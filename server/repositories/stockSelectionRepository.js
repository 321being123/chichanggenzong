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
           v.pb,
           -- 官方估值接口不提供静态市盈率（实测 metricsList 报 (pe,pe_static) are invalid price metrics），
           -- 按站内既定口径现算：当前总市值 ÷ 最近一期已公告年报归母净利（600519 校验与 Tushare 完全一致）。
           -- 这是同一口径的定义式计算，不是估算兜底；归母净利缺失或为 0 时保持 NULL，不猜。
           COALESCE(v.pe_static, CASE WHEN v.total_market_cap IS NOT NULL
                                        AND np.net_profit IS NOT NULL AND np.net_profit <> 0
                                       THEN v.total_market_cap / np.net_profit END) AS pe_static,
           v.pe_ttm, v.dividend_yield_ttm, v.total_market_cap, v.currency_code AS valuation_currency,
           v.trade_date::text AS valuation_date,
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
      -- 最近一期已公告年报归母净利：静态 PE 定义式的分母（与读取估值序列的 fillStaticPe 同一口径）。
      LEFT JOIN LATERAL (
        SELECT f.numeric_value AS net_profit
          FROM fundamental.financial_reports r
          JOIN fundamental.financial_facts f ON f.report_id = r.report_id AND f.metric_code = 'net_profit_parent'
         WHERE r.company_id = ci.company_id
           AND r.report_kind = 'income'
           AND r.period_type = 'annual'
           AND r.statement_scope = 'consolidated'
           AND r.announced_at IS NOT NULL AND r.announced_at < $2::date
         ORDER BY r.period_end DESC, r.announced_at DESC
         LIMIT 1
      ) np ON true
      -- 停牌先判：只有"当天确实停牌（S=停牌，R=复牌不算）"才允许把估值/价格回退到停牌前最后交易日。
      LEFT JOIN LATERAL (
        SELECT sc.suspend_type FROM market.stock_suspend_calendar sc
         WHERE sc.instrument_id = i.instrument_id AND sc.trade_date = $2::date
           AND sc.suspend_type = 'S' LIMIT 1
      ) s ON true
      -- 停牌或当日数据延迟：取目标日前 60 天窗口内最后一个有值交易日（当天有值仍然是当天）。
      -- 不能只靠 suspend_type 触发回退：停牌表只覆盖转债正股与已跟踪股票，全市场并不完整
      -- （*ST康佳A 这类 9-03 之后就没有任何行情的，表里查不到）。60 天上限保证不会拿长期停牌/退市前的陈旧价格。
      LEFT JOIN LATERAL (
        SELECT dv.pb, dv.pe_static, dv.pe_ttm, dv.dividend_yield_ttm, dv.total_market_cap,
               dv.currency_code, dv.trade_date
          FROM market.daily_valuations dv
         WHERE dv.instrument_id = i.instrument_id
           AND dv.trade_date <= $2::date
           AND dv.trade_date > ($2::date - INTERVAL '60 days')
         ORDER BY dv.trade_date DESC, dv.source_id DESC LIMIT 1
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT bb.close, bb.trade_date FROM market.daily_bars bb
         WHERE bb.instrument_id = i.instrument_id
           AND bb.trade_date <= $2::date
           AND bb.trade_date > ($2::date - INTERVAL '60 days')
         ORDER BY bb.trade_date DESC LIMIT 1
      ) b ON true
     WHERE i.asset_class = 'stock'
       AND i.market = $1
       AND i.exchange_code = ANY($3::text[])
       AND (i.list_date IS NULL OR i.list_date <= $2::date)
       AND (i.delist_date IS NULL OR i.delist_date > $2::date)
       -- 从未有过任何行情/估值的证券（已退市、已摘牌、吸收合并后残留主档）不构成可评估对象。
       -- 真停牌的历史上一定有成交记录，所以按"有没有过任何数据"区分，不看名称、也不依赖主档 status 是否已更新。
       AND (EXISTS (SELECT 1 FROM market.daily_bars bx WHERE bx.instrument_id = i.instrument_id)
         OR EXISTS (SELECT 1 FROM market.daily_valuations vx WHERE vx.instrument_id = i.instrument_id))
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
      -- 停牌且当天没有派生出 PB 的交易日不算"应有证据"：停牌期间没有新价格，估值沿用停牌前是正常的，
      -- 把它算成缺口会让每个停牌股都被判"历史数据待补"（2026-11-04 口径：暂时停牌按停牌前最后交易日）。
      SELECT i.instrument_id,
             GREATEST(COUNT(c.trade_date) - COALESCE((
               SELECT COUNT(DISTINCT sc.trade_date)::int
                 FROM market.stock_suspend_calendar sc
                 JOIN cal c3 ON c3.trade_date = sc.trade_date
                WHERE sc.instrument_id = i.instrument_id AND sc.suspend_type = 'S'
                  AND NOT EXISTS (
                    SELECT 1 FROM market.daily_valuations v3
                     WHERE v3.instrument_id = sc.instrument_id
                       AND v3.trade_date = sc.trade_date AND v3.pb IS NOT NULL)
             ), 0), 0)::int AS expected_days
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
             -- 负 PB 是"净资产为负"的真实取值，不是缺失：只排除 NULL（2026-11-04）。
             -- 负值不可能是 >1 的正证，MAX(pb) 仍如实反映窗口内最高值。
             AND v.pb IS NOT NULL
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
           r.source_version,
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
      // 事实版本进入输入指纹（R2-02）：同一财年被更正后版本会变，不能继续命中旧快照。
      sourceVersion: row.source_version || null,
    });
    map.set(key, list);
  });
  return map;
}

