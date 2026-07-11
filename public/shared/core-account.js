// shared/core-account.js – 收益页渲染/全量渲染/自动刷新/账户管理（原 core.js 拆分，全局作用域不变）
// ===================== 历史净值记录 新增/编辑/删除（与持仓一致） =====================
let navEditIndex = -1;   // -1 表示新增；否则为 data.navHistory 中的索引

function openNavEdit(date) {
  const t = document.getElementById('nav-edit-title');
  const d = document.getElementById('nav-edit-date');
  const v = document.getElementById('nav-edit-nav');
  const tt = document.getElementById('nav-edit-total');
  const iv = document.getElementById('nav-edit-invested');
  let rec = null;
  if (date != null && data.navHistory) rec = data.navHistory.find(function (n) { return n.date === date; });
  if (rec) {
    navEditIndex = data.navHistory.indexOf(rec);
    if (t) t.textContent = '编辑净值记录';
    if (d) d.value = rec.date || '';
    if (v) v.value = (rec.nav != null ? rec.nav : '');
    if (tt) tt.value = (rec.totalAsset != null ? rec.totalAsset : '');
    if (iv) iv.value = (rec.invested != null ? rec.invested : '');
  } else {
    navEditIndex = -1;
    if (t) t.textContent = '新增净值记录';
    if (d) d.value = ''; if (v) v.value = ''; if (tt) tt.value = ''; if (iv) iv.value = '';
  }
  document.getElementById('modal-nav-edit').classList.add('show');
}

function saveNavEdit() {
  const date = normalizeDate(document.getElementById('nav-edit-date').value);
  const navRaw = document.getElementById('nav-edit-nav').value;
  const totalRaw = document.getElementById('nav-edit-total').value;
  const invRaw = document.getElementById('nav-edit-invested').value;
  if (!date) { showToast('请填写有效的日期（YYYY-MM-DD）'); return; }
  const nav = parseFloat(navRaw);
  if (isNaN(nav)) { showToast('请填写有效的净值'); return; }
  const rec = {
    date: date,
    nav: nav,
    totalAsset: (totalRaw === '' || totalRaw == null) ? null : parseFloat(totalRaw),
    invested: (invRaw === '' || invRaw == null) ? null : parseFloat(invRaw)
  };
  if (!data.navHistory) data.navHistory = [];
  if (navEditIndex >= 0 && data.navHistory[navEditIndex]) {
    const target = data.navHistory[navEditIndex];
    target.date = rec.date; target.nav = rec.nav; target.totalAsset = rec.totalAsset; target.invested = rec.invested;
  } else {
    const exist = data.navHistory.find(function (n) { return n.date === rec.date; });
    if (exist) { exist.nav = rec.nav; exist.totalAsset = rec.totalAsset; exist.invested = rec.invested; }
    else data.navHistory.push(rec);
  }
  data.navHistory.sort(function (a, b) { return a.date.localeCompare(b.date); });
  saveData();
  renderEarnings();
  closeModal('modal-nav-edit');
  showToast('已保存');
}

function deleteNav(date) {
  if (!data.navHistory) return;
  if (!confirm('确定删除 ' + (date || '') + ' 这条净值记录？')) return;
  data.navHistory = data.navHistory.filter(function (n) { return n.date !== date; });
  data.navHistory.sort(function (a, b) { return a.date.localeCompare(b.date); });
  saveData();
  renderEarnings();
  showToast('已删除');
}

let earningsSorted = [];
let earningsPage = 1;
const EARNINGS_PAGE_SIZE = 20;

