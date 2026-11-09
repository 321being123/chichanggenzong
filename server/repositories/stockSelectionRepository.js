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
async function loadUniverse({ market, asOfDate, availableBefore = null }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT i.instrument_id, i.canonical_code AS code, i.name, i.market, i.currency_code,
           i.exchange_code, i.list_date::text AS list_date, i.delist_date::text AS delist_date,
           ${RISK_NAME_SQL} AS risk_warning,
           ci.company_id,
           -- PB 回退必须币种闭合（F09）：市值与归母权益币种不一致时相除没有意义，
           -- 这种情况宁可留 NULL 让规则判"待补/不可评估"，也不生成一个错误量纲的 PB。
           COALESCE(v.pb, CASE WHEN v.total_market_cap IS NOT NULL
                                AND eq.equity IS NOT NULL AND eq.equity <> 0
                                AND (eq.equity_currency IS NULL OR v.currency_code IS NULL
                                     OR upper(eq.equity_currency) = upper(v.currency_code))
                               THEN v.total_market_cap / eq.equity END) AS pb,
           eq.equity_currency,
           -- 官方估值接口不提供静态市盈率（实测 metricsList 报 (pe,pe_static) are invalid price metrics），
           -- 按站内既定口径现算：当前总市值 ÷ 最近一期已公告年报归母净利（600519 校验与 Tushare 完全一致）。
           -- 这是同一口径的定义式计算，不是估算兜底；归母净利缺失或为 0 时保持 NULL，不猜。
           -- 2026-11-05 起选股排名与页面展示统一使用 pe_ttm（滚动十二个月），静态 PE 只保留作排查参考。
           COALESCE(v.pe_static, CASE WHEN v.total_market_cap IS NOT NULL
                                        AND np.net_profit IS NOT NULL AND np.net_profit <> 0
                                        AND (np.net_profit_currency IS NULL OR v.currency_code IS NULL
                                             OR upper(np.net_profit_currency) = upper(v.currency_code))
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
      -- 可见时点必须与 loadEquityFacts / loadAnnualProfits 同源（F09）：只按 announced_at 截断，
      -- 会让同一批计算里的 PE 和净资产规则落在不同版本的报表上。
      LEFT JOIN LATERAL (
        SELECT f.numeric_value AS net_profit, f.currency_code AS net_profit_currency
          FROM fundamental.financial_reports r
          JOIN fundamental.financial_facts f ON f.report_id = r.report_id AND f.metric_code = 'net_profit_parent'
         WHERE r.company_id = ci.company_id
           AND r.report_kind = 'income'
           AND r.period_type = 'annual'
           AND r.statement_scope = 'consolidated'
           AND r.announced_at IS NOT NULL AND r.announced_at < $2::date
           AND ($4::timestamptz IS NULL OR r.available_at IS NULL OR r.available_at < $4::timestamptz)
         ORDER BY r.period_end DESC, r.announced_at DESC
         LIMIT 1
      ) np ON true
      -- 最近一期已公告归母净资产：源站对"净资产为负"的股票直接不给 PB（字段为空，不是没有这一行），
      -- 所以 PB 为空时要按同一定义式现算（总市值 ÷ 归母净资产），负值如实判为净资产为负。
      LEFT JOIN LATERAL (
        SELECT f.numeric_value AS equity, f.currency_code AS equity_currency
          FROM fundamental.financial_reports r
          JOIN fundamental.financial_facts f ON f.report_id = r.report_id AND f.metric_code = 'equity_parent'
         WHERE r.company_id = ci.company_id
           AND r.report_kind = 'balance'
           AND r.statement_scope = 'consolidated'
           AND r.announced_at IS NOT NULL AND r.announced_at < $2::date
           AND ($4::timestamptz IS NULL OR r.available_at IS NULL OR r.available_at < $4::timestamptz)
         ORDER BY r.period_end DESC, r.announced_at DESC
         LIMIT 1
      ) eq ON true
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
       -- 港股历史主档里有一批 .HK 证券的交易所被登记成 SZSE（2026-11-05 生产实测 688 只，
       -- 恰好是港股通＋恒生成分目标池），按交易所过滤会把整个港股候选池清空、连带补数任务崩溃。
       -- 港股市场唯一，改以 market 为准纳入；A 股仍按交易所列表过滤。
       AND (i.market = 'HK' OR i.exchange_code = ANY($3::text[]))
       AND (i.list_date IS NULL OR i.list_date <= $2::date)
       AND (i.delist_date IS NULL OR i.delist_date > $2::date)
       -- 从未有过任何行情/估值的证券（已退市、已摘牌、吸收合并后残留主档）不构成可评估对象。
       -- 真停牌的历史上一定有成交记录，所以按"有没有过数据"区分，不看名称、也不依赖主档 status 是否已更新。
       AND (EXISTS (SELECT 1 FROM market.daily_bars bx WHERE bx.instrument_id = i.instrument_id)
         OR EXISTS (SELECT 1 FROM market.daily_valuations vx WHERE vx.instrument_id = i.instrument_id))
       -- 目标日前 60 天内没有任何行情 = 已经停止交易（退市整理、长期停牌）。这类证券买不到，
       -- 留着只会让它们以"缺 PB / 缺股价"的名义反复阻断整批发布（2026-11-04）。
       AND EXISTS (SELECT 1 FROM market.daily_bars bt
                   WHERE bt.instrument_id = i.instrument_id
                     AND bt.trade_date <= $2::date
                     AND bt.trade_date > ($2::date - INTERVAL '60 days'))
     ORDER BY i.canonical_code`, [market, asOfDate, config.exchanges, availableBefore || null]);
  return rows;
}

/**
 * 自算 TTM 的输入（方案 27.4「TTM 状态与血缘合同」）：每公司最近几个报告期的归母净利，
 * 覆盖「完整年度＋本期累计−上年同期累计」所需的三段。可见时点与净资产/PE 同一口径，
 * 只按 announced_at 与 available_at 截断，不用今天的最新投影补历史。
 */
async function loadTtmInputs({ companyIds, asOfDate, availableBefore = null }, tx) {
  if (!companyIds.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT r.company_id, r.report_id, r.period_end::text AS period_end, r.period_type,
           r.announced_at::text AS announced_at,
           f.numeric_value::text AS net_profit, f.currency_code
      FROM fundamental.financial_reports r
      JOIN fundamental.financial_facts f ON f.report_id = r.report_id AND f.metric_code = 'net_profit_parent'
     WHERE r.company_id = ANY($1::bigint[])
       AND r.report_kind = 'income'
       AND r.statement_scope = 'consolidated'
       AND r.period_end >= ($2::date - INTERVAL '3 years')
       AND r.period_end <= $2::date
       AND r.announced_at IS NOT NULL AND r.announced_at < $2::date
       AND ($3::timestamptz IS NULL OR r.available_at IS NULL OR r.available_at < $3::timestamptz)
     ORDER BY r.company_id, r.period_end DESC, r.announced_at DESC, r.report_id DESC`,
  [companyIds, asOfDate, availableBefore]);
  const byCompany = new Map();
  rows.forEach(row => {
    const key = String(row.company_id);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push({
      reportId: Number(row.report_id),
      periodEnd: row.period_end,
      periodType: row.period_type || null,
      announcedAt: row.announced_at || null,
      netProfit: row.net_profit === null ? null : Number(row.net_profit),
      currency: row.currency_code || null,
    });
  });
  return byCompany;
}

/**
 * 目标日已固化的股票池 artifact（方案 27.11 / DEV-02）。
 * 同一目标日取最新一条：先固化的集合是这次历史的"当时名单"，后续重算/回测不得悄悄换成今天的池。
 */
async function findUniverseArtifact({ market, targetDate }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT artifact_id, market, target_date::text AS target_date, content_hash, member_count,
           instrument_ids, members, excluded, knowledge_cutoff, source_versions, basis, replay_type, created_at
      FROM analytics.stock_selection_universe_artifacts
     WHERE market = $1 AND target_date = $2::date
     ORDER BY created_at DESC, artifact_id DESC LIMIT 1`, [market, targetDate]);
  return rows[0] || null;
}

/** 固化股票池 artifact：同内容哈希幂等，不覆盖既有集合。 */
async function insertUniverseArtifact({
  market, targetDate, contentHash, instrumentIds, members, excluded,
  knowledgeCutoff, sourceVersions, basis, replayType,
}, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    INSERT INTO analytics.stock_selection_universe_artifacts
      (market, target_date, content_hash, member_count, instrument_ids, members, excluded,
       knowledge_cutoff, source_versions, basis, replay_type)
    VALUES ($1,$2::date,$3,$4,$5::bigint[],$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11)
    ON CONFLICT (market, target_date, content_hash) DO NOTHING
    RETURNING artifact_id`,
  [market, targetDate, contentHash, instrumentIds.length, instrumentIds,
    JSON.stringify(members || []), JSON.stringify(excluded || []),
    knowledgeCutoff || null, JSON.stringify(sourceVersions || {}),
    JSON.stringify(basis || {}), replayType || 'pit_research_replay']);
  if (rows[0]) return Number(rows[0].artifact_id);
  const existing = await findUniverseArtifact({ market, targetDate }, tx);
  return existing ? Number(existing.artifact_id) : null;
}

/**
 * 目标日"目标池名单"（C0）：生命周期与准入范围内的**全部**证券，不带"近 60 日有行情"过滤。
 * 是否在池只由生命周期/市场/交易场所决定；能不能交易（有无行情）是另一个维度，
 * 由调用方作为 excluded 证据记录，不能因为当天没行情就把证券从历史名单里抹掉。
 */
