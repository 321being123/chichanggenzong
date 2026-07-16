# -*- coding: utf-8 -*-
"""
打新日历模块回归测试（聚焦本特性已发现的真实 bug，非追求覆盖率）。
运行：python test_ipo_regression.py
依赖：本地 PostgreSQL 已启动 + .env 含 PG* 与 TUSHARE_TOKEN
"""
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_daily_report as m
import db_pg
import psycopg2

PASS, FAIL, ERR = [], [], []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  [PASS] %s %s" % (name, detail))
    else:
        FAIL.append(name)
        print("  [FAIL] %s %s" % (name, detail))


def pg_conn():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"),
        port=int(os.environ.get("PGPORT", "5432")),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "postgres"),
        dbname=os.environ.get("PGDATABASE", "portfolio"),
        connect_timeout=10,
    )


# ===== 1. _str_date 单元（修复：NaN 污染为 'nan'）=====
print("== 1. _str_date 安全日期转换 ==")
try:
    check("None->空串", m._str_date(None) == "")
    check("NaN(float)->空串", m._str_date(float("nan")) == "")
    check("标准日期透传", m._str_date("2026-07-20") == "2026-07-20")
    check("无横线日期->YYYY-MM-DD", m._str_date("20260720") == "2026-07-20")
    check("空串->空串", m._str_date("") == "")
except Exception as e:
    ERR.append("_str_date: " + str(e))


# ===== 2. db_pg 封装层（修复：CREATE TABLE 空操作报空语句；upsert 幂等）=====
print("== 2. db_pg 封装层 ==")
try:
    conn = db_pg.connect()
    # CREATE TABLE 必须静默空操作，不能抛 "can't execute an empty query"
    conn.execute("CREATE TABLE IF NOT EXISTS __ipo_test_noop (a int)")
    conn.commit()
    check("CREATE TABLE 空操作不抛错", True)

    # INSERT OR REPLACE 幂等（同主键两次写入=1行）
    conn.execute(
        "INSERT OR REPLACE INTO predictions (type, code, name, listing_date, pred_date, status) VALUES (?, ?, ?, ?, ?, ?)",
        ("stock", "TEST001", "测试股", "2026-07-20", "2026-07-20", "pending"),
    )
    conn.execute(
        "INSERT OR REPLACE INTO predictions (type, code, name, listing_date, pred_date, status) VALUES (?, ?, ?, ?, ?, ?)",
        ("stock", "TEST001", "测试股", "2026-07-20", "2026-07-20", "done"),
    )
    conn.commit()
    cur = conn.cursor()
    cur.execute(
        "SELECT count(*) FROM predictions WHERE type='stock' AND code='TEST001' AND pred_date='2026-07-20'")
    cnt = cur.fetchone()[0]
    check("INSERT OR REPLACE 幂等(1行)", cnt == 1, "实际=%d" % cnt)
    cur.execute("DELETE FROM predictions WHERE type='stock' AND code='TEST001'")
    conn.commit()
    conn.close()
    check("占位符 ? 被正确改写", True)
except Exception as e:
    ERR.append("db_pg: " + str(e))
    traceback.print_exc()


# ===== 3. fetch_calendar（修复：日期字段 nan 污染）=====
print("== 3. fetch_calendar ==")
try:
    cal = m.fetch_calendar()
    check("返回列表", isinstance(cal, list))
    bad = [x for x in cal if x.get("TRADE_DATE") == "nan"]
    check("无 'nan' 日期", len(bad) == 0, "污染数=%d" % len(bad))
    import re
    bad_fmt = [x for x in cal if x.get("TRADE_DATE") and
               x["TRADE_DATE"] != "nan" and
               not re.match(r"^\d{4}-\d{2}-\d{2}$", x["TRADE_DATE"])]
    check("日期格式 YYYY-MM-DD", len(bad_fmt) == 0, "异常=%s" % bad_fmt[:3])
    types_ok = all(x.get("SECURITY_TYPE") in ("0", "1") for x in cal)
    check("SECURITY_TYPE 取值合法", types_ok)
