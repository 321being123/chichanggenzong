#!/usr/bin/env python3
# 局部单元验证：桩掉重型依赖后导入真实脚本，测试本次两处修复（隔离样本，避免无关规则干扰）
import contextlib
import io
import json
import os
import sys, types
from pathlib import Path

# 这是纯单元测试，显式关闭外部请求 Guard；生产脚本未配置时仍默认开启。
os.environ.setdefault("EXTERNAL_CALL_GUARD", "0")

for _m in ("fitz", "db_pg", "tushare", "xgboost", "numpy", "pandas", "psycopg2", "requests"):
    sys.modules.setdefault(_m, types.ModuleType(_m))

import importlib.util
import _common as common
import external_call_guard as call_guard
from sse_listing_parser import parse_sse_listing_detail, parse_sse_listing_index
from _common import _classify_tushare_error, TushareRequestError, _emit_tushare_failover
from external_call_guard import _circuit_api
spec = importlib.util.spec_from_file_location(
    "ipo_daily_report_fix",
    Path(__file__).resolve().parent / "ipo_daily_report.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

PASS = []


def check(name, cond, detail=""):
    PASS.append(cond)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}  {detail}")


# Python Guard 默认开启；只有测试/离线诊断显式 opt-out，生产环境不能关闭。
_guard_env_backup = {key: os.environ.get(key) for key in ("EXTERNAL_CALL_GUARD", "NODE_ENV", "APP_ENV")}
try:
    os.environ.pop("EXTERNAL_CALL_GUARD", None)
    os.environ.pop("NODE_ENV", None)
    os.environ.pop("APP_ENV", None)
    check("Guard 未配置时默认开启", call_guard.enabled() is True)
    os.environ["EXTERNAL_CALL_GUARD"] = "0"
    os.environ["NODE_ENV"] = "production"
    check("生产环境显式关闭仍保持开启", call_guard.enabled() is True)
    os.environ["NODE_ENV"] = "test"
    check("测试环境可显式关闭 Guard", call_guard.enabled() is False)
finally:
    for _key, _value in _guard_env_backup.items():
        if _value is None:
            os.environ.pop(_key, None)
        else:
            os.environ[_key] = _value


# ---------- Tushare 业务错误统一分类：HTTP 200 也必须进入接口熔断链 ----------
check("HTTP 200频率超限分类为RATE_LIMIT",
      _classify_tushare_error(40203, "频率超限") == "RATE_LIMIT")
check("HTTP 200当日次数耗尽分类为QUOTA_EXHAUSTED",
      _classify_tushare_error(40203, "当日调用次数已耗尽") == "QUOTA_EXHAUSTED")
check("HTTP 200 Token 数字错误码分类为AUTH_ERROR",
      _classify_tushare_error(401, "Unauthorized") == "AUTH_ERROR")
check("HTTP 200权限数字错误码分类为PERMISSION_DENIED",
      _classify_tushare_error(2002, "接口不可用") == "PERMISSION_DENIED")
check("上游接口日额度保持接口级熔断",
      _circuit_api("rt_min", "QUOTA_EXHAUSTED") == "rt_min")
check("Tushare业务错误保留api_name",
      TushareRequestError("RATE_LIMIT", "频率超限", "tushare", "rt_min", "fingerprint").api_name == "rt_min")
marker_output = io.StringIO()
with contextlib.redirect_stderr(marker_output):
    _emit_tushare_failover("rt_min", TushareRequestError("RATE_LIMIT", "频率超限", "tushare", "rt_min", "fingerprint"))
marker = json.loads(marker_output.getvalue().split(" ", 1)[1])
check("Python备用切换标记保留接口名", marker["api_name"] == "rt_min" and marker["to_role"] == "backup")


class _FakeCursor:
    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))


class _FakeConnection:
    def __init__(self):
        self.cursor_obj = _FakeCursor()

    def cursor(self):
        return self.cursor_obj

    def commit(self):
        pass

    def close(self):
        pass


fake_connection = _FakeConnection()
original_db_connect = call_guard._db_connect
call_guard._db_connect = lambda: fake_connection
try:
    call_guard.close_external_circuit("tushare", "rt_min", "fingerprint")
    call_guard.release_external_circuit_probe("tushare", "rt_min", "fingerprint")
finally:
    call_guard._db_connect = original_db_connect
