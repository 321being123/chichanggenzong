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
  var current = scope.value;
  scope.innerHTML = '<option value="">全部已存口径</option>' + scopes.map(function(value) {
    return '<option value="' + escapeHtml(value) + '">' + escapeHtml(value === 'consolidated' ? '合并口径' : value) + '</option>';
  }).join('');
  scope.value = scopes.indexOf(current) >= 0 ? current : '';
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
    meta.textContent = [data.market || '', data.standard || '', data.currency || '多币种/原币', data.scope || '合并口径', filterText, coverage].filter(Boolean).join(' · ');
  }
  if (!wrap) return;
  if (!data.periods || !data.periods.length || !data.fields || !data.fields.length) {
    wrap.style.display='none';
    if (message) { message.style.display='block'; message.textContent='暂无可展示的财报数据。'; }
    return;
  }
  if (message) message.style.display='none';
  var headYears = data.periods.map(function(period) {
    var notes = [];
    if (period.end_date) notes.push('期末 ' + period.end_date);
    if (period.report_type_label || period.report_type) notes.push(period.report_type_label || period.report_type);
    if (period.currency) notes.push(period.currency);
    if (period.announced_at) notes.push('公告 ' + period.announced_at);
    var note = notes.length ? '<small>' + escapeHtml(notes.join(' · ')) + '</small>' : '';
    return '<th colspan="2">' + escapeHtml(period.fiscal_year || period.year || period.end_date || '') + note + '</th>';
  }).join('');
  var comparisonLabel = data.compare === 'qoq' ? '环比' : data.compare === 'none' ? '' : '同比';
  var subHead = data.periods.map(function() { return '<th>原值</th><th>' + escapeHtml(comparisonLabel) + '</th>'; }).join('');
  var currentSection = '';
  var columnCount = data.periods.length * 2 + 1;
  var rows = data.fields.map(function(field) {
    var sectionRow = '';
    if (field.section !== currentSection) {
      currentSection = field.section;
      sectionRow = '<tr class="statement-section statement-section-' + escapeHtml(data.type) + '"><th colspan="' + columnCount + '">' + escapeHtml(currentSection) + '</th></tr>';
    }
    var cells = field.values.map(function(item) {
      var value = item.value == null ? '—' : stockAnalysisNumber(item.value, 2);
      var change = item.change == null ? '—' : stockAnalysisPercent(item.change);
      var changeClass = item.change != null && item.change < 0 ? ' class="negative"' : '';
      var valueReason = stockAnalysisStatementReason(item.reason);
      var comparisonReason = stockAnalysisStatementReason(item.comparison_reason);
      var valueStatus = item.status && item.status !== 'available' ? ' data-status="' + escapeHtml(item.status) + '" title="' + escapeHtml(valueReason) + '" aria-label="' + escapeHtml(valueReason) + '"' : '';
      var comparisonStatus = item.comparison_status && item.comparison_status !== 'available' ? ' data-status="' + escapeHtml(item.comparison_status) + '" title="' + escapeHtml(comparisonReason) + '" aria-label="' + escapeHtml(comparisonReason) + '"' : '';
      return '<td class="statement-value"' + valueStatus + '>' + escapeHtml(value) + '</td><td' + changeClass + comparisonStatus + '>' + escapeHtml(change) + '</td>';
    }).join('');
    var rowClass = 'statement-item statement-level-' + (field.level || 0) + (field.is_parent ? ' statement-parent' : '');
    var branch = field.level ? '<span class="statement-branch">└</span>' : '';
    return sectionRow + '<tr class="' + rowClass + '"><th>' + branch + '<span>' + escapeHtml(field.label) + '</span>' + (field.unit ? '<small>' + escapeHtml(field.unit) + '</small>' : '') + '</th>' + cells + '</tr>';
  }).join('');
  wrap.classList.add('biz-table-scroll');
  wrap.innerHTML = '<table class="biz-table biz-table--matrix stock-analysis-statements-table"><thead><tr><th rowspan="2">' + escapeHtml(data.unit_label || '默认单位：亿元') + '</th>' + headYears + '</tr><tr>' + subHead + '</tr></thead><tbody>' + rows + '</tbody></table>';
  wrap.style.display='block';
  if (window.BusinessTable) window.BusinessTable.attach(wrap, { page: '#main-stock-analysis', sticky: true });
}
