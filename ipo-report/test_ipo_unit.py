# -*- coding: utf-8 -*-
"""
确定性单元测试（不依赖 PostgreSQL / 外部行情，固定 fixture 或桩隔离，CI 必过）。
运行：python ipo-report/test_ipo_unit.py
"""
import os
import sys
import traceback
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_daily_report as m
import ipo_lib_fetch as fetch
import _common as common
import calendar_core
from ipo_lib_liquidity import calculate_adjustment_from_samples, liquidity_bucket, robust_mean
from ipo_lib_historical_prediction import (
    historical_base_price,
    prior_liquidity_samples,
    rollback_prediction,
)
from datetime import datetime

PASS, FAIL, ERR = [], [], []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  [PASS] %s %s" % (name, detail))
    else:
        FAIL.append(name)
        print("  [FAIL] %s %s" % (name, detail))


check("新股预测价格入库换算", m._price_from_return(84.46, 100) == 168.92)
check("新债实际价格入库换算", m._price_from_return(100, 23.5) == 123.5)
check("流通规模细分8-10亿", liquidity_bucket(8.03)[1] == "中大盘(8-10亿)")
check("小规模按1亿元梯度分组",
      liquidity_bucket(1.2)[0] == liquidity_bucket(1.8)[0]
      and liquidity_bucket(2.1)[0] == liquidity_bucket(2.9)[0]
      and liquidity_bucket(1.9)[0] != liquidity_bucket(2.1)[0])
check("小样本平均使用中位数", robust_mean([1, 2, 100]) == 2)

print("== 招股书主营业务/赛道提取 ==")
try:
    highkai_fixture = (
        "四、发行人主营业务情况 "
        "公司专业从事精密流体控制领域中关键控制部件及相关设备的研发、生产与销售。 "
        "公司所属行业领域 □新一代信息技术 □新材料 √高端装备 □新能源 "
        "五、发行人报告期的主要财务数据和财务指标"
    )
    parsed_business = fetch._extract_main_business(highkai_fixture) or ""
    check("主营业务不误取目录/财务章节",
          "精密流体控制领域中关键控制部件及相关设备的研发、生产与销售" in parsed_business
          and "财务数据" not in parsed_business,
          "结果=%r" % parsed_business)
    check("主营赛道读取高端装备",
          "所属行业：高端装备" in parsed_business,
          "结果=%r" % parsed_business)
except Exception as e:
    ERR.append("主营业务/赛道提取: " + str(e))

recent_liquidity_samples = [
    {"circulation_scale": scale, "residual_pp": residual}
    for scale, residual in [(2.1, 12), (2.2, 10), (2.3, 14), (2.4, 8), (2.15, 11), (2.35, 9),
                            (8.0, 2), (9.0, 0)]
]
older_liquidity_samples = [
    {"circulation_scale": scale, "residual_pp": residual}
    for scale, residual in [(2.1, 8), (2.2, 6), (2.3, 10), (2.4, 4), (8.0, 0), (9.0, -2)]
]
dynamic_adjustment = calculate_adjustment_from_samples(
    2.25, recent_liquidity_samples, older_liquidity_samples
)
check("流通影响按近3月70%和第4至6月30%加权",
      dynamic_adjustment["adjustment_pp"] == 9.45,
      "adjustment=%s" % dynamic_adjustment["adjustment_pp"])
inactive_adjustment = calculate_adjustment_from_samples(2.25, [], [])
check("动态流通调整无符合样本时不启用", inactive_adjustment["adjustment_pp"] == 0)

sparse_cross_bucket_samples = [
    {"circulation_scale": scale, "residual_pp": residual}
    for scale, residual in [(17.6984, 27.28), (2.6723, 49.67), (3.0917, 59.50),
                            (1.2495, 59.20), (77.6359, 10.75)]
]
sparse_adjustment = calculate_adjustment_from_samples(8.0332, sparse_cross_bucket_samples, [])
check("流通规模样本稀疏时不跨多档凑样本",
      sparse_adjustment["adjustment_pp"] == 0,
      "adjustment=%s" % sparse_adjustment["adjustment_pp"])

single_adjustment = calculate_adjustment_from_samples(
    8.0332, [{"circulation_scale": 8.417, "residual_pp": 11.72}], []
)
check("流通规模只有一个符合样本时直接采用",
      single_adjustment["adjustment_pp"] == 11.72,
      "adjustment=%s" % single_adjustment["adjustment_pp"])

