// 股票筛选（投资策略选股中心）Presenter。
// 职责：持有市场/批次/分页与加载状态；决定何时取数、何时把结果交给 View。
// 边界：不操作 DOM（role=presenter、allowDom=false），改界面只调用 View 暴露的 ssRender* 入口。
var ssState = {
  market: 'CN',
  markets: [],
  runs: [],
  runId: null,
  run: null,
  candidates: [],
  candidateTotal: 0,
  candidateOffset: 0,
  portfolio: null,
  backtests: [],
  settings: null,
  settingsRevision: 0,
  industries: [],
  detail: null,
  loading: false,
  loadingKey: null,
  seq: 0,
  error: null,
};

var SS_PAGE_SIZE = 50;
var SS_KIND_BY_PERIOD = { quarter: 'quarterly', weekly: 'weekly', daily: 'daily' };
var SS_PERIOD_LABEL = { quarter: '季度组合', weekly: '每周正式组合', daily: '每日动态' };

// 账号或市场切换守卫：身份变化即作废在途请求，旧响应不得写进新页面。
function ssBeginLoad(key) {
  var user = typeof username === 'string' ? username : '';
  if (ssState.ownerUser !== user) {
    ssState.ownerUser = user;
    ssState.seq = (ssState.seq || 0) + 1;
    ssState.runId = null;
    ssState.run = null;
    ssState.candidates = [];
    ssState.portfolio = null;
    ssState.detail = null;
    ssState.error = null;
    ssState.loading = false;
  }
  if (ssState.loading && ssState.loadingKey === key) return null;
  ssState.loadingKey = key;
  var seq = (ssState.seq || 0) + 1;
  ssState.seq = seq;
  return {
    current: function () {
      return ssState.seq === seq && user === (typeof username === 'string' ? username : '');
    },
  };
}

function ssFormatPercent(value, digits) {
  var n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return (n * 100).toFixed(digits === undefined ? 2 : digits) + '%';
}

function ssFormatNumber(value, digits) {
  var n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n.toFixed(digits === undefined ? 2 : digits);
}

function ssFormatAmount(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) return '--';
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + ' 万';
  return n.toFixed(2);
}

// 页面入口：导航 switchMain('stock-selection') 会调用本函数。
async function loadStockSelection() {
  if (typeof ssInitView === 'function') ssInitView();
  if (!window.StockSelectionApi) {
    if (typeof ssSetError === 'function') ssSetError(new Error('页面脚本未加载完成，请刷新重试'));
    return;
  }
  var guard = ssBeginLoad('markets');
  if (!guard) return;
  ssState.loading = true;
  if (typeof ssSetStatus === 'function') ssSetStatus('正在读取市场环境与已发布批次...');
  try {
    var results = await Promise.all([
      window.StockSelectionApi.getMarkets(),
      // published: '1' 只要已正式发布的组合：未发布批次只是部分数据预览，不能当作可选结论。
      window.StockSelectionApi.listRuns({ market: ssState.market, published: '1', limit: 20,
        // 结果类型只是查询条件：日/周/季各自一个渠道，未发布的预览一律不进下拉。
        kind: SS_KIND_BY_PERIOD[ssState.periodType] || undefined,
      }),
      window.StockSelectionApi.getSettings().catch(function () { return { settings: {}, revision: 0 }; }),
      window.StockSelectionApi.listBacktests({ market: ssState.market, limit: 10 }).catch(function () { return { backtests: [] }; }),
      // 行业排除下拉：只读库内分类；取不到就退化为空列表，不影响其它区块。
      window.StockSelectionApi.listIndustries(ssState.market).catch(function () { return { industries: [] }; }),
    ]);
    if (!guard.current()) return;
    ssState.markets = results[0].markets || [];
    ssState.industries = (results[4] && results[4].industries) || [];
    ssState.strategyCode = results[0].strategyCode || null;
    if (typeof ssRenderRuleScope === 'function') ssRenderRuleScope(ssState);
    if (typeof ssRenderPeriodTabs === 'function') ssRenderPeriodTabs(ssState);
    ssState.runs = results[1].runs || [];
    ssState.settings = results[2].settings || {};
    ssState.settingsRevision = results[2].revision || 0;
    ssState.backtests = results[3].backtests || [];
    ssState.runId = ssState.runs.length ? ssState.runs[0].runId : null;
    if (typeof ssRenderMarkets === 'function') ssRenderMarkets(ssState);
    if (typeof ssRenderRuns === 'function') ssRenderRuns(ssState);
    if (typeof ssRenderSettings === 'function') ssRenderSettings(ssState);
    if (typeof ssRenderBacktests === 'function') ssRenderBacktests(ssState);
    if (!ssState.runId) {
      if (typeof ssSetStatus === 'function') {
        // 港股与 A 股的空列表原因不同：港股是本地还没有个股行情与估值，不能说成"等着生成就有"。
        ssSetStatus(ssState.market === 'HK'
          ? '港股还没有正式发布的季度组合：本地暂无港股个股行情与估值数据，生成港股组合前需要先补齐这些数据。'
          : '该市场还没有正式发布的季度组合。后台按季度计算并正式发布后才会出现在这里。');
      }
      if (typeof ssRenderCandidates === 'function') ssRenderCandidates(ssState);
      if (typeof ssRenderPortfolio === 'function') ssRenderPortfolio(ssState);
      return;
    }
    await ssLoadRun(ssState.runId);
  } catch (error) {
    if (guard.current() && typeof ssSetError === 'function') ssSetError(error);
  } finally {
    if (guard.current()) ssState.loading = false;
  }
}