close_sql, close_params = fake_connection.cursor_obj.calls[0]
release_sql, release_params = fake_connection.cursor_obj.calls[1]
check("Python Token级关闭同时覆盖通配熔断",
      "api_name=ANY(%s)" in close_sql and close_params[1] == ["rt_min", "*"])
check("Python Token级退避同时覆盖通配熔断",
      "api_name=ANY(%s)" in release_sql and release_params[2] == ["rt_min", "*"])


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


original_guarded_urlopen = common.guarded_urlopen
original_primary_token = common.TUSHARE_TOKEN
original_backup_token = common.TUSHARE_BACKUP_TOKEN
original_token_mode = common.TUSHARE_TOKEN_MODE
original_guard_enabled = os.environ.get("EXTERNAL_CALL_GUARD")
try:
    fake_responses = iter([
        {"code": 40203, "msg": "rt_min 频率超限"},
        {"code": 0, "data": {"fields": ["ts_code", "close"], "items": [["000001.SZ", 10]]}},
    ])
    common.TUSHARE_TOKEN = "unit-primary"
    common.TUSHARE_BACKUP_TOKEN = "unit-backup"
    common.TUSHARE_TOKEN_MODE = "auto"
    os.environ["EXTERNAL_CALL_GUARD"] = "0"
    common.guarded_urlopen = lambda *_args, **_kwargs: _FakeResponse(next(fake_responses))
    fallback_output = io.StringIO()
    with contextlib.redirect_stderr(fallback_output):
        fallback_rows = common._tushare("rt_min", {"ts_code": "000001.SZ"}, "ts_code,close")
    fallback_marker = json.loads(fallback_output.getvalue().split(" ", 1)[1])
    check("Python业务限流自动切备用", fallback_rows == [{"ts_code": "000001.SZ", "close": 10}]
          and fallback_marker["api_name"] == "rt_min")
finally:
    common.guarded_urlopen = original_guarded_urlopen
    common.TUSHARE_TOKEN = original_primary_token
    common.TUSHARE_BACKUP_TOKEN = original_backup_token
    common.TUSHARE_TOKEN_MODE = original_token_mode
    if original_guard_enabled is None:
        os.environ.pop("EXTERNAL_CALL_GUARD", None)
    else:
        os.environ["EXTERNAL_CALL_GUARD"] = original_guard_enabled


# ---------- 测试1：_extract_controller_names 收紧正则（隔离「后缀命中」路径） ----------
# 注意：只用 (有限|咨询|投资|合伙) 后缀命中来引入主体，避免 100%出资额 规则干扰
text = """
控股股东：宝钛集团有限公司
实际控制人：张某先生

前十大持有人包括：华夏中证白酒交易型开放式指数证券投资基金、宝鸡投资（集团）有限公司、永安咨询有限公司。
""".strip()
controllers, entities = mod._extract_controller_names(text)
check("明确控股股东保留", any("宝钛集团" in e for e in controllers), f"controllers={controllers}")
check("普通持有人不误判为控制企业",
      not any("宝鸡投资" in e or "永安咨询" in e for e in entities), f"entities={entities}")
check("指数基金被排除(后缀命中路径)",
      not any("指数证券" in e or "证券投资基金" in e for e in entities), f"entities={entities}")

# 玉禾转债真实公告书结构：控股股东直接持股，并通过控制另一企业间接持股。
yuhe_text = """
五、发行人控股股东和实际控制人情况
（一）控股股东
截至本上市公告书出具之日，西藏天之润直接持有发行人171,057,001股股份；同时，西藏天之润通过控制深圳鑫宏泰间接控制发行人3.54%的股份，因此，西藏天之润为发行人的控股股东。
公司名称
西藏天之润投资管理有限公司
（二）实际控制人
周平与周梦晨为父子关系，二人为发行人的共同实际控制人。
六、其他事项
""".strip()
yuhe_holders = [
    ("西藏天之润投资管理有限公司", 6_437_217, 42.91),
    ("深圳市鑫宏泰投资管理有限公司", 530_861, 3.54),
    ("王东焱", 281_924, 1.88),
]
yuhe_controllers, yuhe_entities = mod._extract_controller_names(yuhe_text, yuhe_holders)
yuhe_locked = mod._match_controller_holders(yuhe_holders, yuhe_controllers, yuhe_entities)
check("玉禾控股体系识别两名持有人", len(yuhe_locked) == 2, f"locked={yuhe_locked}")
yuhe_ctrl_zhang = sum(item[1] for item in yuhe_locked)
yuhe_total_zhang = mod._derive_total_zhang(yuhe_ctrl_zhang, sum(item[2] for item in yuhe_locked), 15.0)
yuhe_circulation = round((yuhe_total_zhang - yuhe_ctrl_zhang) * 100 / 100000000, 4)
check("玉禾流通规模约8.03亿元", 8.0 < yuhe_circulation < 8.1, f"circulation={yuhe_circulation}亿")

