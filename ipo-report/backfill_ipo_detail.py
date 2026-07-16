"""
一次性回填脚本：遍历ipo_history已有股票，从东财详情页获取完整发行数据并存入新增字段
"""
import requests
import re
import sqlite3
import time
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_history.db")

s = requests.Session()
s.headers.update({'User-Agent': 'Mozilla/5.0'})

conn = sqlite3.connect(DB_PATH)

# 获取所有没有issue_price的股票（未回填的）
rows = conn.execute(
    "SELECT security_code, security_name FROM ipo_history WHERE issue_price IS NULL"
).fetchall()

print(f"需要回填: {len(rows)} 只新股\n")

updated = 0
failed = 0
for i, (code, name) in enumerate(rows):
    url = f"https://ds.emoney.cn/DataCenter2/datacenter/NewStockXgzl?secucode={code}&type=ss"
    try:
        resp = s.get(url, timeout=15)
        html = resp.text
    except Exception as e:
        print(f"  [{i+1}/{len(rows)}] {code} {name}: 请求失败 {e}")
        failed += 1
        continue

    # 解析表格
    rows2 = re.findall(r'<tr>(.*?)</tr>', html, re.DOTALL)
    data = {}
    for row in rows2:
        tds = re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', row, re.DOTALL)
        cells = [re.sub(r'<[^>]+>', '', c).strip() for c in tds]
        for j in range(len(cells) - 1):
            data[cells[j]] = cells[j + 1]

    def gf(key):
        try: return float(data.get(key, 0) or 0) or None
        except: return None

    # 关键字段
    issue_price = gf("发行价格(元／股)")
    issue_pe = gf("发行市盈率")
    industry_pe = gf("参考行业市盈率(倍)") or gf("行业市盈率")
    fund_raised = gf("实际募集资金总额(亿元)")
    total_shares = gf("总发行量数(万股)")
    online_shares = gf("网上发行数量(万股)")
    lottery_rate = gf("网上发行中签率(%)")
    oversub = gf("机构超额认购倍数")
    upper_limit = gf("申购数量上限(万股)")
    main_biz = data.get("主营业务", "")
    industry = data.get("参考行业", "") or data.get("所属行业", "")

    # 衍生字段
    circulation_mv = round(online_shares * issue_price / 10000, 2) if online_shares and issue_price else None
    pe_ratio = round(industry_pe / issue_pe, 2) if industry_pe and issue_pe else None

    conn.execute("""
        UPDATE ipo_history SET
            issue_price=?,
            issue_pe=?,
            industry_pe=?,
            fund_raised=?,
            total_shares=?,
            online_shares=?,
            online_lottery_rate=?,
            oversubscribe_multiple=?,
            subscribe_upper_limit=?,
            main_business=?,
            industry=?,
            circulation_mv=?,
            pe_ratio=?
        WHERE security_code=?
    """, (
        issue_price, issue_pe, industry_pe,
        fund_raised, total_shares, online_shares,
        lottery_rate, oversub, upper_limit,
        main_biz[:200] if main_biz else None,
        industry,
        circulation_mv, pe_ratio,
        code
    ))
    updated += 1

    if (i + 1) % 10 == 0:
        conn.commit()
        print(f"  [{i+1}/{len(rows)}] {code} {name} ✅ (已提交)")
    else:
        print(f"  [{i+1}/{len(rows)}] {code} {name} 发行价{issue_price} PE{issue_pe}/{industry_pe} 中签{lottery_rate}% 流通{online_shares}万股")

    time.sleep(0.3)  # 间隔

conn.commit()
conn.close()

print(f"\n回填完成: 成功{updated}, 失败{failed}")
