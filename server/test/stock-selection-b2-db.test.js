// Batch 2 真实隔离库回归（B2-2 财报三类合并 + B2-3 港股覆盖查询与写库无变化守卫）。
//
// 全部夹具在同一事务内写入并回滚，不向隔离库留下测试数据。
// 运行：npm.cmd run test:file -- server/test/stock-selection-b2-db.test.js
'use strict';
const assert = require('assert');
const { Client } = require('pg');
const { testDatabaseConfig } = require('./lib/testDatabase');
const projRepo = require('../repositories/stockProjectionRepository');
const repo = require('../repositories/stockSelectionRepository');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

const CODE = '991001.SH';
const HK_CODE = '99911.HK';

async function insertInstrument(client, { code, market, exchange, currency }) {
  const { rows } = await client.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date)
     VALUES($1,$2,'stock',$3,$4,$5,DATE '2015-01-05') RETURNING instrument_id`,
    [code, code, market, exchange, currency],
  );
  const instrumentId = Number(rows[0].instrument_id);
  const company = await client.query(
    `INSERT INTO core.companies(legal_name,short_name,country_code)
     VALUES($1,$2,$3) RETURNING company_id`,
    [`${code} 测试公司`, code, market === 'HK' ? 'HK' : 'CN'],
  );
  await client.query(
    `INSERT INTO core.company_instruments(company_id,instrument_id,relation_type)
     VALUES($1,$2,'issued_by')`,
    [company.rows[0].company_id, instrumentId],
  );
  return { instrumentId, companyId: Number(company.rows[0].company_id) };
}

function lightRow(overrides = {}) {
  return {
    ts_code: CODE, end_date: '20241231', ann_date: '20250328', f_ann_date: '20250328',
    report_type: '1', comp_type: '1', currency: 'CNY', period_type: 'annual', update_flag: '0',
    __statement_coverage: {
      core_complete: true,
      full_statements_complete: false,
      complete: false,
      collection_profile: 'selection_core',
      requested_batch_count: 1,
      returned_batch_count: 1,
      returned_metric_codes: [],
    },
    ...overrides,
  };
}

function fullRow(overrides = {}) {
  return {
    ts_code: CODE, end_date: '20241231', ann_date: '20250328', f_ann_date: '20250328',
    report_type: '1', comp_type: '1', currency: 'CNY', period_type: 'annual', update_flag: '0',
    __statement_coverage: {
      core_complete: true,
      full_statements_complete: true,
      complete: true,
      collection_profile: 'full',
      requested_batch_count: 3,
      returned_batch_count: 3,
      returned_metric_codes: ['bs.ta'],
    },
    __statement_metrics: { 'bs.ta': 100 },
    __statement_comparisons: { yoy: { 'bs.ta': 0.1 } },
    ...overrides,
  };
}

async function reportPayloadOf(client, companyId) {
  const { rows } = await client.query(
    `SELECT ctid::text AS ctid, raw_payload
       FROM fundamental.financial_reports
      WHERE company_id=$1 AND report_kind='balance'`,
    [companyId],
  );
  return rows;
}

async function run() {
  const client = new Client({ ...testDatabaseConfig(), connectionTimeoutMillis: 10000 });
  await client.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const sources = await projRepo.sourceIds(client);
    const sourceId = sources.lixinger_official || sources.tushare;

    // ---------- B2-2 规则 1：同版本轻量补空 ----------
    const master = await projRepo.ensureMaster(client, CODE, sources, {
      ts_code: CODE, name: 'B2 合并测试', market: 'CN', list_date: '20150105',
    });
    await projRepo.syncReportRows(client, [lightRow({
      total_assets: 100,
      __statement_coverage: {
        core_complete: true, full_statements_complete: false, complete: false,
        collection_profile: 'selection_core', requested_batch_count: 1,
        returned_batch_count: 1, returned_metric_codes: ['bs.ta'],
      },
    })], 'balance', master.companyId, sourceId, { tsCode: CODE, currency: 'CNY' });
    await projRepo.syncReportRows(client, [lightRow({
      total_liab: 40,
      __statement_coverage: {
        core_complete: true, full_statements_complete: false, complete: false,
        collection_profile: 'selection_core', requested_batch_count: 1,
        returned_batch_count: 1, returned_metric_codes: ['bs.tl'],
      },
    })], 'balance', master.companyId, sourceId, { tsCode: CODE, currency: 'CNY' });
    let reports = await reportPayloadOf(client, master.companyId);
    eq(reports.length, 1, '轻量补空必须命中同一业务身份行');
    const mergedLight = reports[0].raw_payload;
    eq(Number(mergedLight.total_assets), 100, '轻量补空必须保留原非空字段');
    eq(Number(mergedLight.total_liab), 40, '轻量补空必须补齐新非空字段');
    eq(mergedLight.__statement_coverage.full_statements_complete, false, '轻量行不得标成三表全量');
    ok(mergedLight.__statement_coverage.returned_metric_codes.includes('bs.ta')
      && mergedLight.__statement_coverage.returned_metric_codes.includes('bs.tl'),
    '轻量补空必须合并 returned_metric_codes');

    // ---------- B2-2 规则 3：旧全量三表防降级（先造全量行） ----------
    const fullMaster = await projRepo.ensureMaster(client, '991002.SH', sources, {
      ts_code: '991002.SH', name: 'B2 防降级测试', market: 'CN', list_date: '20150105',
    });
    const full = fullRow({ ts_code: '991002.SH', total_assets: 100 });
    await projRepo.syncReportRows(client, [full], 'balance', fullMaster.companyId, sourceId,
      { tsCode: '991002.SH', currency: 'CNY' });
    const beforeFull = await reportPayloadOf(client, fullMaster.companyId);
    const beforeWide = (await client.query(
      'SELECT ctid::text AS ctid, bs_ta FROM fundamental.statement_balance_cas WHERE report_id=(SELECT report_id::bigint FROM fundamental.financial_reports WHERE company_id=$1 AND report_kind=\'balance\')',
      [fullMaster.companyId])).rows;
    eq(String(beforeFull[0].raw_payload.__statement_coverage.full_statements_complete), 'true');
    ok(beforeWide.length === 1 && Number(beforeWide[0].bs_ta) === 100, '全量行必须写入宽表细项');

    const lightSame = lightRow({
      ts_code: '991002.SH', total_assets: 100, __statement_metrics: undefined,
      __statement_coverage: {
        core_complete: true, full_statements_complete: false, complete: false,
        collection_profile: 'selection_core', requested_batch_count: 1,
        returned_batch_count: 1, returned_metric_codes: ['bs.ta'],
      },
    });
    await projRepo.syncReportRows(client, [lightSame], 'balance', fullMaster.companyId, sourceId,
      { tsCode: '991002.SH', currency: 'CNY' });
    const afterFull = await reportPayloadOf(client, fullMaster.companyId);
    eq(afterFull[0].ctid, beforeFull[0].ctid, '同值轻量重采不得重写全量报告行');
    eq(afterFull[0].raw_payload.__statement_coverage.full_statements_complete, true,
      '同值轻量重采不得把旧全量行降级');
    eq(Number(afterFull[0].raw_payload.__statement_comparisons?.yoy?.['bs.ta']), 0.1,
      '同值轻量重采不得清空旧原生比较值');
    const afterWide = (await client.query(
      'SELECT ctid::text AS ctid, bs_ta FROM fundamental.statement_balance_cas WHERE report_id=(SELECT report_id::bigint FROM fundamental.financial_reports WHERE company_id=$1 AND report_kind=\'balance\')',
      [fullMaster.companyId])).rows;
    eq(afterWide[0].ctid, beforeWide[0].ctid, '同值轻量重采不得重写宽表细项');
    eq(Number(afterWide[0].bs_ta), 100, '同值轻量重采不得清空宽表细项');

    // ---------- B2-2 规则 2：正式更正降级标记 ----------
    const corrected = lightRow({
      ts_code: '991002.SH', total_assets: 120,
      __statement_coverage: {
        core_complete: true, full_statements_complete: false, complete: false,
        collection_profile: 'selection_core', requested_batch_count: 1,
        returned_batch_count: 1, returned_metric_codes: ['bs.ta'],
      },
    });
    await projRepo.syncReportRows(client, [corrected], 'balance', fullMaster.companyId, sourceId,
      { tsCode: '991002.SH', currency: 'CNY' });
    const afterCorrect = await reportPayloadOf(client, fullMaster.companyId);
    eq(afterCorrect.length, 1, '同身份数值更正仍命中同一报告行');
    eq(Number(afterCorrect[0].raw_payload.total_assets), 120, '真实更正必须采用新值');
    eq(afterCorrect[0].raw_payload.__statement_coverage.full_statements_complete, false,
      '全量行被轻量更正后必须显式标记 full_statements_complete=false');
    eq(afterCorrect[0].raw_payload.__statement_coverage.complete, false,
      '兼容 complete 字段必须同步为 false');
    const correctedFact = await client.query(
      "SELECT numeric_value FROM fundamental.financial_facts WHERE report_id=(SELECT report_id::bigint FROM fundamental.financial_reports WHERE company_id=$1 AND report_kind='balance') AND metric_code='total_assets'",
      [fullMaster.companyId]);
    eq(Number(correctedFact.rows[0].numeric_value), 120, '核心标准事实必须随真实更正更新');

    // ---------- B2-3：港股覆盖查询 ----------
    const hk = await insertInstrument(client, { code: HK_CODE, market: 'HK', exchange: 'HKEX', currency: 'HKD' });
    await client.query(
      `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pb,pe_ttm,currency_code)
       VALUES($1,'2026-11-02'::date,$2,1.1,8.0,'HKD'),($1,'2026-11-03'::date,$2,1.2,8.2,'HKD')`,
      [hk.instrumentId, sourceId]);
    await client.query(
      `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close)
       VALUES($1,'2026-11-03'::date,$2,50)`,
      [hk.instrumentId, sourceId]);
    const coverage = await repo.loadHkCoverageDates({
      instrumentId: hk.instrumentId, startDate: '2026-11-01', endDate: '2026-11-05',
    }, client);
    eq(coverage.valuation.size, 2, '覆盖查询必须读出港股估值日期');
    ok(coverage.valuation.has('2026-11-02') && coverage.valuation.has('2026-11-03'));
    eq(coverage.bars.size, 1, '覆盖查询必须读出港股行情日期');

    // ---------- B2-3：写库无变化守卫 ----------
    const valuationRows = [{
      instrumentId: hk.instrumentId, tradeDate: '2026-11-03', peStatic: null, peTtm: 8.2, pb: 1.2,
      dividendYield: 0.03, totalMarketCap: 1000000, circulatingMarketCap: 900000, currencyCode: 'HKD',
    }];
    await repo.upsertDailyValuationRows({ rows: valuationRows, sourceId }, client);
    const beforeValuation = (await client.query(
      `SELECT ctid::text AS ctid, ingested_at::text AS ingested_at
         FROM market.daily_valuations WHERE instrument_id=$1 AND trade_date='2026-11-03'::date`,
      [hk.instrumentId])).rows[0];
    await repo.upsertDailyValuationRows({ rows: valuationRows, sourceId }, client);
    const afterValuation = (await client.query(
      `SELECT ctid::text AS ctid, ingested_at::text AS ingested_at
         FROM market.daily_valuations WHERE instrument_id=$1 AND trade_date='2026-11-03'::date`,
      [hk.instrumentId])).rows[0];
    eq(afterValuation.ctid, beforeValuation.ctid, '估值重复写无变化行时 ctid 不得变化');
    eq(afterValuation.ingested_at, beforeValuation.ingested_at, '估值重复写无变化行时 ingested_at 不得刷新');

    const barRows = [{
      instrumentId: hk.instrumentId, tradeDate: '2026-11-03', open: 49, high: 51, low: 48, close: 50,
      volume: 1000, amount: 50000,
    }];
    await repo.upsertDailyBarRows({ rows: barRows, sourceId }, client);
    const beforeBar = (await client.query(
      `SELECT ctid::text AS ctid, ingested_at::text AS ingested_at
         FROM market.daily_bars WHERE instrument_id=$1 AND trade_date='2026-11-03'::date`,
      [hk.instrumentId])).rows[0];
    await repo.upsertDailyBarRows({ rows: barRows, sourceId }, client);
    const afterBar = (await client.query(
      `SELECT ctid::text AS ctid, ingested_at::text AS ingested_at
         FROM market.daily_bars WHERE instrument_id=$1 AND trade_date='2026-11-03'::date`,
      [hk.instrumentId])).rows[0];
    eq(afterBar.ctid, beforeBar.ctid, '行情重复写无变化行时 ctid 不得变化');
    eq(afterBar.ingested_at, beforeBar.ingested_at, '行情重复写无变化行时 ingested_at 不得刷新');

    // ---------- B2-2：批量 fsTableType 本地读取 ----------
    const types = await repo.loadFsTableTypes({ codes: [CODE, '991002.SH', HK_CODE] }, client);
    ok(types instanceof Map, '批量 fsTableType 必须返回 Map');
  } finally {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
  console.log(`OK stock-selection-b2-db: ${checks} 项真实隔离库 SQL（轻量并表/防降级/更正/覆盖/写库守卫）通过`);
}

run().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
