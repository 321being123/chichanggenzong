// ========== 管理后台前端逻辑 ==========
let adminProfile = null;

// 用户管理状态
let usersSearch = '';
let usersOffset = 0;
const usersLimit = 20;

const VIEW_TITLES = {
  overview: '概览仪表盘',
  users: '用户管理',
  brokers: '券商管理',
  jobs: '定时任务',
  announce: '公告与更新',
  settings: '全局参数',
  holidays: '休市日历',
  audit: '操作审计'
};

// Toast（复用风格，utils.js 未提供）
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ====== 通用弹窗 ======
function openAdminModal(title, bodyHtml, actionsHtml) {
  const m = document.getElementById('admin-modal');
  if (!m) return;
  document.getElementById('admin-modal-title').textContent = title;
  document.getElementById('admin-modal-body').innerHTML = bodyHtml;
  document.getElementById('admin-modal-actions').innerHTML = actionsHtml || '';
  m.classList.add('show');
}
function closeAdminModal() {
  const m = document.getElementById('admin-modal');
  if (m) m.classList.remove('show');
}

// ====== 鉴权 ======
async function checkAuth() {
  try {
    const r = await fetch(api('/api/me'));
    const d = await r.json();
    if (!d.username) { window.location.href = api('/login.html?redirect=' + encodeURIComponent('/admin.html')); return false; }
    if (d.role !== 'admin') { window.location.href = api('/'); return false; }
    adminProfile = d;
    const u = document.getElementById('admin-user');
    if (u) u.textContent = '当前账号：' + (d.nickname || d.username);
    return true;
  } catch (e) {
    window.location.href = api('/login.html?redirect=' + encodeURIComponent('/admin.html'));
    return false;
  }
}

async function adminLogout() {
  await fetch(api('/api/logout'), { method: 'POST' });
  window.location.href = api('/login.html');
}

// ====== 菜单切换 ======
function setupMenu() {
  document.querySelectorAll('.admin-menu-item').forEach(function (item) {
    item.addEventListener('click', function () { switchView(item.dataset.view); });
  });
}

function switchView(view) {
  document.querySelectorAll('.admin-menu-item').forEach(function (i) {
    i.classList.toggle('active', i.dataset.view === view);
  });
  document.querySelectorAll('.admin-view').forEach(function (v) {
    v.classList.remove('active');
  });
  const sec = document.getElementById('view-' + view);
  if (sec) sec.classList.add('active');
  const title = document.getElementById('admin-title');
  if (title) title.textContent = VIEW_TITLES[view] || '管理后台';
  if (view === 'overview') renderOverview();
  else if (view === 'users') renderUsers();
  else if (view === 'brokers') renderBrokers();
  else if (view === 'jobs') renderJobs();
  else if (view === 'announce') renderAnnounce();
  else if (view === 'settings') renderSettings();
  else if (view === 'holidays') renderHolidays();
  else if (view === 'audit') renderAudit();
  else renderPlaceholder(view);
}

// ====== 概览仪表盘 ======
async function renderOverview() {
  const el = document.getElementById('view-overview');
  if (!el) return;
  el.innerHTML = '<div class="admin-placeholder"><div class="spinner" style="margin:0 auto 12px;"></div>加载中...</div>';
  try {
    const r = await fetch(api('/api/admin/overview'));
    if (!r.ok) { el.innerHTML = '<div class="admin-placeholder"><div class="icon">⚠️</div>无权限或加载失败</div>'; return; }
    const d = await r.json();
    const cards = [
      { label: '平台总用户', value: d.totalUsers, icon: '👥', bg: 'icon-bg-blue', sub: '含管理员' },
      { label: '管理员', value: d.adminUsers, icon: '🛡️', bg: 'icon-bg-red', sub: 'role=admin' },
      { label: '禁用账号', value: d.disabledUsers, icon: '🚫', bg: 'icon-bg-orange', sub: '已停用' },
      { label: '券商账户', value: d.totalAccounts, icon: '🏦', bg: 'icon-bg-green', sub: '全部用户下' },
      { label: '今日新增用户', value: d.todayNewUsers, icon: '✨', bg: 'icon-bg-blue', sub: '今日注册' },
      { label: '全平台总资产', value: '¥' + Number(d.totalAsset || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }), icon: '💰', bg: 'icon-bg-blue', sub: '各账户最新市值合计' }
    ];
    el.innerHTML = '<div class="stats">' + cards.map(function (c) {
      return '<div class="stat-card">' +
        '<div class="stat-top"><div><div class="label">' + c.label + '</div>' +
        '<div class="value">' + c.value + '</div></div>' +
        '<div class="stat-icon ' + c.bg + '">' + c.icon + '</div></div>' +
        '<div class="sub">' + c.sub + '</div></div>';
    }).join('') + '</div>';
  } catch (e) {
    el.innerHTML = '<div class="admin-placeholder"><div class="icon">⚠️</div>加载失败，请刷新</div>';
  }
}

