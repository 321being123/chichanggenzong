// shared/core-earnings.js – 页面切换/版本/收益页数据/历史净值导入（原 core.js 拆分，全局作用域不变）
// ===================== 页面切换 =====================

function initNav() {
  document.querySelectorAll('.nav-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.nav-tab').forEach(function (t) { t.classList.remove('active'); });
      document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
      tab.classList.add('active');
      var pageId = 'page-' + tab.dataset.page;
      var page = document.getElementById(pageId);
      if (page) {
        page.classList.add('active');
        if (tab.dataset.page === 'changelog') loadChangelog();
        // 收益页图表在隐藏 tab 中初始尺寸为 0，切到该 tab 时重绘
        if (tab.dataset.page === 'earnings') renderEarnings();
      }
    });
  });
}

// ===================== 版本记录 =====================

async function loadChangelog() {
  var el = document.getElementById('changelog-content');
  if (!el) return;
  try {
    var resp = await fetch('changelog.json');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    el.innerHTML = renderChangelogHtml(data);
  } catch (err) {
    el.innerHTML = '<p style="color:#c00;text-align:center;">版本记录加载失败：' + (err.message || err) + '</p>';
  }
}

function renderChangelogHtml(data) {
  var css = 'color:#1a73e8;font-size:16px;font-weight:700;margin:18px 0 8px;border-left:3px solid #1a73e8;padding-left:10px;';
  var cssItem = 'margin:4px 0 4px 16px;line-height:1.7;';
  var h = '';
  for (var i = 0; i < data.length; i++) {
    var entry = data[i];
    h += '<h3 style="' + css + '">' + entry.date + '</h3>';
    h += '<ol>';
    for (var j = 0; j < entry.items.length; j++) {
      h += '<li style="' + cssItem + '">' + entry.items[j] + '</li>';
    }
    h += '</ol>';
  }
  return h;
}

// ===================== 收益页（投资实验记录） =====================

let chartEarnings = null;
let chartEarningsReturns = null;

// 导入历史净值 Excel（大模型识别）→ 回填 navHistory 历史段
// ===================== 收益 tab 数据源：真实持仓自动算出的净值序列 =====================

function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysBetweenDates(a, b) {
  const d1 = new Date(a + 'T00:00:00');
  const d2 = new Date(b + 'T00:00:00');
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}
// 返回该日期所属自然周的周一(一周起点)
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0 周日 .. 6 周六
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return ymd(d);
}
// 返回该日期「上一个周五」(YYYY-MM-DD)，作为本周涨跌基准起点
function lastFridayOf(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00');
  const day = dt.getDay(); // 0 周日 .. 6 周六
  let daysToFri = 5 - day;
  if (daysToFri < 0) daysToFri += 7;
  const thisFri = new Date(dt);
  thisFri.setDate(dt.getDate() + daysToFri);
  const lastFri = new Date(thisFri);
  lastFri.setDate(thisFri.getDate() - 7);
  return ymd(lastFri);
}
// Excel 日期归一化 → YYYY-MM-DD
function normalizeDate(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if (v > 20000 && v < 60000) {
      return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    }
    const s = String(v);
    if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    return '';
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return s;
}

