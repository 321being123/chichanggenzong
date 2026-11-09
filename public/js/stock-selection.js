// 股票筛选 View：只渲染和上报用户操作，不直接发请求。
'use strict';

function ssEsc(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value === null || value === undefined ? '' : value);
  return String(value === null || value === undefined ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function ssSetStatus(text) { var node = document.getElementById('ss-status'); if (node) node.textContent = text || ''; }
function ssSetError(error) { var node = document.getElementById('ss-status'); if (node) node.textContent = '数据加载失败：' + ((error && error.message) || error); }
function ssShowToast(text) { if (typeof showToast === 'function') showToast(text); }
function ssEl(id) { return document.getElementById(id); }
var ssMetricTooltipButton = null;
var ssMetricTooltipSequence = 0;
var ssMetricTooltipRestoringFocus = false;
var ssMetricTooltipHoveredButton = null;

function ssPositionMetricTooltip(button, tip) {
  if (!button || !tip || !document.contains(button) || !document.contains(tip)) {
    if (ssMetricTooltipButton === button || ssMetricTooltipButton && !document.contains(ssMetricTooltipButton)) ssCloseMetricTooltip(false);
    return;
  }
  var rect = button.getBoundingClientRect();
  var viewportWidth = Number(window.innerWidth) || 800;
  var viewportHeight = Number(window.innerHeight) || 600;
  var width = tip.offsetWidth || 0;
  var height = tip.offsetHeight || 0;
  var left = Math.max(8, Math.min(viewportWidth - width - 8, Number(rect.left) || 0));
  var rectTop = Number(rect.top);
  var rectBottom = Number(rect.bottom);
  if (!isFinite(rectTop)) rectTop = rectBottom;
  if (!isFinite(rectBottom)) rectBottom = rectTop;
  var top = rectBottom + 6;
  var above = rectTop - height - 6;
  if (top + height > viewportHeight - 8 && above >= 8) top = above;
  top = Math.max(8, Math.min(viewportHeight - height - 8, top));
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
function ssCloseMetricTooltip(restoreFocus) {
  var button = ssMetricTooltipButton; var tip = document.querySelector ? document.querySelector('.ss-metric-tooltip') : null;
  if (tip) tip.remove();
  if (button) button.removeAttribute('aria-describedby');
  ssMetricTooltipButton = null;
  ssMetricTooltipHoveredButton = null;
  if (restoreFocus && button && document.contains(button) && typeof button.focus === 'function') {
    ssMetricTooltipRestoringFocus = true; button.focus(); ssMetricTooltipRestoringFocus = false;
  }
}
function ssOpenMetricTooltip(button) {
  if (!button) return;
  var existing = document.querySelector('.ss-metric-tooltip');
  if (existing && ssMetricTooltipButton === button) { ssPositionMetricTooltip(button, existing); return; }
  if (existing || ssMetricTooltipButton) ssCloseMetricTooltip(false);
  var tip = document.createElement('div');
  var tipId = 'ss-metric-tooltip-' + (++ssMetricTooltipSequence);
  tip.className = 'ss-metric-tooltip'; tip.id = tipId; tip.setAttribute('role', 'tooltip');
  tip.setAttribute('data-for', button.getAttribute('data-ss-metric-help') || '');
  var text = document.createElement('span'); text.textContent = button.getAttribute('data-ss-help-text') || '';
  var close = document.createElement('button'); close.type = 'button'; close.className = 'ss-metric-tooltip-close';
  close.setAttribute('data-ss-tooltip-close', '1'); close.setAttribute('aria-label', '关闭说明'); close.textContent = '×';
  tip.appendChild(text); tip.appendChild(close); document.body.appendChild(tip);
  button.setAttribute('aria-describedby', tipId); ssMetricTooltipButton = button;
  close.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); ssCloseMetricTooltip(true); });
  ssPositionMetricTooltip(button, tip);
}

function ssTargetFromNode(node) {
  return {
    code: node.getAttribute('data-ss-code') || '', name: node.getAttribute('data-ss-name') || '',
    instrumentId: Number(node.getAttribute('data-ss-instrument-id') || 0),
    industry: node.getAttribute('data-ss-industry-code') ? {
      code: node.getAttribute('data-ss-industry-code'), name: node.getAttribute('data-ss-industry-name') || null,
      system: node.getAttribute('data-ss-industry-system') || null, version: node.getAttribute('data-ss-industry-version') || null,
    } : null,
  };
}

