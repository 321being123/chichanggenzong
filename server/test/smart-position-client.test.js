const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/shared/core-trade.js'), 'utf8');
const verify = source.slice(source.indexOf('async function verifySmartEventsSaved('), source.indexOf('// 交易单行提交'));
const submit = source.slice(source.indexOf('async function submitPositionRows('), source.indexOf('function removeSmartRows('));
let mode = 'success', saved = [], sent = [];
const ui = {
  currentAccount: '账户%', dataVersion: 3, data: { positions: [], trades: [] },
  convertRowUnit() {}, recognizeCode: () => ({ type: '股权', subtype: '沪市' }), renderAll() {},
  applyLedgerData(value) { if (value) ui.data = value; },
  window: { _smartBatchId: 'batch-test', holdingsQuoteApi: { addPositions: async (_account, _version, events) => {
    sent = events;
    if (mode === 'network') throw new Error('网络故障');
    return mode === 'conflict' ? { ok: false, status: 409, payload: { error: '版本冲突' } }
      : { ok: true, status: 200, payload: {} };
  } }, tradeLedgerApi: { accountData: async () => ({ ok: true, status: 200,
    payload: { data: { positions: [], trades: saved.map(id => ({ id })) } } }) } },
};
vm.createContext(ui);
vm.runInContext(verify + '\n' + submit, ui);
function rows() { return [
  { code: '600000', name: '样本', price: 10, quantity: 200, date: '2026-10-02', _item: { _eventId: 'later' } },
  { code: '600000', name: '样本', price: 10, quantity: 100, date: '2026-10-01', _item: { _eventId: 'earlier' } },
]; }

(async () => {
  let result = await ui.submitPositionRows(rows());
  assert.strictEqual(result.status, 'saved');
  assert.strictEqual(sent[0].direction, 'adjust');
  assert.strictEqual(sent[1].direction, 'open', '同证券最早日期必须建仓');
  assert.strictEqual(sent[0].id, 'later');
  assert.strictEqual(sent[1].date, '2026-10-01', '批量持仓保留用户确认日期');
  mode = 'conflict'; saved = ['later', 'earlier'];
  result = await ui.submitPositionRows(rows());
  assert.strictEqual(result.status, 'saved', '只有整组 ID 已保存才可认定成功');
  saved = ['later'];
  result = await ui.submitPositionRows(rows());
  assert.strictEqual(result.status, 'conflict', '部分 ID 不得认定整批成功');
  assert.strictEqual((await ui.verifySmartEventsSaved([])).all, false);
  mode = 'network'; saved = [];
  result = await ui.submitPositionRows(rows());
  assert.strictEqual(result.status, 'unknown', '网络异常且未查到 ID 应保留待确认');
  console.log('批量持仓：日期顺序、原 ID、整组核对和网络失败通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
