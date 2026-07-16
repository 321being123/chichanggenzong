"""补 rating（第二轮）：用 cb_issue 取权威 ts_code（含正确交易所后缀），
对仍缺评级的债券用正确 ts_code 查 cb_rating。"""
import sys, os, time
sys.path.insert(0, os.path.dirname(__file__))
import db_pg
from ipo_daily_report import _get_tushare_pro

pro = _get_tushare_pro()
if not pro:
    print("ERROR: Tushare not configured"); sys.exit(1)

# 凭据统一从 PG* 环境变量读取（.env / 部署脚本注入），不再写死密码
conn = db_pg.connect()
cur = conn.cursor()
cur.execute("SELECT security_code FROM bond_history WHERE rating IS NULL OR rating=''")
missing = [r[0] for r in cur.fetchall()]
print(f"本地缺评级: {len(missing)} 只")

# 权威 ts_code 映射（cb_issue 自带正确后缀）
df = pro.cb_issue(fields='ts_code')
tsmap = {str(t).split('.')[0]: str(t) for t in df['ts_code'].tolist()}
print(f"cb_issue ts_code 总数: {len(tsmap)}")

updated = 0
for i, code in enumerate(missing):
    tsc = tsmap.get(code)
    if not tsc:
        continue
    try:
        dr = pro.cb_rating(ts_code=tsc)
    except Exception as e:
        dr = None
    if dr is not None and not dr.empty:
        if 'rating_date' in dr.columns:
            dr = dr.sort_values('rating_date', ascending=False)
        rt = dr.iloc[0].get('rating')
        if rt:
            rating = str(rt).replace('sti', '').replace('STI', '').strip()
            cur.execute("UPDATE bond_history SET rating=%s WHERE security_code=%s", (rating, code))
            updated += 1
    if (i + 1) % 20 == 0:
        print(f"  progress {i+1}/{len(missing)} updated={updated}")
    time.sleep(0.2)

conn.commit()
print(f"已更新评级: {updated} 只")
cur.execute("SELECT count(*) FROM bond_history WHERE rating IS NULL OR rating=''")
still = cur.fetchall()[0][0]
print(f"仍缺评级: {still} 只")
cur.close(); conn.close()
