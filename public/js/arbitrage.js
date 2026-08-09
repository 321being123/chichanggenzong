// ========== 套利机会页面 ==========
// 3 个页签：A 股套利 / 港股私有化 / 港股供股权
// 只展示审核通过且未结束的事件，行情缺失时显示 --

var arbState = {
  type: 'a_stock',
  data: null,
  loading: false,
  detailCaseId: null,
};

var ARB_TITLES = {
  a_stock: 'A 股套利',
  hk_privatisation: '港股私有化',
  hk_rights: '港股供股权',
};

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function num(v, d) {
  if (v == null || !isFinite(v)) return '\u2014';
  return Number(v).toFixed(d || 2);
}

function pctv(v, d) {
  if (v == null || !isFinite(v)) return '\u2014';
  return (v >= 0 ? '+' : '') + Number(v).toFixed(d || 2) + '%';
}

function api(p) {
  return (typeof BASE_URL !== 'undefined' && BASE_URL) ? BASE_URL + p : p;
}

// 页签切换
function switchArbTab(type) {
  arbState.type = type;
  arbState.detailCaseId = null;
  document.querySelectorAll('[data-arb-tab]').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.arbTab === type);
  });
  var title = document.getElementById('arb-table-title');
  if (title) title.textContent = ARB_TITLES[type] || type;
  var detail = document.getElementById('arb-detail');
  if (detail) detail.hidden = true;
  loadArbitrage();
}

// 加载数据
async function loadArbitrage() {
  if (arbState.loading) return;
  arbState.loading = true;
  var statusEl = document.getElementById('arb-status');
  if (statusEl) statusEl.textContent = '\u6b63\u5728\u8bfb\u53d6\u5957\u5229\u6570\u636e...';
  try {
    var r = await fetch(api('/api/arbitrage?type=' + arbState.type + '&page=1&page_size=100'));
    if (!r.ok) throw new Error('\u63a5\u53e3\u8fd4\u56de ' + r.status);
    var json = await r.json();
    arbState.data = json;
    renderArbTable(json);
    if (statusEl) statusEl.textContent = '';
  } catch (e) {
    if (statusEl) statusEl.textContent = '\u6570\u636e\u52a0\u8f7d\u5931\u8d25\uff1a' + (e.message || e);
  } finally {
    arbState.loading = false;
  }
}

