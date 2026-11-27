// 阶段 1B：实时筛选接口、5 处读路径轻量化承接与 selection_archive_light 单槽归档回归。
// 覆盖：权限 401、single-flight/LRU/分区水位、SQL 超时、并发限流、正式/个人 ≤30 席归档、
// listCandidates/findCandidate 实时还原、调度开关与新旧模式切换。
// 运行：npm.cmd run test:file -- server/test/stock-selection-realtime-and-light-archive.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { testDatabaseConfig } = require('./lib/testDatabase');
const repo = require('../repositories/stockSelectionRepository');
const pbProjectionRepository = require('../repositories/pbProjectionRepository');
const service = require('../services/stockSelectionService');
const PERIODS = require('../services/stockSelectionPeriods');
const refresh = require('../jobs/stockAnalysisRefresh');
const definitions = require('../services/jobDefinitions');
const datasetRegistry = require('../services/datasetPartitionRegistry');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

const AS_OF = '2026-11-18';
const NEWER_DATE = '2026-11-20';
const CODES = ['699101.SH', '699102.SH', '699103.SH', '699104.SH'];
const INDUSTRY_CODE = 'RT_IND';
const PREFIX = 'RT_LIGHT_TEST';

function tagOf(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function insertInstrument(client, { code, sourceId }) {
  const company = await client.query(
    `INSERT INTO core.companies(legal_name, short_name, country_code, company_type)
     VALUES($1,$2,'CN','listed') RETURNING company_id`,
    [`${PREFIX}${code}`, code]);
  const companyId = Number(company.rows[0].company_id);
  const instrument = await client.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status)
     VALUES($1,$2,'stock','CN','SSE','CNY',DATE '2010-01-01','listed') RETURNING instrument_id`,
    [code, `${PREFIX}${code}`]);
  const instrumentId = Number(instrument.rows[0].instrument_id);
  await client.query(
    `INSERT INTO core.company_instruments(company_id,instrument_id,relation_type,valid_from)
     VALUES($1,$2,'issued_by','2010-01-01')`, [companyId, instrumentId]);
  return { companyId, instrumentId };
}

async function insertBar(client, instrumentId, tradeDate, close, sourceId) {
  await client.query(
    `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount,bar_status,price_adjust,quality_status)
     VALUES($1,$2::date,$3,$4,$4,$4,$4,1000,10000,'terminal','none','passed')`,
    [instrumentId, tradeDate, sourceId, close]);
}

async function insertValuation(client, instrumentId, tradeDate, { pb, peTtm, marketCap }, sourceId) {
  await client.query(
    `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pb,pe_ttm,total_market_cap,currency_code)
     VALUES($1,$2::date,$3,$4,$5,$6,'CNY')`,
    [instrumentId, tradeDate, sourceId, pb, peTtm, marketCap]);
}

async function insertReport(client, { companyId, kind, periodEnd, announcedAt, sourceId, code }) {
  const { rows } = await client.query(
    `INSERT INTO fundamental.financial_reports
       (company_id,report_kind,period_end,period_type,statement_scope,announced_at,source_id,raw_payload,
        source_version,update_flag,is_current_version,report_type)
     VALUES($1,$2,$3::date,'annual','consolidated',$4::date,$5,$6::jsonb,'v1','',true,'1') RETURNING report_id`,
    [companyId, kind, periodEnd, announcedAt, sourceId, JSON.stringify({ ts_code: code })]);
  return rows[0].report_id;
}

async function insertFact(client, reportId, statementType, metricCode, value) {
  await client.query(
    `INSERT INTO fundamental.financial_facts(report_id,statement_type,metric_code,numeric_value,unit_code,currency_code,source_field,is_calculated)
     VALUES($1,$2,$3,$4,'CNY','CNY','src_field',false)`,
    [reportId, statementType, metricCode, value]);
}

async function insertDividend(client, instrumentId, sourceId, year, cashPerShare) {
  await client.query(
    `INSERT INTO fundamental.corporate_actions
       (instrument_id,action_type,fiscal_period_end,announced_at,ex_date,status,cash_per_share_pre_tax,
        stock_dividend_ratio,capitalization_ratio,total_cash_amount,currency_code,source_id,source_key)
     VALUES($1,'dividend',$2::date,$3::date,$4::date,'实施',$5,0,0,$6,'CNY',$7,$8)`,
    [instrumentId, `${year}-12-31`, `${year + 1}-05-01`, `${year + 1}-06-15`, cashPerShare, cashPerShare * 2e8, sourceId,
      `RT-DIV-${instrumentId}-${year}`]);
}

async function seedCalendar(client) {
  const start = new Date('2025-12-01T00:00:00Z');
  const end = new Date(`${AS_OF}T00:00:00Z`);
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = cursor.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    await client.query(
      `INSERT INTO market.trade_calendar(exchange,trade_date,is_open) VALUES('SSE',$1::date,true)
       ON CONFLICT(exchange,trade_date) DO NOTHING`, [cursor.toISOString().slice(0, 10)]);
  }
}

async function seedFixture(client, tag) {
  const source = await client.query(
    `SELECT source_id FROM ops.data_sources WHERE source_code = 'lixinger_official' LIMIT 1`);
  assert.ok(source.rows[0], '隔离库缺少 lixinger_official 数据源');
  const sourceId = source.rows[0].source_id;
  await seedCalendar(client);

  const taxonomy = await client.query(
    `SELECT taxonomy_id FROM core.industry_taxonomies WHERE taxonomy_code='SW2021' LIMIT 1`);
  assert.ok(taxonomy.rows[0], '隔离库缺少 SW2021 行业分类');
  const node = await client.query(
    `INSERT INTO core.industry_nodes(taxonomy_id,industry_code,industry_name,level)
     VALUES($1,$2,'实时筛选测试行业',1) RETURNING industry_node_id`,
    [taxonomy.rows[0].taxonomy_id, INDUSTRY_CODE]);
  const nodeId = node.rows[0].industry_node_id;

  const stocks = [];
  for (let index = 0; index < CODES.length; index++) {
    const code = CODES[index];
    const { companyId, instrumentId } = await insertInstrument(client, { code, sourceId });
    await client.query(
      `INSERT INTO core.company_industry_memberships(company_id,industry_node_id,source_id,valid_from,is_current)
       VALUES($1,$2,$3,'2010-01-01',true)`, [companyId, nodeId, sourceId]);
    await insertValuation(client, instrumentId, AS_OF, {
      pb: String(1.1 + index * 0.1), peTtm: String(7 + index), marketCap: '50000000000',
    }, sourceId);
    await insertBar(client, instrumentId, AS_OF, 10 + index, sourceId);
    for (let year = 2015; year <= 2025; year++) {
      const reportId = await insertReport(client, {
        companyId, kind: 'income', periodEnd: `${year}-12-31`, announcedAt: `${year + 1}-03-31`,
        sourceId, code,
      });
      await insertFact(client, reportId, 'income', 'net_profit_parent', 1e9);
      await insertFact(client, reportId, 'balance', 'equity_parent', 5e10);
      // 组合成员基本面字段（资产负债率 / 利润同比）需要同一报告的资产与负债合计。
      const balanceReportId = await insertReport(client, {
        companyId, kind: 'balance', periodEnd: `${year}-12-31`, announcedAt: `${year + 1}-03-31`,
        sourceId, code,
      });
      await insertFact(client, balanceReportId, 'balance', 'total_assets', 1e10);
      await insertFact(client, balanceReportId, 'balance', 'total_liabilities', 6e9);
      await insertDividend(client, instrumentId, sourceId, year, 0.5);
    }
    stocks.push({ code, companyId, instrumentId });
  }
  await client.query(
    `INSERT INTO market.index_valuation_history(index_code,valuation_method,trade_date,close,pe_ttm,pb,source_code)
     VALUES('000985','market_cap_weighted',$1::date,6000,15,1.5,'lixinger_official')
     ON CONFLICT DO NOTHING`, [AS_OF]);
  await client.query(
    `INSERT INTO users (username, password, accounts, role, status, stock_selection_settings, stock_selection_settings_revision)
     VALUES ($1, 'x', '[]', 'user', 'active', '{"excludedInstruments":[]}'::jsonb, 1)`, [tag]);
  return { sourceId, stocks, companyIds: stocks.map(item => item.companyId), instrumentIds: stocks.map(item => item.instrumentId) };
}

async function rebuildPbProjection(client, stockIds) {
  await client.query(
    `DELETE FROM analytics.stock_selection_universe_artifacts WHERE market='CN' AND target_date=$1::date`, [AS_OF]);
  await pbProjectionRepository.rebuildProjectionRange({
    market: 'CN',
    fromDate: '2016-11-18',
    toDate: AS_OF,
    months: pbProjectionRepository.monthsBetween('2016-11-18', AS_OF),
    instrumentIds: stockIds,
  }, client);
}

async function cleanup(client, tag, companyIds) {
  await client.query(
    `DELETE FROM analytics.stock_selection_runs r USING analytics.stock_selection_strategies s
      WHERE r.strategy_id=s.strategy_id AND s.version=$1`, [tag]).catch(() => {});
  await client.query(`DELETE FROM analytics.stock_selection_strategies WHERE version=$1`, [tag]).catch(() => {});
  await client.query(`DELETE FROM users WHERE username=$1`, [tag]).catch(() => {});
  await client.query(
    `DELETE FROM analytics.stock_selection_universe_artifacts WHERE market='CN' AND target_date=$1::date`, [AS_OF]).catch(() => {});
  if (companyIds && companyIds.length) {
    await client.query(`DELETE FROM fundamental.financial_facts WHERE report_id IN (
      SELECT report_id FROM fundamental.financial_reports WHERE company_id = ANY($1::bigint[]))`, [companyIds]).catch(() => {});
    await client.query(`DELETE FROM fundamental.financial_reports WHERE company_id = ANY($1::bigint[])`, [companyIds]).catch(() => {});
    await client.query(`DELETE FROM fundamental.corporate_actions WHERE instrument_id IN (
      SELECT instrument_id FROM core.company_instruments WHERE company_id = ANY($1::bigint[]))`, [companyIds]).catch(() => {});
    await client.query(`DELETE FROM core.company_industry_memberships WHERE company_id = ANY($1::bigint[])`, [companyIds]).catch(() => {});
    await client.query(`DELETE FROM core.company_instruments WHERE company_id = ANY($1::bigint[])`, [companyIds]).catch(() => {});
    await client.query(`DELETE FROM core.instruments WHERE canonical_code = ANY($1::text[])`, [CODES]).catch(() => {});
    await client.query(`DELETE FROM core.companies WHERE company_id = ANY($1::bigint[])`, [companyIds]).catch(() => {});
  }
  await client.query(`DELETE FROM core.industry_nodes WHERE industry_code=$1`, [INDUSTRY_CODE]).catch(() => {});
}

async function permissionChecks() {
  const stockSelectionRouter = require('../routes/stockSelection');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (!req.session) req.session = {}; next(); });
  app.use('/api/stock-selection', stockSelectionRouter);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/stock-selection`;
  try {
    const post = await fetch(`${base}/screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market: 'CN', asOfDate: AS_OF }),
    });
    eq(post.status, 401, '未登录 POST /screen 必须 401');
    const get = await fetch(`${base}/screen/stocks/600000.SH?market=CN&asOfDate=${AS_OF}`);
    eq(get.status, 401, '未登录 GET /screen/stocks/:code 必须 401');
    ok(/requireLogin/.test(require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'stockSelection.js'), 'utf8')),
      '实时接口必须显式挂载 requireLogin');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function realtimeChecks(client, fixture) {
  const dailyInput = {
    market: 'CN', asOfDate: AS_OF, runKind: 'daily', periodType: 'day',
    periodKey: PERIODS.periodKeyOf('day', AS_OF), strategyCode: 'investment_essentials_adapted_v1', positionRatio: 1,
  };
  const daily = await service.computeAndPersist(dailyInput);
  const run = await repo.findRun(daily.runId);
  eq(run.run_kind, 'daily');
  eq(run.input_manifest.archiveMode, 'light', '正式日归档必须标记 archiveMode=light');
  ok(Array.isArray(run.input_manifest.industryIdentityCounts) && run.input_manifest.industryIdentityCounts.length > 0,
    '正式轻量归档必须冻结全市场一级行业计数摘要');
  const candidateCount = (await client.query(
    'SELECT COUNT(*)::int AS c FROM analytics.stock_selection_candidates WHERE run_id=$1', [daily.runId])).rows[0].c;
  const memberCount = (await client.query(
    'SELECT COUNT(*)::int AS c FROM analytics.stock_selection_portfolio_members WHERE run_id=$1', [daily.runId])).rows[0].c;
  eq(Number(candidateCount), Number(memberCount), '正式归档只落入选成员对应候选');
  ok(Number(candidateCount) <= 30, '正式归档候选必须 ≤30 行');

  // 5 处承接：listMembers / listCandidates / industryIdentityCounts / findCandidate
  const members = await repo.listMembers(daily.runId);
  eq(members.length, Number(memberCount), 'listMembers 的 ≤30 席 JOIN 必须 100% 命中');
  const counts = await repo.listIndustryIdentityCounts(daily.runId);
  ok(counts.length > 0 && counts.every(row => row.affected_count > 0), '行业计数优先来自 input_manifest 摘要');

  service.resetScreenStateForTests();
  const first = await service.screenStocksRealtime({ market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1', limit: 200 });
  ok(first.total >= CODES.length, `实时候选必须覆盖全市场（实得 ${first.total}）`);
  eq(first.cache.hit, false, '首次调用必须冷计算');
  eq(first.portfolio.selectedCount, Number(memberCount), '实时组合必须与归档成员数一致');
  ok(first.portfolio.members.length > 0, '实时组合必须有成员');
  for (const member of first.portfolio.members) {
    ok(member.debtToAssetRatio !== null && member.debtToAssetRatio !== undefined, '实时组合成员必须带资产负债率');
    ok(member.debtToAssetPeriodEnd, '实时组合成员必须带资产负债率报告期');
    ok(member.latestProfitYoy !== null && member.latestProfitYoy !== undefined, '实时组合成员必须带最近财报利润同比');
    ok(member.latestProfitPeriodEnd, '实时组合成员必须带利润同比报告期');
    ok(member.currentPb !== null && member.currentPb !== undefined, '实时组合成员必须带当前 PB');
    ok(member.rankReady !== null && member.rankReady !== undefined, '实时组合成员必须带 rankReady');
    for (const field of ['currentPe', 'dividendYield', 'totalScore', 'pbPositiveExtremaRatio', 'valuationStatus',
      'valuationPassReason', 'ttmProfitStatus']) {
      ok(Object.prototype.hasOwnProperty.call(member, field), '实时组合成员必须显式携带字段 ' + field);
    }
  }
  // P1-1 反例：首屏只取 1 行候选时，组合仍必须由全量结果构造并补齐全部展示字段。
  const firstRow = await service.screenStocksRealtime({
    market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1', limit: 1,
  });
  eq(firstRow.candidates.length, 1, 'limit=1 时首屏候选只能有 1 行');
  ok(firstRow.portfolio.members.length === first.portfolio.members.length,
    '组合成员不得受首屏候选行数限制');
  const beyondFirstPage = firstRow.portfolio.members[firstRow.portfolio.members.length - 1];
  ok(beyondFirstPage && beyondFirstPage.debtToAssetRatio !== null && beyondFirstPage.latestProfitYoy !== null,
    '超出首屏候选行的组合成员仍必须带完整基本面字段');
  const second = await service.screenStocksRealtime({ market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1', limit: 200 });
  eq(second.cache.hit, true, '同键二次调用必须命中缓存');

  // listCandidates 轻量批次自动路由实时引擎
  service.resetScreenStateForTests();
  const listed = await service.getCandidates({ runId: daily.runId, limit: 200, offset: 0 });
  ok(listed.total >= CODES.length, '轻量归档批次的候选列表必须由实时引擎还原全市场');

  // 单股详情：入选成员 + 未入选（如存在）都必须可查
  const detail = await service.getStockDetail({ runId: daily.runId, code: members[0].code });
  ok(detail && detail.candidate.code === members[0].code, '轻量批次入选成员单股详情必须可读');
  const nonMember = first.candidates.find(item => !members.some(member => Number(member.instrument_id) === Number(item.instrumentId)));
  if (nonMember) {
    const nonDetail = await service.getStockDetail({ runId: daily.runId, code: nonMember.code });
    ok(nonDetail && nonDetail.candidate.filterStatus, '轻量批次未入选单股必须由实时引擎还原排除原因');
  }

  // single-flight：同键并发 10 次只查 1 次十年 PB 窗口
  service.resetScreenStateForTests();
  const originalLoadPbWindow = repo.loadPbWindow;
  let pbLoads = 0;
  repo.loadPbWindow = async (...args) => {
    pbLoads += 1;
    await new Promise(resolve => setTimeout(resolve, 80));
    return originalLoadPbWindow.apply(repo, args);
  };
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => service.screenStocksRealtime({
      market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1', limit: 50,
    })));
    eq(pbLoads, 1, '同键并发必须 single-flight，DB 只查 1 次');
    ok(results.every(item => item.total === results[0].total), '并发结果必须一致');
  } finally {
    repo.loadPbWindow = originalLoadPbWindow;
  }

  // 并发限流：不同日期在 maxConcurrent=1 时，第二个请求短等待后 503
  service.resetScreenStateForTests();
  repo.loadPbWindow = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 250));
    return originalLoadPbWindow.apply(repo, args);
  };
  try {
    const slow = service.screenStocksRealtime({
      market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1', limit: 50,
    }, { maxConcurrent: 1, waitMs: 60 });
    await new Promise(resolve => setTimeout(resolve, 20));
    let overload = null;
    try {
      await service.screenStocksRealtime({
        market: 'CN', asOfDate: '2026-11-17', strategyCode: 'investment_essentials_adapted_v1', limit: 50,
      }, { maxConcurrent: 1, waitMs: 60 });
    } catch (error) {
      overload = error;
    }
    await slow.catch(() => {});
    ok(overload && overload.status === 503 && /稍后重试/.test(overload.message), '超过并发信号量必须返回 503 中文提示');
  } finally {
    repo.loadPbWindow = originalLoadPbWindow;
  }

  // statement_timeout：请求级硬中止
  service.resetScreenStateForTests();
  const oldTimeout = process.env.SCREEN_STATEMENT_TIMEOUT_MS;
  process.env.SCREEN_STATEMENT_TIMEOUT_MS = '50';
  repo.loadPbWindow = async (params, tx) => {
    await tx.query('SELECT pg_sleep(0.3)');
    return originalLoadPbWindow.apply(repo, [params, tx]);
  };
  try {
    let timeoutError = null;
    try {
      await service.screenStocksRealtime({ market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1', limit: 10 });
    } catch (error) {
      timeoutError = error;
    }
    ok(timeoutError && String(timeoutError.code) === '57014', `SQL 超时必须触发 statement_timeout（实得 ${timeoutError && timeoutError.code}）`);
  } finally {
    repo.loadPbWindow = originalLoadPbWindow;
    if (oldTimeout === undefined) delete process.env.SCREEN_STATEMENT_TIMEOUT_MS;
    else process.env.SCREEN_STATEMENT_TIMEOUT_MS = oldTimeout;
  }

  // 分区水位：今日凌晨入库不失效历史日期缓存；历史分区更新才失效
  service.resetScreenStateForTests();
  repo.loadPbWindow = async (...args) => { pbLoads += 1; return originalLoadPbWindow.apply(repo, args); };
  pbLoads = 0;
  try {
    await client.query(
      `INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,published_at,data_as_of)
       VALUES('stock_daily','CN',$1::date,'published',now(),$1::date)
       ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE SET published_at=now()`, [AS_OF]);
    const base = await service.screenStocksRealtime({ market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1', limit: 10 });
    eq(base.cache.hit, false, '水位初始化后首次必须冷计算');
    const afterFirst = pbLoads;
    await client.query(
      `INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,published_at,data_as_of)
       VALUES('stock_daily','CN',$1::date,'published',now(),$1::date)
       ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE SET published_at=now()`, [NEWER_DATE]);
    const stillHit = await service.screenStocksRealtime({ market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1', limit: 10 });
    eq(stillHit.cache.hit, true, '更晚日期的分区入库不得让历史日期缓存失效');
    eq(pbLoads, afterFirst, '历史日期缓存命中时不得重复跑全市场查询');
    await client.query(
      `UPDATE ops.dataset_partitions SET published_at = now() + interval '1 second'
        WHERE dataset_code='stock_daily' AND scope_key='CN' AND partition_key=$1::date`, [AS_OF]);
    const invalidated = await service.screenStocksRealtime({ market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1', limit: 10 });
    eq(invalidated.cache.hit, false, '目标日依赖分区更新必须让缓存失效');
  } finally {
    repo.loadPbWindow = originalLoadPbWindow;
    await client.query(`DELETE FROM ops.dataset_partitions WHERE dataset_code='stock_daily' AND scope_key='CN' AND partition_key=ANY($1::date[])`,
      [[AS_OF, NEWER_DATE]]).catch(() => {});
  }

  // 个人测算：轻量源批次读自己的 ≤30 行候选，并保留幂等键与上一份个人基线
  const personal = await service.createSimulation({
    username: fixture.tag, sourceRunId: daily.runId, positionRatio: 1,
    clientRequestId: `rt-${fixture.tag}`,
  });
  const personalRun = await repo.findRun(personal.runId);
  eq(personalRun.input_manifest.archiveMode, 'light', '个人测算必须标记轻量归档');
  eq(personalRun.input_manifest.candidatesRefMode, 'self', '轻量源批次的个人候选必须解析到自身');
  const ownCount = Number((await client.query(
    'SELECT COUNT(*)::int AS c FROM analytics.stock_selection_candidates WHERE run_id=$1', [personal.runId])).rows[0].c);
  const ownMembers = Number((await client.query(
    'SELECT COUNT(*)::int AS c FROM analytics.stock_selection_portfolio_members WHERE run_id=$1', [personal.runId])).rows[0].c);
  eq(ownCount, ownMembers, '个人测算候选必须与成员一一对应');
  ok(ownCount <= 30, '个人候选必须 ≤30 行');
  const again = await service.createSimulation({
    username: fixture.tag, sourceRunId: daily.runId, positionRatio: 1,
    clientRequestId: `rt-${fixture.tag}`,
  });
  eq(Number(again.runId), Number(personal.runId), '同 clientRequestId 必须幂等复用个人批次');
  const previous = await repo.previousPersonalMembers({
    market: 'CN', sourceRunId: daily.runId, excludeRunId: personal.runId,
    ownerUsername: fixture.tag, ownerSubjectId: personalRun.owner_subject_id,
  });
  ok(previous.run === null || previous.rows.length <= 30, 'previousPersonalMembers 必须可从 ≤30 行候选解析');
  const personalListed = await service.getCandidates({ runId: personal.runId, limit: 200, offset: 0 });
  ok(personalListed.total >= CODES.length, '个人轻量批次候选列表必须由实时引擎还原全市场');
  const excludedCode = personalListed.rows.find(row => row.personalExcluded === true);
  if (excludedCode) {
    const personalDetail = await service.getStockDetail({ runId: personal.runId, code: excludedCode.code });
    ok(personalDetail && personalDetail.candidate.filterStatus, '个人未入选/被排除单股详情必须可实时还原');
  }

  // STOCK_SELECTION_REALTIME=0：实时接口停用，读路径回退原表
  const oldRealtime = process.env.STOCK_SELECTION_REALTIME;
  process.env.STOCK_SELECTION_REALTIME = '0';
  try {
    let disabled = null;
    try { await service.screenStocksRealtime({ market: 'CN', asOfDate: AS_OF, strategyCode: 'investment_essentials_adapted_v1' }); }
    catch (error) { disabled = error; }
    ok(disabled && disabled.status === 503 && /停用/.test(disabled.message), 'STOCK_SELECTION_REALTIME=0 必须返回明确停用状态');
    const fallback = await service.getCandidates({ runId: daily.runId, limit: 200, offset: 0 });
    eq(fallback.total, Number(candidateCount), '实时开关关闭后候选读路径必须回退轻量归档原表');
  } finally {
    if (oldRealtime === undefined) delete process.env.STOCK_SELECTION_REALTIME;
    else process.env.STOCK_SELECTION_REALTIME = oldRealtime;
  }

  return { dailyRunId: daily.runId, memberCount };
}

async function scheduleChecks() {
  const definition = definitions.getJobDefinition('stock_analysis_refresh');
  ok(refresh.SELECTION_MODES.includes('selection_archive_light'), 'selection_archive_light 必须登记为选股模式');
  ok(definition.additionalSchedules.some(item => item.mode === 'selection_archive_light'),
    '默认 STOCK_SELECTION_LEGACY_SLOTS=0 时 18:40 必须启用 selection_archive_light 单槽');
  ok(!definition.additionalSchedules.some(item => item.mode === 'selection_periodic'),
    '默认关闭旧 selection_periodic 裂变槽');
  eq(definition.modeDependencyCodes.selection_archive_light.length, 0, 'archive_light 模式必须显式声明无任务依赖');
  eq(definition.modeDatasetDependencies.selection_archive_light.length, 0, 'archive_light 模式必须显式声明无分区依赖');
  eq(definition.modeExternalCallLimits.selection_archive_light, 0, 'archive_light 必须声明外采为 0');
  ok(Array.isArray(definition.datasetPublicationByMode.selection_archive_light.optionalPublish),
    'archive_light 必须显式声明可发布数据集');
  ok(definitions.SELECTION_STAGE_KINDS.selection_archive_light.includes('archive_light_completed'),
    'archive_light 必须有明确完成终态');

  // STOCK_SELECTION_LEGACY_SLOTS=1 在独立进程恢复原 18:40 selection_periodic
  const { execFileSync } = require('child_process');
  const output = execFileSync(process.execPath, ['-e', `
    process.env.STOCK_SELECTION_LEGACY_SLOTS='1';
    const d=require('./server/services/jobDefinitions').getJobDefinition('stock_analysis_refresh');
    console.log(d.additionalSchedules.map(item=>item.mode).join(','));
  `], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, STOCK_SELECTION_LEGACY_SLOTS: '1' } }).toString().trim();
  ok(output.split(',').includes('selection_periodic'), 'STOCK_SELECTION_LEGACY_SLOTS=1 必须恢复 18:40 selection_periodic');
  ok(!output.split(',').includes('selection_archive_light'), '切换旧链路时不得同时启用 archive_light');

  // 单槽串行：2 市场 × 策略集合（默认策略 + V2 + 格雷厄姆，去重）× 日/周 + 影子，最后开市日顺带季度
  const calls = [];
  const quarterCalls = [];
  const strategies = refresh.archiveLightStrategies();
  ok(strategies.includes(service.DEFAULT_STRATEGY_CODE), 'archive_light 必须纳入当前默认策略（尊重 STOCK_SELECTION_STRATEGY）');
  ok(strategies.includes('investment_essentials_adapted_v2') && strategies.includes('graham_net_net_v1'),
    'archive_light 必须同时归档 V2 与格雷厄姆');
  eq(new Set(strategies).size, strategies.length, 'archive_light 策略集合必须去重');
  const shadowStrategies = strategies.filter(code => code !== 'graham_net_net_v1');
  const expectedPeriodicCalls = 2 * strategies.length * 2 + 2 * shadowStrategies.length * 2;
  const expectedQuarterCalls = 2 * strategies.length;
  const originals = {
    runPeriodic: service.runPeriodic,
    runQuarterly: service.runQuarterly,
    resolvePeriodTarget: service.resolvePeriodTarget,
    publishSnapshot: datasetRegistry.publishDatasetSnapshot,
  };
  const oldShadow = process.env.STOCK_SELECTION_SHADOW;
  process.env.STOCK_SELECTION_SHADOW = '1';
  service.runPeriodic = async input => {
    calls.push(input);
    return { ok: true, status: 'succeeded', runId: calls.length, selectedCount: 1, stageCompletedKind: 'daily_recorded' };
  };
  service.runQuarterly = async input => {
    quarterCalls.push(input);
    return { ok: true, status: 'succeeded', quarterDate: AS_OF, selectedCount: 1, qualityStatus: 'passed', businessStatus: 'eligible', runId: 900 + quarterCalls.length, published: true };
  };
  service.resolvePeriodTarget = async ({ periodType, date }) => ({ asOfDate: date });
  datasetRegistry.publishDatasetSnapshot = async () => ({ published: true });
  try {
    const result = await refresh.runSelectionArchiveLight('test', { targetDate: AS_OF, requestId: 'rt-schedule' });
    eq(result.stageComplete, true, '全部分市场/策略成功后 archive_light 必须完成');
    eq(result.stageCompletedKind, 'archive_light_completed', 'archive_light 完成终态必须正确');
    eq(calls.length, expectedPeriodicCalls, '必须串行跑 2 市场×策略集合×日/周 + 影子');
    eq(quarterCalls.length, expectedQuarterCalls, '季度最后开市日必须为 2 市场×策略集合各落一次季指针');
    const keys = new Set(calls.map(item => `${item.market}:${item.strategyCode}:${item.periodType}:${item.shadow === true}`));
    eq(keys.size, calls.length, 'archive_light 必须按市场/策略/周期/影子逐项独立执行，不裂变任务码');
    ok(result.items.every(item => item.mode !== 'selection_quarterly' || item.ok === true), '季度归档项必须成功');
    ok(Array.isArray(result.completedKeys) && result.completedKeys.length === expectedPeriodicCalls + expectedQuarterCalls,
      '必须记录全部已成功子项 completedKeys');

    // P1-3 反例：局部失败续跑不得重跑已成功子项。
    calls.length = 0;
    quarterCalls.length = 0;
    const resumed = await refresh.runSelectionArchiveLight('test', {
      targetDate: AS_OF, requestId: 'rt-schedule', completedKeys: result.completedKeys,
    });
    eq(calls.length, 0, '续跑必须跳过已成功子项，不得重复 runPeriodic');
    eq(quarterCalls.length, 0, '续跑必须跳过已成功季度子项');
    ok(resumed.items.every(item => item.status === 'skipped' && item.reason === 'already_completed'),
      '续跑结果必须显式标记 already_completed');
    eq(resumed.stageComplete, true, '全部子项已完成时续跑必须直接收尾');
  } finally {
    service.runPeriodic = originals.runPeriodic;
    service.runQuarterly = originals.runQuarterly;
    service.resolvePeriodTarget = originals.resolvePeriodTarget;
    datasetRegistry.publishDatasetSnapshot = originals.publishSnapshot;
    if (oldShadow === undefined) delete process.env.STOCK_SELECTION_SHADOW;
    else process.env.STOCK_SELECTION_SHADOW = oldShadow;
  }
}

async function defaultStrategyConsistencyChecks(client, fixture) {
  // F-01 反例：省略 strategyCode 时，列表 POST 与单股 GET 必须落到同一缺省策略和同一缓存键；
  // F-02 反例：纯实时单股的顶层 market/asOfDate/strategyVersion 不能为 null。
  const identity = await client.query(
    'SELECT subject_id::text AS subject_id, auth_version FROM users WHERE username=$1', [fixture.tag]);
  assert.ok(identity.rows[0], '隔离库缺少测试用户身份');
  const session = {
    user: fixture.tag,
    subjectId: identity.rows[0].subject_id,
    authVersion: identity.rows[0].auth_version,
  };
  const stockSelectionRouter = require('../routes/stockSelection');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = Object.assign({}, session); next(); });
  app.use('/api/stock-selection', stockSelectionRouter);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/stock-selection`;
  const originalLoadPbWindow = repo.loadPbWindow;
  let pbLoads = 0;
  repo.loadPbWindow = async (...args) => { pbLoads += 1; return originalLoadPbWindow.apply(repo, args); };
  service.resetScreenStateForTests();
  try {
    const post = await fetch(`${base}/screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market: 'CN', asOfDate: AS_OF, limit: 200 }),
    });
    eq(post.status, 200, '省略 strategyCode 的列表请求必须成功');
    const list = await post.json();
    eq(list.strategyCode, service.DEFAULT_STRATEGY_CODE, '省略 strategyCode 时列表必须使用统一缺省策略');
    eq(list.cache.hit, false, '反例基线：列表首次请求必须冷计算');
    const loadsAfterList = pbLoads;
    const code = list.candidates[0] && list.candidates[0].code;
    ok(code, '反例基线：列表必须返回可查询的候选');
    const detailResponse = await fetch(`${base}/screen/stocks/${encodeURIComponent(code)}?market=CN&asOfDate=${AS_OF}`);
    eq(detailResponse.status, 200, '省略 strategyCode 的单股请求必须成功');
    const detail = await detailResponse.json();
    eq(detail.strategyVersion, list.strategyCode, '单股详情必须命中与列表相同的策略版本');
    eq(pbLoads, loadsAfterList, '单股详情必须复用列表缓存，不得二次冷计算');
    ok(detail.market === 'CN', '实时单股详情顶层 market 必须回填');
    ok(detail.asOfDate === AS_OF, '实时单股详情顶层 asOfDate 必须回填');
    ok(detail.strategyVersion, '实时单股详情顶层 strategyVersion 必须非空');
  } finally {
    repo.loadPbWindow = originalLoadPbWindow;
    service.resetScreenStateForTests();
    await new Promise(resolve => server.close(resolve));
  }
}

async function run() {
  await permissionChecks();

  const client = new Client({ ...testDatabaseConfig(), connectionTimeoutMillis: 10000 });
  await client.connect();
  const tag = tagOf('rtlight');
  let fixture = null;
  try {
    fixture = await seedFixture(client, tag);
    fixture.tag = tag;
    await rebuildPbProjection(client, fixture.instrumentIds);
    await realtimeChecks(client, fixture);
    await defaultStrategyConsistencyChecks(client, fixture);
  } finally {
    await cleanup(client, tag, fixture && fixture.companyIds);
    await client.end().catch(() => {});
  }
  await scheduleChecks();
  console.log(`stock-selection-realtime-and-light-archive.test.js passed (${checks} checks)`);
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
