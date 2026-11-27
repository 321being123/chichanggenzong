// Batch 3 真实隔离库回归（B3-1 个人测算零候选复制 + B3-2 淘汰详情裁剪、历史回放指纹、
// 分红原文红线与选股批次分级留存）。
//
// 主体在事务内写入并回滚；另有一段"已提交夹具 → 走真实服务读入口 → 末尾清理并断言零残留"，
// 因为 service.getCandidates/getPortfolio/getStockDetail 使用连接池，看不到未提交事务。
// 运行：npm.cmd run test:file -- server/test/stock-selection-b3-db.test.js
'use strict';
const assert = require('assert');
const { Client } = require('pg');
const { testDatabaseConfig } = require('./lib/testDatabase');
const repo = require('../repositories/stockSelectionRepository');
const retentionRepository = require('../repositories/storageRetentionRepository');
const retentionService = require('../services/storageRetention');
const service = require('../services/stockSelectionService');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

const MARKET = 'CN';
const AS_OF = '2026-11-20';
const CUTOFF = '2030-01-01T00:00:00+08:00';
const IND = { code: 'B3_IND', name: 'B3 测试行业', system: 'SW2021', version: '2021' };

function tagOf(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function yearsOf(count = 11) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const year = 2014 + i;
    rows.push({
      year, profit: 100000000 + i, profitCurrency: 'CNY',
      dividend: 1000000 + i, dividendKnown: true, dividendCurrencies: ['CNY'],
      dividendCurrencyUnknown: false, complete: true, sourceVersion: `sv-${year}`,
      dividendBasis: 'annual_implemented_amount',
    });
  }
  return rows;
}

function candidate({ instrumentId, companyId = null, code, status, order, industry = IND, annual = null, rules = null }) {
  return {
    instrumentId, companyId, code, name: `B3测试${code}`, industry,
    currentPb: 0.8, historicalPbMax: 1.2, currentPe: 8, profitStatus: 'profit',
    dividendYield: 0.04, equityAmount: 100, equityCurrency: 'CNY', equityCny: 100,
    fxRate: null, fxDate: null,
    pbRank: status === 'PASS' ? order : null, peRank: status === 'PASS' ? order : null,
    dividendRank: status === 'PASS' ? order : null,
    totalScore: status === 'PASS' ? 100 - order : null,
    selectionOrder: status === 'PASS' ? order : null,
    filterStatus: status,
    dataQualityStatus: status === 'PASS' ? 'complete' : 'partial',
    exclusionReasons: status === 'PASS' ? [] : ['pb_above_threshold'],
    rules: rules || { R01: { code: 'R01', status, reason: status === 'PASS' ? null : 'pb_above_threshold', value: 1.9, threshold: 1.5 } },
    anomaly: { status: 'PASS', latestYear: 2024, profitY: 100, profitSum: 1000, comparedYears: [] },
    rankReady: status === 'PASS',
    rankBlockReasons: [],
    detail: {
      price: 10, priceDate: AS_OF,
      annual: annual || { latestYear: 2024, years: yearsOf(), currency: 'CNY', listingYear: 2010, sourceGapYears: [] },
      equity: { amount: 100, currency: 'CNY', periodEnd: '2024-12-31', announcedAt: '2025-03-28', reportId: 1 },
      pbWindow: { maxPb: 1.2, coveredDays: 2000, expectedDays: 2000, gapDays: 0 },
      ttm: { status: 'computed', basis: 'computed_ttm', evidenceRef: { reports: [1, 2, 3] } },
    },
    ttmEvidenceRef: { reports: [1, 2, 3] },
    ttmStatusBasis: 'computed_ttm',
  };
}

