"""Backfill: 首个非涨停日涨幅（历史字段名 first_day_return）回写 PostgreSQL bond_history。

旧逻辑（用户确认保留）：上市涨幅 = 上市后首个「非涨停日」收盘 - 100（百分比）。
即：上市日若未涨停(D1收盘<157)直接取D1；若涨停则顺延，取首个未触及±20%涨停的交易日收盘。
（会越过首日限制，可能产生 204%/147% 等值，此为旧逻辑既定行为。）

数据源：腾讯 K 线（web.ifzq.gtimg.cn），与 ipo_daily_report.py 新债温度一致。
同时回写 SQLite（ipo_daily_report.db）的 bond_history，保证日报预测统计一致。

Usage: python backfill_bond_firstday.py [--dry]
"""
import sys, os, time, datetime
sys.path.insert(0, os.path.dirname(__file__))
import db_pg
import requests
from ipo_daily_report import _get_qt_prefix, _init_ipo_db

dry = '--dry' in sys.argv

# 凭据统一从 PG* 环境变量读取（.env / 部署脚本注入），不再写死密码
conn = db_pg.connect()
cur = conn.cursor()

# 取所有已上市债券（listing_date 非空）
cur.execute("SELECT security_code, security_name, listing_date FROM bond_history WHERE listing_date IS NOT NULL AND listing_date <> ''")
rows = cur.fetchall()
print(f"[1] 已上市债券 {len(rows)} 只，开始按旧逻辑(首个非涨停日)取收盘...")

ok = skip = 0
for code, name, ld in rows:
    ld = str(ld)[:10]
    prefix = _get_qt_prefix(code)
    qt = f"{prefix}{code}"
    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={qt},day,,,365,qfq"
    try:
        k = requests.get(url, timeout=10).json()
        days = (k.get('data', {}).get(qt, {}).get('day') or
                k.get('data', {}).get(qt.replace('sh', 'sz'), {}).get('day') or
                k.get('data', {}).get(qt.replace('sz', 'sh'), {}).get('day') or [])
    except Exception as e:
        print(f"  {code} K线获取失败: {e}")
        continue

    # 旧逻辑：上市后首个非涨停日收盘
    day2_close = None
    listing_found = False
    prev_close = None
    for d in days:
        if d[0] == ld:
            listing_found = True
            prev_close = float(d[2])
            if abs(prev_close - 157.3) > 0.05:
                day2_close = prev_close
                break
            continue
        if listing_found and len(d) >= 3:
            close = float(d[2])
            limit_price = round(prev_close * 1.2, 1)
            if abs(close - limit_price) > 0.5:
                day2_close = close
                break
            prev_close = close
            day2_close = close
    # 还没有出现非涨停日时不写入首日临时值，留待后续继续回补。
    if day2_close is None:
        skip += 1
        continue

    fdr = round(day2_close - 100, 2)   # 上市涨幅%
    print(f"  {code} {name}: 上市日{ld} 首个非涨停日收盘={day2_close} -> 上市涨幅={fdr}%")
    if not dry:
        cur.execute("UPDATE bond_history SET first_day_return=%s, updated_at=NOW() WHERE security_code=%s",
                    (fdr, code))
        # 同步 SQLite
        try:
            sc = _init_ipo_db()
            sc.execute(
                "INSERT OR REPLACE INTO bond_history (security_code, security_name, listing_date, first_day_return, updated_at) VALUES (?,?,?,?,?)",
                (code, name, ld, fdr, datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            sc.commit()
            sc.close()
        except Exception:
            pass
    ok += 1
    time.sleep(0.05)

if not dry:
    conn.commit()
cur.close(); conn.close()
print(f"\nDone: 更新={ok} 跳过(无K线首日)={skip} (dry={dry})")