function renderEarnings() {
  const el = document.getElementById('earnings-stats');
  if (!el) return;
  const records = buildRealReturnsSeries();
  if (records.length === 0) {
    el.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="icon">📊</div><p>暂无收益记录，请先在「总览」刷新一次行情以生成净值</p></div>';
    const tbl = document.getElementById('earnings-table');
    if (tbl) tbl.innerHTML = '';
    if (chartEarnings) { chartEarnings.destroy(); chartEarnings = null; }
    return;
  }

  // 按日期升序
  const sorted = records.slice().sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
  const last = sorted[sorted.length - 1];

  const pct = function (v) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%'; };
  const col = function (v) { return v >= 0 ? '#137333' : '#d93025'; };

  const cards = [
    { label: '当前总市值', value: fmt(last.totalMarketValue || 0), sub: '投入本金 ' + fmt(last.totalInvested || 0) },
    { label: '当前净值', value: (last.nav || 1).toFixed(4), sub: '基准 1.0000', color: col((last.nav || 1) - 1) },
    { label: '总收益率', value: pct(last.totalReturn || 0), sub: '资金总收益 ' + pct(last.capitalGain || 0), color: col(last.totalReturn || 0) },
    { label: '年化收益', value: pct(last.annualizedReturn || 0), sub: '当年收益 ' + pct(last.yearReturn || 0), color: col(last.annualizedReturn || 0) },
    { label: '当前回撤', value: (last.currentDrawdown != null ? (last.currentDrawdown * 100).toFixed(2) : '0.00') + '%', sub: '当日', color: '#d93025' },
    { label: '最大回撤', value: (last.maxDrawdown != null ? (last.maxDrawdown * 100).toFixed(2) : '0.00') + '%', sub: '历史', color: '#d93025' }
  ];
  el.innerHTML = cards.map(function (c) {
    return '<div class="stat-card"><div class="stat-top"><div><div class="label">' + c.label + '</div>' +
      '<div class="value" style="color:' + (c.color || '#1a1a2e') + '">' + c.value + '</div></div></div>' +
      '<div class="sub">' + (c.sub || '') + '</div></div>';
  }).join('');

  earningsPage = 1;
  renderEarningsReturnsChart();
  renderEarningsChart(sorted);
  renderEarningsTable(sorted);
}

function renderEarningsChart(sorted) {
  const ctx = document.getElementById('chart-earnings');
  if (!ctx) return;
  const labels = sorted.map(function (r) { return (r.date || ''); });
  const mv = sorted.map(function (r) { return r.totalMarketValue || 0; });
  const inv = sorted.map(function (r) { return r.totalInvested || 0; });
  if (chartEarnings) chartEarnings.destroy();
  chartEarnings = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: '总市值', data: mv, borderColor: '#1a237e', backgroundColor: 'rgba(26,35,126,.08)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2.5 },
        { label: '投入本金', data: inv, borderColor: '#d93025', backgroundColor: 'transparent', borderDash: [5, 3], tension: 0.3, pointRadius: 0, borderWidth: 1.5 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { padding: 16, font: { size: 12, weight: '500' }, usePointStyle: true } },
        tooltip: {
          backgroundColor: '#323232', cornerRadius: 8, padding: 12,
          callbacks: { label: function (c) { return ' ' + c.dataset.label + ': ' + fmt(c.raw); } }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 12, font: { size: 11 }, color: '#999' } },
        y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 }, color: '#999', callback: function (v) { return '¥' + (v / 10000).toFixed(0) + '万'; } } }
      }
    }
  });
}

// 找首个“净值与指数快照都有”的日期作为对比基准
// （指数历史数据通常晚于净值起始，此前无指数可对比，按用户要求该时间段不画指数线）
function findComparisonStart(navData) {
  if (!data.indexHistory || !data.indexHistory.length) return null;
  for (var i = 0; i < navData.length; i++) {
    var has = data.indexHistory.some(function (h) {
      return h.date === navData[i].date &&
        (h['沪深300'] != null || h['上证指数'] != null || h['中证500'] != null || h['恒生指数'] != null);
    });
    if (has) return navData[i].date;
  }
  return null;
}

