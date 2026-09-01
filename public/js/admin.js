// ========== 管理后台前端逻辑 ==========
let adminProfile = null;
let jobsPollTimer = null;
let jobsVisibilityBound = false;
let settingsTab = 'site';

// 用户管理状态
let usersSearch = '';
let usersOffset = 0;
const usersLimit = 20;

const VIEW_TITLES = {
  overview: '概览仪表盘',
  users: '用户管理',
  brokers: '券商管理',
  jobs: '定时任务',
  settings: '全局参数',
  holidays: '休市日历',
  audit: '操作审计',
  ops: '数据运维',
  knowledge: '投资笔记管理',
  arbitrage: '套利审核'
};

// 后台视图所需能力（无映射者仅需任一后台能力即可访问，与后端 requireStaff 一致）
const VIEW_CAPABILITY = {
  users: 'user_manage',
  brokers: 'ops_manage',
  jobs: 'ops_manage',
  settings: 'ops_manage',
  holidays: 'ops_manage',
  ops: 'ops_manage',
  knowledge: 'content_manage',
  arbitrage: 'ops_manage'
};

function adminCan(cap) {
  if (!adminProfile) return false;
  if (adminProfile.role === 'admin') return true;
  const caps = adminProfile.capabilities || {};
  return !!caps[cap];
}

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
    adminProfile = d;
    const caps = d.capabilities || {};
    const hasAny = d.role === 'admin' || Object.keys(caps).some(function (k) { return caps[k]; });
    if (!hasAny) { adminProfile = null; window.location.href = api('/'); return false; }
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

// 按能力隐藏无权访问的菜单（后端已独立校验，此处仅避免误点）
function applyMenuPermissions() {
  document.querySelectorAll('.admin-menu-item').forEach(function (item) {
    const cap = VIEW_CAPABILITY[item.dataset.view];
    if (cap && !adminCan(cap)) item.style.display = 'none';
  });
}