function ssInitView() {
  if (window.__ssReady) return; window.__ssReady = true;
  var tabs = ssEl('ss-tabs');
  if (tabs) tabs.addEventListener('click', function (event) { var button = event.target.closest('[data-ss-market]'); if (button && window.StockSelectionPresenter) window.StockSelectionPresenter.switchMarket(button.dataset.ssMarket); });
  var runSelect = ssEl('ss-run-select');
  if (runSelect) runSelect.addEventListener('change', function (event) { if (window.StockSelectionPresenter) window.StockSelectionPresenter.selectRun(event.target.value); });
  var runMore = ssEl('ss-run-load-more');
  if (runMore) runMore.addEventListener('click', function () { if (window.StockSelectionPresenter) window.StockSelectionPresenter.loadMoreRuns(); });
  var periodTabs = ssEl('ss-period-tabs');
  if (periodTabs) periodTabs.addEventListener('click', function (event) { var button = event.target.closest('[data-ss-period]'); if (button && window.StockSelectionPresenter) window.StockSelectionPresenter.switchPeriod(button.dataset.ssPeriod); });
  ['ss-candidates', 'ss-portfolio', 'ss-exclusions'].forEach(function (id) {
    var root = ssEl(id); if (!root) return;
    root.addEventListener('click', function (event) {
      var action = event.target.closest('[data-ss-action]');
      if (action && window.StockSelectionPresenter) {
        event.preventDefault(); event.stopPropagation();
        var target = ssTargetFromNode(action); var kind = action.getAttribute('data-ss-action');
        if (kind === 'exclude-instrument') window.StockSelectionPresenter.excludeTarget('instrument', target);
        else if (kind === 'exclude-industry') window.StockSelectionPresenter.excludeTarget('industry', target);
        else if (kind === 'restore-instrument') window.StockSelectionPresenter.restoreExclusion('instrument', target);
        else if (kind === 'restore-industry') window.StockSelectionPresenter.restoreExclusion('industry', target);
        else if (kind === 'retry-settings') window.StockSelectionPresenter.retrySettings();
        return;
      }
      if (event.target.closest('.ss-row-actions')) return;
      var jump = event.target.closest('[data-ss-analysis]');
      if (jump && window.StockSelectionPresenter) { event.preventDefault(); event.stopPropagation(); window.StockSelectionPresenter.openInAnalysis(jump.getAttribute('data-ss-analysis')); return; }
      if (id === 'ss-candidates') {
        var row = event.target.closest('[data-ss-code]'); if (row && window.StockSelectionPresenter) window.StockSelectionPresenter.openStock(row.dataset.ssCode);
      }
    });
  });
  document.addEventListener('mouseover', function (event) {
    var button = event.target.closest('[data-ss-metric-help]');
    if (button && (!event.relatedTarget || !button.contains(event.relatedTarget))) {
      ssMetricTooltipHoveredButton = button; ssOpenMetricTooltip(button);
    }
  });
  document.addEventListener('mouseout', function (event) {
    var button = event.target.closest('[data-ss-metric-help]');
    if (button) {
      if (button.contains(event.relatedTarget)) return;
      ssMetricTooltipHoveredButton = null;
      var buttonTip = document.querySelector('.ss-metric-tooltip');
      if (buttonTip && event.relatedTarget && buttonTip.contains(event.relatedTarget)) return;
      if (document.activeElement !== button) ssCloseMetricTooltip(false);
      return;
    }
    var tip = event.target.closest('.ss-metric-tooltip');
    if (!tip || tip.contains(event.relatedTarget)) return;
    if (event.relatedTarget && ssMetricTooltipButton && ssMetricTooltipButton.contains(event.relatedTarget)) return;
    if (!tip.contains(document.activeElement)) ssCloseMetricTooltip(false);
  });
  document.addEventListener('focusin', function (event) {
    var button = event.target.closest('[data-ss-metric-help]'); if (button && !ssMetricTooltipRestoringFocus) ssOpenMetricTooltip(button);
  });
  document.addEventListener('focusout', function (event) {
    var button = event.target.closest('[data-ss-metric-help]');
    var tip = document.querySelector('.ss-metric-tooltip');
    var next = event.relatedTarget;
    if (button && ssMetricTooltipButton === button && next && (button.contains(next) || tip && tip.contains(next))) return;
    if (button && ssMetricTooltipButton === button && ssMetricTooltipHoveredButton === button) return;
    var fromTip = event.target.closest('.ss-metric-tooltip');
    if (fromTip && next && (next === ssMetricTooltipButton || ssMetricTooltipButton && ssMetricTooltipButton.contains(next) || fromTip.contains(next))) return;
    if (button === ssMetricTooltipButton || fromTip) ssCloseMetricTooltip(false);
  });
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-ss-metric-help]');
    if (button) { event.preventDefault(); ssOpenMetricTooltip(button); return; }
    if (!event.target.closest('.ss-metric-tooltip')) {
      var focusable = event.target.closest('a,button,input,select,textarea,[tabindex]:not([tabindex="-1"])');
      ssCloseMetricTooltip(!focusable);
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && document.querySelector('.ss-metric-tooltip')) { event.preventDefault(); ssCloseMetricTooltip(true); }
  });
  window.addEventListener('resize', function () { if (ssMetricTooltipButton) ssPositionMetricTooltip(ssMetricTooltipButton, document.querySelector('.ss-metric-tooltip')); });
  window.addEventListener('scroll', function () { if (ssMetricTooltipButton) ssPositionMetricTooltip(ssMetricTooltipButton, document.querySelector('.ss-metric-tooltip')); }, true);
}

function ssRenderMarketTabs(state) { document.querySelectorAll('[data-ss-market]').forEach(function (button) { button.classList.toggle('active', button.dataset.ssMarket === state.market); }); }
var SS_STATUS_TEXT = { execution: { succeeded: '执行成功', pending: '待执行', failed: '执行失败', blocked: '已阻断' }, quality: { passed: '数据完整', partial: '数据待补', failed: '质量未通过', pending: '未判定' }, business: { eligible: '可投资', market_closed: '市场暂不配置', insufficient_candidates: '合格股不足', no_eligible_member: '本期无合格股票（空仓）', insufficient_data: '数据不足以发布正式组合', market_data_missing: '市场估值缺失', personal_simulation: '个人组合' } };
var SS_GATE_TEXT = { eligible: '准入通过（指数 PB < 2）', market_closed: '本轮不配置（指数 PB ≥ 2）', data_missing: '指数 PB 缺失，数据故障', not_required: '指数仅参考（V2 不设门槛）' };
var SS_RUN_KIND_TEXT = { quarterly: '正式季度', daily: '每日动态', weekly: '每周正式', preview: '预览', personal: '个人组合' };
function ssRenderPeriodTabs(state) { document.querySelectorAll('[data-ss-period]').forEach(function (button) { button.classList.toggle('active', button.dataset.ssPeriod === state.periodType); }); }
function ssRenderRuleScope(state) {
  var selected = (state.runs || []).find(function (run) { return Number(run.runId) === Number(state.sourceRunId); });
  var sourceStrategy = state.run && (state.run.strategyCode || state.run.strategyVersion);
  if (!sourceStrategy && selected) sourceStrategy = selected.strategyCode || selected.strategyVersion;
  var isV2 = String(sourceStrategy || state.strategyCode || '').indexOf('_v2') >= 0;
  document.querySelectorAll('[data-ss-rule]').forEach(function (node) { node.hidden = node.getAttribute('data-ss-rule') !== (isV2 ? 'v2' : 'v1'); });
}

