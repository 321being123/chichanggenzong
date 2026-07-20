# 本文件由 ipo_daily_report.py 物理拆分而来，函数体/常量未改动，仅调整文件归属。
import requests
import json
import os
import re
from collections import defaultdict
import time
from datetime import datetime, timedelta
import fitz  # PyMuPDF - PDF解析
import db_pg  # PostgreSQL 数据层
from calendar_core import _str_date, build_upcoming_calendar, fetch_calendar_entries
from _classify import _is_bj_stock, _market_type_to_board_key
from _common import _load_env
from ipo_lib_common import *
from ipo_lib_fetch import *
from ipo_lib_sector import *
from ipo_lib_prediction import *

def get_temp_pe_penalty(issue_pe, industry_pe):
    """
    根据市场温度计算PE惩罚/奖励系数
    返回 >1=奖励, <1=惩罚, 1=无变化
    """
    temp = _MARKET_TEMP["level"]
    if not issue_pe or not industry_pe or industry_pe <= 0:
        return 1.0

    pe_ratio = issue_pe / industry_pe

    if temp == "热市":
        if pe_ratio < 0.7:
            return 1.2
        return 1.0
    elif temp == "常温":
        if pe_ratio < 0.7:
            return 1.15
        elif pe_ratio > 2:
            return 0.85
        elif pe_ratio > 1.5:
            return 0.92
        return 1.0
    else:  # 冷市
        if pe_ratio < 0.7:
            return 1.05
        elif pe_ratio > 2:
            return 0.6
        elif pe_ratio > 1.5:
            return 0.75
        elif pe_ratio > 1.2:
            return 0.88
        return 1.0

def get_temp_temp_score_penalty(score):
    """
    根据市场温度对综合评分做整体衰减/放大
    """
    temp = _MARKET_TEMP["level"]
    if temp == "热市":
        return score  # 不动
    elif temp == "常温":
        return int(score * 0.85)  # 打85折
    else:  # 冷市
        return int(score * 0.5)  # 打5折

def get_temp_listing_multiplier():
    """
    根据市场温度返回上市预测的涨幅衰减系数
    """
    temp = _MARKET_TEMP["level"]
    if temp == "热市":
        return 1.0
    elif temp == "常温":
        return 0.75
    else:  # 冷市
        return 0.4