async function seedFixtures(client, { userTag, codes, withFinancials = false }) {
  const sources = await client.query(
    `SELECT source_id FROM ops.data_sources WHERE source_code = 'lixinger_official' LIMIT 1`);
  const sourceId = sources.rows[0] ? sources.rows[0].source_id : null;
  assert(sourceId, '隔离库缺少 lixinger_official 数据源');

  const strategy = await client.query(
    `INSERT INTO analytics.stock_selection_strategies
       (strategy_code, market, version, formula_version, parameters, content_hash)
     VALUES ('v2_valuation_rank_v1', $1, $2, 'b3-test', $3::jsonb, $4)
     RETURNING strategy_id`,
    [MARKET, userTag, JSON.stringify({ slotsPerMarket: 30, industryLimitRatio: 0.2 }), `hash-${userTag}`]);
  const strategyId = Number(strategy.rows[0].strategy_id);

  let companyId = null;
  let annualFromLoader = null;
  if (withFinancials) {
    const company = await client.query(
      `INSERT INTO core.companies (legal_name, short_name, country_code, company_type)
       VALUES ($1, $2, 'CN', 'listed') RETURNING company_id`,
      [`B3测试公司${userTag}`, userTag.slice(0, 8)]);
    companyId = Number(company.rows[0].company_id);
    const instrument = await client.query(
      `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, status)
       VALUES ($1, 'B3测试金融', 'stock', 'CN', 'SSE', 'CNY', '2010-01-01', 'listed') RETURNING instrument_id`,
      [codes.fail]);
    await client.query(
      `INSERT INTO core.company_instruments (company_id, instrument_id, relation_type, valid_from)
       VALUES ($1, $2, 'issued_by', '2010-01-01')`, [companyId, instrument.rows[0].instrument_id]);
    for (let year = 2014; year <= 2024; year++) {
      const report = await client.query(
        `INSERT INTO fundamental.financial_reports
           (company_id, report_kind, period_end, period_type, statement_scope, announced_at, available_at,
            source_id, source_version, raw_payload)
         VALUES ($1, 'income', $2::date, 'annual', 'consolidated', $3::date, $4::timestamptz, $5, $6, $7::jsonb)
         RETURNING report_id`,
        [companyId, `${year}-12-31`, '2025-03-28', '2025-03-28T12:00:00+08:00', sourceId, `rv-${year}`,
          JSON.stringify({ ts_code: codes.fail, currency: 'CNY', period_type: 'annual' })]);
      await client.query(
        `INSERT INTO fundamental.financial_facts (report_id, statement_type, metric_code, numeric_value, currency_code)
         VALUES ($1, 'income', 'net_profit_parent', $2, 'CNY')`,
        [report.rows[0].report_id, 100000000 + (year - 2014)]);
    }
    const params = { companyIds: [companyId], asOfDate: AS_OF, availableBefore: CUTOFF, market: MARKET };
    const profits = await repo.loadAnnualProfits(params, client);
    const dividends = await repo.loadAnnualDividends(params, client);
    annualFromLoader = service.annualFactsOf(
      profits.get(String(companyId)) || [], dividends.get(String(companyId)) || [], codes.fail, null, '2010-01-01');
  }

  const run = await client.query(
    `INSERT INTO analytics.stock_selection_runs
       (strategy_id, market, run_kind, as_of_date, knowledge_cutoff, execution_status, quality_status,
        business_status, input_hash, input_manifest, universe_count, pending_count, selected_count,
        market_pb, market_pe, benchmark_code, valuation_method, position_ratio, revision, published_at,
        period_type, period_key, computed_at, is_shadow)
     VALUES ($1, $2, 'daily', $3::date, $4::timestamptz, 'succeeded', 'passed', 'eligible',
             $5, '{"quality":{}}'::jsonb, 3, 0, 2, 1.0, 10.0, 'CSIALL', 'market_cap_weighted', 1, 1, now(),
             'day', $6, now(), false)
     RETURNING run_id`,
    [strategyId, MARKET, AS_OF, CUTOFF, `src-${userTag}`, `D:${AS_OF}`]);
  const sourceRunId = Number(run.rows[0].run_id);

  const rows = [
    candidate({ instrumentId: 1, companyId, code: codes.pass1, status: 'PASS', order: 1 }),
    candidate({ instrumentId: 2, code: codes.pass2, status: 'PASS', order: 2 }),
    candidate({ instrumentId: 3, companyId, code: codes.fail, status: 'FAIL', order: null, annual: annualFromLoader }),
  ];
  await repo.insertCandidates(client, sourceRunId, rows);

  await client.query(
    `INSERT INTO users (username, password, accounts, role, status, stock_selection_settings, stock_selection_settings_revision)
     VALUES ($1, 'x', '[]', 'user', 'active', $2::jsonb, 1)`,
    [userTag, JSON.stringify({
      excludedInstruments: [{ market: MARKET, code: codes.pass1, instrumentId: 1 }],
    })]);

  return { strategyId, sourceRunId, companyId, annualFromLoader };
}

