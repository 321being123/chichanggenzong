"""批量回填 fundamental.convertible_bond_ratings（估值模块的评级历史表）。

背景：估值详情页「信用评级」依赖 fundamental.convertible_bond_ratings，但该表
只在用户手动刷新某只转债的股债分析时才写入（cb_rating 无法一次批量拉取），
导致绝大多数转债评级历史为空 → 估值页显示「评级历史不足」。

本脚本：从 core.instruments 取全部可转债（cb_type='CB'），逐只调用 Tushare
cb_rating 拉完整评级历史，幂等 upsert 进 fundamental.convertible_bond_ratings。
带限流重试 + --dry 预览。

Usage: python backfill_fundamental_ratings.py [--dry]
"""
import sys, os, time
sys.path.insert(0, os.path.dirname(__file__))
import psycopg2
from ipo_daily_report import _get_tushare_pro

pro = _get_tushare_pro()
if not pro:
    print("ERROR: Tushare not configured")
    sys.exit(1)

dry = '--dry' in sys.argv

conn = psycopg2.connect(
    host=os.environ.get('PGHOST', 'localhost'),
    port=int(os.environ.get('PGPORT', '5432')),
    user=os.environ.get('PGUSER', 'postgres'),
    password=os.environ.get('PGPASSWORD', ''),
    dbname=os.environ.get('PGDATABASE', 'portfolio'),
)
cur = conn.cursor()

# 1) 取全部可转债 instrument_id + canonical_code（估值引擎同款口径：cb_type=CB），
#    只回填评级表里还没有的转债（已有评级的不重复拉）
cur.execute("""
    SELECT i.instrument_id, i.canonical_code
      FROM core.instruments i
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
      LEFT JOIN (SELECT DISTINCT instrument_id FROM fundamental.convertible_bond_ratings) r
             ON r.instrument_id = i.instrument_id
     WHERE p.cb_type IN ('CB', '')
       AND r.instrument_id IS NULL
     ORDER BY i.canonical_code
""")
bonds = cur.fetchall()
print(f"可转债候选: {len(bonds)} 只")

# 2) 每只拉 cb_rating 全历史并 upsert
total_inserted = 0
total_failed = 0
for idx, (instrument_id, canonical_code) in enumerate(bonds):
    ts_code = str(canonical_code).upper()
    if '.' not in ts_code:
        # 按前缀补交易所后缀（估值引擎 canonical_code 通常已带后缀）
        ts_code = ts_code + ('.SH' if str(canonical_code).startswith(('11', '113', '118', '110')) else '.SZ')
    # 每只用独立保存点：单只失败 rollback 到保存点，不影响其他转债
    sp = f"sp_{idx}"
    if not dry:
        cur.execute(f"SAVEPOINT {sp}")
    try:
        dr = None
        for attempt in range(4):
            try:
                dr = pro.cb_rating(ts_code=ts_code)
                break
            except Exception:
                time.sleep(0.5 * (attempt + 1))
        if dr is None or dr.empty:
            total_failed += 1
            if not dry:
                cur.execute(f"RELEASE SAVEPOINT {sp}")
            continue
        if 'rating_date' in dr.columns:
            dr = dr.sort_values('rating_date', ascending=False)
        for _, r in dr.iterrows():
            rating_date = str(r.get('rating_date') or '').strip()[:10]
            if not rating_date:
                continue
            ann_date = str(r.get('ann_date') or '').strip()[:10] or None
            rating = str(r.get('rating') or '').strip()
            rating_outlook = str(r.get('rating_outlook') or '').strip()
            rating_company = str(r.get('rating_com_name') or '').strip()
            rating_type = str(r.get('rating_type') or '').strip()
            rating_method = str(r.get('rating_way') or '').strip()
            if not rating and not rating_company and not rating_outlook:
                continue
            if not dry:
                cur.execute("""
                    INSERT INTO fundamental.convertible_bond_ratings
                      (instrument_id, rating_date, announced_at, rating_company, rating_method,
                       rating_type, rating, rating_outlook, raw_payload)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                    ON CONFLICT (instrument_id, rating_date, rating_company) DO UPDATE SET
                      announced_at = EXCLUDED.announced_at,
                      rating_method = EXCLUDED.rating_method,
                      rating_type = EXCLUDED.rating_type,
                      rating = EXCLUDED.rating,
                      rating_outlook = COALESCE(NULLIF(EXCLUDED.rating_outlook,''),
                                                fundamental.convertible_bond_ratings.rating_outlook),
                      raw_payload = fundamental.convertible_bond_ratings.raw_payload || EXCLUDED.raw_payload
                """, (instrument_id, rating_date, ann_date, rating_company, rating_method,
                      rating_type, rating, rating_outlook,
                      __import__('json').dumps(dict(r), ensure_ascii=False)))
                total_inserted += 1
        if not dry:
            cur.execute(f"RELEASE SAVEPOINT {sp}")
        if (idx + 1) % 10 == 0:
            print(f"  progress {idx+1}/{len(bonds)}")
    except Exception as e:
        total_failed += 1
        if not dry:
            cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
        print(f"  FAIL {canonical_code}: {str(e)[:200]}")
    time.sleep(0.15)

if not dry:
    conn.commit()
cur.close()
conn.close()
print(f"\nDone: inserted/updated={total_inserted}, skipped_no_data={total_failed} (dry={dry})")
