const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/shared/core-trade.js'), 'utf8');
const html = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8');
assert(html.indexOf('js/api/holdings-quote-api.js') < html.indexOf('shared/core-trade.js') &&
  html.indexOf('js/api/account-nav-api.js') < html.indexOf('shared/core-trade.js'), '持仓与账户客户端必须先于交易脚本加载');
const save = source.slice(source.indexOf('function savePosition()'), source.indexOf('function deletePosition('));
const remove = source.slice(source.indexOf('function confirmDelete()'), source.indexOf('function closeModal('));
const fields = { 'modal-type': '股权', 'modal-subtype': '沪市', 'modal-code': '600000', 'modal-name': '样本',
  'modal-price': '10', 'modal-qty': '100', 'modal-cost': '9', 'modal-note': '' };
const calls = [], messages = [];
let conflict = false;
const result = () => conflict ? { ok: false, status: 409, payload: { error: '版本冲突' } } : { ok: true, status: 200, payload: {} };
const ui = {
  document: { getElementById: id => ({ value: fields[id] }) },
  data: { positions: [] }, dataVersion: 3, currentAccount: '账户%', editingId: null,
  deleteTargetId: null, classifyCode: { normalizeCode: x => x }, uid: () => 'fixed-event', todayCN: () => '2026-10-28',
  showToast: text => messages.push(text), closeModal() {}, renderAll() {}, restorePriceChangeMap() {},
  window: {
    holdingsQuoteApi: {
      addPosition: async (account, version, event) => { calls.push({ type: 'event', account, version, event }); return result(); },
      updatePositionMetadata: async (id, version, body) => { calls.push({ type: 'metadata', id, version, body }); return result(); },
    },
    accountNavApi: { saveSettings: async (account, version, body) => { calls.push({ type: 'settings', account, version, body }); return result(); } },
  },
};
vm.createContext(ui);
vm.runInContext(save + '\n' + remove, ui);
const flush = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  ui.savePosition(); await flush();
  assert.strictEqual(calls.at(-1).event.direction, 'open');
  assert.strictEqual(calls.at(-1).event.id, 'fixed-event');
  assert.strictEqual(calls.at(-1).event.date, '2026-10-28', '持仓事件沿用上海业务日');
  assert.strictEqual(calls.at(-1).version, 3);
  ui.data.positions = [{ id: 'p1', code: '600000', name: '样本', quantity: 50, type: '股权', subtype: '沪市', price: 10 }];
  ui.editingId = 'p1';
  ui.savePosition(); await flush();
  assert.strictEqual(calls.at(-1).event.direction, 'adjust');
  assert.strictEqual(calls.at(-1).event.quantity, 100, '调整事件必须使用目标数量');
  assert.strictEqual(calls.at(-1).event.date, '2026-10-28', '持仓调整沿用上海业务日');
  ui.data.positions[0].quantity = 100;
  ui.savePosition(); await flush();
  assert.strictEqual(calls.at(-1).type, 'metadata');
  ui.editingId = 'cash';
  ui.savePosition(); await flush();
  assert.strictEqual(calls.at(-1).type, 'settings');
  assert.strictEqual(calls.at(-1).body.cashType, '股权');
  conflict = true;
  ui.deleteTargetId = 'p1';
  ui.confirmDelete(); await flush();
  assert.strictEqual(calls.at(-1).event.quantity, 0, '删除必须记录清仓调整');
  assert.strictEqual(calls.at(-1).event.date, '2026-10-28', '清仓事件沿用上海业务日');
  assert.strictEqual(calls.at(-1).event.id, 'fixed-event');
  assert.strictEqual(messages.at(-1), '版本冲突', '版本冲突不得报告清仓成功');
  console.log('持仓操作：新建、调整、元数据、现金与清仓冲突通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
