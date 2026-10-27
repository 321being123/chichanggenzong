const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert(html.indexOf('js/api/client.js') < html.indexOf('js/api/trade-ledger-api.js') &&
  html.indexOf('js/api/trade-ledger-api.js') < html.indexOf('shared/core-trade.js'));
const requests = [];
const apiContext = { window: { siteApi: { request: async (url, options) => {
  requests.push({ url, options });
  return { ok: true, status: 200, payload: {} };
} } } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/api/trade-ledger-api.js'), 'utf8'), apiContext);
const api = apiContext.window.tradeLedgerApi;

(async () => {
  await api.addTrade('账户%', 3, { id: 'fixed-id', date: '2026-10-01' });
  await api.deleteTrade('账户%', 3, 'trade/1');
  await api.recomputeNav('账户%', '2026-10-01');
  assert.deepStrictEqual(requests.map(x => x.url), [
    '/api/accounts/%E8%B4%A6%E6%88%B7%25/ledger/trades?version=3',
    '/api/accounts/%E8%B4%A6%E6%88%B7%25/ledger/trades/trade%2F1?version=3',
    '/api/data/%E8%B4%A6%E6%88%B7%25/recompute-nav',
  ]);
  assert.deepStrictEqual(requests.map(x => x.options.method), ['POST', 'DELETE', 'POST']);
  assert(requests.every(x => x.options.timeoutMs === 0));
  assert.strictEqual(JSON.parse(requests[0].options.body).trade.id, 'fixed-id');
  assert.strictEqual(JSON.parse(requests[0].options.body).trade.date, '2026-10-01', '交易事件保留用户日期');
  assert.strictEqual(JSON.parse(requests[2].options.body).fromDate, '2026-10-01');

  const source = fs.readFileSync(path.join(root, 'public/shared/core-trade.js'), 'utf8');
  const section = source.slice(source.indexOf('async function addTradeInternal('), source.indexOf('// ===================== 税费设置'));
  let mode = 'conflict', verified = false, sent;
  const ui = {
    data: { trades: [] }, currentAccount: '账户%', dataVersion: 3,
    classifyCode: { normalizeCode: x => x }, normalizeQuantity: n => n,
    recognizeCode: () => ({ type: '股权', subtype: '沪市' }), uid: () => 'fixed-id',
    calcTradeFees: () => ({ commission: 1, stamp_tax: 0, transfer_fee: 0, other_fee: 0 }),
    verifySmartEventsSaved: async ids => { assert.strictEqual(ids[0], 'fixed-id'); return { all: verified }; },
    applyLedgerData() {}, renderAll() {}, todayCN: () => '2026-10-28', loadData: async () => ({}),
    window: { tradeLedgerApi: {
      addTrade: async (_account, _version, trade) => { sent = trade; if (mode === 'network') throw new Error('网络故障');
        return mode === 'conflict' ? { ok: false, status: 409, payload: { error: '版本冲突' } } : { ok: true, status: 200, payload: {} }; },
      recomputeNav: async () => { throw new Error('重算失败'); },
    } },
  };
  vm.runInNewContext(section, ui);
  let r = await ui.addTradeInternal('600000', '样本', 'buy', 10, 100, '2026-10-01', null, null, { eventId: 'fixed-id' });
  assert.strictEqual(r.status, 'conflict');
  assert.strictEqual(sent.date, '2026-10-01', '交易事件保留用户日期');
  verified = true;
  r = await ui.addTradeInternal('600000', '样本', 'buy', 10, 100, '2026-10-01', null, null, { eventId: 'fixed-id' });
  assert.strictEqual(r.status, 'saved', '版本冲突时仅经原 ID 核对后认定已保存');
  verified = false; mode = 'network';
  r = await ui.addTradeInternal('600000', '样本', 'buy', 10, 100, '2026-10-01', null, null, { eventId: 'fixed-id' });
  assert.strictEqual(r.status, 'unknown', '网络失败且未查到原 ID 时结果待确认');
  mode = 'success';
  r = await ui.addTradeInternal('600000', '样本', 'buy', 10, 100, '2026-10-01', null, null, { eventId: 'fixed-id' });
  assert.strictEqual(r.status, 'saved');
  assert(r.message.includes('历史净值重算失败'), '交易成功与后续重算失败应分别提示');
  console.log('交易客户端：接口、原 ID、用户日期、冲突和重算失败通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