// 投入本金计算（统一规则，三处共用）：
// - 优先使用导入数据（navHistory 中存储的 invested）
// - 导入数据最后一列日期之后，投入本金 = 最后导入值 + 该日期之后的累计出入金(入金+, 出金-)
// - 完全没有导入数据时，投入本金 = 期初本金(cashBase) + 截至该日累计出入金
function investedAt(date) {
  const navs = (data.navHistory || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  const cf = (data.cashFlows || []);
  // 最后一条带 invested 的导入记录
  let lastImpDate = null, lastImpInvested = 0;
  navs.forEach(function (n) {
    if (n.invested != null && n.invested !== '') { lastImpDate = n.date; lastImpInvested = Number(n.invested); }
  });
  if (!lastImpDate) {
    let s = Number(data.cashBase) || 0;
    cf.forEach(function (c) { if (c.date <= date) s += (c.amount || 0); });
    return s;
  }
  if (date <= lastImpDate) {
    // 导入覆盖区间内：取 ≤ date 的最后一条导入 invested
    let val = null;
    navs.forEach(function (n) { if (n.invested != null && n.invested !== '' && n.date <= date) val = Number(n.invested); });
    if (val != null) return val;
    let s = Number(data.cashBase) || 0;
    cf.forEach(function (c) { if (c.date <= date) s += (c.amount || 0); });
    return s;
  }
  // 导入数据之后：最后导入值 + 之后新增出入金
  let s = lastImpInvested;
  cf.forEach(function (c) { if (c.date > lastImpDate && c.date <= date) s += (c.amount || 0); });
  return s;
}

// 把真实数据(navHistory + cashFlows + cashBase)转换为收益 tab 渲染器吃的标准行结构
function buildRealReturnsSeries() {
  if (!data.navHistory || data.navHistory.length === 0) return [];
  const navs = data.navHistory.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  const firstDate = navs[0].date;
  const cf = (data.cashFlows || []);

  let peak = -Infinity;
  let maxDD = 0;
  const rows = navs.map(function (n) {
    // invested 优先取 navHistory 存储值（导入数据或 recordNav 写入的累计值），
    // 仅当存储值为 null 时才走 fallback（cashBase + 现金流累加）
    const invested = investedAt(n.date);
    const nav = n.nav;
    const totalAsset = (n.totalAsset != null) ? n.totalAsset : 0;
    const totalReturn = nav - 1;
    const days = daysBetweenDates(firstDate, n.date);
    const annualized = days > 0 ? Math.pow(nav, 365 / days) - 1 : 0;
    if (nav > peak) peak = nav;
    const curDD = (nav - peak) / peak;
    if (curDD < maxDD) maxDD = curDD;
    let nc = 0;
    cf.forEach(function (c) { if (c.date === n.date) nc += (c.amount || 0); });
    return {
      date: n.date,
      totalMarketValue: totalAsset,
      totalInvested: invested,
      nav: nav,
      totalReturn: totalReturn,
      capitalGain: invested > 0 ? (totalAsset - invested) / invested : 0,
      yearReturn: 0,
      annualizedReturn: annualized,
      currentDrawdown: curDD,
      maxDrawdown: maxDD,
      newCapital: nc,
      weekChange: 0
    };
  });

  // 当年收益（每行按其所属年初第一条 nav 计算）
  rows.forEach(function (r) {
    const yStart = rows.find(function (x) { return x.date.slice(0, 4) === r.date.slice(0, 4); });
    r.yearReturn = yStart ? r.nav / yStart.nav - 1 : 0;
  });

  // 本周涨跌：基准 = 相对该记录日期的「上周五收盘净值」
  // 周五收盘刷新后，最新一条即「上周五→本周五」完整周涨跌；
  // 周内(如周二)最新一条即「上周五→今日」本周至今涨跌（盘中刷新即按交易时间算）
  function navAtOrBefore(targetDate) {
    let best = null;
    for (let i = 0; i < navs.length; i++) {
      if (navs[i].date <= targetDate) best = navs[i].nav;
      else break;
    }
    return best;
  }
  rows.forEach(function (r) {
    const lf = lastFridayOf(r.date);
    const base = navAtOrBefore(lf);
    r.weekChange = (base != null && base !== 0) ? (r.nav - base) / base : 0;
  });

  return rows;
}

// ===================== 历史净值 Excel 导入（大模型识别 + 缺省容错 + 冲突弹框） =====================

// 把解析后的记录合并进 navHistory；mode: 'import'=导入覆盖冲突日, 'online'=保留线上
function applyHistoryRecords(parsed, mode) {
  if (!data.navHistory) data.navHistory = [];
  const realStart = (data.navHistory.length ? data.navHistory[0].date : null);
  const realEnd = (data.navHistory.length ? data.navHistory[data.navHistory.length - 1].date : null);
  const beforeRows = parsed.filter(function (p) { return !realStart || p.date < realStart; });
  const conflictRows = parsed.filter(function (p) { return realStart && p.date >= realStart && (!realEnd || p.date <= realEnd); });

  if (realStart) data.navHistory = data.navHistory.filter(function (n) { return n.date >= realStart; });

  function pushRecord(p) {
    data.navHistory.push({
      date: p.date,
      nav: p.nav,
      totalAsset: (p.totalAsset == null ? null : p.totalAsset),
      invested: (p.invested == null ? investedAt(p.date) : p.invested)
    });
  }

  beforeRows.forEach(pushRecord);

  if (mode === 'import') {
    conflictRows.forEach(function (p) {
      const exist = data.navHistory.find(function (n) { return n.date === p.date; });
      if (exist) {
        exist.nav = p.nav;
        if (p.totalAsset != null) exist.totalAsset = p.totalAsset;
        if (p.invested != null) exist.invested = p.invested;
      } else {
        pushRecord(p);
      }
    });
  }
  data.navHistory.sort(function (a, b) { return a.date.localeCompare(b.date); });
}

// 导入后自动重算：以「导入的最后一条」为锚点，其后的净值按链式公式接续计算
// nav_t = nav_{t-1} * 当日总市值 / (前一日总市值 + 当日现金流)  —— 剔除入金影响，与 recordNav 同源
function recalcNavAfterImport(parsed) {
  if (!data.navHistory || data.navHistory.length === 0) return;
  const cf = (data.cashFlows || []);
  let lastImportDate = null;
  (parsed || []).forEach(function (p) { if (!lastImportDate || p.date > lastImportDate) lastImportDate = p.date; });
  if (!lastImportDate) return;
  const sorted = data.navHistory.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  let anchor = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].date <= lastImportDate && sorted[i].nav != null) anchor = sorted[i];
  }
  if (!anchor) return;
  let prevNav = anchor.nav;
  let prevTotal = (anchor.totalAsset != null) ? anchor.totalAsset : 0;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    if (n.date <= anchor.date) continue; // 锚点及之前保持导入值不动
    const cfToday = cf.filter(function (c) { return c.date === n.date; }).reduce(function (s, c) { return s + (c.amount || 0); }, 0);
    const base = prevTotal + cfToday;
    if (base > 0 && n.totalAsset != null) n.nav = prevNav * (n.totalAsset / base);
    prevNav = (n.nav != null) ? n.nav : prevNav;
    prevTotal = (n.totalAsset != null) ? n.totalAsset : prevTotal;
  }
  data.navHistory = sorted;
}

