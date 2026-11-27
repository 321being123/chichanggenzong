'use strict';
// B4-1 真实隔离库端到端回归（portfolio_test，全部事务内写入并回滚）。
//
// 覆盖：
// A. loadUniverse 去 LATERAL：
//    - SQL 不再含 net_profit_parent / equity_parent 财报子查询；
//    - 源站 PB 为空时用 loadEquityFacts 批量结果在内存回填：负净资产→负 PB、
//      非 balance 报表的归母净资产照样参与、异币种不闭合留空并保留币种证据。
// B. 周度 computation_input_hash 受控复用：
//    - 正例：同市场/同目标日/同 knowledge_cutoff/同输入输出哈希的 passed daily 存在时，
//      weekly 命中复用，新建独立 weekly run/manifest/候选/成员，记录 source_daily_run_id 与双向哈希，
//      重新通过发布/CAS 校验；
//    - 反例：同证券数量但 PB / 年度利润 / 分红 / 行业版本变化 → 哈希变化 → 拒绝复用并完整重算；
//    - 仓储过滤：影子 daily、quality 非 passed、存在待裁决缺口的 daily 一律不得进入复用候选。
//
// 直接复用 runPeriodic 落库的同一入口 computeAndPersist（runPeriodic 仅在其前做日历/就绪检查，
// 受控复用逻辑全在 computeAndPersist 内），并传入外层事务，结束时统一 ROLLBACK。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { Client } = require('pg');
const { testDatabaseConfig } = require('./lib/testDatabase');
const { pool } = require('../db/connection');
const repo = require('../repositories/stockSelectionRepository');
const service = require('../services/stockSelectionService');
const PERIODS = require('../services/stockSelectionPeriods');

const STRATEGY = 'investment_essentials_adapted_v1';
const AS_OF = '2026-11-20';
const CODES = ['609701.SH', '609702.SH', '609703.SH', '609704.SH'];
const COMPANY_PREFIX = 'B4选股复用测试';

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };
const ne = (actual, expected, message) => { assert.notStrictEqual(actual, expected, message); checks += 1; };

