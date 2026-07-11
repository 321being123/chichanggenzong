// shared/core-returns.js – 现金流/基金净值/收益对比图（原 core.js 拆分，全局作用域不变）
// ===================== 现金流管理（NAV 修正） =====================

/**
 * 显示入金/出金弹窗
 * 在收益走势区的"记录净值"按钮旁调用
 */
function showCashFlowModal() {
  var html =
    '<div class="modal-overlay show" id="modal-cashflow" style="z-index:1001;">' +
    '<div class="modal" style="width:400px;">' +
    '<h2>资金转入 / 转出</h2>' +
    '<div style="display:flex;gap:10px;margin-bottom:14px;">' +
    '<button type="button" id="cf-btn-in" class="btn btn-primary" style="flex:1;" onclick="setCfDir(\'in\')">💰 资金转入（入金）</button>' +
    '<button type="button" id="cf-btn-out" class="btn btn-outline" style="flex:1;" onclick="setCfDir(\'out\')">📤 资金转出（出金）</button>' +
    '</div>' +
    '<div class="form-group" style="margin-bottom:14px;">' +
    '<label style="display:block;font-size:12px;color:#888;margin-bottom:4px;">金额 (¥，填正数即可)</label>' +
    '<input type="number" id="cf-amount" step="0.01" placeholder="请输入金额" ' +
    'style="width:100%;padding:9px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;">' +
    '</div>' +
    '<div class="form-group" style="margin-bottom:14px;">' +
    '<label style="display:block;font-size:12px;color:#888;margin-bottom:4px;">备注 (可选)</label>' +
    '<input type="text" id="cf-note" placeholder="如: 工资入金、消费支出" ' +
    'style="width:100%;padding:9px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;">' +
    '</div>' +
    '<div class="modal-actions">' +
    '<button class="btn btn-outline" onclick="closeCashFlowModal()">取消</button>' +
    '<button class="btn btn-primary" onclick="addCashFlow()">确认</button>' +
    '</div>' +
    '</div>' +
    '</div>';
  // 插入到 body
  var div = document.createElement('div');
  div.id = 'cashflow-modal-container';
  div.innerHTML = html;
  document.body.appendChild(div);
  setCfDir('in');
}

// 切换 入金/出金（不再用正负数，改用按钮）
function setCfDir(dir) {
  window.__cfDir = dir;
  var inBtn = document.getElementById('cf-btn-in');
  var outBtn = document.getElementById('cf-btn-out');
  if (inBtn && outBtn) {
    if (dir === 'in') {
      inBtn.className = 'btn btn-primary';
      outBtn.className = 'btn btn-outline';
    } else {
      inBtn.className = 'btn btn-outline';
      outBtn.className = 'btn btn-primary';
    }
  }
}

function closeCashFlowModal() {
  var container = document.getElementById('cashflow-modal-container');
  if (container) container.parentNode.removeChild(container);
}

function addCashFlow() {
  var amountInput = document.getElementById('cf-amount');
  var noteInput = document.getElementById('cf-note');
  var abs = parseFloat(amountInput ? amountInput.value : 0);
  if (!abs || isNaN(abs) || abs <= 0) {
    showToast('请输入有效金额');
    return;
  }
  var dir = window.__cfDir || 'in';
  var cfAmount = dir === 'in' ? abs : -abs;
  if (!data.cashFlows) data.cashFlows = [];
  data.cashFlows.push({
    id: uid(),
    date: todayCN(),
    created_at: nowSec(),
    amount: cfAmount,
    note: noteInput ? noteInput.value.trim() : ''
  });
  // 现金由系统自动重算（cashFlows 已更新），刷新内存显示
  recalcCash();
  saveData();
  closeCashFlowModal();
  renderAll();
  showToast((cfAmount > 0 ? '入金' : '出金') + ' ' + fmt(Math.abs(cfAmount)) + ' 已记录');
}

// ===================== 基金净值法收益（已修正现金流） =====================

let chartReturns = null;
let returnPeriod = 0;
let indexVisibility = {
  '沪深300': true,
  '上证指数': true,
  '中证全指': true,
  '恒生指数': true
};

/**
 * 记录净值（修正版）
 *
 * 原 bug：一直使用 data.navHistory[0].totalAsset 作为基准，
 * 当用户中途入金/出金时，NAV 会被错误地拉高或拉低。
 *
 * 修正：
 * - 新增 data.cashFlows 数组记录入金（正数）和出金（负数）
 * - 公式：adjustedNav = lastNav.nav * (currentTotal / (lastTotalAsset + periodCashFlow))
 *   其中 periodCashFlow 是「上次净值记录日之后、到今天为止」的累计净现金流
 *   （含今天、不含上次净值日，避免漏算未开 App 那几天的出入金，也不重复计入已结算日）
 * - 现金流的金额同时累加到 data.cash 上，确保总资产正确
 */
