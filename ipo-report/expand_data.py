"""
一次性数据扩展脚本：
从RPTA_APP_IPOAPPLY接口拉取近2年新股数据，补齐到ipo_history.db
然后从详情页获取完整发行数据
"""
import requests, json, sqlite3, re, time, os
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_history.db")
s = requests.Session()
s.headers.update({'User-Agent': 'Mozilla/5.0'})

# 先从旧代码导入需要的函数
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 板块分类统一收口（避免与 ipo_daily_report.py 重复分叉）
from _classify import _is_bj_stock, _market_type_to_board_key

now = datetime.now()
cutoff_2y = (now - timedelta(days=730)).strftime("%Y-%m-%d")
cutoff_1y = (now - timedelta(days=365)).strftime("%Y-%m-%d")

print(f"扩展数据范围: {cutoff_2y} 至今")

# ── 1. 从API拉取全部新股列表（近2年） ──
conn = sqlite3.connect(DB_PATH)
existing = set(r[0] for r in conn.execute("SELECT security_code FROM ipo_history").fetchall())

url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
params = {
    "reportName": "RPTA_APP_IPOAPPLY",
    "columns": "SECURITY_CODE,SECURITY_NAME_ABBR,MARKET_TYPE,LISTING_DATE,LD_CLOSE_CHANGE",
    "pageNumber": 1, "pageSize": 500,
    "sortTypes": -1, "sortColumns": "LISTING_DATE",
    "source": "WEB", "client": "WEB",
    "filter": f"(LISTING_DATE>='{cutoff_2y}')",
}
resp = s.get(url, params=params, timeout=20)
d = resp.json()

if not (d.get("success") and d["result"] and d["result"]["data"]):
    print(f"API请求失败: {d.get('message', '?')}")
    exit()

records = d["result"]["data"]
print(f"API返回 {len(records)} 条（近2年）")
print(f"数据库已有 {len(existing)} 条")

new_records = [r for r in records if r.get("SECURITY_CODE", "") not in existing]
print(f"待新增: {len(new_records)} 条\n")

# 存入数据库
now_str = now.strftime("%Y-%m-%d %H:%M:%S")
inserted = 0
for r in new_records:
    code = r.get("SECURITY_CODE", "")
    if not code:
        continue
    mt = r.get("MARKET_TYPE", "")
    bk = _market_type_to_board_key(mt, code)
    gain = r.get("LD_CLOSE_CHANGE")
    try:
        gain = float(gain) if gain else None
    except:
        gain = None

    conn.execute(
        "INSERT OR IGNORE INTO ipo_history (security_code, security_name, market_type, listing_date, ld_close_change, board_key, updated_at) VALUES (?,?,?,?,?,?,?)",
        (code, r.get("SECURITY_NAME_ABBR", ""), mt, r.get("LISTING_DATE", ""), gain, bk, now_str),
    )
    existing.add(code)
    inserted += 1

conn.commit()
print(f"新增入库: {inserted} 只")
total = conn.execute("SELECT COUNT(*) FROM ipo_history").fetchone()[0]
print(f"数据库总计: {total} 只")

# 统计非北交所
non_bj = conn.execute("SELECT COUNT(*) FROM ipo_history WHERE board_key != '北交所' AND ld_close_change IS NOT NULL").fetchone()[0]
print(f"非北交所（有涨幅数据）: {non_bj} 只\n")

# ── 2. 补齐详情数据 ──
print("开始补齐详情数据...\n")
need_detail = conn.execute(
    "SELECT security_code, security_name FROM ipo_history WHERE issue_price IS NULL"
).fetchall()
print(f"需要补齐详情: {len(need_detail)} 只")

updated = 0
for i, (code, name) in enumerate(need_detail):
    url2 = f"https://ds.emoney.cn/DataCenter2/datacenter/NewStockXgzl?secucode={code}&type=ss"
    try:
        resp = s.get(url2, timeout=15)
        html = resp.text
    except:
        continue

    rows2 = re.findall(r"<tr>(.*?)</tr>", html, re.DOTALL)
    data = {}
    for row in rows2:
        tds = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.DOTALL)
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in tds]
        for j in range(len(cells) - 1):
            data[cells[j]] = cells[j + 1]

    def gf(key):
        try: return float(data.get(key, 0) or 0) or None
        except: return None

    ip = gf("发行价格(元／股)")
    ipe = gf("发行市盈率")
    fr = gf("实际募集资金总额(亿元)")
    ts = gf("总发行量数(万股)")
    os_ = gf("网上发行数量(万股)")
    lr = gf("网上发行中签率(%)")
    ov = gf("机构超额认购倍数")
    sl = gf("申购数量上限(万股)")
    mb = data.get("主营业务", "")
    ind = data.get("参考行业", "") or data.get("所属行业", "")
    cmv = round(os_ * ip / 10000, 2) if os_ and ip else None

    conn.execute("""
        UPDATE ipo_history SET
            issue_price=?, issue_pe=?, fund_raised=?,
            total_shares=?, online_shares=?, online_lottery_rate=?,
            oversubscribe_multiple=?, subscribe_upper_limit=?,
            main_business=?, industry=?, circulation_mv=?
        WHERE security_code=?
    """, (ip, ipe, fr, ts, os_, lr, ov, sl, mb[:200] if mb else None, ind, cmv, code))
    updated += 1

    if (i+1) % 20 == 0:
        conn.commit()
        print(f"  [{i+1}/{len(need_detail)}] {code} {name} ✅")

    time.sleep(0.2)

conn.commit()

# ── 3. 补充行业PE ──
print(f"\n补充行业PE数据...")
need_pe = [r[0] for r in conn.execute("SELECT security_code FROM ipo_history WHERE industry_pe IS NULL").fetchall()]
print(f"需要补充行业PE: {len(need_pe)} 只")

pe_updated = 0
for code in need_pe:
    params2 = {
        'reportName': 'RPTA_APP_IPOAPPLY',
        'columns': 'SECURITY_CODE,INDUSTRY_PE',
        'pageNumber': 1, 'pageSize': 1,
        'source': 'WEB', 'client': 'WEB',
        'filter': f'(SECURITY_CODE="{code}")',
    }
    try:
        resp = s.get(url, params=params2, timeout=15)
        d2 = resp.json()
        if d2.get('success') and d2['result'].get('data'):
            pe = d2['result']['data'][0].get('INDUSTRY_PE')
            if pe:
                conn.execute('UPDATE ipo_history SET industry_pe=? WHERE security_code=?', (float(pe), code))
                ipe = conn.execute('SELECT issue_pe FROM ipo_history WHERE security_code=?', (code,)).fetchone()
                if ipe and ipe[0]:
                    conn.execute('UPDATE ipo_history SET pe_ratio=? WHERE security_code=?',
                                 (round(float(pe)/ipe[0], 2), code))
                pe_updated += 1
    except:
        pass
    time.sleep(0.1)

conn.commit()
conn.close()

print(f"补充行业PE: {pe_updated} 只")
print(f"\n{'='*50}")
print("扩展完成！")