# 巨潮实际最多返回30条，不能因请求50条却只收到30条而误判为末页。
fetch_source = open(os.path.join(os.path.dirname(__file__), "ipo_lib_fetch.py"), encoding="utf-8").read()
check("巨潮公告分页不再按返回数小于请求数提前停止",
      "len(page_items or []) < 50" not in fetch_source and "total_announcement" in fetch_source)

# 科创板公告常用“控股股东、实际控制人基本信息如下”介绍自然人。
aiwei_text = """
四、发行人控股股东、实际控制人情况
截至2025年6月30日，孙洪军直接持有公司41.80%的股份。
公司控股股东、实际控制人基本信息如下：
孙洪军先生，中国国籍。
"""
aiwei_holders = [("孙洪军", 7_941_780, 41.77), ("某证券投资基金", 100_000, 0.53)]
aiwei_controllers, aiwei_entities = mod._extract_controller_names(aiwei_text, aiwei_holders)
aiwei_locked = mod._match_controller_holders(aiwei_holders, aiwei_controllers, aiwei_entities)
check("控股股东基本信息如下可识别自然人",
      aiwei_locked == [("孙洪军", 7_941_780, 41.77)],
      f"controllers={aiwei_controllers}, locked={aiwei_locked}")

# ---------- 测试2：_parse_bond_top10_holders 手单位 ×10 ----------
hand_text = """二、前十名可转换公司债券持有人
序号  持有人名称            持有数量（手）  持有比例
1
宝钛集团有限公司
1,800,000
8.50%
2
某财务公司
200,000
0.95%
"""
hands = mod._parse_bond_top10_holders(hand_text)
check("手单位表可解析", hands is not None, f"hands={hands}")
ctrl_hand = [a for n, a, _ in hands if "宝钛" in n][0]
check("手→张 ×10 折算正确", ctrl_hand == 18_000_000, f"ctrl_zhang={ctrl_hand}")

zhang_text = hand_text.replace("（手）", "（张）")
zhang = mod._parse_bond_top10_holders(zhang_text)
ctrl_zhang = [a for n, a, _ in zhang if "宝钛" in n][0]
check("张单位不折算", ctrl_zhang == 1_800_000, f"ctrl_zhang={ctrl_zhang}")

# 单位换行书写（宝钛真实格式：持有数量 与 （手） 分两行）
hand_nl = """二、前十名可转换公司债券持有人
序号  持有人名称            持有数量
（手）  持有比例
1
宝钛集团有限公司
1,800,000
8.50%
"""
hands_nl = mod._parse_bond_top10_holders(hand_nl)
ctrl_nl = [a for n, a, _ in hands_nl if "宝钛" in n][0]
check("单位换行(持有数量\\n（手）)仍×10", ctrl_nl == 18_000_000, f"ctrl_nl={ctrl_nl}")

# ---------- 测试3：流通规模量级合理（手单位修正后） ----------
issue_scale = 25.0  # 亿，合成发行规模，确保大于持有人合计
total_zhang = int(issue_scale * 100000000 / 100)
ctrl_zhang = sum(a for _, a, _ in hands)  # 18M + 2M = 20M 张
circulation = round((total_zhang - ctrl_zhang) * 100 / 100000000, 4)
check("流通规模量级合理(>0 且 <发行规模)",
      0 < circulation < issue_scale, f"circulation={circulation}亿")

# ---------- 测试4：发行总张数从公告书表格推导（宝钛真实口径） ----------
# 宝钛集团持有 16,996,090 张，占比 48.56% → 反推总规模 ≈ 35 亿 → 流通 ≈ 18 亿
baotai_ctrl = 16_996_090
baotai_pct = 48.56
derived = mod._derive_total_zhang(baotai_ctrl, baotai_pct, issue_scale)
check("宝钛: 总规模从占比反推≈35亿(非25亿)",
      34_000_000 <= derived <= 36_000_000,
      f"total_zhang={derived}张(≈{derived*100/100000000:.2f}亿)")
