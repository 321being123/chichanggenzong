// ============== 站内通知收件箱（2026-10-25） ==============
// 一级栏目「通知」的三个子页：全部 / 反馈 / 系统。
// 契约见 docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.3 节。
// 约定：CSP 已关闭内联脚本属性，所有交互走 data-nt-act 事件委托；
// 打开列表不自动已读，只有真正打开反馈详情或系统正文后才标记已读。
// 批次4 View／Presenter 分离：取数、列表/详情状态与请求序号（state.seq/owner）在
// presenters/notifications-presenter.js，本文件只做 DOM/HTML 渲染、地址栏与快照，
// 取数经 window.appNotificationsPresenter 转调，state 经 window.appNotificationsPresenter.state 读写。
(function () {
  'use strict';

  var SUBS = ['all', 'feedback', 'system'];
  var SUB_LABELS = { all: '全部', feedback: '反馈', system: '系统' };
  var SNAPSHOT_KEY = 'nt-state-v1';

  function esc(v) { return escapeHtml(String(v == null ? '' : v)); }
  function byId(id) { return document.getElementById(id); }
  function loggedIn() {
    if (typeof username === 'string' && username) return true;
    return !!window.username;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    if (window.CoreDate && CoreDate.dateTimeInZone) {
      var t = CoreDate.dateTimeInZone(iso, 'Asia/Shanghai');
      if (t) return t;
    }
    return String(iso).replace('T', ' ').slice(0, 16);
  }

  function toast(msg) {
    if (typeof showToast === 'function') { showToast(msg); return; }
    if (window.projectAlert) window.projectAlert(msg);
  }

  // ---------- 地址栏与缓存 ----------
  function readUrl() {
    var state = window.appNotificationsPresenter.state;
    var params = new URLSearchParams(window.location.search);
    var sub = params.get('sub');
    state.sub = SUBS.indexOf(sub) >= 0 ? sub : 'all';
    state.unreadOnly = params.get('unread') === '1';
    state.detailId = params.get('notification') || null;
  }

  function syncUrl(push) {
    if (!push) return;
    var state = window.appNotificationsPresenter.state;
    var params = new URLSearchParams(window.location.search);
    params.set('main', 'notifications');
    params.set('sub', state.sub);
    if (state.unreadOnly) params.set('unread', '1'); else params.delete('unread');
    if (state.detailId) params.set('notification', state.detailId); else params.delete('notification');
    var url = '/?' + params.toString();
    if (window.location.pathname + window.location.search !== url) history.pushState(null, '', url);
  }

  // 返回时保留筛选、游标和滚动位置：跳去反馈详情前把当前列表快照进 sessionStorage
  // 快照绑定「登录名 + 不可复用身份」：同名重注册拿到的是新身份，旧快照必须作废。
  // 拿不到身份时宁可不保存，避免下次按用户名误恢复。
  function saveSnapshot() {
    var state = window.appNotificationsPresenter.state;
    var who = window.appNotificationsPresenter.currentUser();
    var identity = window.appNotificationsPresenter.currentIdentity();
    if (!who || !identity) { clearSnapshot(); return; }
    try {
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        user: who, identity: identity,
        sub: state.sub, unreadOnly: state.unreadOnly, items: state.items,
        nextCursor: state.nextCursor, complete: state.complete,
        scrollTop: window.scrollY || 0,
      }));
    } catch (e) { /* 隐私模式下静默降级为不恢复 */ }
  }

  function readSnapshot() {
    try {
      var raw = sessionStorage.getItem(SNAPSHOT_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || SUBS.indexOf(data.sub) < 0 || !Array.isArray(data.items)) return null;
      var who = window.appNotificationsPresenter.currentUser();
      var identity = window.appNotificationsPresenter.currentIdentity();
      // 缺身份、身份不一致（删号后同名重注册）或登录名不一致：一律丢弃，绝不跨账号复用
      if (!who || !identity || !data.identity || data.identity !== identity || data.user !== who) {
        clearSnapshot();
        return null;
      }
      return data;
    } catch (e) { return null; }
  }

  function clearSnapshot() {
    try { sessionStorage.removeItem(SNAPSHOT_KEY); } catch (e) { /* 忽略 */ }
  }

  // ---------- 渲染 ----------
  function headerHtml() {
    var state = window.appNotificationsPresenter.state;
    var html = '<div class="nt-toolbar">';
    html += '<label class="nt-toggle"><input type="checkbox" data-nt-act="unread"'
      + (state.unreadOnly ? ' checked' : '') + '> 只看未读</label>';
    html += '<span class="nt-toolbar-spacer"></span>';
    html += '<button type="button" class="btn btn-outline btn-sm" data-nt-act="readall">全部已读</button>';
    html += '<button type="button" class="btn btn-outline btn-sm" data-nt-act="refresh">刷新</button>';
    html += '</div>';
    return html;
  }

  function itemHtml(it) {
    var unread = !it.read;
    var cls = 'nt-item' + (unread ? ' nt-item--unread' : '') + (it.invalidated ? ' nt-item--invalid' : '');
    var html = '<article class="' + cls + '" data-nt-act="item" data-id="' + esc(it.id) + '"'
      + ' tabindex="0" role="button" aria-label="' + esc(it.title + (unread ? '（未读）' : '（已读）')) + '">';
    html += '<div class="nt-item-main">';
    html += '<div class="nt-item-head">'
      + '<span class="nt-dot" aria-hidden="true"></span>'
      + '<strong class="nt-item-title">' + esc(it.title) + '</strong>'
      + '<span class="nt-item-type">' + esc(SUB_LABELS[it.category] || it.category) + '</span>'
      + '</div>';
    html += '<p class="nt-item-body">' + esc(it.body) + '</p>';
    var meta = [];
    if (it.feedback && it.feedback.id) {
      meta.push('反馈 #' + esc(it.feedback.id));
      if (it.feedback.title) meta.push(esc(it.feedback.title));
      if (it.feedback.version) meta.push('版本 ' + esc(it.feedback.version));
    }
    meta.push(fmtTime(it.createdAt));
    html += '<div class="nt-item-meta">' + meta.map(function (m) { return '<span>' + m + '</span>'; }).join('') + '</div>';
    if (it.invalidated) html += '<div class="nt-item-invalid">处理状态已更新</div>';
    html += '</div></div>';
    return html + '</article>';
  }

  function detailHtml() {
    var state = window.appNotificationsPresenter.state;
    var d = state.detail;
    if (!d) return '<div class="nt-panel"><p class="nt-empty">加载中…</p></div>';
    var html = '<div class="nt-detail">';
    html += '<button type="button" class="btn btn-outline btn-sm" data-nt-act="back">← 返回列表</button>';
    html += '<h3 class="nt-detail-title">' + esc(d.title) + '</h3>';
    html += '<div class="nt-detail-meta">' + fmtTime(d.createdAt) + '</div>';
    html += '<div class="nt-detail-body">' + esc(d.body).replace(/\n/g, '<br>') + '</div>';
    if (d.invalidated) html += '<div class="nt-item-invalid">处理状态已更新，最新状态请看反馈详情</div>';
    html += '</div>';
    return html;
  }

  function render() {
    var state = window.appNotificationsPresenter.state;
    var host = byId('nt-body');
    if (!host) return;
    if (state.detailId) { host.innerHTML = detailHtml(); return; }
    var html = headerHtml();
    if (!loggedIn()) {
      host.innerHTML = '<div class="nt-panel"><p class="nt-empty">请先登录后查看通知。</p></div>';
      return;
    }
    if (state.error) {
      host.innerHTML = html + '<div class="nt-panel"><p class="nt-error">加载失败：' + esc(state.error)
        + '</p><button type="button" class="btn btn-outline btn-sm" data-nt-act="retry">重新加载</button></div>';
      return;
    }
    if (state.loading && !state.items.length) {
      host.innerHTML = html + '<div class="nt-panel"><p class="nt-empty">加载中…</p></div>';
      return;
    }
    if (!state.items.length) {
      host.innerHTML = html + '<div class="nt-panel"><p class="nt-empty">'
        + (state.unreadOnly ? '没有未读通知。' : '暂时没有通知。') + '</p></div>';
      return;
    }
    html += '<div class="nt-list">' + state.items.map(itemHtml).join('') + '</div>';
    if (!state.complete) {
      html += '<div class="nt-more"><button type="button" class="btn btn-outline btn-sm" data-nt-act="more"'
        + (state.loading ? ' disabled' : '') + '>' + (state.loading ? '加载中…' : '加载更多') + '</button></div>';
    }
    host.innerHTML = html;
  }

  // ---------- 交互 ----------
  async function openItem(id) {
    var state = window.appNotificationsPresenter.state;
    var item = null;
    for (var i = 0; i < state.items.length; i++) {
      if (String(state.items[i].id) === String(id)) { item = state.items[i]; break; }
    }
    if (!item) return;
    if (item.target && item.target.kind === 'feedback' && item.target.feedbackId) {
      // 先标记已读再跳回原反馈详情（复用既有详情链路，不另建反馈详情页）；
      // 标记失败不阻断跳转，详情页自身有权限校验，回来可重试
      var seq = state.seq;
      var owner = window.appNotificationsPresenter.ownerKey();
      var marked = await window.appNotificationsPresenter.markRead(item.id);
      if (!window.appNotificationsPresenter.currentRequest(seq, owner)) return;
      if (!marked) toast('通知已读状态未同步，稍后可重试');
      saveSnapshot();
      window.location.href = api(item.target.path);
      return;
    }
    // 系统通知：同页正文懒加载，成功打开后才标已读
    state.detailId = item.id;
    state.detail = null;
    syncUrl(true);
    render();
    await window.appNotificationsPresenter.refreshDetail();
  }

  function switchSub(sub) {
    var state = window.appNotificationsPresenter.state;
    if (SUBS.indexOf(sub) < 0 || state.sub === sub) return;
    state.sub = sub;
    state.detailId = null;
    state.detail = null;
    clearSnapshot();
    syncUrl(true);
    paintSubTabs();
    window.appNotificationsPresenter.loadFirst();
  }

  function paintSubTabs() {
    var state = window.appNotificationsPresenter.state;
    document.querySelectorAll('#main-notifications [data-nt-sub]').forEach(function (tab) {
      var on = tab.getAttribute('data-nt-sub') === state.sub;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function onAction(act, el) {
    var state = window.appNotificationsPresenter.state;
    if (act === 'sub') { switchSub(el.getAttribute('data-nt-sub')); return; }
    if (act === 'unread') { state.unreadOnly = !!el.checked; syncUrl(true); window.appNotificationsPresenter.loadFirst(); return; }
    if (act === 'readall') { window.appNotificationsPresenter.markAllRead(); return; }
    if (act === 'refresh') { window.appNotificationsPresenter.loadFirst(); return; }
    if (act === 'retry') { window.appNotificationsPresenter.loadFirst(); return; }
    if (act === 'more') { window.appNotificationsPresenter.loadMore(); return; }
    if (act === 'item') { openItem(el.getAttribute('data-id')); return; }
    if (act === 'back') {
      state.seq++;
      state.detailId = null;
      state.detail = null;
      syncUrl(true);
      render();
      return;
    }
  }

  function bindEvents() {
    var root = document.getElementById('main-notifications');
    if (!root || root.__ntBound) return;
    root.__ntBound = true;
    root.addEventListener('click', function (e) {
      var el = e.target.closest('[data-nt-act]');
      if (!el || !root.contains(el)) return;
      var act = el.getAttribute('data-nt-act');
      if (act === 'unread') return;   // 复选框走 change
      onAction(act, el);
    });
    root.addEventListener('change', function (e) {
      var el = e.target.closest('[data-nt-act="unread"]');
      if (el) onAction('unread', el);
    });
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var el = e.target.closest('[data-nt-act="item"]');
      if (!el) return;
      e.preventDefault();
      onAction('item', el);
    });
  }

  // 页面入口：切回通知页时复用已加载列表（保留游标与位置），筛选变化才重新拉取
  function loadNotificationsPage() {
    var state = window.appNotificationsPresenter.state;
    bindEvents();
    // 同一浏览器换账号（含删号后同名重注册）：内存列表、详情与快照全部作废。
    // 归属用不可复用身份判定，仅用户名相同不算同一个人。
    // 首次挂载（owner 未记录）不算换人，此时靠快照里的「登录名+身份」校验决定能否恢复。
    var owner = window.appNotificationsPresenter.ownerKey();
    var firstMount = state.owner === undefined;
    var switched = !firstMount && state.owner !== owner;
    state.owner = owner;
    if (switched) {
      state.items = [];
      state.nextCursor = null;
      state.complete = false;
      state.error = '';
      state.loading = false;
      state.detailId = null;
      state.detail = null;
      state.seq++;
      clearSnapshot();
    }
    readUrl();
    // 换账号后地址栏里残留的通知编号属于上一个人，不能继续沿用
    if (switched && state.detailId) {
      state.detailId = null;
      state.detail = null;
    }
    paintSubTabs();
    if (switched) syncUrl(true);
    if (state.detailId) { render(); window.appNotificationsPresenter.refreshDetail(); return; }
    if (state.items.length && !state.error) { render(); return; }
    var snap = readSnapshot();
    if (snap && snap.sub === state.sub && snap.unreadOnly === state.unreadOnly && snap.items.length) {
      state.items = snap.items;
      state.nextCursor = snap.nextCursor || null;
      state.complete = snap.complete === true;
      render();
      if (snap.scrollTop) window.scrollTo(0, snap.scrollTop);
      return;
    }
    window.appNotificationsPresenter.loadFirst();
  }

  // 未读数变化后同步本页已读标记（铃铛轮询与列表不互相覆盖）
  // clearCache：退出登录/会话失效时立即清空快照与内存列表（由 session.js 调用）
  function clearCache() {
    var state = window.appNotificationsPresenter.state;
    clearSnapshot();
    state.items = [];
    state.nextCursor = null;
    state.complete = false;
    state.error = '';
    state.loading = false;
    state.detailId = null;
    state.detail = null;
    state.seq++;
    state.owner = undefined;
    render();
  }

  // View 对外入口（批次4）：Presenter 只调这些函数改界面，自己不碰 DOM。
  window.appNotificationsRender = render;
  window.appNotificationsToast = toast;
  window.appNotificationsSyncUrl = syncUrl;

  window.AppNotifications = {
    load: loadNotificationsPage,
    refresh: function () { return window.appNotificationsPresenter.loadFirst(); },
    clearCache: clearCache,
  };
})();