function recordNav() {
  if (!data.navHistory) data.navHistory = [];
  const today = todayCN();
  // 投入本金：优先用导入数据，导入数据最后一列日期之后按出入金延续（见 investedAt）
  const invested = investedAt(today);

  const s = calcSummary();
  if (s.total <= 0) return;

  // 当天已记录 → 覆盖当天（一天内多次刷新/收盘后市值变动也能反映）
  if (data.navHistory.length > 0 &&
      data.navHistory[data.navHistory.length - 1].date === today) {
    const lastNav = data.navHistory[data.navHistory.length - 1];
    var periodCashFlow = 0;
    if (data.cashFlows) {
      data.cashFlows.forEach(function (cf) {
        if (cf.date > lastNav.date && cf.date <= today) periodCashFlow += cf.amount;
      });
    }
    var baseAsset = lastNav.totalAsset + periodCashFlow;
    if (baseAsset > 0) {
      lastNav.nav = lastNav.nav * (s.total / baseAsset);
      lastNav.totalAsset = s.total;
      lastNav.invested = invested;
    }
    saveData();
    return;
  }

  if (data.navHistory.length === 0) {
    // 第一条 NAV 记录，净值设为 1.0
    data.navHistory.push({
      date: today,
      nav: 1.0,
      totalAsset: s.total,
      invested: invested
    });
  } else {
    // 修正后的净值计算：
    // adjustedNav = lastNav * (currentTotal / (lastTotalAsset + periodCashFlow))
    // 即：剔除「上次净值以来累计现金流」影响后的真实净值增长
    const lastNav = data.navHistory[data.navHistory.length - 1];
    // 自上次净值记录日（不含）到今天（含）的累计净现金流
    var periodCashFlow2 = 0;
    if (data.cashFlows) {
      data.cashFlows.forEach(function (cf) {
        if (cf.date > lastNav.date && cf.date <= today) periodCashFlow2 += cf.amount;
      });
    }
    var baseAsset2 = lastNav.totalAsset + periodCashFlow2;
    if (baseAsset2 <= 0) return;
    var nav = lastNav.nav * (s.total / baseAsset2);
    data.navHistory.push({
      date: today,
      nav: nav,
      totalAsset: s.total,
      invested: invested
    });
  }
  saveData();
}