// 用本地指数快照构造序列：以“首个有该指数的净值日期”为对齐基准，
// 使指数在首个可比日的值 = 当日净值（已归一到1.0系）的值，实现“起点一致”对比
function getEarnIndex(name, navData) {
  if (!data.indexHistory || !data.indexHistory.length) return null;
  var map = {};
  data.indexHistory.forEach(function (h) { if (h[name] != null) map[h.date] = h[name]; });
  var navBase = Number(navData[0].nav) || 1; // 净值归一基准（首日）
  var baseDate = null, navAtBase = null;
  for (var i = 0; i < navData.length; i++) {
    if (map[navData[i].date] != null) {
      baseDate = navData[i].date;
      navAtBase = Number(navData[i].nav) / navBase; // 该日净值在“1.0系”中的值
      break;
    }
  }
  if (!baseDate) return null;
  var firstClose = map[baseDate];
  return navData
    .filter(function (d) { return map[d.date] != null; })
    .map(function (d) { return { date: d.date, val: (map[d.date] / firstClose) * navAtBase }; });
}

// 实时拉取兜底归一化：同样以“首个有数据的净值日期”为对齐基准，使指数起点 = 当日净值
function normalizeIndexFrom(indexData, navData, base) {
  if (!indexData || !indexData.length || !navData.length) return [];
  var map = {};
  indexData.forEach(function (d) { map[d.date] = d.close; });
  var navBase = Number(navData[0].nav) || 1;
  var baseDate = (base && map[base] != null) ? base : null;
  if (!baseDate) {
    for (var i = 0; i < navData.length; i++) { if (map[navData[i].date] != null) { baseDate = navData[i].date; break; } }
  }
  if (!baseDate) return [];
  var firstClose = map[baseDate];
  var navAtBase = null;
  for (var j = 0; j < navData.length; j++) { if (navData[j].date === baseDate) { navAtBase = Number(navData[j].nav) / navBase; break; } }
  if (navAtBase == null) navAtBase = 1;
  var dateSet = {};
  navData.forEach(function (d) { dateSet[d.date] = true; });
  return indexData
    .filter(function (d) { return dateSet[d.date]; })
    .map(function (d) { return { date: d.date, val: (d.close / firstClose) * navAtBase }; });
}

