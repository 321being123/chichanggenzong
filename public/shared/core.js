// ============================================================
// shared/core.js – 持仓管理共享逻辑
// 被 仓位管理.html (localStorage) 和 index.html (fetch API) 共用
// 
// 全局变量（由 HTML 脚本定义）:
//   data             – 当前账户持仓数据对象
//   currentAccount   – 当前账户名称
//   priceChangeMap   – 行情涨跌幅缓存
//   PRICE_CACHE      – 行情报价缓存
//   accounts         – 账户列表
// ============================================================

// ===================== 安全工具 =====================

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3500);
}

// ===================== 行情 API =====================

async function fetchQuoteFromServer(code) {
  try {
    const r = await fetch(api('/api/quote/' + encodeURIComponent(code)));
    if (r.ok) {
      const data = await r.json();
      if (data && data.price) return data;
    }
  } catch(e) {}
  return null;
}

async function fetchQuote(code, forceRefresh) {
  if (!code) return null;
  if (forceRefresh === undefined) forceRefresh = false;
  const key = code.trim().toUpperCase().replace(/\s/g, '');
  const now = Date.now();
  // 缓存30秒
  if (!forceRefresh && PRICE_CACHE[key] && (now - PRICE_CACHE[key].time < 30000))
    return PRICE_CACHE[key].data;

  // 特殊处理: 搜特退债
  if (key === '404002') {
    PRICE_CACHE[key] = {
      data: { price: null, name: '搜特退债', code: key, change: null },
      time: now
    };
    return PRICE_CACHE[key].data;
  }

  // 统一走服务端行情代理
  let result = await fetchQuoteFromServer(key);
  if (result && result.price) {
    PRICE_CACHE[key] = { data: result, time: now };
    return result;
  }
  return null;
}

async function fetchHKRate() {
  try {
    const r = await fetch(api('/api/hkrate'));
    if (r.ok) {
      const d = await r.json();
      if (d && d.rate > 0) return d.rate;
    }
  } catch(e) {}
  return null;
}

async function refreshAllPrices() {
  const codes = [...new Set(data.positions.map(p => p.code).filter(Boolean))];
  if (codes.length === 0) { showToast('没有持仓需要刷新'); return; }
  showToast('正在获取 ' + codes.length + ' 只行情...');
  let ok = 0, fail = 0;

  // 获取港币→人民币汇率（港股通用）
  var hkRate = await fetchHKRate();
  if (!hkRate || hkRate <= 0) hkRate = 0.868;
  data.hkRate = hkRate; // 全局汇率，供 getMarketValue 使用
  
  // 并发请求，每次10只
  const concurrency = 10;
  for (let i = 0; i < codes.length; i += concurrency) {
    const batch = codes.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(c => fetchQuote(c, true)));
    results.forEach((result, idx) => {
      const c = batch[idx];
      const pos = data.positions.find(p => p.code === c);
      if (pos) {
        if (result && result.price) {
          var price = result.price;
          // 港股存港币价格，不转汇率
          pos.price = price;
          if (result.name && !pos.name) pos.name = result.name;
          priceChangeMap[c] = result.change;
          ok++;
        } else {
          if (c === '404002') priceChangeMap['404002'] = 0;
          if (!pos.type) {
            const rec = recognizeCode(c);
            if (rec) { pos.type = rec.type; pos.subtype = rec.subtype; }
          }
          fail++;
        }
        if (!pos.type) {
          const rec = recognizeCode(c);
          if (rec) { pos.type = rec.type; pos.subtype = rec.subtype; }
        }
      }
    });
  }
  // 保存涨跌幅到数据文件，页面刷新后自动恢复
  data.changes = {}; Object.keys(priceChangeMap).forEach(function(k) { data.changes[k] = priceChangeMap[k]; });
  saveData(); renderAll(); recordNav(); renderReturnsChart();
  const failedCodes = codes.filter(c => {
    const p = data.positions.find(x => x.code === c);
    return p && (!p.price || !p.name);
  });
  if (failedCodes.length > 0) {
    showToast('行情刷新: ' + ok + ' 只成功, ' + fail + ' 只暂无数据: ' +
      failedCodes.slice(0, 6).join(',') +
      (failedCodes.length > 6 ? '...' : ''));
  } else {
    showToast('行情刷新完成: ' + ok + ' 只全部成功');
  }
  // 记录每日收盘价
  saveDailyPricesToDB();
}

/**
 * 完整刷新：拉行情 + 反推现金 + 保存 + 重渲染
 * 供"刷新按钮/F5/自动刷新"统一调用
 */
async function doRefresh() {
  // 总资产持久化（供净值走势展示），须在 refreshAllPrices 之前设置，
  // 使其内部的统一 saveData 一并保存，避免双重写入/重绘
  if (typeof TOTAL_ASSET !== 'undefined' && TOTAL_ASSET > 0) {
    data.totalAsset = TOTAL_ASSET;
  }
  // refreshAllPrices 内部已统一 saveData + renderAll + recordNav + renderReturnsChart
  await refreshAllPrices();
}

async function saveDailyPricesToDB() {
  try {
    // 只在收盘后才记录（A股15:00 / 港股16:00），且今天已记录过就跳过
    if (isMarketOpen()) return;
    if (data._dailyPricesSaved === todayCN()) return;
    var prices = data.positions.map(function(p) {
      return { code: p.code, name: p.name, price: p.price || 0 };
    }).filter(function(p) { return p.code && p.price > 0; });
    if (prices.length === 0) return;
    await fetch(api('/api/daily-prices/' + encodeURIComponent(currentAccount)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prices: prices, date: todayCN() })
    });
    data._dailyPricesSaved = todayCN();
    saveData();
  } catch(e) {}
}

// ===================== 代码输入处理 =====================

let codeInputTimer = null;

function onCodeInput(code) {
  clearTimeout(codeInputTimer);
  if (code.length < 4) return;
  codeInputTimer = setTimeout(async () => {
    const rec = recognizeCode(code);
    if (rec) {
      document.getElementById('quick-type').value = rec.type;
      document.getElementById('quick-subtype').value = rec.subtype;
    }
    const quote = await fetchQuote(code);
    if (quote) {
      document.getElementById('quick-name').value = quote.name || '';
      document.getElementById('quick-price').value = quote.price
        ? '¥' + quote.price.toFixed(3) : '获取中...';
      document.getElementById('quick-name-hint').textContent = '已获取';
      document.getElementById('quick-price').readOnly = false;
    }
    document.getElementById('quick-detail').style.display = 'grid';
    calcQuick();
  }, 500);
}

function onTradeCodeInput(code) {
  clearTimeout(codeInputTimer);
  if (code.length < 4) return;
  codeInputTimer = setTimeout(async () => {
    const rec = recognizeCode(code);
    if (rec) {
      document.getElementById('trade-type').value = rec.type;
      document.getElementById('trade-subtype').value = rec.subtype;
      document.getElementById('trade-type-hint').textContent = rec.type;
      document.getElementById('trade-subtype-hint').textContent = rec.subtype;
    }
    const quote = await fetchQuote(code);
    if (quote) {
      document.getElementById('trade-name').value = quote.name || '';
      document.getElementById('trade-name-hint').textContent = '已获取';
      if (!document.getElementById('trade-price').value) {
        document.getElementById('trade-price').value = quote.price || '';
      }
    }
  }, 500);
}

function onModalCodeInput(code) {
  clearTimeout(codeInputTimer);
  if (code.length < 4) return;
  codeInputTimer = setTimeout(async () => {
    const rec = recognizeCode(code);
    if (rec) {
      document.getElementById('modal-type').value = rec.type;
      document.getElementById('modal-subtype').value = rec.subtype;
      document.getElementById('modal-type-hint').textContent = '自动: ' + rec.type;
      document.getElementById('modal-subtype-hint').textContent = '自动: ' + rec.subtype;
    }
    const quote = await fetchQuote(code);
    if (quote) {
      document.getElementById('modal-name').value = quote.name || '';
      document.getElementById('modal-price').value = quote.price || '';
      document.getElementById('modal-price-hint').textContent =
        '实时: ¥' + quote.price.toFixed(3);
    }
  }, 500);
}

function calcQuick() {
  const price = parseFloat(document.getElementById('quick-price').value.replace('¥', '')) || 0;
  const qty = parseInt(document.getElementById('quick-qty').value) || 0;
  const mv = price * qty;
  document.getElementById('quick-mv').value = mv > 0
    ? fmt(mv).replace('¥', '')
    : '-';
}

