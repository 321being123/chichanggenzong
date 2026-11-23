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

function stockAnalysisStatementRelationReason(relationStatus) {
  var reasons = {
    format_version_unverified: '报告列报版本尚未核实，暂按同组平列展示',
    basis_conflict: '所选报告期准则、范围或列报版本存在差异，暂按同组平列展示',
    group_conflict: '跨类型分组口径存在差异，暂归入当前分组平列展示',
    parent_conflict: '不同报告期类型对该科目的归属存在差异，暂按同组平列展示',
    unverified_context: '部分报告期类型或来源尚未核实，暂按同组平列展示',
    issuer_sample_unmatched: '该层级仅见于特定发行人样本，当前报告暂按同组平列展示',
    candidate: '候选归属关系尚未核实，暂按同组平列展示',
    undecided: '直接归属关系待核实，暂按同组平列展示'
  };
  return reasons[relationStatus] || '';
}

function stockAnalysisStatementFormatChange(rawChange) {
  if (rawChange == null) return { text: '—', cls: '' };
  var num = Number(rawChange);
  var formatted = stockAnalysisPercent(num);
  if (/^[-+]?0(?:\.0+)?%$/.test(formatted) || Math.abs(num) < 0.00005) {
    return { text: formatted.replace(/^[-+]/, ''), cls: 'statement-change flat' };
  }
  if (num > 0) {
    return { text: formatted.charAt(0) === '+' ? formatted : '+' + formatted, cls: 'statement-change up' };
  }
  return { text: formatted, cls: 'statement-change down negative' };
}

