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
        // 交易页：初始化日期时间为当前
        if (tab.dataset.page === 'trades' && typeof initTradeDateTime === 'function') initTradeDateTime();
        // 总览页：切回时重绘收益走势对比图（导入新数据后切回能立即显示，无需再点周期切换）
        if (tab.dataset.page === 'dashboard' && typeof renderReturnsChart === 'function') renderReturnsChart();
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
  var dateCss = 'color:#1a73e8;font-size:16px;font-weight:700;margin:18px 0 8px;border-left:3px solid #1a73e8;padding-left:10px;';
  var itemCss = 'margin:4px 0 4px 16px;line-height:1.7;';
  var catRe = /^(新增|优化|修复)[:：]/;
  function catOf(s) { var m = catRe.exec(s); return m ? m[1] : '优化'; }
  function stripCat(s) { while (catRe.test(s)) s = s.replace(catRe, ''); return s; } // 去掉前缀，避免重复
  // 按日期合并同一天的多个版本
  var byDate = [];
  var map = {};
  for (var i = 0; i < data.length; i++) {
    var entry = data[i];
    if (!map[entry.date]) { map[entry.date] = { date: entry.date, items: [] }; byDate.push(map[entry.date]); }
    for (var j = 0; j < entry.items.length; j++) map[entry.date].items.push(entry.items[j]);
  }
  // 三类顺序：新增 → 优化 → 修复
  var order = ['新增', '优化', '修复'];
  var h = '';
  for (var g = 0; g < byDate.length; g++) {
    var day = byDate[g];
    h += '<h3 style="' + dateCss + '">' + day.date + '</h3>';
    var ordered = [];
    for (var o = 0; o < order.length; o++) {
      for (var k = 0; k < day.items.length; k++) {
        if (catOf(day.items[k]) === order[o]) ordered.push(day.items[k]);
      }
    }
    for (var n = 0; n < ordered.length; n++) {
      var it = ordered[n];
      var cat = catOf(it);
      var content = stripCat(it); // 去掉前缀后由下方统一加回，杜绝「新增：新增：」这类重复
      h += '<div style="' + itemCss + '">' + cat + '：' + content + '</div>';
    }
  }
  return h;
}

// ===================== 收益页（投资实验记录） =====================

let chartEarnings = null;

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
// 周一~周五：基准 = 上周五（本周至今涨跌）；周六/周日：基准也回退到上周五，
// 使周末显示「本周五收盘 vs 上周五」的整周涨跌（按用户要求周六周日沿用周五收盘价）
function lastFridayOf(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00');
  const day = dt.getDay(); // 0 周日 .. 6 周六
  let d = 5 - day;
  if (d < 0) d += 7;
  const thisFri = new Date(dt);
  thisFri.setDate(dt.getDate() + d); // 本周五（或周六周日所在周的下周五）
  if (day === 0 || day === 6) {
    thisFri.setDate(thisFri.getDate() - 14); // 周末：下周五 → 上周五
  } else {
    thisFri.setDate(thisFri.getDate() - 7); // 工作日：本周五 → 上周五
  }
  return ymd(thisFri);
}
// Excel 日期归一化 → YYYY-MM-DD
// 兼容 SheetJS 可能返回的所有形态：
//   1. Date 对象（cellDates:true 时）  2. 数字序列号（Excel serial）
//   3. 标准格式 YYYY-MM-DD           4. 紧凑数字 YYYYMMDD
//   5. 斜杠分隔 2024/01/15 / 2024/1/5
//   6. 点分隔   2024.01.15
//   7. 中文     2024年1月15日
//   8. 自定义格式文本 +046207-12 等（SheetJS 未解析时返回的显示文本）
function normalizeDate(v) {
  if (v == null || v === '') return '';
  // ── 已是 Date 对象（cellDates: true 时 SheetJS 直接返回）──
  if (v instanceof Date) return v.toISOString().slice(0, 10);

  var s = String(v).trim();
  if (s === '') return '';

  // ── 数字类型（含 Excel 序列号）──
  if (typeof v === 'number' || /^\d+$/.test(s)) {
    var n = typeof v === 'number' ? v : parseInt(s, 10);
    // Excel 序列号范围：1900-01-01 ≈ 1, 2099-12-31 ≈ 54000+
    if (n > 20000 && n < 60000)
      return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
    // 8 位紧凑日期 20260709 → 2026-07-09
    if (/^\d{8}$/.test(s))
      return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    return '';
  }

  // ── 标准 ISO 格式 ──
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // ── 斜杠分隔：2024/01/15 或 2024/1/5（兼容中/美式）──
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    var p1 = s.split('/');
    return p1[0] + '-' + pad2(p1[1]) + '-' + pad2(p1[2]);
  }
  // 美式/欧式短年或无年：1/15/2024、15/1/2024 → 交给 new Date 兜底

  // ── 点分隔：2024.01.15 ──
  if (/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(s)) {
    var p2 = s.split('.');
    return p2[0] + '-' + pad2(p2[1]) + '-' + pad2(p2[2]);
  }

  // ── 中文日期：2024年1月15日 / 2024年01月15日 ──
  var cn = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (cn) return cn[1] + '-' + pad2(cn[2]) + '-' + pad2(cn[3]);

  // ── Excel 自定义格式文本（序列号被格式化后的显示文本）──
  // 模式如 "+046207-12" / "046207-12" / "46207-12" —— 前半部分是序列号，后半是月或日
  var mangled = s.match(/^[\+\.0]*(\d{5,})[^\d](\d{1,2})$/);
  if (mangled) {
    var serial = parseInt(mangled[1], 10);
    if (serial > 20000 && serial < 60000)
      return new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
  }

  // ── 最终兜底：交给 JS Date 解析（覆盖英文 Jan 15, 2024 等）──
  var dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return s; // 实在无法识别则原样保留
}