// 周频采样：生成 [start, end] 内所有每周五(UTC 周五=5)的 ISO 日期
function weeklyFridayLabels(startStr, endStr) {
  const labels = [];
  const d = new Date(startStr + 'T00:00:00Z');
  const diff = (5 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  const end = new Date(endStr + 'T00:00:00Z');
  while (d <= end) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    labels.push(y + '-' + m + '-' + dd);
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return labels;
}

// 对每个周五取“该日或之前最近一个交易日”的收盘，返回与 fridays 对齐的收盘价数组
function fridayCarryForward(sortedEntries, fridays) {
  const res = [];
  let p = 0;
  const n = sortedEntries.length;
  fridays.forEach(function (fri) {
    while (p < n && sortedEntries[p].date <= fri) p++;
    res.push(p > 0 ? sortedEntries[p - 1].close : null);
  });
  return res;
}

async function renderEarningsReturnsChart() {
  const ctx = document.getElementById('chart-earnings-returns');
  if (!ctx) return;
  if (!data.navHistory || data.navHistory.length < 2) {
    if (chartEarningsReturns) { chartEarningsReturns.destroy(); chartEarningsReturns = null; }
    return;
  }
  const navData = data.navHistory.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  const cmp = findComparisonStart(navData);

  // ---------- 周频采样：只取每周五收盘，绘制真实周频台阶 ----------
  // 范围起点 = 对比基准日(或净值首日)，终点 = 净值与指数数据的最晚日期
  const lastNavDate = navData[navData.length - 1].date;
  let lastIdxDate = lastNavDate;
  if (data.indexHistory && data.indexHistory.length) {
    data.indexHistory.forEach(function (h) { if (h.date > lastIdxDate) lastIdxDate = h.date; });
  }
  const rangeStart = cmp || navData[0].date;
  const labels = weeklyFridayLabels(rangeStart, lastIdxDate);
  if (!labels.length) {
    if (chartEarningsReturns) { chartEarningsReturns.destroy(); chartEarningsReturns = null; }
    return;
  }

  // 净值周频：每个周五取“周五或之前最近一次净值”作为该周五收盘净值
  const navFridayVals = labels.map(function (fri) {
    let v = null;
    for (let i = navData.length - 1; i >= 0; i--) {
      if (navData[i].date <= fri) { v = Number(navData[i].nav); break; }
    }
    return v == null ? null : +(v.toFixed(4));
  });
  // 归一：首个有净值的周五 = 1.0
  let navBase = 1;
  for (let i = 0; i < navFridayVals.length; i++) { if (navFridayVals[i] != null) { navBase = navFridayVals[i]; break; } }
  const navVals = navFridayVals.map(function (v) { return v == null ? null : +(v / navBase).toFixed(4); });

  // 指数周频：每个周五取收盘(或之前最近交易日)，按各自首个可比周五对齐当日净值
  // 预构建每个指数的有序 [{date, close}]
  const idxEntries = {};
  ['沪深300', '上证指数', '中证500', '恒生指数'].forEach(function (name) {
    const arr = [];
    data.indexHistory.forEach(function (h) { if (h[name] != null) arr.push({ date: h.date, close: h[name] }); });
    arr.sort(function (a, b) { return a.date.localeCompare(b.date); });
    idxEntries[name] = arr;
  });

  const datasets = [{
    label: '持仓净值', data: navVals, borderColor: '#1a237e',
    backgroundColor: 'rgba(26,35,126,.08)', fill: true,
    tension: 0.3, pointRadius: 0, borderWidth: 2.5, spanGaps: true
  }];
  function pushIndex(label, color, name) {
    const entries = idxEntries[name];
    if (!entries || !entries.length) return;
    const closes = fridayCarryForward(entries, labels);
    // 对齐基准：首个“既有净值又有指数收盘”的周五，使指数起点 = 当日净值
    let baseIdx = -1, navAtBase = null, firstClose = null;
    for (let i = 0; i < labels.length; i++) {
      if (navVals[i] != null && closes[i] != null) { baseIdx = i; navAtBase = navVals[i]; firstClose = closes[i]; break; }
    }
    if (baseIdx < 0) return;
    const vals = labels.map(function (fri, i) {
      return closes[i] != null ? +((closes[i] / firstClose) * navAtBase).toFixed(4) : null;
    });
    datasets.push({ label: label, data: vals, borderColor: color, backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 1.5, spanGaps: true });
  }
  pushIndex('沪深300', '#d93025', '沪深300');
  pushIndex('上证指数', '#e37400', '上证指数');
  pushIndex('中证全指', '#7b1fa2', '中证500');
  pushIndex('恒生指数', '#00838f', '恒生指数');

  if (chartEarningsReturns) chartEarningsReturns.destroy();
  chartEarningsReturns = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { padding: 16, font: { size: 12, weight: '500' }, usePointStyle: true } },
        tooltip: {
          backgroundColor: '#323232', cornerRadius: 8, padding: 12,
          callbacks: { label: function (c) {
            if (c.raw == null) return '';
            var ds = c.dataset;
            var first = null;
            for (var k = 0; k < ds.data.length; k++) { if (ds.data[k] != null) { first = ds.data[k]; break; } }
            if (first == null || first === 0) return ' ' + ds.label + ': ' + c.raw.toFixed(2);
            var pct = ((c.raw / first - 1) * 100).toFixed(2);
            var prefix = parseFloat(pct) >= 0 ? '+' : '';
            return ' ' + ds.label + ': ' + c.raw.toFixed(2) + ' (' + prefix + pct + '%)';
          } }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 12, font: { size: 11 }, color: '#999' } },
        y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 }, color: '#999', callback: function (v) {
          var pct = (v - 1) * 100; return pct >= 0 ? '+' + pct.toFixed(1) + '%' : pct.toFixed(1) + '%';
        } } }
      }
    }
  });
}