/**
 * T 前十二个月按除息日计入的现金股息（每股，税前），折算到 **T 日股本单位**。
 * - 送转拆合会让历史上"每股派 X 元"在除权前后不可比，必须用其后发生的送转因子折算（前复权）；
 * - 送转比例直接来自官方分红接口（bonusSharesFromProfit / bonusSharesFromCapitalReserve），
 *   A 股没有独立股权变动接口，但这两项随每笔分红一起返回，不需要另建采集；
 * - 只有"该笔确实发生过送转、但比例字段为空"才判股份单位未知（旧备源数据），这种情况下不猜、不折算；
 * - 同一除息日多来源重复登记只取一条（官方优先），避免把同一笔派息加两遍。
 */
async function loadDividendWindow({ instrumentIds, windowStart, asOfDate }, tx) {
  if (!instrumentIds.length) return new Map();
  const exec = executorOf(tx);
  const detail = await exec(`
      SELECT ca.instrument_id,
             ca.ex_date,
             ca.cash_per_share_pre_tax,
             ca.stock_dividend_ratio,
             ca.capitalization_ratio,
             ca.currency_code,
             ca.total_cash_amount
        FROM fundamental.corporate_actions ca
       WHERE ca.instrument_id = ANY($1::bigint[])
         AND ca.action_type = 'dividend'
         AND ca.status = '实施'
         AND ca.ex_date IS NOT NULL
         AND ca.ex_date > $2::date AND ca.ex_date <= $3::date
       ORDER BY ca.instrument_id, ca.ex_date DESC, ca.source_id DESC`, [instrumentIds, windowStart, asOfDate]);
  const byInstrument = new Map();
  for (const row of detail.rows) {
    const key = String(row.instrument_id);
    const list = byInstrument.get(key) || [];
    // 同一除息日多来源重复登记只保留排序第一条（source_id 降序 = 官方优先）。
    const last = list[list.length - 1];
    if (last && new Date(last.ex_date).getTime() === new Date(row.ex_date).getTime()) continue;
    list.push(row);
    byInstrument.set(key, list);
  }
  // 「采过分红但窗口内一笔都没有」与「从没采过」必须分开（2026-11-04 口径调整）：
  // 前者是明确的"近 12 个月无现金分红"（可判不通过），后者才可能是数据缺失。
  // 老实现只返回有现金分红的证券，导致没分红的公司一律被当成"分红不可用"并阻断整批发布。
  const history = await exec(`
      SELECT DISTINCT instrument_id
        FROM fundamental.corporate_actions
       WHERE instrument_id = ANY($1::bigint[])
         AND action_type = 'dividend'`, [instrumentIds]);
  const hasHistory = new Set(history.rows.map(row => String(row.instrument_id)));
  const map = new Map();
  for (const instrumentId of instrumentIds) {
    const key = String(instrumentId);
    const rows = byInstrument.get(key) || [];
    // 按除息日倒序遍历：先累积"这笔之后发生过的送转"因子，再把这笔现金折算到 T 日股本单位。
    let factor = 1;
    let perShare = null;
    let count = 0;
    let totalCash = null;
    let currency = null;
    let unitUnverified = false;
    for (const row of rows) {
      const bonus = row.stock_dividend_ratio === null ? null : Number(row.stock_dividend_ratio);
      const cap = row.capitalization_ratio === null ? null : Number(row.capitalization_ratio);
      const cashValue = row.cash_per_share_pre_tax === null ? null : Number(row.cash_per_share_pre_tax);
      // 两项都为空 = 这一笔到底有没有送转不知道，折算因子无从谈起 → 整只标未核验，不猜。
      if (bonus === null && cap === null) unitUnverified = true;
      const change = (bonus || 0) + (cap || 0);
      // 本行的送转同样作用于本行现金：除权后股数才变多，所以本行现金要除以含本行的因子。
      if (change > 0) factor *= 1 + change;
      if (cashValue === null || cashValue <= 0) continue;
      perShare = (perShare || 0) + cashValue / factor;
      count += 1;
      if (row.total_cash_amount !== null && Number(row.total_cash_amount) > 0) {
        totalCash = (totalCash || 0) + Number(row.total_cash_amount);
      }
      if (!currency && row.currency_code) currency = row.currency_code;
    }
    map.set(key, {
      ttmPerShare: perShare,
      count,
      currency,
      totalCash,
      shareUnitUnverified: unitUnverified,
      hasDividendHistory: hasHistory.has(key),
      // 折算因子留证：1 表示窗口内没发生送转，>1 表示历史每股金额已按比例折到 T 日单位。
      adjustmentFactor: Number(factor.toFixed(6)),
    });
  }
  return map;
}

