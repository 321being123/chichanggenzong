// 可转债周期：前端展示（只读，不复制后端公式）
// 交互：二级导航切换、时间范围（1年/3年/5年/全部）、指标切换（周期分位/综合估值/价格中位数/溢价率中位数）、SVG 历史图。
var esc = (typeof escapeHtml === 'function') ? escapeHtml : function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
function num(v, d) { var n = Number(v); return Number.isFinite(n) ? n.toFixed(d == null ? 2 : d) : '--'; }
function pct(v, d) { return (v === null || v === undefined || !Number.isFinite(Number(v))) ? '--' : num(Number(v) * 100, d == null ? 1 : d) + '%'; }

var bondCycleState = { range: 'all', metric: 'percentile', data: null, loading: false, visible: { percentile: true, composite: true, median_price: false, median_conversion_premium_pct: false } };
var bondCycleTablePage = 1;
var BC_TABLE_PAGE_SIZE = 50; // 表格每页显示条数（默认展示最近 50 条，可翻页）

function switchBondSub(sub) {
  if (sub === 'analysis') sub = 'safety';
  sub = sub || 'safety';
  var safety = document.getElementById('sub-bond-safety');
  var cycle = document.getElementById('sub-bond-cycle');
  var valuation = document.getElementById('sub-bond-valuation');
  var list = document.getElementById('sub-bond-list');
  if (safety) safety.hidden = (sub !== 'safety');
  if (cycle) cycle.hidden = (sub !== 'cycle');
  if (valuation) valuation.hidden = (sub !== 'valuation');
  if (list) list.hidden = (sub !== 'list');
  var tabs = document.querySelectorAll('.bond-sub-tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.sub === sub);
  var params = new URLSearchParams(window.location.search);
  params.set('main', 'bond-safety');
  if (sub === 'cycle') params.set('sub', 'cycle');
  else if (sub === 'valuation') params.set('sub', 'valuation');
  else if (sub === 'list') params.set('sub', 'list');
  else params.delete('sub');
  history.replaceState(null, '', '/?' + params.toString());
  if (sub === 'cycle') loadBondCycle();
  else if (sub === 'valuation') loadBondValuation();
  else if (sub === 'list' && typeof loadBondList === 'function') loadBondList();
}

function initBondCycleSub() {
  if (window.__bondCycleControlsReady) {
    var p = new URLSearchParams(window.location.search);
    var sub = p.get('sub');
    switchBondSub(sub === 'cycle' ? 'cycle' : (sub === 'valuation' ? 'valuation' : (sub === 'list' ? 'list' : 'safety')));
    return;
  }
  window.__bondCycleControlsReady = true;
  var rangeBtns = document.querySelectorAll('.bond-cycle-range-tabs button');
  for (var i = 0; i < rangeBtns.length; i++) {
    rangeBtns[i].onclick = function () {
      var b = this;
      var all = document.querySelectorAll('.bond-cycle-range-tabs button');
      for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
      b.classList.add('active');
      bondCycleState.range = b.dataset.range;
      bondCycleState.data = null; // 切换范围需重新请求
      bondCycleTablePage = 1;
      loadBondCycle();
    };
  }
  var metricBtns = document.querySelectorAll('.bond-cycle-metric-tabs button');
  function bcSeriesColor(m) { for (var z = 0; z < BC_SERIES.length; z++) if (BC_SERIES[z].key === m) return BC_SERIES[z].color; return '#555'; }
  for (var k = 0; k < metricBtns.length; k++) {
    (function (b) {
      var m = b.dataset.metric;
      b.style.borderBottom = '2px solid ' + bcSeriesColor(m);
      b.style.color = bondCycleState.visible[m] ? bcSeriesColor(m) : '#555';
      b.classList.toggle('active', !!bondCycleState.visible[m]);
      b.onclick = function () {
        bondCycleState.visible[m] = !bondCycleState.visible[m];
        b.classList.toggle('active', bondCycleState.visible[m]);
        b.style.color = bondCycleState.visible[m] ? bcSeriesColor(m) : '#555';
        if (bondCycleState.data) renderBondCycleChart(bondCycleState.data);
      };
    })(metricBtns[k]);
  }
  var p2 = new URLSearchParams(window.location.search);
  var sub2 = p2.get('sub');
  switchBondSub(sub2 === 'cycle' ? 'cycle' : (sub2 === 'valuation' ? 'valuation' : (sub2 === 'list' ? 'list' : 'safety')));
}

async function loadBondCycle() {
  if (bondCycleState.loading) return;
  var statusEl = document.getElementById('bond-cycle-status');
  if (!bondCycleState.data) {
    bondCycleState.loading = true;
    if (statusEl) statusEl.textContent = '正在读取周期数据...';
    try {
      var r = await fetch(api('/api/bond-cycle?range=' + encodeURIComponent(bondCycleState.range)));
      if (!r.ok) throw new Error('接口返回 ' + r.status);
      bondCycleState.data = await r.json();
    } catch (e) {
      bondCycleState.loading = false;
      if (statusEl) statusEl.textContent = '数据加载失败：' + (e.message || e);
      return;
    }
    bondCycleState.loading = false;
  }
  renderBondCycle(bondCycleState.data);
}

function renderBondCycle(data) {
  var statusEl = document.getElementById('bond-cycle-status');
  var overviewEl = document.getElementById('bond-cycle-overview');
  var chartWrap = document.getElementById('bond-cycle-chart-wrap');
  var updatedEl = document.getElementById('bond-cycle-updated');
  if (statusEl) statusEl.textContent = '';

  if (!data || !data.latest) {
    if (statusEl) statusEl.textContent = '尚未完成首次历史回填，暂无周期数据。';
    if (overviewEl) overviewEl.style.display = 'none';
    if (chartWrap) chartWrap.style.display = 'none';
    if (updatedEl) updatedEl.textContent = '暂无数据';
    var tableWrap0 = document.getElementById('bond-cycle-table-wrap');
    if (tableWrap0) tableWrap0.style.display = 'none';
    return;
  }

  if (updatedEl) {
    var up = data.updated_at ? new Date(data.updated_at).toLocaleString('zh-CN') : (data.source_trade_date || '');
    updatedEl.textContent = '数据更新：' + up + (data.source_trade_date ? '（交易日 ' + data.source_trade_date + '）' : '');
  }
  var staleEl = document.getElementById('bond-cycle-stale');
  if (staleEl) staleEl.style.display = data.stale ? 'block' : 'none';

  if (overviewEl) overviewEl.style.display = 'block';
  if (chartWrap) chartWrap.style.display = 'block';

  renderBondCycleCards(data.latest);
  renderBondCycleChart(data);
  renderBondCycleTable(data);
}

function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }

