const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyHkexIpoStatusNotice, syncHkexListingStatusNotices } = require('../services/hkexIpo');
const { hkOfferPhaseSql } = require('../routes/ipo');

const noticeUrl = 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0917/2026091701580_c.pdf';

function makeExecutor(candidate) {
  const writes = [];
  return {
    writes,
    query: async (sql, params = []) => {
      if (sql.includes("source_code='hkex_announcements'")) return { rows: [{ source_id: 9 }] };
      if (sql.includes('FROM public.ipo_history')) {
        writes.push({ kind: 'candidate', sql, params });
        return { rows: [candidate] };
      }
      if (sql.includes('INSERT INTO ops.ingestion_runs')) return { rows: [{ run_id: 21 }] };
      writes.push({ kind: 'write', sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
}

async function main() {
  assert.strictEqual(classifyHkexIpoStatusNotice('Delay of the Global Offering and the Listing'), 'postponed');
  assert.strictEqual(classifyHkexIpoStatusNotice('延迟全球发售及上市'), 'postponed');
  assert.strictEqual(classifyHkexIpoStatusNotice('Cancellation of the Global Offering'), 'cancelled');
  assert.strictEqual(classifyHkexIpoStatusNotice('Postponement of an unrelated meeting'), null);
  assert.match(hkOfferPhaseSql(), /ipo_status,''\)\)='postponed' THEN 'postponed'/);

  const tempCache = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-ipo-postponement-'));
  const priorCache = process.env.DOCUMENT_PDF_CACHE_DIR;
  process.env.DOCUMENT_PDF_CACHE_DIR = tempCache;
  try {
    const executor = makeExecutor({
      security_code: '06700.HK', security_name: '深圳四方精創資訊股份有限公司', instrument_id: 'instrument-6700',
      offer_open_at: '2026-09-14T00:00:00+08:00', source_documents: [], data_completeness: {},
    });
    const result = await syncHkexListingStatusNotices({
      fromDate: '2026-09-14', toDate: '2026-09-27', targetCodes: ['06700.HK'],
      executor: executor.query,
      fetchImpl: async () => Buffer.from('%PDF-1.4\nfixture'),
      searchImpl: async () => [{
        stockCode: '06700', title: 'Delay of the Global Offering and the Listing',
        announcedAt: '2026-09-17', fileLink: noticeUrl,
      }],
    });
    assert.strictEqual(result.postponed, 1);
    assert.strictEqual(result.cancelled, 0);
    assert.deepStrictEqual(executor.writes[0].params[2], ['06700.HK']);
    assert.match(executor.writes[0].sql, /security_code=ANY\(\$3::text\[\]\)/);
    const historyUpdate = executor.writes.find(call => call.kind === 'write' && call.sql.includes('UPDATE public.ipo_history'));
    assert.ok(historyUpdate);
    assert.strictEqual(historyUpdate.params[1], 'postponed');
    assert.strictEqual(historyUpdate.params[2], '2026-09-17');
    const documents = JSON.parse(historyUpdate.params[3]);
    assert.ok(documents.some(document => document.type === 'listing_postponement' && document.url === noticeUrl));

    const resumedExecutor = makeExecutor({
      security_code: '06700.HK', security_name: '深圳四方精創資訊股份有限公司', instrument_id: 'instrument-6700',
      offer_open_at: '2026-10-01T00:00:00+08:00', source_documents: [], data_completeness: {},
    });
    const resumedResult = await syncHkexListingStatusNotices({
      fromDate: '2026-09-14', toDate: '2026-10-02', targetCodes: ['06700.HK'],
      executor: resumedExecutor.query,
      fetchImpl: async () => { throw new Error('新招股窗口不应重新套用旧延期公告'); },
      searchImpl: async () => [{
        stockCode: '06700', title: 'Delay of the Global Offering and the Listing',
        announcedAt: '2026-09-17', fileLink: noticeUrl,
      }],
    });
    assert.strictEqual(resumedResult.postponed, 0);
    assert.strictEqual(resumedExecutor.writes.filter(call => call.sql.includes('UPDATE public.ipo_history')).length, 0);
  } finally {
    if (priorCache === undefined) delete process.env.DOCUMENT_PDF_CACHE_DIR;
    else process.env.DOCUMENT_PDF_CACHE_DIR = priorCache;
    fs.rmSync(tempCache, { recursive: true, force: true });
  }
  console.log('hk-ipo-postponement: 06700 延期公告分类、目标写入和重新招股保护通过');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
