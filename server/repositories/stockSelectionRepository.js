// 投资策略选股中心：批量仓储（方案第 9.1、10 节）。
// 只做批量 SQL 与库内版本优选；禁止逐股多轮查询，也不在这里做业务判断。
// 事实仍读 core/market/fundamental 原表，本文件的写操作只落 analytics.stock_selection_* 产物与 users 设置。
'use strict';

const { pool } = require('../db/connection');

function executorOf(tx) {
  if (!tx) return (sql, params) => pool.query(sql, params);
  return (sql, params) => tx.query(sql, params);
}

const MARKET_CONFIG = Object.freeze({
  CN: {
    exchanges: ['SSE', 'SZSE', 'BSE', 'SH', 'SZ', 'BJ'],
    calendarExchanges: ['SSE'],
    indexCodes: ['000985', 'CSIALL'],
    benchmarkCode: 'CSIALL',
    industryTaxonomies: ['SW2021'],
    industrySystem: 'SW2021',
    currency: 'CNY',
  },
  HK: {
    exchanges: ['HKEX'],
    calendarExchanges: ['HKEX'],
    indexCodes: ['HSI'],
    benchmarkCode: 'HSI',
    industryTaxonomies: ['HSICS', 'HSI', 'SW2021'],
    industrySystem: 'HSICS',
    currency: 'HKD',
  },
});

// 风险名称：目标日已知的 ST/*ST、退市整理与明确退市风险。停牌另由停牌表判定。
const RISK_NAME_SQL = `(i.name ~ '(^|\\s|\\*)ST' OR i.name LIKE '%退市%' OR i.name LIKE '%退' OR i.name ~* '(delist|suspended)')`;

function marketConfig(market) {
  const config = MARKET_CONFIG[String(market || '').toUpperCase()];
  if (!config) {
    const error = new Error('市场参数不合法');
    error.status = 400;
    throw error;
  }
  return config;
}

