// shared/core-tables.js – 统计卡片/饼图/持仓表/交易表（原 core.js 拆分，全局作用域不变）
// ===================== 统计卡片渲染 =====================

function renderStats() {
  var s = calcSummary();
  var container = document.getElementById('stats-container');
  if (!container) return;
  
  // 计算今日涨跌（对比 nav_history 最近两条记录）；若最近两条间隔过大（如导入的历史快照），
  // 则无真实日涨跌，置 hasChange=false 由渲染端显示"-"
  var changeAmt = 0, changePct = 0, hasChange = false;
  if (data.navHistory && data.navHistory.length >= 2) {
    var last = data.navHistory[data.navHistory.length - 1];
    var prev = data.navHistory[data.navHistory.length - 2];
    var gapDays = daysBetweenDates(prev.date, last.date);
    if (gapDays != null && gapDays <= 4) {
      changeAmt = s.total - prev.totalAsset;
      changePct = prev.totalAsset > 0 ? (changeAmt / prev.totalAsset * 100) : 0;
      hasChange = true;
    }
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
    var scEl = el('stat-change');
    if (hasChange) {
      var arrow = changeAmt >= 0 ? '▲' : '▼';
      var color = changeAmt >= 0 ? '#d93025' : '#137333';
      scEl.innerHTML = '<span style="color:' + color + ';">' + arrow + ' ' + fmt(Math.abs(changeAmt)) + ' (' + (changeAmt >= 0 ? '+' : '') + changePct.toFixed(2) + '%)</span>';
      // 悬浮浮框：分解今日涨跌（股价影响 + 汇率影响 + 计算过程）
      bindChangeTip(scEl, changeAmt, changePct);
    } else {
      scEl.textContent = '-';
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

// 总资产今日涨跌浮框：分解「股价影响 + 汇率影响」并写出计算过程
function bindChangeTip(el, changeAmt, changePct) {
  if (!el) return;
  // 股价/债价涨跌影响（含今日汇率）= 各持仓(今价−昨价)×数量×汇率，与持仓明细「今日盈亏」同口径
  var priceImpact = 0;
  (data.positions || []).forEach(function (p) {
    var prof = getTodayProfit(p);
    if (prof != null) priceImpact += prof;
  });
  // 汇率影响 = 港股港币面值 ×（今日汇率 − 昨日快照汇率），直接算，不再用"今日涨跌−股价影响"残差
  var todayRate = Number(data.hkRate) || 0.868;
  var yesterdayRate = null;
  if (data.navHistory && data.navHistory.length >= 2) {
    var prevNav = data.navHistory[data.navHistory.length - 2];
    if (prevNav && prevNav.hkRate != null && prevNav.hkRate > 0) yesterdayRate = prevNav.hkRate;
  }
  var fxImpact = 0;
  var otherChange = null;
  if (yesterdayRate != null) {
    (data.positions || []).forEach(function (p) {
      if (p.subtype === '港股') {
        fxImpact += (Number(p.price) || 0) * (Number(p.quantity) || 0) * (todayRate - yesterdayRate);
      }
    });
    otherChange = changeAmt - priceImpact - fxImpact;
  } else {
    // 旧快照无汇率记录 → 残差兜底（保持与历史一致）
    fxImpact = changeAmt - priceImpact;
  }

  var tip = document.getElementById('stat-change-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'stat-change-tip';
    tip.style.cssText = 'position:fixed;z-index:9999;display:none;max-width:380px;background:#1f2329;color:#e8eaed;padding:12px 14px;border-radius:8px;font-size:12px;line-height:1.7;box-shadow:0 6px 20px rgba(0,0,0,.35);white-space:normal;pointer-events:none;';
    document.body.appendChild(tip);
  }
  el.style.cursor = 'help';
  el.onmouseenter = function () {
    tip.innerHTML = buildChangeTipHtml(changeAmt, changePct, priceImpact, fxImpact, otherChange);
    tip.style.display = 'block';
    var r = el.getBoundingClientRect();
    var left = r.left;
    if (left + 388 > window.innerWidth) left = Math.max(8, window.innerWidth - 388);
    tip.style.left = left + 'px';
    tip.style.top = (r.bottom + 8) + 'px';
  };
  el.onmouseleave = function () { tip.style.display = 'none'; };
}

function buildChangeTipHtml(changeAmt, changePct, priceImpact, fxImpact, otherChange) {
  var sign = function (v) { return (v >= 0 ? '+' : '-') + fmt(Math.abs(v)); };
  var arrow = function (v) { return v >= 0 ? '▲' : '▼'; };
  var col = function (v) { return v >= 0 ? '#f28b82' : '#81c995'; }; // 红涨绿跌
  var total = (changeAmt >= 0 ? '+' : '-') + fmt(Math.abs(changeAmt)) + ' (' + (changeAmt >= 0 ? '+' : '') + changePct.toFixed(2) + '%)';
  var html = '' +
    '<div style="font-weight:600;margin-bottom:6px;">总资产今日涨跌：<span style="color:' + col(changeAmt) + ';">' + arrow(changeAmt) + ' ' + total + '</span></div>' +
    '<div style="border-top:1px solid #3c4043;padding-top:6px;">' +
      '<div>股价/债价涨跌影响：<span style="color:' + col(priceImpact) + ';">' + arrow(priceImpact) + ' ' + sign(priceImpact) + '</span></div>' +
      '<div style="color:#9aa0a6;font-size:11px;margin:2px 0 6px;">各持仓（今价−昨价）×数量×汇率，仅反映价格变动</div>' +
      '<div>汇率影响：<span style="color:' + col(fxImpact) + ';">' + arrow(fxImpact) + ' ' + sign(fxImpact) + '</span></div>' +
      '<div style="color:#9aa0a6;font-size:11px;margin:2px 0 6px;">港股港币市值 ×（今日汇率−昨日汇率），反映港币兑人民币波动</div>';
  if (otherChange != null) {
    html += '<div>其他变动：<span style="color:' + col(otherChange) + ';">' + arrow(otherChange) + ' ' + sign(otherChange) + '</span></div>' +
      '<div style="color:#9aa0a6;font-size:11px;margin:2px 0 6px;">当日买卖、现金流入流出等</div>';
  }
  html += '<div style="border-top:1px solid #3c4043;padding-top:6px;">合计 = 股价影响 + 汇率影响' + (otherChange != null ? ' + 其他变动' : '') + ' = <span style="color:' + col(changeAmt) + ';">' + sign(changeAmt) + '</span></div>' +
    '</div>' +
    '<div style="color:#9aa0a6;font-size:11px;margin-top:6px;">注：持仓明细里的「今日盈亏」只看股价、不含汇率；这里的「汇率影响」是港币兑人民币波动造成的差额，和持仓盈亏对不上属正常现象。</div>';
  return html;
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
        tooltip: appChartTooltip({
          callbacks: {
            label: function (ctx) {
              var v = ctx.raw;
              var p = s.total > 0 ? (v / s.total * 100).toFixed(1) : 0;
              return ' ' + ctx.label + ': ' + fmt(v) + ' (' + p + '%)';
            }
          }
        })
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
        tooltip: appChartTooltip({
          callbacks: {
            label: function (ctx) {
              const p = s.total > 0 ? (ctx.raw / s.total * 100).toFixed(1) : 0;
              return ' ' + ctx.label + ': ' + fmt(ctx.raw) + ' (' + p + '%)';
            }
          }
        })
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

function getTodayProfit(position) {
  var change = priceChangeMap[position.code];
  var price = Number(position.price);
  if (change == null || !(price > 0) || change <= -100) return null;
  var previousClose = price / (1 + change / 100);
  var exchangeRate = position.subtype === '港股' ? (Number(data.hkRate) || 0.868) : 1;
  return (price - previousClose) * (Number(position.quantity) || 0) * exchangeRate;
}

// 估值列颜色（与可转债估值页一致，bond-valuation.css 已加载）
var POS_EVAL_CLASS = { '低估': 'val-low', '偏低估': 'val-low2', '合理': 'val-mid', '偏高估': 'val-high1', '高估': 'val-high', '风险折价': 'val-risk', '数据不足': 'val-none' };

// 点击持仓代码/名称 → 进入对应股票或可转债的证券分析
function openPositionAnalysis(code) {
  if (!code) return;
  switchMain('stock-analysis');
  setTimeout(function () {
    if (typeof securityAnalysisSelect === 'function') securityAnalysisSelect(code);
  }, 100);
}

// 点击估值标签 → 进入该可转债的估值详情页
function openPositionValuation(code) {
  if (!code) return;
  switchMain('bond-safety');
  if (typeof switchBondSub === 'function') switchBondSub('valuation');
  setTimeout(function () {
    if (typeof openBondValDetail === 'function') openBondValDetail(code);
  }, 120);
}

// 持仓代码转估值库格式（6位 → 带后缀，如 113050 → 113050.SH）；取不到市场就用原代码兜底
function positionCodeFull(code) {
  try {
    var info = classifyCode(code);
    if (info && info.market) return code + '.' + info.market.toUpperCase();
  } catch (e) {}
  return code;
}

// 可转债持仓显示估值标签 + 分位（可点击进详情）；其他持仓或查不到显示 —
function getValuationCell(position) {
  if (position.subtype !== '可转债') return '<td class="text-center" style="color:#bbb;">—</td>';
  var vm = (data && data.valuation_map) || {};
  var v = vm[position.code];
  if (!v || !v.eval_class) return '<td class="text-center" style="color:#bbb;">—</td>';
  var cls = POS_EVAL_CLASS[v.eval_class] || '';
  var pct = (v.percentile != null && Number.isFinite(Number(v.percentile))) ? ' ' + Number(v.percentile).toFixed(0) + '%' : '';
  return '<td class="text-center"><a href="javascript:void(0)" class="pos-link" title="查看估值详情" onclick="openPositionValuation(\'' + escapeHtml(positionCodeFull(position.code)) + '\')"><span class="' + cls + '">' + escapeHtml(v.eval_class) + pct + '</span></a></td>';
}

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
  const activePositions = (data.positions || []).filter(function(p) { return Number(p.quantity) > 0; });
  let list = [...activePositions];

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
      else if (col === 'todayProfit') {
        va = getTodayProfit(a);
        vb = getTodayProfit(b);
        if (va == null || vb == null) {
          if (va == null && vb == null) return 0;
          return va == null ? 1 : -1;
        }
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
    const types = [...new Set(activePositions.map(p => p.type).filter(Boolean))];
    const subtypes = [...new Set(activePositions.map(p => p.subtype).filter(Boolean))];
    filterBar = '<div class="filter-bar">' +
      '<span class="filter-label">筛选:</span>' +
      '<select onchange="setFilter(&quot;type&quot;,this.value)">' +
      '<option value="">全部类型</option>' +
      types.map(t => '<option value="' + escapeHtml(t) + '"' + (filterState.type === t ? ' selected' : '') + '>' + escapeHtml(t) + '</option>').join('') +
      '</select>' +
      '<select onchange="setFilter(&quot;subtype&quot;,this.value)">' +
      '<option value="">全部细类</option>' +
      subtypes.map(s => '<option value="' + escapeHtml(s) + '"' + (filterState.subtype === s ? ' selected' : '') + '>' + escapeHtml(s) + '</option>').join('') +
      '</select>' +
      ((filterState.type || filterState.subtype)
        ? '<button class="btn btn-outline btn-sm" onclick="filterState={type:&quot;&quot;,subtype:&quot;&quot;};renderPositionsTable(&quot;positions-table&quot;);renderPositionsTable(&quot;topn-table&quot;)">清除筛选</button>'
        : '') +
      '<button class="btn btn-success btn-sm" style="margin-left:auto;" onclick="exportToExcel()">导出EXCEL</button>' +
      '<span style="color:#bbb;">' + list.length + ' / ' + activePositions.length + ' 只</span>' +
      '</div>';
  }

  var html = filterBar + '<table class="positions-data-table"><thead><tr>' +
    '<th style="width:40px;" class="sortable" onclick="setSort(&quot;xh&quot;)">序号' + sortArrow('xh') + '</th>' +
    '<th class="sortable" onclick="setSort(&quot;code&quot;)">代码' + sortArrow('code') + '</th>' +
    '<th class="sortable" onclick="setSort(&quot;name&quot;)">名称' + sortArrow('name') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(&quot;price&quot;)">现价' + sortArrow('price') + '</th>' +
    '<th class="text-right sortable" style="width:70px;" onclick="setSort(&quot;chg&quot;)">涨跌' + sortArrow('chg') + '</th>' +
    '<th class="sortable" onclick="setSort(&quot;todayProfit&quot;)">今日盈亏（元）' + sortArrow('todayProfit') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(&quot;qty&quot;)">数量' + sortArrow('qty') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(&quot;mv&quot;)">市值' + sortArrow('mv') + '</th>' +
    '<th class="text-right sortable" onclick="setSort(&quot;pct&quot;)">比例' + sortArrow('pct') + '</th>' +
    '<th class="sortable" onclick="setSort(&quot;type&quot;)">类型' + sortArrow('type') + '</th>' +
    '<th class="sortable" onclick="setSort(&quot;subtype&quot;)">细类' + sortArrow('subtype') + '</th>' +
    '<th class="text-center" style="width:110px;">估值</th>' +
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
    var todayProfit = getTodayProfit(p);
    var todayProfitDisplay = todayProfit == null
      ? '<span style="color:#bbb;">--</span>'
      : (todayProfit >= 0 ? '+' : '') + fmt(todayProfit);
    var todayProfitStyle = todayProfit == null ? 'color:#bbb;' : (todayProfit >= 0 ? 'color:#d93025;' : 'color:#137333;');

    html += '<tr>' +
      '<td style="text-align:center;color:#bbb;">' + (idx + 1) + '</td>' +
      '<td style="font-weight:600;color:' + getSubtypeColor(p.subtype) + ';"><a href="javascript:void(0)" class="pos-link" style="color:inherit;" title="查看证券分析" onclick="openPositionAnalysis(\'' + escapeHtml(p.code || '') + '\')">' + escapeHtml(p.code || '-') + '</a></td>' +
      '<td><strong><a href="javascript:void(0)" class="pos-link" style="color:inherit;font-weight:600;" title="查看证券分析" onclick="openPositionAnalysis(\'' + escapeHtml(p.code || '') + '\')">' + escapeHtml(p.name || '未知') + '</a></strong></td>' +
      '<td class="text-right" style="font-weight:600;' + priceStyle + '">' + priceDisplay + '</td>' +
      '<td class="text-right" style="font-weight:600;font-size:13px;' + chgStyle + '">' + chgDisplay + '</td>' +
      '<td style="font-weight:600;' + todayProfitStyle + '">' + todayProfitDisplay + '</td>' +
      '<td class="text-right">' + (p.quantity != null ? fmtQty(p.quantity) : 0) + '</td>' +
      '<td class="text-right" style="font-weight:600;">' + fmt(mv) + '</td>' +
      '<td class="text-right">' + pct + '%</td>' +
      '<td>' + typeTag + '</td>' +
      '<td>' + subtypeTag + '</td>' +
      getValuationCell(p) +
      (limit ? '' : '<td class="text-center">' +
        '<button class="btn btn-outline btn-sm" data-act="editPosition" data-id="' + escapeHtml(p.id) + '">编辑</button> ' +
        '<button class="btn btn-danger btn-sm" data-act="deletePosition" data-id="' + escapeHtml(p.id) + '">删除</button>' +
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
      '<td style="color:#bbb;">-</td>' +
      '<td class="text-right" style="color:#bbb;">-</td>' +
      '<td class="text-right" style="font-weight:600;">' + fmt(cashAmt) + '</td>' +
      '<td class="text-right">' + cashPct + '%</td>' +
      '<td><span class="tag ' + cashTypeTag + '">' + escapeHtml(data.cashType || '现金') + '</span></td>' +
      '<td><span class="tag tag-cash">' + escapeHtml(data.cashSubtype || '现金') + '</span></td>' +
      '<td class="text-center" style="color:#bbb;">—</td>' +
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
    '<th class="text-right">价格</th><th class="text-right">数量</th><th class="text-right">成交额</th><th class="text-right">费用</th>' +
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
        '<td>' + escapeHtml(t.created_at || t.date || '-') + '</td>' +
        '<td>' + escapeHtml(t.code || '-') + '</td>' +
        '<td>' + escapeHtml(displayName || '-') + '</td>' +
        '<td>' + dirLabel + '</td>' +
        '<td class="text-right">' + (t.price != null ? Number(t.price).toFixed(3) : '-') + '</td>' +
        '<td class="text-right ' + (t.direction === 'buy' ? 'positive' : 'negative') + '">' +
          (t.direction === 'buy' ? '+' : '-') + fmtQty(t.quantity) + '</td>' +
        '<td class="text-right">' + (t.amount != null ? fmt(t.amount) : '-') + '</td>' +
        '<td class="text-right">' + (tradeFeeTotal(t) ? fmt(tradeFeeTotal(t)) : '-') + '</td>' +
        '<td>' + escapeHtml(t.type || '-') + '</td>' +
        '<td>' + escapeHtml(t.note || '') + '</td>' +
        '<td class="text-center"><button class="btn btn-danger btn-sm" data-act="deleteTrade" data-id="' + escapeHtml(t.id) + '">删除</button></td>' +
        '</tr>';
    } else {
      const c = item.raw;
      const isIn = c.amount >= 0;
      const dirLabel = isIn
        ? '<span class="tag tag-cash">入金</span>'
        : '<span class="tag tag-equity">出金</span>';
      html += '<tr>' +
        '<td>' + escapeHtml(c.created_at || c.date || '-') + '</td>' +
        '<td>现金</td>' +
        '<td>现金' + (c.note ? '·' + escapeHtml(c.note) : '') + '</td>' +
        '<td>' + dirLabel + '</td>' +
        '<td class="text-right">-</td>' +
        '<td class="text-right">-</td>' +
        '<td class="text-right ' + (isIn ? 'positive' : 'negative') + '">' +
          (isIn ? '+' : '-') + fmt(Math.abs(c.amount)) + '</td>' +
        '<td class="text-right">-</td>' +
        '<td>现金</td>' +
        '<td>' + escapeHtml(c.note || '') + '</td>' +
        '<td class="text-center"><button class="btn btn-danger btn-sm" data-act="deleteCashFlow" data-id="' + escapeHtml(c.id) + '">删除</button></td>' +
        '</tr>';
    }
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function deleteCashFlow(id) {
  if (!id) return;
  // 服务端统一账本：删除后重算现金并返回最新结果（方案阶段一第 5 条）
  try {
    const r = await fetch(api('/api/accounts/' + encodeURIComponent(currentAccount) + '/ledger/cash-flows/' + encodeURIComponent(id) + '?version=' + (dataVersion != null ? dataVersion : '')), {
      method: 'DELETE'
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(j.error || '删除现金流失败'); return; }
    if (j.data) {
      data = j.data;
      dataVersion = j.data.version || dataVersion;
      if (typeof j.data.posVersion === 'number') dataPosVersion = j.data.posVersion;
      if (typeof j.data.tradeVersion === 'number') dataTradeVersion = j.data.tradeVersion;
      if (typeof j.data.navVersion === 'number') dataNavVersion = j.data.navVersion;
      if (typeof j.data.cashflowVersion === 'number') dataCashVersion = j.data.cashflowVersion;
      restorePriceChangeMap();
    }
    renderAll();
    showToast('现金流记录已删除');
  } catch (e) {
    showToast('删除失败：' + (e.message || e));
  }
}

// ===================== 事件委托：替代“把用户数据拼进内联 onclick” =====================
// 把账户名 / 记录 ID / 日期等用户可控数据通过 data-* 属性传递，点击时由委托统一分发，
// 避免将数据嵌入 JS 源码字符串导致持久型 XSS。
(function initActionDelegation() {
  if (window.__actionDelegated) return;
  window.__actionDelegated = true;
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var id = btn.getAttribute('data-id');
    var name = btn.getAttribute('data-account');
    var date = btn.getAttribute('data-date');
    if (act === 'editPosition') editPosition(id);
    else if (act === 'deletePosition') deletePosition(id);
    else if (act === 'deleteTrade') deleteTrade(id);
    else if (act === 'deleteCashFlow') deleteCashFlow(id);
    else if (act === 'editAccount') editAccount(name);
    else if (act === 'promptDeleteAccount') promptDeleteAccount(name);
    else if (act === 'openNavEdit') openNavEdit(date);
    else if (act === 'deleteNav') deleteNav(date);
  });
})();
