const assert = require('assert');
const { pool } = require('../db/connection');
const { loadBondSafetyFacts } = require('../repositories/bondSafetyTushareRepository');
const { fetchBondSafetySourceFromDatabase } = require('../services/bondSafetyTushare');

const TRADE_DATE = '2099-12-15';
const PERIOD_END = '2098-12-31';

async function takeCodes(client, count) {
  const start = 600000 + Math.floor(Math.random() * 90000);
  const { rows } = await client.query(`SELECT n::text||'.SH' AS code FROM generate_series($1::int,$2::int) n
    WHERE NOT EXISTS (SELECT 1 FROM core.instruments WHERE canonical_code=n::text||'.SH') ORDER BY n LIMIT $3`,
  [start, start + count * 3, count]);
  assert.strictEqual(rows.length, count, '无法生成互不冲突的测试证券代码');
  return rows.map(row => row.code);
}

async function createCompanyWithStock(client, code, name) {
  const companyId = (await client.query('INSERT INTO core.companies(legal_name) VALUES($1) RETURNING company_id', [name]))
    .rows[0].company_id;
  const stockId = (await client.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status)
    VALUES($1,$2,'stock','CN','SSE','CNY','listed') RETURNING instrument_id`, [code, name])).rows[0].instrument_id;
  await client.query('INSERT INTO core.company_instruments(company_id,instrument_id) VALUES($1,$2)', [companyId, stockId]);
  return { companyId, stockId };
}

async function createBond(client, stockId, code, sourceId, name) {
  const bondId = (await client.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status,list_date)
    VALUES($1,$2,'convertible_bond','CN','SSE','CNY','listed','2099-01-01') RETURNING instrument_id`, [code, name]))
    .rows[0].instrument_id;
  await client.query('INSERT INTO fundamental.convertible_bond_profiles(instrument_id,stock_instrument_id) VALUES($1,$2)', [bondId, stockId]);
  await client.query(`INSERT INTO market.convertible_bond_daily_metrics(instrument_id,trade_date,source_id,close)
    VALUES($1,$2,$3,100)`, [bondId, TRADE_DATE, sourceId]);
}

async function insertReport(client, params) {
  const { rows } = await client.query(`INSERT INTO fundamental.financial_reports
    (company_id,report_kind,period_end,period_type,announced_at,source_id,source_version,report_type,is_current_version,raw_payload)
    VALUES($1,$2,$3,'annual',$4,$5,$6,'1',true,$7::jsonb) RETURNING report_id`,
  [params.companyId, params.kind, PERIOD_END, params.announcedAt || '2098-04-20', params.sourceId,
    params.version, JSON.stringify(params.payload)]);
  return rows[0].report_id;
}

