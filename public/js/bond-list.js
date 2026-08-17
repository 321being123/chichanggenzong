// 上市可转债列表：只展示服务端每日快照，不在浏览器端访问外部数据源。
var BOND_LIST_REFRESH_MS = 15 * 60 * 1000;
var bondListState = { rows: [], filtered: [], sortKey: 'double_low', sortDir: 1, loaded: false, loading: false, lastRefreshAt: 0, refreshTimer: null, floatingTimer: null };
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
function bondListNumber(value, digits) { var n = Number(value); return Number.isFinite(n) ? n.toFixed(digits == null ? 2 : digits) : '—'; }
function bondListPercent(value) { var n = Number(value); return Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '—'; }
function bondListDate(value) { return value ? String(value).slice(0, 10) : '—'; }
function bondListSafety(value) {
  var rating = String(value || '未评级');
  var cls = { '安全':'safe', '低风险':'low', '中风险':'medium', '高风险':'high', '未评级':'none' }[rating] || 'none';
  return '<span class="bond-rating bond-rating-' + cls + '">' + escapeHtml(rating) + '</span>';
}
function bondListCell(row, key) {
  if (key === 'bond_code' || key === 'bond_name') return '<span class="bond-list-link" onclick="bondListJump(\'' + escapeHtml(row.ts_code || row.bond_code) + '\')">' + escapeHtml(bondListText(row[key])) + '</span>';
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
function bondListFloatingHead() {
  var host = document.getElementById('bond-list-floating-head');
  if (!host) {
    host = document.createElement('div');
    host.id = 'bond-list-floating-head';
    host.className = 'bond-list-floating-head';
    host.hidden = true;
    document.body.appendChild(host);
  }
  return host;
}
function bondListFloatingScroll() {
  var host = document.getElementById('bond-list-floating-scroll');
  if (!host) {
    host = document.createElement('div');
    host.id = 'bond-list-floating-scroll';
    host.className = 'bond-list-floating-scroll';
    host.hidden = true;
    host.innerHTML = '<div class="bond-list-floating-scroll-inner"></div>';
    host.addEventListener('scroll', function() {
      var scroll = document.querySelector('#bond-list-table .bond-list-scroll');
      if (scroll && Math.abs(scroll.scrollLeft - host.scrollLeft) > 1) scroll.scrollLeft = host.scrollLeft;
    }, { passive: true });
    document.body.appendChild(host);
  }
  return host;
}
function bondListBuildFloatingHead() {
  var source = document.querySelector('#bond-list-table .bond-list-table');
  var sourceHead = source && source.querySelector('thead');
  var scroll = document.querySelector('#bond-list-table .bond-list-scroll');
  if (!source || !sourceHead || !scroll) return;
  var host = bondListFloatingHead();
  var bottomScroll = bondListFloatingScroll();
  host.innerHTML = '';
  var floating = source.cloneNode(false);
  floating.classList.add('bond-list-floating-table');
  floating.style.width = source.getBoundingClientRect().width + 'px';
  floating.appendChild(sourceHead.cloneNode(true));
  host.appendChild(floating);
  var sourceCells = sourceHead.querySelectorAll('th');
  floating.querySelectorAll('th').forEach(function(th, index) {
    if (sourceCells[index]) th.style.width = sourceCells[index].getBoundingClientRect().width + 'px';
    th.onclick = function() { if (sourceCells[index]) sourceCells[index].click(); };
  });
  if (!scroll.__bondListFloatingBound) {
    scroll.__bondListFloatingBound = true;
    scroll.addEventListener('scroll', bondListSyncFloatingUi, { passive: true });
  }
  if (!window.__bondListFloatingBound) {
    window.__bondListFloatingBound = true;
    window.addEventListener('scroll', bondListSyncFloatingUi, { passive: true });
    window.addEventListener('resize', bondListSyncFloatingUi);
    document.addEventListener('scroll', bondListSyncFloatingUi, true);
  }
  host.__source = source;
  host.__scroll = scroll;
  bottomScroll.querySelector('.bond-list-floating-scroll-inner').style.width = scroll.scrollWidth + 'px';
}
function bondListSyncFloatingHead() {
  var host = document.getElementById('bond-list-floating-head');
  var source = document.querySelector('#bond-list-table .bond-list-table');
  var head = source && source.querySelector('thead');
  var scroll = document.querySelector('#bond-list-table .bond-list-scroll');
  var nav = document.querySelector('#main-bond-safety > .bond-header');
  var page = document.getElementById('sub-bond-list');
  if (!host || !source || !head || !scroll || !nav || !page || page.hidden) {
    if (host) host.hidden = true;
    return;
  }
  if (host.__source !== source) bondListBuildFloatingHead();
  var top = nav.getBoundingClientRect().bottom;
  var sourceRect = source.getBoundingClientRect();
  var headRect = head.getBoundingClientRect();
  var headRow = head.querySelector('tr');
  var headHeight = Math.max(40, headRow ? headRow.getBoundingClientRect().height : 0, headRect.height || 0);
  var show = headRect.top < top && sourceRect.bottom > top + headHeight;
  if (!show) { host.hidden = true; return; }
  var scrollRect = scroll.getBoundingClientRect();
  host.hidden = false;
  host.style.display = 'block';
  host.style.visibility = 'visible';
  host.style.top = top + 'px';
  host.style.left = scrollRect.left + 'px';
  host.style.width = Math.max(0, Math.min(scrollRect.width, window.innerWidth - scrollRect.left)) + 'px';
  host.style.height = headHeight + 'px';
  var floating = host.querySelector('.bond-list-floating-table');
  if (floating) {
    floating.style.height = headHeight + 'px';
    floating.style.transform = 'translateX(-' + scroll.scrollLeft + 'px)';
  }
}
function bondListSyncFloatingScroll() {
  var host = document.getElementById('bond-list-floating-scroll');
  var scroll = document.querySelector('#bond-list-table .bond-list-scroll');
  var page = document.getElementById('sub-bond-list');
  if (!host || !scroll || !page || page.hidden) {
    if (host) host.hidden = true;
    return;
  }
  var rect = scroll.getBoundingClientRect();
  var show = scroll.scrollWidth > scroll.clientWidth + 1 && rect.top < window.innerHeight && rect.bottom > window.innerHeight;
  if (!show) { host.hidden = true; return; }
  host.hidden = false;
  host.style.left = rect.left + 'px';
  host.style.width = Math.max(0, Math.min(rect.width, window.innerWidth - rect.left)) + 'px';
  host.querySelector('.bond-list-floating-scroll-inner').style.width = scroll.scrollWidth + 'px';
  if (Math.abs(host.scrollLeft - scroll.scrollLeft) > 1) host.scrollLeft = scroll.scrollLeft;
}
function bondListSyncFloatingUi(event) {
  if (event && event.target && event.target.id === 'bond-list-floating-scroll') return;
  bondListSyncFloatingHead();
  bondListSyncFloatingScroll();
}
function bondListRender() {
  var el = document.getElementById('bond-list-table'), visible = document.getElementById('bond-list-visible');
  if (visible) visible.textContent = bondListState.filtered.length + ' / ' + bondListState.rows.length + ' 条';
  if (!el) return;
  if (!bondListState.filtered.length) {
    el.innerHTML = '<div class="bond-list-empty">暂无符合条件的数据</div>';
    var emptyHost = document.getElementById('bond-list-floating-head');
    if (emptyHost) emptyHost.hidden = true;
    var emptyScroll = document.getElementById('bond-list-floating-scroll');
    if (emptyScroll) emptyScroll.hidden = true;
    return;
  }
  var head = BOND_LIST_COLUMNS.map(function(col) { return '<th data-key="' + col[0] + '">' + escapeHtml(col[1]) + '</th>'; }).join('');
  var body = bondListState.filtered.map(function(row) { return '<tr>' + BOND_LIST_COLUMNS.map(function(col) { return '<td>' + bondListCell(row, col[0]) + '</td>'; }).join('') + '</tr>'; }).join('');
  el.innerHTML = '<div class="bond-list-scroll"><table class="bond-list-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  el.querySelectorAll('th[data-key]').forEach(function(th) { th.onclick = function() { var key = th.dataset.key; if (bondListState.sortKey === key) bondListState.sortDir *= -1; else { bondListState.sortKey = key; bondListState.sortDir = 1; } bondListApplyFilters(); }; });
  bondListBuildFloatingHead();
  bondListSyncFloatingUi();
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
  if (!bondListState.floatingTimer) bondListState.floatingTimer = setInterval(bondListSyncFloatingUi, 200);
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