function stockAnalysisBuildRowModels(data) {
  var fields = Array.isArray(data && data.fields) ? data.fields : [];
  var presentation = data && data.presentation;
  var supportedVersions = ['2026-11-23.1'];
  if (presentation && supportedVersions.indexOf(presentation.version) >= 0
      && Array.isArray(presentation.rows) && presentation.rows.length) {
    var byCode = {};
    var fieldCount = 0;
    var allFieldsHaveCode = fields.every(function(field) {
      if (!field || !field.code || byCode[field.code]) return false;
      byCode[field.code] = field;
      fieldCount++;
      return true;
    });
    var seenCodes = {};
    var seenCount = 0;
    var valid = allFieldsHaveCode && presentation.rows.every(function(row) {
      if (!row) return false;
      if (row.kind === 'section') return Boolean(row.label);
      if (row.kind === 'field') {
        if (!row.code || !byCode[row.code] || seenCodes[row.code]) return false;
        seenCodes[row.code] = true;
        seenCount++;
        return true;
      }
      return false;
    }) && seenCount === fieldCount;
    if (valid) {
      return { byCode: byCode, rows: presentation.rows, usesPresentation: true };
    }
  }
  // 缺少或不支持新版 presentation 时回退旧 fields 渲染。
  var fallbackRows = [];
  var currentSection = '';
  fields.forEach(function(field) {
    var section = field.section || '';
    var hasValue = Array.isArray(field.values) && field.values.some(function(item) { return item && item.value != null; });
    if (section && section !== currentSection) {
      currentSection = section;
      if (!(String(field.label || '') === String(currentSection || '') && hasValue)) {
        fallbackRows.push({ kind: 'section', row_role: 'section', group_id: 'legacy:' + currentSection, label: currentSection, depth: 0 });
      }
    }
    var isSectionRep = section && String(field.label || '') === String(section) && hasValue;
    fallbackRows.push({
      kind: 'field',
      code: field.code,
      field: field,
      row_role: field.row_role || (field.is_parent ? 'total' : 'line'),
      group_id: field.group_id || ('legacy:' + section),
      parent_code: field.parent || null,
      depth: Math.max(0, Number(field.level) || 0),
      relation_status: field.relation_status || 'group_only',
      is_group_rep: Boolean(isSectionRep),
    });
  });
  return { byCode: {}, rows: fallbackRows, usesPresentation: false };
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
  var headYears = data.periods.map(function(period, periodIndex) {
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
    return '<th id="stmt-period-' + periodIndex + '" class="statement-period" scope="colgroup" colspan="' + columnsPerPeriod + '">' + escapeHtml(period.fiscal_year || period.year || period.end_date || '') + note + '</th>';
  }).join('');
  var subHead = data.periods.map(function(_, periodIndex) {
    return '<th id="stmt-val-' + periodIndex + '" headers="stmt-period-' + periodIndex + '" scope="col">原值</th>'
      + (comparisonEnabled ? '<th id="stmt-cmp-' + periodIndex + '" headers="stmt-period-' + periodIndex + '" scope="col">' + escapeHtml(comparisonLabel) + '</th>' : '');
  }).join('');

  var model = stockAnalysisBuildRowModels(data);
  var commonComparisonReasons = {};
  var emptySectionFillers = Array(Math.max(0, columnCount - 1)).fill('<td class="statement-section-filler" aria-hidden="true"></td>').join('');

  var rows = model.rows.map(function(entry) {
    if (entry.kind === 'section') {
      var secDepth = Math.max(0, Math.min(4, Number(entry.depth) || 0));
      var groupAttr = entry.group_id ? ' data-group-id="' + escapeHtml(entry.group_id) + '"' : '';
      return '<tr class="statement-section statement-section-' + escapeHtml(data.type) + ' statement-role-section statement-level-' + secDepth + '" data-statement-level="' + (Number(entry.depth) || 0) + '"' + groupAttr + '><th scope="row" class="statement-section-cell">' + escapeHtml(entry.label) + '</th>' + emptySectionFillers + '</tr>';
    }
    var field = entry.field || model.byCode[entry.code];
    if (!field) return '';
    var statusGroups = {};
    var statusOrder = [];
    function addStatusMessage(index, prefix, reason) {
      var reasonText = stockAnalysisStatementReason(reason);
      var period = data.periods[index] || {};
      var periodLabel = period.end_date || period.fiscal_year || period.year || ('第' + (index + 1) + '期');
      var scopeLabels = { consolidated: '合并口径', parent: '母公司口径' };
      if (period.report_type_label || period.report_type) periodLabel += ' ' + (period.report_type_label || period.report_type);
      if (period.scope) periodLabel += ' ' + (scopeLabels[period.scope] || period.scope);
      var groupKey = prefix + '：' + reasonText;
      if (!statusGroups[groupKey]) {
        statusGroups[groupKey] = [];
        statusOrder.push(groupKey);
      }
      if (statusGroups[groupKey].indexOf(periodLabel) < 0) statusGroups[groupKey].push(periodLabel);
    }
    (field.values || []).forEach(function(item, index) {
      if (item && item.status && item.status !== 'available') addStatusMessage(index, '原值', item.reason);
      if (comparisonEnabled && item && item.comparison_status && item.comparison_status !== 'available') {
        addStatusMessage(index, comparisonLabel, item.comparison_reason);
        if (item.comparison_reason) commonComparisonReasons[item.comparison_reason] = (commonComparisonReasons[item.comparison_reason] || 0) + 1;
      }
    });
    var statusMessages = statusOrder.map(function(groupKey) {
      return statusGroups[groupKey].join('、') + ' ' + groupKey;
    });
    var relationReason = stockAnalysisStatementRelationReason(entry.relation_status);
    if (relationReason) statusMessages.push('层级关系：' + relationReason);
    var cells = (field.values || []).map(function(item, periodIndex) {
      var value = item.value == null ? '—' : stockAnalysisNumber(item.value, 2);
      var valueReason = stockAnalysisStatementReason(item.reason);
      var valueStatus = item.status && item.status !== 'available' ? ' data-status="' + escapeHtml(item.status) + '" title="' + escapeHtml(valueReason) + '" aria-label="' + escapeHtml(valueReason) + '"' : '';
      var valueCell = '<td class="statement-value' + (value === '—' ? ' statement-missing' : '') + '" headers="stmt-period-' + periodIndex + ' stmt-val-' + periodIndex + '"' + valueStatus + '>' + escapeHtml(value) + '</td>';
      if (!comparisonEnabled) return valueCell;
      var changeFmt = stockAnalysisStatementFormatChange(item.change);
      var changeClass = changeFmt.cls ? ' class="' + changeFmt.cls + '"' : '';
      var comparisonReason = stockAnalysisStatementReason(item.comparison_reason);
      var comparisonStatus = item.comparison_status && item.comparison_status !== 'available' ? ' data-status="' + escapeHtml(item.comparison_status) + '" title="' + escapeHtml(comparisonReason) + '" aria-label="' + escapeHtml(comparisonReason) + '"' : '';
      return valueCell + '<td' + changeClass + ' headers="stmt-period-' + periodIndex + ' stmt-cmp-' + periodIndex + '"' + comparisonStatus + '>' + escapeHtml(changeFmt.text) + '</td>';
    }).join('');

    var depth = Math.max(0, Number(entry.depth) || 0);
    var visualLevel = Math.min(4, depth);
    var rowRole = entry.row_role || 'line';
    var parentCode = entry.parent_code || null;
    var parentField = parentCode && model.byCode[parentCode] ? model.byCode[parentCode] : null;
    var rowClass = 'statement-item statement-role-' + escapeHtml(rowRole) + ' statement-level-' + visualLevel
      + (rowRole === 'total' ? ' statement-parent statement-total' : rowRole === 'subtotal' ? ' statement-parent' : '')
      + (entry.is_group_rep ? ' statement-section-total' : '');
    var branch = parentCode ? '<span class="statement-branch" aria-hidden="true">└</span>' : '';
    var parentAttr = parentCode ? ' data-parent-code="' + escapeHtml(parentCode) + '"' : '';
    var codeAttr = field.code ? ' data-statement-code="' + escapeHtml(field.code) + '"' : '';
    var groupAttr = entry.group_id ? ' data-group-id="' + escapeHtml(entry.group_id) + '"' : '';
    var roleAttr = ' data-row-role="' + escapeHtml(rowRole) + '"';
    var unit = field.unit ? '<small class="statement-unit">' + escapeHtml(field.unit) + '</small>' : '';
    var srParent = parentField ? '<span class="statement-sr-parent">（隶属：' + escapeHtml(parentField.label) + '）</span>' : '';
    var statusHelp = statusMessages.length
      ? '<details class="statement-status-help"><summary aria-label="查看该字段状态说明">!</summary><div class="statement-status-help-text">' + escapeHtml(statusMessages.join('；')) + '</div></details>'
      : '';
    return '<tr class="' + rowClass + '" data-statement-level="' + depth + '"' + roleAttr + groupAttr + codeAttr + parentAttr + '><th scope="row">' + branch + '<span class="statement-label">' + escapeHtml(field.label) + '</span>' + srParent + unit + statusHelp + '</th>' + cells + '</tr>';
  }).join('');

  var summaryHtml = '';
  if (comparisonEnabled) {
    var topReasons = Object.keys(commonComparisonReasons).filter(function(r) { return commonComparisonReasons[r] >= 3; });
    if (topReasons.length) {
      summaryHtml = '<div class="stock-analysis-statements-summary" role="note">比较口径说明：' + escapeHtml(topReasons.map(stockAnalysisStatementReason).join('；')) + '</div>';
    }
  }
  wrap.classList.add('biz-table-scroll');
  wrap.innerHTML = summaryHtml + '<table class="biz-table biz-table--matrix stock-analysis-statements-table" aria-label="' + escapeHtml((data.name || '财务三表') + '，' + (data.unit_label || '默认单位：亿元')) + '"><thead><tr><th rowspan="2" scope="col">' + escapeHtml(data.unit_label || '默认单位：亿元') + '</th>' + headYears + '</tr><tr>' + subHead + '</tr></thead><tbody>' + rows + '</tbody></table>';
  wrap.style.display='block';
  if (window.BusinessTable) window.BusinessTable.attach(wrap, { page: '#main-stock-analysis', sticky: true });
}
