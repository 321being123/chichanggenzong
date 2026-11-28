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
  const allowed = new Set(dict.metricsOfType('CN', 'bank').map(metric => metric.code));
  for (const { params } of requests) {
    assert.ok(params.metricsList.length <= 128);
    assert.ok(params.metricsList.every(code => {
      if (/^q\.m\./.test(code)) return true;
      const base = String(code).replace(/^q\./, '').replace(/\.(?:t(?:_o)?|t_(?:y2y|c2c)|c(?:_o)?|c_(?:y2y|c2c))$/, '');
      return allowed.has(base);
    }), '不得混发非本类型科目');
  }
  const requested = new Set(requests.flatMap(call => call.params.metricsList));
  assert.ok(requested.has('q.bs.cabwcb.t') && requested.has('q.bs.tlaatc.t') && requested.has('q.ps.nii.t'));
  assert.ok(!requested.has('q.bs.tfa.t'));
  assert.strictEqual(result.balance[0].__statement_metrics['bs.cabwcb'], 254225000000);
  assert.strictEqual(result.balance[0].__statement_coverage.fs_table_type, 'bank');
  assert.deepStrictEqual(result.balance[0].__statement_coverage.fs_table_type_evidence,
    { source_code: 'lixinger_official', raw_record_id: 321, scope: 'current_company_profile' });
  assert.strictEqual(result.balance[0].__statement_coverage.complete, true);
  // INC-0054 第一阶段：四类记录各只带本表的科目、比较值与请求清单。
  // 原来每份报告行都把三表科目和全量请求清单复制一遍，一份报告被撑成四份近 10 KiB 的副本。
  for (const [kind, prefix] of Object.entries({ balance: 'bs', income: 'ps', cashflow: 'cfs' })) {
    assert.ok((result[kind] || []).length, `${kind} 应至少有一行`);
    for (const row of result[kind]) {
      const carried = [
        ...Object.keys(row.__statement_metrics || {}),
        ...Object.values(row.__statement_comparisons || {}).flatMap(map => Object.keys(map || {})),
        ...((row.__statement_coverage && row.__statement_coverage.requested_metric_codes) || []),
      ];
      for (const code of carried) {
        const matched = /^(bs|ps|cfs)\./.exec(String(code));
        if (!matched) continue;
        assert.strictEqual(matched[1], prefix, `${kind} 行不得携带其他报表的科目 ${code}`);
      }
    }
  }
  assert.ok(result.balance[0].__statement_coverage.audit, '标准层行必须保留可复查的轻量审计指纹');
  assert.strictEqual(result.balance[0].__statement_coverage.audit.endpoint, 'cn/company/fs/bank',
    '审计指纹必须记录本次采集的端点');
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

  // F-09（INC-0054 第二阶段）：停止刷新 ingested_at 后，同日原报/更正报的先后不能靠入库时间。
  // 三处版本排序都必须把 update_flag='1' 排在 announced_at 之后、ingested_at 之前，
  // 否则原报因字段补全刷新 ingested_at 就会反超同日更正报。纯源码断言放在连库之前，
  // 数据库不可用时也能验证排序口径本身。
  const fsNodeOrder = require('fs');
  const pathNodeOrder = require('path');
  const projOrderSrc = fsNodeOrder.readFileSync(
    pathNodeOrder.join(__dirname, '..', 'repositories', 'stockProjectionRepository.js'), 'utf8').replace(/\s+/g, ' ');
  const stmtOrderSrc = fsNodeOrder.readFileSync(
    pathNodeOrder.join(__dirname, '..', 'repositories', 'stockStatementsRepository.js'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(projOrderSrc.includes(
    "announced_at DESC NULLS LAST, CASE WHEN COALESCE(NULLIF(update_flag,''),'0')='1' THEN 0 ELSE 1 END, ingested_at DESC"),
  'F-09: is_current_version 重算必须让同日 update_flag=1 优先于 ingested_at 新鲜度');
  assert.ok(stmtOrderSrc.includes(
    "market_version.announced_at DESC NULLS LAST, CASE WHEN COALESCE(NULLIF(market_version.update_flag,''),'0')='1' THEN 0 ELSE 1 END, market_version.ingested_at DESC"),
  'F-09: 三表选版必须让同日更正报优先于原报的 ingested_at');
  assert.ok(stmtOrderSrc.includes(
    "candidate.announced_at DESC NULLS LAST, CASE WHEN COALESCE(NULLIF(candidate.update_flag,''),'0')='1' THEN 0 ELSE 1 END, candidate.ingested_at DESC"),
  'F-09: 年度三表选版同样必须 update_flag=1 优先');

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
    const selectionService = require('../services/stockSelectionService');
    const applyPbFallback = async rows => {
      const cids = [...new Set(rows.map(r => r.company_id).filter(Boolean))];
      const eq = await selection.loadEquityFacts({ companyIds: cids, asOfDate: '2026-11-13', market: 'CN' }, client);
      return selectionService.applyEquityPbFallback(rows, eq);
    };
    let universe = (await applyPbFallback(await selection.loadUniverse({ market: 'CN', asOfDate: '2026-11-13' }, client))).find(row => row.code === code);
    assert.ok(universe);
    assert.strictEqual(universe.pb, null, '报表币种未知时不能与估值相除');
    await client.query(`UPDATE fundamental.financial_facts SET currency_code='CNY' WHERE report_id IN
      (SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1)
      AND metric_code IN ('equity_parent','net_profit_parent')`, [company]);
    universe = (await applyPbFallback(await selection.loadUniverse({ market: 'CN', asOfDate: '2026-11-13' }, client))).find(row => row.code === code);
    assert.ok(Number(universe.pb) > 0, '同币种的已知事实仍可计算');

    const freeHkCode = (await client.query(`SELECT lpad(n::text,5,'0')||'.HK' AS code FROM generate_series(80000,89999) n
      WHERE NOT EXISTS (SELECT 1 FROM core.instruments i WHERE i.canonical_code=lpad(n::text,5,'0')||'.HK') LIMIT 1`)).rows[0].code;
    const hkInstrument = (await client.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code)
      VALUES($1,$2,'stock','HK','HKEX','HKD') RETURNING instrument_id`, [freeHkCode, name])).rows[0].instrument_id;
    await client.query('INSERT INTO core.company_instruments(company_id,instrument_id) VALUES($1,$2)', [company, hkInstrument]);
    const safeFact = `WITH r AS (
        SELECT $1::bigint company_id,$2::smallint source_id,$3::jsonb raw_payload,
               false AS payload_meta_synced, NULL::text AS payload_ts_code, NULL::text AS payload_market,
               NULL::text AS payload_currency, NULL::text AS payload_value_basis
      ),
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

  // #86/#87/#88 合同与前端展示断言
  const stmtService = require('../services/stockStatementService');
  const nativeRows = [
    {
      report_id: 901, company_id: 1, period_end: '2025-06-30', period_type: 'semiannual',
      announced_at: '2025-08-20', currency_code: 'CNY', source_currency: 'CNY', accounting_standard: 'CAS',
      source_id: 30, source_code: 'lixinger_official', source_version: 'v2', statement_scope: 'consolidated',
      statement_coverage: { fs_table_type: 'non_financial', complete: true, requested_metric_codes: ['ps.toi', 'ps.npatshaoehopc'] },
      statement_comparisons: { yoy: { 'ps.toi': 0.1234 }, qoq: { 'ps.toi': 0.05 }, single: { 'ps.toi': 600000000 } },
      ps_toi: 1000000000, ps_npatshaoehopc: 200000000,
    },
    {
      report_id: 900, company_id: 1, period_end: '2025-03-31', period_type: 'q1',
      announced_at: '2025-04-20', currency_code: 'USD', source_currency: 'USD', accounting_standard: 'CAS',
      source_id: 30, source_code: 'lixinger_official', source_version: 'v1', statement_scope: 'consolidated',
      statement_coverage: { fs_table_type: 'non_financial', complete: true, requested_metric_codes: ['ps.toi'] },
      ps_toi: 300000000,
    },
  ];
  const payload = stmtService.buildStatementPayload({
    market: 'CN', type: 'income', rows: nativeRows, options: { periodType: 'all', compare: 'both' }, canonicalCode: '600519.SH',
  });
  const toiField = payload.fields.find(f => f.code === 'ps.toi');
  assert.strictEqual(toiField.values[0].yoy, 0.1234);
  assert.strictEqual(toiField.values[0].yoy_source, 'lixinger_native');
  assert.strictEqual(toiField.values[0].qoq, null);
  assert.strictEqual(toiField.values[0].qoq_reason, 'cumulative_flow_qoq_not_supported');
  assert.strictEqual(toiField.values[0].single_value, 6);
  // 跨币种时本地单季拆算应拒绝
  const localCrossRows = [
    { ...nativeRows[0], statement_comparisons: null },
    nativeRows[1],
  ];
  const crossPayload = stmtService.buildStatementPayload({
    market: 'CN', type: 'income', rows: localCrossRows, options: { periodType: 'all', compare: 'both' }, canonicalCode: '600519.SH',
  });
  assert.strictEqual(crossPayload.fields.find(f => f.code === 'ps.toi').values[0].single_reason, 'comparison_basis_uncomparable');
  // 比较值更新应改变 statementAnalysisVersionOf
  const vWithout = stmtService.statementAnalysisVersionOf({ canonicalCode: '600519.SH', market: 'CN', type: 'income', rows: localCrossRows });
  const vWith = stmtService.statementAnalysisVersionOf({ canonicalCode: '600519.SH', market: 'CN', type: 'income', rows: nativeRows });
  assert.notStrictEqual(vWithout, vWith, '比较值更新必须触发缓存版本摘要变化');

  // F-06: 累计流量原生 qoq 不得绕过累计流量守卫；不同列报版本/comp_type 不得拆算单季
  const nativeQoqRows = [
    { ...nativeRows[0], statement_comparisons: { yoy: { 'ps.toi': 0.12 }, qoq: { 'ps.toi': 0.08 } }, presentation_version: 'CAS_2019', comp_type: '1' },
    { ...nativeRows[1], currency_code: 'CNY', source_currency: 'CNY', presentation_version: 'CAS_2018', comp_type: '1' },
  ];
  const qoqGuardPayload = stmtService.buildStatementPayload({
    market: 'CN', type: 'income', rows: nativeQoqRows, options: { periodType: 'all', compare: 'qoq' }, canonicalCode: '600519.SH',
  });
  const guardedToi = qoqGuardPayload.fields.find(f => f.code === 'ps.toi').values[0];
  assert.strictEqual(guardedToi.qoq, null, 'F-06: 累计流量即使带原生 qoq 也不得绕过累计流量守卫');
  assert.strictEqual(guardedToi.qoq_reason, 'cumulative_flow_qoq_not_supported');
  assert.strictEqual(guardedToi.single_reason, 'comparison_basis_uncomparable', 'F-06: 列报版本不同不得拆算单季');

  const compTypeMismatchRows = [
    { ...nativeRows[0], statement_comparisons: null, presentation_version: 'CAS_2019', comp_type: '1' },
    { ...nativeRows[1], currency_code: 'CNY', source_currency: 'CNY', presentation_version: 'CAS_2019', comp_type: '2' },
  ];
  const compTypePayload = stmtService.buildStatementPayload({
    market: 'CN', type: 'income', rows: compTypeMismatchRows, options: { periodType: 'all', compare: 'yoy' }, canonicalCode: '600519.SH',
  });
  assert.strictEqual(compTypePayload.fields.find(f => f.code === 'ps.toi').values[0].single_reason, 'comparison_basis_uncomparable', 'F-06: comp_type 不同不得拆算单季');

  // F-09（INC-0054 第二阶段）：合并规则从 SQL 搬到 JS，断言改为验证行为而不是 SQL 文本。
  // ① 比较值完整采到时必须整体覆盖新值——「新窄值」必须能等于存储值，否则无变化跳过永远不收敛；
  // ② 同一输入重放得到同一结果（收敛）；
  // ③ 比较值批次部分失败时不得丢掉已采到的旧值，且合并时旧的三表全量宽值必须按本表前缀剪枝。
  const projRepoSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'repositories', 'stockProjectionRepository.js'), 'utf8');
  const { mergeReportPayload } = require('../repositories/stockProjectionRepository');
  assert.ok(!projRepoSrc.includes("raw_payload->'__statement_comparisons'->'yoy'"),
    'F-09: 比较值合并不许再写在 SQL 里（规则只能有一处，在 domain/statementMetricPrefix）');
  assert.ok(!projRepoSrc.includes('SELECT raw_payload->\'__statement_comparisons\''), 'F-09: 不得用非原子的 JS 先读后写合并，避免并发丢失更新或跨市场继承');
  const fullCoverage = { complete: true, comparison_requested: true, comparison_complete: true };
  const partialCoverage = { complete: true, comparison_requested: true, comparison_complete: false };
  const wideRow = {
    end_date: '2025-12-31', total_assets: 100, __statement_coverage: fullCoverage,
    __statement_comparisons: { yoy: { 'bs.ta': 0.1, 'ps.toi': 0.2, 'cfs.ncffoa': 0.3 } },
  };
  const narrowRow = {
    end_date: '2025-12-31', total_assets: 100, __statement_coverage: fullCoverage,
    __statement_comparisons: { yoy: { 'bs.ta': 0.1 } },
  };
  const converged = mergeReportPayload({ previous: wideRow, incoming: narrowRow, kind: 'balance' });
  assert.deepStrictEqual(converged.__statement_comparisons, { yoy: { 'bs.ta': 0.1 } },
    'F-09: 比较值完整采集时必须整体覆盖，否则新窄值永远不等于存储的宽值，无变化跳过不收敛');
  assert.deepStrictEqual(mergeReportPayload({ previous: converged, incoming: narrowRow, kind: 'balance' }), converged,
    'F-09: 同一输入重放必须得到同一结果（收敛）');
  // 完整采集时以新值为准：本次没返回的旧比较值键必须清掉，否则过期值会一直跟着走
  const droppedStale = mergeReportPayload({
    previous: { __statement_coverage: fullCoverage, __statement_comparisons: { yoy: { 'bs.ta': 0.1, 'bs.tl': 0.3 } } },
    incoming: narrowRow,
    kind: 'balance',
  });
  assert.deepStrictEqual(droppedStale.__statement_comparisons, { yoy: { 'bs.ta': 0.1 } },
    'F-09: 比较值完整采集时本次未返回的旧键必须清掉（否则过期比较值永远留在行里）');
  const partialMerged = mergeReportPayload({
    previous: converged,
    incoming: { ...narrowRow, __statement_coverage: partialCoverage, __statement_comparisons: { yoy: { 'bs.ta': 0.2 } } },
    kind: 'balance',
  });
  assert.deepStrictEqual(partialMerged.__statement_comparisons, { yoy: { 'bs.ta': 0.2 } },
    'F-09: 比较值批次部分失败时不得丢掉已采到的旧比较值');
  const trimmedOnMerge = mergeReportPayload({
    previous: wideRow,
    incoming: { ...wideRow, __statement_coverage: partialCoverage, __statement_comparisons: { yoy: { 'bs.ta': 0.15 } } },
    kind: 'balance',
  });
  assert.deepStrictEqual(Object.keys(trimmedOnMerge.__statement_comparisons.yoy), ['bs.ta'],
    'F-09: 合并时旧的三表全量宽值必须按本表前缀剪枝，否则存量行永远不收敛');
  // F-05（2026-11-26 事故后强化）：批次完成标志/批次完整性字段当然不能改变版本号，
  // 但更强的保证是版本号根本不看内容——版本键只由业务身份（公司+报表+报告期+来源+
  // 公告日+币种+口径）决定。原实现用整条 payload 的哈希，正是重复副本暴涨的根因。
  assert.ok(projRepoSrc.includes('function reportIdentityVersion') && projRepoSrc.includes('normalizeUpdateFlag(parts.updateFlag)'),
    'F-05: source_version 必须由业务身份决定');
  assert.ok(!/sourceVersion\s*=\s*rowVersion\(/.test(projRepoSrc),
    'F-05: 报告版本键不得再用整条 payload 哈希（重复采集会被判成新版本，2026-11-26 事故）');
  assert.ok(projRepoSrc.includes("data.__statement_coverage.complete === false") && projRepoSrc.includes('function stripNullKeys') && projRepoSrc.includes('...stripNullKeys(next)'), 'F-05: 标准批次为空的不完整批次必须合并回已有报告且不得用 null 覆盖已落库科目');
  assert.ok(projRepoSrc.includes('announced_at IS NOT DISTINCT FROM $6::date') && projRepoSrc.includes("COALESCE(statement_scope,'consolidated') = $9"), 'F-05: 不完整批次仅限同证券、同公告日、同币种、同列报范围报告合并');
  const stmtRepoSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'repositories', 'stockStatementsRepository.js'), 'utf8');
  assert.ok(stmtRepoSrc.includes("market_version.raw_payload->'__statement_coverage'->>'complete'"), 'F-05: 读取选版必须优先选择完整批次报告');
  const adapterSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'dataAccess', 'adapters', 'lixingerDatasetAdapter.js'), 'utf8');
  assert.ok(adapterSrc.includes('hasBatchMetrics') && adapterSrc.includes('if (batchHasData) prev.batches.add(batchIndex)'), 'F-05: 仅返回报告身份行而 q 无有效指标时不得计入已返回批次');

  const fsNode = require('fs');
  const pathNode = require('path');
  const stmtJs = fsNode.readFileSync(pathNode.join(__dirname, '..', '..', 'public', 'js', 'stock-analysis-statements.js'), 'utf8');
  const stmtCss = fsNode.readFileSync(pathNode.join(__dirname, '..', '..', 'public', 'css', 'stock-analysis.css'), 'utf8');
  assert.ok(stmtJs.includes('stockAnalysisKeepUnitTag') && stmtJs.includes('stockAnalysisFormatCellValue'), '#87 应实现去单位与百分比带 %');
  assert.ok(stmtCss.includes('#0f766e') && stmtCss.includes('#b43c2f'), '#88 应包含一级青绿与二级深砖红配色');
  assert.ok(stmtCss.includes('left:var(--stmt-col1-w)'), '#86 双固定列第 2 列必须使用 left: var(--stmt-col1-w) 独立偏移');

  // F-05 Round 7: 真实隔离库事务实测 syncReportRows（不完整批次合并 + 跨币种/公告日修订隔离）
  const projRepo = require('../repositories/stockProjectionRepository');
  const stmtRepo = require('../repositories/stockStatementsRepository');
  const isoClient = await pool.connect();
  try {
    await isoClient.query('BEGIN');
    const master = await projRepo.ensureMaster(isoClient, '600999.SH', await projRepo.sourceIds(isoClient), {
      ts_code: '600999.SH', name: '测试财报隔离', market: 'CN', list_date: '20100101',
    });
    const sources = await projRepo.sourceIds(isoClient);
    const lixingerId = sources.lixinger_official || sources.tushare;
    const baseRow = {
      ts_code: '600999.SH', end_date: '20251231', ann_date: '20260301', f_ann_date: '20260301',
      report_type: '1', comp_type: '1', currency: 'CNY', period_type: 'annual',
      total_assets: 200000000,
      __statement_coverage: { complete: true, requested_batch_count: 2, returned_batch_count: 2, returned_metric_codes: ['bs.ta', 'bs.cabb'] },
      __statement_metrics: { 'bs.ta': 200000000, 'bs.cabb': 50000000 },
      __statement_comparisons: { yoy: { 'bs.ta': 0.2 }, qoq: { 'bs.ta': 0.1 } },
    };
    await projRepo.syncReportRows(isoClient, [baseRow], 'balance', master.companyId, lixingerId, { tsCode: '600999.SH', currency: 'CNY' });
    const partialSame = {
      ...baseRow, total_assets: null,
      __statement_coverage: { complete: false, requested_batch_count: 2, returned_batch_count: 1, returned_metric_codes: ['bs.cabb'] },
      __statement_metrics: { 'bs.cabb': 55000000 },
      __statement_comparisons: {},
    };
    await projRepo.syncReportRows(isoClient, [partialSame], 'balance', master.companyId, lixingerId, { tsCode: '600999.SH', currency: 'CNY' });
    const missingTotalAssetsComplete = {
      ...baseRow, total_assets: null,
      __statement_coverage: { complete: true, requested_batch_count: 2, returned_batch_count: 2, returned_metric_codes: ['bs.cabb'] },
      __statement_metrics: { 'bs.cabb': 58000000 },
      __statement_comparisons: {},
    };
    await projRepo.syncReportRows(isoClient, [missingTotalAssetsComplete], 'balance', master.companyId, lixingerId, { tsCode: '600999.SH', currency: 'CNY' });
    const runId = await projRepo.createIngestionRun({ sourceId: lixingerId, datasetCode: 'stock_financial_balance' }, isoClient);
    const sameCountSwappedSet = {
      ...baseRow, total_assets: 300000000,
      __statement_coverage: { complete: true, requested_batch_count: 2, returned_batch_count: 2, returned_metric_codes: ['bs.ta', 'bs.ca'] },
      __statement_metrics: { 'bs.ta': 300000000, 'bs.ca': 12000000 },
      __statement_comparisons: {},
    };
    await projRepo.syncReportRows(isoClient, [sameCountSwappedSet], 'balance', master.companyId, lixingerId, { tsCode: '600999.SH', currency: 'CNY', runId });
    const rawRec = (await isoClient.query(`SELECT payload->'__statement_coverage'->'returned_metric_codes' AS codes FROM ops.raw_records WHERE run_id=$1`, [runId])).rows[0];
    assert.deepStrictEqual(rawRec.codes, ['bs.ta', 'bs.ca'], 'F-05: ops.raw_records 原始留证必须只记录本次上游实际返回的 2 项科目');
    const usdPartial = {
      ...baseRow, ann_date: '20260401', f_ann_date: '20260401', currency: 'USD', total_assets: null,
      __statement_coverage: { complete: false, requested_batch_count: 2, returned_batch_count: 1, returned_metric_codes: ['bs.cabb'] },
      __statement_metrics: { 'bs.cabb': 8000000 },
      __statement_comparisons: {},
    };
    await projRepo.syncReportRows(isoClient, [usdPartial], 'balance', master.companyId, lixingerId, { tsCode: '600999.SH', currency: 'USD' });
    const rows = await stmtRepo.listStatementRows({ tsCode: '600999.SH', market: 'CN', type: 'balance', tx: isoClient });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].currency_code, 'CNY', 'F-05: 不完整 USD 修订不得覆盖原 CNY 报告币种');
    assert.strictEqual(rows[0].announced_at, '2026-03-01', 'F-05: 不完整 USD 修订不得覆盖原报告公告日');
    assert.strictEqual(Number(rows[0].bs_ta), 300000000, 'F-05: 合法新总资产 3 亿应生效');
    assert.strictEqual(Number(rows[0].bs_cabb), 58000000, 'F-05: 同数不同集合遗漏旧科目时旧值 5800 万必须保留');
    assert.strictEqual(Number(rows[0].bs_ca), 12000000, 'F-05: 同数不同集合新增科目应写入');
    assert.strictEqual(rows[0].statement_coverage.returned_metric_codes.length, 3, 'F-05: 覆盖元数据科目清单应取并集保留全部 3 项');
    assert.strictEqual(rows[0].statement_comparisons.yoy['bs.ta'], 0.2, 'F-05: 原同比应保留');

    // INC-0054 第一阶段第 2 条：存量行带三表全量覆盖清单时，重采必须收敛到本表前缀。
    // 不裁剪 prevCodes 的话 droppedCoverageMetrics 对存量行恒为 true，跨表旧科目会被灌回
    // returned_metric_codes 并强制保留旧字段，覆盖清单永远不收敛、无变化跳过也永远不生效。
    const isoCtid = async (sql, params) => (await isoClient.query(sql, params)).rows[0].ctid;
    const wideCodesRow = {
      ts_code: '600999.SH', end_date: '20191231', ann_date: '20200301', f_ann_date: '20200301',
      report_type: '1', comp_type: '1', currency: 'CNY', period_type: 'annual', total_assets: 1000,
      __statement_coverage: {
        complete: true, requested_batch_count: 1, returned_batch_count: 1,
        returned_metric_codes: ['bs.ta', 'ps.toi', 'cfs.ncffoa'],
      },
      __statement_metrics: { 'bs.ta': 1000 },
    };
    await projRepo.syncReportRows(isoClient, [wideCodesRow], 'balance', master.companyId, lixingerId,
      { tsCode: '600999.SH', currency: 'CNY' });
    const wideCodesReport = (await isoClient.query(
      `SELECT report_id FROM fundamental.financial_reports
        WHERE company_id=$1 AND report_kind='balance' AND period_end='2019-12-31'`, [master.companyId])).rows[0].report_id;
    const narrowCodesRow = {
      ...wideCodesRow,
      __statement_coverage: { ...wideCodesRow.__statement_coverage, returned_metric_codes: ['bs.ta'] },
    };
    await projRepo.syncReportRows(isoClient, [narrowCodesRow], 'balance', master.companyId, lixingerId,
      { tsCode: '600999.SH', currency: 'CNY' });
    const narrowedCodes = (await isoClient.query(
      "SELECT raw_payload->'__statement_coverage'->'returned_metric_codes' AS codes FROM fundamental.financial_reports WHERE report_id=$1",
      [wideCodesReport])).rows[0].codes;
    assert.deepStrictEqual(narrowedCodes, ['bs.ta'], '存量宽覆盖清单重采后必须收敛到本表前缀');
    const narrowedCtid = await isoCtid(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [wideCodesReport]);
    await projRepo.syncReportRows(isoClient, [narrowCodesRow], 'balance', master.companyId, lixingerId,
      { tsCode: '600999.SH', currency: 'CNY' });
    assert.strictEqual(await isoCtid(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [wideCodesReport]),
    narrowedCtid, '覆盖清单收敛后第二轮重采必须跳过更新');

    // F-03 Round 11 & 12: 旧 3 段 source_key 分红记录原地升级、新旧并存去重、双旧键不撞唯一约束、不同付款日不误合并
    await isoClient.query(
      `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,ex_date,pay_date,status,total_cash_amount,currency_code,source_id,source_key)
       VALUES
       ($1,'dividend','2024-12-31','2024-03-28','2024-04-20','2024-05-01','实施',1000000,'CNY',$2,'600999.SH:2024-12-31:2024-03-28'),
       ($1,'dividend','2024-12-31','2024-03-28','2024-04-20','2024-05-01','实施',1000000,'CNY',$2,'600999.SH:20241231:20240328')`,
      [master.instrumentId, lixingerId],
    );
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2024-12-31', ann_date: '2024-03-28', ex_date: '2024-04-20', pay_date: '2024-05-01',
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    // 模拟新旧键并存后再重采
    await isoClient.query(
      `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,ex_date,pay_date,status,total_cash_amount,currency_code,source_id,source_key)
       VALUES($1,'dividend','2024-12-31','2024-03-28','2024-04-20','2024-05-01','实施',1000000,'CNY',$2,'600999.SH:2024-12-31:2024-03-28')`,
      [master.instrumentId, lixingerId],
    );
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2024-12-31', ann_date: '2024-03-28', ex_date: '2024-04-20', pay_date: '2024-05-01',
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    // 模拟同公告不同付款日、旧行缺 ex_date 时不得误合并
    await isoClient.query(
      `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,ex_date,pay_date,status,total_cash_amount,currency_code,source_id,source_key)
       VALUES($1,'dividend','2023-12-31','2024-03-28',NULL,'2024-05-08','实施',2000000,'CNY',$2,'600999.SH:2023-12-31:2024-03-28')`,
      [master.instrumentId, lixingerId],
    );
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2023-12-31', ann_date: '2024-03-28', ex_date: null, pay_date: '2024-05-01',
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    const divRows = (await isoClient.query(
      `SELECT source_key, total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' ORDER BY source_key`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(divRows.length, 3, 'F-03: 2024 同事件去重剩 1 条，2023 不同付款日两条均保留，共 3 条');
    assert.strictEqual(divRows.filter(r => r.source_key.startsWith('600999.SH:2024-12-31')).length, 1);
    assert.strictEqual(divRows.filter(r => r.source_key.startsWith('600999.SH:2023-12-31')).reduce((s, r) => s + Number(r.total_cash_amount), 0), 3000000);

    // F-03 Round 13 ①: 先按付款日建键，后补齐除净日时必须原地升级为除净日键，不产生两条
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2022-12-31', ann_date: '2023-03-28', ex_date: null, pay_date: '2023-05-01',
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2022-12-31', ann_date: '2023-03-28', ex_date: '2023-04-20', pay_date: '2023-05-01',
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    const payToExRows = (await isoClient.query(
      `SELECT source_key, total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2022-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(payToExRows.length, 1, 'F-03: 补齐除净日后只应保留 1 条记录');
    assert.strictEqual(payToExRows[0].source_key, '600999.SH:2022-12-31:2023-03-28:2023-04-20');

    // F-03 Round 14: 已有除净日后迟到仅含付款日/仅含登记日回包，以及登记日->付款日补齐均不产生重复行
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2022-12-31', ann_date: '2023-03-28', ex_date: '2023-04-20', pay_date: '2023-05-01', record_date: '2023-04-29',
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2022-12-31', ann_date: '2023-03-28', ex_date: null, pay_date: '2023-05-01', record_date: null,
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2022-12-31', ann_date: '2023-03-28', ex_date: null, pay_date: null, record_date: '2023-04-29',
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    const latePartialRows = (await isoClient.query(
      `SELECT source_key, to_char(ex_date,'YYYY-MM-DD') AS ex_date FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2022-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(latePartialRows.length, 1, 'F-03: 迟到部分日期回包不得产生第二条记录');
    assert.strictEqual(latePartialRows[0].source_key, '600999.SH:2022-12-31:2023-03-28:2023-04-20');
    assert.strictEqual(latePartialRows[0].ex_date, '2023-04-20', 'F-03: 已确认的除净日不得被迟到回包清空');

    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2021-12-31', ann_date: '2022-03-28', ex_date: null, pay_date: null, record_date: '2022-04-29',
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2021-12-31', ann_date: '2022-03-28', ex_date: null, pay_date: '2022-05-01', record_date: '2022-04-29',
      div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY',
    }]);
    const regToPayRows = (await isoClient.query(
      `SELECT source_key FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2021-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(regToPayRows.length, 1, 'F-03: 登记日补齐付款日只应保留 1 条记录');
    assert.strictEqual(regToPayRows[0].source_key, '600999.SH:2021-12-31:2022-03-28:2022-05-01:2022-04-29');

    // F-03 Round 15:
    // 1) 迟到回包缺总额和每股金额时不得清空已确认金额与 raw_payload.ex_date
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [{
      ts_code: '600999.SH', end_date: '2022-12-31', ann_date: '2023-03-28', ex_date: null, pay_date: '2023-05-01',
      div_proc: '实施', cash_div_tax: null, total_cash_amount: null, currency: 'CNY',
    }]);
    const preservedAmtRow = (await isoClient.query(
      `SELECT total_cash_amount, raw_payload->>'ex_date' AS raw_ex FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2022-12-31'`,
      [master.instrumentId],
    )).rows[0];
    assert.strictEqual(Number(preservedAmtRow.total_cash_amount), 1000000, 'F-03: 迟到回包缺金额时不得清空已确认的 100 万');
    assert.strictEqual(preservedAmtRow.raw_ex, '2023-04-20', 'F-03: raw_payload.ex_date 不得被迟到回包清空');

    // 2) 同公告同付款日、不同除净日的两笔分红，迟到缺除净日回包不得把 100 万覆盖成 200 万
    // 3) 仅有除净日事件重采不得删除同公告下已有付款日的旧键分红
    await isoClient.query(
      `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,ex_date,pay_date,status,total_cash_amount,currency_code,source_id,source_key)
       VALUES($1,'dividend','2019-12-31','2020-03-28',NULL,'2020-05-08','实施',2000000,'CNY',$2,'600999.SH:2019-12-31:2020-03-28')`,
      [master.instrumentId, lixingerId],
    );
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2019-12-31', ann_date: '2020-03-28', ex_date: '2020-04-20', pay_date: null, div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2019-12-31', ann_date: '2020-03-28', ex_date: '2020-04-20', pay_date: null, div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const r15KeepOldRows = (await isoClient.query(
      `SELECT total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2019-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r15KeepOldRows.length, 2, 'F-03: 仅有除净日重复写入不得删除同公告已有付款日的旧记录');
    assert.strictEqual(r15KeepOldRows.reduce((s, r) => s + Number(r.total_cash_amount), 0), 3000000);

    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2018-12-31', ann_date: '2019-03-28', ex_date: '2019-04-20', pay_date: '2019-05-01', div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2018-12-31', ann_date: '2019-03-28', ex_date: '2019-04-25', pay_date: '2019-05-01', div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2018-12-31', ann_date: '2019-03-28', ex_date: null, pay_date: '2019-05-01', div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' },
    ]);
    const r15MultiRows = (await isoClient.query(
      `SELECT total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2018-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r15MultiRows.length, 2);
    assert.strictEqual(r15MultiRows.reduce((s, r) => s + Number(r.total_cash_amount), 0), 3000000, 'F-03: 多候选迟到回包不得把 100 万覆盖成 200 万');

    // F-03 Round 16: 均缺除净日、同付款日、不同登记日的两笔分红必须均保留，逆序与补全除净日亦然
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2017-12-31', ann_date: '2018-03-28', ex_date: null, pay_date: '2018-05-01', record_date: '2018-04-18', div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2017-12-31', ann_date: '2018-03-28', ex_date: null, pay_date: '2018-05-01', record_date: '2018-04-25', div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2017-12-31', ann_date: '2018-03-28', ex_date: null, pay_date: '2018-05-01', record_date: '2018-04-25', div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2017-12-31', ann_date: '2018-03-28', ex_date: null, pay_date: '2018-05-01', record_date: '2018-04-18', div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2017-12-31', ann_date: '2018-03-28', ex_date: '2018-04-17', pay_date: '2018-05-01', record_date: '2018-04-18', div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2017-12-31', ann_date: '2018-03-28', ex_date: '2018-04-24', pay_date: '2018-05-01', record_date: '2018-04-25', div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' },
    ]);
    const r16Rows = (await isoClient.query(
      `SELECT total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2017-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r16Rows.length, 2, 'F-03: 同付款日不同登记日两笔分红在逆序、重试及补齐除净日后均应保留两条');
    assert.strictEqual(r16Rows.reduce((s, r) => s + Number(r.total_cash_amount), 0), 3000000);

    // F-03 Round 17 ①: 先只含付款日，后保留付款日并补登记日（仍无除净日）只留 1 条
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2016-12-31', ann_date: '2017-03-28', ex_date: null, pay_date: '2017-05-01', record_date: null, div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2016-12-31', ann_date: '2017-03-28', ex_date: null, pay_date: '2017-05-01', record_date: '2017-04-29', div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const r17PayToReg = (await isoClient.query(
      `SELECT source_key, total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2016-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r17PayToReg.length, 1, 'F-03: 付款日补齐登记日只应保留 1 条记录');
    assert.strictEqual(r17PayToReg[0].source_key, '600999.SH:2016-12-31:2017-03-28:2017-05-01:2017-04-29');

    // F-03 Round 17 ②: 已有同付款日不同登记日的两笔分红，后补齐各自除净日但回包省略登记日时仍只留 2 条且合计 300 万
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2015-12-31', ann_date: '2016-03-28', ex_date: null, pay_date: '2016-05-01', record_date: '2016-04-18', div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2015-12-31', ann_date: '2016-03-28', ex_date: null, pay_date: '2016-05-01', record_date: '2016-04-25', div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2015-12-31', ann_date: '2016-03-28', ex_date: '2016-04-17', pay_date: '2016-05-01', record_date: null, div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2015-12-31', ann_date: '2016-03-28', ex_date: '2016-04-24', pay_date: '2016-05-01', record_date: null, div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' },
    ]);
    const r17OmitRec = (await isoClient.query(
      `SELECT total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2015-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r17OmitRec.length, 2, 'F-03: 补齐除净日省略登记日时仍应只留 2 条');
    assert.strictEqual(r17OmitRec.reduce((s, r) => s + Number(r.total_cash_amount), 0), 3000000);

    // F-03 Round 18: 库中已有 A(有登记日缺除净日)，同批包含 [A, B(有除净日缺登记日)] 或逆序 [B, A] 时均须保留两笔合计 300 万
    const rowA14 = { ts_code: '600999.SH', end_date: '2014-12-31', ann_date: '2015-03-28', ex_date: null, pay_date: '2015-05-01', record_date: '2015-04-18', div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' };
    const rowB14 = { ts_code: '600999.SH', end_date: '2014-12-31', ann_date: '2015-03-28', ex_date: '2015-04-24', pay_date: '2015-05-01', record_date: null, div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowA14]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowA14, rowB14]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowA14, rowB14]);
    const r18Fwd = (await isoClient.query(
      `SELECT total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2014-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r18Fwd.length, 2, 'F-03: 同批正序 [A, B] 不得合并成一笔');
    assert.strictEqual(r18Fwd.reduce((s, r) => s + Number(r.total_cash_amount), 0), 3000000);

    const rowA13 = { ...rowA14, end_date: '2013-12-31', ann_date: '2014-03-28', pay_date: '2014-05-01', record_date: '2014-04-18' };
    const rowB13 = { ...rowB14, end_date: '2013-12-31', ann_date: '2014-03-28', ex_date: '2014-04-24', pay_date: '2014-05-01' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowA13]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB13, rowA13]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB13, rowA13]);
    const r18Rev = (await isoClient.query(
      `SELECT total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2013-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r18Rev.length, 2, 'F-03: 同批逆序 [B, A] 不得合并成一笔');
    assert.strictEqual(r18Rev.reduce((s, r) => s + Number(r.total_cash_amount), 0), 3000000);

    // F-03 Round 19 ①: 库中 A 为旧 3 段键，逆序 [B, A] + 重放时 B 不得继承 A 的登记日
    await isoClient.query(
      `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,ex_date,pay_date,record_date,status,total_cash_amount,currency_code,source_id,source_key)
       VALUES($1,'dividend','2012-12-31','2013-03-28',NULL,'2013-05-01','2013-04-18','实施',1000000,'CNY',$2,'600999.SH:2012-12-31:2013-03-28')`,
      [master.instrumentId, lixingerId],
    );
    const rowA12 = { ts_code: '600999.SH', end_date: '2012-12-31', ann_date: '2013-03-28', ex_date: null, pay_date: '2013-05-01', record_date: '2013-04-18', div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' };
    const rowB12 = { ts_code: '600999.SH', end_date: '2012-12-31', ann_date: '2013-03-28', ex_date: '2013-04-24', pay_date: '2013-05-01', record_date: null, div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB12, rowA12]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB12, rowA12]);
    const r19Rows1 = (await isoClient.query(
      `SELECT total_cash_amount, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2012-12-31' ORDER BY total_cash_amount`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r19Rows1.length, 2);
    assert.strictEqual(r19Rows1[0].rec, '2013-04-18', 'F-03: 100万 A 保留原登记日');
    assert.strictEqual(r19Rows1[1].rec, null, 'F-03: 200万 B 不得继承 A 的登记日');

    // F-03 Round 19 ②: 库中 A 为付款日键且含每股 0.75，逆序 [B, A(补登记日且缺每股)] 时 0.75 不得转给 B
    await isoClient.query(
      `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,ex_date,pay_date,record_date,status,cash_per_share_pre_tax,total_cash_amount,currency_code,source_id,source_key)
       VALUES($1,'dividend','2011-12-31','2012-03-28',NULL,'2012-05-01',NULL,'实施',0.75,1000000,'CNY',$2,'600999.SH:2011-12-31:2012-03-28:2012-05-01')`,
      [master.instrumentId, lixingerId],
    );
    const rowA11 = { ts_code: '600999.SH', end_date: '2011-12-31', ann_date: '2012-03-28', ex_date: null, pay_date: '2012-05-01', record_date: '2012-04-18', div_proc: '实施', cash_div_tax: null, total_cash_amount: 1000000, currency: 'CNY' };
    const rowB11 = { ts_code: '600999.SH', end_date: '2011-12-31', ann_date: '2012-03-28', ex_date: '2012-04-24', pay_date: '2012-05-01', record_date: null, div_proc: '实施', cash_div_tax: null, total_cash_amount: 2000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB11, rowA11]);
    const r19Rows2 = (await isoClient.query(
      `SELECT total_cash_amount, cash_per_share_pre_tax FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2011-12-31' ORDER BY total_cash_amount`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r19Rows2.length, 2);
    assert.strictEqual(Number(r19Rows2[0].cash_per_share_pre_tax), 0.75, 'F-03: A 已确认的每股 0.75 必须保留在 A');
    assert.strictEqual(r19Rows2[1].cash_per_share_pre_tax, null, 'F-03: B 不得抢占 A 的每股 0.75');

    // F-03 Round 20: 库中已有 A(100万, 有登记日缺除净日)，同批 [B(200万, 补除净日省略登记日), A(100万, 补除净日省略登记日)] 逆序及重放不得串写登记日
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2010-12-31', ann_date: '2011-03-28', ex_date: null, pay_date: '2011-05-01', record_date: '2011-04-18', div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const rowB10 = { ts_code: '600999.SH', end_date: '2010-12-31', ann_date: '2011-03-28', ex_date: '2011-04-26', pay_date: '2011-05-01', record_date: null, div_proc: '实施', total_cash_amount: 2000000, currency: 'CNY' };
    const rowA10 = { ts_code: '600999.SH', end_date: '2010-12-31', ann_date: '2011-03-28', ex_date: '2011-04-20', pay_date: '2011-05-01', record_date: null, div_proc: '实施', total_cash_amount: 1000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB10, rowA10]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB10, rowA10]);
    const r20Rows = (await isoClient.query(
      `SELECT total_cash_amount, to_char(ex_date,'YYYY-MM-DD') AS ex, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2010-12-31' ORDER BY total_cash_amount`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r20Rows.length, 2);
    assert.strictEqual(r20Rows[0].ex, '2011-04-20');
    assert.strictEqual(r20Rows[0].rec, '2011-04-18', 'F-03: 100万 A 必须保留原登记日 2011-04-18');
    assert.strictEqual(r20Rows[1].ex, '2011-04-26');
    assert.strictEqual(r20Rows[1].rec, null, 'F-03: 200万 B 不得抢占 A 的登记日');

    // F-03 Round 21: 同付款日、同总额 100 万但每股金额不同(0.75 vs 2)，逆序 [B(2), A(0.75)] 补除净日省略登记日时不得串写登记日
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2009-12-31', ann_date: '2010-03-28', ex_date: null, pay_date: '2010-05-01', record_date: '2010-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const rowB09 = { ts_code: '600999.SH', end_date: '2009-12-31', ann_date: '2010-03-28', ex_date: '2010-04-26', pay_date: '2010-05-01', record_date: null, div_proc: '实施', cash_div_tax: 2, total_cash_amount: 1000000, currency: 'CNY' };
    const rowA09 = { ts_code: '600999.SH', end_date: '2009-12-31', ann_date: '2010-03-28', ex_date: '2010-04-20', pay_date: '2010-05-01', record_date: null, div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB09, rowA09]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB09, rowA09]);
    const r21Rows = (await isoClient.query(
      `SELECT cash_per_share_pre_tax, to_char(ex_date,'YYYY-MM-DD') AS ex, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2009-12-31' ORDER BY cash_per_share_pre_tax`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r21Rows.length, 2);
    assert.strictEqual(Number(r21Rows[0].cash_per_share_pre_tax), 0.75);
    assert.strictEqual(r21Rows[0].rec, '2010-04-18', 'F-03: 0.75 港元 A 必须保留原登记日 2010-04-18');
    assert.strictEqual(Number(r21Rows[1].cash_per_share_pre_tax), 2);
    assert.strictEqual(r21Rows[1].rec, null, 'F-03: 2 港元 B 不得抢占 A 的登记日');

    // F-03 Round 22 ①: 同付款日、同总额 100 万，A 带每股 0.75 而 B 缺每股金额，逆序 [B, A] + 重放只留 2 条且登记日留给 0.75
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2008-12-31', ann_date: '2009-03-28', ex_date: null, pay_date: '2009-05-01', record_date: '2009-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const rowB08 = { ts_code: '600999.SH', end_date: '2008-12-31', ann_date: '2009-03-28', ex_date: '2009-04-26', pay_date: '2009-05-01', record_date: null, div_proc: '实施', cash_div_tax: null, total_cash_amount: 1000000, currency: 'CNY' };
    const rowA08 = { ts_code: '600999.SH', end_date: '2008-12-31', ann_date: '2009-03-28', ex_date: '2009-04-20', pay_date: '2009-05-01', record_date: null, div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB08, rowA08]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB08, rowA08]);
    const r22Rows = (await isoClient.query(
      `SELECT cash_per_share_pre_tax, total_cash_amount, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2008-12-31' ORDER BY ex_date`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r22Rows.length, 2, 'F-03: 另一笔缺每股金额时仍只应保留 2 条记录');
    assert.strictEqual(r22Rows.reduce((s, r) => s + Number(r.total_cash_amount), 0), 2000000);
    assert.strictEqual(r22Rows[0].rec, '2009-04-18', 'F-03: 原登记日必须归属于每股 0.75 的 A');
    assert.strictEqual(r22Rows[1].rec, null, 'F-03: 缺每股金额的 B 不得抢占登记日');

    // F-03 Round 22 ②: 两笔均缺每股金额（无法确认归属）时仍只计 2 条 200 万，不保留第 3 条旧行也不串写登记日
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2007-12-31', ann_date: '2008-03-28', ex_date: null, pay_date: '2008-05-01', record_date: '2008-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2007-12-31', ann_date: '2008-03-28', ex_date: '2008-04-26', pay_date: '2008-05-01', record_date: null, div_proc: '实施', cash_div_tax: null, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2007-12-31', ann_date: '2008-03-28', ex_date: '2008-04-20', pay_date: '2008-05-01', record_date: null, div_proc: '实施', cash_div_tax: null, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const r22Tied = (await isoClient.query(
      `SELECT total_cash_amount, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2007-12-31' ORDER BY ex_date`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r22Tied.length, 2, 'F-03: 无法确认归属时汇总仍只计 2 笔');
    assert.strictEqual(r22Tied.reduce((s, r) => s + Number(r.total_cash_amount), 0), 2000000);
    assert.strictEqual(r22Tied[0].rec, '2008-04-18', 'F-03: 已有 1 条旧行登记日应保留，不得删除');

    // F-03 Round 23 ①: 两笔均 100 万且每股均 0.75，库有 1 条旧行(4/18)，逆序 [B, A] + 重放只留 2 条且保留 4/18
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2006-12-31', ann_date: '2007-03-28', ex_date: null, pay_date: '2007-05-01', record_date: '2007-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const rowB06 = { ts_code: '600999.SH', end_date: '2006-12-31', ann_date: '2007-03-28', ex_date: '2007-04-26', pay_date: '2007-05-01', record_date: null, div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' };
    const rowA06 = { ts_code: '600999.SH', end_date: '2006-12-31', ann_date: '2007-03-28', ex_date: '2007-04-20', pay_date: '2007-05-01', record_date: null, div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB06, rowA06]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB06, rowA06]);
    const r23OneOld = (await isoClient.query(
      `SELECT total_cash_amount, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2006-12-31' ORDER BY ex_date`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r23OneOld.length, 2);
    assert.strictEqual(r23OneOld[0].rec, '2007-04-18', 'F-03: 库中 1 条旧记录登记日必须保留');

    // F-03 Round 23 ②: 两笔均 100 万且每股均 0.75，库有 2 条旧行(4/18, 4/25)，逆序 [B, A] + 重放只留 2 条 200 万且保留两条登记日
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2005-12-31', ann_date: '2006-03-28', ex_date: null, pay_date: '2006-05-01', record_date: '2006-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2005-12-31', ann_date: '2006-03-28', ex_date: null, pay_date: '2006-05-01', record_date: '2006-04-25', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const rowB05 = { ts_code: '600999.SH', end_date: '2005-12-31', ann_date: '2006-03-28', ex_date: '2006-04-26', pay_date: '2006-05-01', record_date: null, div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' };
    const rowA05 = { ts_code: '600999.SH', end_date: '2005-12-31', ann_date: '2006-03-28', ex_date: '2006-04-20', pay_date: '2006-05-01', record_date: null, div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB05, rowA05]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB05, rowA05]);
    const r23TwoOld = (await isoClient.query(
      `SELECT total_cash_amount, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2005-12-31' ORDER BY ex_date`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r23TwoOld.length, 2, 'F-03: 两条旧记录匹配并列时只应留 2 条，不得变成 4 条');
    assert.strictEqual(r23TwoOld.reduce((s, r) => s + Number(r.total_cash_amount), 0), 2000000);
    assert.deepStrictEqual(r23TwoOld.map(r => r.rec), ['2006-04-18', '2006-04-25']);

    // F-03 Round 24: 两条旧行完整度不同(一条 cps=0.75、另一条 cps=null)，逆序 [B(2), A(0.75)] + 重放及规范键已存在均只留 2 条 200 万
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2004-12-31', ann_date: '2005-03-28', ex_date: null, pay_date: '2005-05-01', record_date: '2005-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2004-12-31', ann_date: '2005-03-28', ex_date: null, pay_date: '2005-05-01', record_date: '2005-04-25', div_proc: '实施', cash_div_tax: null, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const rowB04 = { ts_code: '600999.SH', end_date: '2004-12-31', ann_date: '2005-03-28', ex_date: '2005-04-26', pay_date: '2005-05-01', record_date: null, div_proc: '实施', cash_div_tax: 2, total_cash_amount: 1000000, currency: 'CNY' };
    const rowA04 = { ts_code: '600999.SH', end_date: '2004-12-31', ann_date: '2005-03-28', ex_date: '2005-04-20', pay_date: '2005-05-01', record_date: null, div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB04, rowA04]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB04, rowA04]);
    const r24Rows = (await isoClient.query(
      `SELECT total_cash_amount, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2004-12-31' ORDER BY ex_date`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r24Rows.length, 2, 'F-03: 旧候选完整度不同时逆序与重放只应留 2 条');
    assert.strictEqual(r24Rows.reduce((s, r) => s + Number(r.total_cash_amount), 0), 2000000);
    assert.deepStrictEqual(r24Rows.map(r => r.rec), ['2005-04-18', '2005-04-25']);

    // F-03 Round 25 ①: 重采已存在的除净日键(200万/cps=2/4-25)时，不得误删同付款日另一笔 ex_date IS NULL 旧行(100万/cps=0.75/4-18)
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2003-12-31', ann_date: '2004-03-28', ex_date: null, pay_date: '2004-05-01', record_date: '2004-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2003-12-31', ann_date: '2004-03-28', ex_date: '2004-04-26', pay_date: '2004-05-01', record_date: '2004-04-25', div_proc: '实施', cash_div_tax: 2, total_cash_amount: 2000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2003-12-31', ann_date: '2004-03-28', ex_date: '2004-04-26', pay_date: '2004-05-01', record_date: null, div_proc: '实施', cash_div_tax: 2, total_cash_amount: 2000000, currency: 'CNY' },
    ]);
    const r25KeepOther = (await isoClient.query(
      `SELECT total_cash_amount FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2003-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r25KeepOther.length, 2, 'F-03: 重采已存在除净日键不得误删同付款日另一笔独立分红');
    assert.strictEqual(r25KeepOther.reduce((s, r) => s + Number(r.total_cash_amount), 0), 3000000);

    // F-03 Round 25 ②: 同一事件新旧键并存归并后，raw_payload 也必须保留旧行的登记日与每股金额
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2002-12-31', ann_date: '2003-03-28', ex_date: null, pay_date: '2003-05-01', record_date: '2003-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2002-12-31', ann_date: '2003-03-28', ex_date: '2003-04-20', pay_date: '2003-05-01', record_date: null, div_proc: '实施', cash_div_tax: null, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2002-12-31', ann_date: '2003-03-28', ex_date: '2003-04-20', pay_date: '2003-05-01', record_date: null, div_proc: '实施', cash_div_tax: null, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const r25Merged = (await isoClient.query(
      `SELECT to_char(record_date,'YYYY-MM-DD') AS rec, cash_per_share_pre_tax, raw_payload->>'record_date' AS raw_rec, (raw_payload->>'cash_div_tax')::numeric AS raw_cps
         FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2002-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r25Merged.length, 1);
    assert.strictEqual(r25Merged[0].rec, '2003-04-18');
    assert.strictEqual(Number(r25Merged[0].cash_per_share_pre_tax), 0.75);
    assert.strictEqual(r25Merged[0].raw_rec, '2003-04-18', 'F-03: 归并后 raw_payload.record_date 必须保留');
    assert.strictEqual(Number(r25Merged[0].raw_cps), 0.75, 'F-03: 归并后 raw_payload.cash_div_tax 必须保留');

    // F-03 Round 26 ①: 等额同每股但登记日不同(4-18 vs 4-25)，重采后者(缺登记日)不得误删前者
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2001-12-31', ann_date: '2002-03-28', ex_date: null, pay_date: '2002-05-01', record_date: '2002-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2001-12-31', ann_date: '2002-03-28', ex_date: '2002-04-26', pay_date: '2002-05-01', record_date: '2002-04-25', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2001-12-31', ann_date: '2002-03-28', ex_date: '2002-04-26', pay_date: '2002-05-01', record_date: null, div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const r26KeepDiffRec = (await isoClient.query(
      `SELECT total_cash_amount, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2001-12-31' ORDER BY rec`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r26KeepDiffRec.length, 2, 'F-03: 登记日不同的等额分红不得被误删');
    assert.strictEqual(r26KeepDiffRec.reduce((s, r) => s + Number(r.total_cash_amount), 0), 2000000);

    // F-03 Round 26 ②: 同事件新旧键并存(均为 100 万/4-18/0.75)，修订总额至 150 万(省略登记日)后只留 150 万一条
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2000-12-31', ann_date: '2001-03-28', ex_date: null, pay_date: '2001-05-01', record_date: '2001-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '2000-12-31', ann_date: '2001-03-28', ex_date: '2001-04-20', pay_date: '2001-05-01', record_date: '2001-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '2000-12-31', ann_date: '2001-03-28', ex_date: '2001-04-20', pay_date: '2001-05-01', record_date: null, div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1500000, currency: 'CNY' },
    ]);
    const r26Revised = (await isoClient.query(
      `SELECT total_cash_amount, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='2000-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r26Revised.length, 1, 'F-03: 金额修订后旧行必须归并，不得合计 250 万');
    assert.strictEqual(Number(r26Revised[0].total_cash_amount), 1500000);
    assert.strictEqual(r26Revised[0].rec, '2001-04-18');

    // F-03 Round 27: 同事件新旧键并存(均为 100 万/4-18/0.75)，同时修订总额至 150 万与每股至 1.125(省略登记日)并重放，只留 150 万一条
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '1999-12-31', ann_date: '2000-03-28', ex_date: null, pay_date: '2000-05-01', record_date: '2000-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '1999-12-31', ann_date: '2000-03-28', ex_date: '2000-04-20', pay_date: '2000-05-01', record_date: '2000-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '1999-12-31', ann_date: '2000-03-28', ex_date: '2000-04-20', pay_date: '2000-05-01', record_date: null, div_proc: '实施', cash_div_tax: 1.125, total_cash_amount: 1500000, currency: 'CNY' },
    ]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '1999-12-31', ann_date: '2000-03-28', ex_date: '2000-04-20', pay_date: '2000-05-01', record_date: null, div_proc: '实施', cash_div_tax: 1.125, total_cash_amount: 1500000, currency: 'CNY' },
    ]);
    const r27Revised = (await isoClient.query(
      `SELECT total_cash_amount, cash_per_share_pre_tax, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='1999-12-31'`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r27Revised.length, 1, 'F-03: 同时修订总额与每股金额后旧行必须归并，不得合计 250 万');
    assert.strictEqual(Number(r27Revised[0].total_cash_amount), 1500000);
    assert.strictEqual(Number(r27Revised[0].cash_per_share_pre_tax), 1.125);
    assert.strictEqual(r27Revised[0].rec, '2000-04-18');

    // F-03 Round 28: 同批日期互补(A 只带登记日且库有付款日+每股0.75；B 已按除净日入库但缺金额且本批补齐200万/cps=2)，正逆序与重放均不串写
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '1998-12-31', ann_date: '1999-03-28', ex_date: null, pay_date: '1999-05-01', record_date: '1999-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '1998-12-31', ann_date: '1999-03-28', ex_date: '1999-04-26', pay_date: '1999-05-01', record_date: null, div_proc: '实施', cash_div_tax: null, total_cash_amount: null, currency: 'CNY' },
    ]);
    const rowA98 = { ts_code: '600999.SH', end_date: '1998-12-31', ann_date: '1999-03-28', ex_date: null, pay_date: null, record_date: '1999-04-18', div_proc: '实施', cash_div_tax: null, total_cash_amount: 1000000, currency: 'CNY' };
    const rowB98 = { ts_code: '600999.SH', end_date: '1998-12-31', ann_date: '1999-03-28', ex_date: '1999-04-26', pay_date: '1999-05-01', record_date: null, div_proc: '实施', cash_div_tax: 2, total_cash_amount: 2000000, currency: 'CNY' };
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB98, rowA98]);
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [rowB98, rowA98]);
    const r28Rows = (await isoClient.query(
      `SELECT total_cash_amount, cash_per_share_pre_tax, to_char(record_date,'YYYY-MM-DD') AS rec FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend' AND fiscal_period_end='1998-12-31' ORDER BY total_cash_amount`,
      [master.instrumentId],
    )).rows;
    assert.strictEqual(r28Rows.length, 2);
    assert.strictEqual(Number(r28Rows[0].total_cash_amount), 1000000);
    assert.strictEqual(Number(r28Rows[0].cash_per_share_pre_tax), 0.75, 'F-03: 重放后 A 的每股 0.75 必须保留');
    assert.strictEqual(r28Rows[0].rec, '1999-04-18');
    assert.strictEqual(Number(r28Rows[1].total_cash_amount), 2000000);
    assert.strictEqual(r28Rows[1].rec, null, 'F-03: B 不得继承 A 的登记日');

    // F-03 Round 29: upsertCorporateAction 在 skipWrite=true 时必须返回 null，不得保护未写入的候选键
    await projRepo.syncOfficialDividends(isoClient, master.instrumentId, lixingerId, [
      { ts_code: '600999.SH', end_date: '1997-12-31', ann_date: '1998-03-28', ex_date: null, pay_date: '1998-05-01', record_date: '1998-04-18', div_proc: '实施', cash_div_tax: 2, total_cash_amount: 1000000, currency: 'CNY' },
      { ts_code: '600999.SH', end_date: '1997-12-31', ann_date: '1998-03-28', ex_date: null, pay_date: '1998-05-07', record_date: '1998-04-18', div_proc: '实施', cash_div_tax: 0.75, total_cash_amount: 1000000, currency: 'CNY' },
    ]);
    const retNull = await projRepo.upsertCorporateAction({
      instrumentId: master.instrumentId, fiscalPeriodEnd: '1997-12-31', announcedAt: '1998-03-28',
      recordDate: '1998-04-18', exDate: null, payDate: null, status: '实施',
      cashPerSharePreTax: null, totalCashAmount: 1000000, currencyCode: 'CNY', sourceId: lixingerId,
      sourceKey: '600999.SH:1997-12-31:1998-03-28:1998-04-18',
      legacySourceKeys: ['600999.SH:1997-12-31:1998-03-28'],
      protectedSourceKeys: [], batchPeers: [],
    }, isoClient);
    assert.strictEqual(retNull, null, 'F-03: 跳过写入时 upsertCorporateAction 必须返回 null，避免污染批次保护名单');
    assert.ok(projRepoSrc.includes('FOR UPDATE') && projRepoSrc.includes('FROM locked'), 'F-03: 旧分红键升级必须单条原子加锁，防止并发覆盖');
    await isoClient.query('ROLLBACK');
  } finally {
    isoClient.release();
  }
  console.log('财报分类、银行字段分批和迁移回滚验证通过');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