except Exception as e:
    ERR.append("fetch_calendar: " + str(e))
    traceback.print_exc()


# ===== 4. fetch_stock_detail（修复：list_date 'nan'）=====
print("== 4. fetch_stock_detail(301677) ==")
try:
    d = m.fetch_stock_detail("301677")
    check("返回 dict", isinstance(d, dict), "返回=%r" % d)
    if isinstance(d, dict):
        for k in ("issue_price", "issue_pe", "online_date", "list_date",
                  "main_business", "industry", "industry_pe"):
            check("含字段 %s" % k, k in d)
        # fund_raised 在未公布发行价(price=0)时无法计算，允许缺失
        check("fund_raised 可选(价格0时缺失)",
              d.get("fund_raised") is None or isinstance(d.get("fund_raised"), (int, float)))
        check("online_date 非 'nan'", d.get("online_date") != "nan")
        check("list_date 非 'nan'", d.get("list_date") != "nan",
              "list_date=%r" % d.get("list_date"))
except Exception as e:
    ERR.append("fetch_stock_detail: " + str(e))
    traceback.print_exc()


# ===== 5. fetch_bond_detail（修复：convert_price=None 漏字段）=====
print("== 5. fetch_bond_detail(真实已上市转债) ==")
try:
    c = pg_conn()
    cur = c.cursor()
    cur.execute("SELECT security_code FROM bond_history WHERE listing_date IS NOT NULL AND listing_date <> '' LIMIT 1")
    row = cur.fetchone()
    c.close()
    if row:
        code = row[0]
        b = m.fetch_bond_detail(code)
        check("返回 dict/None", b is None or isinstance(b, dict), "code=%s" % code)
        if isinstance(b, dict):
            check("含 convert_price 字段", "convert_price" in b)
            check("convert_price 非 None", b.get("convert_price") is not None,
                  "convert_price=%r" % b.get("convert_price"))
            check("含 rating 字段", "rating" in b)
    else:
        check("本地无已上市转债样本(跳过)", True, "bond_history 无 listing_date")
except Exception as e:
    ERR.append("fetch_bond_detail: " + str(e))
    traceback.print_exc()


# ===== 6. build_report（端到端，修复：任何日期字段不得 'nan'）=====
print("== 6. build_report(2026-07-15) ==")
try:
    md, data = m.build_report(__import__("datetime").datetime(2026, 7, 15))
    check("返回 (md,data)", isinstance(md, str) and isinstance(data, dict))
    for k in ("date_display", "weekday", "apply_stocks", "apply_bonds",
              "list_stocks", "list_bonds"):
        check("data 含 %s" % k, k in data)
    # 扫描所有日期类字段
    def _scan(obj, path=""):
        hits = []
        if isinstance(obj, dict):
            for k, v in obj.items():
                if "date" in k.lower() and isinstance(v, str) and "nan" in v.lower():
                    hits.append(path + "/" + k)
                hits += _scan(v, path + "/" + k)
        elif isinstance(obj, list):
            for i, v in enumerate(obj):
                hits += _scan(v, path + "[%d]" % i)
        return hits
    nan_hits = _scan(data)
    check("报告数据无 'nan' 日期", len(nan_hits) == 0, "命中=%s" % nan_hits[:5])
    check("申购/上市列表均为 list",
          isinstance(data["apply_stocks"], list) and isinstance(data["list_bonds"], list))
except Exception as e:
    ERR.append("build_report: " + str(e))
    traceback.print_exc()


