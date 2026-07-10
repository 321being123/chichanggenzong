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

  // 批量拉取行情（A股走Tushare实时，港股走腾讯）
  let allQuotes = {};
  try {
    const rr = await fetch(api('/api/quotes?codes=' + encodeURIComponent(codes.join(','))));
    if (rr.ok) allQuotes = await rr.json() || {};
  } catch (e) {}

  // 获取港币→人民币汇率（港股通用）
  var hkRate = await fetchHKRate();
  if (!hkRate || hkRate <= 0) hkRate = 0.868;
  data.hkRate = hkRate; // 全局汇率，供 getMarketValue 使用
  
  // 并发请求，每次10只
  const concurrency = 10;
  for (let i = 0; i < codes.length; i += concurrency) {
    const batch = codes.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (c) => {
      if (allQuotes[c] && allQuotes[c].price) return allQuotes[c];
      return await fetchQuote(c, true);
    }));
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
  await syncIndexPoints();
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
        va = priceChangeMap[a.code] != null ? priceChangeMap[a.code] : -999;
        vb = priceChangeMap[b.code] != null ? priceChangeMap[b.code] : -999;
      }
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortState.dir === 'asc' ? cmp : -cmp;
    });
  }

  // limit 截取（用于总览页 topN，只读展示）
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
      '<select onchange="setFilter(&quot;type&quot;,this.value)">' +
      '<option value="">全部类型</option>' +
      types.map(t => '<option value="' + t + '"' + (filterState.type === t ? ' selected' : '') + '>' + t + '</option>').join('') +
      '</select>' +
      '<select onchange="setFilter(&quot;subtype&quot;,this.value)">' +
      '<option value="">全部细类</option>' +
      subtypes.map(s => '<option value="' + s + '"' + (filterState.subtype === s ? ' selected' : '') + '>' + s + '</option>').join('') +
      '</select>' +
      ((filterState.type || filterState.subtype)
        ? '<button class="btn btn-outline btn-sm" onclick="filterState={type:&quot;&quot;,subtype:&quot;&quot;};renderPositionsTable(&quot;positions-table&quot;);renderPositionsTable(&quot;topn-table&quot;)">清除筛选</button>'
        : '') +
      '<button class="btn btn-success btn-sm" style="margin-left:auto;" onclick="exportToExcel()">导出EXCEL</button>' +
      '<span style="color:#bbb;">' + list.length + ' / ' + data.positions.length + ' 只</span>' +
      '</div>';
  }

  var html = filterBar + '<table><thead><tr>' +
    '<th style="width:40px;" class="sortable" onclick="setSort(&quot;xh&quot;)">序号' + sortArrow('xh') + '</th>' +
    '<th class="sortable" onclick="setSort(&quot;code&quot;)">代码' + sortArrow('code') + '</th>' +
    '<th class="sortable" onclick="setSort(&quot;name&quot;)">名称' + sortArrow('name') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(&quot;price&quot;)">现价' + sortArrow('price') + '</th>' +
    '<th class="text-right sortable" style="width:70px;" onclick="setSort(&quot;chg&quot;)">涨跌' + sortArrow('chg') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(&quot;qty&quot;)">数量' + sortArrow('qty') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(&quot;mv&quot;)">市值' + sortArrow('mv') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(&quot;pct&quot;)">比例' + sortArrow('pct') + '</th>' +
    '<th class="sortable" onclick="setSort(&quot;type&quot;)">类型' + sortArrow('type') + '</th>' +
    '<th class="sortable" onclick="setSort(&quot;subtype&quot;)">细类' + sortArrow('subtype') + '</th>' +
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
        '<button class="btn btn-outline btn-sm" onclick="editPosition(&quot;' + p.id + '&quot;)">编辑</button> ' +
        '<button class="btn btn-danger btn-sm" onclick="deletePosition(&quot;' + p.id + '&quot;)">删除</button>' +
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
    const sumEl = document.getElementById('topn-summary');
    if (sumEl) sumEl.textContent = '共 ' + data.positions.length + ' 只持仓';
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
      var displayName = t.name;
      if (!displayName || displayName === t.code) {
        var pos = data.positions.find(function(p) { return p.code === t.code; });
        if (pos && pos.name && pos.name !== t.code) displayName = pos.name;
      }
      html += '<tr>' +
        '<td>' + (t.created_at || t.date || '-') + '</td>' +
        '<td>' + (t.code || '-') + '</td>' +
        '<td>' + (displayName || '-') + '</td>' +
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

