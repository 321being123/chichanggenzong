'use strict';

const assert = require('assert');
const hk = require('../services/hkSecurityAnalysis');
const stockRepository = require('../repositories/stockAnalysisRepository');
const hkRepository = require('../repositories/hkSecurityAnalysisRepository');

async function main() {
  const base = { period_end: '2025-12-31', period_type: 'annual', currency_code: 'USD',
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

  base.currency_code = 'HKD';
  const verified = await hk.readHkReportFacts('00005.HK', 20, tx);
  assert.strictEqual(verified[0].profit, 100);
  assert.strictEqual(verified[0].operating, 40);
  base.currency_code = 'USD'; base.source_code = 'other_source';
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
    assert.strictEqual(hk.publicSnapshotOf(analysis).display.formula_version, 'hk-2');
    assert.strictEqual((await hk.refreshHkAnalysis('00005.HK')).cashflow.latest_year.operating, null);
  } finally {
    stockRepository.readLatestSnapshot = originalRead;
    stockRepository.loadAnalysisInputs = originalInputs;
    hkRepository.readHkReportFacts = originalFacts;
  }
  console.log('港股概览币种与旧快照保护通过');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