// 冲突确认弹框（返回 Promise：'import' 导入覆盖 / 'online' 线上覆盖）
function showConflictModal() {
  return new Promise(function (resolve) {
    const modal = document.getElementById('modal-conflict');
    if (!modal) { resolve('online'); return; }
    modal.classList.add('show');
    const btnImport = document.getElementById('conflict-import-btn');
    const btnOnline = document.getElementById('conflict-online-btn');
    function cleanup(choice) {
      modal.classList.remove('show');
      if (btnImport) btnImport.onclick = null;
      if (btnOnline) btnOnline.onclick = null;
      resolve(choice);
    }
    if (btnImport) btnImport.onclick = function () { cleanup('import'); };
    if (btnOnline) btnOnline.onclick = function () { cleanup('online'); };
  });
}

// 精确匹配表头：仅当表头"完全等于"已知集合中的某一项（忽略大小写与空格）才自动识别，
// 否则返回 -1，交由用户手动匹配，避免"净值增长率"之类被误判为净值列。
function detectMappingExact(headers) {
  const norm = function (s) { return (s == null ? '' : String(s)).trim().toLowerCase(); };
  const sets = {
    date: ['日期', '时间', '交易日期', '记账日期', '日期时间', '净值日期', 'date'],
    nav: ['净值', '单位净值', '累计净值', '当日净值', '最新净值', '收盘净值', 'nav'],
    total: ['总资产', '总市值', '市值', '资产总额', '资产总值', 'total'],
    invested: ['本金', '投入', '投入本金', '累计投入', '资金', '投入资金', '实缴本金', 'invest']
  };
  const find = function (key) {
    for (let i = 0; i < headers.length; i++) {
      if (sets[key].indexOf(norm(headers[i])) >= 0) return i;
    }
    return -1;
  };
  return { date: find('date'), nav: find('nav'), total: find('total'), invested: find('invested') };
}

