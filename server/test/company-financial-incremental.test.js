const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  currentReportPeriods, isDisclosureSeason, stateForTarget, fetchCompanyReports,
  selectCompanyBatch, shouldAbortFinancialBatch,
} = require('../services/companyFinancialIncrementalSync');
const { rowVersion } = require('../services/financialDataArchitecture');
const { publicationQualityGate } = require('../services/bondSafetyService');

assert.deepStrictEqual(currentReportPeriods('2026-09-04'), ['20260630', '20260331']);
assert.deepStrictEqual(currentReportPeriods('2026-10-01'), ['20260930', '20260630']);
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
assert.ok(serviceSource.includes('pendingTargets.slice(offset, offset + limit)'));
assert.ok(serviceSource.includes('market.convertible_bond_daily_metrics'));
assert.ok(serviceSource.includes("['fina_indicator', 'fina_indicator_vip'].includes(apiName)"));
assert.ok(serviceSource.includes('options.resume === false'));
assert.ok(backfillSource.includes("const resume = !has('--force')"));
assert.ok(serviceSource.includes('return listCurrentBondUnderlyingTargets(client)'));
assert.ok(!serviceSource.includes("'holding' AS reason") && !serviceSource.includes("'ipo' AS reason"));
assert.ok(serviceSource.includes("i.status='listed'") && serviceSource.includes("iss.issue_type NOT IN ('定向','私募')"));
assert.ok(backfillSource.includes('includeHistoricalGaps: true'));
assert.strictEqual(shouldAbortFinancialBatch({ code: 'JOB_BUDGET_EXCEEDED' }), true);

const previousActive = process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE;
const previousLimit = process.env.JOB_EXTERNAL_CALL_LIMIT;
process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE = '1';
process.env.JOB_EXTERNAL_CALL_LIMIT = '80';
const batch = selectCompanyBatch(Array.from({ length: 20 }, (_, index) => ({ companyId: index + 1, needs: ['income', 'balance', 'cashflow', 'indicator'] })), 20, { usedCalls: 2 });
assert.strictEqual(batch.length, 19);
if (previousActive == null) delete process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE;
else process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE = previousActive;
if (previousLimit == null) delete process.env.JOB_EXTERNAL_CALL_LIMIT;
else process.env.JOB_EXTERNAL_CALL_LIMIT = previousLimit;

(async () => {
  const result = await fetchCompanyReports(
    { tsCode: '600000.SH', needs: ['indicator'] },
    {
      reportPeriods: ['20260630'],
      preferVip: false,
      query: async () => ({ fields: ['ts_code', 'ann_date', 'end_date', 'roe'], items: [['600000.SH', '20260830', '20260630', 8.5]] }),
    }
  );
  assert.strictEqual(result.results.indicator.length, 1);
  assert.strictEqual(result.results.indicator[0].report_type, '1');
  console.log('company financial incremental tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