function ssRenderMarkets(state) {
  var root = ssEl('ss-market-cards'); if (!root) return; ssCloseMetricTooltip(false); ssRenderMarketTabs(state);
  var item = (state.markets || []).find(function (entry) { return entry.market === state.market; });
  if (!item) { root.innerHTML = '<div class="ss-empty">当前市场暂无概览数据</div>'; return; }
  var position = item.referencePosition === null || item.referencePosition === undefined ? '本轮不配置' : Math.round(item.referencePosition * 100) + '%';
  var latest = item.latestRun || null; var latestText = latest ? (latest.period_key || latest.periodKey || latest.quarter || latest.as_of_date || latest.asOfDate || '') + '（' + (latest.selected_count === undefined ? latest.selectedCount : latest.selected_count) + ' 只）' : '尚未发布';
  var readiness = item.selectedPeriodStatus
    ? (item.selectedPeriodStatus.samePeriodPublished
      ? (item.activePeriodType === 'day' ? '今日已发布' : '本周已发布')
      : (item.activePeriodType === 'day' ? '今日待就绪' : '本周待就绪')) : '';
  root.innerHTML = '<div class="ss-card bond-feature-stat active"><div class="ss-card-head"><strong>' + ssEsc(item.label) + '</strong><span class="ss-gate ss-gate-' + ssEsc(item.gate.status) + '">' + ssEsc(SS_GATE_TEXT[item.gate.status] || item.gate.status) + '</span></div><div class="ss-card-body">'
    + '<div><span>' + ssEsc(item.proxyLabel || item.benchmarkLabel + ' PB（市场代理）') + '</span><strong>' + (item.pb === null ? '--' : Number(item.pb).toFixed(3)) + '</strong></div>'
    + '<div><span>' + ssEsc(item.benchmarkLabel) + ' PE（TTM）</span><strong>' + (item.pe === null ? '--' : Number(item.pe).toFixed(2)) + '</strong></div>'
    + '<div><span>估值日期</span><strong>' + ssEsc(item.asOfDate || '--') + '</strong></div><div><span>PB 参考仓位</span><strong>' + ssEsc(position) + '</strong></div>'
    + '<div><span>所选周期最新来源</span><strong>' + ssEsc(latestText) + '</strong></div>' + (readiness ? '<div><span>' + (item.activePeriodType === 'day' ? '今日状态' : '本周状态') + '</span><strong>' + ssEsc(readiness) + '</strong></div>' : '')
    + '</div><div class="ss-card-note">口径：' + ssEsc(item.valuationMethodLabel || '总市值加权') + (item.marketValuationRole === 'display_only' ? '；指数估值仅供参考，不决定是否配置。' : '；仅用于判断市场环境，不替代个股数据。') + '</div></div>';
}

