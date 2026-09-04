var homeDashboardLoading = false;
var homeMarketCyclesLoading = false;
var homeMarketCyclesLoaded = false;
var homeMarketCycleMetric = 'pe';

function homeSetText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value;
}

function homeEventRows(calendar) {
  var rows = [];
  (calendar || []).forEach(function(day) {
    [['apply_stocks','新股申购'],['apply_bonds','新债申购'],['list_stocks','新股上市'],['list_bonds','新债上市']].forEach(function(group) {
      (day[group[0]] || []).forEach(function(item) { rows.push({ date:day.date, name:item.name, code:item.code, type:group[1] }); });
    });
  });
  return rows.sort(function(a,b) { return String(a.date).localeCompare(String(b.date)); });
}

function renderHomeHoldings() {
  if (!username) {
    homeSetText('home-total-asset', '登录后查看');
    homeSetText('home-position-count', '个人持仓数据');
    homeSetText('home-cash-value', '点击进入登录');
    return;
  }
  if (!data || !Array.isArray(data.positions)) return;
  var summary = calcSummary();
  homeSetText('home-total-asset', fmt(summary.total));
  homeSetText('home-position-count', data.positions.length + ' 项持仓');
  homeSetText('home-cash-value', '现金 ' + fmt(summary.cash));
}

function renderHomeIpo(calendar) {
  var rows = homeEventRows(calendar);
  homeSetText('home-ipo-count', String(rows.length));
  homeSetText('home-ipo-next', rows.length ? '下一安排：' + rows[0].date + ' ' + rows[0].name : '暂无已排期事件');
  var el = document.getElementById('home-ipo-list');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="home-overview-empty">暂无已排期的申购或上市</div>'; return; }
  el.innerHTML = rows.slice(0, 5).map(function(row) {
    return '<div class="home-overview-row"><span class="home-date">' + escapeHtml(row.date) + '</span><span class="home-event-name">' + escapeHtml(row.name || '-') + ' <small>' + escapeHtml(row.code || '') + '</small></span><span class="home-event-tag">' + escapeHtml(row.type) + '</span></div>';
  }).join('');
}

function renderHomeBonds(payload) {
  var rows = payload && (payload.data || payload.rows) || [];
  var counts = payload && payload.safety_counts ? payload.safety_counts : { '安全':0, '低风险':0, '中风险':0, '高风险':0 };
  if (!payload || !payload.safety_counts) rows.forEach(function(row) { if (Object.prototype.hasOwnProperty.call(counts,row.safety)) counts[row.safety]++; });
  var totalCount = payload && Number.isFinite(Number(payload.total)) ? Number(payload.total) : rows.length;
  homeSetText('home-bond-count', String(totalCount));
  homeSetText('home-bond-safe', '安全 ' + counts['安全']);
  homeSetText('home-bond-risk', '高风险 ' + counts['高风险']);
  var colors = { '安全':'#19a463', '低风险':'#7bbf45', '中风险':'#f3b33d', '高风险':'#e05a47' };
  var total = totalCount || 1, el = document.getElementById('home-bond-distribution');
  if (!el) return;
  el.innerHTML = Object.keys(counts).map(function(key) {
    var pct = counts[key] / total * 100;
    return '<div class="home-risk-row"><span>' + key + '</span><div class="home-risk-track"><div class="home-risk-fill" style="width:' + pct.toFixed(1) + '%;background:' + colors[key] + '"></div></div><b>' + counts[key] + '</b></div>';
  }).join('');
}

function homeCycleNumber(value, digits) {
  if (value === null || value === undefined || value === '') return '--';
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits == null ? 2 : digits) : '--';
}

function homeCycleRange(values, fixedMin, fixedMax) {
  var nums = values.filter(function(value) {
    return value !== null && value !== undefined && value !== '';
  }).map(Number).filter(Number.isFinite);
  var min = fixedMin == null ? Math.min.apply(null, nums) : fixedMin;
  var max = fixedMax == null ? Math.max.apply(null, nums) : fixedMax;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (fixedMin == null || fixedMax == null) {
    var pad = Math.max((max - min) * .08, .1);
    if (fixedMin == null) min -= pad;
    if (fixedMax == null) max += pad;
  }
  return { min:min, max:max };
}

function homeCyclePath(rows, field, xAt, yAt) {
  var path = '', drawing = false;
  rows.forEach(function(row, index) {
    var raw = row[field];
    if (raw === null || raw === undefined || raw === '') { drawing = false; return; }
    var value = Number(raw);
    if (!Number.isFinite(value)) { drawing = false; return; }
    path += (drawing ? ' L' : 'M') + xAt(index).toFixed(1) + ' ' + yAt(value).toFixed(1);
    drawing = true;
  });
  return path;
}

