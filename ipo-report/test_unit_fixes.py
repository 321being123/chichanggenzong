#!/usr/bin/env python3
# 局部单元验证：桩掉重型依赖后导入真实脚本，测试本次两处修复（隔离样本，避免无关规则干扰）
import sys, types

for _m in ("fitz", "db_pg", "tushare", "xgboost", "numpy", "pandas", "psycopg2"):
    sys.modules.setdefault(_m, types.ModuleType(_m))

import importlib.util
spec = importlib.util.spec_from_file_location(
    "ipo_daily_report_fix",
    r"D:\Users\持仓跟踪\portfolio-server\ipo-report\ipo_daily_report.py",
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
check("真实控股企业(宝钛集团)保留", any("宝钛集团" in e for e in entities), f"entities={entities}")
check("真实控股企业(宝鸡投资集团)保留",
      any("宝鸡投资" in e for e in entities), f"entities={entities}")
check("指数基金被排除(后缀命中路径)",
      not any("指数证券" in e or "证券投资基金" in e for e in entities), f"entities={entities}")
check("咨询类企业保留", any("咨询" in e for e in entities), f"entities={entities}")

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

print("\n结果:", "ALL PASS" if all(PASS) else f"{PASS.count(False)} FAILED")
sys.exit(0 if all(PASS) else 1)
