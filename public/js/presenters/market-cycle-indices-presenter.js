// 市场周期「常见指数」Presenter（View / Presenter 分离，allowDom = false）。
// 职责：管理 10 大常见指数的概览、周期切换、选中指数、历史曲线模式与日期区间状态。
var mviState = {
  period: '1d',
  selectedCode: '000300.SH',
  mode: 'close',
  range: '10y',
  customStart: null,
  customEnd: null,
  overview: null,
  historyCache: Object.create(null),
  loading: false,
  historyLoading: false,
  seq: 0,
  historySeq: 0,
};

async function loadMarketCycleIndices(force) {
  if (typeof mviInit === 'function') mviInit();
  if (mviState.overview && !force) {
    if (typeof mviRender === 'function') mviRender();
    if (!mviState.historyCache[mviState.selectedCode]) {
      await loadMarketCycleIndexHistory(mviState.selectedCode);
    }
    return;
  }
  if (mviState.loading) return;
  mviState.loading = true;
  var seq = ++mviState.seq;
  if (typeof mviSetStatus === 'function') mviSetStatus('正在读取常见指数数据...');
  try {
    var res = await window.siteApi.get('/api/market-volatility/indices/overview');
    if (seq !== mviState.seq) return;
    if (!res.ok) throw new Error('接口返回 ' + res.status);
    mviState.overview = res.payload || { asOfDate: null, indices: [] };
    if (typeof mviRender === 'function') mviRender();
    await loadMarketCycleIndexHistory(mviState.selectedCode);
  } catch (e) {
    if (seq === mviState.seq && typeof mviSetLoadError === 'function') {
      mviSetLoadError(e);
    }
  } finally {
    if (seq === mviState.seq) mviState.loading = false;
  }
}

async function loadMarketCycleIndexHistory(code) {
  var targetCode = code || mviState.selectedCode || '000300.SH';
  mviState.selectedCode = targetCode;
  if (mviState.historyCache[targetCode]) {
    if (typeof mviRenderChartSection === 'function') mviRenderChartSection();
    return;
  }
  var seq = ++mviState.historySeq;
  mviState.historyLoading = true;
  if (typeof mviRenderChartSection === 'function') mviRenderChartSection();
  try {
    var res = await window.siteApi.get('/api/market-volatility/indices/history?code=' + encodeURIComponent(targetCode));
    if (seq !== mviState.historySeq) return;
    if (!res.ok) throw new Error('接口返回 ' + res.status);
    mviState.historyCache[targetCode] = res.payload || { index: null, history: [] };
  } catch (e) {
    if (seq === mviState.historySeq && typeof mviSetChartError === 'function') {
      mviSetChartError(e);
    }
  } finally {
    if (seq === mviState.historySeq) {
      mviState.historyLoading = false;
      if (typeof mviRenderChartSection === 'function') mviRenderChartSection();
    }
  }
}

function mviSelectPeriod(period) {
  if (!period || mviState.period === period) return;
  mviState.period = period;
  if (typeof mviRenderCards === 'function') mviRenderCards();
}

function mviSelectIndex(code) {
  if (!code) return;
  mviState.selectedCode = code;
  if (typeof mviRenderCards === 'function') mviRenderCards();
  loadMarketCycleIndexHistory(code);
}

function mviSelectMode(mode) {
  if (!mode || mviState.mode === mode) return;
  mviState.mode = mode;
  if (typeof mviRenderChartSection === 'function') mviRenderChartSection();
}

function mviSelectRange(range, customStart, customEnd) {
  mviState.range = range || '10y';
  mviState.customStart = customStart || null;
  mviState.customEnd = customEnd || null;
  if (typeof mviRenderChartSection === 'function') mviRenderChartSection();
}
