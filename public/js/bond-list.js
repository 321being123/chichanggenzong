// 上市可转债列表：只展示服务端每日快照，不在浏览器端访问外部数据源。
var BOND_LIST_REFRESH_MS = 15 * 60 * 1000;
var bondListState = { rows: [], filtered: [], sortKey: 'double_low', sortDir: 1, loaded: false, loading: false, lastRefreshAt: 0, refreshTimer: null };
// 兼容旧页面调用名：实际表头吸顶和底部滚动条已统一交给 BusinessTable。
function bondListFloatingHead() { return null; }
function bondListSyncFloatingHead() { if (window.BusinessTable) window.BusinessTable.sync(); }
function bondListFloatingScroll() { return null; }
function bondListSyncFloatingScroll() { if (window.BusinessTable) window.BusinessTable.sync(); }
// 旧版监听曾排除 event.target.id === 'bond-list-floating-scroll'，现由共享组件内部处理。
// 旧版定位选择器 document.querySelector('#main-bond-safety > .bond-header') 已作为 BusinessTable 的 top 作用域传入。
var BOND_LIST_COLUMNS = [
  ['bond_code','代码'],['bond_name','转债名称'],['price','现价'],['change_pct','涨跌幅'],['stock_name','正股名称'],
  ['stock_price','正股价'],['stock_change_pct','正股涨跌'],['stock_pb','正股PB'],['convert_price','转股价'],['conversion_value','转股价值'],
  ['conversion_premium','转股溢价率'],['bond_value','纯债价值'],['bond_floor_premium','债底溢价率'],['rating','债券评级'],['safety','安全性'],
  ['option_value','期权价值'],['theoretical_value','理论价值'],['theoretical_deviation','理论偏离度'],['stock_volatility','正股波动率'],
  ['call_trigger_price','强赎触发价'],['bond_market_cap_ratio','转债占比'],['asset_liability_ratio','资产负债率'],['fund_holding_ratio','基金持仓'],
  ['maturity_date','到期时间'],['remaining_years','剩余年限'],['remain_size','剩余规模(亿元)'],['amount','成交额(万元)'],['turnover_rate','换手率'],
  ['maturity_yield_pre_tax','到期税前收益'],['double_low','双低']
];
var BOND_LIST_PERCENT = { change_pct:1, stock_change_pct:1, conversion_premium:1, bond_floor_premium:1, theoretical_deviation:1,
  stock_volatility:1, bond_market_cap_ratio:1, asset_liability_ratio:1, fund_holding_ratio:1, turnover_rate:1,
  maturity_yield_pre_tax:1, put_yield_pre_tax:1, put_yield_after_tax:1 };

