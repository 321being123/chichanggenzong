// 股票筛选（投资策略选股中心）View。
// 职责：只做渲染与用户操作上报；取数、状态与竞态守卫在 presenters/stock-selection-presenter.js。
// 约定：本文件不发请求（静态门禁 frontend_api_client 校验），也不决定何时采集。
'use strict';

function ssEsc(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value === null || value === undefined ? '' : value);
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ssSetStatus(text) {
  var node = document.getElementById('ss-status');
  if (node) node.textContent = text || '';
}

function ssSetError(error) {
  var node = document.getElementById('ss-status');
  if (node) node.textContent = '数据加载失败：' + ((error && error.message) || error);
}

function ssShowToast(text) {
  if (typeof showToast === 'function') showToast(text);
}

function ssEl(id) { return document.getElementById(id); }

function ssInitView() {
  if (window.__ssReady) return;
  window.__ssReady = true;
  var tabs = ssEl('ss-tabs');
  if (tabs) {
    tabs.addEventListener('click', function (event) {
      var button = event.target.closest('[data-ss-market]');
      if (!button) return;
      if (window.StockSelectionPresenter) window.StockSelectionPresenter.switchMarket(button.dataset.ssMarket);
    });
  }
  var runSelect = ssEl('ss-run-select');
  if (runSelect) {
    runSelect.addEventListener('change', function (event) {
      if (window.StockSelectionPresenter) window.StockSelectionPresenter.selectRun(event.target.value);
    });
  }
  var more = ssEl('ss-load-more');
  if (more) {
    more.addEventListener('click', function () {
      if (window.StockSelectionPresenter) window.StockSelectionPresenter.loadMore();
    });
  }
  var save = ssEl('ss-settings-save');
  if (save) {
    save.addEventListener('click', function () {
      if (!window.StockSelectionPresenter) return;
      window.StockSelectionPresenter.saveSettings({
        budgetRatioA: ssEl('ss-budget-a') ? ssEl('ss-budget-a').value : null,
        budgetRatioHk: ssEl('ss-budget-hk') ? ssEl('ss-budget-hk').value : null,
        positionRatioA: ssEl('ss-position-a') ? ssEl('ss-position-a').value : null,
        positionRatioHk: ssEl('ss-position-hk') ? ssEl('ss-position-hk').value : null,
        totalCapital: ssEl('ss-total-capital') ? ssEl('ss-total-capital').value : null,
      });
    });
  }
  var simulate = ssEl('ss-simulate');
  if (simulate) {
    simulate.addEventListener('click', function () {
      if (!window.StockSelectionPresenter) return;
      window.StockSelectionPresenter.simulate({
        positionRatio: ssEl('ss-simulate-position') ? ssEl('ss-simulate-position').value : null,
      });
    });
  }
  var candidates = ssEl('ss-candidates');
  if (candidates) {
    candidates.addEventListener('click', function (event) {
      var row = event.target.closest('[data-ss-code]');
      if (!row || !window.StockSelectionPresenter) return;
      window.StockSelectionPresenter.openStock(row.dataset.ssCode);
    });
  }
}

function ssRenderMarketTabs(state) {
  document.querySelectorAll('[data-ss-market]').forEach(function (button) {
    button.classList.toggle('active', button.dataset.ssMarket === state.market);
  });
}

var SS_STATUS_TEXT = {
  execution: { succeeded: '执行成功', pending: '待执行', failed: '执行失败', blocked: '已阻断' },
  quality: { passed: '数据完整', partial: '数据待补', failed: '质量未通过', pending: '未判定' },
  business: {
    eligible: '可投资', market_closed: '市场暂不配置', insufficient_candidates: '合格股不足',
    no_eligible_member: '本期无合格股票（空仓）',
    insufficient_data: '数据不足以发布正式组合', market_data_missing: '市场估值缺失',
    personal_simulation: '个人测算',
  },
};

