'use strict';

const assert = require('assert');
const dict = require('../dataAccess/lixingerReportMetrics');
const official = require('../services/lixingerOfficial');
const { pool } = require('../db/connection');
const { migration194FinancialStatementTypeColumns } = require('../db/migrations/era11FinancialStatements');

async function main() {
  const statementService = require('../services/stockStatementService');
  const hkStatements = require('../services/hkStockStatements');
  const hkAnalysis = require('../services/hkSecurityAnalysis');
  const versionRows = [{ report_id: 1, period_end: '2025-12-31', period_type: 'annual',
    source_version: 'v1', statement_revision: 'r1' }];
  const versionParams = { canonicalCode: '00005.HK', market: 'HK', type: 'income', rows: versionRows };
  const cnVersion = { canonicalCode: '000858.SZ', market: 'CN', type: 'income', rows: versionRows };
  assert.notStrictEqual(statementService.statementAnalysisVersionOf(cnVersion),
    statementService.statementAnalysisVersionOf({ ...cnVersion, formulaVersion: 'stock-statements-4' }), '跨市场报告选择变化必须产生新版本');
  assert.notStrictEqual(statementService.statementAnalysisVersionOf({ ...versionParams, formulaVersion: hkStatements.FORMULA_VERSION }),
    statementService.statementAnalysisVersionOf({ ...versionParams, formulaVersion: 'hk-statements-1' }), '展示和度量合同变化必须产生新版本');
  const overview = hkAnalysis.buildHkAnalysis({ reportFacts: [{ ...versionRows[0], currency: 'HKD',
    report_ids: [{ kind: 'income', report_id: 1, statement_revision: 'r1' }] }] }, { tsCode: '00005.HK' });
  assert.strictEqual(overview.display.statement_analysis_versions.income,
    statementService.statementAnalysisVersionOf({ ...versionParams, formulaVersion: hkStatements.FORMULA_VERSION }), '概览与三表必须使用同一版本');
  const calls = [];
  let addQuarterly = false;
  official.callEndpoint = async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (endpoint === 'cn/company') return { rawRecordId: 321, rows: [
      { stockCode: '000001', exchange: 'sz', fsTableType: 'bank' },
      { stockCode: '000001', exchange: 'sh', fsTableType: 'non_financial' },
    ] };
    assert.strictEqual(endpoint, 'cn/company/fs/bank');
    const q = {};
    for (const metric of params.metricsList) {
      const match = /^q\.([a-z]+)\.([a-z0-9_]+)\.t$/.exec(metric);
      assert.ok(match, metric);
      (q[match[1]] ||= {})[match[2]] = { t: match[2] === 'cabwcb' ? 254225000000
        : match[2] === 'toe_ta_r' ? 0.25 : 123 };
    }
    const report = { date: '2025-12-31', standardDate: '2025-12-31', reportDate: '2026-03-01',
      reportType: 'annual_report', stockCode: '000001', currency: 'CNY', q };
    return { rows: addQuarterly ? [report, { ...report, reportType: 'fourth_quarterly_report' }] : [report] };
  };
  const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
  const datasets = require('../dataAccess/marketDatasets');
  const profiles = await adapter.resolveCnCompanyProfiles({ codes: ['000001.SZ'] });
  assert.deepStrictEqual(profiles.map(row => [row.code, row.fsTableType]), [['000001.SZ', 'bank']]);

  calls.length = 0;
  const result = await datasets.readFinancialReportRows({ tsCode: '000001.SZ',
    kinds: ['balance', 'income', 'cashflow', 'indicator'], startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.strictEqual(calls[0].endpoint, 'cn/company');
  const requests = calls.filter(call => call.endpoint === 'cn/company/fs/bank');
  assert.ok(requests.length >= 3);
  const allowed = new Set(dict.metricsOfType('CN', 'bank').map(metric => `q.${metric.code}.t`));
  for (const { params } of requests) {
    assert.ok(params.metricsList.length <= 128);
    assert.ok(params.metricsList.every(code => allowed.has(code) || /^q\.m\./.test(code)), '不得混发非本类型科目');
  }
  const requested = new Set(requests.flatMap(call => call.params.metricsList));
  assert.ok(requested.has('q.bs.cabwcb.t') && requested.has('q.bs.tlaatc.t') && requested.has('q.ps.nii.t'));
  assert.ok(!requested.has('q.bs.tfa.t'));
  assert.strictEqual(result.balance[0].__statement_metrics['bs.cabwcb'], 254225000000);
  assert.strictEqual(result.balance[0].__statement_coverage.fs_table_type, 'bank');
  assert.deepStrictEqual(result.balance[0].__statement_coverage.fs_table_type_evidence,
    { source_code: 'lixinger_official', raw_record_id: 321, scope: 'current_company_profile' });
  assert.strictEqual(result.balance[0].__statement_coverage.complete, true);
  calls.length = 0; addQuarterly = true;
  const annuals = await adapter.resolveAnnualNetProfits({ tsCode: '000001.SZ', startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.strictEqual(annuals.length, 1, '年末但来源类型不是年报不能冒充年报');
  assert.strictEqual(calls[1].endpoint, 'cn/company/fs/bank', '静态估值利润必须使用银行财报端点');
  calls.length = 0;
  assert.deepStrictEqual(await adapter.resolveAnnualNetProfits({ tsCode: '00005.HK', startDate: '2025-01-01', endDate: '2025-12-31' }), []);
  assert.strictEqual(calls.length, 0, '港股币种待核实，不得请求或计算静态估值利润');
  addQuarterly = false;
  await assert.rejects(() => datasets.readFinancialReportRows({ tsCode: '000001.SZ', fsTableType: 'unrecognized' }),
    error => error.code === 'FINANCIAL_TYPE_UNKNOWN');
  const oldProfile = adapter.resolveCnCompanyProfiles;
  adapter.resolveCnCompanyProfiles = async () => [];
  try {
    await assert.rejects(() => datasets.readFinancialReportRows({ tsCode: '000001.SZ' }),
      error => error.code === 'FINANCIAL_TYPE_UNKNOWN');
  } finally { adapter.resolveCnCompanyProfiles = oldProfile; }

  // 仅在测试库事务中执行迁移，回滚后不能改变测试库或业务库的架构。
  const client = await pool.connect();
  try {
    const db = (await client.query('SELECT current_database() AS name')).rows[0].name;
    assert.strictEqual(db, 'portfolio_test');
    await client.query('BEGIN');
    await migration194FinancialStatementTypeColumns(client);
    await migration194FinancialStatementTypeColumns(client);
    const rows = await client.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='fundamental' AND (table_name,column_name) IN
      (('statement_balance_cas','bs_cabwcb'),('statement_balance_cas','bs_tlaatc'),('statement_income_cas','ps_nii'))`);
    assert.strictEqual(rows.rowCount, 3);
    for (const market of ['CN', 'HK']) {
      for (const kind of dict.STATEMENTS) {
        const [schema, table] = dict.tableNameOf(market, kind).split('.');
        const columns = dict.metricsByStatement(market, kind).map(metric => dict.columnOf(metric.code));
        const missing = await client.query(`SELECT requested.column_name FROM unnest($3::text[]) AS requested(column_name)
          WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema=$1 AND c.table_name=$2 AND c.column_name=requested.column_name)`, [schema, table, columns]);
        assert.deepStrictEqual(missing.rows, [], `${market}/${kind} 必须承载所有类型科目`);
      }
    }
    const name = `财报类型回归-${Date.now()}`;
    const company = (await client.query('INSERT INTO core.companies(legal_name) VALUES($1) RETURNING company_id', [name])).rows[0].company_id;
    const code = '999998.SZ';
    const instrument = (await client.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code)
      VALUES($1,$2,'stock','CN','SZSE','CNY') RETURNING instrument_id`, [code, name])).rows[0].instrument_id;
    await client.query('INSERT INTO core.company_instruments(company_id,instrument_id) VALUES($1,$2)', [company, instrument]);
    const source = (await client.query("SELECT source_id FROM ops.data_sources WHERE source_code='lixinger_official'")).rows[0].source_id;
    const projection = require('../repositories/stockProjectionRepository');
    const repository = require('../repositories/stockStatementsRepository');
    const service = require('../services/stockStatementService');
    for (const kind of ['balance', 'income', 'cashflow']) {
      await projection.syncReportRows(client, result[kind], kind, company, source, { tsCode: code });
      const reportRows = await repository.listStatementRows({ tsCode: code, market: 'CN', type: kind, tx: client });
      const payload = service.buildStatementPayload({ market: 'CN', type: kind, rows: reportRows, canonicalCode: code });
      assert.strictEqual(payload.periods[0].fs_table_type, 'bank');
      if (kind === 'balance') {
        const cash = payload.fields.find(field => field.code === 'bs.cabwcb');
        const employees = payload.fields.find(field => field.code === 'bs.ep_stn');
        assert.strictEqual(cash.values[0].value, 2542.25);
        assert.strictEqual(employees.values[0].value, 123);
        assert.strictEqual(employees.unit, '人');
        assert.strictEqual(employees.section, '员工情况');
        const cashDetail = payload.fields.find(field => field.code === 'bs.c');
        assert.strictEqual(cashDetail.label, '(其中)现金');
        assert.strictEqual(cashDetail.section, '资产总计');
        assert.strictEqual(cashDetail.parent, null, '银行现金父项只有发行人样本，来源类型关系未核实时保持平级');
        assert.strictEqual(cashDetail.level, 0);
        const equityRatio = payload.fields.find(field => field.code === 'bs.toe_ta_r');
        assert.strictEqual(equityRatio.values[0].value, 25);
        assert.strictEqual(equityRatio.unit, '%');
      }
      if (kind === 'income') assert.strictEqual(payload.fields.find(field => field.code === 'ps.nii').section, '营业收入');
    }
    const selection = require('../repositories/stockSelectionRepository');
    await client.query(`INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close)
      VALUES($1,'2026-11-12',$2,10)`, [instrument, source]);
    await client.query(`INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,total_market_cap,currency_code)
      VALUES($1,'2026-11-12',$2,1000,'CNY')`, [instrument, source]);
    await client.query(`UPDATE fundamental.financial_facts SET currency_code=NULL WHERE report_id IN
      (SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1)
      AND metric_code IN ('equity_parent','net_profit_parent')`, [company]);
    let universe = (await selection.loadUniverse({ market: 'CN', asOfDate: '2026-11-13' }, client)).find(row => row.code === code);
    assert.ok(universe);
    assert.strictEqual(universe.pb, null, '报表币种未知时不能与估值相除');
    assert.strictEqual(universe.pe_static, null, '利润币种未知时不能与估值相除');
    await client.query(`UPDATE fundamental.financial_facts SET currency_code='CNY' WHERE report_id IN
      (SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1)
      AND metric_code IN ('equity_parent','net_profit_parent')`, [company]);
    universe = (await selection.loadUniverse({ market: 'CN', asOfDate: '2026-11-13' }, client)).find(row => row.code === code);
    assert.ok(Number(universe.pb) > 0 && Number(universe.pe_static) > 0, '同币种的已知事实仍可计算');

    const freeHkCode = (await client.query(`SELECT lpad(n::text,5,'0')||'.HK' AS code FROM generate_series(80000,89999) n
      WHERE NOT EXISTS (SELECT 1 FROM core.instruments i WHERE i.canonical_code=lpad(n::text,5,'0')||'.HK') LIMIT 1`)).rows[0].code;
    const hkInstrument = (await client.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code)
      VALUES($1,$2,'stock','HK','HKEX','HKD') RETURNING instrument_id`, [freeHkCode, name])).rows[0].instrument_id;
    await client.query('INSERT INTO core.company_instruments(company_id,instrument_id) VALUES($1,$2)', [company, hkInstrument]);
    const safeFact = `WITH r AS (SELECT $1::bigint company_id,$2::smallint source_id,$3::jsonb raw_payload),
      f AS (SELECT 123::numeric numeric_value,$4::text currency_code)
      SELECT ${selection.SAFE_FINANCIAL_FACT_SQL} AS value FROM r,f`;
    const valueOf = async (payload, factCurrency) => (await client.query(safeFact,
      [company, source, JSON.stringify(payload), factCurrency])).rows[0].value;
    assert.strictEqual(await valueOf({ currency: 'USD' }, 'USD'), null, '身份不明且关联港股的旧外币事实必须保护');
    assert.strictEqual(await valueOf({ ts_code: '000001.SZ', currency: 'CNY' }, 'CNY'), '123', '明确 A 股来源不因关联港股而受阻');
    assert.strictEqual(await valueOf({ currency: 'USD', __statement_coverage: { value_basis: 'source_original_t_o' } }, 'USD'), '123', '原始值和币种均有证据时允许读取');
    assert.strictEqual(await valueOf({ ts_code: '00005.HK', currency: 'USD', __statement_coverage: { value_basis: 'source_original_t_o' } }, 'HKD'), null, '标准事实与报告币种不一致不得放行');
    assert.strictEqual(await valueOf({ ts_code: '00005.HK', currency: 'USD', __statement_coverage: { value_basis: 'source_original_t_o' } }, null), null, '事实币种未知不得放行');

    await projection.syncReportRows(client, [{ ts_code: freeHkCode, end_date: '2024-12-31', ann_date: '2025-03-01',
      report_type: '1', period_type: 'annual', currency: 'USD', total_assets: 200000000,
      __statement_coverage: { value_basis: 'source_original_t_o', market: 'HK', fs_table_type: 'bank' },
      __statement_metrics: { 'bs.ta': 200000000, 'bs.tetoshopc': 100000000 } }], 'balance', company, source, { tsCode: freeHkCode });
    const legacySource = (await client.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare'")).rows[0].source_id;
    const legacyReport = (await client.query(`INSERT INTO fundamental.financial_reports
      (company_id,report_kind,period_end,period_type,announced_at,source_id,source_version,raw_payload)
      VALUES($1,'balance','2023-12-31','annual','2024-03-01',$2,'legacy-market-test',$3::jsonb) RETURNING report_id`,
    [company, legacySource, JSON.stringify({ ts_code: code, total_assets: 123000000, currency: 'CNY' })])).rows[0].report_id;
    const hkReport = (await client.query(`SELECT report_id FROM fundamental.financial_reports
      WHERE company_id=$1 AND report_kind='balance' AND period_end='2024-12-31'`, [company])).rows[0].report_id;
    const hkMarketRows = await repository.listStatementRows({ tsCode: freeHkCode, market: 'HK', type: 'balance', tx: client });
    assert.strictEqual(hkMarketRows.length, 1, '关联 A 股报告不能挤入港股三表期间');
    assert.strictEqual(String(hkMarketRows[0].report_id), String(hkReport));
    const cnMarketRows = await repository.listStatementRows({ tsCode: code, market: 'CN', type: 'balance', tx: client });
    assert.ok(cnMarketRows.length > 0 && cnMarketRows.every(item => String(item.report_id) !== String(hkReport)), '关联港股报告不能挤入 A 股三表期间');
    const legacyRow = cnMarketRows.find(item => String(item.report_id) === String(legacyReport));
    assert.ok(legacyRow, '有明确 A 股代码的无宽表历史报告仍可读取');
    assert.strictEqual(service.buildStatementPayload({ market: 'CN', type: 'balance', rows: [legacyRow], canonicalCode: code })
      .fields.find(item => item.code === 'bs.ta').values[0].value, 1.23, '旧 A 股原始字段回退必须保留');
    const readBalance = async () => (await repository.listStatementRows({ tsCode: freeHkCode, market: 'HK', type: 'balance', tx: client }))
      .find(item => String(item.report_id) === String(hkReport));
    let hkRow = await readBalance();
    assert.strictEqual(hkRow.source_currency, 'USD', '三表仓储必须读出原报告币种');
    assert.strictEqual(service.buildStatementPayload({ market: 'HK', type: 'balance', rows: [hkRow], canonicalCode: freeHkCode })
      .fields.find(item => item.code === 'bs.ta').values[0].value, 2);

    await client.query(`UPDATE fundamental.statement_balance_hkfrs SET currency_code='HKD' WHERE report_id=$1`, [hkReport]);
    hkRow = await readBalance();
    assert.strictEqual(service.buildStatementPayload({ market: 'HK', type: 'balance', rows: [hkRow], canonicalCode: freeHkCode })
      .fields.find(item => item.code === 'bs.ta').values[0].value, null, '真实宽表币种错配不得展示');
    const hkGroups = await hkAnalysis.readHkReportFacts(freeHkCode, 20, client);
    assert.strictEqual(hkGroups.find(group => group.period_end === '2024-12-31').assets, null, '概览读取同样隐藏错配金额');
    await projection.syncReportRows(client, [{ ts_code: freeHkCode, end_date: '2025-12-31', ann_date: '2026-04-01',
      report_type: '1', period_type: 'annual', currency: 'USD', __statement_coverage: { market: 'HK', value_basis: 'source_original_t_o' },
      __statement_metrics: { 'bs.ta': 200000000 } }], 'balance', company, source, { tsCode: freeHkCode });
    const currentDiagnostic = await client.query(`SELECT raw_payload->>'ts_code' AS code,is_current_version
      FROM fundamental.financial_reports WHERE company_id=$1 AND report_kind='balance' AND period_end='2025-12-31' ORDER BY code`, [company]);
    assert.strictEqual(currentDiagnostic.rows.filter(item => item.is_current_version).length, 2, 'A/H 同期报告的兼容当前标记必须按市场分别保留');
    const cnSamePeriod = await repository.listStatementRows({ tsCode: code, market: 'CN', type: 'balance', tx: client });
    const hkSamePeriod = await repository.listStatementRows({ tsCode: freeHkCode, market: 'HK', type: 'balance', tx: client });
    assert.ok(cnSamePeriod.some(item => item.period_end === '2025-12-31' && item.source_currency === 'CNY'), 'A 股同期报告不能被港股全局标记遮蔽');
    assert.ok(hkSamePeriod.some(item => item.period_end === '2025-12-31' && item.source_currency === 'USD'), '港股同期报告应独立可读');
    const hkSamePeriodGroups = await hkAnalysis.readHkReportFacts(freeHkCode, 20, client);
    assert.ok(hkSamePeriodGroups.some(group => group.period_end === '2025-12-31' && group.assets === 200000000), '概览应读取独立港股版本');
    const legacyAnalysis = require('../repositories/stockAnalysisRepository');
    const hkLegacyInputs = await legacyAnalysis.loadAnalysisInputs({ tsCode: freeHkCode }, client);
    for (const kind of ['income', 'balance', 'cashflow', 'indicators']) {
      assert.ok(hkLegacyInputs[kind].every(row => String(row.ts_code || '').toUpperCase() === freeHkCode),
        `旧股票分析 ${kind} 入口不得混入同公司的 A 股报告`);
    }
    await projection.syncReportRows(client, [{ ts_code: freeHkCode, end_date: '2025-12-31', ann_date: '2026-04-02',
      report_type: '1', period_type: 'annual', currency: 'USD', record_marker: 'parent',
      __statement_coverage: { market: 'HK', value_basis: 'source_original_t_o' },
      __statement_metrics: { 'bs.ta': 900000000 } }], 'balance', company, source, { tsCode: freeHkCode });
    await client.query(`UPDATE fundamental.financial_reports SET statement_scope='parent'
      WHERE company_id=$1 AND raw_payload->>'record_marker'='parent'`, [company]);
    const bothScopes = await repository.listStatementRows({ tsCode: freeHkCode, market: 'HK', type: 'balance', tx: client });
    assert.strictEqual(bothScopes.filter(item => item.period_end === '2025-12-31').length, 2, '同市场同报告期的不同范围独立选版');
    const consolidatedOnly = await repository.listStatementRows({ tsCode: freeHkCode, market: 'HK', type: 'balance', scope: 'consolidated', tx: client });
    const parentOnly = await repository.listStatementRows({ tsCode: freeHkCode, market: 'HK', type: 'balance', scope: 'parent', tx: client });
    assert.strictEqual(parentOnly.length, 1);
    assert.ok(consolidatedOnly.every(item => item.statement_scope === 'consolidated'));
    const visible = service.buildStatementPayload({ market: 'HK', type: 'balance', rows: consolidatedOnly, versionRows: bothScopes, canonicalCode: freeHkCode });
    assert.strictEqual(visible.scope, 'consolidated', '默认仅显示合并口径');
    assert.ok(visible.available_filters.scopes.includes('parent'), '可用筛选须包括未选中的其他范围');
    const groupsWithParent = await hkAnalysis.readHkReportFacts(freeHkCode, 20, client);
    const overviewWithParent = hkAnalysis.buildHkAnalysis({ reportFacts: groupsWithParent }, { tsCode: freeHkCode });
    assert.strictEqual(overviewWithParent.latest_report.end_date, '2025-12-31');
    assert.strictEqual(groupsWithParent.find(group => group.statement_scope === 'parent').assets, 900000000);
    assert.ok(!overviewWithParent.latest_report.report_ids.some(item => String(item.report_id) === String(parentOnly[0].report_id)), '概览不能把母公司报告当合并报告');
    assert.strictEqual(overviewWithParent.display.statement_analysis_versions.balance,
      service.statementAnalysisVersionOf({ canonicalCode: freeHkCode, market: 'HK', type: 'balance',
        formulaVersion: hkStatements.FORMULA_VERSION, rows: bothScopes }), '概览和三表版本都须涵盖可选范围');

    // 选股侧也必须按市场取标准事实，不能因为 A/H 共用 company_id 就把另一市场的最新报告带进来。
    const insertSelectionReport = async ({ kind, periodEnd, announcedAt, tsCode, metricCode, value }) => {
      const row = (await client.query(`INSERT INTO fundamental.financial_reports
        (company_id,report_kind,period_end,period_type,statement_scope,announced_at,source_id,raw_payload,source_version,update_flag,is_current_version,report_type)
        VALUES($1,$2,$3::date,'annual','consolidated',$4::date,$5,$6::jsonb,$7,'',true,'1') RETURNING report_id`,
      [company, kind, periodEnd, announcedAt, source, JSON.stringify({ ts_code: tsCode, currency: tsCode.endsWith('.HK') ? 'HKD' : 'CNY' }),
        `market-isolation-${tsCode === 'unknown-source' ? 'unknown' : (tsCode.endsWith('.HK') ? 'hk' : 'cn')}`])).rows[0];
      await client.query(`INSERT INTO fundamental.financial_facts
        (report_id,statement_type,metric_code,numeric_value,unit_code,currency_code,source_field,is_calculated)
        VALUES($1,$2,$3,$4,$5,$6,'market_isolation',false)`,
      [row.report_id, kind, metricCode, value, tsCode.endsWith('.HK') ? 'HKD' : 'CNY', tsCode.endsWith('.HK') ? 'HKD' : 'CNY']);
      return row.report_id;
    };
    await insertSelectionReport({ kind: 'balance', periodEnd: '2026-06-30', announcedAt: '2026-08-01', tsCode: code, metricCode: 'equity_parent', value: 111 });
    await insertSelectionReport({ kind: 'balance', periodEnd: '2026-06-30', announcedAt: '2026-08-02', tsCode: freeHkCode, metricCode: 'equity_parent', value: 222 });
    await insertSelectionReport({ kind: 'income', periodEnd: '2024-12-31', announcedAt: '2025-03-01', tsCode: code, metricCode: 'net_profit_parent', value: 11 });
    await insertSelectionReport({ kind: 'income', periodEnd: '2024-12-31', announcedAt: '2025-03-02', tsCode: freeHkCode, metricCode: 'net_profit_parent', value: 22 });
    const cnEquity = await selection.loadEquityFacts({ companyIds: [company], asOfDate: '2026-11-13', market: 'CN' }, client);
    const hkEquity = await selection.loadEquityFacts({ companyIds: [company], asOfDate: '2026-11-13', market: 'HK' }, client);
    assert.strictEqual(Number(cnEquity.get(String(company)).amount), 111, 'A 股权益不能取港股报告');
    assert.strictEqual(Number(hkEquity.get(String(company)).amount), 222, '港股权益不能取 A 股报告');
    const cnProfits = await selection.loadAnnualProfits({ companyIds: [company], asOfDate: '2026-11-13', market: 'CN' }, client);
    const hkProfits = await selection.loadAnnualProfits({ companyIds: [company], asOfDate: '2026-11-13', market: 'HK' }, client);
    assert.strictEqual(Number(cnProfits.get(String(company))[0].profit), 11, 'A 股年度利润不能取港股报告');
    assert.strictEqual(Number(hkProfits.get(String(company))[0].profit), 22, '港股年度利润不能取 A 股报告');
    await insertSelectionReport({ kind: 'balance', periodEnd: '2026-06-30', announcedAt: '2026-08-03', tsCode: 'unknown-source', metricCode: 'equity_parent', value: 333 });
    const guardedEquity = await selection.loadEquityFacts({ companyIds: [company], asOfDate: '2026-11-13', market: 'CN' }, client);
    assert.strictEqual(guardedEquity.get(String(company)).amount, null, '身份不明的最新报告不得回退为旧市场事实');
    assert.strictEqual(guardedEquity.get(String(company)).currencyUnverified, true);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  console.log('财报分类、银行字段分批和迁移回滚验证通过');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