async function insertWide(client, params) {
  await client.query(`INSERT INTO fundamental.statement_balance_cas
    (report_id,company_id,period_end,currency_code,accounting_standard,source_id,source_version,bs_tcl)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [params.reportId, params.companyId, PERIOD_END, params.currency || 'CNY', params.standard || 'CAS',
    params.sourceId, params.version, params.value]);
}

(async () => {
  const client = await pool.connect();
  const original = pool.query;
  try {
    await client.query('BEGIN');
    const sources = Object.fromEntries((await client.query(
      "SELECT source_code,source_id FROM ops.data_sources WHERE source_code IN ('tushare','lixinger_official')"
    )).rows.map(row => [row.source_code, row.source_id]));
    if (!sources.lixinger_official) {
      sources.lixinger_official = (await client.query(`INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
        VALUES('lixinger_official','理杏仁开放平台','api',70) ON CONFLICT(source_code) DO UPDATE SET source_name=EXCLUDED.source_name
        RETURNING source_id`)).rows[0].source_id;
    }
    assert.ok(sources.tushare && sources.lixinger_official, '测试库必须有两个来源');

    const codes = await takeCodes(client, 18);
    const stockCodes = codes.slice(0, 9), bondCodes = codes.slice(9);
    const lix = sources.lixinger_official, ts = sources.tushare;

    async function scenario(index, config) {
      const stockCode = stockCodes[index], bondCode = bondCodes[index];
      const name = `安全性流动负债回归-${index}-${Date.now()}`;
      const { companyId, stockId } = await createCompanyWithStock(client, stockCode, name);
      await createBond(client, stockId, bondCode, ts, name);
      const version = config.version || `v-${index}`;
      const common = { companyId, sourceId: config.sourceId, version };
      const tsCode = stockCode;
      await insertReport(client, { ...common, kind: 'indicator', announcedAt: '2098-04-20',
        payload: { ts_code: tsCode, ebit_to_interest: 10, ebit: 1000, interestdebt: 500 } });
      await insertReport(client, { ...common, kind: 'income', announcedAt: '2098-04-20',
        payload: { ts_code: tsCode, fin_exp_int_exp: 100 } });
      const balancePayload = { ts_code: tsCode, total_assets: 1000000, total_liab: 400000,
        total_hldr_eqy_exc_min_int: 600000, ...config.balancePayload };
      const balanceId = await insertReport(client, { ...common, kind: 'balance', announcedAt: '2098-04-20', payload: balancePayload });
      const wide = config.wide;
      if (wide) {
        await insertWide(client, {
          reportId: balanceId,
          companyId, sourceId: wide.sourceId == null ? config.sourceId : wide.sourceId,
          version: wide.version || version, value: wide.value,
          currency: wide.currency, standard: wide.standard,
        });
      }
      return { bondCode, stockId, reportId: balanceId };
    }

    // 1. 理杏仁摘要缺键，同一 report_id 的 CNY/CAS bs_tcl 命中。
    const fallback = await scenario(0, { sourceId: lix, wide: { value: 590000000 } });
    assert.strictEqual((await client.query('SELECT raw_payload FROM fundamental.financial_reports WHERE report_id=$1',
      [fallback.reportId])).rows[0].raw_payload.total_cur_liab, undefined,
    '反例前提：理杏仁摘要本身没有 total_cur_liab');

    // 2. 原始字段优先（宽表不同值不覆盖）。
    const rawFirst = await scenario(1, { sourceId: lix, balancePayload: { total_cur_liab: 100 }, wide: { value: 999 } });

    // 3. 另一报告/版本：选中新报告，宽表只挂旧报告，不能借用。
    const otherVersion = await scenario(2, { sourceId: lix, version: 'v-new' });
    const otherCompany = (await client.query('SELECT company_id FROM fundamental.financial_reports WHERE report_id=$1',
      [otherVersion.reportId])).rows[0].company_id;
    const oldReport = await insertReport(client, {
      companyId: otherCompany, kind: 'balance', announcedAt: '2098-04-19', sourceId: lix, version: 'v-old',
      payload: { ts_code: stockCodes[2], total_assets: 1000000, total_liab: 400000 },
    });
    await insertWide(client, { reportId: oldReport, companyId: otherCompany, sourceId: lix, version: 'v-old', value: 777 });

    // 4. 无任何宽表证据：保留缺失。
    const missing = await scenario(3, { sourceId: lix });

    // 5. Tushare 缺失原始键时不得回退宽表。
    const tushareMissing = await scenario(4, { sourceId: ts, wide: { value: 888 } });

    // 6. 跨来源：宽表 source_id 不是选中报告的来源。
    const crossSource = await scenario(5, { sourceId: lix, wide: { value: 666, sourceId: ts } });

    // 7. 跨币种：宽表不是 CNY。
    const crossCurrency = await scenario(6, { sourceId: lix, wide: { value: 555, currency: 'HKD' } });

    // 8. 原始 0 必须保留 0，不能回退宽表。
    const zero = await scenario(7, { sourceId: lix, balancePayload: { total_cur_liab: 0 }, wide: { value: 444 } });

    const { rows } = await loadBondSafetyFacts([TRADE_DATE], client);
    const byCode = code => rows.find(row => row.bond_code === code);
    const valueOf = code => byCode(code).balance_current_liability;
    assert.strictEqual(byCode(fallback.bondCode).balance_payload.total_cur_liab ?? null, null,
      '反例：旧读法只读 raw_payload.total_cur_liab，此场景只能得到 null');
    assert.strictEqual(valueOf(fallback.bondCode), 590000000, '同一 report_id 的 CAS bs_tcl 必须补足缺失');
    assert.strictEqual(valueOf(rawFirst.bondCode), 100, '原始字段必须优先');
    assert.strictEqual(valueOf(otherVersion.bondCode), null, '另一报告/版本的宽表不得借用');
    assert.strictEqual(valueOf(missing.bondCode), null, '无证据必须保留缺失');
    assert.strictEqual(valueOf(tushareMissing.bondCode), null, 'Tushare 不得回退宽表');
    assert.strictEqual(valueOf(crossSource.bondCode), null, '跨来源宽表不得借用');
    assert.strictEqual(valueOf(crossCurrency.bondCode), null, '非 CNY 宽表不得借用');
    assert.strictEqual(valueOf(zero.bondCode), 0, '原始 0 必须保留为 0');
    assert.notStrictEqual(byCode(otherVersion.bondCode).balance_report_id, byCode(otherVersion.bondCode).balance_wide_report_id,
      '反例前提：选中的报告与旧宽表报告不同');

    // 服务层真正消费仓储单字段；旧读法对 fallback 场景会是 null。
    pool.query = client.query.bind(client);
    const result = await fetchBondSafetySourceFromDatabase(TRADE_DATE);
    const companyOf = code => result.companyRows.find(row => String(row.identity_key) === String(result.bondRows.find(item => item.bond_code === code).identity_key));
    assert.strictEqual(companyOf(fallback.bondCode).current_liability, 590000000, '服务必须消费宽表回退字段');
    assert.strictEqual(companyOf(rawFirst.bondCode).current_liability, 100);
    assert.strictEqual(companyOf(missing.bondCode).current_liability, null);
    assert.strictEqual(companyOf(zero.bondCode).current_liability, 0);
    console.log('安全性流动负债真实 PostgreSQL：同一报告命中、原始优先、拒绝借用与真实缺失通过');
  } finally {
    pool.query = original;
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
})().catch(async error => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