async function ssLoadRun(runId) {
  var guard = ssBeginLoad('run:' + ssState.market + ':' + runId);
  if (!guard) return;
  ssState.loading = true;
  if (typeof ssSetStatus === 'function') ssSetStatus('正在读取批次数据...');
  try {
    var market = ssState.market;
    var both = await Promise.all([
      window.StockSelectionApi.getCandidates(runId, { limit: SS_PAGE_SIZE, offset: 0 }),
      window.StockSelectionApi.getPortfolio(runId),
      window.StockSelectionApi.getRun(runId),
    ]);
    if (!guard.current() || market !== ssState.market) return;
    ssState.runId = runId;
    ssState.run = both[2];
    ssState.candidates = both[0].candidates || [];
    ssState.candidateTotal = both[0].total || 0;
    ssState.candidateOffset = ssState.candidates.length;
    ssState.portfolio = both[1];
    ssState.detail = null;
    if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
    if (typeof ssRenderCandidates === 'function') ssRenderCandidates(ssState);
    if (typeof ssRenderPortfolio === 'function') ssRenderPortfolio(ssState);
    if (typeof ssRenderDetail === 'function') ssRenderDetail(ssState);
    if (typeof ssSetStatus === 'function') ssSetStatus('');
  } catch (error) {
    if (guard.current() && typeof ssSetError === 'function') ssSetError(error);
  } finally {
    if (guard.current()) ssState.loading = false;
  }
}

async function ssLoadMoreCandidates() {
  if (!ssState.runId || ssState.candidates.length >= ssState.candidateTotal) return;
  var guard = ssBeginLoad('more:' + ssState.runId + ':' + ssState.candidateOffset);
  if (!guard) return;
  try {
    var result = await window.StockSelectionApi.getCandidates(ssState.runId, {
      limit: SS_PAGE_SIZE, offset: ssState.candidateOffset,
    });
    if (!guard.current()) return;
    ssState.candidates = ssState.candidates.concat(result.candidates || []);
    ssState.candidateOffset = ssState.candidates.length;
    ssState.candidateTotal = result.total || ssState.candidateTotal;
    if (typeof ssRenderCandidates === 'function') ssRenderCandidates(ssState);
  } catch (error) {
    if (guard.current() && typeof ssShowToast === 'function') ssShowToast('加载失败：' + (error.message || error));
  }
}

async function ssOpenStock(code) {
  if (!ssState.runId) return;
  try {
    var detail = await window.StockSelectionApi.getStock(ssState.runId, code);
    ssState.detail = detail;
    if (typeof ssRenderDetail === 'function') ssRenderDetail(ssState);
  } catch (error) {
    if (typeof ssShowToast === 'function') ssShowToast('读取失败：' + (error.message || error));
  }
}