async function loadUniverseRoster({ market, asOfDate }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT i.instrument_id, i.canonical_code AS code, i.name, i.market, i.exchange_code,
           i.currency_code, i.list_date::text AS list_date, i.delist_date::text AS delist_date,
           EXISTS (SELECT 1 FROM market.daily_bars bx WHERE bx.instrument_id = i.instrument_id) AS has_any_data,
           EXISTS (SELECT 1 FROM market.daily_bars bt
                    WHERE bt.instrument_id = i.instrument_id
                      AND bt.trade_date <= $2::date
                      AND bt.trade_date > ($2::date - INTERVAL '60 days')) AS has_recent_bars
      FROM core.instruments i
     WHERE i.asset_class = 'stock'
       AND i.market = $1
       AND (i.market = 'HK' OR i.exchange_code = ANY($3::text[]))
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
    exempt AS (
      -- 停牌豁免一次性按证券聚合：原实现把它写成 expect 里的相关子查询，
      -- 而且是 expected_days 与 exempt_days 各写一遍（同一只证券算两次）。
      -- 日历补齐到十年后（应有日基数 5749×2672≈1536 万），逐证券子查询变成主要耗时来源。
      SELECT sc.instrument_id, COUNT(DISTINCT sc.trade_date)::int AS exempt_days
        FROM market.stock_suspend_calendar sc
        JOIN cal c3 ON c3.trade_date = sc.trade_date
       WHERE sc.suspend_type = 'S'
         AND NOT EXISTS (
               SELECT 1 FROM market.daily_valuations v3
                WHERE v3.instrument_id = sc.instrument_id
                  AND v3.trade_date = sc.trade_date AND v3.pb IS NOT NULL)
       GROUP BY 1
    ),
    expect AS (
      -- 停牌且当天没有派生出 PB 的交易日不算"应有证据"：停牌期间没有新价格，估值沿用停牌前是正常的，
      -- 把它算成缺口会让每个停牌股都被判"历史数据待补"（2026-11-04 口径：暂时停牌按停牌前最后交易日）。
      -- 豁免数单独留证（V2 exemptDays），不能只从应有日里悄悄扣掉——否则复牌后重新核验时看不出扣过什么。
      SELECT i.instrument_id, i.list_date,
             GREATEST(COUNT(c.trade_date) - COALESCE(e.exempt_days, 0), 0)::int AS expected_days,
             COALESCE(e.exempt_days, 0)::int AS exempt_days
        FROM inst i
        JOIN cal c ON c.trade_date > i.list_date
        LEFT JOIN exempt e ON e.instrument_id = i.instrument_id
       GROUP BY i.instrument_id, i.list_date, e.exempt_days
    ),
    covered AS (
      SELECT picked.instrument_id,
             -- V1 口径：窗口内最高 PB 如实反映（含负值），用于「是否出现过 PB>1」的正证判断。
             MAX(picked.pb) AS max_pb,
             -- V2 口径：只有正 PB 参与正极值比，负值是非正事实、不参与 min/max。
             MAX(picked.pb) FILTER (WHERE picked.pb > 0) AS max_positive_pb,
             MIN(picked.pb) FILTER (WHERE picked.pb > 0) AS min_positive_pb,
             COUNT(*) FILTER (WHERE picked.pb > 0)::int AS covered_days,
             COUNT(*)::int AS observed_days,
             COUNT(*) FILTER (WHERE picked.pb <= 0)::int AS non_positive_days,
             MIN(picked.trade_date) FILTER (WHERE picked.pb > 0) AS effective_start,
             (ARRAY_AGG(picked.trade_date ORDER BY picked.pb ASC, picked.trade_date ASC)
               FILTER (WHERE picked.pb > 0))[1] AS min_pb_date,
             (ARRAY_AGG(picked.trade_date ORDER BY picked.pb DESC, picked.trade_date ASC)
               FILTER (WHERE picked.pb > 0))[1] AS max_pb_date,
             -- 内容指纹（V2 方案 27.5「同一冻结序列」）：逐行 32 位摘要累加＋行数，
             -- 用于检测"证据被改过"；不是密码学前缀，明细仍以 market.daily_valuations 原始行为准。
             SUM(('x' || substr(md5(picked.trade_date::text || ':' || picked.pb::text), 1, 8))::bit(32)::bigint) AS series_digest,
             COUNT(*)::int AS series_rows
        FROM (
          SELECT DISTINCT ON (v.instrument_id, v.trade_date) v.instrument_id, v.trade_date, v.pb
            FROM market.daily_valuations v
            JOIN inst i2 ON i2.instrument_id = v.instrument_id
            JOIN cal c2 ON c2.trade_date = v.trade_date
            LEFT JOIN ops.data_sources s ON s.source_id = v.source_id
           WHERE v.trade_date > $1::date AND v.trade_date <= $2::date
             -- 负 PB 是"净资产为负"的真实取值，不是缺失：只排除 NULL（2026-11-04）。
             -- 'NaN' 是 PG NUMERIC 的合法值，但比较恒为 false，必须单独归入 invalid 而不是"缺失"。
             AND v.pb IS NOT NULL
           -- ⚠️ 这里刻意用表达式排序，不要"优化"成物化列：2026-11-07 生产实测过一版
           -- source_priority 物化列 + 复合索引，DISTINCT ON 的 Sort 确实消失了，但索引扫描
           -- 1220 万行反而更慢，loadPbWindow 由 60.7s 变成 62.4s。真正的耗时是"一千多万行必须
           -- 排一次序"这个量级本身，不是排序键的写法。要实质提速只能做按年预聚合（见任务卡 21 节）。
           ORDER BY v.instrument_id, v.trade_date,
                    CASE WHEN s.source_code LIKE 'lixinger%' THEN 0 ELSE 1 END, v.source_id
        ) picked
       GROUP BY 1
    )
    SELECT e.instrument_id, e.expected_days, e.exempt_days, e.list_date::text AS list_date,
           COALESCE(c.covered_days, 0)::int AS covered_days,
           COALESCE(c.observed_days, 0)::int AS observed_days,
           COALESCE(c.non_positive_days, 0)::int AS non_positive_days,
           COALESCE(c.observed_days, 0)::int
             - COALESCE(c.covered_days, 0)::int
             - COALESCE(c.non_positive_days, 0)::int AS invalid_days,
           c.max_pb, c.max_positive_pb, c.min_positive_pb,
           c.effective_start::text AS effective_start,
           c.min_pb_date::text AS min_pb_date, c.max_pb_date::text AS max_pb_date,
           c.series_digest, c.series_rows
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
    // 两个口径必须分开，不能互相顶替：
    //   V1「十年 PB 覆盖」= 有观测（含负 PB 这类真实非正事实）——2026-11-04 口径，不能改成只算正值；
    //   V2「有效正 PB 覆盖」= 只有 pb>0 才算覆盖（正极值比需要正值序列）。
    const observedDays = Number(row.observed_days || 0);
    const positiveDays = Number(row.covered_days || 0);
    const listDate = row.list_date || null;
    const effectiveStart = row.effective_start || listDate || null;
    const gapOf = days => (calendarCount === 0 ? null : Math.max(expectedDays - days, 0));
    byInstrument.set(String(row.instrument_id), {
      // V1 合同（R02「十年内出现过 PB>1」）沿用原字段，语义不变。
      maxPb: row.max_pb === null ? null : Number(row.max_pb),
      coveredDays: observedDays,
      expectedDays,
      gapDays: gapOf(observedDays),
      // V2：正极值比与覆盖分账。原始 NUMERIC 文本一并返回，判定走十进制，不先转 Number。
      positiveDays,
      positiveGapDays: gapOf(positiveDays),
      minPb: row.min_positive_pb === null ? null : Number(row.min_positive_pb),
      minPbRaw: row.min_positive_pb === null ? null : String(row.min_positive_pb),
      maxPbRaw: row.max_positive_pb === null ? null : String(row.max_positive_pb),
      observedDays,
      nonPositiveDays: Number(row.non_positive_days || 0),
      invalidDays: Number(row.invalid_days || 0),
      missingDays: gapOf(observedDays),
      exemptDays: Number(row.exempt_days || 0),
      calendarComplete: calendarCount > 0,
      windowStart,
      windowEnd: asOfDate,
      effectiveStart,
      listDate,
      minPbDate: row.min_pb_date || null,
      maxPbDate: row.max_pb_date || null,
      historyYears: effectiveStart ? Math.round((Date.parse(asOfDate) - Date.parse(effectiveStart)) / 86400000 / 365.25 * 10) / 10 : null,
      pbSeriesDigest: row.series_digest === null || row.series_digest === undefined
        ? null : `${row.series_digest}:${row.series_rows}`,
      pbSeriesRows: Number(row.series_rows || 0),
    });
  });
  return {
    byInstrument,
    marketDays: Number((marketDays.rows[0] || {}).market_days || 0),
    calendarDays: calendarCount,
  };
}

/**
 * 指定证券在 PB 窗口内的**缺失交易日清单**（应有交易日里没有有效正 PB 的那些天）。
 * 只给已登记「源端不可恢复」的极少数证券单独调用：全市场口径的 loadPbWindow 不输出清单，
 * 因为对 688 只逐日保留集合会把十年级查询再放大一轮（该查询已是本模块最慢的一段）。
 * 判据用途：窗口内缺失日是否**全部**被 governance 登记覆盖，只有全覆盖才允许判不可评估。
 *
 * ⚠️ 语义必须与 loadPbWindow 的 expect/covered 完全一致，否则这里列出的"缺失日"和规则看到的
 * positiveGapDays 不是同一批天，登记永远对不上：① 窗口严格 > windowStart；② 排除上市日
 * （c.trade_date > list_date）；③ 停牌且当天无 PB 的交易日豁免；④ 只有 pb > 0 才算覆盖
 * （负债真实取值的负 PB 在规则层先被判为非正事实，走不到缺口分支）。
 */