def _get_market_premium_curve(bonds_data):
    """
    从全市场转债数据构建"转股价值 → 溢价率"映射表

    按转股价值10元一档，取每档中位数溢价率。
    返回: {转股价值区间: 中位数溢价率} 的字典
    """
    curve = {}
    for lo in range(0, 300, 10):
        hi = lo + 10
        group = sorted([d[3] for d in bonds_data if lo <= d[2] < hi])
        if len(group) >= 3:
            curve[(lo, hi)] = group[len(group) // 2]
    return curve

def _estimate_initial_premium_by_iteration(transfer_value, bonds_data):
    """
    转股价值分档中位数法估算新债上市首日基础溢价率

    算法：
    1. 转股价值向下取整到10元档（如122.45 → 120-130区间）
    2. 取该区间内全市场转债溢价率的中位数
    3. 样本不足时扩大范围到±15、±25，最终fallback到全市场中位数

    为什么用转股价值分档：
    - 转债溢价率主要由转股价值决定（债性/股性二元结构）
    - 同转股价值区间的转债，市场给予的溢价率相近
    - 中位数比平均数更稳健，不受极端妖债影响
    """
    tv = float(transfer_value)

    # 转股价值10元一档
    bucket = int(tv // 10) * 10
    bucket_prems = sorted([d[3] for d in bonds_data if bucket <= d[2] < bucket + 10])

    if len(bucket_prems) >= 3:
        return bucket_prems[len(bucket_prems) // 2] / 100

    # 样本不足：扩大到转股价值±15
    nearby = sorted([d[3] for d in bonds_data if abs(d[2] - tv) <= 15])
    if len(nearby) >= 3:
        return nearby[len(nearby) // 2] / 100

    # 再扩大到±25
    nearby = sorted([d[3] for d in bonds_data if abs(d[2] - tv) <= 25])
    if len(nearby) >= 3:
        return nearby[len(nearby) // 2] / 100

    # 最终fallback：全市场中位数
    all_prems = sorted([d[3] for d in bonds_data])
    if all_prems:
        return all_prems[len(all_prems) // 2] / 100

    return 0.40  # 默认40%

def _calc_xgb_boost(stock_detail, xgb_raw):
    """根据板块基准和市场温度，计算XGBoost动态调整系数"""
    if xgb_raw is None or xgb_raw <= 0:
        return 1.0

    code = stock_detail.get("stock_code", "")
    board_key = _get_board_key_from_code(code)
    board_base = BOARD_BASE.get(board_key, 200)

    # 目标：让XGBoost预测值向板块基准收敛
    # 如果XGBoost明显低于板块基准（在牛市常见），则向上修正
    ratio = board_base / max(xgb_raw, 10)

    # 热市下，如果板基准远高于XGBoost，加大修正力度
    temp = _MARKET_TEMP["level"]
    if temp == "热市":
        # 热市时板基准置信度高，主动拉高XGBoost
        boost = 1.0 + (ratio - 1.0) * 0.6
    elif temp == "常温":
        boost = 1.0 + (ratio - 1.0) * 0.3
    else:
        # 冷市：不向上修正，反而保守
        boost = 1.0

    # 限制范围 0.5x ~ 3.0x
    boost = max(0.5, min(3.0, boost))
    return round(boost, 3)

def estimate_bond_listing_price(transfer_value, circulation_scale, rating,
                                 stock_code="", bond_name="", stock_name="", stock_industry="",
                                 issue_scale=None):
    """
    新债上市首日价格预估 - 五因子模型（迭代收敛法）

    核心思路（用户方法论）：
    1. 用全市场平均溢价率估算新债首日价格P1
    2. 在市场中找价格≈P1的同类转债，看它们的平均溢价率 → 修正
    3. 用修正后溢价率重新算价格P2
    4. 重复直到收敛
    5. 在收敛后的基础溢价率上，叠加流通规模/评级/行业加成

    公式：上市首日价格 = 转股价值 × (1 + 迭代收敛溢价率 + 流通调整 + 评级调整 + 行业加成)

    上市首日沪深两市顶格均为 157.3元
    """
    if transfer_value is None:
        return None, "转股价值数据缺失"

    tv = float(transfer_value)

    # ── 0. 获取全市场数据和热度 ──
    bonds_data = _fetch_all_bonds_market()
    market = fetch_market_heat()
    market_level = market["index_level"]
    index_1m = market.get("index_1m", 0)

    # ── 1. 迭代收敛法计算基础溢价率 ──
    if bonds_data and len(bonds_data) >= 30:
        base_premium = _estimate_initial_premium_by_iteration(tv, bonds_data)
    else:
        # fallback: 用默认值
        base_premium = market["avg_premium"]

    # 动量修正：近1月中证转债指数涨跌影响情绪
    momentum_adj = index_1m * 0.02

    # ── 2. 流通规模调整（基于新上市转债统计校准，2026-06-18） ──
    # 统计结论：新债流通规模越小，溢价率越高，倒U型峰值在1.5-2亿
    # scale_adj 是在转股价值分档中位数基础溢价率之上的增量调整
    scale_adj = 0
    scale_label = ""
    is_yaozhai = False
    if circulation_scale is not None:
        cs = float(circulation_scale)
        if cs < 1:
            # 妖债：流通<1亿，额外大幅加成（保留原有转股价值联动逻辑）
            if market_level == "高估":
                yaozhai_base = 1.20
            elif market_level == "偏高":
                yaozhai_base = 1.00
            elif market_level == "中性偏低":
                yaozhai_base = 0.70
            else:
                yaozhai_base = 0.55
            scale_adj = yaozhai_base * (1 + tv / 100)
            scale_label = f"妖债(流通{cs}亿)"
            is_yaozhai = True
        elif cs < 1.5:
            scale_adj = 0.55
            scale_label = "小妖(1-1.5亿)"
            is_yaozhai = True
        elif cs < 2:
            scale_adj = 0.30
            scale_label = "中妖(1.5-2亿)"
            is_yaozhai = True
        elif cs < 3:
            scale_adj = 0.20
            scale_label = "小盘(2-3亿)"
        elif cs < 5:
            scale_adj = 0.12
            scale_label = "中盘(3-5亿)"
        elif cs < 10:
            scale_adj = 0.05
            scale_label = "大盘(5-10亿)"
        else:
            scale_adj = -0.05
            scale_label = "巨盘(>10亿)"

    # ── 2.5 发行规模(总募资)折扣（用户2026-07-15：巨无霸转债溢价率明显高估，需额外下修）──
    # 与流通规模折扣叠加；按总募资档位给固定负向调整（温和梯度）
    issue_adj = 0
    issue_scale_label = ""
    if issue_scale is not None:
        try:
            isz = float(issue_scale)
        except (TypeError, ValueError):
            isz = 0
        if isz >= 300:
            issue_adj = -0.18
            issue_scale_label = f"超大盘(总募资{isz:.0f}亿)"
        elif isz >= 100:
            issue_adj = -0.10
            issue_scale_label = f"大盘(总募资{isz:.0f}亿)"
        elif isz >= 50:
            issue_adj = -0.05
            issue_scale_label = f"中大盘(总募资{isz:.0f}亿)"

    # ── 3. 评级调整 ──
    rating_adj = 0
    if rating:
        if rating.startswith("AAA"):
            rating_adj = 0.05
        elif rating.startswith("AA+"):
            rating_adj = 0.03
        elif rating.startswith("AA"):
            rating_adj = 0
        elif rating.startswith("AA-"):
            rating_adj = -0.02
        elif rating:
            rating_adj = -0.05

    # ── 4. 行业炒作加成 ──
    sector_label, sector_boost = detect_hot_sector(bond_name, stock_name, stock_industry)
    if sector_boost == 0 and stock_industry:
        # 再尝试只用行业名搜索
        sector_label, sector_boost = detect_hot_sector("", "", stock_industry)

    # ── 5. 计算预估价格 ──
    total_premium = base_premium + scale_adj + rating_adj + sector_boost + issue_adj
    estimated_price = round(tv * (1 + total_premium), 2)
    tracking_price = estimated_price  # 首个非涨停日理论价格，不受上市首日157.3元限制

    # 上市首日沪深两市顶格均为 157.3元，模型估值超过则封顶
    capped = False
    cap_reason = ""
    if estimated_price > 157.3:
        estimated_price = 157.3
        capped = True
    second_day_limit = capped and tracking_price >= round(157.3 * 1.2, 1)
    if capped:
        cap_reason = "⚠️ 受上市首日157.3元上限限制"
        if second_day_limit:
            cap_reason += "，预计次日继续涨停"

    # ── 6.5 预测区间带（规模越大不确定性越大，带宽越宽）──
    ref_size = issue_scale if issue_scale is not None else circulation_scale
    try:
        rs = float(ref_size)
    except (TypeError, ValueError):
        rs = 0
    if rs >= 50:
        band_unit = 10
    elif rs >= 20:
        band_unit = 7
    elif rs >= 5:
        band_unit = 5
    else:
        band_unit = 3
    low_price = max(100.0, round(estimated_price - band_unit, 2))
    high_price = min(157.3, round(estimated_price + band_unit, 2))

    # ── 6. 生成详细说明 ──
    premium_pct = round(total_premium * 100, 1)
    detail_parts = []
    detail_parts.append(f"📊 预估上市价: {estimated_price}元（溢价率 {premium_pct}%）")

    # 市场热度
    detail_parts.append(f"🔥 市场热度: {market_level}（全市场平均溢价率 {round(market['avg_premium']*100,1)}%，"
                        f"近1月指数 {index_1m:+.1f}%）")

    # 转股价值 + 基础溢价率
    detail_parts.append(f"📈 转股价值 {tv}元 → 转股价值分档中位数得基础溢价 {round(base_premium*100,1)}%")
    detail_parts.append(f"   （方法：在全市场{len(bonds_data)}只转债中，取同转股价值区间的溢价率中位数）")

    # 流通规模
    if scale_label:
        detail_parts.append(f"💰 流通规模 {circulation_scale}亿 → {scale_label}，调整 {round(scale_adj*100,1)}%")

    # 发行规模(总募资)
    if issue_scale_label:
        detail_parts.append(f"🏦 发行规模 {issue_scale}亿 → {issue_scale_label}，调整 {round(issue_adj*100,1)}%")

    # 评级
    if rating:
        detail_parts.append(f"⭐ 评级 {rating} → 调整 {round(rating_adj*100,1)}%")

    # 行业炒作
    if sector_label:
        detail_parts.append(f"🚀 行业加成: {sector_label}热门赛道 → +{round(sector_boost*100,1)}%")

    # 上限
    if capped:
        detail_parts.append(cap_reason)

    # 生成简洁摘要：非封顶预测统一取最接近的 5 元整数，并用“左右”表达模糊区间。
    rounded_price = int((estimated_price + 2.5) // 5 * 5)
    if capped:
        range_text = "预估157.3元"
        if second_day_limit:
            range_text += "（预计次日继续涨停）"
    else:
        suffix = "，注意破发风险" if estimated_price < 105 else ""
        prefix = "🔥 妖债，" if is_yaozhai else ""
        range_text = f"{prefix}预估{rounded_price}元左右{suffix}"

    return {
        "price": estimated_price,
        "tracking_price": tracking_price,
        "premium": premium_pct,
        "detail": "\n".join(detail_parts),
        "summary": range_text,
        "low": low_price,
        "high": high_price,
        "capped": capped,
        "second_day_limit": second_day_limit,
        "is_yaozhai": is_yaozhai,
        "market_level": market_level,
    }, None

def get_valuation_advice(item_type, issue_pe, industry_pe, rating=None, stock_detail=None):
    """基于估值给出打新建议（2025-2026年零破发环境适配版）"""
    if item_type == "bond":
        # 可转债申购建议：零破发环境一律顶格，出现破发后按评级分档
        bond_temp = _BOND_MARKET_TEMP
        if bond_temp.get("break_rate", 0) == 0:
            return "顶格申购", "当前可转债零破发，中签即赚"
        if rating and rating.startswith("AAA"):
            return "顶格申购", "优质AAA级转债，破发风险极低"
        elif rating and rating.startswith("AA"):
            return "顶格申购", "AA级转债，安全性较高"
        elif rating and rating.startswith("A"):
            return "可以申购", "A级转债，注意正股基本面"
        else:
            return "可以申购", "转债打新整体风险可控"

    # ── 新股申购建议（市场温度自适应版） ──

    if stock_detail is None:
        stock_detail = {}

    stock_code = stock_detail.get("stock_code", "")
    stock_name = stock_detail.get("stock_name", "")
    main_business = stock_detail.get("main_business", "")
    industry = stock_detail.get("industry", "")
    issue_price = stock_detail.get("issue_price")
    fund_raised = stock_detail.get("fund_raised")

    # 判断板块
    board_base = estimate_board_base(stock_code)

    # 检测热门赛道
    sector_label, sector_boost = detect_stock_hot_sector(stock_name, main_business, industry)

    # 综合评分（用于判断建议等级）
    score = board_base  # 板块基准

    if sector_label:
        # 赛道加成
        score = int(score * (1 + sector_boost * 0.3))

    # 市场温度 + PE修正
    temp_pe = get_temp_pe_penalty(issue_pe, industry_pe)
    score = int(score * temp_pe)

    # 市场温度整体衰减
    score = get_temp_temp_score_penalty(score)

    # 发行价修正：低价股涨幅通常更大，高价股压制
    if issue_price:
        if issue_price < 15:
            score = int(score * 1.15)
        elif issue_price < 30:
            score = int(score * 1.05)
        elif issue_price > 50:
            score = int(score * 0.90)

    # 募资规模修正：超大募资可能压制涨幅
    if fund_raised and fund_raised > 50:
        score = int(score * 0.85)

    # 中签率修正：中签率越低 = 申购越热 = 涨幅越大
    lottery_rate = stock_detail.get("online_lottery_rate")
    lottery_reason = ""
    if lottery_rate is not None and lottery_rate > 0:
        if lottery_rate < 0.02:
            score = int(score * 1.15)
            lottery_reason = "极低中签率"
        elif lottery_rate < 0.03:
            score = int(score * 1.10)
            lottery_reason = "低中签率"
        elif lottery_rate < 0.05:
            score = int(score * 1.05)
            lottery_reason = "较低中签率"
        elif lottery_rate > 0.12:
            score = int(score * 0.88)
            lottery_reason = "高中签率"
        elif lottery_rate > 0.08:
            score = int(score * 0.95)
            lottery_reason = "较高中签率"

    # 首日流通市值修正：流通盘越小越容易被炒作
    cmv = stock_detail.get("circulation_mv")
    cmv_reason = ""
    if cmv is not None and cmv > 0:
        if cmv < 3:
            score = int(score * 1.25)
            cmv_reason = "极小流通盘"
        elif cmv < 6:
            score = int(score * 1.15)
            cmv_reason = "小流通盘"
        elif cmv < 10:
            score = int(score * 1.05)
            cmv_reason = "较小流通盘"
        elif cmv > 50:
            score = int(score * 0.80)
            cmv_reason = "超大流通盘"
        elif cmv > 20:
            score = int(score * 0.90)
            cmv_reason = "较大流通盘"

    # 机构超额认购倍数：倍数越高 = 机构越看好
    oversub = stock_detail.get("oversubscribe_multiple")
    oversub_reason = ""
    if oversub is not None and oversub > 0:
        if oversub > 5000:
            score = int(score * 1.10)
            oversub_reason = "高认购倍数"
        elif oversub > 3000:
            score = int(score * 1.05)
            oversub_reason = "较高认购倍数"
        elif oversub < 500:
            score = int(score * 0.92)
            oversub_reason = "低认购倍数"

    temp = _MARKET_TEMP["level"]

    # 生成理由中的额外因子说明
    extra_reasons = []
    if lottery_reason:
        extra_reasons.append(lottery_reason)
    if cmv_reason:
        extra_reasons.append(cmv_reason)
    if oversub_reason:
        extra_reasons.append(oversub_reason)

    # 生成建议和理由
    extra_str = "，".join(extra_reasons)
    if extra_str:
        extra_str = f"（{extra_str}）"

    if temp != "冷市":
        if score >= 500:
            advice = "顶格申购"
            if sector_label:
                reason = f"热门赛道({sector_label})，预计首日涨幅可观{extra_str}"
            else:
                reason = f"板块优质，预计首日涨幅较高{extra_str}"
        elif score >= 300:
            advice = "顶格申购"
            reason = f"预计首日涨幅良好{extra_str}"
            if sector_label:
                reason += f"，{sector_label}赛道加持"
        elif score >= 150:
            advice = "顶格申购"
            if sector_label:
                reason = f"当前市场零破发，中签即赚，{sector_label}赛道加持{extra_str}"
            else:
                reason = f"当前市场零破发，中签即赚{extra_str}"
        else:
            advice = "可以申购"
            reason = f"当前市场零破发，中签即赚{extra_str}"
    else:
        # 冷市：新增谨慎/不建议等级
        if score >= 400:
            advice = "顶格申购"
            reason = "冷市中相对优质，注意控制仓位"
        elif score >= 200:
            advice = "可以申购"
            reason = "冷市环境下，建议谨慎参与"
        elif score >= 100:
            advice = "谨慎申购"
            reason = "市场降温，破发风险上升"
        else:
            advice = "放弃申购"
            reason = "冷市+高估值，破发风险较大"

    return advice, reason

_XGB_MODEL = None

_XGB_FEATURES = None

_XGB_FEATURE_INFO = None

_XGB_MEDIAN_VALS = {}

def _load_xgb_model():
    """加载XGBoost模型（从训练好的模型文件）"""
    global _XGB_MODEL, _XGB_FEATURES, _XGB_FEATURE_INFO, _XGB_MEDIAN_VALS
    if _XGB_MODEL is not None:
        return True

    import os
    import json
    import numpy as np
    import xgboost as xgb

    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_xgb_model.json")
    feat_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_xgb_features.json")

    if not os.path.exists(model_path) or not os.path.exists(feat_path):
        print("[XGBoost] 模型文件不存在，使用线性模型")
        return False

    try:
        _XGB_MODEL = xgb.Booster()
        _XGB_MODEL.load_model(model_path)

        with open(feat_path, "r", encoding="utf-8") as f:
            info = json.load(f)

        _XGB_FEATURES = info["features"]
        _XGB_FEATURE_INFO = info
        _XGB_MEDIAN_VALS = info.get("medians", {})
        return True
    except Exception as e:
        print(f"[XGBoost] 模型加载失败: {e}")
        return False

def _xgb_predict_listing(stock_detail, sector_label="", sector_boost=0):
    """
    用XGBoost模型预测首日涨幅
    返回 (estimated, detail_parts) 或 None
    """
    import numpy as np
    import xgboost as xgb

    if not _load_xgb_model():
        return None

    try:
        # 构建特征向量
        def get_val(key, default=np.nan):
            v = stock_detail.get(key)
            if v is None:
                v = _XGB_MEDIAN_VALS.get(key, default)
            try:
                return float(v) if v is not None else default
            except (ValueError, TypeError):
                return default

        ip = get_val("issue_price")
        ipe = get_val("issue_pe")
        ind_pe = get_val("industry_pe")
        fr = get_val("fund_raised")
        os_ = get_val("online_shares")
        ts = get_val("total_shares")
        lr = get_val("online_lottery_rate")
        ov = get_val("oversubscribe_multiple")
        cmv = get_val("circulation_mv")
        sl = get_val("subscribe_upper_limit")
        pr = get_val("pe_ratio")

        # 确保数值有效
        ip = ip if not np.isnan(ip) and ip > 0 else _XGB_MEDIAN_VALS.get("issue_price", 20)
        ipe = ipe if not np.isnan(ipe) and ipe > 0 else _XGB_MEDIAN_VALS.get("issue_pe", 25)
        ind_pe = ind_pe if not np.isnan(ind_pe) and ind_pe > 0 else _XGB_MEDIAN_VALS.get("industry_pe", 30)
        lr = lr if not np.isnan(lr) and lr > 0 else _XGB_MEDIAN_VALS.get("lottery_rate", 0.03)
        cmv = cmv if not np.isnan(cmv) and cmv > 0 else _XGB_MEDIAN_VALS.get("circ_mv", 5)
        ov = ov if not np.isnan(ov) and ov > 0 else _XGB_MEDIAN_VALS.get("oversub_multiple", 2000)
        fr = fr if not np.isnan(fr) and fr > 0 else 0
        ts = ts if not np.isnan(ts) and ts > 0 else 0
        os_ = os_ if not np.isnan(os_) and os_ > 0 else 0
        sl = sl if not np.isnan(sl) and sl > 0 else 0
        pr = pr if not np.isnan(pr) and pr > 0 else 0

        # 衍生特征
        cmv_log = np.log1p(cmv)
        fund_log = np.log1p(fr)
        price_times_pe = ip * ipe / 100
        lottery_inv = 1 / (lr + 0.001)
        circ_per_lot = cmv / (lr + 0.001)
        pe_squared = ipe ** 2 / 1000

        features = np.array([[
            ip, ipe, ind_pe, fr,
            os_, ts, lr,
            ov, cmv, sl, pr,
            cmv_log, fund_log, price_times_pe,
            lottery_inv, circ_per_lot, pe_squared
        ]])

        estimated = float(_XGB_MODEL.predict(xgb.DMatrix(features))[0])
        estimated = int(round(max(estimated, 0)))

        # XGBoost动态校准：按板块基准 + 市场温度调整
        xgb_boost = _calc_xgb_boost(stock_detail, estimated)
        if xgb_boost != 1.0:
            old_est = estimated
            estimated = int(round(estimated * xgb_boost))
            detail_parts = [
                f"📊 预估首日涨幅: {estimated}%（🤖 XGBoost模型，校准系数×{xgb_boost}）",
                f"📋 发行数据: 价{ip}元 PE{ipe} 中签{lr}% 流通{cmv:.1f}亿",
            ]
        else:
            detail_parts = [
                f"📊 预估首日涨幅: {estimated}%（🤖 XGBoost模型）",
                f"📋 发行数据: 价{ip}元 PE{ipe} 中签{lr}% 流通{cmv:.1f}亿",
            ]

        return estimated, detail_parts
    except Exception as e:
        print(f"[XGBoost] 预测失败: {e}")
        return None

def _get_lot_size(stock_code):
    """根据股票代码判断一签多少股"""
    if not stock_code:
        return 500  # 默认
    code_str = str(stock_code).strip()
    # 北交所
    if code_str.startswith(("8", "920", "43")):
        return 100
    # 沪市主板
    if code_str.startswith(("60",)):
        return 1000
    # 深市主板 / 创业板 / 科创板
    return 500

def _format_listing_summary(estimated, stock_detail, temp):
    """生成上市结论文字，包含预计单签收益
    涨幅按50%梯度向下取整，单签收益按万元整数向下取整"""
    # 涨幅向下取整到最近的50%梯度
    est_floor = (estimated // 50) * 50
    issue_price = None
    if stock_detail:
        try:
            issue_price = float(stock_detail.get("issue_price", 0))
        except (ValueError, TypeError):
            pass

    single_lot_profit = None
    if issue_price and issue_price > 0:
        stock_code = stock_detail.get("stock_code") if stock_detail else None
        lot_size = _get_lot_size(stock_code)
        single_lot_profit = issue_price * lot_size * estimated / 100 / 10000  # 万元

    if temp == "冷市":
        return f"❄️ 预计首日涨幅 {est_floor}%，冷市涨幅受限"
    if est_floor >= 500:
        part = f"{est_floor}%+"
    else:
        part = f"约{est_floor}%"
    if single_lot_profit and single_lot_profit >= 0.01:
        return f"预计首日涨幅{part}，预计首日单签收益{int(single_lot_profit)}万元"
    else:
        return f"预计首日涨幅{part}"

def get_listing_analysis(item_type, issue_price, issue_pe, industry_pe, bond_detail=None, stock_detail=None):
    """上市首日表现预估（2025-2026年零破发环境适配版）"""
    if item_type == "bond":
        if bond_detail:
            tv = bond_detail.get("transfer_value")
            cs = bond_detail.get("circulation_scale")
            rating = bond_detail.get("rating")
            sc = bond_detail.get("stock_code", "")
            bn = bond_detail.get("bond_name", "")
            sn = bond_detail.get("stock_name", "")
            si = bond_detail.get("stock_industry", "")
            result, err = estimate_bond_listing_price(tv, cs, rating, sc, bn, sn, si,
                                                      issue_scale=bond_detail.get("issue_scale"))
            if result:
                return result
        return {"summary": "预计首日涨幅 15%-30%，数据不足无法精确预估", "detail": "转股价值或流通规模数据缺失", "price": None}

    # ── 新股上市首日预测 ──
    # 优先使用XGBoost模型，无模型时回退到改进线性模型
    if stock_detail is None:
        stock_detail = {}

    stock_code = stock_detail.get("stock_code", "")
    stock_name = stock_detail.get("stock_name", "")
    main_business = stock_detail.get("main_business", "")
    industry = stock_detail.get("industry", "")
    sector_label, sector_boost = detect_stock_hot_sector(stock_name, main_business, industry)
    temp = _MARKET_TEMP["level"]

    # 尝试XGBoost预测
    xgb_result = _xgb_predict_listing(stock_detail, sector_label, sector_boost)
    if xgb_result is not None:
        estimated, detail_parts = xgb_result
        # 叠加赛道热度修正
        if sector_label:
            if sector_boost >= 2:
                # 顶级热门赛道龙头：非线性高加成 + 板块基准软下限
                bkey = _get_board_key_from_code(stock_code)
                bbase = BOARD_BASE.get(bkey, 200)
                sector_mult = 1 + (sector_boost ** 1.6) * 0.35
                new_est = int(round(estimated * sector_mult))
                floor = int(round(bbase * (1.0 + sector_boost * 0.25)))
                estimated = max(new_est, floor)
                detail_parts.append(f"🚀 顶级赛道修正: {sector_label}（×{sector_mult:.2f}，下限{floor}%）→{estimated}%")
            else:
                sector_mult = 1 + sector_boost * 0.10
                estimated = int(round(estimated * sector_mult))
                detail_parts.append(f"🚀 赛道修正: {sector_label}（×{sector_mult:.2f}）→{estimated}%")
        # 市场温度衰减
        temp_mult = get_temp_listing_multiplier()
        estimated = int(round(estimated * temp_mult))
        detail_parts.append(f"🌡️ 温度衰减: {temp}（×{temp_mult}）→{estimated}%")

        if temp == "冷市":
            summary = f"❄️ 预计首日涨幅 {estimated}%，冷市涨幅受限"
        elif estimated >= 500:
            summary = _format_listing_summary(estimated, stock_detail, temp)
        elif estimated >= 200:
            summary = _format_listing_summary(estimated, stock_detail, temp)
        elif estimated >= 100:
            summary = f"预计首日涨幅约{estimated}%"
        else:
            summary = f"预计首日涨幅约{estimated}%"

        return {"summary": summary, "detail": "\n".join(detail_parts), "price": None, "predicted_return": estimated}

    # ── 回退：改进版线性模型 ──
    unified_base = _MARKET_TEMP.get("avg_gain_3m", 250)
    estimated = unified_base

    # 发行价修正
    if issue_price:
        if issue_price < 15:
            estimated = estimated * 1.1
        elif issue_price > 50:
            estimated = estimated * 0.90

    # 募资规模修正
    fund_raised = stock_detail.get("fund_raised")
    if fund_raised and fund_raised > 50:
        estimated = estimated * 0.85
    elif fund_raised and fund_raised > 20:
        estimated = estimated * 0.95

    # 中签率修正：中签率越低 = 申购越热
    lottery_rate = stock_detail.get("online_lottery_rate")
    if lottery_rate is not None and lottery_rate > 0:
        if lottery_rate < 0.02:
            estimated = estimated * 1.15
        elif lottery_rate < 0.03:
            estimated = estimated * 1.10
        elif lottery_rate < 0.05:
            estimated = estimated * 1.05
        elif lottery_rate > 0.12:
            estimated = estimated * 0.85
        elif lottery_rate > 0.08:
            estimated = estimated * 0.92

    # 机构超额认购倍数：倍数越高 = 机构越看好
    oversub = stock_detail.get("oversubscribe_multiple")
    if oversub is not None and oversub > 0:
        if oversub > 5000:
            estimated = estimated * 1.10
        elif oversub > 3000:
            estimated = estimated * 1.05
        elif oversub < 500:
            estimated = estimated * 0.92

    # 首日流通市值修正：流通盘越小越容易被炒作
    cmv = stock_detail.get("circulation_mv")
    if cmv is not None and cmv > 0:
        if cmv < 3:
            estimated = estimated * 1.25
        elif cmv < 6:
            estimated = estimated * 1.15
        elif cmv < 10:
            estimated = estimated * 1.05
        elif cmv > 50:
            estimated = estimated * 0.75
        elif cmv > 20:
            estimated = estimated * 0.88

    # 市场温度整体衰减
    temp = _MARKET_TEMP["level"]
    temp_mult = get_temp_listing_multiplier()
    estimated = int(round(estimated * temp_mult))

    # 生成预测文本
    if temp == "冷市":
        summary = f"❄️ 预计首日涨幅 {estimated}%，冷市环境下涨幅受限"
    elif estimated >= 500:
        summary = _format_listing_summary(estimated, stock_detail, temp)
    elif estimated >= 200:
        summary = _format_listing_summary(estimated, stock_detail, temp)
    elif estimated >= 100:
        summary = f"预计首日涨幅约{estimated}%，打新收益良好"
    else:
        summary = f"预计首日涨幅约{estimated}%，中签即赚"

    detail_parts = []
    detail_parts.append(f"📊 预估首日涨幅: {estimated}%")
    detail_parts.append(f"🏢 市场基准: {unified_base}%（近3月均值）")
    detail_parts.append(f"🌡️ 市场温度: {temp}（衰减系数×{temp_mult}）")
    if sector_label:
        detail_parts.append(f"🚀 热门赛道: {sector_label}（加成系数×{1+sector_boost*0.15:.1f}）")
    if lottery_rate is not None:
        detail_parts.append(f"📋 中签率: {lottery_rate}%")
    if cmv is not None:
        detail_parts.append(f"💰 首日流通市值: {cmv}亿元")
    if issue_pe and industry_pe and industry_pe > 0:
        pe_ratio = issue_pe / industry_pe
        detail_parts.append(f"📈 PE对比: 发行{issue_pe} vs 行业{industry_pe}（比值{pe_ratio:.2f}）")
    if issue_price:
        detail_parts.append(f"💰 发行价: {issue_price}元")
    if fund_raised:
        detail_parts.append(f"📦 募资规模: {fund_raised}亿")

    return {
        "summary": summary,
        "detail": " | ".join(detail_parts),
        "price": None,
        "predicted_return": estimated,
    }

__all__ = ['get_temp_pe_penalty', 'get_temp_temp_score_penalty', 'get_temp_listing_multiplier', '_get_market_premium_curve', '_estimate_initial_premium_by_iteration', '_calc_xgb_boost', 'estimate_bond_listing_price', 'get_valuation_advice', '_XGB_MODEL', '_XGB_FEATURES', '_XGB_FEATURE_INFO', '_XGB_MEDIAN_VALS', '_load_xgb_model', '_xgb_predict_listing', '_get_lot_size', '_format_listing_summary', 'get_listing_analysis']
