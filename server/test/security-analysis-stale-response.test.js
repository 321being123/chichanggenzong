const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const presenter = fs.readFileSync(path.join(root, 'public/js/presenters/stock-analysis-presenter.js'), 'utf8');
const statements = fs.readFileSync(path.join(root, 'public/js/stock-analysis-statements.js'), 'utf8');
const bond = fs.readFileSync(path.join(root, 'public/js/bond-analysis.js'), 'utf8');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));

(async () => {
  const snapshots = [], rendered = [], messages = [];
  let finishRefresh;
  const ui = {
    username: 'test', stockAnalysisState: { selected: 'A', stocks: [], selectToken: 1, loading: false },
    stockAnalysisApi: {
      requestRefresh: () => new Promise(resolve => { finishRefresh = resolve; }),
      getSnapshot: () => new Promise(resolve => snapshots.push(resolve)),
    },
    stockAnalysisApplyRemoveVisibility() {}, stockAnalysisShowContent() {}, stockAnalysisSwitchView() {},
    stockAnalysisSetRefreshButton() {}, stockAnalysisSetMessage: value => messages.push(value),
    stockAnalysisRender: value => rendered.push(value.tag), showToast() {},
  };
  vm.runInNewContext(extract(presenter, 'async function stockAnalysisSelect(', 'async function stockAnalysisAddWatchlist('), ui);
  const refresh = ui.stockAnalysisRefresh();
  const selectB = ui.stockAnalysisSelect('B');
  const selectA = ui.stockAnalysisSelect('A');
  snapshots[1]({ ok: true, status: 200, payload: { tag: 'new-A' } });
  await selectA;
  finishRefresh({ ok: true, status: 200, payload: { analysis: { tag: 'old-refresh' } } });
  await refresh;
  snapshots[0]({ ok: true, status: 200, payload: { tag: 'old-B' } });
  await selectB;
  assert.deepStrictEqual(rendered, ['new-A'], '旧刷新不能覆盖 A→B→A 的最新选择');
  const pendingStock = ui.stockAnalysisSelect('A');
  ui.stockAnalysisCancelSelection();
  snapshots[2]({ ok: true, status: 200, payload: { tag: 'stock-after-bond' } });
  await pendingStock;
  assert.deepStrictEqual(rendered, ['new-A'], '转债选择使先前股票请求失效');

  const pending = [], statementRendered = [];
  const statementUi = {
    stockAnalysisState: { selected: 'A', selectToken: 1 },
    document: { getElementById: () => null },
    stockAnalysisApi: { getStatements: () => new Promise(resolve => pending.push(resolve)) },
    stockAnalysisRenderStatements: value => statementRendered.push(value.tag),
  };
  vm.runInNewContext('var stockStatementState = { type: "balance", cache: {}, requestToken: 0 };\n' +
    extract(statements, 'async function stockAnalysisLoadStatements(', 'function stockAnalysisRenderStatements('), statementUi);
  const first = statementUi.stockAnalysisLoadStatements('balance');
  const second = statementUi.stockAnalysisLoadStatements('income');
  pending[1]({ ok: true, payload: { tag: 'income' } });
  await second;
  pending[0]({ ok: true, payload: { tag: 'balance-old' } });
  await first;
  assert.deepStrictEqual(statementRendered, ['income'], '旧三表响应不能覆盖新选择的报表');

  const bondPending = [], bondRendered = [];
  const bondUi = {
    securityAnalysisState: { type: 'bond', code: '113001', loading: false, requestToken: 1 },
    document: { getElementById: () => null }, username: 'test', showToast() {},
    stockAnalysisSetMessage() {}, bondAnalysisRender: data => bondRendered.push(data.tag),
    window: { siteApi: { request: () => new Promise(resolve => bondPending.push(resolve)) } },
  };
  vm.runInNewContext(extract(bond, 'async function bondAnalysisLoad(', 'async function bondAnalysisRenderListFallback('), bondUi);
  const oldBond = bondUi.bondAnalysisLoad(false, 'stock');
  bondUi.securityAnalysisState.requestToken++;
  bondUi.securityAnalysisState.loading = false;
  bondUi.securityAnalysisState.code = '113002';
  const newBond = bondUi.bondAnalysisLoad(false, 'stock');
  bondPending[1]({ ok: true, status: 200, payload: { tag: 'new-bond' } });
  await newBond;
  bondPending[0]({ ok: true, status: 200, payload: { tag: 'old-bond' } });
  await oldBond;
  assert.deepStrictEqual(bondRendered, ['new-bond'], '旧转债响应不能覆盖新选择');

  let finishFallback;
  const fallbackUi = {
    window: { siteApi: { get: () => new Promise(resolve => { finishFallback = resolve; }) } },
    stockAnalysisSetMessage() { throw new Error('旧结果不能渲染'); },
  };
  vm.runInNewContext(extract(bond, 'async function bondAnalysisRenderListFallback(', 'securityAnalysisInitSearch();'), fallbackUi);
  let current = true;
  const fallback = fallbackUi.bondAnalysisRenderListFallback('stock', '113001', () => current);
  current = false;
  finishFallback({ ok: true, payload: { data: [{ bond_code: '113001' }] } });
  assert.strictEqual(await fallback, false, '切换后不得显示旧转债列表兜底');
  console.log('证券分析旧响应隔离：股票刷新、财务报表及转债切换通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
