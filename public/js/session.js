// ============== 登录态与当前用户（FRONT-01 拆分，第一期） ==============
// 从 index.html 内联脚本抽取：集中管理登录态（username / myProfile）与认证流程。
// 保持 username / myProfile 为全局 var，供其他独立脚本直接引用（与项目设计约定一致：
// 顶层变量不挂 window，但同属经典脚本作用域，其他脚本可直接按名读取）。
var username = null;
var myProfile = null;   // 个人中心资料缓存（nickname/avatar/email/last_login/accounts）
// 不可复用账号身份（建号时间摘要）：删号后同名重注册会变。
// 前端所有按账号隔离的缓存都必须绑定它，只比对用户名的缓存会串号。
var accountIdentity = '';

// ============== 站内通知铃铛（2026-10-25） ==============
// 契约见 docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.3 节：
// 铃铛常驻头像左侧、0 隐藏 / 1~99 显示数字 / 超过 99 显示 99+；点击直达通知列表（无中间弹窗）。
// 只在登录后轮询；隐藏时暂停、恢复可见立即查；重复挂载不叠加计时器；失败保留旧数不伪装 0。
var NOTIFICATION_POLL_MS = 60000;
var notifPoll = { total: null, seq: 0, timer: null, user: null };

function bellLabel(total) {
  if (total === null || total === undefined) return '通知，未读数暂不可用';
  if (!total) return '通知，无未读';
  return '通知，' + total + ' 条未读';
}

function paintBell(total) {
  var bell = document.getElementById('nav-bell');
  if (!bell) return;
  var badge = document.getElementById('nav-bell-badge');
  bell.setAttribute('aria-label', bellLabel(total));
  bell.setAttribute('title', total === null || total === undefined
    ? '通知（未读数刷新失败，点击查看）' : bellLabel(total));
  if (!badge) return;
  if (!total) { badge.hidden = true; badge.textContent = ''; return; }
  badge.hidden = false;
  badge.textContent = total > 99 ? '99+' : String(total);
}

function resetBell() {
  notifPoll.total = null;
  paintBell(null);
}

// 未读数：旧响应不能覆盖新结果（seq 递增作废），换账号后旧响应直接丢弃
async function refreshUnreadCount() {
  if (!username) { resetBell(); return null; }
  var seq = ++notifPoll.seq;
  var who = username;
  try {
    var r = await fetch(api('/api/notifications/unread-count'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var d = await r.json();
    if (seq !== notifPoll.seq || who !== username) return null;
    var total = Number(d && d.total);
    notifPoll.total = Number.isFinite(total) && total > 0 ? total : 0;
    paintBell(notifPoll.total);
    return d;
  } catch (e) {
    if (seq !== notifPoll.seq || who !== username) return null;
    // 失败保留旧数并提示重试，绝不伪装成 0
    paintBell(notifPoll.total);
    return null;
  }
}

function stopNotificationPolling() {
  if (notifPoll.timer) { clearInterval(notifPoll.timer); notifPoll.timer = null; }
  notifPoll.seq++;
  notifPoll.user = null;
}

function startNotificationPolling() {
  stopNotificationPolling();
  if (!username) { resetBell(); return; }
  notifPoll.user = username;
  refreshUnreadCount();
  notifPoll.timer = setInterval(function () {
    if (document.hidden) return;   // 隐藏时暂停查询
    refreshUnreadCount();
  }, NOTIFICATION_POLL_MS);
}

// 页面恢复可见：立即刷新一次（隐藏期间不查，回到前台补齐）
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && username) refreshUnreadCount();
  });
}

// 通知入口：登录后常驻，点击直接进入统一通知列表
function openNotificationCenter() {
  if (typeof switchMain === 'function') { switchMain('notifications'); return; }
  window.location.href = api('/?main=notifications');
}

function buildBell() {
  var bell = document.createElement('button');
  bell.type = 'button';
  bell.id = 'nav-bell';
  bell.className = 'nav-bell';
  bell.setAttribute('aria-label', '通知');
  bell.setAttribute('title', '通知');
  bell.addEventListener('click', function (e) { e.stopPropagation(); openNotificationCenter(); });
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3a5 5 0 0 0-5 5v3.2l-1.6 2.7A1 1 0 0 0 6.3 15h11.4a1 1 0 0 0 .9-1.1L17 11.2V8a5 5 0 0 0-5-5Zm0 18a2.6 2.6 0 0 0 2.5-2h-5A2.6 2.6 0 0 0 12 21Z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  bell.appendChild(svg);
  var badge = document.createElement('span');
  badge.id = 'nav-bell-badge';
  badge.className = 'nav-bell-badge';
  badge.hidden = true;
  bell.appendChild(badge);
  return bell;
}

async function checkAuth() {
  try {
    const r = await fetch(api('/api/me'));
    const d = await r.json();
    if (!d.username) {
      username = null; myProfile = null; accountIdentity = ''; stopNotificationPolling(); clearNotificationCache(); renderTopUser(null); return false;
    }
    username = d.username;
    myProfile = d;
    accountIdentity = String(d.accountIdentity || '');
    const nu0 = document.getElementById('nav-user');
    if (nu0) nu0.textContent = d.nickname || username;
    renderTopUser(d);
    startNotificationPolling();
    return true;
  } catch (e) {
    username = null; myProfile = null; accountIdentity = ''; stopNotificationPolling(); clearNotificationCache(); renderTopUser(null); return false;
  }
}

// 通知缓存按账号隔离：退出/失效时立即清掉，避免下一个人看到上一个人的私密通知
function clearNotificationCache() {
  if (window.AppNotifications && typeof window.AppNotifications.clearCache === 'function') {
    window.AppNotifications.clearCache();
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
    { label: '反馈与版本', fn: function () { switchMain('feedback'); } }
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
  // 铃铛常驻在头像左侧（仅登录态），保留原头像菜单
  wrap.appendChild(buildBell());
  wrap.appendChild(button);
  wrap.appendChild(menu);
  el.appendChild(wrap);
  paintBell(notifPoll.total);
}

async function logout() {
  stopNotificationPolling();
  clearNotificationCache();
  accountIdentity = '';
  await fetch(api('/api/logout'), { method: 'POST' });
  window.location.href = api('/');
}

// 统一会话 API（供首页按登录态重排等场景读取，避免直接依赖全局变量）
window.AppSession = {
  isLoggedIn: function () { return !!username; },
  getUser: function () { return username; },
  getProfile: function () { return myProfile; }
};
