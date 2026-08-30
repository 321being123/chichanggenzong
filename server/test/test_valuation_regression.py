# -*- coding: utf-8 -*-
# 可转债估值 Python 端回归测试（原生 assert，不依赖 pytest）
# 覆盖整改中修复的 7 个真 bug + 数据库落地完整性
# 运行：./venv/Scripts/python.exe server/test/test_valuation_regression.py
import sys, os, time, json, datetime as _dt, inspect

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))
import server.scripts.convertibleBondValuation as m
import pandas as pd
import numpy as np

results = []
def check(name, cond, detail=""):
    if cond:
        results.append(('PASS', name)); print('  [PASS]', name)
    else:
        results.append(('FAIL', name + ' :: ' + detail)); print('  [FAIL]', name, '::', detail)


# =====================================================================
# 单元：回测“完全失效”语义（bug1：原 len(fail_years)>=3 误判）
# =====================================================================
print('== 单元：回测“完全失效”语义 (bug1) ==')
def make_preds(year, mode):
    # mode: 'ok' 所有周期方向正; 'fail' 所有周期方向负; 'mixed' 仅 return_20 负、60/120 正
    n = 120
    seed = {'ok': 0, 'fail': 1, 'mixed': 2}[mode] * 1000 + year
    rng = np.random.default_rng(seed)
    dev = np.linspace(0, 100, n)
    z = rng.normal(0, 0.001, n)
    base = {'trade_date': pd.to_datetime([f'{year}-06-15'] * n),
            'absolute_deviation': dev, 'bond_value': 100.0}
    if mode == 'mixed':
        base['return_20'] = (0.01 * dev + z)
        base['return_60'] = (-0.01 * dev + z)
        base['return_120'] = (-0.01 * dev + z)
    else:
        ret = (-0.01 * dev + z) if mode == 'ok' else (0.01 * dev + z)
        base['return_20'] = base['return_60'] = base['return_120'] = ret
    for k in ('return_20', 'return_60', 'return_120'):
        base['anchor_adjusted_' + k] = base[k]
    return pd.DataFrame(base)

a = m.run_backtest(pd.concat([make_preds(2024, 'ok'), make_preds(2025, 'ok')], ignore_index=True))
check('A 全正年份 → 不判年度失效', a['yearly_fail'] is False)

b = m.run_backtest(pd.concat([make_preds(2024, 'ok'), make_preds(2025, 'fail')], ignore_index=True))
check('B 某年全周期负 → 判年度失效且含该年', b['yearly_fail'] is True and 2025 in b.get('complete_fail_years', []))

c = m.run_backtest(pd.concat([make_preds(2024, 'ok'), make_preds(2025, 'mixed')], ignore_index=True))
check('C 仅单周期负（非全周期）→ 不判年度失效', c['yearly_fail'] is False)


# =====================================================================
# 单元：_insufficient_row 的 FK 与 missing_fields（bug2 / bug6）
# =====================================================================
print('== 单元：_insufficient_row FK 与 missing_fields (bug2/bug6) ==')
tgt = pd.Timestamp('2025-06-02')
row_bad = m._insufficient_row(tgt, '110000.SH', None, '核心字段缺失:价格,转股价值', False, {},
                              '110000', None, mv='cb-valuation-v1-train-20260724')
check('FK: model_version 非空且等于传入值', row_bad['model_version'] == 'cb-valuation-v1-train-20260724')
diag = json.loads(row_bad['diagnostics'])
check('missing_fields 正确解析为 [价格, 转股价值]', diag['missing_fields'] == ['价格', '转股价值'])
row_new = m._insufficient_row(tgt, '110001.SH', None, '新上市观察期:18/40个交易日', False, {},
                              '110001', None, mv='cb-valuation-v1-train-20260724')
check('新上市债单列观察期', row_new['data_status'] == '新上市观察期')
check('新上市债记录样本进度', json.loads(row_new['diagnostics'])['observation_days'] == 18)