/** 按公司财年汇总的现金分红（A/H 同一发行人按经济事件去重），只认目标日当时可见的事实（SSV-04）。
 *  - 可见性：公告日严格早于目标日；公告日缺失但除息日已发生（除息必然在公告之后）视为可见；
 *  - 金额只统计目标日之前已除息且状态为"实施"的现金，后续状态变化不会回灌旧季度；
 *  - 完整性独立于行数（R3-03）：只有"财年末那笔分红已实施、已除息且总额已知"才构成该财年完整证据。
 *    只有预案（未实施）= 之后可能再实施一笔；只有中期记录 = 末期可能尚未采集；
 *    已实施但 total_cash_amount 为 NULL = 金额未知。这三种都保留 dividend=NULL、dividendKnown=false，
 *    绝不把"未知"折成 0 参与年度比较；行数只用于诊断，不用于判定。
 *  - 财年末按公司**实际年报期末**识别（R4-03）：港股/变更财年可能是 3/6 月结束，
 *    写死 12-31 会把整段年度分红判成"只有中期"，所以用同期 `period_type='annual'` 的
 *    `financial_reports.period_end` 作为该财年期末集合。
 *  - 明确零分红也算已知（R4-04）：官方"无股息"落成"实施 + 每股 0 + 无除息日"，
 *    这类年度零分红证据要与"金额未知"区分开，不能为了放行零值又回到"有记录即完整"。
 */
