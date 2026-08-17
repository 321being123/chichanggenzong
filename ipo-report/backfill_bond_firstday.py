"""Backfill: 首个非涨停日涨幅写入统一上市表现表。

旧逻辑（用户确认保留）：上市涨幅 = 上市后首个「非涨停日」收盘 - 100（百分比）。
即：上市日若未涨停(D1收盘<157.3)直接取D1；若涨停则顺延，取首个未触及±20%涨停的交易日收盘。
（会越过首日限制，可能产生 204%/147% 等值，此为旧逻辑既定行为。）

数据源：Tushare cb_daily（可转债日线，含上市日及之后每日收盘）。
原腾讯行情接口 web.ifzq.gtimg.cn 现已被 WAF 拦截返回 501，故改用 Tushare。

Usage: python backfill_bond_firstday.py [--dry]
"""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(__file__))
import db_pg
from _common import _load_env, get_tushare_pro
from bond_data_layer import update_listing_performance

_load_env()

# 凭据统一从 PG* 环境变量读取（.env / 部署脚本注入），不再写死密码
dry = '--dry' in sys.argv
conn = db_pg.connect()
cur = conn.cursor()

# 只处理已上市且尚未形成表现事实的债券；已有有效表现不重复请求上游。
limit = max(int(os.environ.get('IPO_BOND_FIRSTDAY_LIMIT', '80')), 1)
cur.execute("SELECT security_code, bond_name, listing_date FROM public.bond_unified WHERE listing_date IS NOT NULL AND listing_date < CURRENT_DATE")
all_rows = cur.fetchall()
cur.execute("""
  SELECT b.instrument_id,b.security_code,b.bond_name,b.listing_date
    FROM public.bond_unified b
   WHERE b.listing_date IS NOT NULL
     AND b.listing_date < CURRENT_DATE
     AND (b.issue_type IS NULL OR b.issue_type NOT IN ('定向','私募'))
     AND NOT EXISTS (
       SELECT 1 FROM analytics.convertible_bond_listing_performance p
        WHERE p.instrument_id=b.instrument_id
          AND p.measurement_type='first_non_limit_day'
          AND p.formula_version='first_non_limit_day_v1'
     )
   ORDER BY b.listing_date DESC
   LIMIT %s
""", (limit,))
rows = cur.fetchall()
print(f"[1] 已上市债券 {len(all_rows)} 只，本批待补 {len(rows)} 只，最多处理 {limit} 只...")

if not rows:
    cur.close(); conn.close()
    print(json.dumps({"ok": True, "attempted": 0, "updated": 0, "skipped": 0, "remaining": 0}, ensure_ascii=False))
    raise SystemExit(0)

pro = get_tushare_pro()
if pro is None:
    cur.close(); conn.close()
    raise RuntimeError("TUSHARE_TOKEN/TUSHARE_BACKUP_TOKEN 未配置")


def _ts_code(code):
    return code[:6] + ('.SH' if code.startswith('11') else '.SZ')