real_priority = calculate_adjustment_from_samples(
    8.03,
    [
        {"circulation_scale": 8.4, "residual_pp": 25, "is_backfilled": True},
        {"circulation_scale": 8.2, "residual_pp": 4, "is_backfilled": False},
    ],
    [],
)
check("真实日报样本覆盖历史回滚样本",
      real_priority["adjustment_pp"] == 4
      and real_priority["recent"]["sample_source"] == "live")

base_fixture = historical_base_price(
    82.32,
    [
        {"conversion_value": 81, "conversion_premium_pct": 20},
        {"conversion_value": 84, "conversion_premium_pct": 30},
        {"conversion_value": 88, "conversion_premium_pct": 40},
    ],
    rating="AA", issue_scale=20, bond_name="测试债", stock_name="测试股",
)
check("历史回滚基础价只使用预测日前市场截面",
      base_fixture["base_price_no_liquidity"] == 107.02
      and base_fixture["market_sample_count"] == 3)

recent_fixture, older_fixture = prior_liquidity_samples(
    [
        {"listing_date": "2026-08-01", "circulation_scale": 5.5, "residual_pp": 8},
        {"listing_date": "2026-01-01", "circulation_scale": 5.4, "residual_pp": 30},
        {"listing_date": "2026-09-01", "circulation_scale": 5.4, "residual_pp": 99},
    ],
    "2026-08-16",
)
check("历史回滚严格排除预测日之后样本",
      len(recent_fixture) == 1 and len(older_fixture) == 0)

rollback_fixture = rollback_prediction(
    82.32, 5.5,
    [
        {"conversion_value": 81, "conversion_premium_pct": 20},
        {"conversion_value": 84, "conversion_premium_pct": 30},
        {"conversion_value": 88, "conversion_premium_pct": 40},
    ],
    "2026-08-16", [], rating="AA", issue_scale=20,
    bond_name="测试债", stock_name="测试股",
)
check("历史回滚同时生成基础价和预测价",
      rollback_fixture["base_price_no_liquidity"] == 107.02
      and rollback_fixture["tracking_price"] == 107.02
      and rollback_fixture["liquidity_adjustment_pp"] == 0)


check("psql 路径适配当前系统", os.name == "nt" or not common.PSQL.lower().startswith("c:\\"), common.PSQL)

try:
    old_tushare = calendar_core._tushare
    calendar_core._tushare = lambda *_args, **_kwargs: [
        {"cal_date": "20261001", "is_open": "0"},
        {"cal_date": "20261002", "is_open": "1"},
    ]
    check("下一个实际交易日跳过节假日", calendar_core.next_trading_date(datetime(2026, 9, 30)).strftime("%Y-%m-%d") == "2026-10-02")
finally:
    calendar_core._tushare = old_tushare

try:
    old_tushare = calendar_core._tushare
    old_bond_layer = sys.modules.get("bond_data_layer")
    save_calls = []

    def fake_calendar_tushare(api, params, fields):
        if api == "new_share":
            return [{"ts_code": "301001.SZ", "name": "测试股", "ipo_date": "20260812", "issue_date": "20260813"}]
        if api == "cb_issue":
            return [{"ts_code": "113099.SH", "onl_name": "测试债", "onl_date": "20260813", "ann_date": "20260801"}]
        if api == "cb_basic":
            raise RuntimeError("cb_basic unavailable")
        raise AssertionError(api)

    layer = types.ModuleType("bond_data_layer")
    layer.save_cb_issue_rows = lambda issues, basics, ratings: save_calls.append((issues, basics, ratings))
    sys.modules["bond_data_layer"] = layer
    calendar_core._tushare = fake_calendar_tushare
    calendar_rows = calendar_core.fetch_calendar_entries("2026-08-01", "2026-08-31")
    check("cb_basic 失败时日历仍保留新债", any(row.get("SECURITY_CODE") == "113099" for row in calendar_rows))
    check("cb_issue 成功时仍写入统一层", len(save_calls) == 1)
