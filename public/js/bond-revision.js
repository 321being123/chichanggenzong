// 可转债下修监控：纯展示层，状态与计算全部来自服务端统一视图。
var bondRevisionState = { rows: [], filtered: [], loaded: false, loading: false };
var BOND_REVISION_STATUS = {
  implemented: '已实施', approved: '股东大会通过', meeting_pending: '股东大会待审', proposed: '已提议下修',
  terminated: '未通过/已终止', met_pending: '已满足待公告', near: '接近触发', locked: '不下修锁定期', floor_blocked: '净资产底线限制',
  tracking: '跟踪中', incomplete: '数据不完整'
};
var BOND_REVISION_MOTIVE = { research_high: '研究评分≥70（待校准）', has_motive: '存在动机', weak: '动机偏弱', unavailable: '暂无数据' };
var BOND_REVISION_COLUMNS = [
  ['business_status','状态'],['motive_level','动机等级'],['security_code','代码'],['bond_name','转债名称'],['bond_close','转债现价'],['remain_size','剩余规模(亿元)'],
  ['stock_name','正股名称'],['stock_close','正股价'],['current_conv_price','转股价'],['conversion_value','转股价值'],['conversion_premium_pct','转股溢价率'],
  ['stock_pb','正股PB'],['net_asset_floor_applicable','净资产底线'],['net_asset_floor_value','每股净资产'],['trigger_ratio','下修比例'],['trigger_price','下修触发价'],['distance_to_trigger_pct','距触发'],['matched_days','下修进度'],['remaining_days','当前还差'],['rolling_remaining_days','滚动最快还需'],
  ['no_revision_valid_until','锁定至'],['next_eligible_date','重新起算日'],['official_announced_at','公告日'],['meeting_date','股东大会日'],
  ['price_after','新转股价'],['effective_date','生效日'],['reached_floor','是否到底'],['official_source_url','公告']
];
var BOND_REVISION_PERCENT = { conversion_premium_pct: true, distance_to_trigger_pct: true, trigger_ratio: true };
var BOND_REVISION_NUMBER = { bond_close: true, remain_size: true, stock_close: true, current_conv_price: true, conversion_value: true, stock_pb: true, net_asset_floor_value: true, trigger_price: true, price_after: true, remaining_days: true, rolling_remaining_days: true };

