// 股票分析 Presenter（批次4：View／Presenter 分离）。
// 职责：持有选择与加载状态、每次选择领请求序号、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
//       页面打开只读本地快照，建立分析数据必须由用户明确点击「刷新数据」。
var stockAnalysisState = { loaded: false, stocks: [], selected: '', data: null, loading: false, selectToken: 0 };

async function loadStockAnalysis(force) {
  // 必须 await：加自选后要等下拉填充完成才能回选，否则 value 落在空列表上被重置
  if (window.securityAnalysisLoadList) await window.securityAnalysisLoadList(force);
  stockAnalysisApplyRefreshAvailability(!!username);
  if (!username) {
    stockAnalysisState.stocks = [];
    stockAnalysisState.loaded = true;
    return;
  }
  if (stockAnalysisState.loaded && !force) return;
  try {
    var listResult = await stockAnalysisApi.listStocks();
    if (!listResult.ok) throw new Error(listResult.payload.error || '股票列表加载失败');
    stockAnalysisState.stocks = listResult.payload.data || [];
    stockAnalysisState.loaded = true;
  } catch (error) { stockAnalysisSetMessage(error.message || String(error), true); }
}

async function stockAnalysisSelect(tsCode) {
  // 每次选择都领一个新序号。只比对 tsCode 无法区分 A→B→A：第一次 A 与第三次 A 同码，
  // 先发的旧 A 响应回来时仍满足 selected === tsCode，会把新 A 的结果覆盖成旧数据。
  var selectToken = (stockAnalysisState.selectToken || 0) + 1;
  stockAnalysisState.selectToken = selectToken;
  stockAnalysisState.selected = tsCode || '';
  stockAnalysisState.data = null;
  if (typeof stockAnalysisSwitchView === 'function') stockAnalysisSwitchView('analysis');
  var row = stockAnalysisState.stocks.find(function (item) { return item.ts_code === tsCode; });
  stockAnalysisApplyRemoveVisibility(!!(row && row.watchlisted));
  if (!tsCode) {
    stockAnalysisSetMessage('从持仓或自选股中选择一只股票开始分析。');
    stockAnalysisShowContent(false);
    return;
  }
  stockAnalysisSetMessage('正在读取分析结果...');
  try {
    var snapshotResult = await stockAnalysisApi.getSnapshot(tsCode);
    // 迟到的响应不得覆盖当前选择：按序号判定，覆盖 A→B→A 这类同码重选
    if (stockAnalysisState.selectToken !== selectToken) return;
    if (snapshotResult.status === 404) {
      if (!username) return stockAnalysisSetMessage('该股票暂未建档，登录后可刷新并建立分析数据。');
      // 页面打开只读本地快照；建立分析数据必须由用户明确点击“刷新数据”。
      return stockAnalysisSetMessage('该股票暂无分析快照，请点击“刷新数据”建立。');
    }
    var payload = snapshotResult.payload;
    if (stockAnalysisState.selectToken !== selectToken) return;
    if (!snapshotResult.ok) throw new Error(payload.error || '分析读取失败');
    if (payload.needs_refresh) {
      var reasons = payload.freshness && payload.freshness.reasons ? payload.freshness.reasons.map(function (r) { return r.message; }).join('；') : '数据待更新';
      // 页面打开只读本地快照；外部采集必须由用户明确点击“刷新数据”触发。
      showToast('数据待更新：' + reasons);
    }
    stockAnalysisRender(payload);
  } catch (error) {
    if (stockAnalysisState.selectToken !== selectToken) return;
    stockAnalysisSetMessage(error.message || String(error), true);
  }
}

function stockAnalysisCancelSelection() {
  stockAnalysisState.selectToken = (stockAnalysisState.selectToken || 0) + 1;
  stockAnalysisState.selected = '';
  stockAnalysisState.data = null;
}

async function stockAnalysisRefresh() {
  var tsCode = stockAnalysisState.selected;
  if (!tsCode || stockAnalysisState.loading) return;
  if (!username) return stockAnalysisSetMessage('登录后可刷新并建立分析数据。');
  var selectToken = stockAnalysisState.selectToken;
  stockAnalysisState.loading = true;
  stockAnalysisSetRefreshButton(true, '刷新中...');
  stockAnalysisSetMessage('正在提交股票刷新任务...');
  try {
    if (typeof stockAnalysisInvalidateStatements === 'function') stockAnalysisInvalidateStatements(tsCode);
    var refreshResult = await stockAnalysisApi.requestRefresh(tsCode);
    var payload = refreshResult.payload;
    var analysis = payload.analysis;
    if (!refreshResult.ok && !analysis) throw new Error(payload.error || '刷新失败');
    // 刷新期间切换了股票则丢弃过期结果，避免旧股渲染覆盖当前选择
    var stillCurrent = stockAnalysisState.selected === tsCode && stockAnalysisState.selectToken === selectToken;
    if (analysis && stillCurrent) stockAnalysisRender(analysis);
    if (refreshResult.status === 202) {
      if (!payload.queued || !payload.queued.queued) throw new Error(payload.warning || '未能登记刷新任务，请稍后重试');
      if (stillCurrent) stockAnalysisSetMessage('已加入后台刷新队列，完成后重新查询该股票即可查看。首次建档需要采集历史财报，请稍候。');
    }
    if (!refreshResult.ok && payload.error && stillCurrent) showToast('刷新失败，已显示上一份有效数据：' + payload.error);
  } catch (error) {
    if (stockAnalysisState.selected === tsCode && stockAnalysisState.selectToken === selectToken) stockAnalysisSetMessage(error.message || String(error), true);
  } finally {
    stockAnalysisState.loading = false;
    stockAnalysisSetRefreshButton(false, '刷新数据');
  }
}

async function stockAnalysisAddWatchlist() {
  var code = stockAnalysisReadCodeInput();
  if (!code) return showToast('请输入股票代码');
  stockAnalysisSetMessage('正在添加自选股并建立财务档案...');
  try {
    var addResult = await stockAnalysisApi.addWatchlist(code);
    var payload = addResult.payload;
    if (!addResult.ok && addResult.status !== 202) throw new Error(payload.error || '添加失败');
    stockAnalysisState.loaded = false;
    await loadStockAnalysis(true);
    stockAnalysisState.selected = payload.stock.ts_code;
    // 下拉 option 的 value 是六位纯数字，ts_code 带后缀（如 600000.SH）需由 View 截取
    stockAnalysisSelectOption(payload.stock.ts_code);
    stockAnalysisApplyRemoveVisibility(true);
    stockAnalysisClearCodeInput();
    if (payload.analysis) stockAnalysisRender(payload.analysis); else await stockAnalysisSelect(payload.stock.ts_code);
    if (payload.warning) showToast('已加入自选，建档稍后重试：' + payload.warning);
  } catch (error) { stockAnalysisSetMessage(error.message || String(error), true); }
}

async function stockAnalysisRemoveWatchlist() {
  if (!stockAnalysisState.selected) return;
  try {
    var removeResult = await stockAnalysisApi.removeWatchlist(stockAnalysisState.selected);
    if (!removeResult.ok) throw new Error(removeResult.payload.error || '删除失败');
    stockAnalysisState.loaded = false;
    stockAnalysisState.selected = '';
    stockAnalysisState.data = null;
    await loadStockAnalysis(true);
    stockAnalysisSelect('');
    showToast('已移出自选股');
  } catch (error) { showToast(error.message || String(error)); }
}
