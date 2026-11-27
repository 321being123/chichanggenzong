// Batch 3（B3-1 个人测算零候选复制 + B3-2 淘汰详情裁剪/分红原文红线/分级留存）专项回归。
// 纯函数、常量与读入口接线断言；真实 SQL 行为见 stock-selection-b3-db.test.js。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const storageRetention = require('../services/storageRetention');
const retentionRepository = require('../repositories/storageRetentionRepository');
const repo = require('../repositories/stockSelectionRepository');
const service = require('../services/stockSelectionService');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

function bigYears(count = 11) {
  const years = [];
  for (let i = 0; i < count; i++) {
    const year = 2014 + i;
    years.push({
      year,
      profit: 100000000 + i,
      profitCurrency: 'CNY',
      dividend: 1000000 + i,
      dividendKnown: true,
      dividendCurrencies: ['CNY'],
      dividendCurrencyUnknown: false,
      complete: true,
      sourceVersion: `v-${year}`,
      dividendBasis: 'annual_implemented_amount',
    });
  }
  return years;
}

function candidateRow(overrides = {}) {
  return Object.assign({
    instrumentId: 1, companyId: 10, code: '900001.SH', name: '测试股票',
    industry: { code: 'IND', name: '测试行业', system: 'SW2021', version: '2021' },
    currentPb: 0.8, historicalPbMax: 1.2, currentPe: 8, profitStatus: 'profit',
    dividendYield: 0.04, equityAmount: 100, equityCurrency: 'CNY', equityCny: 100,
    fxRate: null, fxDate: null, pbRank: 1, peRank: 1, dividendRank: 1, totalScore: 3,
    selectionOrder: 1, filterStatus: 'PASS', dataQualityStatus: 'complete',
    exclusionReasons: [], rules: { R01: { status: 'PASS', reason: null } },
    anomaly: { status: 'PASS', latestYear: 2024, profitY: 100, profitSum: 1000 },
    rankReady: true, rankBlockReasons: [], detail: {
      price: 10, priceDate: '2026-11-20',
      annual: { latestYear: 2024, years: bigYears(), currency: 'CNY', listingYear: 2010, sourceGapYears: [] },
      ttm: { status: 'computed', basis: 'computed_ttm', evidenceRef: { reports: [1, 2, 3] } },
    },
    ttmEvidenceRef: { reports: [1, 2, 3] }, ttmStatusBasis: 'computed_ttm',
  }, overrides);
}