function renderEarningsTable(sorted) {
  const el = document.getElementById('earnings-table');
  if (!el) return;
  earningsSorted = sorted;
  const wan = function (v) { return (Number(v || 0) / 10000).toFixed(2) + '万'; };
  const cols = [
    { t: '日期', get: function (r) { return r.date || '-'; } },
    { t: '总市值(万元)', get: function (r) { return wan(r.totalMarketValue); } },
    { t: '投入本金(万元)', get: function (r) { return wan(r.totalInvested); } },
    { t: '净值', get: function (r) { return (r.nav || 1).toFixed(4); } },
    { t: '总收益率', right: true, color: function (r) { return (r.totalReturn || 0) >= 0 ? '#137333' : '#d93025'; }, get: function (r) { return ((r.totalReturn || 0) >= 0 ? '+' : '') + ((r.totalReturn || 0) * 100).toFixed(2) + '%'; } },
    { t: '本周涨跌', right: true, color: function (r) { return (r.weekChange || 0) >= 0 ? '#137333' : '#d93025'; }, get: function (r) { return ((r.weekChange || 0) >= 0 ? '+' : '') + ((r.weekChange || 0) * 100).toFixed(2) + '%'; } },
    { t: '年化', right: true, color: function (r) { return (r.annualizedReturn || 0) >= 0 ? '#137333' : '#d93025'; }, get: function (r) { return ((r.annualizedReturn || 0) >= 0 ? '+' : '') + ((r.annualizedReturn || 0) * 100).toFixed(2) + '%'; } },
    { t: '当前回撤', right: true, color: function () { return '#d93025'; }, get: function (r) { return ((r.currentDrawdown || 0) * 100).toFixed(2) + '%'; } },
    { t: '最大回撤', right: true, color: function () { return '#d93025'; }, get: function (r) { return ((r.maxDrawdown || 0) * 100).toFixed(2) + '%'; } },
    { t: '操作', center: true, get: function (r) {
        return '<button class="btn btn-outline btn-sm" onclick="openNavEdit(\'' + r.date + '\')">编辑</button> ' +
               '<button class="btn btn-danger btn-sm" onclick="deleteNav(\'' + r.date + '\')">删除</button>';
      } }
  ];
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / EARNINGS_PAGE_SIZE));
  if (earningsPage > totalPages) earningsPage = totalPages;
  if (earningsPage < 1) earningsPage = 1;
  const reversed = sorted.slice().reverse();
  const start = (earningsPage - 1) * EARNINGS_PAGE_SIZE;
  const pageRows = reversed.slice(start, start + EARNINGS_PAGE_SIZE);
  let html = '<table><thead><tr>';
  cols.forEach(function (c) {
    const cls = c.right ? ' class="text-right"' : (c.center ? ' class="text-center"' : '');
    html += '<th' + cls + '>' + c.t + '</th>';
  });
  html += '</tr></thead><tbody>';
  pageRows.forEach(function (r) {
    html += '<tr>' + cols.map(function (c) {
      if (c.right) {
        return '<td class="text-right" style="font-weight:600;color:' + (c.color ? c.color(r) : '#1a1a2e') + '">' + c.get(r) + '</td>';
      }
      if (c.center) {
        return '<td class="text-center">' + c.get(r) + '</td>';
      }
      return '<td>' + c.get(r) + '</td>';
    }).join('') + '</tr>';
  });
  html += '</tbody></table>';
  html += '<div class="earnings-pager">' +
    '<button class="btn btn-sm btn-outline" onclick="earningsToPage(1)"' + (earningsPage <= 1 ? ' disabled' : '') + '>首页</button>' +
    '<button class="btn btn-sm btn-outline" onclick="earningsGoPage(-1)"' + (earningsPage <= 1 ? ' disabled' : '') + '>上一页</button>' +
    '<span class="pager-info">第 ' + earningsPage + ' / ' + totalPages + ' 页　共 ' + total + ' 条</span>' +
    '<button class="btn btn-sm btn-outline" onclick="earningsGoPage(1)"' + (earningsPage >= totalPages ? ' disabled' : '') + '>下一页</button>' +
    '<button class="btn btn-sm btn-outline" onclick="earningsToPage(' + totalPages + ')"' + (earningsPage >= totalPages ? ' disabled' : '') + '>尾页</button>' +
    '<span class="pager-jump">跳至 <input type="number" id="earnings-jump-input" min="1" max="' + totalPages + '" value="' + earningsPage + '" onkeydown="if(event.key===\'Enter\')earningsJump()"> 页 ' +
    '<button class="btn btn-sm btn-outline" onclick="earningsJump()">跳转</button></span>' +
    '</div>';
  el.innerHTML = html;
}