// ====== 用户管理 ======
function renderUsers() {
  const el = document.getElementById('view-users');
  if (!el) return;
  el.innerHTML =
    '<div class="filter-bar">' +
      '<input id="users-search" placeholder="搜索账号" value="' + escapeHtml(usersSearch) + '" ' +
        'style="padding:5px 9px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;min-width:180px;" ' +
        'onkeydown="if(event.key===\'Enter\'){usersSearch=this.value;usersOffset=0;renderUsers();}">' +
      '<button class="btn btn-primary btn-sm" onclick="usersSearch=document.getElementById(\'users-search\').value;usersOffset=0;renderUsers();">搜索</button>' +
      '<button class="btn btn-outline btn-sm" onclick="usersSearch=\'\';usersOffset=0;renderUsers();">重置</button>' +
    '</div>' +
    '<div class="admin-table-wrap"><table>' +
      '<thead><tr><th>账号</th><th>角色</th><th>状态</th><th>账户数</th><th>注册时间</th><th>操作</th></tr></thead>' +
      '<tbody id="users-tbody"><tr><td colspan="6" style="text-align:center;color:#999;padding:24px;">加载中...</td></tr></tbody>' +
    '</table></div>' +
    '<div class="earnings-pager" id="users-pager"></div>';

  // 事件委托：操作按钮
  document.getElementById('users-tbody').addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const u = btn.dataset.username;
    const action = btn.dataset.action;
    if (action === 'status') adminToggleStatus(u, btn.dataset.cur);
    else if (action === 'role') adminToggleRole(u, btn.dataset.cur);
    else if (action === 'pwd') adminResetPwd(u);
    else if (action === 'del') adminDeleteUser(u);
    else if (action === 'detail') adminShowDetail(u);
  });

  loadUsersData();
}

async function loadUsersData() {
  const tbody = document.getElementById('users-tbody');
  const pager = document.getElementById('users-pager');
  try {
    const r = await fetch(api('/api/admin/users?search=' + encodeURIComponent(usersSearch) + '&limit=' + usersLimit + '&offset=' + usersOffset));
    if (!r.ok) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#d93025;">加载失败</td></tr>'; return; }
    const d = await r.json();
    if (!d.list.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:24px;">暂无用户</td></tr>';
    } else {
      tbody.innerHTML = d.list.map(function (u) {
        const isAdmin = u.role === 'admin';
        const disabled = u.status && u.status !== 'active';
        const roleTag = isAdmin ? '<span class="tag tag-a">管理员</span>' : '<span class="tag">普通用户</span>';
        const statusTag = disabled ? '<span class="tag tag-over">已禁用</span>' : '<span class="tag tag-ok">正常</span>';
        const created = u.created_at ? String(u.created_at).replace('T', ' ').slice(0, 19) : '—';
        const self = u.username === (adminProfile && adminProfile.username);
        return '<tr>' +
          '<td>' + escapeHtml(u.username) + (self ? ' <span class="tag tag-ok">我</span>' : '') + '</td>' +
          '<td>' + roleTag + '</td>' +
          '<td>' + statusTag + '</td>' +
          '<td>' + (u.account_count || 0) + '</td>' +
          '<td>' + created + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button class="btn btn-sm btn-outline" data-action="detail" data-username="' + escapeHtml(u.username) + '">详情</button> ' +
            '<button class="btn btn-sm ' + (disabled ? 'btn-success' : 'btn-warning') + '" data-action="status" data-username="' + escapeHtml(u.username) + '" data-cur="' + (disabled ? 'disabled' : 'active') + '">' + (disabled ? '启用' : '禁用') + '</button> ' +
            '<button class="btn btn-sm ' + (isAdmin ? 'btn-outline' : 'btn-info') + '" data-action="role" data-username="' + escapeHtml(u.username) + '" data-cur="' + u.role + '"' + (self ? ' disabled title="不能修改自己"' : '') + '>' + (isAdmin ? '取消管理员' : '设管理员') + '</button> ' +
            '<button class="btn btn-sm btn-ghost" data-action="pwd" data-username="' + escapeHtml(u.username) + '">重置密码</button> ' +
            '<button class="btn btn-sm btn-danger" data-action="del" data-username="' + escapeHtml(u.username) + '"' + (self ? ' disabled title="不能删除自己"' : '') + '>删除</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }
    // 分页
    const start = d.total === 0 ? 0 : usersOffset + 1;
    const end = Math.min(usersOffset + usersLimit, d.total);
    pager.innerHTML =
      '<span class="pager-info">共 ' + d.total + ' 条，当前 ' + start + '-' + end + '</span>' +
      '<button class="btn btn-sm btn-outline" ' + (usersOffset <= 0 ? 'disabled' : 'onclick="usersOffset=Math.max(0,usersOffset-usersLimit);renderUsers();"') + '>上一页</button>' +
      '<button class="btn btn-sm btn-outline" ' + (end >= d.total ? 'disabled' : 'onclick="usersOffset+=usersLimit;renderUsers();"') + '>下一页</button>';
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#d93025;">网络错误，请重试</td></tr>';
  }
}

async function adminToggleStatus(username, cur) {
  const next = cur === 'active' ? 'disabled' : 'active';
  try {
    const r = await fetch(api('/api/admin/users/' + encodeURIComponent(username) + '/status'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next })
    });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '操作失败'); return; }
    showToast(next === 'active' ? '已启用' : '已禁用');
    loadUsersData();
  } catch (e) { showToast('网络错误'); }
}

async function adminToggleRole(username, cur) {
  const next = cur === 'admin' ? 'user' : 'admin';
  try {
    const r = await fetch(api('/api/admin/users/' + encodeURIComponent(username) + '/role'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: next })
    });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '操作失败'); return; }
    showToast(next === 'admin' ? '已设为管理员' : '已取消管理员');
    loadUsersData();
  } catch (e) { showToast('网络错误'); }
}

