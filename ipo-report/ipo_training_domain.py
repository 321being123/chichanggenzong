# -*- coding: utf-8 -*-
"""训练和回测共用的纯特征、参数和目标变换；不访问数据库。"""
import numpy as np

# 注意：前 15 项是模型特征列，必须与 TRAINING_SQL 的选择顺序严格一致；
# listing_date 起的 5 项只供回测按预测截点重算校准量（不进入特征矩阵）：
# listing_date=上市日截点、ipo_date=发行公告日（申购阶段回测的信息截点）。
ROW_FIELDS = ('code', 'name', 'board', 'gain',
              'issue_price', 'issue_pe', 'industry_pe', 'fund_raised',
              'online_shares', 'total_shares', 'lottery_rate',
              'oversub_multiple', 'circ_mv', 'sub_limit', 'pe_ratio',
              'listing_date', 'main_business', 'industry', 'source_payload',
              'ipo_date')

# 缺值口径必须分两类，产物里也要分开标注，不能都写成“中位数”：
#   1) FITTED_MEDIAN_FIELDS：有有效样本，用中位数填充，推理端可直接复用该补位值；
#   2) NATIVE_MISSING_FIELDS：历史数据长期缺失，保持 NaN 由 XGBoost 按原生缺失学习，
#      推理端必须保持同样的缺失状态，产物里的 0 只是占位，不是补位值。
NATIVE_MISSING_FIELDS = ("issue_price", "fund_raised", "online_shares", "total_shares", "sub_limit")
FITTED_MEDIAN_FIELDS = ("issue_pe", "industry_pe", "lottery_rate", "oversub_multiple", "circ_mv", "pe_ratio")

FIELD_ORDER = ("issue_price", "issue_pe", "industry_pe", "fund_raised", "online_shares",
               "total_shares", "lottery_rate", "oversub_multiple", "circ_mv", "sub_limit", "pe_ratio")

FEATURE_NAMES = [
    'issue_price', 'issue_pe', 'industry_pe', 'fund_raised',
    'online_shares', 'total_shares', 'lottery_rate',
    'oversub_multiple', 'circ_mv', 'sub_limit', 'pe_ratio',
    'circ_mv_log', 'fund_log', 'price_times_pe',
    'lottery_inv', 'circ_per_lot', 'pe_squared'
]

XGB_PARAMS = {
    "objective": "reg:squarederror", "max_depth": 3, "eta": 0.05,
    "subsample": 0.7, "colsample_bytree": 0.7, "alpha": 2.0,
    "lambda": 3.0, "min_child_weight": 5, "seed": 42, "verbosity": 0,
}

NUM_BOOST_ROUND = 300


def to_float(arr):
    return [float(x) if x is not None else np.nan for x in arr]


def symlog_return(y):
    """奇对称对数变换：正值等价 log1p，负值（破发）保留符号与量级。

    不用 max(y, 0) 把破发截断成 0——那会让模型永远学不到破发，
    而首日破发恰恰是申购决策最需要预警的方向。
    """
    return np.sign(y) * np.log1p(np.abs(y))


def inv_symlog_return(z):
    """symlog_return 的逆变换，专供推理端与回测还原模型输出。"""
    return np.sign(z) * np.expm1(np.abs(z))


def build_feature_matrix(raw, medians):
    """按给定补位值构建 17 列特征矩阵。

    raw: {字段名: np.ndarray} 原始数组（未补值）
    medians: {FITTED_MEDIAN_FIELDS 中的字段: 中位数}
    生产训练传全量样本与全量中位数；评估或回测时对训练段与测试段都传**训练段**中位数，
    避免测试段样本进入补值统计（原先先补值再切分，测试集信息会回灌到训练特征）。
    """
    values = {}
    for field in FITTED_MEDIAN_FIELDS:
        values[field] = np.nan_to_num(raw[field], nan=medians[field])
    for field in NATIVE_MISSING_FIELDS:
        values[field] = raw[field]

    circ_mv_log = np.log1p(values["circ_mv"])
    fund_log = np.log1p(values["fund_raised"])
    price_times_pe = values["issue_price"] * values["issue_pe"] / 100
    lottery_inv = 1 / (values["lottery_rate"] + 0.001)
    circ_per_lot = values["circ_mv"] / (values["lottery_rate"] + 0.001)
    pe_squared = values["issue_pe"] ** 2 / 1000

    return np.column_stack([
        values["issue_price"], values["issue_pe"], values["industry_pe"], values["fund_raised"],
        values["online_shares"], values["total_shares"], values["lottery_rate"],
        values["oversub_multiple"], values["circ_mv"], values["sub_limit"], values["pe_ratio"],
        circ_mv_log, fund_log, price_times_pe,
        lottery_inv, circ_per_lot, pe_squared,
    ])


def rows_to_arrays(rows):
    """把数据库行拆成 {字段名: np.ndarray} 与代码/名称列表。"""
    data = {key: [] for key in ROW_FIELDS}
    for r in rows:
        for i, key in enumerate(ROW_FIELDS):
            data[key].append(r[i])
    raw = {field: np.array(to_float(data[field])) for field in FIELD_ORDER}
    return raw, data['code'], data['name'], np.array(to_float(data['gain']))