async function importFundExcel(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    openImportProgress();
    const base64 = await fileToBase64(file);
    const r = await fetch(api('/api/excel-history-parse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64 })
    });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok || d.error) { showImportError(d.error || ('请求失败：HTTP ' + r.status)); return; }
    if (!d.headers || !d.rows || d.rows.length === 0) { closeImportProgress(); showToast('Excel 中没有可识别的数据行'); return; }

    const auto = detectMappingExact(d.headers);
    if (auto.date >= 0 && auto.nav >= 0) {
      // 精确匹配成功，直接导入
      closeImportProgress();
      await finishImport(d.rows, auto);
    } else {
      // 无法精确匹配 → 弹框让用户手动选列
      closeImportProgress();
      openMappingModal(d.headers, d.rows, auto);
    }
  } catch (e) {
    showImportError('导入失败: ' + (e.message || e));
  } finally {
    event.target.value = '';
  }
}

// 按列映射从数据行提取记录并合并进 navHistory（共享：自动匹配与手动匹配都会走到这）
async function finishImport(rows, mapping) {
  const parsed = [];
  const badRows = [];
  rows.forEach(function (row, i) {
    const date = normalizeDate(row[mapping.date]);
    const navRaw = row[mapping.nav];
    const nav = (navRaw == null || navRaw === '') ? null : Number(navRaw);
    if (!date || nav === null || isNaN(nav)) { badRows.push(i + 1); return; }
    parsed.push({
      date: date,
      nav: nav,
      totalAsset: (mapping.total >= 0 && row[mapping.total] != null && row[mapping.total] !== '') ? Number(row[mapping.total]) : null,
      invested: (mapping.invested >= 0 && row[mapping.invested] != null && row[mapping.invested] !== '') ? Number(row[mapping.invested]) : null
    });
  });
  if (parsed.length === 0) {
    showToast('没有可用数据' + (badRows.length ? ('（' + badRows.length + ' 行因缺日期/净值被跳过）') : ''));
    return;
  }

  // 冲突检测：导入中存在日期落在线上段 [首条, 末条] 内
  const realStart = (data.navHistory && data.navHistory.length) ? data.navHistory[0].date : null;
  const realEnd = (data.navHistory && data.navHistory.length) ? data.navHistory[data.navHistory.length - 1].date : null;
  const hasConflict = realStart && parsed.some(function (p) { return p.date >= realStart && p.date <= realEnd; });
  const choice = hasConflict ? await showConflictModal() : 'online';
  applyHistoryRecords(parsed, choice);
  recalcNavAfterImport(parsed); // 以导入最后一条为锚，其后净值自动接续重算

  saveData();
  renderEarnings();
  let msg = '已导入 ' + parsed.length + ' 条历史净值';
  if (badRows.length) msg += '（' + badRows.length + ' 行因缺日期/净值未导入）';
  showToast(msg);
}

// ===================== 列手动匹配弹框 =====================
let pendingMapping = null;

function openMappingModal(headers, rows, auto) {
  pendingMapping = { headers: headers, rows: rows };
  const fields = [
    { key: 'date', label: '日期列 *', def: auto.date },
    { key: 'nav', label: '净值列 *', def: auto.nav },
    { key: 'total', label: '总市值/总资产列', def: auto.total },
    { key: 'invested', label: '本金/投入列', def: auto.invested }
  ];
  const optsHtml = '<option value="-1">— 请选择 —</option>' +
    headers.map(function (h, i) { return '<option value="' + i + '">' + escapeHtml(h || '(空表头' + (i + 1) + ')') + '</option>'; }).join('');
  const cont = document.getElementById('mapping-fields');
  cont.innerHTML = fields.map(function (f) {
    return '<div style="display:flex;align-items:center;margin-bottom:10px;gap:10px;">' +
      '<label style="width:150px;font-size:13px;color:#333;">' + f.label + '</label>' +
      '<select id="map-' + f.key + '" style="flex:1;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;outline:none;" onchange="renderMappingPreview()">' + optsHtml + '</select>' +
      '</div>';
  }).join('');
  fields.forEach(function (f) {
    const sel = document.getElementById('map-' + f.key);
    if (sel && f.def >= 0) sel.value = String(f.def);
  });
  renderMappingPreview();
  document.getElementById('modal-mapping').classList.add('show');
}