async function loadPbMissingDaysForCodes({ market, codes = [], windowStart, asOfDate }, tx) {
  const list = (codes || []).filter(Boolean);
  if (!list.length) return new Map();
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    WITH inst AS (
      SELECT instrument_id, canonical_code, COALESCE(list_date, DATE '1900-01-01') AS list_date
        FROM core.instruments
       WHERE market = $5 AND asset_class = 'stock' AND canonical_code = ANY($3::text[])
    ), cal AS (
      SELECT trade_date FROM market.trade_calendar
       WHERE exchange = ANY($4::text[]) AND COALESCE(is_open, true) = true
         AND trade_date > $1::date AND trade_date <= $2::date
    ), susp AS (
      SELECT sc.instrument_id, sc.trade_date
        FROM market.stock_suspend_calendar sc
        JOIN cal c3 ON c3.trade_date = sc.trade_date
       WHERE sc.suspend_type = 'S'
         AND NOT EXISTS (
               SELECT 1 FROM market.daily_valuations v3
                WHERE v3.instrument_id = sc.instrument_id
                  AND v3.trade_date = sc.trade_date AND v3.pb IS NOT NULL)
    )
    SELECT i.canonical_code AS code, to_char(c.trade_date, 'YYYY-MM-DD') AS missing_day
      FROM inst i
      JOIN cal c ON c.trade_date > i.list_date
     WHERE NOT EXISTS (
             SELECT 1 FROM market.daily_valuations v
              WHERE v.instrument_id = i.instrument_id
                AND v.trade_date = c.trade_date
                AND v.pb IS NOT NULL AND v.pb > 0)
       AND NOT EXISTS (
             SELECT 1 FROM susp s
              WHERE s.instrument_id = i.instrument_id AND s.trade_date = c.trade_date)
     ORDER BY 1, 2`, [windowStart, asOfDate, list, config.calendarExchanges, market]);
  const map = new Map();
  rows.forEach(row => {
    const key = String(row.code || '').toUpperCase();
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(String(row.missing_day).slice(0, 10));
  });
  return map;
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
 * - A 股源逐行下发比例，只有"该笔确实发生过送转、但比例字段为空"才判股份单位未知（旧备源数据），这种情况下不猜、不折算；
 *   港股源未下发比例（见函数内 2026-11-05 实测说明），两列空属常态、不能推断送转，按官方每股现金累计；
 * - 同一除息日多来源重复登记只取一条（官方优先），避免把同一笔派息加两遍。
 */
async function loadDividendWindow({ instrumentIds, windowStart, asOfDate, market }, tx) {
  if (!instrumentIds.length) return new Map();
  // 送转比例取自官方分红接口。2026-11-05 实测：`hk/company/dividend` 对港股（含 01211、
  // 01171、00754 这些确实派过红股/转增的标的）不返回 bonusSharesFromProfit /
  // bonusSharesFromCapitalReserve，方案原文也不含送转；`cn/company/dividend` 才逐行下发（含 0）。
  // 所以港股「两列都空」是常态、不能推断发生过送转：官方每股现金本就是按当期股本单位
  // 公布的已实施金额，直接累计即可。若日后源端对港股下发了比例，仍按下面同一套因子折算。
  const hkDividend = String(market || '').toUpperCase() === 'HK';
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
  // 「采过分红但窗口内一笔都没有」与「从没采过」必须分开：前者是明确的"近 12 个月无现金分红"
  // （可判不通过），后者才可能是数据缺失。判"采过"的证据有两条：
  //   ①该证券有任意分红历史记录；②该证券所属公司有财报——补数是同一任务里一起采的，
  //   财报采到了说明分红接口也请求过（新股接口返回空则是"确实没分红"，不是"没采"）。
  const history = await exec(`
      SELECT instrument_id FROM fundamental.corporate_actions
       WHERE instrument_id = ANY($1::bigint[]) AND action_type = 'dividend'
      UNION
      SELECT ci.instrument_id
        FROM core.company_instruments ci
        JOIN fundamental.financial_reports r ON r.company_id = ci.company_id
       WHERE ci.instrument_id = ANY($1::bigint[]) AND ci.relation_type = 'issued_by'`, [instrumentIds]);
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
    let currencyMixed = false;
    let unitUnverified = false;
    let hasSplitRatio = false;
    for (const row of rows) {
      const bonus = row.stock_dividend_ratio === null ? null : Number(row.stock_dividend_ratio);
      const cap = row.capitalization_ratio === null ? null : Number(row.capitalization_ratio);
      const cashValue = row.cash_per_share_pre_tax === null ? null : Number(row.cash_per_share_pre_tax);
      // A 股源逐行下发比例（含 0），两列都空 = 这一笔有没有送转不知道 → 整只标未核验，不猜。
      // 港股源未下发比例，两列空是常态，不能据此推断送转；官方每股现金按当期股本单位给出。
      if (!hkDividend && bonus === null && cap === null) unitUnverified = true;
      if (bonus !== null || cap !== null) hasSplitRatio = true;
      const change = (bonus || 0) + (cap || 0);
      // 本行的送转同样作用于本行现金：除权后股数才变多，所以本行现金要除以含本行的因子。
      if (change > 0) factor *= 1 + change;
      if (cashValue === null || cashValue <= 0) continue;
      perShare = (perShare || 0) + cashValue / factor;
      count += 1;
      if (row.total_cash_amount !== null && Number(row.total_cash_amount) > 0) {
        totalCash = (totalCash || 0) + Number(row.total_cash_amount);
      }
      // 币种不能只留第一条（F09）：同一窗口里混着 USD 与 HKD 的派息，
      // 相加得到的"每股股息"没有量纲，除价格算出来的股息率是错的。
      const rowCurrency = row.currency_code ? String(row.currency_code).toUpperCase() : null;
      if (rowCurrency) {
        if (!currency) currency = rowCurrency;
        else if (currency !== rowCurrency) currencyMixed = true;
      }
    }
    map.set(key, {
      ttmPerShare: perShare,
      count,
      currency,
      currencyMixed,
      totalCash,
      shareUnitUnverified: unitUnverified,
      // 口径留证按实际数据判定，不按市场一刀切：源端给了比例（哪怕将来港股开始给）就走折算，
      // 港股两列全空才按官方每股现金直接累计；A 股维持既有留证值。
      shareUnitBasis: hkDividend && !hasSplitRatio ? 'official_per_share_hk' : 'verified_split_ratio',
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
async function loadAnnualDividends({ companyIds, asOfDate, availableBefore, market }, tx) {
  if (!companyIds.length) return new Map();
  const exec = executorOf(tx);
  // 金额口径按市场分流（2026-11-05 生产实证）：港股分红多数只有「每股现金」、没有总额，
  // 沿用 A 股的 total_cash_amount 会被判成「已实施但金额缺失」→ 永远待补
  // （01919.HK 46 笔分红全部有每股现金、只有 10 笔有总额）。港股改用每股现金同口径累计：
  // 只在同一公司内部逐财年比较，不跨公司、不与总额口径混用；A 股仍按总额。
  const perShareBasis = String(market || '').toUpperCase() === 'HK';
  const amountExpr = perShareBasis ? 'ca.cash_per_share_pre_tax' : 'ca.total_cash_amount';
  // 官方会返回"已实施、已除息、但每股金额与总金额都是空"的记录（多见于中期分红），
  // 这种行不携带任何金额信息，不能算成"实施但金额缺失"——否则同财年里一笔年度分红已经拿到，
  // 整年仍被判未知（177 只曾因此在年度异常上永远待补）。
  const visibleCash = perShareBasis
    ? `(ca.cash_per_share_pre_tax IS NOT NULL)`
    : `(ca.cash_per_share_pre_tax IS NOT NULL OR ca.total_cash_amount IS NOT NULL)`;
  // 纯送转方案（只有送股/转增比例、没有一分现金）也算「已实施」：它的现金分红就是 0。
  // 不这样算的话，年末那笔转增进不了实现集合，"财年末已实施"恒为 0，该财年永远判未知
  // （2026-11-08 生产实测 600959 的 2015：中期 0.16 元已实施、年末 10 转 3 无现金，整年挂了多年）。
  const pureTransfer = `(ca.cash_per_share_pre_tax IS NULL AND ca.total_cash_amount IS NULL
    AND (COALESCE(ca.stock_dividend_ratio, 0) > 0 OR COALESCE(ca.capitalization_ratio, 0) > 0))`;
  const implemented = `ca.status = '实施' AND ca.ex_date IS NOT NULL AND ca.ex_date <= $2::date AND (${visibleCash} OR ${pureTransfer})`;
  // 明确零分红：官方把"该财年不派现"落成「股东大会通过 + 每股 0 + 无除息日」，
  // 实施且每股 0 同理。只认"实施"会把这类年份判成未知（福莱特 2024/2022/2021/2019 都是这样），
  // 实际上方案已定、就是不分红。预案（board_director_plan）仍属未定，不在此列。
  const explicitZero = `ca.status IN ('实施', '股东大会通过') AND ca.ex_date IS NULL AND COALESCE(ca.cash_per_share_pre_tax, 0) = 0`;
  // 跨财年判重指纹（2026-11-08）：同一笔分红被标成两个财年时金额相同，可以合并；
  // 金额不同就是两笔真实的钱（601966 的 2024 年报 0.014 元与 2025 一季报 0.070 元同为 2025-07-10 除息）。
  // 用「总额优先、退到每股」的文本指纹，同一笔在两个来源间口径统一时能对上。
  const amountKey = `COALESCE(ca.total_cash_amount::text, ca.cash_per_share_pre_tax::text, '0')`;
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
    ), visible_actions AS (
      -- 可见性先于去重：同一笔分红备源公告更晚时，不能因为"官方那条还没到公告日"
      -- 就把一条本来可见的记录整笔丢掉，否则旧季度会把已可见分红当成"该年没有分红"。
      SELECT ca.*
        FROM fundamental.corporate_actions ca
       WHERE ca.action_type = 'dividend'
         AND (
           (ca.announced_at IS NOT NULL AND ca.announced_at < $2::date)
           OR (ca.announced_at IS NULL AND ca.ex_date IS NOT NULL AND ca.ex_date <= $2::date)
         )
    ), same_fiscal_year AS (
      -- 第一步：同一财年 + 同一除息日 就是同一笔，跨来源只留官方那条（source_id 大）。
      -- 财年相同的两条不论金额是否一致都要合并：2026-11-08 生产实测同财年重复组 321 个，
      -- 其中 147 组两个来源金额不一致（一条写 0、一条写空，或港股 0.034 与 0.046），
      -- 按金额判重会在这些组里各留两行、把同一笔钱算两遍。
      SELECT DISTINCT ON (ca.instrument_id, ca.ex_date, ca.fiscal_period_end) ca.*
        FROM visible_actions ca
       WHERE ca.ex_date IS NOT NULL AND ca.fiscal_period_end IS NOT NULL
       ORDER BY ca.instrument_id, ca.ex_date, ca.fiscal_period_end, ca.source_id DESC
    ), same_day_no_fy AS (
      -- 缺财年的备源行（港股常见）：只有同一证券同一除息日完全没有带财年的记录时才留，
      -- 否则它就是上面那条的重复登记；留着会让这笔钱被算两遍。
      SELECT DISTINCT ON (ca.instrument_id, ca.ex_date) ca.*
        FROM visible_actions ca
       WHERE ca.ex_date IS NOT NULL AND ca.fiscal_period_end IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM visible_actions other
            WHERE other.instrument_id = ca.instrument_id
              AND other.ex_date = ca.ex_date
              AND other.fiscal_period_end IS NOT NULL)
       ORDER BY ca.instrument_id, ca.ex_date, ca.source_id DESC
    ), dedup_actions AS (
      -- 第二步：同证券同除息日但分属不同财年的记录，金额相同 → 同一笔重复打标，留较早财年那条；
      -- 金额不同 → 两笔真实的钱，都保留（2026-11-08 生产实测 601966，原按除息日一刀切把年报那笔吞掉，
      -- 该财年因此永远判"分红未知"；全库同类 22 组）。
      SELECT DISTINCT ON (ca.instrument_id, ca.ex_date, ${amountKey}) ca.*
        FROM same_fiscal_year ca
       ORDER BY ca.instrument_id, ca.ex_date, ${amountKey}, ca.fiscal_period_end ASC, ca.source_id DESC
    ), ca_kept AS (
      SELECT * FROM dedup_actions
      UNION ALL
      SELECT * FROM same_day_no_fy
      UNION ALL
      -- 无除息日的行（官方"该财年不派现"= 实施 + 每股 0）不参与按除息日去重，原样保留。
      SELECT * FROM visible_actions WHERE ex_date IS NULL
    ), per_instrument AS (
      -- 以「公司实际年报期末」为主表（2026-11-04 口径）：财报采到了就证明这家公司被采集过，
      -- 某个财年一笔分红记录都没有，就是该财年**确实没有分红事件**，判 0 而不是未知。
      -- 原实现从 corporate_actions 出发，无记录的财年根本不出行，于是永远挂在"年度分红未知"上。
      SELECT ci.company_id,
             date_part('year', ae.period_end)::int AS fiscal_year,
             ci.instrument_id,
             SUM(CASE WHEN ${implemented} THEN COALESCE(${amountExpr}, 0) ELSE 0 END) AS implemented_cash,
             COUNT(ca.action_id) FILTER (WHERE ${implemented})::int AS implemented_count,
             -- 纯送转方案（只有送股/转增比例、没有一分现金）的现金分红就是 0，不算"金额缺失"：
             -- 2026-11-08 生产实测全库 804 条「实施但现金全空」里 800 条带送转比例
             -- （600959 的 2015 是 10 转 3，cash 全空但 capitalization_ratio=0.3），
             -- 把它们当"没采到"会让这类年份永远挂在待补上。
             COUNT(ca.action_id) FILTER (WHERE ${implemented} AND ${amountExpr} IS NULL
               AND COALESCE(ca.stock_dividend_ratio, 0) = 0
               AND COALESCE(ca.capitalization_ratio, 0) = 0)::int AS amount_missing_count,
             -- 「已实施但完全没有金额」既不是零分红也不是已知金额（R4-04 对照用例）：
             -- 官方偶尔只给状态、不给钱数，这种年份必须保持未知，不能被后面的"预案判零"规则吞掉。
             -- 只认"连除息日都没有"的空实施记录：官方会给一批「实施 + 无金额 + 有除息日」的
             -- 中期空记录，它们不携带任何金额信息（2026-11-05 口径），不能反过来把整年判未知；
             -- 而同财年已有真实年度分红时必须仍然算已知。
             COUNT(ca.action_id) FILTER (WHERE ca.status = '实施' AND ca.ex_date IS NULL
               AND ca.cash_per_share_pre_tax IS NULL AND ca.total_cash_amount IS NULL)::int AS amount_unknown_count,
             -- 「财年末那笔已实施」必须落到本财年期末所在月份，不能用"本财年有过任何一笔实施"代替（R5-02）：
             -- 只有中期分红而年末尚未公告时，该财年仍是未知，不是零分红。
             -- 判据用**同年月**而非精确相等（2026-11-08 生产实测）：港股早年分红记录的
             -- fiscal_period_end 被记成月初（2015-12-01），年报期末是月末（2015-12-31），
             -- 精确相等会把已实施的末期股息当成"只有中期"，整年永远挂在分红未知上
             -- （港股 96 只挂 2015/2016，正是这一位之差）。同年月既不把中期分红
             -- （财年中期 9-30 对期末 12-31）算成末期，也不再依赖"日"这一位的来源差异。
             COUNT(ca.action_id) FILTER (WHERE ${implemented}
               AND date_trunc('month', ca.fiscal_period_end) = date_trunc('month', ae.period_end))::int AS year_end_implemented_count,
             COUNT(ca.action_id) FILTER (WHERE ca.action_id IS NOT NULL AND NOT (${implemented}))::int AS not_implemented_count,
             -- 财年期末已过 2 年以上、状态仍停在预案/股东大会通过且该财年从未实施：
             -- 这种历史方案就是"没有落地"，再等也不会变，与"金额未知"要分开。
             COUNT(ca.action_id) FILTER (WHERE ca.status IN ('预案', '股东大会通过')
               AND ca.fiscal_period_end <= ($2::date - INTERVAL '2 years'))::int AS stale_plan_count,
             COUNT(ca.action_id) FILTER (WHERE ${explicitZero})::int AS year_zero_count,
             BOOL_OR(${implemented}) AS has_any_implemented,
             COUNT(ca.action_id)::int AS event_count,
             -- 「零分红」只在财年已经充分尘埃落定时成立：年报出了不等于分红已经公布，
             -- 分红方案公告晚于年报、甚至跨年才实施都常见。给足 1 年，避免把"尚未公告"误判成"没有分红"。
             BOOL_OR(ae.period_end <= ($2::date - INTERVAL '1 year')) AS fiscal_year_settled
        FROM annual_ends ae
        JOIN core.company_instruments ci ON ci.company_id = ae.company_id AND ci.relation_type = 'issued_by'
        -- 按「证券 + 财年」关联，而不是按 period_end 精确相等（R5-02）：
        -- 中期分红的 fiscal_period_end 是期中日期，精确相等会让它以"该财年一笔记录都没有"的身份消失，
        -- 于是"只有中期记录"被误判成"该财年零分红"。
        LEFT JOIN ca_kept ca
          ON ca.instrument_id = ci.instrument_id
         AND ca.fiscal_period_end IS NOT NULL
         AND date_part('year', ca.fiscal_period_end) = date_part('year', ae.period_end)
       WHERE ci.company_id = ANY($1::bigint[])
       GROUP BY 1, 2, 3
    )
    SELECT company_id, fiscal_year,
           MAX(implemented_cash) AS implemented_cash,
           SUM(implemented_count)::int AS implemented_count,
           SUM(amount_missing_count)::int AS amount_missing_count,
           SUM(amount_unknown_count)::int AS amount_unknown_count,
           SUM(not_implemented_count)::int AS not_implemented_count,
           SUM(stale_plan_count)::int AS stale_plan_count,
           SUM(year_zero_count)::int AS year_zero_count,
           SUM(event_count)::int AS event_count,
           BOOL_OR(fiscal_year_settled) AS fiscal_year_settled,
           BOOL_OR(has_any_implemented) AS has_any_implemented,
           SUM(year_end_implemented_count)::int AS year_end_implemented_count
      FROM per_instrument
     GROUP BY 1, 2`, [companyIds, asOfDate, availableBefore || null]);
  const map = new Map();
  rows.forEach(row => {
    const key = String(row.company_id);
    const list = map.get(key) || [];
    const implementedCount = Number(row.implemented_count || 0);
    const amountMissing = Number(row.amount_missing_count || 0);
    const amountUnknown = Number(row.amount_unknown_count || 0);
    const notImplemented = Number(row.not_implemented_count || 0);
    const yearZero = Number(row.year_zero_count || 0);
    const stalePlan = Number(row.stale_plan_count || 0);
    const eventCount = Number(row.event_count || 0);
    // 完整证据 = 财年末那笔已实施已除息 + 该年所有已实施记录金额都不缺；
    // 或者官方明确给出"该财年零股息"（实施 + 每股 0 + 无除息日）；
    // 或者该财年只有"预案/股东大会通过"、且财年期末已过 2 年以上仍从未实施——
    // 或者该财年**一笔分红记录都没有**：财报采到了就说明这家公司被采集过，
    // 缺记录就是该财年确实没有分红事件（2026-11-04 口径，按真实计 0）。
    const yearEndImplemented = Number(row.year_end_implemented_count || 0) > 0;
    // 金额未知优先：只要有"已实施但完全没有金额"的记录，该财年就是未知（R4-04）。
    const amountIncomplete = amountMissing > 0 || amountUnknown > 0;
    const knownFromImplemented = implementedCount > 0 && !amountIncomplete && yearEndImplemented;
    const knownFromZero = yearZero > 0 && !amountIncomplete;
    // 末期方案停摆 2 年以上仍未实施 → 视为该财年不会再有第二次分红，按已知处理；
    // 即使该财年已有中期实施也成立（2026-11-08 生产实测 002648 的 2022：中期 0.4 元已实施，
    // 年报方案停在「预案」三年，原先因 implementedCount>0 被判成 interim_only 永远待补）。
    // 末期那笔真正实施后 stalePlan 归零，会改走 knownFromImplemented，不会互相打架。
    const knownFromStalePlan = !amountIncomplete && stalePlan > 0 && !yearEndImplemented;
    const knownFromNoEvent = eventCount === 0 && row.fiscal_year_settled === true;
    // 有记录、但一条都没走到实施（只剩预案/股东大会通过）→ 2026-11-04 口径判零分红。
    // 与「金额缺失」区分：amountIncomplete 说明实施记录确实存在、只是金额没采到，那才是未知。
    // 只有预案/股东大会通过时判零分红有前提：该财年已经尘埃落定（期末早于目标日 1 年以上），
    // 或方案已停摆 2 年以上仍未实施。财年还没到期的预案仍按未知——它后面还可能真的实施一笔。
    const knownFromPlanOnly = implementedCount === 0 && !amountIncomplete && eventCount > 0
      && (row.fiscal_year_settled === true || stalePlan > 0);
    const known = knownFromImplemented || knownFromZero || knownFromStalePlan || knownFromNoEvent || knownFromPlanOnly;
    list.push({
      year: Number(row.fiscal_year),
      dividend: known ? Number(row.implemented_cash || 0) : null,
      eventCount: implementedCount + notImplemented,
      dividendKnown: known,
      // 留证：港股按每股现金、A 股按总额；同一公司内部同口径比较，不跨市场混用。
      amountBasis: perShareBasis ? 'per_share' : 'total_amount',
      dividendBasis: knownFromImplemented ? 'annual_implemented_amount'
        : knownFromZero ? (implementedCount > 0 ? 'interim_plus_verified_zero' : 'verified_zero_dividend')
          : knownFromStalePlan ? 'stale_plan_not_implemented'
            : knownFromNoEvent ? 'no_dividend_event_in_fiscal_year'
              : knownFromPlanOnly ? 'plan_not_implemented_zero'
                : amountIncomplete ? 'implemented_amount_missing'
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

/**
 * 逐日日历证据（方案 27.5 第 1 条 / 27.6）：返回区间内**全部**日历行（含休市），
 * 由上层区分「整周期休市」与「日历缺档」。loadCalendar 的原语义（只返回开市日）
 * 被 V1 季度与回测复用，不能就地改返回结构。
 */
async function loadCalendarEvidence({ market, fromDate, toDate }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT trade_date::text AS trade_date, COALESCE(is_open, true) AS is_open
      FROM market.trade_calendar
     WHERE exchange = ANY($1::text[]) AND trade_date >= $2::date AND trade_date <= $3::date
     ORDER BY trade_date`, [config.calendarExchanges, fromDate, toDate]);
  return rows.map(row => ({ trade_date: row.trade_date, is_open: row.is_open !== false }));
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

/** 期末估值用收盘价（F10）：调仓按开盘价成交，但区间末净值必须按当日收盘估值，
 *  否则请求到 9-30 的回测会把最后净值停在 7-01。 */
async function loadClosePrices({ instrumentIds, dates }, tx) {
  if (!instrumentIds.length || !dates.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT instrument_id, trade_date::text AS trade_date, close
      FROM market.daily_bars
     WHERE instrument_id = ANY($1::bigint[]) AND trade_date = ANY($2::date[])`, [instrumentIds, dates]);
  const map = new Map();
  rows.forEach(row => map.set(`${row.instrument_id}|${row.trade_date}`, row.close === null ? null : Number(row.close)));
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
  // 同一经济事件被两个来源同时落库时不能双计（F10）；同一证券同一天也可能有两笔分属不同财年的
  // 分红（2026-11-08 生产实测 601966：2024 年报 0.014 元与 2025 一季报 0.070 元同为 2025-07-10 除息）。
  // 因此先去「财年 + 除息日」这一层（同财年不论金额都合并），再只合并跨财年且金额完全相同的重复打标。
  const { rows } = await exec(`
    SELECT instrument_id, SUM(cash_per_share_pre_tax) AS per_share
      FROM (
        SELECT DISTINCT ON (d.instrument_id, d.ex_date, d.amount_key)
               d.instrument_id, d.ex_date, d.cash_per_share_pre_tax
          FROM (
            SELECT DISTINCT ON (ca.instrument_id, ca.ex_date, ca.fiscal_period_end)
                   ca.instrument_id, ca.ex_date, ca.fiscal_period_end, ca.cash_per_share_pre_tax,
                   COALESCE(ca.total_cash_amount::text, ca.cash_per_share_pre_tax::text, '0') AS amount_key
              FROM fundamental.corporate_actions ca
             WHERE ca.instrument_id = ANY($1::bigint[])
               AND ca.action_type = 'dividend'
               AND ca.status = '实施'
               AND ca.ex_date IS NOT NULL
               AND ca.ex_date > $2::date AND ca.ex_date <= $3::date
               AND ca.cash_per_share_pre_tax > 0
             ORDER BY ca.instrument_id, ca.ex_date, ca.fiscal_period_end, ca.source_id DESC
          ) d
         ORDER BY d.instrument_id, d.ex_date, d.amount_key, d.fiscal_period_end ASC
      ) e
     GROUP BY 1`, [instrumentIds, fromDate, toDate]);
  return new Map(rows.map(row => [String(row.instrument_id), Number(row.per_share)]));
}

/**
 * 逐日分红事件（除息日 → 每股税前现金）：逐日 NAV 回测必须把分红记在真实除息日，
 * 不能在期末一次性累加，否则区间内现金曲线与再投资路径都不对。
 * 与 loadDividendCash 同一去重口径：先去「财年 + 除息日」，再只合并跨财年金额相同的重复打标；
 * 同一天的两笔不同财年分红（金额不同）各记一次，否则逐日现金曲线会少一笔。
 */
async function loadDividendEvents({ instrumentIds, fromDate, toDate }, tx) {
  if (!instrumentIds.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT DISTINCT ON (e.instrument_id, e.ex_date, e.amount_key)
           e.instrument_id, e.ex_date::text AS ex_date, e.cash_per_share_pre_tax AS per_share
      FROM (
        SELECT DISTINCT ON (ca.instrument_id, ca.ex_date, ca.fiscal_period_end)
               ca.instrument_id, ca.ex_date, ca.fiscal_period_end, ca.cash_per_share_pre_tax,
               COALESCE(ca.total_cash_amount::text, ca.cash_per_share_pre_tax::text, '0') AS amount_key
          FROM fundamental.corporate_actions ca
         WHERE ca.instrument_id = ANY($1::bigint[])
           AND ca.action_type = 'dividend'
           AND ca.status = '实施'
           AND ca.ex_date IS NOT NULL
           AND ca.ex_date > $2::date AND ca.ex_date <= $3::date
           AND ca.cash_per_share_pre_tax > 0
         ORDER BY ca.instrument_id, ca.ex_date, ca.fiscal_period_end, ca.source_id DESC
      ) e
     ORDER BY e.instrument_id, e.ex_date, e.amount_key, e.fiscal_period_end ASC`,
  [instrumentIds, fromDate, toDate]);
  const byDate = new Map();
  rows.forEach(row => {
    if (!byDate.has(row.ex_date)) byDate.set(row.ex_date, []);
    byDate.get(row.ex_date).push({ instrumentId: Number(row.instrument_id), perShare: Number(row.per_share) });
  });
  return byDate;
}

/**
 * 日线窗口（开/高/低/收/量/额）：撮合约束（停牌、涨跌停、容量）与逐日估值共用一次批量读取。
 * 调用方把起始日提前若干天，才能拿到第一个信号日的前收盘价。
 */
async function loadBarWindow({ instrumentIds, fromDate, toDate }, tx) {
  if (!instrumentIds.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT instrument_id, trade_date::text AS trade_date, open, high, low, close, volume, amount
      FROM market.daily_bars
     WHERE instrument_id = ANY($1::bigint[]) AND trade_date >= $2::date AND trade_date <= $3::date
     ORDER BY instrument_id, trade_date`, [instrumentIds, fromDate, toDate]);
  const map = new Map();
  rows.forEach(row => {
    const key = String(row.instrument_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      tradeDate: row.trade_date,
      open: row.open === null ? null : Number(row.open),
      high: row.high === null ? null : Number(row.high),
      low: row.low === null ? null : Number(row.low),
      close: row.close === null ? null : Number(row.close),
      volume: row.volume === null ? null : Number(row.volume),
      amount: row.amount === null ? null : Number(row.amount),
    });
  });
  return map;
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

/** 已登记策略的当前 id（取最新生效版本）；没登记过返回 null，不自动创建。 */
async function findStrategyId({ market, strategyCode }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT strategy_id FROM analytics.stock_selection_strategies
     WHERE market = $1 AND strategy_code = $2
     ORDER BY effective_from DESC NULLS LAST, strategy_id DESC LIMIT 1`, [market, strategyCode]);
  return rows[0] ? Number(rows[0].strategy_id) : null;
}

async function findRunByIdempotencyKey(tx, { strategyId, market, asOfDate, runKind, inputHash, ownerUsername, ownerSubjectId, periodType, isShadow }) {
  const exec = executorOf(tx);
  // 影子与正式是两个渠道：同输入也不能互相复用（方案 27.8），周期类型参与身份但缺省按 V1 口径。
  // 主体（迁移187 的 users.subject_id）参与身份：账号删除重建后同名不能继承旧结果（方案 27.9）。
  const { rows } = await exec(`
    SELECT run_id FROM analytics.stock_selection_runs
     WHERE strategy_id = $1 AND market = $2 AND as_of_date = $3::date AND run_kind = $4
       AND COALESCE(period_type, 'quarter') = COALESCE($7, 'quarter')
       AND is_shadow = $8
       AND input_hash = $5 AND COALESCE(owner_username,'') = COALESCE($6,'')
       AND ($9::text IS NULL OR COALESCE(owner_subject_id::text,'') = $9::text)
     LIMIT 1`,
  [strategyId, market, asOfDate, runKind, inputHash, ownerUsername || null, periodType || null, isShadow === true,
    ownerSubjectId || null]);
  return rows[0] ? Number(rows[0].run_id) : null;
}

/**
 * 修订域：季度、日、周各自递增（方案 27.7「非影子正式 revision 在同市场/策略/类型/周期内递增」）。
 * 季度与日/周不能共用同一分支：季度也带 period_type/period_key，若只用日/周过滤条件，
 * MAX 会恒为 0，第二次修订又从 1 开始并撞旧季度唯一索引（AC-02）。
 */
async function nextRevision(tx, { market, quarter, strategyId, periodType, periodKey, runKind }) {
  const exec = executorOf(tx);
  const type = periodType || (runKind === 'quarterly' ? 'quarter' : null);
  if (type === 'quarter' || runKind === 'quarterly') {
    // V1 只写 quarter（period_key 可能尚未回填），V2 写 period_key；两种身份都要能匹配到同一域。
    const key = periodKey || (quarter ? `Q:${quarter}` : null);
    const { rows } = await exec(`
      SELECT COALESCE(MAX(revision), 0)::int AS max_revision
        FROM analytics.stock_selection_runs
       WHERE market = $1 AND strategy_id = $2 AND run_kind = 'quarterly' AND is_shadow = false
         AND (
           ($3::text IS NOT NULL AND period_key = $3::text)
           OR ($4::text IS NOT NULL AND quarter = $4::text)
         )`,
    [market, strategyId, key, quarter || null]);
    return Number(rows[0].max_revision || 0) + 1;
  }
  if (type === 'day' || type === 'week') {
    const kind = runKind || (type === 'day' ? 'daily' : 'weekly');
    const { rows } = await exec(`
      SELECT COALESCE(MAX(revision), 0)::int AS max_revision
        FROM analytics.stock_selection_runs
       WHERE market = $1 AND strategy_id = $2 AND run_kind = $3
         AND period_type = $4 AND period_key = $5 AND is_shadow = false`,
    [market, strategyId, kind, type, periodKey]);
    return Number(rows[0].max_revision || 0) + 1;
  }
  const { rows } = await exec(`
    SELECT COALESCE(MAX(revision), 0)::int AS max_revision
      FROM analytics.stock_selection_runs
     WHERE market = $1 AND quarter = $2 AND strategy_id = $3 AND run_kind = 'quarterly'`,
  [market, quarter, strategyId]);
  return Number(rows[0].max_revision || 0) + 1;
}

async function insertRun(tx, run) {
  const exec = executorOf(tx);
  // V2 周期默认值：V1 调用只传 runKind/quarter，也要落到同一套周期语义，不能留 NULL 让筛选漏掉旧批次。
  const periodType = run.periodType || (run.runKind === 'quarterly' ? 'quarter' : null);
  const periodKey = run.periodKey || (run.runKind === 'quarterly' && run.quarter ? `Q:${run.quarter}` : null);
  const { rows } = await exec(`
    INSERT INTO analytics.stock_selection_runs
      (strategy_id, market, run_kind, owner_username, quarter, as_of_date, knowledge_cutoff,
       execution_status, quality_status, business_status, input_hash, input_manifest,
       universe_count, pending_count, selected_count, market_pb, market_pe, benchmark_code,
       valuation_method, position_ratio, budget_ratio, revision, published_at, supersedes_run_id, request_id,
       period_type, period_key, period_start, period_end, source_daily_run_id,
       settings_revision, settings_hash, owner_subject_id, revision_reason, computed_at, is_shadow)
    VALUES ($1,$2,$3,$4,$5,$6::date,$7::timestamptz,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
            $26,$27,$28::date,$29::date,$30,$31,$32,$33,$34,$35::timestamptz,$36)
    RETURNING run_id`, [
    run.strategyId, run.market, run.runKind, run.ownerUsername || null, run.quarter || null,
    run.asOfDate, run.knowledgeCutoff, run.executionStatus, run.qualityStatus, run.businessStatus,
    run.inputHash, JSON.stringify(run.inputManifest || {}), run.universeCount, run.pendingCount,
    run.selectedCount, run.marketPb, run.marketPe, run.benchmarkCode, run.valuationMethod,
    run.positionRatio, run.budgetRatio, run.revision, run.publishedAt || null,
    run.supersedesRunId || null, run.requestId || null,
    periodType, periodKey, run.periodStart || null, run.periodEnd || null,
    run.sourceDailyRunId || null, run.settingsRevision === undefined ? null : run.settingsRevision,
    run.settingsHash || null, run.ownerSubjectId || null, run.revisionReason || null,
    run.computedAt || null, run.isShadow === true,
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
    // V2 判定与证据列（V1 行写 null，不伪造）
    'historical_pb_min', 'pb_positive_extrema_ratio', 'pb_pe_product',
    'valuation_status', 'valuation_pass_reason', 'ttm_profit_status', 'rank_ready',
    'rank_block_reasons', 'pb_covered_days', 'pb_expected_days', 'pb_gap_days', 'pb_history_years',
  ];
  const JSON_COLUMNS = new Set(['exclusion_reasons', 'detail', 'rank_block_reasons']);
  const INT_COLUMNS = new Set(['pb_covered_days', 'pb_expected_days', 'pb_gap_days']);
  const DATE_COLUMNS = new Set(['fx_date']);
  // 一次写入全部列：filter_status / data_quality_status 是 NOT NULL，必须与行同批落库。
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let p = 1;
    chunk.forEach(item => {
      values.push('(' + insertColumns.map(name => {
        const position = `$${p++}`;
        if (JSON_COLUMNS.has(name)) return `${position}::jsonb`;
        if (DATE_COLUMNS.has(name)) return `${position}::date`;
        return position;
      }).join(',') + ')');
      const coverage = item.pbCoverage || (item.detail && item.detail.pbWindow) || {};
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
          // V2：排名受阻原因必须随快照持久化（方案 27.4），不能只留内存字段。
          rankBlockReasons: item.rankBlockReasons || [],
          riskStatus: item.riskStatus || null,
          valuationStatus: item.valuationStatus === undefined ? null : item.valuationStatus,
          valuationPassReason: item.valuationPassReason === undefined ? null : item.valuationPassReason,
          ttm: item.detail && item.detail.ttm ? item.detail.ttm : null,
          // TTM 血缘证据（三段报表 + 公式）必须随快照持久化，不能只留一个状态字符串。
          ttmEvidenceRef: item.ttmEvidenceRef || null,
          ttmStatusBasis: item.ttmStatusBasis || null,
        })),
        item.historicalPbMin === undefined ? null : item.historicalPbMin,
        item.pbPositiveExtremaRatio === undefined ? null : item.pbPositiveExtremaRatio,
        item.pbPeProduct === undefined ? null : item.pbPeProduct,
        item.valuationStatus === undefined ? null : item.valuationStatus,
        item.valuationPassReason === undefined ? null : item.valuationPassReason,
        item.ttmProfitStatus || null,
        item.rankReady === undefined ? null : item.rankReady === true,
        JSON.stringify(item.rankBlockReasons || []),
        toNullableInt(coverage.coveredDays, INT_COLUMNS),
        toNullableInt(coverage.expectedDays, INT_COLUMNS),
        toNullableInt(coverage.gapDays, INT_COLUMNS),
        coverage.historyYears === undefined || coverage.historyYears === null ? null : Number(coverage.historyYears),
      );
    });
    await exec(`
      INSERT INTO analytics.stock_selection_candidates (${insertColumns.join(', ')})
      VALUES ${values.join(',')}
      ON CONFLICT (run_id, instrument_id) DO NOTHING`, params);
  }
}

/** NUMERIC/INTEGER 列只接受可解析数字：undefined/null/NaN 统一写 NULL，不写 0。 */
function toNullableInt(value, _columns) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function insertMembers(tx, runId, members) {
  if (!members.length) return;
  const exec = executorOf(tx);
  const values = [];
  const params = [];
  let p = 1;
  members.forEach(member => {
    values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb)`);
    params.push(runId, member.instrumentId, member.slotNo, member.industry ? member.industry.code : null,
      member.industry ? member.industry.system : null, member.industry ? member.industry.version : null,
      member.weightInMarketBudget, member.weightInEquityTarget, !!member.issuerDuplicate,
      member.weightInInvestedEquity === undefined ? null : member.weightInInvestedEquity,
      JSON.stringify({ selectionOrder: member.selectionOrder || null, code: member.code, name: member.name || null }));
  });
  await exec(`
    INSERT INTO analytics.stock_selection_portfolio_members
      (run_id, instrument_id, slot_no, industry_code, industry_system, industry_version,
       weight_in_market_budget, weight_in_equity_target, issuer_duplicate, weight_in_invested_equity, detail)
    VALUES ${values.join(',')}
    ON CONFLICT (run_id, instrument_id) DO NOTHING`, params);
}