function renderBondCycleCards(latest) {
  setText('bc-cycle-level', latest.cycle_level != null ? latest.cycle_level : '--');
  setText('bc-percentile', latest.rolling_percentile == null ? '--' : num(latest.rolling_percentile, 1) + '%');
  setText('bc-composite', latest.composite_value == null ? '--' : num(latest.composite_value, 2));
  setText('bc-bond-count', latest.bond_count == null ? '--' : latest.bond_count);
  setText('bc-median-price', latest.median_price == null ? '--' : num(latest.median_price, 2) + ' 元');
  setText('bc-median-premium', latest.median_conversion_premium_pct == null ? '--' : num(latest.median_conversion_premium_pct, 2) + ' %');
  setText('bc-median-value', latest.median_conversion_value == null ? '--' : num(latest.median_conversion_value, 2) + ' 元');
  setText('bc-weight', latest.premium_weight == null ? '--' : pct(latest.premium_weight, 1));
  setText('bc-coverage', latest.coverage_ratio == null ? '--' : pct(latest.coverage_ratio, 1));

  var note = document.getElementById('bc-history-note');
  if (note) note.style.display = (latest.rolling_percentile == null) ? 'block' : 'none';
}

function renderBondCycleChart(data) {
  var latest = data.latest;
  if (!latest) return;
  renderHistoryChart(data.history || []);
}

// 前端指标名 → 接口返回字段名映射（接口返回 rolling_percentile / composite_value）
var BC_METRIC_FIELDS = {
  percentile: 'rolling_percentile',
  composite: 'composite_value',
  median_price: 'median_price',
  median_conversion_premium_pct: 'median_conversion_premium_pct'
};

// 四条曲线配置：每条独立纵轴，轴色与曲线同色
// side: L1=左外(综合估值) L2=左内(价格中位数) R1=右内(溢价率) R2=右外(周期分位)
var BC_SERIES = [
  { key: 'composite', name: '综合估值', color: '#2563eb', side: 'L1' },
  { key: 'median_price', name: '价格中位数', color: '#06b6d4', side: 'L2' },
  { key: 'median_conversion_premium_pct', name: '溢价率中位数', color: '#f59e0b', side: 'R1' },
  { key: 'percentile', name: '周期分位', color: '#ef4444', side: 'R2' }
];