function renderMappingPreview() {
  if (!pendingMapping) return;
  const map = {
    date: parseInt(document.getElementById('map-date').value, 10),
    nav: parseInt(document.getElementById('map-nav').value, 10),
    total: parseInt(document.getElementById('map-total').value, 10),
    invested: parseInt(document.getElementById('map-invested').value, 10)
  };
  const rows = pendingMapping.rows.slice(0, 5);
  let html = '<table style="width:100%;font-size:12px;border-collapse:collapse;"><thead><tr style="background:#f7f7f9;color:#666;">' +
    '<th style="padding:6px;text-align:left;">日期</th><th style="padding:6px;text-align:left;">净值</th><th style="padding:6px;text-align:left;">总市值</th><th style="padding:6px;text-align:left;">本金</th></tr></thead><tbody>';
  rows.forEach(function (row) {
    html += '<tr>' +
      '<td style="padding:6px;border-top:1px solid #f0f0f0;">' + escapeHtml(map.date >= 0 ? row[map.date] : '') + '</td>' +
      '<td style="padding:6px;border-top:1px solid #f0f0f0;">' + escapeHtml(map.nav >= 0 ? row[map.nav] : '') + '</td>' +
      '<td style="padding:6px;border-top:1px solid #f0f0f0;">' + escapeHtml(map.total >= 0 ? row[map.total] : '') + '</td>' +
      '<td style="padding:6px;border-top:1px solid #f0f0f0;">' + escapeHtml(map.invested >= 0 ? row[map.invested] : '') + '</td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('mapping-preview').innerHTML = html;
}

function confirmMapping() {
  const map = {
    date: parseInt(document.getElementById('map-date').value, 10),
    nav: parseInt(document.getElementById('map-nav').value, 10),
    total: parseInt(document.getElementById('map-total').value, 10),
    invested: parseInt(document.getElementById('map-invested').value, 10)
  };
  if (map.date < 0 || map.nav < 0) { showToast('请先选择「日期列」和「净值列」'); return; }
  const pm = pendingMapping;
  closeMappingModal();
  finishImport(pm.rows, map);
}

function closeMappingModal() {
  const m = document.getElementById('modal-mapping');
  if (m) m.classList.remove('show');
  pendingMapping = null;
}

function openImportProgress() {
  const ov = document.getElementById('modal-import-progress');
  if (!ov) return;
  document.getElementById('import-progress-body').style.display = '';
  document.getElementById('import-error-body').style.display = 'none';
  if (document.getElementById('import-spinner')) document.getElementById('import-spinner').style.display = '';
  document.getElementById('import-close-btn').style.display = 'none';
  document.getElementById('import-copy-btn').style.display = 'none';
  document.getElementById('import-progress-fill').style.width = '0%';
  document.getElementById('import-progress-text').textContent = '正在解析 Excel...';
  document.getElementById('import-progress-sub').textContent = '';
  ov.classList.add('show');
}
function closeImportProgress() {
  const ov = document.getElementById('modal-import-progress');
  if (ov) ov.classList.remove('show');
}
function updateImportProgress(batch, total, text) {
  const fill = document.getElementById('import-progress-fill');
  const txt = document.getElementById('import-progress-text');
  const sub = document.getElementById('import-progress-sub');
  if (fill) fill.style.width = (total ? Math.round(batch / total * 100) : 0) + '%';
  if (txt) txt.textContent = text;
  if (sub) sub.textContent = '已解析 ' + batch + ' / ' + total + ' 批';
}
function showImportError(message) {
  const ov = document.getElementById('modal-import-progress');
  if (!ov) { showToast('导入失败: ' + message); return; }
  const body = document.getElementById('import-progress-body');
  const errBody = document.getElementById('import-error-body');
  const errTxt = document.getElementById('import-error-text');
  if (body) body.style.display = 'none';
  if (errBody) errBody.style.display = '';
  if (errTxt) errTxt.textContent = message;
  if (document.getElementById('import-spinner')) document.getElementById('import-spinner').style.display = 'none';
  document.getElementById('import-close-btn').style.display = '';
  document.getElementById('import-copy-btn').style.display = '';
  ov.classList.add('show');
}
function copyImportError() {
  const txt = document.getElementById('import-error-text');
  if (!txt) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt.textContent).then(function () { showToast('错误已复制，可发给我定位'); }, function () { showToast('复制失败，请手动选择文本复制'); });
  } else {
    showToast('当前环境不支持自动复制，请手动选择');
  }
}