// 点证券名称跳「证券分析」看该股完整分析：只切页并复用证券分析既有入口，
// 不在本页复制一套取数与渲染。
async function ssOpenInAnalysis(code) {
  var raw = String(code || '').trim().toUpperCase();
  if (!raw) return;
  if (typeof switchMain === 'function') await switchMain('stock-analysis');
  if (typeof securityAnalysisSetCodeInput === 'function') securityAnalysisSetCodeInput(raw, 'stock');
  if (typeof securityAnalysisSubmit === 'function') return securityAnalysisSubmit(raw, 'stock');
  if (typeof ssShowToast === 'function') ssShowToast('证券分析页还没加载完成，请稍后重试');
}

// 市场切换：清掉该市场的批次状态后重新读取，另一个市场的错误不会清空本市场内容。
async function ssSwitchMarket(market) {
  if (market === ssState.market) return;
  ssState.market = market;
  ssState.runId = null;
  ssState.run = null;
  ssState.candidates = [];
  ssState.candidateTotal = 0;
  ssState.candidateOffset = 0;
  ssState.portfolio = null;
  ssState.detail = null;
  ssState.error = null;
  if (typeof ssRenderMarketTabs === 'function') ssRenderMarketTabs(ssState);
  await loadStockSelection();
}

async function ssSwitchPeriod(periodType) {
  var type = String(periodType || '');
  if (!SS_KIND_BY_PERIOD[type] || type === ssState.periodType) return;
  ssState.periodType = type;
  ssState.runId = null;
  ssState.run = null;
  ssState.candidates = [];
  ssState.candidateTotal = 0;
  ssState.candidateOffset = 0;
  ssState.portfolio = null;
  ssState.detail = null;
  if (typeof ssRenderPeriodTabs === 'function') ssRenderPeriodTabs(ssState);
  await loadStockSelection();
}

async function ssSelectRun(runId) {
  if (!runId || Number(runId) === Number(ssState.runId)) return;
  await ssLoadRun(Number(runId));
}

async function ssSaveSettings(payload) {
  try {
    var saved = await window.StockSelectionApi.saveSettings(Object.assign({}, payload, { revision: ssState.settingsRevision }));
    ssState.settings = saved.settings;
    ssState.settingsRevision = saved.revision;
    if (typeof ssRenderSettings === 'function') ssRenderSettings(ssState);
    if (typeof ssShowToast === 'function') ssShowToast('资金设置已保存');
  } catch (error) {
    if (typeof ssShowToast === 'function') ssShowToast('保存失败：' + (error.message || error));
  }
}

// 保存设置后再测算：排除项必须先落到服务端，否则这次测算用的还是旧设置。
async function ssSaveSettingsAndSimulate(settingsPayload, simulatePayload) {
  try {
    var saved = await window.StockSelectionApi.saveSettings(Object.assign({}, settingsPayload, { revision: ssState.settingsRevision }));
    ssState.settings = saved.settings;
    ssState.settingsRevision = saved.revision;
    if (typeof ssRenderSettings === 'function') ssRenderSettings(ssState);
  } catch (error) {
    if (typeof ssShowToast === 'function') ssShowToast('排除设置保存失败：' + (error.message || error));
    return;
  }
  return ssSimulate(simulatePayload);
}

async function ssSimulate(payload) {
  if (!ssState.runId) {
    if (typeof ssShowToast === 'function') ssShowToast('请先选择一个已发布批次');
    return;
  }
  try {
    var result = await window.StockSelectionApi.simulate(Object.assign({ sourceRunId: ssState.runId }, payload));
    if (typeof ssShowToast === 'function') ssShowToast('已生成个人测算批次 #' + result.runId);
    await ssLoadRun(result.runId);
  } catch (error) {
    if (typeof ssShowToast === 'function') ssShowToast('测算失败：' + (error.message || error));
  }
}

window.StockSelectionPresenter = {
  state: ssState,
  load: loadStockSelection,
  switchMarket: ssSwitchMarket,
  selectRun: ssSelectRun,
  switchPeriod: ssSwitchPeriod,
  loadMore: ssLoadMoreCandidates,
  openStock: ssOpenStock,
  openInAnalysis: ssOpenInAnalysis,
  saveSettings: ssSaveSettings,
  saveSettingsAndSimulate: ssSaveSettingsAndSimulate,
  simulate: ssSimulate,
  formatPercent: ssFormatPercent,
  formatNumber: ssFormatNumber,
  formatAmount: ssFormatAmount,
};