function addQuickPosition() {
  const code = classifyCode.normalizeCode(document.getElementById('quick-code').value.trim());
  const name = document.getElementById('quick-name').value.trim();
  const qty = parseInt(document.getElementById('quick-qty').value);
  const priceVal = document.getElementById('quick-price').value.replace('¥', '').trim();
  const price = parseFloat(priceVal);
  const type = document.getElementById('quick-type').value;
  const subtype = document.getElementById('quick-subtype').value;

  if (!code || !qty || qty <= 0) { showToast('请填写代码和数量'); return; }
  if (isNaN(price) || price <= 0) { showToast('请输入有效价格（可手动填写）'); return; }

  data.positions.push({
    id: uid(), code, name: name,
    price: price, quantity: qty,
    cost: price, type: type, subtype: subtype, note: ''
  });
  saveData();
  renderAll();
  showToast('已添加 ' + (name || code) + ' ' + qty + (subtype === '可转债' ? '张' : '股'));

  document.getElementById('quick-code').value = '';
  document.getElementById('quick-name').value = '';
  document.getElementById('quick-qty').value = '';
  document.getElementById('quick-price').value = '';
  document.getElementById('quick-type').value = '';
  document.getElementById('quick-subtype').value = '';
  document.getElementById('quick-mv').value = '';
  document.getElementById('quick-detail').style.display = 'none';
  document.getElementById('quick-name-hint').textContent = '自动获取';
}

// ===================== 粘贴导入 =====================

function pasteImport() {
  document.getElementById('paste-import-area').style.display = 'block';
}

function executePasteImport() {
  const raw = document.getElementById('paste-input').value.trim();
  if (!raw) { showToast('请粘贴数据'); return; }
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0, skipped = 0;
  lines.forEach(line => {
    const parts = line.split(/\s+/);
    if (parts.length < 3) { skipped++; return; }
    const code = parts[0].replace(/[.](SH|SZ|HK|US)$/i, '');
    const type = parts[1] === '债权' ? '债权' : '股权';
    const subtype = parts[2] || (type === '股权' ? 'A股' : type === '现金' ? '现金' : '可转债');
    const qty = parseInt(parts[3]) || 0;
    if (data.positions.some(p => p.code === code)) { skipped++; return; }
    data.positions.push({
      id: uid(), code: code, name: '', price: null,
      quantity: qty, cost: null, type: type, subtype: subtype, note: ''
    });
    added++;
  });
  saveData(); renderAll();
  document.getElementById('paste-import-area').style.display = 'none';
  showToast('已导入 ' + added + ' 只' + (skipped > 0 ? '，' + skipped + ' 只跳过' : ''));
  doRefresh();
}

// ===================== 统计卡片渲染 =====================

function renderStats() {
  var s = calcSummary();
  var container = document.getElementById('stats-container');
  if (!container) return;
  
  // 计算今日涨跌（对比 nav_history 最近两条记录）
  var changeAmt = 0, changePct = 0, hasChange = false;
  if (data.navHistory && data.navHistory.length >= 2) {
    var last = data.navHistory[data.navHistory.length - 1];
    var prev = data.navHistory[data.navHistory.length - 2];
    changeAmt = s.total - prev.totalAsset;
    changePct = prev.totalAsset > 0 ? (changeAmt / prev.totalAsset * 100) : 0;
    hasChange = true;
  }
  
  // 首次渲染生成卡片结构
  if (!container.querySelector('.stat-card')) {
    container.innerHTML = 
      '<div class="stat-card">' +
        '<div class="stat-top">' +
          '<div><div class="label">总资产</div><div class="value" id="stat-total"></div><div class="sub" id="stat-total-sub"></div><div class="sub" id="stat-change" style="font-size:13px;"></div></div>' +
          '<div class="stat-icon icon-bg-blue">💰</div>' +
        '</div>' +
        '<div class="bar-wrap"><div class="bar-fill" id="bar-total" style="width:100%;background:#1a73e8;"></div></div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-top">' +
          '<div><div class="label">股权资产</div><div class="value" id="stat-equity"></div><div class="sub" id="stat-equity-pct"></div></div>' +
          '<div class="stat-icon icon-bg-red">📈</div>' +
        '</div>' +
        '<div class="bar-wrap"><div class="bar-fill" id="bar-equity" style="width:0%;background:#d93025;"></div></div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-top">' +
          '<div><div class="label">债权资产</div><div class="value" id="stat-debt"></div><div class="sub" id="stat-debt-pct"></div></div>' +
          '<div class="stat-icon icon-bg-orange">📊</div>' +
        '</div>' +
        '<div class="bar-wrap"><div class="bar-fill" id="bar-debt" style="width:0%;background:#e37400;"></div></div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-top">' +
          '<div><div class="label">现金余额</div><div class="value" id="stat-cash"></div><div class="sub" id="stat-cash-pct"></div></div>' +
          '<div class="stat-icon icon-bg-green">💵</div>' +
        '</div>' +
        '<div class="bar-wrap"><div class="bar-fill" id="bar-cash" style="width:0%;background:#137333;"></div></div>' +
      '</div>';
  }
  
  // 更新数值
  var el = function(id) { return document.getElementById(id); };
  if (el('stat-total')) {
    el('stat-total').textContent = fmt(s.total);
    // 涨跌颜色
    if (hasChange) {
      var isUp = changeAmt >= 0;
      el('stat-total').style.color = isUp ? '#d93025' : '#137333';
    }
  }
  if (el('stat-total-sub')) el('stat-total-sub').textContent = '持仓市值 ' + fmt(s.total - s.cash) + ' + 现金 ' + fmt(s.cash);
  if (el('stat-change')) {
    if (hasChange) {
      var arrow = changeAmt >= 0 ? '▲' : '▼';
      var color = changeAmt >= 0 ? '#d93025' : '#137333';
      el('stat-change').innerHTML = '<span style="color:' + color + ';">' + arrow + ' ' + fmt(Math.abs(changeAmt)) + ' (' + (changeAmt >= 0 ? '+' : '') + changePct.toFixed(2) + '%)</span>';
    } else {
      el('stat-change').textContent = '';
    }
  }
  if (el('stat-equity')) el('stat-equity').textContent = fmt(s.equityVal);
  if (el('stat-equity-pct')) el('stat-equity-pct').textContent = '占比 ' + fmtPct(s.equityPct);
  if (el('stat-debt')) el('stat-debt').textContent = fmt(s.debtVal);
  if (el('stat-debt-pct')) el('stat-debt-pct').textContent = '占比 ' + fmtPct(s.debtPct);
  if (el('stat-cash')) el('stat-cash').textContent = fmt(s.cash);
  if (el('stat-cash-pct')) el('stat-cash-pct').textContent = '占比 ' + fmtPct(s.cashPct);
  if (el('bar-equity')) el('bar-equity').style.width = (s.equityPct * 100) + '%';
  if (el('bar-debt')) el('bar-debt').style.width = (s.debtPct * 100) + '%';
  if (el('bar-cash')) el('bar-cash').style.width = (s.cashPct * 100) + '%';
}

// ===================== 饼图渲染 =====================

let chartCategory = null;
let chartSubtype = null;