/** 只有共享正式渠道可写发布指针；预览/回测/个人属诊断产物（方案 27.7）。 */
const PUBLISHABLE_RUN_KINDS = new Set(['quarterly', 'daily', 'weekly']);

/**
 * 发布前的执行身份校验（方案 27.7「发布前再次核验 slot_id、mode/market、当前租约与 executionToken」）。
 * 手动管理入口不带槽位，不臆造租约；但只要给了 slotId 或 token 之一，两者都必须真实有效。
 */
async function assertPublishLease(exec, options) {
  const slotId = options.slotId === undefined || options.slotId === null || options.slotId === '' ? null : Number(options.slotId);
  const token = options.executionToken === undefined || options.executionToken === null ? '' : String(options.executionToken);
  if (slotId === null && !token) return { verified: false, reason: 'manual_without_slot' };
  if (slotId === null || !token) {
    const error = new Error('发布必须同时提供有效槽位与执行令牌');
    error.status = 409;
    throw error;
  }
  const { rows } = await exec(`
    SELECT slot_id, job_code, status, execution_token,
           (lease_until IS NOT NULL AND lease_until > clock_timestamp()) AS lease_ok
      FROM ops.job_schedule_slots WHERE slot_id = $1 FOR UPDATE`, [slotId]);
  const slot = rows[0];
  if (!slot) {
    const error = new Error('执行槽位不存在，不能发布');
    error.status = 409;
    throw error;
  }
  if (slot.job_code !== 'stock_analysis_refresh') {
    const error = new Error('执行槽位不属于选股任务');
    error.status = 409;
    throw error;
  }
  if (slot.status !== 'running') {
    const error = new Error('执行槽位不在运行中，不能发布');
    error.status = 409;
    throw error;
  }
  if (String(slot.execution_token || '') !== token) {
    const error = new Error('执行令牌与当前租约不一致');
    error.status = 409;
    throw error;
  }
  if (!slot.lease_ok) {
    const error = new Error('执行租约已过期，不能发布');
    error.status = 409;
    throw error;
  }
  return { verified: true };
}