// 1. 分红原文保护红线 -------------------------------------------------------
(async () => {
eq(JSON.stringify(storageRetention.PROTECTED_RAW_DATASETS), JSON.stringify(['dividends']), 'dividends 必须登记为受保护数据集');
ok(!storageRetention.DEFAULT_PRUNE_DATASETS.includes('dividends'), 'dividends 不得进入常规原文清理白名单');
ok(!storageRetention.DEFAULT_PRUNE_DATASETS.includes('forecasts'), '未完成引用盘点的数据集不得悄悄加入白名单');

let protectedError = null;
try {
  storageRetention.assertNoProtectedDatasets(['income', 'dividends']);
} catch (error) { protectedError = error; }
ok(protectedError && protectedError.code === 'RAW_RECORD_PROTECTED_DATASET', '显式传入 dividends 必须拒绝而不是静默过滤');
let upperProtectedError = null;
try { storageRetention.assertNoProtectedDatasets(['DIVIDENDS']); } catch (error) { upperProtectedError = error; }
ok(upperProtectedError && upperProtectedError.code === 'RAW_RECORD_PROTECTED_DATASET', '保护判定必须大小写不敏感');

// 2. 分级留存参数与 dry-run 接线 ---------------------------------------------
const original = {
  raw: retentionRepository.deleteExpiredUnreferencedRawRecords,
  partial: retentionRepository.deleteStalePartialSelectionRuns,
  prune: retentionRepository.pruneStaleSelectionRuns,
};
const calls = [];
try {
  retentionRepository.deleteExpiredUnreferencedRawRecords = async params => { calls.push({ kind: 'raw', ...params }); return 0; };
  retentionRepository.deleteStalePartialSelectionRuns = async params => { calls.push({ kind: 'partial', ...params }); return 0; };
  retentionRepository.pruneStaleSelectionRuns = async params => {
    calls.push({ kind: 'prune', ...params });
    return { dryRun: params.dryRun, deleted: { daily: 1, personal: 2, ephemeral: 3 }, total: 6, retentionDays: {} };
  };

  const defaults = await storageRetention.purgeStorageData();
  eq(defaults.selectionRetentionDays.daily, 30, 'daily 默认保留 30 天');
  eq(defaults.selectionRetentionDays.personal, 14, '中间 personal 默认保留 14 天');
  eq(defaults.selectionRetentionDays.ephemeral, 7, 'preview/shadow 默认保留 7 天');
  eq(defaults.selectionRetention.deleted.daily, 1, '分级留存结果必须回传');
  eq(calls.filter(item => item.kind === 'prune')[0].dryRun, true, '默认只读盘点（dry-run），不自动真删存量');

  const dry = await storageRetention.purgeStorageData({ selectionDryRun: true, selectionDailyRetentionDays: 0, selectionEphemeralRetentionDays: 999 });
  eq(dry.selectionRetentionDays.daily, 1, 'daily 窗口下限 1 天');
  eq(dry.selectionRetentionDays.ephemeral, 365, 'ephemeral 窗口上限 365 天');
  eq(calls.filter(item => item.kind === 'prune')[1].dryRun, true, 'dryRun 必须透传给仓储');

  const disabled = await storageRetention.purgeStorageData({ selectionRunRetentionEnabled: false });
  ok(disabled.selectionRetention.skipped === true, '可配置关闭分级留存');
  eq(calls.filter(item => item.kind === 'prune').length, 2, '关闭时不得调用清理仓储');

  let blocked = null;
  await storageRetention.purgeStorageData({ datasetCodes: ['dividends'] }).catch(error => { blocked = error; });
  ok(blocked && blocked.code === 'RAW_RECORD_PROTECTED_DATASET', 'purgeStorageData 必须拒绝 dividends，且不执行任何删除');
} finally {
  retentionRepository.deleteExpiredUnreferencedRawRecords = original.raw;
  retentionRepository.deleteStalePartialSelectionRuns = original.partial;
  retentionRepository.pruneStaleSelectionRuns = original.prune;
}

// 3. 淘汰详情受控裁剪 --------------------------------------------------------
const eliminated = candidateRow({
  code: '900002.SH', selectionOrder: null, filterStatus: 'FAIL', rankReady: false,
  exclusionReasons: ['pb_above_threshold'],
  rules: { R01: { status: 'FAIL', reason: 'pb_above_threshold', value: 1.9, threshold: 1.5 } },
  anomaly: { status: 'PASS', latestYear: 2024, profitSum: 1000 },
});
const compacted = repo.compactCandidateDetail(eliminated);
ok(compacted.annual.yearsTrimmed === true, '淘汰股年度数组必须标记已裁剪');
eq(compacted.annual.years.length, 0, '淘汰股不再存 11 年全量数组');
eq(compacted.annual.yearCount, 11, '必须保留裁剪前年度条数');
eq(JSON.stringify(compacted.annual.yearRange), JSON.stringify([2014, 2024]), '必须保留年度区间');
eq(compacted.annual.yearsDigest, repo.annualYearsDigest(eliminated.detail.annual.years), '指纹必须与写入前年度事实一致');
eq(compacted.annual.sourceVersions['2014'], 'v-2014', '逐年来源/报告版本指纹必须保留');
eq(compacted.rules.R01.reason, 'pb_above_threshold', '触发淘汰的规则原因必须保留');
eq(compacted.anomaly.profitSum, 1000, '年度异常判定依据必须保留');
eq(compacted.ttmEvidenceRef.reports.length, 3, 'TTM 血缘必须保留一份');
eq(compacted.ttm.evidenceRef, undefined, '重复的 detail.ttm.evidenceRef 必须去掉');
ok(eliminated.detail.annual.years.length === 11, '裁剪不得修改计算层原始 detail');
ok(eliminated.detail.annual.yearsDigest === undefined, '裁剪不得把持久化标记写回内存对象');

const passDetail = repo.compactCandidateDetail(candidateRow());
eq(passDetail.annual.years.length, 11, 'PASS 候选保留完整年度数组');
ok(passDetail.annual.yearsTrimmed === undefined, 'PASS 候选不得标裁剪');
passDetail.ttm = passDetail.ttm || {};
ok(passDetail.ttm.evidenceRef === undefined, 'PASS 候选同样去除重复 TTM 血缘');

const riskDetail = repo.compactCandidateDetail(candidateRow({ filterStatus: 'RISK' }));
ok(riskDetail.annual.yearsTrimmed === true, 'RISK 同样属于淘汰状态');
const naDetail = repo.compactCandidateDetail(candidateRow({ filterStatus: 'NOT_APPLICABLE' }));
ok(naDetail.annual.yearsTrimmed === true, 'NOT_APPLICABLE 同样属于淘汰状态');
const pendingDetail = repo.compactCandidateDetail(candidateRow({ filterStatus: 'PENDING' }));
eq(pendingDetail.annual.years.length, 11, 'PENDING 不是确定淘汰，保留完整年度数组');

// 指纹必须对字段顺序不敏感、对版本变化敏感。
const years = bigYears();
const reordered = years.map(row => ({
  dividendBasis: row.dividendBasis, sourceVersion: row.sourceVersion, complete: row.complete,
  dividendCurrencyUnknown: row.dividendCurrencyUnknown, dividendCurrencies: row.dividendCurrencies,
  dividendKnown: row.dividendKnown, dividend: row.dividend, profitCurrency: row.profitCurrency,
  profit: row.profit, year: row.year,
}));
eq(repo.annualYearsDigest(reordered), repo.annualYearsDigest(years), '指纹必须与对象键顺序无关');
const revised = years.map(row => (row.year === 2020 ? Object.assign({}, row, { sourceVersion: 'v-2020-revised' }) : row));
ok(repo.annualYearsDigest(revised) !== repo.annualYearsDigest(years), '报告版本变化必须改变指纹');

// 4. 读入口接线（静态锁定，行为由真实隔离库测试覆盖） ----------------------
const repoSource = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), 'utf8');
ok(repoSource.includes('resolveCandidateRunId'), '仓储必须提供零复制来源解析');
ok(repoSource.includes("candidatesRefMode") && repoSource.includes("source_run"), '仓储必须识别 candidatesRefMode=source_run');
ok(repoSource.includes('EFFECTIVE_CANDIDATE_RUN_SQL'), '成员与基线读取必须走同一有效候选批次表达式');