// Catmull-Rom 样条转三次贝塞尔：平滑曲线（类似收益率曲线），且精确穿过每个数据点
function bcSmoothPath(pts) {
  if (!pts || pts.length < 2) return pts && pts.length ? ('M' + pts[0].x + ' ' + pts[0].y) : '';
  var d = 'M' + pts[0].x + ' ' + pts[0].y;
  for (var i = 0; i < pts.length - 1; i++) {
    var p0 = pts[i - 1] || pts[i];
    var p1 = pts[i];
    var p2 = pts[i + 1];
    var p3 = pts[i + 2] || p2;
    var cp1x = p1.x + (p2.x - p0.x) / 6;
    var cp1y = p1.y + (p2.y - p0.y) / 6;
    var cp2x = p2.x - (p3.x - p1.x) / 6;
    var cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ' C' + cp1x.toFixed(2) + ' ' + cp1y.toFixed(2) + ' ' + cp2x.toFixed(2) + ' ' + cp2y.toFixed(2) + ' ' + p2.x.toFixed(2) + ' ' + p2.y.toFixed(2);
  }
  return d;
}

function renderHistoryChart(history) {
  var root = document.getElementById('bond-cycle-chart');
  if (!root) return;
  if (!history || !history.length) { root.innerHTML = '<div class="bond-cycle-chart-empty">所选时间内暂无历史数据</div>'; return; }

  var W = 1100, H = 360, L = 76, R = 76, T = 35, B = 45;
  var plotH = H - T - B;
  function xAt(i) { return L + i * (W - L - R) / Math.max(1, history.length - 1); }
  function bcAxisX(side) {
    if (side === 'L1') return L - 46;
    if (side === 'L2') return L - 16;
    if (side === 'R1') return W - R + 16;
    if (side === 'R2') return W - R + 46;
    return L;
  }

  // 收集每条可见且有数据的序列，各自独立纵轴范围
  var series = [];
  for (var s = 0; s < BC_SERIES.length; s++) {
    var metric = BC_SERIES[s].key;
    if (!bondCycleState.visible[metric]) continue;
    var field = BC_METRIC_FIELDS[metric];
    var vals = [];
    for (var i = 0; i < history.length; i++) {
      var r = history[i];
      var v = r[field];
      if (v !== null && v !== undefined && Number.isFinite(Number(v))) vals.push(Number(v));
    }
    if (!vals.length) continue;
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (mn === mx) { mx += 1; mn = Math.max(0, mn - 1); }
    else { var pad = (mx - mn) * 0.08; mn -= pad; mx += pad; }
    series.push({ cfg: BC_SERIES[s], field: field, mn: mn, mx: mx });
  }
  if (!series.length) { root.innerHTML = '<div class="bond-cycle-chart-empty">无有效数据</div>'; return; }

  function yOf(v, s) { return T + (s.mx - Math.max(s.mn, Math.min(s.mx, v))) * plotH / (s.mx - s.mn); }

  var svg = ['<title>可转债周期历史图（多指标叠加）</title>'];

  // 淡灰基准网格（4 条横线，不绑定任何轴）
  for (var g = 0; g <= 4; g++) {
    var gy = T + g * plotH / 4;
    svg.push('<line class="bc-grid" x1="' + L + '" y1="' + gy + '" x2="' + (W - R) + '" y2="' + gy + '"/>');
  }

  // 每条序列：独立纵轴 + 曲线（轴色与线同色）
  for (var si = 0; si < series.length; si++) {
    var s = series[si], ax = bcAxisX(s.cfg.side), col = s.cfg.color, isLeft = (s.cfg.side[0] === 'L');
    svg.push('<line x1="' + ax + '" y1="' + T + '" x2="' + ax + '" y2="' + (T + plotH) + '" stroke="' + col + '" stroke-width="1.2"/>');
    // 5 个刻度值：必须全是 5 的整数倍（无小数），step 动态算（≥5）
    var span = s.mx - s.mn;
    var step = Math.max(5, Math.ceil(span / 4 / 5) * 5);
    var tickVals = [0, 1, 2, 3, 4].map(function (t) {
      return Math.round((s.mx - t * span / 4) / step) * step;
    });
    for (var t = 0; t <= 4; t++) {
      var yy = T + t * plotH / 4;
      var val = tickVals[t];
      var tx1 = isLeft ? (ax - 4) : ax;
      var tx2 = isLeft ? ax : (ax + 4);
      svg.push('<line x1="' + tx1 + '" y1="' + yy + '" x2="' + tx2 + '" y2="' + yy + '" stroke="' + col + '" stroke-width="1"/>');
      var lblX = isLeft ? (ax - 7) : (ax + 7);
      var anchor = isLeft ? 'end' : 'start';
      svg.push('<text class="bc-axis" style="fill:' + col + '" x="' + lblX + '" y="' + (yy + 4) + '" text-anchor="' + anchor + '">' + val + '</text>');
    }
    var pts = [];
    for (var i = 0; i < history.length; i++) {
      var r = history[i];
      var v = r[s.field];
      if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
      pts.push({ x: xAt(i), y: yOf(Number(v), s) });
    }
    var d = bcSmoothPath(pts);
    svg.push('<path class="bc-line" style="stroke:' + col + '" d="' + d + '"/>');
  }

  // 横轴时间标签
  var xt = Math.min(10, history.length - 1);
  for (var n = 0; n <= xt; n++) {
    var idx = Math.round(n * (history.length - 1) / xt);
    svg.push('<text class="bc-axis" x="' + xAt(idx) + '" y="' + (H - 18) + '" text-anchor="middle">' + esc(String(history[idx].date).slice(0, 7)) + '</text>');
  }
  svg.push('<rect class="bc-hit" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + plotH + '"/>');

  root.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="可转债周期历史图（多指标叠加）">' + svg.join('') + '</svg>';

  var hit = root.querySelector('.bc-hit');
  var tip = document.getElementById('bond-cycle-tip');
  var chart = root.querySelector('svg');
  if (hit) {
    hit.onmousemove = function (e) {
      if (!tip || !chart) return;
      var box = chart.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (e.clientX - box.left - L / W * box.width) / ((W - L - R) / W * box.width)));
      var idx = Math.round(ratio * (history.length - 1));
      var r = history[idx];
      if (!r) return;
      var lines = ['<strong>' + esc(String(r.date).slice(0, 10)) + '</strong>'];
      for (var k = 0; k < series.length; k++) {
        var sc = series[k];
        var val = r[sc.field];
        var disp = (val === null || val === undefined) ? '--'
          : (sc.cfg.key === 'percentile' ? num(val, 1) + '%'
            : sc.cfg.key === 'median_price' ? num(val, 2) + ' 元'
            : sc.cfg.key === 'median_conversion_premium_pct' ? num(val, 2) + ' %'
            : num(val, 2));
        lines.push('<span style="color:' + sc.cfg.color + '">● ' + sc.cfg.name + '：' + disp + '</span>');
      }
      tip.innerHTML = lines.join('');
      tip.style.display = 'block';
      // 跟随鼠标（fixed 相对视口），超出视口则夹紧
      var padX = 12, padY = 14;
      var leftPx = e.clientX + padX;
      var topPx = e.clientY + padY;
      var vw = window.innerWidth, vh = window.innerHeight;
      if (leftPx + tip.offsetWidth > vw - 8) leftPx = e.clientX - tip.offsetWidth - padX;
      if (leftPx < 8) leftPx = 8;
      if (topPx + tip.offsetHeight > vh - 8) topPx = e.clientY - tip.offsetHeight - padY;
      if (topPx < 8) topPx = 8;
      tip.style.left = leftPx + 'px';
      tip.style.top = topPx + 'px';
    };
    hit.onmouseleave = function () { if (tip) tip.style.display = 'none'; };
  }
}

