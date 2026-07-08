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
  var equityVal = 0, debtVal = 0;
  data.positions.forEach(function(p) {
    var mv = getMarketValue(p);
    if (p.type === '股权') equityVal += mv; else debtVal += mv;
  });
  var cash = Number(data.cash) || 0;
  var total = equityVal + debtVal + cash;
  return { total: total, equityVal: equityVal, debtVal: debtVal, cash: cash,
    equityPct: total > 0 ? equityVal / total : 0,
    debtPct: total > 0 ? debtVal / total : 0,
    cashPct: total > 0 ? cash / total : 0 };
}

function getSubtypeTag(st) {
  var map = { 'A股': '<span class="tag tag-a">A股</span>', '港股': '<span class="tag tag-hk">港股</span>', '美股': '<span class="tag tag-us">美股</span>', '可转债': '<span class="tag tag-cb">可转债</span>', '信用债': '<span class="tag tag-bond">信用债</span>', '基金/ETF': '<span class="tag tag-etf">基金/ETF</span>' };
  return map[st] || '<span class="tag">' + (st || '-') + '</span>';
}

function getSubtypeColor(st) {
  var map = { 'A股': '#d93025', '港股': '#7b1fa2', '美股': '#283593', '可转债': '#00838f', '信用债': '#3f51b5', '基金/ETF': '#c62828' };
  return map[st] || '#666';
}

function sortArrow(col) {
  if (sortState.col !== col) return '';
  return sortState.dir === 'asc' ? ' ▲' : ' ▼';
}

// ===================== 交易时间判断 =====================
// A股/可转债: 周一至五 9:30-11:30, 13:00-15:00
// 港股: 周一至五 9:30-12:00, 13:00-16:00

function isMarketOpen() {
  var now = new Date();
  var day = now.getDay();
  if (day === 0 || day === 6) return false; // 周末休市
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
