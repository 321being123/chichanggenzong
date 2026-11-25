// 上市可转债列表：只展示服务端每日快照，不在浏览器端访问外部数据源。
// 上市可转债列表 View（批次4：View／Presenter 分离）。
// 职责：只做渲染、筛选排序与格式化，并把用户操作上报给全局入口；取数与列表状态在 presenters/bond-list-presenter.js。
// 约定：本文件不直接发请求（静态门禁 frontend_api_client 校验），也不决定何时采集。
var BOND_LIST_REFRESH_MS = 15 * 60 * 1000;
// 兼容旧页面调用名：实际表头吸顶和底部滚动条已统一交给 BusinessTable。
function bondListFloatingHead() { return null; }
function bondListSyncFloatingHead() { if (window.BusinessTable) window.BusinessTable.sync(); }
function bondListFloatingScroll() { return null; }
function bondListSyncFloatingScroll() { if (window.BusinessTable) window.BusinessTable.sync(); }
// 旧版监听曾排除 event.target.id === 'bond-list-floating-scroll'，现由共享组件内部处理。
// 旧版定位选择器 document.querySelector('#main-bond-safety > .bond-header') 已作为 BusinessTable 的 top 作用域传入。
var BOND_LIST_COLUMNS = window.BondListContract.COLUMNS;
var BOND_LIST_PERCENT = { change_pct:1, stock_change_pct:1, conversion_premium:1, bond_floor_premium:1, theoretical_deviation:1,
  stock_volatility:1, bond_market_cap_ratio:1, asset_liability_ratio:1, fund_holding_ratio:1, turnover_rate:1,
  maturity_yield_pre_tax:1, put_yield_pre_tax:1, put_yield_after_tax:1 };