/** 目标日股票池 + 当日估值/收盘价/停牌/公司关联，单次批量取数。 */
async function loadUniverse({ market, asOfDate }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT i.instrument_id, i.canonical_code AS code, i.name, i.market, i.currency_code,
           i.exchange_code, i.list_date::text AS list_date, i.delist_date::text AS delist_date,
           ${RISK_NAME_SQL} AS risk_warning,
           ci.company_id,
           v.pb, v.pe_static, v.pe_ttm, v.dividend_yield_ttm, v.total_market_cap, v.currency_code AS valuation_currency,
           b.close AS price, b.trade_date::text AS price_date,
           s.suspend_type
      FROM core.instruments i
      LEFT JOIN LATERAL (
        SELECT c.company_id FROM core.company_instruments c
         WHERE c.instrument_id = i.instrument_id AND c.relation_type = 'issued_by'
           AND (c.valid_from IS NULL OR c.valid_from <= $2::date)
           AND (c.valid_to IS NULL OR c.valid_to >= $2::date)
         ORDER BY c.valid_from DESC NULLS LAST LIMIT 1
      ) ci ON true
      LEFT JOIN LATERAL (
        SELECT dv.pb, dv.pe_static, dv.pe_ttm, dv.dividend_yield_ttm, dv.total_market_cap, dv.currency_code
          FROM market.daily_valuations dv
         WHERE dv.instrument_id = i.instrument_id AND dv.trade_date = $2::date
         ORDER BY dv.source_id DESC LIMIT 1
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT bb.close, bb.trade_date FROM market.daily_bars bb
         WHERE bb.instrument_id = i.instrument_id AND bb.trade_date = $2::date
         LIMIT 1
      ) b ON true
      LEFT JOIN LATERAL (
        SELECT sc.suspend_type FROM market.stock_suspend_calendar sc
         WHERE sc.instrument_id = i.instrument_id AND sc.trade_date = $2::date LIMIT 1
      ) s ON true
     WHERE i.asset_class = 'stock'
       AND i.market = $1
       AND i.exchange_code = ANY($3::text[])
       AND (i.list_date IS NULL OR i.list_date <= $2::date)
       AND (i.delist_date IS NULL OR i.delist_date > $2::date)
     ORDER BY i.canonical_code`, [market, asOfDate, config.exchanges]);
  return rows;
}

/**
 * 十年 PB 证据：按"上市后应有交易日"逐日核验，不看覆盖率阈值（SSV-09）。
 * - 应有日：本地市场交易日历在窗口内的开市日，且晚于该证券上市日（上市前空白不算缺口）；
 * - 有效日：当天有同口径有效 PB（>0），同一天多来源时按官方优先择一，不跨来源拼值；
 * - gapDays = 应有日 − 有效日：>0 说明未覆盖区间可能藏有 PB>1 正证，只能待补。
 * 日历为空时 gapDays 返回 null（未知），绝不当作"无缺口"。
 */
async function loadPbWindow({ market, windowStart, asOfDate }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const detail = await exec(`
    WITH cal AS (
      SELECT trade_date FROM market.trade_calendar
       WHERE exchange = ANY($3::text[]) AND COALESCE(is_open, true) = true
         AND trade_date > $1::date AND trade_date <= $2::date
    ),
    inst AS (
      SELECT instrument_id, COALESCE(list_date, DATE '1900-01-01') AS list_date
        FROM core.instruments
       WHERE market = $4 AND asset_class = 'stock'
    ),
    expect AS (
      SELECT i.instrument_id, COUNT(c.trade_date)::int AS expected_days
        FROM inst i JOIN cal c ON c.trade_date > i.list_date
       GROUP BY 1
    ),
    covered AS (
      SELECT picked.instrument_id,
             MAX(picked.pb) AS max_pb,
             COUNT(*)::int AS covered_days
        FROM (
          SELECT DISTINCT ON (v.instrument_id, v.trade_date) v.instrument_id, v.trade_date, v.pb
            FROM market.daily_valuations v
            JOIN inst i2 ON i2.instrument_id = v.instrument_id
            JOIN cal c2 ON c2.trade_date = v.trade_date
            LEFT JOIN ops.data_sources s ON s.source_id = v.source_id
           WHERE v.trade_date > $1::date AND v.trade_date <= $2::date
             AND v.pb IS NOT NULL AND v.pb > 0
           ORDER BY v.instrument_id, v.trade_date,
                    CASE WHEN s.source_code LIKE 'lixinger%' THEN 0 ELSE 1 END, v.source_id
        ) picked
       GROUP BY 1
    )
    SELECT e.instrument_id, e.expected_days,
           COALESCE(c.covered_days, 0)::int AS covered_days,
           c.max_pb
      FROM expect e
      LEFT JOIN covered c USING (instrument_id)`,
  [windowStart, asOfDate, config.calendarExchanges, market]);
  const marketDays = await exec(`
      SELECT COUNT(DISTINCT v.trade_date)::int AS market_days
        FROM market.daily_valuations v
        JOIN core.instruments i ON i.instrument_id = v.instrument_id
       WHERE i.market = $1 AND v.trade_date > $2::date AND v.trade_date <= $3::date`, [market, windowStart, asOfDate]);
  const calendarDays = await exec(`
      SELECT COUNT(*)::int AS calendar_days
        FROM market.trade_calendar
       WHERE exchange = ANY($1::text[]) AND trade_date > $2::date AND trade_date <= $3::date
         AND COALESCE(is_open, true) = true`,
  [config.calendarExchanges, windowStart, asOfDate]);
  const calendarCount = Number((calendarDays.rows[0] || {}).calendar_days || 0);
  const byInstrument = new Map();
  detail.rows.forEach(row => {
    const expectedDays = Number(row.expected_days || 0);
    const coveredDays = Number(row.covered_days || 0);
    byInstrument.set(String(row.instrument_id), {
      maxPb: row.max_pb === null ? null : Number(row.max_pb),
      coveredDays,
      expectedDays,
      // 日历缺档时缺口未知；否则缺口 = 应有 − 已覆盖（covered 已限制在日历内，不会为负）。
      gapDays: calendarCount === 0 ? null : Math.max(expectedDays - coveredDays, 0),
    });
  });
  return {
    byInstrument,
    marketDays: Number((marketDays.rows[0] || {}).market_days || 0),
    calendarDays: calendarCount,
  };
}

/** 最新可见归母权益（按公告日严格早于目标日，目录日期不当作公告日）。 */
async function loadEquityFacts({ companyIds, asOfDate, availableBefore }, tx) {
  if (!companyIds.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT DISTINCT ON (r.company_id)
           r.company_id, r.report_id, r.period_end::text AS period_end, r.announced_at::text AS announced_at,
           r.available_at, r.availability_basis, r.source_version,
           f.numeric_value, f.currency_code
      FROM fundamental.financial_reports r
      JOIN fundamental.financial_facts f ON f.report_id = r.report_id AND f.metric_code = 'equity_parent'
     WHERE r.company_id = ANY($1::bigint[])
       AND r.statement_scope = 'consolidated'
       AND r.announced_at IS NOT NULL
       AND r.announced_at < $2::date
       AND ($3::timestamptz IS NULL OR r.available_at IS NULL OR r.available_at < $3::timestamptz)
     ORDER BY r.company_id, r.period_end DESC, r.announced_at DESC, r.report_id DESC`, [companyIds, asOfDate, availableBefore || null]);
  return new Map(rows.map(row => [String(row.company_id), {
    reportId: row.report_id,
    amount: row.numeric_value === null ? null : Number(row.numeric_value),
    currency: row.currency_code || null,
    periodEnd: row.period_end,
    announcedAt: row.announced_at,
    availableAt: row.available_at,
    availabilityBasis: row.availability_basis,
    sourceVersion: row.source_version,
  }]));
}

