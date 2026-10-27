const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const calls = [];
let fail = false;
let conflict = false;
const response = { ok: true, status: 200, payload: {} };
const ui = { window: { siteApi: { request: async (url, options) => {
  calls.push({ url, options });
  return fail ? { ok: false, status: 0, payload: {}, error: '网络故障' }
    : conflict ? { ok: false, status: 409, payload: { error: '版本冲突' } } : response;
} } } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/api/holdings-quote-api.js'), 'utf8'), ui);
const api = ui.window.holdingsQuoteApi;

(async () => {
  assert.strictEqual(await api.quote('600000.SH'), response);
  await api.hkRate(true);
  await api.quotes(['600000', '00700']);
  await api.savePrices('账户甲', 3, [{ code: '600000', price: 10 }]);
  await api.saveDailyPrices('账户甲', '2026-10-28', [{ code: '600000', price: 10 }]);
  await api.addPosition('账户甲', 3, { id: 'fixed-event', code: '600000' });
  await api.addPositions('账户甲', 3, [{ id: 'fixed-batch-event' }]);
  assert.deepStrictEqual(calls.map(x => x.url), [
    '/api/quote/600000.SH', '/api/hkrate?realtime=1', '/api/quotes?codes=600000%2C00700',
    '/api/positions/prices?version=3', '/api/daily-prices/%E8%B4%A6%E6%88%B7%E7%94%B2',
    '/api/accounts/%E8%B4%A6%E6%88%B7%E7%94%B2/ledger/position-events?version=3',
    '/api/accounts/%E8%B4%A6%E6%88%B7%E7%94%B2/ledger/position-events/batch?version=3',
  ]);
  assert(calls.every(x => x.options.timeoutMs === 0), '沿用原请求的不设客户端超时口径');
  assert.deepStrictEqual(calls.slice(3).map(x => x.options.method), ['PATCH', 'POST', 'POST', 'POST']);
  assert.strictEqual(JSON.parse(calls[5].options.body).event.id, 'fixed-event', '保留原交易幂等键');
  assert.strictEqual(JSON.parse(calls[6].options.body).events[0].id, 'fixed-batch-event');
  conflict = true;
  const stale = await api.savePrices('账户甲', 3, []);
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.payload.error, '版本冲突');
  conflict = false;
  fail = true;
  await assert.rejects(api.quote('600000'), /网络故障/);
  console.log('持仓行情客户端：7 类请求、版本、正文和网络失败通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