/**
 * 正式发布（V2 加固）：范围锁 + 前一版本比较 + 当前指针 + 不可变事件，同一事务提交。
 * V1 调用只传 { market, quarter }，行为与原实现一致（季度渠道）；V2 日/周按 period_key 分渠道。
 * 影子批次、私人批次、非共享季度/周度一律不得写正式指针。
 */
async function publishRun(tx, runId, options = {}) {
  const exec = executorOf(tx);
  const targetResult = await exec(`
    SELECT run_id, market, strategy_id, run_kind, quarter, period_type, period_key,
           period_start::text AS period_start, period_end::text AS period_end,
           as_of_date::text AS as_of_date, revision, is_shadow, quality_status, input_hash
      FROM analytics.stock_selection_runs WHERE run_id = $1`, [runId]);
  const target = targetResult.rows[0];
  if (!target) {
    const error = new Error('批次不存在');
    error.status = 404;
    throw error;
  }
  if (target.is_shadow) {
    const error = new Error('影子批次不得写入正式发布指针');
    error.status = 409;
    throw error;
  }
  // 存储层白名单与服务层 isFormal 同口径：预览/回测/个人即使带合法 period_key 也不得发布（AC-09）。
  if (target.run_kind === 'personal') {
    const error = new Error('个人测算结果不得发布为公共组合');
    error.status = 409;
    throw error;
  }
  if (!PUBLISHABLE_RUN_KINDS.has(String(target.run_kind))) {
    const error = new Error('该类型批次不得发布为正式组合');
    error.status = 409;
    throw error;
  }
  // 执行身份校验：槽位必须仍在运行、令牌一致且租约未过期，否则拒绝移动正式指针（AC-04）。
  await assertPublishLease(exec, options);
  const periodType = target.period_type || 'quarter';
  const periodKey = target.period_key || (options.quarter && target.run_kind === 'quarterly' ? `Q:${options.quarter}` : null);
  if (!periodKey) {
    // 预览批次没有周期身份，原实现也不发布它们；这里显式拒绝而不是写一条无渠道的指针。
    const error = new Error('该批次没有可发布的周期身份');
    error.status = 409;
    throw error;
  }
  if (target.quality_status !== 'passed' && !options.allowPartial) {
    const error = new Error('质量未通过，不能发布正式组合');
    error.status = 409;
    throw error;
  }

  const lockKey = `stock_selection_publish:${target.market}:${target.strategy_id}:${periodType}:${periodKey}`;
  await exec(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);

  // 前一版本：同渠道已发布且 revision 更高时拒绝，防止旧批次覆盖新结论。
  const currentResult = await exec(`
    SELECT run_id, revision FROM analytics.stock_selection_runs
     WHERE market = $1 AND strategy_id = $2
       AND COALESCE(period_type, 'quarter') = $3 AND COALESCE(period_key, '') = $4
       AND is_shadow = false AND published_at IS NOT NULL AND run_id <> $5
     ORDER BY revision DESC, run_id DESC LIMIT 1`,
  [target.market, target.strategy_id, periodType, periodKey, runId]);
  const current = currentResult.rows[0] || null;
  const targetRevision = Number(target.revision || 0);
  if (current && Number(current.revision) >= targetRevision) {
    const error = new Error('该周期已有更新版本，本次发布未通过前一版本比较');
    error.status = 409;
    throw error;
  }
  // CAS：调用方若声明了期望旧指针，就必须真的匹配（首次发布对"无前驱"同样校验）。
  if (options.expectedRunId !== undefined && options.expectedRunId !== null
    && Number(options.expectedRunId) !== (current ? Number(current.run_id) : 0)) {
    const error = new Error('发布指针已被其他批次改变，请刷新后重试');
    error.status = 409;
    throw error;
  }

  await exec(`UPDATE analytics.stock_selection_runs SET published_at = now(), execution_status = 'succeeded' WHERE run_id = $1`, [runId]);

  const pointer = await exec(`
    INSERT INTO analytics.stock_selection_publications
      (market, strategy_id, period_type, period_key, period_start, period_end, run_id,
       pointer_revision, activated_at, actor, reason)
    VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,1,$8,$9,$10)
    ON CONFLICT (market, strategy_id, period_type, period_key) DO UPDATE
      SET run_id = EXCLUDED.run_id,
          period_start = COALESCE(EXCLUDED.period_start, analytics.stock_selection_publications.period_start),
          period_end = COALESCE(EXCLUDED.period_end, analytics.stock_selection_publications.period_end),
          pointer_revision = analytics.stock_selection_publications.pointer_revision + 1,
          activated_at = EXCLUDED.activated_at,
          -- 修订后的指针必须等本次提交的可见确认；沿用旧 visible_at 会把历史发布时刻回推给新版本（AC-05）
          visible_at = NULL,
          actor = EXCLUDED.actor,
          reason = EXCLUDED.reason
    RETURNING publication_id, pointer_revision`,
  [target.market, target.strategy_id, periodType, periodKey, target.period_start, target.period_end, runId,
    new Date(), options.actor || null, options.reason || null]);
  const pointerRow = pointer.rows[0] || {};

  // 不可变事件：真实发布历史由事件链推导，不改写旧事件的结束时间。
  const action = current ? 'correct' : 'publish';
  const eventResult = await exec(`
    INSERT INTO analytics.stock_selection_publication_events
      (market, strategy_id, period_type, period_key, action, from_run_id, to_run_id,
       from_strategy_id, to_strategy_id, pointer_revision, actor, subject_id, slot_id,
       execution_token, input_hash, reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$2,$2,$8,$9,$10,$11,$12,$13,$14)
    RETURNING event_id`,
  [target.market, target.strategy_id, periodType, periodKey, action,
    current ? Number(current.run_id) : null, runId, Number(pointerRow.pointer_revision || 1),
    options.actor || null, options.subjectId || null, options.slotId || null,
    options.executionToken || null, target.input_hash || null, options.reason || null]);

  return {
    published: true,
    previousRunId: current ? Number(current.run_id) : null,
    action,
    pointerRevision: Number(pointerRow.pointer_revision || 1),
    eventId: Number((eventResult.rows[0] || {}).event_id || 0),
    periodType,
    periodKey,
  };
}