function earningsGoPage(delta) {
  earningsPage += delta;
  renderEarningsTable(earningsSorted);
}

function earningsToPage(page) {
  earningsPage = page;
  renderEarningsTable(earningsSorted);
}

function earningsJump() {
  const inp = document.getElementById('earnings-jump-input');
  if (!inp) return;
  const p = parseInt(inp.value, 10);
  if (isNaN(p)) return;
  earningsPage = p;
  renderEarningsTable(earningsSorted);
}

// ===================== 全量渲染 =====================

function renderAll() {
  try { renderStats(); } catch(e) {}
  try { renderCharts(); } catch(e) {}
  try { renderPositionsTable('topn-table'); } catch(e) {}
  try { renderPositionsTable('positions-table'); } catch(e) {}
  try { renderTrades(); } catch(e) {}
  try { renderReturnsStats(); } catch(e) {}
  try { renderEarnings(); } catch(e) {}
}

// ===================== 自动刷新 =====================

var _autoRefreshTimer = null;

function initAutoRefresh() {
  if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
  // 每 15 分钟自动刷新行情（收盘后且有价格则跳过，实时查看请手动刷新）
  _autoRefreshTimer = setInterval(function () {
    if (data && data.positions && data.positions.length > 0) {
      // 收盘后且已有报价 → 不再自动刷新
      if (!isMarketOpen()) {
        var hasAnyPrice = data.positions.some(function(p) { return p.price > 0; });
        if (hasAnyPrice) return;
      }
      doRefresh();
    }
  }, 900000);
}

// ===================== 账户管理 =====================

/**
 * 账户选择下拉框渲染
 * 依赖全局 accounts 数组（由各 HTML 定义）
 */
function renderAccountSelect() {
  const sel = document.getElementById('account-select');
  if (!sel) return;
  sel.innerHTML = accounts.map(function (a) {
    return '<option value="' + escapeHtml(a) + '"' +
      (a === currentAccount ? ' selected' : '') + '>' + escapeHtml(a) + '</option>';
  }).join('');
}

async function switchAccount(name) {
  if (name === currentAccount) return;
  currentAccount = name;
  priceChangeMap = {};
  data = await loadData(currentAccount);
  // loadData() 已从 data.changes 和持仓 price 恢复 priceChangeMap
  renderAccountSelect();
  renderAll();
  if (data.positions.length > 0) doRefresh();
  showToast('已切换到「' + currentAccount + '」');
}

let accountIsNew = false;
let accountActionTarget = null;

function addAccount() {
  accountIsNew = true;
  accountActionTarget = null;
  var input = document.getElementById('account-name-input');
  if (input) input.value = '';
  var modal = document.getElementById('modal-account');
  if (modal) modal.classList.add('show');
  if (input) input.focus();
}

function showAccountMenu() {
  accountIsNew = false;
  accountActionTarget = null;
  var input = document.getElementById('account-name-input');
  if (input) input.value = currentAccount;
  
  // 渲染账户列表，每个账户都显示操作按钮
  var listEl = document.getElementById('account-list');
  if (listEl) {
    listEl.innerHTML = accounts.map(function(a) {
      var isCurrent = a === currentAccount;
      var canDelete = accounts.length > 1;
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #eee;">' +
        '<div>' +
          '<span style="font-weight:600;font-size:14px;">' + escapeHtml(a) + '</span>' +
          (isCurrent ? ' <span style="display:inline-block;padding:1px 8px;border-radius:3px;background:#e8f0fe;color:#1a73e8;font-size:11px;font-weight:500;">当前</span>' : '') +
        '</div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button class="btn btn-outline btn-sm" onclick="editAccount(\'' + escapeHtml(a) + '\')" style="font-size:11px;">✏️ 修改名称</button>' +
          (canDelete
            ? '<button class="btn btn-danger btn-sm" onclick="promptDeleteAccount(\'' + escapeHtml(a) + '\')" style="font-size:11px;">🗑 删除</button>'
            : '') +
        '</div>' +
      '</div>';
    }).join('') || '<div style="color:#999;padding:12px 0;text-align:center;">暂无账户</div>';
  }
  
  var modal = document.getElementById('modal-account');
  if (modal) modal.classList.add('show');
  if (input) input.focus();
}