# =====================================================================
# 单元：训练时固化残差分布（阻断① 消除年内未来泄漏/当日横排）
# =====================================================================
print('== 单元：固定残差分布 (阻断1) ==')
edges = np.linspace(-0.5, 0.5, 201)
counts, _ = np.histogram(np.linspace(-0.2, 0.2, 101), bins=edges)
hist = {"hist_edges": edges.tolist(), "hist_cum": (np.cumsum(counts) / counts.sum()).tolist()}
p_mid = m.percentile_from_hist(0.0, hist)
check(f'固定历史分布中位约 50 (实测 {p_mid})', 40 <= p_mid <= 60)
p_low, p_high = m.percentile_from_hist(-0.19, hist), m.percentile_from_hist(0.19, hist)
check(f'固定分位单调 (低 {p_low} < 高 {p_high})', p_low < p_mid < p_high)
check('风险折价使用独立稳定分类', m._stable_eval_class('低估', '风险折价，不认定为低估') == '风险折价')

# 临近到期时只衰减正的额外期权价值，不衰减转股/债底内在价值。
fair_near, weight_near = m.maturity_adjusted_fair_value(110.0, 0.10, np.log(1.16))
fair_far, weight_far = m.maturity_adjusted_fair_value(110.0, 2.0, np.log(1.16))
fair_discount, _ = m.maturity_adjusted_fair_value(110.0, 0.10, np.log(0.95))
check(f'临期正溢价按剩余期限衰减 (实测 {fair_near:.2f})', 111.0 < fair_near < 112.5)
check('一年以上完整保留正溢价', abs(fair_far - 127.6) < 0.01 and weight_far == 1)
check('临期负溢价不被抹掉', abs(fair_discount - 104.5) < 0.01)
quality_dates = pd.to_datetime(['2026-08-17'] * 5 + ['2026-08-18'] * 5)
quality = pd.DataFrame({
    'trade_date': quality_dates,
    'close': [100] * 10,
    'conversion_value': [90] * 10,
    'bond_value': [95] * 5 + [np.nan] * 5,
})
check('半成品行情日不作为最新估值日', m.latest_usable_trade_date(quality) == pd.Timestamp('2026-08-17').date())
forced_years, forced_end, forced_source = m.effective_option_window(
    pd.Timestamp('2026-07-27'), 1.14,
    {'maturity_date': pd.Timestamp('2027-09-16'), 'conv_stop_date': pd.Timestamp('2026-08-12'),
     'bond_delist_date': pd.Timestamp('2026-08-12')}
)
check('强赎按停止转股日缩短期权窗口',
      forced_end == '2026-08-12' and forced_source == 'conv_stop_date' and 0.04 < forced_years < 0.05)


# =====================================================================
# 单元：预警状态机（阻断④）
# =====================================================================
print('== 单元：预警状态机 (阻断4) ==')
base_row = {"valuation_percentile": 85.0, "safety_level": "中风险", "final_evaluation": "偏高估",
            "credit_warning": "", "market_heat_pct": 5.0, "data_status": "完整"}