/** 年度归母利润（只取年报口径），同一财年取最新公告版本。 */
async function loadAnnualProfits({ companyIds, asOfDate, availableBefore }, tx) {
  if (!companyIds.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT DISTINCT ON (r.company_id, date_part('year', r.period_end))
           r.company_id,
           date_part('year', r.period_end)::int AS fiscal_year,
           r.period_end::text AS period_end,
           f.numeric_value, f.currency_code
      FROM fundamental.financial_reports r
      JOIN fundamental.financial_facts f ON f.report_id = r.report_id AND f.metric_code = 'net_profit_parent'
     WHERE r.company_id = ANY($1::bigint[])
       AND r.report_kind = 'income'
       AND r.period_type = 'annual'
       AND r.statement_scope = 'consolidated'
       AND r.announced_at IS NOT NULL
       AND r.announced_at < $2::date
       AND ($3::timestamptz IS NULL OR r.available_at IS NULL OR r.available_at < $3::timestamptz)
     ORDER BY r.company_id, date_part('year', r.period_end), r.period_end DESC, r.announced_at DESC, r.report_id DESC`,
  [companyIds, asOfDate, availableBefore || null]);
  const map = new Map();
  rows.forEach(row => {
    const key = String(row.company_id);
    const list = map.get(key) || [];
    list.push({
      year: Number(row.fiscal_year),
      periodEnd: row.period_end,
      profit: row.numeric_value === null ? null : Number(row.numeric_value),
      currency: row.currency_code || null,
    });
    map.set(key, list);
  });
  return map;
}

/** T 前十二个月按除息日计入的现金股息（每股，税前），并检测送转拆合导致的股份单位变化。 */
async function loadDividendWindow({ instrumentIds, windowStart, asOfDate }, tx) {
  if (!instrumentIds.length) return new Map();
  const exec = executorOf(tx);
  const cash = await exec(`
      SELECT ca.instrument_id,
             SUM(ca.cash_per_share_pre_tax) FILTER (WHERE ca.cash_per_share_pre_tax > 0) AS per_share,
             COUNT(*) FILTER (WHERE ca.cash_per_share_pre_tax > 0)::int AS cash_count,
             MAX(ca.currency_code) AS currency,
             SUM(ca.total_cash_amount) FILTER (WHERE ca.total_cash_amount > 0) AS total_cash
        FROM fundamental.corporate_actions ca
       WHERE ca.instrument_id = ANY($1::bigint[])
         AND ca.action_type = 'dividend'
         AND ca.status = '实施'
         AND ca.ex_date IS NOT NULL
         AND ca.ex_date > $2::date AND ca.ex_date <= $3::date
       GROUP BY 1`, [instrumentIds, windowStart, asOfDate]);
  const shareChanges = await exec(`
      SELECT ca.instrument_id, COUNT(*)::int AS cnt
        FROM fundamental.corporate_actions ca
       WHERE ca.instrument_id = ANY($1::bigint[])
         AND ca.status = '实施'
         AND ca.ex_date IS NOT NULL
         AND ca.ex_date > $2::date AND ca.ex_date <= $3::date
         AND (COALESCE(ca.stock_dividend_ratio, 0) > 0 OR COALESCE(ca.capitalization_ratio, 0) > 0)
       GROUP BY 1`, [instrumentIds, windowStart, asOfDate]);
  const shareChangeById = new Map(shareChanges.rows.map(row => [String(row.instrument_id), Number(row.cnt)]));
  return new Map(cash.rows.map(row => [String(row.instrument_id), {
    ttmPerShare: row.per_share === null ? null : Number(row.per_share),
    count: Number(row.cash_count || 0),
    currency: row.currency || null,
    totalCash: row.total_cash === null ? null : Number(row.total_cash),
    // 区间内发生送转/拆合股时，历史每股金额未统一到 T 股份单位 → 标待核验，不直接算股息率。
    shareUnitUnverified: (shareChangeById.get(String(row.instrument_id)) || 0) > 0,
  }]));
}

/** 按公司财年汇总的现金分红（A/H 同一发行人按经济事件去重），只认目标日当时可见的事实（SSV-04）。
 *  - 可见性：公告日严格早于目标日；公告日缺失但除息日已发生（除息必然在公告之后）视为可见；
 *  - 金额只统计目标日之前已除息且状态为"实施"的现金，后续状态变化不会回灌旧季度；
 *  - 每年同时返回"是否有任何分红记录"，供上层区分"确实零分红"与"没有采集到"，未知不补 0。
 */
async function loadAnnualDividends({ companyIds, asOfDate }, tx) {
  if (!companyIds.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    WITH per_instrument AS (
      SELECT ci.company_id,
             date_part('year', ca.fiscal_period_end)::int AS fiscal_year,
             ci.instrument_id,
             SUM(CASE WHEN ca.status = '实施' AND ca.ex_date IS NOT NULL AND ca.ex_date <= $2::date
                      THEN COALESCE(ca.total_cash_amount, 0) ELSE 0 END) AS implemented_cash,
             COUNT(*)::int AS event_count
        FROM fundamental.corporate_actions ca
        JOIN core.company_instruments ci ON ci.instrument_id = ca.instrument_id AND ci.relation_type = 'issued_by'
       WHERE ci.company_id = ANY($1::bigint[])
         AND ca.action_type = 'dividend'
         AND ca.fiscal_period_end IS NOT NULL
         AND (
           (ca.announced_at IS NOT NULL AND ca.announced_at < $2::date)
           OR (ca.announced_at IS NULL AND ca.ex_date IS NOT NULL AND ca.ex_date <= $2::date)
         )
       GROUP BY 1, 2, 3
    )
    SELECT company_id, fiscal_year,
           MAX(implemented_cash) AS implemented_cash,
           SUM(event_count)::int AS event_count
      FROM per_instrument
     GROUP BY 1, 2`, [companyIds, asOfDate]);
  const map = new Map();
  rows.forEach(row => {
    const key = String(row.company_id);
    const list = map.get(key) || [];
    list.push({
      year: Number(row.fiscal_year),
      // 只有"实施"且已除息的记录才计入现金；其余状态记 0 但保留 event_count 作为"事实存在"证据。
      dividend: Number(row.implemented_cash || 0),
      eventCount: Number(row.event_count || 0),
      dividendKnown: Number(row.event_count || 0) > 0,
    });
    map.set(key, list);
  });
  return map;
}

/** 一级行业（时点有效），按市场分类体系取。缺分类不塞"其他"。
 *  公司归属记录在**最深**行业节点上（申万三级 / 恒生三级），所以一级要沿 parent 链回溯；
 *  归属直接落在一级时本身即命中。 */
