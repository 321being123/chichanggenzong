// 股票筛选 Presenter：管理市场/周期/公共来源/个人结果四个上下文，View 只渲染和上报操作。
// 页面打开、切换和排除均只读取/写入站内 API，不触发外部采集。
var ssState = {
  market: 'CN', markets: [], runs: [], runTotal: 0, runOffset: 0,
  runId: null, sourceRunId: null, personalRunId: null, run: null, sourceRun: null, sourcePortfolio: null,
  candidates: [], candidateTotal: 0, candidateOffset: 0, portfolio: null,
  settings: null, settingsRevision: 0, settingsWritable: false, settingsError: null, settingsSaveError: null,
  industries: [], detail: null, periodType: null, periodUserSelected: false, strategyCode: null,
  loading: false, loadingKey: null, runListLoading: false, seq: 0, contextVersion: 0, detailVersion: 0,
  error: null, pendingSimulation: null, simulationError: null, pendingSettingsOperation: null,
};

var SS_PAGE_SIZE = 50;
var SS_RUN_PAGE_SIZE = 20;
var SS_KIND_BY_PERIOD = { quarter: 'quarterly', weekly: 'weekly', daily: 'daily' };
var SS_PERIOD_LABEL = { quarter: '历史季度', weekly: '每周正式', daily: '每日动态' };
var SS_PERIOD_API_TYPE = { quarter: 'quarter', weekly: 'week', daily: 'day' };
var ssSettingsMutationQueue = [];
var ssSettingsMutationRunning = false;
var ssSettingsMutationPaused = false;
var ssSettingsRetrying = false;
var ssSimulationRetrying = false;
var ssLastSettingsRecovery = null;
var ssCandidateLoadSeq = 0;
var ssRunLoadSeq = 0;
var ssSourceSelectionCache = Object.create(null);
var ssAuthFailureKey = null;
var SS_ERR_SETTINGS_REVISION = 'STOCK_SELECTION_SETTINGS_REVISION_CONFLICT';
var SS_ERR_POSITION_REQUIRED = 'STOCK_SELECTION_POSITION_REQUIRED';

function ssMakeError(message, status, code) {
  var error = new Error(message);
  error.status = status;
  error.code = code || null;
  return error;
}

function ssRedirectToLogin() {
  if (typeof window === 'undefined' || !window.location) return;
  var current = (window.location.pathname || '/') + (window.location.search || '');
  var login = typeof api === 'function' ? api('/login.html') : '/login.html';
  window.location.href = login + '?redirect=' + encodeURIComponent(current);
}

function ssClearPrivateStateAfterAuthFailure() {
  ssSettingsMutationQueue.splice(0).forEach(function (operation) { operation.resolve(null); });
  ssSettingsMutationPaused = true;
  ssLastSettingsRecovery = null;
  ssState.pendingSettingsOperation = null;
  ssState.pendingSimulation = null;
  ssState.simulationError = null;
  ssState.settings = null;
  ssState.settingsRevision = 0;
  ssState.settingsWritable = false;
  ssState.subjectToken = null;
  ssState.loading = false;
  ssState.runListLoading = false;
  ssState.settingsError = ssMakeError('登录已失效，请重新登录。', 401, 'AUTHENTICATION_REQUIRED');
  ssState.settingsSaveError = '登录已失效，请重新登录。';
  ssSourceSelectionCache = Object.create(null);
  ssState.seq += 1;
  ssState.contextVersion += 1;
  ssResetDisplayedRun();
  if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
  if (typeof ssShowToast === 'function') ssShowToast('登录已失效，请重新登录');
}

function ssHandleAuthFailure(context, error) {
  if (!error || error.status !== 401 || context && !ssSameOwner(context)) return false;
  if (context && context.version !== undefined && context.version !== ssState.contextVersion) return false;
  if (context && context.market && context.market !== ssState.market) return false;
  if (context && context.periodType && context.periodType !== ssState.periodType) return false;
  if (context && context.sourceRunId !== undefined && Number(context.sourceRunId) !== Number(ssState.sourceRunId)) return false;
  var key = (context && context.ownerUser || '') + '\u0000' + (context && context.ownerIdentity || '');
  if (ssAuthFailureKey === key) return true;
  ssAuthFailureKey = key;
  ssClearPrivateStateAfterAuthFailure();
  ssRedirectToLogin();
  return true;
}

function ssStopWritesAfterForbidden() {
  ssSettingsMutationQueue.splice(0).forEach(function (operation) { operation.resolve(null); });
  ssSettingsMutationPaused = true;
  ssState.pendingSettingsOperation = null;
  ssState.settingsWritable = false;
}

function ssSameOwner(context) {
  return !!context && context.ownerUser === ssState.ownerUser
    && context.ownerUser === (typeof username === 'string' ? username : '')
    && (context.ownerIdentity || '') === (typeof accountIdentity === 'string' ? accountIdentity : '');
}

function ssBeginLoad(key) {
  var user = typeof username === 'string' ? username : '';
  var identity = typeof accountIdentity === 'string' ? accountIdentity : '';
  if (ssState.ownerUser !== user || (ssState.ownerIdentity || '') !== identity) {
    ssSettingsMutationQueue.splice(0).forEach(function (operation) { operation.resolve(null); });
    ssSettingsMutationPaused = false; ssLastSettingsRecovery = null;
    ssState.pendingSettingsOperation = null; ssState.settingsSaveError = null;
    ssState.pendingSimulation = null; ssState.simulationError = null;
    ssState.settingsWritable = false;
    ssState.ownerUser = user; ssState.ownerIdentity = identity; ssState.subjectToken = null; ssState.seq += 1; ssState.contextVersion += 1; ssState.runId = null; ssState.sourceRunId = null;
    ssSourceSelectionCache = Object.create(null);
    ssAuthFailureKey = null;
    ssCandidateLoadSeq += 1;
    ssRunLoadSeq += 1;
    ssState.personalRunId = null; ssState.run = null; ssState.sourceRun = null; ssState.sourcePortfolio = null;
    ssState.candidates = []; ssState.portfolio = null; ssState.detail = null; ssState.settings = null;
    ssState.settingsError = null; ssState.loading = false;
  }
  if (ssState.loading && ssState.loadingKey === key) return null;
  ssState.runListLoading = false;
  ssState.loadingKey = key;
  ssRunLoadSeq += 1;
  var seq = ++ssState.seq;
  return { current: function () { return ssState.seq === seq && user === (typeof username === 'string' ? username : '') && identity === (typeof accountIdentity === 'string' ? accountIdentity : ''); } };
}

function ssBeginRunListLoad(offset) {
  var user = typeof username === 'string' ? username : '';
  var identity = typeof accountIdentity === 'string' ? accountIdentity : '';
  var market = ssState.market;
  var periodType = ssState.periodType;
  var expectedOffset = Number(offset);
  var seq = ++ssRunLoadSeq;
  return {
    current: function () {
      return ssRunLoadSeq === seq
        && ssState.market === market && ssState.periodType === periodType
        && user === (typeof username === 'string' ? username : '')
        && identity === (typeof accountIdentity === 'string' ? accountIdentity : '');
    },
    sameOffset: function () { return Number(ssState.runOffset) === expectedOffset; },
  };
}

