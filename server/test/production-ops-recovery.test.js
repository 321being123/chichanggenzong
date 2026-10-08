require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const ExcelJS = require('exceljs');
const { pool } = require('../db/connection');
const { parseHsiWorkbook, calculateM2MarketCap } = require('../jobs/marketVolatilitySync');
const { parseHkIpoXHtml } = require('../services/hkIpoMarketSignals');
const { upsertHkIpoFacts, parsePredefinedDocumentHtml, recomputeCompletenessForStoredRow, isUsableProspectusDocument, readHkIpoCompleteness } = require('../services/hkexIpo');
const { normalizeIpoDiagnostics } = require('../jobs/ipoHistorySync');
const { buildDatasetDiagnosticAlerts, datasetPartitionKeyForSlot } = require('../services/jobOrchestrator');

(async () => {
  const empty = '<section><h2>今日申购 <span class="count">(0)</span></h2><table><thead><tr><th>代码</th><th>认购倍数 <span>实时</span></th></tr></thead><tbody><tr><td colspan="20" class="empty">暂无</td></tr></tbody></table></section>';
  assert.deepStrictEqual(parseHkIpoXHtml(empty), [], '明确零项目及空表体是可核验空结果');
  assert.throws(() => parseHkIpoXHtml(empty.replace('(0)', '(1)')), /预期数据列/, '非零声明不能伪装成无新增');
  assert.throws(() => parseHkIpoXHtml(empty.replace('暂无', '加载失败')), /预期数据列/, '加载失败不算空结果');
  const rightsTitle = 'RESULTS OF VALID ACCEPTANCES OF THE RIGHTS SHARES AND NUMBER OF UNSUBSCRIBED RIGHTS SHARES SUBJECT TO THE COMPENSATORY ARRANGEMENTS UNDER THE RIGHTS ISSUE';
  const rightsDoc = { type: 'allotment_result', title: rightsTitle, url: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/1006/2026100601483.pdf' };
  assert.deepStrictEqual(parsePredefinedDocumentHtml(`<table><tr><td>2147</td><td><a href="${rightsDoc.url}">${rightsTitle}</a></td></tr></table>`, { documentType: 'allotment_result' }), [], '供股配发不应创建 IPO 候选');
  assert.strictEqual(recomputeCompletenessForStoredRow({ source_documents: [rightsDoc] }, '2026-10-08').exclusionReason, 'rights_issue', '旧供股记录应保留证据并排除普通招股完整度');
  assert.strictEqual(isUsableProspectusDocument({ type: 'prospectus', title: 'GLOBAL OFFERING', url: rightsDoc.url }), true, '已登记官方招股书无需再次发现');
  assert.strictEqual(isUsableProspectusDocument({ type: 'prospectus', title: 'GLOBAL OFFERING', url: 'https://example.com/a.pdf' }), false);
  const fullAudit = await readHkIpoCompleteness(async sql => {
    assert.match(sql, /^SELECT/);
    assert.doesNotMatch(sql, /UPDATE|security_code=ANY/);
    return { rows: [{ ipo_status: 'cancelled' }, { ipo_status: 'active' }] };
  }, '2026-10-08');
  assert.strictEqual(fullAudit.rows, 2);
  assert.strictEqual(fullAudit.complete, 1);
  assert.strictEqual(fullAudit.missing, 1, '目标外缺项必须阻止全市场质量通过');
  assert.strictEqual(fullAudit.qualityStatus, 'stale');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('HSI');
  sheet.addRows([['MONTH-END WEIGHTED AVERAGE P/E RATIO'], ['last update'], ['', 'Hang Seng Index'], [new Date('2026-09-30T00:00:00Z'), 13.5]]);
  const rows = await parseHsiWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
  assert.strictEqual(rows[3][0].getTime(), Date.parse('2026-09-30T00:00:00Z'));
  assert.strictEqual(rows[3][1], 13.5, '官方 XLSX 的恒指列不能误取行业分项');
  await assert.rejects(parseHsiWorkbook(Buffer.from('PKbroken')), /./, '损坏工作簿不能覆盖有效事实');
  const result = normalizeIpoDiagnostics({ datasetDiagnostics: { ipo_history: { ingestion_run_id: 2768, quality_status: 'passed', target_date: '2026-10-09' } }, publishDatasetCodes: ['ipo_history'], datasets: [{ datasetCode: 'ipo_history', published: true, partitionKey: '2026-10-08' }] }, '2026-10-08');
  const slot = { job_code: 'ipo_history_sync', slot_id: 123, business_date: '2026-10-08' };
  assert.strictEqual(datasetPartitionKeyForSlot(slot, result, 'ipo_history'), '2026-10-08');
  assert.strictEqual(datasetPartitionKeyForSlot(slot, { datasets: [{ datasetCode: 'ipo_history', published: false, partitionKey: '2026-10-07' }], datasetDiagnostics: { ipo_history: { target_date: '2026-10-08' } } }, 'ipo_history'), '2026-10-08', '未发布旧快照不能覆盖本轮尝试分区');
  assert.deepStrictEqual(buildDatasetDiagnosticAlerts(slot, result), [], '已核验核心快照不能产生次日 unknown 告警');
  const unknown = normalizeIpoDiagnostics({ datasetDiagnostics: { ipo_history: { quality_status: 'passed' } } }, '2026-10-08');
  assert.strictEqual(unknown.datasetDiagnostics.ipo_history.query_status, undefined, '缺少运行证据不得猜测成功');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionalPool = { connect: async () => ({ query: (sql, params) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) ? Promise.resolve({ rows: [] }) : client.query(sql, params), release() {} }) };
    const code = '09991.HK';
    await upsertHkIpoFacts([{ securityCode: code, securityName: 'ops regression', offerOpenDate: '2099-01-01' }], { dbPool: transactionalPool });
    for (const status of ['cancelled', 'postponed', 'introduction', 'gem_transfer', 'de_spac']) {
      await client.query('UPDATE public.ipo_history SET ipo_status=$2 WHERE security_code=$1', [code, status]);
      await client.query('UPDATE core.instruments SET status=$2 WHERE canonical_code=$1', [code, status]);
      await upsertHkIpoFacts([{ securityCode: code, securityName: 'generic announcement' }], { dbPool: transactionalPool });
      const stored = (await client.query('SELECT h.ipo_status,i.status FROM public.ipo_history h JOIN core.instruments i USING(instrument_id) WHERE h.security_code=$1', [code])).rows[0];
      assert.deepStrictEqual(stored, { ipo_status: status, status }, '普通公告不得撤销官方特殊状态：' + status);
    }
    const serviceSource = fs.readFileSync(require.resolve('../services/hkexIpo'), 'utf8');
    const serviceContext = vm.createContext({ require: name => require(require.resolve(name, { paths: [require('path').dirname(require.resolve('../services/hkexIpo'))] })), module: { exports: {} }, exports: {}, process, console, Buffer, URL, __dirname: require('path').dirname(require.resolve('../services/hkexIpo')) });
    vm.runInContext(serviceSource, serviceContext);
    const url = 'https://www1.hkexnews.hk/listedco/listconews/sehk/2099/0101/2099010100001.pdf';
    await client.query(`UPDATE public.ipo_history SET ipo_status='active',issue_price_low=3,issue_price_high=3,issue_price_final=2.5,
      source_documents=$2::jsonb WHERE security_code=$1`, [code, JSON.stringify([{ type: 'prospectus', title: 'GLOBAL OFFERING', url }])]);
    serviceContext.officialUrl = url;
    vm.runInContext("fetchOfficialPdfWithCache=async()=>({buffer:Buffer.from('official fixture'),url:officialUrl}); parseHkexProspectusPdf=async()=>({parserStatus:'parsed',parserVersion:'hk-ipo-prospectus-v5',issuePriceLow:2,issuePriceHigh:3,issuePriceType:'range',lotSizeShares:100,offerOpenAt:'2099-01-01T09:00:00+08:00',offerCloseAt:'2099-01-02T12:00:00+08:00',expectedPricingDate:'2099-01-03',expectedAllotmentDate:'2099-01-04',expectedListingDate:'2099-01-05',evidence:{issuePrice:'official range 2 to 3'}})", serviceContext);
    const options = { targetCodes: [code], executor: client.query.bind(client), fromDate: '2098-01-01', toDate: '2099-12-31' };
    await serviceContext.module.exports.syncHkexProspectusFacts(options);
    const prices = async () => (await client.query('SELECT issue_price_low::float8,issue_price_high::float8,issue_price_final::float8 FROM public.ipo_history WHERE security_code=$1', [code])).rows[0];
    assert.deepStrictEqual(await prices(), { issue_price_low: 2, issue_price_high: 3, issue_price_final: 2.5 }, '官方范围纠正旧固定价且不覆盖实际最终价');
    await upsertHkIpoFacts([{ securityCode: code, issuePriceLow: 2.5, issuePriceHigh: 2.5, issuePriceFinal: 2.5 }], { dbPool: transactionalPool });
    assert.deepStrictEqual(await prices(), { issue_price_low: 2, issue_price_high: 3, issue_price_final: 2.5 }, '普通上市报表最终价不得回写已核验招股范围');
    await client.query('UPDATE public.ipo_history SET issue_price_low=3 WHERE security_code=$1', [code]);
    await serviceContext.module.exports.syncHkexProspectusFacts(options);
    assert.deepStrictEqual(await prices(), { issue_price_low: 2, issue_price_high: 3, issue_price_final: 2.5 }, '未来招股项目的区间与存量固定价不一致必须重新核验');
    await client.query('UPDATE public.ipo_history SET offer_close_at=NULL WHERE security_code=$1', [code]);
    vm.runInContext("parseHkexProspectusPdf=async()=>{throw new Error('invalid official PDF')}", serviceContext);
    await serviceContext.module.exports.syncHkexProspectusFacts(options);
    assert.deepStrictEqual(await prices(), { issue_price_low: 2, issue_price_high: 3, issue_price_final: 2.5 }, '解析失败不得覆盖有效价格范围');
    await client.query("INSERT INTO market.money_supply_monthly(market_code,month,m2_100m_yuan,source_code) VALUES('CN','2099-08-01',1000,'ops-test')");
    await client.query("INSERT INTO market.a_share_market_cap_daily(trade_date,total_market_cap_100m_yuan,security_count,source_code) VALUES('2099-10-31',500,1000,'tushare_daily_basic'),('2099-11-01',500,1000,'tushare_daily_basic')");
    await calculateM2MarketCap({ executor: client.query.bind(client) });
    const m2 = (await client.query("SELECT trade_date::text,data_status FROM analytics.m2_market_cap_daily WHERE trade_date IN ('2099-10-31','2099-11-01') ORDER BY trade_date")).rows;
    assert.deepStrictEqual(m2, [{ trade_date: '2099-10-31', data_status: 'normal' }, { trade_date: '2099-11-01', data_status: 'carried_forward' }], '月频宽限须覆盖整个第二个月，第三个月仍保留陈旧标记');
  } finally { await client.query('ROLLBACK'); client.release(); }

  // 对实际 Runner 注入恒指失败，验证 A 股派生计算仍执行且任务不会假报成功。
  const source = fs.readFileSync(require.resolve('../jobs/marketVolatilitySync'), 'utf8');
  const context = vm.createContext({ require: name => name === '../db' ? { pool: { query: async () => ({ rows: [{ n: 1 }] }) }, tryClaimJob: async () => true, startJobRun: async () => 1, finishJobRun: async () => {}, releaseJob: async () => {} } : require(name), module: { exports: {} }, exports: {}, process, console: { log() {} }, Buffer, __dirname: require('path').dirname(require.resolve('../jobs/marketVolatilitySync')) });
  vm.runInContext(source, context);
  vm.runInContext("syncChinaYield=syncCsiIndexPe=syncUsTreasuryYield=syncMarketCycleMetrics=async()=>1; syncHsiPe=async()=>{throw new Error('HTTP 302')}; calculateGraham=async()=>{globalThis.grahamRan=true}; readMarketSubdatasetFreshness=async()=>({});", context);
  const failed = await context.module.exports.runMarketVolatilitySync({ businessDate: '2026-10-08' });
  assert.strictEqual(context.grahamRan, true, '恒指失败不能阻断 A 股计算');
  assert.strictEqual(failed.ok, false);
  assert.ok(failed.failedDatasets.includes('hsi_pe'), '真实失败仍必须保留');
  console.log('production ops recovery regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