function renderReturnsStats() {
  const container = document.getElementById('returns-section') || document.getElementById('page-dashboard');
  
  // 首次渲染生成结构
  if (document.getElementById('returns-section') && !document.querySelector('#returns-section .chart-box')) {
    document.getElementById('returns-section').innerHTML =
      '<div class="chart-box" style="margin-bottom:20px;">' +
        '<div class="chart-title">' +
          '<h3>收益走势对比</h3>' +
          '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
            '<button class="period-btn active" data-days="30" onclick="switchPeriod(30)">近1月</button>' +
            '<button class="period-btn" data-days="90" onclick="switchPeriod(90)">近3月</button>' +
            '<button class="period-btn" data-days="180" onclick="switchPeriod(180)">近6月</button>' +
            '<button class="period-btn" data-days="365" onclick="switchPeriod(365)">近1年</button>' +
            '<button class="period-btn" data-days="0" onclick="switchPeriod(0)">全部</button>' +
          '</div>' +
        '</div>' +
        '<div style="margin-bottom:10px;font-size:13px;">' +
          '<span id="ret-total-return" style="font-weight:700;font-size:16px;">¥0.00</span>' +
          '<span id="ret-total-return-pct" style="font-weight:600;margin-left:6px;"></span>' +
          '<span style="margin-left:14px;color:#888;">📊 净值 <span id="ret-nav">1.0000</span></span>' +
          '<span style="margin-left:10px;color:#888;">📅 <span id="ret-nav-date">无记录</span></span>' +
          '<span style="margin-left:10px;color:#888;">记录 <span id="ret-days">0</span> 天</span>' +
          '<button class="cashflow-btn" onclick="showCashFlowModal()" style="margin-left:10px;">💰 现金流</button>' +
        '</div>' +
        '<div style="margin-bottom:10px;font-size:12px;color:#888;">对比指数:' +
          '<button class="period-btn index-toggle active" data-idx="沪深300" onclick="toggleIndex(\'沪深300\')" style="font-size:11px;padding:2px 10px;margin-left:4px;">沪深300</button>' +
          '<button class="period-btn index-toggle active" data-idx="上证指数" onclick="toggleIndex(\'上证指数\')" style="font-size:11px;padding:2px 10px;">上证指数</button>' +
          '<button class="period-btn index-toggle active" data-idx="中证全指" onclick="toggleIndex(\'中证全指\')" style="font-size:11px;padding:2px 10px;">中证全指</button>' +
          '<button class="period-btn index-toggle active" data-idx="恒生指数" onclick="toggleIndex(\'恒生指数\')" style="font-size:11px;padding:2px 10px;">恒生指数</button>' +
        '</div>' +
        '<div class="chart-canvas-wrap" style="height:300px;"><canvas id="chart-returns"></canvas></div>' +
      '</div>';
  }
  
  // 更新数值
  var el = function(id) { return document.getElementById(id); };
  if (!el('ret-total-return')) return;
  
  if (!data.navHistory || data.navHistory.length === 0) {
    document.getElementById('ret-total-return').textContent = '¥0';
    document.getElementById('ret-total-return').style.color = '#999';
    document.getElementById('ret-total-return-pct').textContent = '无数据';
    document.getElementById('ret-nav').textContent = '1.0000';
    document.getElementById('ret-nav-date').textContent = '无记录';
    document.getElementById('ret-days').textContent = '0';
    return;
  }
  const first = data.navHistory[0];
  const last = data.navHistory[data.navHistory.length - 1];
  const initAsset = first.totalAsset;
  const curAsset = last.totalAsset;

  // 计算调整后的真实收益：考虑所有现金流
  // 累计收益 = 当前总资产 - 初始资产 - 累计净入金
  var totalCashFlow = 0;
  if (data.cashFlows) {
    data.cashFlows.forEach(function (cf) { totalCashFlow += cf.amount; });
  }
  // 调整后的初始资产：初始资产 + 累计现金流
  var adjustedInit = initAsset + totalCashFlow;
  var totalReturn = adjustedInit > 0
    ? curAsset - adjustedInit
    : curAsset - initAsset;
  // 调整后的收益率 = 最新净值 - 1（NAV 已通过 corrected formula 计算）
  var totalReturnPct = (last.nav - 1) * 100;

  var sign = totalReturn >= 0 ? '+' : '';
  document.getElementById('ret-total-return').textContent = (totalReturn < 0 ? '-' : '') + fmt(Math.abs(totalReturn));
  document.getElementById('ret-total-return').style.color = totalReturn >= 0 ? '#137333' : '#d93025';
  document.getElementById('ret-total-return-pct').textContent = sign + totalReturnPct.toFixed(2) + '%';
  document.getElementById('ret-total-return-pct').style.color = totalReturn >= 0 ? '#137333' : '#d93025';

  var navEl = document.getElementById('ret-nav');
  navEl.textContent = last.nav.toFixed(4);
  navEl.style.color = last.nav >= 1 ? '#137333' : '#d93025';
  document.getElementById('ret-nav-date').textContent = last.date;
  document.getElementById('ret-days').textContent = data.navHistory.length;
}

async function fetchIndexKline(secid, days) {
  try {
    const r = await fetch(api('/api/kline?secid=' + encodeURIComponent(secid) + '&days=' + (days || 365)));
    if (r.ok) {
      const data = await r.json();
      if (data && data.length > 0) return data;
    }
  } catch(e) {}
  return [];
}

// 指数 secid 映射（东方财富格式；A股15:00收盘 / 港股16:00收盘，kline 自动取已收盘日）
const INDEX_SECID = {
  '沪深300': 'sh000300',
  '上证指数': 'sh000001',
  '中证500': 'sh000905',
  '恒生指数': 'hkHSI'
};

// 日期跨度（天）：从给定日期到今天，用于按真实时间区间拉取指数K线
// （旧逻辑用 navHistory.length*2，稀疏或跨多年的净值历史会拉不到足够的指数区间）
function daysBetween(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.max(1, Math.ceil((now - d) / 86400000));
}

// 基准日解析：净值首日若为非交易日(周末/节假日)，回退到最近的前一个交易日
// （含该周周五），保证指数归一化基准有对应收盘点位，避免整条指数线被丢弃
function resolveBaselineDate(navFirstDate, indexMap) {
  if (indexMap[navFirstDate] != null) return navFirstDate;
  const d = new Date(navFirstDate);
  for (let i = 0; i < 10; i++) {
    d.setDate(d.getDate() - 1);
    const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (indexMap[ds] != null) return ds;
  }
  return null;
}

