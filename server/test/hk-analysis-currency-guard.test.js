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
    assert.strictEqual(hk.publicSnapshotOf(analysis).display.formula_version, 'hk-8');
    assert.strictEqual((await hk.refreshHkAnalysis('00005.HK')).cashflow.latest_year.operating, null);
    // hk-6 旧快照在 hk-7 下自动失效保护（汇率读取修复 + 图表币种口径变化）
    const oldHk6 = { ...old, display: { ...old.display, formula_version: 'hk-6' } };
    assert.strictEqual(hk.publicSnapshotOf(oldHk6).display.field_status.ttm_profit.value, null);
  } finally {
    stockRepository.readLatestSnapshot = originalRead;
    stockRepository.loadAnalysisInputs = originalInputs;
    hkRepository.readHkReportFacts = originalFacts;
  }

  // #84 补充指标与严格覆盖证据测试
  const baseValuations = [
    { trade_date: '20240102', close: 10, adj_factor: 1, pe_ttm: -8, pb: 1.2, total_mv: 10000, dv_ttm: 0, total_share: 1000 },
    { trade_date: '20251101', close: 12, adj_factor: 1.25, pe_ttm: -10, pb: 1.4, total_mv: 12000, dv_ttm: 0, total_share: 1000 },
  ];
  const lossBuild = hk.buildHkAnalysis({
    meta: { name: '测试港股', list_date: '20150101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendSyncVerified: false,
    reportFacts: [
      { period_end: '2025-06-30', period_type: 'semiannual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1',
        report_ids: [{ kind: 'income', report_id: 11 }], profit: 15000000, currency_unverified: false },
      { period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1',
        report_ids: [{ kind: 'income', report_id: 1 }, { kind: 'balance', report_id: 2 }],
        profit: -20000000, equity: 80000000, goodwill: null,
        balance_coverage: { complete: true, requested_metric_codes: ['bs.tetoshopc', 'bs.gw'] }, currency_unverified: false },
      { period_end: '2023-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1',
        report_ids: [{ kind: 'income', report_id: 3 }], profit: -10000000, currency_unverified: false },
      { period_end: '2022-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1',
        report_ids: [{ kind: 'income', report_id: 4 }], profit: -30000000, currency_unverified: false },
    ],
  }, { tsCode: '09999.HK', today: '20251101' });

  assert.ok(lossBuild.valuation.pe_static < 0, '亏损股静态 PE 应输出负值');
  assert.ok(lossBuild.valuation.pe_three_year_avg < 0, '亏损股三年平均 PE 应输出负值');
  assert.ok(lossBuild.valuation.pe_forecast > 0, '中报存在时动态 PE 应年化计算');
  assert.strictEqual(lossBuild.valuation.pb_ex_goodwill, 1.5, '已请求商誉且完整但未披露时按 0 计算扣除商誉 PB');
  assert.strictEqual(lossBuild.display.field_status.pb_ex_goodwill.reason, 'goodwill_not_disclosed_treated_as_zero');
  assert.strictEqual(lossBuild.valuation.return_start_mode, 'range', '行情起始晚于上市日超过 30 天应标为 range');
  assert.strictEqual(lossBuild.valuation.payout_ratio, null, '无分红覆盖证据时分红率保持 null');
  assert.strictEqual(lossBuild.display.field_status.payout_ratio.reason, 'dividend_coverage_unverified');

  // 未请求商誉且分红完整起止覆盖已验证为 0
  const uncollectedGwBuild = hk.buildHkAnalysis({
    meta: { name: '测试港股2', list_date: '20240101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendCoverage: { complete: true, startDate: '2024-01-01', endDate: '2025-11-01' },
    reportFacts: [
      { period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1',
        report_ids: [{ kind: 'income', report_id: 1 }, { kind: 'balance', report_id: 2 }],
        profit: 20000000, equity: 80000000, goodwill: null,
        balance_coverage: { complete: true, requested_metric_codes: ['bs.tetoshopc'] }, currency_unverified: false },
    ],
  }, { tsCode: '09998.HK', today: '20251101' });
  assert.strictEqual(uncollectedGwBuild.valuation.pb_ex_goodwill, null, '未请求商誉时禁止按 0 计算扣除商誉 PB');
  assert.strictEqual(uncollectedGwBuild.display.field_status.pb_ex_goodwill.reason, 'goodwill_not_collected');
  assert.strictEqual(uncollectedGwBuild.valuation.payout_ratio, 0, '分红覆盖已验证且 dv_ttm=0 时分红率可输出 0');
  assert.strictEqual(uncollectedGwBuild.valuation.return_start_mode, 'listing');

  // F-03: 仅传成功水位无起止覆盖、覆盖不完整、以及不可换汇真实分红事件均不得输出 0%
  const watermarkOnly = hk.buildHkAnalysis({
    meta: { name: '水位无起点', list_date: '20240101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendSyncVerified: true,
    dividendSyncDate: '2025-11-01',
    reportFacts: uncollectedGwBuild ? [{ period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false }] : [],
  }, { tsCode: '09995.HK', today: '20251101' });
  assert.strictEqual(watermarkOnly.valuation.payout_ratio, null, 'F-03: 仅传成功水位无覆盖起点时不得输出 0%');
  assert.strictEqual(watermarkOnly.valuation.cumulative_payout_ratio, null);

  const incompleteCov = hk.buildHkAnalysis({
    meta: { name: '覆盖不完整', list_date: '20240101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendSyncVerified: true,
    dividendCoverage: { complete: false, startDate: '2020-01-01', endDate: '2025-11-01' },
    reportFacts: [{ period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false }],
  }, { tsCode: '09994.HK', today: '20251101' });
  assert.strictEqual(incompleteCov.valuation.payout_ratio, null, 'F-03: 覆盖明确不完整时不得输出 0%');

  // F-03: 2023/2024 均有盈利，覆盖从 2023-12-31（最早财年期末）才开始时，累计分红率与平均股息率不得输出 0%
  const tailStartCov = hk.buildHkAnalysis({
    meta: { name: '首年缺头', list_date: '20200101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendCoverage: { complete: true, startDate: '2023-12-31', endDate: '2025-11-01' },
    reportFacts: [
      { period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false },
      { period_end: '2023-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 2 }], profit: 15000000, currency_unverified: false },
    ],
  }, { tsCode: '09992.HK', today: '20251101' });
  assert.strictEqual(tailStartCov.valuation.payout_ratio, 0, '2024 完整覆盖时分红率为 0');
  assert.strictEqual(tailStartCov.valuation.cumulative_payout_ratio, null, 'F-03: 覆盖从 2023-12-31 开始未覆盖 2023 全年，累计分红率不得为 0');
  assert.strictEqual(tailStartCov.valuation.average_dividend_yield, null, 'F-03: 覆盖未达最早财年起日时平均股息率不得为 0');

  const unconvertibleDiv = hk.buildHkAnalysis({
    meta: { name: '不可换汇分红', list_date: '20240101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [{ ex_date: '2025-05-10', fiscal_year: '2024', cash_per_share: 0.5, currency: 'USD' }],
    events: [],
    dividendCoverage: { complete: true, startDate: '2020-01-01', endDate: '2025-11-01' },
    reportFacts: [{ period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false }],
  }, { tsCode: '09993.HK', today: '20251101' });
  assert.strictEqual(unconvertibleDiv.valuation.payout_ratio, null, 'F-03: 存在不可换汇分红事件时不得输出 0%');
  assert.strictEqual(unconvertibleDiv.valuation.cumulative_payout_ratio, null);
  assert.strictEqual(unconvertibleDiv.display.field_status.payout_ratio.reason, 'fx_rate_missing');

  // 分红按股本推算必须标注 is_estimated
  const estDivBuild = hk.buildHkAnalysis({
    meta: { name: '测试港股3', list_date: '20240101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [{ ex_date: '2025-05-10', fiscal_year: '2024', cash_per_share: 0.5, currency: 'HKD' }],
    events: [],
    reportFacts: [
      { period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1',
        report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false },
    ],
  }, { tsCode: '09997.HK', today: '20251101' });
  assert.strictEqual(estDivBuild.valuation.dividend_is_estimated, true);
  assert.strictEqual(estDivBuild.valuation.dividend_basis, 'estimated_from_shares');
  assert.ok(estDivBuild.valuation.payout_ratio > 0);

  // F-03: 仅有旧财年(2022)分红且无目标财年(2023/2024)覆盖证据时，三个分红指标必须保持 null
  const oldDivNoCov = hk.buildHkAnalysis({
    meta: { name: '测试港股4', list_date: '20200101', currency: 'HKD' },
    valuations: [{ trade_date: '20251101', close: 10, adj_factor: 1, pe_ttm: 10, pb: 1, total_mv: 10000, dv_ttm: 0, total_share: 1000 }],
    dividends: [{ ex_date: '2022-06-01', fiscal_year: '2022', cash_per_share: 0.5, currency: 'HKD' }],
    events: [],
    dividendSyncVerified: false,
    reportFacts: [
      { period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1',
        report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false },
      { period_end: '2023-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1',
        report_ids: [{ kind: 'income', report_id: 2 }], profit: 15000000, currency_unverified: false },
    ],
  }, { tsCode: '09996.HK', today: '20251101' });
  assert.strictEqual(oldDivNoCov.valuation.payout_ratio, null, 'F-03: 无 2024 覆盖证据时分红率不得为 0');
  assert.strictEqual(oldDivNoCov.valuation.cumulative_payout_ratio, null, 'F-03: 无覆盖证据时累计分红率不得为 0');
  assert.strictEqual(oldDivNoCov.valuation.average_dividend_yield, null, 'F-03: 无覆盖证据时平均股息率不得为 0');
  assert.strictEqual(oldDivNoCov.display.field_status.payout_ratio.reason, 'dividend_coverage_unverified');

  // F-03 Round 4: 闰年财年 2024-02-29 的起日为 2023-03-01，不得因 JS Date 闰年溢出误算为 2023-03-02
  const leapMissingFirstDay = hk.buildHkAnalysis({
    meta: { name: '闰年缺首日', list_date: '20200101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendCoverage: { complete: true, startDate: '2023-03-02', endDate: '2025-11-01' },
    reportFacts: [{ period_end: '2024-02-29', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false }],
  }, { tsCode: '09991.HK', today: '20251101' });
  assert.strictEqual(leapMissingFirstDay.valuation.payout_ratio, null, 'F-03: 闰年财年 2024-02-29 缺少 2023-03-01 覆盖时分红率不得为 0');
  assert.strictEqual(leapMissingFirstDay.valuation.cumulative_payout_ratio, null);
  assert.strictEqual(leapMissingFirstDay.valuation.average_dividend_yield, null);

  const leapFullCov = hk.buildHkAnalysis({
    meta: { name: '闰年完整覆盖', list_date: '20200101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendCoverage: { complete: true, startDate: '2023-03-01', endDate: '2025-11-01' },
    reportFacts: [{ period_end: '2024-02-29', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false }],
  }, { tsCode: '09990.HK', today: '20251101' });
  assert.strictEqual(leapFullCov.valuation.payout_ratio, 0);
  assert.strictEqual(leapFullCov.valuation.cumulative_payout_ratio, 0);
  assert.strictEqual(leapFullCov.valuation.average_dividend_yield, 0);

  const hkSvcSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'hkSecurityAnalysis.js'), 'utf8');
  assert.ok(hkSvcSrc.includes('const dividendCoverage = base.dividendCoverage') && hkSvcSrc.includes('dividendCoverage }'), 'F-03: loadHkAnalysisInputs 必须透传完整 dividendCoverage 区间');
  assert.ok(hkSvcSrc.includes('divCursor.cursor_payload'), 'F-03: loadHkAnalysisInputs 必须读取 divCursor.cursor_payload 中的覆盖区间');
  assert.ok(hkSvcSrc.includes('cursorPayload.complete === true'), 'F-03: 游标缺少 complete===true 时必须 fail-closed 不得判为完整覆盖');
  const cursorsSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'datasetCursors.js'), 'utf8');
  assert.ok(cursorsSrc.includes('cursor_payload') && cursorsSrc.includes('options.cursorPayload'), 'F-03: datasetCursors 必须支持读写 cursor_payload');
  const syncSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'stockSelectionInputsSync.js'), 'utf8');
  assert.ok(syncSrc.includes("datasetScope('hk', meta.ts_code), 'dividends'"), 'F-03: 现役采集必须写入 hk:<代码> dividends 完整覆盖区间');
  assert.ok(syncSrc.indexOf('await persistCollectedData(') < syncSrc.indexOf("datasetScope('hk', meta.ts_code), 'dividends'"), 'F-03: 必须先成功落库再写游标，落库失败不得写 complete=true');
  const mdSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'dataAccess', 'marketDatasets.js'), 'utf8');
  assert.ok(mdSrc.includes('readDividendRowsWithCoverage') && mdSrc.includes('!primary.fallback') && mdSrc.includes("incompleteReason || 'primary_failed'"), 'F-03: 主源成功(!primary.fallback)必须返回完整覆盖，主源失败后备源为空时必须标记 complete=false');
  const hkRefreshSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'hkSingleStockRefresh.js'), 'utf8');
  assert.ok(hkRefreshSrc.includes("domain === 'dividends' && Boolean(collectedDividendCoverage && collectedDividendCoverage.complete === true)"), 'F-03: 权威零分红完整覆盖时单股刷新不得标作 blocked_optional');
  assert.ok(hkRefreshSrc.includes('const covered = !domainError'), 'F-03: 本轮采集落库报错时不得凭历史行将领域状态标为成功');
  const hkAdapterSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'dataAccess', 'adapters', 'lixingerDatasetAdapter.js'), 'utf8');
  assert.ok(hkAdapterSrc.includes("incompleteReason = 'missing_fiscal_year'") && hkAdapterSrc.includes('__incompleteCoverage'), 'F-03: 有正分红金额但缺 fsEndDate 时不得伪装完整零分红');

  // F-03 Round 9: 仅有公告分红总额 total_cash_amount（无股本）时应直接使用总额计算，不得报 fx_rate_missing
  const officialTotalDiv = hk.buildHkAnalysis({
    meta: { name: '公告总额分红', list_date: '20200101', currency: 'HKD' },
    valuations: [{ trade_date: '20251101', close: 10, adj_factor: 1, pe_ttm: 10, pb: 1, total_mv: 10000, dv_ttm: 0, total_share: null }],
    dividends: [{ ex_date: '2025-05-10', fiscal_year: '2024', cash_per_share: 0.1, total_cash_amount: 1000000, currency: 'HKD' }],
    events: [],
    dividendCoverage: { complete: true, startDate: '2024-01-01', endDate: '2025-11-01' },
    reportFacts: [
      { period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false },
    ],
  }, { tsCode: '09986.HK', today: '20251101' });
  assert.strictEqual(officialTotalDiv.valuation.payout_ratio, 0.05, 'F-03: 100万港元 / 2000万港元利润应得 5% 分红率(0.05)');
  assert.strictEqual(officialTotalDiv.valuation.cumulative_payout_ratio, 0.05);
  assert.strictEqual(officialTotalDiv.valuation.dividend_is_estimated, false);
  assert.strictEqual(officialTotalDiv.valuation.dividend_basis, null);

  // F-03 Round 10: 同公告日不同除净日的两笔分红不得互相覆盖，合计 300 万港元应得 15%
  const { officialDividendSourceKey, legacyOfficialDividendSourceKeys } = require('../repositories/stockProjectionRepository');
  const k1 = officialDividendSourceKey({ ts_code: '09985.HK', end_date: '2024-12-31', ann_date: '2024-03-28', ex_date: '2024-04-20' });
  const k2 = officialDividendSourceKey({ ts_code: '09985.HK', end_date: '2024-12-31', ann_date: '2024-03-28', ex_date: '2024-04-25' });
  assert.notStrictEqual(k1, k2, 'F-03: 同公告日不同除净日必须生成不同 source_key');
  const legacyKeys = legacyOfficialDividendSourceKeys({ ts_code: '09985.HK', end_date: '2024-12-31', ann_date: '2024-03-28', ex_date: '2024-04-20', pay_date: '2024-05-01', record_date: '2024-04-29' }, 123);
  assert.ok(legacyKeys.includes('09985.HK:2024-12-31:2024-03-28'), 'F-03: 必须识别旧 3 段 source_key 进行原地升级');
  assert.ok(legacyKeys.includes('09985.HK:2024-12-31:2024-03-28:2024-05-01'), 'F-03: 必须识别先按付款日建键后补齐除净日的旧键');
  assert.ok(legacyKeys.includes('09985.HK:2024-12-31:2024-03-28:2024-04-29'), 'F-03: 必须识别先按登记日建键后补齐除净日的旧键');
  const regToPayKeys = legacyOfficialDividendSourceKeys({ ts_code: '09985.HK', end_date: '2024-12-31', ann_date: '2024-03-28', ex_date: null, pay_date: '2024-05-01', record_date: '2024-04-29' }, 123);
  assert.ok(regToPayKeys.includes('09985.HK:2024-12-31:2024-03-28:2024-04-29'), 'F-03: 必须识别先按登记日建键后补齐付款日的旧键');
  assert.ok(hkAdapterSrc.includes("`${mappedRow.pay_date || ''}:${mappedRow.record_date || ''}`"), 'F-03: 适配器去重键必须同时区分除净日、付款日与登记日');
  const multiDiv = hk.buildHkAnalysis({
    meta: { name: '同公告日两笔分红', list_date: '20200101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [
      { ex_date: '2024-04-20', ann_date: '2024-03-28', fiscal_year: '2024', total_cash_amount: 1000000, currency: 'HKD' },
      { ex_date: '2024-04-25', ann_date: '2024-03-28', fiscal_year: '2024', total_cash_amount: 2000000, currency: 'HKD' },
    ],
    events: [],
    dividendCoverage: { complete: true, startDate: '2024-01-01', endDate: '2025-11-01' },
    reportFacts: [
      { period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false },
    ],
  }, { tsCode: '09985.HK', today: '20251101' });
  assert.strictEqual(multiDiv.valuation.payout_ratio, 0.15, 'F-03: 两笔分红合计 300 万港元应得 15% 分红率(0.15)');
  assert.strictEqual(multiDiv.valuation.cumulative_payout_ratio, 0.15);

  // F-03 Round 6: 仅有起止日期但缺少 complete===true 时必须留空，不得误报 0%
  const missingCompleteFlag = hk.buildHkAnalysis({
    meta: { name: '缺完成标记', list_date: '20200101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendCoverage: { startDate: '2020-01-01', endDate: '2025-11-01' },
    reportFacts: [
      { period_end: '2024-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false },
    ],
  }, { tsCode: '09987.HK', today: '20251101' });
  assert.strictEqual(missingCompleteFlag.valuation.payout_ratio, null, 'F-03: 缺少 complete===true 时分红率不得为 0');
  assert.strictEqual(missingCompleteFlag.valuation.cumulative_payout_ratio, null);
  assert.strictEqual(missingCompleteFlag.valuation.average_dividend_yield, null);

  // F-03 Round 5: 次年 2 月末财年 2025-02-28 紧接闰年 2024-02-29，起日为 2024-03-01（不是 2024-02-29）
  const nextFebFullCov = hk.buildHkAnalysis({
    meta: { name: '次年二月末完整覆盖', list_date: '20200101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendCoverage: { complete: true, startDate: '2024-03-01', endDate: '2025-11-01' },
    reportFacts: [
      { period_end: '2025-02-28', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false },
      { period_end: '2024-02-29', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 2 }], profit: 15000000, currency_unverified: false },
    ],
  }, { tsCode: '09989.HK', today: '20251101' });
  assert.strictEqual(nextFebFullCov.valuation.payout_ratio, 0, 'F-03: 2025-02-28 从 2024-03-01 覆盖应输出 0%');
  assert.strictEqual(nextFebFullCov.valuation.cumulative_payout_ratio, null, '2024-02-29 未从 2023-03-01 覆盖时累计分红率保持 null');

  const nextFebMissingFirstDay = hk.buildHkAnalysis({
    meta: { name: '次年二月末缺首日', list_date: '20200101', currency: 'HKD' },
    valuations: baseValuations,
    dividends: [],
    events: [],
    dividendCoverage: { complete: true, startDate: '2024-03-02', endDate: '2025-11-01' },
    reportFacts: [
      { period_end: '2025-02-28', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD', source_version: 'v1', report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, currency_unverified: false },
    ],
  }, { tsCode: '09988.HK', today: '20251101' });
  assert.strictEqual(nextFebMissingFirstDay.valuation.payout_ratio, null, 'F-03: 2025-02-28 缺少 2024-03-01 覆盖时不得输出 0%');
  // 反馈 #100：港股按交易币种展示；跨币种比值只用已落库汇率折算，缺汇率才留空。
  const hkMarketValuations = [{ trade_date: '20251101', close: 10, adj_factor: 1, pe_ttm: 9, pb: 1.1, total_mv: 10000, dv_ttm: 0, total_share: 1000 }];
  const cnyReport = [{
    period_end: '2025-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'CNY', source_version: 'v1',
    report_ids: [{ kind: 'income', report_id: 1 }, { kind: 'balance', report_id: 2 }],
    profit: 10000000, equity: 50000000, goodwill: 0, currency_unverified: false,
  }];
  const withHkdRate = hk.buildHkAnalysis({
    meta: { name: '中国中药', list_date: '19930407', currency: 'HKD' },
    valuations: hkMarketValuations, dividends: [], events: [], reportFacts: cnyReport,
    fxToCny: { HKD: 0.92, USD: 7.1 },
  }, { tsCode: '00570.HK', today: '20251101' });
  assert.ok(withHkdRate.valuation.pe_static > 0, '#100: HKD 市值 + CNY 财报在已有 HKD→CNY 汇率时必须算出静态 PE');
  assert.strictEqual(withHkdRate.display.field_status.pe_static.reason, null);
  assert.ok(Math.abs(withHkdRate.valuation.pe_static - 9.2) < 1e-9, '#100: CNY 利润按 HKD→CNY 折算后再与 HKD 市值相除');
  assert.ok(withHkdRate.valuation.pb_ex_goodwill > 0, '#100: 净资产同样按 HKD 交易币种折算');
  assert.strictEqual(withHkdRate.display.currency, 'HKD');
  assert.strictEqual(withHkdRate.display.report_currency, 'CNY');
  assert.strictEqual(withHkdRate.display.currency_label, '港元 (HKD)');
  assert.ok(withHkdRate.display.currency_note.includes('财报币种：人民币 (CNY)'), '#100: 页面顶部必须说明交易/财报币种');

  const usdReport = [{ ...cnyReport[0], currency: 'USD', profit: 1000000 }];
  const withUsdRate = hk.buildHkAnalysis({
    meta: { name: '美元财报港股', list_date: '19930407', currency: 'HKD' },
    valuations: hkMarketValuations, dividends: [], events: [], reportFacts: usdReport,
    fxToCny: { HKD: 0.92, USD: 7.1 },
  }, { tsCode: '00571.HK', today: '20251101' });
  assert.ok(withUsdRate.valuation.pe_static > 0, '#100: HKD 市值 + USD 财报必须用 USD→CNY 与 HKD→CNY 交叉折算');
  assert.strictEqual(withUsdRate.display.report_currency, 'USD');

  const missingRate = hk.buildHkAnalysis({
    meta: { name: '缺汇率港股', list_date: '19930407', currency: 'HKD' },
    valuations: hkMarketValuations, dividends: [], events: [], reportFacts: cnyReport,
    fxToCny: {},
  }, { tsCode: '00572.HK', today: '20251101' });
  assert.strictEqual(missingRate.valuation.pe_static, null, '#100: 真缺交叉汇率时不得用不同币种直接相除');
  assert.strictEqual(missingRate.display.field_status.pe_static.reason, 'fx_rate_missing');

  const hkdReport = [{ ...cnyReport[0], currency: 'HKD' }];
  const sameCurrency = hk.buildHkAnalysis({
    meta: { name: '港币财报港股', list_date: '19930407', currency: 'HKD' },
    valuations: hkMarketValuations, dividends: [], events: [], reportFacts: hkdReport,
    fxToCny: {},
  }, { tsCode: '00573.HK', today: '20251101' });
  assert.ok(sameCurrency.valuation.pe_static > 0, '#100: 交易与财报同为 HKD 时无需汇率即可计算');

  const hkSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'hkSecurityAnalysis.js'), 'utf8');
  assert.ok(hkSrc.includes("readLatestRatePairUpTo({ baseCurrency: 'HKD', quoteCurrency: 'CNY'"), '#100: 汇率必须按仓储对象签名读取');
  assert.ok(!/readLatestRatePairUpTo\('HKD'/.test(hkSrc), '#100: 不得再使用会静默返回空的三位置参数');

  console.log('港股概览币种与旧快照保护通过');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