function ssBeginCandidateLoad(runId, offset) {
  var user = typeof username === 'string' ? username : '';
  var identity = typeof accountIdentity === 'string' ? accountIdentity : '';
  var contextVersion = ssState.contextVersion;
  var seq = ++ssCandidateLoadSeq;
  return {
    current: function () {
      return ssCandidateLoadSeq === seq && ssState.contextVersion === contextVersion
        && Number(ssState.runId) === Number(runId) && Number(ssState.candidateOffset) === Number(offset)
        && user === (typeof username === 'string' ? username : '')
        && identity === (typeof accountIdentity === 'string' ? accountIdentity : '');
    },
  };
}

function ssFormatPercent(value, digits) { var n = Number(value); return Number.isFinite(n) ? (n * 100).toFixed(digits === undefined ? 2 : digits) + '%' : '--'; }
function ssFormatNumber(value, digits) { var n = Number(value); return Number.isFinite(n) ? n.toFixed(digits === undefined ? 2 : digits) : '--'; }
function ssFormatAmount(value) {
  var n = Number(value); if (!Number.isFinite(n)) return '--';
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + ' 万';
  return n.toFixed(2);
}
function ssDefaultPeriod(strategyCode) { return String(strategyCode || '').indexOf('_v2') >= 0 ? 'weekly' : 'quarter'; }

function ssResetDisplayedRun() {
  ssState.runId = null; ssState.sourceRunId = null; ssState.sourceRun = null; ssState.sourcePortfolio = null;
  ssState.run = null; ssState.personalRunId = null; ssState.candidates = [];
  ssState.candidateTotal = 0; ssState.candidateOffset = 0; ssState.portfolio = null; ssState.detail = null;
  ssState.detailVersion += 1; ssState.pendingSimulation = null; ssState.simulationError = null;
  if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
  if (typeof ssRenderCandidates === 'function') ssRenderCandidates(ssState);
  if (typeof ssRenderPortfolio === 'function') ssRenderPortfolio(ssState);
  if (typeof ssRenderDetail === 'function') ssRenderDetail(ssState);
}

function ssSettingsResult(result) {
  if (result && result.error && ssHandleAuthFailure({ ownerUser: ssState.ownerUser, ownerIdentity: ssState.ownerIdentity || '' }, result.error)) return;
  if (result && result.ownerUsername && result.ownerUsername !== ssState.ownerUser) result = { error: new Error('登录账号已变化，请刷新后重试') };
  if (result && result.accountIdentity && ssState.ownerIdentity && result.accountIdentity !== ssState.ownerIdentity) result = { error: new Error('登录账号已变化，请刷新后重试') };
  if (!result || result.error) {
    ssState.settings = null; ssState.settingsRevision = 0; ssState.settingsWritable = false;
    ssState.settingsError = result && result.error ? result.error : new Error('设置读取失败'); return;
  }
  ssState.settings = result.settings || {}; ssState.settingsRevision = Number(result.revision || 0);
  ssAuthFailureKey = null;
  ssState.subjectToken = result.subjectToken || null;
  ssState.settingsWritable = true; ssState.settingsError = null;
  // 403 会暂停写队列并清空未确认意图；同一主体重新成功读取权威设置后，允许新的用户操作继续入队。
  // 若仍有未确认操作，则保留暂停状态，避免用一次普通读取掩盖未知写入结果。
  if (!ssState.pendingSettingsOperation) ssSettingsMutationPaused = false;
  ssState.settingsSaveError = ssState.pendingSettingsOperation ? '排除设置尚未确认，请重试保存。' : null;
}

function ssSelectionCacheKey(market, periodType) {
  var user = typeof username === 'string' ? username : (ssState.ownerUser || '');
  var identity = typeof accountIdentity === 'string' ? accountIdentity : (ssState.ownerIdentity || '');
  return user + '\u0000' + identity + '\u0000' + String(market || '') + '\u0000' + String(periodType || '');
}

function ssRememberSourceSelection() {
  var runId = Number(ssState.sourceRunId);
  if (!runId || !ssState.market || !ssState.periodType) return;
  ssSourceSelectionCache[ssSelectionCacheKey(ssState.market, ssState.periodType)] = runId;
}

function ssRememberedSourceSelection() {
  var key = ssSelectionCacheKey(ssState.market, ssState.periodType);
  var runId = Number(ssSourceSelectionCache[key]);
  return runId > 0 ? runId : null;
}

function ssForgetRememberedSourceSelection() {
  delete ssSourceSelectionCache[ssSelectionCacheKey(ssState.market, ssState.periodType)];
}

function ssMergeRuns(existing, incoming) {
  var seen = Object.create(null);
  return (existing || []).concat(incoming || []).filter(function (run) {
    var id = Number(run && run.runId);
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
  });
}

// 历史季度横跨策略版本；日周渠道仍绑定当前激活策略。
function ssSourceStrategyFilter() {
  return ssState.periodType === 'quarter' ? null : ssState.strategyCode;
}

function ssIsValidRememberedSource(run) {
  if (!run || !Number(run.runId)) return false;
  if (run.market !== ssState.market || run.runKind !== SS_KIND_BY_PERIOD[ssState.periodType]) return false;
  if (run.periodType && run.periodType !== SS_PERIOD_API_TYPE[ssState.periodType]) return false;
  var strategyFilter = ssSourceStrategyFilter();
  if (strategyFilter && run.strategyCode !== strategyFilter) return false;
  return !!run.publishedAt && run.isShadow !== true;
}

async function ssResolveInitialSource(runs, guard, requestOwner) {
  var rememberedId = ssRememberedSourceSelection();
  var latestId = runs.length ? Number(runs[0].runId) : null;
  if (!rememberedId) return { runId: latestId, runs: runs, remember: true };
  if (runs.some(function (run) { return Number(run.runId) === rememberedId; })) {
    return { runId: rememberedId, runs: runs, remember: true };
  }
  try {
    // 只按已知 ID 读取一次，不为了恢复选择扫描全部历史批次。
    var rememberedRun = await window.StockSelectionApi.getRun(rememberedId);
    if (!guard.current()) return null;
    if (ssIsValidRememberedSource(rememberedRun)) {
      return { runId: rememberedId, runs: ssMergeRuns([rememberedRun], runs), remember: true };
    }
    ssForgetRememberedSourceSelection();
    if (typeof ssShowToast === 'function') ssShowToast('上次选择的来源已失效，已切换到最新来源。');
    return { runId: latestId, runs: runs, remember: true };
  } catch (error) {
    if (guard.current() && error && error.status === 401 && ssHandleAuthFailure(requestOwner, error)) return null;
    if (error && error.status === 404) {
      ssForgetRememberedSourceSelection();
      if (typeof ssShowToast === 'function') ssShowToast('上次选择的来源已失效，已切换到最新来源。');
      return { runId: latestId, runs: runs, remember: true };
    }
    // 读取暂时失败不能误判为失效，也不覆盖内存中的用户选择；本次仅降级到最新来源。
    if (guard.current() && typeof ssShowToast === 'function') ssShowToast('上次选择的来源暂时无法读取，已显示最新来源。');
    return { runId: latestId, runs: runs, remember: false };
  }
}

