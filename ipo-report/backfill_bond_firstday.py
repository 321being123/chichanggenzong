"""Backfill: 首个非涨停日涨幅（历史字段名 first_day_return）回写 PostgreSQL bond_history。

旧逻辑（用户确认保留）：上市涨幅 = 上市后首个「非涨停日」收盘 - 100（百分比）。
即：上市日若未涨停(D1收盘<157.3)直接取D1；若涨停则顺延，取首个未触及±20%涨停的交易日收盘。
（会越过首日限制，可能产生 204%/147% 等值，此为旧逻辑既定行为。）

数据源：Tushare cb_daily（可转债日线，含上市日及之后每日收盘）。
原腾讯行情接口 web.ifzq.gtimg.cn 现已被 WAF 拦截返回 501，故改用 Tushare。

Usage: python backfill_bond_firstday.py [--dry]
"""
import sys, os, time
sys.path.insert(0, os.path.dirname(__file__))
import db_pg
import tushare as ts

dry = '--dry' in sys.argv
pro = ts.pro_api()

# 凭据统一从 PG* 环境变量读取（.env / 部署脚本注入），不再写死密码
conn = db_pg.connect()
cur = conn.cursor()

# 取所有已上市债券（listing_date 非空），全部按旧逻辑重算以保证一致正确
cur.execute("SELECT security_code, security_name, listing_date FROM bond_history WHERE listing_date IS NOT NULL AND listing_date <> ''")
rows = cur.fetchall()
print(f"[1] 已上市债券 {len(rows)} 只，开始按旧逻辑(首个非涨停日)取收盘...")


def _ts_code(code):
    return code[:6] + ('.SH' if code.startswith('11') else '.SZ')


ok = skip = 0
for code, name, ld in rows:
    ld = str(ld)[:10]
    ldd = ld.replace('-', '')
    # Tushare cb_daily 限 200次/分钟；触发限流时休眠重试，而非跳过
    df = None
    for attempt in range(4):
        try:
            df = pro.cb_daily(ts_code=_ts_code(code), start_date=ldd, end_date='20261231')
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
        skip += 1
        continue

    df = df.sort_values('trade_date')  # 升序：上市日 -> 之后
    # 旧逻辑：上市后首个非涨停日收盘
    day2_close = None
    listing_found = False
    prev_close = None
    for _, r in df.iterrows():
        td = str(r['trade_date'])
        close = float(r['close'])
        if td == ld:
            listing_found = True
            prev_close = close
            if abs(prev_close - 157.3) > 0.05:  # 首日未触及 +57.3% 限制
                day2_close = prev_close
                break
            continue
        if listing_found:
            limit_price = round(prev_close * 1.2, 1)  # 次日起 ±20% 限制
            if abs(close - limit_price) > 0.5:  # 未涨停
                day2_close = close
                break
            prev_close = close
            day2_close = close

    # 数据中缺失上市日（极少）：用首个可用收盘兜底
    if not listing_found and day2_close is None:
        day2_close = float(df.iloc[0]['close'])

    if day2_close is None:
        skip += 1
        continue

    fdr = round(day2_close - 100, 2)   # 上市涨幅%
    print(f"  {code} {name}: 上市日{ld} 首个非涨停日收盘={day2_close} -> 上市涨幅={fdr}%")
    if not dry:
        cur.execute("UPDATE bond_history SET first_day_return=%s, updated_at=NOW() WHERE security_code=%s",
                    (fdr, code))
    ok += 1
    time.sleep(0.4)  # 控速：约150次/分钟，低于200上限

if not dry:
    conn.commit()
cur.close(); conn.close()
print(f"\nDone: 更新={ok} 跳过(无K线/缺失)={skip} (dry={dry})")
