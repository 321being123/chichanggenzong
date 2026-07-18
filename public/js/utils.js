// ============================================================
// utils.js – 纯工具函数（无 DOM 依赖）
// 注意: recognizeCode 委托全局 classifyCode（见 /js/code-classify.js），
//       该脚本须在 utils.js 之前加载（见 index.html）。
// ============================================================

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fmt(n) {
  var num = Number(n);
  if (isNaN(num)) return '¥0.00';
  var sign = num < 0 ? '-' : '';
  var abs = Math.abs(num);
  // 精确到分，避免浮点精度问题（如 17.15*14000 → 240099.99999999997）
  var totalCents = Math.round(abs * 100);
  var intPart = Math.floor(totalCents / 100);
  var decPart = totalCents % 100;
  var intStr = String(intPart);
  var formattedInt = '';
  for (var i = 0; i < intStr.length; i++) {
    if (i > 0 && (intStr.length - i) % 4 === 0) formattedInt += ',';
    formattedInt += intStr[i];
  }
  return sign + '¥' + formattedInt + '.' + String(decPart).padStart(2, '0');
}

function fmtQty(n) {
  var num = Number(n);
  if (isNaN(num) || num === 0) return '0';
  var intStr = String(Math.floor(Math.abs(num)));
  var formatted = '';
  for (var i = 0; i < intStr.length; i++) {
    if (i > 0 && (intStr.length - i) % 4 === 0) formatted += ',';
    formatted += intStr[i];
  }
  return (num < 0 ? '-' : '') + formatted;
}

function fmtPct(n) {
  return (n * 100).toFixed(2) + '%';
}

function recognizeCode(code) {
  // 委托单一分类函数（public/js/code-classify.js，前后端共用）
  var c = classifyCode(code);
  return c ? { type: c.type, subtype: c.subtype } : null;
}

function getMarketValue(pos) {
  var mv = (pos.price || 0) * (pos.quantity || 0);
  if (pos.subtype === '港股') { var rate = data.hkRate || 0.868; mv = mv * rate; }
  return mv;
}

function calcSummary() {
  var equityVal = 0, debtVal = 0, cashPosVal = 0;
  data.positions.forEach(function(p) {
    var mv = getMarketValue(p);
    if (p.type === '股权') equityVal += mv;
    else if (p.type === '现金') cashPosVal += mv;
    else debtVal += mv;
  });
  var cash = (Number(data.cash) || 0) + cashPosVal;
  var total = equityVal + debtVal + cash;
  return { total: total, equityVal: equityVal, debtVal: debtVal, cash: cash,
    equityPct: total > 0 ? equityVal / total : 0,
    debtPct: total > 0 ? debtVal / total : 0,
    cashPct: total > 0 ? cash / total : 0 };
}

function getSubtypeTag(st) {
  var map = { '沪市': '<span class="tag tag-a">沪市</span>', '深市': '<span class="tag tag-a">深市</span>', '京市': '<span class="tag tag-a">京市</span>', '港股': '<span class="tag tag-hk">港股</span>', '美股': '<span class="tag tag-us">美股</span>', '可转债': '<span class="tag tag-cb">可转债</span>', '信用债': '<span class="tag tag-bond">信用债</span>', '基金/ETF': '<span class="tag tag-etf">基金/ETF</span>' };
  return map[st] || '<span class="tag">' + escapeHtml(st || '-') + '</span>';
}

function getTypeTag(type) {
  if (type === '股权') return '<span class="tag tag-equity">股权</span>';
  if (type === '现金') return '<span class="tag tag-cash">现金</span>';
  return '<span class="tag tag-debt">债权</span>';
}

function getTypeTagClass(type) {
  if (type === '股权') return 'tag-equity';
  if (type === '现金') return 'tag-cash';
  return 'tag-debt';
}

function getSubtypeColor(st) {
  var map = { '沪市': '#d93025', '深市': '#ef6c00', '京市': '#2e7d32', '港股': '#7b1fa2', '美股': '#283593', '可转债': '#00838f', '信用债': '#3f51b5', '基金/ETF': '#c62828' };
  return map[st] || '#666';
}

function sortArrow(col) {
  if (sortState.col !== col) return '';
  return sortState.dir === 'asc' ? ' ▲' : ' ▼';
}

// ===================== 交易时间判断 =====================
// A股/可转债: 周一至五 9:30-11:30, 13:00-15:00
// 港股: 周一至五 9:30-12:00, 13:00-16:00

// 法定节假日（A股休市，来源：上交所2026全年休市安排公告）。
// ⚠️ 每年需更新：把下一年的休市日期补进对应集合（周末已自动处理，这里只列法定假日）。
// 格式 YYYY-MM-DD。2026 已按官方公告录入；同步覆盖沪港通/深港通下的港股通休市日。
var CN_HOLIDAYS = (function () {
  var list = [
    // 元旦 1/1-1/3（1/4 周日周末）
    '2026-01-01', '2026-01-02', '2026-01-03',
    // 春节 2/15-2/23（2/14、2/28 周六周末）
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    // 清明节 4/4-4/6（4/4 周六）
    '2026-04-04', '2026-04-05', '2026-04-06',
    // 劳动节 5/1-5/5（5/9 周六周末）
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    // 端午节 6/19-6/21
    '2026-06-19', '2026-06-20', '2026-06-21',
    // 中秋节 9/25-9/27（9/20 周日周末）
    '2026-09-25', '2026-09-26', '2026-09-27',
    // 国庆节 10/1-10/7（10/10 周六周末）
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
    '2026-10-06', '2026-10-07'
  ];
  return new Set(list);
})();

// 是否为 A股法定休市日（与周末并列，供 isMarketOpen 判断）
function isCnHoliday(dateStr) {
  if (!dateStr) return false;
  return CN_HOLIDAYS.has(dateStr);
}

function isMarketOpen() {
  var now = new Date();
  var day = now.getDay();
  if (day === 0 || day === 6) return false; // 周末休市
  if (isCnHoliday(todayCN())) return false; // 法定节假日休市
  var h = now.getHours(), m = now.getMinutes();
  var t = h * 100 + m;
  var aShareOpen = (t >= 930 && t < 1130) || (t >= 1300 && t < 1500);
  var hkOpen = (t >= 930 && t < 1200) || (t >= 1300 && t < 1600);
  // 根据持仓判断需要何种市场
  if (typeof data !== 'undefined' && data && data.positions) {
    var hasHK = data.positions.some(function(p) { return p.subtype === '港股'; });
    var hasAShare = data.positions.some(function(p) { return p.subtype !== '港股'; });
    if (hasHK && hasAShare) return aShareOpen || hkOpen;
    if (hasHK) return hkOpen;
  }
  return aShareOpen;
}

// ===================== 部署相关（子目录 + 时区） =====================

// 子目录部署：在 index.html / login.html 的 <meta name="base-url" content="/sub"> 设置前缀
// 留空表示部署在域名根目录（默认）
var BASE_URL = (function () {
  var m = document.querySelector('meta[name="base-url"]');
  return (m && m.content) ? m.content : '';
})();

// 给接口路径加上部署前缀（如 /sub/api/me）
function api(path) { return BASE_URL + path; }

// 东八区（北京时间）日期 YYYY-MM-DD
// 避免服务器时区非东八区时，净值日期 / 交易日期差一天（尤其凌晨）
function todayCN() {
  var now = new Date();
  var cn = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}
