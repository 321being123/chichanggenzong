// 可转债估值：前端展示（只读，不复制后端公式）
// 职责：市场概览、工具栏筛选/排序、估值总表、单券详情（估值拆解/安全性/信用风险/模型说明）、四类历史曲线、预警。
// 不提供任何买卖、仓位、收益预测文案。

var esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
function num(v, d) { var n = Number(v); return Number.isFinite(n) ? n.toFixed(d == null ? 2 : d) : '—'; }
function pctv(v, d) { return (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : num(Number(v), d == null ? 2 : d) + '%'; }
function api(p) { return (typeof BASE_URL !== 'undefined' && BASE_URL) ? BASE_URL + p : p; }

var bondValState = { data: null, loading: false, sortKey: '__default__', sortDir: 'asc', detailCode: null };

var EVAL_CLASS = {
  '低估': 'val-low', '偏低估': 'val-low2', '合理': 'val-mid', '偏高估': 'val-high1',
  '高估': 'val-high', '风险折价': 'val-risk', '数据不足': 'val-none'
};

// ---------- 加载列表 ----------
async function loadBondValuation() {
  if (bondValState.loading) return;
  bondValState.loading = true;
  var statusEl = document.getElementById('bond-val-status');
  if (statusEl) statusEl.textContent = '正在读取估值数据...';
  try {
    var r = await fetch(api('/api/bond-valuation/bonds'));
    if (!r.ok) throw new Error('接口返回 ' + r.status);
    var json = await r.json();
    bondValState.data = json;
    renderBondValOverview(json);
    bondValState.loading = false;
    if (statusEl) statusEl.textContent = '';
    if (json.detailCode) bondValState.detailCode = json.detailCode;
    // 直接带 bond 参数进入详情
    var params = new URLSearchParams(window.location.search);
    var bond = params.get('bond');
    if (bond) { openBondValDetail(bond); }
    else { renderBondValTable(); }
  } catch (e) {
    bondValState.loading = false;
    if (statusEl) statusEl.textContent = '数据加载失败：' + (e.message || e);
  }
}

function renderBondValOverview(json) {
  var ov = document.getElementById('bond-val-overview');
  var up = document.getElementById('bond-val-updated');
  var stale = document.getElementById('bond-val-stale');
  if (!ov) return;
  ov.style.display = '';
  if (up) up.textContent = '行情日期 ' + (json.as_of_date || '—') + '　模型 ' + (json.model_version || '—') +
    '　计算时间 ' + (json.updated_at ? new Date(json.updated_at).toLocaleString() : '—');
  if (stale) stale.style.display = json.stale ? '' : 'none';

  var cards = [
    { k: '可交易转债', v: json.total != null ? json.total : '—' },
    { k: '可正式估值', v: json.valued_count != null ? json.valued_count : '—' },
    { k: '市场热度', v: pctv(json.market_heat_pct) },
    { k: '当前周期位置', v: json.cycle_level || '—' },
    { k: '数据覆盖率', v: json.coverage_ratio != null ? pctv(json.coverage_ratio * 100, 1) : '—' }
  ];
  var ch = '';
  for (var i = 0; i < cards.length; i++) ch += '<div class="bond-val-card"><span>' + esc(cards[i].k) + '</span><strong>' + esc(cards[i].v) + '</strong></div>';
  document.getElementById('bond-val-cards').innerHTML = ch;

  var c = json.counts || {};
  var order = ['低估', '偏低估', '合理', '偏高估', '高估', '风险折价', '数据不足'];
  var cc = '';
  for (var j = 0; j < order.length; j++) {
    var name = order[j];
    cc += '<span class="bond-val-count ' + (EVAL_CLASS[name] || '') + '">' + esc(name) + '：' + (c[name] || 0) + '</span>';
  }
  document.getElementById('bond-val-counts').innerHTML = cc;
}

// ---------- 筛选与排序 ----------
function bondValFilters() {
  return {
    search: (document.getElementById('bond-val-search') || {}).value || '',
    final_evaluation: (document.getElementById('bond-val-eval') || {}).value || '',
    safety_level: (document.getElementById('bond-val-safety') || {}).value || '',
    alert_level: (document.getElementById('bond-val-alert') || {}).value || '',
    data_status: (document.getElementById('bond-val-data') || {}).value || ''
  };
}
function bondValApplyFilters() { renderBondValTable(); }
function bondValClearFilters() {
  ['bond-val-search', 'bond-val-eval', 'bond-val-safety', 'bond-val-alert', 'bond-val-data'].forEach(function (id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  bondValState.sortKey = '__default__';
  renderBondValTable();
}

function bondValFilteredRows() {
  var json = bondValState.data; if (!json || !json.data) return [];
  var f = bondValFilters();
  var rows = json.data.filter(function (r) {
    if (f.search && (r.bond_code + r.bond_name + r.stock_name).toLowerCase().indexOf(f.search.toLowerCase()) < 0) return false;
    if (f.final_evaluation && r.eval_class !== f.final_evaluation) return false;
    if (f.safety_level && r.safety_level !== f.safety_level) return false;
    if (f.alert_level && r.alert_level !== f.alert_level) return false;
    if (f.data_status && r.data_status !== f.data_status) return false;
    return true;
  });
  var key = bondValState.sortKey;
  if (key && key !== '__default__') {
    var dir = bondValState.sortDir === 'asc' ? 1 : -1;
    var isNum = ['close', 'conversion_value', 'bond_value', 'conversion_premium_pct', 'anchor_value',
      'remaining_years', 'conversion_value_volatility_60d', 'fair_price', 'absolute_deviation_pct',
      'valuation_percentile', 'relative_market_deviation_pct'].indexOf(key) >= 0;
    rows.sort(function (a, b) {
      var va = a[key], vb = b[key];
      if (isNum) { va = Number(va); vb = Number(vb); if (!Number.isFinite(va)) va = Infinity; if (!Number.isFinite(vb)) vb = Infinity; return (va - vb) * dir; }
      return String(va == null ? '' : va).localeCompare(String(vb == null ? '' : vb), 'zh') * dir;
    });
  }
  return rows;
}

// ---------- 总表 ----------
var BOND_VAL_COLS = [
  { k: 'bond_code', t: '转债代码' }, { k: 'bond_name', t: '转债名称' }, { k: 'stock_name', t: '正股名称' },
  { k: 'safety_level', t: '安全性' }, { k: 'credit_warning', t: '信用风险' }, { k: 'close', t: '当前价格', n: 1 },
  { k: 'conversion_value', t: '转股价值', n: 1 }, { k: 'bond_value', t: '纯债价值', n: 1 },
  { k: 'conversion_premium_pct', t: '转股溢价率', p: 1 }, { k: 'anchor_value', t: '价值底座', n: 1 },
  { k: 'remaining_years', t: '剩余年限', n: 1 }, { k: 'conversion_value_volatility_60d', t: '60日波动率', p: 1 },
  { k: 'fair_price', t: '中性公允价', n: 1 }, { k: 'fair_range', t: '公允区间', noSort: 1 },
  { k: 'absolute_deviation_pct', t: '绝对估值偏离', p: 1 }, { k: 'valuation_percentile', t: '历史估值分位', p: 1 },
  { k: 'relative_market_deviation_pct', t: '相对市场偏离', p: 1 }, { k: 'final_evaluation', t: '最终估值评价' },
  { k: 'alert_level', t: '预警' }, { k: 'quote_date', t: '行情日期' }
];

function renderBondValTable() {
  bondValState.loading = false;
  var json = bondValState.data;
  var box = document.getElementById('bond-val-table');
  var vis = document.getElementById('bond-val-visible');
  if (!box) return;
  if (!json) { box.innerHTML = '<div class="bond-val-empty">尚未生成估值数据</div>'; return; }
  var rows = bondValFilteredRows();
  if (vis) vis.textContent = '显示 ' + rows.length + ' / ' + (json.total || 0) + ' 只';

  var head = '<table class="bond-val-table"><thead><tr>';
  for (var i = 0; i < BOND_VAL_COLS.length; i++) {
    var c = BOND_VAL_COLS[i];
    var cls = (c.n || c.p) ? ' num' : '';
    var sortMark = bondValState.sortKey === c.k ? (bondValState.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    if (c.noSort) head += '<th class="' + cls + '">' + esc(c.t) + '</th>';
    else head += '<th class="' + cls + '" onclick="bondValSort(\'' + c.k + '\')">' + esc(c.t) + sortMark + '</th>';
  }
  head += '</tr></thead><tbody>';

  if (!rows.length) {
    box.innerHTML = '<div class="bond-val-table-scroll">' + head + '</tbody></table><div class="bond-val-empty">没有符合条件的转债</div></div>';
    return;
  }
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    head += '<tr class="' + (EVAL_CLASS[r.eval_class] || '') + '" onclick="openBondValDetail(\'' + esc(r.bond_code) + '\')">';
    for (var m = 0; m < BOND_VAL_COLS.length; m++) {
      var col = BOND_VAL_COLS[m];
      var v = r[col.k];
      var cls = (col.n || col.p) ? ' num' : '';
      var txt;
      if (col.k === 'fair_range') txt = r.fair_price_low != null ? (num(r.fair_price_low, 1) + '～' + num(r.fair_price_high, 1)) : '—';
      else if (col.p) txt = pctv(v);
      else if (col.n) txt = num(v, 1);
      else if (col.k === 'bond_name') txt = esc(v) + (r.data_status === '新上市观察期' ? '<span class="bond-val-new-listing" title="上市满 40 个交易日后自动进入正式估值">新上市</span>' : '');
      else if (col.k === 'alert_level') txt = (v && v !== '无') ? '<span class="val-alert ' + (v === '重要' ? 'val-alert-imp' : 'val-alert-att') + '">' + esc(v) + '</span>' : '—';
      else if (col.k === 'final_evaluation') txt = '<span class="' + (EVAL_CLASS[v] || '') + '">' + esc(v || '—') + '</span>';
      else txt = (v == null || v === '') ? '—' : esc(v);
      head += '<td class="' + cls + '">' + txt + '</td>';
    }
    head += '</tr>';
  }
  head += '</tbody></table>';
  box.innerHTML = '<div class="bond-val-table-scroll">' + head + '</div>';
}

function bondValSort(k) {
  if (bondValState.sortKey === k) bondValState.sortDir = bondValState.sortDir === 'asc' ? 'desc' : 'asc';
  else { bondValState.sortKey = k; bondValState.sortDir = 'asc'; }
  renderBondValTable();
}

// ---------- 详情 ----------
// 浏览器前进/后退：根据 URL bond 参数恢复列表/详情状态
window.addEventListener('popstate', function () {
  var params = new URLSearchParams(window.location.search);
  if (params.get('sub') !== 'valuation') return;
  var bond = params.get('bond');
  if (bond) openBondValDetail(bond, true);
  else if (bondValState.detailCode) closeBondValDetail(true);
});

function openBondValDetail(code, skipPush) {
  if (!skipPush) {
    var params = new URLSearchParams(window.location.search);
    params.set('main', 'bond-safety'); params.set('sub', 'valuation'); params.set('bond', code);
    history.pushState(null, '', '/?' + params.toString());
  }
  bondValState.detailCode = code;

  var listWrap = document.getElementById('sub-bond-valuation');
  var detail = document.getElementById('bond-val-detail');
  if (!detail) {
    detail = document.createElement('div');
    detail.id = 'bond-val-detail';
    detail.className = 'bond-val-detail';
    listWrap.appendChild(detail);
  }
  // 隐藏列表区，显示详情
  var ov = document.getElementById('bond-val-overview'); if (ov) ov.style.display = 'none';
  var tw = document.querySelector('#sub-bond-valuation .table-wrap'); if (tw) tw.style.display = 'none';
  var tb = document.getElementById('bond-val-toolbar'); // noop guard
  detail.hidden = false;
  detail.innerHTML = '<div class="bond-val-detail-loading">正在读取 ' + esc(code) + ' 的估值详情...</div>';

  Promise.all([
    fetch(api('/api/bond-valuation/bonds/' + encodeURIComponent(code))),
    fetch(api('/api/bond-valuation/bonds/' + encodeURIComponent(code) + '/history?range=all')),
    fetch(api('/api/bond-valuation/bonds/' + encodeURIComponent(code) + '/alerts'))
  ]).then(function (res) {
    // 统一检查 HTTP 状态（404 的详情/历史允许继续渲染错误提示）
    return Promise.all(res.map(function (r) {
      if (!r.ok && r.status !== 404) throw new Error('接口返回 ' + r.status);
      return r.json();
    }));
  })
    .then(function (out) {
      renderBondValDetail(out[0], out[1], out[2]);
    })
    .catch(function (e) {
      detail.innerHTML = '<div class="bond-val-detail-loading">详情加载失败：' + esc(e.message || e) + '</div>' +
        '<button class="btn btn-outline btn-sm" onclick="closeBondValDetail()">返回列表</button>';
    });
}

function closeBondValDetail(skipPush) {
  if (!skipPush) {
    var params = new URLSearchParams(window.location.search);
    params.set('main', 'bond-safety'); params.set('sub', 'valuation'); params.delete('bond');
    history.pushState(null, '', '/?' + params.toString());
  }
  bondValState.detailCode = null;
  var detail = document.getElementById('bond-val-detail');
  if (detail) detail.hidden = true;
  var ov = document.getElementById('bond-val-overview'); if (ov && bondValState.data) ov.style.display = '';
  var tw = document.querySelector('#sub-bond-valuation .table-wrap'); if (tw) tw.style.display = '';
  renderBondValTable();
}

function badge(v, cls) { return v ? '<span class="' + (cls || '') + '">' + esc(v) + '</span>' : '—'; }

function renderBondValDetail(d, hist, alerts) {
  var detail = document.getElementById('bond-val-detail');
  if (!detail || !d || d.error) {
    detail.innerHTML = '<div class="bond-val-detail-loading">' + esc((d && d.error) || '未找到该转债') + '</div>' +
      '<button class="btn btn-outline btn-sm" onclick="closeBondValDetail()">返回列表</button>';
    return;
  }
  var cur = d.current;
  var b = d.breakdown;
  var html = '';
  html += '<div class="bond-val-detail-bar"><button class="btn btn-outline btn-sm" onclick="closeBondValDetail()">← 返回列表</button>' +
    '<span class="bond-val-detail-title">' + esc(d.bond_name) + '（' + esc(d.bond_code) + '）</span>' +
    '<button class="btn btn-outline btn-sm" onclick="switchMain(\'stock-analysis\');setTimeout(function(){securityAnalysisSelect(\'' + esc(d.bond_code) + '\')},100)" title="查看完整债券分析（条款、评级、正股财务等）">📊 完整分析</button>' +
    '<span class="val-alert-tag ' + (EVAL_CLASS[cur.eval_class] || '') + '">' + esc(cur.final_evaluation) + '</span></div>';

  // 顶部摘要
  html += '<div class="bond-val-summary">';
  var sums = [
    ['当前价格', num(cur.close, 2)], ['中性公允价', num(cur.fair_price, 2)],
    ['公允区间', (cur.fair_price_low != null ? num(cur.fair_price_low, 1) + '～' + num(cur.fair_price_high, 1) : '—')],
    ['绝对估值偏离', pctv(cur.absolute_deviation_pct)], ['历史估值分位', pctv(cur.valuation_percentile, 1)],
    ['安全性', cur.safety_level || '—'], ['当前预警', cur.alert_level || '无'], ['行情日期', cur.quote_date || '—']
  ];
  for (var i = 0; i < sums.length; i++) html += '<div class="bond-val-sum-card"><span>' + esc(sums[i][0]) + '</span><strong>' + esc(sums[i][1]) + '</strong></div>';
  html += '</div>';

  // 估值拆解
  html += '<div class="bond-val-section"><h3>估值拆解</h3><table class="bond-val-detail-table"><tbody>';
  var bd = [
    ['转股价值', num(b.conversion_value, 2), '当前股性基础'],
    ['纯债价值', num(b.bond_value, 2), '当前债性基础'],
    ['到期赎回价', num(b.maturity_call_price, 2), '募集说明书约定'],
    ['赎回价折现值', num(b.redemption_present_value, 2), '最后一年纳入价值底座'],
    ['价值底座', num(b.anchor_value, 2), '转股价值、纯债价值与临期赎回价折现值中的较高值'],
    ['转股溢价率', pctv(b.conversion_premium_pct), '当前转股溢价'],
    ['剩余年限', num(b.remaining_years, 2) + ' 年', '模型输入'],
    ['期权截止日', b.option_end_date || '自然到期', b.option_end_reason || '按自然到期日计算'],
    ['有效期权年限', num(b.effective_option_years, 2) + ' 年', b.option_end_date ? '按强赎/提前退出窗口计算' : '与剩余年限一致'],
    ['期权时间价值权重', pctv(b.option_time_value_weight == null ? null : b.option_time_value_weight * 100), '最后一年随到期线性归零'],
    ['60日波动率', pctv(b.conversion_value_volatility_60d), '模型输入（转股价值年化波动）'],
    ['历史中性额外价值', num(b.neutral_market_extra, 4), '模型市场中性基准（跨牛熊）'],
    ['单券结构性额外价值', num(b.predicted_relative_extra, 4), '模型根据条件估计的额外价值'],
    ['中性公允价', num(b.fair_price, 2), '中心估计'],
    ['公允区间', (b.fair_price_low != null ? num(b.fair_price_low, 1) + '～' + num(b.fair_price_high, 1) : '—'), '合理范围（历史误差 40%~60%）'],
    ['绝对估值偏离', pctv(b.absolute_deviation_pct), '当前价格相对公允价'],
    ['相对市场偏离', pctv(b.relative_market_deviation_pct), '相对当前全市场']
  ];
  for (var x = 0; x < bd.length; x++) html += '<tr><td>' + esc(bd[x][0]) + '</td><td class="num">' + esc(bd[x][1]) + '</td><td class="note">' + esc(bd[x][2]) + '</td></tr>';
  html += '</tbody></table></div>';

  // 安全性与信用风险
  html += '<div class="bond-val-section"><h3>安全性与信用风险</h3>';
  if (d.safety) {
    html += '<table class="bond-val-detail-table"><tbody>' +
      '<tr><td>安全性评价</td><td>' + badge(d.safety.safety, EVAL_CLASS[d.safety.safety]) + '</td><td class="note">来自现有可转债安全性模块</td></tr>' +
      '<tr><td>利息保障倍数</td><td class="num">' + (d.safety.interest_coverage != null ? num(d.safety.interest_coverage, 2) : '—') + '</td><td class="note">-</td></tr>' +
      '<tr><td>现金覆盖率</td><td class="num">' + (d.safety.cash_coverage != null ? num(d.safety.cash_coverage, 2) : '—') + '</td><td class="note">-</td></tr>' +
      '<tr><td>负债市值比</td><td class="num">' + (d.safety.liability_to_market_cap != null ? num(d.safety.liability_to_market_cap, 2) : '—') + '</td><td class="note">-</td></tr>' +
      '<tr><td>财务数据日期</td><td>' + esc(d.safety.source_updated_at || '—') + '</td><td class="note">-</td></tr>' +
      '</tbody></table>';
  } else {
    html += '<p class="bond-val-note">未匹配到安全性快照，估值仅供参考。</p>';
  }
  html += '<h4>信用评级</h4>';
  var ratingHistory = Array.isArray(d.rating_history) ? d.rating_history : [];
  if (ratingHistory.length) {
    html += '<table class="bond-val-detail-table"><thead><tr><th>公告日</th><th>评级</th><th>展望</th><th>评级机构</th></tr></thead><tbody>';
    for (var c = 0; c < ratingHistory.length; c++) {
      var cr = ratingHistory[c];
      html += '<tr><td>' + esc((cr.announced_at || cr.rating_date || '').slice(0, 10)) + '</td><td>' + esc(cr.rating || '—') + '</td><td>' + esc(cr.rating_outlook || '—') + '</td><td>' + esc(cr.rating_company || '—') + '</td></tr>';
    }
    html += '</tbody></table>';
  } else {
    html += '<p class="bond-val-note">评级历史不足。</p>';
  }
  html += '</div>';

  // 四类历史曲线
  var hdata = (hist && hist.data) || [];
  html += '<div class="bond-val-section"><h3>历史估值曲线</h3>';
  html += '<div class="bond-val-range-tabs">' +
    '<button data-r="1y" onclick="bondValReloadHistory(\'' + esc(d.bond_code) + '\',\'1y\',this)">1年</button>' +
    '<button data-r="3y" onclick="bondValReloadHistory(\'' + esc(d.bond_code) + '\',\'3y\',this)">3年</button>' +
    '<button data-r="5y" onclick="bondValReloadHistory(\'' + esc(d.bond_code) + '\',\'5y\',this)">5年</button>' +
    '<button data-r="all" class="active" onclick="bondValReloadHistory(\'' + esc(d.bond_code) + '\',\'all\',this)">全部</button>' +
    '</div>';
  html += '<div id="bond-val-charts"></div></div>';

  // 预警时间线
  html += '<div class="bond-val-section"><h3>预警时间线</h3>';
  var al = (alerts && alerts.data) || [];
  if (al.length) {
    html += '<table class="bond-val-detail-table"><thead><tr><th>日期</th><th>类型</th><th>级别</th><th>原状态</th><th>新状态</th></tr></thead><tbody>';
    for (var a = 0; a < al.length; a++) {
      html += '<tr><td>' + esc(al[a].trade_date) + '</td><td>' + esc(al[a].alert_type) + '</td><td>' + esc(al[a].alert_level) + '</td><td>' + esc(al[a].previous_state || '—') + '</td><td>' + esc(al[a].current_state || '—') + '</td></tr>';
    }
    html += '</tbody></table>';
  } else {
    html += '<p class="bond-val-note">暂无预警记录。</p>';
  }
  html += '</div>';

  // 模型与数据说明
  var dstatus = d.data_status || '完整';
  var missFields = (d.missing_fields && d.missing_fields.length) ? d.missing_fields.join('、') : '';
  html += '<div class="bond-val-section bond-val-disclaimer"><h3>数据与模型说明</h3>';
  html += '<table class="bond-val-detail-table"><tbody>';
  html += '<tr><td>数据状态</td><td>' + esc(dstatus) + (dstatus === '数据不足' && missFields ? '（缺失：' + esc(missFields) + '）' : '') + '</td></tr>';
  if (dstatus === '新上市观察期') html += '<tr><td>处理说明</td><td>上市行情已积累 ' + esc(d.observation_days == null ? '—' : d.observation_days) + ' / ' + esc(d.required_observation_days || 40) + ' 个交易日，暂不输出高低估结论；样本达到要求后自动进入正式估值。</td></tr>';
  if (d.model_version) html += '<tr><td>模型版本</td><td>' + esc(d.model_version) + '</td></tr>';
  if (d.model_year) html += '<tr><td>模型年份</td><td>' + esc(String(d.model_year)) + '</td></tr>';
  if (d.model_training_end_date) html += '<tr><td>模型训练截止日（防未来泄漏）</td><td>' + esc(d.model_training_end_date) + '</td></tr>';
  if (d.model_year) html += '<tr><td>年度训练规则</td><td>' + esc(String(d.model_year)) + ' 年估值只使用 ' + esc(String(Number(d.model_year) - 1)) + ' 年末及以前的数据</td></tr>';
  if (d.historical_safety) html += '<tr><td>历史安全性</td><td>' + esc(d.historical_safety) + '</td></tr>';
  html += '<tr><td>行情日期</td><td>' + esc(cur.quote_date || '—') + '</td></tr>';
  html += '<tr><td>估值计算时间</td><td>' + esc(d.trade_date || '—') + '</td></tr>';
  html += '</tbody></table>';
  html += '<p>行情来源：本地 PostgreSQL（market.convertible_bond_daily_metrics）。中性公允价仅使用跨牛熊历史数据，不使用当前市场热度或当天横向排名；高评级不提高公允价。本页仅供研究参考，不构成任何投资建议。</p></div>';

  detail.innerHTML = html;
  // 默认画全部区间（边界用模型版本固化值，不随查看范围变化）
  drawBondValCharts(hdata, hist && hist.boundaries);
}

function bondValReloadHistory(code, range, btn) {
  var tabs = btn.parentNode.querySelectorAll('button');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
  btn.classList.add('active');
  var box = document.getElementById('bond-val-charts');
  if (box) box.innerHTML = '<div class="bond-val-detail-loading">加载历史...</div>';
  fetch(api('/api/bond-valuation/bonds/' + encodeURIComponent(code) + '/history?range=' + range))
    .then(function (r) { return r.json(); }).then(function (h) { drawBondValCharts((h && h.data) || [], h && h.boundaries); })
    .catch(function (e) { if (box) box.innerHTML = '历史加载失败：' + esc(e.message || e); });
}

// ---------- SVG 历史曲线 ----------
function drawBondValCharts(data, boundaries) {
  var box = document.getElementById('bond-val-charts');
  if (!box) return;
  if (!data.length) { box.innerHTML = '<div class="bond-val-note">该区间暂无历史估值数据。</div>'; return; }
  bondValChartTipStore = {};
  bondValChartTipSeq = 0;
  box.innerHTML =
    chartCard('价格与公允区间', svgChart([
      { key: 'close', color: '#c0392b', label: '收盘价' },
      { key: 'fair_price', color: '#2980b9', label: '中性公允价' },
      { key: 'anchor_value', color: '#7f8c8d', label: '价值底座' }
    ], data, { band: ['fair_price_low', 'fair_price_high'] })) +
    chartCard('绝对估值偏离', svgChart([
      { key: 'absolute_deviation_pct', color: '#8e44ad', label: '绝对估值偏离' }
    ], data, { zero: true, pct: true, fixedBoundaries: boundaries, versionKey: 'model_version' })) +
    chartCard('估值分位', svgChart([
      { key: 'valuation_percentile', color: '#16a085', label: '历史估值分位' }
    ], data, { zero: false, pct: true, refLines: [20, 40, 60, 80], fixedRange: [0, 100], bands5: true, versionKey: 'model_version' })) +
    chartCard('单券与市场', svgChart([
      { key: 'absolute_deviation_pct', color: '#8e44ad', label: '单券偏离' },
      { key: 'market_heat_pct', color: '#e67e22', label: '市场热度' },
      { key: 'relative_market_deviation_pct', color: '#34495e', label: '相对市场偏离' }
    ], data, { zero: true, pct: true }));
  bindBondValChartTips(box);
}

function chartCard(title, svg) {
  return '<div class="bond-val-chart-card"><div class="bond-val-chart-title">' + esc(title) + '</div>' + svg + '</div>';
}

var bondValChartTipStore = {};
var bondValChartTipSeq = 0;

// 通用 SVG 折线图；opts: {band:[low,high], zero:bool, pct:bool, refLines:[], shadePct:field}
function svgChart(series, data, opts) {
  opts = opts || {};
  var W = 720, H = 220, padL = 48, padR = 12, padT = 12, padB = 24;
  var n = data.length;
  if (n < 2) return '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '"><text x="10" y="40">数据不足，无法绘图</text></svg>';
  // 收集所有取值确定 y 范围（fixedRange 时锁定）
  var min, max;
  if (opts.fixedRange) {
    min = opts.fixedRange[0]; max = opts.fixedRange[1];
  } else {
    var all = [];
    series.forEach(function (s) { data.forEach(function (d) { var v = Number(d[s.key]); if (Number.isFinite(v)) all.push(v); }); });
    if (opts.band) { opts.band.forEach(function (bk) { data.forEach(function (d) { var v = Number(d[bk]); if (Number.isFinite(v)) all.push(v); }); }); }
    if (opts.zero) all.push(0);
    if (opts.refLines) opts.refLines.forEach(function (v) { if (opts.pct) all.push(v); });
    if (opts.fixedBoundaries) {
      ['q20', 'q40', 'q60', 'q80'].forEach(function (qk) {
        var bv = Number(opts.fixedBoundaries[qk]);
        if (Number.isFinite(bv)) all.push(bv);
      });
    }
    min = Math.min.apply(null, all); max = Math.max.apply(null, all);
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.08; min -= pad; max += pad;
  }
  function X(i) { return padL + (W - padL - padR) * (i / (n - 1)); }
  function Y(v) { return padT + (H - padT - padB) * (1 - (v - min) / (max - min)); }

  var tipId = 'bond-val-chart-' + (++bondValChartTipSeq);
  bondValChartTipStore[tipId] = { series: series, data: data, opts: opts };
  var svg = '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="bond-val-svg" data-tip-id="' + tipId + '">';
  // 五分位背景区（低估→高估，用于估值分位图）
  if (opts.bands5) {
    var bandCols = ['rgba(39,174,96,0.12)', 'rgba(46,204,113,0.07)', 'rgba(241,196,15,0.05)', 'rgba(230,126,34,0.07)', 'rgba(192,57,43,0.12)'];
    for (var b = 0; b < 5; b++) {
      var by0 = Y(max - (max - min) * (b + 1) / 5), by1 = Y(max - (max - min) * b / 5);
      svg += '<rect x="' + padL + '" y="' + by0.toFixed(1) + '" width="' + (W - padL - padR) + '" height="' + (by1 - by0).toFixed(1) + '" fill="' + bandCols[b] + '"/>';
    }
  }
  // 模型版本切换竖线
  if (opts.versionKey) {
    var _lastV = null;
    for (var vi = 0; vi < n; vi++) {
      var _v = data[vi][opts.versionKey];
      if (_v !== _lastV && _lastV !== null) {
        svg += '<line x1="' + X(vi).toFixed(1) + '" y1="' + padT + '" x2="' + X(vi).toFixed(1) + '" y2="' + (H - padB) + '" stroke="#2c3e50" stroke-dasharray="4 3" stroke-width="1"/>';
      }
      _lastV = _v;
    }
  }
  // 0 线
  if (opts.zero && min < 0 && max > 0) svg += '<line x1="' + padL + '" y1="' + Y(0) + '" x2="' + (W - padR) + '" y2="' + Y(0) + '" stroke="#aaa" stroke-dasharray="3 3"/>';
  // 参考线
  if (opts.refLines) opts.refLines.forEach(function (rv) {
    svg += '<line x1="' + padL + '" y1="' + Y(rv) + '" x2="' + (W - padR) + '" y2="' + Y(rv) + '" stroke="#bbb" stroke-dasharray="2 4"/>';
  });
  // 历史分位边界（模型版本固化的 20/40/60/80 偏离边界，不随查看范围变化）
  if (opts.fixedBoundaries) {
    ['q20', 'q40', 'q60', 'q80'].forEach(function (qk) {
      var pv = Number(opts.fixedBoundaries[qk]);
      if (!Number.isFinite(pv) || pv < min || pv > max) return;
      svg += '<line x1="' + padL + '" y1="' + Y(pv).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(pv).toFixed(1) + '" stroke="#9b59b6" stroke-dasharray="5 3" stroke-width="1"/>';
    });
  }
  // 带状（公允区间）
  if (opts.band) {
    var band = '';
    for (var i = 0; i < n; i++) {
      var lo = Number(data[i][opts.band[0]]), hi = Number(data[i][opts.band[1]]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      band += (i === 0 ? 'M' : 'L') + X(i).toFixed(1) + ',' + Y(hi).toFixed(1) + ' ';
    }
    for (var j = n - 1; j >= 0; j--) {
      var lo2 = Number(data[j][opts.band[0]]), hi2 = Number(data[j][opts.band[1]]);
      if (!Number.isFinite(lo2) || !Number.isFinite(hi2)) continue;
      band += 'L' + X(j).toFixed(1) + ',' + Y(lo2).toFixed(1) + ' ';
    }
    if (band) svg += '<path d="' + band + 'Z" fill="rgba(41,128,185,0.12)" stroke="none"/>';
  }
  // 估值分位着色背景（低<20 绿，高>80 红）
  if (opts.shadePct) {
    for (var k = 0; k < n - 1; k++) {
      var p = Number(data[k][opts.shadePct]); if (!Number.isFinite(p)) continue;
      var col = p < 20 ? 'rgba(39,174,96,0.10)' : (p > 80 ? 'rgba(192,57,43,0.10)' : 'none');
      if (col === 'none') continue;
      svg += '<rect x="' + X(k).toFixed(1) + '" y="' + padT + '" width="' + (X(k + 1) - X(k)).toFixed(1) + '" height="' + (H - padT - padB) + '" fill="' + col + '"/>';
    }
  }
  // 折线
  series.forEach(function (s) {
    var path = '';
    for (var i = 0; i < n; i++) {
      var v = Number(data[i][s.key]); if (!Number.isFinite(v)) continue;
      path += (path === '' ? 'M' : 'L') + X(i).toFixed(1) + ',' + Y(v).toFixed(1) + ' ';
    }
    svg += '<path d="' + path + '" fill="none" stroke="' + s.color + '" stroke-width="1.5"/>';
  });
  svg += '</svg>';
  // 图例
  var leg = '<div class="bond-val-legend">';
  series.forEach(function (s) { leg += '<span><i style="background:' + s.color + '"></i>' + esc(s.label) + '</span>'; });
  if (opts.band) leg += '<span><i style="background:rgba(41,128,185,0.3)"></i>公允区间</span>';
  if (opts.bands5) leg += '<span><i style="background:rgba(39,174,96,0.4)"></i>低估</span><span><i style="background:rgba(241,196,15,0.4)"></i>合理</span><span><i style="background:rgba(192,57,43,0.4)"></i>高估</span>';
  if (opts.pctlKey) leg += '<span><i style="background:#9b59b6"></i>历史分位边界</span>';
  if (opts.versionKey) leg += '<span><i style="background:#2c3e50"></i>模型版本切换</span>';
  leg += '</div>';
  return svg + leg;
}

function bindBondValChartTips(box) {
  var tip = document.getElementById('bond-val-chart-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'bond-val-chart-tooltip';
    tip.className = 'bond-val-chart-tooltip app-tooltip';
    document.body.appendChild(tip);
  }
  var svgs = box.querySelectorAll('.bond-val-svg[data-tip-id]');
  for (var i = 0; i < svgs.length; i++) {
    svgs[i].addEventListener('mousemove', function (e) {
      var entry = bondValChartTipStore[this.getAttribute('data-tip-id')];
      if (!entry || !entry.data.length) return;
      var rect = this.getBoundingClientRect();
      var plotRatio = ((e.clientX - rect.left) / rect.width * 720 - 48) / (720 - 48 - 12);
      var idx = Math.round(Math.max(0, Math.min(1, plotRatio)) * (entry.data.length - 1));
      var row = entry.data[idx];
      var html = '<strong>' + esc(row.date || row.trade_date || '—') + '</strong>';
      for (var j = 0; j < entry.series.length; j++) {
        var s = entry.series[j], value = Number(row[s.key]);
        html += '<span><i style="background:' + s.color + '"></i>' + esc(s.label) + '：' +
          (Number.isFinite(value) ? esc(num(value, 2) + (entry.opts.pct ? '%' : '')) : '—') + '</span>';
      }
      if (entry.opts.band) {
        var low = Number(row[entry.opts.band[0]]), high = Number(row[entry.opts.band[1]]);
        html += '<span>公允区间：' + (Number.isFinite(low) && Number.isFinite(high) ? esc(num(low, 2) + '～' + num(high, 2)) : '—') + '</span>';
      }
      tip.innerHTML = html;
      tip.style.display = 'block';
      var left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
      var top = e.clientY - tip.offsetHeight - 12;
      if (top < 8) top = Math.min(e.clientY + 18, window.innerHeight - tip.offsetHeight - 8);
      tip.style.left = Math.max(8, left) + 'px';
      tip.style.top = Math.max(8, top) + 'px';
    });
    svgs[i].addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  }
}