function renderCharts() {
  try {
    const s = calcSummary();
    const chartEl = document.getElementById('chart-category');
    if (!chartEl) return;
    if (typeof Chart === 'undefined') return;
    const ctx1 = chartEl.getContext('2d');
    if (chartCategory) chartCategory.destroy();
  // 类别饼图：动态聚合持仓类型 + 现金归入其类型
  var typeMap = {};
  data.positions.forEach(p => {
    var mv = getMarketValue(p);
    var key = p.type || '其他';
    typeMap[key] = (typeMap[key] || 0) + mv;
  });
  // 现金归入其类型
  var cashAmt = Number(data.cash) || 0;
  if (cashAmt > 0) {
    var ct = data.cashType || '现金';
    typeMap[ct] = (typeMap[ct] || 0) + cashAmt;
  }
  var typeLabels = Object.keys(typeMap);
  var typeValues = typeLabels.map(k => typeMap[k]);
  var typeColors = ['#d93025', '#1a73e8', '#137333', '#e37400', '#7b1fa2', '#00838f'];

  chartCategory = new Chart(ctx1, {
    type: 'doughnut',
    data: {
      labels: typeLabels,
      datasets: [{
        data: typeValues,
        backgroundColor: typeColors.slice(0, typeLabels.length),
        borderWidth: 3,
        borderColor: '#fff',
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            padding: 14,
            font: { size: 12, weight: '500' },
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: '#323232',
          cornerRadius: 8,
          padding: 10,
          titleFont: { size: 13 },
          bodyFont: { size: 12 },
          callbacks: {
            label: function (ctx) {
              var v = ctx.raw;
              var p = s.total > 0 ? (v / s.total * 100).toFixed(1) : 0;
              return ' ' + ctx.label + ': ' + fmt(v) + ' (' + p + '%)';
            }
          }
        }
      }
    }
  });

  // 细类饼图
  const subtypeMap = {};
  data.positions.forEach(p => {
    const mv = getMarketValue(p);
    const key = p.subtype || (p.type === '股权' ? '股权' : '债权');
    subtypeMap[key] = (subtypeMap[key] || 0) + mv;
  });
  // 现金归入其细类
  if (cashAmt > 0) {
    var cs = data.cashSubtype || '现金';
    subtypeMap[cs] = (subtypeMap[cs] || 0) + cashAmt;
  }
  const subtypeLabels = Object.keys(subtypeMap);
  const subtypeValues = subtypeLabels.map(k => subtypeMap[k]);
  const subtypeColors = ['#d93025', '#1a73e8', '#137333', '#e37400', '#7b1fa2', '#00838f', '#c62828', '#283593'];

  const ctx2 = document.getElementById('chart-subtype').getContext('2d');
  if (chartSubtype) chartSubtype.destroy();
  chartSubtype = new Chart(ctx2, {
    type: 'doughnut',
    data: {
      labels: subtypeLabels,
      datasets: [{
        data: subtypeValues,
        backgroundColor: subtypeColors.slice(0, subtypeLabels.length),
        borderWidth: 3,
        borderColor: '#fff',
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            padding: 14,
            font: { size: 12, weight: '500' },
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: '#323232',
          cornerRadius: 8,
          padding: 10,
          titleFont: { size: 13 },
          bodyFont: { size: 12 },
          callbacks: {
            label: function (ctx) {
              const p = s.total > 0 ? (ctx.raw / s.total * 100).toFixed(1) : 0;
              return ' ' + ctx.label + ': ' + fmt(ctx.raw) + ' (' + p + '%)';
            }
          }
        }
      }
    }
  });
  } catch(e) {}
}

// ===================== 持仓表格渲染 =====================

// 排序状态（全局）
let sortState = { col: null, dir: 'asc' };
// 筛选状态（全局）
let filterState = { type: '', subtype: '' };

function setSort(col) {
  if (sortState.col === col) {
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.col = col;
    sortState.dir = 'asc';
  }
  renderPositionsTable('positions-table');
  renderPositionsTable('topn-table');
}

function setFilter(type, val) {
  filterState[type] = val;
  renderPositionsTable('positions-table');
  renderPositionsTable('topn-table');
}