function adminResetPwd(username) {
  openAdminModal('重置密码 - ' + username,
    '<div class="form-group"><label>新密码（至少6位）</label><input id="admin-pwd-input" type="password" placeholder="输入新密码" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>',
    '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button>' +
    '<button class="btn btn-primary" onclick="doAdminResetPwd(\'' + escapeHtml(username) + '\')">确定重置</button>'
  );
}
async function doAdminResetPwd(username) {
  const pwd = document.getElementById('admin-pwd-input').value;
  if (!pwd || pwd.length < 6) { showToast('密码至少6位'); return; }
  try {
    const r = await fetch(api('/api/admin/users/' + encodeURIComponent(username) + '/password'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '重置失败'); return; }
    showToast('密码已重置');
    closeAdminModal();
  } catch (e) { showToast('网络错误'); }
}

function adminDeleteUser(username) {
  openAdminModal('删除用户 - ' + username,
    '<p style="font-size:14px;color:#666;line-height:1.6;">确定删除该用户吗？将<b>同时删除其全部持仓、交易、账户与净值数据</b>，且不可恢复。</p>',
    '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button>' +
    '<button class="btn btn-danger" onclick="doAdminDeleteUser(\'' + escapeHtml(username) + '\')">确认删除</button>'
  );
}
async function doAdminDeleteUser(username) {
  try {
    const r = await fetch(api('/api/admin/users/' + encodeURIComponent(username)), { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '删除失败'); return; }
    showToast('已删除');
    closeAdminModal();
    loadUsersData();
  } catch (e) { showToast('网络错误'); }
}

async function adminShowDetail(username) {
  try {
    const r = await fetch(api('/api/admin/users/' + encodeURIComponent(username)));
    if (!r.ok) { showToast('加载失败'); return; }
    const d = await r.json();
    const accts = (d.accounts || []).map(function (a) {
      return '<div class="profile-acct">' + escapeHtml(a.account_name) + ' <span class="tag">' + escapeHtml(a.broker || 'other') + '</span></div>';
    }).join('') || '<div class="acct-empty">暂无账户</div>';
    const created = d.created_at ? String(d.created_at).replace('T', ' ').slice(0, 19) : '—';
    const last = d.last_login ? String(d.last_login).replace('T', ' ').slice(0, 19) : '—';
    openAdminModal('用户详情 - ' + username,
      '<div class="info-row"><span>账号</span><span>' + escapeHtml(d.username) + '</span></div>' +
      '<div class="info-row"><span>角色</span><span>' + (d.role === 'admin' ? '管理员' : '普通用户') + '</span></div>' +
      '<div class="info-row"><span>状态</span><span>' + (d.status === 'active' ? '正常' : '已禁用') + '</span></div>' +
      '<div class="info-row"><span>邮箱</span><span>' + escapeHtml(d.email || '—') + '</span></div>' +
      '<div class="info-row"><span>注册时间</span><span>' + created + '</span></div>' +
      '<div class="info-row"><span>最后登录</span><span>' + last + '</span></div>' +
      '<div class="acct-section-title" style="margin-top:16px;">券商账户</div>' + accts
    );
  } catch (e) { showToast('网络错误'); }
}

// ====== 占位（模块后续任务填充）======
function renderPlaceholder(view) {
  const el = document.getElementById('view-' + view);
  if (!el) return;
  el.innerHTML = '<div class="admin-placeholder"><div class="icon">🚧</div>' +
    (VIEW_TITLES[view] || '该模块') + ' · 建设中</div>';
}

// ====== 券商管理 ======
let brokersSearch = '';
let brokersMarket = '';
const MARKET_TEXT = { A: '中国A股', H: '中国港股', U: '美股' };
const MARKET_OPTS = '<option value="A">中国A股</option><option value="H">中国港股</option><option value="U">美股</option>';

function renderBrokers() {
  const el = document.getElementById('view-brokers');
  if (!el) return;
  el.innerHTML =
    '<div class="filter-bar">' +
      '<input id="brokers-search" placeholder="搜索券商名/代码" value="' + escapeHtml(brokersSearch) + '" ' +
        'style="padding:5px 9px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;min-width:160px;" ' +
        'onkeydown="if(event.key===\'Enter\'){brokersSearch=this.value;renderBrokers();}">' +
      '<select id="brokers-market" onchange="brokersMarket=this.value;renderBrokers();" style="padding:5px 9px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;">' +
        '<option value="">全部市场</option>' + MARKET_OPTS + '</select>' +
      '<button class="btn btn-primary btn-sm" onclick="brokersSearch=document.getElementById(\'brokers-search\').value;renderBrokers();">搜索</button>' +
      '<button class="btn btn-outline btn-sm" onclick="brokersSearch=\'\';brokersMarket=\'\';renderBrokers();">重置</button>' +
      '<button class="btn btn-success btn-sm" style="margin-left:auto;" onclick="openBrokerForm()">+ 新增券商</button>' +
    '</div>' +
      '<div class="admin-table-wrap"><table>' +
      '<thead><tr><th>代码</th><th>名称</th><th>市场</th><th>导入单位</th><th>排序</th><th>操作</th></tr></thead>' +
      '<tbody id="brokers-tbody"><tr><td colspan="6" style="text-align:center;color:#999;padding:24px;">加载中...</td></tr></tbody>' +
    '</table></div>';
  const msel = document.getElementById('brokers-market');
  if (msel) msel.value = brokersMarket;
  document.getElementById('brokers-tbody').addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const code = btn.dataset.code;
    if (btn.dataset.action === 'edit') openBrokerForm(code);
    else if (btn.dataset.action === 'del') deleteBrokerConfirm(code);
  });
  loadBrokersData();
}