# 安全性恶化：上一日低风险 → 中风险 = 真正下降 → 触发
s1 = m._alert_state_of(dict(base_row), prev_row={"safety": "低风险"}, market_cycle="中位")
check('安全性真正下降时触发恶化预警', s1.get("安全性恶化") == "中风险")
# 上一日同为中风险 → 无变化 → 不触发
s2 = m._alert_state_of(dict(base_row), prev_row={"safety": "中风险"}, market_cycle="中位")
check('安全性无变化不触发恶化预警', "安全性恶化" not in s2)
# 无上一日快照 → 无从对比 → 不触发
s3 = m._alert_state_of(dict(base_row), prev_row=None, market_cycle="中位")
check('无上一日快照不触发恶化预警', "安全性恶化" not in s3)
# 双高：市场周期非高热 → 不触发；高位 → 触发
check('市场非高热不触发双高', "市场与单券双高" not in s2)
s4 = m._alert_state_of(dict(base_row), prev_row={"safety": "中风险"}, market_cycle="高位")
check('市场高位+单券高位触发双高', s4.get("市场与单券双高") == "双高")
# 高位状态值稳定（不含每日分位数字）
check('高位状态值不含每日分位', s4.get("估值进入高位") == "p80")
r95 = dict(base_row); r95["valuation_percentile"] = 96.0
s5 = m._alert_state_of(r95, prev_row={"safety": "中风险"}, market_cycle="中位")
check('极端高位状态值稳定为 p95', s5.get("估值进入极端高位") == "p95")
check('极端高位同时保持高位活动状态', s5.get("估值进入高位") == "p80")
low_risk_row = dict(base_row); low_risk_row["valuation_percentile"] = 10.0; low_risk_row["safety_level"] = "低风险"
check('低分位且低风险触发进入低位', m._alert_state_of(low_risk_row, prev_row={"safety": "低风险"}).get("估值进入低位") == "p20")
medium_row = dict(low_risk_row); medium_row["safety_level"] = "中风险"
check('中风险低分位不触发进入低位', "估值进入低位" not in m._alert_state_of(medium_row, prev_row={"safety": "中风险"}))
missing_row = dict(base_row); missing_row["data_status"] = "数据不足"
check('数据从完整变为不足才触发', "数据不足" in m._alert_state_of(missing_row, prev_row={"status": "完整", "safety": "中风险"}))
check('首日即不足不误触发状态变化', "数据不足" not in m._alert_state_of(missing_row, prev_row=None))


# =====================================================================
# 单元：估值断档发现与游标单调推进（防复发）
# =====================================================================
print('== 单元：估值断档发现与游标单调推进 (防复发) ==')
class _GapProbeCursor:
    def __init__(self):
        self.sql = ''

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.sql = sql

    def fetchall(self):
        return [(pd.Timestamp('2026-08-20').date(),), (pd.Timestamp('2026-08-25').date(),)]


class _GapProbeConnection:
    def __init__(self):
        self.cursor_probe = _GapProbeCursor()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self):
        return self.cursor_probe


gap_probe = _GapProbeConnection()
original_db_connect = m.db_connect
m.db_connect = lambda: gap_probe
try:
    gap_dates = m._find_valuation_gap_dates()
finally:
    m.db_connect = original_db_connect
check('刷新差集能识别游标已越过的历史断档',
      gap_dates == [pd.Timestamp('2026-08-20').date(), pd.Timestamp('2026-08-25').date()]
      and 'LEFT JOIN valuation_dates' in gap_probe.cursor_probe.sql)
check('日常刷新实际调用差集检查', '_find_valuation_gap_dates()' in inspect.getsource(m.cmd_refresh))