// 刷新行情时同步指数收盘点位快照（对齐股票每日价格逻辑）
// 一次拉取较长区间补齐历史交易日，使对比曲线按交易日连续、平滑
// 拉取后增量写入独立 index_history 表（消除 JSON 读写放大），内存 data.indexHistory 仅作图表数据源
async function syncIndexPoints() {
  try {
    if (!data.indexHistory) data.indexHistory = [];
    const firstNavDate = (data.navHistory && data.navHistory.length) ? data.navHistory[0].date : null;
    const days = Math.max(250, firstNavDate ? daysBetween(firstNavDate) : 250);
    const names = Object.keys(INDEX_SECID);
    const results = await Promise.all(names.map(function (n) {
      return fetchIndexKline(INDEX_SECID[n], days + 5);
    }));
    var byDate = {};
    data.indexHistory.forEach(function (h) { byDate[h.date] = h; });
    names.forEach(function (n, i) {
      (results[i] || []).forEach(function (pt) {
        if (!byDate[pt.date]) byDate[pt.date] = { date: pt.date };
        byDate[pt.date][n] = pt.close;
      });
    });
    data.indexHistory = Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
    // 增量写入独立表
    try {
      const points = [];
      data.indexHistory.forEach(function (h) {
        names.forEach(function (n) { if (h[n] != null) points.push({ date: h.date, name: n, close: h[n] }); });
      });
      await fetch(api('/api/index-history'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: currentAccount, points: points })
      });
    } catch (e) { /* 指数入库失败不影响主流程 */ }
  } catch (e) { /* 指数快照失败不影响主流程 */ }
}

// 优先用本地快照构造指数序列（按交易日对齐，基准=净值第一天对应点位）
function getIndexSeries(name, navData) {
  if (!data.indexHistory || !data.indexHistory.length) return null;
  var map = {};
  data.indexHistory.forEach(function (h) { if (h[name] != null) map[h.date] = h[name]; });
  // 基准日：净值首日若为非交易日(周末/节假日)，回退到最近的前一个交易日(含该周周五)
  var baseDate = resolveBaselineDate(navData[0].date, map);
  if (baseDate == null) return null;
  var firstClose = map[baseDate];
  return navData
    .filter(function (d) { return map[d.date] != null; })
    .map(function (d) { return { date: d.date, val: map[d.date] / firstClose }; });
}

// 实时 kline 兜底归一化（修复：基准用净值第一天对应点位，而非拉取区间第一天）
function normalizeIndexData(indexData, navData) {
  if (indexData.length === 0 || navData.length === 0) return [];
  const map = {};
  indexData.forEach(function (d) { map[d.date] = d.close; });
  // 基准日：净值首日若为非交易日(周末/节假日)，回退到最近的前一个交易日(含该周周五)
  const baseDate = resolveBaselineDate(navData[0].date, map);
  if (baseDate == null) return [];
  const firstClose = map[baseDate];
  const dateSet = new Set(navData.map(function (d) { return d.date; }));
  return indexData
    .filter(function (d) { return dateSet.has(d.date); })
    .map(function (d) {
      return { date: d.date, val: d.close / firstClose };
    });
}

