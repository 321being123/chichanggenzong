// 财务三表 View（批次4：View／Presenter 分离）。
// 职责：只做三表渲染与视图切换；取数、缓存与请求序号在 presenters/stock-analysis-statements-presenter.js。
// 约定：本文件不直接发请求（静态门禁 frontend_api_client 校验），也不决定何时采集。

function stockAnalysisSwitchView(view) {
  var statements = ['balance','income','cashflow'].includes(view);
  if (!statements) stockStatementState.requestToken++;
  var analysisPane = document.getElementById('stock-analysis-analysis-pane');
  var statementsPane = document.getElementById('stock-analysis-statements-pane');
  var analysisTab = document.getElementById('stock-analysis-view-analysis');
  if (analysisPane) { analysisPane.classList.remove('js-hidden'); analysisPane.style.display = statements ? 'none' : ''; }
  if (statementsPane) { statementsPane.classList.remove('js-hidden'); statementsPane.style.display = statements ? '' : 'none'; }
  if (analysisTab) { analysisTab.classList.toggle('selected', !statements); analysisTab.setAttribute('aria-selected', String(!statements)); }
  document.querySelectorAll('[data-statement-view]').forEach(function(button) {
    var selected = statements && button.getAttribute('data-statement-view') === view;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  if (statements && stockAnalysisState.selected) stockAnalysisLoadStatements(view);
}

// View 对外入口（批次4）：Presenter 只调这些函数改界面，自己不碰 DOM。
function stockAnalysisShowStatementsLoading() {
  var message = document.getElementById('stock-analysis-statements-message');
  var wrap = document.getElementById('stock-analysis-statements-wrap');
  if (message) { message.style.display='block'; message.textContent='正在读取三表数据...'; }
  if (wrap) wrap.style.display='none';
}

function stockAnalysisStatementFilterChanged(value) {
  var id = this && this.id || '';
  var name = id === 'stock-analysis-statement-period' ? 'periodType'
    : id === 'stock-analysis-statement-compare' ? 'compare'
      : id === 'stock-analysis-statement-range' ? 'limit' : 'scope';
  if (typeof stockAnalysisSetStatementFilter === 'function') stockAnalysisSetStatementFilter(name, value);
}

function stockAnalysisRenderStatementFilters(data) {
  var scope = document.getElementById('stock-analysis-statement-scope');
  var scopes = data && data.available_filters && data.available_filters.scopes || [];
  if (!scope || !scopes.length) return;
  var current = typeof stockAnalysisStatementFilters === 'function' ? stockAnalysisStatementFilters().scope : scope.value;
  var optionScopes = ['consolidated'].concat(scopes.filter(function(value) { return value !== 'consolidated'; }));
  scope.innerHTML = '<option value="all">全部已存口径</option>' + optionScopes.map(function(value) {
    var absent = scopes.indexOf(value) < 0;
    var label = value === 'consolidated' ? '合并口径' : value;
    return '<option value="' + escapeHtml(value) + '"' + (absent ? ' disabled' : '') + '>'
      + escapeHtml(absent ? label + '（暂无）' : label) + '</option>';
  }).join('');
  scope.value = current === 'all' || scopes.indexOf(current) >= 0 ? current : 'consolidated';
}

function stockAnalysisShowStatementsError(error) {
  var message = document.getElementById('stock-analysis-statements-message');
  if (message) { message.style.display='block'; message.textContent=error.message || String(error); }
}

function stockAnalysisStatementReason(reason) {
  var reasons = {
    comparison_method_unverified: '该项目的比较口径尚未核实',
    negative_comparison_unverified: '含负数的比较口径尚未核实',
    comparable_period_missing: '缺少可确认口径一致的比较期',
    comparable_value_missing: '比较期缺少数据',
    cumulative_flow_qoq_not_supported: '累计值暂无已核实的单期环比',
    flow_period_basis_unverified: '累计报告期起始日及重述口径尚未核实',
    zero_denominator: '比较期为零，无法计算',
    source_batch_incomplete: '来源采集不完整',
    source_not_disclosed: '来源未披露',
    source_mapping_unverified: '来源字段口径尚未核实',
    source_currency_unverified: '来源金额币种尚未核实',
    metric_not_requested: '该项目尚未采集',
    metric_missing: '暂无数据'
  };
  return reasons[reason] || '暂无可用数据';
}

function stockAnalysisRenderStatements(data) {
  var title = document.getElementById('stock-analysis-statements-title');
  var message = document.getElementById('stock-analysis-statements-message');
  var wrap = document.getElementById('stock-analysis-statements-wrap');
  if (title) title.textContent = data.name || '三表';
  stockAnalysisRenderStatementFilters(data);
  var meta = document.getElementById('stock-analysis-statements-meta');
  if (meta) {
    var filterText = data.compare === 'qoq' ? '环比' : data.compare === 'none' ? '不比较' : '同比';
    var coverage = data.coverage && data.coverage.complete === false ? '采集不完整'
      : data.coverage && data.coverage.complete === true ? '来源覆盖已记录' : '覆盖证据未提供';
    var scopeText = data.scope === 'all' ? '全部已存口径' : data.scope === 'parent' ? '母公司口径' : data.scope === 'consolidated' || !data.scope ? '合并口径' : data.scope;
    meta.textContent = [data.market || '', data.standard || '', data.currency || '多币种/原币', scopeText, filterText, coverage].filter(Boolean).join(' · ');
  }
  if (!wrap) return;
  if (!data.periods || !data.periods.length || !data.fields || !data.fields.length) {
    wrap.style.display='none';
    if (message) { message.style.display='block'; message.textContent='暂无可展示的财报数据。'; }
    return;
  }
  if (message) message.style.display='none';
  var comparisonEnabled = data.compare !== 'none';
  var comparisonLabel = data.compare === 'qoq' ? '环比' : '同比';
  var columnsPerPeriod = comparisonEnabled ? 2 : 1;
  var columnCount = data.periods.length * columnsPerPeriod + 1;
  var headYears = data.periods.map(function(period) {
    var notes = [];
    if (period.end_date) notes.push('期末 ' + period.end_date);
    if (period.report_type_label || period.report_type) notes.push(period.report_type_label || period.report_type);
    var tableTypes = { non_financial:'非金融', bank:'银行', insurance:'保险', security:'证券', other_financial:'其他金融', reit:'房地产投资信托' };
    notes.push(tableTypes[period.fs_table_type] ? '报表类型：' + tableTypes[period.fs_table_type] : '报表类型待确认');
    var scopes = { consolidated:'合并口径', parent:'母公司口径' };
    notes.push(scopes[period.scope] || (period.scope ? '口径：' + period.scope : '口径待确认'));
    if (period.currency) notes.push(period.currency);
    if (period.announced_at) notes.push('公告 ' + period.announced_at);
    var note = notes.length ? '<small>' + escapeHtml(notes.join(' · ')) + '</small>' : '';
    return '<th class="statement-period" scope="colgroup" colspan="' + columnsPerPeriod + '">' + escapeHtml(period.fiscal_year || period.year || period.end_date || '') + note + '</th>';
  }).join('');
  var subHead = data.periods.map(function() {
    return '<th scope="col">原值</th>' + (comparisonEnabled ? '<th scope="col">' + escapeHtml(comparisonLabel) + '</th>' : '');
  }).join('');
  var currentSection = '';
  var rows = data.fields.map(function(field) {
    var sectionRow = '';
    var sectionChanged = field.section !== currentSection;
    var fieldHasValue = Array.isArray(field.values) && field.values.some(function(item) { return item && item.value != null; });
    var statusMessages = [];
    function addStatusMessage(index, prefix, reason) {
      var message = stockAnalysisStatementReason(reason);
      var period = data.periods[index] || {};
      var periodLabel = period.end_date || period.fiscal_year || period.year || ('第' + (index + 1) + '期');
      var text = periodLabel + ' ' + prefix + '：' + message;
      if (statusMessages.indexOf(text) < 0) statusMessages.push(text);
    }
    (field.values || []).forEach(function(item, index) {
      if (item && item.status && item.status !== 'available') addStatusMessage(index, '原值', item.reason);
      if (comparisonEnabled && item && item.comparison_status && item.comparison_status !== 'available') {
        addStatusMessage(index, comparisonLabel, item.comparison_reason);
      }
    });
    if (field.section !== currentSection) {
      currentSection = field.section;
      // 来源已经给出同名且有值的总计时，直接把它作为分组首行，避免“分组标题＋总计”重复占行。
      if (!(String(field.label || '') === String(currentSection || '') && fieldHasValue)) {
        sectionRow = '<tr class="statement-section statement-section-' + escapeHtml(data.type) + '"><th colspan="' + columnCount + '" scope="colgroup">' + escapeHtml(currentSection) + '</th></tr>';
      }
    }
    var cells = field.values.map(function(item) {
      var value = item.value == null ? '—' : stockAnalysisNumber(item.value, 2);
      var valueReason = stockAnalysisStatementReason(item.reason);
      var valueStatus = item.status && item.status !== 'available' ? ' data-status="' + escapeHtml(item.status) + '" title="' + escapeHtml(valueReason) + '" aria-label="' + escapeHtml(valueReason) + '"' : '';
      var valueCell = '<td class="statement-value"' + valueStatus + '>' + escapeHtml(value) + '</td>';
      if (!comparisonEnabled) return valueCell;
      var change = item.change == null ? '—' : stockAnalysisPercent(item.change);
      var changeClass = item.change != null && item.change < 0 ? ' class="negative"' : '';
      var comparisonReason = stockAnalysisStatementReason(item.comparison_reason);
      var comparisonStatus = item.comparison_status && item.comparison_status !== 'available' ? ' data-status="' + escapeHtml(item.comparison_status) + '" title="' + escapeHtml(comparisonReason) + '" aria-label="' + escapeHtml(comparisonReason) + '"' : '';
      return valueCell + '<td' + changeClass + comparisonStatus + '>' + escapeHtml(change) + '</td>';
    }).join('');
    var level = Math.max(0, Number(field.level) || 0);
    var rowClass = 'statement-item statement-level-' + level + (field.is_parent ? ' statement-parent statement-total' : '')
      + (sectionChanged && String(field.label || '') === String(currentSection || '') && fieldHasValue ? ' statement-section-total' : '');
    var branch = level ? '<span class="statement-branch" aria-hidden="true">└</span>' : '';
    var parentAttr = field.parent ? ' data-parent-code="' + escapeHtml(field.parent) + '"' : '';
    var codeAttr = field.code ? ' data-statement-code="' + escapeHtml(field.code) + '"' : '';
    var unit = field.unit ? '<small class="statement-unit">' + escapeHtml(field.unit) + '</small>' : '';
    var statusHelp = statusMessages.length
      ? '<details class="statement-status-help"><summary aria-label="查看该字段状态说明">!</summary><div class="statement-status-help-text">' + escapeHtml(statusMessages.join('；')) + '</div></details>'
      : '';
    return sectionRow + '<tr class="' + rowClass + '" data-statement-level="' + level + '"' + codeAttr + parentAttr + '><th scope="row">' + branch + '<span class="statement-label">' + escapeHtml(field.label) + '</span>' + unit + statusHelp + '</th>' + cells + '</tr>';
  }).join('');
  wrap.classList.add('biz-table-scroll');
  wrap.innerHTML = '<table class="biz-table biz-table--matrix stock-analysis-statements-table" aria-label="' + escapeHtml((data.name || '财务三表') + '，' + (data.unit_label || '默认单位：亿元')) + '"><thead><tr><th rowspan="2" scope="col">' + escapeHtml(data.unit_label || '默认单位：亿元') + '</th>' + headYears + '</tr><tr>' + subHead + '</tr></thead><tbody>' + rows + '</tbody></table>';
  wrap.style.display='block';
  if (window.BusinessTable) window.BusinessTable.attach(wrap, { page: '#main-stock-analysis', sticky: true });
}