const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), 'utf8');
// createSimulation 仍必须零候选复制；周度受控复用允许 repo.copyCandidates，因此只锁定该函数体。
const createSimulationStart = serviceSource.indexOf('async function createSimulation(');
const createSimulationEnd = createSimulationStart < 0 ? -1 : serviceSource.indexOf('\nasync function ', createSimulationStart + 1);
const createSimulationBody = createSimulationStart < 0 ? '' : serviceSource.slice(createSimulationStart, createSimulationEnd < 0 ? serviceSource.length : createSimulationEnd);
ok(createSimulationBody.length > 0 && !/repo\.copyCandidates\s*\(/.test(createSimulationBody), 'createSimulation 不得再物理复制候选');
ok(serviceSource.includes("candidatesRefMode: 'source_run'"), '个人批次必须显式标记候选引用模式');
ok(serviceSource.includes('historicalReplayVerified'), '详情必须显式返回历史回放是否可证明一致');
ok(serviceSource.includes('historicalAnnualReplayOf'), '详情必须按冻结指纹核验历史回放');

const retentionSource = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'storageRetentionRepository.js'), 'utf8');
ok(retentionSource.includes('source_daily_run_id = r.run_id'), '分级留存必须保护 source_daily_run_id 引用');
ok(retentionSource.includes('stock_selection_publication_events'), '分级留存必须保护发布事件引用');
ok(retentionSource.includes('stock_selection_backtest_periods'), '分级留存必须保护历史回测引用');
ok(retentionSource.includes('supersedes_run_id IS NOT DISTINCT FROM'), '中间 personal 清理必须按同源同主体判定');
ok(!/query\(\s*[`'"][^`'"]*vacuum/i.test(retentionSource + fs.readFileSync(path.join(__dirname, '..', 'services', 'storageRetention.js'), 'utf8')),
  '清理代码不得执行 VACUUM / VACUUM FULL');

ok(typeof repo.annualYearsDigest === 'function' && typeof repo.compactCandidateDetail === 'function', '裁剪工具必须可被回归直接调用');
ok(typeof storageRetention.measureSelectionStorage === 'function', '容量核算能力必须从服务层可调用');

console.log(`stock-selection-b3.test.js passed (${checks} checks)`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
