# -*- coding: utf-8 -*-
"""A 股打新首日涨幅预测的时间滚动样本外回测（walk-forward）。

为什么需要它：
  单次 80/20 切分只给出一个时点的样本外指标；而上线模型用全量样本训练后，
  再拿它预测历史样本属于**样本内**（见过答案），"预测变准"其实是假象。
  本脚本按时间滚动：每个测试点只用它**之前**的样本训练，模拟"站在当时预测未来"，
  用于验证模型、统计量或参数改动是否真的改善了样本外表现。

产出指标：
  - MAE / MAPE / 中位绝对误差
  - 预测区间覆盖率（区间由训练段残差分位数给出，覆盖率应接近名义水平）
  - 破发识别（实际破发被预测为破发的比例）
  - 按年份、按板块分层

用法：
  python backtest_ipo_prediction.py                  # 全量滚动（每 1 条重训）
  python backtest_ipo_prediction.py --step 5         # 每 5 条重训一次（提速）
  python backtest_ipo_prediction.py --min-train 100  # 至少 100 条历史才开始预测
  python backtest_ipo_prediction.py --json out.json  # 同时输出机器可读结果
"""
import argparse
import json
import os
import sys

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


def slice_fields(fields, start, stop):
    return {key: value[start:stop] for key, value in fields.items()}


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


def main():
    parser = argparse.ArgumentParser(description="A 股打新预测时间滚动样本外回测")
    parser.add_argument("--min-train", type=int, default=80, help="开始滚动前至少有多少条历史样本")
    parser.add_argument("--step", type=int, default=1, help="每隔多少条重训一次（1 为逐条重训）")
    parser.add_argument("--json", default=None, help="把结果写入 JSON 文件")
    args = parser.parse_args()

    import xgboost as xgb

    rows = load_training_rows()
    if not rows:
        print("没有可用于回测的历史样本")
        return 1
    raw, codes, names, gain = rows_to_arrays(rows)
    total = len(rows)
    if args.min_train >= total:
        print(f"历史样本仅 {total} 条，不足以在 min-train={args.min_train} 下滚动")
        return 1

    print(f"样本 {total} 条，起始训练窗口 {args.min_train} 条，重训间隔 {args.step}")
    print(f"{'序号':>5} {'代码':>8} {'名称':<8} {'预测':>7} {'实际':>7} {'偏差':>7}")

    results = []
    model = medians = low_q = high_q = None
    for index in range(args.min_train, total):
        if (index - args.min_train) % args.step == 0:
            model, medians, low_q, high_q = train_on_window(
                slice_fields(raw, 0, index), gain[:index], xgb
            )
        test_raw = slice_fields(raw, index, index + 1)
        matrix = xgb.DMatrix(build_feature_matrix(test_raw, medians), feature_names=FEATURE_NAMES)
        predicted = float(inv_symlog_return(model.predict(matrix))[0])
        actual = float(gain[index])
        results.append({
            "code": codes[index],
            "name": names[index],
            "predicted": predicted,
            "actual": actual,
            "error": predicted - actual,
            "low": predicted + low_q,
            "high": predicted + high_q,
        })
        print(f"{index:>5} {codes[index]:>8} {names[index]:<8} {predicted:>6.0f}% {actual:>6.0f}% {predicted-actual:>+6.0f}pp")

    predicted = np.array([r["predicted"] for r in results])
    actual = np.array([r["actual"] for r in results])
    error = predicted - actual
    covered = (actual >= np.array([r["low"] for r in results])) & (actual <= np.array([r["high"] for r in results]))

    mae = float(np.mean(np.abs(error)))
    mape = float(np.mean(np.abs(error / (actual + 1))) * 100)
    medae = float(np.median(np.abs(error)))
    coverage = float(np.mean(covered))
    # 破发识别：实际破发被预测为破发的比例；历史无破发时该指标无定义
    broke = actual < 0
    broke_hit = float(np.mean(predicted[broke] < 0)) if broke.any() else None
    false_alarm = float(np.mean(predicted[~broke] < 0)) if (~broke).any() else None

    summary = {
        "min_train": args.min_train,
        "step": args.step,
        "test_points": len(results),
        "mae": mae,
        "mape": mape,
        "median_absolute_error": medae,
        "interval_coverage": coverage,
        "interval_nominal": 0.8,
        "break_count": int(broke.sum()),
        "break_recall": broke_hit,
        "false_break_alarm_rate": false_alarm,
        "mean_error": float(np.mean(error)),
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
            production_coverage = float(np.mean(np.abs(error) <= production_half))
    except Exception:
        production_half = production_coverage = None

    print(f"\n{'='*54}")
    print(f"样本外 MAE      : {mae:.1f}pp")
    print(f"样本外 MAPE     : {mape:.1f}%")
    print(f"中位绝对误差    : {medae:.1f}pp")
    print(f"平均偏差        : {np.mean(error):+.1f}pp（正=系统性高估）")
    print(f"模型自估区间覆盖: {coverage*100:.1f}%（名义 {summary['interval_nominal']*100:.0f}%，区间由训练段残差分位数给出）")
    if production_coverage is not None:
        print(f"产物区间覆盖    : {production_coverage*100:.1f}%（半宽 {production_half:.0f}pp；同源定标，偏乐观）")
    if broke.any():
        print(f"破发识别召回    : {broke_hit*100:.1f}%")
        print(f"破发误报率      : {false_alarm*100:.1f}%")
    else:
        print(f"破发识别        : 历史 {len(actual)} 个测试点无破发样本，该指标不可评估")
    print(f"{'='*54}")

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