var SS_GATE_TEXT = {
  eligible: '准入通过（指数 PB < 2）',
  market_closed: '本轮不配置（指数 PB ≥ 2）',
  data_missing: '指数 PB 缺失，数据故障',
};

function ssRenderMarkets(state) {
  var root = ssEl('ss-market-cards');
  if (!root) return;
  ssRenderMarketTabs(state);
  if (!state.markets || !state.markets.length) {
    root.innerHTML = '<div class="ss-empty">暂无可用的市场估值数据</div>';
    return;
  }
  root.innerHTML = state.markets.map(function (item) {
    var active = item.market === state.market ? ' active' : '';
    var position = item.referencePosition === null || item.referencePosition === undefined
      ? '本轮不配置' : Math.round(item.referencePosition * 100) + '%';
    return '<div class="ss-card bond-feature-stat' + active + '">'
      + '<div class="ss-card-head"><strong>' + ssEsc(item.label) + '</strong>'
      + '<span class="ss-gate ss-gate-' + ssEsc(item.gate.status) + '">' + ssEsc(SS_GATE_TEXT[item.gate.status] || item.gate.status) + '</span></div>'
      + '<div class="ss-card-body">'
      + '<div><span>' + ssEsc(item.benchmarkLabel) + ' PB（' + ssEsc(item.label) + '市场代理）</span><strong>'
      + (item.pb === null ? '--' : Number(item.pb).toFixed(3)) + '</strong></div>'
      + '<div><span>' + ssEsc(item.benchmarkLabel) + ' PE（TTM）</span><strong>'
      + (item.pe === null ? '--' : Number(item.pe).toFixed(2)) + '</strong></div>'
      + '<div><span>估值日期</span><strong>' + ssEsc(item.asOfDate || '--') + '</strong></div>'
      + '<div><span>PB 参考仓位</span><strong>' + ssEsc(position) + '</strong></div>'
      + '<div><span>当前季度组合</span><strong>'
      + (item.latestRun ? ssEsc(item.latestRun.quarter + '（' + item.latestRun.selected_count + ' 只）') : '尚未发布') + '</strong></div>'
      + '</div>'
      + '<div class="ss-card-note">口径：' + ssEsc(item.valuationMethodLabel || '总市值加权') + '；仅用于判断市场环境，不替代个股数据。</div>'
      + '</div>';
  }).join('');
}

function ssRenderRuns(state) {
  var select = ssEl('ss-run-select');
  if (!select) return;
  var runs = state.runs || [];
  if (!runs.length) {
    select.innerHTML = '<option value="">暂无批次</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = runs.map(function (run) {
    var label = run.quarter + ' · ' + (run.runKind === 'quarterly' ? '正式季度' : run.runKind === 'preview' ? '预览' : '个人测算')
      + ' · ' + (run.publishedAt ? '已发布' : '未发布') + ' · ' + run.selectedCount + ' 只';
    return '<option value="' + ssEsc(run.runId) + '"' + (Number(run.runId) === Number(state.runId) ? ' selected' : '') + '>' + ssEsc(label) + '</option>';
  }).join('');
}

