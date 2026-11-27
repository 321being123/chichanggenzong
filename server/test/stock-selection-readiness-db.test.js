// B1-1/B1-2 真实隔离库回归：新增的 SQL 收窄与就绪查询必须实际执行 PostgreSQL，
// 不能用 repo/deps 替身把 SQL 绕过去。
//
// 覆盖：
// 1. repo.loadUniverse({ codes }) 与全市场查询逐字段一致；
// 2. repo.loadPbWindow({ instrumentIds }) 与全市场查询逐字段一致；
// 3. registry.readDatasetPartitions 对 ops.dataset_partitions 的真实读取（缺分区/零行/齐备）；
// 4. repo.loadHkPeriodReadiness 对 market.daily_bars / daily_valuations / fx_rates 的真实读取
//    （同证券双齐、仅行情/仅估值、目标池部分双齐、汇率超过 10 天）。
//
// 所有夹具写入在同一事务内完成并回滚，不向隔离库留下测试数据；本文件必须经
// `npm.cmd run test:file -- server/test/stock-selection-readiness-db.test.js` 执行。
'use strict';
const assert = require('assert');
const { Client } = require('pg');
const { testDatabaseConfig } = require('./lib/testDatabase');
const { pool } = require('../db/connection');
const repo = require('../repositories/stockSelectionRepository');
const pbProjectionRepository = require('../repositories/pbProjectionRepository');
const registry = require('../services/datasetPartitionRegistry');
const readiness = require('../services/stockSelectionReadiness');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

const CN_DATE = '2099-03-02';
const PB_WINDOW_START = '2099-02-01';
const CN_PARTITION = '2099-01-15';
const CN_PARTITION_MISSING = '2099-01-16';
// 港股夹具全部使用远期日期：隔离库从业务库复制，真实港股数据不会被误当成目标池。
const HK_DATE = '2099-03-02';
const HK_STALE_DATE = '2099-03-13'; // 汇率日期后第 11 天
const HK_MISMATCH_DATE = '2099-06-01'; // 与 HK_DATE 相隔 91 天，目标池互不重叠
const HK_PARTIAL_DATE = '2100-01-05'; // 与上一夹具再隔 218 天
const SOURCE_SQL = "(SELECT source_id FROM ops.data_sources WHERE source_code='tushare')";

