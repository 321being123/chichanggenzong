# -*- coding: utf-8 -*-
"""
确定性单元测试（不依赖 PostgreSQL / 外部行情，固定 fixture 或桩隔离，CI 必过）。
运行：python ipo-report/test_ipo_unit.py
"""
import os
import sys
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


# ===== 2. _to_ts_code 后缀处理（修复：已带后缀不得再拼 .SZ）=====
print("== 2. _to_ts_code 后缀处理 ==")
try:
    check("_to_ts_code 已带后缀不双拼", m._to_ts_code("300750.SZ") == "300750.SZ",
          "得到 %r" % m._to_ts_code("300750.SZ"))
    check("_to_ts_code 无后缀补.SZ", m._to_ts_code("301677") == "301677.SZ")
    check("_to_ts_code 沪市补.SH", m._to_ts_code("600000") == "600000.SH")
except Exception as e:
    ERR.append("_to_ts_code: " + str(e))


# ===== 3. 可转债预测：发行规模折扣 + 区间带（桩隔离外部行情）=====
print("== 3. 可转债预测：发行规模折扣 + 区间带 ==")
try:
    # 隔离外部依赖：强制用固定市场热度与基础溢价率，使结果可断言。
    # estimate_bond_listing_price 定义在 ipo_lib_valuation，其引用的
    # _fetch_all_bonds_market / fetch_market_heat 经 `from ... import *`
    # 进入 ipo_lib_valuation 命名空间，故桩必须打到该模块才生效。
    import ipo_lib_valuation as _val
    _val._fetch_all_bonds_market = lambda: []          # 空列表 -> 走 fallback: base_premium = market['avg_premium']
    _val.fetch_market_heat = lambda: {"index_level": "中性", "avg_premium": 0.30, "index_1m": 0.0}

    # 3.1 发行规模(总募资)折扣档位：TV=100 / 流通20亿(巨盘,-0.05) / AAA(+0.05)
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

    # 3.2 区间带宽度（ref_size = issue_scale 优先，否则流通规模）
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

    # 3.3 摘要格式：非妖债/非封顶 显示区间「预估X–Y元」，不再单点「XXX元左右」
    check("summary 含区间 '–'", "–" in r500["summary"], "summary=%r" % r500["summary"])
    check("summary 不含旧式 '元左右'", "元左右" not in r500["summary"], "summary=%r" % r500["summary"])

    # 3.4 返回结构含 low/high 区间键
    check("返回含 low 键", "low" in r500)
    check("返回含 high 键", "high" in r500)

    # 3.5 回归：issue_scale=None 不报错（旧调用兼容）
    r0, err0 = m.estimate_bond_listing_price(100, 5, "AA", issue_scale=None)
    check("issue_scale=None 正常返回", err0 is None and r0 is not None)
except Exception as e:
    ERR.append("可转债预测(发行规模/区间): " + str(e))
    traceback.print_exc()


# ===== 汇总 =====
print("\n===== 结果汇总（确定性单元测试）=====")
print("PASS=%d  FAIL=%d  ERROR=%d" % (len(PASS), len(FAIL), len(ERR)))
if FAIL:
    print("失败项:", FAIL)
if ERR:
    print("异常项:", ERR)
print("OK" if not FAIL and not ERR else "HAS_ISSUES")