function ssRenderRunHeader(state) {
  var root = ssEl('ss-run-header');
  if (!root) return;
  var run = state.run;
  if (!run) { root.innerHTML = ''; return; }
  var quality = SS_STATUS_TEXT.quality[run.qualityStatus] || run.qualityStatus;
  var business = SS_STATUS_TEXT.business[run.businessStatus] || run.businessStatus;
  var execution = SS_STATUS_TEXT.execution[run.executionStatus] || run.executionStatus;
  var publishText = run.publishedAt ? '已正式发布' : '仅保存为部分数据预览，未替换正式组合';
  root.innerHTML = '<div class="ss-run-meta">'
    + '<span>批次 #' + ssEsc(run.runId) + '</span>'
    + '<span>目标日 ' + ssEsc(run.asOfDate) + '</span>'
    + '<span>信息截止 ' + ssEsc(run.knowledgeCutoff) + '</span>'
    + '<span>策略 ' + ssEsc(run.strategyVersion) + '</span>'
    + '<span>修订 ' + ssEsc(run.revision) + '</span>'
    + '<span>执行：' + ssEsc(execution) + '</span>'
    + '<span>质量：' + ssEsc(quality) + '</span>'
    + '<span>业务：' + ssEsc(business) + '</span>'
    + '<span>' + ssEsc(publishText) + '</span>'
    + '</div>'
    + '<div class="ss-run-note">排名池 ' + ssEsc(run.universeCount) + ' 只，待补 ' + ssEsc(run.pendingCount)
    + ' 只；入选 ' + ssEsc(run.selectedCount) + ' 只。待补不为 0 时不会发布正式可投资组合。</div>';
}

function ssRenderCandidates(state) {
  var root = ssEl('ss-candidates');
  if (!root) return;
  var list = state.candidates || [];
  if (!list.length) {
    root.innerHTML = '<div class="ss-empty">本批次暂无候选记录</div>';
    ssRenderRunHeader(state);
    return;
  }
  var rows = list.map(function (item) {
    var order = item.selectionOrder === null || item.selectionOrder === undefined ? '--' : item.selectionOrder;
    var profit = item.profitStatus === 'loss' ? '<span class="ss-tag ss-tag-warn">亏损（按规则记分）</span>'
      : item.profitStatus === 'zero' ? '<span class="ss-tag ss-tag-warn">零利润（按规则记分）</span>'
        : item.profitStatus === 'unknown' ? '<span class="ss-tag">利润待补</span>' : '';
    var statusTag = item.filterStatus === 'PASS'
      ? '<span class="ss-tag ss-tag-ok">四项通过</span>'
      : item.filterStatus === 'FAIL' ? '<span class="ss-tag ss-tag-bad">不符合</span>'
        : '<span class="ss-tag ss-tag-warn">数据待补</span>';
    var reasons = (item.exclusionReasons || []).filter(function (reason) { return reason.rule; })
      .map(function (reason) { return ssEsc(reason.code); }).join('、');
    return '<tr data-ss-code="' + ssEsc(item.code) + '" tabindex="0">'
      + '<td class="text-right">' + ssEsc(order) + '</td>'
      + '<td><strong>' + ssEsc(item.name || item.code) + '</strong><div class="ss-sub">' + ssEsc(item.code) + '</div></td>'
      + '<td>' + ssEsc(item.industry ? item.industry.name : '分类待核验') + '</td>'
      + '<td class="text-right">' + (item.currentPb === null ? '--' : Number(item.currentPb).toFixed(3)) + '</td>'
      + '<td class="text-right">' + (item.historicalPbMax === null ? '--' : Number(item.historicalPbMax).toFixed(3)) + '</td>'
      + '<td class="text-right">' + (item.currentPe === null ? '--' : Number(item.currentPe).toFixed(2)) + ' ' + profit + '</td>'
      + '<td class="text-right">' + (item.dividendYield === null ? '--' : (Number(item.dividendYield) * 100).toFixed(2) + '%') + '</td>'
      + '<td class="text-right">' + (item.equityCny === null ? '--' : (Number(item.equityCny) / 1e8).toFixed(1) + ' 亿') + '</td>'
      + '<td class="text-right">' + [item.pbRank, item.peRank, item.dividendRank].map(function (v) { return v === null || v === undefined ? '--' : v; }).join(' / ') + '</td>'
      + '<td class="text-right">' + (item.totalScore === null || item.totalScore === undefined ? '--' : item.totalScore) + '</td>'
      + '<td>' + statusTag + (reasons ? '<div class="ss-sub">' + reasons + '</div>' : '') + '</td>'
      + '</tr>';
  }).join('');
  root.innerHTML = '<div class="biz-table-scroll"><table class="biz-table"><thead><tr>'
    + '<th class="text-right">名次</th><th>证券</th><th>行业</th><th class="text-right">PB</th><th class="text-right">十年最高 PB</th>'
    + '<th class="text-right">静态 PE</th><th class="text-right">股息率</th><th class="text-right">净资产（人民币）</th>'
    + '<th class="text-right">PB/PE/股息名次</th><th class="text-right">总分</th><th>结论</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="ss-list-foot">已显示 ' + list.length + ' / ' + state.candidateTotal + ' 只'
    + '<button class="btn btn-outline btn-sm" id="ss-load-more"' + (list.length >= state.candidateTotal ? ' disabled' : '') + '>加载更多</button></div>';
  var more = ssEl('ss-load-more');
  if (more) {
    more.addEventListener('click', function () {
      if (window.StockSelectionPresenter) window.StockSelectionPresenter.loadMore();
    });
  }
  if (window.BusinessTable) window.BusinessTable.attach(root, { page: '#main-stock-selection', sticky: false });
  ssRenderRunHeader(state);
}