async function loadBrokersData() {
  const tbody = document.getElementById('brokers-tbody');
  try {
    const qs = 'search=' + encodeURIComponent(brokersSearch) + '&market=' + encodeURIComponent(brokersMarket);
    const r = await fetch(api('/api/admin/brokers?' + qs));
    if (!r.ok) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#d93025;">加载失败</td></tr>'; return; }
    const d = await r.json();
    if (!d.list.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:24px;">暂无券商</td></tr>';
    } else {
      tbody.innerHTML = d.list.map(function (b) {
        return '<tr>' +
          '<td>' + escapeHtml(b.code) + '</td>' +
          '<td>' + escapeHtml(b.name) + '</td>' +
          '<td><span class="tag">' + (MARKET_TEXT[b.market] || escapeHtml(b.market || '')) + '</span></td>' +
          '<td>' + (b.import_unit === 'lot' ? '<span class="tag tag-a">手</span>' : '<span class="tag">张</span>') + '</td>' +
          '<td>' + (b.sort_order || 0) + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button class="btn btn-sm btn-outline" data-action="edit" data-code="' + escapeHtml(b.code) + '">编辑</button> ' +
            '<button class="btn btn-sm btn-danger" data-action="del" data-code="' + escapeHtml(b.code) + '">删除</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#d93025;">网络错误，请重试</td></tr>';
  }
}

function openBrokerForm(code) {
  const isEdit = !!code;
  let body = '<input type="hidden" id="broker-code-old" value="' + (isEdit ? escapeHtml(code) : '') + '">' +
    '<div class="form-group"><label>券商代码（唯一，如 huatai）</label><input id="broker-code" ' + (isEdit ? 'value="' + escapeHtml(code) + '" disabled' : '') + ' placeholder="英文代码" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>' +
    '<div class="form-group"><label>券商名称</label><input id="broker-name" placeholder="如 华泰证券" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>' +
    '<div class="form-group"><label>市场</label><select id="broker-market" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;">' + MARKET_OPTS + '</select></div>' +
    '<div class="form-group"><label>导入数量单位（持仓导入时，「手」券商的上交所债券按 1手=10张 自动换算）</label><select id="broker-unit" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"><option value="sheet">张（默认，无需换算）</option><option value="lot">手（如华泰上交所债券）</option></select></div>' +
    '<div class="form-group"><label>排序（数字越小越靠前）</label><input id="broker-sort" type="number" value="0" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>';
  openAdminModal(isEdit ? '编辑券商' : '新增券商', body,
    '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button>' +
    '<button class="btn btn-primary" onclick="submitBroker()">保存</button>'
  );
  if (isEdit) {
    fetch(api('/api/admin/brokers/' + encodeURIComponent(code))).then(function (r) { return r.json(); }).then(function (b) {
      const n = document.getElementById('broker-name'); if (n) n.value = b.name || '';
      const m = document.getElementById('broker-market'); if (m) m.value = b.market || 'A';
      const u = document.getElementById('broker-unit'); if (u) u.value = b.import_unit || 'sheet';
      const s = document.getElementById('broker-sort'); if (s) s.value = b.sort_order || 0;
    }).catch(function () {});
  }
}

async function submitBroker() {
  const old = document.getElementById('broker-code-old').value;
  const isEdit = !!old;
  const code = isEdit ? old : (document.getElementById('broker-code').value || '').trim();
  const name = (document.getElementById('broker-name').value || '').trim();
  const market = document.getElementById('broker-market').value;
  const import_unit = document.getElementById('broker-unit').value || 'sheet';
  const sort_order = parseInt(document.getElementById('broker-sort').value, 10) || 0;
  if (!code || !name) { showToast('代码和名称均必填'); return; }
  const url = isEdit ? '/api/admin/brokers/' + encodeURIComponent(code) : '/api/admin/brokers';
  const method = isEdit ? 'PUT' : 'POST';
  const body = isEdit ? { name, market, import_unit, sort_order } : { code, name, market, import_unit, sort_order };
  try {
    const r = await fetch(api(url), { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '保存失败'); return; }
    showToast('已保存');
    closeAdminModal();
    loadBrokersData();
  } catch (e) { showToast('网络错误'); }
}

function deleteBrokerConfirm(code) {
  openAdminModal('删除券商 - ' + code,
    '<p style="font-size:14px;color:#666;line-height:1.6;">确定删除该券商吗？删除后，历史账户中曾选择此券商的将不再能在下拉中找到该选项（账户数据不会丢失）。</p>',
    '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button>' +
    '<button class="btn btn-danger" onclick="doDeleteBroker(\'' + escapeHtml(code) + '\')">确认删除</button>'
  );
}
async function doDeleteBroker(code) {
  try {
    const r = await fetch(api('/api/admin/brokers/' + encodeURIComponent(code)), { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '删除失败'); return; }
    showToast('已删除');
    closeAdminModal();
    loadBrokersData();
  } catch (e) { showToast('网络错误'); }
}

// ====== 定时任务监控 ======
function jobLabel(job) {
  if (!job) return '—';
  if (job.indexOf('market_close:') === 0) return '收盘数据（' + job.slice('market_close:'.length) + '）';
  const map = {
    index_baseline: '指数基线', manual_backfill: '手动补漏',
    manual_holiday_sync: '手动休市核对', holiday_sync: '休市日历同步'
  };
  return map[job] || job;
}
function jobStatusTag(status) {
  if (status === 'done') return '<span class="tag tag-ok">成功</span>';
  if (status === 'failed') return '<span class="tag tag-over">失败</span>';
  if (status === 'running') return '<span class="tag tag-a">运行中</span>';
  return '<span class="tag">' + escapeHtml(status || '—') + '</span>';
}
function fmtTime(t) {
  return t ? String(t).replace('T', ' ').slice(0, 19) : '—';
}

function renderJobs() {
  const el = document.getElementById('view-jobs');
  if (!el) return;
  el.innerHTML =
    '<div class="job-help">' +
      '<div class="job-help-title">📋 任务说明</div>' +
      '<div class="job-help-sub">以下自动任务由系统按周期执行；手动任务可随时点击触发，用于补救或立即生效。</div>' +
      '<div class="job-help-group"><b>自动任务</b>' +
        '<div class="job-help-item"><span class="job-help-name">收盘数据抓取（market_close）</span><span>每个交易日收盘后，自动抓取所有账户当日收盘价与市值并落库（daily_prices），驱动收益走势与净值计算。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">指数基线（index_baseline）</span><span>维护沪深300 / 上证 / 恒生等指数基准点，供收益对比图使用。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">休市日历同步（holiday_sync）</span><span>每月自动从交易所（上交所）日历校正当年法定休市日，确保「交易日判断」准确。</span></div>' +
      '</div>' +
      '<div class="job-help-group"><b>手动任务（下方按钮）</b>' +
        '<div class="job-help-item"><span class="job-help-name">手动补漏收盘数据</span><span>对最近 6 个交易日，逐个账户检查是否缺失当日收盘价/市值，缺失则重新从行情源抓取并补写（已存在的数据不会被覆盖）。<i>适用：收盘任务因网络抖动/接口超时漏抓，导致某天收益图断点。</i></span></div>' +
        '<div class="job-help-item"><span class="job-help-name">手动核对休市日历</span><span>立即从交易所（上交所）日历重新拉取本年度法定休市日并校正 holidays.json（仅改本机文件，无需重启、不动 git）。<i>适用：法定节假日调整后需立即生效。</i></span></div>' +
      '</div>' +
    '</div>' +
    '<div class="filter-bar">' +
      '<button class="btn btn-primary btn-sm" id="job-btn-backfill" onclick="runJobBackfill()">手动补漏收盘数据</button>' +
      '<button class="btn btn-info btn-sm" id="job-btn-holiday" onclick="runJobHolidaySync()">手动核对休市日历</button>' +
      '<button class="btn btn-outline btn-sm" onclick="loadJobsData()">刷新</button>' +
    '</div>' +
    '<div id="jobs-summary" style="margin-bottom:14px;"></div>' +
    '<div class="acct-section-title">最近执行记录</div>' +
    '<div class="admin-table-wrap"><table>' +
      '<thead><tr><th>任务</th><th>状态</th><th>开始时间</th><th>结束时间</th><th>详情</th></tr></thead>' +
      '<tbody id="jobs-tbody"><tr><td colspan="5" style="text-align:center;color:#999;padding:24px;">加载中...</td></tr></tbody>' +
    '</table></div>';
  loadJobsData();
}

async function loadJobsData() {
  const tbody = document.getElementById('jobs-tbody');
  const summary = document.getElementById('jobs-summary');
  try {
    const r = await fetch(api('/api/admin/jobs?limit=50'));
    if (!r.ok) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#d93025;">加载失败</td></tr>'; return; }
    const d = await r.json();
    // 各任务最近状态卡片
    if (summary) {
      summary.innerHTML = (d.summary && d.summary.length)
        ? '<div class="stats">' + d.summary.map(function (s) {
            return '<div class="stat-card"><div class="stat-top"><div>' +
              '<div class="label">' + escapeHtml(jobLabel(s.job)) + '</div>' +
              '<div style="margin-top:6px;">' + jobStatusTag(s.status) + '</div></div></div>' +
              '<div class="sub">最近：' + fmtTime(s.finished_at || s.started_at) + '</div></div>';
          }).join('') + '</div>'
        : '<div class="admin-placeholder" style="padding:16px;">暂无任务记录</div>';
    }
    // 执行记录表
    if (!d.recent || !d.recent.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;padding:24px;">暂无执行记录</td></tr>';
    } else {
      tbody.innerHTML = d.recent.map(function (j) {
        return '<tr>' +
          '<td>' + escapeHtml(jobLabel(j.job)) + '</td>' +
          '<td>' + jobStatusTag(j.status) + '</td>' +
          '<td>' + fmtTime(j.started_at) + '</td>' +
          '<td>' + fmtTime(j.finished_at) + '</td>' +
          '<td style="max-width:320px;word-break:break-all;color:#666;font-size:12px;">' + escapeHtml(j.detail || '') + '</td>' +
        '</tr>';
      }).join('');
    }
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#d93025;">网络错误，请重试</td></tr>';
  }
}

async function runJobBackfill() {
  const btn = document.getElementById('job-btn-backfill');
  if (btn) { btn.disabled = true; btn.textContent = '补漏中...'; }
  try {
    const r = await fetch(api('/api/admin/jobs/backfill'), { method: 'POST' });
    const d = await r.json();
    showToast(r.ok ? '补漏完成' : (d.error || '补漏失败'));
  } catch (e) { showToast('网络错误'); }
  if (btn) { btn.disabled = false; btn.textContent = '手动补漏收盘数据'; }
  loadJobsData();
}

async function runJobHolidaySync() {
  const btn = document.getElementById('job-btn-holiday');
  if (btn) { btn.disabled = true; btn.textContent = '核对中...'; }
  try {
    const r = await fetch(api('/api/admin/jobs/holiday-sync'), { method: 'POST' });
    const d = await r.json();
    showToast(r.ok ? '休市日历已核对' : (d.error || '核对失败'));
  } catch (e) { showToast('网络错误'); }
  if (btn) { btn.disabled = false; btn.textContent = '手动核对休市日历'; }
  loadJobsData();
}

// ====== 平台公告 + 版本更新记录 ======
function renderAnnounce() {
  const el = document.getElementById('view-announce'); if (!el) return;
  el.innerHTML =
    '<div class="filter-bar"><button class="btn btn-success btn-sm" style="margin-left:auto;" onclick="openAnnounceForm()">+ 新增公告</button></div>' +
    '<div class="admin-table-wrap"><table><thead><tr><th>标题</th><th>置顶</th><th>发布日期</th><th>操作</th></tr></thead>' +
    '<tbody id="announce-tbody"><tr><td colspan="4" style="text-align:center;color:#999;padding:24px;">加载中...</td></tr></tbody></table></div>' +
    '<div class="acct-section-title" style="margin-top:22px;">版本更新记录</div>' +
    '<div id="changelog-box" style="margin-bottom:10px;"></div>' +
    '<button class="btn btn-outline btn-sm" onclick="openChangelogForm()">+ 新增更新记录</button>';
  const tb = document.getElementById('announce-tbody');
  if (tb) tb.addEventListener('click', function (e) { const btn = e.target.closest('button[data-action]'); if (!btn) return; const id = btn.dataset.id; if (btn.dataset.action === 'edit') openAnnounceForm(id); else if (btn.dataset.action === 'del') deleteAnnounceConfirm(id); });
  loadAnnounceData();
  loadChangelog();
}
async function loadAnnounceData() {
  const tb = document.getElementById('announce-tbody'); if (!tb) return;
  try {
    const r = await fetch(api('/api/admin/announcements'));
    if (!r.ok) { tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#d93025;">加载失败</td></tr>'; return; }
    const d = await r.json();
    if (!d.list.length) { tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999;padding:24px;">暂无公告</td></tr>'; return; }
    tb.innerHTML = d.list.map(function (a) {
      return '<tr><td>' + escapeHtml(a.title) + '</td><td>' + (a.pinned ? '<span class="tag tag-a">置顶</span>' : '—') + '</td><td>' + escapeHtml(a.published_at || '') + '</td><td style="white-space:nowrap;"><button class="btn btn-sm btn-outline" data-action="edit" data-id="' + escapeHtml(a.id) + '">编辑</button> <button class="btn btn-sm btn-danger" data-action="del" data-id="' + escapeHtml(a.id) + '">删除</button></td></tr>';
    }).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#d93025;">网络错误</td></tr>'; }
}
function openAnnounceForm(id) {
  const isEdit = !!id;
  let body = '<input type="hidden" id="announce-id" value="' + (isEdit ? escapeHtml(id) : '') + '">' +
    '<div class="form-group"><label>标题</label><input id="announce-title" placeholder="公告标题" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>' +
    '<div class="form-group"><label>内容</label><textarea id="announce-content" rows="4" placeholder="公告正文" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></textarea></div>' +
    '<div class="form-group"><label>发布日期</label><input id="announce-published" placeholder="如 2026-07-12（可空）" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>' +
    '<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#555;"><input type="checkbox" id="announce-pinned"> 置顶显示</label>';
  openAdminModal(isEdit ? '编辑公告' : '新增公告', body, '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button><button class="btn btn-primary" onclick="submitAnnounce()">保存</button>');
  if (isEdit) {
    fetch(api('/api/admin/announcements')).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { const a = (d.list || []).find(function (x) { return x.id === id; }); if (!a) return; const t = document.getElementById('announce-title'); if (t) t.value = a.title || ''; const c = document.getElementById('announce-content'); if (c) c.value = a.content || ''; const p = document.getElementById('announce-published'); if (p) p.value = a.published_at || ''; const pin = document.getElementById('announce-pinned'); if (pin) pin.checked = !!a.pinned; }).catch(function () {});
  }
}
async function submitAnnounce() {
  const id = document.getElementById('announce-id').value;
  const isEdit = !!id;
  const body = { title: (document.getElementById('announce-title').value || '').trim(), content: document.getElementById('announce-content').value || '', published_at: document.getElementById('announce-published').value || '', pinned: document.getElementById('announce-pinned').checked };
  if (!body.title) { showToast('标题必填'); return; }
  try {
    const r = await fetch(api(isEdit ? '/api/admin/announcements/' + encodeURIComponent(id) : '/api/admin/announcements'), { method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '保存失败'); return; }
    showToast('已保存'); closeAdminModal(); loadAnnounceData();
  } catch (e) { showToast('网络错误'); }
}
function deleteAnnounceConfirm(id) {
  openAdminModal('删除公告', '<p style="font-size:14px;color:#666;">确定删除该公告吗？</p>', '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button><button class="btn btn-danger" onclick="doDeleteAnnounce(\'' + escapeHtml(id) + '\')">确认删除</button>');
}
async function doDeleteAnnounce(id) {
  try { const r = await fetch(api('/api/admin/announcements/' + encodeURIComponent(id)), { method: 'DELETE' }); const d = await r.json(); if (!r.ok) { showToast(d.error || '删除失败'); return; } showToast('已删除'); closeAdminModal(); loadAnnounceData(); } catch (e) { showToast('网络错误'); }
}
async function loadChangelog() {
  const box = document.getElementById('changelog-box'); if (!box) return;
  try {
    const r = await fetch(api('/api/admin/changelog'));
    if (!r.ok) { box.innerHTML = '<div style="color:#d93025;font-size:13px;">加载失败</div>'; return; }
    const d = await r.json();
    const list = (d.list || []).slice(0, 3);
    if (!list.length) { box.innerHTML = '<div style="color:#999;font-size:13px;">暂无更新记录</div>'; return; }
    box.innerHTML = list.map(function (e) {
      return '<div style="border-left:3px solid #4f6ef7;padding:6px 10px;margin-bottom:8px;background:#f8f9ff;border-radius:0 6px 6px 0;"><div style="font-weight:600;font-size:13px;color:#333;">' + escapeHtml(e.date) + '</div>' + e.items.slice(0, 3).map(function (it) { return '<div style="font-size:12px;color:#666;">· ' + escapeHtml(it) + '</div>'; }).join('') + (e.items.length > 3 ? '<div style="font-size:12px;color:#999;">…共' + e.items.length + '条</div>' : '') + '</div>';
    }).join('');
  } catch (e) { box.innerHTML = '<div style="color:#d93025;font-size:13px;">网络错误</div>'; }
}
function openChangelogForm() {
  let body = '<div class="form-group"><label>日期</label><input id="cl-date" type="date" value="' + new Date().toISOString().slice(0, 10) + '" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>' +
    '<div class="form-group"><label>更新内容</label><textarea id="cl-item" rows="3" placeholder="一句话描述本次更新" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></textarea></div>';
  openAdminModal('新增更新记录', body, '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button><button class="btn btn-primary" onclick="submitChangelog()">添加</button>');
}
async function submitChangelog() {
  const date = document.getElementById('cl-date').value;
  const item = (document.getElementById('cl-item').value || '').trim();
  if (!date || !item) { showToast('日期与内容均必填'); return; }
  try {
    const r = await fetch(api('/api/admin/changelog'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: date, item: item }) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '添加失败'); return; }
    showToast('已添加更新记录'); closeAdminModal(); loadChangelog();
  } catch (e) { showToast('网络错误'); }
}

// ====== 全局参数 ======
function renderSettings() {
  const el = document.getElementById('view-settings'); if (!el) return;
  el.innerHTML = '<div class="admin-placeholder"><div class="spinner" style="margin:0 auto 12px;"></div>加载中...</div>';
  fetch(api('/api/admin/settings')).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
    if (!s) { el.innerHTML = '<div class="admin-placeholder"><div class="icon">⚠️</div>加载失败</div>'; return; }
    const o = s.register_open === '1' ? 'checked' : '';
    const e = s.require_email === '1' ? 'checked' : '';
    el.innerHTML = '<div style="background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:24px 28px;max-width:560px;">' +
      '<div style="display:flex;align-items:center;gap:9px;margin-bottom:16px;"><input type="checkbox" id="set-register-open" ' + o + ' style="flex-shrink:0;accent-color:#1a237e;width:18px;height:18px;"><label for="set-register-open" style="font-size:14px;color:#333;cursor:pointer;user-select:none;">开放注册（关闭后任何人无法注册）</label></div>' +
      '<div style="margin-bottom:16px;"><div style="font-size:13px;color:#555;margin-bottom:6px;">邀请码</div><input id="set-register-code" value="' + escapeHtml(s.register_code || '') + '" placeholder="留空则无需；填写后注册必须匹配，如 abc123" style="width:100%;padding:9px 12px;border:1px solid #d0d0d0;border-radius:6px;font-size:13px;box-sizing:border-box;outline:none;"></div>' +
      '<div style="display:flex;align-items:center;gap:9px;margin-bottom:20px;"><input type="checkbox" id="set-require-email" ' + e + ' style="flex-shrink:0;accent-color:#1a237e;width:18px;height:18px;"><label for="set-require-email" style="font-size:14px;color:#333;cursor:pointer;user-select:none;">注册强制邮箱验证（需服务端已配置邮件服务）</label></div>' +
      '<button class="btn btn-primary" onclick="submitSettings()" style="padding:9px 22px;">保存设置</button>' +
      '<div style="font-size:12px;color:#999;margin-top:12px;">设置即时生效，无需重启。</div></div>';
  }).catch(function () { el.innerHTML = '<div class="admin-placeholder"><div class="icon">⚠️</div>加载失败</div>'; });
}
async function submitSettings() {
  const body = { register_open: document.getElementById('set-register-open').checked, register_code: document.getElementById('set-register-code').value || '', require_email: document.getElementById('set-require-email').checked };
  try {
    const r = await fetch(api('/api/admin/settings'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '保存失败'); return; }
    showToast('设置已保存（即时生效）');
  } catch (e) { showToast('网络错误'); }
}

// ====== 休市日历（日历视图）======
let holidayYear = String(new Date().getFullYear());
let holidayEditSet = null; // 当前年份可编辑的休市日集合(Set of 'YYYY-MM-DD')
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

function renderHolidays() {
  const el = document.getElementById('view-holidays'); if (!el) return;
  el.innerHTML = '<div class="admin-placeholder"><div class="spinner" style="margin:0 auto 12px;"></div>加载中...</div>';
  fetch(api('/api/admin/holidays')).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d) { el.innerHTML = '<div class="admin-placeholder"><div class="icon">⚠️</div>加载失败</div>'; return; }
    const years = Object.keys(d.years || {}).sort();
    if (!years.length) { el.innerHTML = '<div class="admin-placeholder">暂无休市数据</div>'; return; }
    if (years.indexOf(holidayYear) < 0) holidayYear = years[years.length - 1];
    holidayEditSet = new Set((d.years[holidayYear] || []).slice().sort());
    let opts = ''; years.forEach(function (y) { opts += '<option value="' + y + '"' + (y === holidayYear ? ' selected' : '') + '>' + y + '年</option>'; });
    el.innerHTML =
      '<div class="filter-bar">' +
      '<select id="holiday-year" onchange="holidayYear=this.value;renderHolidays();" style="padding:5px 9px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;">' + opts + '</select>' +
      '<input id="holiday-new" type="date" style="padding:5px 9px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;">' +
      '<button class="btn btn-primary btn-sm" onclick="addHolidayByInput()">添加休市日</button>' +
      '<button class="btn btn-outline btn-sm" onclick="saveHolidays()">保存' + holidayYear + '年</button>' +
      '<button class="btn btn-outline btn-sm" onclick="renderHolidays()">刷新</button>' +
      '</div>' +
      '<div style="font-size:12px;color:#888;background:#f6f8fa;padding:8px 10px;border-radius:6px;margin-bottom:12px;">休市日（法定节假日，不含周末）影响收盘数据抓取与交易日判断；修改即时生效，无需部署。每年自动核对。<b>点击日历格可增删</b>：橙色=休市日（点它移除），空白格（点它添加），灰色=周末。</div>' +
      '<div id="holiday-calendar" class="holiday-calendar"></div>';
    renderHolidayCalendar();
  }).catch(function () { el.innerHTML = '<div class="admin-placeholder"><div class="icon">⚠️</div>加载失败</div>'; });
}