// 图表下方：历史回填数据明细表（默认最近 50 条，可翻页）
function renderBondCycleTable(data) {
  var wrap = document.getElementById('bond-cycle-table-wrap');
  var el = document.getElementById('bond-cycle-table');
  if (!el) return;
  var history = (data && data.history) || [];
  if (!history.length) { if (wrap) wrap.style.display = 'none'; return; }
  if (wrap) wrap.style.display = 'block';

  // 最近日期在前
  var rows = history.slice().reverse();
  var total = rows.length;
  var totalPages = Math.max(1, Math.ceil(total / BC_TABLE_PAGE_SIZE));
  if (bondCycleTablePage > totalPages) bondCycleTablePage = totalPages;
  if (bondCycleTablePage < 1) bondCycleTablePage = 1;
  var start = (bondCycleTablePage - 1) * BC_TABLE_PAGE_SIZE;
  var pageRows = rows.slice(start, start + BC_TABLE_PAGE_SIZE);

  var cols = [
    { t: '日期', get: function (r) { return esc(String(r.date).slice(0, 10)); } },
    { t: '综合估值', right: true, get: function (r) { return num(r.composite_value, 2); } },
    { t: '周期分位', right: true, get: function (r) { return r.rolling_percentile == null ? '--' : num(r.rolling_percentile, 1) + '%'; } },
    { t: '价格中位数', right: true, get: function (r) { return r.median_price == null ? '--' : num(r.median_price, 2) + ' 元'; } },
    { t: '溢价率中位数', right: true, get: function (r) { return r.median_conversion_premium_pct == null ? '--' : num(r.median_conversion_premium_pct, 2) + ' %'; } },
    { t: '转股价值中位数', right: true, get: function (r) { return r.median_conversion_value == null ? '--' : num(r.median_conversion_value, 2) + ' 元'; } },
    { t: '溢价率权重', right: true, get: function (r) { return r.premium_weight == null ? '--' : pct(r.premium_weight, 1); } },
    { t: '有效转债数', right: true, get: function (r) { return r.bond_count == null ? '--' : r.bond_count; } },
    { t: '数据覆盖率', right: true, get: function (r) { return r.coverage_ratio == null ? '--' : pct(r.coverage_ratio, 1); } }
  ];

  var html = '<table><thead><tr>';
  cols.forEach(function (c) {
    html += '<th' + (c.right ? ' class="text-right"' : '') + '>' + c.t + '</th>';
  });
  html += '</tr></thead><tbody>';
  pageRows.forEach(function (r) {
    html += '<tr>' + cols.map(function (c) {
      return '<td' + (c.right ? ' class="text-right"' : '') + '>' + c.get(r) + '</td>';
    }).join('') + '</tr>';
  });
  html += '</tbody></table>';
  html += '<div class="earnings-pager">' +
    '<button class="btn btn-sm btn-outline" onclick="bcTableToPage(1)"' + (bondCycleTablePage <= 1 ? ' disabled' : '') + '>首页</button>' +
    '<button class="btn btn-sm btn-outline" onclick="bcTableGoPage(-1)"' + (bondCycleTablePage <= 1 ? ' disabled' : '') + '>上一页</button>' +
    '<span class="pager-info">第 ' + bondCycleTablePage + ' / ' + totalPages + ' 页　共 ' + total + ' 条</span>' +
    '<button class="btn btn-sm btn-outline" onclick="bcTableGoPage(1)"' + (bondCycleTablePage >= totalPages ? ' disabled' : '') + '>下一页</button>' +
    '<button class="btn btn-sm btn-outline" onclick="bcTableToPage(' + totalPages + ')"' + (bondCycleTablePage >= totalPages ? ' disabled' : '') + '>尾页</button>' +
    '<span class="pager-jump">跳至 <input type="number" id="bc-table-jump-input" min="1" max="' + totalPages + '" value="' + bondCycleTablePage + '" onkeydown="if(event.key===\'Enter\')bcTableJump()"> 页 ' +
    '<button class="btn btn-sm btn-outline" onclick="bcTableJump()">跳转</button></span>' +
    '</div>';
  el.innerHTML = html;
}