function ssRenderPortfolio(state) {
  var root = ssEl('ss-portfolio');
  if (!root) return;
  var portfolio = state.portfolio;
  if (!portfolio) { root.innerHTML = '<div class="ss-empty">暂无组合数据</div>'; return; }
  if (!portfolio.members.length) {
    root.innerHTML = '<div class="ss-empty">本批次没有可买入席位：'
      + '合格股不足或市场本轮不配置。未填席位留现金，不放大单只权重。</div>';
    return;
  }
  var rows = portfolio.members.map(function (member) {
    return '<tr>'
      + '<td class="text-right">' + ssEsc(member.slotNo) + '</td>'
      + '<td><strong>' + ssEsc(member.name || member.code) + '</strong><div class="ss-sub">' + ssEsc(member.code) + '</div></td>'
      + '<td>' + ssEsc(member.industryName || '分类待核验') + '</td>'
      + '<td class="text-right">' + (Number(member.weightInMarketBudget) * 100).toFixed(2) + '%</td>'
      + '<td class="text-right">' + (Number(member.weightInEquityTarget) * 100).toFixed(2) + '%</td>'
      + '<td class="text-right">' + (member.currentPb === null ? '--' : Number(member.currentPb).toFixed(3)) + '</td>'
      + '<td>' + (member.issuerDuplicate ? '<span class="ss-tag ss-tag-warn">A/H 重复暴露</span>' : '') + '</td>'
      + '</tr>';
  }).join('');
  var industries = (portfolio.industryBreakdown || []).map(function (item) {
    return '<li>' + ssEsc(item.industryName || item.industryCode) + '：' + ssEsc(item.count) + ' 只，占市场预算 '
      + (Number(item.weightInMarketBudget) * 100).toFixed(2) + '%（上限 ' + (Number(item.limitRatio) * 100).toFixed(0) + '%）</li>';
  }).join('');
  root.innerHTML = '<div class="biz-table-scroll"><table class="biz-table"><thead><tr>'
    + '<th class="text-right">席位</th><th>证券</th><th>行业</th><th class="text-right">占市场预算</th>'
    + '<th class="text-right">占股票目标</th><th class="text-right">PB</th><th>提示</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="ss-portfolio-summary">仓位 ' + (Number(portfolio.positionRatio) * 100).toFixed(0) + '%，'
    + '已填 ' + portfolio.selectedCount + '/' + portfolio.slots + ' 席，空席 ' + portfolio.unfilledSlots + '；'
    + '股票占市场预算 ' + (Number(portfolio.equityWeightInMarketBudget) * 100).toFixed(2) + '%，'
    + '现金 ' + (Number(portfolio.cashWeightInMarketBudget) * 100).toFixed(2) + '%。</div>'
    + ssRenderChanges(portfolio.changes)
    + (industries ? '<ul class="ss-industry">' + industries + '</ul>' : '');
  if (window.BusinessTable) window.BusinessTable.attach(root, { page: '#main-stock-selection', sticky: false });
}

