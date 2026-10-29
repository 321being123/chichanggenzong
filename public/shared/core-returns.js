// shared/core-returns.js – 现金流/基金净值/收益对比图（原 core.js 拆分，全局作用域不变）
// ===================== 现金流管理（NAV 修正） =====================

/**
 * 显示入金/出金弹窗
 * 在收益走势区的"记录净值"按钮旁调用
 */
function showCashFlowModal() {
  var html =
    '<div class="modal-overlay show" id="modal-cashflow" data-style="z-index:1001;">' +
    '<div class="modal" data-style="width:400px;">' +
    '<h2>资金转入 / 转出</h2>' +
    '<div data-style="display:flex;gap:10px;margin-bottom:14px;">' +
    '<button type="button" id="cf-btn-in" class="btn btn-primary u-flex-1"  data-act="setCfDir" data-arg1="in">💰 资金转入（入金）</button>' +
    '<button type="button" id="cf-btn-out" class="btn btn-outline u-flex-1"  data-act="setCfDir" data-arg1="out">📤 资金转出（出金）</button>' +
    '</div>' +
    '<div class="form-group u-mb-14" >' +
    '<label class="u-field-label">金额 (¥，填正数即可)</label>' +
    '<input type="number" id="cf-amount" step="0.01" placeholder="请输入金额" ' +
    ' class="u-input-lg">' +
    '</div>' +
    '<div class="form-group u-mb-14" >' +
    '<label class="u-field-label">备注 (可选)</label>' +
    '<input type="text" id="cf-note" placeholder="如: 工资入金、消费支出" ' +
    ' class="u-input-lg">' +
    '</div>' +
    '<div class="modal-actions">' +
    '<button class="btn btn-outline" data-act="closeCashFlowModal">取消</button>' +
    '<button class="btn btn-primary" data-act="addCashFlow">确认</button>' +
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

async function addCashFlow() {
  var amountInput = document.getElementById('cf-amount');
  var noteInput = document.getElementById('cf-note');
  var abs = parseFloat(amountInput ? amountInput.value : 0);
  if (!abs || isNaN(abs) || abs <= 0) {
    showToast('请输入有效金额');
    return;
  }
  var dir = window.__cfDir || 'in';
  var cfAmount = dir === 'in' ? abs : -abs;
  // 幂等键：前端生成唯一 id，重复点击/网络重试不会新增第二条（2026-08-04 修复）
  var cfId = uid();
  try {
    var result = await window.siteApi.requestRaw('/api/accounts/' + encodeURIComponent(currentAccount) + '/ledger/cash-flows?version=' + (dataVersion != null ? dataVersion : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cashFlow: {
          id: cfId,
          date: todayCN(),
          amount: cfAmount,
          note: noteInput ? noteInput.value.trim() : ''
        }
      }),
      timeoutMs: 0
    });
    if (!result.response) { showToast(result.error || '网络异常'); return; }
    var r = result.response;
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { showToast(j.error || '记录失败'); return; }
    if (j.data) refreshDataFromServer(j.data);
    closeCashFlowModal();
    renderAll();
    showToast((cfAmount > 0 ? '入金' : '出金') + ' ' + fmt(Math.abs(cfAmount)) + ' 已记录');
  } catch(e) { showToast('记录失败：' + (e.message || e)); }
}

// ===================== 基金净值法收益（已修正现金流） =====================

