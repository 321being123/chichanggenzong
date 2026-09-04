const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  currentReportPeriods, isDisclosureSeason, stateForTarget,
} = require('../services/companyFinancialIncrementalSync');
const { rowVersion } = require('../services/financialDataArchitecture');
const { publicationQualityGate } = require('../services/bondSafetyService');

assert.deepStrictEqual(currentReportPeriods('2026-09-04'), ['20260630', '20260331', '20251231', '20250930']);
assert.strictEqual(isDisclosureSeason('2026-09-04'), true);
assert.strictEqual(isDisclosureSeason('2026-07-15'), false);
assert.notStrictEqual(rowVersion({ end_date: '20260630', report_type: '1', ebit: 1 }), rowVersion({ end_date: '20260630', report_type: '1', ebit: 2 }));

const rows = ['income', 'balance', 'cashflow', 'indicator'].map(report_kind => ({
  report_kind, period_end: '2026-06-30', report_type: '1', is_current_version: true,
}));
const complete = stateForTarget({ companyId: 1, tsCode: '600000.SH' }, rows, { reportPeriods: ['20260630'] });
assert.deepStrictEqual(complete.missingKinds, []);
assert.deepStrictEqual(complete.missingPeriods, []);

const nonConsolidated = stateForTarget({}, rows.map(row => row.report_kind === 'income' ? { ...row, report_type: '2' } : row), { reportPeriods: ['20260630'] });
assert.ok(nonConsolidated.missingKinds.includes('income'));
assert.ok(nonConsolidated.missingPeriods.includes('20260630'));

const previous = {
  data: Array.from({ length: 20 }, (_, index) => ({ bond_code: `B${index}`, safety: '安全' })),
  row_count: 20,
};
const current = {
  data: Array.from({ length: 20 }, (_, index) => ({ bond_code: `B${index}`, safety: '安全' })),
  diagnostics: {
    expected_bond_count: 20, bond_rows: 20, eligible_companies: 20,
    financial_complete_companies: 20, financial_report_periods: ['2026-06-30'],
  },
};
assert.strictEqual(publicationQualityGate(current, previous).ok, true);
const rejected = { ...current, data: current.data.map((row, index) => index === 0 ? { ...row, safety: '未评级' } : row) };
assert.strictEqual(publicationQualityGate(rejected, previous).ok, false);

const serviceSource = fs.readFileSync(path.resolve(__dirname, '..', 'services', 'companyFinancialIncrementalSync.js'), 'utf8');
const routeSource = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'stockAnalysis.js'), 'utf8');
const jobSource = fs.readFileSync(path.resolve(__dirname, '..', 'services', 'jobDefinitions.js'), 'utf8');
const backfillSource = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'backfillCompanyFinancials.js'), 'utf8');
assert.ok(serviceSource.includes("'disclosure_date'"));
assert.ok(serviceSource.includes("report_type: '1'"));
assert.ok(routeSource.includes('refreshStockAnalysis(tsCode, `watchlist:${req.session.user}`, { readOnly: true })'));
assert.ok(routeSource.includes('enqueueCompanyFinancialSyncByCode'));
assert.ok(jobSource.includes("jobCode: 'company_financial_incremental_sync'"));
assert.ok(jobSource.includes("strictDatasetPublication: true"));
assert.ok(backfillSource.includes("valueOf('--offset'"));
assert.ok(serviceSource.includes('targets.slice(offset, offset + limit)'));
assert.ok(serviceSource.includes('market.convertible_bond_daily_metrics'));

console.log('company financial incremental tests passed');
