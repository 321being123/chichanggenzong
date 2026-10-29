const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const code = fs.readFileSync(path.join(root, 'public/shared/core-trade.js'), 'utf8');
const section = (a, b) => code.slice(code.indexOf(a), code.indexOf(b));
const ui = {
  _smartParsed: [], _visionQueue: [], _visionProcessing: false, _visionClearWhenComplete: false,
  CoreDate: require('../../public/shared/core-date'), classifyCode: { normalizeCode: x => x },
  newSmartRowId: (() => { let n = 0; return () => 'r' + ++n; })(), uid: () => 'event',
  renderVisionQueue() {}, renderSmartItems() {}
};
ui.window = ui;
vm.createContext(ui);
vm.runInContext(section('function smartMergeKey(', '// 手机扫码传来的图片'), ui);
vm.runInContext(section('function clearCompletedVisionBatch()', '// 用户主动排除行'), ui);
const item = {kind:'position', code:'000001', date:'', _v:{status:'blocked', issues:[{field:'date',level:'error',message:'缺日期'},{field:'currency',level:'warn',message:'待核对'}]}};
ui.mergeSmartItems([item], 'image-id');
assert.strictEqual(item.date, ui.CoreDate.todayInZone('Asia/Shanghai'));
assert.strictEqual(item._v.status, 'review');
assert.strictEqual(item._v.issues.length, 1);
assert.strictEqual(item._imageTags[0], 'image-id');
assert.strictEqual(ui.normalizeSmartDate('2026/10/9'), '2026-10-09');
const bad = {kind:'position', code:'000002', date:'2026-02-30'};
ui.mergeSmartItems([bad], 'image-2');
assert.strictEqual(bad.date, '');
assert.strictEqual(bad._v.status, 'blocked');
const trade = {kind:'trade', code:'000003', date:''};
ui.mergeSmartItems([trade], 'image-3');
assert.strictEqual(trade.date, '');
assert.strictEqual(trade._v.status, 'blocked');
ui._smartParsed = [{_rowId:'r1'}]; ui._visionQueue = [{status:'done'}];
ui.removeSmartRows(['r1'], true);
assert.strictEqual(ui._visionQueue.length, 0, '全部保存后清空完成图片');
ui._smartParsed = [{_rowId:'r2'}]; ui._visionQueue = [{status:'failed'}];
ui.removeSmartRows(['r2'], true);
assert.strictEqual(ui._visionQueue.length, 1, '失败图片必须保留');
ui._smartParsed = [{_rowId:'r3'}]; ui._visionQueue = [{status:'done'}]; ui._visionClearWhenComplete = false;
ui.removeSmartRows(['r3'], false);
assert.strictEqual(ui._visionQueue.length, 1, '手动排除行不得伪装为全部保存');
console.log('智能导入反馈：日期、状态、图片来源和批次清理通过');