function bondListText(value) { return value === null || value === undefined || value === '' ? '—' : String(value); }
function bondListNumber(value, digits) { if (value === null || value === undefined || value === '') return '—'; var n = Number(value); return Number.isFinite(n) ? n.toFixed(digits == null ? 2 : digits) : '—'; }
function bondListPercent(value) { if (value === null || value === undefined || value === '') return '—'; var n = Number(value); return Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '—'; }
function bondListDate(value) { return value ? String(value).slice(0, 10) : '—'; }
function bondListSafety(value) {
  var rating = String(value || '未评级');
  var cls = { '安全':'safe', '低风险':'low', '中风险':'medium', '高风险':'high', '未评级':'none' }[rating] || 'none';
  return '<span class="bond-rating bond-rating-' + cls + '">' + escapeHtml(rating) + '</span>';
}
function bondListCell(row, key) {
  if (key === 'bond_code' || key === 'bond_name') return '<span class="bond-list-link" data-act="bondListJump" data-arg1="' + escapeHtml(row.ts_code || row.bond_code) + '">' + escapeHtml(bondListText(row[key])) + '</span>' + (key === 'bond_name' ? bondLifecycleMark(row) : '');
  if (key === 'rating') return escapeHtml(bondListText(row[key]));
  if (key === 'safety') return bondListSafety(row[key]);
  if (key.indexOf('date') >= 0) return escapeHtml(bondListDate(row[key]));
  if (key === 'change_pct' || key === 'stock_change_pct') {
    var change = Number(row[key]);
    var changeClass = change > 0 ? 'bond-list-up' : change < 0 ? 'bond-list-down' : '';
    return '<span class="' + changeClass + '">' + escapeHtml(bondListPercent(row[key])) + '</span>';
  }
  if (BOND_LIST_PERCENT[key]) return escapeHtml(bondListPercent(row[key]));
  if (key === 'price' || key === 'stock_price' || key === 'convert_price' || key === 'conversion_value' || key === 'bond_value' || key === 'option_value' || key === 'theoretical_value' || key === 'call_trigger_price' || key === 'double_low') return escapeHtml(bondListNumber(row[key], 2));
  if (key === 'stock_pb') return escapeHtml(bondListNumber(row[key], 2));
  if (key === 'remaining_years' || key === 'earliest_put_remaining_years') return escapeHtml(bondListNumber(row[key], 2));
  if (key === 'remain_size' || key === 'amount') return escapeHtml(bondListNumber(row[key], 2));
  return escapeHtml(bondListText(row[key]));
}
function bondListSort(a, b) {
  var key = bondListState.sortKey, av = a[key], bv = b[key];
  if (av == null || av === '') return (bv == null || bv === '') ? 0 : 1;
  if (bv == null || bv === '') return -1;
  var an = Number(av), bn = Number(bv);
  var result = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : String(av).localeCompare(String(bv), 'zh-CN');
  return result * bondListState.sortDir;
}
function bondListReadNumInput(id) {
  var el = document.getElementById(id);
  if (!el) return null;
  var raw = String(el.value == null ? '' : el.value).trim();
  if (!raw) return null;
  var n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function bondListAllRatings() {
  var set = {};
  (bondListState.rows || []).forEach(function(r) {
    set[r.rating ? String(r.rating) : '未评级'] = true;
  });
  var list = Object.keys(set);
  return list.length ? list : ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A'];
}
function bondListSyncRatingMenu() {
  var menu = document.getElementById('bond-filter-rating-menu');
  var btn = document.getElementById('bond-filter-rating-btn');
  if (!menu) return;
  var ratings = bondListAllRatings();
  var selected = bondListState.draftRatings;
  if (!selected) {
    selected = {};
    ratings.forEach(function(r) { selected[r] = true; });
    bondListState.draftRatings = selected;
  }
  menu.innerHTML = '<label class="bond-filter-rating-item"><input type="checkbox" data-rating-all="1"' +
    (ratings.every(function(r) { return selected[r]; }) ? ' checked' : '') + '><span>全选 / 全不选</span></label>' +
    ratings.map(function(r) {
      return '<label class="bond-filter-rating-item"><input type="checkbox" data-rating-val="' + escapeHtml(r) + '"' +
        (selected[r] ? ' checked' : '') + '><span>' + escapeHtml(r) + '</span></label>';
    }).join('');
  menu.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
    cb.onchange = function() {
      if (cb.dataset.ratingAll) {
        ratings.forEach(function(r) { bondListState.draftRatings[r] = cb.checked; });
      } else if (cb.dataset.ratingVal) {
        bondListState.draftRatings[cb.dataset.ratingVal] = cb.checked;
      }
      bondListSyncRatingMenu();
    };
  });
  if (btn) {
    var cnt = ratings.filter(function(r) { return selected[r]; }).length;
    btn.textContent = cnt === ratings.length ? '全部评级' : ('已选 ' + cnt + '/' + ratings.length);
  }
}
function bondListToggleRatingMenu() {
  var menu = document.getElementById('bond-filter-rating-menu');
  var btn = document.getElementById('bond-filter-rating-btn');
  if (!menu) return;
  bondListSyncRatingMenu();
  var open = menu.classList.contains('js-hidden');
  menu.classList.toggle('js-hidden', !open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function bondListToggleFilterPanel() {
  var panel = document.getElementById('bond-list-filters-panel');
  var btn = document.getElementById('bond-list-filter-toggle');
  if (!panel) return;
  var open = !panel.classList.contains('is-open');
  panel.classList.toggle('is-open', open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function bondListReadDraftFilters() {
  var ratings = bondListAllRatings();
  var draftRatings = bondListState.draftRatings || {};
  var allSelected = !bondListState.draftRatings || ratings.every(function(r) { return draftRatings[r]; });
  var selectedRatings = allSelected ? null : ratings.filter(function(r) { return draftRatings[r]; });
  return {
    priceMin: bondListReadNumInput('bond-filter-price-min'),
    priceMax: bondListReadNumInput('bond-filter-price-max'),
    remainMax: bondListReadNumInput('bond-filter-remain-max'),
    capRatioMax: bondListReadNumInput('bond-filter-cap-ratio-max'),
    debtRatioMax: bondListReadNumInput('bond-filter-debt-ratio-max'),
    premiumMax: bondListReadNumInput('bond-filter-premium-max'),
    ytmMin: bondListReadNumInput('bond-filter-ytm-min'),
    yearsMin: bondListReadNumInput('bond-filter-years-min'),
    yearsMax: bondListReadNumInput('bond-filter-years-max'),
    selectedRatings: selectedRatings,
    histLow: Boolean((document.getElementById('bond-filter-hist-low') || {}).checked),
  };
}
function bondListCountActiveFilters(f) {
  if (!f) return 0;
  var c = 0;
  if (f.priceMin != null || f.priceMax != null) c++;
  if (f.remainMax != null) c++;
  if (f.capRatioMax != null) c++;
  if (f.debtRatioMax != null) c++;
  if (f.premiumMax != null) c++;
  if (f.ytmMin != null) c++;
  if (f.yearsMin != null || f.yearsMax != null) c++;
  if (f.selectedRatings != null) c++;
  if (f.histLow) c++;
  return c;
}
function bondListMatchesCommittedFilters(row, f) {
  if (!f) return true;
  var num = function(v) { return (v === null || v === undefined || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null); };
  if (f.priceMin != null) { var p1 = num(row.price); if (p1 == null || p1 < f.priceMin) return false; }
  if (f.priceMax != null) { var p2 = num(row.price); if (p2 == null || p2 > f.priceMax) return false; }
  if (f.remainMax != null) { var rm = num(row.remain_size); if (rm == null || rm > f.remainMax) return false; }
  if (f.capRatioMax != null) { var cr = num(row.bond_market_cap_ratio); if (cr == null || cr * 100 > f.capRatioMax) return false; }
  if (f.debtRatioMax != null) { var dr = num(row.asset_liability_ratio); if (dr == null || dr * 100 > f.debtRatioMax) return false; }
  if (f.premiumMax != null) { var cp = num(row.conversion_premium); if (cp == null || cp * 100 > f.premiumMax) return false; }
  if (f.ytmMin != null) { var ym = num(row.maturity_yield_pre_tax); if (ym == null || ym * 100 < f.ytmMin) return false; }
  if (f.yearsMin != null) { var y1 = num(row.remaining_years); if (y1 == null || y1 < f.yearsMin) return false; }
  if (f.yearsMax != null) { var y2 = num(row.remaining_years); if (y2 == null || y2 > f.yearsMax) return false; }
  if (Array.isArray(f.selectedRatings)) {
    var r = row.rating ? String(row.rating) : '未评级';
    if (f.selectedRatings.indexOf(r) < 0) return false;
  }
  if (f.histLow && !row.is_historical_low) return false;
  return true;
}
function bondListApplyCommittedFilters() {
  bondListState.committedFilters = bondListReadDraftFilters();
  var menu = document.getElementById('bond-filter-rating-menu');
  if (menu) menu.classList.add('js-hidden');
  bondListApplyFilters();
}
function bondListResetFilters() {
  ['bond-filter-price-min', 'bond-filter-price-max', 'bond-filter-remain-max', 'bond-filter-cap-ratio-max',
    'bond-filter-debt-ratio-max', 'bond-filter-premium-max', 'bond-filter-ytm-min', 'bond-filter-years-min', 'bond-filter-years-max']
    .forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
  var hl = document.getElementById('bond-filter-hist-low'); if (hl) hl.checked = false;
  bondListState.draftRatings = null;
  bondListState.committedFilters = null;
  bondListSyncRatingMenu();
  bondListApplyFilters();
}
function bondListApplyFilters() {
  var search = String((document.getElementById('bond-list-search') || {}).value || '').trim().toLowerCase();
  var status = String((document.getElementById('bond-list-status') || {}).value || '');
  var committed = bondListState.committedFilters || null;
  bondListState.filtered = bondListState.rows.filter(function(row) {
    var hit = !search || [row.bond_code,row.bond_name,row.stock_name,row.stock_code].some(function(v) { return String(v || '').toLowerCase().indexOf(search) >= 0; });
    return hit && (!status || row.data_status === status) && bondListMatchesCommittedFilters(row, committed);
  }).sort(bondListSort);
  var toggleBtn = document.getElementById('bond-list-filter-toggle');
  if (toggleBtn) toggleBtn.textContent = '筛选条件 (' + bondListCountActiveFilters(committed) + ')';
  var hintEl = document.getElementById('bond-filter-status-hint');
  if (hintEl) {
    var baseHint = '当前结果为最后的筛选条件执行结果；如需显示默认结果请点击“重置”按钮';
    if (committed && committed.histLow) {
      var insuff = bondListState.rows.filter(function(r) { return r.historical_low_status === 'insufficient_history'; }).length;
      hintEl.textContent = baseHint + '（已排除 ' + insuff + ' 只历史覆盖不足转债）';
    } else {
      hintEl.textContent = baseHint;
    }
  }
  bondListRender();
}
function bondListRender() {
  var el = document.getElementById('bond-list-table'), visible = document.getElementById('bond-list-visible');
  if (visible) visible.textContent = bondListState.filtered.length + ' / ' + bondListState.rows.length + ' 条';
  if (!el) return;
  if (!bondListState.filtered.length) {
    el.innerHTML = '<div class="bond-list-empty">暂无符合条件的数据</div>';
    return;
  }
  var head = BOND_LIST_COLUMNS.map(function(col) {
    var selected = bondListState.sortKey === col[0];
    var direction = selected ? (bondListState.sortDir > 0 ? 'ascending' : 'descending') : 'none';
    var arrow = selected ? '<span class="biz-sort-indicator" aria-hidden="true">' + (bondListState.sortDir > 0 ? '▲' : '▼') + '</span>' : '';
    var cls = 'sortable' + (selected ? ' is-sorted sort-' + (bondListState.sortDir > 0 ? 'asc' : 'desc') : '');
    return '<th class="' + cls + '" data-key="' + escapeHtml(col[0]) + '" aria-sort="' + direction + '">' + escapeHtml(col[1]) + arrow + '</th>';
  }).join('');
  var body = bondListState.filtered.map(function(row) { return '<tr>' + BOND_LIST_COLUMNS.map(function(col) { return '<td>' + bondListCell(row, col[0]) + '</td>'; }).join('') + '</tr>'; }).join('');
  el.innerHTML = '<div class="biz-table-scroll"><table class="biz-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  el.querySelectorAll('th[data-key]').forEach(function(th) {
    th.tabIndex = 0;
    th.onclick = function() { var key = th.dataset.key; if (bondListState.sortKey === key) bondListState.sortDir *= -1; else { bondListState.sortKey = key; bondListState.sortDir = 1; } bondListApplyFilters(); };
  });
  if (window.BusinessTable) window.BusinessTable.attach(el, { page: '#sub-bond-list', top: '#main-bond-safety > .bond-header' });
}
function bondListJump(code) { if (typeof switchMain === 'function') { switchMain('stock-analysis'); setTimeout(function() { if (typeof securityAnalysisSelect === 'function') securityAnalysisSelect(code); }, 150); } }
function bondListSetRefreshButton(refreshing) {
  var button = document.getElementById('bond-list-refresh');
  if (!button) return;
  button.disabled = Boolean(refreshing);
  button.textContent = refreshing ? '刷新中...' : '刷新行情';
}
function bondListSetExportButton(busy, text) {
  var button = document.getElementById('bond-list-export');
  if (!button) return;
  button.disabled = Boolean(busy);
  button.textContent = text || '导出 Excel';
}
// 只发送当前列表 30 列，不带 data_status/stock_code 等内部或非展示字段。
function bondListExportRow(row) {
  var projected = {};
  BOND_LIST_COLUMNS.forEach(function(col) {
    var value = row[col[0]];
    projected[col[0]] = value === undefined ? null : value;
  });
  return projected;
}
function bondListDownload(blob, tradeDate) {
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = '上市可转债_' + String(tradeDate || '').slice(0, 10) + '.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
function bondListStartAutoRefresh() {
  if (bondListState.refreshTimer) return;
  bondListState.refreshTimer = setInterval(function() {
    var page = document.getElementById('sub-bond-list');
    // 定时器只重新读取数据库快照；腾讯实时行情仅由用户点击“刷新行情”主动触发。
    if (page && !page.hidden) loadBondList(false);
  }, BOND_LIST_REFRESH_MS);
}
function bondListRefresh() { loadBondList(true); }
// View 对外入口（批次4）：Presenter 只调这些函数改界面，自己不碰 DOM。
function bondListShowUpdated(data, forceRefresh) {
  bondListSyncRatingMenu();
  var status = document.getElementById('bond-list-updated');
  var stale = document.getElementById('bond-list-stale');
  if (stale) { stale.classList.remove('js-hidden'); stale.style.display = data.stale ? '' : 'none'; }
  var quoteTime = data.quote_time ? String(data.quote_time).slice(0, 16).replace('T', ' ') : null;
  var quoteText = forceRefresh && data.quote_status === 'partial' ? '行情部分更新' : quoteTime ? '行情：' + quoteTime : '收盘数据';
  if (status) status.textContent = data.trade_date ? '数据日期：' + data.trade_date + ' · ' + quoteText + '（' + bondListState.rows.length + ' 条）' : '暂无数据';
}

function bondListShowError(error) {
  var status = document.getElementById('bond-list-updated');
  var table = document.getElementById('bond-list-table');
  if (bondListState.rows.length) {
    bondListApplyFilters();
    if (status) status.textContent = '刷新失败，继续显示上次行情';
  } else if (table) table.innerHTML = '<div class="bond-list-empty">数据加载失败：' + escapeHtml(error.message || error) + '</div>';
  if (status && !bondListState.rows.length) status.textContent = '读取失败';
}
