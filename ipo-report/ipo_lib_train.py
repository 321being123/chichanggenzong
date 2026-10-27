# -*- coding: utf-8 -*-
"""训练与回测的兼容入口；发行阶段以 ipo_date 为信息截点。"""
import ipo_training_domain as _domain
from ipo_training_domain import (
    ROW_FIELDS, NATIVE_MISSING_FIELDS, FITTED_MEDIAN_FIELDS, FIELD_ORDER,
    FEATURE_NAMES, XGB_PARAMS, NUM_BOOST_ROUND, to_float,
    inv_symlog_return, rows_to_arrays,
)
from ipo_training_data import BASE_DIR, DATA_DIR, DB_PATH, TRAINING_SQL, load_training_rows


def symlog_return(y):
    return _domain.symlog_return(y)


def build_feature_matrix(raw, medians):
    return _domain.build_feature_matrix(raw, medians)
