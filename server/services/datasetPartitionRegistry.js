// 非核心任务产出数据集的统一分区登记。
// SQL 全部来自本文件的白名单，任务只传数据集代码，不允许拼接外部 SQL。
const { pool } = require('../db/connection');
const { publishDatasetPartition } = require('./datasetPartitions');
const { getJobDefinition } = require('./jobDefinitions');

// 同时接受 'YYYY-MM-DD' 与 'YYYYMMDD' 两种历史格式（ipo_reports 等 TEXT 日期列），
// 否则水位只统计到带横线的旧行（2026-10-21 审查 R-14：10-21 分区却记录 7-15 水位）。
const DATE_TEXT = (column) => `MAX(CASE WHEN ${column}::text ~ '^(\\d{4}-\\d{2}-\\d{2}|\\d{8})$' THEN ${column}::date END)::text`;

/**
 * 选股 V2 周期渠道的数据集定义（方案 27.8）：
 * 每日/每周/影子各自一个逻辑数据集，底层仍是 analytics.stock_selection_runs + members。
 * 计数只取该渠道该业务日**生效的那一个** run（正式取已发布、影子取最新记录），
 * 不把多个 revision 的成员相加——那会让修订后的行数虚高。
 */
function selectionPeriodDataset(market, runKind, shadow) {
  const kindFilter = runKind ? `r.run_kind = '${runKind}'` : `r.run_kind IN ('daily','weekly')`;
  const publishedFilter = shadow ? '' : 'AND r.published_at IS NOT NULL';
  return {
    scopeKey: market,
    table: 'analytics.stock_selection_portfolio_members',
    partitionedCountSql: `SELECT COALESCE((
        SELECT r.selected_count FROM analytics.stock_selection_runs r
         WHERE r.market = '${market}' AND ${kindFilter} AND r.as_of_date = $1::date
           AND r.is_shadow = ${shadow ? 'true' : 'false'} ${publishedFilter}
         ORDER BY r.revision DESC, r.run_id DESC LIMIT 1), 0)::int AS row_count`,
    partitionedDataAsOfSql: 'SELECT $1::text AS data_as_of',
  };
}