async function loadStockSelection() {
  if (typeof ssInitView === 'function') ssInitView();
  if (!window.StockSelectionApi) { if (typeof ssSetError === 'function') ssSetError(new Error('页面脚本未加载完成，请刷新重试')); return; }
  var guard = ssBeginLoad('context:' + ssState.market + ':' + ssState.periodType); if (!guard) return;
  var requestOwner = { ownerUser: ssState.ownerUser, ownerIdentity: ssState.ownerIdentity || '' };
  ssState.loading = true; ssResetDisplayedRun();
  if (typeof ssSetStatus === 'function') ssSetStatus('正在读取当前市场与来源批次...');
  try {
    var marketResult = await window.StockSelectionApi.getMarkets({ periodType: SS_PERIOD_API_TYPE[ssState.periodType] }); if (!guard.current()) return;
    ssState.strategyCode = marketResult.strategyCode || null;
    if (!ssState.periodUserSelected || !SS_KIND_BY_PERIOD[ssState.periodType]) ssState.periodType = ssDefaultPeriod(ssState.strategyCode);
    var requestedPeriodType = SS_PERIOD_API_TYPE[ssState.periodType];
    if (requestedPeriodType && marketResult.activePeriodType !== requestedPeriodType) {
      marketResult = await window.StockSelectionApi.getMarkets({ periodType: requestedPeriodType });
      if (!guard.current()) return;
    }
    ssState.markets = marketResult.markets || [];
    if (typeof ssRenderRuleScope === 'function') ssRenderRuleScope(ssState);
    if (typeof ssRenderMarketTabs === 'function') ssRenderMarketTabs(ssState);
    if (typeof ssRenderMarkets === 'function') ssRenderMarkets(ssState);
    if (typeof ssRenderPeriodTabs === 'function') ssRenderPeriodTabs(ssState);
    var results = await Promise.all([
      window.StockSelectionApi.listRuns({ market: ssState.market, published: '1', limit: SS_RUN_PAGE_SIZE, offset: 0, kind: SS_KIND_BY_PERIOD[ssState.periodType], periodType: requestedPeriodType, strategy: ssSourceStrategyFilter() }),
      window.StockSelectionApi.getSettings().catch(function (error) {
        if (guard.current() && error && error.status === 401) ssHandleAuthFailure(requestOwner, error);
        return { error: error };
      }),
      window.StockSelectionApi.listIndustries(ssState.market).catch(function (error) {
        if (guard.current() && error && error.status === 401) ssHandleAuthFailure(requestOwner, error);
        return { error: error };
      }),
    ]);
    if (!guard.current()) return;
    var resolvedSource = await ssResolveInitialSource(results[0].runs || [], guard, requestOwner);
    if (!guard.current() || !resolvedSource) return;
    ssState.runs = resolvedSource.runs; ssState.runTotal = Number(results[0].total || ssState.runs.length); ssState.runOffset = (results[0].runs || []).length;
    ssSettingsResult(results[1]);
    if (!guard.current()) return;
    if (results[2] && results[2].error && results[2].error.status === 401
      && ssHandleAuthFailure(requestOwner, results[2].error)) return;
    ssState.industries = results[2].industries || [];
    ssState.sourceRunId = resolvedSource.runId; ssState.runId = ssState.sourceRunId;
    if (resolvedSource.remember && ssState.sourceRunId) ssRememberSourceSelection();
    if (typeof ssRenderRuns === 'function') ssRenderRuns(ssState);
    if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
    if (!ssState.sourceRunId) {
      if (typeof ssSetStatus === 'function') ssSetStatus('当前市场暂无' + SS_PERIOD_LABEL[ssState.periodType] + '来源组合。可保留周期与市场选择，待正式批次发布后再操作。');
      if (typeof ssRenderCandidates === 'function') ssRenderCandidates(ssState);
      if (typeof ssRenderPortfolio === 'function') ssRenderPortfolio(ssState); return;
    }
    await ssLoadSourceAndMaybePersonal(ssState.sourceRunId);
  } catch (error) {
    if (guard.current() && error && error.status === 401) ssHandleAuthFailure(requestOwner, error);
    if (guard.current() && typeof ssSetError === 'function') ssSetError(error);
  }
  finally { if (guard.current()) ssState.loading = false; }
}

function ssHasPersonalExclusions() {
  var settings = ssState.settings || {};
  var industries = settings.industryFilters && Array.isArray(settings.industryFilters[ssState.market]) ? settings.industryFilters[ssState.market] : [];
  var instruments = Array.isArray(settings.excludedInstruments) ? settings.excludedInstruments.filter(function (item) {
    return item && String(item.market).toUpperCase() === ssState.market;
  }) : [];
  return industries.length > 0 || instruments.length > 0;
}

async function ssLoadSourceAndMaybePersonal(runId) {
  await ssLoadRun(runId, { source: true });
  if (Number(ssState.sourceRunId) !== Number(runId) || !ssState.run || ssState.run.runKind === 'personal' || !ssHasPersonalExclusions()) return;
  await ssSimulate({ sourceRunId: Number(runId), settingsRevision: ssState.settingsRevision });
}

async function ssLoadCandidateRange(runId, targetCount) {
  var target = Math.max(0, Number(targetCount) || 0);
  var candidates = []; var total = 0; var offset = 0;
  while (offset < target) {
    var limit = Math.min(SS_PAGE_SIZE, target - offset);
    var page = await window.StockSelectionApi.getCandidates(runId, { limit: limit, offset: offset });
    var rows = page.candidates || [];
    total = Number(page.total || total || 0);
    candidates = candidates.concat(rows);
    offset += rows.length;
    if (!rows.length || rows.length < limit || offset >= total) break;
  }
  return { candidates: candidates.slice(0, target), total: total };
}