function bcTableGoPage(delta) { bondCycleTablePage += delta; renderBondCycleTable(bondCycleState.data); }
function bcTableToPage(p) { bondCycleTablePage = p; renderBondCycleTable(bondCycleState.data); }
function bcTableJump() {
  var inp = document.getElementById('bc-table-jump-input');
  if (!inp) return;
  var p = parseInt(inp.value, 10);
  if (isNaN(p)) return;
  bondCycleTablePage = p;
  renderBondCycleTable(bondCycleState.data);
}

// 导出可转债周期图为 PNG（含上方指标卡片）
function exportBondCycleChart() {
  try {
    var svg = document.querySelector('#bond-cycle-chart svg');
    if (!svg) { showToast('未找到图表，请先加载可转债周期数据'); return; }
    var svgClone = svg.cloneNode(true);
    // 注入 CSS（SVG 独立成图时会丢失外部样式表）
    var style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = '.bc-grid{stroke:#eee;stroke-width:1}.bc-line{fill:none;stroke-width:1.8}.bc-hit{fill:transparent}';
    svgClone.insertBefore(style, svgClone.firstChild);

    var svgRect = svg.getBoundingClientRect();
    var svgW = Math.round(svgRect.width) || 1100;
    var svgH = Math.round(svgRect.height) || 360;

    // 采集卡片信息
    var cards = [];
    var cardIds = ['bc-cycle-level','bc-percentile','bc-composite','bc-bond-count',
                   'bc-median-price','bc-median-premium','bc-median-value','bc-weight','bc-coverage'];
    for (var i = 0; i < cardIds.length; i++) {
      var el = document.getElementById(cardIds[i]);
      var span = el && el.parentElement && el.parentElement.querySelector('span');
      cards.push({ label: span ? span.textContent : cardIds[i], value: el ? el.textContent : '--' });
    }
    var updatedAt = document.getElementById('bond-cycle-updated');
    var dateStr = updatedAt ? updatedAt.textContent.replace('数据日期：','') : '';
    var rangeEl = document.querySelector('.bond-cycle-range-tabs .active');
    var range = rangeEl ? rangeEl.textContent : '全部';

    // Canvas
    var cardH = 80, gap = 10, titleH = 28, legendH = 24, padX = 16;
    var totalW = svgW + padX * 2;
    var totalH = titleH + cardH + 4 + legendH + 8 + svgH + padX;
    var canvas = document.createElement('canvas');
    canvas.width = totalW * 2; canvas.height = totalH * 2;
    var ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, totalW, totalH);
    ctx.fillStyle = '#172033'; ctx.font = '600 14px sans-serif';
    ctx.fillText('可转债周期 · ' + range + ' · ' + dateStr, padX, 20);

    var cw = Math.floor((totalW - padX * 2 - gap * (cards.length - 1)) / cards.length);
    var cr = 6;
    for (var j = 0; j < cards.length; j++) {
      var cx = padX + j * (cw + gap), cy = titleH, cw2 = cw, ch2 = cardH - 8;
      ctx.fillStyle = '#f7f8fa'; ctx.strokeStyle = '#e7ebf0'; ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx + cr, cy); ctx.lineTo(cx + cw2 - cr, cy); ctx.quadraticCurveTo(cx + cw2, cy, cx + cw2, cy + cr);
      ctx.lineTo(cx + cw2, cy + ch2 - cr); ctx.quadraticCurveTo(cx + cw2, cy + ch2, cx + cw2 - cr, cy + ch2);
      ctx.lineTo(cx + cr, cy + ch2); ctx.quadraticCurveTo(cx, cy + ch2, cx, cy + ch2 - cr);
      ctx.lineTo(cx, cy + cr); ctx.quadraticCurveTo(cx, cy, cx + cr, cy); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8a8f98'; ctx.font = '11px sans-serif';
      ctx.fillText(cards[j].label, cx + 8, cy + 20);
      ctx.fillStyle = '#172033'; ctx.font = '700 18px sans-serif';
      ctx.fillText(cards[j].value, cx + 8, cy + 48);
    }

    // 图例行
    var legendY = titleH + cardH;
    ctx.font = '12px sans-serif'; ctx.textBaseline = 'middle';
    var legends = [];
    for (var k = 0; k < BC_SERIES.length; k++) {
      if (!bondCycleState.visible[BC_SERIES[k].key]) continue;
      legends.push({ name: BC_SERIES[k].name, color: BC_SERIES[k].color });
    }
    var lx = padX;
    for (var m = 0; m < legends.length; m++) {
      var lw = ctx.measureText(legends[m].name).width + 28;
      ctx.strokeStyle = legends[m].color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, legendY + 14); ctx.lineTo(lx + 20, legendY + 14); ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.fillText(legends[m].name, lx + 24, legendY + 14);
      lx += lw + 16;
    }

    // SVG → data URL → Image → Canvas
    var svgTop = legendY + legendH;
    var svgData = '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(svgClone);
    var img = new Image();
    img.onload = function() {
      ctx.drawImage(img, padX, svgTop, svgW, svgH);
      var a = document.createElement('a');
      a.download = '可转债周期_' + dateStr.replace(/\//g, '-').replace(/\s/g, '') + '_' + range + '.png';
      a.href = canvas.toDataURL('image/png');
      a.click();
      showToast('导出完成');
    };
    img.onerror = function() { showToast('导出失败：SVG 渲染异常，请刷新后重试'); };
    img.src = 'data:image/svg+xml,' + encodeURIComponent(svgData);
  } catch (e) {
    console.error('导出失败', e);
    showToast('导出失败：' + (e.message || e));
  }
}