// ===================== 弹窗通用 =====================

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

// ===================== 截图识别（AI视觉） =====================

var tradeMode = 'manual';

function switchTradeMode(mode) {
  tradeMode = mode;
  document.getElementById('mode-manual').classList.toggle('active', mode === 'manual');
  document.getElementById('mode-smart').classList.toggle('active', mode === 'smart');
  document.getElementById('trade-manual-section').style.display = mode === 'manual' ? '' : 'none';
  document.getElementById('trade-smart-section').style.display = mode === 'smart' ? '' : 'none';
  if (mode === 'smart') { initVisionQr(); } else { stopVisionQr(); }
}

async function handleVisionFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  await doSmartParse(file, 'vision');
}

async function handleExcelFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  await doSmartParse(file, 'excel');
}

// 粘贴支持
(function initVisionPaste() {
  document.addEventListener('paste', function(e) {
    if (tradeMode !== 'smart') return;
    var tradesPage = document.getElementById('page-trades');
    if (!tradesPage || !tradesPage.classList.contains('active')) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        var blob = items[i].getAsFile();
        if (blob) { doSmartParse(blob, 'vision'); break; }
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
    if (file && file.type.startsWith('image/')) doSmartParse(file, 'vision');
  });
})();

async function doSmartParse(file, source) {
  var loading = document.getElementById('smart-loading');
  var result = document.getElementById('smart-result');
  if (loading) loading.style.display = 'block';
  if (result) result.innerHTML = '';

  try {
    var base64 = await fileToBase64(file);
    if (loading) loading.innerHTML = '<span class="spinner"></span>AI识别中...';

    var d;
    if (source === 'vision') {
      var r = await fetch(api('/api/vision-parse'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 })
      });
      d = await r.json();
    } else {
      var r2 = await fetch(api('/api/excel-parse'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: base64 })
      });
      d = await r2.json();
    }

    if (loading) loading.style.display = 'none';

    if (d.error) {
      if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">识别失败: ' + escapeHtml(d.error) + '</div>';
      return;
    }

    if (!d.items || d.items.length === 0) {
      if (result) result.innerHTML = '<div style="color:#888;padding:12px;">未能识别出交易或持仓信息，请检查内容后重试</div>';
      return;
    }

    window._smartParsed = d.items.map(function(item) {
      item.code = classifyCode.normalizeCode(item.code || '');
      return item;
    });
    renderSmartItems();
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">识别失败: ' + escapeHtml(e.message) + '</div>';
  }
}