async function insertRunRow(client, {
  strategyId, runKind, inputHash, owner = null, createdAtDaysAgo = 0,
  published = false, qualityStatus = 'passed', supersedes = null, sourceDaily = null,
  isShadow = false, asOf = AS_OF,
}) {
  const { rows } = await client.query(
    `INSERT INTO analytics.stock_selection_runs
       (strategy_id, market, run_kind, as_of_date, knowledge_cutoff, execution_status, quality_status,
        business_status, input_hash, input_manifest, universe_count, pending_count, selected_count,
        position_ratio, revision, published_at, period_type, supersedes_run_id, source_daily_run_id,
        owner_username, is_shadow, created_at)
     VALUES ($1, $2, $3, $4::date, $5::timestamptz, 'succeeded', $6, 'eligible', $7, '{}'::jsonb,
             0, 0, 0, 1, 1, $8::timestamptz, $9, $10, $11, $12, $13, now() - make_interval(days => $14))
     RETURNING run_id`,
    [strategyId, MARKET, runKind, asOf, CUTOFF, qualityStatus, inputHash, published ? new Date().toISOString() : null,
      runKind === 'daily' ? 'day' : runKind === 'weekly' ? 'week' : null, supersedes, sourceDaily, owner, isShadow, createdAtDaysAgo]);
  return Number(rows[0].run_id);
}