const DATASET_PARTITION_REGISTRY = Object.freeze({
  account_cash_income:{scopeKey:null,scopeType:'account',table:'public.cash_flows'},
  stock_cash_dividend_facts:{scopeKey:'GLOBAL',table:'fundamental.corporate_actions',countSql:"SELECT COUNT(*)::int AS row_count",whereSql:"WHERE action_type='dividend'",dataAsOfSql:'SELECT MAX(announced_at)::text AS data_as_of'},
  stock_swap_settlements:{scopeKey:'GLOBAL',table:'event.stock_swap_settlements',countSql:'SELECT COUNT(*)::int AS row_count',dataAsOfSql:'SELECT MAX(settlement_date)::text AS data_as_of'},
  repo_daily_rates:{scopeKey:'CN',table:'market.repo_daily_rates',partitionedCountSql:"SELECT COUNT(*)::int AS row_count FROM market.repo_daily_rates WHERE trade_date=$1::date AND quality_status='passed'",partitionedDataAsOfSql:"SELECT MAX(trade_date)::text AS data_as_of FROM market.repo_daily_rates WHERE trade_date=$1::date AND quality_status='passed'"},
  account_daily_prices: { scopeKey: 'GLOBAL', table: 'public.daily_prices', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT ${DATE_TEXT('date')} AS data_as_of` },
  hk_fx_rate: { scopeKey: 'GLOBAL', table: 'market.fx_rates', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(rate_date)::text AS data_as_of' },
  nav_snapshot: { scopeKey: 'GLOBAL', table: 'public.nav_history',
    partitionedCountSql: 'SELECT COUNT(*)::int AS row_count FROM public.nav_history WHERE date=$1::text',
    partitionedDataAsOfSql: 'SELECT MAX(date)::text AS data_as_of FROM public.nav_history WHERE date=$1::text' },
  index_daily: { scopeKey: 'GLOBAL', table: 'public.index_history', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT ${DATE_TEXT('date')} AS data_as_of` },
  ipo_calendar: { scopeKey: 'GLOBAL', table: 'public.ipo_reports', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT ${DATE_TEXT('report_date')} AS data_as_of` },
  // 只数与「上市可转债列表」同口径（2026-11-01 统一）：该交易日有行情、在市、公募、生命周期可判定的转债。
  // 旧口径 COUNT(bond_unified WHERE status='listed') = 433、甚至含 731 只已退市老债与 46 只定向/私募，
  // 与列表（同期 307）对不上；而列表必须排除行情源给已摘牌债返回的冻结行（成交量 0），
  // 所以只数只能从当日行情分区派生，不能直接从主档表数。回填脚本不传分区日期，会按
  // partition_key_required 跳过，不会再用旧口径写出一个虚高数字。
  bond_master: {
    scopeKey: 'CN',
    table: 'public.bond_unified',
    partitionedCountSql: `SELECT COUNT(DISTINCT m.instrument_id)::int AS row_count
        FROM market.convertible_bond_daily_metrics m
        JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=m.instrument_id
        JOIN core.instruments b ON b.instrument_id=m.instrument_id
        JOIN public.bond_unified u ON u.instrument_id=m.instrument_id
       WHERE m.trade_date=$1::date
         AND u.status='listed'
         AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
         AND (b.list_date IS NULL OR b.list_date <= $1::date)
         AND (b.delist_date IS NULL OR b.delist_date > $1::date)
         AND (p.maturity_date IS NULL OR p.maturity_date >= $1::date)
         AND (p.conv_end_date IS NULL OR p.conv_end_date >= $1::date)
         AND (u.conv_stop_date IS NULL OR u.conv_stop_date > $1::date)
         AND (p.maturity_date IS NOT NULL OR p.conv_end_date IS NOT NULL OR b.delist_date IS NOT NULL)`,
    partitionedDataAsOfSql: 'SELECT $1::text AS data_as_of',
  },
  bond_daily: { scopeKey: 'CN', table: 'market.convertible_bond_daily_metrics', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  stock_daily: { scopeKey: 'CN', table: 'market.daily_bars', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  // 收盘任务亲自核验并落库的日终收盘价（证券级证据）：只登记「本任务核验通过的证券只数」，
  // 与全市场 stock_daily 分区语义不同，互不顶替。两市场各自一个数据集，港股不得借用 A 股分区。
  position_close_bars_cn: {
    scopeKey: 'CN', table: 'market.daily_bars',
    partitionedCountSql: `SELECT COUNT(*)::int AS row_count
        FROM market.daily_bars b JOIN core.instruments i ON i.instrument_id=b.instrument_id
       WHERE b.trade_date=$1::date AND i.market='CN'
         AND b.bar_status='terminal' AND b.price_adjust='none' AND b.quality_status='passed'`,
    partitionedDataAsOfSql: 'SELECT $1::text AS data_as_of',
  },
  position_close_bars_hk: {
    scopeKey: 'HK', table: 'market.daily_bars',
    partitionedCountSql: `SELECT COUNT(*)::int AS row_count
        FROM market.daily_bars b JOIN core.instruments i ON i.instrument_id=b.instrument_id
       WHERE b.trade_date=$1::date AND i.market='HK'
         AND b.bar_status='terminal' AND b.price_adjust='none' AND b.quality_status='passed'`,
    partitionedDataAsOfSql: 'SELECT $1::text AS data_as_of',
  },
  stock_valuation: { scopeKey: 'CN', table: 'market.daily_valuations', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  stock_adj_factor: { scopeKey: 'CN', table: 'market.adjustment_factors', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  stock_financial_reports: { scopeKey: 'CN', table: 'fundamental.financial_reports', whereSql: "WHERE report_type='1' AND is_current_version=true", countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: "SELECT MAX(COALESCE(f_ann_date,announced_at,period_end))::text AS data_as_of" },
  stock_suspend_calendar: { scopeKey: 'CN', table: 'market.stock_suspend_calendar', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  bond_redemption_events: { scopeKey: 'CN', table: 'event.convertible_bond_call_events', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(announced_at)::text AS data_as_of' },
  bond_issuance_events: { scopeKey: 'CN', table: 'event.instrument_events', whereSql: "WHERE event_type IN ('issue_announcement','shareholder_record','online_subscription','result_announcement','listing')", countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(source_updated_at)::date::text AS data_as_of' },
  bond_listing_liquidity: { scopeKey: 'CN', table: 'analytics.convertible_bond_listing_liquidity', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(updated_at)::date::text AS data_as_of' },
  bond_motive_inputs: { scopeKey: 'CN', table: 'fundamental.convertible_bond_holder_positions', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(report_date)::text AS data_as_of' },
  bond_motive_scores: { scopeKey: 'CN', table: 'analytics.convertible_bond_revision_motive_daily', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  bond_announcement_facts: { scopeKey: 'CN', table: 'event.convertible_bond_revision_events', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(announced_at)::text AS data_as_of' },
  market_volatility: { scopeKey: 'GLOBAL', table: 'market.market_valuation_daily', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  ipo_history: { scopeKey: 'GLOBAL', table: 'public.ipo_history', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT MAX(CASE WHEN updated_at::text ~ '^\\d{4}-\\d{2}-\\d{2}' THEN updated_at::date END) AS data_as_of` },
  stock_analysis_snapshot: { scopeKey: 'CN', table: 'analytics.analysis_snapshots', whereSql: "WHERE snapshot_type='stock_analysis'", countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(as_of_date)::text AS data_as_of' },
  bond_analysis_snapshot: {scopeKey:'CN',table:'analytics.analysis_snapshots',whereSql:"WHERE snapshot_type='convertible_bond_analysis' AND formula_bundle_version='4'",countSql:'SELECT COUNT(*)::int AS row_count',dataAsOfSql:'SELECT MAX(as_of_date)::text AS data_as_of',
    partitionedCountSql:"SELECT COUNT(DISTINCT instrument_id)::int AS row_count FROM analytics.analysis_snapshots WHERE snapshot_type='convertible_bond_analysis' AND formula_bundle_version='4' AND as_of_date=$1::date",
    partitionedDataAsOfSql:"SELECT MAX(as_of_date)::text AS data_as_of FROM analytics.analysis_snapshots WHERE snapshot_type='convertible_bond_analysis' AND formula_bundle_version='4' AND as_of_date=$1::date"},
  bond_analysis_inputs: {scopeKey:'CN',snapshotSql:`SELECT (cursor_payload->>'count')::int AS row_count,last_success_date::text AS data_as_of
    FROM ops.sync_cursors WHERE scope_key='convertible_bond_analysis' AND dataset_code='inputs' AND last_error=''`},
  bond_safety_snapshot: { scopeKey: 'CN', snapshotSql: `SELECT row_count,COALESCE(source_updated_at,refreshed_at)::date::text AS data_as_of
    FROM bond_safety_snapshots WHERE publication_status='published' ORDER BY id DESC LIMIT 1`, table: 'bond_safety_snapshots' },
  // 转债每日估值快照：阶段 3 收敛后由 bond_analytics_refresh 统一发布；按交易日分区，供安全评分的上游依赖核对。
  bond_valuation: { scopeKey: 'CN', table: 'analytics.convertible_bond_valuation_daily',
    partitionedCountSql: 'SELECT COUNT(*)::int AS row_count FROM analytics.convertible_bond_valuation_daily WHERE trade_date=$1::date',
    partitionedDataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of FROM analytics.convertible_bond_valuation_daily WHERE trade_date=$1::date' },
  hk_trade_rules: { scopeKey: 'HK', table: 'market.instrument_trade_rules', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(valid_from)::text AS data_as_of' },
  hk_trade_calendar: { scopeKey: 'HK', table: 'market.trade_calendar', whereSql: "WHERE exchange='HKEX'", countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  hk_ipo_facts: { scopeKey: 'HK', table: 'public.ipo_history', whereSql: "WHERE market_code='HK'", countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT MAX(CASE WHEN updated_at::text ~ '^\\d{4}-\\d{2}-\\d{2}' THEN updated_at::date END) AS data_as_of` },
  hk_ipo_subscription_signals: {
    scopeKey: 'HK',
    table: 'analytics.hk_ipo_market_snapshots',
    partitionedCountSql: "SELECT COUNT(*)::int AS row_count FROM analytics.hk_ipo_market_snapshots WHERE signal_type='subscription' AND data_date=$1::date",
    partitionedDataAsOfSql: "SELECT MAX(data_date)::text AS data_as_of FROM analytics.hk_ipo_market_snapshots WHERE signal_type='subscription' AND data_date=$1::date",
  },
  arbitrage_cases: { scopeKey: 'GLOBAL', table: 'event.arbitrage_cases', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(announced_at)::text AS data_as_of' },
  trade_calendar: { scopeKey: 'GLOBAL', table: 'market.trade_calendar', whereSql: "WHERE exchange='SSE'", countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  // 投资策略选股中心（2026-11-02 方案第 9.2 节）：两市场各自分区，不合并成一个跨市场数据集。
  // snapshot 只统计"已正式发布"的季度组合席位；保存为部分数据预览时不产生可投资分区。
  stock_selection_snapshot_cn: {
    scopeKey: 'CN', table: 'analytics.stock_selection_portfolio_members',
    partitionedCountSql: `SELECT COUNT(*)::int AS row_count FROM analytics.stock_selection_portfolio_members m
        JOIN analytics.stock_selection_runs r ON r.run_id = m.run_id
       WHERE r.market = 'CN' AND r.run_kind = 'quarterly' AND r.as_of_date = $1::date AND r.published_at IS NOT NULL`,
    partitionedDataAsOfSql: 'SELECT $1::text AS data_as_of',
  },
  stock_selection_snapshot_hk: {
    scopeKey: 'HK', table: 'analytics.stock_selection_portfolio_members',
    partitionedCountSql: `SELECT COUNT(*)::int AS row_count FROM analytics.stock_selection_portfolio_members m
        JOIN analytics.stock_selection_runs r ON r.run_id = m.run_id
       WHERE r.market = 'HK' AND r.run_kind = 'quarterly' AND r.as_of_date = $1::date AND r.published_at IS NOT NULL`,
    partitionedDataAsOfSql: 'SELECT $1::text AS data_as_of',
  },
  // 选股输入：该市场目标日有标准估值与收盘价的普通股数量，用于缺口可查与质量判定。
  stock_selection_inputs_cn: {
    scopeKey: 'CN', table: 'market.daily_valuations',
    partitionedCountSql: `SELECT COUNT(DISTINCT v.instrument_id)::int AS row_count
        FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id = v.instrument_id
       WHERE i.market = 'CN' AND i.asset_class = 'stock' AND v.trade_date = $1::date AND v.pb IS NOT NULL`,
    partitionedDataAsOfSql: 'SELECT $1::text AS data_as_of',
  },
  stock_selection_inputs_hk: {
    scopeKey: 'HK', table: 'market.daily_valuations',
    partitionedCountSql: `SELECT COUNT(DISTINCT v.instrument_id)::int AS row_count
        FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id = v.instrument_id
       WHERE i.market = 'HK' AND i.asset_class = 'stock' AND v.trade_date = $1::date AND v.pb IS NOT NULL`,
    partitionedDataAsOfSql: 'SELECT $1::text AS data_as_of',
  },
  // V2 每日/每周/影子：渠道由数据集代码区分，底层仍是同一套 runs/members（方案 27.8）。
  // 计数取"该渠道该日生效的正式 revision"，不把多个 revision 的成员相加。
  stock_selection_daily_cn: selectionPeriodDataset('CN', 'daily', false),
  stock_selection_daily_hk: selectionPeriodDataset('HK', 'daily', false),
  stock_selection_weekly_cn: selectionPeriodDataset('CN', 'weekly', false),
  stock_selection_weekly_hk: selectionPeriodDataset('HK', 'weekly', false),
  stock_selection_shadow_cn: selectionPeriodDataset('CN', null, true),
  stock_selection_shadow_hk: selectionPeriodDataset('HK', null, true),
});

function dateValue(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = part => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const short = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(short) ? short : null;
}
// 这四个数据集按市场隔离：旧调用默认 CN，HK 必须显式传 market='HK' 且不得退回 CN。
// 只在显式 HK 时追加市场过滤，历史 CN 调用的统计与新鲜度口径保持不变。
const MARKET_SCOPED_DATASETS = new Set(['stock_daily','stock_valuation','stock_financial_reports','stock_analysis_snapshot']);
function marketPredicateFor(datasetCode, market) {
  if (!MARKET_SCOPED_DATASETS.has(datasetCode) || !['CN', 'HK'].includes(market)) return '';
  if (datasetCode !== 'stock_financial_reports' && market !== 'HK') return '';
  if (datasetCode === 'stock_financial_reports') {
    const codePredicate = market === 'HK'
      ? "upper(COALESCE(raw_payload->>'ts_code','')) LIKE '%.HK'"
      : "upper(COALESCE(raw_payload->>'ts_code','')) ~ '^[0-9]{6}[.](SH|SZ|BJ)$'";
    const companyMarket = `company_id IN (SELECT ci.company_id FROM core.company_instruments ci JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.market='${market}')`;
    return `(${companyMarket} AND ${codePredicate})`;
  }
  return `instrument_id IN (SELECT instrument_id FROM core.instruments WHERE market='${market}')`;
}
function resolveDatasetScope(datasetCode,context={}) {
  const definition=DATASET_PARTITION_REGISTRY[datasetCode];
  if(definition?.scopeType==='account') return typeof context.username==='string'&&context.username&&typeof context.accountName==='string'&&context.accountName
    ? 'account:'+encodeURIComponent(context.username)+':'+encodeURIComponent(context.accountName):null;
  if (MARKET_SCOPED_DATASETS.has(datasetCode) && String(context.market||'').toUpperCase()==='HK') return 'HK';
  return definition?.scopeKey||null;
}

async function readSnapshot(datasetCode, optionsOrExecutor = {}, maybeExecutor = null) {
  const options = typeof optionsOrExecutor === 'function' ? {} : optionsOrExecutor || {};
  const executor = typeof optionsOrExecutor === 'function' ? optionsOrExecutor : maybeExecutor || pool.query.bind(pool);
  const definition = DATASET_PARTITION_REGISTRY[datasetCode];
  if (!definition) return { published: false, reason: 'not_registered', datasetCode };
  if(definition.scopeType==='account') return {published:false,reason:'account_runner_evidence_required',datasetCode,scopeKey:resolveDatasetScope(datasetCode,options)};
  const scopeKey = resolveDatasetScope(datasetCode, options);
  const partitionKey = dateValue(options.partitionKey);
  if (definition.partitionedCountSql) {
    if (!partitionKey) return { published: false, datasetCode, scopeKey, reason: 'partition_key_required', rowCount: 0, dataAsOf: null };
    const countResult = await executor(definition.partitionedCountSql, [partitionKey]);
    const dateResult = await executor(definition.partitionedDataAsOfSql, [partitionKey]);
    return {
      published: false,
      datasetCode,
      scopeKey,
      rowCount: Number(countResult.rows[0]?.row_count || 0),
      dataAsOf: dateValue(dateResult.rows[0]?.data_as_of),
    };
  }
  if (definition.snapshotSql) {
    const result = await executor(definition.snapshotSql);
    const row = result.rows[0] || {};
    return { published: false, datasetCode, scopeKey, rowCount: Number(row.row_count || 0), dataAsOf: dateValue(row.data_as_of) };
  }
  const requestedMarket = String(options.market || (definition.scopeKey === 'CN' ? 'CN' : '')).toUpperCase();
  const marketWhere = marketPredicateFor(datasetCode, requestedMarket);
  const whereParts = [definition.whereSql || ''];
  if (marketWhere) whereParts.push(whereParts[0] ? `AND ${marketWhere}` : `WHERE ${marketWhere}`);
  const from = ` FROM ${definition.table} ${whereParts.join(' ')}`;
  const countResult = await executor(`${definition.countSql}${from}`);
  const dateResult = definition.dataAsOfStandaloneSql
    ? await executor(definition.dataAsOfStandaloneSql)
    : await executor(definition.dataAsOfSql + from);
  const rowCount = Number(countResult.rows[0]?.row_count || 0);
  const dataAsOf = dateValue(dateResult.rows[0]?.data_as_of);
  return { published: false, datasetCode, scopeKey, rowCount, dataAsOf };
}

async function publishDatasetSnapshot(datasetCode, options = {}, executor = pool.query.bind(pool)) {
  const requestedPartitionKey = dateValue(options.partitionKey);
  const snapshot = await readSnapshot(datasetCode, { ...options, partitionKey: requestedPartitionKey }, executor);
  const scopeKey = resolveDatasetScope(datasetCode, options) || snapshot.scopeKey;
  const dataAsOf = dateValue(options.dataAsOf) || snapshot.dataAsOf;
  const rowCount = Number.isFinite(Number(options.rowCount)) ? Number(options.rowCount) : snapshot.rowCount;
  const diagnostics = options.diagnostics || {};
  // 动态行情信号失败时只能保留上一份已落库事实，不能把旧快照再次发布成“本次成功”。
  // 这样页面仍可读取历史数据，但任务诊断不会被错误覆盖为完整。
  if (datasetCode === 'hk_ipo_subscription_signals' && diagnostics.query_status !== 'success') {
    return { ...snapshot, reason: 'dynamic_signal_degraded', diagnostics };
  }
  const allowEmpty = options.allowEmpty === true
    || ['verified_no_suspension', 'verified_no_change'].includes(diagnostics.coverage_status);
  if (!dataAsOf || (rowCount <= 0 && !allowEmpty)) return { ...snapshot, reason: 'empty_or_no_date' };
  const partitionKey = dateValue(options.partitionKey) || snapshot.dataAsOf;
  const published = await publishDatasetPartition(datasetCode, scopeKey, {
    partitionKey,
    dataAsOf,
    rowCount,
    sourceId: options.sourceId || null,
    diagnostics: {
      registry: true,
      table: DATASET_PARTITION_REGISTRY[datasetCode].table,
      reason: options.reason || 'snapshot',
      ...diagnostics,
    },
  }, executor);
  return { ...snapshot, scopeKey, dataAsOf, rowCount, published: Boolean(published), partitionKey };
}

// 允许"本阶段无发布对象"的任务/阶段白名单：目前只有回购利率在历史休市日会出现。
// 其他任务或阶段即使自报 skipDatasetPublication 也必须正常走发布门禁。
const SKIP_PUBLICATION_CONTRACT = Object.freeze({
  convertible_bond_universe_refresh: Object.freeze(['repo_daily']),
});

// 严格校验业务日：必须是真实存在的 YYYY-MM-DD（13 月、2 月 30 日、平年 2 月 29 日都不算）。
// 用月天数与闰年规则纯算术判断，不做时区换算，避免把非法日期当成"某个交易日"。
const MONTH_DAYS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
function strictBusinessDate(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const monthDays = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1];
  if (day > monthDays) return null;
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

// 独立核验业务日是否交易日：经 infrastructure 层的交易日历读取（同一份运行时休市日历）。
// 调用方必须先通过 strictBusinessDate；日历缺失或无法判断时按"交易日"处理，
// 宁可报错拒绝跳过，也不能在说不清的情况下放行。
function isTradingBusinessDate(date) {
  try {
    const { isTradingDate } = require('../db/tradingCalendar');
    return isTradingDate(date);
  } catch (error) {
    console.warn('[dataset-partition] 交易日判断失败，按交易日处理：' + (error && error.message));
    return true;
  }
}

async function publishJobDatasets(jobCode, businessDate, result) {
  const definition = getJobDefinition(jobCode);
  const declaredDatasets = definition.producesDatasets || [];
  const requestedDatasets = result && Array.isArray(result.publishDatasetCodes)
    ? result.publishDatasetCodes : declaredDatasets;
  const phaseMode = String(result && result.mode || 'core');
  // 本阶段确实没有可发布对象（例如回购利率落在历史休市日）时由 Runner 显式声明跳过。
  // 例外必须收窄：只允许登记过的任务+阶段，且业务日要在这里独立核验确实是休市日——
  // 不能只凭 Runner 自报，否则任何任务都能拿这个标记绕过发布门禁。
  // 同时必须提交空发布清单，防止"声明跳过却仍在真发布"。
  if (result && result.skipDatasetPublication === true) {
    const allowedPhases = SKIP_PUBLICATION_CONTRACT[jobCode] || [];
    if (!allowedPhases.includes(phaseMode)) {
      throw new Error(`${jobCode}/${phaseMode} 未登记可跳过发布，不能以 skipDatasetPublication 绕过发布门禁`);
    }
    // 必须显式提交空数组：省略字段或传非数组（字符串/对象/null）一律拒绝，
    // 不能把"没想清楚要发什么"当成"没有要发的东西"。
    if (!Array.isArray(result.publishDatasetCodes)) {
      throw new Error(`${jobCode}/${phaseMode} 跳过发布必须显式提交空发布清单（publishDatasetCodes: []）`);
    }
    if (result.publishDatasetCodes.length) {
      throw new Error(`${jobCode}/${phaseMode} 声明跳过发布却仍提交了发布清单`);
    }
    // 日期先严格校验真伪，再交给交易日历：非法日期不能借"休市"名义通过。
    const businessDay = strictBusinessDate(businessDate);
    if (!businessDay) {
      throw new Error(`${jobCode}/${phaseMode} 业务日无效（${businessDate}），不得跳过发布`);
    }
    if (isTradingBusinessDate(businessDay)) {
      throw new Error(`${jobCode}/${phaseMode} 业务日 ${businessDay} 是交易日，不得跳过发布`);
    }
    return [];
  }
  const phaseContract = definition.datasetPublicationByMode
    ? definition.datasetPublicationByMode[phaseMode] : null;
  if (definition.strictDatasetPublication && definition.datasetPublicationByMode && !phaseContract) {
    throw new Error(`${jobCode} 未声明 ${phaseMode} 阶段的数据集发布契约`);
  }
  if (phaseContract) {
    const expected = phaseContract.publish || [];
    const optional = phaseContract.optionalPublish || [];
    if (new Set(requestedDatasets).size !== requestedDatasets.length || expected.some(code => !requestedDatasets.includes(code)) || requestedDatasets.some(code => !expected.includes(code) && !optional.includes(code))) {
      throw new Error(`${jobCode}/${phaseMode} 实际发布数据集与阶段契约不一致`);
    }
    if (result && result.ok === false) return [];
    if (result && result.continuationRequired === true) return [];
    if (phaseContract.requireStageComplete === true && result.stageComplete !== true) {
      throw new Error(`${jobCode}/${phaseMode} 阶段仍有未完成对象或子阶段`);
    }
    if (expected.length === 0) {
      if (!(await areDatasetPartitionsPublished(phaseContract.requirePublished || [], businessDate,result))) {
        throw new Error(`${jobCode}/${phaseMode} 所依赖的数据集分区未发布或质量未通过`);
      }
      return [];
    }
  }
  const datasets = requestedDatasets.filter(code => DATASET_PARTITION_REGISTRY[code]);
  if (result && result.ok === false) return [];
  // partial 仅表示本批有后续阶段，不能被严格发布门禁当成最终成功；续批完成后再由末批发布/校验。
  if (result && result.continuationRequired === true) return [];
  if (result && result.publishDatasets === false) {
    if ((definition.strictDatasetPublication||phaseContract?.requireStageComplete) && !(await areJobDatasetsPublished(jobCode, businessDate, datasets,result))) {
      const noChange = datasets.length > 0 && datasets.every(code => {
        const diagnostics = result.datasetDiagnostics && result.datasetDiagnostics[code] || {};
        return diagnostics.coverage_status === 'verified_no_change' && diagnostics.query_status === 'success';
      });
      if (noChange) {
        await Promise.all(datasets.map(code => {
          const diagnostics = result.datasetDiagnostics[code] || {};
          return publishDatasetSnapshot(code, {
            partitionKey: businessDate,
            market: result.market,
            dataAsOf: result.dataAsOf || result.data_as_of,
            rowCount: diagnostics.valid_report_rows ?? diagnostics.partition_row_count,
            diagnostics,
            reason: `job:${jobCode}:verified_no_change`,
          });
        }));
      }
      if (!(await areJobDatasetsPublished(jobCode, businessDate, datasets,result))) {
        throw new Error(`${jobCode} 数据集分区未全部发布，不能标记任务完成`);
      }
    }
    return [];
  }
  const allDeclaredDatasetsRequested = requestedDatasets.length === declaredDatasets.length;
  if (definition.strictDatasetPublication && (!datasets.length
    || (allDeclaredDatasetsRequested && datasets.length !== declaredDatasets.length)
    || datasets.length !== requestedDatasets.length
    || requestedDatasets.some(code => !declaredDatasets.includes(code)))) {
    throw new Error(`${jobCode} 的 producesDatasets 存在未登记白名单，已拒绝发布`);
  }
  const results = await Promise.all(datasets.map(async datasetCode => {
    try {
      const diagnostics = result && result.datasetDiagnostics && result.datasetDiagnostics[datasetCode] || {};
      const publication = await publishDatasetSnapshot(datasetCode, {
        partitionKey: businessDate,
        market: result && result.market,
        dataAsOf: result && (result.dataAsOf || result.data_as_of),
        rowCount: diagnostics.partition_row_count,
        allowEmpty: diagnostics.coverage_status === 'verified_no_suspension',
        diagnostics,
        reason: `job:${jobCode}`,
      });
      if (definition.strictDatasetPublication && !publication.published) {
        throw new Error(`${datasetCode} 数据分区未发布：${publication.reason || 'unknown'}`);
      }
      return publication;
    } catch (error) {
      if (definition.strictDatasetPublication) throw error;
      console.warn(`[dataset-partition] ${datasetCode} 发布失败：${error.message}`);
      return { published: false, datasetCode, reason: 'publish_error', error: error.message };
    }
  }));
  if (definition.strictDatasetPublication && !(await areJobDatasetsPublished(jobCode, businessDate, datasets,result))) {
    throw new Error(`${jobCode} 数据集分区未全部发布，不能标记任务完成`);
  }
  if (phaseContract && !(await areDatasetPartitionsPublished(phaseContract.requirePublished || [], businessDate,result))) {
    throw new Error(`${jobCode}/${phaseMode} 所依赖的数据集分区未发布或质量未通过`);
  }
  return results;
}

/**
 * 数据集"已发布且质量通过"的唯一判据（F08）。
 *
 * 发布门禁、依赖判定、槽位恢复和告警恢复此前各写一套：槽位恢复接受"published + 非 stale +
 * quality 缺省"，告警恢复连 query_status 都不看，于是隔离分区 query_status='failed' 且没有
 * quality_status 时仍能被判成恢复。这里把判据收敛成一份，缺字段只在**该数据集本来就不写这条
 * 证据**时才不算失败，绝不用"没有字段"当"通过"。
 *
 * @param {object} row ops.dataset_partitions 行
 * @param {string} code 数据集代码
 * @param {{requireQuality?:boolean}} [options] 强制要求 quality_status === 'passed'
 */
const STRICT_QUALITY_DATASETS = new Set([
  'ipo_history', 'hk_ipo_facts', 'bond_redemption_events', 'bond_listing_liquidity',
  'account_cash_income', 'repo_daily_rates', 'stock_cash_dividend_facts', 'stock_swap_settlements',
]);
const ACCEPTED_QUERY_STATUS = new Set(['success', 'passed', 'verified']);

function isPublishedDatasetEvidence(row, code, options = {}) {
  if (!row || row.status !== 'published' || row.is_stale) return false;
  const diagnostics = row.diagnostics && typeof row.diagnostics === 'object' ? row.diagnostics : {};
  const requireQuality = options.requireQuality === true || STRICT_QUALITY_DATASETS.has(String(code || ''));
  // qualityStatus 允许调用方按维度（例如共享分区的品种）给出结论：
  // 整行 quality_status 是多维度合并结果，不能代表某一个维度是否完整。
  const qualityStatus = options.qualityStatus !== undefined ? options.qualityStatus : diagnostics.quality_status;
  if (requireQuality && qualityStatus !== 'passed') return false;
  const query = diagnostics.query_status;
  // 明确写了"没查成"就不是恢复证据；字段缺省只说明该数据集不上报这条，不等于通过也不等于失败。
  if (query !== undefined && query !== null && String(query).trim() !== ''
    && !ACCEPTED_QUERY_STATUS.has(String(query))) return false;
  return true;
}

/**
 * 读取一批数据集的已发布证据（B1-2 前置就绪检查的唯一入口）：
 * 返回逐数据集状态与**精确缺失清单**，供日/周选股槽在计算前给出"还缺哪个分区"，
 * 不再只拿一个布尔值去猜。判据仍是 isPublishedDatasetEvidence 这一份。
 */
async function readDatasetPartitions(datasetCodes, businessDate, context = {}) {
  const requested = Array.isArray(datasetCodes) ? [...new Set(datasetCodes.map(String))] : [];
  const datasets = requested.filter(code => DATASET_PARTITION_REGISTRY[code]);
  const partitionKey = dateValue(businessDate);
  const empty = {
    partitionKey,
    rows: [],
    byCodeAndScope: new Map(),
    missingCodes: requested.slice(),
    unregisteredCodes: requested.filter(code => !DATASET_PARTITION_REGISTRY[code]),
    evidence: [],
  };
  if (!requested.length) return { ...empty, missingCodes: [], unregisteredCodes: [] };
  if (!partitionKey || datasets.length !== requested.length) return empty;
  const scopes = datasets.map(code => resolveDatasetScope(code, context));
  if (scopes.some(scope => !scope)) return empty;
  const { rows } = await pool.query(
    `SELECT dataset_code,scope_key,status,is_stale,diagnostics
       FROM ops.dataset_partitions
      WHERE dataset_code=ANY($1::text[]) AND scope_key=ANY($2::text[]) AND partition_key=$3::date`,
    [datasets, scopes, partitionKey]
  );
  const byCodeAndScope = new Map(rows.map(row => [`${row.dataset_code}:${row.scope_key}`, row]));
  const evidence = datasets.map((code, index) => {
    const scopeKey = scopes[index];
    const row = byCodeAndScope.get(`${code}:${scopeKey}`) || null;
    return {
      datasetCode: code,
      scopeKey,
      partitionKey,
      published: isPublishedDatasetEvidence(row, code),
      row,
    };
  });
  return {
    partitionKey,
    rows,
    byCodeAndScope,
    missingCodes: evidence.filter(item => !item.published).map(item => item.datasetCode),
    unregisteredCodes: requested.filter(code => !DATASET_PARTITION_REGISTRY[code]),
    evidence,
  };
}

async function areDatasetPartitionsPublished(datasetCodes, businessDate,context={}) {
  const datasets = datasetCodes.filter(code => DATASET_PARTITION_REGISTRY[code]);
  if (datasets.length !== datasetCodes.length) return false;
  if (!datasets.length) return true;
  const result = await readDatasetPartitions(datasets, businessDate, context);
  return Boolean(result.partitionKey) && result.missingCodes.length === 0;
}

async function areJobDatasetsPublished(jobCode, businessDate, requestedDatasets = null,context={}) {
  const definition = getJobDefinition(jobCode);
  const declaredDatasets = definition.producesDatasets || [];
  const datasetCodes = Array.isArray(requestedDatasets) ? requestedDatasets : declaredDatasets;
  const datasets = datasetCodes.filter(code => DATASET_PARTITION_REGISTRY[code]);
  // 严格任务的声明必须全部落在注册表中；过滤为空时必须失败关闭，不能把“没有检查对象”当成已完成。
  if (definition.strictDatasetPublication && (!datasets.length || datasets.length !== datasetCodes.length)) return false;
  return areDatasetPartitionsPublished(datasets, businessDate,context);
}

module.exports = { DATASET_PARTITION_REGISTRY, MARKET_SCOPED_DATASETS, marketPredicateFor, readSnapshot, readDatasetPartitions, publishDatasetSnapshot, publishJobDatasets, areJobDatasetsPublished,resolveDatasetScope, isPublishedDatasetEvidence, STRICT_QUALITY_DATASETS };
