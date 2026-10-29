const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const trade = fs.readFileSync(path.join(root, 'public/shared/core-trade.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const apiClient = fs.readFileSync(path.join(root, 'public/js/api/client.js'), 'utf8');
const part = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const helpers = part(trade, 'var _visionQueue =', 'function newSmartRowId()');
const flush = () => new Promise(resolve => setImmediate(resolve));

function context() {
  const ui = {
    username: 'user', accountIdentity: 'identity-1', currentAccount: '同名账户',
    _qrGeneration: 0, _qrPollTimer: null, _qrToken: null, _visionPaused: false,
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    renderVisionQueue() {}, renderSmartItems() {}, clearCompletedVisionBatch() {}, setSmartButtonsDisabled() {}, clearInterval() {},
  };
  ui.window = ui;
  vm.createContext(ui);
  vm.runInContext(apiClient, ui);
  vm.runInContext(helpers, ui);
  return ui;
}

(async () => {
  const ui = context(), pending = [], accepted = [];
  ui.api = x => x;
  ui.fetch = () => new Promise(resolve => pending.push(resolve));
  ui.mergeSmartItems = items => accepted.push(items[0].tag);
  ui.showToast = () => {};
  ui._visionProcessing = false; ui._visionProcessingGeneration = null; ui._visionPaused = false;
  vm.runInContext(part(trade, 'async function processVisionQueue()', 'function resumeVisionQueue()'), ui);
  ui.bindSmartImportScope();
  ui._visionQueue.push({ status: 'queued', base64: 'old', name: '旧图' });
  const old = ui.processVisionQueue();
  ui.accountIdentity = 'identity-2';
  ui.invalidateSmartImportScope(); ui.bindSmartImportScope();
  ui._visionQueue.push({ status: 'queued', base64: 'new', name: '新图' });
  const fresh = ui.processVisionQueue();
  pending[1]({ ok: true, status: 200, json: async () => ({ items: [{ tag: 'new' }] }) });
  await fresh;
  pending[0]({ ok: true, status: 200, json: async () => ({ items: [{ tag: 'old' }] }) });
  await old;
  assert.deepStrictEqual(accepted, ['new'], '同名新账号不得接收旧识别结果');
  assert.strictEqual(ui._visionQueue.length, 1, '旧响应不得清空新队列');

  const removed = context(), requests = [], merged = [];
  removed.api = x => x;
  removed.fetch = () => new Promise(resolve => requests.push(resolve));
  removed.mergeSmartItems = (items, tag) => merged.push([items[0].tag, tag]);
  removed.showToast = () => {};
  removed._visionProcessing = false; removed._visionProcessingGeneration = null;
  vm.runInContext(part(trade, 'async function processVisionQueue()', 'function resumeVisionQueue()'), removed);
  removed.bindSmartImportScope();
  const deletedImage = {imageId:'deleted', status:'queued', base64:'one'};
  const keptImage = {imageId:'kept', status:'queued', base64:'two'};
  removed._visionQueue.push(deletedImage, keptImage);
  const running = removed.processVisionQueue();
  removed._visionQueue.splice(0, 1);
  requests[0]({ok:true, status:200, json:async()=>({items:[{tag:'deleted'}]})});
  await flush();
  assert.strictEqual(requests.length, 2, '删除在途图片不能跳过下一张');
  requests[1]({ok:true, status:200, json:async()=>({items:[{tag:'kept'}]})});
  await running;
  assert.deepStrictEqual(merged, [['kept','kept']], '已删除图片的迟到结果不得进入预览，来源使用 imageId');

  const files = context(); let finishFile;
  files.fileToBase64 = () => new Promise(resolve => { finishFile = resolve; });
  files.processVisionQueue = () => {};
  files.showToast = () => {};
  vm.runInContext(part(trade, 'function enqueueVisionFiles(', '// 并发固定 1'), files);
  files.enqueueVisionFiles([{ type: 'image/png', size: 10, name: '旧图' }]);
  files.currentAccount = '另一账户'; files.invalidateSmartImportScope();
  files.currentAccount = '同名账户'; files.invalidateSmartImportScope(); files.bindSmartImportScope();
  files._visionQueue.push({ name: '新图' });
  finishFile('data:image/png;base64,AA=='); await flush();
  assert.deepStrictEqual(Array.from(files._visionQueue, x => x.name), ['新图'], 'A→B→A 迟到文件读取不得进入新批次');

  const capacity = context(), fileReads = [];
  capacity.fileToBase64 = () => new Promise(resolve => fileReads.push(resolve));
  capacity.processVisionQueue = () => {}; capacity.showToast = () => {};
  vm.runInContext(part(trade, 'function enqueueVisionFiles(', '// 并发固定 1'), capacity);
  capacity.bindSmartImportScope();
  capacity.enqueueVisionFiles(Array.from({length: 4}, (_, i) => ({type:'image/png', size:10, name:'a'+i})));
  capacity.enqueueVisionFiles(Array.from({length: 4}, (_, i) => ({type:'image/png', size:10, name:'b'+i})));
  fileReads.forEach((resolve, i) => resolve('data:image/png;base64,' + i));
  await flush();
  assert.strictEqual(capacity._visionQueue.length, 6, '并发读取完成时仍必须执行六张上限');

  const excel = context(); let finishExcel, excelRequests = 0;
  excel.fileToBase64 = () => new Promise(resolve => { finishExcel = resolve; });
  excel.fetch = () => { excelRequests++; throw new Error('旧文件不应发送'); };
  vm.runInNewContext(part(trade, 'async function doSmartParse(', '// 识别为空/失败时的可操作指引'), excel);
  const readingExcel = excel.doSmartParse({ name: '旧表' }, 'excel');
  excel.accountIdentity = 'identity-2'; excel.invalidateSmartImportScope();
  finishExcel('old-file'); await readingExcel;
  assert.strictEqual(excelRequests, 0, '切换账号后迟到的文件读取不得发起识别');

  const qr = context(); let finishQr, intervals = 0;
  qr.api = x => x; qr.fetch = () => new Promise(resolve => { finishQr = resolve; });
  qr.setInterval = () => { intervals++; return 1; }; qr.setQrStatus = () => {};
  qr._qrPollTimer = null; qr._qrToken = null; qr._qrGeneration = 0;
  vm.runInContext(part(trade, 'function initVisionQr()', 'function stopVisionQr()'), qr);
  qr.initVisionQr();
  qr.accountIdentity = 'identity-2'; qr.invalidateSmartImportScope();
  finishQr({ json: async () => ({ token: 'old-token', qr: 'old-qr' }) });
  await flush();
  assert.strictEqual(intervals, 0, '旧二维码响应不得启动新账号轮询');

  const poll = context(); let pollCallback, finishPoll, enqueued = 0;
  poll.api = x => x; poll.setQrStatus = () => {}; poll.enqueueBase64Images = () => { enqueued++; };
  poll.setInterval = callback => { pollCallback = callback; return 2; };
  poll.fetch = url => url.includes('vision-token') ? Promise.resolve({ json: async () => ({ token: 't', qr: '' }) })
    : new Promise(resolve => { finishPoll = resolve; });
  vm.runInContext(part(trade, 'function initVisionQr()', 'function stopVisionQr()'), poll);
  poll.initVisionQr(); await flush(); pollCallback();
  poll.currentAccount = '另一账户'; poll.invalidateSmartImportScope();
  finishPoll({ json: async () => ({ images: ['old-image'] }) }); await flush();
  assert.strictEqual(enqueued, 0, '切换账户后旧扫码轮询不得恢复图片');

  const verify = context();
  verify.data = { positions: [], trades: [{ id: 'stale' }] };
  verify.applyLedgerData = value => { verify.data = value; };
  verify.window.tradeLedgerApi = { accountData: async () => ({ ok: true, payload: { positions: [], trades: [] } }) };
  vm.runInContext(part(trade, 'async function verifySmartEventsSaved(', '// 交易单行提交'), verify);
  assert.strictEqual((await verify.verifySmartEventsSaved(['stale'])).all, false, '服务端无该事件时不得使用旧缓存误报成功');
  verify.window.tradeLedgerApi.accountData = async () => ({ ok: true, payload: { positions: [], trades: [{ id: 'real' }] } });
  assert.strictEqual((await verify.verifySmartEventsSaved(['real'])).all, true, '服务端顶层交易列表应支持核对');
  let finishVerify;
  verify.window.tradeLedgerApi.accountData = () => new Promise(resolve => { finishVerify = resolve; });
  const oldVerify = verify.verifySmartEventsSaved(['real']);
  verify.accountIdentity = 'identity-2'; verify.invalidateSmartImportScope();
  const newAccountData = { positions: [{ code: 'new' }], trades: [] }; verify.data = newAccountData;
  finishVerify({ ok: true, payload: { positions: [], trades: [{ id: 'real' }] } });
  assert.strictEqual((await oldVerify).all, false);
  assert.strictEqual(verify.data, newAccountData, '旧账号事件核对不得写入新账号');

  const submit = context(); let finishSubmit, submittedEvents;
  submit.data = { positions: [], trades: [] }; submit.dataVersion = 1;
  submit.convertRowUnit = () => {}; submit.recognizeCode = () => ({ type: '股权', subtype: '沪市' });
  submit.applyLedgerData = value => { submit.data = value; }; submit.renderAll = () => {};
  submit.window.holdingsQuoteApi = { addPositions: (_account, _version, events) => { submittedEvents = events; return new Promise(resolve => { finishSubmit = resolve; }); } };
  vm.runInContext(part(trade, 'async function submitPositionRows(', 'function removeSmartRows('), submit);
  const submission = submit.submitPositionRows([{ code: '600000', price: 10, quantity: 1, date: '2026-10-01', _item: { _eventId: 'id' } }]);
  assert.strictEqual(submittedEvents[0].date, '2026-10-01', '跨账号提交仍保留确认日期');
  submit.accountIdentity = 'identity-2'; submit.invalidateSmartImportScope();
  const newData = { positions: [{ code: 'new' }], trades: [] }; submit.data = newData;
  finishSubmit({ ok: true, status: 200, payload: { data: { positions: [{ code: 'old' }], trades: [] } } });
  assert.strictEqual((await submission).status, 'scope_changed');
  assert.strictEqual(submit.data, newData, '旧账户提交响应不得覆盖新账户');

  const tradeSubmit = context(); let finishTrade;
  tradeSubmit.data = { positions: [], trades: [] }; tradeSubmit.dataVersion = 1;
  tradeSubmit.classifyCode = { normalizeCode: x => x }; tradeSubmit.normalizeQuantity = n => n;
  tradeSubmit.recognizeCode = () => ({ type: '股权', subtype: '沪市' }); tradeSubmit.uid = () => 'trade-id';
  tradeSubmit.calcTradeFees = () => ({ commission: 0, stamp_tax: 0, transfer_fee: 0, other_fee: 0 });
  tradeSubmit.applyLedgerData = value => { tradeSubmit.data = value; }; tradeSubmit.renderAll = () => {};
  tradeSubmit.window.tradeLedgerApi = { addTrade: () => new Promise(resolve => { finishTrade = resolve; }) };
  vm.runInNewContext(part(trade, 'async function addTradeInternal(', '// ===================== 税费设置'), tradeSubmit);
  const pendingTrade = tradeSubmit.addTradeInternal('600000', '样本', 'buy', 10, 1, '2026-10-01');
  tradeSubmit.accountIdentity = 'identity-2'; tradeSubmit.invalidateSmartImportScope();
  const newTradeData = { positions: [{ code: 'new' }], trades: [] }; tradeSubmit.data = newTradeData;
  finishTrade({ ok: true, status: 200, payload: { data: { positions: [{ code: 'old' }], trades: [] } } });
  assert.strictEqual((await pendingTrade).status, 'scope_changed');
  assert.strictEqual(tradeSubmit.data, newTradeData, '旧交易响应不得覆盖新账号');

  const queue = context(); let finishRow, submitted = 0;
  queue.bindSmartImportScope();
  queue._smartParsed = [{ _rowId: 'r1' }, { _rowId: 'r2' }];
  queue.syncAllSmartRowsFromDom = () => {}; queue.collectSmartConflicts = () => [];
  queue.revalidateSmartRow = () => ({ status: 'ok' }); queue.readSmartRow = id => ({ rowId: id, kind: 'trade' });
  queue.submitTradeRow = () => { submitted++; return new Promise(resolve => { finishRow = resolve; }); };
  queue.removeSmartRows = () => { throw new Error('旧提交不得修改新预览'); }; queue.showToast = () => {};
  vm.runInContext(part(trade, 'async function confirmAllSmartItems()', 'function posRowsCountable('), queue);
  const batch = queue.confirmAllSmartItems();
  queue.currentAccount = '另一账户'; queue.invalidateSmartImportScope();
  queue._smartParsed = [{ _rowId: 'new' }]; queue._smartSubmitting = true;
  finishRow({ status: 'saved' }); await batch;
  assert.strictEqual(submitted, 1, '切换账户后不得继续提交旧批次');
  assert.strictEqual(queue._smartParsed[0]._rowId, 'new');
  assert.strictEqual(queue._smartSubmitting, true, '旧提交不得解除新批次状态');

  const pendingLoads = [];
  const load = { data: { positions: [], trades: [], cashFlows: [] }, currentAccount: 'A', username: 'user', accountIdentity: 'id',
    api: value => value, fetch: () => new Promise((resolve, reject) => pendingLoads.push({ resolve, reject })), fetchUnifiedHKRate: async () => 1,
    priceChangeMap: {}, previousPriceMap: {}, TOTAL_ASSET: 0, classifyCode: () => null };
  load.window = load;
  vm.createContext(load);
  vm.runInContext(apiClient, load);
  vm.runInContext(part(html, 'var accountLoadSequence = 0;', 'var dataVersion = 0;'), load);
  const first = load.loadData('A'); load.currentAccount = 'B'; const middle = load.loadData('B');
  load.currentAccount = 'A'; const last = load.loadData('A');
  const accountData = tag => ({ tag, positions: [], trades: [], navHistory: [], cashFlows: [] });
  pendingLoads[2].resolve({ json: async () => accountData('new-A') }); await last;
  pendingLoads[0].resolve({ json: async () => accountData('old-A') }); await first;
  pendingLoads[1].resolve({ json: async () => accountData('old-B') }); await middle;
  assert.strictEqual(load.data.tag, 'new-A', '账户 A→B→A 的旧数据不得覆盖最新加载');
  const oldError = load.loadData('A'); load.currentAccount = 'B'; const newB = load.loadData('B');
  pendingLoads[4].resolve({ json: async () => accountData('new-B') }); await newB;
  pendingLoads[3].reject(new Error('旧请求失败')); await oldError;
  assert.strictEqual(load.data.tag, 'new-B', '旧请求失败不得清空新账户数据');
  load.currentAccount = 'A'; let finishRate;
  load.fetchUnifiedHKRate = () => new Promise(resolve => { finishRate = resolve; });
  const oldRate = load.loadData('A');
  pendingLoads[5].resolve({ json: async () => accountData('old-rate') }); await flush();
  load.currentAccount = 'B'; load.fetchUnifiedHKRate = async () => 1;
  const afterRate = load.loadData('B');
  pendingLoads[6].resolve({ json: async () => accountData('after-rate') }); await afterRate;
  finishRate(0.5); await oldRate;
  assert.strictEqual(load.data.tag, 'after-rate', '旧汇率响应不得改变新账户数据');
  assert.strictEqual(load.data.hkRate, 1);

  const accountSource = fs.readFileSync(path.join(root, 'public/shared/core-account.js'), 'utf8');
  let invalidations = 0;
  const switching = { currentAccount: 'A', data: { positions: [] }, priceChangeMap: {},
    window: { invalidateSmartImportScope: () => { invalidations++; } },
    loadData: async () => ({ positions: [] }), renderAccountSelect() {}, renderAll() {}, showToast() {}, doAutoRefresh() {} };
  vm.runInNewContext(part(accountSource, 'async function switchAccount(', 'let accountIsNew'), switching);
  await switching.switchAccount('B'); await switching.switchAccount('A');
  assert.strictEqual(invalidations, 2, '账户 A→B→A 每次切换都必须使旧导入失效');

  const sessionPresenter = fs.readFileSync(path.join(root, 'public/js/presenters/session-presenter.js'), 'utf8');
  let identityInvalidations = 0;
  const auth = { username: 'user', accountIdentity: 'old', myProfile: null,
    api: value => value, fetch: async () => ({ json: async () => ({ username: 'user', accountIdentity: 'new' }) }),
    document: { getElementById: () => null },
    window: {
      invalidateSmartImportScope: () => { identityInvalidations++; },
      siteApi: { requestRaw: async () => ({ response: { ok: true, status: 200, json: async () => ({ username: 'user', accountIdentity: 'new' }) } }) },
      stopNotificationPolling() {}, clearNotificationCache() {}, renderTopUser() {}, startNotificationPolling() {}, renderAuthUser() {},
    } };
  vm.runInNewContext(part(sessionPresenter, 'async function checkAuth()', 'async function logout()'), auth);
  await auth.checkAuth();
  assert.strictEqual(identityInvalidations, 1, '同名重建账号身份变化必须清除旧导入');

  let modeInvalidations = 0;
  const mode = { tradeMode: 'smart', document: { getElementById: () => ({ classList: { toggle() {}, remove() {} }, style: {} }) },
    invalidateSmartImportScope: () => { modeInvalidations++; }, initVisionQr() {}, stopVisionQr() {} };
  vm.runInNewContext(part(trade, 'function switchTradeMode(', '// ===================== 智能导入'), mode);
  mode.switchTradeMode('manual');
  assert.strictEqual(modeInvalidations, 1, '切换手动录入必须使旧导入失效');

  const earnings = fs.readFileSync(path.join(root, 'public/shared/core-earnings.js'), 'utf8');
  let subnavInvalidations = 0, subnavClick;
  const tab = { dataset: { page: 'dashboard' }, classList: { add() {}, remove() {} }, addEventListener: (_type, fn) => { subnavClick = fn; } };
  const subnav = { window: { invalidateSmartImportScope: () => { subnavInvalidations++; } },
    document: { querySelectorAll: selector => selector === '.nav-tab' ? [tab] : [],
      getElementById: id => id === 'page-trades' ? { classList: { contains: () => true } } : null } };
  vm.runInNewContext(part(earnings, 'function initNav()', '// ===================== 版本记录'), subnav);
  subnav.initNav(); subnavClick();
  assert.strictEqual(subnavInvalidations, 1, '离开交易二级页必须使旧导入失效');

  const navigation = fs.readFileSync(path.join(root, 'public/js/navigation.js'), 'utf8');
  let mainInvalidations = 0;
  const active = { classList: { contains: () => true, add() {}, remove() {} } };
  const mainNav = { username: 'user', window: { invalidateSmartImportScope: () => { mainInvalidations++; } },
    document: { querySelectorAll: () => [], getElementById: id => ['main-holdings', 'page-trades'].includes(id) ? active : null },
    loadHomeDashboard() {}, showToast() {} };
  vm.runInNewContext(part(navigation, 'function switchMain(', 'function setupMainNav()'), mainNav);
  await mainNav.switchMain('home', true);
  assert.strictEqual(mainInvalidations, 1, '离开持仓主管理页必须使旧导入失效');
  console.log('智能导入身份隔离：识别、文件、扫码、提交和账户加载通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
