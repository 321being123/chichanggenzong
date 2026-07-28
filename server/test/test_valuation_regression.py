# -*- coding: utf-8 -*-
# 可转债估值 Python 端回归测试（原生 assert，不依赖 pytest）
# 覆盖整改中修复的 7 个真 bug + 数据库落地完整性
# 运行：./venv/Scripts/python.exe server/test/test_valuation_regression.py
import sys, os, time, json

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


# =====================================================================
# 单元：as-of 残差分布（阻断① 消除年内未来泄漏）
# =====================================================================
print('== 单元：as-of 残差分布 (阻断1) ==')
edges = list(np.linspace(-0.5, 0.5, 201))
tr = m._new_residual_tracker(edges)
check('空 tracker 分位返回 None', m._tracker_percentile(tr, 0.1) is None)
m._tracker_add(tr, np.linspace(-0.2, 0.2, 101))
p_mid = m._tracker_percentile(tr, 0.0)
check(f'中位偏离分位约 50 (实测 {p_mid})', p_mid is not None and 40 <= p_mid <= 60)
p_low, p_high = m._tracker_percentile(tr, -0.19), m._tracker_percentile(tr, 0.19)
check(f'分位单调 (低 {p_low} < 高 {p_high})', p_low < p_mid < p_high)
q40, q60 = m._tracker_quantile(tr, 0.40), m._tracker_quantile(tr, 0.60)
check(f'q40 < q60 (实测 {q40:.4f} / {q60:.4f})', q40 < q60)
# 增量累计后分位随之变化（as-of 语义：只反映已累计的历史）
m._tracker_add(tr, np.full(500, 0.3))
p_mid2 = m._tracker_percentile(tr, 0.0)
check(f'追加高偏离样本后原中位分位下降 (实测 {p_mid2})', p_mid2 < p_mid)


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


# =====================================================================
# 集成：性能 (bug7) + 数据库落地完整性（Task21）
# =====================================================================
print('== 集成：性能 / 数据库落地 (bug7 / Task21) ==')
try:
    m.load_env()
    t0 = time.time(); prep = m._build_prepared(); t1 = time.time()
    idx = m._build_index(prep); t2 = time.time()
    model = m._load_active_model()
    assert model, '尚未启用估值模型'
    safety = m.load_safety_map(); ratings = m.load_ratings(); full = m._full_universe(prep)
    profiles = m.load_bond_profiles()
    check('构建索引耗时合理 (<=120s)', (t2 - t1) <= 120)

    # 阻断③：可交易范围须排除到期/停止转股的券
    univ = m._universe_as_of(idx[1], profiles, pd.Timestamp('2026-07-24'), 7)
    check('可交易范围排除已到期券 110073.SH', '110073.SH' not in univ)
    check('可交易范围排除转股截止券 113037.SH', '113037.SH' not in univ)
    check(f'可交易范围非空 (实测 {len(univ)} 只)', len(univ) > 100)

    # bug7：单天 compute 必须远低于整改前的 8~42s（预填 as-of 分布不计入单天耗时）
    # 注意：须用行情表真实存在的交易日，否则 compute_daily 会用滞后行情写出孤儿日期，
    # 干扰下方“估值日集合 ⊆ 行情日”的孤儿检查。
    perf_date = '2025-06-03'
    trackers = m._prefill_trackers(prep, model, perf_date, idx, profiles)
    ts = time.time()
    n, _ = m.compute_daily(perf_date, prep, model, full, safety, ratings, is_historical=False,
                           index=idx, profile_map=profiles, residual_trackers=trackers)
    dt = time.time() - ts
    check(f'bug7 单天 compute < 5s (实测 {dt:.2f}s, {n} 只)', dt < 5)

    with m.db_connect() as conn:
        with conn.cursor() as cur:
            # 孤儿日期检查：估值日必须是行情表真实存在的交易日
            cur.execute(
                "SELECT COUNT(*) FROM ("
                "SELECT DISTINCT DATE(trade_date) FROM analytics.convertible_bond_valuation_daily WHERE trade_date>='2023-01-01' "
                "EXCEPT SELECT DISTINCT DATE(trade_date) FROM market.convertible_bond_daily_metrics WHERE trade_date>='2023-01-01') t")
            orphan_days = cur.fetchone()[0]
            check(f'估值日集合 ⊆ 行情日（无孤儿日期, 实测 {orphan_days}）', orphan_days == 0)
            cur.execute("SELECT COUNT(DISTINCT trade_date) FROM market.convertible_bond_daily_metrics WHERE trade_date >= '2023-01-01'")
            expected_days = cur.fetchone()[0]
            cur.execute("SELECT COUNT(DISTINCT trade_date) FROM analytics.convertible_bond_valuation_daily WHERE trade_date >= '2023-01-01'")
            days = cur.fetchone()[0]
            check(f'回填覆盖全部行情交易日 (期望 {expected_days}, 实测 {days})', days == expected_days)

            cur.execute(
                "SELECT COUNT(*) FROM analytics.convertible_bond_valuation_daily d "
                "WHERE d.model_version <> (SELECT model_version FROM analytics.convertible_bond_valuation_models WHERE is_active LIMIT 1)")
            orphan = cur.fetchone()[0]
            check(f'FK 孤儿行 = 0 (实测 {orphan})', orphan == 0)

            cur.execute(
                "SELECT EXTRACT(YEAR FROM trade_date)::int y, "
                "AVG(CASE WHEN data_status='数据不足' THEN 1.0 ELSE 0 END) p "
                "FROM analytics.convertible_bond_valuation_daily GROUP BY 1 ORDER BY 1")
            trend = {int(r[0]): float(r[1]) for r in cur.fetchall()}
            check('数据不足占比随年递减 (2023 > 2026)', trend.get(2023, 0) > trend.get(2026, 0))

            cur.execute(
                "SELECT COUNT(*) FROM analytics.convertible_bond_valuation_alerts "
                "WHERE alert_type='安全性恶化' AND current_state IN ('安全','低风险')")
            wrong = cur.fetchone()[0]
            check(f'安全性恶化不含 安全/低风险 误报 (实测 {wrong})', wrong == 0)

            # 阻断②/⑧：最新估值日不过期（等于最新行情日）且六档评价非全零
            cur.execute("SELECT MAX(trade_date) FROM market.convertible_bond_daily_metrics")
            latest_mkt = cur.fetchone()[0]
            cur.execute("SELECT MAX(trade_date) FROM analytics.convertible_bond_valuation_daily")
            latest_val = cur.fetchone()[0]
            check(f'最新估值日不过期 (行情 {latest_mkt} / 估值 {latest_val})', latest_val == latest_mkt)
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
except Exception as e:
    import traceback; traceback.print_exc()
    check('集成测试执行', False, str(e))


fail = sum(1 for x in results if x[0] == 'FAIL')
print(f'\n结果：{len(results) - fail}/{len(results)} 通过')
sys.exit(1 if fail else 0)