function switchView(view) {
  if (view !== 'jobs' && jobsPollTimer) { clearInterval(jobsPollTimer); jobsPollTimer = null; }
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
  else if (view === 'settings') renderSettings();
  else if (view === 'holidays') renderHolidays();
  else if (view === 'audit') renderAudit();
  else if (view === 'ops') renderOps();
  else if (view === 'knowledge') renderKnowledge();
  else if (view === 'arbitrage') renderArbitrage();
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
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table">' +
      '<thead><tr><th>账号</th><th>角色</th><th>状态</th><th>账户数</th><th>注册时间</th><th>操作</th></tr></thead>' +
      '<tbody id="users-tbody"><tr><td colspan="6" class="biz-table-state-cell">加载中...</td></tr></tbody>' +
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
    if (!r.ok) { tbody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">加载失败</td></tr>'; return; }
    const d = await r.json();
    if (!d.list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell">暂无用户</td></tr>';
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
          '<td class="biz-table-nowrap">' +
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
    tbody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">网络错误，请重试</td></tr>';
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
    '<div class="form-group"><label>新密码（至少6位）</label><input id="admin-pwd-input" type="password" autocomplete="new-password" placeholder="输入新密码" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>',
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
      '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table">' +
      '<thead><tr><th>代码</th><th>名称</th><th>市场</th><th>导入单位</th><th>排序</th><th>操作</th></tr></thead>' +
      '<tbody id="brokers-tbody"><tr><td colspan="6" class="biz-table-state-cell">加载中...</td></tr></tbody>' +
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
    if (!r.ok) { tbody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">加载失败</td></tr>'; return; }
    const d = await r.json();
    if (!d.list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell">暂无券商</td></tr>';
    } else {
      tbody.innerHTML = d.list.map(function (b) {
        return '<tr>' +
          '<td>' + escapeHtml(b.code) + '</td>' +
          '<td>' + escapeHtml(b.name) + '</td>' +
          '<td><span class="tag">' + (MARKET_TEXT[b.market] || escapeHtml(b.market || '')) + '</span></td>' +
          '<td>' + (b.import_unit === 'lot' ? '<span class="tag tag-a">手</span>' : '<span class="tag">张</span>') + '</td>' +
          '<td>' + (b.sort_order || 0) + '</td>' +
          '<td class="biz-table-nowrap">' +
            '<button class="btn btn-sm btn-outline" data-action="edit" data-code="' + escapeHtml(b.code) + '">编辑</button> ' +
            '<button class="btn btn-sm btn-danger" data-action="del" data-code="' + escapeHtml(b.code) + '">删除</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">网络错误，请重试</td></tr>';
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
const JOB_LABELS = {
  index_baseline: '指数基线补齐',
  index_recent: '指数每日补齐',
  nav_snapshot: '净值快照',
  hk_rate: '港币汇率更新',
  bond_safety_refresh: '可转债安全评分',
  convertible_bond_universe_refresh: '可转债行情同步',
  convertible_bond_redemption_announcement_sync: '可转债强赎公告同步',
  convertible_bond_revision_motive_inputs_sync: '下修动机输入增量同步',
  convertible_bond_revision_motive_calculate: '下修动机评分计算',
  convertible_bond_announcement_history_sync: '可转债下修与转股价公告事实同步',
  convertible_bond_announcement_reparse: '可转债旧公告重新解析',
  convertible_bond_valuation_refresh: '可转债估值预警',
  stock_analysis_refresh: '个股分析刷新',
  ipo_calendar_refresh: '打新日历与日报',
  ipo_history_sync: 'IPO事实同步',
  market_volatility_sync: '股市波动指标同步',
  hk_trade_rules_sync: '港股每手股数同步',
  arbitrage_sync: '套利公告同步',
  arbitrage_reparse: '套利公告重新解析',
  holiday_sync: '休市日历同步',
  manual_backfill: '手动补漏收盘数据',
  manual_holiday_sync: '手动核对休市日历',
};
const JOB_FIELD_LABELS = {
  reason: '执行原因', executable: '执行程序', retryOf: '关联重试', ok: '执行结果', source: '数据来源', bootstrap: '是否首次初始化',
  window_start: '开始日期', window_end: '结束日期', fetched: '获取数量', inserted: '新增数量', refreshed: '更新数量', completed_fields: '已补全字段数',
  first_day: '首日表现', quality: '数据质量', missing_records: '缺少记录数', missing_fields: '缺少字段数', calendar_diff: '日历差异数',
  enrichment: '数据补充', attempted: '尝试处理数', updated: '更新数量', pending: '待处理数量', failed: '失败数量', remaining: '剩余数量',
  cycleMetrics: '波动指标', cnYield: '中债收益率', csi300Pe: '沪深300市盈率', csiAllPe: '中证全指市盈率', hsiPe: '恒生指数市盈率',
  usTreasuryYield: '美国十年期国债收益率', csi300Valuation: '沪深300估值', moneySupply: '货币供应', aShareMarketCap: 'A股市值', m2MarketCap: 'M2市值',
  trade_date: '交易日期', tradeDate: '交易日期', data_as_of: '数据日期', dataAsOf: '数据日期', runId: '执行编号', detail: '说明', error: '错误',
  count: '数量', total: '总数', saved: '写入数量', synced: '同步数量', skipped: '跳过数量', errors: '错误数量', message: '说明', output: '执行日志',
  recorded: '记录数量', accounts: '账户数量', missingDates: '缺少日期', rate: '汇率', expected: '目标日期', last: '最新日期', previous: '上次执行',
  days: '交易日数量', recovered: '恢复数量', result: '同步结果', label: '任务类别', modelVersion: '模型版本', incomplete: '数据是否不完整',
  status: '状态', caseId: '事件编号', parse_pending: '待解析数量', parse_exhausted: '解析失败数量', unsupported: '是否支持',
};
const JOB_VALUE_LABELS = {
  scheduled: '定时执行', startup_catchup: '启动补跑', manual_retry: '人工补跑', auto_retry: '自动重试', locked: '已有同类任务运行', already_running: '已有同类任务运行',
  already_initialized: '已经完成初始化', cached: '使用已缓存结果', not_configured: '未配置，已跳过', in_process: '已有进程运行', fresh: '数据已是最新',
  'retry-after-failure': '失败后重试', no_missing: '没有缺失数据', no_nav: '没有净值记录', not_due: '尚未到执行时间', job_runs: '任务执行记录',
  'tushare.new_share': 'Tushare 新股接口', tushare: 'Tushare 数据接口', tencent: '腾讯行情接口', tushare_close: 'Tushare 收盘数据',
};
function jobLabel(job) {
  if (!job) return '—';
  if (JOB_LABELS[job]) return JOB_LABELS[job];
  if (job.indexOf('market_close:') === 0) return job.slice('market_close:'.length) + '收盘数据';
  return '其他后台任务';
}
function jobTriggerLabel(trigger) { return JOB_VALUE_LABELS[trigger] || (trigger ? '系统触发' : '—'); }
function jobActionLabel(action) {
  return { job_validate: '重新校验', job_retry: '人工补跑', job_acknowledge: '确认任务异常', job_alert_resend: '重发告警', job_alert_acknowledge: '确认告警' }[action] || (action ? '系统操作' : '—');
}
function jobStatusLabel(status) {
  return { done: '成功', succeeded: '成功', failed: '失败', running: '运行中', pending: '待运行', blocked: '已阻塞', degraded: '降级', skipped: '已跳过', sent: '已发送', resolved: '已恢复', acknowledged: '已确认', sending: '发送中', send_failed: '发送失败' }[status] || status || '—';
}
function jobFieldLabel(field) { return JOB_FIELD_LABELS[field] || '任务信息'; }
function translateJobText(value) {
  let text = String(value || '')
    .replace(/\bmarket_close:([^#、，\s]+)#(\d+)/g, function (all, market, id) { return jobLabel('market_close:' + market) + '#' + id; });
  Object.keys(JOB_LABELS).forEach(function (code) {
    text = text.split(code + '#').join(JOB_LABELS[code] + '#');
  });
  return text
    .replace(/\bparse_pending\b/g, '待解析数量')
    .replace(/\bparse_exhausted\b/g, '解析失败数量')
    .replace(/\bscheduled\b/g, '定时执行')
    .replace(/\bacceptance_recheck_2\b/g, '验收复核第2次')
    .replace(/\bacceptance_recheck\b/g, '验收复核')
    .replace(/\bhkex\b/g, '港交所')
    .replace(/\bcninfo\b/g, '巨潮资讯')
    .replace(/\berrors\b/g, '错误数量')
    .replace(/\bmodel=/g, '模型版本：')
    .replace(/\breason=/g, '执行原因：')
    .replace(/\btrade_date=/g, '交易日期：')
    .replace(/\bwindow_start=/g, '开始日期：')
    .replace(/\bwindow_end=/g, '结束日期：')
    .replace(/\bspawn\b/g, '启动程序失败')
    .replace(/\bENOENT\b/g, '文件不存在')
    .replace(/\/opt\/portfolio\/[^\s|]+/g, 'Python 任务程序')
    .replace(/\balready_running\b/g, '已有同类任务运行')
    .replace(/\bnot_configured\b/g, '未配置，已跳过')
    .replace(/\bPermission denied\b/gi, '权限不足');
}
function jobValueLabel(value, field) {
  if (value === null || value === undefined || value === '') return '';
  if (field === 'ok') return value ? '成功' : '失败';
  if (field === 'bootstrap') return value ? '是' : '否';
  if (field === 'executable') return 'Python 数据同步程序';
  if (field === 'output') return '程序执行日志已完成（详细日志不在页面展开）';
  if (field === 'status') return jobStatusLabel(String(value));
  if (typeof value === 'boolean') return value ? '是' : '否';
  return JOB_VALUE_LABELS[value] || (typeof value === 'string' ? translateJobText(value) : String(value));
}
function formatJobObject(value) {
  if (!value || typeof value !== 'object') return '';
  return Object.keys(value).reduce(function (parts, field) {
    const item = value[field];
    if (item === null || item === undefined || item === '') return parts;
    if (Array.isArray(item)) {
      if (item.length) parts.push(jobFieldLabel(field) + '：' + item.map(function (entry) { return typeof entry === 'object' ? formatJobObject(entry) : jobValueLabel(entry, field); }).join('、'));
      return parts;
    }
    if (typeof item === 'object') {
      const nested = formatJobObject(item);
      if (nested) parts.push(jobFieldLabel(field) + '（' + nested + '）');
      return parts;
    }
    parts.push(jobFieldLabel(field) + '：' + jobValueLabel(item, field));
    return parts;
  }, []).join('；');
}
function formatJobDetail(value, limit) {
  let parsed = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
  }
  const formatted = parsed && typeof parsed === 'object' ? formatJobObject(parsed) : translateJobText(String(parsed || ''));
  const max = Number(limit) || 500;
  return formatted.length > max ? formatted.slice(0, max) + '…' : formatted;
}
function jobDescription(job) {
  if (!job) return '';
  if (job.indexOf('market_close:') === 0) {
    const market = job.slice('market_close:'.length);
    return '每个交易日收盘后，自动抓取' + market + '持仓的当日收盘价与市值并落库，用于计算收益与净值。';
  }
  const map = {
    bond_safety_refresh: '每日早 6:30 刷新可转债安全评分快照，供转债筛选与风险面板使用。',
    convertible_bond_universe_refresh: '每日 08:00 按上一交易日同步可转债全量数据（含价格、条款、评级、正股等）；目标日数据不完整时有限回看并自动重试。',
    hk_rate: '每日自动抓取港币兑人民币汇率并写入所有账户，用于港股持仓的人民币估值。',
    index_baseline: '首次启动或新增账户时，自动补齐净值起点之前的沪深300/上证/中证500/恒生等指数基准点位。',
    index_recent: '每日补齐最近交易日的指数点位，确保收益对比图数据连续。',
    nav_snapshot: '收盘后根据当日收盘价自动计算并补齐每个账户的总资产与净值记录（nav_history）。',
    stock_analysis_refresh: '每日 20:30 刷新用户关注个股的深度分析数据（估值、财务、情绪等）。',
    ipo_calendar_refresh: '工作日 18:00 自动更新 IPO/打新日历与每日打新日报数据。',
    ipo_history_sync: '工作日 19:30 独立增量同步新股历史、发行详情与首日表现；启动时自动补漏。',
    market_volatility_sync: '每日 18:45 同步中债收益率、沪深指数估值、恒指市盈率等数据，并计算股市波动指标。',
    convertible_bond_valuation_refresh: '在可转债行情同步后自动刷新估值、预警与模型结果。',
    hk_trade_rules_sync: '每日同步港股证券的每手股数和交易规则，供港股持仓测算使用。',
    arbitrage_sync: '每日同步港交所和巨潮资讯的套利公告，并更新事件状态。',
    arbitrage_reparse: '按指定事件重新解析已入库公告，补齐套利条款和风险字段。',
    holiday_sync: '每月自动核对交易所法定休市日，确保「是否交易日」判断准确。',
    manual_backfill: '手动触发：查询每个账户已落库日期范围内缺失的交易日，再重新抓取补齐。',
    manual_holiday_sync: '手动触发：立即从交易所日历重新拉取并校正当年休市日。'
  };
  return map[job] || '系统自动后台任务。';
}
function jobStatusTag(status) {
  if (status === 'done') return '<span class="tag tag-ok">成功</span>';
  if (status === 'failed') return '<span class="tag tag-over">失败</span>';
  if (status === 'running') return '<span class="tag tag-a">运行中</span>';
  return '<span class="tag">' + escapeHtml(jobStatusLabel(status)) + '</span>';
}
function fmtTime(t) {
  if (!t) return '—';
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) return String(t).replace('T', ' ').slice(0, 19);
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function renderJobsLegacy() {
  const el = document.getElementById('view-jobs');
  if (!el) return;
  el.innerHTML =
    '<div class="job-help">' +
      '<div class="job-help-title">📋 任务说明</div>' +
      '<div class="job-help-sub">以下自动任务由系统按周期执行；手动任务可随时点击触发，用于补救或立即生效。</div>' +
      '<div class="job-help-group"><b>自动任务</b>' +
        '<div class="job-help-item"><span class="job-help-name">A 股 / 可转债 / LOF·ETF 收盘数据（15:10）</span><span>每个交易日收盘后，抓取所有账户对应持仓的收盘价并写入 daily_prices。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">港股收盘数据（16:10）</span><span>抓取港股持仓收盘价；完成后依次触发当日净值快照、指数点位与港币汇率更新。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">净值快照</span><span>根据已落库的收盘价，补齐每个账户的总资产和净值记录。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">指数基线与每日补齐</span><span>启动时补齐净值起点以来的指数基线；每个交易日收盘后补齐沪深300、上证、中证500、恒生等最新点位。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">港币汇率</span><span>每个交易日港股收盘后更新港币兑人民币汇率，用于港股持仓人民币估值。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">可转债安全评分（06:30）</span><span>每日刷新可转债安全评分快照，供转债筛选与风险面板使用。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">可转债行情、估值与预警（08:00 / 08:15）</span><span>08:00 按上一交易日同步可转债行情、条款、评级与正股信息，随后刷新估值和预警结果；目标日数据不完整时有限回看并自动重试。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">打新日历与日报（工作日 18:00）</span><span>自动生成并更新 IPO/打新日历和每日打新日报。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">股市波动指标（18:45）</span><span>同步中债收益率、沪深指数估值、恒指市盈率等数据，并重新计算股市波动指标。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">个股分析（20:30）</span><span>刷新用户关注个股的估值、财务和情绪等深度分析数据。</span></div>' +
        '<div class="job-help-item"><span class="job-help-name">休市日历同步（启动时及每月）</span><span>从交易所日历校正当年法定休市日，确保「交易日判断」准确。</span></div>' +
      '</div>' +
      '<div class="job-help-group"><b>手动任务（下方按钮）</b>' +
        '<div class="job-help-item"><span class="job-help-name">手动补漏收盘数据</span><span>先查询每个账户已落库日期范围内缺失的交易日，再逐日从行情源抓取并补写（已存在的数据不会被覆盖）。<i>适用：收盘任务因网络抖动/接口超时漏抓，导致某天收益图断点。</i></span></div>' +
      '</div>' +
    '</div>' +
    '<div class="filter-bar">' +
      '<button class="btn btn-primary btn-sm" id="job-btn-backfill" onclick="runJobBackfill()">手动补漏收盘数据</button>' +
      '<button class="btn btn-outline btn-sm" onclick="loadJobsData()">刷新</button>' +
    '</div>' +
     '<div id="jobs-summary" style="margin-bottom:14px;"></div>' +
    '<div class="acct-section-title">最近执行记录</div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table">' +
      '<thead><tr><th>任务</th><th>说明</th><th>状态</th><th>开始时间</th><th>结束时间</th><th>详情</th></tr></thead>' +
      '<tbody id="jobs-tbody"><tr><td colspan="6" class="biz-table-state-cell">加载中...</td></tr></tbody>' +
    '</table></div>';
  loadJobsData();
}

async function importFederalFunds() {
  const input = document.getElementById('set-fed-file'), file = input && input.files && input.files[0];
  if (!file) return showToast('请选择 CSV 或 XLSX 文件');
  const button = document.getElementById('set-btn-fed'), form = new FormData(); form.append('file', file); button.disabled = true;
  try {
    const r = await fetch(api('/api/market-volatility/federal-funds/import'), { method: 'POST', body: form }), d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status); input.value = ''; showToast('已导入 ' + d.imported + ' 条日频利率数据');
  } catch (e) { showToast('导入失败：' + (e.message || e)); }
  finally { button.disabled = false; }
}

async function loadJobsDataLegacy() {
  const tbody = document.getElementById('jobs-tbody');
  const summary = document.getElementById('jobs-summary');
  try {
    const r = await fetch(api('/api/admin/jobs?limit=50'));
    if (!r.ok) { tbody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">加载失败</td></tr>'; return; }
    const d = await r.json();
    // 各任务最近状态卡片
    if (summary) {
      summary.innerHTML = (d.summary && d.summary.length)
        ? '<div class="stats">' + d.summary.map(function (s) {
            const desc = escapeHtml(jobDescription(s.job));
            return '<div class="stat-card" title="' + desc + '"><div class="stat-top"><div>' +
              '<div class="label">' + escapeHtml(jobLabel(s.job)) + '</div>' +
              '<div style="margin-top:6px;">' + jobStatusTag(s.status) + '</div></div></div>' +
              '<div class="sub">最近：' + fmtTime(s.finished_at || s.started_at) + '</div></div>';
          }).join('') + '</div>'
        : '<div class="admin-placeholder" style="padding:16px;">暂无任务记录</div>';
    }
    // 执行记录表
    if (!d.recent || !d.recent.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell">暂无执行记录</td></tr>';
    } else {
      tbody.innerHTML = d.recent.map(function (j) {
        return '<tr>' +
          '<td>' + escapeHtml(jobLabel(j.job)) + '</td>' +
          '<td class="biz-table-note-cell biz-table-note-cell--260">' + escapeHtml(jobDescription(j.job)) + '</td>' +
          '<td>' + jobStatusTag(j.status) + '</td>' +
          '<td>' + fmtTime(j.started_at) + '</td>' +
          '<td>' + fmtTime(j.finished_at) + '</td>' +
          '<td class="biz-table-note-cell biz-table-note-cell--260 biz-table-break-all">' + escapeHtml(jobDisplayText(j.detail || '', 500)) + '</td>' +
        '</tr>';
      }).join('');
    }
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">网络错误，请重试</td></tr>';
  }
}

function jobSlotStatusTag(status, late) {
  if (late && status === 'pending') return '<span class="tag tag-over">超时待处理</span>';
  if (status === 'succeeded' || status === 'done') return '<span class="tag tag-ok">成功</span>';
  if (status === 'running') return '<span class="tag tag-a">运行中</span>';
  if (status === 'failed' || status === 'blocked') return '<span class="tag tag-over">' + (status === 'blocked' ? '已阻塞' : '失败') + '</span>';
  if (status === 'degraded') return '<span class="tag tag-warn">降级</span>';
  return '<span class="tag">待运行</span>';
}

function renderJobs() {
  const el = document.getElementById('view-jobs');
  if (!el) return;
  el.innerHTML =
    '<div class="job-help"><div class="job-help-title">后台自动任务</div>' +
      '<div class="job-help-sub">这里同时展示计划时间、实际运行结果、超时任务和邮件告警。失败或漏跑时可直接补跑；补跑和确认操作都会留下审计记录。</div>' +
    '</div>' +
    '<div class="filter-bar">' +
      '<button class="btn btn-primary btn-sm" id="job-btn-backfill" onclick="runJobBackfill()">手动补漏收盘数据</button>' +
      '<button class="btn btn-outline btn-sm" onclick="testJobAlertEmail()">测试告警邮件</button>' +
      '<button class="btn btn-outline btn-sm" onclick="loadJobsData()">刷新</button>' +
      '<span id="job-worker-status" class="job-worker-status">正在读取 Worker 状态…</span>' +
    '</div>' +
    '<div id="jobs-summary" style="margin-bottom:14px;"></div>' +
    '<div class="acct-section-title">今日计划与运行情况</div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr><th>任务</th><th>计划时间</th><th>状态</th><th>尝试次数</th><th>数据日期</th><th>最近结果</th><th>操作</th></tr></thead>' +
      '<tbody id="jobs-slots-tbody"><tr><td colspan="7" class="biz-table-state-cell">加载中…</td></tr></tbody></table></div>' +
    '<div class="acct-section-title">待处理告警</div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr><th>时间</th><th>任务</th><th>告警</th><th>状态</th><th>操作</th></tr></thead>' +
      '<tbody id="jobs-alerts-tbody"><tr><td colspan="5" class="biz-table-state-cell">加载中…</td></tr></tbody></table></div>' +
    '<div class="acct-section-title">最近运行记录</div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr><th>任务</th><th>状态</th><th>开始时间</th><th>结束时间</th><th>触发方式</th><th>详情</th></tr></thead>' +
      '<tbody id="jobs-tbody"><tr><td colspan="6" class="biz-table-state-cell">加载中…</td></tr></tbody></table></div>';
  loadJobsData();
  if (jobsPollTimer) clearInterval(jobsPollTimer);
  jobsPollTimer = setInterval(function () {
    if (document.visibilityState === 'visible' && document.getElementById('view-jobs')?.classList.contains('active')) loadJobsData();
  }, 30000);
  if (!jobsVisibilityBound) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && document.getElementById('view-jobs')?.classList.contains('active')) loadJobsData();
    });
    jobsVisibilityBound = true;
  }
}

async function retryJobSlotFromUi(slotId) {
  try {
    const detailResponse = await fetch(api('/api/admin/jobs/slots/' + encodeURIComponent(slotId)));
    const detail = await detailResponse.json();
    if (!detailResponse.ok) return showToast(detail.error || '读取任务信息失败');
    const label = detail.definition && detail.definition.label || detail.job_code || '该任务';
    const targetDate = detail.business_date ? String(detail.business_date).slice(0, 10) : '-';
    const source = detail.definition && detail.definition.sourceDescription || '本地数据库与该任务已配置的数据源';
    const cost = detail.definition && detail.definition.mayConsumeQuota ? '可能消耗接口额度' : '通常不产生额外接口费用';
    if (!window.confirm('确认补跑“' + label + '”？\n目标业务日期：' + targetDate + '\n访问数据源：' + source + '\n成本提示：' + cost + '。')) return;
    const r = await fetch(api('/api/admin/jobs/slots/' + encodeURIComponent(slotId) + '/retry'), { method: 'POST' });
    const d = await r.json();
    showToast(r.ok ? (d.queued ? '已加入补跑队列' : '补跑完成') : (d.error || '补跑失败'));
  } catch (e) { showToast('网络错误'); }
  loadJobsData();
}

async function validateJobSlotFromUi(slotId) {
  try {
    const r = await fetch(api('/api/admin/jobs/slots/' + encodeURIComponent(slotId) + '/validate'), { method: 'POST' });
    const d = await r.json();
    showToast(d.message || (r.ok ? '重新校验通过' : '重新校验未通过'));
  } catch (e) { showToast('网络错误'); }
  loadJobsData();
}

async function acknowledgeJobSlot(slotId) {
  try {
    const r = await fetch(api('/api/admin/jobs/slots/' + encodeURIComponent(slotId) + '/acknowledge'), { method: 'POST' });
    const d = await r.json();
    showToast(r.ok ? '已确认并接管' : (d.error || '操作失败'));
  } catch (e) { showToast('网络错误'); }
  loadJobsData();
}

async function testJobAlertEmail() {
  try {
    const r = await fetch(api('/api/admin/jobs/alert-email/test'), { method: 'POST' });
    const d = await r.json();
    showToast(r.ok ? '测试邮件已发送' : (d.error || '邮件测试失败'));
  } catch (e) { showToast('网络错误'); }
}

async function loadJobsData() {
  const slotBody = document.getElementById('jobs-slots-tbody');
  const runBody = document.getElementById('jobs-tbody');
  const alertBody = document.getElementById('jobs-alerts-tbody');
  const summary = document.getElementById('jobs-summary');
  ensureJobMonitorControls();
  ensureJobMonitorAdvancedControls();
  try {
    const responses = await Promise.all([
      fetch(api('/api/admin/jobs/overview')),
      fetch(api('/api/admin/jobs/slots?limit=100' + jobSlotQuery())),
      fetch(api('/api/admin/jobs?limit=50')),
      fetch(api('/api/admin/jobs/notifications?limit=30')),
    ]);
    const data = await Promise.all(responses.map(r => r.json()));
    if (responses.some(r => !r.ok)) throw new Error('load failed');
    const overview = data[0], slots = data[1].list || [], runs = data[2], alerts = data[3].list || [];
    if (summary) {
      const counts = (overview.counts || []).reduce((map, item) => { map[item.status] = item.count; return map; }, {});
      const alertCounts = (overview.alerts || []).reduce((map, item) => { map[item.status] = Number(item.count || 0); return map; }, {});
      const emailConfigured = Boolean(overview.health && overview.health.emailConfigured);
      const emailStatus = !emailConfigured ? '未配置' : (alertCounts.send_failed ? '投递失败' : '正常');
      const emailColor = !emailConfigured || alertCounts.send_failed ? '#d93025' : '#188038';
      summary.innerHTML = '<div class="stats">' +
        '<div class="stat-card"><div class="label">今日计划</div><div class="value">' + slots.length + '</div><div class="sub">已生成持久化计划</div></div>' +
        '<div class="stat-card"><div class="label">已成功</div><div class="value" style="color:#188038">' + (counts.succeeded || 0) + '</div><div class="sub">可继续观察数据时间</div></div>' +
        '<div class="stat-card"><div class="label">待处理异常</div><div class="value" style="color:#d93025">' + ((counts.failed || 0) + (counts.blocked || 0) + (counts.degraded || 0)) + '</div><div class="sub">失败、阻塞或降级</div></div>' +
        '<div class="stat-card"><div class="label">告警数量</div><div class="value">' + (overview.alerts || []).reduce((n, item) => n + Number(item.count || 0), 0) + '</div><div class="sub">邮件告警会去重抑制</div></div>' +
        '<div class="stat-card"><div class="label">邮件告警</div><div class="value" style="color:' + emailColor + '">' + emailStatus + '</div><div class="sub">可在下方查看投递失败详情</div></div>' +
      '</div>';
    }
    const workers = overview.workers || [];
    workers.sort(function (a, b) { return (a.role === 'worker' ? 0 : 1) - (b.role === 'worker' ? 0 : 1); });
    const workerText = workers.length ? 'Worker 心跳：' + fmtTime(workers[0].last_seen_at) + '（' + (workers[0].status || 'unknown') + '）' : '未检测到 Worker 心跳';
    const workerEl = document.getElementById('job-worker-status'); if (workerEl) workerEl.textContent = workerText;
    if (slotBody) slotBody.innerHTML = slots.length ? slots.map(renderJobSlotRow).join('') : '<tr><td colspan="7" class="biz-table-state-cell">暂无计划</td></tr>';
    const freshness = document.getElementById('jobs-freshness');
    if (freshness) freshness.innerHTML = '<div class="job-help-sub">数据日期：' + escapeHtml(slots.filter(function (slot) { return slot.data_as_of; }).map(function (slot) { return jobLabel(slot.job_code) + ' ' + String(slot.data_as_of).slice(0, 10); }).join(' ｜ ') || '暂无可确认数据日期') + '</div>';
    if (runBody) runBody.innerHTML = runs.recent && runs.recent.length ? runs.recent.map(function (j) {
      return '<tr><td>' + escapeHtml(jobLabel(j.job)) + '</td><td>' + jobStatusTag(j.status) + '</td><td>' + fmtTime(j.started_at) + '</td><td>' + fmtTime(j.finished_at) + '</td><td>' + escapeHtml(jobTriggerLabel(j.trigger_type || 'scheduled')) + '</td><td class="biz-table-note-cell biz-table-note-cell--300 biz-table-break-all">' + escapeHtml(jobDisplayText(j.detail || '', 500)) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="biz-table-state-cell">暂无运行记录</td></tr>';
    if (alertBody) alertBody.innerHTML = alerts.length ? alerts.map(function (alert) {
      return '<tr><td>' + fmtTime(alert.last_seen_at) + '</td><td>' + escapeHtml(jobLabel(alert.job_code)) + '</td><td class="biz-table-note-cell biz-table-note-cell--320 biz-table-break-word">' + escapeHtml(jobDisplayText(alert.summary || alert.subject || '', 300)) + '</td><td>' + escapeHtml(jobStatusLabel(alert.status)) + '</td><td><button class="btn btn-outline btn-xs" onclick="resendJobAlert(' + Number(alert.alert_id) + ')">重发</button> <button class="btn btn-outline btn-xs" onclick="acknowledgeJobAlert(' + Number(alert.alert_id) + ')">确认</button></td></tr>';
    }).join('') : '<tr><td colspan="5" class="biz-table-state-cell">暂无待处理告警</td></tr>';
  } catch (e) {
    if (slotBody) slotBody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">加载失败，请刷新重试</td></tr>';
    if (runBody) runBody.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">加载失败，请刷新重试</td></tr>';
    if (alertBody) alertBody.innerHTML = '<tr><td colspan="5" class="biz-table-state-cell biz-table-error">加载失败，请刷新重试</td></tr>';
  }
}

function ensureJobMonitorControls() {
  const summary = document.getElementById('jobs-summary');
  if (!summary || document.getElementById('job-status-filter')) return;
  summary.insertAdjacentHTML('afterend',
    '<div class="filter-bar"><label>任务状态 <select id="job-status-filter" onchange="loadJobsData()">' +
      '<option value="">全部</option><option value="pending">待执行</option><option value="running">运行中</option>' +
      '<option value="failed">失败</option><option value="blocked">阻塞</option><option value="degraded">降级</option>' +
      '<option value="succeeded">成功</option></select></label></div>' +
    '<div id="jobs-freshness" style="margin-bottom:14px;"></div>'
  );
}

function jobSlotQuery() {
  const fields = [
    ['date', 'job-date-filter'], ['status', 'job-status-filter'],
    ['category', 'job-category-filter'], ['trigger', 'job-trigger-filter'],
    ['keyword', 'job-keyword-filter'],
  ];
  return fields.reduce(function (query, item) {
    const el = document.getElementById(item[1]);
    const value = el && el.value ? String(el.value).trim() : '';
    return value ? query + '&' + item[0] + '=' + encodeURIComponent(value) : query;
  }, '');
}

function jobDisplayText(value, limit) {
  const text = formatJobDetail(value, limit).replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/(Permission denied|权限不足)/i.test(text) && /ipo_xgb_model\.json/i.test(text)) {
    return 'XGBoost 模型文件写入失败：ipo_xgb_model.json 权限不足，请重新部署修复目录归属。';
  }
  if ((text.match(/\uFFFD/g) || []).length >= 3) {
    return '历史运行输出编码异常，原内容无法完整还原；重新执行后将以 UTF-8 正常显示。';
  }
  const max = Number(limit) || 300;
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function ensureJobMonitorAdvancedControls() {
  const summary = document.getElementById('jobs-summary');
  if (!summary || document.getElementById('job-date-filter')) return;
  summary.insertAdjacentHTML('afterend',
    '<div class="filter-bar" style="gap:8px;flex-wrap:wrap;">' +
      '<label>日期 <input id="job-date-filter" type="date" onchange="loadJobsData()"></label>' +
      '<label>分类 <select id="job-category-filter" onchange="loadJobsData()"><option value="">全部分类</option><option value="data_sync">数据同步</option><option value="system">系统任务</option></select></label>' +
      '<label>触发方式 <select id="job-trigger-filter" onchange="loadJobsData()"><option value="">全部触发</option><option value="scheduled">定时</option><option value="manual_retry">人工补跑</option><option value="auto_retry">自动重试</option></select></label>' +
      '<label>关键词 <input id="job-keyword-filter" type="search" placeholder="任务或错误内容" onkeydown="if(event.key===\'Enter\') loadJobsData()"></label>' +
    '</div>'
  );
  const table = document.getElementById('jobs-slots-tbody')?.closest('table');
  if (table) {
    const headers = table.querySelectorAll('thead th');
    ['任务', '计划时间', '状态', '尝试次数', '数据日期', '最近结果', '操作'].forEach(function (text, index) {
      if (headers[index]) headers[index].textContent = text;
    });
  }
}

function renderJobSlotRow(slot) {
  const detail = '<button class="btn btn-outline btn-xs" onclick="openJobSlotDetail(' + Number(slot.slot_id) + ')">详情</button>';
  const validate = (slot.status === 'succeeded' || slot.status === 'degraded')
    ? ' <button class="btn btn-outline btn-xs" onclick="validateJobSlotFromUi(' + Number(slot.slot_id) + ')">重新校验</button>' : '';
  const retry = (slot.status === 'failed' || slot.status === 'degraded' || slot.status === 'blocked')
    ? ' <button class="btn btn-outline btn-xs" onclick="retryJobSlotFromUi(' + Number(slot.slot_id) + ')">立即补跑</button> <button class="btn btn-outline btn-xs" onclick="acknowledgeJobSlot(' + Number(slot.slot_id) + ')">确认</button>' : '';
  const watermark = slot.data_as_of ? String(slot.data_as_of).slice(0, 10) : '-';
  return '<tr><td>' + escapeHtml(jobLabel(slot.job_code)) + '</td><td>' + fmtTime(slot.scheduled_for) + '</td><td>' + jobSlotStatusTag(slot.status, slot.is_late) + '</td><td>' + Number(slot.attempt_count || 0) + '/' + Number(slot.max_attempts || 4) + '</td><td>' + escapeHtml(watermark) + '</td><td class="biz-table-note-cell biz-table-note-cell--260 biz-table-break-word">' + escapeHtml(jobDisplayText(slot.last_error || (slot.result_summary && JSON.stringify(slot.result_summary)) || '', 300)) + '</td><td>' + detail + validate + retry + '</td></tr>';
}

async function resendJobAlert(alertId) {
  try {
    const r = await fetch(api('/api/admin/jobs/notifications/' + encodeURIComponent(alertId) + '/resend'), { method: 'POST' });
    const d = await r.json();
    showToast(r.ok ? '告警邮件已重新投递' : (d.error || '邮件投递失败'));
  } catch (e) { showToast('网络错误'); }
  loadJobsData();
}

async function acknowledgeJobAlert(alertId) {
  try {
    const r = await fetch(api('/api/admin/jobs/alerts/' + encodeURIComponent(alertId) + '/acknowledge'), { method: 'POST' });
    const d = await r.json();
    showToast(r.ok ? '告警已确认' : (d.error || '确认失败'));
  } catch (e) { showToast('网络错误'); }
  loadJobsData();
}

async function openJobSlotDetailLegacy(slotId) {
  try {
    const r = await fetch(api('/api/admin/jobs/slots/' + encodeURIComponent(slotId)));
    const d = await r.json();
    if (!r.ok) return showToast(d.error || '读取详情失败');
    openAdminModal('任务详情', '<div class="job-detail"><p><b>任务：</b>' + escapeHtml(jobLabel(d.job_code)) + '</p><p><b>状态：</b>' + jobSlotStatusTag(d.status) + '</p><p><b>计划时间：</b>' + fmtTime(d.scheduled_for) + '</p><p><b>最近错误：</b>' + escapeHtml(jobDisplayText(d.last_error || '无', 1000)) + '</p><p><b>结果：</b><br>' + escapeHtml(jobDisplayText(d.result_summary || {}, 4000)) + '</p></div>', '<button class="btn btn-outline" onclick="closeAdminModal()">关闭</button>');
  } catch (e) { showToast('网络错误'); }
}

// 任务详情包含执行尝试、数据水位、依赖、邮件告警和人工审计，便于直接定位异常。
async function openJobSlotDetail(slotId) {
  try {
    const r = await fetch(api('/api/admin/jobs/slots/' + encodeURIComponent(slotId)));
    const d = await r.json();
    if (!r.ok) return showToast(d.error || '读取详情失败');
    const list = function (items, mapper, empty) {
      return (items || []).map(mapper).join('') || '<li>' + empty + '</li>';
    };
    const runs = list(d.runs, function (run) { return '<li>' + escapeHtml(jobStatusLabel(run.status)) + ' / ' + fmtTime(run.started_at) + ' / ' + escapeHtml(jobTriggerLabel(run.trigger_type)) + ' / 外部请求 ' + Number(run.external_call_count || 0) + ' 次 / ' + escapeHtml(run.error_type || '') + ' / ' + escapeHtml(jobDisplayText(run.detail || '', 1000)) + '</li>'; }, '暂无执行记录');
    const deps = list(d.dependencies, function (dep) { return '<li>' + escapeHtml(jobLabel(dep.job_code)) + '：' + escapeHtml(jobStatusLabel(dep.status)) + '，数据日期 ' + escapeHtml(dep.data_as_of ? String(dep.data_as_of).slice(0, 10) : '-') + '</li>'; }, '无前置依赖');
    const alerts = list(d.alerts, function (alert) { return '<li>' + escapeHtml(jobStatusLabel(alert.status)) + ' / 尝试 ' + Number(alert.send_attempts || 0) + ' / ' + escapeHtml(jobDisplayText(alert.last_send_error || alert.subject || '', 1000)) + '</li>'; }, '无告警记录');
    const audits = list(d.audits, function (audit) { return '<li>' + escapeHtml(audit.actor || '-') + ' / ' + escapeHtml(jobActionLabel(audit.action)) + ' / ' + escapeHtml(audit.created_at || '') + '</li>'; }, '无审计记录');
    const freshness = d.freshness_validation || {};
    const html = '<div class="job-detail"><p><b>任务：</b>' + escapeHtml(jobLabel(d.job_code)) + '</p><p><b>计划时间：</b>' + fmtTime(d.scheduled_for) + '</p><p><b>业务执行结果：</b><br>' + escapeHtml(jobDisplayText(d.business_execution || d.result_summary || {}, 4000)) + '</p><p><b>数据新鲜度校验：</b>' + escapeHtml(freshness.status === 'passed' ? '通过' : freshness.status === 'not_required' ? '不需要水位校验' : freshness.status === 'degraded' ? '未达到目标日期' : '待校验') + '；数据日期 ' + escapeHtml(freshness.dataAsOf ? String(freshness.dataAsOf).slice(0, 10) : '-') + '；业务日期 ' + escapeHtml(freshness.businessDate || '-') + '</p><p><b>计划状态：</b>' + jobSlotStatusTag(d.status) + '</p><p><b>最近错误：</b>' + escapeHtml(jobDisplayText(d.last_error || '无', 1000)) + '</p><p><b>执行尝试：</b></p><ul>' + runs + '</ul><p><b>依赖：</b></p><ul>' + deps + '</ul><p><b>邮件告警：</b></p><ul>' + alerts + '</ul><p><b>人工审计：</b></p><ul>' + audits + '</ul></div>';
    openAdminModal('任务详情', html, '<button class="btn btn-outline" onclick="closeAdminModal()">关闭</button>');
  } catch (e) { showToast('网络错误'); }
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
  const btn = document.getElementById('holiday-btn-sync');
  if (btn) { btn.disabled = true; btn.textContent = '核对中...'; }
  try {
    const r = await fetch(api('/api/admin/jobs/holiday-sync'), { method: 'POST' });
    const d = await r.json();
    showToast(r.ok ? '休市日历已核对' : (d.error || '核对失败'));
  } catch (e) { showToast('网络错误'); }
  if (btn) { btn.disabled = false; btn.textContent = '从交易所核对本年休市日'; }
  renderHolidays();
}

// ====== 全局参数 ======
function renderSettings() {
  const el = document.getElementById('view-settings'); if (!el) return;
  el.innerHTML = '<div class="admin-placeholder"><div class="spinner" style="margin:0 auto 12px;"></div>加载中...</div>';
  fetch(api('/api/admin/settings')).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
    if (!s) { el.innerHTML = '<div class="admin-placeholder"><div class="icon">⚠️</div>加载失败</div>'; return; }
    renderSettingsTabs(el, s); return;
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
function renderSettingsTabs(el, s) {
  const o = s.register_open === '1' ? 'checked' : '', e = s.require_email === '1' ? 'checked' : '';
  const apiSettings = s.external_apis && s.external_apis.tushare || {};
  const apiPrimary = apiSettings.primary || {}, apiBackup = apiSettings.backup || {};
  const apiTests = apiSettings.test_results || {};
  const apiMode = ['auto', 'primary', 'backup'].indexOf(apiSettings.mode) >= 0 ? apiSettings.mode : 'auto';
  const apiSwitch = apiSettings.last_switch || null;
  const modeLabel = apiMode === 'primary' ? '主 Token' : apiMode === 'backup' ? '备用 Token' : '自动故障转移';
  const option = function (value, label) { return '<option value="' + value + '"' + (apiMode === value ? ' selected' : '') + '>' + label + '</option>'; };
  el.innerHTML = '<div class="filter-bar" style="margin-bottom:16px;border-bottom:1px solid #e8e8e8;padding-bottom:10px;">' +
    '<button class="btn btn-primary btn-sm settings-tab active" data-tab="site" onclick="switchSettingsTab(\'site\')">站点参数</button>' +
    '<button class="btn btn-outline btn-sm settings-tab" data-tab="market" onclick="switchSettingsTab(\'market\')">市场数据</button>' +
    '<button class="btn btn-outline btn-sm settings-tab" data-tab="models" onclick="switchSettingsTab(\'models\')">大模型配置</button>' +
    '<button class="btn btn-outline btn-sm settings-tab" data-tab="external-api" onclick="switchSettingsTab(\'external-api\')">外部 API 主备</button></div>' +
    '<div class="settings-panel" data-panel="site"><div style="font-size:13px;color:#666;margin-bottom:12px;">控制用户注册与邮箱验证；保存后即时生效。</div><div style="background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:24px 28px;max-width:560px;">' +
    '<div style="display:flex;align-items:center;gap:9px;margin-bottom:16px;"><input type="checkbox" id="set-register-open" ' + o + '><label for="set-register-open">开放注册</label></div>' +
    '<div style="margin-bottom:16px;"><div style="font-size:13px;color:#555;margin-bottom:6px;">邀请码</div><input id="set-register-code" value="' + escapeHtml(s.register_code || '') + '" placeholder="留空则无需邀请码" style="width:100%;padding:9px 12px;border:1px solid #d0d0d0;border-radius:6px;box-sizing:border-box;"></div>' +
    '<div style="display:flex;align-items:center;gap:9px;margin-bottom:20px;"><input type="checkbox" id="set-require-email" ' + e + '><label for="set-require-email">注册强制邮箱验证</label></div><button class="btn btn-primary" onclick="submitSettings()">保存站点参数</button></div></div>' +
    '<div class="settings-panel" data-panel="market" hidden><div style="font-size:13px;color:#666;margin-bottom:12px;">港股格雷厄姆指数使用美国十年期国债收益率作为代理，数据由 Tushare us_tycr.y10 定时自动同步。</div><div style="background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:20px;max-width:680px;">无需手工上传，市场波动任务每日自动更新。</div></div>' +
    '<div class="settings-panel" data-panel="models" hidden><div style="font-size:13px;color:#666;margin-bottom:12px;">配置图片和 Excel 识别使用的大模型。模型按顺序调用，排在最前的是默认模型；前一个不可用时会自动切换。</div><div id="settings-models"></div></div>' +
    '<div class="settings-panel" data-panel="external-api" hidden><div style="font-size:13px;color:#666;margin-bottom:12px;">统一管理外部数据 API 的主备凭据。凭据加密保存在服务端，页面只显示掩码；留空表示保留原值。</div><div style="background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:20px;max-width:700px;">' +
    '<div style="font-size:17px;font-weight:600;color:#222;margin-bottom:16px;">' + escapeHtml(apiSettings.label || 'Tushare Pro') + '</div>' +
    '<div style="display:grid;grid-template-columns:120px 1fr;gap:12px 14px;align-items:center;">' +
    '<label for="set-tushare-primary">主 Token</label><div><input id="set-tushare-primary" type="password" autocomplete="new-password" placeholder="' + (apiPrimary.configured ? '当前已配置：' + escapeHtml(apiPrimary.masked || '已配置') : '尚未配置') + '" style="width:100%;padding:9px 12px;border:1px solid #d0d0d0;border-radius:6px;box-sizing:border-box;"></div>' +
    '<label for="set-tushare-backup">备用 Token</label><div><input id="set-tushare-backup" type="password" autocomplete="new-password" placeholder="' + (apiBackup.configured ? '当前已配置：' + escapeHtml(apiBackup.masked || '已配置') : '尚未配置') + '" style="width:100%;padding:9px 12px;border:1px solid #d0d0d0;border-radius:6px;box-sizing:border-box;"></div>' +
    '<label for="set-tushare-mode">运行模式</label><select id="set-tushare-mode" style="padding:9px 12px;border:1px solid #d0d0d0;border-radius:6px;box-sizing:border-box;max-width:260px;">' + option('auto', '自动故障转移') + option('primary', '固定使用主 Token') + option('backup', '固定使用备用 Token') + '</select>' +
    '<label>切换通知</label><label style="display:flex;align-items:center;gap:8px;"><input id="set-tushare-notify" type="checkbox" ' + (apiSettings.notify_on_switch !== false ? 'checked' : '') + '>主备切换时发送后台告警</label></div>' +
    '<div style="font-size:12px;color:#777;margin-top:16px;">当前模式：' + modeLabel + (apiSwitch ? '；最近切换：' + escapeHtml(apiSwitch.switched_at || '') + '（' + escapeHtml(apiSwitch.reason || '') + '）' : '') + '</div>' +
    '<div style="display:flex;gap:10px;margin-top:18px;"><button class="btn btn-primary" onclick="saveExternalApiSettings()">保存 API 参数</button><button class="btn btn-outline" onclick="switchExternalApiMode(\'tushare\')">手动应用当前模式</button></div>' +
     '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #eee;"><div style="font-size:14px;font-weight:600;color:#222;margin-bottom:6px;">API 可用性测试</div><div style="font-size:12px;color:#777;margin-bottom:10px;">请选择接口后测试指定 Token；不会自动切换主备。rt_min 返回空行也表示接口已被接受，不能用 trade_cal 代替权限验证。</div>' +
     '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;"><label for="set-tushare-test-api" style="font-size:12px;color:#555;">测试接口</label><select id="set-tushare-test-api" style="padding:7px 10px;border:1px solid #d0d0d0;border-radius:6px;"><option value="trade_cal">trade_cal（基础）</option><option value="rt_min">rt_min（实时分钟）</option><option value="new_share">new_share（新股）</option><option value="cb_daily">cb_daily（转债日线）</option></select></div>' +
     '<div style="display:flex;gap:8px;flex-wrap:wrap;"><button id="test-tushare-primary" class="btn btn-outline btn-sm" onclick="testExternalApiAvailability(\'tushare\',\'primary\')">测试主 API</button><button id="test-tushare-backup" class="btn btn-outline btn-sm" onclick="testExternalApiAvailability(\'tushare\',\'backup\')">测试备用 API</button><button id="test-tushare-current" class="btn btn-outline btn-sm" onclick="testExternalApiAvailability(\'tushare\',\'current\')">测试当前 API</button></div>' +
     '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;">' + renderExternalApiTestResult(getLatestExternalApiTest(apiTests, 'primary'), '主 Token') + renderExternalApiTestResult(getLatestExternalApiTest(apiTests, 'backup'), '备用 Token') + '</div>' + renderExternalApiCircuits(apiSettings.circuits) + '</div></div></div>';
  switchSettingsTab(settingsTab);
}
function renderExternalApiTestResult(result, label) {
  if (!result) return '<div style="padding:9px 10px;background:#f7f7f7;border-radius:6px;color:#888;font-size:12px;">' + label + '：未测试</div>';
  const status = result.status === 'available' ? '可用' : result.status === 'not_configured' ? '未配置' : '不可用';
  const color = result.ok ? '#16803c' : '#c62828';
  const latency = result.latency_ms == null ? '' : ' · ' + Number(result.latency_ms) + ' ms';
   return '<div style="padding:9px 10px;background:#f7f7f7;border-radius:6px;font-size:12px;"><div style="color:#555;">' + label + ' · ' + escapeHtml(result.api_name || '未知接口') + '：<span style="font-weight:600;color:' + color + ';">' + status + '</span>' + latency + '</div><div style="color:#888;margin-top:4px;word-break:break-all;">' + escapeHtml(result.message || '') + (result.checked_at ? ' · ' + escapeHtml(result.checked_at) : '') + '</div>' + renderExternalApiReturnedData(result.returned_data) + '</div>';
 }
function getLatestExternalApiTest(tests, role) {
  if (!tests) return null;
  if (tests[role] && tests[role].api_name) return tests[role];
  const values = Object.keys(tests).filter(function (key) { return key.indexOf(role + ':') === 0; }).map(function (key) { return tests[key]; }).filter(Boolean);
  values.sort(function (a, b) { return String(b.checked_at || '').localeCompare(String(a.checked_at || '')); });
  return values[0] || null;
}
function renderExternalApiCircuits(circuits) {
  if (!Array.isArray(circuits) || !circuits.length) return '<div style="margin-top:12px;color:#888;font-size:12px;">当前没有接口熔断。</div>';
  let html = '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #eee;"><div style="font-size:13px;font-weight:600;color:#555;margin-bottom:6px;">当前接口熔断</div>';
  circuits.forEach(function (item) {
    const role = item.source_role === 'primary' ? '主Token' : item.source_role === 'backup' ? '备用Token' : item.source_role;
    const recovery = item.recover_at ? new Date(item.recover_at).toLocaleString('zh-CN', { hour12: false }) : 'Token 配置变化后再测';
    html += '<div style="padding:8px 10px;background:#fff8e1;border-radius:6px;margin-top:6px;font-size:12px;color:#6d4c00;">' + escapeHtml(item.api_name || '*') + '：' + escapeHtml(role) + '熔断；原因：' + escapeHtml(item.detail || item.error_code || '上游错误') + '；预计恢复：' + escapeHtml(recovery) + '</div>';
  });
  return html + '</div>';
}
function renderExternalApiReturnedData(data) {
  if (!data || !Array.isArray(data.fields)) return '';
  const fields = data.fields.slice(0, 20), rows = Array.isArray(data.items) ? data.items.slice(0, 5) : [];
  let html = '<div style="margin-top:8px;color:#555;">API 返回数据：</div>';
  if (!fields.length) return html + '<div style="color:#888;margin-top:3px;">0 个字段，0 行</div>';
  html += '<div class="biz-table-scroll" style="margin-top:4px;"><table class="biz-table biz-table--preview"><thead><tr>';
  fields.forEach(function (field) { html += '<th>' + escapeHtml(field) + '</th>'; });
  html += '</tr></thead><tbody>';
  rows.forEach(function (row) {
    html += '<tr>';
    fields.forEach(function (field, index) { const value = !row || row[index] == null ? '-' : row[index]; html += '<td>' + escapeHtml(String(value)) + '</td>'; });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  if (!rows.length) html += '<div style="color:#888;margin-top:3px;">0 行</div>';
  if (data.truncated) html += '<div style="color:#888;margin-top:3px;">仅展示前 5 行</div>';
  return html;
}
function switchSettingsTab(tab) {
  settingsTab = tab;
  document.querySelectorAll('.settings-tab').forEach(function (button) { const active = button.dataset.tab === tab; button.classList.toggle('btn-primary', active); button.classList.toggle('btn-outline', !active); });
  document.querySelectorAll('.settings-panel').forEach(function (panel) { panel.hidden = panel.dataset.panel !== tab; });
  if (tab === 'models') { const target = document.getElementById('settings-models'); if (target && !target.dataset.loaded) { target.dataset.loaded = '1'; renderAimodels(target); } }
}
async function saveExternalApiSettings() {
  const body = { external_api: { provider: 'tushare', primary_token: document.getElementById('set-tushare-primary').value || '', backup_token: document.getElementById('set-tushare-backup').value || '', mode: document.getElementById('set-tushare-mode').value, notify_on_switch: document.getElementById('set-tushare-notify').checked } };
  try {
    const r = await fetch(api('/api/admin/settings'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '保存失败'); return; }
    showToast('外部 API 参数已保存');
    renderSettings();
  } catch (e) { showToast('网络错误'); }
}
async function switchExternalApiMode(provider) {
  const mode = document.getElementById('set-tushare-mode').value;
  try {
    const r = await fetch(api('/api/admin/settings/external-api/' + encodeURIComponent(provider) + '/switch'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: mode }) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '切换失败'); return; }
    showToast('已手动应用' + (mode === 'auto' ? '自动故障转移' : mode === 'primary' ? '主 Token' : '备用 Token'));
    renderSettings();
  } catch (e) { showToast('网络错误'); }
}
async function testExternalApiAvailability(provider, role) {
  const button = document.getElementById('test-' + provider + '-' + role);
  const originalText = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '测试中...'; }
  const label = role === 'primary' ? '主' : role === 'backup' ? '备用' : '当前';
  const apiName = (document.getElementById('set-tushare-test-api') || {}).value || 'trade_cal';
  try {
    const r = await fetch(api('/api/admin/settings/external-api/' + encodeURIComponent(provider) + '/test'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: role, api_name: apiName }) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '测试失败'); if (button) { button.disabled = false; button.textContent = originalText; } return; }
    showToast((d.result && d.result.ok ? label + ' API 可用' : label + ' API 不可用：' + ((d.result && d.result.message) || '请检查配置')));
    renderSettings();
  } catch (e) { showToast('网络错误'); }
  if (button) { button.disabled = false; button.textContent = originalText; }
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
       '<button class="btn btn-info btn-sm" id="holiday-btn-sync" onclick="runJobHolidaySync()">从交易所核对本年休市日</button>' +
       '<button class="btn btn-outline btn-sm" onclick="renderHolidays()">刷新</button>' +
       '</div>' +
       '<div style="font-size:12px;color:#888;background:#f6f8fa;padding:8px 10px;border-radius:6px;margin-bottom:12px;">休市日（法定节假日，不含周末）影响收盘数据抓取与交易日判断；修改即时生效，无需部署。可点击「从交易所核对本年休市日」立即同步，也可<b>点击日历格手动增删</b>：橙色=休市日（点它移除），空白格（点它添加），灰色=周末。</div>' +
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
const AUDIT_MODULE_LABELS = {
  user: '用户权限', broker: '券商', job: '人工任务', holiday: '休市日历',
  model: '大模型', settings: '全局参数', knowledge: '知识分享', bond: '可转债',
  market: '行情指标', benchmark: '标杆发布'
};
function renderAudit() {
  const el = document.getElementById('view-audit'); if (!el) return;
  el.innerHTML =
    '<div class="filter-bar">' +
      '<select id="audit-filter-module" style="padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"><option value="">全部模块</option></select>' +
      '<input id="audit-filter-actor" placeholder="操作人" style="width:140px;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;" />' +
      '<select id="audit-filter-result" style="padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"><option value="">全部结果</option><option value="success">成功</option><option value="failure">失败</option></select>' +
      '<button class="btn btn-outline btn-sm" onclick="loadAuditData()">查询</button>' +
      '<button class="btn btn-ghost btn-sm" style="margin-left:auto;" onclick="loadAuditData()">刷新</button>' +
    '</div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>结果</th><th>详情</th></tr></thead>' +
    '<tbody id="audit-tbody"><tr><td colspan="6" class="biz-table-state-cell">加载中...</td></tr></tbody></table></div>';
  loadAuditData();
}
async function loadAuditData() {
  const tb = document.getElementById('audit-tbody'); if (!tb) return;
  const moduleSel = document.getElementById('audit-filter-module');
  const actorInp = document.getElementById('audit-filter-actor');
  const resultSel = document.getElementById('audit-filter-result');
  const m = moduleSel ? moduleSel.value : '';
  const a = actorInp ? actorInp.value.trim() : '';
  const r = resultSel ? resultSel.value : '';
  const qs = 'limit=100' + (m ? '&module=' + encodeURIComponent(m) : '') + (a ? '&actor=' + encodeURIComponent(a) : '') + (r ? '&result=' + encodeURIComponent(r) : '');
  try {
    const resp = await fetch(api('/api/admin/audit?' + qs));
    if (!resp.ok) { tb.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">加载失败</td></tr>'; return; }
    const d = await resp.json();
    if (moduleSel && d.modules) {
      d.modules.forEach(function (k) {
        if (!moduleSel.querySelector('option[value="' + k + '"]')) {
          const o = document.createElement('option'); o.value = k; o.textContent = AUDIT_MODULE_LABELS[k] || k; moduleSel.appendChild(o);
        }
      });
    }
    if (!d.list.length) { tb.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell">暂无操作记录</td></tr>'; return; }
    tb.innerHTML = d.list.map(function (x) {
      const isFail = x.result === 'failure';
      const rc = isFail ? 'tag-over' : 'tag-ok';
      const rt = isFail ? '失败' : '成功';
      return '<tr><td>' + escapeHtml(x.created_at || '') + '</td><td>' + escapeHtml(x.actor || '') + '</td><td><span class="tag">' + escapeHtml(x.action || '') + '</span></td><td>' + escapeHtml(x.target || '') + '</td><td><span class="tag ' + rc + '">' + rt + '</span></td><td class="biz-table-note-cell biz-table-note-cell--360 biz-table-break-all">' + escapeHtml(x.detail || '') + '</td></tr>';
    }).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">网络错误</td></tr>'; }
}

// ====== 数据运维（OPS-01：共享数据刷新/导入统一迁入后台，前台按钮已移除）======
function renderOps() {
  const el = document.getElementById('view-ops'); if (!el) return;
  el.innerHTML =
    '<div class="ops-grid">' +
      opsCard('可转债安全性刷新', '手动触发全部可转债安全评分快照刷新（每日 06:30 自动跑，此处用于立即生效或补救）。',
        '<button class="btn btn-primary" id="ops-bond-safety-refresh" onclick="opsRefreshBondSafety()">立即刷新</button>') +
      opsCard('可转债估值刷新', '手动触发估值与预警模型重算（每日行情同步完成后自动跑）。',
        '<button class="btn btn-primary" id="ops-bond-valuation-refresh" onclick="opsRefreshBondValuation()">立即刷新</button>') +
      opsCard('美国十年期国债收益率', '由 Tushare us_tycr.y10 自动同步，并用于港股格雷厄姆指数计算。',
        '<span style="color:#55705d;">定时任务自动更新，无需手工导入</span>') +
    '</div>' +
    '<div class="ops-jobs"><div class="ops-jobs-head"><span>最近任务状态</span><button class="btn btn-outline btn-sm" onclick="opsLoadJobs()">刷新</button></div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr><th>任务</th><th>状态</th><th>开始</th><th>结束</th><th>结果</th></tr></thead>' +
    '<tbody id="ops-jobs-tbody"><tr><td colspan="5" class="biz-table-state-cell">加载中...</td></tr></tbody></table></div></div>';
  opsLoadJobs();
}
function opsCard(title, desc, actionHtml) {
  return '<div class="ops-card"><div class="ops-card-title">' + title + '</div><div class="ops-card-desc">' + desc + '</div><div class="ops-card-action">' + actionHtml + '</div></div>';
}
async function opsRefreshBondSafety() {
  const btn = document.getElementById('ops-bond-safety-refresh'); if (btn) { btn.disabled = true; btn.textContent = '刷新中...'; }
  try {
    const r = await fetch(api('/api/bond-safety/refresh'), { method: 'POST' });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) showToast(d.error || '刷新失败');
    else showToast('可转债安全性数据已刷新');
  } catch (e) { showToast('网络错误'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '立即刷新'; } opsLoadJobs(); }
}
async function opsRefreshBondValuation() {
  const btn = document.getElementById('ops-bond-valuation-refresh'); if (btn) { btn.disabled = true; btn.textContent = '刷新中...'; }
  try {
    const r = await fetch(api('/api/bond-valuation/refresh'), { method: 'POST' });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) showToast(d.error || '刷新失败');
    else showToast('可转债估值已刷新');
  } catch (e) { showToast('网络错误'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '立即刷新'; } opsLoadJobs(); }
}
async function opsImportFederalFunds() {
  const fileEl = document.getElementById('ops-fed-file');
  const btn = document.getElementById('ops-fed-import');
  if (!fileEl || !fileEl.files || !fileEl.files.length) { showToast('请先选择利率文件'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '导入中...'; }
  try {
    const fd = new FormData();
    fd.append('file', fileEl.files[0]);
    const r = await fetch(api('/api/market-volatility/federal-funds/import'), { method: 'POST', body: fd });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) showToast(d.error || '导入失败');
    else showToast('已导入 ' + (d.imported || 0) + ' 条利率数据');
  } catch (e) { showToast('网络错误'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '导入文件'; } opsLoadJobs(); }
}
async function opsLoadJobs() {
  const tb = document.getElementById('ops-jobs-tbody'); if (!tb) return;
  try {
    const r = await fetch(api('/api/admin/jobs?limit=20'));
    if (!r.ok) { tb.innerHTML = '<tr><td colspan="5" class="biz-table-state-cell biz-table-error">加载失败</td></tr>'; return; }
    const list = (await r.json()).list || [];
    if (!list.length) { tb.innerHTML = '<tr><td colspan="5" class="biz-table-state-cell">暂无任务记录</td></tr>'; return; }
    tb.innerHTML = list.map(function (j) {
      const st = j.status === 'done' ? '<span class="tag tag-ok">成功</span>' : (j.status === 'failed' ? '<span class="tag tag-over">失败</span>' : (j.status === 'running' ? '<span class="tag tag-a">运行中</span>' : '<span class="tag">' + escapeHtml(j.status || '—') + '</span>'));
      return '<tr><td>' + escapeHtml(jobLabel(j.job)) + '</td><td>' + st + '</td><td>' + fmtTime(j.started_at) + '</td><td>' + fmtTime(j.finished_at) + '</td><td class="biz-table-note-cell biz-table-note-cell--320 biz-table-break-all">' + escapeHtml(jobDisplayText(j.detail || '', 500)) + '</td></tr>';
    }).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="5" class="biz-table-state-cell biz-table-error">网络错误</td></tr>'; }
}

// ====== 大模型配置 ======
function renderAimodels(target) {
  const el = target || document.getElementById('settings-models'); if (!el) return;
  el.innerHTML =
    '<div style="font-size:12px;color:#888;background:#f6f8fa;padding:8px 10px;border-radius:6px;margin-bottom:12px;">图片/Excel 识别会按顺序依次调用已启用的模型：排在最前的是<b>默认模型</b>，上一个失效自动切换到下一个（用户无感知）。状态灯反映后台最近一次真实调用的结果。</div>' +
    '<div class="filter-bar">' +
      '<button class="btn btn-outline btn-sm" onclick="loadAimodelsData()">刷新</button>' +
      '<button class="btn btn-success btn-sm" style="margin-left:auto;" onclick="openModelForm()">+ 新增模型</button>' +
    '</div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table">' +
      '<thead><tr><th>名称</th><th>模型名</th><th>API 地址</th><th>API Key</th><th>状态</th><th>操作</th></tr></thead>' +
      '<tbody id="aimodels-tbody"><tr><td colspan="6" class="biz-table-state-cell">加载中...</td></tr></tbody>' +
    '</table></div>';
  const tb = document.getElementById('aimodels-tbody');
  if (tb) tb.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]'); if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === 'edit') openModelForm(id);
    else if (action === 'del') deleteModelConfirm(id);
    else if (action === 'test') testModel(id, btn);
    else if (action === 'default') setDefaultModel(id);
    else if (action === 'up') moveModel(id, 'up');
    else if (action === 'down') moveModel(id, 'down');
  });
  loadAimodelsData();
}

function aimodelStatusHtml(st) {
  if (!st) return '<span class="tag">未调用</span>';
  const dot = st.ok ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#2e7d32;margin-right:6px;"></span>' : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d93025;margin-right:6px;"></span>';
  const time = st.at ? new Date(st.at).toLocaleString('zh-CN', { hour12: false }) : '';
  const detail = st.ok ? ('耗时 ' + (st.ms || 0) + 'ms') : ('失败：' + escapeHtml((st.error || '').slice(0, 40)));
  return '<div style="font-size:12px;line-height:1.5;">' + dot + (st.ok ? '正常' : '异常') + '<div style="color:#999;">' + time + ' · ' + detail + '</div></div>';
}

async function loadAimodelsData() {
  const tb = document.getElementById('aimodels-tbody'); if (!tb) return;
  try {
    const r = await fetch(api('/api/admin/models'));
    if (!r.ok) { tb.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">加载失败</td></tr>'; return; }
    const d = await r.json();
    const list = d.list || [];
    if (!list.length) { tb.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell">暂无模型，点击右上角「新增模型」</td></tr>'; return; }
    const minOrder = Math.min.apply(null, list.map(function (m) { return m.order || 0; }));
    tb.innerHTML = list.map(function (m) {
      const isDefault = (m.order || 0) === minOrder;
      const defTag = isDefault ? '<span class="tag tag-a">默认</span> ' : '';
      const enTag = m.enabled ? '<span class="tag tag-ok">启用</span>' : '<span class="tag tag-over">停用</span>';
      return '<tr>' +
        '<td>' + defTag + escapeHtml(m.name) + '</td>' +
        '<td>' + escapeHtml(m.model) + '</td>' +
        '<td class="biz-table-note-cell biz-table-note-cell--240 biz-table-break-all">' + escapeHtml(m.apiUrl) + '</td>' +
        '<td class="biz-table-mono-cell">' + escapeHtml(m.apiKey || '') + '</td>' +
        '<td>' + enTag + '<div style="margin-top:4px;">' + aimodelStatusHtml(m.status) + '</div></td>' +
        '<td class="biz-table-nowrap">' +
          '<button class="btn btn-sm btn-info" data-action="test" data-id="' + escapeHtml(m.id) + '">测试</button> ' +
          '<button class="btn btn-sm btn-outline" data-action="edit" data-id="' + escapeHtml(m.id) + '">编辑</button> ' +
          (isDefault ? '' : '<button class="btn btn-sm btn-ghost" data-action="default" data-id="' + escapeHtml(m.id) + '">设默认</button> ') +
          (isDefault ? '' : '<button class="btn btn-sm btn-ghost" data-action="up" data-id="' + escapeHtml(m.id) + '" title="上移">↑</button> ') +
          '<button class="btn btn-sm btn-ghost" data-action="down" data-id="' + escapeHtml(m.id) + '" title="下移">↓</button> ' +
          '<button class="btn btn-sm btn-danger" data-action="del" data-id="' + escapeHtml(m.id) + '">删除</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="6" class="biz-table-state-cell biz-table-error">网络错误，请重试</td></tr>'; }
}

// 在全部模型里找出指定 id 的记录（含打码 Key，用于编辑回显；后端遇打码串保留原值）
function findModel(list, id) {
  return (list || []).find(function (m) { return m.id === id; }) || null;
}

function openModelForm(id) {
  const isEdit = !!id;
  let body = '<input type="hidden" id="model-id" value="' + (isEdit ? escapeHtml(id) : '') + '">' +
    '<div class="form-group"><label>名称（便于区分，如「默认模型」）</label><input id="model-name" placeholder="如 默认模型" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>' +
    '<div class="form-group"><label>模型名（如 agnes-2.0-flash）</label><input id="model-model" placeholder="如 agnes-2.0-flash" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>' +
    '<div class="form-group"><label>API 地址（必须是 HTTPS，如 https://apihub.agnes-ai.com/v1/chat/completions）</label><input id="model-url" placeholder="https://..." style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>' +
    '<div class="form-group"><label>API Key' + (isEdit ? '（留空或显示打码串表示不修改）' : '') + '</label><input id="model-key" type="password" autocomplete="new-password" placeholder="粘贴 API Key" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;"></div>' +
    '<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#555;"><input type="checkbox" id="model-enabled" checked> 启用（参与识别兜底）</label>';
  openAdminModal(isEdit ? '编辑模型' : '新增模型', body,
    '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button>' +
    '<button class="btn btn-primary" onclick="submitModel()">保存</button>'
  );
  if (isEdit) {
    fetch(api('/api/admin/models')).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      const m = findModel(d && d.list, id); if (!m) return;
      const n = document.getElementById('model-name'); if (n) n.value = m.name || '';
      const md = document.getElementById('model-model'); if (md) md.value = m.model || '';
      const u = document.getElementById('model-url'); if (u) u.value = m.apiUrl || '';
      const k = document.getElementById('model-key'); if (k) k.value = m.apiKey || ''; // 打码串回显，留空即不修改
      const en = document.getElementById('model-enabled'); if (en) en.checked = m.enabled !== false;
    }).catch(function () {});
  }
}

async function submitModel() {
  const id = document.getElementById('model-id').value;
  const isEdit = !!id;
  const name = (document.getElementById('model-name').value || '').trim();
  const model = (document.getElementById('model-model').value || '').trim();
  const apiUrl = (document.getElementById('model-url').value || '').trim();
  const apiKey = (document.getElementById('model-key').value || '').trim();
  const enabled = document.getElementById('model-enabled').checked;
  if (!name || !model || !apiUrl) { showToast('名称、模型名、API 地址均必填'); return; }
  if (!isEdit && !apiKey) { showToast('新增时 API Key 必填'); return; }
  const url = isEdit ? '/api/admin/models/' + encodeURIComponent(id) : '/api/admin/models';
  const method = isEdit ? 'PUT' : 'POST';
  const body = { name: name, model: model, apiUrl: apiUrl, apiKey: apiKey, enabled: enabled };
  try {
    const r = await fetch(api(url), { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '保存失败'); return; }
    showToast('已保存'); closeAdminModal(); loadAimodelsData();
  } catch (e) { showToast('网络错误'); }
}

function deleteModelConfirm(id) {
  openAdminModal('删除模型', '<p style="font-size:14px;color:#666;line-height:1.6;">确定删除该模型吗？删除后它将不参与识别兜底。</p>',
    '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button>' +
    '<button class="btn btn-danger" onclick="doDeleteModel(\'' + escapeHtml(id) + '\')">确认删除</button>'
  );
}
async function doDeleteModel(id) {
  try {
    const r = await fetch(api('/api/admin/models/' + encodeURIComponent(id)), { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '删除失败'); return; }
    showToast('已删除'); closeAdminModal(); loadAimodelsData();
  } catch (e) { showToast('网络错误'); }
}

async function testModel(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '测试中...'; }
  try {
    const r = await fetch(api('/api/admin/models/' + encodeURIComponent(id) + '/test'), { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '测试失败'); }
    else if (d.ok) { showToast('测试成功（耗时 ' + (d.ms || 0) + 'ms）'); }
    else { showToast('测试失败：' + (d.error || '未知错误')); }
  } catch (e) { showToast('网络错误'); }
  if (btn) { btn.disabled = false; btn.textContent = '测试'; }
  loadAimodelsData();
}

async function setDefaultModel(id) {
  try {
    const r = await fetch(api('/api/admin/models/' + encodeURIComponent(id) + '/default'), { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '操作失败'); return; }
    showToast('已设为默认模型'); loadAimodelsData();
  } catch (e) { showToast('网络错误'); }
}

async function moveModel(id, dir) {
  try {
    const r = await fetch(api('/api/admin/models/' + encodeURIComponent(id) + '/move'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: dir }) });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '操作失败'); return; }
    loadAimodelsData();
  } catch (e) { showToast('网络错误'); }
}

// ====== 知识分享管理 ======
let ksAdminTab = 'articles';
let ksAdminCommentFilter = '';

function renderKnowledge() {
  const el = document.getElementById('view-knowledge');
  if (!el) return;
  el.innerHTML =
    '<div class="ks-admin-tabs">' +
      '<button class="ks-admin-tab ' + (ksAdminTab === 'articles' ? 'active' : '') + '" data-tab="articles">文章管理</button>' +
      '<button class="ks-admin-tab ' + (ksAdminTab === 'comments' ? 'active' : '') + '" data-tab="comments">评论管理</button>' +
      '<button class="ks-admin-tab ' + (ksAdminTab === 'permissions' ? 'active' : '') + '" data-tab="permissions">写权限管理</button>' +
    '</div>' +
    '<div id="ks-admin-body"></div>';
  el.querySelectorAll('.ks-admin-tab').forEach(function (b) {
    b.addEventListener('click', function () { ksAdminTab = b.dataset.tab; renderKnowledge(); });
  });
  if (ksAdminTab === 'articles') ksRenderKsArticles();
  else if (ksAdminTab === 'comments') ksRenderKsComments();
  else ksRenderKsPermissions();
}

async function ksRenderKsArticles() {
  const body = document.getElementById('ks-admin-body');
  if (!body) return;
  let html = '<div class="filter-bar">' +
    '<select id="ks-ad-status" style="padding:5px 9px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;">' +
      '<option value="">全部状态</option><option value="published">已发布</option><option value="draft">草稿</option></select>' +
    '<button class="btn btn-primary btn-sm" id="ks-ad-search">筛选</button>' +
    '<span class="ks-ad-count" id="ks-ad-count"></span></div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr><th>ID</th><th>标题</th><th>分类</th><th>状态</th><th>作者</th><th>阅读</th><th>发布时间</th><th>操作</th></tr></thead>' +
    '<tbody id="ks-ad-tbody"><tr><td colspan="8" class="biz-table-state-cell">加载中...</td></tr></tbody></table></div>';
  body.innerHTML = html;
  document.getElementById('ks-ad-search').addEventListener('click', function () {
    ksLoadKsArticles(document.getElementById('ks-ad-status').value);
  });
  ksLoadKsArticles('');
}

async function ksLoadKsArticles(status) {
  const tbody = document.getElementById('ks-ad-tbody');
  const count = document.getElementById('ks-ad-count');
  try {
    const r = await fetch(api('/api/admin/knowledge/articles?limit=50' + (status ? '&status=' + status : '')));
    const d = await r.json();
    if (count) count.textContent = '共 ' + d.total + ' 篇';
  if (!d.list.length) { tbody.innerHTML = '<tr><td colspan="8" class="biz-table-state-cell">暂无文章</td></tr>'; return; }
    tbody.innerHTML = d.list.map(function (a) {
      const created = (a.published_at || a.updated_at || '').toString().replace('T', ' ').slice(0, 19);
      const statusTag = a.status === 'draft' ? '<span class="tag tag-over">草稿</span>' : '<span class="tag tag-ok">已发布</span>';
      return '<tr>' +
        '<td>' + a.id + '</td>' +
        '<td>' + escapeHtml(a.title || '无标题') + '</td>' +
        '<td>' + escapeHtml(a.category_name || '未分类') + '</td>' +
        '<td>' + statusTag + '</td>' +
        '<td>' + escapeHtml(a.author_username || '') + '</td>' +
        '<td>' + (a.view_count || 0) + '</td>' +
        '<td>' + created + '</td>' +
        '<td class="biz-table-nowrap">' +
          '<button class="btn btn-sm ' + (a.status === 'draft' ? 'btn-success' : 'btn-warning') + '" data-act="status" data-id="' + a.id + '" data-cur="' + a.status + '">' + (a.status === 'draft' ? '发布' : '撤回') + '</button> ' +
          '<button class="btn btn-sm btn-danger" data-act="del" data-id="' + a.id + '">删除</button>' +
        '</td></tr>';
    }).join('');
    tbody.querySelectorAll('button[data-act]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const id = btn.dataset.id, act = btn.dataset.act;
        if (act === 'del') {
          if (!await projectConfirm('确定删除这篇文章？', { title: '删除文章', confirmText: '删除', danger: true })) return;
          await fetch(api('/api/admin/knowledge/articles/' + id), { method: 'DELETE' });
          showToast('已删除'); ksLoadKsArticles(document.getElementById('ks-ad-status').value);
        } else if (act === 'status') {
          const next = btn.dataset.cur === 'draft' ? 'published' : 'draft';
          await fetch(api('/api/admin/knowledge/articles/' + id + '/status'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
          showToast(next === 'published' ? '已发布' : '已撤回'); ksLoadKsArticles(document.getElementById('ks-ad-status').value);
        }
      });
    });
  } catch (e) { tbody.innerHTML = '<tr><td colspan="8" class="biz-table-state-cell biz-table-error">加载失败</td></tr>'; }
}

async function ksRenderKsComments() {
  const body = document.getElementById('ks-admin-body');
  if (!body) return;
  body.innerHTML = '<div class="filter-bar">' +
    '<input id="ks-cm-article" placeholder="按文章ID筛选（可选）" style="padding:5px 9px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;width:160px;">' +
    '<button class="btn btn-primary btn-sm" id="ks-cm-search">筛选</button>' +
    '<span class="ks-ad-count" id="ks-cm-count"></span></div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr><th>ID</th><th>文章</th><th>评论人</th><th>内容</th><th>回复对象</th><th>时间</th><th>操作</th></tr></thead>' +
    '<tbody id="ks-cm-tbody"><tr><td colspan="7" class="biz-table-state-cell">加载中...</td></tr></tbody></table></div>';
  document.getElementById('ks-cm-search').addEventListener('click', function () {
    ksLoadKsComments(document.getElementById('ks-cm-article').value.trim());
  });
  ksLoadKsComments('');
}

async function ksLoadKsComments(articleId) {
  const tbody = document.getElementById('ks-cm-tbody');
  const count = document.getElementById('ks-cm-count');
  try {
    const r = await fetch(api('/api/admin/knowledge/comments?limit=50' + (articleId ? '&article_id=' + articleId : '')));
    const d = await r.json();
    if (count) count.textContent = '共 ' + d.total + ' 条';
  if (!d.list.length) { tbody.innerHTML = '<tr><td colspan="7" class="biz-table-state-cell">暂无评论</td></tr>'; return; }
    tbody.innerHTML = d.list.map(function (c) {
      const t = (c.created_at || '').toString().replace('T', ' ').slice(0, 19);
      const reply = c.parent_id ? ('#' + c.parent_id) : '—';
      return '<tr>' +
        '<td>' + c.id + '</td>' +
        '<td>' + escapeHtml(c.article_title || ('#' + c.article_id)) + '</td>' +
        '<td>' + escapeHtml(c.nickname) + '</td>' +
        '<td class="biz-table-note-cell biz-table-note-cell--360">' + escapeHtml(c.content) + '</td>' +
        '<td>' + reply + '</td>' +
        '<td>' + t + '</td>' +
        '<td><button class="btn btn-sm btn-danger" data-id="' + c.id + '">删除</button></td></tr>';
    }).join('');
    tbody.querySelectorAll('button[data-id]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!await projectConfirm('确定删除这条评论？', { title: '删除评论', confirmText: '删除', danger: true })) return;
        await fetch(api('/api/admin/knowledge/comments/' + btn.dataset.id), { method: 'DELETE' });
        showToast('已删除'); ksLoadKsComments(document.getElementById('ks-cm-article').value.trim());
      });
    });
  } catch (e) { tbody.innerHTML = '<tr><td colspan="7" class="biz-table-state-cell biz-table-error">加载失败</td></tr>'; }
}

