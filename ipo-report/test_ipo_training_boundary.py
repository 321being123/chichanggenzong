"""训练模块拆分前后等价及数据源回退检查，不访问真实数据源。"""
import json
import math
from pathlib import Path
from unittest.mock import patch

import numpy as np
import ipo_lib_train as facade
import ipo_training_data as data
import ipo_training_domain as domain

ROWS = [
    ('600000.SH', '样本甲', '主板', -3, 12, None, 20, None, None, None, 0.02, 100, 200, None, 1.3, '2025-02-01', '业务甲', '行业甲', {}, '2025-01-25'),
    ('300001.SZ', '样本乙', '创业板', 150, None, 25, None, 40, 10, 20, None, None, None, 3, None, '2025-03-01', '业务乙', '行业乙', {}, '2025-02-25'),
]
MEDIANS = {'issue_pe': 18, 'industry_pe': 22, 'lottery_rate': 0.04, 'oversub_multiple': 80, 'circ_mv': 100, 'pe_ratio': 1.1}


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [clean(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def actual():
    raw, codes, names, gains = facade.rows_to_arrays(ROWS)
    sample = np.array([-100.0, -3.0, 0.0, 150.0])
    return clean({
        'feature_names': facade.FEATURE_NAMES, 'params': facade.XGB_PARAMS,
        'rounds': facade.NUM_BOOST_ROUND, 'codes': codes, 'names': names,
        'gains': gains.tolist(), 'features': facade.build_feature_matrix(raw, MEDIANS).tolist(),
        'transforms': facade.symlog_return(sample).tolist(),
        'inverse': facade.inv_symlog_return(facade.symlog_return(sample)).tolist(),
    })


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows
        self.closed = False
        self.sql = None

    def execute(self, sql):
        self.sql = sql
        return self

    def fetchall(self):
        return self.rows

    def close(self):
        self.closed = True


def main():
    fixture = Path(__file__).resolve().parent.parent / 'server/test/fixtures/ipo-training-boundary-baseline.json'
    assert actual() == json.loads(fixture.read_text(encoding='utf-8'))['expected'], '训练特征、模型参数或目标变换偏离改动前基线'
    assert facade.rows_to_arrays is domain.rows_to_arrays
    assert facade.load_training_rows is data.load_training_rows
    primary = FakeConnection(ROWS)
    with patch.object(data.db_pg, 'connect', return_value=primary), patch.object(data.sqlite3, 'connect', side_effect=AssertionError('主源有效时不得访问备用库')):
        assert facade.load_training_rows() == ROWS
    assert primary.closed and primary.sql == data.TRAINING_SQL
    backup = FakeConnection(ROWS)
    with patch.object(data.db_pg, 'connect', side_effect=RuntimeError('主源不可用')), patch.object(data.sqlite3, 'connect', return_value=backup):
        assert facade.load_training_rows() == ROWS
    assert backup.closed and backup.sql == data.TRAINING_SQL
    print('训练分层：改动前基线、唯一实现与主备读取通过')


if __name__ == '__main__':
    main()
