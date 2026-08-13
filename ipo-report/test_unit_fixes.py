#!/usr/bin/env python3
# 局部单元验证：桩掉重型依赖后导入真实脚本，测试本次两处修复（隔离样本，避免无关规则干扰）
import sys, types
from pathlib import Path

for _m in ("fitz", "db_pg", "tushare", "xgboost", "numpy", "pandas", "psycopg2", "requests"):
    sys.modules.setdefault(_m, types.ModuleType(_m))

import importlib.util
from sse_listing_parser import parse_sse_listing_detail, parse_sse_listing_index
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

print("\n结果:", "ALL PASS" if all(PASS) else f"{PASS.count(False)} FAILED")
sys.exit(0 if all(PASS) else 1)