async function transactionalChecks(client) {
  const tag = tagOf('b3tx');
  const codes = { pass1: '994101.SH', pass2: '994102.SH', fail: '994103.SH' };
  await client.query('BEGIN');
  let rolledBack = false;
  try {
    // 物理对比前关闭 TOAST 压缩，让 pg_column_size 反映真实逻辑载荷：
    // 11 年 JSONB 结构重复度极高，压缩会把"裁剪前"压到比"裁剪后"还小，容易被误读成裁剪无效。
    // 本 DDL 只改列存储策略且随事务回滚，不重写表。
    await client.query('ALTER TABLE analytics.stock_selection_candidates ALTER COLUMN detail SET STORAGE EXTERNAL');
    const { strategyId, sourceRunId, companyId, annualFromLoader } = await seedFixtures(client, { userTag: tag, codes, withFinancials: true });
    // ---------- B3-1 写入侧：零候选复制 ----------
    const first = await service.createSimulation({
      username: tag, sourceRunId, positionRatio: 1,
    }, { tx: client });
    const personalRunId = Number(first.runId);
    const own = await client.query(
      `SELECT COUNT(*)::int AS count FROM analytics.stock_selection_candidates WHERE run_id = $1`, [personalRunId]);
    eq(own.rows[0].count, 0, '个人测算不得写入任何候选行');
    const memberCount = await client.query(
      `SELECT COUNT(*)::int AS count FROM analytics.stock_selection_portfolio_members WHERE run_id = $1`, [personalRunId]);
    eq(memberCount.rows[0].count, 1, '个人测算只写成员（剩余 PASS 1 只，另一只被本人排除）');
    const runRow = await repo.findRun(personalRunId, client);
    eq(runRow.supersedes_run_id !== null && Number(runRow.supersedes_run_id), sourceRunId, '个人批次必须绑定来源批次');
    eq(runRow.input_manifest.candidatesRefMode, 'source_run', '必须显式标记候选引用模式');
    ok(Array.isArray(runRow.input_manifest.portfolio.selectionOutcomes), '必须冻结未入选原因');
    ok(runRow.input_manifest.settingsSnapshot, '必须冻结设置快照');

    const listed = await repo.listCandidates({ runId: personalRunId, limit: 10, offset: 0 }, client);
    eq(listed.total, 3, '个人候选列表必须解析到源批次全部候选');
    eq(listed.rows.length, 3, '列表分页不得因零复制而变空');
    const paged = await repo.listCandidates({ runId: personalRunId, limit: 1, offset: 1 }, client);
    eq(paged.rows.length, 1, '分页必须可用');
    const filtered = await repo.listCandidates({ runId: personalRunId, filterStatus: 'FAIL', limit: 10, offset: 0 }, client);
    eq(filtered.total, 1, '筛选必须作用在源批次候选上');
    const found = await repo.findCandidate({ runId: personalRunId, code: codes.pass2 }, client);
    ok(found && found.filter_status === 'PASS', '单股详情必须解析到源批次候选');
    const members = await repo.listMembers(personalRunId, client);
    eq(members.length, 1, '成员名单必须通过源批次候选补齐代码/名称');
    ok(members[0].code === codes.pass2, '被本人排除的股票不得进入成员');
    const industryCounts = await repo.listIndustryIdentityCounts(personalRunId, client);
    ok(industryCounts.some(row => row.code === IND.code && Number(row.affected_count) === 3),
      '行业计数必须统计源批次候选');

    // ---------- 连续个人排除：旧个人批次仍可作基线 ----------
    // ---------- 连续个人排除：旧个人批次仍可作基线 ----------
    await client.query(
      `UPDATE users SET stock_selection_settings_revision = stock_selection_settings_revision + 1 WHERE username = $1`, [tag]);
    const second = await service.createSimulation({ username: tag, sourceRunId, positionRatio: 0.5 }, { tx: client });
    const secondId = Number(second.runId);
    const previous = await repo.previousPersonalMembers({
      market: MARKET, sourceRunId, excludeRunId: secondId, ownerUsername: tag,
      ownerSubjectId: first.run.owner_subject_id,
    }, client);
    ok(previous.run && Number(previous.run.run_id) === personalRunId, '连续个人测算必须找到上一份个人批次');
    eq(previous.rows.length, 1, '上一份个人批次的成员必须通过候选解析可读');

    // ---------- 历史已复制个人批次保持原读路径 ----------
    const legacyId = await insertRunRow(client, {
      strategyId, runKind: 'personal', inputHash: `legacy-${tag}`, owner: tag, supersedes: sourceRunId,
    });
    await repo.copyCandidates({ sourceRunId, targetRunId: legacyId }, client);
    const legacyList = await repo.listCandidates({ runId: legacyId, limit: 10, offset: 0 }, client);
    eq(legacyList.total, 3, '旧已复制个人批次仍读自有候选');
    await client.query(
      `INSERT INTO analytics.stock_selection_candidates
         (run_id, instrument_id, code, filter_status, data_quality_status, detail)
       VALUES ($1, 99, '994199.SH', 'FAIL', 'partial', '{}'::jsonb)`, [legacyId]);
    const legacyAfter = await repo.listCandidates({ runId: legacyId, limit: 10, offset: 0 }, client);
    eq(legacyAfter.total, 4, '旧批次新增自有候选后必须读到 4 行，证明未强制解析到源批次');
    const sourceStill = await repo.listCandidates({ runId: sourceRunId, limit: 10, offset: 0 }, client);
    eq(sourceStill.total, 3, '旧批次的额外候选不得污染源批次');

    // ---------- B3-2 淘汰详情裁剪 + 历史回放指纹 ----------
    const stored = await client.query(
      `SELECT code, filter_status, pg_column_size(detail) AS detail_bytes, detail
         FROM analytics.stock_selection_candidates
        WHERE run_id = $1 ORDER BY instrument_id`, [sourceRunId]);
    const failed = stored.rows.find(row => row.code === codes.fail);
    const passed = stored.rows.find(row => row.code === codes.pass2);
    ok(failed && passed, '必须能读回淘汰与通过候选');
    ok(failed.detail.annual.yearsTrimmed === true && failed.detail.annual.years.length === 0,
      '淘汰股必须裁剪 11 年年度数组');
    ok(failed.detail.annual.yearsDigest && failed.detail.annual.sourceVersions,
      '淘汰股必须保留年度指纹与逐年来源版本');
    ok(failed.detail.rules.R01.reason === 'pb_above_threshold', '淘汰规则原因必须保留');
    eq(failed.detail.ttm.evidenceRef, undefined, 'detail.ttm.evidenceRef 不得重复存储');
    ok(failed.detail.ttmEvidenceRef, 'TTM 血缘必须保留一份');
    ok(passed.detail.annual.years.length === 11, 'PASS 候选保留完整年度数组');

    // 同一份淘汰事实做 A/B：旧存储（直接写全量年度数组） vs 新投影（受控裁剪），实测列字节下降。
    const sizeRunId = await insertRunRow(client, {
      strategyId, runKind: 'daily', inputHash: `size-${tag}`, createdAtDaysAgo: 0,
    });
    const rawFail = candidate({
      instrumentId: 41, companyId, code: '994141.SH', status: 'FAIL', order: null, annual: annualFromLoader,
    });
    const rawDetail = Object.assign({}, rawFail.detail, {
      rules: rawFail.rules, anomaly: rawFail.anomaly, rankReady: false, rankBlockReasons: [],
      riskStatus: null, valuationStatus: null, valuationPassReason: null,
      ttmEvidenceRef: rawFail.ttmEvidenceRef, ttmStatusBasis: rawFail.ttmStatusBasis,
    });
    await client.query(
      `INSERT INTO analytics.stock_selection_candidates
         (run_id, instrument_id, code, filter_status, data_quality_status, detail)
       VALUES ($1, 41, '994141.SH', 'FAIL', 'partial', $2::jsonb)`, [sizeRunId, JSON.stringify(rawDetail)]);
    await repo.insertCandidates(client, sizeRunId, [
      candidate({ instrumentId: 42, companyId, code: '994142.SH', status: 'FAIL', order: null, annual: annualFromLoader }),
    ]);
    const sizes = await client.query(
      `SELECT instrument_id, pg_column_size(detail) AS bytes FROM analytics.stock_selection_candidates
        WHERE run_id = $1 ORDER BY instrument_id`, [sizeRunId]);
    const rawBytes = Number(sizes.rows.find(row => Number(row.instrument_id) === 41).bytes);
    const compactBytes = Number(sizes.rows.find(row => Number(row.instrument_id) === 42).bytes);
    ok(compactBytes < rawBytes,
      `淘汰详情受控裁剪必须实测减小（旧存储=${rawBytes}B / 裁剪后=${compactBytes}B）`);

    const runForReplay = await repo.findRun(sourceRunId, client);
    const replayCandidate = await repo.findCandidate({ runId: sourceRunId, code: codes.fail }, client);
    const replay = await service.historicalAnnualReplayOf(runForReplay, replayCandidate, client);
    ok(replay.required === true && replay.verified === true, '指纹一致时允许历史回放');
    ok(replay.years.length >= 2, '回放必须返回完整年度明细');
    ok(replay.years.some(row => row.sourceVersion), '回放年份必须带来源版本');

    const fact = await client.query(
      `SELECT f.fact_id FROM fundamental.financial_facts f
         JOIN fundamental.financial_reports r ON r.report_id = f.report_id
        WHERE r.company_id = $1 AND f.metric_code = 'net_profit_parent'
        ORDER BY r.period_end DESC LIMIT 1`, [replayCandidate.company_id]);
    await client.query(`UPDATE fundamental.financial_facts SET numeric_value = numeric_value + 7 WHERE fact_id = $1`, [fact.rows[0].fact_id]);
    const revisedReplay = await service.historicalAnnualReplayOf(runForReplay, replayCandidate, client);
    eq(revisedReplay.verified, false, '事实版本变化后必须拒绝把今日数据当历史回放');
    eq(revisedReplay.years, null, '未证明一致时不得返回年份明细');
    eq(revisedReplay.reason, 'frozen_digest_mismatch', '必须给出可诊断的拒绝原因');
    await client.query(`UPDATE fundamental.financial_facts SET numeric_value = numeric_value - 7 WHERE fact_id = $1`, [fact.rows[0].fact_id]);

    // ---------- 分红原文红线：默认白名单不删 dividends ----------
    const rawSource = (await client.query(`SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1`)).rows[0].source_id;
    for (const dataset of ['dividends', 'income']) {
      await client.query(
        `INSERT INTO ops.raw_records (source_id, dataset_code, source_key, payload, payload_hash, ingested_at)
         VALUES ($1, $2, $3, '{"probe":true}'::jsonb, $4, now() - interval '30 days')
         ON CONFLICT (source_id, dataset_code, source_key, payload_hash) DO NOTHING`,
        [rawSource, dataset, `b3-${tag}-${dataset}`, `ph-${tag}-${dataset}`]);
    }
    const purge = await retentionService.purgeStorageData({
      client,
      rawRetentionDays: 7, selectionRunRetentionEnabled: false, selectionPartialRetentionDays: 90,
      rawBatchSize: 10000, rawMaxBatches: 500,
    });
    ok(purge.protectedDatasets.includes('dividends'), '清理结果必须声明 dividends 受保护');
    const dividendLeft = await client.query(
      `SELECT COUNT(*)::int AS count FROM ops.raw_records WHERE source_key = $1`, [`b3-${tag}-dividends`]);
    eq(dividendLeft.rows[0].count, 1, '超过 7 天的 dividends 原文不得被常规清理删除');
    const incomeLeft = await client.query(
      `SELECT COUNT(*)::int AS count FROM ops.raw_records WHERE source_key = $1`, [`b3-${tag}-income`]);
    eq(incomeLeft.rows[0].count, 0, '白名单内的超期无引用原文按保留窗口清理');

    let protectedRejected = null;
    await retentionService.purgeStorageData({ client, datasetCodes: ['dividends'] }).catch(error => { protectedRejected = error; });
    ok(protectedRejected && protectedRejected.code === 'RAW_RECORD_PROTECTED_DATASET', '显式传入 dividends 必须拒绝执行');

    // ---------- B3-2 分级留存：只删过期无引用批次 ----------
    const oldDaily = await insertRunRow(client, { strategyId, runKind: 'daily', inputHash: `old-daily-${tag}`, createdAtDaysAgo: 40 });
    const publishedDaily = await insertRunRow(client, { strategyId, runKind: 'daily', inputHash: `pub-daily-${tag}`, createdAtDaysAgo: 40, published: true });
    const oldWeekly = await insertRunRow(client, { strategyId, runKind: 'weekly', inputHash: `old-weekly-${tag}`, createdAtDaysAgo: 40 });
    const oldPreview = await insertRunRow(client, { strategyId, runKind: 'preview', inputHash: `old-preview-${tag}`, createdAtDaysAgo: 10 });
    const oldShadow = await insertRunRow(client, { strategyId, runKind: 'weekly', inputHash: `old-shadow-${tag}`, createdAtDaysAgo: 10, isShadow: true });
    const referencedBySupersedes = await insertRunRow(client, { strategyId, runKind: 'daily', inputHash: `ref-sup-${tag}`, createdAtDaysAgo: 40 });
    await insertRunRow(client, { strategyId, runKind: 'personal', inputHash: `ref-sup-p-${tag}`, owner: tag, supersedes: referencedBySupersedes, createdAtDaysAgo: 39 });
    const referencedBySourceDaily = await insertRunRow(client, { strategyId, runKind: 'daily', inputHash: `ref-src-${tag}`, createdAtDaysAgo: 40 });
    await insertRunRow(client, {
      strategyId, runKind: 'weekly', inputHash: `ref-src-w-${tag}`, createdAtDaysAgo: 39, sourceDaily: referencedBySourceDaily,
    });
    const referencedByEvent = await insertRunRow(client, { strategyId, runKind: 'daily', inputHash: `ref-event-${tag}`, createdAtDaysAgo: 40 });
    await client.query(
      `INSERT INTO analytics.stock_selection_publication_events
         (market, strategy_id, period_type, period_key, action, from_run_id, to_run_id)
       VALUES ($1, $2, 'day', $3, 'publish', NULL, $4)`, [MARKET, strategyId, `D:${AS_OF}`, referencedByEvent]);
    const oldPersonal = await insertRunRow(client, {
      strategyId, runKind: 'personal', inputHash: `old-p-${tag}`, owner: tag, supersedes: sourceRunId, createdAtDaysAgo: 20,
    });
    const newPersonal = await insertRunRow(client, {
      strategyId, runKind: 'personal', inputHash: `new-p-${tag}`, owner: tag, supersedes: sourceRunId, createdAtDaysAgo: 0,
    });
    const oldPartial = await insertRunRow(client, {
      strategyId, runKind: 'daily', inputHash: `old-partial-${tag}`, createdAtDaysAgo: 5, qualityStatus: 'partial',
    });
    const keptPartial = await insertRunRow(client, {
      strategyId, runKind: 'daily', inputHash: `kept-partial-${tag}`, createdAtDaysAgo: 5, qualityStatus: 'partial',
    });
    await insertRunRow(client, {
      strategyId, runKind: 'personal', inputHash: `kept-partial-p-${tag}`, owner: tag, supersedes: keptPartial, createdAtDaysAgo: 4,
    });
    const dryRunProbe = await insertRunRow(client, { strategyId, runKind: 'daily', inputHash: `dry-${tag}`, createdAtDaysAgo: 40 });

    const dry = await retentionRepository.pruneStaleSelectionRuns({
      dailyRetentionDays: 30, personalRetentionDays: 14, ephemeralRetentionDays: 7, dryRun: true,
    }, client);
    ok(dry.dryRun === true && dry.total >= 1, 'dry-run 必须盘点出待清理批次');
    const dryStill = await client.query(`SELECT 1 FROM analytics.stock_selection_runs WHERE run_id = $1`, [dryRunProbe]);
    eq(dryStill.rowCount, 1, 'dry-run 不得删除任何批次');

    const result = await retentionRepository.pruneStaleSelectionRuns({
      dailyRetentionDays: 30, personalRetentionDays: 14, ephemeralRetentionDays: 7,
      batchSize: 50, maxBatches: 10,
    }, client);
    ok(result.total >= 5, `必须清理过期无引用的 daily/preview/shadow/中间 personal（实际 ${result.total}）`);

    const remaining = await client.query(
      `SELECT run_id FROM analytics.stock_selection_runs WHERE strategy_id = $1`, [strategyId]);
    const remainingIds = new Set(remaining.rows.map(row => Number(row.run_id)));
    for (const [label, id] of [
      ['已发布 daily', publishedDaily], ['weekly', oldWeekly], ['被 supersedes_run_id 引用', referencedBySupersedes],
      ['被 source_daily_run_id 引用', referencedBySourceDaily], ['被发布事件引用', referencedByEvent],
      ['最新 personal', newPersonal], ['仅一份 personal', personalRunId], ['第二份 personal', secondId],
      ['被 supersedes 引用的旧式 personal', legacyId],
    ]) {
      ok(remainingIds.has(Number(id)), `${label} 批次必须永久保留`);
    }
    for (const [label, id] of [
      ['超期无引用 daily', oldDaily], ['超期 preview', oldPreview], ['超期影子批次', oldShadow],
      ['过期中间 personal', oldPersonal],
    ]) {
      ok(!remainingIds.has(Number(id)), `${label} 批次必须被清理`);
    }
    // 5 天前、仍在 30 天窗口内的 partial 不受分级清理影响，交给旧 partial 入口按 1 天窗口处理。
    ok(remainingIds.has(Number(oldPartial)), '分级清理不得越过 daily 30 天窗口删除较新的 partial');

    const partialDeleted = await retentionRepository.deleteStalePartialSelectionRuns({
      retentionDays: 1, batchSize: 10000, maxBatches: 10,
    }, client);
    ok(partialDeleted >= 1, '旧 partial 清理入口必须删除超期无引用 partial 批次');
    const keptPartialStill = await client.query(`SELECT 1 FROM analytics.stock_selection_runs WHERE run_id = $1`, [keptPartial]);
    eq(keptPartialStill.rowCount, 1, '被 supersedes_run_id 引用的 partial 批次不得被旧清理入口删除');
    const oldPartialStill = await client.query(`SELECT 1 FROM analytics.stock_selection_runs WHERE run_id = $1`, [oldPartial]);
    eq(oldPartialStill.rowCount, 0, '无引用 partial 批次由旧入口按原语义删除');

    const measured = await retentionRepository.measureSelectionStorage({ runId: sourceRunId }, client);
    eq(measured.candidateRows, 3, '容量核算必须按批次统计候选行');
    ok(measured.detailBytes > 0 && measured.avgDetailBytes > 0, '容量核算必须给出 pg_column_size 指标');
    eq(measured.vacuumFull, false, '容量核算不得安排 VACUUM FULL');
    ok(measured.table && measured.table.deadTuples >= 0, '容量核算必须给出表内可复用空间指标');

    await client.query('ROLLBACK');
    rolledBack = true;
  } finally {
    if (!rolledBack) await client.query('ROLLBACK').catch(() => {});
  }
  return tag;
}