function ssRenderRuns(state) {
  var select = ssEl('ss-run-select'); if (!select) return; var runs = state.runs || [];
  if (!runs.length) { select.innerHTML = '<option value="">暂无已发布公共来源</option>'; select.disabled = true; } else {
    select.disabled = false; select.innerHTML = runs.map(function (run) {
      var period = run.periodKey || run.quarter || run.asOfDate; var label = period + ' · ' + (SS_RUN_KIND_TEXT[run.runKind] || run.runKind) + ' · ' + run.selectedCount + ' 只';
      return '<option value="' + ssEsc(run.runId) + '"' + (Number(run.runId) === Number(state.sourceRunId) ? ' selected' : '') + '>' + ssEsc(label) + '</option>';
    }).join('');
  }
  var more = ssEl('ss-run-load-more'); if (more) more.disabled = state.runs.length >= state.runTotal || !runs.length;
}
function ssRenderRunHeader(state) {
  var root = ssEl('ss-run-header'); if (!root) return; ssCloseMetricTooltip(false); var run = state.run;
  if (!run) { root.innerHTML = ''; return; }
  var quality = SS_STATUS_TEXT.quality[run.qualityStatus] || run.qualityStatus; var business = SS_STATUS_TEXT.business[run.businessStatus] || run.businessStatus; var execution = SS_STATUS_TEXT.execution[run.executionStatus] || run.executionStatus;
  var personal = run.runKind === 'personal' ? '<span class="ss-tag ss-tag-ok">个人组合</span> 来源 #' + ssEsc(run.sourceRunId || state.sourceRunId) + ' · 设置版本 ' + ssEsc(run.settingsRevision || '--') : '<span class="ss-tag">公共来源</span>';
  root.innerHTML = '<div class="ss-run-meta">' + personal + '<span>批次 #' + ssEsc(run.runId) + '</span><span>周期 ' + ssEsc(run.periodKey || run.quarter || '--') + '</span><span>目标日 ' + ssEsc(run.asOfDate) + '</span><span>策略 ' + ssEsc(run.strategyVersion) + '</span><span>执行：' + ssEsc(execution) + '</span><span>质量：' + ssEsc(quality) + '</span><span>业务：' + ssEsc(business) + '</span></div>'
    + '<div class="ss-run-note">排名池 ' + ssEsc(run.universeCount) + ' 只，待补 ' + ssEsc(run.pendingCount) + ' 只；入选 ' + ssEsc(run.selectedCount) + ' 只。来源、周期和设置版本均绑定当前页面上下文。</div>'
    + (state.pendingSimulation && !state.simulationError ? '<div class="ss-run-note" role="status" aria-live="polite">个人组合更新中（设置版本 ' + ssEsc(state.pendingSimulation.settingsRevision) + '）；当前展示结果尚未更新，请等待组合与候选状态读取完成。</div>' : '')
    + (state.simulationError && state.pendingSimulation ? '<div class="ss-run-error">'
      + (state.simulationError.code === 'STOCK_SELECTION_POSITION_REQUIRED'
        ? '个人组合暂未生成：当前来源未记录有效仓位，请选择其他公共来源。'
        : state.simulationError.status === 403 || state.pendingSimulation.noRetry
          ? '当前账号无权生成个人组合，已停止重试写入。'
          : state.simulationError.code === 'STOCK_SELECTION_SETTINGS_REVISION_CONFLICT'
            ? '设置版本已变化，已刷新最新设置；重试时会合并本次排除操作。'
            : '个人组合更新失败，排除设置已保存。')
      + (state.simulationError.status === 403 || state.pendingSimulation.noRetry || state.simulationError.code === 'STOCK_SELECTION_POSITION_REQUIRED' ? '' : '<button type="button" class="btn btn-outline btn-sm" id="ss-retry-simulation">'
        + (state.simulationError.code === 'STOCK_SELECTION_POSITION_REQUIRED' ? '刷新设置并重试' : '重试更新个人组合') + '</button>')
      + '</div>' : '');
  var retry = ssEl('ss-retry-simulation');
  if (retry) retry.addEventListener('click', function () { if (window.StockSelectionPresenter && window.StockSelectionPresenter.retrySimulation) window.StockSelectionPresenter.retrySimulation(); });
}

function ssHelp(label, text) { return '<button type="button" class="ss-metric-help" data-ss-metric-help="' + ssEsc(label) + '" data-ss-help-text="' + ssEsc(text) + '" aria-label="查看' + ssEsc(label) + '说明">ⓘ</button>'; }
var SS_PERSONAL_REASON_TEXT = {
  user_excluded_instrument: '个人排除股票', user_excluded_industry: '个人排除行业',
  annual_anomaly: '年度财务异常', annual_anomaly_pending: '年度财务异常待核验',
  annual_anomaly_not_evaluable: '年度财务异常不可评估', risk_held: '风险暂缓',
  rule_or_data_pending: '规则或排名数据待补', rule_not_passed: '基础规则不符合',
  rule_not_evaluable: '基础规则不可评估', industry_unverified: '行业待核验',
  industry_limit: '行业上限', slots_full: '席位已满', zero_position: '本批次零仓位，保留观察',
  not_selected: '历史结果未记录具体原因',
};
function ssPersonalCandidateLabel(item) {
  if (item.personalSelected) return '<span class="ss-tag ss-tag-ok">个人入选</span>';
  var reasons = item.personalNonSelectionReasons || item.personalExclusionReasons || [];
  if (!item.personalExcluded && item.personalStatus !== 'not_selected' && !reasons.length) return '';
  if (!reasons.length) reasons = ['not_selected'];
  return '<span class="ss-tag ss-tag-warn">' + (item.personalExcluded ? '个人排除：' : '个人未入选：')
    + reasons.map(function (reason) { return ssEsc(SS_PERSONAL_REASON_TEXT[reason] || reason); }).join('、') + '</span>';
}
function ssIndustryAction(item) {
  var industry = item.industry; var attrs = ' data-ss-code="' + ssEsc(item.code) + '" data-ss-name="' + ssEsc(item.name || '') + '" data-ss-instrument-id="' + ssEsc(item.instrumentId) + '"';
  var industryAttrs = industry ? attrs + ' data-ss-industry-code="' + ssEsc(industry.code) + '" data-ss-industry-name="' + ssEsc(industry.name || '') + '" data-ss-industry-system="' + ssEsc(industry.system || '') + '" data-ss-industry-version="' + ssEsc(industry.version || '') + '"' : attrs;
  var reasons = Array.isArray(item.personalExclusionReasons) ? item.personalExclusionReasons : [];
  var instrumentAction = reasons.includes('user_excluded_instrument')
    ? '<button type="button" data-ss-action="restore-instrument"' + attrs + '>恢复该股票</button>'
    : '<button type="button" data-ss-action="exclude-instrument"' + attrs + '>排除该股票</button>';
  var industryAction = !industry ? '<span class="ss-disabled-note">行业待核验，不能按行业排除</span>'
    : reasons.includes('user_excluded_industry')
      ? '<button type="button" data-ss-action="restore-industry"' + industryAttrs + '>恢复该行业</button>'
      : '<button type="button" data-ss-action="exclude-industry"' + industryAttrs + '>排除该行业</button>';
  return '<details class="ss-row-actions"><summary>操作</summary><div class="ss-row-menu">' + instrumentAction + industryAction + '</div></details>';
}

