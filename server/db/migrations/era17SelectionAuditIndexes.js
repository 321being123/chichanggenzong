// 214：选股输入审计的全市场查询索引（2026-11-27）。
//
// 背景：2026-11-26 起 `company_financial_incremental_sync` 的 selection_inputs 模式
// 每次跑满 30 分钟被 kill。生产实测慢点不在采集，而在 `auditInputs` 的全市场查询：
// `loadAnnualDividends` 的年度分红查询单条要 500—880 秒，每次运行还要跑两遍（审计前后各一次）。
// 数据规模已到 fundamental.financial_reports 118 万行 / 9.4GB、corporate_actions 11.6 万行。
//
// 这里只补两个「查询条件固定」的部分索引，不改表结构、不改任何金额或口径：
//   ① 利润类财报按公司取报告期：只覆盖 income + 合并口径；
//   ② 分红去重：同一证券按除息日/财年查找。
// 部分索引的条件必须能被查询条件蕴含，否则索引根本不会被选中：
//   - 财报侧只写 report_kind / statement_scope（期间类型在代码里是表达式，
//     不能写成 period_type='annual' 的索引条件，那样查询推不出谓词、索引直接失效）；
//   - 分红侧 action_type='dividend' 与查询里的常量条件一致。
// 代码若改这些常量条件，必须同步本迁移，否则索引不再命中（功能不受影响，只会变慢）。
async function migration214SelectionAuditIndexes(pool) {
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_financial_reports_income_period
    ON fundamental.financial_reports (company_id, announced_at, period_end)
    INCLUDE (available_at, period_type)
    WHERE report_kind = 'income' AND statement_scope = 'consolidated'`);
  // 期间类型未声明的存量行（生产仅 23 行）才回退官方标签；单独一条小索引，
  // 让「年度报告期集合」查询可以把等值与回退分成两支，而不必对整表逐行解 JSON。
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_financial_reports_period_undeclared
    ON fundamental.financial_reports (company_id, announced_at, period_end)
    WHERE report_kind = 'income' AND statement_scope = 'consolidated'
      AND COALESCE(period_type, 'unknown') IN ('', 'unknown')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_corporate_actions_dividend_dedup
    ON fundamental.corporate_actions (instrument_id, ex_date, fiscal_period_end, source_id DESC)
    WHERE action_type = 'dividend'`);
}

module.exports = { migration214SelectionAuditIndexes };
