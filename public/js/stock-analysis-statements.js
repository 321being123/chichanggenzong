var stockStatementState = { type:'balance', loadedCode:'', cache:{} };

function stockAnalysisSwitchView(view) {
  var statements = ['balance','income','cashflow'].includes(view);
  var analysisPane = document.getElementById('stock-analysis-analysis-pane');
  var statementsPane = document.getElementById('stock-analysis-statements-pane');
  var analysisTab = document.getElementById('stock-analysis-view-analysis');
  if (analysisPane) analysisPane.style.display = statements ? 'none' : '';
  if (statementsPane) statementsPane.style.display = statements ? '' : 'none';
  if (analysisTab) { analysisTab.classList.toggle('selected', !statements); analysisTab.setAttribute('aria-selected', String(!statements)); }
  document.querySelectorAll('[data-statement-view]').forEach(function(button) {
    var selected = statements && button.getAttribute('data-statement-view') === view;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  if (statements && stockAnalysisState.selected) stockAnalysisLoadStatements(view);
}

async function stockAnalysisLoadStatements(type) {
  type = ['balance','income','cashflow'].includes(type) ? type : 'balance';
  stockStatementState.type = type;
  var code = stockAnalysisState.selected;
  if (!code) return;
  var key = code + ':' + type;
  if (stockStatementState.cache[key]) return stockAnalysisRenderStatements(stockStatementState.cache[key]);
  var message = document.getElementById('stock-analysis-statements-message');
  var wrap = document.getElementById('stock-analysis-statements-wrap');
  if (message) { message.style.display='block'; message.textContent='正在读取三表数据...'; }
  if (wrap) wrap.style.display='none';
  try {
    var response = await fetch(api('/api/stock-analysis/' + encodeURIComponent(code) + '/statements?type=' + type + '&limit=10'));
    var payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '三表读取失败');
    stockStatementState.cache[key] = payload;
    stockAnalysisRenderStatements(payload);
  } catch (error) {
    if (message) { message.style.display='block'; message.textContent=error.message || String(error); }
  }
}

function stockAnalysisRenderStatements(data) {
  var title = document.getElementById('stock-analysis-statements-title');
  var message = document.getElementById('stock-analysis-statements-message');
  var wrap = document.getElementById('stock-analysis-statements-wrap');
  if (title) title.textContent = data.name || '三表';
  if (!wrap) return;
  if (!data.periods || !data.periods.length || !data.fields || !data.fields.length) {
    wrap.style.display='none';
    if (message) { message.style.display='block'; message.textContent='暂无可展示的年度三表数据。'; }
    return;
  }
  if (message) message.style.display='none';
  var headYears = data.periods.map(function(period) {
    var note = period.announced_at ? '<small>公告 ' + escapeHtml(period.announced_at) + '</small>' : '';
    return '<th colspan="2">' + escapeHtml(period.year) + note + '</th>';
  }).join('');
  var subHead = data.periods.map(function() { return '<th>原值</th><th>同比</th>'; }).join('');
  var currentSection = '';
  var columnCount = data.periods.length * 2 + 1;
  var rows = data.fields.map(function(field) {
    var sectionRow = '';
    if (field.section !== currentSection) {
      currentSection = field.section;
      sectionRow = '<tr class="statement-section statement-section-' + escapeHtml(data.type) + '"><th colspan="' + columnCount + '">' + escapeHtml(currentSection) + '</th></tr>';
    }
    var cells = field.values.map(function(item) {
      var value = item.value == null ? '--' : stockAnalysisNumber(item.value, 2);
      var yoy = item.yoy == null ? '--' : stockAnalysisPercent(item.yoy);
      var yoyClass = item.yoy != null && item.yoy < 0 ? ' class="negative"' : '';
      return '<td class="statement-value">' + escapeHtml(value) + '</td><td' + yoyClass + '>' + escapeHtml(yoy) + '</td>';
    }).join('');
    var rowClass = 'statement-item statement-level-' + (field.level || 0) + (field.is_parent ? ' statement-parent' : '');
    var branch = field.level ? '<span class="statement-branch">└</span>' : '';
    return sectionRow + '<tr class="' + rowClass + '"><th>' + branch + '<span>' + escapeHtml(field.label) + '</span>' + (field.unit ? '<small>' + escapeHtml(field.unit) + '</small>' : '') + '</th>' + cells + '</tr>';
  }).join('');
  wrap.innerHTML = '<table class="stock-analysis-statements-table"><thead><tr><th rowspan="2">默认单位：亿元</th>' + headYears + '</tr><tr>' + subHead + '</tr></thead><tbody>' + rows + '</tbody></table>';
  wrap.style.display='block';
}

function stockAnalysisInvalidateStatements(code) {
  Object.keys(stockStatementState.cache).forEach(function(key) {
    if (!code || key.indexOf(code + ':') === 0) delete stockStatementState.cache[key];
  });
}
