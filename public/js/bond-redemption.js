// 强赎监控：只读服务端统一状态视图，不在浏览器端重新计算触发条件。
var bondRedemptionState = { rows: [], filtered: [], loaded: false, loading: false, lastRefreshAt: 0 };
var BOND_REDEMPTION_REFRESH_MS = 15 * 60 * 1000;

function bondRedemptionText(value) { return value === null || value === undefined || value === '' ? '—' : String(value); }
function bondRedemptionNum(value, digits) { var n = Number(value); return Number.isFinite(n) ? n.toFixed(digits == null ? 2 : digits) : '—'; }
function bondRedemptionPct(value) { var n = Number(value); return Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—'; }
function bondRedemptionDate(value) {
  if (!value) return '—';
  var text = String(value);
  var iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return iso[1] + '年' + iso[2].padStart(2, '0') + '月' + iso[3].padStart(2, '0') + '日';
  var date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  var values = {};
  parts.forEach(function (part) { values[part.type] = part.value; });
  return values.year + '年' + values.month + '月' + values.day + '日';
}
function bondRedemptionStatus(value) {
  var labels = { announced: '已公告强赎', met_pending: '已满足待确认', near: '接近触发', maturity_near: '临近到期', tracking: '跟踪中', waived: '不提前赎回', completed: '已完成', inactive: '已失效', incomplete: '数据不完整' };
  var cls = String(value || 'incomplete').replace(/[^a-z_]/g, '');
  return '<span class="bond-redemption-status bond-redemption-status-' + cls + '">' + escapeHtml(labels[value] || '数据不完整') + '</span>';
}
function bondRedemptionApplyFilters() {
  var search = String((document.getElementById('bond-redemption-search') || {}).value || '').trim().toLowerCase();
  var status = String((document.getElementById('bond-redemption-status') || {}).value || '');
  bondRedemptionState.filtered = bondRedemptionState.rows.filter(function (row) {
    var hit = !search || [row.security_code, row.ts_code, row.bond_name, row.stock_code, row.stock_name].some(function (v) { return String(v || '').toLowerCase().indexOf(search) >= 0; });
    return hit && (!status || row.business_status === status || (status === 'incomplete' && row.data_status !== 'complete'));
  });
  bondRedemptionRender();
}
function bondRedemptionCell(row, key) {
  if (key === 'security_code' || key === 'bond_name') {
    return '<span class="bond-redemption-link" onclick="bondRedemptionJump(\'' + escapeHtml(row.ts_code || row.security_code) + '\')">' + escapeHtml(bondRedemptionText(row[key])) + '</span>';
  }
  if (key === 'business_status') return bondRedemptionStatus(row[key]);
  if (key === 'distance_to_trigger_pct') return escapeHtml(bondRedemptionPct(row[key]));
  if (key === 'bond_close' || key === 'stock_close' || key === 'current_conv_price' || key === 'trigger_price') return escapeHtml(bondRedemptionNum(row[key], 2));
  if (key === 'remain_size') return escapeHtml(bondRedemptionNum(row[key], 3));
  if (key.indexOf('date') >= 0 || key === 'trade_date') return escapeHtml(bondRedemptionDate(row[key]));
  if (key === 'matched_days') return escapeHtml(row.required_days ? (bondRedemptionText(row.matched_days) + ' / ' + bondRedemptionText(row.required_days) + ' | ' + bondRedemptionText(row.observation_days)) : '—');
  return escapeHtml(bondRedemptionText(row[key]));
}
var BOND_REDEMPTION_COLUMNS = [
  ['business_status','状态'],['security_code','代码'],['bond_name','转债名称'],['bond_close','转债价'],['stock_name','正股'],['stock_close','正股价'],
  ['current_conv_price','转股价'],['trigger_price','强赎触发价'],['distance_to_trigger_pct','距触发'],['matched_days','触发进度'],
  ['last_trade_date','停止交易日'],['last_conversion_date','停止转股日'],['remain_size','剩余规模(亿元)'],['maturity_date','到期日']
];
function bondRedemptionRender() {
  var el = document.getElementById('bond-redemption-table'), visible = document.getElementById('bond-redemption-visible');
  if (visible) visible.textContent = bondRedemptionState.filtered.length + ' / ' + bondRedemptionState.rows.length + ' 条';
  if (!el) return;
  if (!bondRedemptionState.filtered.length) { el.innerHTML = '<div class="bond-redemption-empty">暂无符合条件的数据</div>'; return; }
  var head = BOND_REDEMPTION_COLUMNS.map(function (col) { return '<th>' + escapeHtml(col[1]) + '</th>'; }).join('');
  var body = bondRedemptionState.filtered.map(function (row) { return '<tr>' + BOND_REDEMPTION_COLUMNS.map(function (col) { return '<td>' + bondRedemptionCell(row, col[0]) + '</td>'; }).join('') + '</tr>'; }).join('');
  el.innerHTML = '<div class="biz-table-scroll"><table class="biz-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  if (window.BusinessTable) window.BusinessTable.attach(el, { page: '#sub-bond-redemption', top: '#main-bond-safety > .bond-header' });
}
function bondRedemptionRenderSummary(summary) {
  document.querySelectorAll('[data-call-status]').forEach(function (el) { el.textContent = String((summary || {})[el.dataset.callStatus] || 0); });
}
function bondRedemptionJump(code) {
  if (typeof switchMain !== 'function') return;
  switchMain('stock-analysis');
  setTimeout(function () { if (typeof securityAnalysisSelect === 'function') securityAnalysisSelect(code); }, 150);
}
async function loadBondRedemption(force) {
  if (bondRedemptionState.loading) return;
  if (!force && bondRedemptionState.loaded) { bondRedemptionApplyFilters(); return; }
  bondRedemptionState.loading = true;
  var updated = document.getElementById('bond-redemption-updated');
  try {
    var response = await fetch(api('/api/bond-redemption?limit=2000'), { cache: 'no-store' });
    if (!response.ok) throw new Error('接口返回 ' + response.status);
    var data = await response.json();
    bondRedemptionState.rows = Array.isArray(data.data) ? data.data : [];
    bondRedemptionState.loaded = true;
    bondRedemptionState.lastRefreshAt = Date.now();
    bondRedemptionRenderSummary(data.summary);
    if (updated) updated.textContent = data.trade_date
      ? '数据日期：' + bondRedemptionDate(data.trade_date) + '（' + bondRedemptionState.rows.length + ' 条）' + (data.stale ? ' · 强赎状态待更新' : '')
      : '暂无数据';
    bondRedemptionApplyFilters();
  } catch (error) {
    var table = document.getElementById('bond-redemption-table');
    if (table && !bondRedemptionState.rows.length) table.innerHTML = '<div class="bond-redemption-empty">数据加载失败：' + escapeHtml(error.message || error) + '</div>';
    if (updated) updated.textContent = '读取失败';
  } finally {
    bondRedemptionState.loading = false;
  }
}