// 季度调入调出：只在有上一份正式季度组合时才有可比对象，否则明确说明没有对比基准。
function ssRenderChanges(changes) {
  if (!changes) return '';
  if (!changes.comparable) {
    return '<div class="ss-portfolio-summary">季度变动：这是该市场第一份正式季度组合，暂无可比的上一季度。</div>';
  }
  var added = (changes.added || []).map(function (item) { return ssEsc(item.code + ' ' + (item.name || '')); }).join('、');
  var removed = (changes.removed || []).map(function (item) { return ssEsc(item.code + ' ' + (item.name || '')); }).join('、');
  return '<div class="ss-portfolio-summary">季度变动（对比 ' + ssEsc(changes.previousQuarter || '上一季度')
    + '，保留 ' + ssEsc(changes.kept) + ' 只）：<br>调入：' + (added || '无') + '<br>调出：' + (removed || '无') + '</div>';
}

var SS_RULE_LABEL = {
  R01: '当前 PB（0 < PB ≤ 1.5）',
  R02: '十年内出现过 PB > 1',
  R04: '近十二个月现金股息率 > 0',
  R05: '归母净资产 ≥ 100 亿元',
};

var SS_RULE_STATUS = { PASS: '通过', FAIL: '不符合', PENDING: '数据待补', NOT_APPLICABLE: '不适用' };

function ssRenderDetail(state) {
  var root = ssEl('ss-detail');
  if (!root) return;
  var detail = state.detail;
  if (!detail) { root.hidden = true; root.innerHTML = ''; return; }
  var candidate = detail.candidate;
  var rules = (candidate.detail && candidate.detail.rules) || {};
  var ruleRows = ['R01', 'R02', 'R04', 'R05'].map(function (code) {
    var rule = rules[code] || {};
    return '<tr><td>' + ssEsc(SS_RULE_LABEL[code]) + '</td>'
      + '<td>' + ssEsc(SS_RULE_STATUS[rule.status] || rule.status || '--') + '</td>'
      + '<td>' + (rule.reason ? ssEsc(rule.reason) : '') + '</td>'
      + '<td class="text-right">' + (rule.value === null || rule.value === undefined ? '--' : Number(rule.value).toFixed(4)) + '</td></tr>';
  }).join('');
  var anomaly = (candidate.detail && candidate.detail.anomaly) || null;
  var anomalyText = anomaly
    ? ('最新财年 ' + ssEsc(anomaly.latestYear || '--') + ' 利润 ' + (anomaly.profitY === null ? '--' : (Number(anomaly.profitY) / 1e8).toFixed(2) + ' 亿')
      + '，前十年合计 ' + (anomaly.profitSum === null ? '--' : (Number(anomaly.profitSum) / 1e8).toFixed(2) + ' 亿')
      + '；分红 ' + (anomaly.dividendY === null ? '--' : (Number(anomaly.dividendY) / 1e8).toFixed(2) + ' 亿')
      + ' / 十年合计 ' + (anomaly.dividendSum === null ? '--' : (Number(anomaly.dividendSum) / 1e8).toFixed(2) + ' 亿') + '。')
    : '年度异常比较数据待补。';
  root.hidden = false;
  root.innerHTML = '<div class="ss-detail-head"><h3>' + ssEsc(candidate.name || candidate.code) + '（' + ssEsc(candidate.code) + '）</h3>'
    + '<button class="btn btn-outline btn-sm" id="ss-detail-close">关闭</button></div>'
    + '<div class="ss-detail-meta">批次 #' + ssEsc(detail.runId) + ' · 目标日 ' + ssEsc(detail.asOfDate)
    + ' · 行业 ' + ssEsc(candidate.industry ? candidate.industry.name : '待核验')
    + ' · PB ' + (candidate.currentPb === null ? '--' : Number(candidate.currentPb).toFixed(3))
    + ' · 静态 PE ' + (candidate.currentPe === null ? '--' : Number(candidate.currentPe).toFixed(2))
    + '（' + ssEsc(candidate.profitStatus === 'loss' ? '亏损，按规则记分' : candidate.profitStatus === 'zero' ? '零利润，按规则记分' : candidate.profitStatus === 'profit' ? '盈利' : '利润待补') + '）'
    + ' · 股息率 ' + (candidate.dividendYield === null ? '--' : (Number(candidate.dividendYield) * 100).toFixed(2) + '%')
    + ' · 净资产 ' + (candidate.equityCny === null ? '--' : (Number(candidate.equityCny) / 1e8).toFixed(2) + ' 亿元')
    + (candidate.equityCurrency && candidate.equityCurrency !== 'CNY'
      ? '（原币 ' + (candidate.equityAmount === null ? '--' : Number(candidate.equityAmount).toFixed(2)) + ' ' + ssEsc(candidate.equityCurrency)
        + '，汇率 ' + ssEsc(candidate.fxRate || '--') + '（' + ssEsc(candidate.fxDate || '--') + '））' : '')
    + '</div>'
    + '<div class="biz-table-scroll"><table class="biz-table"><thead><tr><th>规则</th><th>结论</th><th>原因</th><th class="text-right">取值</th></tr></thead>'
    + '<tbody>' + ruleRows + '</tbody></table></div>'
    + '<div class="ss-detail-note">年度异常（最新财年 vs 前十年合计，任一严格大于则排除）：' + anomalyText + '</div>';
  var close = ssEl('ss-detail-close');
  if (close) {
    close.addEventListener('click', function () {
      state.detail = null;
      ssRenderDetail(state);
    });
  }
}