# ===== 7. save_report_to_pg 幂等（修复：重复写入不新增行）=====
print("== 7. save_report_to_pg 幂等 ==")
try:
    date_str = "20260715"
    md = "# 测试报告"
    data = {"date_display": "2026-07-15", "weekday": "周三",
            "apply_stocks": [], "apply_bonds": [], "list_stocks": [],
            "list_bonds": [], "sector_boost_info": None}
    m.save_report_to_pg(md, "<html>test</html>", data, date_str)
    m.save_report_to_pg(md, "<html>test2</html>", data, date_str)  # 第二次应覆盖
    c = pg_conn()
    cur = c.cursor()
    cur.execute("SELECT count(*) FROM ipo_reports WHERE report_date=%s", (date_str,))
    cnt = cur.fetchone()[0]
    check("同日期仅 1 行(upsert)", cnt == 1, "实际=%d" % cnt)
    cur.execute("SELECT summary_json IS NOT NULL FROM ipo_reports WHERE report_date=%s", (date_str,))
    notnull = cur.fetchone()[0]
    check("summary_json 非空", notnull is True)
    cur.execute("DELETE FROM ipo_reports WHERE report_date=%s", (date_str,))
    c.commit()
    c.close()
except Exception as e:
    ERR.append("save_report_to_pg: " + str(e))
    traceback.print_exc()


# ===== 8. 本轮回真 bug 回归（_to_ts_code 后缀双拼 / 需配市值 / 行业PE映射）=====
print("\n== 8. 本轮回修复点回归 ==")

# 8.1 _to_ts_code 已带后缀时不得再拼后缀（曾出现 300750.SZ.SZ）
check("_to_ts_code 已带后缀不双拼", m._to_ts_code("300750.SZ") == "300750.SZ",
      "得到 %r" % m._to_ts_code("300750.SZ"))
check("_to_ts_code 无后缀补.SZ", m._to_ts_code("301677") == "301677.SZ")
check("_to_ts_code 沪市补.SH", m._to_ts_code("600000") == "600000.SH")

# 8.2 需配市值 = 顶格申购股数/1000(万) = limit_amount*10
m._INDUSTRY_PE_MAP = None
try:
    d301 = m.fetch_stock_detail("301677")  # 欣兴工具 limit_amount=0.6 万股
    check("fetch_stock_detail 返回字典", isinstance(d301, dict))
    if d301:
        check("subscribe_mv 由 limit_amount 算出", d301.get("subscribe_mv") is not None,
              "subscribe_mv=%r" % d301.get("subscribe_mv"))
        if d301.get("limit_amount"):
            exp_mv = round(d301["limit_amount"] * 10, 1)
            check("subscribe_mv == limit_amount*10", d301.get("subscribe_mv") == exp_mv,
                  "期望 %s 实得 %s" % (exp_mv, d301.get("subscribe_mv")))
        # subscribe_upper_limit 库内单位=顶格申购上限(万股)；Tushare limit_amount 已是万股，直接相等
        check("subscribe_upper_limit == limit_amount(万股)",
              d301.get("subscribe_upper_limit") == d301.get("limit_amount"),
              "期望 %s 实得 %s" % (d301.get("limit_amount"), d301.get("subscribe_upper_limit")))
except Exception as e:
    ERR.append("_to_ts_code/subscribe_mv: " + str(e))

# 8.3 行业PE映射：取最近有日线数据的交易日，且能补全已上市股票行业PE
try:
    mp = m._get_industry_pe_map()
    check("行业PE映射非空", len(mp) > 0, "共 %d 行业" % len(mp))
    ind = m._fetch_stock_industry("300750.SZ")
    check("_fetch_stock_industry 返回行业", bool(ind), "行业=%r" % ind)
    if ind:
        check("行业PE映射可查到该行业", mp.get(ind) is not None, "行业PE=%s" % mp.get(ind))
except Exception as e:
    ERR.append("行业PE映射: " + str(e))


