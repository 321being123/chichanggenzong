// 可转债安全性页面：纯展示层，所有评级计算均在服务端完成。
var bondSafetyState = { rows: [], filtered: [], sortKey: 'bond_price', sortDir: 1, loaded: false };

var BOND_SAFETY_COLUMNS = [
  ['bond_code', '债券代码'], ['bond_name', '债券名称'], ['stock_name', '正股名称'],
  ['pe_ttm', 'PE-TTM'], ['pb', 'PB'], ['dividend_yield', '股息率'],
  ['bond_price', '最新债券价格'],
  ['change_pct', '涨跌幅'], ['double_low', '双低'], ['convert_premium', '最近转股溢价率'],
  ['convert_price', '最近转股价'], ['convert_value', '最近转股价值'],
  ['indicator_interest', '利息保障≥7倍'], ['indicator_liquidity', '现金覆盖负债>=1'],
  ['indicator_leverage', '负债/市值≤1.5'], ['safety', '安全性']
];

function bondSafetyText(value) {
  if (value === null || value === undefined || value === '' || (typeof value === 'number' && !isFinite(value))) return '-';
  if (typeof value === 'number') return String(Math.round(value * 10000) / 10000);
  return String(value);
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

function bondSafetyIndicator(value) {
  var number = Number(value);
  if (value !== '' && value !== null && value !== undefined && isFinite(number)) return escapeHtml(number.toFixed(2));
  var cls = { '达标':'pass', '不达标':'fail', '数据不足':'missing', '行业豁免':'exempt' }[value] || 'missing';
  return '<span class="bond-indicator bond-indicator-' + cls + '">' + escapeHtml(value || '-') + '</span>';
}

function bondSafetyCell(row, key) {
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
  var html = '<div class="bond-safety-scroll"><table class="bond-safety-table"><thead><tr>';
  BOND_SAFETY_COLUMNS.forEach(function(col) {
    var arrow = bondSafetyState.sortKey === col[0] ? (bondSafetyState.sortDir > 0 ? ' ↑' : ' ↓') : '';
    html += '<th onclick="bondSafetySort(\'' + col[0] + '\')">' + escapeHtml(col[1] + arrow) + '</th>';
  });
  html += '</tr></thead><tbody>';
  rows.forEach(function(row) {
    html += '<tr>';
    BOND_SAFETY_COLUMNS.forEach(function(col, index) {
      var cls = index === 0 ? 'bond-safety-code' : (index >= 3 && index <= 11 ? 'bond-safety-number' : '');
      html += '<td class="' + cls + '">' + bondSafetyCell(row, col[0]) + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
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

async function exportBondSafety() {
  var button = document.getElementById('bond-safety-export');
  var searchEl = document.getElementById('bond-safety-search');
  var ratingEl = document.getElementById('bond-safety-rating');
  var params = new URLSearchParams({
    search: searchEl ? searchEl.value.trim() : '',
    rating: ratingEl ? ratingEl.value : '',
    sort: bondSafetyState.sortKey,
    dir: bondSafetyState.sortDir > 0 ? 'asc' : 'desc'
  });
  if (button) { button.disabled = true; button.textContent = '导出中...'; }
  try {
    var response = await fetch(api('/api/bond-safety/export?' + params.toString()));
    if (!response.ok) {
      var error = await response.json().catch(function() { return {}; });
      throw new Error(error.error || '导出失败');
    }
    var blob = await response.blob();
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = '可转债安全性评估_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    if (typeof showToast === 'function') showToast(error.message || String(error));
  } finally {
    if (button) { button.disabled = false; button.textContent = '导出Excel'; }
  }
}

async function loadBondSafety(force) {
  if (bondSafetyState.loaded && !force) return;
  var el = document.getElementById('bond-safety-table');
  if (el) el.innerHTML = '<div class="bond-safety-empty">正在加载安全性数据...</div>';
  var refresh = document.getElementById('bond-safety-refresh');
  if (refresh) refresh.style.display = myProfile && myProfile.role === 'admin' ? '' : 'none';
  try {
    var response = await fetch(api('/api/bond-safety/bonds'));
    var d = await response.json();
    if (!response.ok) throw new Error(d.error || '加载失败');
    bondSafetyState.rows = Array.isArray(d.data) ? d.data : [];
    bondSafetyState.loaded = true;
    var updated = document.getElementById('bond-safety-updated');
    if (updated) updated.textContent = d.updated_at ? '系统刷新：' + new Date(d.updated_at).toLocaleString('zh-CN') : '尚无成功快照';
    bondSafetyRenderStats(d);
    if (!d.data.length && !d.configured) {
      if (el) el.innerHTML = '<div class="bond-safety-empty">数据源尚未配置。管理员完成 API 配置后，系统会自动生成第一份快照。</div>';
      return;
    }
    bondSafetyApplyFilters();
  } catch(error) {
    if (el) el.innerHTML = '<div class="bond-safety-empty bond-safety-error">加载失败：' + escapeHtml(error.message || String(error)) + '</div>';
  }
}

async function refreshBondSafety() {
  var button = document.getElementById('bond-safety-refresh');
  if (button) { button.disabled = true; button.textContent = '刷新中...'; }
  try {
    var response = await fetch(api('/api/bond-safety/refresh'), { method:'POST' });
    var d = await response.json();
    if (!response.ok) throw new Error(d.error || '刷新失败');
    bondSafetyState.loaded = false;
    await loadBondSafety(true);
    if (typeof showToast === 'function') showToast('可转债安全性数据已刷新');
  } catch(error) {
    if (typeof showToast === 'function') showToast(error.message || String(error));
  } finally {
    if (button) { button.disabled = false; button.textContent = '刷新数据'; }
  }
}