async function ksRenderKsPermissions() {
  const body = document.getElementById('ks-admin-body');
  if (!body) return;
  body.innerHTML = '<div class="filter-bar">' +
    '<input id="ks-per-search" placeholder="搜索账号" style="padding:5px 9px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;width:180px;">' +
    '<button class="btn btn-primary btn-sm" id="ks-per-go">搜索</button>' +
    '<span class="ks-ad-count">管理员默认拥有写权限</span></div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>投资笔记写权限</th><th>操作</th></tr></thead>' +
    '<tbody id="ks-per-tbody"><tr><td colspan="5" class="biz-table-state-cell">加载中...</td></tr></tbody></table></div>';
  document.getElementById('ks-per-go').addEventListener('click', function () {
    ksLoadKsPermissions(document.getElementById('ks-per-search').value.trim());
  });
  ksLoadKsPermissions('');
}

async function ksLoadKsPermissions(search) {
  const tbody = document.getElementById('ks-per-tbody');
  try {
    const r = await fetch(api('/api/admin/knowledge/users' + (search ? '?search=' + encodeURIComponent(search) : '')));
    const d = await r.json();
  if (!d.list.length) { tbody.innerHTML = '<tr><td colspan="5" class="biz-table-state-cell">暂无用户</td></tr>'; return; }
    tbody.innerHTML = d.list.map(function (u) {
      const isAdmin = u.role === 'admin';
      const enabled = isAdmin || u.knowledge_enabled;
      const roleTag = isAdmin ? '<span class="tag tag-a">管理员</span>' : '<span class="tag">普通用户</span>';
      const statusTag = (u.status && u.status !== 'active') ? '<span class="tag tag-over">已禁用</span>' : '<span class="tag tag-ok">正常</span>';
      const permTag = enabled ? '<span class="tag tag-ok">可写</span>' : '<span class="tag tag-over">不可写</span>';
      const toggleBtn = isAdmin
        ? '<button class="btn btn-sm btn-outline" disabled>管理员默认开启</button>'
        : '<button class="btn btn-sm ' + (enabled ? 'btn-warning' : 'btn-success') + '" data-act="toggle" data-username="' + escapeHtml(u.username) + '" data-cur="' + (enabled ? '1' : '0') + '">' + (enabled ? '关闭写权限' : '开启写权限') + '</button>';
      return '<tr>' +
        '<td>' + escapeHtml(u.username) + '</td>' +
        '<td>' + roleTag + '</td>' +
        '<td>' + statusTag + '</td>' +
        '<td>' + permTag + '</td>' +
        '<td>' + toggleBtn + '</td></tr>';
    }).join('');
    tbody.querySelectorAll('button[data-act="toggle"]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const next = btn.dataset.cur !== '1';
        await fetch(api('/api/admin/knowledge/users/' + encodeURIComponent(btn.dataset.username) + '/permission'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next })
        });
        showToast(next ? '已开启写权限' : '已关闭写权限');
        ksLoadKsPermissions(document.getElementById('ks-per-search').value.trim());
      });
    });
  } catch (e) { tbody.innerHTML = '<tr><td colspan="5" class="biz-table-state-cell biz-table-error">加载失败</td></tr>'; }
}

