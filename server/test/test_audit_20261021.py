# -*- coding: utf-8 -*-
"""2026-10-21 三视角审查回归（Python）：R-13 安全性映射键、P-7 名称提取根因。

运行：venv/Scripts/python.exe server/test/test_audit_20261021.py
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'server', 'scripts'))

import server.scripts.convertibleBondValuation as val  # noqa: E402
import extractConvertibleBondLifecycle as xt  # noqa: E402

results = []


def check(name, cond, detail=''):
    if cond:
        results.append(('PASS', name))
        print('  [PASS]', name)
    else:
        results.append(('FAIL', name + ' :: ' + detail))
        print('  [FAIL]', name, '::', detail)


# =====================================================================
# R-13：安全性映射键（快照存完整代码，估值按 base_code 查询）
# =====================================================================
print('== R-13 安全性映射双键 ==')


class _FakeCursor:
    def __init__(self, row):
        self._row = row

    def execute(self, *args, **kwargs):
        pass

    def fetchone(self):
        return self._row

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeConn:
    def __init__(self, row):
        self._row = row

    def cursor(self):
        return _FakeCursor(self._row)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


SAMPLE = [
    {'bond_code': '110092.SH', 'safety': '安全'},
    {'bond_code': '123456.SZ', 'safety': '未评级'},
    {'bond_code': '', 'safety': '高风险'},
]
orig_connect = val.db_connect
val.db_connect = lambda: _FakeConn([json.dumps(SAMPLE)])
try:
    smap = val.load_safety_map()
finally:
    val.db_connect = orig_connect

check('R-13 完整代码键命中', smap.get('110092.SH') == '安全', str(smap))
check('R-13 base_code 查询命中（compute_daily 的查法）', smap.get('110092') == '安全' and smap.get('123456') == '未评级', str(smap))
check('R-13 空代码不写入', '' not in smap)

orig_connect = val.db_connect
val.db_connect = lambda: _FakeConn([json.dumps(SAMPLE)])
try:
    hmap = val.load_historical_safety_map('2026-10-20')
finally:
    val.db_connect = orig_connect
check('R-13 历史映射同样双键命中', hmap and hmap.get('110092') == '安全', str(hmap))

# =====================================================================
# P-7：生命周期公告名称提取（根因：正文残留混入简称）
# =====================================================================
print('== P-7 名称提取根因 ==')
t1 = xt.parse_text('本期发行的可转换公司债券简称为“航亚转债”，债券代码为118078，股票简称为“航亚科技”，股票代码为688510。')
check('P-7 引号写法不带正文残留', t1['bond_name'] == '航亚转债', repr(t1.get('bond_name')))
check('P-7 股票简称同样干净', t1['stock_name'] == '航亚科技', repr(t1.get('stock_name')))

t2 = xt.parse_text('债券简称为“常青转债二”、可转换公司债券将于2026年11月上市，债券代码113711，股票简称常青科技，股票代码603125。')
check('P-7 顿号后的体裁残留不进名称', t2['bond_name'] == '常青转债二', repr(t2.get('bond_name')))

t3 = xt.parse_text('债券简称：国科转债2、可转换公司债券，债券代码123456。')
check('P-7 无引号写法同样只取简称', t3['bond_name'] == '国科转债2', repr(t3.get('bond_name')))

t4 = xt.parse_text('债券简称为航亚转债股票简称航亚科技股票代码688510。')
check('P-7 无分隔符时按字段边界截断', t4['bond_name'] == '航亚转债', repr(t4.get('bond_name')))

failed = [r for r in results if r[0] == 'FAIL']
print('PASS=%d FAIL=%d ERROR=0' % (len(results) - len(failed), len(failed)))
if failed:
    print('HAS_ISSUES')
    sys.exit(1)
print('test_audit_20261021 全部通过')