function renderSmartItems() {
  var result = document.getElementById('smart-result');
  if (!result) return;
  var items = window._smartParsed || [];
  if (items.length === 0) { result.innerHTML = ''; return; }

  var html = '<div style="margin-bottom:8px;"><button class="btn btn-success btn-sm" onclick="confirmAllSmartItems()">✅ 全部录入</button></div>' +
    '<table><thead><tr>' +
    '<th>类型</th><th>日期</th><th>代码</th><th>名称</th><th class="text-right">价格</th><th class="text-right">数量</th>' +
    '<th>方向</th><th>品种</th><th>确认</th>' +
    '</tr></thead><tbody>';
  items.forEach(function(item, i) {
    var code = item.code || '';
    var rec = recognizeCode(code) || { type: '股权', subtype: 'A股' };
    var isTrade = item.kind === 'trade';
    html += '<tr>' +
      '<td>' + (isTrade ? '<span class="tag tag-equity">交易</span>' : '<span class="tag tag-cash">持仓</span>') + '</td>' +
      '<td>' + (isTrade ? '<input type="date" id="s-date-' + i + '" value="' + (item.date || '') + '" style="width:110px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' : '-') + '</td>' +
      '<td><input type="text" id="s-code-' + i + '" value="' + code + '" style="width:70px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;" oninput="onSmartCodeChange(' + i + ')"></td>' +
      '<td><input type="text" id="s-name-' + i + '" value="' + (item.name || '') + '" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
      '<td><input type="number" id="s-price-' + i + '" value="' + (item.price || '') + '" step="0.001" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
      '<td><input type="number" id="s-qty-' + i + '" value="' + (item.quantity || '') + '" step="1" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
      '<td>' + (isTrade ? '<select id="s-dir-' + i + '" style="padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' +
        '<option value="buy"' + (item.direction === 'buy' ? ' selected' : '') + '>买入</option>' +
        '<option value="sell"' + (item.direction === 'sell' ? ' selected' : '') + '>卖出</option>' +
        '</select>' : '-') + '</td>' +
      '<td>' + getTypeTag(rec.type) + ' ' + (rec.subtype || '') + '</td>' +
      '<td><button class="btn btn-success btn-sm" onclick="confirmSmartItem(' + i + ')">确认' + (isTrade ? '录入' : '导入') + '</button></td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  result.innerHTML = html;
}

function onSmartCodeChange(index) {
  var code = document.getElementById('s-code-' + index).value.trim();
  if (code.length >= 4) {
    fetchQuote(code).then(function(q) {
      if (q && q.price) {
        var priceEl = document.getElementById('s-price-' + index);
        if (priceEl && !priceEl.value) priceEl.value = q.price;
        if (q.name) {
          var nameEl = document.getElementById('s-name-' + index);
          if (nameEl && !nameEl.value) nameEl.value = q.name;
        }
      }
    });
  }
}

async function ensureName(code, currentName) {
  if (currentName && currentName !== code) return currentName;
  var pos = data.positions.find(function(p) { return p.code === code; });
  if (pos && pos.name && pos.name !== code) return pos.name;
  try {
    var q = await fetchQuote(code);
    if (q && q.name) return q.name;
  } catch(e) {}
  return currentName || code;
}

async function confirmSmartItem(index) {
  var item = window._smartParsed[index];
  if (!item) return;

  var code = classifyCode.normalizeCode(document.getElementById('s-code-' + index).value.trim());
  var name = await ensureName(code, document.getElementById('s-name-' + index).value.trim());
  var price = parseFloat(document.getElementById('s-price-' + index).value) || 0;
  var quantity = parseInt(document.getElementById('s-qty-' + index).value) || 0;
  if (!code || !price || !quantity) { showToast('请填写代码、价格和数量'); return; }

  if (item.kind === 'trade') {
    var direction = document.getElementById('s-dir-' + index).value;
    var date = document.getElementById('s-date-' + index).value;
    addTradeInternal(code, name, direction, price, quantity, date);
  } else {
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
    showToast('已导入持仓 ' + (name || code));
  }

  var row = document.getElementById('s-code-' + index);
  if (row && row.closest('tr')) row.closest('tr').remove();
  window._smartParsed.splice(index, 1);
}

async function confirmAllSmartItems() {
  if (!window._smartParsed || window._smartParsed.length === 0) return;
  for (var i = window._smartParsed.length - 1; i >= 0; i--) {
    await confirmSmartItem(i);
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
              doSmartParse(file, 'vision');
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
    headers.map(function (h, i) { return '<option value="' + i + '">' + (h || '(空表头' + (i + 1) + ')') + '</option>'; }).join('');
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
      '<td style="padding:6px;border-top:1px solid #f0f0f0;">' + (map.date >= 0 ? row[map.date] : '') + '</td>' +
      '<td style="padding:6px;border-top:1px solid #f0f0f0;">' + (map.nav >= 0 ? row[map.nav] : '') + '</td>' +
      '<td style="padding:6px;border-top:1px solid #f0f0f0;">' + (map.total >= 0 ? row[map.total] : '') + '</td>' +
      '<td style="padding:6px;border-top:1px solid #f0f0f0;">' + (map.invested >= 0 ? row[map.invested] : '') + '</td>' +
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