# ===== 9. 可转债预测：发行规模折扣 + 区间带（用户2026-07-15 新增）=====
print("\n== 9. 可转债预测：发行规模折扣 + 区间带 ==")
try:
    # 隔离外部依赖：强制用固定市场热度与基础溢价率，使结果可断言
    m._fetch_all_bonds_market = lambda: []              # 空列表 -> 走 fallback: base_premium = market['avg_premium']
    m.fetch_market_heat = lambda: {"index_level": "中性", "avg_premium": 0.30, "index_1m": 0.0}

    # 9.1 发行规模(总募资)折扣档位：TV=100 / 流通20亿(巨盘,-0.05) / AAA(+0.05)
    #     总溢价率 = 0.30(基础) -0.05(流通) + 发行折扣 + 0.05(AAA)
    discount_cases = [
        (500, 112.00, "超大盘(>=300亿) -0.18"),
        (150, 120.00, "大盘(>=100亿) -0.10"),
        (60,  125.00, "中大盘(>=50亿) -0.05"),
        (None, 130.00, "无发行规模折扣 0"),
    ]
    for isz, exp_price, label in discount_cases:
        r, err = m.estimate_bond_listing_price(100, 20, "AAA",
                                                bond_name="", stock_name="", stock_industry="",
                                                issue_scale=isz)
        check("发行规模折扣 %s" % label, err is None and abs(r["price"] - exp_price) < 0.01,
              "issue_scale=%s 实得=%s 期望=%s" % (isz, (r or {}).get("price"), exp_price))

    # 9.2 区间带宽度（ref_size = issue_scale 优先，否则流通规模）
    r500, _ = m.estimate_bond_listing_price(100, 20, "AAA", issue_scale=500)   # >=50亿 -> ±10
    check("区间带 500亿 ±10 (low)", abs(r500["low"] - 102.0) < 0.01, "low=%s" % r500["low"])
    check("区间带 500亿 ±10 (high)", abs(r500["high"] - 122.0) < 0.01, "high=%s" % r500["high"])

    r20, _ = m.estimate_bond_listing_price(100, 20, "AAA", issue_scale=20)     # >=20亿 -> ±7
    check("区间带 20亿 ±7 (low)", abs(r20["low"] - 123.0) < 0.01, "low=%s" % r20["low"])
    check("区间带 20亿 ±7 (high)", abs(r20["high"] - 137.0) < 0.01, "high=%s" % r20["high"])

    r8, _ = m.estimate_bond_listing_price(100, 20, "AAA", issue_scale=8)       # >=5亿 -> ±5
    check("区间带 8亿 ±5 (low)", abs(r8["low"] - 125.0) < 0.01, "low=%s" % r8["low"])
    check("区间带 8亿 ±5 (high)", abs(r8["high"] - 135.0) < 0.01, "high=%s" % r8["high"])

    r3cs, _ = m.estimate_bond_listing_price(100, 2, "AAA", issue_scale=None)   # 流通2亿(<3) -> ±3
    check("区间带 流通2亿 ±3 (low)", abs(r3cs["low"] - 152.0) < 0.01, "low=%s" % r3cs["low"])
    check("区间带 流通2亿 ±3 (high<=157.3)", abs(r3cs["high"] - 157.3) < 0.01, "high=%s" % r3cs["high"])

    # 9.3 摘要格式：非妖债/非封顶 显示区间「预估X–Y元」，不再单点「XXX元左右」
    check("summary 含区间 '–'", "–" in r500["summary"], "summary=%r" % r500["summary"])
    check("summary 不含旧式 '元左右'", "元左右" not in r500["summary"], "summary=%r" % r500["summary"])

    # 9.4 返回结构含 low/high 区间键
    check("返回含 low 键", "low" in r500)
    check("返回含 high 键", "high" in r500)

    # 9.5 回归：issue_scale=None 不报错（旧调用兼容）
    r0, err0 = m.estimate_bond_listing_price(100, 5, "AA", issue_scale=None)
    check("issue_scale=None 正常返回", err0 is None and r0 is not None)
except Exception as e:
    ERR.append("可转债预测(发行规模/区间): " + str(e))
    traceback.print_exc()


# ===== 汇总 =====
print("\n===== 结果汇总 =====")
print("PASS=%d  FAIL=%d  ERROR=%d" % (len(PASS), len(FAIL), len(ERR)))
if FAIL:
    print("失败项:", FAIL)
if ERR:
    print("异常项:", ERR)
print("OK" if not FAIL and not ERR else "HAS_ISSUES")
