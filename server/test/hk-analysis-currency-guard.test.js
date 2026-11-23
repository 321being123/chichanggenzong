'use strict';

const assert = require('assert');
const hk = require('../services/hkSecurityAnalysis');
const stockRepository = require('../repositories/stockAnalysisRepository');
const hkRepository = require('../repositories/hkSecurityAnalysisRepository');

async function main() {
  const base = { period_end: '2025-12-31', period_type: 'annual', currency_code: 'USD', source_currency: 'USD',
    source_version: 'v1', company_id: 1, source_code: 'lixinger_official', report_id: 1 };
  const tx = { query: async sql => {
    assert.match(sql, /LEFT JOIN ops\.data_sources ds/);
    if (sql.includes("SELECT 'income'")) return { rows: [{ ...base, ps_npatoshopc: 100, ps_beps: 2 }] };
    if (sql.includes("SELECT 'balance'")) return { rows: [{ ...base, report_id: 2, bs_tetoshopc: 500 }] };
    return { rows: [{ ...base, report_id: 3, cfs_ncffoa: 40 }] };
  } };
  const facts = await hk.readHkReportFacts('00005.HK', 20, tx);
  assert.strictEqual(facts[0].profit, null);
  assert.strictEqual(facts[0].equity, null);
  assert.strictEqual(facts[0].operating, null);
  assert.strictEqual(facts[0].currency_unverified, true);
  const analysis = hk.buildHkAnalysis({ reportFacts: facts }, { tsCode: '00005.HK' });
  assert.strictEqual(analysis.display.field_status.ttm_profit.reason, 'source_currency_unverified');
  assert.strictEqual(analysis.cashflow.latest_year.operating, null);
  assert.strictEqual(analysis.display.statement_analysis_versions.income != null, true);

  base.statement_coverage = { value_basis: 'source_original_t_o' };
  const original = await hk.readHkReportFacts('00005.HK', 20, tx);
  assert.strictEqual(original[0].profit, 100, '经标记的原币原始报告可参与概览');
  assert.strictEqual(original[0].operating, 40);
  const separated = [
    { ...original[0], source_version: 'income', report_ids: [{ kind: 'income', report_id: 1 }], operating: null },
    { ...original[0], source_version: 'balance', report_ids: [{ kind: 'balance', report_id: 2 }], profit: null, operating: null },
    { ...original[0], source_version: 'cashflow', report_ids: [{ kind: 'cashflow', report_id: 3 }], profit: null },
  ];
  const separatedAnalysis = hk.buildHkAnalysis({ reportFacts: separated }, { tsCode: '00005.HK' });
  assert.strictEqual(separatedAnalysis.display.field_status.ttm_profit.value, 100);
  assert.strictEqual(separatedAnalysis.display.field_status.ttm_profit.currency, 'USD');
  assert.strictEqual(separatedAnalysis.cashflow.latest_year.operating, 40, '现金流应读取独立版本的现金流报告');
  assert.strictEqual(separatedAnalysis.cashflow.latest_year.currency, 'USD');
  const mixed = hk.buildHkAnalysis({ reportFacts: [
    { ...separated[0], period_end: '2026-06-30', period_type: 'semiannual', currency: 'CNY', profit: 50 },
    ...separated,
    { ...separated[0], period_end: '2025-06-30', period_type: 'semiannual', currency: 'USD', profit: 30 },
  ] }, { tsCode: '00005.HK' });
  assert.strictEqual(mixed.display.field_status.ttm_profit.value, null, '不同币种不得合成 TTM');
  const comparable = hk.buildHkAnalysis({ reportFacts: [
    { ...separated[0], period_end: '2026-06-30', period_type: 'semiannual', profit: 50 },
    ...separated,
    { ...separated[0], period_end: '2025-06-30', period_type: 'semiannual', profit: 30 },
  ] }, { tsCode: '00005.HK' });
  assert.strictEqual(comparable.display.field_status.ttm_profit.value, 120, '半年报不得当成年报，TTM 使用可比三期');
  const revisedHistory = hk.buildHkAnalysis({ reportFacts: [
    { ...separated[0], period_end: '2026-06-30', period_type: 'semiannual', profit: 50 },
    ...separated,
    { ...separated[0], period_end: '2025-06-30', period_type: 'semiannual', profit: 30,
      report_ids: [{ kind: 'income', report_id: 1, statement_revision: 'later' }] },
  ] }, { tsCode: '00005.HK' });
  assert.notStrictEqual(comparable.display.analysis_version, revisedHistory.display.analysis_version,
    '所用历史报告的宽表修订应改变概览版本');
  const alreadyCovered = hk.buildHkAnalysis({ reportFacts: [
    ...separated,
    { ...separated[0], period_end: '2025-06-30', period_type: 'semiannual', profit: 50 },
    { ...separated[0], period_end: '2024-06-30', period_type: 'semiannual', profit: 30 },
  ] }, { tsCode: '00005.HK' });
  assert.strictEqual(alreadyCovered.display.field_status.ttm_profit.value, 100, '已被年报覆盖的半年报不得重复叠加');
  const wrongFiscalYear = hk.buildHkAnalysis({ reportFacts: [
    { ...separated[0], period_end: '2026-06-30', period_type: 'semiannual', profit: 50 },
    { ...separated[0], period_end: '2025-06-30', period_type: 'semiannual', profit: 30 },
    { ...separated[0], period_end: '2025-03-31', period_type: 'annual', profit: 100 },
  ] }, { tsCode: '00005.HK' });
  assert.strictEqual(wrongFiscalYear.display.field_status.ttm_profit.value, null, '去年同期晚于所选年报不能拼接 TTM');
  base.statement_coverage = null;

  base.currency_code = 'HKD'; base.source_currency = 'HKD';
  const verified = await hk.readHkReportFacts('00005.HK', 20, tx);
  assert.strictEqual(verified[0].profit, 100);
  assert.strictEqual(verified[0].operating, 40);
  base.source_currency = 'USD';
  assert.strictEqual((await hk.readHkReportFacts('00005.HK', 20, tx))[0].profit, null, '宽表币种与原始币种冲突时隐藏');
  base.source_currency = null;
  assert.strictEqual((await hk.readHkReportFacts('00005.HK', 20, tx))[0].profit, null, '来源无币种时不可使用默认币种');
  base.source_currency = 'USD'; base.currency_code = 'USD'; base.source_code = 'other_source';
  const other = await hk.readHkReportFacts('00005.HK', 20, tx);
  assert.strictEqual(other[0].profit, 100);
  base.source_code = 'lixinger_official'; base.currency_code = null;
  assert.strictEqual((await hk.readHkReportFacts('00005.HK', 20, tx))[0].profit, null);

  const old = { market: 'HK', valuation: { pe_ttm: 12 }, display: { formula_version: 'hk-1',
    field_status: { ttm_profit: { value: 100, status: 'available' } } },
    cashflow: { latest_year: { end_date: '2025-12-31', operating: 40, free: 20 } },
    stability: { status: 'available', years: [{ profit: 100 }], profitable_each_year: true } };
  const originalRead = stockRepository.readLatestSnapshot;
  const originalInputs = stockRepository.loadAnalysisInputs;
  const originalFacts = hkRepository.readHkReportFacts;
  stockRepository.readLatestSnapshot = async () => ({ payload: old, created_at: '2026-11-12' });
  stockRepository.loadAnalysisInputs = async () => ({ meta: {}, valuations: [], dividends: [], events: [] });
  hkRepository.readHkReportFacts = async () => [];
  try {
    const snapshot = await hk.getHkSnapshot('00005.HK');
    assert.strictEqual(snapshot.display.field_status.ttm_profit.value, null);
    assert.strictEqual(snapshot.cashflow.latest_year.operating, null);
    assert.deepStrictEqual(snapshot.stability.years, []);
    assert.strictEqual(snapshot.valuation.pe_ttm, 12);
    assert.strictEqual(old.cashflow.latest_year.operating, 40, '不能修改已保存的快照对象');
    assert.strictEqual(hk.publicSnapshotOf(old).cashflow.latest_year.operating, null);
    assert.strictEqual(hk.publicSnapshotOf(analysis).display.formula_version, 'hk-5');
    assert.strictEqual((await hk.refreshHkAnalysis('00005.HK')).cashflow.latest_year.operating, null);
  } finally {
    stockRepository.readLatestSnapshot = originalRead;
    stockRepository.loadAnalysisInputs = originalInputs;
    hkRepository.readHkReportFacts = originalFacts;
  }
  console.log('港股概览币种与旧快照保护通过');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