baotai_circ = round((derived - baotai_ctrl) * 100 / 100000000, 4)
check("宝钛: 流通规模≈18亿(非8亿)",
      17.0 < baotai_circ < 19.0, f"circulation={baotai_circ}亿")

# ---------- 测试5：一致性兜底（表格占比异常时退回 issue_scale） ----------
# 占比过小导致反推值远超 issue_scale → 应退回 scale_total
wild = mod._derive_total_zhang(baotai_ctrl, 2.0, issue_scale)
check("占比异常时退回 issue_scale 兜底",
      wild == 25_000_000, f"total_zhang={wild}")
# 占比缺失（None/0）→ 退回 scale_total
no_pct = mod._derive_total_zhang(baotai_ctrl, 0, issue_scale)
check("占比缺失时退回 issue_scale 兜底",
      no_pct == 25_000_000, f"total_zhang={no_pct}")

# ---------- 测试6：上交所上市/退市公告来源分类与字段解析 ----------
sse_index = """
<dd><span>2026-08-10</span>
<a href="/disclosure/announcement/listing/stock/c/c_20260810_10828514.shtml"
   title="关于申能股份有限公司可转换公司债券上市交易的公告">公告</a></dd>
"""
index_rows = parse_sse_listing_index(sse_index)
check("上交所列表识别可转债公告", len(index_rows) == 1, f"rows={index_rows}")
check("上交所来源分类正确",
      index_rows and index_rows[0]["source_code"] == "sse_listing_announcements",
      f"source={index_rows[0].get('source_code') if index_rows else None}")

sse_detail = """
<span id="searchTitle">关于申能股份有限公司可转换公司债券上市交易的公告</span>
<div class="article_opt"><i>2026-08-10</i></div>
<div class="allZoom"><p>上证公告（可转债上市）【2026】111号</p>
根据相关规定，申能股份有限公司发行的20亿元可转换公司债券将于2026年8月13日起在本所市场上市交易，证券代码为“110103”，证券简称为“申能转债”。
</div>
"""
detail = parse_sse_listing_detail(sse_detail, "https://www.sse.com.cn/example.shtml")
check("申能转债代码解析", detail["bond_code"] == "110103", f"detail={detail}")
check("申能转债上市日解析", detail["listing_date"] == "2026-08-13", f"listing_date={detail['listing_date']}")
check("申能转债发行规模解析", detail["issue_scale"] == 20.0, f"issue_scale={detail['issue_scale']}")
check("申能转债公告编号解析", detail["announcement_number"] == "2026-111", f"number={detail['announcement_number']}")
check("申能转债官方来源标记", detail["is_official"] and detail["event_type"] == "convertible_bond_listing",
      f"source={detail['source_class']}, event={detail['event_type']}")

# ---------- 测试7：上市首日腾讯行情与转股溢价率 ----------
tencent_payload = 'v_sz123277="51~玉禾转债~123277~130.000~100.000~130.000";'.encode('gbk')
check("带交易所后缀的深市转债可正确解析腾讯价格",
      mod._parse_tencent_bond_price(tencent_payload, "123277.SZ") == 130.0)
for code, market in (("110103", "sh"), ("113001", "sh"), ("118001", "sh"),
                     ("123277", "sz"), ("127001", "sz"), ("128001", "sz")):
    payload = f'v_{market}{code}="51~测试转债~{code}~123.456";'.encode('gbk')
    check(f"腾讯转债代码族 {code} 路由与解析正确",
          mod._parse_tencent_bond_price(payload, f"{code}.{market.upper()}") == 123.456)
transfer_value, premium_ratio = mod.calculate_conversion_metrics(16.28, 16.35, 130.0)
check("玉禾转债转股价值按同步正股价计算", transfer_value == 99.57, f"transfer_value={transfer_value}")
check("玉禾转债转股溢价率按真实债价计算", premium_ratio == 30.56, f"premium_ratio={premium_ratio}")
_, missing_premium = mod.calculate_conversion_metrics(16.28, 16.35, None)
check("已上市债价缺失时不伪造面值溢价率", missing_premium is None)
check("腾讯同步只覆盖正股价格、不覆盖Tushare基本面",
      '"price": live_stock["price"]' in fetch_source and '**{k: v for k, v in live_stock.items()' not in fetch_source)

print("\n结果:", "ALL PASS" if all(PASS) else f"{PASS.count(False)} FAILED")
sys.exit(0 if all(PASS) else 1)