function ssRenderSettings(state) {
  var root = ssEl('ss-settings');
  if (!root) return;
  var settings = state.settings || {};
  function value(key) {
    var v = settings[key];
    return v === null || v === undefined ? '' : v;
  }
  root.innerHTML = '<div class="ss-settings-grid">'
    + '<label>A股市场资金占比<input id="ss-budget-a" type="number" min="0" max="1" step="0.01" inputmode="decimal" value="' + ssEsc(value('budgetRatioA')) + '"></label>'
    + '<label>港股市场资金占比<input id="ss-budget-hk" type="number" min="0" max="1" step="0.01" inputmode="decimal" value="' + ssEsc(value('budgetRatioHk')) + '"></label>'
    + '<label>A股目标股票仓位<input id="ss-position-a" type="number" min="0" max="1" step="0.01" inputmode="decimal" value="' + ssEsc(value('positionRatioA')) + '"></label>'
    + '<label>港股目标股票仓位<input id="ss-position-hk" type="number" min="0" max="1" step="0.01" inputmode="decimal" value="' + ssEsc(value('positionRatioHk')) + '"></label>'
    + '<label>总资金（可选）<input id="ss-total-capital" type="number" min="0" step="1000" inputmode="decimal" value="' + ssEsc(value('totalCapital')) + '"></label>'
    + '<label>个人测算仓位<input id="ss-simulate-position" type="number" min="0" max="1" step="0.01" inputmode="decimal" placeholder="例如 0.7"></label>'
    + '</div>'
    + '<div class="ss-settings-actions">'
    + '<button class="btn btn-primary btn-sm" id="ss-settings-save">保存资金设置</button>'
    + '<button class="btn btn-outline btn-sm" id="ss-simulate">用当前批次做个人测算</button>'
    + '</div>'
    + '<div class="ss-settings-note">资金设置只属于本人账号，不写进公共策略版本；两个市场占比之和不能超过 100%。'
    + '个人测算复用已发布排名，不改动正式季度组合。</div>';
  var save = ssEl('ss-settings-save');
  if (save) {
    save.addEventListener('click', function () {
      if (!window.StockSelectionPresenter) return;
      window.StockSelectionPresenter.saveSettings({
        budgetRatioA: ssEl('ss-budget-a').value,
        budgetRatioHk: ssEl('ss-budget-hk').value,
        positionRatioA: ssEl('ss-position-a').value,
        positionRatioHk: ssEl('ss-position-hk').value,
        totalCapital: ssEl('ss-total-capital').value,
      });
    });
  }
  var simulate = ssEl('ss-simulate');
  if (simulate) {
    simulate.addEventListener('click', function () {
      if (!window.StockSelectionPresenter) return;
      window.StockSelectionPresenter.simulate({
        positionRatio: ssEl('ss-simulate-position').value,
        budgetRatio: state.market === 'CN' ? ssEl('ss-budget-a').value : ssEl('ss-budget-hk').value,
      });
    });
  }
}