async function ssLoadRun(runId, options) {
  ssCandidateLoadSeq += 1;
  var guard = ssBeginLoad('run:' + ssState.market + ':' + ssState.periodType + ':' + runId); if (!guard) return;
  var requestOwner = { ownerUser: ssState.ownerUser, ownerIdentity: ssState.ownerIdentity || '' };
  ssState.loading = true; if (typeof ssSetStatus === 'function') ssSetStatus('正在读取来源批次及组合...');
  try {
    var market = ssState.market;
    var preserveCount = options && options.preserveCandidateRange ? Math.max(Number(options.preserveCandidateCount) || 0, ssState.candidates.length) : 0;
    var candidateRequest = preserveCount > 0
      ? ssLoadCandidateRange(runId, preserveCount)
      : window.StockSelectionApi.getCandidates(runId, { limit: SS_PAGE_SIZE, offset: 0 });
    var both = await Promise.all([
      candidateRequest,
      window.StockSelectionApi.getPortfolio(runId, options && options.baselineRunId), window.StockSelectionApi.getRun(runId),
    ]);
    if (!guard.current() || market !== ssState.market) return;
    ssState.runId = Number(runId); ssState.run = both[2];
    if (typeof ssRenderRuleScope === 'function') ssRenderRuleScope(ssState);
    if (options && options.source !== false && ssState.run && ssState.run.runKind !== 'personal') {
      ssState.sourceRunId = Number(runId); ssState.sourceRun = ssState.run; ssState.sourcePortfolio = both[1]; ssState.personalRunId = null;
    }
    if (ssState.run && ssState.run.runKind === 'personal') { ssState.personalRunId = Number(runId); if (ssState.run.sourceRunId) ssState.sourceRunId = Number(ssState.run.sourceRunId); }
    ssState.candidates = both[0].candidates || []; ssState.candidateTotal = both[0].total || 0; ssState.candidateOffset = ssState.candidates.length;
    ssState.portfolio = both[1]; ssState.detail = null;
    if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
    if (typeof ssRenderCandidates === 'function') ssRenderCandidates(ssState);
    if (typeof ssRenderPortfolio === 'function') ssRenderPortfolio(ssState);
    if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
    if (typeof ssRenderDetail === 'function') ssRenderDetail(ssState);
    if (typeof ssSetStatus === 'function') ssSetStatus('');
    return true;
  } catch (error) {
    if (guard.current() && error && error.status === 401) ssHandleAuthFailure(requestOwner, error);
    if (guard.current() && typeof ssSetError === 'function') ssSetError(error); return false;
  }
  finally { if (guard.current()) ssState.loading = false; }
}

async function ssLoadMoreRuns() {
  if (Number(ssState.runOffset) >= Number(ssState.runTotal) || !window.StockSelectionApi) return;
  if (ssState.runListLoading) return;
  var offset = Number(ssState.runOffset);
  var guard = ssBeginRunListLoad(offset);
  var requestOwner = { ownerUser: typeof username === 'string' ? username : '', ownerIdentity: typeof accountIdentity === 'string' ? accountIdentity : '' };
  ssState.runListLoading = true;
  try {
    var result = await window.StockSelectionApi.listRuns({ market: ssState.market, published: '1', limit: SS_RUN_PAGE_SIZE, offset: offset, kind: SS_KIND_BY_PERIOD[ssState.periodType], periodType: SS_PERIOD_API_TYPE[ssState.periodType], strategy: ssSourceStrategyFilter() });
    if (!guard.current() || !guard.sameOffset()) return; var pageRuns = result.runs || []; ssState.runs = ssMergeRuns(ssState.runs, pageRuns); ssState.runTotal = result.total === undefined ? ssState.runTotal : Number(result.total); ssState.runOffset = offset + pageRuns.length;
    if (typeof ssRenderRuns === 'function') ssRenderRuns(ssState);
  } catch (error) {
    if (guard.current() && error && error.status === 401 && ssHandleAuthFailure(requestOwner, error)) return;
    if (guard.current() && typeof ssShowToast === 'function') ssShowToast('加载历史来源失败：' + (error.message || error));
  }
  finally { if (guard.current()) ssState.runListLoading = false; }
}

async function ssLoadMoreCandidates() {
  if (!ssState.runId || ssState.candidates.length >= ssState.candidateTotal) return;
  if (ssState.loading) return;
  var runId = Number(ssState.runId); var offset = Number(ssState.candidateOffset);
  var guard = ssBeginCandidateLoad(runId, offset);
  var requestOwner = { ownerUser: typeof username === 'string' ? username : '', ownerIdentity: typeof accountIdentity === 'string' ? accountIdentity : '' };
  try {
    var result = await window.StockSelectionApi.getCandidates(runId, { limit: SS_PAGE_SIZE, offset: offset }); if (!guard.current()) return;
    ssState.candidates = ssState.candidates.concat(result.candidates || []); ssState.candidateOffset = ssState.candidates.length; ssState.candidateTotal = result.total || ssState.candidateTotal;
    if (typeof ssRenderCandidates === 'function') ssRenderCandidates(ssState);
  } catch (error) {
    if (guard.current() && error && error.status === 401 && ssHandleAuthFailure(requestOwner, error)) return;
    if (guard.current() && typeof ssShowToast === 'function') ssShowToast('加载候选失败：' + (error.message || error));
  }
}

async function ssOpenStock(code) {
  if (!ssState.runId) return;
  var runId = ssState.runId; var detailVersion = ++ssState.detailVersion; var contextVersion = ssState.contextVersion;
  var requestOwner = { ownerUser: typeof username === 'string' ? username : '', ownerIdentity: typeof accountIdentity === 'string' ? accountIdentity : '' };
  var isCurrent = function () { return detailVersion === ssState.detailVersion && contextVersion === ssState.contextVersion && runId === ssState.runId; };
  try {
    var detail = await window.StockSelectionApi.getStock(runId, code);
    if (!isCurrent()) return;
    ssState.detail = detail; if (typeof ssRenderDetail === 'function') ssRenderDetail(ssState);
  } catch (error) {
    if (!isCurrent()) return;
    if (error && error.status === 401 && ssHandleAuthFailure(requestOwner, error)) return;
    if (typeof ssShowToast === 'function') ssShowToast('读取详情失败：' + (error.message || error));
  }
}
async function ssOpenInAnalysis(code) {
  var raw = String(code || '').trim().toUpperCase(); if (!raw) return;
  if (typeof switchMain === 'function') await switchMain('stock-analysis');
  if (typeof securityAnalysisSetCodeInput === 'function') securityAnalysisSetCodeInput(raw, 'stock');
  if (typeof securityAnalysisSubmit === 'function') return securityAnalysisSubmit(raw, 'stock');
  if (typeof ssShowToast === 'function') ssShowToast('证券分析页还没加载完成，请稍后重试');
}
async function ssSwitchMarket(market) {
  var next = String(market || '').toUpperCase(); if (!['CN', 'HK'].includes(next) || next === ssState.market) return;
  ssRememberSourceSelection(); ssState.market = next; ssState.seq += 1; ssState.contextVersion += 1; ssResetDisplayedRun(); if (typeof ssRenderMarketTabs === 'function') ssRenderMarketTabs(ssState); await loadStockSelection();
}
async function ssSwitchPeriod(periodType) {
  var type = String(periodType || ''); if (!SS_KIND_BY_PERIOD[type] || type === ssState.periodType) return;
  ssRememberSourceSelection(); ssState.periodType = type; ssState.periodUserSelected = true; ssState.seq += 1; ssState.contextVersion += 1; ssResetDisplayedRun(); if (typeof ssRenderPeriodTabs === 'function') ssRenderPeriodTabs(ssState); await loadStockSelection();
}
async function ssSelectRun(runId) {
  var id = Number(runId); if (!id || id === Number(ssState.sourceRunId)) return;
  ssState.personalRunId = null; ssState.seq += 1; ssState.contextVersion += 1; ssResetDisplayedRun(); ssState.sourceRunId = id; ssRememberSourceSelection();
  await ssLoadSourceAndMaybePersonal(id);
}