ok = skip = 0
for instrument_id, code, name, ld in rows:
    ld = str(ld)[:10]
    ldd = ld.replace('-', '')
    # Tushare cb_daily 限 200次/分钟；触发限流时休眠重试，而非跳过
    df = None
    for attempt in range(4):
        try:
            df = pro.cb_daily(ts_code=_ts_code(code), start_date=ldd, end_date='20991231')
            break
        except Exception as e:
            msg = str(e)
            if '频率' in msg or '限速' in msg or 'rate' in msg.lower():
                print(f"  {code} 触发限流，休眠30s重试({attempt+1})...")
                time.sleep(30)
                continue
            print(f"  {code} cb_daily 获取失败: {e}")
            time.sleep(1)
            break
    if df is None or len(df) == 0:
        if not dry:
            cur.execute("""INSERT INTO ops.data_quality_issues
              (instrument_id,dataset_code,field_code,issue_type,severity,status,details)
              VALUES(%s,'cb_listing_performance','first_non_limit_day','source_unavailable','warning','open',%s::jsonb)
              ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
              DO UPDATE SET details=EXCLUDED.details,detected_at=now(),resolved_at=NULL""",
              (instrument_id, json.dumps({"security_code": code, "listing_date": ld, "reason": "cb_daily_empty"}, ensure_ascii=False)))
        skip += 1
        continue

    df = df.sort_values('trade_date')  # 升序：上市日 -> 之后
    # 旧逻辑：上市后首个非涨停日收盘
    day2_close = None
    listing_found = False
    prev_close = None
    observation_date = None
    for _, r in df.iterrows():
        td = str(r['trade_date'])
        close = float(r['close'])
        if td == ldd:
            listing_found = True
            prev_close = close
            if abs(prev_close - 157.3) > 0.05:  # 首日未触及 +57.3% 限制
                day2_close = prev_close
                observation_date = td
                break
            continue
        if listing_found:
            limit_price = round(prev_close * 1.2, 1)  # 次日起 ±20% 限制
            if abs(close - limit_price) > 0.5:  # 未涨停
                day2_close = close
                observation_date = td
                break
            prev_close = close
            day2_close = close
            observation_date = td

    # 数据中缺失上市日（极少）：用首个可用收盘兜底
    if not listing_found and day2_close is None:
        day2_close = float(df.iloc[0]['close'])

    if day2_close is None:
        if not dry:
            cur.execute("""INSERT INTO ops.data_quality_issues
              (instrument_id,dataset_code,field_code,issue_type,severity,status,details)
              VALUES(%s,'cb_listing_performance','first_non_limit_day','source_unavailable','warning','open',%s::jsonb)
              ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
              DO UPDATE SET details=EXCLUDED.details,detected_at=now(),resolved_at=NULL""",
              (instrument_id, json.dumps({"security_code": code, "listing_date": ld, "reason": "no_non_limit_close"}, ensure_ascii=False)))
        skip += 1
        continue

    fdr = round(day2_close - 100, 2)   # 上市涨幅%
    print(f"  {code} {name}: 上市日{ld} 首个非涨停日收盘={day2_close} -> 上市涨幅={fdr}%")
    if not dry:
        update_listing_performance(code, ld, observation_date or ld, day2_close, fdr,
                                   {"source": "cb_daily", "formula": "first_non_limit_day_v1"}, dry=dry)
        cur.execute("""UPDATE ops.data_quality_issues
                          SET status='resolved',resolved_at=now(),details=details || %s::jsonb
                        WHERE instrument_id=%s AND dataset_code='cb_listing_performance'
                          AND field_code='first_non_limit_day' AND status='open'""",
                    (json.dumps({"resolved_by": "backfill_bond_firstday"}), instrument_id))
    ok += 1
    time.sleep(0.4)  # 控速：约150次/分钟，低于200上限

if not dry:
    conn.commit()
cur.execute("""
  SELECT count(*) FROM public.bond_unified b
   WHERE b.listing_date IS NOT NULL AND b.listing_date < CURRENT_DATE
     AND (b.issue_type IS NULL OR b.issue_type NOT IN ('定向','私募'))
     AND NOT EXISTS (
       SELECT 1 FROM analytics.convertible_bond_listing_performance p
        WHERE p.instrument_id=b.instrument_id
          AND p.measurement_type='first_non_limit_day'
          AND p.formula_version='first_non_limit_day_v1'
     )
""")
remaining = int(cur.fetchone()[0] or 0)
cur.close(); conn.close()
print(f"\nDone: 更新={ok} 跳过(无K线/缺失)={skip} 剩余={remaining} (dry={dry})")
print(json.dumps({"ok": True, "attempted": len(rows), "updated": ok, "skipped": skip, "remaining": remaining}, ensure_ascii=False))
