// 可转债安全性页面：纯展示层，所有评级计算均在服务端完成。
// 可转债安全性 View（批次4：View／Presenter 分离）。
// 职责：只做渲染、筛选排序与格式化，并把用户操作上报给全局入口；取数与列表状态在 presenters/bond-safety-presenter.js。
// 约定：本文件不直接发请求（静态门禁 frontend_api_client 校验），也不决定何时采集。
// View 对外入口（批次4）：Presenter 只调这些函数改界面，自己不碰 DOM。
function bondSafetyShowLoading() {
  var el = document.getElementById('bond-safety-table');
  if (el) el.innerHTML = '<div class="bond-safety-empty">正在加载安全性数据...</div>';
}
function bondSafetyShowEmptySource() {
  var el = document.getElementById('bond-safety-table');
  if (el) el.innerHTML = '<div class="bond-safety-empty">数据源尚未配置。管理员完成 API 配置后，系统会自动生成第一份快照。</div>';
}
function bondSafetyShowError(error) {
  var el = document.getElementById('bond-safety-table');
  if (el) el.innerHTML = '<div class="bond-safety-empty bond-safety-error">加载失败：' + escapeHtml(error.message || String(error)) + '</div>';
}
function bondSafetyShowUpdated(d) {
  var updated = document.getElementById('bond-safety-updated');
  if (updated) updated.textContent = bondSafetyUpdatedText(d);
}
function bondSafetyExportFilters() {
  var searchEl = document.getElementById('bond-safety-search');
  var ratingEl = document.getElementById('bond-safety-rating');
  return {
    search: searchEl ? searchEl.value.trim() : '',
    rating: ratingEl ? ratingEl.value : ''
  };
}
function bondSafetySetExportButton(busy, text) {
  var button = document.getElementById('bond-safety-export');
  if (!button) return;
  button.disabled = !!busy;
  button.textContent = text;
}
function bondSafetyDownload(blob) {
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = '可转债安全性评估_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

var BOND_SAFETY_COLUMNS = [
  ['bond_code', '债券代码'], ['bond_name', '债券名称'], ['stock_name', '正股名称'],
  ['pe_ttm', 'PE-TTM'], ['pb', 'PB'], ['dividend_yield', '股息率'],
  ['bond_price', '最新债券价格'],
  ['change_pct', '涨跌幅'], ['double_low', '双低'], ['convert_premium', '最近转股溢价率'],
  ['indicator_interest', '利息保障≥7倍'], ['indicator_liquidity', '现金覆盖任一负债≥1'],
  ['indicator_leverage', '负债/市值≤1.5'], ['safety', '安全性'],
  ['convert_price', '最近转股价'], ['convert_value', '最近转股价值']
];

function bondSafetyText(value) {
  if (value === null || value === undefined || value === '' || (typeof value === 'number' && !isFinite(value))) return '-';
  if (typeof value === 'number') return String(Math.round(value * 10000) / 10000);
  return String(value);
}

function bondSafetyLifecycleMarker(status) {
  if (status === 'announced') return '<span class="bond-lifecycle-mark bond-lifecycle-mark-call" role="img" aria-label="已公告强赎" title="已公告强赎">!</span>';
  if (status === 'maturity_redeem') return '<span class="bond-lifecycle-mark bond-lifecycle-mark-maturity" role="img" aria-label="已公告到期兑付" title="已公告到期兑付">!</span>';
  if (status === 'redemption_unconfirmed') return '<span class="bond-lifecycle-mark bond-lifecycle-mark-maturity" role="img" aria-label="赎回方式待确认" title="赎回方式待确认">!</span>';
  if (status === 'completed') return '<span class="bond-lifecycle-mark bond-lifecycle-mark-call" role="img" aria-label="赎回已完成" title="赎回已完成">!</span>';
  if (status === 'maturity_near') return '<span class="bond-lifecycle-mark bond-lifecycle-mark-maturity" role="img" aria-label="临近到期" title="临近到期">!</span>';
  return '';
}

function bondSafetyFixed(value, digits) {
  var number = Number(value);
  return isFinite(number) ? number.toFixed(digits) : bondSafetyText(value);
}

function bondSafetyPercent(value, colorize) {
  var number = Number(value);
  if (!isFinite(number)) return '-';
  var text = number.toFixed(2) + '%';
  if (!colorize || number === 0) return text;
  return '<span class="' + (number > 0 ? 'bond-change-up' : 'bond-change-down') + '">' +
    (number > 0 ? '+' : '') + text + '</span>';
}

function bondSafetyRating(rating) {
  var cls = { '安全':'safe', '低风险':'low', '中风险':'medium', '高风险':'high', '未评级':'none' }[rating] || 'none';
  return '<span class="bond-rating bond-rating-' + cls + '">' + escapeHtml(rating || '未评级') + '</span>';
}

function bondSafetyUpdatedText(data) {
  var d = data || {};
  var dataDate = d.data_as_of || d.trade_date || (d.source_updated_at ? String(d.source_updated_at).slice(0, 10) : '');
  var parts = [dataDate ? '数据日期：' + dataDate : '尚无成功快照'];
  if (d.is_stale || d.stale) parts.push('数据过期' + (d.stale_reason ? '：' + d.stale_reason : ''));
  if (d.updated_at) parts.push('系统刷新：' + new Date(d.updated_at).toLocaleString('zh-CN'));
  return parts.join(' · ');
}

function bondSafetyIndicator(value) {
  var number = Number(value);
  if (value !== '' && value !== null && value !== undefined && isFinite(number)) return escapeHtml(number.toFixed(2));
  var cls = { '达标':'pass', '不达标':'fail', '数据不足':'missing', '行业豁免':'exempt' }[value] || 'missing';
  return '<span class="bond-indicator bond-indicator-' + cls + '">' + escapeHtml(value || '-') + '</span>';
}

function bondSafetyCell(row, key) {
  if (key === 'bond_code' || key === 'bond_name') {
    return '<span class="bond-safety-link" data-act="bondSafetyJump" data-arg1="' + row.bond_code + '" title="点击查看证券分析">' + escapeHtml(bondSafetyText(row[key])) + '</span>' + (key === 'bond_name' ? bondSafetyLifecycleMarker(row.call_status) : '');
  }
  if (key === 'safety') return bondSafetyRating(row[key]);
  if (key.indexOf('indicator_') === 0) return bondSafetyIndicator(row[key]);
  if (key === 'change_pct') return bondSafetyPercent(row[key], true);
  if (key === 'convert_premium' || key === 'dividend_yield') return bondSafetyPercent(row[key], false);
  if (key === 'bond_price' || key === 'double_low' || key === 'convert_price' || key === 'convert_value') {
    return escapeHtml(bondSafetyFixed(row[key], 2));
  }
  if (key === 'pe_ttm' || key === 'pb') return escapeHtml(bondSafetyFixed(row[key], 2));
  return escapeHtml(bondSafetyText(row[key]));
}

function bondSafetyJump(code) {
  switchMain('stock-analysis');
  setTimeout(function(){ securityAnalysisSelect(code); }, 150);
}

function bondSafetyApplyFilters() {
  var searchEl = document.getElementById('bond-safety-search');
  var ratingEl = document.getElementById('bond-safety-rating');
  var query = String(searchEl ? searchEl.value : '').trim().toLowerCase();
  var rating = ratingEl ? ratingEl.value : '';
  var rows = bondSafetyState.rows.filter(function(row) {
    var matchesText = !query || [row.bond_code,row.bond_name,row.stock_name].some(function(v) {
      return String(v || '').toLowerCase().indexOf(query) >= 0;
    });
    return matchesText && (!rating || row.safety === rating);
  });
  var key = bondSafetyState.sortKey, dir = bondSafetyState.sortDir;
  rows.sort(function(a,b) {
    var av = a[key], bv = b[key];
    if (av === null || av === undefined || av === '') return (bv === null || bv === undefined || bv === '') ? 0 : 1;
    if (bv === null || bv === undefined || bv === '') return -1;
    var an = Number(av), bn = Number(bv);
    if (isFinite(an) && isFinite(bn)) return (an - bn) * dir;
    return String(av).localeCompare(String(bv), 'zh-CN') * dir;
  });
  bondSafetyState.filtered = rows;
  bondSafetyRenderTable();
}

function bondSafetySort(key) {
  if (bondSafetyState.sortKey === key) bondSafetyState.sortDir *= -1;
  else { bondSafetyState.sortKey = key; bondSafetyState.sortDir = 1; }
  bondSafetyApplyFilters();
}

function bondSafetyRenderTable() {
  var el = document.getElementById('bond-safety-table');
  if (!el) return;
  var rows = bondSafetyState.filtered;
  if (!rows.length) {
    el.innerHTML = '<div class="bond-safety-empty">没有符合当前条件的可转债</div>';
    return;
  }
  var html = '<div class="biz-table-scroll"><table class="biz-table bond-safety-table"><thead><tr>';
  BOND_SAFETY_COLUMNS.forEach(function(col) {
    var selected = bondSafetyState.sortKey === col[0];
    var direction = selected ? (bondSafetyState.sortDir > 0 ? 'ascending' : 'descending') : 'none';
    var arrow = selected ? '<span class="biz-sort-indicator" aria-hidden="true">' + (bondSafetyState.sortDir > 0 ? '▲' : '▼') + '</span>' : '';
    var cls = 'sortable' + (selected ? ' is-sorted sort-' + (bondSafetyState.sortDir > 0 ? 'asc' : 'desc') : '');
    html += '<th class="' + cls + '" tabindex="0" aria-sort="' + direction + '" data-act="bondSafetySort" data-arg1="' + col[0] + '">' + escapeHtml(col[1]) + arrow + '</th>';
  });
  html += '</tr></thead><tbody>';
  rows.forEach(function(row) {
    html += '<tr>';
    BOND_SAFETY_COLUMNS.forEach(function(col, index) {
      var cls = index === 0 ? 'bond-safety-code' : ((index >= 3 && index <= 10) || index >= 14 ? 'bond-safety-number' : '');
      html += '<td class="' + cls + '">' + bondSafetyCell(row, col[0]) + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
  if (window.BusinessTable) window.BusinessTable.attach(el, { page: '#sub-bond-safety', top: '#main-bond-safety > .bond-header' });
  var visible = document.getElementById('bond-safety-visible');
  if (visible) visible.textContent = '当前显示 ' + rows.length + ' / ' + bondSafetyState.rows.length + ' 只';
}

function bondSafetyRenderStats(d) {
  var counts = (d.diagnostics && d.diagnostics.rating_counts) || {};
  ['安全','低风险','中风险','高风险'].forEach(function(rating) {
    var el = document.querySelector('[data-bond-rating-count="' + rating + '"]');
    if (el) el.textContent = counts[rating] || 0;
  });
  var quality = document.getElementById('bond-safety-quality');
  if (quality && d.diagnostics) {
    quality.textContent = '未匹配正股 ' + (d.diagnostics.unmatched_stock_count || 0) +
      ' · 财务字段不完整 ' + (d.diagnostics.incomplete_company_count || 0);
  }
}