async function loadIndustries({ companyIds, market, asOfDate }, tx) {
  if (!companyIds.length) return new Map();
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    WITH RECURSIVE picked AS (
      SELECT DISTINCT ON (m.company_id, t.taxonomy_code)
             m.company_id, n.industry_node_id, n.parent_id, n.level, n.industry_code, n.industry_name,
             t.taxonomy_code, t.version, m.valid_from
        FROM core.company_industry_memberships m
        JOIN core.industry_nodes n ON n.industry_node_id = m.industry_node_id
        JOIN core.industry_taxonomies t ON t.taxonomy_id = n.taxonomy_id
       WHERE m.company_id = ANY($1::bigint[])
         AND t.taxonomy_code = ANY($2::text[])
         AND (m.valid_from IS NULL OR m.valid_from <= $3::date)
         AND (m.valid_to IS NULL OR m.valid_to >= $3::date)
       ORDER BY m.company_id, t.taxonomy_code, COALESCE(m.is_current, false) DESC, m.valid_from DESC NULLS LAST
    ), walk AS (
      SELECT company_id, industry_node_id, parent_id, level, industry_code, industry_name, taxonomy_code, version
        FROM picked
      UNION ALL
      SELECT w.company_id, parent.industry_node_id, parent.parent_id, parent.level,
             parent.industry_code, parent.industry_name, w.taxonomy_code, w.version
        FROM walk w
        JOIN core.industry_nodes parent ON parent.industry_node_id = w.parent_id
    )
    SELECT DISTINCT ON (company_id)
           company_id, industry_code, industry_name, taxonomy_code, version
      FROM walk
     WHERE level = 1
     ORDER BY company_id, array_position($2::text[], taxonomy_code)`,
  [companyIds, config.industryTaxonomies, asOfDate]);
  return new Map(rows.map(row => [String(row.company_id), {
    code: row.industry_code,
    name: row.industry_name,
    system: row.taxonomy_code,
    version: row.version || null,
  }]));
}

/** 报告期末当日已存在的历史汇率（逐币种逐日期批量取），无当日报价取此前最近有效日并记录实际日期。 */
async function loadFxRatesForPairs({ pairs }, tx) {
  const list = (pairs || []).filter(pair => pair && pair.currency && pair.currency !== 'CNY' && pair.date);
  if (!list.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    WITH need(base_currency, need_date) AS (
      SELECT * FROM unnest($1::text[], $2::date[])
    )
    SELECT DISTINCT ON (n.base_currency, n.need_date)
           n.base_currency, n.need_date::text AS need_date, f.rate, f.rate_date::text AS rate_date
      FROM need n
      JOIN market.fx_rates f
        ON f.base_currency = n.base_currency AND f.quote_currency = 'CNY' AND f.rate_date <= n.need_date
     ORDER BY n.base_currency, n.need_date, f.rate_date DESC`,
  [list.map(pair => String(pair.currency).toUpperCase()), list.map(pair => pair.date)]);
  return new Map(rows.map(row => [`${row.base_currency}|${row.need_date}`, {
    rate: Number(row.rate), date: row.rate_date,
  }]));
}

/** 市场估值代理：市值加权（mcw）口径，目标日精确取值。 */
async function loadMarketValuation({ market, asOfDate }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT index_code, valuation_method, trade_date::text AS trade_date, pb, pe_ttm, source_code
      FROM market.index_valuation_history
     WHERE index_code = ANY($1::text[])
       AND valuation_method = 'market_cap_weighted'
       AND trade_date = $2::date
     ORDER BY CASE WHEN source_code LIKE 'lixinger%' THEN 0 ELSE 1 END, index_code
     LIMIT 1`, [config.indexCodes, asOfDate]);
  const row = rows[0] || null;
  return {
    benchmarkCode: config.benchmarkCode,
    valuationMethod: 'market_cap_weighted',
    tradeDate: row ? row.trade_date : null,
    pb: row && row.pb !== null ? Number(row.pb) : null,
    pe: row && row.pe_ttm !== null ? Number(row.pe_ttm) : null,
    sourceCode: row ? row.source_code : null,
  };
}

/** 页面用：指数最近一条可用估值（只读库，不外采）。 */
async function loadLatestMarketValuation({ market }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT index_code, trade_date::text AS trade_date, pb, pe_ttm, source_code
      FROM market.index_valuation_history
     WHERE index_code = ANY($1::text[])
       AND valuation_method = 'market_cap_weighted'
     ORDER BY trade_date DESC, CASE WHEN source_code LIKE 'lixinger%' THEN 0 ELSE 1 END
     LIMIT 1`, [config.indexCodes]);
  const row = rows[0] || null;
  return {
    benchmarkCode: config.benchmarkCode,
    valuationMethod: 'market_cap_weighted',
    tradeDate: row ? row.trade_date : null,
    pb: row && row.pb !== null ? Number(row.pb) : null,
    pe: row && row.pe_ttm !== null ? Number(row.pe_ttm) : null,
    sourceCode: row ? row.source_code : null,
  };
}

/** 目标日所在市场交易日历区间（只取开市日），用于季度末与下一交易日推导。 */
async function loadCalendar({ market, fromDate, toDate }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT trade_date::text AS trade_date
      FROM market.trade_calendar
     WHERE exchange = ANY($1::text[]) AND trade_date >= $2::date AND trade_date <= $3::date
       AND COALESCE(is_open, true) = true
     ORDER BY trade_date`, [config.calendarExchanges, fromDate, toDate]);
  return rows.map(row => row.trade_date);
}

/** 交易日未复权开盘价，用于回测执行价。 */
async function loadOpenPrices({ instrumentIds, dates }, tx) {
  if (!instrumentIds.length || !dates.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT instrument_id, trade_date::text AS trade_date, open
      FROM market.daily_bars
     WHERE instrument_id = ANY($1::bigint[]) AND trade_date = ANY($2::date[])`, [instrumentIds, dates]);
  const map = new Map();
  rows.forEach(row => map.set(`${row.instrument_id}|${row.trade_date}`, row.open === null ? null : Number(row.open)));
  return map;
}