/**
 * 提交后的可见确认：事务开始时的 now() 不能冒称"对外可见时刻"（方案 27.7）。
 * 由上层层在事务成功提交后调用；未取得确认时 real_publication_replay 不据此回推交易时刻。
 */
async function markPublicationVisible({ runId, eventId }, tx) {
  const exec = executorOf(tx);
  let eventConfirmed = false;
  if (eventId) {
    const updated = await exec(
      `UPDATE analytics.stock_selection_publication_events SET visible_at = now()
        WHERE event_id = $1 AND visible_at IS NULL RETURNING event_id`, [eventId]);
    eventConfirmed = updated.rows.length > 0;
    if (!eventConfirmed) {
      const existing = await exec(`SELECT visible_at FROM analytics.stock_selection_publication_events WHERE event_id = $1`, [eventId]);
      eventConfirmed = !!(existing.rows[0] && existing.rows[0].visible_at);
    }
  }
  const pointerUpdated = await exec(
    `UPDATE analytics.stock_selection_publications SET visible_at = now()
      WHERE run_id = $1 AND visible_at IS NULL RETURNING publication_id`, [runId]);
  let pointerConfirmed = pointerUpdated.rows.length > 0;
  if (!pointerConfirmed) {
    // 指针已被后续发布改写时，本次发布的可见确认不能算成功（返回 false 由上层记待补）。
    const existing = await exec(`SELECT visible_at FROM analytics.stock_selection_publications WHERE run_id = $1`, [runId]);
    pointerConfirmed = !!(existing.rows[0] && existing.rows[0].visible_at);
  }
  // 不再无条件返回 true：调用方必须能区分"确认成功"和"提交后可见时刻仍待补"（AC-05）。
  return { ok: pointerConfirmed, eventConfirmed, pointerConfirmed };
}

/** 当前发布指针（按渠道精确读取）；没有指针时返回 null，不猜。 */
async function findPublication({ market, strategyId, periodType, periodKey }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT p.publication_id, p.market, p.strategy_id, p.period_type, p.period_key,
           p.period_start::text AS period_start, p.period_end::text AS period_end,
           p.run_id, p.pointer_revision, p.activated_at, p.visible_at
      FROM analytics.stock_selection_publications p
     WHERE p.market = $1 AND ($2::bigint IS NULL OR p.strategy_id = $2::bigint)
       AND ($3::text IS NULL OR p.period_type = $3::text)
       AND ($4::text IS NULL OR p.period_key = $4::text)
     ORDER BY p.activated_at DESC, p.publication_id DESC LIMIT 1`,
  [market, strategyId || null, periodType || null, periodKey || null]);
  return rows[0] || null;
}

async function listPublicationEvents({ market, periodType, periodKey, limit = 50 }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT event_id, market, strategy_id, period_type, period_key, action,
           from_run_id, to_run_id, from_strategy_id, to_strategy_id, pointer_revision,
           actor, subject_id, slot_id, execution_token, input_hash, reason, occurred_at, visible_at
      FROM analytics.stock_selection_publication_events
     WHERE market = $1
       AND ($2::text IS NULL OR period_type = $2::text)
       AND ($3::text IS NULL OR period_key = $3::text)
     ORDER BY event_id DESC LIMIT $4`,
  [market, periodType || null, periodKey || null, limit]);
  return rows;
}

/**
 * 真实发布回放的证据（方案 27.7 生效历史 / 27.21 C04 / 27.23 E02）：按渠道返回**完整事件序列**，
 * 不是每个周期一条。首次发布、修订、回滚、激活/停用都要按发生顺序保留，
 * 回放时逐事件重建持仓区间；用 MAX(visible_at) 拼一条会把首次发布与它的持仓区间抹掉。
 * 同时带上目标批次的完成/质量/业务状态与选中计数：只有这些证据都在，才能区分
 * "已验证的零合格空仓"和"成员丢失/未知"（E02）。
 */
async function loadPublicationReplayEvidence({ market, periodType, periodKeys, strategyCode }, tx) {
  if (!periodKeys || !periodKeys.length) return new Map();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT e.period_key, e.event_id, e.action, e.to_run_id, e.from_run_id,
           e.visible_at, e.occurred_at, e.pointer_revision, e.actor, e.reason,
           r.execution_status, r.quality_status, r.business_status,
           r.selected_count, r.pending_count, r.universe_count
      FROM analytics.stock_selection_publication_events e
      JOIN analytics.stock_selection_strategies s ON s.strategy_id = e.strategy_id
      LEFT JOIN analytics.stock_selection_runs r ON r.run_id = e.to_run_id
     WHERE e.market = $1 AND e.period_type = $2 AND e.period_key = ANY($3::text[])
       AND e.action IN ('publish','correct','rollback','activate','deactivate')
       AND ($4::text IS NULL OR s.strategy_code = $4::text)
     ORDER BY e.period_key, e.occurred_at NULLS LAST, e.event_id`,
  [market, periodType, periodKeys, strategyCode || null]);
  const byPeriod = new Map();
  rows.forEach(row => {
    if (!byPeriod.has(row.period_key)) byPeriod.set(row.period_key, []);
    byPeriod.get(row.period_key).push(row);
  });
  return byPeriod;
}

async function markRunFailure(tx, runId, { executionStatus, qualityStatus, businessStatus }) {
  const exec = executorOf(tx);
  await exec(`
    UPDATE analytics.stock_selection_runs
       SET execution_status = $2, quality_status = $3, business_status = $4
     WHERE run_id = $1`, [runId, executionStatus, qualityStatus, businessStatus]);
}

// ========== 读接口 ==========

/** 某渠道是否已有正式（非影子）批次：自动排队只做去重，不判断要不要重算（方案 27.8）。 */
async function hasPeriodRun({ market, periodType, periodKey, strategyCode }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT 1 FROM analytics.stock_selection_runs r
      JOIN analytics.stock_selection_strategies s ON s.strategy_id = r.strategy_id
     WHERE r.market = $1 AND r.period_type = $2 AND r.period_key = $3
       AND r.is_shadow = false AND r.run_kind IN ('daily','weekly')
       AND ($4::text IS NULL OR s.strategy_code = $4::text)
     LIMIT 1`, [market, periodType, periodKey, strategyCode || null]);
  return rows.length > 0;
}