async function committedServiceChecks(client) {
  const tag = tagOf('b3svc');
  const codes = { pass1: '994201.SH', pass2: '994202.SH', fail: '994203.SH' };
  let strategyId = null;
  let companyId = null;
  try {
    await client.query('BEGIN');
    const seeded = await seedFixtures(client, { userTag: tag, codes, withFinancials: true });
    strategyId = seeded.strategyId;
    companyId = seeded.companyId;
    await client.query('COMMIT');

    const first = await service.createSimulation({ username: tag, sourceRunId: seeded.sourceRunId, positionRatio: 1 });
    const personalRunId = Number(first.runId);
    const candidates = await service.getCandidates({ runId: personalRunId, limit: 200, offset: 0 });
    eq(candidates.total, 3, '服务候选读入口必须解析源批次');
    const excluded = candidates.rows.find(row => row.code === codes.pass1);
    ok(excluded && excluded.personalExcluded === true, '个人排除状态必须叠加在源候选上');
    const selected = candidates.rows.find(row => row.code === codes.pass2);
    ok(selected && selected.personalSelected === true, '个人入选状态必须正确');

    const portfolio = await service.getPortfolio(personalRunId);
    eq(portfolio.selectedCount, 1, '个人组合成员读取正常');
    eq(portfolio.members[0].code, codes.pass2, '组合成员来自源候选解析');
    ok(portfolio.sourceIndustryIdentityCounts.length > 0, '行业身份计数读取正常');

    const detail = await service.getStockDetail({ runId: personalRunId, code: codes.pass2 });
    ok(detail && detail.candidate.personalSelected === true, '个人详情读取正常');
    const failDetail = await service.getStockDetail({ runId: personalRunId, code: codes.fail });
    ok(failDetail.candidate.detail.annual.yearsTrimmed === true, '服务详情返回裁剪标记');
    ok(failDetail.historicalReplayVerified === true, '服务详情必须核验历史回放指纹');
    ok(Array.isArray(failDetail.historicalReplay.years), '证明一致时返回可核对的历史年份');

    // 事实版本变化后，真实接口不得冒充历史回放。
    const fact = await client.query(
      `SELECT f.fact_id FROM fundamental.financial_facts f
         JOIN fundamental.financial_reports r ON r.report_id = f.report_id
        WHERE r.company_id = $1 ORDER BY r.period_end DESC LIMIT 1`, [companyId]);
    await client.query(`UPDATE fundamental.financial_facts SET numeric_value = numeric_value + 5 WHERE fact_id = $1`, [fact.rows[0].fact_id]);
    const revised = await service.getStockDetail({ runId: personalRunId, code: codes.fail });
    eq(revised.historicalReplayVerified, false, '版本不一致必须显式 false');
    eq(revised.historicalReplay.years, null, '版本不一致不得返回今日修订后的年份');
  } finally {
    if (strategyId) await client.query(`DELETE FROM analytics.stock_selection_runs WHERE strategy_id = $1`, [strategyId]);
    if (strategyId) await client.query(`DELETE FROM analytics.stock_selection_strategies WHERE strategy_id = $1`, [strategyId]);
    await client.query(`DELETE FROM users WHERE username = $1`, [tag]);
    if (companyId) {
      await client.query(`DELETE FROM fundamental.financial_facts WHERE report_id IN (SELECT report_id FROM fundamental.financial_reports WHERE company_id = $1)`, [companyId]);
      await client.query(`DELETE FROM fundamental.financial_reports WHERE company_id = $1`, [companyId]);
      await client.query(`DELETE FROM core.company_instruments WHERE company_id = $1`, [companyId]);
      await client.query(`DELETE FROM core.instruments WHERE canonical_code = $1`, [codes.fail]);
      await client.query(`DELETE FROM core.companies WHERE company_id = $1`, [companyId]);
    }
    const leftover = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM analytics.stock_selection_runs r
           JOIN analytics.stock_selection_strategies s ON s.strategy_id = r.strategy_id
          WHERE s.version = $1)::int AS runs,
         (SELECT COUNT(*) FROM users WHERE username = $2)::int AS users`, [tag, tag]);
    eq(leftover.rows[0].runs, 0, '已提交夹具必须清理干净（runs）');
    eq(leftover.rows[0].users, 0, '已提交夹具必须清理干净（users）');
  }
}

async function run() {
  const client = new Client({ ...testDatabaseConfig(), connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await transactionalChecks(client);
    await committedServiceChecks(client);
  } finally {
    await client.end().catch(() => {});
  }
  console.log(`stock-selection-b3-db.test.js passed (${checks} checks)`);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