async function loadBenchmarkCloses({ indexCode, fromDate, toDate }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT trade_date::text AS trade_date, close
      FROM market.index_valuation_history
     WHERE index_code = $1 AND trade_date >= $2::date AND trade_date <= $3::date
     ORDER BY trade_date`, [indexCode, fromDate, toDate]);
  return new Map(rows.map(row => [row.trade_date, row.close === null ? null : Number(row.close)]));
}

/** 持有期内的现金分红（每股税前 × 除息日），用于回测现金收益，避免重复加股息。 */
async function loadDividendCash({ instrumentIds, fromDate, toDate }, tx) {
  if (!instrumentIds.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT instrument_id, SUM(cash_per_share_pre_tax) AS per_share
      FROM fundamental.corporate_actions
     WHERE instrument_id = ANY($1::bigint[])
       AND action_type = 'dividend'
       AND status = '实施'
       AND ex_date IS NOT NULL
       AND ex_date > $2::date AND ex_date <= $3::date
       AND cash_per_share_pre_tax > 0
     GROUP BY 1`, [instrumentIds, fromDate, toDate]);
  return new Map(rows.map(row => [String(row.instrument_id), Number(row.per_share)]));
}

// ========== 写操作 ==========

async function upsertStrategy(tx, strategy) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    INSERT INTO analytics.stock_selection_strategies
      (strategy_code, market, version, formula_version, adapter_version, risk_version, industry_version, effective_from, parameters, content_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
    ON CONFLICT (strategy_code, market, version) DO UPDATE
      SET parameters = analytics.stock_selection_strategies.parameters
    RETURNING strategy_id, content_hash`, [
    strategy.strategyCode, strategy.market, strategy.version, strategy.formulaVersion,
    strategy.adapterVersion || null, strategy.riskVersion || null, strategy.industryVersion || null,
    strategy.effectiveFrom || null, JSON.stringify(strategy.parameters || {}), strategy.contentHash,
  ]);
  const row = rows[0];
  // 已使用版本不可原位改参：同版本但参数哈希不同直接失败，要求新建版本。
  if (row.content_hash !== strategy.contentHash) {
    const error = new Error('该策略版本已用不同参数发布，禁止原位改参，请新建版本');
    error.status = 409;
    throw error;
  }
  return row.strategy_id;
}

async function findRunByIdempotencyKey(tx, { strategyId, market, asOfDate, runKind, inputHash, ownerUsername }) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT run_id FROM analytics.stock_selection_runs
     WHERE strategy_id = $1 AND market = $2 AND as_of_date = $3::date AND run_kind = $4
       AND input_hash = $5 AND COALESCE(owner_username,'') = COALESCE($6,'')
     LIMIT 1`, [strategyId, market, asOfDate, runKind, inputHash, ownerUsername || null]);
  return rows[0] ? Number(rows[0].run_id) : null;
}

async function nextRevision(tx, { market, quarter, strategyId }) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT COALESCE(MAX(revision), 0)::int AS max_revision
      FROM analytics.stock_selection_runs
     WHERE market = $1 AND quarter = $2 AND strategy_id = $3 AND run_kind = 'quarterly'`,
  [market, quarter, strategyId]);
  return Number(rows[0].max_revision || 0) + 1;
}

async function insertRun(tx, run) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    INSERT INTO analytics.stock_selection_runs
      (strategy_id, market, run_kind, owner_username, quarter, as_of_date, knowledge_cutoff,
       execution_status, quality_status, business_status, input_hash, input_manifest,
       universe_count, pending_count, selected_count, market_pb, market_pe, benchmark_code,
       valuation_method, position_ratio, budget_ratio, revision, published_at, supersedes_run_id, request_id)
    VALUES ($1,$2,$3,$4,$5,$6::date,$7::timestamptz,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    RETURNING run_id`, [
    run.strategyId, run.market, run.runKind, run.ownerUsername || null, run.quarter || null,
    run.asOfDate, run.knowledgeCutoff, run.executionStatus, run.qualityStatus, run.businessStatus,
    run.inputHash, JSON.stringify(run.inputManifest || {}), run.universeCount, run.pendingCount,
    run.selectedCount, run.marketPb, run.marketPe, run.benchmarkCode, run.valuationMethod,
    run.positionRatio, run.budgetRatio, run.revision, run.publishedAt || null,
    run.supersedesRunId || null, run.requestId || null,
  ]);
  return Number(rows[0].run_id);
}

