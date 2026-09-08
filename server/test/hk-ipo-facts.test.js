const assert = require('assert');
const {
  buildProbePlan,
  parseNewListingsHtml,
  parsePredefinedDocumentHtml,
  stageForRow,
  allotmentTitleLooksLikeIpo,
} = require('../services/hkexIpo');
const { normalizeCalendarRows } = require('../jobs/hkTradeCalendarSync');
const { rowsFromProbe, runHkIpoSync } = require('../jobs/hkIpoSync');
const { syncHkexAllotmentFacts, shouldPersistAllotmentFacts } = require('../services/hkexIpo');

const listingHtml = `
  <table><tr><th>Stock Code</th><th>Name</th><th>Listing Date</th></tr>
  <tr><td>358</td><td>示例科技</td><td>2026-09-10</td><td><a href="/docs/358.pdf">公告</a></td></tr>
  <tr><td>12345</td><td>测试公司</td><td>10/09/2026</td></tr></table>`;
const listings = parseNewListingsHtml(listingHtml, { board: '主板', sourceUrl: 'https://www.hkex.com.hk/new' });
assert.strictEqual(listings.length, 2);
assert.strictEqual(listings[0].securityCode, '00358.HK');
assert.strictEqual(listings[0].listingDate, '2026-09-10');
assert.strictEqual(listings[0].board, '主板');

const dateFirst = parseNewListingsHtml('<table><tr><td>2026-09-10</td><td>00700</td><td>日期先出现的公司</td></tr></table>');
assert.strictEqual(dateFirst[0].securityCode, '00700.HK');

const docs = parsePredefinedDocumentHtml('<a href="/docs/00700-prospectus.pdf">Prospectus 00700 2026-09-01</a>', {
  documentType: 'prospectus', sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/'
});
assert.strictEqual(docs[0].securityCode, '00700.HK');
assert.strictEqual(docs[0].documentType, 'prospectus');
const dateOnlyDoc = parsePredefinedDocumentHtml('<a href="/listedco/listconews/sehk/2026/0901/202609010001.pdf">招股章程</a>', {
  documentType: 'prospectus', sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/'
});
assert.strictEqual(dateOnlyDoc[0].securityCode, null);

for (const target of buildProbePlan()) {
  assert.strictEqual(new URL(target.url).protocol, 'https:');
  assert.ok(['www.hkex.com.hk', 'www2.hkex.com.hk', 'www1.hkexnews.hk', 'www2.hkexnews.hk'].includes(new URL(target.url).hostname));
}

const calendar = normalizeCalendarRows([{ cal_date: '20260910', is_open: '1' }, { trade_date: '2026-09-11', is_open: 0 }]);
assert.deepStrictEqual(calendar.map(row => row.tradeDate), ['2026-09-10', '2026-09-11']);
assert.deepStrictEqual(calendar.map(row => row.isOpen), [true, false]);

const probeRows = rowsFromProbe({ targets: [{ ok: true, url: 'x', items: listings }, { ok: true, url: 'y', items: [listings[0]] }] });
assert.strictEqual(probeRows.length, 2);
assert.strictEqual(probeRows[0].securityCode, '00358.HK');

const merged = rowsFromProbe({ targets: [
  { ok: true, items: [{ securityCode: '00700.HK', securityName: '示例公司', listingDate: '2026-09-10', documentUrl: 'https://www2.hkex.com.hk/listing/700' }] },
  { ok: true, items: [{ securityCode: '00700.HK', documentType: 'prospectus', title: '招股章程', url: 'https://www1.hkexnews.hk/docs/700.pdf' }] },
] });
assert.strictEqual(merged[0].securityName, '示例公司');
assert.strictEqual(merged[0].listingDate, '2026-09-10');
assert.strictEqual(merged[0].sourceDocuments.length, 2);

assert.strictEqual(stageForRow({ listingDate: '2099-01-01', offerCloseDate: '2026-01-02' }, '2026-01-03'), 'active');
assert.strictEqual(stageForRow({ offerCloseDate: '2026-01-02', allotmentDate: '2026-01-05' }, '2026-01-03'), 'active');
assert.strictEqual(stageForRow({ allotmentDate: '2026-01-05' }, '2026-01-06'), 'allotted');