async function insertInstrument(client, { code, market = 'CN', exchange = 'SSE', name, currency = 'CNY' }) {
  const company = await client.query(
    `INSERT INTO core.companies(legal_name, short_name, country_code, company_type)
     VALUES($1,$2,$3,'listed') RETURNING company_id`,
    [`${COMPANY_PREFIX}${code}`, code, market === 'HK' ? 'HK' : 'CN'],
  );
  const companyId = Number(company.rows[0].company_id);
  const instrument = await client.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status)
     VALUES($1,$2,'stock',$3,$4,$5,DATE '2010-01-01','listed') RETURNING instrument_id`,
    [code, name || `B4测试${code}`, market, exchange, currency],
  );
  const instrumentId = Number(instrument.rows[0].instrument_id);
  await client.query(
    `INSERT INTO core.company_instruments(company_id,instrument_id,relation_type,valid_from)
     VALUES($1,$2,'issued_by','2010-01-01')`, [companyId, instrumentId]);
  return { companyId, instrumentId };
}

async function insertBar(client, instrumentId, tradeDate, close = 10, sourceId) {
  await client.query(
    `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
     VALUES($1,$2::date,$3,$4,$4,$4,$4,1000,10000)`,
    [instrumentId, tradeDate, sourceId, close]);
}

async function insertValuation(client, instrumentId, tradeDate, { pb = '1.10', peTtm = '8.00', marketCap = '50000000000', currency = 'CNY' } = {}, sourceId) {
  await client.query(
    `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pb,pe_ttm,total_market_cap,currency_code)
     VALUES($1,$2::date,$3,$4,$5,$6,$7)`,
    [instrumentId, tradeDate, sourceId, pb, peTtm, marketCap, currency]);
}

async function insertReport(client, { companyId, kind, periodEnd, periodType = 'annual', announcedAt, sourceId, code }) {
  const { rows } = await client.query(
    `INSERT INTO fundamental.financial_reports
       (company_id,report_kind,period_end,period_type,statement_scope,announced_at,source_id,raw_payload,
        source_version,update_flag,is_current_version,report_type)
     VALUES($1,$2,$3::date,$4,'consolidated',$5::date,$6,$7::jsonb,'v1','',true,'1') RETURNING report_id`,
    [companyId, kind, periodEnd, periodType, announcedAt, sourceId, JSON.stringify({ ts_code: code })]);
  return rows[0].report_id;
}

async function insertFact(client, reportId, statementType, metricCode, value, currency = 'CNY') {
  await client.query(
    `INSERT INTO fundamental.financial_facts(report_id,statement_type,metric_code,numeric_value,unit_code,currency_code,source_field,is_calculated)
     VALUES($1,$2,$3,$4,'CNY',$5,'src_field',false)`,
    [reportId, statementType, metricCode, value, currency]);
}

async function insertDividend(client, instrumentId, sourceId, year, cashPerShare = 0.5) {
  const exDate = year === 2025 ? '2026-06-15' : `${year + 1}-06-15`;
  await client.query(
    `INSERT INTO fundamental.corporate_actions
       (instrument_id,action_type,fiscal_period_end,announced_at,ex_date,status,cash_per_share_pre_tax,
        stock_dividend_ratio,capitalization_ratio,total_cash_amount,currency_code,source_id,source_key)
     VALUES($1,'dividend',$2::date,$3::date,$4::date,'实施',$5,0,0,$6,'CNY',$7,$8)`,
    [instrumentId, `${year}-12-31`, `${year + 1}-05-01`, exDate, cashPerShare, cashPerShare * 2e8, sourceId, `B4-DIV-${instrumentId}-${year}`]);
}

async function seedCalendar(client) {
  // 覆盖 AS_OF 前 12 个月的工作日，保证 PB 窗口有交易日分母；ON CONFLICT 不动真实日历。
  const start = new Date('2025-12-01T00:00:00Z');
  const end = new Date(`${AS_OF}T00:00:00Z`);
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = cursor.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    await client.query(
      `INSERT INTO market.trade_calendar(exchange,trade_date,is_open) VALUES('SSE',$1::date,true)
       ON CONFLICT(exchange,trade_date) DO NOTHING`,
      [cursor.toISOString().slice(0, 10)]);
  }
}

async function seedCompleteStocks(client, sourceId) {
  // 行业归属：没有一级行业时组合会按 industry_unverified 跳过全部成员（质量仍可能是 passed）。
  const taxonomy = await client.query(
    `SELECT taxonomy_id FROM core.industry_taxonomies WHERE taxonomy_code='SW2021' LIMIT 1`);
  assert.ok(taxonomy.rows[0], '隔离库缺少 SW2021 行业分类，无法验证组合成员');
  const node = await client.query(
    `INSERT INTO core.industry_nodes(taxonomy_id,industry_code,industry_name,level)
     VALUES($1,'B4_IND','B4复用测试行业',1) RETURNING industry_node_id`,
    [taxonomy.rows[0].taxonomy_id]);
  const nodeId = node.rows[0].industry_node_id;

  const stocks = [];
  for (let index = 0; index < CODES.length; index++) {
    const code = CODES[index];
    const { companyId, instrumentId } = await insertInstrument(client, { code });
    await client.query(
      `INSERT INTO core.company_industry_memberships(company_id,industry_node_id,source_id,valid_from,is_current)
       VALUES($1,$2,$3,'2010-01-01',true)`, [companyId, nodeId, sourceId]);
    await insertValuation(client, instrumentId, AS_OF, {
      pb: String(1.1 + index * 0.1), peTtm: String(7 + index), marketCap: '50000000000', currency: 'CNY',
    }, sourceId);
    await insertBar(client, instrumentId, AS_OF, 10, sourceId);
    for (let year = 2015; year <= 2025; year++) {
      const reportId = await insertReport(client, {
        companyId, kind: 'income', periodEnd: `${year}-12-31`, periodType: 'annual',
        announcedAt: `${year + 1}-03-31`, sourceId, code,
      });
      await insertFact(client, reportId, 'income', 'net_profit_parent', 1e9);
      // 净资产事实刻意放在 income 报表里：证明去 LATERAL 后不再依赖 report_kind='balance'。
      await insertFact(client, reportId, 'balance', 'equity_parent', 5e10);
      await insertDividend(client, instrumentId, sourceId, year, 0.5);
    }
    stocks.push({ code, companyId, instrumentId });
  }
  await client.query(
    `INSERT INTO market.index_valuation_history(index_code,valuation_method,trade_date,close,pe_ttm,pb,source_code)
     VALUES('000985','market_cap_weighted',$1::date,6000,15,1.5,'lixinger_official')
     ON CONFLICT DO NOTHING`, [AS_OF]);
  return stocks;
}

function dailyInput() {
  return {
    market: 'CN', asOfDate: AS_OF, runKind: 'daily', periodType: 'day',
    periodKey: PERIODS.periodKeyOf('day', AS_OF), strategyCode: STRATEGY, positionRatio: 1,
  };
}

function weeklyInput() {
  return {
    market: 'CN', asOfDate: AS_OF, runKind: 'weekly', periodType: 'week',
    periodKey: PERIODS.periodKeyOf('week', AS_OF), strategyCode: STRATEGY, positionRatio: 1,
  };
}

function qualitySummary(result) {
  const manifest = (result.run && result.run.input_manifest) || {};
  return JSON.stringify({
    quality: result.run && result.run.quality_status,
    business: result.run && result.run.business_status,
    pending: result.run && result.run.pending_count,
    reasons: (manifest.quality && manifest.quality.reasons) || [],
  });
}

// ===================== Phase A：loadUniverse 去 LATERAL =====================
async function phaseUniverse(client, sourceId) {
  const DA = '2027-01-15';
  const neg = await insertInstrument(client, { code: '609801.SH', name: 'B4负净资产' });
  const nonBal = await insertInstrument(client, { code: '609802.SH', name: 'B4非balance净资产' });
  const foreign = await insertInstrument(client, { code: '609803.SH', name: 'B4异币种净资产' });

  // 源站 PB 均为空；总市值与估值币种照常给出。
  await insertValuation(client, neg.instrumentId, DA, { pb: null, marketCap: '1000000000', currency: 'CNY' }, sourceId);
  await insertValuation(client, nonBal.instrumentId, DA, { pb: null, marketCap: '600000000', currency: 'CNY' }, sourceId);
  await insertValuation(client, foreign.instrumentId, DA, { pb: null, marketCap: '1000000000', currency: 'CNY' }, sourceId);
  for (const item of [neg, nonBal, foreign]) await insertBar(client, item.instrumentId, DA, 10, sourceId);

  // 负净资产：balance 报表 equity_parent = -2 亿。
  const negReport = await insertReport(client, {
    companyId: neg.companyId, kind: 'balance', periodEnd: '2026-06-30', periodType: 'interim',
    announcedAt: '2026-08-15', sourceId, code: '609801.SH',
  });
  await insertFact(client, negReport, 'balance', 'equity_parent', -2e8);

  // 非 balance 报表携带归母净资产 = 3 亿（income 报表），验证不再按 report_kind 过滤。
  const nonBalReport = await insertReport(client, {
    companyId: nonBal.companyId, kind: 'income', periodEnd: '2026-06-30', periodType: 'interim',
    announcedAt: '2026-08-15', sourceId, code: '609802.SH',
  });
  await insertFact(client, nonBalReport, 'income', 'equity_parent', 3e8);

  // 异币种：净资产 HKD，估值币种 CNY → 不闭合留空。
  const foreignReport = await insertReport(client, {
    companyId: foreign.companyId, kind: 'balance', periodEnd: '2026-06-30', periodType: 'interim',
    announcedAt: '2026-08-15', sourceId, code: '609803.SH',
  });
  await insertFact(client, foreignReport, 'balance', 'equity_parent', 5e8, 'HKD');

  const statements = [];
  const originalQuery = client.query.bind(client);
  client.query = (sql, params) => { statements.push(String(sql)); return originalQuery(sql, params); };
  let universe;
  try {
    universe = await repo.loadUniverse({ market: 'CN', asOfDate: DA, codes: ['609801.SH', '609802.SH', '609803.SH'] }, client);
  } finally {
    client.query = originalQuery;
  }
  const sql = statements.join('\n');
  ok(!/net_profit_parent/i.test(sql), 'loadUniverse 不得再跑 pe_static 的归母净利 LATERAL');
  ok(!/equity_parent/i.test(sql), 'loadUniverse 不得再跑 PB 空值回退的归母净资产 LATERAL');
  ok(/v\.pb AS pb/i.test(sql) && /v\.pe_static AS pe_static/i.test(sql),
    'loadUniverse 必须保留源站 PB / pe_static 原字段');

  eq(universe.length, 3, '三只夹具证券都应进入收窄股票池');
  universe.forEach(row => eq(row.pb, null, `${row.code} 的源站 PB 必须保持为空，等待内存回退`));

  const equity = await repo.loadEquityFacts({
    companyIds: [neg.companyId, nonBal.companyId, foreign.companyId], asOfDate: DA, market: 'CN',
  }, client);
  service.applyEquityPbFallback(universe, equity);
  const byCode = new Map(universe.map(row => [row.code, row]));

  eq(Number(byCode.get('609801.SH').pb), -5, '负净资产：10 亿 ÷ -2 亿 = -5');
  eq(Number(byCode.get('609802.SH').pb), 2, '非 balance 报表的净资产：6 亿 ÷ 3 亿 = 2');
  eq(byCode.get('609803.SH').pb, null, '异币种（HKD 报表 / CNY 估值）不得相除');
  eq(byCode.get('609803.SH').equity_currency, 'HKD', '异币种时仍保留净资产币种证据');
}

// ===================== Phase B：周度受控复用 =====================
async function phaseReuse(client, sourceId) {
  // 确保本目标日没有遗留 artifact，强制按本次夹具冻结名单。
  await client.query(`DELETE FROM analytics.stock_selection_universe_artifacts WHERE market='CN' AND target_date=$1::date`, [AS_OF]);
  await seedCalendar(client);
  const stocks = await seedCompleteStocks(client, sourceId);

  const daily0 = await service.computeAndPersist(dailyInput(), { tx: client });
  eq(daily0.run.quality_status, 'passed', `daily 基线必须质量通过：${qualitySummary(daily0)}`);
  const dailyHash = daily0.run.input_manifest.computationInputHash;
  const dailyOutputHash = daily0.run.input_manifest.computationOutputHash;
  ok(dailyHash && dailyOutputHash, 'daily 必须持久化 computationInputHash 与 computationOutputHash');

  // ---------- 正例 ----------
  const weekly0 = await service.computeAndPersist(weeklyInput(), { tx: client });
  eq(weekly0.run.quality_status, 'passed', `weekly 复用批次质量必须通过：${qualitySummary(weekly0)}`);
  ne(Number(weekly0.runId), Number(daily0.runId), '复用也必须新建独立 weekly run，不得改 daily 类型');
  eq(Number(weekly0.run.source_daily_run_id), Number(daily0.runId), 'weekly 必须记录 source_daily_run_id');
  const reuse0 = weekly0.run.input_manifest.computationReuse || {};
  eq(reuse0.reused, true, '同输入/同输出的 passed daily 存在时 weekly 必须命中复用');
  eq(reuse0.sourceComputationInputHash, dailyHash, '复用必须记录源 daily 的输入哈希');
  eq(reuse0.sourceComputationOutputHash, dailyOutputHash, '复用必须记录源 daily 的输出哈希');
  eq(weekly0.run.input_manifest.computationInputHash, dailyHash, 'weekly 的 computationInputHash 必须与 daily 相同');
  eq(weekly0.run.input_manifest.computationOutputHash, dailyOutputHash, 'weekly 的 computationOutputHash 必须与 daily 相同');
  eq(weekly0.run.run_kind, 'weekly', '复用批次 run_kind 必须是 weekly');
  eq(weekly0.run.period_type, 'week', '复用批次周期类型必须是 week');
  ok(weekly0.run.published_at !== null, '复用批次仍须完整通过发布与 CAS 校验');
  const weeklyCandidates = await client.query(
    'SELECT COUNT(*)::int AS c FROM analytics.stock_selection_candidates WHERE run_id=$1', [weekly0.runId]);
  const weeklyMembers = await client.query(
    'SELECT COUNT(*)::int AS c FROM analytics.stock_selection_portfolio_members WHERE run_id=$1', [weekly0.runId]);
  eq(Number(weeklyCandidates.rows[0].c), stocks.length, '复用批次必须新建自己的候选行');
  ok(Number(weeklyMembers.rows[0].c) > 0, '复用批次必须新建自己的组合成员');

  // ---------- 反例 1：同证券数量但 PB 变化 ----------
  await client.query(`UPDATE market.daily_valuations SET pb=1.25 WHERE instrument_id=$1 AND trade_date=$2::date`,
    [stocks[0].instrumentId, AS_OF]);
  const weeklyPb = await service.computeAndPersist(weeklyInput(), { tx: client });
  eq(weeklyPb.computed.evaluated.length, stocks.length, 'PB 变化反例必须保持同证券数量');
  assertRejected(weeklyPb, 'PB 变化');
  const pbCandidate = await client.query(
    'SELECT current_pb::text AS pb FROM analytics.stock_selection_candidates WHERE run_id=$1 AND instrument_id=$2',
    [weeklyPb.runId, stocks[0].instrumentId]);
  eq(Number(pbCandidate.rows[0].pb), 1.25, '拒绝复用后必须完整重算并反映新 PB');

  const daily1 = await service.computeAndPersist(dailyInput(), { tx: client });
  eq(daily1.run.quality_status, 'passed', `PB 变化后的 daily 基线必须通过：${qualitySummary(daily1)}`);

  // ---------- 反例 2：同证券数量但年度利润变化 ----------
  const profitReport = await client.query(
    `SELECT report_id FROM fundamental.financial_reports
      WHERE company_id=$1 AND report_kind='income' AND period_end='2015-12-31'`, [stocks[0].companyId]);
  await client.query(
    `UPDATE fundamental.financial_facts SET numeric_value=1.2e9
      WHERE report_id=$1 AND metric_code='net_profit_parent'`, [profitReport.rows[0].report_id]);
  const weeklyProfit = await service.computeAndPersist(weeklyInput(), { tx: client });
  eq(weeklyProfit.computed.evaluated.length, stocks.length, '年度利润变化反例必须保持同证券数量');
  assertRejected(weeklyProfit, '年度利润变化');

  const daily2 = await service.computeAndPersist(dailyInput(), { tx: client });
  eq(daily2.run.quality_status, 'passed', `利润变化后的 daily 基线必须通过：${qualitySummary(daily2)}`);

  // ---------- 反例 3：同证券数量但分红变化 ----------
  await client.query(
    `UPDATE fundamental.corporate_actions SET cash_per_share_pre_tax=0.9, total_cash_amount=1.8e8
      WHERE instrument_id=$1 AND fiscal_period_end='2020-12-31'`, [stocks[0].instrumentId]);
  const weeklyDividend = await service.computeAndPersist(weeklyInput(), { tx: client });
  eq(weeklyDividend.computed.evaluated.length, stocks.length, '分红变化反例必须保持同证券数量');
  assertRejected(weeklyDividend, '分红变化');

  const daily3 = await service.computeAndPersist(dailyInput(), { tx: client });
  eq(daily3.run.quality_status, 'passed', `分红变化后的 daily 基线必须通过：${qualitySummary(daily3)}`);

  // ---------- 反例 4：同证券数量但行业版本变化 ----------
  await client.query(
    `UPDATE core.industry_taxonomies SET version = COALESCE(version,'2021') || '-b4' WHERE taxonomy_code='SW2021'`);
  const weeklyIndustry = await service.computeAndPersist(weeklyInput(), { tx: client });
  eq(weeklyIndustry.computed.evaluated.length, stocks.length, '行业版本变化反例必须保持同证券数量');
  assertRejected(weeklyIndustry, '行业版本变化');

  // ---------- 仓储过滤：影子/非 passed/有缺口 daily 不得进入复用候选 ----------
  const strategyId = daily0.run.strategy_id;
  const T3 = '2027-03-15';
  const cutoff = service.knowledgeCutoffFor('CN', T3);
  async function insertSyntheticDaily({ isShadow, quality, pending, inputHash, inputManifest }) {
    const { rows } = await client.query(
      `INSERT INTO analytics.stock_selection_runs
         (strategy_id,market,run_kind,as_of_date,knowledge_cutoff,execution_status,quality_status,business_status,
          input_hash,input_manifest,pending_count,selected_count,period_type,period_key,revision,is_shadow)
       VALUES($1,'CN','daily',$2::date,$3::timestamptz,'succeeded',$4,'eligible',$5,$6::jsonb,$7,0,'day',$8,1,$9)
       RETURNING run_id`,
      [strategyId, T3, cutoff, quality, inputHash, JSON.stringify(inputManifest), pending,
        PERIODS.periodKeyOf('day', T3), isShadow]);
    return Number(rows[0].run_id);
  }
  const fakeManifest = { computationInputHash: 'hash-x', computationOutputHash: 'hash-y' };
  const shadowId = await insertSyntheticDaily({
    isShadow: true, quality: 'passed', pending: 0, inputHash: 'b4-shadow', inputManifest: fakeManifest,
  });
  const partialId = await insertSyntheticDaily({
    isShadow: false, quality: 'partial', pending: 0, inputHash: 'b4-partial', inputManifest: fakeManifest,
  });
  const pendingId = await insertSyntheticDaily({
    isShadow: false, quality: 'passed', pending: 2, inputHash: 'b4-pending', inputManifest: fakeManifest,
  });
  const validId = await insertSyntheticDaily({
    isShadow: false, quality: 'passed', pending: 0, inputHash: 'b4-valid', inputManifest: fakeManifest,
  });
  const candidates = await repo.listReusableDailyRuns(client, {
    market: 'CN', strategyId, asOfDate: T3, knowledgeCutoff: cutoff,
  });
  const candidateIds = candidates.map(item => Number(item.runId));
  ok(!candidateIds.includes(shadowId), '影子 daily 不得进入复用候选');
  ok(!candidateIds.includes(partialId), 'quality_status=partial 的 daily 不得进入复用候选');
  ok(!candidateIds.includes(pendingId), '存在待裁决缺口的 daily 不得进入复用候选');
  eq(candidateIds.join(','), String(validId), '只有 passed 且无缺口的非影子 daily 可进入复用候选');
  ok(candidates[0].computationInputHash === 'hash-x' && candidates[0].computationOutputHash === 'hash-y',
    '复用候选必须原样带出输入/输出哈希供服务层比对');
}

function assertRejected(result, label) {
  eq(result.run.source_daily_run_id, null, `${label} → 不得记录 source_daily_run_id`);
  const reuse = (result.run.input_manifest && result.run.input_manifest.computationReuse) || {};
  eq(reuse.reused, false, `${label} → 必须拒绝复用`);
  eq(reuse.reason, 'computation_hash_mismatch', `${label} → 拒绝原因必须是哈希不一致`);
}

async function runPhase(client, label, fn, sourceId) {
  await client.query('BEGIN');
  try {
    await fn(client, sourceId);
    console.log(`  [PASS] ${label}（事务内校验后回滚，不留脏数据）`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`${label} 失败：${error.message}`);
  }
  await client.query('ROLLBACK');
}

async function main() {
  const client = new Client({ ...testDatabaseConfig(), connectionTimeoutMillis: 10000 });
  await client.connect();
  const originalPoolQuery = pool.query;
  let poolRedirected = false;
  try {
    const sourceRow = await client.query('SELECT source_id FROM ops.data_sources ORDER BY priority, source_id LIMIT 1');
    assert.ok(sourceRow.rows[0], '测试库缺少 ops.data_sources，无法铺夹具');
    const sourceId = sourceRow.rows[0].source_id;

    await runPhase(client, 'A 真实 PG：loadUniverse 去 LATERAL 与内存 PB 回退等价口径', phaseUniverse, sourceId);

    // 让 computeAndPersist 后置的可见确认与仓储默认读取落到同一事务连接，避免读到未提交前的空结果。
    pool.query = (sql, params) => client.query(sql, params);
    poolRedirected = true;
    await runPhase(client, 'B 真实 PG：周度 computation_input_hash 受控复用与四类强制反例', phaseReuse, sourceId);
  } finally {
    if (poolRedirected) pool.query = originalPoolQuery;
    await client.end().catch(() => {});
  }
  console.log(`OK stock-selection-b4-db: ${checks} 项真实隔离库校验通过`);
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