async function insertCandidates(tx, runId, candidates) {
  const exec = executorOf(tx);
  const chunkSize = 200;
  const insertColumns = [
    'run_id', 'instrument_id', 'company_id', 'code', 'name', 'industry_code', 'industry_name',
    'industry_system', 'industry_version', 'current_pb', 'historical_pb_max', 'current_pe',
    'profit_status', 'dividend_yield', 'equity_amount', 'equity_currency', 'equity_cny',
    'fx_rate', 'fx_date', 'pb_rank', 'pe_rank', 'dividend_rank', 'total_score', 'selection_order',
    'filter_status', 'data_quality_status', 'exclusion_reasons', 'detail',
  ];
  // 一次写入全部列：filter_status / data_quality_status 是 NOT NULL，必须与行同批落库。
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let p = 1;
    chunk.forEach(item => {
      values.push('(' + insertColumns.map((_, index) => {
        const position = `$${p++}`;
        if (index === insertColumns.length - 2 || index === insertColumns.length - 1) return `${position}::jsonb`;
        if (insertColumns[index] === 'fx_date') return `${position}::date`;
        return position;
      }).join(',') + ')');
      params.push(
        runId, item.instrumentId, item.companyId === undefined ? null : item.companyId, item.code, item.name || null,
        item.industry ? item.industry.code : null, item.industry ? item.industry.name : null,
        item.industry ? item.industry.system : null, item.industry ? item.industry.version : null,
        item.currentPb === undefined ? null : item.currentPb,
        item.historicalPbMax === undefined ? null : item.historicalPbMax,
        item.currentPe === undefined ? null : item.currentPe,
        item.profitStatus || 'unknown',
        item.dividendYield === undefined ? null : item.dividendYield,
        item.equityAmount === undefined ? null : item.equityAmount,
        item.equityCurrency || null,
        item.equityCny === undefined ? null : item.equityCny,
        item.fxRate === undefined ? null : item.fxRate,
        item.fxDate || null,
        item.pbRank === undefined ? null : item.pbRank,
        item.peRank === undefined ? null : item.peRank,
        item.dividendRank === undefined ? null : item.dividendRank,
        item.totalScore === undefined ? null : item.totalScore,
        item.selectionOrder === undefined ? null : item.selectionOrder,
        item.filterStatus, item.dataQualityStatus || 'partial',
        JSON.stringify(item.exclusionReasons || []),
        // 规则结果、原始事实副本与年度异常平铺保存，页面按 detail.rules / detail.annual 直接读取。
        JSON.stringify(Object.assign({}, item.detail || {}, {
          rules: item.rules || {},
          anomaly: item.anomaly || null,
          rankReady: item.rankReady !== false,
        })),
      );
    });
    await exec(`
      INSERT INTO analytics.stock_selection_candidates (${insertColumns.join(', ')})
      VALUES ${values.join(',')}
      ON CONFLICT (run_id, instrument_id) DO NOTHING`, params);
  }
}

