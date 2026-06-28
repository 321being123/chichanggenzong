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
    const r = await fetch('/api/quote/' + encodeURIComponent(code));
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
    const r = await fetch('/api/hkrate');
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
}

/**
 * 完整刷新：拉行情 + 反推现金 + 保存 + 重渲染
 * 供"刷新按钮/F5/自动刷新"统一调用
 */
async function doRefresh() {
  await refreshAllPrices();
  var s = calcSummary();
  if (typeof TOTAL_ASSET !== 'undefined' && TOTAL_ASSET > 0) {
    data.cash = Math.round((TOTAL_ASSET - (s.equityVal + s.debtVal)) * 100) / 100;
    data.totalAsset = TOTAL_ASSET; // 持久化总市值
  }
  // 有真实数据时才触发保存（只保存用户修改的字段，不保存实时价格）
  var hasData = data.positions.length > 0 || data.trades.length > 0 || data.navHistory.length > 0;
  if (hasData) saveData();
  renderAll();
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
  const code = document.getElementById('quick-code').value.trim();
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
    const subtype = parts[2] || (type === '股权' ? 'A股' : '可转债');
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
  const s = calcSummary();
  var container = document.getElementById('stats-container');
  if (!container) return;
  
  // 首次渲染生成卡片结构
  if (!container.querySelector('.stat-card')) {
    container.innerHTML = 
      '<div class="stat-card">' +
        '<div class="stat-top">' +
          '<div><div class="label">总资产</div><div class="value" id="stat-total"></div><div class="sub" id="stat-total-sub"></div></div>' +
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
  if (el('stat-total')) el('stat-total').textContent = fmt(s.total);
  if (el('stat-total-sub')) el('stat-total-sub').textContent = '持仓市值 ' + fmt(s.total - s.cash) + ' + 现金 ' + fmt(s.cash);
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
  chartCategory = new Chart(ctx1, {
    type: 'doughnut',
    data: {
      labels: ['股权', '债权', '现金'],
      datasets: [{
        data: [s.equityVal, s.debtVal, s.cash],
        backgroundColor: ['#d93025', '#1a73e8', '#137333'],
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
              const v = ctx.raw;
              const p = s.total > 0 ? (v / s.total * 100).toFixed(1) : 0;
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

  if (list.length === 0) {
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
    const typeTag = p.type === '股权'
      ? '<span class="tag tag-equity">股权</span>'
      : '<span class="tag tag-debt">债权</span>';
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
  html += '</tbody></table>';
  el.innerHTML = html;
  if (targetId === 'topn-table') {
    document.getElementById('topn-summary').textContent = '共 ' + data.positions.length + ' 只持仓';
  }
}

// ===================== 交易表格渲染 =====================

function renderTrades() {
  const el = document.getElementById('trades-table');
  if (data.trades.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="icon">📄</div><p>暂无交易记录</p></div>';
    return;
  }
  var html = '<table><thead><tr>' +
    '<th>时间</th><th>代码</th><th>名称</th><th>方向</th>' +
    '<th class="text-right">价格</th><th class="text-right">数量</th><th class="text-right">成交额</th>' +
    '<th>类型</th><th>备注</th><th class="text-center">操作</th>' +
    '</tr></thead><tbody>';
  [...data.trades].reverse().forEach(t => {
    const dirLabel = t.direction === 'buy'
      ? '<span class="tag tag-equity">买入</span>'
      : '<span class="tag tag-cash">卖出</span>';
    html += '<tr>' +
      '<td>' + (t.date || '-') + '</td>' +
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
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ===================== 交易录入 =====================

function addTrade() {
  const code = document.getElementById('trade-code').value.trim();
  const name = document.getElementById('trade-name').value.trim() || code;
  const direction = document.getElementById('trade-direction').value;
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
    date: new Date().toISOString().slice(0, 10),
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

  // 更新现金
  if (direction === 'buy') data.cash = (data.cash || 0) - amount;
  else data.cash = (data.cash || 0) + amount;

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

function savePosition() {
  const code = document.getElementById('modal-code').value.trim();
  const name = document.getElementById('modal-name').value.trim();
  const price = parseFloat(document.getElementById('modal-price').value);
  const qty = parseInt(document.getElementById('modal-qty').value);
  const cost = parseFloat(document.getElementById('modal-cost').value) || price;
  const type = document.getElementById('modal-type').value;
  const subtype = document.getElementById('modal-subtype').value;
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
    data.trades = data.trades.filter(t => data.positions.some(p => p.code === t.code));
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
  data.cash = parseFloat(val) || 0;
  saveData();
  renderStats();
  renderCharts();
}

// ===================== 截图 OCR =====================

// 图片预处理：灰度化 + 自适应二值化 + 2x放大（大幅提升Tesseract识别率）
function preprocessImage(file) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() {
      var scale = 2;
      var w = img.naturalWidth * scale;
      var h = img.naturalHeight * scale;
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      // 先画白底（防止透明背景影响二值化）
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      var imageData = ctx.getImageData(0, 0, w, h);
      var data = imageData.data;

      // 自适应阈值：取所有像素的平均亮度
      var sum = 0, count = data.length / 4;
      for (var i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      }
      var threshold = sum / count;

      // 二值化：暗字变黑、背景变白
      for (var i = 0; i < data.length; i += 4) {
        var gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
        var val = gray > threshold ? 255 : 0;
        data[i] = data[i+1] = data[i+2] = val;
      }

      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob(function(blob) { resolve(blob); }, 'image/png');
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function handleOcrFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  await doOcr(file);
}

// OCR 区域拖拽事件（在 HTML 的 script 中绑定，这里也提供函数）
(function initOcrDragDrop() {
  const ocrZone = document.getElementById('ocr-zone');
  if (!ocrZone) return;
  ocrZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    ocrZone.classList.add('dragover');
  });
  ocrZone.addEventListener('dragleave', function () {
    ocrZone.classList.remove('dragover');
  });
  ocrZone.addEventListener('drop', function (e) {
    e.preventDefault();
    ocrZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) doOcr(file);
  });
})();
// 粘贴支持：Ctrl+V 粘贴截图到 OCR 页面
(function initOcrPaste() {
  document.addEventListener('paste', function (e) {
    var ocrPage = document.getElementById('page-ocr');
    if (!ocrPage || !ocrPage.classList.contains('active')) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        var blob = items[i].getAsFile();
        if (blob) { doOcr(blob); break; }
      }
    }
  });
})();

async function doOcr(file) {
  // 隐藏原提示文字
  var hint = document.getElementById('ocr-result-hint');
  if (hint) hint.style.display = 'none';
  var loading = document.getElementById('ocr-loading');
  if (loading) loading.style.display = 'block';
  var resultEl = document.getElementById('ocr-result');
  if (resultEl) resultEl.innerHTML = '';
  var parsedEl = document.getElementById('ocr-parsed-table');
  if (parsedEl) parsedEl.innerHTML = '';

  try {
    // 1. 预处理：灰度 + 二值化 + 放大
    var p = document.querySelector('#ocr-loading p');
    if (p) p.textContent = '预处理图片...';
    var processedBlob = await preprocessImage(file);

    // 2. 预览图用原图
    const imgUrl = URL.createObjectURL(file);
    const previewHtml =
      '<div style="margin-bottom:12px;">' +
      '<img src="' + imgUrl + '" style="max-width:100%;max-height:300px;border-radius:8px;">' +
      '</div>';

    // 3. Tesseract 识别（用预处理后的图片）
    const worker = await Tesseract.createWorker('chi_sim+eng', 1, {
      logger: function (m) {
        var lp = document.querySelector('#ocr-loading p');
        if (!lp) return;
        if (m.status === 'loading tesseract core') lp.textContent = '加载引擎...';
        else if (m.status === 'initializing tesseract') lp.textContent = '初始化...';
        else if (m.status === 'loading language traineddata') lp.textContent = '下载语言包...';
        else if (m.status === 'initializing api') lp.textContent = '初始化API...';
        else if (m.status === 'recognizing text')
          lp.textContent = '识别中... ' + (m.progress * 100).toFixed(0) + '%';
      }
    });
    // PSM 6 = 假设为统一文本块（适合截图表格）
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const { data: { text } } = await worker.recognize(processedBlob);
    await worker.terminate();

    if (loading) loading.style.display = 'none';
    if (resultEl) resultEl.innerHTML =
      previewHtml + '<h3>识别结果</h3><pre>' + (text || '(未识别到文字)') + '</pre>';

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const parsed = parseOcrLines(lines);

    if (parsed.length > 0) {
      var html = '<table><thead><tr>' +
        '<th>代码</th><th>名称</th><th class="text-right">价格</th><th class="text-right">数量</th>' +
        '<th class="text-right">金额</th><th>方向</th><th>类型</th>' +
        '<th>确认</th>' +
        '</tr></thead><tbody>';
      parsed.forEach(function (item, i) {
        const rec = recognizeCode(item.code) || { type: '股权', subtype: 'A股' };
        var dirOptions = '<option value="buy"' +
          (item.direction === 'buy' ? ' selected' : '') + '>买入</option>' +
          '<option value="sell"' +
          (item.direction === 'sell' ? ' selected' : '') + '>卖出</option>';
        html += '<tr>' +
          '<td><input type="text" id="ocr-code-' + i + '" value="' + item.code +
            '" style="width:70px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"' +
            ' oninput="onOcrCodeChange(' + i + ')"></td>' +
          '<td><input type="text" id="ocr-name-' + i + '" value="' + item.name +
            '" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
          '<td><input type="number" id="ocr-price-' + i + '" value="' + item.price +
            '" step="0.001" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
          '<td><input type="number" id="ocr-qty-' + i + '" value="' + item.quantity +
            '" step="1" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
          '<td class="text-right">' + (item.amount ? fmt(item.amount) : '-') + '</td>' +
          '<td><select id="ocr-dir-' + i + '" style="padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' +
            dirOptions + '</select></td>' +
          '<td><span class="tag ' + (rec.type === '股权' ? 'tag-equity' : 'tag-debt') + '">' +
            rec.type + '</span> <span style="font-size:11px;color:#999;">' + rec.subtype + '</span></td>' +
          '<td><button class="btn btn-success btn-sm" onclick="confirmOcrItem(' + i + ')">确认录入</button></td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      if (parsedEl) parsedEl.innerHTML = html;
      window._ocrParsed = parsed;
    } else {
      if (parsedEl) parsedEl.innerHTML =
        '<div class="empty-state"><p>未能自动识别出交易数据，建议手动在"交易"页面录入</p></div>';
    }
  } catch (e) {
    if (loading) loading.style.display = 'none';
    var errMsg = '<div class="confirm-box">OCR识别失败: ' + e.message + '</div>';
    if (hint) { hint.style.display = 'block'; hint.innerHTML = errMsg; }
    if (resultEl) resultEl.innerHTML = errMsg;
  }
}

function onOcrCodeChange(index) {
  const code = document.getElementById('ocr-code-' + index).value.trim();
  if (code.length >= 4) {
    fetchQuote(code).then(function (q) {
      if (q && q.price) {
        document.getElementById('ocr-price-' + index).value = q.price;
        if (q.name) document.getElementById('ocr-name-' + index).value = q.name;
      }
    });
  }
}

/**
 * 将 OCR 文本按交易块分组
 * 每遇到"买入/卖出"等关键词开始一个新块
 */
function parseOcrLines(lines) {
  const results = [];
  let currentBlock = '';
  for (const line of lines) {
    if (/买入|卖出|buy|sell|成交|委托|交易|购入|减持|增持/i.test(line) || currentBlock === '') {
      if (currentBlock) {
        const parsed = tryParseBlock(currentBlock);
        if (parsed) results.push(parsed);
      }
      currentBlock = line + '\n';
    } else {
      currentBlock += line + '\n';
    }
  }
  if (currentBlock) {
    const parsed = tryParseBlock(currentBlock);
    if (parsed) results.push(parsed);
  }
  return results;
}

/**
 * 从 OCR 文本块中解析交易数据（价格、数量、金额）
 *
 * 改进的启发式策略：
 * 1. 先识别价格特征：带 2~3 位小数、数值在 0.01~100000 之间的数字
 * 2. 再识别数量特征：整数（或带 0 小数）、数值不太大也不太小的数字
 * 3. 金额 = 价格 × 数量，用这个关系验证
 * 4. 如果 OCR 文本中标有"数量""价格"等中文标签，给予更高权重
 */
function tryParseBlock(text) {
  const numbers = text.match(/[0-9]+(?:\.[0-9]+)?/g) || [];
  const lower = text.toLowerCase();
  let direction = 'buy';
  if (/卖出|sell|减持|卖|出/i.test(lower)) direction = 'sell';

  if (numbers.length === 0) return null;

  const floats = numbers.map(Number);
  let price = null;
  let quantity = null;
  let amount = null;

  // --- 改进的启发式解析 ---

  // 检测文本中的标签关键词，辅助判断
  var hasPriceLabel = /价格|单价|成本|现价|price|成交价/i.test(text);
  var hasQtyLabel = /数量|股数|张数|份数|持有|quantity|qty/i.test(text);
  var hasAmountLabel = /金额|成交额|总额|总计|合计|amount|total/i.test(text);
  var hasCodeLabel = /代码|证券代码|股票代码|编号|code/i.test(text);

  // 第一阶段：识别各数字的角色
  // 收集浮点数及其字符串形式
  var numberInfo = floats.map(function (v, i) {
    var str = numbers[i];
    var decimalPlaces = (str.indexOf('.') >= 0) ? str.length - str.indexOf('.') - 1 : 0;
    var isInteger = (str.indexOf('.') < 0);
    return {
      value: v,
      str: str,
      decimalPlaces: decimalPlaces,
      isInteger: isInteger,
      // 价格特征：有 2~3 位小数，且在合理价格区间
      looksLikePrice: (decimalPlaces >= 2 && decimalPlaces <= 3 && v > 0.01 && v < 100000),
      // 数量特征：整数或只有 0 位小数，且在合理数量区间
      looksLikeQty: (isInteger || decimalPlaces === 0) && v >= 1 && v < 10000000,
      // 金额特征：数额较大，可能在 100 以上
      looksLikeAmount: v >= 100 && v <= 100000000
    };
  });

  // 第二阶段：如果有 3 个或更多数字，尝试用 price * qty ≈ amount 匹配
  if (numberInfo.length >= 3) {
    // 尝试找一组 price, qty, amount 满足 price * qty ≈ amount
    var bestMatch = null;
    var bestDiff = Infinity;
    for (var pi = 0; pi < numberInfo.length; pi++) {
      for (var qi = 0; qi < numberInfo.length; qi++) {
        if (qi === pi) continue;
        for (var ai = 0; ai < numberInfo.length; ai++) {
          if (ai === pi || ai === qi) continue;
          var pVal = numberInfo[pi].value;
          var qVal = numberInfo[qi].value;
          var aVal = numberInfo[ai].value;
          var product = pVal * qVal;
          var diff = Math.abs(product - aVal) / Math.max(aVal, 1);
          if (diff < 0.05 && diff < bestDiff) {
            // 检查上下文标签匹配
            var score = 0;
            if (hasPriceLabel && numberInfo[pi].looksLikePrice) score += 2;
            if (hasQtyLabel && numberInfo[qi].looksLikeQty) score += 2;
            if (hasAmountLabel && numberInfo[ai].looksLikeAmount) score += 2;
            if (numberInfo[pi].looksLikePrice) score += 1;
            if (numberInfo[qi].looksLikeQty) score += 1;
            if (numberInfo[ai].looksLikeAmount) score += 1;
            bestDiff = diff;
            bestMatch = { price: numberInfo[pi], quantity: numberInfo[qi], amount: numberInfo[ai], score: score };
          }
        }
      }
    }
    if (bestMatch && bestMatch.score > 0) {
      price = bestMatch.price.value;
      quantity = bestMatch.quantity.value;
      amount = bestMatch.amount.value;
    }
  }

  // 第三阶段：如果上面的匹配没找到，fallback 策略
  if (price === null) {
    // 先识别价格：找看起来像价格的数字
    var priceCandidates = numberInfo.filter(function (n) { return n.looksLikePrice; });
    var qtyCandidates = numberInfo.filter(function (n) { return n.looksLikeQty; });
    var amountCandidates = numberInfo.filter(function (n) { return n.looksLikeAmount; });

    // 如果只有 1 个数字，视为价格
    if (floats.length === 1) {
      price = floats[0];
    } else if (floats.length === 2) {
      // 2 个数字：通常一个价格、一个数量/金额
      if (priceCandidates.length === 1 && qtyCandidates.length === 1) {
        price = priceCandidates[0].value;
        quantity = qtyCandidates[0].value;
      } else if (amountCandidates.length >= 1 && priceCandidates.length === 1) {
        price = priceCandidates[0].value;
        amount = amountCandidates[0].value;
      } else {
        // 旧 fallback：小的是价格，大的是数量或金额
        var sorted2 = [...floats].sort(function (a, b) { return a - b; });
        if (sorted2[0] < 1000 && sorted2[1] > sorted2[0] * 10) {
          price = sorted2[0];
          quantity = Math.round(sorted2[1] / sorted2[0]) > 100
            ? Math.round(sorted2[1] / sorted2[0])
            : sorted2[1];
        } else {
          price = sorted2[0];
          quantity = sorted2[1];
        }
      }
    } else if (floats.length >= 3) {
      // 3 个以上数字：用优化后的规则
      if (priceCandidates.length >= 1) {
        // 取最像价格的那个作为价格
        price = priceCandidates[0].value;
        // 剩下数字中找数量
        var remaining = numberInfo.filter(function (n) { return n.value !== price; });
        var qtyCand = remaining.filter(function (n) { return n.looksLikeQty; });
        if (qtyCand.length >= 1) {
          quantity = qtyCand[0].value;
          var remain2 = remaining.filter(function (n) { return n.value !== quantity; });
          if (remain2.length >= 1 && remain2[0].looksLikeAmount) {
            amount = remain2[0].value;
          }
        }
      }
      // 如果仍然没识别出来，使用旧 fallback
      if (price === null) {
        var sorted = [...floats].sort(function (a, b) { return a - b; });
        // 尝试: 最小的可能是数量(可转债张数通常小)，中间是价格，最大是金额
        // 但要根据上下文判断
        if (hasPriceLabel || hasAmountLabel) {
          // 有标签时，按标签辅助判断
          quantity = sorted[0];
          price = sorted[1];
          amount = sorted[2];
        } else {
          // 无标签时，检查数值是否合理
          var smallest = sorted[0];
          var middle = sorted[1];
          var largest = sorted[2];
          // 如果最小值和中间值相差很大，可能是(数量, 价格)或(价格, 金额)
          if (middle / smallest > 10 && largest / middle > 2) {
            // 数量 价格 金额
            quantity = smallest;
            price = middle;
            amount = largest;
          } else if (largest / middle > 100) {
            // 价格 数量 金额
            price = smallest;
            quantity = middle;
            amount = largest;
          } else {
            // 默认: 最小=数量, 中间=价格, 最大=金额
            quantity = smallest;
            price = middle;
            amount = largest;
          }
        }
      }
    }
  }

  // 提取代码（6位数字）
  let code = '';
  const codeMatch = text.match(/(?:^|[^0-9])([0-9]{6})(?:$|[^0-9])/);
  if (codeMatch) code = codeMatch[1];
  // 如果没找到6位代码，试试5位港股代码
  if (!code) {
    const hkMatch = text.match(/(?:^|[^0-9])([0-9]{5})(?:$|[^0-9])/);
    if (hkMatch) code = hkMatch[1];
  }

  // 提取名称
  let name = '';
  const nameMatch = text.match(/([^\d\s\n\r,.，。、；：()（）\[\]{}]{2,8})/);
  if (nameMatch) name = nameMatch[1];

  // 修正缺失字段
  if (!price && !quantity) return null;
  if (price && quantity && !amount) amount = price * quantity;
  if (price && !quantity && amount && amount > 0) quantity = Math.round(amount / price);
  if (!price && quantity && amount && amount > 0) price = amount / quantity;
  if (!price) return null;

  var result = {
    code: code,
    name: name,
    price: Math.round(price * 1000) / 1000,
    quantity: Math.round(quantity),
    amount: amount ? Math.round(amount * 100) / 100 : null,
    direction: direction
  };

  // 合理性校验：数量不超过 1000 万，价格不超过 100 万
  if (result.quantity > 10000000 || result.price > 1000000) return null;

  return result;
}

function confirmOcrItem(index) {
  const item = window._ocrParsed[index];
  if (!item) return;
  const code = document.getElementById('ocr-code-' + index).value.trim();
  const name = document.getElementById('ocr-name-' + index).value.trim();
  const price = parseFloat(document.getElementById('ocr-price-' + index).value);
  const qty = parseInt(document.getElementById('ocr-qty-' + index).value);
  const direction = document.getElementById('ocr-dir-' + index).value;
  if (!code || !name || isNaN(price) || isNaN(qty)) {
    showToast('请确认代码、名称、价格和数量');
    return;
  }

  const rec = recognizeCode(code) || { type: '股权', subtype: 'A股' };
  const trade = {
    id: uid(),
    date: new Date().toISOString().slice(0, 10),
    code: code, name: name, direction: direction,
    price: price, quantity: qty, amount: price * qty,
    type: rec.type, subtype: rec.subtype, note: 'OCR识别录入'
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
      existing.type = rec.type;
      existing.subtype = rec.subtype;
    } else {
      data.positions = data.positions.filter(p => p.id !== existing.id);
    }
  } else if (direction === 'buy') {
    data.positions.push({
      id: uid(), code: code, name: name,
      price: price, quantity: qty,
      type: rec.type, subtype: rec.subtype, cost: price, note: ''
    });
  }

  // 更新现金
  if (direction === 'buy') data.cash = (data.cash || 0) - price * qty;
  else data.cash = (data.cash || 0) + price * qty;

  saveData();
  renderAll();
  const btn = document.querySelector(
    '#ocr-parsed-table button[onclick="confirmOcrItem(' + index + ')"]'
  );
  if (btn) { btn.textContent = '已录入'; btn.disabled = true; btn.style.background = '#95a5a6'; }
  showToast('已录入 ' + name + ' ' + (direction === 'buy' ? '买入' : '卖出'));
}

// ===================== 数据导入导出 =====================

function exportData() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '仓位数据_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function exportToExcel() {
  var url = '/api/export/' + encodeURIComponent(currentAccount);
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
    date: new Date().toISOString().slice(0, 10),
    amount: cfAmount,
    note: noteInput ? noteInput.value.trim() : ''
  });
  // 同时更新现金余额
  data.cash = (data.cash || 0) + cfAmount;
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
 * - 公式：adjustedNav = lastNav.nav * (currentTotal / (lastTotalAsset + todayCashFlow))
 *   其中 todayCashFlow 是当天所有现金流的净额
 * - 现金流的金额同时累加到 data.cash 上，确保总资产正确
 */
function recordNav() {
  if (!data.navHistory) data.navHistory = [];
  const today = new Date().toISOString().slice(0, 10);
  // 如果今天已经记录过，跳过
  if (data.navHistory.length > 0 &&
      data.navHistory[data.navHistory.length - 1].date === today) return;

  const s = calcSummary();
  if (s.total <= 0) return;

  // 计算今天的净现金流（入金为正，出金为负）
  var todayCashFlow = 0;
  if (data.cashFlows) {
    data.cashFlows.forEach(function (cf) {
      if (cf.date === today) todayCashFlow += cf.amount;
    });
  }

  if (data.navHistory.length === 0) {
    // 第一条 NAV 记录，净值设为 1.0
    data.navHistory.push({
      date: today,
      nav: 1.0,
      totalAsset: s.total
    });
  } else {
    // 修正后的净值计算：
    // adjustedNav = lastNav * (currentTotal / (lastTotalAsset + todayCashFlow))
    // 即：剔除今天现金流影响后的真实净值增长
    const lastNav = data.navHistory[data.navHistory.length - 1];
    var baseAsset = lastNav.totalAsset + todayCashFlow;
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
            '<button class="period-btn active" onclick="switchPeriod(30)">近1月</button>' +
            '<button class="period-btn" onclick="switchPeriod(90)">近3月</button>' +
            '<button class="period-btn" onclick="switchPeriod(180)">近6月</button>' +
            '<button class="period-btn" onclick="switchPeriod(365)">近1年</button>' +
            '<button class="period-btn" onclick="switchPeriod(0)">全部</button>' +
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
          '<button class="period-btn" onclick="toggleIndex(\'sh\')" style="font-size:11px;padding:2px 10px;margin-left:4px;">沪深300</button>' +
          '<button class="period-btn" onclick="toggleIndex(\'sz\')" style="font-size:11px;padding:2px 10px;">上证指数</button>' +
          '<button class="period-btn" onclick="toggleIndex(\'zz\')" style="font-size:11px;padding:2px 10px;">中证全指</button>' +
          '<button class="period-btn" onclick="toggleIndex(\'hs\')" style="font-size:11px;padding:2px 10px;">恒生指数</button>' +
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
  document.getElementById('ret-total-return').textContent = fmt(Math.abs(totalReturn));
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
    const r = await fetch('/api/kline?secid=' + encodeURIComponent(secid) + '&days=' + (days || 365));
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
  document.querySelectorAll('.period-btn').forEach(function (b) { b.classList.remove('active'); });
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
      if (page) page.classList.add('active');
    });
  });
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
  // 每 60 秒自动刷新行情（收盘后且有价格则跳过）
  _autoRefreshTimer = setInterval(function () {
    if (data && data.positions && data.positions.length > 0) {
      // 收盘后且已有报价 → 不再自动刷新
      if (!isMarketOpen()) {
        var hasAnyPrice = data.positions.some(function(p) { return p.price > 0; });
        if (hasAnyPrice) return;
      }
      doRefresh();
    }
  }, 60000);
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
    var resp = await fetch('/api/data/' + encodeURIComponent(targetName));
    if (resp.ok) oldData = await resp.json();
  } catch(e) {}
  if (!oldData) oldData = { positions: [], trades: [], cash: 0, navHistory: [], cashFlows: [] };

  accounts[oldIdx] = n;
  if (wasCurrent) currentAccount = n;
  saveAccounts();

  // 保存到新名称下
  await fetch('/api/data/' + encodeURIComponent(n), {
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