function editAccount(name) {
  accountIsNew = false;
  accountActionTarget = name;
  var input = document.getElementById('account-name-input');
  if (input) { input.value = name; input.focus(); input.select(); }
}

function promptDeleteAccount(name) {
  accountActionTarget = name;
  closeModal('modal-account'); // 先关管理弹框，避免确认框被挡在后面

  document.getElementById('delete-msg').textContent = '确定删除账户「' + name + '」及其所有持仓数据？此操作不可恢复！';
  document.getElementById('delete-confirm-btn').onclick = confirmDeleteAccount;

  // 取消按钮临时改为：关闭确认框后重新打开管理弹框
  var cancelBtn = document.querySelector('#modal-delete .btn-outline');
  cancelBtn.onclick = function cancelDel() {
    this.onclick = null; // 清理临时绑定，恢复 HTML 属性的 onClick
    closeModal('modal-delete');
    showAccountMenu();
  };

  document.getElementById('modal-delete').classList.add('show');
}

async function confirmDeleteAccount() {
  // 清理取消按钮的临时绑定
  var cancelBtn = document.querySelector('#modal-delete .btn-outline');
  if (cancelBtn) cancelBtn.onclick = null;

  var name = accountActionTarget;
  if (!name) { closeModal('modal-delete'); return; }
  if (accounts.length <= 1) { showToast('至少保留一个账户'); closeModal('modal-delete'); return; }
  
  closeModal('modal-delete');
  
  accounts = accounts.filter(function(a) { return a !== name; });
  saveAccounts();
  
  if (name === currentAccount) {
    currentAccount = accounts[0];
  }
  priceChangeMap = {};
  data = await loadData(currentAccount);
  // loadData() 已恢复 priceChangeMap
  renderAccountSelect();
  renderAll();
  showToast('已删除账户「' + name + '」');
}

async function saveAccountName() {
  const n = document.getElementById('account-name-input').value.trim();
  if (!n) { showToast('名称不能为空'); return; }

  if (accountIsNew) {
    if (accounts.includes(n)) { showToast('该账户已存在'); return; }
    accounts.push(n);
    saveAccounts();
    currentAccount = n;
    data = await loadData(currentAccount);
    priceChangeMap = {};
    renderAccountSelect();
    renderAll();
    closeModal('modal-account');
    showToast('已创建账户「' + n + '」');
    return;
  }

  const targetName = accountActionTarget || currentAccount;
  if (n === targetName) { closeModal('modal-account'); return; }
  if (accounts.includes(n)) { showToast('该名称已被使用'); return; }

  // 重命名任何账户：从旧名加载数据，保存到新名
  var wasCurrent = targetName === currentAccount;
  var oldIdx = accounts.indexOf(targetName);
  if (oldIdx === -1) { showToast('找不到该账户'); return; }
  
  var oldData = null;
  try {
    var resp = await fetch(api('/api/data/' + encodeURIComponent(targetName)));
    if (resp.ok) oldData = await resp.json();
  } catch(e) {}
  if (!oldData) oldData = { positions: [], trades: [], cash: 0, navHistory: [], cashFlows: [] };

  accounts[oldIdx] = n;
  if (wasCurrent) currentAccount = n;
  saveAccounts();

  // 保存到新名称下
  await fetch(api('/api/data/' + encodeURIComponent(n)), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(oldData)
  });

  renderAccountSelect();
  if (wasCurrent) {
    data = oldData;
    renderAll();
  }
  closeModal('modal-account');
  showToast('已重命名为「' + n + '」');
}