function bondListText(value) { return value === null || value === undefined || value === '' ? '—' : String(value); }
function bondListLifecycleMarker(status) {
  if (status === 'announced' || status === 'completed') return '<span class="bond-lifecycle-mark bond-lifecycle-mark-call" role="img" aria-label="已公告强赎" title="已公告强赎">!</span>';
  if (status === 'maturity_near') return '<span class="bond-lifecycle-mark bond-lifecycle-mark-maturity" role="img" aria-label="临近到期" title="临近到期">!</span>';
  return '';
}
function bondListNumber(value, digits) { var n = Number(value); return Number.isFinite(n) ? n.toFixed(digits == null ? 2 : digits) : '—'; }
function bondListPercent(value) { var n = Number(value); return Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '—'; }
function bondListDate(value) { return value ? String(value).slice(0, 10) : '—'; }
function bondListSafety(value) {
  var rating = String(value || '未评级');
  var cls = { '安全':'safe', '低风险':'low', '中风险':'medium', '高风险':'high', '未评级':'none' }[rating] || 'none';
  return '<span class="bond-rating bond-rating-' + cls + '">' + escapeHtml(rating) + '</span>';
}
function bondListCell(row, key) {
  if (key === 'bond_code' || key === 'bond_name') return '<span class="bond-list-link" onclick="bondListJump(\'' + escapeHtml(row.ts_code || row.bond_code) + '\')">' + escapeHtml(bondListText(row[key])) + '</span>' + (key === 'bond_name' ? bondListLifecycleMarker(row.call_status) : '');
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
function bondListApplyFilters() {
  var search = String((document.getElementById('bond-list-search') || {}).value || '').trim().toLowerCase();
  var status = String((document.getElementById('bond-list-status') || {}).value || '');
  bondListState.filtered = bondListState.rows.filter(function(row) {
    var hit = !search || [row.bond_code,row.bond_name,row.stock_name,row.stock_code].some(function(v) { return String(v || '').toLowerCase().indexOf(search) >= 0; });
    return hit && (!status || row.data_status === status);
  }).sort(bondListSort);
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
  el.querySelectorAll('th[data-key]').forEach(function(th) { th.onclick = function() { var key = th.dataset.key; if (bondListState.sortKey === key) bondListState.sortDir *= -1; else { bondListState.sortKey = key; bondListState.sortDir = 1; } bondListApplyFilters(); }; });
  if (window.BusinessTable) window.BusinessTable.attach(el, { page: '#sub-bond-list', top: '#main-bond-safety > .bond-header' });
}
function bondListJump(code) { if (typeof switchMain === 'function') { switchMain('stock-analysis'); setTimeout(function() { if (typeof securityAnalysisSelect === 'function') securityAnalysisSelect(code); }, 150); } }
function bondListSetRefreshButton(refreshing) {
  var button = document.getElementById('bond-list-refresh');
  if (!button) return;
  button.disabled = Boolean(refreshing);
  button.textContent = refreshing ? '刷新中...' : '刷新行情';
}
function bondListStartAutoRefresh() {
  if (bondListState.refreshTimer) return;
  bondListState.refreshTimer = setInterval(function() {
    var page = document.getElementById('sub-bond-list');
    if (page && !page.hidden) loadBondList(true);
  }, BOND_LIST_REFRESH_MS);
}
function bondListRefresh() { loadBondList(true); }
async function loadBondList(forceRefresh) {
  forceRefresh = Boolean(forceRefresh);
  if (!bondListState.loaded) forceRefresh = true;
  if (bondListState.loading) return;
  if (!forceRefresh && bondListState.loaded) {
    bondListApplyFilters();
    if (Date.now() - bondListState.lastRefreshAt >= BOND_LIST_REFRESH_MS) loadBondList(true);
    return;
  }
  bondListState.loading = true;
  bondListSetRefreshButton(true);
  var status = document.getElementById('bond-list-updated');
  try {
    var url = '/api/bond-analysis/bonds?limit=1000' + (forceRefresh ? '&refresh=1' : '');
    var response = await fetch(api(url), { cache: 'no-store' });
    if (!response.ok) throw new Error('接口返回 ' + response.status);
    var data = await response.json();
    bondListState.rows = Array.isArray(data.data) ? data.data : [];
    bondListState.loaded = true;
    bondListState.lastRefreshAt = Date.now();
    var stale = document.getElementById('bond-list-stale');
    if (stale) stale.style.display = data.stale ? '' : 'none';
    var quoteTime = data.quote_time ? String(data.quote_time).slice(0, 16).replace('T', ' ') : null;
    var quoteText = forceRefresh && data.quote_status === 'partial' ? '行情部分更新' : quoteTime ? '行情：' + quoteTime : '收盘数据';
    if (status) status.textContent = data.trade_date ? '数据日期：' + data.trade_date + ' · ' + quoteText + '（' + bondListState.rows.length + ' 条）' : '暂无数据';
    bondListApplyFilters();
  } catch (error) {
    var table = document.getElementById('bond-list-table');
    if (bondListState.rows.length) {
      bondListApplyFilters();
      if (status) status.textContent = '刷新失败，继续显示上次行情';
    } else if (table) table.innerHTML = '<div class="bond-list-empty">数据加载失败：' + escapeHtml(error.message || error) + '</div>';
    if (status && !bondListState.rows.length) status.textContent = '读取失败';
  } finally {
    bondListState.loading = false;
    bondListSetRefreshButton(false);
    bondListStartAutoRefresh();
  }
}