finally:
    calendar_core._tushare = old_tushare
    if old_bond_layer is None:
        sys.modules.pop("bond_data_layer", None)
    else:
        sys.modules["bond_data_layer"] = old_bond_layer


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
    _old_market_temp = dict(_val._MARKET_TEMP)
    _val._MARKET_TEMP.clear()
    _val._MARKET_TEMP.update({"level": "热市", "break_rate": 0, "avg_gain_3m": 0})
    hot_zero_advice = _val.get_valuation_advice(
        "stock", 38.19, None,
        stock_detail={"stock_code": "001232", "stock_name": "嘉立创", "issue_price": 84.46, "fund_raised": 46.93},
    )
    check("新股热市且零破发一律顶格申购", hot_zero_advice[0] == "顶格申购", "实得=%s" % (hot_zero_advice,))
    _val._MARKET_TEMP.clear()
    _val._MARKET_TEMP.update(_old_market_temp)
    check("XGBoost模型文件可加载", _val._load_xgb_model())
    model_prediction = _val._xgb_predict_listing({
        "stock_code": "688001", "issue_price": 20, "issue_pe": 30,
        "industry_pe": 35, "fund_raised": 10, "online_lottery_rate": 0.03,
        "circulation_mv": 5,
    })
    check("XGBoost可完成新股预测", model_prediction is not None)
    summary_125 = _val._format_listing_summary(
        125,
        {"stock_code": "301668", "issue_price": 84.46},
        "热市",
    )
    check("新股125%按50%档位向下显示100%", "约100%" in summary_125, "summary=%r" % summary_125)
    check("新股摘要包含单签收益", "预计首日单签收益4万元" in summary_125, "summary=%r" % summary_125)
    _old_xgb_for_floor = _val._xgb_predict_listing
    _old_sector_for_floor = _val.detect_stock_hot_sector
    _old_temp_multiplier_for_floor = _val.get_temp_listing_multiplier
    _val._xgb_predict_listing = lambda *args, **kwargs: (125.99, ["测试"], None)
    _val.detect_stock_hot_sector = lambda *args, **kwargs: ("", 1.0)
    _val.get_temp_listing_multiplier = lambda: 1.0
    floored = _val.get_listing_analysis(
        "stock", 10, None, None,
        stock_detail={"stock_code": "001234", "issue_price": 10},
    )
    check("新股预计涨幅按50%档位向下取整", floored.get("predicted_return") == 100,
          "predicted_return=%r" % floored.get("predicted_return"))
    _val._xgb_predict_listing = _old_xgb_for_floor
    _val.detect_stock_hot_sector = _old_sector_for_floor
    _val.get_temp_listing_multiplier = _old_temp_multiplier_for_floor
    sector = _val.detect_stock_hot_sector("测试", "印制电路板（PCB）研发和生产", "电子元器件")
    check("PCB赛道无历史样本时按中性系数识别", sector[0] in ("PCB", "印制电路板") and sector[1] == 1.0,
          "sector=%r" % (sector,))
    industry_fallback = _val.detect_stock_hot_sector("测试", "普通产品研发和生产", "专用设备")
    check("未命中热门赛道时按行业中性兜底", industry_fallback == ("专用设备", 1.0),
          "sector=%r" % (industry_fallback,))
    no_industry_fallback = _val.detect_stock_hot_sector("测试", "普通产品研发和生产", "")
    check("行业缺失时仍有中性赛道系数", no_industry_fallback == ("其他赛道", 1.0),
          "sector=%r" % (no_industry_fallback,))
    _val._fetch_all_bonds_market = lambda: []          # 空列表 -> 走 fallback: base_premium = market['avg_premium']
    _val.fetch_market_heat = lambda: {"index_level": "中性", "avg_premium": 0.30, "index_1m": 0.0}
    _val.calculate_liquidity_adjustment = lambda cs, *_args: {
        "adjustment_pp": -5.0 if float(cs) >= 10 else (20.0 if float(cs) < 3 else 0.0),
        "bucket_label": liquidity_bucket(cs)[1], "sample_count": 8,
        "weight_text": "测试样本", "model_version": "dynamic_residual_v1",
    }
    _old_xgb = _val._xgb_predict_listing
    _val._xgb_predict_listing = lambda *args, **kwargs: None
    fallback = _val.get_listing_analysis("stock", 10, None, None, stock_detail={"stock_code": "001234"})
    check("新股线性模型回退已初始化", fallback.get("predicted_return") is not None)
    _val._xgb_predict_listing = _old_xgb

    sample_md = "#### 测试新股（688001）\n- **首日预估**：100%\n\n### 💰 新债申购\n\n| 债券 | 内容 |"
    stock_section = m._extract_code_sections(sample_md).get("688001", "")
    check("新股单独报告不混入新债", "新债申购" not in stock_section)

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

    # 3.3 摘要格式：最终理论价按5元档向下取整，不显示首日交易上限替代值。
    check("summary 显示向下取整后的最终价格", r500["summary"] == "110元左右", "summary=%r" % r500["summary"])
    capped_result, _ = m.estimate_bond_listing_price(108, 2, "AAA", issue_scale=None)
    check("理论估值167元向下展示165元左右",
          capped_result["price"] == 157.3
          and capped_result["display_price"] == 165
          and capped_result["summary"] == "165元左右",
          "price=%s display=%s summary=%s" % (
              capped_result["price"], capped_result["display_price"], capped_result["summary"]))

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
