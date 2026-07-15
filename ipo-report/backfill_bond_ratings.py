"""补充回填 bond_history.rating：逐只调用 Tushare cb_rating（带重试），仅更新 rating 列。
单独抽出是因为 cb_rating 必须带 ts_code，无法一次批量拉取；原 backfill 的兜底在遇到
限流异常时被静默吞掉，导致部分债券评级缺失。本脚本带重试，确保有数据的债券评级被填满。
Usage: python backfill_bond_ratings.py [--dry]
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

conn = psycopg2.connect(host='127.0.0.1', port=5432, dbname='portfolio', user='postgres', password=***REDACTED***)
cur = conn.cursor()

# 取全部 ts_code（含交易所后缀），避免自己猜交易所
print("Fetching cb_issue ts_codes...")
df = pro.cb_issue(fields='ts_code,onl_name')
print(f"  {len(df)} bonds")

updated = skipped = 0
for _, r in df.iterrows():
    ts_code = str(r.get('ts_code', '') or '')
    code6 = ts_code.split('.')[0]
    if not code6:
        continue
    rating = None
    for attempt in range(3):
        try:
            dr = pro.cb_rating(ts_code=ts_code)
            if dr is not None and not dr.empty:
                if 'rating_date' in dr.columns:
                    dr = dr.sort_values('rating_date', ascending=False)
                rt = dr.iloc[0].get('rating')
                if rt:
                    rating = str(rt).replace('sti', '').replace('STI', '').strip()
            break
        except Exception:
            time.sleep(0.3 * (attempt + 1))
    if not rating:
        skipped += 1
        continue
    if not dry:
        cur.execute("UPDATE bond_history SET rating=%s, updated_at=NOW() WHERE security_code=%s", (rating, code6))
    updated += 1
    time.sleep(0.05)

if not dry:
    conn.commit()
cur.close(); conn.close()
print(f"\nDone: rating updated={updated}, skipped(no data)={skipped} (dry={dry})")
