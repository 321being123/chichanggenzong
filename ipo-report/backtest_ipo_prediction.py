# -*- coding: utf-8 -*-
"""A 股打新首日涨幅预测的时间滚动样本外回测（walk-forward，含完整预测链路）。

为什么需要它：
  单次 80/20 切分只给出一个时点的样本外指标；而上线模型用全量样本训练后，
  再拿它预测历史样本属于**样本内**（见过答案），"预测变准"其实是假象。
  本脚本按时间滚动：每个测试点只用它**之前**的样本训练，模拟"站在当时预测未来"。

为什么 v2 要按时点还原校准量：
  完整预测链路是「XGBoost 原始 → 板块校准 → 赛道修正 → 温度系数」。若回测里直接
  调用读当前日期的生产校准函数（`calibrate_board_base` / `calibrate_sector_boost` /
  `detect_market_temperature`），它们用的是"今天之前 N 个月"的样本，含测试点**之后**
  才上市的新股，等于把未来信息灌进历史预测。故本脚本对每个测试点只用该时点之前
  已上市的首日结果重算板块基准、赛道系数与市场温度，再逐层统计误差。

产出指标（逐层）：
  - MAE / MAPE / 中位绝对误差 / 平均偏差
  - 预测区间覆盖率（区间由训练段残差分位数给出，覆盖率应接近名义水平）
  - 破发识别（历史无破发样本时明确标记不可评估）
  - 按年份、按板块分层

用法：
  python backtest_ipo_prediction.py                       # 全量滚动（每 1 条重训）
  python backtest_ipo_prediction.py --step 5              # 每 5 条重训一次（提速）
  python backtest_ipo_prediction.py --min-train 100       # 至少 100 条历史才开始预测
  python backtest_ipo_prediction.py --temp-stat median    # 温度统计量候选（对比用）
  python backtest_ipo_prediction.py --hot-gain-min 120 --warm-gain-min 25   # 阈值候选
  python backtest_ipo_prediction.py --json out.json       # 同时输出机器可读结果
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta

import numpy as np

from ipo_lib_train import (
    FITTED_MEDIAN_FIELDS,
    FEATURE_NAMES,
    XGB_PARAMS,
    NUM_BOOST_ROUND,
    symlog_return,
    inv_symlog_return,
    build_feature_matrix,
    load_training_rows,
    rows_to_arrays,
)

import ipo_lib_sector as sector_lib
import ipo_lib_valuation as valuation_lib
from ipo_lib_prediction import BOARDS_DEFAULT, BOARD_BASE, board_base_from_rows
from ipo_lib_valuation import _calc_xgb_boost, temp_listing_multiplier

# 各层修正所用的历史窗口，与生产校准函数的窗口保持一致。
TEMP_WINDOW_DAYS = sector_lib.TEMP_WINDOW_DAYS
SECTOR_WINDOW_DAYS = sector_lib.SECTOR_CALIBRATION_DAYS
BOARD_WINDOW_DAYS = 360  # 对应 ipo_lib_prediction._CALIBRATE_MONTHS * 30

LAYER_NAMES = ("raw", "board_median", "board", "sector", "temp")


def slice_fields(fields, start, stop):
    return {key: value[start:stop] for key, value in fields.items()}


def take_indices(fields, indices):
    """按索引列表取样本子集。

    训练窗口按预测截点过滤（同日上市的样本不得互相当答案）后不再是一段连续区间，
    行切片 `fields[:index]` 表达不了这个语义，必须按索引取。
    """
    idx = np.asarray(indices, dtype=int)
    return {key: np.asarray(value)[idx] for key, value in fields.items()}


def train_on_window(raw_window, gain_window, xgb):
    """只用窗口内的样本训练，并返回模型与该窗口的中位数、残差区间。"""
    medians = {field: float(np.nanmedian(raw_window[field])) for field in FITTED_MEDIAN_FIELDS}
    features = build_feature_matrix(raw_window, medians)
    matrix = xgb.DMatrix(features, label=symlog_return(gain_window), feature_names=FEATURE_NAMES)
    model = xgb.train(XGB_PARAMS, matrix, num_boost_round=NUM_BOOST_ROUND)
    fitted = inv_symlog_return(model.predict(matrix))
    residual = gain_window - fitted
    low_q, high_q = np.quantile(residual, [0.1, 0.9])
    return model, medians, float(low_q), float(high_q)


def history_indices(dates, index, days, anchor=None):
    """返回 [0, index) 中上市日落在 (截点 − days, 截点) 的样本下标。

    严格排除截点当天及之后上市的样本，保证校准量只用当时已公布的结果。
    anchor 缺省取测试点的上市日；申购阶段回测必须传入更早的申购截点
    （发行公告日）——申购时点之后、本股上市日之前上市的新股，其首日
    结果在申购时同样不可见。
    """
    anchor = anchor or dates[index]
    cutoff = anchor - timedelta(days=days)
    return [i for i in range(index) if cutoff <= dates[i] < anchor]


def needs_retrain(trained_anchor, anchor_date, index, min_train, step, has_model):
    """判断当前测试点能否复用上一轮训练的模型与赛道状态。

    样本按上市日排序，申购截点（发行公告日）不保证随序号递增；截点倒退时，
    上一次训练可能已包含当前截点之后才公布的首日结果（验收第三次复核：
    603376 截点 2025-10-24 沿用按 2025-10-27 训练的模型，其中含 603175 的
    首日结果），必须立即重建，与重训节奏无关。复用（返回 False）的前提是
    训练截点不晚于当前截点——训练数据全部在当前截点之前已公布。同截点的
    节奏点也不重训：训练窗口完全相同，重训只会得到同一个模型。
    """
    if not has_model:
        return True
    if trained_anchor is not None and anchor_date < trained_anchor:
        return True
    return (index - min_train) % step == 0 and anchor_date != trained_anchor


def build_issue_anchors(rows, listing_dates=None):
    """构造每个样本的申购截点（近似取发行公告日 ipo_date）。

    返回 (anchors, invalid)：截点缺失或格式异常的样本进入 invalid 集合，
    申购模式回测必须跳过这些点并在汇总中报告——回退上市日会把「上市后
    回测」伪装成「申购前回测」，重新引入未来信息（验收第三次复核）。
    """
    anchors = []
    invalid = set()
    for i, r in enumerate(rows):
        try:
            anchors.append(datetime.strptime(str(r[19])[:10], "%Y-%m-%d").date())
        except ValueError:
            anchors.append(None)
            invalid.add(i)
    return anchors, invalid


def layer_metrics(predicted, actual):
    """单层预测的误差指标。"""
    error = predicted - actual
    return {
        "mae": float(np.mean(np.abs(error))),
        "mape": float(np.mean(np.abs(error / (actual + 1))) * 100),
        "median_absolute_error": float(np.median(np.abs(error))),
        "mean_error": float(np.mean(error)),
    }


def average_ranks(values):
    """并列值取平均秩（Spearman 的标准并列处理）。

    此前用两次 argsort：并列值会按出现顺序拿到递增虚秩，全部相同的评分
    被排成 1,2,3…，与任意实际序列都能算出高相关——验收实测 [10,10,10] 对
    [1,2,3] 给出 1.0。并列必须用平均秩。
    """
    arr = np.asarray(values, dtype=float)
    order = np.argsort(arr, kind="mergesort")
    ranks = np.empty(len(arr), dtype=float)
    sorted_values = arr[order]
    start = 0
    while start < len(arr):
        end = start
        while end + 1 < len(arr) and sorted_values[end + 1] == sorted_values[start]:
            end += 1
        ranks[order[start:end + 1]] = (start + end) / 2.0 + 1.0
        start = end + 1
    return ranks


def spearman(a, b, min_distinct=3):
    """秩相关（不依赖 scipy）：建议分越高，实际首日涨幅是否也越高。

    并列分数取平均秩；评分区分度不足（唯一取值少于 min_distinct 个，或全相同）
    时返回 None——用没有区分力的评分排出的“相关”没有意义，不能当作权重选择证据。
    """
    arr_a = np.asarray(a, dtype=float)
    arr_b = np.asarray(b, dtype=float)
    if len(arr_a) < 3:
        return None
    if len(np.unique(arr_a)) < min_distinct or len(np.unique(arr_b)) < min_distinct:
        return None
    rank_a = average_ranks(arr_a)
    rank_b = average_ranks(arr_b)
    if rank_a.std() == 0 or rank_b.std() == 0:
        return None
    return float(np.corrcoef(rank_a, rank_b)[0, 1])


def score_advice_candidates(weights, stock_detail, issue_pe, industry_pe, temperature, original_weight):
    """按候选权重分别计算申购建议分，返回 {权重字符串: 分值}。

    评分函数读的是进程内的市场温度与赛道系数，调用方须已按测试点时点设好这些状态
    （温度由本函数按传入的时点温度临时接管）；结束后还原，避免污染后续测试点。
    """
    saved_temp = dict(sector_lib._MARKET_TEMP)
    sector_lib._MARKET_TEMP.clear()
    sector_lib._MARKET_TEMP.update(temperature)
    scores = {}
    try:
        for weight in weights:
            valuation_lib.SECTOR_SCORE_WEIGHT = weight
            _, _, calculation = valuation_lib.get_valuation_advice(
                "stock", issue_pe, industry_pe, stock_detail=stock_detail, return_detail=True
            )
            steps = (calculation or {}).get("steps") or []
            scores[str(weight)] = steps[-1]["after"] if steps else None
    finally:
        valuation_lib.SECTOR_SCORE_WEIGHT = original_weight
        sector_lib._MARKET_TEMP.clear()
        sector_lib._MARKET_TEMP.update(saved_temp)
    return scores


def rolling_interval_coverage(results, window=50, quantile=0.8, min_points=30):
    """滚动定标区间的独立验收：半宽跟随近期误差水平，定标数据严格早于验收点。

    为什么需要它：固定半宽（前半定标、后半验收）实测只有 64.7% 覆盖——
    样本外误差随市场行情漂移（后半段更热、误差更大），固定宽度框不住。
    滚动定标让每个测试点的半宽取「它之前最近 window 个**更早上市**样本
    的最终链路误差分位」：行情转热时半宽自动放大，转冷时收窄。

    可见性规则（验收第三次复核）：历史样本的误差要等**它自己上市收盘**后才
    产生，所以历史点能否计入，用「历史点上市日 < 当前点的预测截点」判断。
    此前两侧都用申购截点，申购更早但尚未上市的股票误差被当成已知——实测
    72 个有效评价点中 65 个引入了未上市股票的误差。同日上市的样本结果同样
    不可见，严格排除。历史不足 min_points 的点不计入（半宽不可信）。
    返回 (覆盖率, 平均半宽, 计入点数)；无可用点返回 (None, None, 0)。
    """
    availability = []   # 每个历史点的误差可用时刻 = 该股票的上市日
    query_anchor = []   # 当前点的预测截点（申购模式为发行公告日，上市模式为上市日）
    for item in results:
        try:
            availability.append(date.fromisoformat(str(item["date"])[:10]))
        except (KeyError, ValueError):
            availability.append(None)
        try:
            query_anchor.append(date.fromisoformat(str(item.get("anchor_date") or item["date"])[:10]))
        except ValueError:
            query_anchor.append(None)
    covered, widths = [], []
    for i in range(len(results)):
        anchor = query_anchor[i]
        if anchor is None:
            continue
        history = [abs(results[j]["error"]) for j in range(max(0, i - window), i)
                   if availability[j] is not None and availability[j] < anchor]
        if len(history) < min_points:
            continue
        half = float(np.quantile(history, quantile))
        covered.append(abs(results[i]["error"]) <= half)
        widths.append(half)
    if not covered:
        return None, None, 0
    return float(np.mean(covered)), float(np.mean(widths)), len(covered)


def main():
    parser = argparse.ArgumentParser(description="A 股打新预测时间滚动样本外回测（含完整链路逐层对比）")
    parser.add_argument("--min-train", type=int, default=80, help="开始滚动前至少有多少条历史样本")
    parser.add_argument("--step", type=int, default=1, help="每隔多少条重训一次（1 为逐条重训）")
    parser.add_argument("--json", default=None, help="把结果写入 JSON 文件")
    parser.add_argument("--quiet", action="store_true", help="不逐条打印，只输出汇总")
    parser.add_argument("--temp-stat", choices=["mean", "median"], default=None,
                        help="温度涨幅统计量候选；不传用生产当前口径")
    parser.add_argument("--hot-gain-min", type=float, default=None, help="热市涨幅统计量下限候选")
    parser.add_argument("--warm-gain-min", type=float, default=None, help="常温涨幅统计量下限候选")
    parser.add_argument("--warm-break-max", type=float, default=None, help="常温破发率上限候选")
    parser.add_argument("--advice-weights", default=None,
                        help="逗号分隔的赛道分权重候选（如 0,0.15,0.3,0.45,0.6）；"
                             "给出后额外评估「建议分与实际首日涨幅的秩相关」")
    parser.add_argument("--skip-board", action="store_true", help="消融：跳过板块校准层")
    parser.add_argument("--skip-sector", action="store_true", help="消融：跳过赛道修正层")
    parser.add_argument("--skip-temp", action="store_true", help="消融：跳过温度系数层")
    parser.add_argument("--issuance-stage", action="store_true",
                        help="按「发行阶段（申购前）」口径评估：中签率与超额认购倍数此时尚未公布，"
                             "按缺失处理走补位，用于量化申购阶段预测相对上市阶段的可信度差异")
    parser.add_argument("--rolling-window", type=int, default=50,
                        help="滚动定标区间的误差窗口（多少个更早上市的测试点）；0 关闭该评估")
    parser.add_argument("--rolling-quantile", type=float, default=0.8,
                        help="滚动定标区间的误差分位数（0.8 对应名义 80%% 区间）")
    args = parser.parse_args()

    import xgboost as xgb

    # 候选统计量与阈值只在本次回测进程内生效，不改生产源码常量。
    if args.temp_stat:
        sector_lib.TEMP_GAIN_STAT = args.temp_stat
    if args.hot_gain_min is not None:
        sector_lib.TEMP_HOT_GAIN_MIN = args.hot_gain_min
    if args.warm_gain_min is not None:
        sector_lib.TEMP_WARM_GAIN_MIN = args.warm_gain_min
    if args.warm_break_max is not None:
        sector_lib.TEMP_WARM_BREAK_MAX = args.warm_break_max

    rows = load_training_rows()
    if not rows:
        print("没有可用于回测的历史样本")
        return 1
    raw, codes, names, gain = rows_to_arrays(rows)
    total = len(rows)
    if args.min_train >= total:
        print(f"历史样本仅 {total} 条，不足以在 min-train={args.min_train} 下滚动")
        return 1

    boards = [r[2] for r in rows]
    listing = [r[15] for r in rows]
    main_business = [r[16] for r in rows]
    industries = [r[17] for r in rows]
    payloads = [r[18] for r in rows]
    dates = [datetime.strptime(str(d)[:10], "%Y-%m-%d").date() for d in listing]
    # 申购截点：近似取发行公告日（ipo_date），申购阶段预测发生在此之前，训练/校准
    # 窗口都以它为界。缺失或格式异常时**明确跳过**并在汇总中报告——回退上市日会
    # 重新引入未来信息，等于把上市后回测伪装成申购前回测（验收第三次复核）。
    issue_anchors, invalid_issue = build_issue_anchors(rows, dates)

    print(f"样本 {total} 条，起始训练窗口 {args.min_train} 条，重训间隔 {args.step}")
    print(f"温度统计量 {sector_lib.TEMP_GAIN_STAT}，阈值 热市>{sector_lib.TEMP_HOT_GAIN_MIN}"
          f" / 常温>{sector_lib.TEMP_WARM_GAIN_MIN} 且破发率<{sector_lib.TEMP_WARM_BREAK_MAX}")
    if not args.quiet:
        print(f"{'序号':>5} {'代码':>8} {'名称':<8} {'原始':>7} {'板块基线':>8} {'板块后':>7} {'赛道后':>7} {'温度后':>7} {'实际':>7}")

    advice_weights = []
    if args.advice_weights:
        advice_weights = [float(x) for x in args.advice_weights.split(",") if x.strip()]
    original_advice_weight = valuation_lib.SECTOR_SCORE_WEIGHT

    results = []
    skipped_no_issue = []
    model = medians = low_q = high_q = None
    trained_anchor = None
    sector_boosts = {}
    sector_counts = {}
    temp_level = "未知"

    for index in range(args.min_train, total):
        # 预测信息截点（验收第二次复核-阻断1）：上市阶段预测的截点是本股上市日；
        # 申购阶段预测发生在申购前，截点是发行公告日（ipo_date）——申购时点之后、
        # 本股上市日之前上市的其他新股，其首日结果在申购时同样不可见，此前仍按
        # 上市日取历史，实测 102 个测试点中 92 个用到了申购时尚未公布的结果。
        anchor_date = issue_anchors[index] if args.issuance_stage else dates[index]
        if args.issuance_stage and anchor_date is None:
            # 申购截点缺失：明确跳过并报告，不回退上市日（验收第三次复核）。
            skipped_no_issue.append(index)
            if not args.quiet:
                print(f"{index:>5} {codes[index]:>8} {names[index]:<8}  -- 跳过：申购截点（ipo_date）缺失")
            continue
        # 训练窗口按预测截点限制：历史样本的首日结果必须在本截点之前已产生
        # （同日或更晚上市的都不可见）。
        train_indices = [i for i in range(index) if dates[i] < anchor_date]
        # 板块基准：从生产同款默认值出发，只用截点前 BOARD_WINDOW_DAYS 内已上市样本重算。
        # 每个测试点都按各自截点重算（窗口滑动），成本低。
        board_bases = board_base_from_rows(
            [(boards[i], gain[i]) for i in history_indices(dates, index, BOARD_WINDOW_DAYS, anchor_date)]
        )

        if needs_retrain(trained_anchor, anchor_date, index, args.min_train, args.step,
                         model is not None):
            # 复用前提（验收第三次复核）：已训练模型所用结果必须在当前截点仍可见。
            # 截点倒退时即使不在重训节奏上也要立即重建——否则模型训练数据里含有
            # 当前截点之后才公布的首日结果（603376 案例）。赛道状态与模型同窗口
            # 构建，必须一起刷新。
            # 训练与生产完全一致：始终使用完整字段（含事后公布的中签率/超购）训练，
            # 不做按阶段掩蔽——生产训练从不区分阶段；阶段差异只出现在推理端
            # （_ISSUANCE_PENDING_FIELDS）。此前回测把训练行也掩蔽，口径与生产
            # 不一致，回测成绩不能代表实际使用效果（验收第二次复核-阻断2）。
            model, medians, low_q, high_q = train_on_window(
                take_indices(raw, train_indices), gain[train_indices], xgb
            )
            trained_anchor = anchor_date

            # 赛道系数：只用截点前 SECTOR_WINDOW_DAYS 内已上市样本重算。
            # 需要逐只做业务暴露识别，成本较高，故与模型同节奏（重训点）更新。
            # 元组顺序须与 sector_tables_from_history 的期望一致：
            # (代码, 名称, 市场/板块, 上市日, 主营业务, 行业, 首日涨幅, source_payload)
            sector_history = [
                (rows[i][0], rows[i][1], rows[i][2], rows[i][15],
                 rows[i][16], rows[i][17], rows[i][3], rows[i][18])
                for i in history_indices(dates, index, SECTOR_WINDOW_DAYS, anchor_date)
            ]
            table, _benchmark = sector_lib.sector_tables_from_history(sector_history)
            sector_boosts = {key: item["boost"] for key, item in table.items()}
            sector_counts = {key: item["sample_count"] for key, item in table.items()}

        # 市场温度：每个测试点都按各自截点重算（窗口滑动，不能复用上一个点）
        temperature = sector_lib.summarize_temperature(
            [gain[i] for i in history_indices(dates, index, TEMP_WINDOW_DAYS, anchor_date)]
        )
        temp_level = temperature["level"]

        test_raw = slice_fields(raw, index, index + 1)
        if args.issuance_stage:
            # 发行阶段（申购前）中签率与超额认购倍数尚未公布（申购后 T+2 才公布），
            # 按缺失处理自动走补位——这正是申购前预测实际拿到的输入。
            test_raw = dict(test_raw)
            test_raw["lottery_rate"] = np.array([np.nan])
            test_raw["oversub_multiple"] = np.array([np.nan])
        matrix = xgb.DMatrix(build_feature_matrix(test_raw, medians), feature_names=FEATURE_NAMES)
        raw_value = float(inv_symlog_return(model.predict(matrix))[0])

        board_key = boards[index]
        board_base_value = board_bases.get(board_key, BOARDS_DEFAULT.get(board_key))
        # 独立板块中位数基线（验收 P1-6）：预测=该板块近 BOARD_WINDOW_DAYS 首日中位数。
        # 它是「不 用 XGBoost 也能给出预测」的最低对比标准——任何模型或修正层
        # 只有稳定优于这条基线才谈得上有增益。
        board_median_pred = float(board_base_value) if board_base_value is not None else 0.0
        if args.skip_board:
            # 消融：跳过板块校准，用于判断这一层是否有稳定增益
            board_boost = 1.0
        else:
            board_boost = _calc_xgb_boost(
                {"stock_code": codes[index]}, raw_value,
                board_base=board_base_value, temp_level=temp_level,
            )
        board_est = raw_value * board_boost

        advice_scores = {}
        with sector_lib.swap_sector_boosts(sector_boosts, sector_counts):
            context = sector_lib.get_stock_sector_context(
                names[index], main_business[index], industries[index],
                industry_taxonomy=sector_lib._stored_sw_industry_taxonomy(payloads[index]),
            )
            if advice_weights:
                advice_detail = {
                    "stock_code": codes[index], "stock_name": names[index],
                    "main_business": main_business[index], "industry": industries[index],
                    "issue_price": rows[index][4], "issue_pe": rows[index][5],
                    "industry_pe": rows[index][6], "fund_raised": rows[index][7],
                    "online_lottery_rate": rows[index][10],
                    "oversubscribe_multiple": rows[index][11],
                    "circulation_mv": rows[index][12],
                }
                if args.issuance_stage:
                    # 建议分与预测必须用同一组掩蔽后的输入（验收 P1-2）：
                    # 申购阶段不能把事后公布的中签率/超购喂给评分。
                    advice_detail["online_lottery_rate"] = None
                    advice_detail["oversubscribe_multiple"] = None
                # 建议评分内部经 estimate_board_base 读全局 BOARD_BASE，不替换就会用
                # 「今天之前」的当前校准值——验收实测只改全局某板块基准，同一只股票的
                # 建议分能从 288 变到 432。必须换成该测试点的时点基准。
                merged_board_base = dict(BOARDS_DEFAULT)
                merged_board_base.update(board_bases)
                saved_board_base = dict(BOARD_BASE)
                BOARD_BASE.clear()
                BOARD_BASE.update(merged_board_base)
                try:
                    advice_scores = score_advice_candidates(
                        advice_weights, advice_detail,
                        rows[index][5], rows[index][6], temperature, original_advice_weight,
                    )
                finally:
                    BOARD_BASE.clear()
                    BOARD_BASE.update(saved_board_base)
        sector_mult = 1.0 if args.skip_sector else float(context.get("multiplier") or 1.0)
        sector_est = board_est * sector_mult
        temp_mult = 1.0 if args.skip_temp else temp_listing_multiplier(temp_level)
        final_est = sector_est * temp_mult

        actual = float(gain[index])
        results.append({
            "code": codes[index],
            "name": names[index],
            "board_name": board_key,
            "date": str(listing[index]),
            "anchor_date": str(anchor_date),
            "trained_anchor": str(trained_anchor),
            "year": str(listing[index])[:4],
            "actual": actual,
            "raw": raw_value,
            "board_median": board_median_pred,
            "board": board_est,
            "sector": sector_est,
            "temp": final_est,
            "board_boost": board_boost,
            "sector_multiplier": sector_mult,
            "sector_label": context.get("label"),
            "temp_level": temp_level,
            "temp_multiplier": temp_mult,
            "low": final_est + low_q,
            "high": final_est + high_q,
            "error": final_est - actual,
            "advice_scores": advice_scores,
        })
        if not args.quiet:
            print(f"{index:>5} {codes[index]:>8} {names[index]:<8} {raw_value:>6.0f}% "
                  f"{board_median_pred:>7.0f} {board_est:>6.0f}% {sector_est:>6.0f}% "
                  f"{final_est:>6.0f}% {actual:>6.0f}%")

    actual = np.array([r["actual"] for r in results])
    covered = (actual >= np.array([r["low"] for r in results])) & (actual <= np.array([r["high"] for r in results]))
    broke = actual < 0

    layers = {}
    for name in LAYER_NAMES:
        layers[name] = layer_metrics(np.array([r[name] for r in results]), actual)

    # 区间独立验收（验收 P1-4）：区间构造固定为「完整最终链路样本外误差的 80 分位」，
    # 定标只用时间上较早的一半测试点，覆盖率只在未参与定标的后续一半上评估。
    # 此前两种数字都不能算独立验证：模型自估区间来自训练段拟合残差（覆盖 46.1%）；
    # 产物半宽覆盖 81.4% 但用同一段历史定标并验收。
    independent_interval = None
    n_points = len(results)
    if n_points >= 20:
        split = n_points // 2
        calib_errors = [abs(r["error"]) for r in results[:split]]
        holdout_errors = [abs(r["error"]) for r in results[split:]]
        calib_half = float(np.quantile(calib_errors, 0.8))
        independent_interval = {
            "method": "最终链路样本外误差80分位；前半段定标、后半段验收",
            "half_width": calib_half,
            "calibration_points": len(calib_errors),
            "evaluation_points": len(holdout_errors),
            "coverage": float(np.mean([e <= calib_half for e in holdout_errors])),
        }

    # 滚动定标区间（方案第四批「分位数/滚动校准区间」）：半宽跟随近期误差水平。
    # 与上面的固定半宽独立验收互为对照：固定半宽 64.7% 的根因是误差随行情漂移，
    # 滚动定标若能把覆盖率拉回名义水平，即证明漂移假设成立且方案可行。
    rolling_interval = None
    if args.rolling_window > 0:
        coverage_r, width_r, count_r = rolling_interval_coverage(
            results, window=args.rolling_window, quantile=args.rolling_quantile)
        if count_r:
            rolling_interval = {
                "window": args.rolling_window,
                "quantile": args.rolling_quantile,
                "coverage": coverage_r,
                "mean_half_width": width_r,
                "points": count_r,
                "availability_rule": "历史误差在其上市日之后才计入定标历史（可见性口径）",
            }

    def grouped_mae(group_key):
        """按分组键统计各层 MAE：用于判断某项修正在哪些板块/年份/温度档真正起作用。"""
        groups = {}
        for item in results:
            groups.setdefault(item[group_key], []).append(item)
        table = {}
        for key, items in groups.items():
            group_actual = np.array([it["actual"] for it in items])
            row = {"count": len(items)}
            for layer in LAYER_NAMES:
                row[layer] = float(np.mean(np.abs(np.array([it[layer] for it in items]) - group_actual)))
            table[str(key)] = row
        return table

    by_temperature = grouped_mae("temp_level")
    by_year = grouped_mae("year")
    by_board = grouped_mae("board_name")

    # 建议分定参：赛道分权重取不同值时，建议分与实际首日涨幅的排序一致性如何变化。
    # 建议分是规则评分而非预测值，故用秩相关评估区分力，不能看 MAE。
    advice_scan = None
    if advice_weights:
        advice_scan = {}
        for weight in advice_weights:
            key = str(weight)
            pairs = [(r["advice_scores"].get(key), r["actual"]) for r in results]
            pairs = [(s, g) for s, g in pairs if isinstance(s, (int, float))]
            advice_scan[key] = {
                "count": len(pairs),
                "spearman": spearman([p[0] for p in pairs], [p[1] for p in pairs]),
            }

    mape_value = layers["temp"]["mape"]
    summary = {
        "min_train": args.min_train,
        "step": args.step,
        "test_points": len(results),
        "temp_stat": sector_lib.TEMP_GAIN_STAT,
        "temp_hot_gain_min": sector_lib.TEMP_HOT_GAIN_MIN,
        "temp_warm_gain_min": sector_lib.TEMP_WARM_GAIN_MIN,
        "temp_warm_break_max": sector_lib.TEMP_WARM_BREAK_MAX,
        "layers": layers,
        "mae": layers["temp"]["mae"],
        "mape": mape_value,
        "median_absolute_error": layers["temp"]["median_absolute_error"],
        "mean_error": layers["temp"]["mean_error"],
        "interval_coverage": float(np.mean(covered)),
        "interval_nominal": 0.8,
        "break_count": int(broke.sum()),
        "break_recall": float(np.mean(np.array([r["temp"] for r in results])[broke] < 0)) if broke.any() else None,
        "false_break_alarm_rate": float(np.mean(np.array([r["temp"] for r in results])[~broke] < 0)) if (~broke).any() else None,
        "by_temperature": by_temperature,
        "by_year": by_year,
        "by_board": by_board,
        "advice_scan": advice_scan,
        "independent_interval": independent_interval,
        "rolling_interval": rolling_interval,
        "skipped_missing_issue_date": len(skipped_no_issue),
    }

    # 当前产物区间半宽（interval_half_width）对应的覆盖率。
    # 注意：该半宽由同一批历史样本定标，属于**同源评估**，数值偏乐观，需用后续新样本复核。
    production_half = production_coverage = None
    try:
        features_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ipo_xgb_features.json")
        with open(features_path, encoding="utf-8") as handle:
            value = json.load(handle).get("interval_half_width")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            production_half = max(60.0, min(250.0, float(value)))
            production_coverage = float(np.mean(np.abs(actual - np.array([r["temp"] for r in results])) <= production_half))
    except Exception:
        production_half = production_coverage = None

    print(f"\n{'='*66}")
    print("逐层样本外误差（每层都在同一批测试点、同一模型输出上评估）")
    print(f"{'层级':<14}{'MAE':>9}{'MAPE':>9}{'中位绝对误差':>14}{'平均偏差':>11}")
    layer_labels = {
        "raw": "XGBoost 原始",
        "board_median": "板块中位数基线",
        "board": "+板块校准",
        "sector": "+赛道修正",
        "temp": "+温度系数（最终）",
    }
    for name in LAYER_NAMES:
        m = layers[name]
        print(f"{layer_labels[name]:<14}{m['mae']:>8.1f}pp{m['mape']:>8.1f}%"
              f"{m['median_absolute_error']:>13.1f}pp{m['mean_error']:>+10.1f}pp")
    print("-" * 66)
    for title, table, order in (
        ("按市场温度分组（温度系数是否真的生效）", by_temperature, ("热市", "常温", "冷市", "未知")),
        ("按年份分组", by_year, None),
        ("按板块分组", by_board, None),
    ):
        print(f"\n{title}")
        print(f"{'分组':<12}{'点数':>4}" + "".join(f"{layer_labels[l]:>14}" for l in LAYER_NAMES))
        keys = [k for k in order if k in table] if order else sorted(table)
        for key in keys:
            row = table[key]
            print(f"{key:<12}{row['count']:>4}"
                  + "".join(f"{row[l]:>13.0f} " for l in LAYER_NAMES))
    print("-" * 66)
    if advice_scan:
        print("\n建议分与实际首日涨幅的秩相关（+1 完全同序，0 无区分力；建议分是规则评分，不能看 MAE）")
        for key, row in advice_scan.items():
            value = row["spearman"]
            text = "不可评估" if value is None else format(value, "+.3f")
            print(f"  赛道分权重 {key}: {row['count']} 个点 | 秩相关 {text}")
    print(f"模型自估区间覆盖: {summary['interval_coverage']*100:.1f}%（名义 {summary['interval_nominal']*100:.0f}%，来自训练段拟合残差，仅参考）")
    if independent_interval:
        print(f"区间独立验收    : 半宽 {independent_interval['half_width']:.0f}pp -> 未参与定标的"
              f"后 {independent_interval['evaluation_points']} 点覆盖 "
              f"{independent_interval['coverage']*100:.1f}%"
              f"（前 {independent_interval['calibration_points']} 点定标；最终链路误差 80 分位）")
    if rolling_interval:
        print(f"滚动定标区间    : 窗口{rolling_interval['window']}只/"
              f"{rolling_interval['quantile']:.0%}分位 -> 覆盖 "
              f"{rolling_interval['coverage']*100:.1f}%（平均半宽 "
              f"{rolling_interval['mean_half_width']:.0f}pp，{rolling_interval['points']} 点；"
              f"历史误差按其上市日计入）")
    if args.issuance_stage and skipped_no_issue:
        shown = ", ".join(codes[i] for i in skipped_no_issue[:5])
        more = f" 等 {len(skipped_no_issue)} 个" if len(skipped_no_issue) > 5 else ""
        print(f"跳过的测试点    : 申购截点（ipo_date）缺失 {len(skipped_no_issue)} 个{more}：{shown}")
    if production_coverage is not None:
        print(f"产物区间覆盖    : {production_coverage*100:.1f}%（半宽 {production_half:.0f}pp；同源定标，偏乐观）")
    if broke.any():
        print(f"破发识别召回    : {summary['break_recall']*100:.1f}%，误报率 {summary['false_break_alarm_rate']*100:.1f}%")
    else:
        print(f"破发识别        : 历史 {len(actual)} 个测试点无破发样本，该指标不可评估")
    print(f"{'='*66}")

    if production_coverage is not None:
        summary["production_half_width"] = production_half
        summary["production_interval_coverage"] = production_coverage

    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump({"summary": summary, "points": results}, handle, ensure_ascii=False, indent=2)
        print(f"结果已写入: {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