function ssActionFamily(action) {
  return action && action.indexOf('instrument') >= 0 ? 'instrument' : action && action.indexOf('industry') >= 0 ? 'industry' : null;
}

function ssCloseRowActionMenus(root) {
  var scope = root || document;
  if (!scope || !scope.querySelectorAll) return;
  var active = document.activeElement;
  var activeDetails = active && active.closest ? active.closest('details.ss-row-actions') : null;
  var focusTarget = activeDetails ? activeDetails.querySelector('summary') : null;
  scope.querySelectorAll('details.ss-row-actions[open]').forEach(function (details) { details.open = false; });
  if (focusTarget && typeof focusTarget.focus === 'function' && document.contains(focusTarget)) focusTarget.focus();
}

function ssRestoreRowFocus(root, focusedCode, focusedAction, focusedActionFamily, focusedDetailsOpen, fallback) {
  if (!focusedCode) return false;
  var focusedNodes = root.querySelectorAll('[data-ss-code]');
  for (var index = 0; index < focusedNodes.length; index += 1) {
    if (focusedNodes[index].getAttribute('data-ss-code') !== focusedCode) continue;
    var target = null;
    var actionNodes = focusedNodes[index].querySelectorAll('[data-ss-action]');
    if (focusedAction) {
      for (var actionIndex = 0; actionIndex < actionNodes.length; actionIndex += 1) {
        var actionKind = actionNodes[actionIndex].getAttribute('data-ss-action');
        if (actionKind === focusedAction || focusedActionFamily && actionKind.indexOf(focusedActionFamily) >= 0) { target = actionNodes[actionIndex]; break; }
      }
    } else target = focusedNodes[index];
    var details = focusedNodes[index].querySelector('details.ss-row-actions');
    if (details && focusedDetailsOpen) details.open = true;
    if (target && typeof target.focus === 'function') target.focus();
    return !!target;
  }
  var targetFallback = fallback || root;
  if (targetFallback && typeof targetFallback.focus === 'function') {
    if (!targetFallback.hasAttribute('tabindex')) targetFallback.setAttribute('tabindex', '-1');
    targetFallback.focus();
  }
  return false;
}

function ssRenderCandidates(state) {
  var root = ssEl('ss-candidates'); if (!root) return; ssCloseMetricTooltip(false); var list = state.candidates || [];
  var oldViewport = root.querySelector('.biz-table-scroll');
  var oldScrollLeft = oldViewport ? oldViewport.scrollLeft : null;
  var active = document.activeElement; var focusedRow = active && root.contains(active) ? active.closest('tr[data-ss-code]') : null;
  var focusedCode = focusedRow ? focusedRow.getAttribute('data-ss-code') : null;
  var focusedAction = active && focusedRow ? active.getAttribute('data-ss-action') : null;
  var focusedActionFamily = ssActionFamily(focusedAction);
  var focusedDetailsOpen = !!(focusedRow && focusedRow.querySelector('details.ss-row-actions[open]'));
  if (!list.length) {
    root.innerHTML = '<div class="ss-empty">当前市场 / 周期 / 来源暂无候选结果</div>';
    if (focusedRow) ssRestoreRowFocus(root, focusedCode, focusedAction, focusedActionFamily, false, ssEl('ss-exclusions') || ssEl('ss-run-header') || root);
    return;
  }
  var rows = list.map(function (item) {
    var order = item.selectionOrder === null || item.selectionOrder === undefined ? '--' : item.selectionOrder;
    var status = item.filterStatus === 'PASS' ? '<span class="ss-tag ss-tag-ok">四项通过</span>' : item.filterStatus === 'FAIL' ? '<span class="ss-tag ss-tag-bad">不符合</span>' : '<span class="ss-tag ss-tag-warn">数据待补</span>';
    var personal = ssPersonalCandidateLabel(item);
    var reasons = (item.exclusionReasons || []).filter(function (reason) { return reason.rule; }).map(function (reason) { return ssEsc(reason.code); }).join('、');
    var ratio = item.pbPositiveExtremaRatio === null || item.pbPositiveExtremaRatio === undefined ? '--' : Number(item.pbPositiveExtremaRatio).toFixed(2) + '×';
    var product = item.pbPeProduct === null || item.pbPeProduct === undefined ? '--' : Number(item.pbPeProduct).toFixed(2);
    var industry = item.industry ? ssEsc(item.industry.name || item.industry.code) : '分类待核验';
    return '<tr data-ss-code="' + ssEsc(item.code) + '" tabindex="0"><td class="text-right">' + ssEsc(order) + '</td><td><button type="button" class="ss-stock-link" data-ss-analysis="' + ssEsc(item.code) + '">' + ssEsc(item.name || item.code) + '</button><div class="ss-sub">' + ssEsc(item.code) + '</div></td><td>' + industry + '</td>'
      + '<td class="text-right">' + (item.currentPb === null ? '--' : Number(item.currentPb).toFixed(3)) + '</td><td class="text-right">' + (item.historicalPbMin === null || item.historicalPbMin === undefined ? '--' : Number(item.historicalPbMin).toFixed(3) + ' ~ ' + (item.historicalPbMax === null ? '--' : Number(item.historicalPbMax).toFixed(3))) + '</td><td class="text-right">' + ratio + '</td><td class="text-right">' + (item.currentPe === null ? '--' : Number(item.currentPe).toFixed(2)) + '</td><td class="text-right">' + product + '</td><td class="text-right">' + (item.dividendYield === null ? '--' : (Number(item.dividendYield) * 100).toFixed(2) + '%') + '</td><td class="text-right">' + (item.equityCny === null ? '--' : (Number(item.equityCny) / 1e8).toFixed(1) + ' 亿') + '</td><td class="text-right">' + [item.pbRank, item.peRank, item.dividendRank].map(function (v) { return v === null || v === undefined ? '--' : v; }).join(' / ') + '</td><td class="text-right">' + (item.totalScore === null || item.totalScore === undefined ? '--' : item.totalScore) + '</td><td>' + status + (personal ? '<div class="ss-sub">' + personal + '</div>' : '') + (reasons ? '<div class="ss-sub">' + reasons + '</div>' : '') + '</td><td>' + ssIndustryAction(item) + '</td></tr>';
  }).join('');
  root.innerHTML = '<div class="biz-table-scroll"><table class="biz-table"><thead><tr><th class="text-right">名次</th><th>证券</th><th>行业 ' + ssHelp('行业分类', '按来源批次冻结的分类体系、版本和行业代码识别；缺失时不能按行业排除。') + '</th><th class="text-right">PB ' + ssHelp('PB', '当前来源批次的市净率；缺值显示“—”，不当作 0。') + '</th><th class="text-right">十年 PB 区间</th><th class="text-right">正极值比' + ssHelp('PB 正极值比', '最近十年有效正 PB 的最高值 ÷ 最低值；覆盖不足或无有效正值时不评估。') + '</th><th class="text-right">PE（TTM）' + ssHelp('PE（TTM）', '滚动十二个月市盈率，按来源批次的财务可见性冻结；亏损/零利润不伪造为低 PE。') + '</th><th class="text-right">PB×PE ' + ssHelp('PB×PE', '仅当 PB 超过阈值且 PE（TTM）为正时计算；直接 PB 阈值通过、PE 缺失、非正或口径不一致时显示“—”，不表示读取失败。') + '</th><th class="text-right">股息率 ' + ssHelp('股息率', '按来源批次冻结的股息率；缺失显示“—”，不混入另行估算值。') + '</th><th class="text-right">净资产（人民币）</th><th class="text-right">三项名次</th><th class="text-right">总分</th><th>结论</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div><div class="ss-list-foot">已显示 ' + list.length + ' / ' + state.candidateTotal + ' 只<button class="btn btn-outline btn-sm" id="ss-load-more"' + (list.length >= state.candidateTotal ? ' disabled' : '') + '>加载更多</button></div>';
  var newViewport = root.querySelector('.biz-table-scroll'); if (newViewport && oldScrollLeft !== null) newViewport.scrollLeft = oldScrollLeft;
  if (focusedCode) ssRestoreRowFocus(root, focusedCode, focusedAction, focusedActionFamily, focusedDetailsOpen, root.querySelector('.ss-list-foot') || ssEl('ss-exclusions') || root);
  var more = ssEl('ss-load-more'); if (more) more.addEventListener('click', function () { if (window.StockSelectionPresenter) window.StockSelectionPresenter.loadMore(); });
  if (window.BusinessTable) window.BusinessTable.attach(root, { page: '#main-stock-selection' }); ssRenderRunHeader(state);
}