/** 补零辅助 */
function pad2(n) { return String(n).padStart(2, '0'); }

// 数值单元格清洗：支持千分位逗号、带单位/符号（"1,234.56"、"100股"、"12.34元"），无法识别返回 NaN
function parseNumericCellF(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  var s = String(v).replace(/,/g, '').trim();
  var m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

// 投入本金 investedAt() 已收口到 shared/nav-math.js（前后端共用），此处不再重复定义

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
    const invested = investedAt(data.navHistory, data.cashFlows, data.cashBase, n.date);
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

  // 当年/历年收益：基准 = 上一年年底净值，对比 = 该行当日净值
  // 例如 2022 年任意一行 = 该行 nav / 2021 年底 nav - 1（每行值不同，随时间变化）
  // 首年(无上一年底数据) → 改用「首年第一个净值」作基准；缺口年(中间断档)同理
  const yearEndNav = {};
  const firstNavOfYear = {};
  rows.forEach(function (r) {
    const Y = r.date.slice(0, 4);
    yearEndNav[Y] = r.nav;                          // rows 升序，同一年最后一条覆盖为该年底
    if (firstNavOfYear[Y] == null) firstNavOfYear[Y] = r.nav; // 同一年首条为该年第一个净值
  });
  rows.forEach(function (r) {
    const Y = r.date.slice(0, 4);
    const prevBase = yearEndNav[String(Number(Y) - 1)];
    const base = (prevBase != null) ? prevBase : firstNavOfYear[Y]; // 有去年底用去年底；否则用首年首净值
    const cur = r.nav;                                              // 用该行自身净值（非当年底），使每行值不同
    r.yearReturn = (base != null && base > 0 && cur != null) ? cur / base - 1 : null;
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

  // 今日涨跌判定规则：
  // ① 首行无前一日 → null（"-"）
  // ② 与上一记录间隔>4天（导入的历史快照往往不连续）→ null（"-"）
  // ③ 连续的周末（市场休市）→ 0%
  // ④ 其余（连续交易日）→ 按「当日总资产 vs 前一交易日总资产」计算真实涨跌
  rows.forEach(function (r, i) {
    if (i === 0) { r.dayChange = null; return; }
    const dt = new Date(r.date + 'T00:00:00');
    const isWeekend = (dt.getDay() === 0 || dt.getDay() === 6);
    const prev = rows[i - 1];
    const gap = daysBetweenDates(prev.date, r.date);
    if (gap == null || gap > 4) { r.dayChange = null; return; }
    if (isWeekend) { r.dayChange = 0; return; }
    r.dayChange = (prev.totalMarketValue > 0) ? (r.totalMarketValue - prev.totalMarketValue) / prev.totalMarketValue : 0;
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
      invested: (p.invested == null ? investedAt(data.navHistory, data.cashFlows, data.cashBase, p.date) : p.invested)
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
// 返回锚点日期（导入最后一条），供提交时把重算后的后续记录一并持久化（2026-08-04 修复）
function recalcNavAfterImport(parsed) {
  if (!data.navHistory || data.navHistory.length === 0) return null;
  const cf = (data.cashFlows || []);
  let lastImportDate = null;
  (parsed || []).forEach(function (p) { if (!lastImportDate || p.date > lastImportDate) lastImportDate = p.date; });
  if (!lastImportDate) return null;
  const sorted = data.navHistory.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  let anchor = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].date <= lastImportDate && sorted[i].nav != null) anchor = sorted[i];
  }
  if (!anchor) return null;
  let prevNav = anchor.nav;
  let prevTotal = (anchor.totalAsset != null) ? anchor.totalAsset : 0;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    if (n.date <= anchor.date) continue; // 锚点及之前保持导入值不动
    const cfToday = cf.filter(function (c) { return c.date === n.date; }).reduce(function (s, c) { return s + (c.amount || 0); }, 0);
    const base = prevTotal + cfToday;
    if (base > 0 && n.totalAsset != null) n.nav = chainNav(prevNav, prevTotal, n.totalAsset, cfToday);
    prevNav = (n.nav != null) ? n.nav : prevNav;
    prevTotal = (n.totalAsset != null) ? n.totalAsset : prevTotal;
  }
  data.navHistory = sorted;
  return lastImportDate;
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
    const nav = parseNumericCellF(row[mapping.nav]);
    if (!date || nav === null || isNaN(nav)) { badRows.push(i + 1); return; }
    parsed.push({
      date: date,
      nav: nav,
      totalAsset: (mapping.total >= 0 && row[mapping.total] != null && row[mapping.total] !== '') ? parseNumericCellF(row[mapping.total]) : null,
      invested: (mapping.invested >= 0 && row[mapping.invested] != null && row[mapping.invested] !== '') ? parseNumericCellF(row[mapping.invested]) : null
    });
  });
  if (parsed.length === 0) {
    showToast('没有可用数据' + (badRows.length ? ('（' + badRows.length + ' 行因缺日期/净值被跳过）') : ''));
    return;
  }

  // 导入前自动备份当前 navHistory（误导入可一键还原）；备份失败则中止导入，防止"以为有快照实际没有"
  var backedUp = await backupNavHistoryServer();
  if (!backedUp) {
    showToast('导入前自动备份失败，已取消导入（避免误导入后无法还原）。请稍后重试');
    return;
  }

  // 冲突检测：导入中存在日期落在线上段 [首条, 末条] 内
  const realStart = (data.navHistory && data.navHistory.length) ? data.navHistory[0].date : null;
  const realEnd = (data.navHistory && data.navHistory.length) ? data.navHistory[data.navHistory.length - 1].date : null;
  const hasConflict = realStart && parsed.some(function (p) { return p.date >= realStart && p.date <= realEnd; });
  const choice = hasConflict ? await showConflictModal() : 'online';
  applyHistoryRecords(parsed, choice);
  const lastImportDate = recalcNavAfterImport(parsed); // 以导入最后一条为锚，其后净值自动接续重算

  // 阶段三：净值导入走 POST /nav/import 局部接口
  // 语义（2026-08-04 阻断修复）：
  //  - 导入数据为准：发送全部记录，后端按日期 upsert，只覆盖冲突日期、保留其余线上净值（不再 replace 删全部）
  //  - 线上数据为准：只发送不落在线上段内的记录，冲突日期不发，避免覆盖线上
  //  - 导入数据为准时追加重算后的后续记录一并持久化，防止服务器响应刷新后重算结果消失
  var sendRecords = parsed;
  if (choice === 'online' && realStart) {
    sendRecords = parsed.filter(function (p) { return p.date < realStart || p.date > realEnd; });
  } else if (choice === 'import' && lastImportDate) {
    var tail = (data.navHistory || []).filter(function (n) { return n.date > lastImportDate; })
      .map(function (n) { return { date: n.date, nav: n.nav, totalAsset: (n.totalAsset != null ? n.totalAsset : null), invested: (n.invested != null ? n.invested : null) }; });
    sendRecords = parsed.concat(tail);
  }
  if (sendRecords.length === 0) {
    renderEarnings();
    showToast('导入完成：冲突日期均保留线上净值，无新增记录');
    return;
  }
  try {
    var importBody = { account: currentAccount, records: sendRecords };
    var r = await fetch(api('/api/nav/import?version=' + (dataVersion != null ? dataVersion : '')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importBody)
    });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { showToast(j.error || '导入失败'); return; }
    if (j.data) refreshDataFromServer(j.data);
  } catch(e) { showToast('导入失败：' + (e.message || e)); return; }

  renderEarnings();
  let msg = '已导入 ' + parsed.length + ' 条历史净值';
  if (badRows.length) msg += '（' + badRows.length + ' 行因缺日期/净值未导入）';
  showToast(msg);
}