async function renderReturnsChart() {
  renderReturnsStats();
  if (!data.navHistory || data.navHistory.length < 2) {
    if (chartReturns) { chartReturns.destroy(); chartReturns = null; }
    return;
  }

  let navData = data.navHistory;
  if (returnPeriod > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - returnPeriod);
    navData = navData.filter(function (d) { return new Date(d.date) >= cutoff; });
  }
  if (navData.length < 2) return;

  const labels = navData.map(function (d) { return d.date.slice(5); });
  const navVals = navData.map(function (d) { return +(d.nav.toFixed(4)); });

  // 指数序列：优先本地快照（按交易日连续、平滑），缺失时实时拉取兜底
  var hs300Data = getIndexSeries('沪深300', navData) || [];
  var shData = getIndexSeries('上证指数', navData) || [];
  var zzData = getIndexSeries('中证500', navData) || [];
  var hsidata = getIndexSeries('恒生指数', navData) || [];
  if (!hs300Data.length || !shData.length || !zzData.length || !hsidata.length) {
    try {
      const days = returnPeriod > 0 ? returnPeriod : Math.max(250, daysBetween(navData[0].date));
      const results = await Promise.all([
        fetchIndexKline('sh000300', days + 30),
        fetchIndexKline('sh000001', days + 30),
        fetchIndexKline('sh000905', days + 30),
        fetchIndexKline('hkHSI', days + 30)
      ]);
      if (!hs300Data.length) hs300Data = normalizeIndexData(results[0], navData);
      if (!shData.length) shData = normalizeIndexData(results[1], navData);
      if (!zzData.length) zzData = normalizeIndexData(results[2], navData);
      if (!hsidata.length) hsidata = normalizeIndexData(results[3], navData);
    } catch (e) { /* 指数数据加载失败不阻塞 */ }
  }

  var datasets = [{
    label: '持仓净值',
    data: navVals,
    borderColor: '#1a237e',
    backgroundColor: 'rgba(26,35,126,.08)',
    fill: true,
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2.5
  }];

  // 沪深300
  if (hs300Data.length > 0) {
    var hs300Map = {};
    hs300Data.forEach(function (d) { hs300Map[d.date] = d.val; });
    var hs300Vals = navData.map(function (d) { return hs300Map[d.date] || null; });
    datasets.push({
      label: '沪深300', data: hs300Vals,
      borderColor: '#d93025', backgroundColor: 'transparent',
      borderDash: [5, 3], tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      hidden: !indexVisibility['沪深300']
    });
  }
  // 上证指数
  if (shData.length > 0) {
    var shMap = {};
    shData.forEach(function (d) { shMap[d.date] = d.val; });
    var shVals = navData.map(function (d) { return shMap[d.date] || null; });
    datasets.push({
      label: '上证指数', data: shVals,
      borderColor: '#e37400', backgroundColor: 'transparent',
      borderDash: [3, 3], tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      hidden: !indexVisibility['上证指数']
    });
  }
  // 中证全指
  if (zzData.length > 0) {
    var zzMap = {};
    zzData.forEach(function (d) { zzMap[d.date] = d.val; });
    var zzVals = navData.map(function (d) { return zzMap[d.date] || null; });
    datasets.push({
      label: '中证全指', data: zzVals,
      borderColor: '#7b1fa2', backgroundColor: 'transparent',
      borderDash: [4, 4], tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      hidden: !indexVisibility['中证全指']
    });
  }
  // 恒生指数
  if (hsidata.length > 0) {
    var hsiMap = {};
    hsidata.forEach(function (d) { hsiMap[d.date] = d.val; });
    var hsiVals = navData.map(function (d) { return hsiMap[d.date] || null; });
    datasets.push({
      label: '恒生指数', data: hsiVals,
      borderColor: '#00838f', backgroundColor: 'transparent',
      borderDash: [2, 4], tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      hidden: !indexVisibility['恒生指数']
    });
  }

  const ctx = document.getElementById('chart-returns').getContext('2d');
  if (chartReturns) chartReturns.destroy();

  chartReturns = new Chart(ctx, {
    type: 'line',
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { padding: 16, font: { size: 12, weight: '500' }, usePointStyle: true }
        },
        tooltip: {
          backgroundColor: '#323232',
          cornerRadius: 8,
          padding: 12,
          callbacks: {
            label: function (ctx) {
              if (ctx.raw == null) return '';
              var pct = ((ctx.raw - 1) * 100).toFixed(2);
              var prefix = parseFloat(pct) >= 0 ? '+' : '';
              return ' ' + ctx.dataset.label + ': ' + prefix + pct + '%';
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 12, font: { size: 11 }, color: '#999' }
        },
        y: {
          grid: { color: '#f0f0f0' },
          ticks: {
            font: { size: 11 },
            color: '#999',
            callback: function (v) {
              var pct = (v - 1) * 100;
              return pct >= 0 ? '+' + pct.toFixed(1) + '%' : pct.toFixed(1) + '%';
            }
          }
        }
      }
    }
  });
}

function switchPeriod(days) {
  returnPeriod = days;
  document.querySelectorAll('.period-btn[data-days]').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.querySelector('.period-btn[data-days="' + days + '"]');
  if (btn) btn.classList.add('active');
  renderReturnsChart();
}

function toggleIndex(name) {
  indexVisibility[name] = !indexVisibility[name];
  var btn = document.querySelector('.index-toggle[data-idx="' + name + '"]');
  if (btn) {
    btn.classList.toggle('active');
    btn.style.opacity = indexVisibility[name] ? '1' : '.35';
  }
  if (chartReturns) {
    var ds = chartReturns.data.datasets.find(function (d) { return d.label === name; });
    if (ds) ds.hidden = !indexVisibility[name];
    chartReturns.update();
  }
}