const chartMap = {};
let returnMode = '1y';
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
async function recordNav() {
  const today = todayCN();
  // 自动净值只提交意图，由服务端在账户锁内按首页资产基准计算；浏览器不写自算NAV。
  try {
    const result = await window.siteApi.requestRaw('/api/nav/' + today + '?version=' + (dataVersion != null ? dataVersion : ''), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: currentAccount, calculationMode: 'system' }),
      timeoutMs: 0
    });
    if (!result.response) { showToast(result.error || '网络异常'); return; }
    const response = result.response;
    const _j2 = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      // 2026-10-27 修复：409（版本冲突/资产基准不完整/并发）后同步一次最新版本号，
      // 避免带着旧版本号连环失败导致净值一直写不进
      if (response.status === 409) {
        try {
          const rr = await fetch(api('/api/data/' + encodeURIComponent(currentAccount)));
          const jj = await rr.json().catch(function () { return {}; });
          if (jj.data && typeof jj.data.version === 'number') dataVersion = jj.data.version;
        } catch (e2) {}
      }
      const msg = _j2.error || '净值基准不完整，未保存';
      showToast(msg.indexOf('基准不完整') >= 0
        ? '今日净值未自动记录：' + msg + '（补齐初始净值或等持仓取得行情后，再点「刷新行情」即可补记）'
        : msg);
      return;
    }
    if (_j2.data) {
      syncDataVersions(_j2.data);
      data.navHistory = _j2.data.navHistory;
      data.performanceHistory = _j2.data.performanceHistory;
      data.navReturnTotals = _j2.data.navReturnTotals;
      // 只同步服务端确认的资产/现金标量，保留刚刷新的逐笔持仓报价。
      ['cash', 'hkRate', 'totalAsset', 'authoritativeTotalAsset', 'authoritativePositionValue', 'authoritativeCash',
        'authoritativeInvested', 'cashConfirmed', 'cashEstimatedDelta', 'cashIncludesEstimates', 'cashDataIncomplete',
        'cashIncomeState', 'cashIncomePolicy'].forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(_j2.data, key)) data[key] = _j2.data[key];
      });
      if (typeof TOTAL_ASSET !== 'undefined') TOTAL_ASSET = _j2.data.totalAsset;
      if (_j2.data.navAttribution) data.navAttribution = _j2.data.navAttribution;
      if (_j2.data.totalAssetSource) data.totalAssetSource = _j2.data.totalAssetSource;
    }
  } catch (error) { console.warn('recordNav PUT failed:', error); }
}