function homeCycleAxisLabels(rows, xAt, height) {
  var out = [], last = Math.max(rows.length - 1, 0);
  [0, .25, .5, .75, 1].forEach(function(ratio) {
    var index = Math.round(last * ratio);
    if (!rows[index]) return;
    out.push('<text class="home-cycle-axis" x="' + xAt(index) + '" y="' + (height - 9) + '" text-anchor="middle">' +
      escapeHtml(String(rows[index].date || '').slice(0, 7)) + '</text>');
  });
  return out.join('');
}

function homeBindCycleTooltip(root, rows, left, right, width, formatter) {
  var svg = root.querySelector('svg');
  var hit = root.querySelector('.home-cycle-hit');
  var tip = root.querySelector('.home-cycle-tooltip');
  if (!svg || !hit || !tip || !rows.length) return;
  hit.onmousemove = function(event) {
    var box = svg.getBoundingClientRect();
    var svgX = (event.clientX - box.left) * width / box.width;
    var ratio = Math.max(0, Math.min(1, (svgX - left) / (width - left - right)));
    var row = rows[Math.round(ratio * (rows.length - 1))];
    if (!row) return;
    tip.innerHTML = formatter(row);
    tip.hidden = false;
    tip.style.left = Math.min(Math.max(event.clientX - box.left + 12, 8), box.width - 205) + 'px';
    tip.style.top = Math.max(event.clientY - box.top + 12, 8) + 'px';
  };
  hit.onmouseleave = function() { tip.hidden = true; };
}