// ===================== 历史净值备份/还原（导入前自动拍快照，误导入可一键还原） =====================

// 调用后端 API：把当前 nav_history 存到 nav_history_backup；成功返回 true，失败返回 false
async function backupNavHistoryServer() {
  if (!currentAccount) return true; // 无账户上下文不备份也不阻塞
  try {
    var r = await fetch(api('/api/accounts/' + encodeURIComponent(currentAccount) + '/backup-nav-history'), { method: 'POST' });
    if (!r.ok) { console.warn('历史数据备份失败：HTTP ' + r.status); return false; }
    return true;
  } catch (e) { console.warn('历史数据备份失败', e); return false; }
}

// 打开"管理历史数据"弹窗
async function openNavHistoryManageModal() {
  if (!currentAccount) { showToast('请先选择账户'); return; }
  var info = document.getElementById('nav-mgmt-backup-info');
  var restoreBtn = document.getElementById('nav-mgmt-restore-btn');
  if (info) info.innerHTML = '正在读取备份信息...';
  try {
    var r = await fetch(api('/api/accounts/' + encodeURIComponent(currentAccount) + '/nav-history-backup-info'));
    var d = await r.json();
    if (d.hasBackup) {
      if (info) info.innerHTML = '✓ 已备份 <b>' + (d.rows || 0) + '</b> 条记录，备份时间：' + escapeHtml(String(d.at || '')).replace('T', ' ').replace(/\..*$/, '');
      if (restoreBtn) restoreBtn.disabled = false;
    } else {
      if (info) info.innerHTML = '⚠ 当前账户没有备份（本次功能之前的历史数据未自动备份）—— 一键还原不可用，可用「清空历史数据」救火';
      if (restoreBtn) restoreBtn.disabled = true;
    }
  } catch (e) {
    if (info) info.innerHTML = '读取备份信息失败：' + escapeHtml(e.message);
    if (restoreBtn) restoreBtn.disabled = true;
  }
  var modal = document.getElementById('modal-nav-mgmt');
  if (modal) modal.classList.add('show');
}