function ssRenderBacktests(state) {
  var root = ssEl('ss-backtests');
  if (!root) return;
  var list = state.backtests || [];
  if (!list.length) {
    root.innerHTML = '<div class="ss-empty">还没有回测记录。回测由管理员在后台发起，页面只展示结果；'
      + '历史数据不足以还原时不会生成收益曲线，也不会给出"已验证"的结论。</div>';
    return;
  }
  var rows = list.map(function (item) {
    var metrics = item.metrics || {};
    var diagnostics = item.diagnostics || {};
    var statusText = item.status === 'partial' ? '部分可用' : item.status === 'not_evaluable' ? '历史不可还原' : item.status;
    var reason = item.status === 'not_evaluable'
      ? ssEsc((diagnostics.missing && diagnostics.missing.reason) || '数据不足以还原历史区间')
      : '';
    function pct(value) { return value === null || value === undefined ? '--' : (Number(value) * 100).toFixed(2) + '%'; }
    return '<tr>'
      + '<td class="text-right">' + ssEsc(item.backtestId) + '</td>'
      + '<td>' + ssEsc(item.startDate) + ' 至 ' + ssEsc(item.endDate) + '</td>'
      + '<td>' + ssEsc(statusText) + (reason ? '<div class="ss-sub">' + reason + '</div>' : '') + '</td>'
      + '<td class="text-right">' + pct(metrics.annualizedReturn) + '</td>'
      + '<td class="text-right">' + pct(metrics.maxDrawdown) + '</td>'
      + '<td class="text-right">' + pct(metrics.benchmarkReturn) + '</td>'
      + '<td class="text-right">' + (metrics.periodCount === undefined ? '--' : metrics.periodCount) + '</td>'
      + '</tr>';
  }).join('');
  root.innerHTML = '<div class="biz-table-scroll"><table class="biz-table"><thead><tr>'
    + '<th class="text-right">编号</th><th>区间</th><th>结论</th>'
    + '<th class="text-right">年化</th><th class="text-right">最大回撤</th><th class="text-right">基准收益</th><th class="text-right">期数</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="ss-settings-note">基准：A股沪深300、港股恒生指数，均为价格指数；夏普在缺少合格无风险序列时不输出。</div>';
  if (window.BusinessTable) window.BusinessTable.attach(root, { page: '#main-stock-selection', sticky: false });
}

window.StockSelectionView = {
  init: ssInitView,
  setStatus: ssSetStatus,
  setError: ssSetError,
  renderMarkets: ssRenderMarkets,
  renderRuns: ssRenderRuns,
  renderRunHeader: ssRenderRunHeader,
  renderCandidates: ssRenderCandidates,
  renderPortfolio: ssRenderPortfolio,
  renderDetail: ssRenderDetail,
  renderSettings: ssRenderSettings,
  renderBacktests: ssRenderBacktests,
};
