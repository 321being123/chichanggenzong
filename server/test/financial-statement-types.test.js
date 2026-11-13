'use strict';

const assert = require('assert');
const dict = require('../dataAccess/lixingerReportMetrics');
const official = require('../services/lixingerOfficial');
const { pool } = require('../db/connection');
const { migration194FinancialStatementTypeColumns } = require('../db/migrations/era11FinancialStatements');

async function main() {
  const calls = [];
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
      (q[match[1]] ||= {})[match[2]] = { t: match[2] === 'cabwcb' ? 254225000000 : 123 };
    }
    return { rows: [{ date: '2025-12-31', standardDate: '2025-12-31', reportDate: '2026-03-01',
      reportType: 'annual_report', stockCode: '000001', currency: 'CNY', q }] };
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
    const instrument = (await client.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,currency_code)
      VALUES($1,$2,'stock','CN','CNY') RETURNING instrument_id`, [code, name])).rows[0].instrument_id;
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
      }
      if (kind === 'income') assert.ok(payload.fields.some(field => field.code === 'ps.nii'));
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  console.log('财报分类、银行字段分批和迁移回滚验证通过');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