// ====== 套利审核 ======
async function renderArbitrage() {
  const el = document.getElementById('view-arbitrage');
  if (!el) return;
  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
      '<div><button class="btn btn-sm btn-primary" onclick="adminArbSync()">手动同步</button></div>' +
      '<div id="arb-admin-meta" style="font-size:12px;color:#999;"></div>' +
    '</div>' +
    '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr>' +
      '<th>ID</th><th>市场</th><th>类型</th><th>证券</th><th>状态</th><th>审核</th><th>公告日</th><th>操作</th>' +
    '</tr></thead><tbody id="arb-admin-tbody"><tr><td colspan="8" class="biz-table-state-cell">加载中...</td></tr></tbody></table></div>';
  loadArbCandidates();
}

async function loadArbCandidates() {
  const tb = document.getElementById('arb-admin-tbody');
  if (!tb) return;
  try {
    const r = await fetch(api('/api/admin/arbitrage/candidates?status=approved&page_size=100'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const meta = document.getElementById('arb-admin-meta');
    if (meta) meta.textContent = '共 ' + (d.total || 0) + ' 条事件';
    if (!d.rows || !d.rows.length) {
      tb.innerHTML = '<tr><td colspan="8" class="biz-table-state-cell">暂无待审核事件</td></tr>';
      return;
    }
    tb.innerHTML = d.rows.map(function (c) {
      return '<tr>' +
        '<td>' + c.case_id + '</td>' +
        '<td>' + (c.market || '') + '</td>' +
        '<td>' + esc(c.strategy_type || '') + '</td>' +
        '<td>' + esc(c.canonical_code || '') + ' ' + esc(c.name || '') + '</td>' +
        '<td>' + esc(c.event_status || '') + '</td>' +
        '<td>' + esc(c.review_status || '') + '</td>' +
        '<td>' + (c.announced_at ? String(c.announced_at).slice(0, 10) : '') + '</td>' +
        '<td>' +
          '<button class="btn btn-sm btn-success" onclick="adminArbReview(' + c.case_id + ',\'approved\')">通过</button> ' +
          '<button class="btn btn-sm btn-danger" onclick="adminArbReview(' + c.case_id + ',\'rejected\')">驳回</button> ' +
          '<button class="btn btn-sm btn-ghost" onclick="adminArbDetail(' + c.case_id + ')">详情</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  } catch (e) {
    tb.innerHTML = '<tr><td colspan="8" class="biz-table-state-cell biz-table-error">加载失败: ' + esc(e.message) + '</td></tr>';
  }
}

async function adminArbReview(caseId, status) {
  try {
    const r = await fetch(api('/api/admin/arbitrage/' + caseId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: status })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    showToast(status === 'approved' ? '已通过审核' : '已驳回');
    loadArbCandidates();
  } catch (e) {
    showToast('操作失败: ' + e.message);
  }
}

async function adminArbDetail(caseId) {
  try {
    const r = await fetch(api('/api/admin/arbitrage/' + caseId));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    var docs = (d.documents || []).map(function (doc) {
      return '<div style="padding:4px 0;border-bottom:1px solid #eee;font-size:13px;">' +
        '<span style="color:#666;">' + (doc.announced_at ? String(doc.announced_at).slice(0, 10) : '') + '</span> ' +
        esc(doc.title || '') + '</div>';
    }).join('');
    openAdminModal('套利事件 #' + caseId,
      '<div style="max-height:400px;overflow-y:auto;">' +
      '<p><b>证券:</b> ' + esc(d.canonical_code || '') + ' ' + esc(d.name || '') + '</p>' +
      '<p><b>类型:</b> ' + esc(d.strategy_type || '') + '</p>' +
      '<p><b>状态:</b> ' + esc(d.event_status || '') + ' / ' + esc(d.review_status || '') + '</p>' +
      '<p><b>描述:</b> ' + esc(d.description || '') + '</p>' +
      '<h4 style="margin:12px 0 4px;">公告链</h4>' + (docs || '<p style="color:#999;">无</p>') +
      '</div>',
      '<button class="btn btn-sm btn-primary" onclick="openArbEditForm(' + caseId + ')">编辑条款</button>' +
      '<button class="btn btn-sm btn-ghost" onclick="closeAdminModal()">关闭</button>'
    );
  } catch (e) {
    showToast('加载失败: ' + e.message);
  }
}

async function adminArbSync() {
  try {
    const r = await fetch(api('/api/admin/arbitrage/sync'), { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    showToast(d.message || '同步已启动');
  } catch (e) {
    showToast('同步失败: ' + e.message);
  }
}

// 编辑套利事件条款（证券 / 价格 / 比例 / 日期），保存时 PATCH 到后端
async function openArbEditForm(caseId) {
  let d;
  try {
    const r = await fetch(api('/api/admin/arbitrage/' + caseId));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    d = await r.json();
  } catch (e) { showToast('加载失败: ' + e.message); return; }
  const v = function (x) { return x == null ? '' : x; };
  const g = function (label, id, type, step) {
    const t = type || 'text';
    const s = step ? (' step="' + step + '"') : '';
    return '<div class="form-group"><label>' + label + '</label><input id="' + id + '" type="' + t + '"' + s + ' style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;box-sizing:border-box;"></div>';
  };
  const sel = function (label, id, opts, cur) {
    let o = ''; opts.forEach(function (x) { o += '<option value="' + x + '"' + (x === cur ? ' selected' : '') + '>' + x + '</option>'; });
    return '<div class="form-group"><label>' + label + '</label><select id="' + id + '" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;box-sizing:border-box;">' + o + '</select></div>';
  };
  const body =
    '<div style="max-height:62vh;overflow:auto;padding-right:4px;">' +
      sel('类型', 'arb-edit-strategy_type', ['a_cash_offer', 'a_share_swap', 'hk_privatisation', 'hk_rights'], d.strategy_type) +
      sel('状态', 'arb-edit-event_status', ['proposed', 'in_progress', 'completed', 'terminated', 'expired'], d.event_status) +
      sel('审核', 'arb-edit-review_status', ['pending', 'approved', 'rejected'], d.review_status) +
      g('现金对价', 'arb-edit-offer_price', 'number', '0.0001') +
      g('现金选择权价', 'arb-edit-cash_choice_price', 'number', '0.0001') +
      g('供股价', 'arb-edit-subscription_price', 'number', '0.0001') +
      g('换股比例', 'arb-edit-swap_ratio', 'number', '0.00000001') +
      g('现金补偿', 'arb-edit-cash_component', 'number', '0.0001') +
      g('每新股所需供股权数', 'arb-edit-rights_units_per_new_share', 'number', '1') +
      g('供股比例(分子)', 'arb-edit-rights_ratio_numerator', 'number', '1') +
      g('供股比例(分母)', 'arb-edit-rights_ratio_denominator', 'number', '1') +
      g('参考证券代码', 'arb-edit-reference_instrument_code') +
      g('供股权代码', 'arb-edit-rights_instrument_code') +
      g('要约人', 'arb-edit-offeror') +
      g('持股比例%', 'arb-edit-offeror_holding_pct', 'number', '0.01') +
      g('公告日', 'arb-edit-announced_at', 'date') +
      g('预计完成', 'arb-edit-expected_completion_date', 'date') +
      g('供股交易开始', 'arb-edit-rights_trade_start', 'date') +
      g('供股交易结束', 'arb-edit-rights_trade_end', 'date') +
      g('缴款截止', 'arb-edit-payment_deadline', 'date') +
      g('上市日', 'arb-edit-listing_date', 'date') +
      '<div class="form-group"><label>描述</label><textarea id="arb-edit-description" rows="3" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;box-sizing:border-box;">' + escapeHtml(v(d.description)) + '</textarea></div>' +
    '</div>';
  openAdminModal('编辑条款 #' + caseId, body,
    '<button class="btn btn-outline" onclick="closeAdminModal()">取消</button>' +
    '<button class="btn btn-primary" onclick="submitArbEdit(' + caseId + ')">保存</button>');
  const setVal = function (id, val) { const el = document.getElementById(id); if (el) el.value = v(val); };
  setVal('arb-edit-offer_price', d.offer_price);
  setVal('arb-edit-cash_choice_price', d.cash_choice_price);
  setVal('arb-edit-subscription_price', d.subscription_price);
  setVal('arb-edit-swap_ratio', d.swap_ratio);
  setVal('arb-edit-cash_component', d.cash_component);
  setVal('arb-edit-rights_units_per_new_share', d.rights_units_per_new_share);
  setVal('arb-edit-rights_ratio_numerator', d.rights_ratio_numerator);
  setVal('arb-edit-rights_ratio_denominator', d.rights_ratio_denominator);
  setVal('arb-edit-reference_instrument_code', d.ref_code);
  setVal('arb-edit-rights_instrument_code', d.rights_code);
  setVal('arb-edit-offeror', d.offeror);
  setVal('arb-edit-offeror_holding_pct', d.offeror_holding_pct);
  setVal('arb-edit-announced_at', d.announced_at ? String(d.announced_at).slice(0, 10) : '');
  setVal('arb-edit-expected_completion_date', d.expected_completion_date ? String(d.expected_completion_date).slice(0, 10) : '');
  setVal('arb-edit-rights_trade_start', d.rights_trade_start ? String(d.rights_trade_start).slice(0, 10) : '');
  setVal('arb-edit-rights_trade_end', d.rights_trade_end ? String(d.rights_trade_end).slice(0, 10) : '');
  setVal('arb-edit-payment_deadline', d.payment_deadline ? String(d.payment_deadline).slice(0, 10) : '');
  setVal('arb-edit-listing_date', d.listing_date ? String(d.listing_date).slice(0, 10) : '');
}

async function submitArbEdit(caseId) {
  const numOrNull = function (id) { const el = document.getElementById(id); if (!el || el.value === '' || el.value == null) return null; const n = Number(el.value); return isNaN(n) ? null : n; };
  const strOrNull = function (id) { const el = document.getElementById(id); if (!el || el.value.trim() === '') return null; return el.value.trim(); };
  const dateOrNull = function (id) { const el = document.getElementById(id); if (!el || el.value === '') return null; return el.value; };
  const body = {
    strategy_type: strOrNull('arb-edit-strategy_type'),
    event_status: strOrNull('arb-edit-event_status'),
    review_status: strOrNull('arb-edit-review_status'),
    offer_price: numOrNull('arb-edit-offer_price'),
    cash_choice_price: numOrNull('arb-edit-cash_choice_price'),
    subscription_price: numOrNull('arb-edit-subscription_price'),
    swap_ratio: numOrNull('arb-edit-swap_ratio'),
    cash_component: numOrNull('arb-edit-cash_component'),
    rights_units_per_new_share: numOrNull('arb-edit-rights_units_per_new_share'),
    rights_ratio_numerator: numOrNull('arb-edit-rights_ratio_numerator'),
    rights_ratio_denominator: numOrNull('arb-edit-rights_ratio_denominator'),
    reference_instrument_code: strOrNull('arb-edit-reference_instrument_code'),
    rights_instrument_code: strOrNull('arb-edit-rights_instrument_code'),
    offeror: strOrNull('arb-edit-offeror'),
    offeror_holding_pct: numOrNull('arb-edit-offeror_holding_pct'),
    announced_at: dateOrNull('arb-edit-announced_at'),
    expected_completion_date: dateOrNull('arb-edit-expected_completion_date'),
    rights_trade_start: dateOrNull('arb-edit-rights_trade_start'),
    rights_trade_end: dateOrNull('arb-edit-rights_trade_end'),
    payment_deadline: dateOrNull('arb-edit-payment_deadline'),
    listing_date: dateOrNull('arb-edit-listing_date'),
    description: strOrNull('arb-edit-description'),
  };
  try {
    const r = await fetch(api('/api/admin/arbitrage/' + caseId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || '保存失败'); return; }
    showToast('条款已保存');
    closeAdminModal();
    loadArbCandidates();
  } catch (e) { showToast('网络错误'); }
}

// ====== 启动 ======
(async function init() {
  const ok = await checkAuth();
  if (!ok) return;
  setupMenu();
  applyMenuPermissions();
  renderOverview();
})();