function ssRenderPortfolio(state) {
  var root = ssEl('ss-portfolio'); if (!root) return; ssCloseMetricTooltip(false);
  var active = document.activeElement;
  var focusedRow = active && root.contains(active) ? active.closest('tr[data-ss-code]') : null;
  var focusedCode = focusedRow ? focusedRow.getAttribute('data-ss-code') : null;
  var focusedAction = active && focusedRow ? active.getAttribute('data-ss-action') : null;
  var focusedActionFamily = ssActionFamily(focusedAction);
  var focusedDetailsOpen = !!(focusedRow && focusedRow.querySelector('details.ss-row-actions[open]'));
  var portfolio = state.portfolio;
  if (!portfolio) { root.innerHTML = '<div class="ss-empty">当前市场 / 周期 / 来源暂无目标组合</div>'; return; }
  var rows = (portfolio.members || []).map(function (member) {
    var industry = member.industryCode ? { code: member.industryCode, name: member.industryName, system: member.industrySystem, version: member.industryVersion } : null;
    var item = { code: member.code, name: member.name, instrumentId: member.instrumentId, industry: industry };
    var marketWeight = member.weightInMarketBudget === null || member.weightInMarketBudget === undefined ? '--' : (Number(member.weightInMarketBudget) * 100).toFixed(2) + '%';
    var equityWeight = member.weightInEquityTarget === null || member.weightInEquityTarget === undefined ? '--' : (Number(member.weightInEquityTarget) * 100).toFixed(2) + '%';
    return '<tr data-ss-code="' + ssEsc(member.code) + '"><td class="text-right">' + ssEsc(member.slotNo) + '</td><td><button type="button" class="ss-stock-link" data-ss-analysis="' + ssEsc(member.code) + '">' + ssEsc(member.name || member.code) + '</button><div class="ss-sub">' + ssEsc(member.code) + '</div></td><td>' + ssEsc(member.industryName || '分类待核验') + '</td><td class="text-right">' + marketWeight + '</td><td class="text-right">' + equityWeight + '</td><td class="text-right">' + (member.currentPb === null ? '--' : Number(member.currentPb).toFixed(3)) + '</td><td>' + (member.issuerDuplicate ? '<span class="ss-tag ss-tag-warn">A/H 重复暴露</span>' : '') + '</td><td>' + ssIndustryAction(item) + '</td></tr>';
  }).join('');
  var empty = portfolio.members.length ? '' : '<div class="ss-empty">本来源没有可买入席位；空席和剩余仓位保留现金，不放大单只权重。</div>';
   var industries = (portfolio.industryBreakdown || []).map(function (item) { var marketWeight = item.weightInMarketBudget === null || item.weightInMarketBudget === undefined ? '--' : (Number(item.weightInMarketBudget) * 100).toFixed(2) + '%'; var limit = item.limitRatio === null || item.limitRatio === undefined ? '--' : (Number(item.limitRatio) * 100).toFixed(0) + '%'; return '<li>' + ssEsc(item.industryName || item.industryCode) + '：' + ssEsc(item.count) + ' 只，占市场预算 ' + marketWeight + '（上限 ' + limit + '）</li>'; }).join('');
  root.innerHTML = empty + (rows ? '<div class="biz-table-scroll"><table class="biz-table"><thead><tr><th class="text-right">席位 ' + ssHelp('席位', '来源批次按原始排名和席位规则冻结的目标位置；空席保留现金。') + '</th><th>证券</th><th>行业</th><th class="text-right">占市场预算' + ssHelp('参考仓位', '参考仓位是来源批次的冻结参数；实际采用仓位与参考仓位分开显示。') + '</th><th class="text-right">占股票目标' + ssHelp('股票目标权重', '按个人组合目标股票资产计算的权重；空席和剩余仓位保留现金。') + '</th><th class="text-right">PB ' + ssHelp('PB', '当前来源批次冻结的市净率；缺失显示“—”，不当作 0。') + '</th><th>提示</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '')
    + '<div class="ss-portfolio-summary">实际仓位 ' + (portfolio.positionRatio === null ? '—' : (Number(portfolio.positionRatio) * 100).toFixed(0) + '%') + '；已填 ' + portfolio.selectedCount + '/' + portfolio.slots + ' 席，空席 ' + portfolio.unfilledSlots + '；股票占市场预算 ' + (portfolio.equityWeightInMarketBudget === null ? '—' : (Number(portfolio.equityWeightInMarketBudget) * 100).toFixed(2) + '%') + '，现金 ' + (portfolio.cashWeightInMarketBudget === null ? '—' : (Number(portfolio.cashWeightInMarketBudget) * 100).toFixed(2) + '%') + '。</div>'
    + ssRenderChanges(portfolio.changes) + (industries ? '<ul class="ss-industry">' + industries + '</ul>' : '');
  if (focusedCode) ssRestoreRowFocus(root, focusedCode, focusedAction, focusedActionFamily, focusedDetailsOpen,
    root.querySelector('.ss-portfolio-summary') || ssEl('ss-exclusions') || ssEl('ss-run-header') || root);
  if (window.BusinessTable) window.BusinessTable.attach(root, { page: '#main-stock-selection' });
}
function ssRenderChanges(changes) {
  if (!changes) return ''; if (!changes.comparable) return '<div class="ss-portfolio-summary">变动：没有同渠道可比较的上一份来源。</div>';
  var added = (changes.added || []).map(function (item) { return ssEsc(item.code + ' ' + (item.name || '')); }).join('、'); var removed = (changes.removed || []).map(function (item) { return ssEsc(item.code + ' ' + (item.name || '')); }).join('、');
  return '<div class="ss-portfolio-summary">变动（基线 ' + ssEsc(changes.previousPeriodKey || changes.previousQuarter || changes.previousAsOfDate || '来源') + '，保留 ' + ssEsc(changes.kept) + ' 只）：<br>调入：' + (added || '无') + '<br>调出：' + (removed || '无') + '</div>';
}

function ssIndustryIdentity(item) {
  if (typeof item === 'string') item = { code: item };
  return item && item.code ? [item.system || '', item.version || '', item.code].join('::') : '';
}
function ssIndustryMapping(state, item) {
  var source = state.portfolio && Array.isArray(state.portfolio.sourceIndustryIdentityCounts)
    ? state.portfolio.sourceIndustryIdentityCounts : [];
  var hasCode = !!(item && item.code);
  var identityComplete = !!(hasCode && item.system && item.version);
  var exact = hasCode ? source.find(function (row) { return ssIndustryIdentity(row) === ssIndustryIdentity(item); }) : null;
  if (exact) return { mapped: true, identityComplete: identityComplete, affectedCount: Number(exact.affectedCount || 0) };
  var sameCode = source.some(function (row) { return row && row.code === item.code; });
  return { mapped: false, identityComplete: identityComplete, affectedCount: null, reason: !identityComplete ? '配置缺少体系或版本' : sameCode ? '源批次存在同代码但分类身份不同' : '源批次没有同身份证据' };
}

function ssRenderExclusions(state) {
  var root = ssEl('ss-exclusions'); if (!root) return; ssCloseMetricTooltip(false);
  if (state.settingsError) { root.innerHTML = '<div class="ss-exclusion-head"><strong>排除管理</strong><span class="ss-disabled-note">设置读取失败，排除与恢复已禁用，请刷新重试。</span></div>'; return; }
  var settings = state.settings || {}; var industries = ((settings.industryFilters && settings.industryFilters[state.market]) || []).filter(Boolean).map(function (item) { return typeof item === 'string' ? { code: item, system: null, version: null, name: null } : item; }); var stocks = (settings.excludedInstruments || []).filter(function (item) { return item && String(item.market).toUpperCase() === state.market; });
  var count = industries.length + stocks.length;
  var industryRows = industries.map(function (item) {
    var attrs = ' data-ss-industry-code="' + ssEsc(item.code) + '" data-ss-industry-name="' + ssEsc(item.name || '') + '" data-ss-industry-system="' + ssEsc(item.system || '') + '" data-ss-industry-version="' + ssEsc(item.version || '') + '"';
    var mapping = ssIndustryMapping(state, item);
    var identity = '体系 ' + (item.system || '未知') + ' · 版本 ' + (item.version || '未知') + ' · 代码 ' + (item.code || '--');
    var status = mapping.mapped
      ? (mapping.identityComplete ? '<span class="ss-tag ss-tag-ok">已映射</span> 当前来源受影响 ' + ssEsc(mapping.affectedCount) + ' 只' : '<span class="ss-tag ss-tag-warn">已精确命中（身份含未知字段）</span> 当前来源受影响 ' + ssEsc(mapping.affectedCount) + ' 只；不按未知版本通配')
      : '<span class="ss-tag ss-tag-warn">待映射</span> ' + ssEsc(mapping.reason) + '，影响数未知';
    return '<li><span>行业：' + ssEsc(item.name || item.code) + '（' + ssEsc(item.code) + '）<span class="ss-sub">' + ssEsc(identity) + '；' + status + '</span></span><button type="button" class="btn btn-outline btn-sm" data-ss-action="restore-industry"' + attrs + '>恢复</button></li>';
  }).join('');
  var stockRows = stocks.map(function (item) { return '<li><span>股票：' + ssEsc(item.name || item.code) + '（' + ssEsc(item.code) + '）</span><button type="button" class="btn btn-outline btn-sm" data-ss-action="restore-instrument" data-ss-code="' + ssEsc(item.code) + '" data-ss-name="' + ssEsc(item.name || '') + '" data-ss-instrument-id="' + ssEsc(item.instrumentId || '') + '">恢复</button></li>'; }).join('');
  var saveError = state.settingsSaveError ? '<div class="ss-run-error">' + ssEsc(state.settingsSaveError) + (state.pendingSettingsOperation ? '<button type="button" class="btn btn-outline btn-sm" data-ss-action="retry-settings">重试保存排除</button>' : '') + '</div>' : '';
  root.innerHTML = saveError + '<div class="ss-exclusion-head"><strong>排除管理（' + count + '）</strong><span>跨日、周期和来源生效；恢复后会从同一公共来源重新派生。</span></div>' + (count ? '<div class="ss-exclusion-groups">' + (industryRows ? '<div><strong>行业</strong><ul>' + industryRows + '</ul></div>' : '') + (stockRows ? '<div><strong>股票</strong><ul>' + stockRows + '</ul></div>' : '') + '</div>' : '<div class="ss-empty">当前市场没有个人排除项</div>');
}

function ssRenderDetail(state) {
  var root = ssEl('ss-detail'); if (!root) return; ssCloseMetricTooltip(false); var detail = state.detail; if (!detail) { root.hidden = true; root.innerHTML = ''; return; }
  var candidate = detail.candidate; var rules = (candidate.detail && candidate.detail.rules) || {};
  var labels = { R01: '当前 PB', R02: '十年 PB', R04: '股息率', R05: '净资产' };
  var rows = ['R01', 'R02', 'R04', 'R05'].map(function (code) { var rule = rules[code] || {}; return '<tr><td>' + ssEsc(labels[code]) + '</td><td>' + ssEsc(rule.status || '--') + '</td><td>' + ssEsc(rule.reason || '') + '</td><td class="text-right">' + (rule.value === null || rule.value === undefined ? '--' : Number(rule.value).toFixed(4)) + '</td></tr>'; }).join('');
  root.hidden = false; root.innerHTML = '<div class="ss-detail-head"><h3>' + ssEsc(candidate.name || candidate.code) + '（' + ssEsc(candidate.code) + '）</h3><button class="btn btn-outline btn-sm" id="ss-detail-close">关闭</button></div><div class="ss-detail-meta">批次 #' + ssEsc(detail.runId) + ' · 目标日 ' + ssEsc(detail.asOfDate) + ' · 行业 ' + ssEsc(candidate.industry ? candidate.industry.name : '待核验') + ' · PB ' + (candidate.currentPb === null ? '--' : Number(candidate.currentPb).toFixed(3)) + ' · PE（TTM） ' + (candidate.currentPe === null ? '--' : Number(candidate.currentPe).toFixed(2)) + ' · 股息率 ' + (candidate.dividendYield === null ? '--' : (Number(candidate.dividendYield) * 100).toFixed(2) + '%') + '</div><div class="biz-table-scroll"><table class="biz-table"><thead><tr><th>规则</th><th>结论</th><th>原因</th><th class="text-right">取值</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  var personalLabel = ssPersonalCandidateLabel(candidate);
  if (personalLabel) {
    var selectionNote = document.createElement('div'); selectionNote.className = 'ss-detail-note';
    selectionNote.innerHTML = personalLabel;
    root.appendChild(selectionNote);
  }
  var close = ssEl('ss-detail-close'); if (close) close.addEventListener('click', function () { state.detail = null; ssRenderDetail(state); });
}

window.StockSelectionView = { init: ssInitView, setStatus: ssSetStatus, setError: ssSetError, renderMarkets: ssRenderMarkets, renderRuns: ssRenderRuns, renderPeriodTabs: ssRenderPeriodTabs, renderRuleScope: ssRenderRuleScope, renderRunHeader: ssRenderRunHeader, renderCandidates: ssRenderCandidates, renderPortfolio: ssRenderPortfolio, renderExclusions: ssRenderExclusions, renderDetail: ssRenderDetail };
