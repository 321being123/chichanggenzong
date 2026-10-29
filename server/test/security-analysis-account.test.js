const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const bond = fs.readFileSync(path.join(root, 'public/js/bond-analysis.js'), 'utf8');
// 批次4：securityAnalysisLoadList 取数/请求序号已拆入 Presenter，断言跟随代码分别切片 View 与 Presenter。
const bondPresenter = fs.readFileSync(path.join(root, 'public/js/presenters/bond-analysis-presenter.js'), 'utf8');
const stock = fs.readFileSync(path.join(root, 'public/js/presenters/stock-analysis-presenter.js'), 'utf8');
const slice = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end));
(async () => {
  let resolveBond, resolveStock;
  const select = { disabled: false, innerHTML: '旧账号持仓' };
  const ui = {
    username: 'same', accountIdentity: 'old',
    securityAnalysisState: { listLoaded: true }, stockAnalysisState: { loaded: true, stocks: [{ ts_code: 'old' }] },
    document: { getElementById: () => select },
    stockAnalysisCancelSelection() {}, stockAnalysisApplyRemoveVisibility() {},
    escapeHtml: String, stockAnalysisApplyRefreshAvailability() {}, stockAnalysisSetMessage() { throw Error('旧请求不应提示'); },
    window: { siteApi: { get: () => new Promise(resolve => { resolveBond = resolve; }) } },
    stockAnalysisApi: { listStocks: () => new Promise(resolve => { resolveStock = resolve; }) },
  };
  vm.createContext(ui);
  vm.runInContext(slice(bondPresenter, 'async function securityAnalysisLoadList(', 'function securityAnalysisSelect('), ui);
  vm.runInContext(slice(bond, 'function securityAnalysisResetAccount(', 'function bondAnalysisText('), ui);
  vm.runInContext(slice(stock, 'async function loadStockAnalysis(', 'async function stockAnalysisSelect('), ui);
  const pendingBond = ui.securityAnalysisLoadList(true);
  const pendingStock = ui.loadStockAnalysis(true);
  ui.accountIdentity = 'new';
  ui.securityAnalysisResetAccount();
  assert.strictEqual(ui.stockAnalysisState.stocks.length, 0);
  assert(!select.innerHTML.includes('旧账号持仓'));
  resolveBond({ ok: true, payload: { data: [{ code: 'old', name: '旧账号' }] } });
  resolveStock({ ok: true, payload: { data: [{ ts_code: 'old' }] } });
  await Promise.all([pendingBond, pendingStock]);
  assert(!select.innerHTML.includes('旧账号'));
  assert.strictEqual(ui.securityAnalysisState.listLoaded, false);
  assert.strictEqual(ui.stockAnalysisState.loaded, false);
  assert.strictEqual(ui.stockAnalysisState.stocks.length, 0);
  let resolveAdd, resolveRemove;
  const messages = [];
  const writes = {
    username: 'same', accountIdentity: 'old', stockAnalysisState: { selected: '600000', accountEpoch: 0 },
    stockAnalysisReadCodeInput: () => '600000', stockAnalysisSetMessage: value => messages.push(value),
    showToast: value => messages.push(value), loadStockAnalysis() { throw Error('旧操作不能读取新账号'); },
    stockAnalysisApi: {
      addWatchlist: () => new Promise(resolve => { resolveAdd = resolve; }),
      removeWatchlist: () => new Promise(resolve => { resolveRemove = resolve; }),
    },
  };
  vm.createContext(writes);
  vm.runInContext(stock.slice(stock.indexOf('async function stockAnalysisAddWatchlist(')), writes);
  const add = writes.stockAnalysisAddWatchlist();
  const remove = writes.stockAnalysisRemoveWatchlist();
  writes.accountIdentity = 'new';
  writes.stockAnalysisState.accountEpoch++;
  resolveAdd({ ok: true, payload: { stock: { ts_code: '600000' } } });
  resolveRemove({ ok: true, payload: {} });
  await Promise.all([add, remove]);
  assert.strictEqual(writes.stockAnalysisState.selected, '600000');
  assert.deepStrictEqual(messages, ['正在添加自选股并建立财务档案...']);
  console.log('证券列表：同名账号身份切换清除缓存并丢弃迟到响应');
})().catch(error => { console.error(error); process.exitCode = 1; });