async function insertMembers(tx, runId, members) {
  if (!members.length) return;
  const exec = executorOf(tx);
  const values = [];
  const params = [];
  let p = 1;
  members.forEach(member => {
    values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb)`);
    params.push(runId, member.instrumentId, member.slotNo, member.industry ? member.industry.code : null,
      member.industry ? member.industry.system : null, member.industry ? member.industry.version : null,
      member.weightInMarketBudget, member.weightInEquityTarget, !!member.issuerDuplicate,
      JSON.stringify({ selectionOrder: member.selectionOrder || null, code: member.code, name: member.name || null }));
  });
  await exec(`
    INSERT INTO analytics.stock_selection_portfolio_members
      (run_id, instrument_id, slot_no, industry_code, industry_system, industry_version,
       weight_in_market_budget, weight_in_equity_target, issuer_duplicate, detail)
    VALUES ${values.join(',')}
    ON CONFLICT (run_id, instrument_id) DO NOTHING`, params);
}

/** 正式发布：范围锁 + 前一版本比较，失败事务不留下半个组合。 */
async function publishRun(tx, runId, { market, quarter }) {
  const exec = executorOf(tx);
  await exec(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`stock_selection_publish:${market}:${quarter || 'none'}`]);
  const { rows } = await exec(`
    SELECT run_id, revision FROM analytics.stock_selection_runs
     WHERE market = $1 AND quarter = $2 AND run_kind = 'quarterly' AND published_at IS NOT NULL
     ORDER BY revision DESC LIMIT 1`, [market, quarter]);
  const current = rows[0] || null;
  const target = await exec(`SELECT revision FROM analytics.stock_selection_runs WHERE run_id = $1`, [runId]);
  const targetRevision = Number((target.rows[0] || {}).revision || 0);
  if (current && Number(current.revision) >= targetRevision && Number(current.run_id) !== runId) {
    const error = new Error('该季度已有更新版本，本次发布未通过前一版本比较');
    error.status = 409;
    throw error;
  }
  await exec(`UPDATE analytics.stock_selection_runs SET published_at = now(), execution_status = 'succeeded' WHERE run_id = $1`, [runId]);
  return { published: true, previousRunId: current ? Number(current.run_id) : null };
}

async function markRunFailure(tx, runId, { executionStatus, qualityStatus, businessStatus }) {
  const exec = executorOf(tx);
  await exec(`
    UPDATE analytics.stock_selection_runs
       SET execution_status = $2, quality_status = $3, business_status = $4
     WHERE run_id = $1`, [runId, executionStatus, qualityStatus, businessStatus]);
}

// ========== 读接口 ==========

async function listRuns({ market, quarter, kind, ownerUsername, limit, offset }, tx) {
  const exec = executorOf(tx);
  const conditions = [];
  const params = [];
  if (market) { params.push(market); conditions.push(`r.market = $${params.length}`); }
  if (quarter) { params.push(quarter); conditions.push(`r.quarter = $${params.length}`); }
  if (kind) { params.push(kind); conditions.push(`r.run_kind = $${params.length}`); }
  // 个人运行只有本人可见；正式与预览按登录可见。所有者一律走参数，不拼字符串。
  if (ownerUsername) { params.push(ownerUsername); conditions.push(`(r.run_kind <> 'personal' OR r.owner_username = $${params.length})`); }
  else conditions.push(`r.run_kind <> 'personal'`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const { rows } = await exec(`
    SELECT r.run_id, r.market, r.run_kind, r.quarter, r.as_of_date::text AS as_of_date, r.strategy_id,
           r.execution_status, r.quality_status, r.business_status, r.universe_count, r.pending_count,
           r.selected_count, r.market_pb, r.market_pe, r.revision, r.published_at, r.owner_username,
           r.position_ratio, r.budget_ratio, s.version AS strategy_version, COUNT(*) OVER () AS total
      FROM analytics.stock_selection_runs r
      JOIN analytics.stock_selection_strategies s ON s.strategy_id = r.strategy_id
      ${where}
     ORDER BY r.as_of_date DESC, r.run_id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

async function findRun(runId, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT r.*, r.as_of_date::text AS as_of_date_text, r.knowledge_cutoff::text AS knowledge_cutoff_text,
           s.version AS strategy_version, s.formula_version, s.parameters
      FROM analytics.stock_selection_runs r
      JOIN analytics.stock_selection_strategies s ON s.strategy_id = r.strategy_id
     WHERE r.run_id = $1`, [runId]);
  return rows[0] || null;
}

async function listCandidates({ runId, limit, offset, filterStatus, orderBy }, tx) {
  const exec = executorOf(tx);
  const params = [runId];
  let where = 'WHERE run_id = $1';
  if (filterStatus) { params.push(filterStatus); where += ` AND filter_status = $${params.length}`; }
  params.push(limit, offset);
  const order = orderBy === 'code' ? 'code ASC' : 'COALESCE(selection_order, 100000) ASC, code ASC';
  const { rows } = await exec(`
    SELECT instrument_id, code, name, industry_code, industry_name, industry_system, industry_version,
           current_pb, historical_pb_max, current_pe, profit_status, dividend_yield, equity_amount,
           equity_currency, equity_cny, fx_rate, fx_date::text AS fx_date, pb_rank, pe_rank, dividend_rank,
           total_score, selection_order, filter_status, data_quality_status, exclusion_reasons,
           COUNT(*) OVER () AS total
      FROM analytics.stock_selection_candidates
      ${where}
     ORDER BY ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

async function findCandidate({ runId, code }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT * FROM analytics.stock_selection_candidates WHERE run_id = $1 AND code = $2 LIMIT 1`, [runId, code]);
  return rows[0] || null;
}

async function listMembers(runId, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT m.slot_no, m.instrument_id, m.industry_code, m.industry_system, m.industry_version,
           m.weight_in_market_budget, m.weight_in_equity_target, m.issuer_duplicate,
           c.code, c.name, c.company_id, c.industry_name,
           c.current_pb, c.current_pe, c.dividend_yield, c.total_score
      FROM analytics.stock_selection_portfolio_members m
      JOIN analytics.stock_selection_candidates c ON c.run_id = m.run_id AND c.instrument_id = m.instrument_id
     WHERE m.run_id = $1
     ORDER BY m.slot_no`, [runId]);
  return rows;
}

async function readUserSettings(username, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT stock_selection_settings, stock_selection_settings_revision FROM users WHERE username = $1`, [username]);
  const row = rows[0];
  if (!row) return null;
  return {
    settings: row.stock_selection_settings || {},
    revision: Number(row.stock_selection_settings_revision || 0),
  };
}

async function saveUserSettings({ username, settings, expectedRevision }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    UPDATE users
       SET stock_selection_settings = $2::jsonb,
           stock_selection_settings_revision = stock_selection_settings_revision + 1
     WHERE username = $1 AND stock_selection_settings_revision = $3
     RETURNING stock_selection_settings_revision`, [username, JSON.stringify(settings), expectedRevision]);
  if (!rows.length) {
    const error = new Error('设置已被其他窗口修改，请刷新后重试');
    error.status = 409;
    throw error;
  }
  return { settings, revision: Number(rows[0].stock_selection_settings_revision) };
}

/** 选股输入缺口队列（可续跑）：复用 ops.sync_cursors，不另建事实表。 */
async function saveInputGapQueue({ market, payload }, tx) {
  const exec = executorOf(tx);
  const scope = `selection_inputs:${market}`;
  const { rows } = await exec(
    `SELECT cursor_id FROM ops.sync_cursors WHERE scope_key = $1 AND dataset_code = 'gap_queue' LIMIT 1`, [scope]);
  if (rows.length) {
    await exec(
      `UPDATE ops.sync_cursors SET cursor_payload = $2::jsonb, last_attempt_at = now(), updated_at = now() WHERE cursor_id = $1`,
      [rows[0].cursor_id, JSON.stringify(payload)]);
    return rows[0].cursor_id;
  }
  const inserted = await exec(
    `INSERT INTO ops.sync_cursors (scope_key, dataset_code, last_attempt_at, cursor_payload, last_error, retry_count, updated_at)
     VALUES ($1, 'gap_queue', now(), $2::jsonb, '', 0, now()) RETURNING cursor_id`,
    [scope, JSON.stringify(payload)]);
  return inserted.rows[0].cursor_id;
}

async function readInputGapQueue({ market }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(
    `SELECT cursor_payload, last_attempt_at FROM ops.sync_cursors
      WHERE scope_key = $1 AND dataset_code = 'gap_queue' LIMIT 1`, [`selection_inputs:${market}`]);
  return rows[0] || null;
}

async function insertBacktest(tx, backtest) {  const exec = executorOf(tx);
  const { rows } = await exec(`
    INSERT INTO analytics.stock_selection_backtests
      (market, strategy_id, start_date, end_date, currency, status, input_hash, execution_model_version,
       cost_version, benchmark_code, benchmark_return_type, parameters, metrics, diagnostics)
    VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)
    RETURNING backtest_id`, [
    backtest.market, backtest.strategyId, backtest.startDate, backtest.endDate, backtest.currency || 'LOCAL',
    backtest.status, backtest.inputHash, backtest.executionModelVersion, backtest.costVersion,
    backtest.benchmarkCode, backtest.benchmarkReturnType || 'price', JSON.stringify(backtest.parameters || {}),
    JSON.stringify(backtest.metrics || {}), JSON.stringify(backtest.diagnostics || {}),
  ]);
  return Number(rows[0].backtest_id);
}

async function insertBacktestPeriods(tx, backtestId, periods) {
  if (!periods.length) return;
  const exec = executorOf(tx);
  const chunkSize = 500;
  for (let i = 0; i < periods.length; i += chunkSize) {
    const chunk = periods.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let p = 1;
    chunk.forEach(row => {
      values.push(`($${p++},$${p++}::date,$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(backtestId, row.tradeDate, row.nav, row.cashWeight, row.turnover, row.fees,
        row.dividendIncome, row.benchmarkNav, row.unpricedCount || 0, row.runId || null);
    });
    await exec(`
      INSERT INTO analytics.stock_selection_backtest_periods
        (backtest_id, trade_date, nav, cash_weight, turnover, fees, dividend_income, benchmark_nav, unpriced_count, run_id)
      VALUES ${values.join(',')}
      ON CONFLICT (backtest_id, trade_date) DO NOTHING`, params);
  }
}

async function findBacktest(backtestId, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`SELECT * FROM analytics.stock_selection_backtests WHERE backtest_id = $1`, [backtestId]);
  return rows[0] || null;
}

async function listBacktests({ market, limit, offset }, tx) {
  const exec = executorOf(tx);
  const params = [];
  let where = '';
  if (market) { params.push(market); where = `WHERE market = $${params.length}`; }
  params.push(limit, offset);
  const { rows } = await exec(`
    SELECT backtest_id, market, start_date::text AS start_date, end_date::text AS end_date, currency, status,
           execution_model_version, cost_version, benchmark_code, benchmark_return_type,
           metrics, diagnostics, created_at, COUNT(*) OVER () AS total
      FROM analytics.stock_selection_backtests
      ${where}
     ORDER BY created_at DESC, backtest_id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

/** 上一份已发布季度组合的席位，用于计算本季度调入/调出。 */
async function previousPublishedMembers({ market, asOfDate, excludeRunId }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    WITH prev AS (
      SELECT run_id FROM analytics.stock_selection_runs
       WHERE market = $1 AND run_kind = 'quarterly' AND published_at IS NOT NULL
         AND as_of_date < $2::date AND run_id <> $3
       ORDER BY as_of_date DESC, revision DESC LIMIT 1
    )
    SELECT m.instrument_id, c.code, c.name, r.quarter, r.as_of_date::text AS as_of_date
      FROM analytics.stock_selection_portfolio_members m
      JOIN analytics.stock_selection_runs r ON r.run_id = m.run_id
      JOIN analytics.stock_selection_candidates c ON c.run_id = m.run_id AND c.instrument_id = m.instrument_id
     WHERE m.run_id = (SELECT run_id FROM prev)`, [market, asOfDate, excludeRunId]);
  return rows;
}

async function listBacktestPeriods({ backtestId, limit, offset }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT trade_date::text AS trade_date, nav, cash_weight, turnover, fees, dividend_income, benchmark_nav, unpriced_count,
           COUNT(*) OVER () AS total
      FROM analytics.stock_selection_backtest_periods
     WHERE backtest_id = $1
     ORDER BY trade_date
     LIMIT $2 OFFSET $3`, [backtestId, limit, offset]);
  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

async function latestPublishedRun({ market }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT run_id, quarter, as_of_date::text AS as_of_date, revision, selected_count, business_status,
           strategy_id, market_pb, market_pe, benchmark_code, valuation_method, input_manifest
      FROM analytics.stock_selection_runs
     WHERE market = $1 AND run_kind = 'quarterly' AND published_at IS NOT NULL
     ORDER BY as_of_date DESC, revision DESC LIMIT 1`, [market]);
  return rows[0] || null;
}

/** 个人测算复制源批次的候选快照（保留同一排名，不重新取数）。 */
async function copyCandidates({ sourceRunId, targetRunId }, tx) {
  const exec = executorOf(tx);
  await exec(`
    INSERT INTO analytics.stock_selection_candidates
      (run_id, instrument_id, company_id, code, name, industry_code, industry_name, industry_system, industry_version,
       current_pb, historical_pb_max, current_pe, profit_status, dividend_yield, equity_amount, equity_currency,
       equity_cny, fx_rate, fx_date, total_score, selection_order, filter_status, data_quality_status,
       exclusion_reasons, detail)
    SELECT $2, instrument_id, company_id, code, name, industry_code, industry_name, industry_system, industry_version,
           current_pb, historical_pb_max, current_pe, profit_status, dividend_yield, equity_amount, equity_currency,
           equity_cny, fx_rate, fx_date, total_score, selection_order, filter_status, data_quality_status,
           exclusion_reasons, detail
      FROM analytics.stock_selection_candidates
     WHERE run_id = $1
    ON CONFLICT (run_id, instrument_id) DO NOTHING`, [sourceRunId, targetRunId]);
}

module.exports = {
  MARKET_CONFIG,
  loadUniverse, loadPbWindow, loadEquityFacts, loadAnnualProfits, loadDividendWindow,
  loadAnnualDividends, loadIndustries, loadFxRatesForPairs, loadMarketValuation, loadLatestMarketValuation, loadCalendar,
  loadOpenPrices, loadBenchmarkCloses, loadDividendCash,
  upsertStrategy, findRunByIdempotencyKey, nextRevision, insertRun, insertCandidates, insertMembers,
  publishRun, markRunFailure,
  listRuns, findRun, listCandidates, findCandidate, listMembers, latestPublishedRun, copyCandidates,
  readUserSettings, saveUserSettings,
  saveInputGapQueue, readInputGapQueue,
  insertBacktest, insertBacktestPeriods, findBacktest, listBacktestPeriods, listBacktests, previousPublishedMembers,
};
