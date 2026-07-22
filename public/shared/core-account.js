// shared/core-account.js – 收益页渲染/全量渲染/自动刷新/账户管理（原 core.js 拆分，全局作用域不变）
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
  const col = function (v) { return v >= 0 ? '#d93025' : '#137333'; };

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

// 收益页包装：复用总览页共享走势图（统一全量 + spanGaps，两页一致）
let earnReturnMode = '1y';

function switchEarnPeriod(mode) {
  earnReturnMode = mode;
  document.querySelectorAll('#earnings-returns-period [data-mode]').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.querySelector('#earnings-returns-period [data-mode="' + mode + '"]');
  if (btn) btn.classList.add('active');
  renderEarningsReturnsChart();
}

function renderEarningsReturnsChart() {
  renderNavVsIndexChart('chart-earnings-returns', { mode: earnReturnMode });
}

function renderEarningsTable(sorted) {
  const el = document.getElementById('earnings-table');
  if (!el) return;
  earningsSorted = sorted;
  const wan = function (v) { return (Number(v || 0) / 10000).toFixed(2) + '万'; };
  const trendColor = function (v) { return v > 0 ? '#d93025' : (v < 0 ? '#137333' : '#888'); };
  const cols = [
    { t: '日期', get: function (r) { return r.date || '-'; } },
    { t: '总市值(万元)', get: function (r) { return wan(r.totalMarketValue); } },
    { t: '投入本金(万元)', get: function (r) { return wan(r.totalInvested); } },
    { t: '净值', get: function (r) { return Number(r.nav || 1).toFixed(4); } },
    { t: '总收益率', right: true, color: function (r) { return trendColor(r.totalReturn || 0); }, get: function (r) { return ((r.totalReturn || 0) >= 0 ? '+' : '') + ((r.totalReturn || 0) * 100).toFixed(2) + '%'; } },
    { t: '本周涨跌', right: true, color: function (r) { return trendColor(r.weekChange || 0); }, get: function (r) { return ((r.weekChange || 0) >= 0 ? '+' : '') + ((r.weekChange || 0) * 100).toFixed(2) + '%'; } },
    { t: '今日涨跌', right: true, color: function (r) { return (r.dayChange == null) ? '#888' : trendColor(r.dayChange); }, get: function (r) { return (r.dayChange == null) ? '-' : ((r.dayChange >= 0) ? '+' : '') + ((r.dayChange || 0) * 100).toFixed(2) + '%'; } },
    { t: '年化', right: true, color: function (r) { return trendColor(r.annualizedReturn || 0); }, get: function (r) { return ((r.annualizedReturn || 0) >= 0 ? '+' : '') + ((r.annualizedReturn || 0) * 100).toFixed(2) + '%'; } },
    { t: '当前回撤', right: true, color: function (r) { return trendColor(r.currentDrawdown || 0); }, get: function (r) { return ((r.currentDrawdown || 0) * 100).toFixed(2) + '%'; } },
    { t: '今年收益', right: true, color: function (r) { return (r.yearReturn == null) ? '#888' : trendColor(r.yearReturn); }, get: function (r) { return (r.yearReturn == null) ? '-' : ((r.yearReturn >= 0 ? '+' : '') + ((r.yearReturn) * 100).toFixed(2) + '%'); } },
    { t: '操作', center: true,       get: function (r) {
        return '<button class="btn btn-outline btn-sm" data-act="openNavEdit" data-date="' + escapeHtml(r.date) + '">编辑</button> ' +
               '<button class="btn btn-danger btn-sm" data-act="deleteNav" data-date="' + escapeHtml(r.date) + '">删除</button>';
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
  try { if (typeof renderHomeHoldings === 'function') renderHomeHoldings(); } catch(e) {}
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
  // 每 15 分钟自动刷新行情：休市时也刷新（接口回落最近交易日收盘价），
  // 保证总资产始终按持仓现值实时计算，页面常开时无需手动刷新。
  _autoRefreshTimer = setInterval(function () {
    if (data && data.positions && data.positions.length > 0) {
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
  var modal = document.getElementById('modal-account');
  if (modal) modal.classList.add('show');
  renderAccountForm();
}

// 券商字典缓存（进程内只拉一次，避免每次开弹窗都请求）
var _brokerDictCache = null;
async function loadBrokerDict() {
  if (_brokerDictCache) return _brokerDictCache;
  try {
    var r = await fetch(api('/api/brokers?market=A'));
    _brokerDictCache = r.ok ? await r.json() : [];
  } catch (e) { _brokerDictCache = []; }
  return _brokerDictCache;
}

// 用户在账户管理里为某账户选择券商 → 落库；若为当前账户则同步 data._broker，交易录入单位换算即时生效
async function saveAccountBroker(name, broker) {
  try {
    var r = await fetch(api('/api/accounts/broker'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_name: name, broker: broker })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (name === currentAccount && data) data._broker = broker;
    showToast('已设置「' + name + '」券商');
  } catch (e) { showToast('券商保存失败，请重试'); }
}

// 根据当前状态（新建/重命名/空闲）动态渲染底部表单区
function renderAccountForm() {
  var el = document.getElementById('account-form-section');
  if (!el) return;

  // 空闲态：点 ⚙ 打开、尚未操作 → 显示虚线引导框
  if (!accountIsNew && !accountActionTarget) {
    el.innerHTML =
      '<div class="acct-idle" onclick="addAccount();renderAccountForm();">' +
        '<div class="acct-idle-icon">+</div>' +
        '<div class="acct-idle-text">点击新建账户</div>' +
      '</div>';
    return;
  }

  // 新建态
  if (accountIsNew) {
    var titleHtml = '新建账户';
    var placeHolder = '请输入新账户名称';
    var btnLabel = '创建';
    var btnClass = 'btn-primary';
    var val = '';
    el.innerHTML =
      '<div class="acct-section-title">' + titleHtml + '</div>' +
      '<div class="acct-add">' +
        '<input id="account-name-input" placeholder="' + placeHolder + '" value="' + escapeHtml(val) + '">' +
        '<button class="btn ' + btnClass + '" onclick="saveAccountName()">' + btnLabel + '</button>' +
        '<button class="btn btn-outline" onclick="showAccountMenu()">取消</button>' +
      '</div>';
    setTimeout(function () {
      var inp = document.getElementById('account-name-input');
      if (inp) { inp.focus(); inp.select(); }
    }, 50);
    return;
  }

  // 重命名态
  if (accountActionTarget) {
    var oldName = accountActionTarget || '';
    el.innerHTML =
      '<div class="acct-section-title">重命名「' + escapeHtml(oldName) + '」</div>' +
      '<div class="acct-add">' +
        '<input id="account-name-input" placeholder="请输入新名称" value="' + escapeHtml(oldName) + '">' +
        '<button class="btn btn-primary" onclick="saveAccountName()">确认重命名</button>' +
        '<button class="btn btn-outline" onclick="showAccountMenu()">取消</button>' +
      '</div>';
    setTimeout(function () {
      var inp = document.getElementById('account-name-input');
      if (inp) { inp.focus(); inp.select(); }
    }, 50);
    return;
  }
}

// 券商下拉的 change 事件委托（下拉动态生成，用委托统一处理）
(function initBrokerChangeDelegation() {
  if (window.__brokerChangeDelegated) return;
  window.__brokerChangeDelegated = true;
  document.addEventListener('change', function (e) {
    var sel = e.target.closest ? e.target.closest('[data-broker-account]') : null;
    if (!sel) return;
    saveAccountBroker(sel.getAttribute('data-broker-account'), sel.value);
  });
})();

// 账户卡片点击切换（点卡片 = 切换当前账户，蓝边框跟随移动）
(function initAccountSwitchDelegation() {
  if (window.__accountSwitchDelegated) return;
  window.__accountSwitchDelegated = true;
  document.addEventListener('click', function (e) {
    // 排除：点击按钮/下拉框时不触发切换（它们有自己的处理逻辑）
    if (e.target.closest('button, select, [data-act]')) return;
    var card = e.target.closest ? e.target.closest('[data-account-switch]') : null;
    if (!card) return;
    var name = card.getAttribute('data-account-switch');
    if (name && name !== currentAccount) {
      switchAccount(name);
      // 切换后重渲染卡片列表，让 is-current 蓝边框跟随更新
      showAccountMenu();
    }
  });
})();

async function showAccountMenu() {
  accountIsNew = false;
  accountActionTarget = null;

  // 券商字典 + 各账户当前券商（供每行下拉回填）
  var brokerDict = await loadBrokerDict();
  var acctBrokers = {};
  try {
    var rb = await fetch(api('/api/accounts/broker'));
    if (rb.ok) acctBrokers = await rb.json();
  } catch (e) {}

  // 渲染账户列表，每个账户都显示券商下拉 + 操作按钮
  var listEl = document.getElementById('account-list');
  if (listEl) {
    listEl.innerHTML = accounts.map(function(a) {
      var isCurrent = a === currentAccount;
      var canDelete = accounts.length > 1;
      var cur = acctBrokers[a] || 'other';
      var initial = (a || '?').trim().charAt(0);
      var opts = brokerDict.map(function(b) {
        return '<option value="' + escapeHtml(b.code) + '"' + (b.code === cur ? ' selected' : '') + '>' + escapeHtml(b.name) + '</option>';
      }).join('');
      return '<div class="acct-card' + (isCurrent ? ' is-current' : '') + '" data-account-switch="' + escapeHtml(a) + '">' +
          '<div class="acct-avatar">' + escapeHtml(initial) + '</div>' +
          '<div class="acct-body">' +
            '<div class="acct-name-row">' +
              '<span class="acct-name">' + escapeHtml(a) + '</span>' +
              (isCurrent ? '<span class="acct-badge">当前</span>' : '') +
            '</div>' +
            '<div class="acct-broker">' +
              '<label>券商</label>' +
              '<select data-broker-account="' + escapeHtml(a) + '">' + opts + '</select>' +
            '</div>' +
          '</div>' +
          '<div class="acct-actions">' +
            '<button class="btn btn-outline btn-sm" data-act="editAccount" data-account="' + escapeHtml(a) + '">修改名称</button>' +
            (canDelete
              ? '<button class="btn btn-danger btn-sm" data-act="promptDeleteAccount" data-account="' + escapeHtml(a) + '">删除</button>'
              : '') +
          '</div>' +
        '</div>';
    }).join('') || '<div class="acct-empty">暂无账户，点左上角「+」新建一个吧</div>';
  }

  var modal = document.getElementById('modal-account');
  if (modal) modal.classList.add('show');
  renderAccountForm();
}

function editAccount(name) {
  accountIsNew = false;
  accountActionTarget = name;
  var modal = document.getElementById('modal-account');
  if (modal) modal.classList.add('show');
  renderAccountForm();
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
