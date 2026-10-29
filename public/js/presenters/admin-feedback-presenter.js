// 后台反馈管理 Presenter（批次4：View／Presenter 分离）。
// 职责：持有列表筛选与详情并发版本（revision）状态、经 siteApi 取数与提交、把数据交给 View 渲染。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       列表/详情 HTML、事件绑定与弹窗在 admin-feedback.js（View），经 window 全局回调 View。
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第四、六节。
//       只负责展示与提交，权限由后端按 content_manage 校验；状态规则与事件留痕在 feedbackService。
(function () {
  'use strict';

  var state = { page: 1, pageSize: 20, status: '', type: '', author: '', q: '', from: '', to: '', detailId: null, data: null };

  function query() {
    var parts = [];
    ['status', 'type', 'author', 'q', 'from', 'to', 'page', 'pageSize'].forEach(function (k) {
      var v = state[k];
      if (v === '' || v == null) return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  async function apiJson(url, options) {
    var result = await window.siteApi.requestRaw(url, Object.assign({ timeoutMs: 0, headers: {} }, options || {}));
    if (!result.response) throw new Error(result.error || '网络异常');
    var r = result.response;
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) throw new Error((data && data.error) || ('请求失败（' + r.status + '）'));
    return data || {};
  }

  // ===== 列表 =====
  async function renderAdminFeedback() {
    if (!window.adminFeedbackPaintLoading()) return;
    try {
      var data = await apiJson('/api/admin/feedback' + query());
      state.data = data;
      window.adminFeedbackPaintList(state, data);
    } catch (err) {
      window.adminFeedbackPaintError(err);
    }
  }

  // ===== 详情与处理 =====
  async function openDetail(id) {
    var data;
    try {
      data = await apiJson('/api/admin/feedback/' + encodeURIComponent(id));
    } catch (err) {
      window.adminFeedbackToast(err.message);
      return;
    }
    state.detailId = id;
    state.detailRevision = data.feedback.revision;
    window.adminFeedbackPaintDetail(data);
  }

  async function saveDetail(id) {
    var payload = window.adminFeedbackReadDetailForm(state);
    if (!payload.expectedRevision) { window.adminFeedbackToast('缺少并发版本，请重新打开该反馈'); return; }
    try {
      await apiJson('/api/admin/feedback/' + encodeURIComponent(id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      window.adminFeedbackToast('已保存');
      window.closeAdminModal();
      renderAdminFeedback();
    } catch (err) {
      window.adminFeedbackToast(err.message);
    }
  }

  // 回复隐藏/恢复：取数与刷新在 Presenter；原因输入（弹窗）与事件解析在 View
  function commentAction(id, cid, hide, reason) {
    apiJson('/api/admin/feedback/' + encodeURIComponent(id) + '/comments/' + encodeURIComponent(cid), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: hide ? 'hide' : 'restore', reason: reason }),
    }).then(function () {
      window.adminFeedbackToast(hide ? '已隐藏' : '已恢复');
      openDetail(id);
      renderAdminFeedback();
    }).catch(function (err) { window.adminFeedbackToast(err.message); });
  }

  // 最小桥：View（含 HTML 与 window.renderAdminFeedback）经此转调取数；state 供事件绑定读写筛选
  window.adminFeedbackPresenter = {
    state: state,
    load: renderAdminFeedback,
    openDetail: openDetail,
    saveDetail: saveDetail,
    commentAction: commentAction
  };
})();