function renderHomeBondCycle(payload) {
  var root = document.getElementById('home-bond-cycle-chart');
  var rows = payload && payload.history || [];
  if (!root || !rows.length) {
    if (root) root.innerHTML = '<div class="home-overview-empty">暂无可转债周期数据</div>';
    homeSetText('home-bond-cycle-summary', '暂无可用数据');
    return;
  }
  var latest = payload.latest || rows[rows.length - 1];
  homeSetText('home-bond-cycle-summary', String(payload.source_trade_date || rows[rows.length - 1].date).slice(0, 10) +
    ' · 周期分位 ' + homeCycleNumber(latest.rolling_percentile, 1) + '% · 综合估值 ' + homeCycleNumber(latest.composite_value, 2));

  var W=1100,H=300,L=58,R=58,T=18,B=36,plotH=H-T-B;
  var compositeRange = homeCycleRange(rows.map(function(row) { return row.composite_value; }));
  var percentileRange = { min:0, max:100 };
  if (!compositeRange) { root.innerHTML = '<div class="home-overview-empty">暂无可用数据</div>'; return; }
  function xAt(index) { return L + index * (W-L-R) / Math.max(rows.length-1, 1); }
  function yComposite(value) { return T + (compositeRange.max-value) * plotH / (compositeRange.max-compositeRange.min); }
  function yPercentile(value) { return T + (percentileRange.max-value) * plotH / 100; }
  var svg = [];
  for (var i=0;i<=4;i++) {
    var y=T+i*plotH/4;
    svg.push('<line class="home-cycle-grid-line" x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'"/>');
    svg.push('<text class="home-cycle-axis" x="'+(L-8)+'" y="'+(y+4)+'" text-anchor="end" style="fill:#2563eb">'+
      homeCycleNumber(compositeRange.max-i*(compositeRange.max-compositeRange.min)/4,0)+'</text>');
    svg.push('<text class="home-cycle-axis" x="'+(W-R+8)+'" y="'+(y+4)+'" style="fill:#ef4444">'+(100-i*25)+'%</text>');
  }
  svg.push('<path class="home-cycle-path" stroke="#2563eb" d="'+homeCyclePath(rows,'composite_value',xAt,yComposite)+'"/>');
  svg.push('<path class="home-cycle-path" stroke="#ef4444" d="'+homeCyclePath(rows,'rolling_percentile',xAt,yPercentile)+'"/>');
  svg.push(homeCycleAxisLabels(rows,xAt,H));
  svg.push('<rect class="home-cycle-hit" x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+plotH+'"/>');
  root.innerHTML = '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="可转债周期历史图">'+svg.join('')+'</svg><div class="home-cycle-tooltip" hidden></div>';
  homeBindCycleTooltip(root, rows, L, R, W, function(row) {
    return '<strong>'+escapeHtml(String(row.date).slice(0,10))+'</strong><br>' +
      '<span style="color:#60a5fa">综合估值：'+homeCycleNumber(row.composite_value,2)+'</span><br>' +
      '<span style="color:#f87171">周期分位：'+homeCycleNumber(row.rolling_percentile,1)+'%</span>';
  });
}

function openHomeMarketCycleDetail() {
  switchMain('market-volatility');
  switchMarketCycleMetric(homeMarketCycleMetric);
}

function renderHomeMarketCycle(payload) {
  var root = document.getElementById('home-market-chart');
  var rows = payload && payload.history || [];
  var overview = payload && payload.overview || {};
  var current = overview && overview.current;
  var setting = overview && overview.setting;
  var metric = payload && payload.metric || 'pe';
  var meta = {
    graham: { title:'格雷厄姆指数', legend:'格雷厄姆指数', suffix:'%', currentField:'graham_index_pct' },
    pe: { title:'市盈率（PE）', legend:'PE', suffix:'倍', currentField:'value' },
    pb: { title:'市净率（PB）', legend:'PB', suffix:'倍', currentField:'value' },
    m2_market_cap: { title:'M2与股市市值比', legend:'M2与股市市值比', suffix:'%', currentField:'value' }
  }[metric];
  homeMarketCycleMetric = metric;
  homeSetText('home-market-title', '股市周期 · ' + meta.title);
  homeSetText('home-market-legend', meta.legend);
  if (!root || !current || !rows.length || !setting) {
    if (root) root.innerHTML = '<div class="home-overview-empty">暂无管理员保存的首页边界或历史数据</div>';
    homeSetText('home-market-summary', '暂无可用数据');
    return;
  }
  var currentDate = metric === 'graham' ? current.trade_date : current.date;
  var currentValue = Number(current[meta.currentField]);
  var recommended = overview.recommendedPosition;
  var summary = String(currentDate || '').slice(0,10) + ' · 当前 ' + homeCycleNumber(currentValue,2) + meta.suffix;
  if (metric !== 'graham') summary += ' · 历史分位 ' + homeCycleNumber(overview.stats&&overview.stats.percentile,1) + '%';
  summary += ' · 建议仓位 ' + homeCycleNumber(recommended,0) + '%';
  homeSetText('home-market-summary', summary);

  var ladder = setting.ladder || [];
  var values = rows.map(function(row) { return row.value; }).concat(ladder.map(function(row) { return row.value; }));
  var range = homeCycleRange(values);
  if (!range) { root.innerHTML = '<div class="home-overview-empty">暂无可用数据</div>'; return; }
  var W=1100,H=300,L=58,R=58,T=18,B=36,plotH=H-T-B;
  function xAt(index) { return L + index * (W-L-R) / Math.max(rows.length-1, 1); }
  function yAt(value) { return T + (range.max-value) * plotH / (range.max-range.min); }
  var svg = [];
  for (var i=0;i<=4;i++) {
    var y=T+i*plotH/4;
    svg.push('<line class="home-cycle-grid-line" x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'"/>');
    svg.push('<text class="home-cycle-axis" x="'+(L-8)+'" y="'+(y+4)+'" text-anchor="end">'+
      homeCycleNumber(range.max-i*(range.max-range.min)/4,2)+meta.suffix+'</text>');
  }
  ladder.forEach(function(row,index) {
    var y=yAt(Number(row.value));
    var edge=index===0 || index===ladder.length-1;
    svg.push('<line class="home-cycle-boundary" x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'" style="stroke:'+(edge?'#dc2626':'#94a3b8')+'"/>');
    svg.push('<text class="home-cycle-axis" x="'+(W-R-4)+'" y="'+(y-5)+'" text-anchor="end">'+row.position+'%</text>');
  });
  svg.push('<path class="home-cycle-path" stroke="#2563eb" d="'+homeCyclePath(rows,'value',xAt,yAt)+'"/>');
  svg.push(homeCycleAxisLabels(rows,xAt,H));
  svg.push('<rect class="home-cycle-hit" x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+plotH+'"/>');
  root.innerHTML = '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+escapeHtml(meta.title)+'历史图">'+svg.join('')+'</svg><div class="home-cycle-tooltip" hidden></div>';
  homeBindCycleTooltip(root, rows, L, R, W, function(row) {
    var detail = '<strong>'+escapeHtml(String(row.date).slice(0,10))+'</strong><br>'+escapeHtml(meta.title)+'：'+homeCycleNumber(row.value,2)+meta.suffix;
    if (metric === 'graham') detail += '<br>指数 PE：'+homeCycleNumber(row.pe,2)+'倍';
    else if (metric === 'm2_market_cap') detail += '<br>M2：'+homeCycleNumber(row.m2_100m_yuan,2)+'亿元<br>A股总市值：'+homeCycleNumber(row.total_market_cap_100m_yuan,2)+'亿元';
    else detail += '<br>指数点位：'+homeCycleNumber(row.close,2);
    return detail;
  });
}

async function loadHomeMarketCycles() {
  if (homeMarketCyclesLoading || homeMarketCyclesLoaded) return;
  homeMarketCyclesLoading = true;
  try {
    var responses = await Promise.all([
      fetch(api('/api/bond-cycle?range=all&view=home&maxPoints=800')),
      fetch(api('/api/market-volatility/home-cycle?range=20y'))
    ]);
    if (!responses[0].ok || !responses[1].ok) throw new Error('市场周期数据读取失败');
    var payloads = await Promise.all(responses.map(function(response) { return response.json(); }));
    renderHomeBondCycle(payloads[0]);
    renderHomeMarketCycle(payloads[1]);
    homeMarketCyclesLoaded = true;
  } catch (error) {
    console.error('首页市场周期加载失败', error);
    ['home-bond-cycle-chart','home-market-chart'].forEach(function(id) {
      var el=document.getElementById(id);
      if (el) el.innerHTML='<div class="home-overview-empty">数据加载失败</div>';
    });
  } finally {
    homeMarketCyclesLoading = false;
  }
}

// HOME-01：首页按登录态调整内容顺序（只重排已有区块/卡片，不新增接口或统计口径）
// 游客：公开文章 + 研究优先；登录用户：最新文章置顶，再展示资产/周期/打新等。
var HOME_ORDER_GUEST = ['home-section-articles', 'home-section-cycle', 'home-section-modules', 'home-section-secondary', 'home-section-capabilities'];
var HOME_ORDER_LOGGED = ['home-section-articles', 'home-section-cycle', 'home-section-modules', 'home-section-secondary', 'home-section-capabilities'];

function applyHomeOrder(root, isLoggedIn) {
  var shell = root && root.querySelector ? root.querySelector('.home-dashboard-shell') : null;
  if (!shell) return;
  var order = isLoggedIn ? HOME_ORDER_LOGGED : HOME_ORDER_GUEST;
  order.forEach(function (id) {
    var el = root.getElementById(id);
    if (el && el.parentNode === shell) shell.appendChild(el);
  });
  // 登录用户：把“持仓管理”资产卡置于模块网格首位
  if (isLoggedIn) {
    var grid = root.querySelector('#home-section-modules .home-module-grid');
    var holdings = root.getElementById('home-module-holdings');
    if (grid && holdings && grid.firstElementChild && grid.firstElementChild !== holdings) {
      grid.insertBefore(holdings, grid.firstElementChild);
    }
  }
}

async function loadHomeDashboard() {
  renderHomeHoldings();
  // HOME-01：按登录态重排首页区块顺序
  applyHomeOrder(document, !!username);
  // 最新文章独立加载，不等待 IPO/债券接口，避免被大数据接口阻塞
  renderHomeArticles();
  loadHomeMarketCycles();
  if (homeDashboardLoading) return;
  homeDashboardLoading = true;
  try {
    var results = await Promise.all([fetch(api('/api/ipo/calendar?days=90')), fetch(api('/api/bond-safety/bonds?view=summary'))]);
    if (!results[0].ok || !results[1].ok) throw new Error('首页数据读取失败');
    var calendar = await results[0].json(), bonds = await results[1].json();
    renderHomeIpo(calendar.calendar || []);
    renderHomeBonds(bonds);
  } catch (error) {
    console.error('首页数据加载失败', error);
  } finally { homeDashboardLoading = false; }
}

async function renderHomeArticles() {
  var heroBox = document.getElementById('home-hero-articles');
  if (!heroBox) return;
  try {
    var r = await fetch(api('/api/knowledge/latest?limit=5'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var list = await r.json();
    if (!Array.isArray(list)) throw new Error('返回格式错误');
    if (!list.length) {
      heroBox.innerHTML = '<span class="home-hero-article-loading">暂无已发布文章</span>';
      return;
    }
    heroBox.innerHTML = list.slice(0, 5).map(function (a) {
      var date = (a.published_at || '').toString().slice(0, 10);
      return '<button type="button" class="home-hero-article" onclick="switchMain(\'knowledge\'); ksOpenArticle(' + (a.id || 0) + ');">' +
        '<span>' + escapeHtml(a.category_name || '未分类') + '</span>' +
        '<strong>' + escapeHtml(a.title || '无标题') + '</strong>' +
        '<small>' + escapeHtml(a.summary || '点击阅读文章详情') + '</small>' +
        '<em>' + date + ' · ' + (a.view_count || 0) + ' 次阅读</em>' +
      '</button>';
    }).join('');
  } catch (e) {
    heroBox.innerHTML = '<span class="home-hero-article-loading">加载失败</span>';
  }
}
