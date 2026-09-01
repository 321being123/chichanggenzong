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
from instrument_identity import resolve_provider_code

pro = _get_tushare_pro()
if not pro:
    print("ERROR: Tushare not configured")
    sys.exit(1)

dry = '--dry' in sys.argv


def _json_safe(row_dict):
    """清洗 numpy NaN / pandas NaT 等非 JSON 值，避免 jsonb 写入报错。"""
    import json
    import math
    out = {}
    for k, v in dict(row_dict).items():
        if v is None:
            out[k] = None
            continue
        # 数字类型做 NaN/inf 检测；字符串/日期等原样保留
        if not isinstance(v, str):
            try:
                f = float(v)
                if math.isnan(f) or math.isinf(f):
                    out[k] = None
                    continue
            except (TypeError, ValueError):
                pass
        out[k] = str(v) if isinstance(v, (bytes,)) else v
    return json.dumps(out, ensure_ascii=False, allow_nan=False)

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
    ts_code = resolve_provider_code(canonical_code, 'tushare', 'ts_code', conn=conn, asset_class='convertible_bond')
    if not ts_code:
        total_failed += 1
        print(f"  {canonical_code} 缺少统一 Tushare 代码映射，跳过")
        continue
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
            # Tushare 空值可能以字符串 'nan'/'NaN' 形式出现，统一清洗为空（否则 JSONB 写入报错）
            if rating_outlook.lower() == 'nan':
                rating_outlook = ''
            if rating_company.lower() == 'nan':
                rating_company = ''
            if rating_type.lower() == 'nan':
                rating_type = ''
            if rating_method.lower() == 'nan':
                rating_method = ''
            if rating.lower() == 'nan':
                rating = ''
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
                      _json_safe(dict(r))))
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