function bondRevisionText(v) { return v === null || v === undefined || v === '' ? '—' : String(v); }
function bondRevisionNumber(v, digits) { var n = Number(v); return Number.isFinite(n) ? n.toFixed(digits == null ? 2 : digits) : '—'; }
function bondRevisionPercent(v) { var n = Number(v); return Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '—'; }
function bondRevisionDate(v) { return v ? String(v).slice(0, 10) : '—'; }
function bondRevisionStatus(v) {
  var cls = String(v || 'incomplete').replace(/[^a-z_]/g, '');
  return '<span class="bond-revision-status bond-revision-status-' + cls + '">' + escapeHtml(BOND_REVISION_STATUS[v] || '数据不完整') + '</span>';
}
function bondRevisionJump(code) {
  if (typeof switchMain !== 'function') return;
  switchMain('stock-analysis');
  setTimeout(function () { if (typeof securityAnalysisSelect === 'function') securityAnalysisSelect(code); }, 150);
}
function bondRevisionCell(row, key) {
  if (key === 'business_status') return bondRevisionStatus(row[key]);
  if (key === 'motive_level') {
    if (!row[key] || row.motive_quality_status === 'incomplete' || row[key] === 'unavailable') return '暂无数据';
    var code = encodeURIComponent(String(row.ts_code || ''));
    return '<a class="bond-revision-motive-link" href="/bond-revision-motive.html?code=' + code + '">' + escapeHtml(BOND_REVISION_MOTIVE[row[key]] || row[key]) + '</a>';
  }
  if (key === 'security_code' || key === 'bond_name') {
    return '<span class="bond-revision-link" onclick="bondRevisionJump(\'' + escapeHtml(row.ts_code || row.security_code) + '\')">' + escapeHtml(bondRevisionText(row[key])) + '</span>';
  }
  if (key === 'official_source_url') return row[key] ? '<a href="' + escapeHtml(row[key]) + '" target="_blank" rel="noreferrer">查看</a>' : '—';
  if (key === 'matched_days') return row.required_days == null || row.matched_days == null ? '—' : escapeHtml(String(row.matched_days) + ' / ' + String(row.required_days) + ' | ' + String(row.observation_days || '—'));
  if (key === 'reached_floor') return row[key] == null ? '—' : (row[key] ? '下修到底' : '下修不到底');
  if (key === 'net_asset_floor_applicable') return row[key] == null ? '—' : (row[key] ? '不得低于' : '可低于');
  if (BOND_REVISION_PERCENT[key]) return escapeHtml(bondRevisionPercent(row[key]));
  if (BOND_REVISION_NUMBER[key]) return escapeHtml(bondRevisionNumber(row[key], key === 'current_conv_price' ? 3 : 2));
  if (key.indexOf('date') >= 0) return escapeHtml(bondRevisionDate(row[key]));
  return escapeHtml(bondRevisionText(row[key]));
}
function bondRevisionApplyFilters() {
  var search = String((document.getElementById('bond-revision-search') || {}).value || '').trim().toLowerCase();
  var status = String((document.getElementById('bond-revision-status') || {}).value || '');
  var near = !!((document.getElementById('bond-revision-near') || {}).checked);
  bondRevisionState.filtered = bondRevisionState.rows.filter(function (row) {
    var hit = !search || [row.security_code,row.ts_code,row.bond_name,row.stock_code,row.stock_name].some(function (v) { return String(v || '').toLowerCase().indexOf(search) >= 0; });
    var nearHit = !near || ['near','met_pending','proposed','meeting_pending','approved'].indexOf(row.business_status) >= 0;
    return hit && nearHit && (!status || row.business_status === status);
  });
  bondRevisionRender();
}
function bondRevisionRender() {
  var el = document.getElementById('bond-revision-table'), visible = document.getElementById('bond-revision-visible');
  if (visible) visible.textContent = bondRevisionState.filtered.length + ' / ' + bondRevisionState.rows.length + ' 条';
  if (!el) return;
  if (!bondRevisionState.filtered.length) { el.innerHTML = '<div class="bond-revision-empty">暂无符合条件的数据</div>'; return; }
  var head = BOND_REVISION_COLUMNS.map(function (col) { return '<th>' + escapeHtml(col[1]) + '</th>'; }).join('');
  var body = bondRevisionState.filtered.map(function (row) {
    return '<tr>' + BOND_REVISION_COLUMNS.map(function (col) { return '<td>' + bondRevisionCell(row, col[0]) + '</td>'; }).join('') + '</tr>';
  }).join('');
  el.innerHTML = '<div class="biz-table-scroll"><table class="biz-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  if (window.BusinessTable) window.BusinessTable.attach(el, { page: '#sub-bond-revision', top: '#main-bond-safety > .bond-header' });
}
function bondRevisionRenderSummary(summary) {
  document.querySelectorAll('[data-revision-status]').forEach(function (el) { el.textContent = String((summary || {})[el.dataset.revisionStatus] || 0); });
}
async function loadBondRevision(force) {
  if (bondRevisionState.loading) return;
  if (!force && bondRevisionState.loaded) { bondRevisionApplyFilters(); return; }
  bondRevisionState.loading = true;
  var updated = document.getElementById('bond-revision-updated');
  try {
    var response = await fetch(api('/api/bond-revision?limit=2000'), { cache: 'no-store' });
    if (!response.ok) throw new Error('接口返回 ' + response.status);
    var data = await response.json();
    bondRevisionState.rows = Array.isArray(data.data) ? data.data : [];
    bondRevisionState.loaded = true;
    bondRevisionRenderSummary(data.summary);
    if (updated) updated.textContent = data.trade_date ? '数据日期：' + bondRevisionDate(data.trade_date) + '（' + bondRevisionState.rows.length + ' 条）' + (data.stale ? (data.quality && data.quality.status === 'degraded' ? ' · 公告数据待补齐' : ' · 下修状态待更新') : (data.quality && data.quality.terminal_no_revision_parse ? ' · 公告解析有例外' : '')) : '暂无数据';
    bondRevisionApplyFilters();
  } catch (error) {
    var table = document.getElementById('bond-revision-table');
    if (table && !bondRevisionState.rows.length) table.innerHTML = '<div class="bond-revision-empty">数据加载失败：' + escapeHtml(error.message || error) + '</div>';
    if (updated) updated.textContent = '读取失败';
  } finally { bondRevisionState.loading = false; }
}