async function loadAnnualDividends({ companyIds, asOfDate, availableBefore }, tx) {
  if (!companyIds.length) return new Map();
  const exec = executorOf(tx);
  // 官方会返回"已实施、已除息、但每股金额与总金额都是空"的记录（多见于中期分红），
  // 这种行不携带任何金额信息，不能算成"实施但金额缺失"——否则同财年里一笔年度分红已经拿到，
  // 整年仍被判未知（177 只曾因此在年度异常上永远待补）。
  const visibleCash = `(ca.cash_per_share_pre_tax IS NOT NULL OR ca.total_cash_amount IS NOT NULL)`;
  const implemented = `ca.status = '实施' AND ca.ex_date IS NOT NULL AND ca.ex_date <= $2::date AND ${visibleCash}`;
  // 明确零分红：状态已实施、没有除息日（本就不该有）、每股金额明确为 0。
  const explicitZero = `ca.status = '实施' AND ca.ex_date IS NULL AND ca.cash_per_share_pre_tax = 0`;
  const { rows } = await exec(`
    WITH annual_ends AS (
      -- R5-02：财年期末集合必须与利润查询用**同一套信息截止**。
      -- 只过滤公告日会让"公告在目标日前、但目标日之后才可取到"的年报版本混进来，
      -- 把旧季度的分红从"待补"变成"通过"（未来数据泄漏）。
      SELECT DISTINCT r.company_id, r.period_end
        FROM fundamental.financial_reports r
       WHERE r.company_id = ANY($1::bigint[])
         AND r.report_kind = 'income'
         AND r.period_type = 'annual'
         AND r.statement_scope = 'consolidated'
         AND r.announced_at IS NOT NULL
         AND r.announced_at < $2::date
         AND ($3::timestamptz IS NULL OR r.available_at IS NULL OR r.available_at < $3::timestamptz)
    ), per_instrument AS (
      SELECT ci.company_id,
             date_part('year', ca.fiscal_period_end)::int AS fiscal_year,
             ci.instrument_id,
             SUM(CASE WHEN ${implemented} THEN COALESCE(ca.total_cash_amount, 0) ELSE 0 END) AS implemented_cash,
             COUNT(*) FILTER (WHERE ${implemented})::int AS implemented_count,
             COUNT(*) FILTER (WHERE ${implemented} AND ca.total_cash_amount IS NULL)::int AS amount_missing_count,
             COUNT(*) FILTER (WHERE NOT (${implemented}))::int AS not_implemented_count,
             -- 财年期末已过 2 年以上、状态仍停在预案/股东大会通过且该财年从未实施：
             -- 这种历史方案就是"没有落地"，再等也不会变（2026-11-04 口径），
             -- 与"金额未知"要分开，否则老公司会永远挂在"年度分红未知"上。
             COUNT(*) FILTER (WHERE ca.status IN ('预案', '股东大会通过')
               AND ca.fiscal_period_end <= ($2::date - INTERVAL '2 years'))::int AS stale_plan_count,
             COUNT(*) FILTER (WHERE ${explicitZero} AND EXISTS (
               SELECT 1 FROM annual_ends ae
                WHERE ae.company_id = ci.company_id AND ae.period_end = ca.fiscal_period_end))::int AS year_zero_count,
             BOOL_OR(${implemented} AND EXISTS (
               SELECT 1 FROM annual_ends ae
                WHERE ae.company_id = ci.company_id AND ae.period_end = ca.fiscal_period_end)) AS has_year_end_implemented
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
           SUM(implemented_count)::int AS implemented_count,
           SUM(amount_missing_count)::int AS amount_missing_count,
           SUM(not_implemented_count)::int AS not_implemented_count,
           SUM(stale_plan_count)::int AS stale_plan_count,
           SUM(year_zero_count)::int AS year_zero_count,
           BOOL_OR(has_year_end_implemented) AS has_year_end_implemented
      FROM per_instrument
     GROUP BY 1, 2`, [companyIds, asOfDate, availableBefore || null]);
  const map = new Map();
  rows.forEach(row => {
    const key = String(row.company_id);
    const list = map.get(key) || [];
    const implementedCount = Number(row.implemented_count || 0);
    const amountMissing = Number(row.amount_missing_count || 0);
    const notImplemented = Number(row.not_implemented_count || 0);
    const yearZero = Number(row.year_zero_count || 0);
    const stalePlan = Number(row.stale_plan_count || 0);
    // 完整证据 = 财年末那笔已实施已除息 + 该年所有已实施记录金额都不缺；
    // 或者官方明确给出"该财年零股息"（实施 + 每股 0 + 无除息日）；
    // 或者该财年只有"预案/股东大会通过"、且财年期末已过 2 年以上仍从未实施——
    // 这种历史方案不会再有落地，按"该财年无已实施现金分红"计入（2026-11-04 口径）。
    const knownFromImplemented = implementedCount > 0 && amountMissing === 0 && row.has_year_end_implemented === true;
    const knownFromZero = yearZero > 0 && amountMissing === 0;
    const knownFromStalePlan = implementedCount === 0 && amountMissing === 0 && stalePlan > 0;
    const known = knownFromImplemented || knownFromZero || knownFromStalePlan;
    list.push({
      year: Number(row.fiscal_year),
      dividend: known ? Number(row.implemented_cash || 0) : null,
      eventCount: implementedCount + notImplemented,
      dividendKnown: known,
      dividendBasis: knownFromImplemented ? 'annual_implemented_amount'
        : knownFromZero ? (implementedCount > 0 ? 'interim_plus_verified_zero' : 'verified_zero_dividend')
          : knownFromStalePlan ? 'stale_plan_not_implemented'
            : amountMissing > 0 ? 'implemented_amount_missing'
              : implementedCount > 0 ? 'interim_only' : 'plan_only',
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

/**
 * 该季度是否已有"可核验的完成终态"批次（R5-03）。
 * 用**存在性查询**而不是列表分页：批次修订会把完成记录推到很远，
 * 只看最近 N 条会在"N 条更新的部分批次"出现时误判"没完成"并重复排队。
 * 完成终态 = 已正式发布，或执行成功且业务结论为正常关闭/明确零合格；
 * insufficient_data 与失败不算完成，仍应继续补算。
 */
async function hasCompletedQuarterRun({ market, quarter }, tx) {
  if (!market || !quarter) return false;
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT 1 AS hit
      FROM analytics.stock_selection_runs r
     WHERE r.market = $1
       AND r.quarter = $2
       AND r.run_kind = 'quarterly'
       AND r.owner_username IS NULL
       AND (
         r.published_at IS NOT NULL
         OR (r.execution_status = 'succeeded'
             AND r.business_status IN ('market_closed', 'no_eligible_member', 'insufficient_candidates'))
       )
     LIMIT 1`, [market, quarter]);
  return rows.length > 0;
}

/** 证券主档最小信息（选股输入补齐用）。SQL 留在仓储层，服务不再直接持连接池查询。 */
async function findInstrumentMeta({ tsCode }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(
    `SELECT i.canonical_code AS ts_code, i.name, i.market, i.list_date::text AS list_date,
            i.currency_code, i.raw_data
       FROM core.instruments i WHERE i.canonical_code = $1 LIMIT 1`, [tsCode]);
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
  saveInputGapQueue, readInputGapQueue, findInstrumentMeta, hasCompletedQuarterRun,
  insertBacktest, insertBacktestPeriods, findBacktest, listBacktestPeriods, listBacktests, previousPublishedMembers,
};