function renderHolidayCalendar() {
  const box = document.getElementById('holiday-calendar'); if (!box || !holidayEditSet) return;
  const y = parseInt(holidayYear, 10);
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  let html = '<div class="holiday-grid">';
  for (let m = 1; m <= 12; m++) {
    const startW = new Date(y, m - 1, 1).getDay();
    const days = new Date(y, m, 0).getDate();
    html += '<div class="holiday-month"><div class="holiday-month-title">' + y + '年' + m + '月</div>';
    html += '<div class="holiday-week">' + wd.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
    html += '<div class="holiday-days">';
    for (let i = 0; i < startW; i++) html += '<span class="holiday-cell empty"></span>';
    for (let d = 1; d <= days; d++) {
      const ds = fmtDate(y, m, d);
      const isH = holidayEditSet.has(ds);
      const wknd = (new Date(y, m - 1, d).getDay() === 0 || new Date(y, m - 1, d).getDay() === 6);
      const cls = 'holiday-cell' + (isH ? ' holiday-on' : '') + (wknd && !isH ? ' holiday-weekend' : '');
      const act = isH
        ? ('onclick="removeHoliday(\'' + ds + '\')" title="点击移除 ' + ds + '"')
        : ('onclick="addHoliday(\'' + ds + '\')" title="点击添加 ' + ds + '"');
      html += '<span class="' + cls + '" ' + act + '>' + d + (isH ? '<i class="holiday-x">×</i>' : '') + '</span>';
    }
    html += '</div></div>';
  }
  html += '</div>';
  box.innerHTML = html;
}