# =====================================================================
# 集成：性能 (bug7) + 数据库落地完整性（Task21）
# =====================================================================
print('== 集成：性能 / 数据库落地 (bug7 / Task21) ==')
try:
    m.load_env()
    t0 = time.time(); prep = m._build_prepared(); t1 = time.time()
    idx = m._build_index(prep); t2 = time.time()
    model = m._load_active_model()
    if not model:
        # GitHub Actions 使用空测试库，不训练或启用生产估值模型。
        # 算法单元测试已在上方执行；以下只验证依赖真实历史数据的集成项。
        raise RuntimeError('__CI_EMPTY_VALUATION_DATA__')
    safety = m.load_safety_map(); ratings = m.load_ratings(); full = m._full_universe(prep)
    profiles = m.load_bond_profiles()
    check('构建索引耗时合理 (<=120s)', (t2 - t1) <= 120)

    # 阻断③：可交易范围须排除到期/停止转股的券
    univ = m._universe_as_of(idx[1], profiles, pd.Timestamp('2026-07-24'), 7)
    check('可交易范围排除已到期券 110073.SH', '110073.SH' not in univ)
    check('可交易范围排除转股截止券 113037.SH', '113037.SH' not in univ)
    delist_univ = m._universe_as_of(idx[1], profiles, pd.Timestamp('2026-07-27'), 7)
    check('可交易范围排除退市日债券 113632.SH', '113632.SH' not in delist_univ)
    ghost_profiles = dict(profiles)
    ghost_profiles.pop('128044.SZ', None)
    ghost_univ = m._universe_as_of(idx[1], ghost_profiles, pd.Timestamp('2026-07-27'), 7)
    check('可交易范围排除无正式档案的幽灵行情 128044.SZ', '128044.SZ' not in ghost_univ)
    check(f'可交易范围非空 (实测 {len(univ)} 只)', len(univ) > 100)

    # bug7：单天 compute 必须远低于整改前的 8~42s（预填 as-of 分布不计入单天耗时）
    # 注意：须用行情表真实存在的交易日，否则 compute_daily 会用滞后行情写出孤儿日期，
    # 干扰下方“估值日全部属于行情日”的孤儿检查。
    perf_date = '2025-06-03'
    # 性能测试不得写真实数据库：临时替换发布函数，计算完成后立即恢复。
    class _NoWriteConnection:
        def __enter__(self): return self
        def __exit__(self, exc_type, exc, tb): return False
        def commit(self): return None

    original_db_connect = m.db_connect
    original_validate = m._validate_snapshot
    original_persist = m._persist_daily
    m.db_connect = lambda: _NoWriteConnection()
    m._validate_snapshot = lambda rows, conn, is_historical=False: None
    m._persist_daily = lambda rows, conn: None
    ts = time.time()
    try:
        n, _ = m.compute_daily(perf_date, prep, model, full, safety, ratings, is_historical=False,
                               index=idx, profile_map=profiles)
        dt = time.time() - ts
    finally:
        m.db_connect = original_db_connect
        m._validate_snapshot = original_validate
        m._persist_daily = original_persist
    check(f'bug7 单天 compute < 5s (实测 {dt:.2f}s, {n} 只)', dt < 5)

    with m.db_connect() as conn:
        with conn.cursor() as cur:
            # 孤儿日期检查：估值日必须是行情表真实存在的交易日
            cur.execute(
                "SELECT COUNT(*) FROM ("
                "SELECT DISTINCT DATE(trade_date) FROM analytics.convertible_bond_valuation_daily WHERE trade_date>='2023-01-01' "
                "EXCEPT SELECT DISTINCT DATE(trade_date) FROM market.convertible_bond_daily_metrics WHERE trade_date>='2023-01-01') t")
            orphan_days = cur.fetchone()[0]
            check(f'估值日全部属于行情日（无孤儿日期, 实测 {orphan_days}）', orphan_days == 0)
            cur.execute("SELECT COUNT(DISTINCT trade_date) FROM market.convertible_bond_daily_metrics WHERE trade_date >= '2023-01-01'")
            expected_days = cur.fetchone()[0]
            cur.execute("SELECT COUNT(DISTINCT trade_date) FROM analytics.convertible_bond_valuation_daily WHERE trade_date >= '2023-01-01'")
            days = cur.fetchone()[0]
            cur.execute(
                "SELECT COUNT(*) FROM ("
                "SELECT DISTINCT DATE(trade_date) AS d FROM market.convertible_bond_daily_metrics WHERE trade_date >= '2023-01-01' "
                "EXCEPT SELECT DISTINCT DATE(trade_date) FROM analytics.convertible_bond_valuation_daily WHERE trade_date >= '2023-01-01'"
                ") missing "
                "WHERE d <= (SELECT MAX(trade_date) FROM analytics.convertible_bond_valuation_daily)")
            internal_missing = cur.fetchone()[0]
            check(f'历史估值回填无内部缺口 (行情 {expected_days} 天 / 估值 {days} 天)', internal_missing == 0)

            cur.execute(
                "SELECT COUNT(*) FROM analytics.convertible_bond_valuation_daily d "
                "WHERE d.model_version <> (SELECT model_version FROM analytics.convertible_bond_valuation_models WHERE is_active LIMIT 1)")
            orphan = cur.fetchone()[0]
            check(f'FK 孤儿行 = 0 (实测 {orphan})', orphan == 0)

            cur.execute(
                "SELECT EXTRACT(YEAR FROM trade_date)::int y, "
                "AVG(CASE WHEN eval_class='数据不足' THEN 1.0 ELSE 0 END) p "
                "FROM analytics.convertible_bond_valuation_daily GROUP BY 1 ORDER BY 1")
            trend = {int(r[0]): float(r[1]) for r in cur.fetchall()}
            check('数据不足占比随年递减 (2023 > 2026)', trend.get(2023, 0) > trend.get(2026, 0))

            cur.execute(
                "SELECT COUNT(*) FROM analytics.convertible_bond_valuation_alerts "
                "WHERE alert_type='安全性恶化' AND current_state IN ('安全','低风险')")
            wrong = cur.fetchone()[0]
            check(f'安全性恶化不含 安全/低风险 误报 (实测 {wrong})', wrong == 0)

            # 阻断②/⑧：估值日不超前行情日；最新行情尚未完成估值时由 stale 水位提示，
            # 不把异步刷新窗口误报成回归失败。
            cur.execute("SELECT MAX(trade_date) FROM market.convertible_bond_daily_metrics")
            latest_mkt = cur.fetchone()[0]
            cur.execute("SELECT MAX(trade_date) FROM analytics.convertible_bond_valuation_daily")
            latest_val = cur.fetchone()[0]
            check(f'最新估值日不超前行情日 (行情 {latest_mkt} / 估值 {latest_val})',
                  latest_val is None or latest_mkt is None or latest_val <= latest_mkt)
            if latest_val is None:
                pending_market_days = expected_days
            else:
                cur.execute(
                    "SELECT COUNT(DISTINCT trade_date) FROM market.convertible_bond_daily_metrics WHERE trade_date > %s",
                    (latest_val,))
                pending_market_days = cur.fetchone()[0]
            check(f'末尾待估值行情不超过 1 个交易日 (实测 {pending_market_days})', pending_market_days <= 1)
            cur.execute(
                "SELECT COUNT(*) FROM analytics.convertible_bond_valuation_daily "
                "WHERE trade_date=%s AND eval_class IN ('低估','偏低估','合理','偏高估','高估','风险折价')",
                (latest_val,))
            valued_n = cur.fetchone()[0]
            check(f'最新日六档评价非全零 (实测 {valued_n} 只)', valued_n > 0)
            cur.execute(
                "SELECT COUNT(*) FROM analytics.convertible_bond_valuation_daily WHERE trade_date=%s",
                (latest_val,))
            total_n = cur.fetchone()[0]
            check(f'最新日"数据不足"非全部 (评价 {valued_n}/{total_n})', valued_n * 2 > total_n)

            # 阻断③：库中最新日不含已到期/停止转股的券
            cur.execute(
                "SELECT COUNT(*) FROM analytics.convertible_bond_valuation_daily d "
                "JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=d.instrument_id "
                "WHERE d.trade_date=%s AND ("
                "  (p.maturity_date IS NOT NULL AND p.maturity_date < d.trade_date) OR"
                "  (p.conv_stop_date IS NOT NULL AND p.conv_stop_date < d.trade_date))",
                (latest_val,))
            expired = cur.fetchone()[0]
            check(f'最新日无已到期/停止转股残留 (实测 {expired})', expired == 0)

            # 阻断④：恢复记录不保持活动状态（防"恢复的恢复"）
            cur.execute(
                "SELECT COUNT(*) FROM analytics.convertible_bond_valuation_alerts "
                "WHERE alert_type LIKE '%（恢复）' AND is_active")
            active_recover = cur.fetchone()[0]
            check(f'恢复记录不保持活动状态 (实测 {active_recover})', active_recover == 0)

            cur.execute(
                "SELECT COUNT(*) FROM analytics.convertible_bond_valuation_daily "
                "WHERE final_evaluation LIKE '风险折价%' AND eval_class <> '风险折价'")
            wrong_risk_class = cur.fetchone()[0]
            check(f'风险折价均使用独立分类 (实测错误 {wrong_risk_class})', wrong_risk_class == 0)

            cur.execute(
                "SELECT model_path, model_file_rel_path, backtest_metrics, yearly_metadata "
                "FROM analytics.convertible_bond_valuation_models WHERE is_active LIMIT 1")
            model_path, rel_path, metrics, yearly = cur.fetchone()
            check('活动模型数据库路径不含本机绝对路径',
                  not os.path.isabs(model_path or '') and not os.path.isabs(rel_path or ''))
            required_bt = {'high_heat_portfolio', 'high_heat_convergence', 'missing_horizon', 'high_heat_fail'}
            check('活动模型保存完整新回测字段', required_bt.issubset(set((metrics or {}).keys())))
            leakage = [
                year for year, meta in (yearly or {}).items()
                if str((meta.get('residual_quantiles') or {}).get('calibration_end_date', '9999')) >= f'{year}-01-01'
            ]
            check(f'年度误差校准截止日早于预测年 (异常 {leakage})', not leakage)

            # 在事务内验证补旧断档不会把已完成的更晚游标倒退，随后回滚。
            cur.execute(
                "SELECT last_success_date FROM ops.sync_cursors "
                "WHERE scope_key='convertible_bond_valuation' AND dataset_code='daily_valuation'"
            )
            cursor_before = cur.fetchone()[0]
            if cursor_before:
                m._advance_valuation_cursor(cursor_before - _dt.timedelta(days=1), conn)
                cur.execute(
                    "SELECT last_success_date FROM ops.sync_cursors "
                    "WHERE scope_key='convertible_bond_valuation' AND dataset_code='daily_valuation'"
                )
                cursor_after = cur.fetchone()[0]
                check('补旧断档不使估值游标倒退', cursor_after == cursor_before)
            else:
                check('补旧断档不使估值游标倒退', False, '估值游标为空')

            # 在事务内验证同一状态可于不同交易日再次触发，随后回滚，不污染数据库。
            cur.execute("SELECT instrument_id FROM analytics.convertible_bond_valuation_daily ORDER BY trade_date DESC LIMIT 1")
            test_iid = cur.fetchone()[0]
            for event_date in ('1900-01-01', '1900-01-02'):
                cur.execute(
                    "INSERT INTO analytics.convertible_bond_valuation_alerts "
                    "(instrument_id,trade_date,alert_type,alert_level,current_state,model_version,is_active) "
                    "VALUES(%s,%s,'回归测试-恢复后再次触发','关注','同一状态',%s,false)",
                    (test_iid, event_date, model["model_version"]),
                )
                check('恢复后可在新交易日再次触发相同状态', True)
            conn.rollback()
except RuntimeError as e:
    if str(e) == '__CI_EMPTY_VALUATION_DATA__':
        check('CI 空数据库：跳过真实估值数据集成校验', True)
    else:
        import traceback; traceback.print_exc()
        check('集成测试执行', False, str(e))
except Exception as e:
    import traceback; traceback.print_exc()
    check('集成测试执行', False, str(e))


fail = sum(1 for x in results if x[0] == 'FAIL')
print(f'\n结果：{len(results) - fail}/{len(results)} 通过')
sys.exit(1 if fail else 0)
