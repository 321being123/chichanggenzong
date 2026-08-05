// ============== 登录态与当前用户（FRONT-01 拆分，第一期） ==============
// 从 index.html 内联脚本抽取：集中管理登录态（username / myProfile）与认证流程。
// 保持 username / myProfile 为全局 var，供其他独立脚本直接引用（与项目设计约定一致：
// 顶层变量不挂 window，但同属经典脚本作用域，其他脚本可直接按名读取）。
var username = null;
var myProfile = null;   // 个人中心资料缓存（nickname/avatar/email/last_login/accounts）

async function checkAuth() {
  try {
    const r = await fetch(api('/api/me'));
    const d = await r.json();
    if (!d.username) { username = null; myProfile = null; renderTopUser(null); return false; }
    username = d.username;
    myProfile = d;
    const nu0 = document.getElementById('nav-user');
    if (nu0) nu0.textContent = d.nickname || username;
    renderTopUser(d);
    return true;
  } catch (e) {
    username = null; myProfile = null; renderTopUser(null); return false;
  }
}

// 顶部右侧：登录态显示头像（点击展开菜单），未登录显示「登录/注册」
function renderTopUser(p) {
  const el = document.getElementById('top-user');
  if (!el) return;
  el.textContent = '';
  if (!p || !p.username) {
    const link = document.createElement('a');
    link.className = 'nav-avatar guest-avatar';
    link.href = api('/login.html');
    link.title = '登录/注册';
    link.textContent = '👤';
    el.appendChild(link);
    return;
  }
  const src = p.avatar || '';
  const initial = (p.nickname || p.username || '?').charAt(0).toUpperCase();
  const isAdmin = (p.role || (myProfile && myProfile.role)) === 'admin';
  const caps = (p.capabilities || (myProfile && myProfile.capabilities) || {});
  let hasAnyCap = false;
  for (const k in caps) { if (caps[k]) { hasAnyCap = true; break; } }
  const canStaff = isAdmin || hasAnyCap;
  const wrap = document.createElement('div');
  wrap.className = 'nav-user';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-avatar';
  button.title = '菜单';
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '头像';
    button.appendChild(img);
  } else {
    button.textContent = initial;
  }
  const menu = document.createElement('div');
  menu.className = 'nav-user-menu';
  const items = [
    { label: '个人中心', fn: function () { switchMain('profile'); } },
    { label: '版本记录', fn: function () { switchMain('changelog'); } }
  ];
  if (canStaff) items.push({ label: '管理后台', href: '/admin.html' });
  items.push({ label: '退出登录', fn: function () { logout(); } });
  function closeMenu() { menu.classList.remove('open'); }
  items.forEach(function (it) {
    const node = document.createElement(it.href ? 'a' : 'button');
    node.className = 'nav-user-item';
    node.textContent = it.label;
    if (it.href) {
      node.href = it.href;
    } else {
      node.type = 'button';
      node.addEventListener('click', function () { closeMenu(); it.fn(); });
    }
    menu.appendChild(node);
  });
  button.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) closeMenu(); });
  wrap.appendChild(button);
  wrap.appendChild(menu);
  el.appendChild(wrap);
}

async function logout() {
  await fetch(api('/api/logout'), { method: 'POST' });
  window.location.href = api('/');
}

// 统一会话 API（供首页按登录态重排等场景读取，避免直接依赖全局变量）
window.AppSession = {
  isLoggedIn: function () { return !!username; },
  getUser: function () { return username; },
  getProfile: function () { return myProfile; }
};
