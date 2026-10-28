const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const bond = fs.readFileSync(path.join(root, 'public/js/bond-analysis.js'), 'utf8');
const stock = fs.readFileSync(path.join(root, 'public/js/presenters/stock-analysis-presenter.js'), 'utf8');
const slice = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end));
(async () => {
  let resolveBond, resolveStock;
  const select = { disabled: false, innerHTML: '旧账号持仓' };
  const ui = {
    username: 'same', accountIdentity: 'old',
    securityAnalysisState: { listLoaded: true }, stockAnalysisState: { loaded: true, stocks: [{ ts_code: 'old' }] },
    document: { getElementById: () => select },
    escapeHtml: String, stockAnalysisApplyRefreshAvailability() {}, stockAnalysisSetMessage() { throw Error('旧请求不应提示'); },
    window: { siteApi: { get: () => new Promise(resolve => { resolveBond = resolve; }) } },
    stockAnalysisApi: { listStocks: () => new Promise(resolve => { resolveStock = resolve; }) },
  };
  vm.createContext(ui);
  vm.runInContext(slice(bond, 'async function securityAnalysisLoadList(', 'function securityAnalysisSelect('), ui);
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
  console.log('证券列表：同名账号身份切换清除缓存并丢弃迟到响应');
})().catch(error => { console.error(error); process.exitCode = 1; });