async function listRuns({ market, quarter, kind, ownerUsername, ownerSubjectId, publishedOnly, periodType, strategyCode, includeShadow, limit, offset }, tx) {
  const exec = executorOf(tx);
  const conditions = [];
  const params = [];
  if (market) { params.push(market); conditions.push(`r.market = $${params.length}`); }
  if (quarter) { params.push(quarter); conditions.push(`r.quarter = $${params.length}`); }
  if (kind) { params.push(kind); conditions.push(`r.run_kind = $${params.length}`); }
  if (periodType) { params.push(periodType); conditions.push(`r.period_type = $${params.length}`); }
  if (strategyCode) { params.push(strategyCode); conditions.push(`s.strategy_code = $${params.length}`); }
  // 影子批次默认不出现在普通列表里：它是工程观察渠道，混进正式下拉会让用户以为已上线。
  if (!includeShadow) conditions.push('r.is_shadow = false');
  // 页面批次下拉只列有意义的批次：已正式发布的组合，以及本人的个人测算结果。
  // 未发布的 preview（部分数据预览）既没有可买入席位也不代表本期结论，混在可选列表里只会误导
  // （2026-11-05 用户反馈：同一季度堆了 6 条「未发布」）。
  if (publishedOnly) conditions.push("(r.published_at IS NOT NULL OR r.run_kind = 'personal')");
  // 个人运行只有本人可见；主体（迁移 187 subject_id）优先，缺失时才回退 username（旧记录边界）。
  // 账号删除重建后同名用户拿不到旧结果：新主体与旧行的 owner_subject_id 不相等（方案 27.9）。
  if (ownerUsername || ownerSubjectId) {
    const ownClauses = [];
    if (ownerSubjectId) {
      params.push(ownerSubjectId);
      ownClauses.push(`r.owner_subject_id = $${params.length}::uuid`);
    }
    if (ownerUsername) {
      params.push(ownerUsername);
      ownClauses.push(`(r.owner_subject_id IS NULL AND r.owner_username = $${params.length})`);
    }
    conditions.push(`(r.run_kind <> 'personal' OR (${ownClauses.join(' OR ')}))`);
  } else conditions.push(`r.run_kind <> 'personal'`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const { rows } = await exec(`
    SELECT r.run_id, r.market, r.run_kind, r.quarter, r.as_of_date::text AS as_of_date, r.strategy_id,
           r.execution_status, r.quality_status, r.business_status, r.universe_count, r.pending_count,
           r.selected_count, r.market_pb, r.market_pe, r.revision, r.published_at, r.owner_username,
           r.position_ratio, r.budget_ratio, s.version AS strategy_version, s.strategy_code,
           r.period_type, r.period_key, r.period_start::text AS period_start, r.period_end::text AS period_end,
           r.is_shadow, r.computed_at, r.created_at, COUNT(*) OVER () AS total
      FROM analytics.stock_selection_runs r
      JOIN analytics.stock_selection_strategies s ON s.strategy_id = r.strategy_id
      ${where}
     ORDER BY r.as_of_date DESC, r.period_type NULLS LAST, r.run_id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

async function findRun(runId, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT r.*, r.as_of_date::text AS as_of_date_text, r.knowledge_cutoff::text AS knowledge_cutoff_text,
           r.period_start::text AS period_start_text, r.period_end::text AS period_end_text,
           s.version AS strategy_version, s.strategy_code, s.formula_version, s.parameters
      FROM analytics.stock_selection_runs r
      JOIN analytics.stock_selection_strategies s ON s.strategy_id = r.strategy_id
     WHERE r.run_id = $1`, [runId]);
  return rows[0] || null;
}

/** 个人派生事务内锁定源批次，避免源状态/访问权限在复制期间变化。 */
async function findRunForUpdate(runId, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT r.*, r.as_of_date::text AS as_of_date_text, r.knowledge_cutoff::text AS knowledge_cutoff_text,
           r.period_start::text AS period_start_text, r.period_end::text AS period_end_text,
           s.version AS strategy_version, s.strategy_code, s.formula_version, s.parameters
      FROM analytics.stock_selection_runs r
      JOIN analytics.stock_selection_strategies s ON s.strategy_id = r.strategy_id
     WHERE r.run_id = $1
     FOR UPDATE OF r`, [runId]);
  return rows[0] || null;
}

// 港股主档名可能是英文或代码（如 01114.HK 的 BRILLIANCE CHI）；腾讯行情缓存里已有中文名，
// 仅对名称不含汉字的港股回退，中文名、A 股与所有计算字段都不变。
const HK_NAME_FALLBACK = `
      LEFT JOIN LATERAL (
        SELECT q.name FROM market_quote_cache q
         WHERE c.code LIKE '%.HK' AND q.source = 'tencent'
           AND q.symbol = 'hk' || substring(c.code from 1 for 5)
         ORDER BY q.fetched_at DESC LIMIT 1
      ) q ON true`;

async function listCandidates({ runId, limit, offset, filterStatus, orderBy }, tx) {
  const exec = executorOf(tx);
  const params = [runId];
  let where = 'WHERE c.run_id = $1';
  if (filterStatus) { params.push(filterStatus); where += ` AND c.filter_status = $${params.length}`; }
  params.push(limit, offset);
  const order = orderBy === 'code' ? 'c.code ASC' : 'COALESCE(c.selection_order, 100000) ASC, c.code ASC';
  const { rows } = await exec(`
    SELECT c.instrument_id, c.company_id, c.code,
           CASE WHEN c.name ~ '[一-龥]' THEN c.name
                ELSE COALESCE(NULLIF(q.name, ''), c.name) END AS name,
           c.industry_code, c.industry_name, c.industry_system, c.industry_version,
           c.current_pb, c.historical_pb_max, c.historical_pb_min, c.current_pe, c.profit_status, c.dividend_yield, c.equity_amount,
           c.equity_currency, c.equity_cny, c.fx_rate, c.fx_date::text AS fx_date, c.pb_rank, c.pe_rank, c.dividend_rank,
           c.total_score, c.selection_order, c.filter_status, c.data_quality_status, c.exclusion_reasons,
           c.pb_positive_extrema_ratio, c.pb_pe_product, c.valuation_status, c.valuation_pass_reason,
           c.ttm_profit_status, c.rank_ready, c.rank_block_reasons,
           c.pb_covered_days, c.pb_expected_days, c.pb_gap_days, c.pb_history_years,
           COUNT(*) OVER () AS total
      FROM analytics.stock_selection_candidates c
      ${HK_NAME_FALLBACK}
      ${where}
     ORDER BY ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

/** 来源快照中的行业完整身份及受影响候选数；用于个人排除的可审计映射提示。 */
async function listIndustryIdentityCounts(runId, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT industry_code AS code, MIN(industry_name) AS name,
           industry_system AS system, industry_version AS version,
           COUNT(*)::int AS affected_count
      FROM analytics.stock_selection_candidates
     WHERE run_id = $1 AND industry_code IS NOT NULL
     GROUP BY industry_system, industry_version, industry_code
     ORDER BY industry_system NULLS LAST, industry_version NULLS LAST, industry_code`, [runId]);
  return rows;
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
           m.weight_in_market_budget, m.weight_in_equity_target, m.weight_in_invested_equity,
           m.issuer_duplicate,
           c.code,
           CASE WHEN c.name ~ '[一-龥]' THEN c.name
                ELSE COALESCE(NULLIF(q.name, ''), c.name) END AS name,
           c.company_id, c.industry_name,
           c.current_pb, c.current_pe, c.dividend_yield, c.total_score,
           c.pb_pe_product, c.historical_pb_min, c.historical_pb_max, c.pb_positive_extrema_ratio,
           c.valuation_status, c.valuation_pass_reason, c.ttm_profit_status
      FROM analytics.stock_selection_portfolio_members m
      JOIN analytics.stock_selection_candidates c ON c.run_id = m.run_id AND c.instrument_id = m.instrument_id
      ${HK_NAME_FALLBACK}
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

async function readUserSettingsForUpdate(username, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT stock_selection_settings, stock_selection_settings_revision, subject_id::text AS subject_id
      FROM users WHERE username = $1 FOR UPDATE`, [username]);
  const row = rows[0];
  if (!row) return null;
  return {
    settings: row.stock_selection_settings || {},
    revision: Number(row.stock_selection_settings_revision || 0),
    subjectId: row.subject_id,
  };
}

/** 不可复用主体 id（迁移 187）：私人批次绑定它，读取时按会话主体核验，不只按 username。 */
async function readUserSubjectId(username, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`SELECT subject_id::text AS subject_id FROM users WHERE username = $1`, [username]);
  return rows[0] ? rows[0].subject_id : null;
}

/**
 * 同一请求 id 的私人批次（幂等判定用），返回 run_id 与规范化载荷哈希。
 * 主体优先：同一 username 被删除重建后不能复用旧主体的私人结果（方案 27.9）。
 */
async function findPersonalRunByRequestId({ username, subjectId, requestId }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT run_id, market, input_hash, input_manifest, settings_revision, supersedes_run_id,
           position_ratio, budget_ratio, owner_subject_id::text AS owner_subject_id
      FROM analytics.stock_selection_runs
     WHERE request_id = $2 AND run_kind = 'personal'
       AND (
         ($3::uuid IS NOT NULL AND owner_subject_id = $3::uuid)
         OR ($3::uuid IS NULL AND owner_subject_id IS NULL AND owner_username = $1)
       )
     ORDER BY run_id DESC LIMIT 1`, [username || null, requestId, subjectId || null]);
  return rows[0] || null;
}

async function findStockSelectionRequestBinding({ username, subjectId, requestId }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT b.binding_id, b.run_id, b.input_hash, b.owner_subject_id::text AS owner_subject_id,
           r.market, r.input_manifest, r.settings_revision, r.supersedes_run_id, r.position_ratio, r.budget_ratio
      FROM analytics.stock_selection_request_bindings b
      JOIN analytics.stock_selection_runs r ON r.run_id = b.run_id
     WHERE b.owner_username = $1
       AND b.client_request_id = $2
       AND ($3::uuid IS NOT DISTINCT FROM b.owner_subject_id)
     ORDER BY b.binding_id DESC LIMIT 1`, [username, requestId, subjectId || null]);
  return rows[0] || null;
}

async function bindStockSelectionRequest({ username, subjectId, requestId, inputHash, runId }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    INSERT INTO analytics.stock_selection_request_bindings
      (owner_username, owner_subject_id, client_request_id, input_hash, run_id)
    VALUES ($1,$2::uuid,$3,$4,$5)
    ON CONFLICT DO NOTHING
    RETURNING binding_id, run_id, input_hash`, [username, subjectId || null, requestId, inputHash, runId]);
  if (rows[0]) return rows[0];
  return findStockSelectionRequestBinding({ username, subjectId, requestId }, tx);
}

async function saveUserSettings({ username, settings, expectedRevision, expectedSubjectId }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    UPDATE users
       SET stock_selection_settings = $2::jsonb,
           stock_selection_settings_revision = stock_selection_settings_revision + 1
     WHERE username = $1 AND stock_selection_settings_revision = $3
       AND ($4::uuid IS NULL OR subject_id = $4::uuid)
     RETURNING stock_selection_settings_revision`, [username, JSON.stringify(settings), expectedRevision, expectedSubjectId || null]);
  if (!rows.length) {
    const error = new Error('设置已被其他窗口修改，请刷新后重试');
    error.status = 409;
    error.code = 'STOCK_SELECTION_SETTINGS_REVISION_CONFLICT';
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
/**
 * 个人排除代码的统一身份解析（方案 27.9）：一次批量查询，不逐股回源。
 * 输入允许「600519」「600519.SH」「700」「00700.HK」这几种写法；返回全部候选，
 * 由服务层判定唯一匹配——不唯一就是待核验，不猜。
 */
async function resolveInstrumentsByCodes({ market, codes = [] }, tx) {
  const list = Array.from(new Set((codes || []).map(code => String(code || '').trim().toUpperCase()).filter(Boolean)));
  if (!list.length) return [];
  const bare = list.map(code => code.split('.')[0]);
  const padded = bare.map(code => (/^\d+$/.test(code) ? code.padStart(5, '0') : code));
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT instrument_id, canonical_code AS code, name, market, asset_class,
           list_date::text AS list_date, delist_date::text AS delist_date
      FROM core.instruments
     WHERE market = $1
       AND (canonical_code = ANY($2::text[])
            OR split_part(canonical_code, '.', 1) = ANY($3::text[])
            OR split_part(canonical_code, '.', 1) = ANY($4::text[]))`,
  [market, list, bare, padded]);
  return rows;
}

/** 库内合法一级行业（按市场分类体系）：只读已落库分类，不现场调用行业源。 */
async function listIndustryOptions({ market }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT n.industry_code AS code, n.industry_name AS name,
           t.taxonomy_code AS system, t.version, n.level
      FROM core.industry_nodes n
      JOIN core.industry_taxonomies t ON t.taxonomy_id = n.taxonomy_id
     WHERE t.taxonomy_code = ANY($1::text[]) AND n.level = 1
     ORDER BY array_position($1::text[], t.taxonomy_code), n.industry_code`, [config.industryTaxonomies]);
  return rows;
}

async function findInstrumentMeta({ tsCode }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(
    `SELECT i.instrument_id, i.canonical_code AS ts_code, i.name, i.market, i.list_date::text AS list_date,
            i.currency_code, i.raw_data
       FROM core.instruments i WHERE i.canonical_code = $1 LIMIT 1`, [tsCode]);
  return rows[0] || null;
}