async function insertInstrument(client, { code, market, exchange, name }) {
  const { rows } = await client.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date)
     VALUES($1,$2,'stock',$3,$4,$5,DATE '2015-01-05') RETURNING instrument_id`,
    [code, name || code, market, exchange, market === 'HK' ? 'HKD' : 'CNY'],
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
  return instrumentId;
}

async function insertBar(client, instrumentId, tradeDate, close) {
  await client.query(
    `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close)
     VALUES($1,$2::date,${SOURCE_SQL},$3)`,
    [instrumentId, tradeDate, close],
  );
}

async function insertValuation(client, instrumentId, tradeDate, { pb = '1.20', peTtm = '8.50', marketCap = '10000000000', currency = 'CNY' } = {}) {
  await client.query(
    `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_ttm,pb,total_market_cap,currency_code)
     VALUES($1,$2::date,${SOURCE_SQL},$3,$4,$5,$6)`,
    [instrumentId, tradeDate, peTtm, pb, marketCap, currency],
  );
}

async function insertPartition(client, { datasetCode, partitionKey, rowCount, status = 'published', diagnostics }) {
  await client.query(
    `INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,is_stale,row_count,diagnostics,published_at)
     VALUES($1,'CN',$2::date,$3,false,$4,$5::jsonb,now())
     ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE SET
       status=EXCLUDED.status,is_stale=EXCLUDED.is_stale,row_count=EXCLUDED.row_count,
       diagnostics=EXCLUDED.diagnostics,published_at=EXCLUDED.published_at`,
    [datasetCode, partitionKey, status, rowCount, JSON.stringify(diagnostics)],
  );
}

function sameRow(left, right, message) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  for (const key of keys) {
    eq(JSON.stringify(left[key]), JSON.stringify(right[key]), `${message}（字段 ${key}）`);
  }
}

async function run() {
  const client = new Client({ ...testDatabaseConfig(), connectionTimeoutMillis: 10000 });
  await client.connect();
  const originalPoolQuery = pool.query;
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    // 让 registry.readDatasetPartitions / 就绪模块的默认仓储读取与夹具处于同一事务与快照。
    pool.query = (sql, params) => client.query(sql, params);

    // ---------- 夹具：A 股三只（一只无行情 → 不进池）、两只有估值 ----------
    const aId = await insertInstrument(client, { code: '990001.SH', market: 'CN', exchange: 'SSE' });
    const bId = await insertInstrument(client, { code: '990002.SH', market: 'CN', exchange: 'SSE' });
    const cId = await insertInstrument(client, { code: '990003.SH', market: 'CN', exchange: 'SSE' });
    await insertBar(client, aId, CN_DATE, '10.00');
    await insertBar(client, bId, CN_DATE, '20.00');
    await insertBar(client, aId, '2099-02-27', '9.80');
    await insertValuation(client, aId, CN_DATE);
    await insertValuation(client, aId, '2099-02-27', { pb: '1.10', peTtm: '8.00' });
    await insertValuation(client, bId, CN_DATE, { pb: '2.40', peTtm: '30.00' });

    // PB 窗口需要本地交易日历（不含日历会得到 calendarDays=0、gapDays=null，比较不到覆盖语义）。
    const start = new Date(`${PB_WINDOW_START}T00:00:00Z`);
    const end = new Date(`${CN_DATE}T00:00:00Z`);
    for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const day = cursor.getUTCDay();
      await client.query(
        `INSERT INTO market.trade_calendar(exchange,trade_date,is_open)
         VALUES('SSE',$1::date,$2)
         ON CONFLICT(exchange,trade_date) DO NOTHING`,
        [cursor.toISOString().slice(0, 10), day !== 0 && day !== 6],
      );
    }

    // ---------- 1. loadUniverse 收窄与全市场逐字段一致 ----------
    // PB 投影与 daily_valuations 同源：同一事务内按夹具窗口重建，保证读写口径一致。
    await pbProjectionRepository.rebuildProjectionRange({
      market: 'CN',
      fromDate: PB_WINDOW_START,
      toDate: CN_DATE,
      months: pbProjectionRepository.monthsBetween(PB_WINDOW_START, CN_DATE),
      instrumentIds: [aId, bId],
    }, client);
    const fullUniverse = await repo.loadUniverse({ market: 'CN', asOfDate: CN_DATE }, client);
    const fullCodes = fullUniverse.map(row => row.code);
    ok(fullCodes.includes('990001.SH') && fullCodes.includes('990002.SH'),
      '全市场查询必须包含有目标日前 60 天行情的两只夹具');
    ok(!fullCodes.includes('990003.SH'), '从未有行情的夹具不得进入可评估池');
    const restrictedUniverse = await repo.loadUniverse({ market: 'CN', asOfDate: CN_DATE, codes: ['990001.SH'] }, client);
    eq(restrictedUniverse.length, 1, 'codes 收窄必须只返回本批证券');
    const fullRow = fullUniverse.find(row => row.code === '990001.SH');
    sameRow(restrictedUniverse[0], fullRow, 'loadUniverse 收窄结果必须与全市场逐字段一致');

    // ---------- 2. loadPbWindow 收窄与全市场逐字段一致，且不再扫全市场估值 ----------
    const fullPb = await repo.loadPbWindow({
      market: 'CN', windowStart: PB_WINDOW_START, asOfDate: CN_DATE,
    }, client);
    const scopedSql = [];
    const originalClientQuery = client.query.bind(client);
    client.query = (sql, params) => {
      scopedSql.push(String(sql));
      return originalClientQuery(sql, params);
    };
    let restrictedPb;
    try {
      restrictedPb = await repo.loadPbWindow({
        market: 'CN', windowStart: PB_WINDOW_START, asOfDate: CN_DATE, instrumentIds: [aId],
      }, client);
    } finally {
      client.query = originalClientQuery;
    }
    eq(restrictedPb.byInstrument.size, 1, 'instrumentIds 收窄必须只返回本批证券的 PB 窗口');
    // F-08：定点复核不得再对全市场十年 daily_valuations 做 COUNT(DISTINCT trade_date)。
    ok(!scopedSql.some(sql => /COUNT\(DISTINCT\s+v\.trade_date\)/i.test(sql) && /daily_valuations/i.test(sql)),
      '定点复核不得触发全市场估值交易日聚合');
    ok(!scopedSql.some(sql => /FROM market\.daily_valuations v[\s\S]*JOIN core\.instruments i[\s\S]*i\.market/i.test(sql)),
      '定点复核不得扫描全市场 daily_valuations 与 instruments 的 JOIN 聚合');
    eq(restrictedPb.calendarDays, fullPb.calendarDays, '收窄不得改变日历交易日分母');
    eq(restrictedPb.marketDays, restrictedPb.calendarDays,
      '收窄模式复用已核验交易日历作为市场日证据，不另扫全市场');
    sameRow(
      restrictedPb.byInstrument.get(String(aId)),
      fullPb.byInstrument.get(String(aId)),
      'loadPbWindow 收窄结果必须与全市场逐字段一致',
    );

    // ---------- 3. readDatasetPartitions 真实分区读取（零行 / 齐备 / 缺分区） ----------
    const CN_DATASETS = ['stock_daily', 'stock_valuation', 'stock_suspend_calendar'];
    const publishedDiagnostics = (rowCount) => ({
      quality_status: 'passed', query_status: 'success', partition_row_count: rowCount,
    });
    await insertPartition(client, {
      datasetCode: 'stock_daily', partitionKey: CN_PARTITION, rowCount: 0, diagnostics: publishedDiagnostics(0),
    });
    await insertPartition(client, {
      datasetCode: 'stock_valuation', partitionKey: CN_PARTITION, rowCount: 120, diagnostics: publishedDiagnostics(120),
    });
    // 停牌日历允许当天 0 条（无停牌），不能因为零行判缺失。
    await insertPartition(client, {
      datasetCode: 'stock_suspend_calendar', partitionKey: CN_PARTITION, rowCount: 0, diagnostics: publishedDiagnostics(0),
    });

    const zeroRowParts = await registry.readDatasetPartitions(CN_DATASETS, CN_PARTITION, { market: 'CN' });
    eq(zeroRowParts.missingCodes.length, 0, '三份分区均已发布时 readDatasetPartitions 不得报缺失');
    eq(zeroRowParts.evidence.length, 3, '必须逐数据集返回真实分区证据');
    const zeroRowCheck = await readiness.assessPeriodReadiness({
      market: 'CN', periodType: 'day', asOfDate: CN_PARTITION,
      now: new Date('2099-01-16T00:00:00.000Z'),
      deps: { readDatasetPartitions: async (codes, key, context) => registry.readDatasetPartitions(codes, key, context) },
    });
    eq(zeroRowCheck.ready, false, '已发布但 partition_row_count=0 的行情分区不得当成就绪');
    eq(zeroRowCheck.emptyDatasets.join(','), 'stock_daily', '零行分区必须单独留证');
    eq(zeroRowCheck.missingDatasets.length, 0, '零行不是“缺分区”，两种证据必须分开');

    await insertPartition(client, {
      datasetCode: 'stock_daily', partitionKey: CN_PARTITION, rowCount: 500, diagnostics: publishedDiagnostics(500),
    });
    const readyParts = await registry.readDatasetPartitions(CN_DATASETS, CN_PARTITION, { market: 'CN' });
    eq(readyParts.missingCodes.length, 0, '补齐行数后不得再报缺失');
    const readyCheck = await readiness.assessPeriodReadiness({
      market: 'CN', periodType: 'day', asOfDate: CN_PARTITION,
      now: new Date('2099-01-16T00:00:00.000Z'),
      deps: { readDatasetPartitions: async (codes, key, context) => registry.readDatasetPartitions(codes, key, context) },
    });
    eq(readyCheck.ready, true, '三份分区齐备且行情行数 >0 时必须就绪');

    await insertPartition(client, {
      datasetCode: 'stock_daily', partitionKey: CN_PARTITION_MISSING, rowCount: 500, diagnostics: publishedDiagnostics(500),
    });
    await insertPartition(client, {
      datasetCode: 'stock_valuation', partitionKey: CN_PARTITION_MISSING, rowCount: 120, diagnostics: publishedDiagnostics(120),
    });
    const missingParts = await registry.readDatasetPartitions(CN_DATASETS, CN_PARTITION_MISSING, { market: 'CN' });
    eq(missingParts.missingCodes.join(','), 'stock_suspend_calendar', '真实缺分区必须精确列出');
    const missingCheck = await readiness.assessPeriodReadiness({
      market: 'CN', periodType: 'day', asOfDate: CN_PARTITION_MISSING,
      now: new Date('2099-01-17T00:00:00.000Z'),
      deps: { readDatasetPartitions: async (codes, key, context) => registry.readDatasetPartitions(codes, key, context) },
    });
    eq(missingCheck.missingDatasets.join(','), 'stock_suspend_calendar', '就绪检查必须回传真实缺失分区');

    // ---------- 4. loadHkPeriodReadiness 同证券行情/估值双齐与真实汇率读取 ----------
    const hk1 = await insertInstrument(client, { code: '99901.HK', market: 'HK', exchange: 'HKEX' });
    const hk2 = await insertInstrument(client, { code: '99902.HK', market: 'HK', exchange: 'HKEX' });
    await insertBar(client, hk1, HK_DATE, '300.00');
    await insertBar(client, hk2, HK_DATE, '150.00');
    await insertValuation(client, hk1, HK_DATE, { pb: '3.10', peTtm: '18.00', currency: 'HKD' });
    await insertValuation(client, hk2, HK_DATE, { pb: '1.80', peTtm: '12.00', currency: 'HKD' });
    // 同一天可能已被其他来源登记为“权威汇率”；事务内先清掉该日夹具范围的旧行再写入，
    // 避免唯一索引 ux_market_fx_rates_authoritative_day 与回滚外的存量冲突。
    await client.query(
      `DELETE FROM market.fx_rates
        WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date=$1::date`,
      [HK_DATE],
    );
    // 夹具时间点之后可能已有其他来源写入更近的汇率；事务内清掉，才能稳定验证“超过 10 天”。
    await client.query(
      `DELETE FROM market.fx_rates
        WHERE base_currency='HKD' AND quote_currency='CNY'
          AND rate_date > $1::date AND rate_date <= $2::date`,
      [HK_DATE, HK_PARTIAL_DATE],
    );
    await client.query(
      `INSERT INTO market.fx_rates(base_currency,quote_currency,rate_date,source_id,rate)
       VALUES('HKD','CNY',$1::date,${SOURCE_SQL},$2)`,
      [HK_DATE, '0.9100'],
    );

    // ③ 目标池全部同证券双齐 + 有效汇率 → ready。
    const hkReady = await repo.loadHkPeriodReadiness({ asOfDate: HK_DATE }, client);
    eq(hkReady.targetCount, 2, '港股目标池必须精确统计在册且近 60 日活跃的证券');
    eq(hkReady.bothReadyCount, 2, '同一证券同时有行情与 pb 非空估值才算双齐');
    eq(hkReady.missingCoverageCount, 0, '目标池全部双齐时覆盖缺口必须为 0');
    eq(hkReady.fxDate, HK_DATE, '港股就绪查询必须读到 HKD→CNY 的真实汇率日期');
    const hkReadyCheck = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: HK_DATE,
      now: new Date('2099-03-02T15:00:00.000Z'), // 上海 23:00，已过收盘
      deps: { getMarketState: async () => ({ status: 'open', sessionType: 'full_day', closeTime: '16:10' }) },
    });
    eq(hkReadyCheck.ready, true, '港股目标池同证券双齐且汇率有效时必须就绪');
    eq(hkReadyCheck.evidence.missingCoverageCount, 0, '就绪证据必须回传覆盖缺口为 0');

    // ① 证券 A 仅有行情、证券 B 仅有估值 → not_ready。
    const hkBarOnly = await insertInstrument(client, { code: '99903.HK', market: 'HK', exchange: 'HKEX' });
    const hkValuationOnly = await insertInstrument(client, { code: '99904.HK', market: 'HK', exchange: 'HKEX' });
    await insertBar(client, hkBarOnly, HK_MISMATCH_DATE, '88.00');
    await insertValuation(client, hkValuationOnly, HK_MISMATCH_DATE, { pb: '1.10', peTtm: '9.00', currency: 'HKD' });
    const hkMismatch = await repo.loadHkPeriodReadiness({ asOfDate: HK_MISMATCH_DATE }, client);
    eq(hkMismatch.targetCount, 1, '仅估值的证券没有近 60 日行情，不得进入目标池');
    eq(hkMismatch.bothReadyCount, 0, '行情与估值分属不同证券时同证券双齐数必须为 0');
    eq(hkMismatch.missingCoverageCount, 1, '分属不同证券的覆盖不得互相顶替');
    const hkMismatchCheck = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: HK_MISMATCH_DATE,
      now: new Date('2099-06-01T15:00:00.000Z'),
      deps: { getMarketState: async () => ({ status: 'open', sessionType: 'full_day', closeTime: '16:10' }) },
    });
    eq(hkMismatchCheck.ready, false, '证券 A 仅有行情、证券 B 仅有估值时必须 not_ready');
    ok(hkMismatchCheck.missingDomains.includes('hk_valuation'), '同证券缺估值必须记 hk_valuation');

    // ② 目标池 2 只，仅 1 只同证券双齐 → not_ready。
    const hkFull = await insertInstrument(client, { code: '99905.HK', market: 'HK', exchange: 'HKEX' });
    const hkPartial = await insertInstrument(client, { code: '99906.HK', market: 'HK', exchange: 'HKEX' });
    await insertBar(client, hkFull, HK_PARTIAL_DATE, '66.00');
    await insertBar(client, hkPartial, HK_PARTIAL_DATE, '77.00');
    await insertValuation(client, hkFull, HK_PARTIAL_DATE, { pb: '2.00', peTtm: '11.00', currency: 'HKD' });
    const hkPartialRead = await repo.loadHkPeriodReadiness({ asOfDate: HK_PARTIAL_DATE }, client);
    eq(hkPartialRead.targetCount, 2, '目标池必须包含两只近 60 日活跃的港股');
    eq(hkPartialRead.bothReadyCount, 1, '只有一只证券同证券双齐');
    eq(hkPartialRead.missingCoverageCount, 1, '剩余 1 只未双齐必须计入覆盖缺口');
    eq(hkPartialRead.missingValuationCount, 1, '缺估值数量必须精确回传');
    const hkPartialCheck = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: HK_PARTIAL_DATE,
      now: new Date('2100-01-05T15:00:00.000Z'),
      deps: { getMarketState: async () => ({ status: 'open', sessionType: 'full_day', closeTime: '16:10' }) },
    });
    eq(hkPartialCheck.ready, false, '目标池仅 1 只双齐时必须 not_ready');
    eq(hkPartialCheck.evidence.targetCount, 2, '就绪证据必须回传目标池规模');
    eq(hkPartialCheck.evidence.bothReadyCount, 1, '就绪证据必须回传同证券双齐数');

    const hkStale = await repo.loadHkPeriodReadiness({ asOfDate: HK_STALE_DATE }, client);
    eq(hkStale.fxDate, HK_DATE, '没有新汇率时 fxDate 必须停留在最后一条真实记录');
    const staleDays = Math.round(
      (Date.parse(`${HK_STALE_DATE}T00:00:00Z`) - Date.parse(`${hkStale.fxDate}T00:00:00Z`)) / 86400000,
    );
    eq(staleDays, 11, '夹具必须覆盖“汇率超过 10 天”的边界');
    const hkStaleCheck = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: HK_STALE_DATE,
      now: new Date('2099-03-13T15:00:00.000Z'),
      deps: { getMarketState: async () => ({ status: 'open', sessionType: 'full_day', closeTime: '16:10' }) },
    });
    ok(hkStaleCheck.missingDomains.includes('hk_fx_rate'),
      '汇率超过 10 天必须由真实 fx_rates 查询判为未就绪');
  } finally {
    pool.query = originalPoolQuery;
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }

  console.log(`OK stock-selection-readiness-db: ${checks} 项真实隔离库 SQL（股票池/PB窗口/分区证据/港股就绪）通过`);
}

run().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