assert.strictEqual(
  allotmentTitleLooksLikeIpo('全球發售', { SHORT_TEXT: '公告及通告 - [配發結果]' }),
  true,
  '港交所配发结果类别在原始字段、标题为全球發售时仍必须识别'
);
assert.strictEqual(
  allotmentTitleLooksLikeIpo('全球發售', { SHORT_TEXT: '公告及通告 - [招股章程]' }),
  false,
  '只有全球發售标题不能单独判定为配发结果'
);
assert.strictEqual(
  allotmentTitleLooksLikeIpo('供股結果', { SHORT_TEXT: '公告及通告 - [配發結果]' }),
  false,
  '供股配发结果不得进入港股 IPO 配发补全'
);

(async () => {
  const failed = await runHkIpoSync('preopen', 'test', { probe: { targets: [{ ok: false, error: 'network' }] } });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.publishDatasets, false);
  let refreshParams = null;
  const refreshResult = await syncHkexAllotmentFacts({
    fromDate: '2025-08-04', toDate: '2026-09-08', limit: 0, refreshLottery: true,
    executor: async (sql, params) => {
      if (sql.includes("source_code='hkex_announcements'")) return { rows: [{ source_id: 1 }] };
      if (sql.includes('FROM public.ipo_history')) { refreshParams = params; return { rows: [] }; }
      if (sql.includes('INSERT INTO ops.ingestion_runs')) return { rows: [{ run_id: 1 }] };
      return { rows: [] };
    },
  });
  assert.strictEqual(refreshResult.status, 'succeeded');
  assert.strictEqual(refreshParams[3], true, '历史配发重解析必须显式传入 refreshLottery');

  let candidateSql = '';
  const defaultResult = await syncHkexAllotmentFacts({
    fromDate: '2025-08-04', toDate: '2026-09-08', limit: 0, refreshLottery: false,
    executor: async (sql, params) => {
      if (sql.includes("source_code='hkex_announcements'")) return { rows: [{ source_id: 1 }] };
      if (sql.includes('FROM public.ipo_history')) { candidateSql = sql; assert.strictEqual(params[3], false); return { rows: [] }; }
      if (sql.includes('INSERT INTO ops.ingestion_runs')) return { rows: [{ run_id: 2 }] };
      return { rows: [] };
    },
  });
  assert.strictEqual(defaultResult.status, 'succeeded');
  assert.match(candidateSql, /lotteryParserStatus.*missing/, '默认补全必须跳过已确认无一手中签率的官方文件');
  assert.match(candidateSql, /parserStatus.*incomplete/, '默认补全必须跳过已确认结构不完整的官方文件');
  assert.match(candidateSql, /lotteryParserStatus.*parsed/, '比例结构不完整但一手中签率已解析的文件默认不应重复抓取');
  assert.match(candidateSql, /oneLotSuccessRate.*IS NOT NULL/, '默认补全必须兼容历史证据中缺少 parserStatus 的已解析文件');
  assert.match(candidateSql, /NOT IN \('introduction','gem_transfer','de_spac'\)/, '配发补全不得为非公众项目重复检索官方文件');
  assert.strictEqual(
    shouldPersistAllotmentFacts({ parserStatus: 'incomplete' }, 'parsed'),
    true,
    '初始发售比例不完整但一手中签率已解析时，必须保留一手中签率'
  );
  assert.strictEqual(
    shouldPersistAllotmentFacts({ parserStatus: 'incomplete' }, 'missing'),
    false,
    '两类配发事实都缺失时，不能写入不完整结果'
  );
  assert.strictEqual(
    shouldPersistAllotmentFacts({ parserStatus: 'incomplete', lotAmountHkd: 4904.97, applicationFeeHkd: 48.97 }, 'missing', 'parsed'),
    true,
    '配发结构缺失但公告费用已解析时，必须保留每手资金和申请费用'
  );
  assert.match(candidateSql, /feeParserStatus.*IN \('parsed','missing'\)/, '默认补全必须避免重复抓取已确认费用解析结果');
  console.log('hk-ipo-facts.test.js passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