// 还原：先弹通用确认框，确认后调用
function confirmRestoreNavHistory() {
  if (!currentAccount) return;
  var modal = document.getElementById('modal-nav-restore-confirm');
  if (modal) modal.classList.add('show');
}
async function doRestoreNavHistory() {
  if (!currentAccount) return;
  closeModal('modal-nav-restore-confirm');
  try {
    var r = await fetch(api('/api/accounts/' + encodeURIComponent(currentAccount) + '/restore-nav-history'), { method: 'POST' });
    var d = await r.json();
    if (!r.ok || d.error) { showToast('还原失败：' + (d.error || r.status)); return; }
    showToast('已还原 ' + (d.rows || 0) + ' 条记录' + (d.backupAt ? '（备份时间 ' + String(d.backupAt).replace('T',' ').replace(/\..*$/,'') + '）' : ''));
    var fresh = await loadData(currentAccount);
    if (fresh) { data = fresh; }
    renderEarnings();
    closeModal('modal-nav-mgmt');
  } catch (e) { showToast('还原失败：' + e.message); }
}

// 清空历史数据：先弹通用确认框，确认后删除除最近一天外的全部记录
function confirmClearNavHistory() {
  if (!currentAccount) return;
  var modal = document.getElementById('modal-nav-clear-confirm');
  if (modal) modal.classList.add('show');
}
async function doClearNavHistory() {
  if (!currentAccount) return;
  closeModal('modal-nav-clear-confirm');
  try {
    var r = await fetch(api('/api/accounts/' + encodeURIComponent(currentAccount) + '/clear-nav-history'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'keep-latest' })
    });
    var d = await r.json();
    if (!r.ok || d.error) { showToast('清空失败：' + (d.error || r.status)); return; }
    showToast('已清空历史数据，仅保留最近一天，共删除 ' + (d.rows || 0) + ' 条记录');
    var fresh = await loadData(currentAccount);
    if (fresh) { data = fresh; }
    renderEarnings();
    closeModal('modal-nav-mgmt');
  } catch (e) { showToast('清空失败：' + e.message); }
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
