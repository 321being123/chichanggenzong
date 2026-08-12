# -*- coding: utf-8 -*-
"""
外部行情合约测试（依赖 Tushare / 外部行情与网络，CI 用 continue-on-error，不阻断普通 PR）。
运行：python ipo-report/test_ipo_contract.py
依赖：本地 PostgreSQL 已启动 + .env 含 PG* 与 TUSHARE_TOKEN
"""
import os
import sys
import re
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_daily_report as m

PASS, FAIL, ERR = [], [], []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  [PASS] %s %s" % (name, detail))
    else:
        FAIL.append(name)
        print("  [FAIL] %s %s" % (name, detail))


# ===== 1. fetch_calendar_entries（依赖 Tushare）=====
print("== 1. fetch_calendar_entries ==")
try:
    cal = m.fetch_calendar_entries()
    check("返回列表", isinstance(cal, list))
    bad = [x for x in cal if x.get("TRADE_DATE") == "nan"]
    check("无 'nan' 日期", len(bad) == 0, "污染数=%d" % len(bad))
    bad_fmt = [x for x in cal if x.get("TRADE_DATE") and
               x["TRADE_DATE"] != "nan" and
               not re.match(r"^\d{4}-\d{2}-\d{2}$", x["TRADE_DATE"])]
    check("日期格式 YYYY-MM-DD", len(bad_fmt) == 0, "异常=%s" % bad_fmt[:3])
    types_ok = all(x.get("SECURITY_TYPE") in ("0", "1") for x in cal)
    check("SECURITY_TYPE 取值合法", types_ok)
except Exception as e:
    ERR.append("fetch_calendar: " + str(e))
    traceback.print_exc()


# ===== 2. fetch_stock_detail（依赖 Tushare）=====
print("== 2. fetch_stock_detail(301677) ==")
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


# ===== 3. build_report（依赖 Tushare + 外部）=====
print("== 3. build_report(2026-07-15) ==")
try:
    import datetime
    md, data = m.build_report(datetime.datetime(2026, 7, 15))
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


# ===== 4. subscribe_mv / 行业PE映射（依赖 Tushare / 外部行情）=====
print("\n== 4. subscribe_mv / 行业PE映射 ==")

# 4.1 需配市值 = 顶格申购股数/1000(万) = limit_amount*10
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
    ERR.append("subscribe_mv: " + str(e))
    traceback.print_exc()

# 4.2 行业PE映射：取最近有日线数据的交易日，且能补全已上市股票行业PE
try:
    mp = m._get_industry_pe_map()
    check("行业PE映射非空", len(mp) > 0, "共 %d 行业" % len(mp))
    ind = m._fetch_stock_industry("300750.SZ")
    check("_fetch_stock_industry 返回行业", bool(ind), "行业=%r" % ind)
    if ind:
        check("行业PE映射可查到该行业", mp.get(ind) is not None, "行业PE=%s" % mp.get(ind))
except Exception as e:
    ERR.append("行业PE映射: " + str(e))


# ===== 汇总 =====
print("\n===== 结果汇总（外部行情合约测试）=====")
print("PASS=%d  FAIL=%d  ERROR=%d" % (len(PASS), len(FAIL), len(ERR)))
if FAIL:
    print("失败项:", FAIL)
if ERR:
    print("异常项:", ERR)
print("OK" if not FAIL and not ERR else "HAS_ISSUES")