function addHoliday(ds) {
  if (!holidayEditSet) return;
  if (holidayEditSet.has(ds)) { showToast('该日期已是休市日'); return; }
  holidayEditSet.add(ds);
  renderHolidayCalendar();
  showToast('已标记 ' + ds + '（点「保存」后生效）');
}
function removeHoliday(ds) {
  if (!holidayEditSet) return;
  holidayEditSet.delete(ds);
  renderHolidayCalendar();
  showToast('已移除 ' + ds + '（点「保存」后生效）');
}
function addHolidayByInput() {
  const inp = document.getElementById('holiday-new');
  const v = inp && inp.value;
  if (!v) { showToast('请选择日期'); return; }
  addHoliday(v);
  if (inp) inp.value = '';
}
async function saveHolidays() {
  if (!holidayEditSet) return;
  const dates = Array.from(holidayEditSet).sort();
  try {
    const r = await fetch(api('/api/admin/holidays'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year: holidayYear, dates: dates }) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '保存失败'); return; }
    showToast('已保存 ' + holidayYear + ' 年休市日（' + dates.length + '天）');
    renderHolidays();
  } catch (e) { showToast('网络错误'); }
}

// ====== 操作审计 ======
function renderAudit() {
  const el = document.getElementById('view-audit'); if (!el) return;
  el.innerHTML =
    '<div class="filter-bar"><button class="btn btn-outline btn-sm" onclick="loadAuditData()">刷新</button></div>' +
    '<div class="admin-table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>' +
    '<tbody id="audit-tbody"><tr><td colspan="5" style="text-align:center;color:#999;padding:24px;">加载中...</td></tr></tbody></table></div>';
  loadAuditData();
}
async function loadAuditData() {
  const tb = document.getElementById('audit-tbody'); if (!tb) return;
  try {
    const r = await fetch(api('/api/admin/audit?limit=100'));
    if (!r.ok) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#d93025;">加载失败</td></tr>'; return; }
    const d = await r.json();
    if (!d.list.length) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;padding:24px;">暂无操作记录</td></tr>'; return; }
    tb.innerHTML = d.list.map(function (a) {
      return '<tr><td>' + escapeHtml(a.created_at || '') + '</td><td>' + escapeHtml(a.actor || '') + '</td><td><span class="tag">' + escapeHtml(a.action || '') + '</span></td><td>' + escapeHtml(a.target || '') + '</td><td style="max-width:360px;word-break:break-all;color:#666;font-size:12px;">' + escapeHtml(a.detail || '') + '</td></tr>';
    }).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#d93025;">网络错误</td></tr>'; }
}

// ====== 启动 ======
(async function init() {
  const ok = await checkAuth();
  if (!ok) return;
  setupMenu();
  renderOverview();
})();