function renderPositionsTable(targetId, limit) {
  const el = document.getElementById(targetId);
  if (!el) return;
  let list = [...data.positions];

  // 筛选（仅全量表格，topN 不筛选）
  if (!limit) {
    if (filterState.type) list = list.filter(p => p.type === filterState.type);
    if (filterState.subtype) list = list.filter(p => p.subtype === filterState.subtype);
  }

  // 排序
  if (sortState.col) {
    const col = sortState.col;
    list.sort((a, b) => {
      let va, vb;
      if (col === 'xh') { va = list.indexOf(a); vb = list.indexOf(b); }
      else if (col === 'code') { va = a.code || ''; vb = b.code || ''; }
      else if (col === 'name') { va = a.name || ''; vb = b.name || ''; }
      else if (col === 'price') { va = a.price || 0; vb = b.price || 0; }
      else if (col === 'qty') { va = a.quantity || 0; vb = b.quantity || 0; }
      else if (col === 'mv') {
        va = getMarketValue(a);
        vb = getMarketValue(b);
      }
      else if (col === 'pct') {
        const t = calcSummary().total;
        va = t > 0 ? getMarketValue(a) / t : 0;
        vb = t > 0 ? getMarketValue(b) / t : 0;
      }
      else if (col === 'type') { va = a.type || ''; vb = b.type || ''; }
      else if (col === 'subtype') { va = a.subtype || ''; vb = b.subtype || ''; }
      else if (col === 'chg') {
        va = priceChangeMap[a.code] || -999;
        vb = priceChangeMap[b.code] || -999;
      }
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortState.dir === 'asc' ? cmp : -cmp;
    });
  }

  // limit 截取（用于总览页 topN）
  if (limit) list = list.slice(0, limit);

  var cashAmt = Number(data.cash) || 0;
  if (list.length === 0 && cashAmt <= 0) {
    el.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>暂无持仓数据' +
      (filterState.type || filterState.subtype ? '（筛选条件下无结果）' : '') +
      '</p></div>';
    return;
  }

  // 筛选栏（仅全量表格）
  let filterBar = '';
  if (!limit) {
    const types = [...new Set(data.positions.map(p => p.type).filter(Boolean))];
    const subtypes = [...new Set(data.positions.map(p => p.subtype).filter(Boolean))];
    filterBar = '<div class="filter-bar">' +
      '<span class="filter-label">筛选:</span>' +
      '<select onchange="setFilter(\'type\',this.value)">' +
      '<option value="">全部类型</option>' +
      types.map(t => '<option value="' + t + '"' + (filterState.type === t ? ' selected' : '') + '>' + t + '</option>').join('') +
      '</select>' +
      '<select onchange="setFilter(\'subtype\',this.value)">' +
      '<option value="">全部细类</option>' +
      subtypes.map(s => '<option value="' + s + '"' + (filterState.subtype === s ? ' selected' : '') + '>' + s + '</option>').join('') +
      '</select>' +
      ((filterState.type || filterState.subtype)
        ? '<button class="btn btn-outline btn-sm" onclick="filterState={type:\'\',subtype:\'\'};renderPositionsTable(\'positions-table\');renderPositionsTable(\'topn-table\')">清除筛选</button>'
        : '') +
      '<button class="btn btn-success btn-sm" style="margin-left:auto;" onclick="exportToExcel()">导出EXCEL</button>' +
      '<span style="color:#bbb;">' + list.length + ' / ' + data.positions.length + ' 只</span>' +
      '</div>';
  }

  var html = filterBar + '<table><thead><tr>' +
    '<th style="width:40px;" class="sortable" onclick="setSort(\'xh\')">序号' + sortArrow('xh') + '</th>' +
    '<th class="sortable" onclick="setSort(\'code\')">代码' + sortArrow('code') + '</th>' +
    '<th class="sortable" onclick="setSort(\'name\')">名称' + sortArrow('name') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(\'price\')">现价' + sortArrow('price') + '</th>' +
    '<th class="text-right sortable" style="width:70px;" onclick="setSort(\'chg\')">涨跌' + sortArrow('chg') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(\'qty\')">数量' + sortArrow('qty') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(\'mv\')">市值' + sortArrow('mv') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(\'pct\')">比例' + sortArrow('pct') + '</th>' +
    '<th class="sortable" onclick="setSort(\'type\')">类型' + sortArrow('type') + '</th>' +
    '<th class="sortable" onclick="setSort(\'subtype\')">细类' + sortArrow('subtype') + '</th>' +
    (limit ? '' : '<th class="text-center">操作</th>') +
    '</tr></thead><tbody>';

  const total = calcSummary().total;
  list.forEach((p, idx) => {
    const mv = getMarketValue(p);
    const pct = total > 0 ? (mv / total * 100).toFixed(2) : 0;
    const typeTag = getTypeTag(p.type);
    const subtypeTag = getSubtypeTag(p.subtype);

    // 判断行情数据状态
    //   priceChangeMap[p.code] === undefined → 完全没有获取过（显示 ⟳）
    //   priceChangeMap[p.code] === null     → 有缓存价格但无实时涨跌（灰色显示）
    //   priceChangeMap[p.code] !== null     → 有实时行情数据（红/绿着色）
    var hasRealTime = priceChangeMap[p.code] !== undefined && priceChangeMap[p.code] !== null;
    var hasCachedPrice = p.price != null && p.price > 0;

    var priceStyle = '';
    if (hasCachedPrice) {
      priceStyle = hasRealTime
        ? (priceChangeMap[p.code] >= 0 ? 'color:#d93025;' : 'color:#137333;')
        : 'color:#999;';
    }
    var chgStyle = '#999;';
    var chgText = '-';
    if (hasRealTime) {
      chgStyle = priceChangeMap[p.code] >= 0 ? 'color:#d93025;' : 'color:#137333;';
      var chgVal = priceChangeMap[p.code];
      chgText = chgVal != null
        ? (chgVal >= 0 ? '+' : '') + chgVal.toFixed(2) + '%'
        : '--';
    }

    // 价格显示：有缓存价就显示，无任何数据才显示 ⟳
    var priceCurrency = p.subtype === '港股' ? 'HK$' : '¥';
    var priceDisplay = hasCachedPrice
      ? priceCurrency + Number(p.price).toFixed(3)
      : '<span style="color:#ccc;" title="无价格数据">⟳</span>';
    var chgDisplay = hasRealTime
      ? chgText
      : (hasCachedPrice ? '<span style="color:#bbb;">--</span>' : '<span style="color:#ccc;font-size:16px;" title="无涨跌数据">⟳</span>');

    html += '<tr>' +
      '<td style="text-align:center;color:#bbb;">' + (idx + 1) + '</td>' +
      '<td style="font-weight:600;color:' + getSubtypeColor(p.subtype) + ';">' + (p.code || '-') + '</td>' +
      '<td><strong>' + (p.name || '未知') + '</strong></td>' +
      '<td class="text-right" style="font-weight:600;' + priceStyle + '">' + priceDisplay + '</td>' +
      '<td class="text-right" style="font-weight:600;font-size:13px;' + chgStyle + '">' + chgDisplay + '</td>' +
      '<td class="text-right">' + (p.quantity != null ? fmtQty(p.quantity) : 0) + '</td>' +
      '<td class="text-right" style="font-weight:600;">' + fmt(mv) + '</td>' +
      '<td class="text-right">' + pct + '%</td>' +
      '<td>' + typeTag + '</td>' +
      '<td>' + subtypeTag + '</td>' +
      (limit ? '' : '<td class="text-center">' +
        '<button class="btn btn-outline btn-sm" onclick="editPosition(\'' + p.id + '\')">编辑</button> ' +
        '<button class="btn btn-danger btn-sm" onclick="deletePosition(\'' + p.id + '\')">删除</button>' +
        '</td>') +
      '</tr>';
  });
  // 现金行
  if (cashAmt > 0) {
    var cashPct = total > 0 ? (cashAmt / total * 100).toFixed(2) : 0;
    var cashTypeTag = getTypeTagClass(data.cashType || '现金');
    html += '<tr class="cash-row" style="background:#f0fdf4;">' +
      '<td style="text-align:center;color:#bbb;">-</td>' +
      '<td style="color:#bbb;">-</td>' +
      '<td><strong>现金</strong></td>' +
      '<td class="text-right" style="color:#bbb;">-</td>' +
      '<td class="text-right" style="color:#bbb;">-</td>' +
      '<td class="text-right" style="color:#bbb;">-</td>' +
      '<td class="text-right" style="font-weight:600;">' + fmt(cashAmt) + '</td>' +
      '<td class="text-right">' + cashPct + '%</td>' +
      '<td><span class="tag ' + cashTypeTag + '">' + (data.cashType || '现金') + '</span></td>' +
      '<td><span class="tag tag-cash">' + (data.cashSubtype || '现金') + '</span></td>' +
      (limit ? '' : '<td class="text-center">' +
        '<button class="btn btn-outline btn-sm" onclick="editCash()">编辑</button>' +
        '</td>') +
      '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  if (targetId === 'topn-table') {
    document.getElementById('topn-summary').textContent = '共 ' + data.positions.length + ' 只持仓';
  }
}

// ===================== 交易表格渲染 =====================

function renderTrades() {
  const el = document.getElementById('trades-table');
  // 合并股票交易与现金流转出，按日期倒序展示
  const items = [];
  (data.trades || []).forEach(t => items.push({ kind: 'trade', created_at: t.created_at || t.date || '', raw: t }));
  (data.cashFlows || []).forEach(c => items.push({ kind: 'flow', created_at: c.created_at || c.date || '', raw: c }));
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (items.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="icon">📄</div><p>暂无交易记录</p></div>';
    return;
  }
  var html = '<table><thead><tr>' +
    '<th>时间</th><th>代码</th><th>名称</th><th>方向</th>' +
    '<th class="text-right">价格</th><th class="text-right">数量</th><th class="text-right">成交额</th>' +
    '<th>类型</th><th>备注</th><th class="text-center">操作</th>' +
    '</tr></thead><tbody>';
  items.forEach(item => {
    if (item.kind === 'trade') {
      const t = item.raw;
      const dirLabel = t.direction === 'buy'
        ? '<span class="tag tag-equity">买入</span>'
        : '<span class="tag tag-cash">卖出</span>';
      html += '<tr>' +
        '<td>' + (t.created_at || t.date || '-') + '</td>' +
        '<td>' + (t.code || '-') + '</td>' +
        '<td>' + (t.name || '-') + '</td>' +
        '<td>' + dirLabel + '</td>' +
        '<td class="text-right">' + (t.price != null ? Number(t.price).toFixed(3) : '-') + '</td>' +
        '<td class="text-right ' + (t.direction === 'buy' ? 'positive' : 'negative') + '">' +
          (t.direction === 'buy' ? '+' : '-') + fmtQty(t.quantity) + '</td>' +
        '<td class="text-right">' + (t.amount != null ? fmt(t.amount) : '-') + '</td>' +
        '<td>' + (t.type || '-') + '</td>' +
        '<td>' + (t.note || '') + '</td>' +
        '<td class="text-center"><button class="btn btn-danger btn-sm" onclick="deleteTrade(\'' + t.id + '\')">删除</button></td>' +
        '</tr>';
    } else {
      const c = item.raw;
      const isIn = c.amount >= 0;
      const dirLabel = isIn
        ? '<span class="tag tag-cash">入金</span>'
        : '<span class="tag tag-equity">出金</span>';
      html += '<tr>' +
        '<td>' + (c.created_at || c.date || '-') + '</td>' +
        '<td>现金</td>' +
        '<td>现金' + (c.note ? '·' + c.note : '') + '</td>' +
        '<td>' + dirLabel + '</td>' +
        '<td class="text-right">-</td>' +
        '<td class="text-right">-</td>' +
        '<td class="text-right ' + (isIn ? 'positive' : 'negative') + '">' +
          (isIn ? '+' : '-') + fmt(Math.abs(c.amount)) + '</td>' +
        '<td>现金</td>' +
        '<td>' + (c.note || '') + '</td>' +
        '<td class="text-center"><button class="btn btn-danger btn-sm" onclick="deleteCashFlow(\'' + c.id + '\')">删除</button></td>' +
        '</tr>';
    }
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function deleteCashFlow(id) {
  if (!id) return;
  data.cashFlows = (data.cashFlows || []).filter(c => c.id !== id);
  saveData();
  renderAll();
  showToast('现金流记录已删除');
}

// ===================== 交易录入 =====================

// 本地秒级时间字符串 YYYY-MM-DD HH:MM:SS（用于交易/现金流精确排序，东八区）
function nowSec() {
  const now = new Date();
  const cn = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${cn.getUTCFullYear()}-${p(cn.getUTCMonth() + 1)}-${p(cn.getUTCDate())} ${p(cn.getUTCHours())}:${p(cn.getUTCMinutes())}:${p(cn.getUTCSeconds())}`;
}

// 现金自动重算：现金 = 期初本金(cashBase) + 现金流净额 + 交易净额(买入减/卖出加)
// 与后端 loadAccountData 逻辑一致，是现金唯一真相源，避免刷新/覆盖导致现金丢失
function recalcCash() {
  const cfNet = (data.cashFlows || []).reduce((s, c) => s + (c.amount || 0), 0);
  const tradeNet = (data.trades || []).reduce((s, t) => s + (t.direction === 'buy' ? -(t.amount || 0) : (t.amount || 0)), 0);
  const base = (typeof data.cashBase === 'number') ? data.cashBase : 0;
  data.cash = base + cfNet + tradeNet;
}

function addTrade() {
  const code = classifyCode.normalizeCode(document.getElementById('trade-code').value.trim());
  const name = document.getElementById('trade-name').value.trim() || code;
  const direction = document.getElementById('trade-dir').value;
  const price = parseFloat(document.getElementById('trade-price').value);
  const qty = parseInt(document.getElementById('trade-qty').value);
  const amount = parseFloat(document.getElementById('trade-amount').value) || price * qty;
  const type = document.getElementById('trade-type').value;
  const subtype = document.getElementById('trade-subtype').value;
  const note = document.getElementById('trade-note').value.trim();

  if (!code || isNaN(price) || isNaN(qty) || qty <= 0) {
    showToast('请填写代码、价格和数量');
    return;
  }

  const trade = {
    id: uid(),
    date: todayCN(),
    created_at: nowSec(),
    code: code, name: name, direction: direction,
    price: price, quantity: qty, amount: amount,
    type: type, subtype: subtype, note: note
  };
  data.trades.push(trade);

  // 更新持仓
  const existing = data.positions.find(p => p.code === code);
  const delta = direction === 'buy' ? qty : -qty;
  if (existing) {
    const oldMv = (existing.price || 0) * (existing.quantity || 0);
    const newMv = direction === 'buy' ? price * qty : -(price * qty);
    const totalQty = (existing.quantity || 0) + delta;
    if (totalQty > 0) {
      existing.quantity = totalQty;
      existing.price = (oldMv + newMv) / totalQty;
      existing.type = type;
      existing.subtype = subtype;
      if (!existing.name) existing.name = name;
    } else {
      data.positions = data.positions.filter(p => p.id !== existing.id);
    }
  } else if (direction === 'buy') {
    data.positions.push({
      id: uid(), code: code, name: name,
      price: price, quantity: qty,
      type: type, subtype: subtype, cost: price, note: ''
    });
  }

  // 现金由系统自动重算，这里仅刷新内存显示
  recalcCash();

  saveData();
  renderAll();
  document.getElementById('trade-price').value = '';
  document.getElementById('trade-qty').value = '';
  document.getElementById('trade-amount').value = '';
  document.getElementById('trade-note').value = '';
}

function deleteTrade(id) {
  data.trades = data.trades.filter(t => t.id !== id);
  saveData();
  renderAll();
}

function clearTrades() {
  if (!confirm('确定清空所有交易记录？（不会影响持仓数据）')) return;
  data.trades = [];
  saveData();
  renderAll();
}

// ===================== 持仓增删改 =====================

let editingId = null;
let deleteTargetId = null;

function showAddModal() {
  editingId = null;
  document.getElementById('modal-title').textContent = '新增持仓';
  document.getElementById('modal-save-btn').textContent = '保存';
  ['modal-code', 'modal-name', 'modal-price', 'modal-qty', 'modal-cost', 'modal-note']
    .forEach(id => document.getElementById(id).value = '');
  document.getElementById('modal-type').value = '股权';
  document.getElementById('modal-subtype').value = 'A股';
  document.getElementById('modal-type-hint').textContent = '自动识别';
  document.getElementById('modal-subtype-hint').textContent = '自动识别';
  document.getElementById('modal-price-hint').textContent = '输入代码后自动获取';
  document.getElementById('modal-add').classList.add('show');
}

function editPosition(id) {
  const p = data.positions.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  // 恢复正常编辑模式，启用所有字段
  ['modal-code','modal-name','modal-price','modal-qty','modal-cost','modal-note'].forEach(function(fid) {
    document.getElementById(fid).disabled = false;
  });
  document.getElementById('modal-title').textContent = '编辑持仓';
  document.getElementById('modal-save-btn').textContent = '更新';
  document.getElementById('modal-code').value = p.code || '';
  document.getElementById('modal-name').value = p.name || '';
  document.getElementById('modal-price').value = p.price || '';
  document.getElementById('modal-qty').value = p.quantity || '';
  document.getElementById('modal-cost').value = p.cost || '';
  document.getElementById('modal-note').value = p.note || '';
  document.getElementById('modal-type').value = p.type || '股权';
  document.getElementById('modal-subtype').value = p.subtype || 'A股';
  document.getElementById('modal-add').classList.add('show');
}

function editCash() {
  editingId = 'cash';
  // 禁用非类型/细类字段
  ['modal-code','modal-name','modal-price','modal-qty','modal-cost','modal-note'].forEach(function(fid) {
    document.getElementById(fid).disabled = true;
  });
  document.getElementById('modal-title').textContent = '编辑现金';
  document.getElementById('modal-save-btn').textContent = '更新';
  document.getElementById('modal-code').value = '';
  document.getElementById('modal-name').value = '现金';
  document.getElementById('modal-price').value = '';
  document.getElementById('modal-qty').value = '';
  document.getElementById('modal-cost').value = '';
  document.getElementById('modal-note').value = '';
  document.getElementById('modal-type').value = data.cashType || '现金';
  document.getElementById('modal-subtype').value = data.cashSubtype || '现金';
  document.getElementById('modal-add').classList.add('show');
}

function savePosition() {
  const type = document.getElementById('modal-type').value;
  const subtype = document.getElementById('modal-subtype').value;

  // 现金编辑：只更新类型和细类
  if (editingId === 'cash') {
    data.cashType = type;
    data.cashSubtype = subtype;
    saveData();
    closeModal('modal-add');
    renderAll();
    showToast('现金已更新');
    return;
  }

  const code = classifyCode.normalizeCode(document.getElementById('modal-code').value.trim());
  const name = document.getElementById('modal-name').value.trim();
  const price = parseFloat(document.getElementById('modal-price').value);
  const qty = parseInt(document.getElementById('modal-qty').value);
  const cost = parseFloat(document.getElementById('modal-cost').value) || price;
  const note = document.getElementById('modal-note').value.trim();

  if (!code || !price || !qty) { showToast('请填写代码、价格和数量'); return; }

  if (editingId) {
    const p = data.positions.find(x => x.id === editingId);
    if (p) Object.assign(p, { code, name, price, quantity: qty, cost, type, subtype, note });
  } else {
    data.positions.push({ id: uid(), code, name, price, quantity: qty, cost, type, subtype, note });
  }

  saveData();
  closeModal('modal-add');
  renderAll();
  showToast('已保存 ' + (name || code));
}

function deletePosition(id) {
  const p = data.positions.find(x => x.id === id);
  if (!p) return;
  deleteTargetId = id;
  document.getElementById('delete-msg').textContent =
    '确定删除「' + (p.name || p.code) + '」的持仓记录吗？';
  document.getElementById('delete-confirm-btn').onclick = confirmDelete;
  document.getElementById('modal-delete').classList.add('show');
}

function confirmDelete() {
  if (deleteTargetId) {
    data.positions = data.positions.filter(p => p.id !== deleteTargetId);
    // 仅删持仓，保留交易流水（交易用于净值计算，删持仓不应抹掉历史）
    deleteTargetId = null;
    saveData();
    renderAll();
  }
  closeModal('modal-delete');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

function updateCash(val) {
  const target = parseFloat(val) || 0;
  const cfNet = (data.cashFlows || []).reduce((s, c) => s + (c.amount || 0), 0);
  const tradeNet = (data.trades || []).reduce((s, t) => s + (t.direction === 'buy' ? -(t.amount || 0) : (t.amount || 0)), 0);
  const current = (data.cashBase || 0) + cfNet + tradeNet;
  const delta = Math.round((target - current) * 100) / 100;
  // 调整现金 = 追加一条"校正现金流"，不改期初本金(cashBase)，避免污染净值计算
  if (!data.cashFlows) data.cashFlows = [];
  data.cashFlows.push({ id: uid(), date: todayCN(), created_at: nowSec(), amount: delta, note: '现金调整' });
  saveData();
  renderAll();
}

// ===================== 截图识别（AI视觉） =====================

var tradeMode = 'manual';

function switchTradeMode(mode) {
  tradeMode = mode;
  document.getElementById('mode-manual').classList.toggle('active', mode === 'manual');
  document.getElementById('mode-excel').classList.toggle('active', mode === 'excel');
  document.getElementById('mode-position').classList.toggle('active', mode === 'position');
  document.getElementById('mode-vision').classList.toggle('active', mode === 'vision');
  document.getElementById('trade-manual-section').style.display = mode === 'manual' ? '' : 'none';
  document.getElementById('trade-excel-section').style.display = mode === 'excel' ? '' : 'none';
  document.getElementById('trade-position-section').style.display = mode === 'position' ? '' : 'none';
  document.getElementById('trade-vision-section').style.display = mode === 'vision' ? '' : 'none';
  if (mode === 'vision') { initVisionQr(); } else { stopVisionQr(); }
}

async function handleVisionFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  await doVisionParse(file);
}

async function handleExcelFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  await doExcelParse(file);
}

// 粘贴支持
(function initVisionPaste() {
  document.addEventListener('paste', function(e) {
    if (tradeMode !== 'vision') return;
    var tradesPage = document.getElementById('page-trades');
    if (!tradesPage || !tradesPage.classList.contains('active')) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        var blob = items[i].getAsFile();
        if (blob) { doVisionParse(blob); break; }
      }
    }
  });
})();

// 拖拽支持
(function initVisionDrag() {
  var zone = document.getElementById('vision-zone');
  if (!zone) return;
  zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', function() { zone.classList.remove('dragover'); });
  zone.addEventListener('drop', function(e) {
    e.preventDefault();
    zone.classList.remove('dragover');
    var file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) doVisionParse(file);
  });
})();

async function doVisionParse(file) {
  var loading = document.getElementById('vision-loading');
  var result = document.getElementById('vision-result');
  if (loading) loading.style.display = 'block';
  if (result) result.innerHTML = '';

  try {
    var base64 = await fileToBase64(file);
    if (loading) loading.textContent = 'AI识别中...';
    var r = await fetch(api('/api/vision-parse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64 })
    });
    var d = await r.json();

    if (loading) loading.style.display = 'none';

    if (d.error) {
      if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">识别失败: ' + escapeHtml(d.error) + '</div>';
      return;
    }

    if (!d.trades || d.trades.length === 0) {
      if (result) result.innerHTML = '<div style="color:#888;padding:12px;">未能识别出交易信息，请手动录入</div>';
      return;
    }

    var html = '<div style="margin-bottom:8px;"><button class="btn btn-success btn-sm" onclick="confirmAllVisionItems()">✅ 全部录入</button></div>' +
      '<table><thead><tr>' +
      '<th>代码</th><th>名称</th><th class="text-right">价格</th><th class="text-right">数量</th>' +
      '<th>方向</th><th>类型</th><th>确认</th>' +
      '</tr></thead><tbody>';
    d.trades.forEach(function(item, i) {
      var rec = recognizeCode(item.code) || { type: '股权', subtype: 'A股' };
      html += '<tr>' +
        '<td><input type="text" id="v-code-' + i + '" value="' + (item.code || '') +
          '" style="width:70px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"' +
          ' oninput="onVisionCodeChange(' + i + ')"></td>' +
        '<td><input type="text" id="v-name-' + i + '" value="' + (item.name || '') +
          '" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td><input type="number" id="v-price-' + i + '" value="' + (item.price || '') +
          '" step="0.001" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td><input type="number" id="v-qty-' + i + '" value="' + (item.quantity || '') +
          '" step="1" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td><select id="v-dir-' + i + '" style="padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' +
          '<option value="buy"' + (item.direction === 'buy' ? ' selected' : '') + '>买入</option>' +
          '<option value="sell"' + (item.direction === 'sell' ? ' selected' : '') + '>卖出</option>' +
          '</select></td>' +
        '<td>' + getTypeTag(rec.type) + ' ' + (rec.subtype || '') + '</td>' +
        '<td><button class="btn btn-success btn-sm" onclick="confirmVisionItem(' + i + ')">确认录入</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    if (result) result.innerHTML = html;
    window._visionParsed = d.trades;
    window._visionParsed.forEach(function(item) { item.code = classifyCode.normalizeCode(item.code); });
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">识别失败: ' + escapeHtml(e.message) + '</div>';
  }
}

function onVisionCodeChange(index) {
  var code = document.getElementById('v-code-' + index).value.trim();
  if (code.length >= 4) {
    fetchQuote(code).then(function(q) {
      if (q && q.price) {
        document.getElementById('v-price-' + index).value = q.price;
        if (q.name) document.getElementById('v-name-' + index).value = q.name;
      }
    });
  }
}

function confirmVisionItem(index) {
  var item = window._visionParsed[index];
  if (!item) return;
  addTradeInternal(
    document.getElementById('v-code-' + index).value.trim(),
    document.getElementById('v-name-' + index).value.trim(),
    document.getElementById('v-dir-' + index).value,
    parseFloat(document.getElementById('v-price-' + index).value) || 0,
    parseInt(document.getElementById('v-qty-' + index).value) || 0
  );
  document.getElementById('v-code-' + index).closest('tr').remove();
  window._visionParsed.splice(index, 1);
}

function confirmAllVisionItems() {
  if (!window._visionParsed || window._visionParsed.length === 0) return;
  for (var i = window._visionParsed.length - 1; i >= 0; i--) {
    confirmVisionItem(i);
  }
}

async function doExcelParse(file) {
  var loading = document.getElementById('excel-loading');
  var result = document.getElementById('excel-result');
  if (loading) loading.style.display = 'block';
  if (result) result.innerHTML = '';

  try {
    var base64 = await fileToBase64(file);
    if (loading) loading.textContent = 'AI解析中...';
    var r = await fetch(api('/api/excel-parse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64 })
    });
    var d = await r.json();

    if (loading) loading.style.display = 'none';

    if (d.error) {
      if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">解析失败: ' + escapeHtml(d.error) + '</div>';
      return;
    }

    if (!d.trades || d.trades.length === 0) {
      if (result) result.innerHTML = '<div style="color:#888;padding:12px;">未能识别出交易信息，请检查 Excel 格式后重试</div>';
      return;
    }

    var html = '<div style="margin-bottom:8px;"><button class="btn btn-success btn-sm" onclick="confirmAllExcelItems()">✅ 全部录入</button></div>' +
      '<table><thead><tr>' +
      '<th>日期</th><th>代码</th><th>名称</th><th class="text-right">价格</th><th class="text-right">数量</th>' +
      '<th>方向</th><th>类型</th><th>确认</th>' +
      '</tr></thead><tbody>';
    d.trades.forEach(function(item, i) {
      var rec = recognizeCode(item.code) || { type: '股权', subtype: 'A股' };
      html += '<tr>' +
        '<td><input type="date" id="e-date-' + i + '" value="' + (item.date || '') +
          '" style="width:110px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td><input type="text" id="e-code-' + i + '" value="' + (item.code || '') +
          '" style="width:70px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"' +
          ' oninput="onExcelCodeChange(' + i + ')"></td>' +
        '<td><input type="text" id="e-name-' + i + '" value="' + (item.name || '') +
          '" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td><input type="number" id="e-price-' + i + '" value="' + (item.price || '') +
          '" step="0.001" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td><input type="number" id="e-qty-' + i + '" value="' + (item.quantity || '') +
          '" step="1" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td><select id="e-dir-' + i + '" style="padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' +
          '<option value="buy"' + (item.direction === 'buy' ? ' selected' : '') + '>买入</option>' +
          '<option value="sell"' + (item.direction === 'sell' ? ' selected' : '') + '>卖出</option>' +
          '</select></td>' +
        '<td>' + getTypeTag(rec.type) + ' ' + (rec.subtype || '') + '</td>' +
        '<td><button class="btn btn-success btn-sm" onclick="confirmExcelItem(' + i + ')">确认录入</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    if (result) result.innerHTML = html;
    window._excelParsed = d.trades;
    window._excelParsed.forEach(function(item) { item.code = classifyCode.normalizeCode(item.code); });
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">解析失败: ' + escapeHtml(e.message) + '</div>';
  }
}

function onExcelCodeChange(index) {
  var code = document.getElementById('e-code-' + index).value.trim();
  if (code.length >= 4) {
    fetchQuote(code).then(function(q) {
      if (q && q.price) {
        document.getElementById('e-price-' + index).value = q.price;
        if (q.name) document.getElementById('e-name-' + index).value = q.name;
      }
    });
  }
}

function confirmExcelItem(index) {
  var item = window._excelParsed[index];
  if (!item) return;
  addTradeInternal(
    document.getElementById('e-code-' + index).value.trim(),
    document.getElementById('e-name-' + index).value.trim(),
    document.getElementById('e-dir-' + index).value,
    parseFloat(document.getElementById('e-price-' + index).value) || 0,
    parseInt(document.getElementById('e-qty-' + index).value) || 0,
    document.getElementById('e-date-' + index).value
  );
  document.getElementById('e-code-' + index).closest('tr').remove();
  window._excelParsed.splice(index, 1);
}

function confirmAllExcelItems() {
  if (!window._excelParsed || window._excelParsed.length === 0) return;
  for (var i = window._excelParsed.length - 1; i >= 0; i--) {
    confirmExcelItem(i);
  }
}

async function handlePositionFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  await doPositionImport(file);
}

async function doPositionImport(file) {
  var loading = document.getElementById('position-loading');
  var result = document.getElementById('position-result');
  if (loading) loading.style.display = 'block';
  if (result) result.innerHTML = '';

  try {
    var base64 = await fileToBase64(file);
    if (loading) loading.textContent = 'AI解析中...';
    var r = await fetch(api('/api/excel-positions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64 })
    });
    var d = await r.json();

    if (loading) loading.style.display = 'none';

    if (d.error) {
      if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">解析失败: ' + escapeHtml(d.error) + '</div>';
      return;
    }

    if (!d.positions || d.positions.length === 0) {
      if (result) result.innerHTML = '<div style="color:#888;padding:12px;">未能识别出持仓信息，请检查 Excel 格式后重试</div>';
      return;
    }

    var html = '<div style="margin-bottom:8px;"><button class="btn btn-success btn-sm" onclick="confirmAllPositionItems()">✅ 全部导入</button></div>' +
      '<table><thead><tr>' +
      '<th>代码</th><th>名称</th><th class="text-right">成本价</th><th class="text-right">数量</th>' +
      '<th>类型</th><th>确认</th>' +
      '</tr></thead><tbody>';
    d.positions.forEach(function(item, i) {
      var rec = recognizeCode(item.code) || { type: '股权', subtype: 'A股' };
      html += '<tr>' +
        '<td><input type="text" id="p-code-' + i + '" value="' + (item.code || '') +
          '" style="width:70px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"' +
          ' oninput="onPositionCodeChange(' + i + ')"></td>' +
        '<td><input type="text" id="p-name-' + i + '" value="' + (item.name || '') +
          '" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td><input type="number" id="p-price-' + i + '" value="' + (item.price || '') +
          '" step="0.001" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td><input type="number" id="p-qty-' + i + '" value="' + (item.quantity || '') +
          '" step="1" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
        '<td>' + getTypeTag(rec.type) + ' ' + (rec.subtype || '') + '</td>' +
        '<td><button class="btn btn-success btn-sm" onclick="confirmPositionItem(' + i + ')">确认导入</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    if (result) result.innerHTML = html;
    window._positionParsed = d.positions;
    window._positionParsed.forEach(function(item) { item.code = classifyCode.normalizeCode(item.code); });
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">解析失败: ' + escapeHtml(e.message) + '</div>';
  }
}

function onPositionCodeChange(index) {
  var code = document.getElementById('p-code-' + index).value.trim();
  if (code.length >= 4) {
    fetchQuote(code).then(function(q) {
      if (q && q.price) {
        var priceEl = document.getElementById('p-price-' + index);
        if (priceEl && !priceEl.value) priceEl.value = q.price;
        if (q.name) {
          var nameEl = document.getElementById('p-name-' + index);
          if (nameEl && !nameEl.value) nameEl.value = q.name;
        }
      }
    });
  }
}

function confirmPositionItem(index) {
  var item = window._positionParsed[index];
  if (!item) return;

  var code = classifyCode.normalizeCode(document.getElementById('p-code-' + index).value.trim());
  var name = document.getElementById('p-name-' + index).value.trim();
  var price = parseFloat(document.getElementById('p-price-' + index).value) || 0;
  var quantity = parseInt(document.getElementById('p-qty-' + index).value) || 0;
  if (!code || !price || !quantity) { showToast('请填写代码、价格和数量'); return; }

  var rec = recognizeCode(code) || { type: '股权', subtype: 'A股' };
  var existing = data.positions.find(function(p) { return p.code === code; });
  if (existing) {
    existing.name = name || code;
    existing.price = price;
    existing.quantity = quantity;
    existing.cost = price;
    existing.type = existing.type || rec.type;
    existing.subtype = existing.subtype || rec.subtype;
  } else {
    data.positions.push({
      id: uid(), code: code, name: name || code,
      price: price, quantity: quantity, cost: price,
      type: rec.type, subtype: rec.subtype, note: ''
    });
  }

  recalcCash();
  saveData();
  renderAll();
  document.getElementById('p-code-' + index).closest('tr').remove();
  window._positionParsed.splice(index, 1);
  showToast('已导入持仓 ' + (name || code));
}

function confirmAllPositionItems() {
  if (!window._positionParsed || window._positionParsed.length === 0) return;
  for (var i = window._positionParsed.length - 1; i >= 0; i--) {
    confirmPositionItem(i);
  }
}

function fileToBase64(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 将 base64 data URL 转为 File 对象（URL → Blob → File）
function base64ToFile(base64, filename) {
  var arr = base64.split(',');
  var mime = arr[0].match(/:(.*?);/)[1];
  var bstr = atob(arr[1]);
  var n = bstr.length;
  var u8arr = new Uint8Array(n);
  while (n--) { u8arr[n] = bstr.charCodeAt(n); }
  return new File([u8arr], filename || 'upload.png', { type: mime });
}

// ===================== 手机扫码上传 =====================
var _qrPollTimer = null;
var _qrToken = null;

function initVisionQr() {
  fetch(api('/api/vision-token'), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _qrToken = d.token;
      var img = document.getElementById('qr-image');
      if (img) img.src = d.qr || '';

      if (_qrPollTimer) clearInterval(_qrPollTimer);
      _qrPollTimer = setInterval(function() {
        fetch(api('/api/vision-check/' + d.token))
          .then(function(r) { return r.json(); })
          .then(function(result) {
            if (result.expired) {
              clearInterval(_qrPollTimer);
              _qrPollTimer = null;
              return;
            }
            if (result.image) {
              clearInterval(_qrPollTimer);
              _qrPollTimer = null;
              var file = base64ToFile(result.image, 'phone_upload.png');
              doVisionParse(file);
            }
          });
      }, 2000);
    });
}

function stopVisionQr() {
  if (_qrPollTimer) { clearInterval(_qrPollTimer); _qrPollTimer = null; }
  _qrToken = null;
  var img = document.getElementById('qr-image');
  if (img) img.src = '';
}

// ===================== 交易录入增强 =====================

function addTradeInternal(code, name, direction, price, quantity, date) {
  code = classifyCode.normalizeCode(code);
  var amount = Math.round(price * quantity * 100) / 100;
  if (!code || !price || !quantity) { showToast('请填写代码、价格和数量'); return; }

  var rec = recognizeCode(code) || { type: '股权', subtype: 'A股' };
  data.trades.push({
    id: uid(), code: code, name: name || code,
    direction: direction, price: price, quantity: quantity,
    amount: amount, type: rec.type, subtype: rec.subtype,
    date: date || todayCN(), created_at: nowSec()
  });

  var existing = data.positions.find(function(p) { return p.code === code; });
  if (existing) {
    existing.price = price;
    existing.type = existing.type || rec.type;
    if (direction === 'buy') existing.quantity += quantity;
    else existing.quantity = Math.max(0, existing.quantity - quantity);
  } else if (direction === 'buy') {
    data.positions.push({
      id: uid(), code: code, name: name || code,
      price: price, quantity: quantity, cost: price,
      type: rec.type, subtype: rec.subtype, note: ''
    });
  }

  recalcCash();
  saveData();
  renderAll();
  showToast('已记录 ' + (direction === 'buy' ? '买入' : '卖出') + ' ' + (name || code));
}

// ===================== 数据导入导出 =====================

function exportData() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '仓位数据_' + todayCN() + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function exportToExcel() {
  var url = api('/api/export/' + encodeURIComponent(currentAccount));
  var a = document.createElement('a');
  a.href = url;
  a.download = currentAccount + '_持仓导出.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('正在下载...');
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported.positions && imported.trades !== undefined) {
        data = imported;
        saveData();
        renderAll();
        showToast('数据导入成功！');
      } else {
        showToast('数据格式不正确');
      }
    } catch (err) {
      showToast('导入失败: ' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ===================== 现金流管理（NAV 修正） =====================

/**
 * 显示入金/出金弹窗
 * 在收益走势区的"记录净值"按钮旁调用
 */
function showCashFlowModal() {
  var html =
    '<div class="modal-overlay show" id="modal-cashflow" style="z-index:1001;">' +
    '<div class="modal" style="width:400px;">' +
    '<h2>入金 / 出金</h2>' +
    '<div class="form-group" style="margin-bottom:14px;">' +
    '<label style="display:block;font-size:12px;color:#888;margin-bottom:4px;">金额 (¥)</label>' +
    '<input type="number" id="cf-amount" step="0.01" placeholder="正数=入金, 负数=出金" ' +
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
}

function closeCashFlowModal() {
  var container = document.getElementById('cashflow-modal-container');
  if (container) container.parentNode.removeChild(container);
}

function addCashFlow() {
  var amountInput = document.getElementById('cf-amount');
  var noteInput = document.getElementById('cf-note');
  var cfAmount = parseFloat(amountInput ? amountInput.value : 0);
  if (!cfAmount || isNaN(cfAmount) || cfAmount === 0) {
    showToast('请输入有效金额（正数入金，负数出金）');
    return;
  }
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
  // 如果今天已经记录过，跳过
  if (data.navHistory.length > 0 &&
      data.navHistory[data.navHistory.length - 1].date === today) return;

  const s = calcSummary();
  if (s.total <= 0) return;

  if (data.navHistory.length === 0) {
    // 第一条 NAV 记录，净值设为 1.0
    data.navHistory.push({
      date: today,
      nav: 1.0,
      totalAsset: s.total
    });
  } else {
    // 修正后的净值计算：
    // adjustedNav = lastNav * (currentTotal / (lastTotalAsset + periodCashFlow))
    // 即：剔除「上次净值以来累计现金流」影响后的真实净值增长
    const lastNav = data.navHistory[data.navHistory.length - 1];
    // 自上次净值记录日（不含）到今天（含）的累计净现金流
    // 修复：原逻辑只算当天，会漏掉未开 App / 收盘后那几天的出入金
    var periodCashFlow = 0;
    if (data.cashFlows) {
      data.cashFlows.forEach(function (cf) {
        if (cf.date > lastNav.date && cf.date <= today) periodCashFlow += cf.amount;
      });
    }
    var baseAsset = lastNav.totalAsset + periodCashFlow;
    if (baseAsset <= 0) return;
    var nav = lastNav.nav * (s.total / baseAsset);
    data.navHistory.push({
      date: today,
      nav: nav,
      totalAsset: s.total
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

function normalizeIndexData(indexData, navData) {
  if (indexData.length === 0 || navData.length === 0) return [];
  const firstClose = indexData[0].close;
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

  var hs300Data = [], shData = [], zzData = [], hsidata = [];
  try {
    const days = returnPeriod > 0 ? returnPeriod : Math.max(90, navData.length * 2);
    const results = await Promise.all([
      fetchIndexKline('1.000300', days + 30),
      fetchIndexKline('1.000001', days + 30),
      fetchIndexKline('1.000985', days + 30),
      fetchIndexKline('0.^HSI', days + 30)
    ]);
    hs300Data = normalizeIndexData(results[0], navData);
    shData = normalizeIndexData(results[1], navData);
    zzData = normalizeIndexData(results[2], navData);
    hsidata = normalizeIndexData(results[3], navData);
  } catch (e) { /* 指数数据加载失败不阻塞 */ }

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
      }
    });
  });
}

// ===================== 版本记录 =====================

function loadChangelog() {
  var el = document.getElementById('changelog-content');
  if (!el) return;
  if (el.dataset.loaded) return;
  el.dataset.loaded = '1';
  el.innerHTML = getChangelogHtml();
}

function getChangelogHtml() {
  var css = 'color:#1a73e8;font-size:16px;font-weight:700;margin:18px 0 8px;border-left:3px solid #1a73e8;padding-left:10px;';
  var cssItem = 'margin:4px 0 4px 16px;line-height:1.7;';

  var h = '';

  h += '<h3 style="' + css + '">2026-07-08</h3>';
  h += '<ol>';
  h += '<li style="' + cssItem + '">存储引擎从 SQLite 迁移到 PostgreSQL，支持多用户并发；数据库六表自动建表、路由全异步化、交易脚本同步改造。</li>';
  h += '<li style="' + cssItem + '">代码本地验证通过（加载级+连库级），SQLite 残留全部清除，真实数据已迁移并抽查确认。</li>';
  h += '<li style="' + cssItem + '">时区统一为北京时间（东八区），前端/脚本/服务端日期全部改用 <code>todayCN()</code>。</li>';
  h += '<li style="' + cssItem + '">支持子目录部署，新增 <code>BASE_URL</code> 配置，静态资源和 API 请求自动加前缀。</li>';
  h += '<li style="' + cssItem + '">接入 dotenv 自动读取 <code>.env</code>，修复部署后数据库连接为空的致命缺陷。</li>';
  h += '<li style="' + cssItem + '">Git 版本管理规范建立，代码推送至 GitHub，配置 <code>.gitignore</code> 排除敏感文件。</li>';
  h += '<li style="' + cssItem + '">腾讯云 CVM 一键部署脚本完成（Node22+PG+Nginx+pm2），SSH 实跑成功，服务上线运行。</li>';
  h += '<li style="' + cssItem + '">持仓表格新增现金行：显示余额和占比，可编辑类型/细类，图表动态聚合持仓类别。</li>';
  h += '<li style="' + cssItem + '">类型下拉增加"现金"选项，细类下拉增加"现金"选项。</li>';
  h += '<li style="' + cssItem + '">自动刷新间隔从 60 秒改为 15 分钟，降低行情查询频率。</li>';
  h += '<li style="' + cssItem + '">新增"版本记录"页面，按日期汇总系统更新内容。</li>';
  h += '<li style="' + cssItem + '">截图识别并入交易页（手动/图片两种录入方式），用 Agnes AI 视觉模型替代 Tesseract OCR。</li>';
  h += '<li style="' + cssItem + '">AI 视觉模型支持环境变量配置（VISION_API_KEY），默认 Agnes AI 1.5-flash。</li>';
  h += '<li style="' + cssItem + '">类型标签统一用 getTypeTag() 处理（股权/债权/现金三种颜色），消除多处二元判断遗漏。</li>';
  h += '<li style="' + cssItem + '">修复页面切换时右侧滚动条抖动（body overflow-y:scroll）。</li>';
  h += '<li style="' + cssItem + '">修复交易录入方向下拉 ID 不匹配（trade-dir vs trade-direction）。</li>';
  h += '<li style="' + cssItem + '">服务器建立 Git 仓库并同步至 GitHub，后续支持 git pull 一键升级。</li>';
  h += '<li style="' + cssItem + '">总资产卡片增加今日涨跌（▲红色涨 / ▼绿色跌），对比上一条净值记录。</li>';
  h += '<li style="' + cssItem + '"><strong>手机扫码上传：</strong>图片识别区左右布局（左边拖拽上传 + 右边二维码），手机扫码自动调起相机，拍照后电脑端自动接收并 AI 识别。</li>';
  h += '<li style="' + cssItem + '">每日收盘价自动记录，按各市场收盘时刻精准触发（A股 15:10 / 港股 16:10）。</li>';
  h += '<li style="' + cssItem + '">招商证券账户数据清理，修复迁移后两账户数据重复问题。</li>';
  h += '</ol>';

  h += '<h3 style="' + css + '">2026-07-06</h3>';
  h += '<ol>';
  h += '<li style="' + cssItem + '">修复静默丢数据缺陷：删除持仓时保留交易流水（交易用于净值计算）。</li>';
  h += '<li style="' + cssItem + '">修复收益走势图指数开关和区间高亮失效问题。</li>';
  h += '<li style="' + cssItem + '">亏损金额增加负号显示。</li>';
  h += '<li style="' + cssItem + '">清理无效死代码和归档失效脚本。</li>';
  h += '<li style="' + cssItem + '">前后端分类逻辑统一收敛为 <code>code-classify.js</code> 单一函数，消除代码前缀规则不一致。</li>';
  h += '</ol>';

  h += '<h3 style="' + css + '">2026-06-27</h3>';
  h += '<ol>';
  h += '<li style="' + cssItem + '">修复嘉实原油LOF(160723)价格系数错误（1.715 → 原错误显示 17.15）。</li>';
  h += '<li style="' + cssItem + '">全面重构价格系数逻辑：默认千分位，仅A股用百分位，避免新增品种遗漏。</li>';
  h += '<li style="' + cssItem + '">统一数量/价格/市值格式约定（万位逗号、3位小数价格、¥前缀金额）。</li>';
  h += '<li style="' + cssItem + '">建立港股价格（存港币）、汇率（hkRate=0.868）和代码五位的系统级别规则。</li>';
  h += '<li style="' + cssItem + '">新增交易时间感知（A股/港股开盘判断），收盘后不自动刷新。</li>';
  h += '<li style="' + cssItem + '">从 JSON 文件迁移到 SQLite 数据库，新增持仓/交易/净值/现金流四张独立表。</li>';
  h += '<li style="' + cssItem + '">后端分层（server.js 路由 + db.js 数据层）、前端模块化（utils.js 工具函数）。</li>';
  h += '<li style="' + cssItem + '">行情统一走服务端代理，移除前端直接请求，增加安全加固（CSRF 防护）。</li>';
  h += '<li style="' + cssItem + '">新增港币汇率代理 API 和指数 K 线 API。</li>';
  h += '<li style="' + cssItem + '">修复上交所可转债(11xxxx)行情查询 Bug，secid 构造缺前缀。</li>';
  h += '</ol>';

  h += '<h3 style="' + css + '">2026-06-26</h3>';
  h += '<ol>';
  h += '<li style="' + cssItem + '">项目初始化：从券商 CSV 导入 A 股和港股通持仓数据。</li>';
  h += '<li style="' + cssItem + '">初始持仓 43 只（17 A股 + 7 可转债 + 19 港股），47 笔交易。</li>';
  h += '</ol>';

  return h;
}

// ===================== 全量渲染 =====================

function renderAll() {
  try { renderStats(); } catch(e) {}
  try { renderCharts(); } catch(e) {}
  try { renderPositionsTable('positions-table'); } catch(e) {}
  try { renderPositionsTable('topn-table'); } catch(e) {}
  try { renderTrades(); } catch(e) {}
  try { renderReturnsStats(); } catch(e) {}
  try { var cashInput = document.querySelector('#page-positions .form-row #cash-input'); if (cashInput) cashInput.value = data.cash || ''; } catch(e) {}
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