/** 这批代码里，谁在目标日往前 days 天内已经有收盘价（避免对同一批对象重复请求外部接口）。 */
async function listCodesWithRecentBars({ codes = [], asOfDate, days = 60 }, tx) {
  const list = (codes || []).filter(Boolean);
  if (!list.length || !asOfDate) return new Set();
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT DISTINCT i.canonical_code AS code
      FROM market.daily_bars b
      JOIN core.instruments i ON i.instrument_id = b.instrument_id
     WHERE i.canonical_code = ANY($1::text[]) AND b.trade_date <= $2::date AND b.trade_date > ($2::date - $3::int)`,
  [list, asOfDate, Number(days) || 60]);
  return new Set(rows.map(row => row.code));
}

/**
 * 港股选股补估值：批量按 (instrument_id, trade_date, source_id) 幂等写入。
 * 行由数据层给出标准字段（total_market_cap 已是元、dividend_yield_ttm 已是小数），
 * 这里只负责落库，不做单位换算与口径判断；币种必须随行写入，避免 HKD 被当成人民币。
 */
async function upsertDailyValuationRows({ rows = [], sourceId }, tx) {
  const list = (rows || []).filter(row => row && row.instrumentId && row.tradeDate).map(row => ({
    instrument_id: Number(row.instrumentId),
    trade_date: row.tradeDate,
    pe_static: row.peStatic === undefined ? null : row.peStatic,
    pe_ttm: row.peTtm === undefined ? null : row.peTtm,
    pb: row.pb === undefined ? null : row.pb,
    dividend_yield_ttm: row.dividendYield === undefined ? null : row.dividendYield,
    total_market_cap: row.totalMarketCap === undefined ? null : row.totalMarketCap,
    circulating_market_cap: row.circulatingMarketCap === undefined ? null : row.circulatingMarketCap,
    currency_code: row.currencyCode || null,
  }));
  if (!list.length) return 0;
  const exec = executorOf(tx);
  await exec(`
    INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,
      total_market_cap,circulating_market_cap,currency_code)
    SELECT x.instrument_id,x.trade_date,$2,x.pe_static,x.pe_ttm,x.pb,x.dividend_yield_ttm,
           x.total_market_cap,x.circulating_market_cap,x.currency_code
      FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,pe_static numeric,pe_ttm numeric,
           pb numeric,dividend_yield_ttm numeric,total_market_cap numeric,circulating_market_cap numeric,currency_code text)
    ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET
      pe_static=COALESCE(EXCLUDED.pe_static,market.daily_valuations.pe_static),
      pe_ttm=COALESCE(EXCLUDED.pe_ttm,market.daily_valuations.pe_ttm),
      pb=COALESCE(EXCLUDED.pb,market.daily_valuations.pb),
      dividend_yield_ttm=COALESCE(EXCLUDED.dividend_yield_ttm,market.daily_valuations.dividend_yield_ttm),
      total_market_cap=COALESCE(EXCLUDED.total_market_cap,market.daily_valuations.total_market_cap),
      circulating_market_cap=COALESCE(EXCLUDED.circulating_market_cap,market.daily_valuations.circulating_market_cap),
      currency_code=COALESCE(EXCLUDED.currency_code,market.daily_valuations.currency_code),
      ingested_at=now()`, [JSON.stringify(list), sourceId]);
  return list.length;
}

/** 港股选股补收盘价：批量按 (instrument_id, trade_date, source_id) 幂等写入 OHLC。 */
async function upsertDailyBarRows({ rows = [], sourceId }, tx) {
  const list = (rows || []).filter(row => row && row.instrumentId && row.tradeDate).map(row => ({
    instrument_id: Number(row.instrumentId),
    trade_date: row.tradeDate,
    open: row.open === undefined ? null : row.open,
    high: row.high === undefined ? null : row.high,
    low: row.low === undefined ? null : row.low,
    close: row.close === undefined ? null : row.close,
    volume: row.volume === undefined ? null : row.volume,
    amount: row.amount === undefined ? null : row.amount,
  }));
  if (!list.length) return 0;
  const exec = executorOf(tx);
  await exec(`
    INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
    SELECT x.instrument_id,x.trade_date,$2,x.open,x.high,x.low,x.close,x.volume,x.amount
      FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,open numeric,high numeric,
           low numeric,close numeric,volume numeric,amount numeric)
    ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET
      open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
      volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`, [JSON.stringify(list), sourceId]);
  return list.length;
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

/** 找同市场、同周期的上一份正式来源；个人派生可通过 sourceRunId 精确锁定公共来源。 */
async function previousPublishedRun({ market, asOfDate, excludeRunId, periodType = 'quarter', sourceRunId = null }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
      SELECT run_id, market, run_kind, period_type, period_key, quarter, as_of_date::text AS as_of_date,
             revision, selected_count
        FROM analytics.stock_selection_runs
       WHERE market = $1 AND published_at IS NOT NULL
         AND period_type = $4 AND run_id <> $3
         AND ($5::bigint IS NULL OR run_id = $5)
         AND ($2::date IS NULL OR as_of_date < $2::date)
       ORDER BY period_start DESC NULLS LAST, as_of_date DESC, revision DESC, run_id DESC LIMIT 1
    `, [market, asOfDate || null, excludeRunId, periodType, sourceRunId]);
  return rows[0] || null;
}

/** 上一份已发布组合的席位；返回 run 元数据以区分“有效零成员”和“没有基线”。 */
async function previousPublishedMembers(options, tx) {
  const previous = await previousPublishedRun(options, tx);
  if (!previous) return { run: null, rows: [] };
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT r.run_id, r.market, r.run_kind, r.period_type, r.period_key,
           m.instrument_id, c.code, c.name, r.quarter, r.as_of_date::text AS as_of_date
      FROM analytics.stock_selection_portfolio_members m
      JOIN analytics.stock_selection_runs r ON r.run_id = m.run_id
      JOIN analytics.stock_selection_candidates c ON c.run_id = m.run_id AND c.instrument_id = m.instrument_id
     WHERE m.run_id = $1`, [previous.run_id]);
  return { run: previous, rows };
}

/** 同一主体、同一公共来源的上一份个人组合；用于解释连续排除的本次变动。 */
async function previousPersonalRun({ market, sourceRunId, excludeRunId, ownerUsername, ownerSubjectId }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
      SELECT run_id, market, run_kind, period_type, period_key, quarter, as_of_date::text AS as_of_date,
             revision, selected_count, created_at
        FROM analytics.stock_selection_runs
       WHERE market = $1 AND run_kind = 'personal'
         AND supersedes_run_id = $2 AND run_id <> $3
         AND (created_at, run_id) < (SELECT created_at, run_id FROM analytics.stock_selection_runs WHERE run_id = $3)
         AND (
           ($4::uuid IS NOT NULL AND owner_subject_id = $4::uuid)
           OR ($4::uuid IS NULL AND owner_subject_id IS NULL AND owner_username = $5)
         )
       ORDER BY created_at DESC NULLS LAST, run_id DESC LIMIT 1
    `, [market, sourceRunId, excludeRunId, ownerSubjectId || null, ownerUsername || null]);
  return rows[0] || null;
}

async function previousPersonalMembers(options, tx) {
  const previous = await previousPersonalRun(options, tx);
  if (!previous) return { run: null, rows: [] };
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT r.run_id, r.market, r.run_kind, r.period_type, r.period_key,
           m.instrument_id, c.code, c.name, r.quarter, r.as_of_date::text AS as_of_date
      FROM analytics.stock_selection_portfolio_members m
      JOIN analytics.stock_selection_runs r ON r.run_id = m.run_id
      JOIN analytics.stock_selection_candidates c ON c.run_id = m.run_id AND c.instrument_id = m.instrument_id
     WHERE m.run_id = $1`, [previous.run_id]);
  return { run: previous, rows };
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

/**
 * 最新正式结果：先限定 market／已激活策略／周期／非影子正式渠道，再按日期稳定排序。
 * 有发布指针时优先读指针（指针就是"当前生效"的唯一事实），没有指针才回退到 published_at 扫描，
 * 绝不按 period_key 字典序或跨 day/week/quarter 直接取最大值。
 */
async function latestPublishedRun({ market, strategyId, periodType }, tx) {
  const exec = executorOf(tx);
  const type = periodType || 'quarter';
  if (strategyId) {
    const pointer = await exec(`
      SELECT r.run_id, r.quarter, r.as_of_date::text AS as_of_date, r.revision, r.selected_count,
             r.business_status, r.strategy_id, r.market_pb, r.market_pe, r.benchmark_code,
             r.valuation_method, r.input_manifest, r.period_type, r.period_key,
             r.period_start::text AS period_start, r.period_end::text AS period_end,
             r.published_at, r.computed_at, p.pointer_revision
        FROM analytics.stock_selection_publications p
        JOIN analytics.stock_selection_runs r ON r.run_id = p.run_id
       WHERE p.market = $1 AND p.strategy_id = $2 AND p.period_type = $3
       ORDER BY p.activated_at DESC LIMIT 1`, [market, strategyId, type]);
    if (pointer.rows[0]) return pointer.rows[0];
  }
  const kinds = type === 'quarter' ? ['quarterly'] : (type === 'week' ? ['weekly'] : ['daily']);
  const { rows } = await exec(`
    SELECT run_id, quarter, as_of_date::text AS as_of_date, revision, selected_count, business_status,
           strategy_id, market_pb, market_pe, benchmark_code, valuation_method, input_manifest,
           period_type, period_key, period_start::text AS period_start, period_end::text AS period_end,
           published_at, computed_at
      FROM analytics.stock_selection_runs
     WHERE market = $1 AND run_kind = ANY($2::text[]) AND published_at IS NOT NULL AND is_shadow = false
       AND ($3::bigint IS NULL OR strategy_id = $3::bigint)
     ORDER BY period_start DESC NULLS LAST, as_of_date DESC, revision DESC, run_id DESC LIMIT 1`,
  [market, kinds, strategyId || null]);
  return rows[0] || null;
}

/**
 * 个人测算复制源批次的候选快照（保留同一排名，不重新取数）。
 * 必须复制**全部判定证据**（三项名次、V2 估值/极值/TTM/覆盖列），
 * 否则个人结果会丢掉源批次的名次与原因，页面只能显示"无解释的空行"。
 */
async function copyCandidates({ sourceRunId, targetRunId }, tx) {
  const exec = executorOf(tx);
  await exec(`
    INSERT INTO analytics.stock_selection_candidates
      (run_id, instrument_id, company_id, code, name, industry_code, industry_name, industry_system, industry_version,
       current_pb, historical_pb_max, historical_pb_min, current_pe, profit_status, dividend_yield,
       equity_amount, equity_currency, equity_cny, fx_rate, fx_date,
       pb_rank, pe_rank, dividend_rank, total_score, selection_order,
       filter_status, data_quality_status, exclusion_reasons, detail,
       pb_positive_extrema_ratio, pb_pe_product, valuation_status, valuation_pass_reason,
       ttm_profit_status, rank_ready, rank_block_reasons,
       pb_covered_days, pb_expected_days, pb_gap_days, pb_history_years)
    SELECT $2, instrument_id, company_id, code, name, industry_code, industry_name, industry_system, industry_version,
           current_pb, historical_pb_max, historical_pb_min, current_pe, profit_status, dividend_yield,
           equity_amount, equity_currency, equity_cny, fx_rate, fx_date,
           pb_rank, pe_rank, dividend_rank, total_score, selection_order,
           filter_status, data_quality_status, exclusion_reasons, detail,
           pb_positive_extrema_ratio, pb_pe_product, valuation_status, valuation_pass_reason,
           ttm_profit_status, rank_ready, rank_block_reasons,
           pb_covered_days, pb_expected_days, pb_gap_days, pb_history_years
      FROM analytics.stock_selection_candidates
     WHERE run_id = $1
    ON CONFLICT (run_id, instrument_id) DO NOTHING`, [sourceRunId, targetRunId]);
}

/**
 * 个人派生用的完整冻结投影（方案 27.9）：分页游标读取源批次**全部**候选，
 * 显式带出 detail/company_id/rankReady/reasons，不再用 5000 行上限截断、也不补 rankReady=true。
 */
async function listCandidatesForProjection({ runId, batchSize = 1000 }, tx) {
  const exec = executorOf(tx);
  const rows = [];
  let lastInstrumentId = 0;
  for (;;) {
    const page = await exec(`
      SELECT instrument_id, company_id, code, name, industry_code, industry_name, industry_system, industry_version,
             current_pb, historical_pb_max, historical_pb_min, current_pe, profit_status, dividend_yield,
             pb_rank, pe_rank, dividend_rank, total_score, selection_order,
             filter_status, data_quality_status, exclusion_reasons, detail,
             pb_positive_extrema_ratio, pb_pe_product, valuation_status, valuation_pass_reason,
             ttm_profit_status, rank_ready, rank_block_reasons
        FROM analytics.stock_selection_candidates
       WHERE run_id = $1 AND instrument_id > $2
       ORDER BY instrument_id
       LIMIT $3`, [runId, lastInstrumentId, batchSize]);
    if (!page.rows.length) break;
    page.rows.forEach(row => rows.push(row));
    lastInstrumentId = Number(page.rows[page.rows.length - 1].instrument_id);
    if (page.rows.length < batchSize) break;
  }
  return rows;
}

module.exports = {
  MARKET_CONFIG,
  loadUniverse, loadPbWindow, loadPbMissingDaysForCodes, loadEquityFacts, loadAnnualProfits, loadDividendWindow,
  loadAnnualDividends, loadIndustries, loadFxRatesForPairs, loadMarketValuation, loadLatestMarketValuation, loadCalendar,
  loadCalendarEvidence, findUniverseArtifact, insertUniverseArtifact, loadUniverseRoster, loadTtmInputs,
  loadOpenPrices, loadClosePrices, loadBenchmarkCloses, loadDividendCash, loadDividendEvents, loadBarWindow,
  upsertStrategy, findStrategyId, findRunByIdempotencyKey, nextRevision, insertRun, insertCandidates, insertMembers,
  publishRun, markRunFailure,
  findPublication, listPublicationEvents, markPublicationVisible, loadPublicationReplayEvidence,
  listRuns, findRun, findRunForUpdate, listCandidates, listIndustryIdentityCounts, findCandidate, listMembers, latestPublishedRun, copyCandidates,
  hasPeriodRun,
  listCandidatesForProjection,
  readUserSettings, readUserSettingsForUpdate, saveUserSettings,
  readUserSubjectId, findPersonalRunByRequestId,
  findStockSelectionRequestBinding, bindStockSelectionRequest,
  resolveInstrumentsByCodes, listIndustryOptions,
  saveInputGapQueue, readInputGapQueue, findInstrumentMeta, hasCompletedQuarterRun,
  upsertDailyValuationRows, upsertDailyBarRows, listCodesWithRecentBars,
  insertBacktest, insertBacktestPeriods, findBacktest, listBacktestPeriods, listBacktests, previousPublishedRun, previousPublishedMembers, previousPersonalRun, previousPersonalMembers,
};