function renderReturnsStats() {
  const container = document.getElementById('returns-section') || document.getElementById('page-dashboard');
  
  // 首次渲染生成结构
  if (document.getElementById('returns-section') && !document.querySelector('#returns-section .chart-box')) {
    document.getElementById('returns-section').innerHTML =
      '<div class="chart-box u-mb-20" >' +
        '<div class="chart-title">' +
          '<h3>收益走势对比</h3>' +
          '<div data-style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
            '<button class="period-btn" data-mode="mtd" data-act="switchReturnMode" data-arg1="mtd">本月</button>' +
            '<button class="period-btn" data-mode="q3" data-act="switchReturnMode" data-arg1="q3">近三个月</button>' +
            '<button class="period-btn" data-mode="ytd" data-act="switchReturnMode" data-arg1="ytd">今年</button>' +
            '<button class="period-btn active" data-mode="1y" data-act="switchReturnMode" data-arg1="1y">近一年</button>' +
            '<button class="period-btn" data-mode="2y" data-act="switchReturnMode" data-arg1="2y">近两年</button>' +
            '<button class="period-btn" data-mode="all" data-act="switchReturnMode" data-arg1="all">全部</button>' +
          '</div>' +
        '</div>' +
        '<div data-style="margin-bottom:10px;font-size:13px;">' +
          '<span id="ret-total-return" data-style="font-weight:700;font-size:16px;">¥0.00</span>' +
          '<span id="ret-total-return-pct" data-style="font-weight:600;margin-left:6px;"></span>' +
          '<span data-style="margin-left:14px;color:#6e6e6e;">📊 净值 <span id="ret-nav">1.0000</span></span>' +
          '<span class="u-ml-10 u-c-muted">📅 <span id="ret-nav-date">无记录</span></span>' +
          '<span class="u-ml-10 u-c-muted">记录 <span id="ret-days">0</span> 天</span>' +
        '</div>' +
        '<div data-style="margin-bottom:10px;font-size:12px;color:#6e6e6e;">对比指数:' +
          '<button class="period-btn index-toggle active" data-idx="沪深300" data-act="toggleIndex" data-arg1="沪深300" data-style="font-size:11px;padding:2px 10px;margin-left:4px;">沪深300</button>' +
          '<button class="period-btn index-toggle active u-badge-pill" data-idx="上证指数" data-act="toggleIndex" data-arg1="上证指数" >上证指数</button>' +
          '<button class="period-btn index-toggle active u-badge-pill" data-idx="中证全指" data-act="toggleIndex" data-arg1="中证全指" >中证全指</button>' +
          '<button class="period-btn index-toggle active u-badge-pill" data-idx="恒生指数" data-act="toggleIndex" data-arg1="恒生指数" >恒生指数</button>' +
        '</div>' +
        '<div class="chart-canvas-wrap" data-style="height:300px;"><canvas id="chart-returns"></canvas></div>' +
      '</div>';
  }
  
  // 更新数值
  var el = function(id) { return document.getElementById(id); };
  if (!el('ret-total-return')) return;
  
  const displayNavs = getPerformanceNavHistory();
  if (displayNavs.length === 0) {
    document.getElementById('ret-total-return').textContent = '¥0';
    document.getElementById('ret-total-return').style.color = '#999';
    document.getElementById('ret-total-return-pct').textContent = '无数据';
    document.getElementById('ret-nav').textContent = '1.0000';
    document.getElementById('ret-nav-date').textContent = '无记录';
    document.getElementById('ret-days').textContent = '0';
    return;
  }
  const first = displayNavs[0];
  const last = displayNavs[displayNavs.length - 1];
  const initAsset = first.totalAsset;
  const curAsset = last.totalAsset;

  // 计算调整后的真实收益：考虑所有现金流
  // 累计收益 = 当前总资产 - 初始资产 - 累计净入金
  var totalCashFlow = 0;
  if (data.cashFlows) {
    data.cashFlows.filter(NavMath.isExternalTransfer).forEach(function (cf) { if (cf.date > first.date && cf.date <= last.date) totalCashFlow += cf.amount; });
  }
  // 调整后的初始资产：初始资产 + 累计现金流
  var adjustedInit = initAsset + totalCashFlow;
  var totalReturn = adjustedInit > 0
    ? curAsset - adjustedInit
    : curAsset - initAsset;
  // 调整后的收益率 = 最新净值 - 1（NAV 已通过 corrected formula 计算）
  var totalReturnPct = last.nav == null ? null : (last.nav - 1) * 100;

  var sign = totalReturn >= 0 ? '+' : '';
  document.getElementById('ret-total-return').textContent = curAsset == null || initAsset == null ? '—' : (totalReturn < 0 ? '-' : '') + fmt(Math.abs(totalReturn));
  document.getElementById('ret-total-return').style.color = totalReturn >= 0 ? '#137333' : '#d93025';
  document.getElementById('ret-total-return-pct').textContent = totalReturnPct == null ? '—' : (totalReturnPct >= 0 ? '+' : '') + totalReturnPct.toFixed(2) + '%';
  document.getElementById('ret-total-return-pct').style.color = totalReturn >= 0 ? '#137333' : '#d93025';

  var navEl = document.getElementById('ret-nav');
  navEl.textContent = last.nav == null ? '—' : Number(last.nav).toFixed(4);
  navEl.style.color = last.nav >= 1 ? '#137333' : '#d93025';
  document.getElementById('ret-nav-date').textContent = last.date;
  document.getElementById('ret-days').textContent = data.navHistory.length;
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

// 从指定日期往前（含当天）找第一个有值的交易日收盘，用于把指数对齐到净值（可能落在周末）的日期
function carryBackward(map, dateStr) {
  const d = new Date(dateStr);
  for (let i = 0; i < 14; i++) {
    const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (map[ds] != null) return map[ds];
    d.setDate(d.getDate() - 1);
  }
  return null;
}

// 优先用本地快照构造指数序列（按净值日期对齐，周日/非交易日 carry-forward 到之前最近交易日收盘）
function getIndexSeries(name, navData) {
  if (!data.indexHistory || !data.indexHistory.length) return null;
  var map = {};
  data.indexHistory.forEach(function (h) { if (h[name] != null) map[h.date] = h[name]; });
  // 基准日：净值首日若为非交易日(周末/节假日)，回退到最近的前一个交易日(含该周周五)
  var baseDate = resolveBaselineDate(navData[0].date, map);
  if (baseDate == null) return null;
  var firstClose = map[baseDate];
  return navData.map(function (d) {
    var v = carryBackward(map, d.date);
    return { date: d.date, val: v == null ? null : v / firstClose };
  });
}

// 共享：净值 vs 宽基指数 走势对比图（总览页与收益页共用，改一处两处同步）
// 周期模式 → 起点日期(YYYY-MM-DD)：本月=本月初，今年=今年初，近三个月/近一年/近两年=近N天
function periodStart(mode) {
  const t = new Date();
  const y = t.getFullYear(), m = t.getMonth();
  if (mode === 'mtd') return y + '-' + String(m + 1).padStart(2, '0') + '-01';
  if (mode === 'ytd') return y + '-01-01';
  const back = { q3: 90, '1y': 365, '2y': 730 }[mode];
  if (back) {
    const s = new Date(t);
    s.setDate(s.getDate() - back);
    return s.getFullYear() + '-' + String(s.getMonth() + 1).padStart(2, '0') + '-' + String(s.getDate()).padStart(2, '0');
  }
  return '';
}

// 生成 [start, end] 内所有周五(UTC 周五=5)的 ISO 日期（升序）—— 用于走势图「周五稀疏显示」
function genFridayLabels(startStr, endStr) {
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

// 从每日全量序列（升序 [{date, value}]，value 非空）中，对每个展示标签取「该日或之前最近有值日」的值
// —— 走势图按周五显示，但取值仍用每日全量真实数据（缺口向前补齐，避免凭空插值）
function carryForwardTo(entries, labels) {
  const res = [];
  let p = 0;
  const n = entries.length;
  labels.forEach(function (label) {
    while (p < n && entries[p].date <= label) p++;
    res.push(p > 0 ? entries[p - 1].value : null);
  });
  return res;
}

async function renderNavVsIndexChart(canvasId, opts) {
  opts = opts || {};
  const period = opts.period || 0;
  const mode = opts.mode || '';
  if (getPerformanceNavHistory().length < 2) {
    if (chartMap[canvasId]) { chartMap[canvasId].destroy(); chartMap[canvasId] = null; }
    return;
  }

  let navData = getPerformanceNavHistory();
  if (mode) {
    const start = periodStart(mode);
    if (start) navData = navData.filter(function (d) { return d.date >= start; });
  } else if (period > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - period);
    navData = navData.filter(function (d) { return new Date(d.date) >= cutoff; });
  }
  if (navData.length < 2) return;

  // 每日全量显示（曲线细密真实），X 轴靠 maxTicksLimit:12 控制标签密度
  const labels = navData.map(function (d) { return d.date; });
  // 归一：首日净值 = 1.0
  var navBaseVal = navData[0].nav == null ? null : +(Number(navData[0].nav).toFixed(4));
  var navVals = navData.map(function (d) {
    return navBaseVal > 0 && d.nav != null ? +(Number(d.nav) / navBaseVal).toFixed(4) : null;
  });

  // 指数序列只使用本地快照；缺失时等待后台 index_recent 任务补齐，不在页面请求时访问外部源。
  var hs300Data = getIndexSeries('沪深300', navData) || [];
  var shData = getIndexSeries('上证指数', navData) || [];
  var zzData = getIndexSeries('中证500', navData) || [];
  var hsidata = getIndexSeries('恒生指数', navData) || [];

  var datasets = [{
    label: '持仓净值',
    data: navVals,
    borderColor: '#1a237e',
    backgroundColor: 'rgba(26,35,126,.08)',
    fill: true,
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2.5,
    spanGaps: true
  }];

  // 沪深300
  if (hs300Data.length > 0) {
    var hs300Map = {};
    hs300Data.forEach(function (d) { hs300Map[d.date] = d.val; });
    var hs300Vals = navData.map(function (d) { return hs300Map[d.date] || null; });
    datasets.push({
      label: '沪深300', data: hs300Vals,
      borderColor: '#d93025', backgroundColor: 'transparent',
      tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      spanGaps: true, hidden: !indexVisibility['沪深300']
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
      tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      spanGaps: true, hidden: !indexVisibility['上证指数']
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
      tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      spanGaps: true, hidden: !indexVisibility['中证全指']
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
      tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      spanGaps: true, hidden: !indexVisibility['恒生指数']
    });
  }

  const el = document.getElementById(canvasId);
  if (!el) return;
  const ctx = el.getContext('2d');
  if (chartMap[canvasId]) chartMap[canvasId].destroy();

  chartMap[canvasId] = new Chart(ctx, {
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
        tooltip: appChartTooltip({
          callbacks: {
            label: function (ctx) {
              if (ctx.raw == null) return '';
              var pct = ((ctx.raw - 1) * 100).toFixed(2);
              var prefix = parseFloat(pct) >= 0 ? '+' : '';
              return ' ' + ctx.dataset.label + ': ' + prefix + pct + '%';
            }
          }
        })
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

// 总览页包装：带统计数字 + 周期切换
function renderReturnsChart() {
  renderReturnsStats();
  renderNavVsIndexChart('chart-returns', { mode: returnMode });
}

function switchReturnMode(mode) {
  returnMode = mode;
  document.querySelectorAll('#returns-section [data-mode]').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.querySelector('#returns-section [data-mode="' + mode + '"]');
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
  if (chartMap['chart-returns']) {
    var ds = chartMap['chart-returns'].data.datasets.find(function (d) { return d.label === name; });
    if (ds) ds.hidden = !indexVisibility[name];
    chartMap['chart-returns'].update();
  }
}
