// 站内通知 Presenter（批次4：View／Presenter 分离）。
// 职责：持有通知列表/详情状态与请求序号（state.seq / state.owner：旧响应与换号后整体作废）、经 siteApi 取数。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       列表/详情渲染与事件绑定在 notifications.js（View），经 window.appNotifications* 回调 View；
//       View 不取数，只渲染并上报用户操作。
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.3 节。
//       window.AppNotifications={load,refresh,clearCache} 仍由 View 组装，键名不变，取数转调本文件。
(function () {
  'use strict';

  var state = {
    sub: 'all',
    unreadOnly: false,
    items: [],
    nextCursor: null,
    complete: false,
    loading: false,
    error: '',
    detailId: null,
    detail: null,
    seq: 0,
    owner: undefined,   // 当前列表属于哪个登录名：首次挂载不视为换人，之后变化即整体丢弃
  };
  var PAGE_SIZE = 20;

  // 当前登录名：列表缓存与快照都必须绑定它，同一浏览器换账号不能复用上一个人的通知
  function currentUser() {
    if (typeof username === 'string' && username) return username;
    if (typeof window.username === 'string' && window.username) return window.username;
    return null;
  }
  // 不可复用账号身份（建号时间摘要）：与用户名一起校验。
  // 只比用户名时，删号后同名重注册会命中旧缓存，看到上一个人的私密通知。
  function currentIdentity() {
    if (typeof accountIdentity === 'string' && accountIdentity) return accountIdentity;
    if (typeof window.accountIdentity === 'string' && window.accountIdentity) return window.accountIdentity;
    return '';
  }
  // 归属键必须同时含「用户名 + 不可复用身份」：
  // 只用建号时间时，两个不同账号若建号时间落在同一刻会被判成同一个人，
  // 切换后不重新请求，直接沿用上一个人的私密列表。
  function ownerKey() {
    var who = currentUser();
    if (!who) return '';
    return 'u:' + who + '|id:' + currentIdentity();
  }

  function markLocalRead(id) {
    state.items.forEach(function (it) { if (String(it.id) === String(id)) it.read = true; });
  }

  function currentRequest(seq, owner) {
    return seq === state.seq && owner === ownerKey();
  }

  // ---------- 请求 ----------
  async function requestJson(url, options) {
    var result = await window.siteApi.requestRaw(url, Object.assign({ timeoutMs: 0, headers: {} }, options || {}));
    if (!result.response) throw new Error(result.error || '网络异常');
    var r = result.response;
    var payload = null;
    try { payload = await r.json(); } catch (e) { payload = null; }
    if (!r.ok) {
      var err = new Error((payload && payload.error) || ('请求失败（' + r.status + '）'));
      err.status = r.status;
      throw err;
    }
    return payload || {};
  }

  function buildQuery(base) {
    var params = [];
    Object.keys(base).forEach(function (k) {
      var v = base[k];
      if (v === '' || v == null || v === false) return;
      params.push(encodeURIComponent(k) + '=' + encodeURIComponent(v === true ? '1' : v));
    });
    return params.length ? '?' + params.join('&') : '';
  }

  // ---------- 数据 ----------
  async function loadFirst() {
    state.items = [];
    state.nextCursor = null;
    state.complete = false;
    state.error = '';
    state.loading = true;
    window.appNotificationsRender();
    var seq = ++state.seq;
    try {
      var data = await requestJson('/api/notifications' + buildQuery({
        category: state.sub, unreadOnly: state.unreadOnly, limit: PAGE_SIZE,
      }));
      if (seq !== state.seq) return;   // 拒绝旧响应覆盖新筛选
      state.items = data.items || [];
      state.nextCursor = data.nextCursor || null;
      state.complete = data.complete !== false;
    } catch (e) {
      if (seq !== state.seq) return;
      state.error = e.message || '网络异常';
    } finally {
      if (seq === state.seq) { state.loading = false; window.appNotificationsRender(); }
    }
  }

  async function loadMore() {
    if (state.loading || state.complete || !state.nextCursor) return;
    state.loading = true;
    state.error = '';
    window.appNotificationsRender();
    var seq = state.seq;
    try {
      var data = await requestJson('/api/notifications' + buildQuery({
        category: state.sub, unreadOnly: state.unreadOnly, limit: PAGE_SIZE, cursor: state.nextCursor,
      }));
      if (seq !== state.seq) return;
      state.items = state.items.concat(data.items || []);
      state.nextCursor = data.nextCursor || null;
      state.complete = data.complete !== false;
    } catch (e) {
      if (seq !== state.seq) return;
      state.error = e.message || '网络异常';
    } finally {
      if (seq === state.seq) { state.loading = false; window.appNotificationsRender(); }
    }
  }

  async function markRead(id) {
    var seq = state.seq;
    var owner = ownerKey();
    try {
      await requestJson('/api/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST' });
      if (!currentRequest(seq, owner)) return false;
      markLocalRead(id);
      if (typeof window.refreshUnreadCount === 'function') window.refreshUnreadCount();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function markAllRead() {
    var seq = state.seq;
    var owner = ownerKey();
    try {
      var res = await requestJson('/api/notifications/read-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: state.sub }),
      });
      if (!currentRequest(seq, owner)) return;
      state.items.forEach(function (it) { it.read = true; });
      if (typeof window.refreshUnreadCount === 'function') window.refreshUnreadCount();
      window.appNotificationsRender();
      window.appNotificationsToast(res && res.marked ? ('已标记 ' + res.marked + ' 条为已读') : '没有未读通知');
    } catch (e) {
      if (!currentRequest(seq, owner)) return;
      window.appNotificationsToast('全部已读失败：' + (e.message || '请重试'));
    }
  }

  async function refreshDetail() {
    if (!state.detailId) return;
    var id = state.detailId;
    var seq = ++state.seq;
    state.loading = false; // 已作废的列表请求不能让返回后的“加载更多”一直禁用
    var owner = ownerKey();
    try {
      var data = await requestJson('/api/notifications/' + encodeURIComponent(id));
      if (!currentRequest(seq, owner) || state.detailId !== id) return;
      state.detail = data;
      window.appNotificationsRender();
      markRead(id);
    } catch (e) {
      if (!currentRequest(seq, owner) || state.detailId !== id) return;
      state.detailId = null;
      window.appNotificationsSyncUrl(true);
      window.appNotificationsRender();
      window.appNotificationsToast('通知正文加载失败：' + (e.message || '请重试'));
    }
  }

  // 最小桥：View（含 HTML 与 window.AppNotifications）经此转调取数；state 供 View 读写列表/详情与序号
  window.appNotificationsPresenter = {
    state: state,
    currentUser: currentUser,
    currentIdentity: currentIdentity,
    ownerKey: ownerKey,
    currentRequest: currentRequest,
    loadFirst: loadFirst,
    loadMore: loadMore,
    markRead: markRead,
    markAllRead: markAllRead,
    refreshDetail: refreshDetail,
  };
})();