function ssSettingsCopy() { return JSON.parse(JSON.stringify(ssState.settings || {})); }
function ssContextMatches(context) {
  return context && context.version === ssState.contextVersion && context.market === ssState.market
    && context.periodType === ssState.periodType && Number(context.sourceRunId) === Number(ssState.sourceRunId)
    && ssSameOwner(context);
}
function ssComparableSettings(settings) {
  var copy = JSON.parse(JSON.stringify(settings || {}));
  delete copy.customFilterVersion;
  if (copy.schemaVersion === undefined) copy.schemaVersion = 2;
  ['budgetRatioA', 'budgetRatioHk', 'positionRatioA', 'positionRatioHk', 'totalCapital'].forEach(function (key) {
    if (copy[key] === undefined || copy[key] === '') copy[key] = null;
  });
  if (Array.isArray(copy.excludedInstruments)) {
    copy.excludedInstruments.forEach(function (item) {
      // 名称由服务端按证券主档补全，不参与排除身份与操作意图。
      if (!item || typeof item !== 'object') return;
      delete item.name;
      if (item.note === undefined || item.note === '') item.note = null;
      if (item.instrumentId === undefined) item.instrumentId = null;
      if (item.instrumentId !== null && Number.isFinite(Number(item.instrumentId))) item.instrumentId = Number(item.instrumentId);
      if (item.market) item.market = String(item.market).toUpperCase();
      if (item.code) item.code = String(item.code).trim().toUpperCase();
    });
    copy.excludedInstruments.sort(function (a, b) {
      a = a || {}; b = b || {};
      return String(a.market || '').localeCompare(String(b.market || ''))
        || Number(a.instrumentId || 0) - Number(b.instrumentId || 0)
        || String(a.code || '').localeCompare(String(b.code || ''));
    });
  }
  if (copy.industryFilters && typeof copy.industryFilters === 'object') {
    ['CN', 'HK'].forEach(function (market) {
      if (Array.isArray(copy.industryFilters[market])) {
        copy.industryFilters[market] = copy.industryFilters[market].map(function (item) {
          if (typeof item === 'string') item = { code: item };
          if (!item || typeof item !== 'object') return item;
          ['system', 'version', 'name'].forEach(function (key) { if (item[key] === undefined || item[key] === '') item[key] = null; });
          if (item.code) item.code = String(item.code).trim();
          return item;
        });
        copy.industryFilters[market].sort(function (a, b) { return ssIndustryKey(a).localeCompare(ssIndustryKey(b)); });
      }
    });
  }
  function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce(function (result, key) { result[key] = sortKeys(value[key]); return result; }, {});
  }
  return sortKeys(copy);
}
function ssSettingsEquivalent(left, right) {
  return JSON.stringify(ssComparableSettings(left)) === JSON.stringify(ssComparableSettings(right));
}
function ssApplySettingsResult(result, context, options) {
  if (!result || !ssSameOwner(context)) return;
  ssState.settings = result.settings || {}; ssState.settingsRevision = Number(result.revision || 0);
  ssState.settingsError = null; ssState.settingsSaveError = null;
  if (!options || !options.preserveSimulationError) ssState.simulationError = null;
  if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
}
function ssCaptureOperationContext(anchor) {
  var params = anchor ? { positionRatio: anchor.positionRatio, budgetRatio: anchor.budgetRatio } : ssSourceParameters(ssState.sourceRunId);
  return {
    version: ssState.contextVersion, market: anchor && anchor.market ? anchor.market : ssState.market,
    periodType: anchor && anchor.periodType ? anchor.periodType : ssState.periodType,
    sourceRunId: Number(anchor && anchor.sourceRunId ? anchor.sourceRunId : ssState.sourceRunId),
    ownerUser: anchor && anchor.ownerUser ? anchor.ownerUser : ssState.ownerUser,
    ownerIdentity: anchor ? (anchor.ownerIdentity || '') : (ssState.ownerIdentity || ''),
    subjectToken: anchor ? anchor.subjectToken : ssState.subjectToken,
    baselineRunId: anchor && anchor.baselineRunId ? anchor.baselineRunId : (ssState.runId || ssState.sourceRunId),
    settingsRevision: ssState.settingsRevision, positionRatio: params.positionRatio, budgetRatio: params.budgetRatio,
  };
}
async function ssSaveSettings(payload, options) {
  if (!ssState.settingsWritable) { if (typeof ssShowToast === 'function') ssShowToast('个人设置读取失败，暂不能修改；请刷新重试'); return null; }
  options = options || {};
  ssLastSettingsRecovery = null;
  try {
    var expectedRevision = options.expectedRevision === undefined ? ssState.settingsRevision : options.expectedRevision;
    var saved = await window.StockSelectionApi.saveSettings(Object.assign({}, payload, { revision: expectedRevision, expectedSubjectToken: options.context && options.context.subjectToken }));
    if (options.context && !ssSameOwner(options.context)) return null;
    ssApplySettingsResult(saved, options.context || { ownerUser: ssState.ownerUser, ownerIdentity: ssState.ownerIdentity || '' });
    return saved;
  } catch (error) {
    if (options.context && !ssSameOwner(options.context)) return null;
    if (ssHandleAuthFailure(options.context, error)) return null;
    if (error && error.status === 403) {
      ssStopWritesAfterForbidden();
      ssLastSettingsRecovery = { status: 'denied', error: error };
      ssState.settingsSaveError = '当前账号无权修改设置，已停止重试写入。';
      if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
      return null;
    }
    var latest = null;
    try { latest = await window.StockSelectionApi.getSettings(); } catch (readError) {
      if (options.context && !ssSameOwner(options.context)) return null;
      if (ssHandleAuthFailure(options.context, readError)) return null;
      if (readError && readError.status === 403) {
        ssStopWritesAfterForbidden();
        ssLastSettingsRecovery = { status: 'denied', error: readError };
        ssState.settingsSaveError = '当前账号无权修改设置，已停止重试写入。';
        if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
        return null;
      }
      ssLastSettingsRecovery = { status: 'unknown', error: readError };
    }
    if (options.context && !ssSameOwner(options.context)) return null;
    if (latest && options.context && ((latest.ownerUsername && latest.ownerUsername !== options.context.ownerUser)
      || (options.context.subjectToken && latest.subjectToken !== options.context.subjectToken))) {
      ssLastSettingsRecovery = { status: 'identity_changed' };
      return null;
    }
    if (latest && ssSettingsEquivalent(latest.settings, payload)) {
      ssLastSettingsRecovery = { status: 'saved', latest: latest };
      ssApplySettingsResult(latest, options.context || { ownerUser: ssState.ownerUser, ownerIdentity: ssState.ownerIdentity || '' });
      return latest;
    }
    if (latest && (!options.context || ssContextMatches(options.context))) {
      ssLastSettingsRecovery = { status: error.status === 409 ? 'conflict' : 'different', latest: latest };
      ssState.settings = latest.settings || {}; ssState.settingsRevision = Number(latest.revision || 0);
      ssState.settingsSaveError = error.status === 409 ? '设置已被其他窗口修改，已刷新当前设置，正在合并本次操作。' : '保存结果与当前设置不一致，请重试本次操作。';
      if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
    }
    if (!options.deferError && typeof ssShowToast === 'function') ssShowToast('排除设置保存失败：' + (error.message || error));
    return null;
  }
}
function ssSourceParameters(sourceRunId) {
  var portfolio = Number(sourceRunId) === Number(ssState.sourceRunId) ? ssState.sourcePortfolio : null;
  var personal = ssState.run && ssState.run.runKind === 'personal' && Number(ssState.run.sourceRunId || ssState.sourceRunId) === Number(sourceRunId) && ssState.portfolio;
  if (personal) portfolio = ssState.portfolio;
  var settings = ssState.settings || {};
  return {
    positionRatio: portfolio ? portfolio.positionRatio : null,
    budgetRatio: personal && Object.prototype.hasOwnProperty.call(portfolio, 'budgetRatio')
      ? portfolio.budgetRatio : (ssState.market === 'CN' ? settings.budgetRatioA : settings.budgetRatioHk),
  };
}
async function ssSimulate(payload) {
  payload = payload || {}; var sourceRunId = Number(payload.sourceRunId || ssState.sourceRunId);
  if (!sourceRunId) { if (typeof ssShowToast === 'function') ssShowToast('当前市场没有可用的公共来源批次'); return null; }
  var operationContext = payload.operationContext || null;
  var params = operationContext ? { positionRatio: operationContext.positionRatio, budgetRatio: operationContext.budgetRatio } : ssSourceParameters(sourceRunId);
  var positionRatio = payload.positionRatio === undefined || payload.positionRatio === '' ? params.positionRatio : payload.positionRatio;
  var requestId = payload.clientRequestId || (ssState.pendingSimulation && ssState.pendingSimulation.clientRequestId) || ('ss-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  var settingsRevision = payload.settingsRevision === undefined ? ssState.settingsRevision : payload.settingsRevision;
  var baselineRunId = payload.baselineRunId || (operationContext && operationContext.baselineRunId) || ssState.runId || sourceRunId;
  var context = operationContext || { version: ssState.contextVersion, market: ssState.market, periodType: ssState.periodType, sourceRunId: sourceRunId, ownerUser: ssState.ownerUser, ownerIdentity: ssState.ownerIdentity || '', subjectToken: ssState.subjectToken };
  var request = { sourceRunId: sourceRunId, settingsRevision: settingsRevision, positionRatio: positionRatio, budgetRatio: payload.budgetRatio === undefined ? params.budgetRatio : payload.budgetRatio, clientRequestId: requestId, baselineRunId: baselineRunId, expectedSubjectToken: payload.expectedSubjectToken || context.subjectToken };
  var isCurrent = function () {
    return ssContextMatches(context);
  };
  var setPendingFailure = function (error) {
    if (!isCurrent()) return;
    ssState.pendingSimulation = Object.assign({}, request);
    ssState.simulationError = error;
    if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
  };
  if (positionRatio === null || positionRatio === undefined || positionRatio === '') {
    var positionError = ssMakeError('当前来源未记录有效仓位，请选择仓位明确的公共来源。', 409, SS_ERR_POSITION_REQUIRED);
    setPendingFailure(positionError);
    if (typeof ssShowToast === 'function') ssShowToast(positionError.message);
    return null;
  }
  var markSimulationReadFailure = function () {
    if (!isCurrent()) return;
    ssState.simulationError = new Error('个人组合结果读取未完成，请重试');
    if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
    if (typeof ssShowToast === 'function') ssShowToast('组合已生成，但结果读取未完成，可点击重试');
  };
  if (isCurrent()) {
    ssState.pendingSimulation = Object.assign({}, request, payload.resultRunId ? { resultRunId: Number(payload.resultRunId) } : {});
    ssState.simulationError = null;
    if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
  }
  if (payload.resultRunId) {
    var retried = await ssLoadRun(Number(payload.resultRunId), {
      source: false, baselineRunId: baselineRunId,
      preserveCandidateRange: ssState.candidates.length > 0,
      preserveCandidateCount: ssState.candidates.length,
    });
    if (!isCurrent()) return { runId: Number(payload.resultRunId), reused: true };
    if (retried !== true) { markSimulationReadFailure(); return null; }
    if (typeof ssCloseRowActionMenus === 'function') ssCloseRowActionMenus();
    ssState.pendingSimulation = null; ssState.simulationError = null; ssState.personalRunId = Number(payload.resultRunId);
    if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
    return { runId: Number(payload.resultRunId), reused: true };
  }
  try {
    var result = await window.StockSelectionApi.simulate(request);
    if (!isCurrent()) return result;
    var loaded = await ssLoadRun(result.runId, {
      source: false, baselineRunId: baselineRunId,
      preserveCandidateRange: ssState.candidates.length > 0,
      preserveCandidateCount: ssState.candidates.length,
    });
    if (!isCurrent()) return result;
    if (loaded !== true) {
      ssState.pendingSimulation = Object.assign({}, request, { resultRunId: Number(result.runId) });
      markSimulationReadFailure();
      return result;
    }
    if (typeof ssCloseRowActionMenus === 'function') ssCloseRowActionMenus();
    ssState.pendingSimulation = null; ssState.simulationError = null; ssState.personalRunId = Number(result.runId); if (typeof ssShowToast === 'function') ssShowToast(result.reused ? '已恢复个人组合结果' : '已更新个人组合与候选状态');
    if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
    return result;
  } catch (error) {
    if (isCurrent() && ssHandleAuthFailure(context, error)) return null;
    if (isCurrent()) {
      if (error && error.status === 403) {
        ssStopWritesAfterForbidden();
        ssState.pendingSimulation = Object.assign({}, request, { noRetry: true });
        ssState.simulationError = error;
        if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
        if (typeof ssShowToast === 'function') ssShowToast('当前账号无权生成个人组合，已停止重试写入');
        return null;
      }
      ssState.simulationError = error;
      if (error && error.code === SS_ERR_SETTINGS_REVISION) {
        try {
          var latest = await window.StockSelectionApi.getSettings();
          if (!isCurrent()) return null;
          if (latest && latest.ownerUsername && latest.ownerUsername !== context.ownerUser
            || latest && context.subjectToken && latest.subjectToken && latest.subjectToken !== context.subjectToken) {
            ssHandleAuthFailure(context, ssMakeError('登录账号已变化，请重新登录。', 401, 'AUTHENTICATION_REQUIRED'));
            return null;
          }
          ssApplySettingsResult(latest, context, { preserveSimulationError: true });
        } catch (readError) {
          if (isCurrent() && ssHandleAuthFailure(context, readError)) return null;
          if (readError && readError.status === 403 && isCurrent()) {
            ssStopWritesAfterForbidden();
            ssState.pendingSimulation.noRetry = true;
            ssState.simulationError = readError;
          }
        }
      }
      if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
      if (typeof ssShowToast === 'function') ssShowToast(error && error.code === SS_ERR_SETTINGS_REVISION
        ? '设置版本已变化，已刷新最新设置；请重试生成并合并本次排除操作'
        : '组合更新失败（排除已保存），可点击重试');
    }
    return null;
  }
}
async function ssRetrySimulation() {
  if (ssSimulationRetrying) return null;
  ssSimulationRetrying = true;
  try { return await ssRetrySimulationOnce(); }
  finally { ssSimulationRetrying = false; }
}
async function ssRetrySimulationOnce() {
  var pending = ssState.pendingSimulation;
  if (!pending || pending.noRetry) return null;
  var context = { version: ssState.contextVersion, market: ssState.market, periodType: ssState.periodType,
    sourceRunId: Number(pending.sourceRunId || ssState.sourceRunId), ownerUser: ssState.ownerUser,
    ownerIdentity: ssState.ownerIdentity || '', subjectToken: ssState.subjectToken,
    baselineRunId: pending.baselineRunId || ssState.runId || ssState.sourceRunId };
  var isCurrent = function () { return ssContextMatches(context) && ssState.pendingSimulation === pending; };
  if (!isCurrent() || Number(context.sourceRunId) !== Number(ssState.sourceRunId)) return null;
  var error = ssState.simulationError;
  var latest = null;
  if (error && error.code === SS_ERR_POSITION_REQUIRED) {
    if (typeof ssShowToast === 'function') ssShowToast('当前来源未记录有效仓位，请选择其他公共来源。');
    return null;
  }
  if (error && error.code === SS_ERR_SETTINGS_REVISION) {
    try {
      latest = await window.StockSelectionApi.getSettings();
      if (!isCurrent()) return null;
      if (latest && latest.ownerUsername && latest.ownerUsername !== context.ownerUser
        || latest && context.subjectToken && latest.subjectToken && latest.subjectToken !== context.subjectToken) {
        ssHandleAuthFailure(context, ssMakeError('登录账号已变化，请重新登录。', 401, 'AUTHENTICATION_REQUIRED'));
        return null;
      }
      ssApplySettingsResult(latest, context, { preserveSimulationError: true });
    } catch (readError) {
      if (!isCurrent()) return null;
      if (ssHandleAuthFailure(context, readError)) return null;
      if (readError && readError.status === 403) {
        if (ssSameOwner(context) && ssState.pendingSimulation === pending) {
          ssStopWritesAfterForbidden();
          pending.noRetry = true;
          ssState.simulationError = readError;
          if (typeof ssRenderRunHeader === 'function') ssRenderRunHeader(ssState);
        }
        return null;
      }
      return null;
    }
  }
  var operation = ssState.pendingSettingsOperation;
  if (error && error.code === SS_ERR_SETTINGS_REVISION && operation && typeof operation.mutate === 'function' && latest) {
    var rebasedSettings = operation.mutate(ssCurrentExclusions());
    var rebasedResult = await ssSaveSettingsAndSimulate(rebasedSettings, {
      reapply: operation.mutate, label: operation.label || '排除设置', anchorContext: operation.anchorContext,
      expectedRevision: latest.revision, clientRequestId: pending.clientRequestId,
    });
    if (!ssState.pendingSettingsOperation && ssState.settingsWritable) {
      if (ssSettingsMutationQueue.length && ssSettingsMutationQueue[0].mutate === operation.mutate) ssSettingsMutationQueue.shift();
      ssSettingsMutationPaused = false;
      ssDrainSettingsMutationQueue();
    }
    return rebasedResult;
  }
  var retryPayload = Object.assign({}, pending);
  delete retryPayload.noRetry;
  if (latest) {
    retryPayload.settingsRevision = latest.revision;
  }
  var result = await ssSimulate(retryPayload);
  if (result && !ssState.pendingSettingsOperation) {
    ssSettingsMutationPaused = false;
    ssDrainSettingsMutationQueue();
  }
  return result;
}
async function ssSaveSettingsAndSimulate(settingsPayload, options) {
  options = options || {};
  var context = ssCaptureOperationContext(options.anchorContext);
  context.baselineRunId = ssContextMatches(context) ? (ssState.runId || context.sourceRunId) : (context.baselineRunId || context.sourceRunId);
  var expectedRevision = options.expectedRevision === undefined ? context.settingsRevision : options.expectedRevision;
  if (options.reapply) ssState.pendingSettingsOperation = { mutate: options.reapply, label: options.label || '排除设置', anchorContext: options.anchorContext || null,
    attemptedSettings: JSON.parse(JSON.stringify(settingsPayload)), expectedRevision: expectedRevision };
  ssState.settingsSaveError = null;
  ssState.contextVersion += 1; context.version = ssState.contextVersion;
  ssState.seq += 1; ssState.pendingSimulation = null; ssState.simulationError = null;
  var saved = options.confirmedSettings || await ssSaveSettings(settingsPayload, { context: context, expectedRevision: expectedRevision, deferError: true });
  if (options.confirmedSettings) ssApplySettingsResult(saved, context);
  if (!ssSameOwner(context)) return null;
  if (!saved && options.reapply && ssLastSettingsRecovery && ssLastSettingsRecovery.status === 'conflict' && ssContextMatches(context)) {
    var retryContext = ssCaptureOperationContext(options.anchorContext);
    retryContext.baselineRunId = context.baselineRunId;
    ssState.contextVersion += 1; retryContext.version = ssState.contextVersion;
    ssState.seq += 1; ssState.pendingSimulation = null; ssState.simulationError = null;
    var rebasedSettings = options.reapply(ssCurrentExclusions());
    ssState.pendingSettingsOperation.attemptedSettings = JSON.parse(JSON.stringify(rebasedSettings));
    ssState.pendingSettingsOperation.expectedRevision = retryContext.settingsRevision;
    saved = await ssSaveSettings(rebasedSettings, { context: retryContext, expectedRevision: retryContext.settingsRevision, deferError: true });
    context = retryContext;
    if (!ssSameOwner(context)) return null;
  }
  if (!saved) {
    if (ssSameOwner(context)) {
      ssState.settingsSaveError = ssState.settingsSaveError || '设置保存结果未知，请点击重试。';
      if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
      if (typeof ssShowToast === 'function') ssShowToast(ssState.settingsSaveError);
    }
    return null;
  }
  if (ssState.pendingSettingsOperation) {
    ssState.pendingSettingsOperation.attemptedSettings = JSON.parse(JSON.stringify(saved.settings || settingsPayload));
    ssState.pendingSettingsOperation.expectedRevision = Number(saved.revision);
  }
  ssState.settingsSaveError = null;
  var simulation = await ssSimulate({
    operationContext: context, sourceRunId: context.sourceRunId, settingsRevision: saved.revision,
    positionRatio: context.positionRatio, budgetRatio: context.budgetRatio, clientRequestId: options.clientRequestId,
  });
  if (simulation || !ssState.simulationError || ssState.simulationError.code !== SS_ERR_SETTINGS_REVISION) {
    // 设置已经确认落库；只有模拟阶段 revision 冲突还需要保留 mutate，供用户在最新设置上合并重试。
    ssState.pendingSettingsOperation = null;
  }
  return simulation;
}
function ssQueueSettingsMutation(mutate, label, anchorContext) {
  if (!ssState.settingsWritable) {
    if (typeof ssShowToast === 'function') ssShowToast('当前设置不可修改，请重新登录或刷新后重试');
    return Promise.resolve(null);
  }
  var task = new Promise(function (resolve, reject) { ssSettingsMutationQueue.push({ mutate: mutate, label: label, anchorContext: anchorContext || ssCaptureOperationContext(), resolve: resolve, reject: reject }); });
  if (!ssSettingsMutationPaused) ssDrainSettingsMutationQueue();
  return task;
}
async function ssDrainSettingsMutationQueue() {
  if (ssSettingsMutationRunning || ssSettingsMutationPaused) return;
  ssSettingsMutationRunning = true;
  while (ssSettingsMutationQueue.length && !ssSettingsMutationPaused) {
    var operation = ssSettingsMutationQueue.shift();
    try {
      if (!ssSameOwner(operation.anchorContext)) { operation.resolve(null); continue; }
      if (!ssState.settingsWritable) {
        if (typeof ssShowToast === 'function') ssShowToast('设置读取失败，排除操作已禁用，请刷新重试');
        operation.resolve(null);
      } else {
        var result = await ssSaveSettingsAndSimulate(operation.retryPayload || operation.mutate(ssCurrentExclusions()), { reapply: operation.mutate, label: operation.label, anchorContext: operation.anchorContext,
          expectedRevision: operation.retryRevision, confirmedSettings: operation.confirmedSettings });
        operation.resolve(result);
        if (!ssSameOwner(operation.anchorContext)) continue;
        if (result === null && ssState.pendingSettingsOperation) {
          // 保存未确认时必须把失败操作放回队首；后续快速点击的意图留在队列中，不能被成功保存覆盖。
          ssSettingsMutationQueue.unshift({ mutate: operation.mutate, label: operation.label, anchorContext: operation.anchorContext, resolve: function () {}, reject: function () {} });
          ssSettingsMutationPaused = true;
          break;
        }
        // 组合生成失败后，后续排除会基于已保存的最新设置重新生成；它代表更新后的完整意图，
        // 不再保留已被新排除覆盖的旧结果读取请求。
      }
    } catch (error) { operation.reject(error); }
  }
  ssSettingsMutationRunning = false;
}
async function ssRetrySettings() {
  var pending = ssState.pendingSettingsOperation;
  if (!pending || typeof pending.mutate !== 'function' || ssSettingsRetrying) return null;
  ssSettingsRetrying = true;
  try {
    var context = ssCaptureOperationContext(pending.anchorContext);
    if (!ssSameOwner(context)) return null;
    var latest = null;
    try { latest = await window.StockSelectionApi.getSettings(); } catch (error) {
      if (ssHandleAuthFailure(context, error)) return null;
      if (error && error.status === 403) {
        if (ssSameOwner(context) && ssState.pendingSettingsOperation === pending) {
          ssStopWritesAfterForbidden();
          ssState.settingsSaveError = '当前账号无权修改设置，已停止重试写入。';
          if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
        }
        return null;
      }
      // 读取失败时只能使用原 revision 与原载荷做 CAS，不能盲目覆盖。
    }
    if (!ssSameOwner(context) || ssState.pendingSettingsOperation !== pending) return null;
    if (latest && (!latest.settings || typeof latest.settings !== 'object' || Array.isArray(latest.settings)
      || latest.revision === null || latest.revision === undefined || !Number.isInteger(Number(latest.revision)))) latest = null;
    if (latest && ((latest.ownerUsername && latest.ownerUsername !== context.ownerUser)
      || (context.subjectToken && latest.subjectToken !== context.subjectToken))) {
      ssState.settingsSaveError = '登录账号已变化，请刷新后重试。';
      if (typeof ssRenderExclusions === 'function') ssRenderExclusions(ssState);
      return null;
    }
    if (!ssSettingsMutationQueue.length || ssSettingsMutationQueue[0].mutate !== pending.mutate) {
      ssSettingsMutationQueue.unshift({ mutate: pending.mutate, label: pending.label || '排除设置', anchorContext: pending.anchorContext, resolve: function () {}, reject: function () {} });
    }
    var operation = ssSettingsMutationQueue[0];
    if (latest) {
      ssApplySettingsResult(latest, context);
      if (ssSettingsEquivalent(latest.settings, pending.attemptedSettings)) operation.confirmedSettings = latest;
    } else {
      operation.retryPayload = pending.attemptedSettings;
      operation.retryRevision = pending.expectedRevision;
    }
    ssSettingsMutationPaused = false;
    return await ssDrainSettingsMutationQueue();
  } finally { ssSettingsRetrying = false; }
}
function ssIndustryKey(item) { if (typeof item === 'string') item = { code: item }; return item && item.code ? [item.system || '', item.version || '', item.code].join('::') : ''; }
function ssCurrentExclusions() {
  var settings = ssSettingsCopy(); if (!settings.industryFilters) settings.industryFilters = { CN: [], HK: [] };
  if (!Array.isArray(settings.industryFilters.CN)) settings.industryFilters.CN = []; if (!Array.isArray(settings.industryFilters.HK)) settings.industryFilters.HK = [];
  if (!Array.isArray(settings.excludedInstruments)) settings.excludedInstruments = []; return settings;
}
async function ssExcludeTarget(kind, target) {
  var market = ssState.market;
  var anchorContext = ssCaptureOperationContext();
  return ssQueueSettingsMutation(function (settings) {
    if (kind === 'instrument') {
      var exists = settings.excludedInstruments.some(function (item) { return String(item.market).toUpperCase() === market && Number(item.instrumentId) === Number(target.instrumentId); });
      if (!exists) settings.excludedInstruments.push({ market: market, code: target.code, name: target.name || null, instrumentId: Number(target.instrumentId), note: null });
    } else if (kind === 'industry' && target.industry && target.industry.code) {
      var list = settings.industryFilters[market]; if (!list.some(function (item) { return ssIndustryKey(item) === ssIndustryKey(target.industry); })) list.push(target.industry);
    }
    return settings;
  }, '排除设置', anchorContext);
}
async function ssRestoreExclusion(kind, target) {
  var market = ssState.market;
  var anchorContext = ssCaptureOperationContext();
  return ssQueueSettingsMutation(function (settings) {
    if (kind === 'instrument') settings.excludedInstruments = settings.excludedInstruments.filter(function (item) { return !(String(item.market).toUpperCase() === market && (Number(item.instrumentId) === Number(target.instrumentId) || String(item.code) === String(target.code))); });
    else settings.industryFilters[market] = settings.industryFilters[market].filter(function (item) { return ssIndustryKey(item) !== ssIndustryKey(target.industry || target); });
    return settings;
  }, '排除设置', anchorContext);
}

window.StockSelectionPresenter = {
  state: ssState, load: loadStockSelection, switchMarket: ssSwitchMarket, selectRun: ssSelectRun, loadMoreRuns: ssLoadMoreRuns,
  switchPeriod: ssSwitchPeriod, loadMore: ssLoadMoreCandidates, openStock: ssOpenStock, openInAnalysis: ssOpenInAnalysis,
  saveSettings: ssSaveSettings, saveSettingsAndSimulate: ssSaveSettingsAndSimulate, simulate: ssSimulate,
  retrySimulation: ssRetrySimulation,
  excludeTarget: ssExcludeTarget, restoreExclusion: ssRestoreExclusion, retrySettings: ssRetrySettings,
  formatPercent: ssFormatPercent, formatNumber: ssFormatNumber, formatAmount: ssFormatAmount,
};