// 渲染表格
function renderArbTable(json) {
  var el = document.getElementById('arb-table');
  if (!el) return;
  var rows = json.rows || [];
  var meta = document.getElementById('arb-meta');
  if (meta) {
    var parts = [];
    if (json.dataAsOf) parts.push('\u6570\u636e\u66f4\u65b0 ' + json.dataAsOf.slice(0, 16));
    if (json.stale) parts.push('\u26a0 \u90e8\u5206\u884c\u60c5\u7f3a\u5931');
    parts.push('\u5171 ' + (json.total || 0) + ' \u6761');
    meta.textContent = parts.join(' \u00b7 ');
  }

  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">\u5f53\u524d\u6ca1\u6709\u5ba1\u6838\u901a\u8fc7\u7684\u5957\u5229\u4e8b\u4ef6</div>';
    return;
  }

  var type = arbState.type;
  var html = '<table class="positions-data-table" style="width:100%;font-size:13px;"><thead><tr>';

  if (type === 'a_stock') {
    html += '<th>\u4ee3\u7801</th><th>\u540d\u79f0</th><th>\u73b0\u4ef7</th><th>\u6da8\u8dcc</th>';
    html += '<th>\u73b0\u91d1\u9009\u62e9\u6743/\u6ce8\u9500\u4ef7</th><th>\u5957\u5229\u7a7a\u95f4</th>';
    html += '<th>\u6362\u80a1\u53c2\u8003\u4ef7</th><th>\u6362\u80a1\u6bd4\u4f8b</th><th>\u6362\u80a1\u5957\u5229\u7a7a\u95f4</th>';
    html += '<th>\u7c7b\u578b</th><th>\u5f53\u524d\u8fdb\u7a0b</th><th>\u66f4\u65b0\u65f6\u95f4</th>';
  } else if (type === 'hk_privatisation') {
    html += '<th>\u4ee3\u7801</th><th>\u540d\u79f0</th><th>\u73b0\u4ef7</th><th>\u6da8\u8dcc</th>';
    html += '<th>\u6ce8\u9500\u4ef7</th><th>\u5957\u5229\u7a7a\u95f4</th>';
    html += '<th>\u9996\u6b21\u516c\u544a</th><th>\u5f53\u524d\u8fdb\u7a0b</th>';
    html += '<th>\u8981\u7ea6\u4eba</th><th>\u6301\u80a1%</th><th>\u66f4\u65b0\u65f6\u95f4</th>';
  } else if (type === 'hk_rights') {
    html += '<th>\u6b63\u80a1\u4ee3\u7801</th><th>\u4f9b\u80a1\u6743\u4ee3\u7801</th><th>\u540d\u79f0</th>';
    html += '<th>\u6b63\u80a1\u4ef7</th><th>\u4f9b\u80a1\u6743\u4ef7</th><th>\u6da8\u8dcc</th>';
    html += '<th>\u4f9b\u80a1\u4ef7</th><th>\u4f9b\u80a1\u6bd4\u4f8b</th>';
    html += '<th>\u5957\u5229\u7a7a\u95f4</th><th>\u4ea4\u6613\u671f</th><th>\u4ed8\u6b3e\u622a\u6b62</th><th>\u66f4\u65b0\u65f6\u95f4</th>';
  }

  html += '</tr></thead><tbody>';

  rows.forEach(function (r) {
    var cls = r.stale ? ' style="opacity:0.6;"' : '';
    var click = ' onclick="openArbDetail(' + r.case_id + ')" style="cursor:pointer;"';
    html += '<tr' + cls + click + '>';

    if (type === 'a_stock') {
      html += '<td>' + esc(r.canonical_code || '\u2014') + '</td>';
      html += '<td>' + esc(r.name || '\u2014') + '</td>';
      html += '<td>' + num(r.currentPrice) + '</td>';
      html += '<td style="color:' + (r.changePct >= 0 ? '#d93025' : '#137333') + ';">' + pctv(r.changePct) + '</td>';
      html += '<td>' + num(r.offer_price || r.cash_choice_price) + '</td>';
      html += '<td style="color:' + (r.arbitrageSpace >= 0 ? '#d93025' : '#137333') + ';">' + pctv(r.arbitrageSpace) + '</td>';
      html += '<td>' + num(r.theoreticalPrice) + '</td>';
      html += '<td>' + (r.swap_ratio ? esc(r.swap_ratio) : '\u2014') + '</td>';
      html += '<td style="color:' + (r.arbitrageSpace >= 0 ? '#d93025' : '#137333') + ';">' + pctv(r.arbitrageSpace) + '</td>';
      html += '<td>' + esc(formatStrategyType(r.strategy_type)) + '</td>';
      html += '<td>' + esc(r.event_status) + '</td>';
      html += '<td>' + (r.terms_updated_at ? esc(String(r.terms_updated_at).slice(0, 10)) : '\u2014') + '</td>';
    } else if (type === 'hk_privatisation') {
      html += '<td>' + esc(r.canonical_code || '\u2014') + '</td>';
      html += '<td>' + esc(r.name || '\u2014') + '</td>';
      html += '<td>' + num(r.currentPrice) + '</td>';
      html += '<td style="color:' + (r.changePct >= 0 ? '#d93025' : '#137333') + ';">' + pctv(r.changePct) + '</td>';
      html += '<td>' + num(r.offer_price) + '</td>';
      html += '<td style="color:' + (r.arbitrageSpace >= 0 ? '#d93025' : '#137333') + ';">' + pctv(r.arbitrageSpace) + '</td>';
      html += '<td>' + (r.announced_at ? esc(String(r.announced_at).slice(0, 10)) : '\u2014') + '</td>';
      html += '<td>' + esc(r.event_status) + '</td>';
      html += '<td>' + esc(r.offeror || '\u2014') + '</td>';
      html += '<td>' + num(r.offeror_holding_pct, 2) + '</td>';
      html += '<td>' + (r.terms_updated_at ? esc(String(r.terms_updated_at).slice(0, 10)) : '\u2014') + '</td>';
    } else if (type === 'hk_rights') {
      html += '<td>' + esc(r.canonical_code || '\u2014') + '</td>';
      html += '<td>' + esc(r.rights_code || '\u2014') + '</td>';
      html += '<td>' + esc(r.name || '\u2014') + '</td>';
      html += '<td>' + num(r.currentPrice) + '</td>';
      html += '<td>' + num(r.rightsPrice) + '</td>';
      html += '<td style="color:' + (r.changePct >= 0 ? '#d93025' : '#137333') + ';">' + pctv(r.changePct) + '</td>';
      html += '<td>' + num(r.subscription_price) + '</td>';
      html += '<td>' + (r.rights_ratio_numerator && r.rights_ratio_denominator ? r.rights_ratio_numerator + ':' + r.rights_ratio_denominator : '\u2014') + '</td>';
      html += '<td style="color:' + (r.arbitrageSpace >= 0 ? '#d93025' : '#137333') + ';">' + pctv(r.arbitrageSpace) + '</td>';
      html += '<td>' + (r.rights_trade_start && r.rights_trade_end ? esc(r.rights_trade_start) + '~' + esc(r.rights_trade_end) : '\u2014') + '</td>';
      html += '<td>' + (r.payment_deadline ? esc(String(r.payment_deadline).slice(0, 10)) : '\u2014') + '</td>';
      html += '<td>' + (r.terms_updated_at ? esc(String(r.terms_updated_at).slice(0, 10)) : '\u2014') + '</td>';
    }

    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

function formatStrategyType(t) {
  var map = {
    a_cash_offer: '\u73b0\u91d1\u9009\u62e9\u6743',
    a_share_swap: '\u6362\u80a1\u5438\u6536\u5408\u5e76',
    hk_privatisation: '\u79c1\u6709\u5316',
    hk_rights: '\u4f9b\u80a1\u6743',
  };
  return map[t] || t || '\u2014';
}

// 详情
async function openArbDetail(caseId) {
  arbState.detailCaseId = caseId;
  var detail = document.getElementById('arb-detail');
  if (!detail) return;
  detail.hidden = false;
  detail.innerHTML = '<div style="padding:20px;color:#999;">\u52a0\u8f7d\u4e2d...</div>';

  try {
    var r = await fetch(api('/api/arbitrage/' + caseId));
    if (!r.ok) throw new Error('\u63a5\u53e3\u8fd4\u56de ' + r.status);
    var d = await r.json();
    renderArbDetail(d);
  } catch (e) {
    detail.innerHTML = '<div style="padding:20px;color:#d93025;">\u52a0\u8f7d\u5931\u8d25\uff1a' + esc(e.message) + '</div>';
  }
}

function renderArbDetail(d) {
  var detail = document.getElementById('arb-detail');
  if (!detail) return;

  var html = '<div class="table-wrap"><div class="table-header"><h3>\u5957\u5229\u8be6\u60c5</h3>';
  html += '<button class="btn btn-sm btn-ghost" onclick="closeArbDetail()">\u5173\u95ed</button></div>';
  html += '<div style="padding:16px;">';

  // 关键条款
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:16px;">';
  html += arbDetailItem('\u76ee\u6807\u8bc1\u5238', esc(d.canonical_code) + ' ' + esc(d.name));
  html += arbDetailItem('\u73b0\u4ef7', num(d.currentPrice) + (d.stale ? ' (\u884c\u60c5\u7f3a\u5931)' : ''));
  if (d.offer_price) html += arbDetailItem('\u73b0\u91d1\u5bf9\u4ef7/\u6ce8\u9500\u4ef7', num(d.offer_price));
  if (d.subscription_price) html += arbDetailItem('\u4f9b\u80a1\u4ef7', num(d.subscription_price));
  if (d.swap_ratio) html += arbDetailItem('\u6362\u80a1\u6bd4\u4f8b', esc(d.swap_ratio));
  if (d.theoreticalPrice) html += arbDetailItem('\u7406\u8bba\u5bf9\u4ef7', num(d.theoreticalPrice));
  if (d.arbitrageValue != null) html += arbDetailItem('\u5957\u5229\u4ef7\u503c', num(d.arbitrageValue));
  if (d.arbitrageSpace != null) html += arbDetailItem('\u5957\u5229\u7a7a\u95f4', pctv(d.arbitrageSpace));
  if (d.offeror) html += arbDetailItem('\u8981\u7ea6\u4eba', esc(d.offeror));
  if (d.offeror_holding_pct != null) html += arbDetailItem('\u6301\u80a1\u6bd4\u4f8b', num(d.offeror_holding_pct, 2) + '%');
  if (d.announced_at) html += arbDetailItem('\u9996\u6b21\u516c\u544a\u65e5', esc(String(d.announced_at).slice(0, 10)));
  if (d.rights_trade_start) html += arbDetailItem('\u4ea4\u6613\u671f', esc(d.rights_trade_start) + ' ~ ' + esc(d.rights_trade_end || ''));
  if (d.payment_deadline) html += arbDetailItem('\u4ed8\u6b3e\u622a\u6b62', esc(String(d.payment_deadline).slice(0, 10)));
  if (d.listing_date) html += arbDetailItem('\u65b0\u80a1\u4e0a\u5e02', esc(String(d.listing_date).slice(0, 10)));
  html += '</div>';

  // 风险提示
  html += '<div style="background:#fff3e0;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px;color:#e65100;">';
  html += '\u26a0 \u4ee5\u4e0a\u4e3a\u672a\u6263\u9664\u4ea4\u6613\u8d39\u7528\u7684\u7406\u8bba\u6bdb\u7a7a\u95f4\uff0c\u4ec5\u4f9b\u53c2\u8003\uff0c\u4e0d\u6784\u6210\u6295\u8d44\u5efa\u8bae\u3002';
  html += '</div>';

  // 公告链
  if (d.documents && d.documents.length) {
    html += '<h4 style="margin-bottom:8px;">\u516c\u544a\u94fe</h4>';
    html += '<div style="margin-bottom:8px;">';
    d.documents.forEach(function (doc) {
      var url = doc.url || '';
      var isWhitelisted = url && /^(https?:\/\/)?(www1\.hkexnews\.hk|www\.cninfo\.com\.cn)/.test(url);
      html += '<div style="padding:6px 0;border-bottom:1px solid #eee;font-size:13px;">';
      html += '<span style="color:#666;">' + (doc.announced_at ? esc(String(doc.announced_at).slice(0, 10)) : '\u2014') + '</span> ';
      if (isWhitelisted) {
        html += '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="color:#1a73e8;">' + esc(doc.title) + '</a>';
      } else {
        html += esc(doc.title);
      }
      html += '</div>';
    });
    html += '</div>';
  }

  // 计算口径
  html += '<div style="font-size:12px;color:#999;margin-top:8px;">';
  html += '\u516c\u5f0f\u7248\u672c: ' + esc(d.formulaVersion || '\u2014') + ' | ';
  html += '\u884c\u60c5\u65f6\u95f4: ' + (d.quoteAsOf ? esc(d.quoteAsOf.slice(0, 16)) : '\u2014') + ' | ';
  html += '\u6570\u636e\u65f6\u95f4: ' + (d.dataAsOf ? esc(d.dataAsOf.slice(0, 16)) : '\u2014');
  html += '</div>';

  html += '</div></div>';
  detail.innerHTML = html;
}

function arbDetailItem(label, value) {
  return '<div><div style="font-size:12px;color:#999;">' + label + '</div><div style="font-weight:500;">' + value + '</div></div>';
}

function closeArbDetail() {
  var detail = document.getElementById('arb-detail');
  if (detail) { detail.hidden = true; detail.innerHTML = ''; }
  arbState.detailCaseId = null;
}
