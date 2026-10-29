// 反馈中心 Presenter（批次4：View／Presenter 分离）。
// 职责：持有子页/筛选/详情/表单状态与请求序号（state.seq）、经 siteApi 取数与提交，把数据交给 View 渲染。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       列表/详情/排名/版本 HTML、图片压缩、事件委托与表单在 feedback.js（View），
//       需要改界面时只调用 View 暴露的 window.feedback* 入口；View 不取数，只渲染并上报用户操作。
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第三、六节。
//       乱序响应不覆盖当前子页：每次加载领一个 state.seq 序号，回包时序号不一致直接丢弃。
//       地址栏读写（readUrl/syncUrl）随状态一并入 P，视窗地址不是 DOM 元素操作。
(function () {
  'use strict';

  var SUBS = ['all', 'mine', 'ranking', 'versions'];

  var state = {
    sub: 'versions',
    detailId: null,
    seq: 0,
    list: { page: 1, pageSize: 20, q: '', type: '', status: '', from: '', to: '', sort: 'created' },
    mine: { page: 1, pageSize: 20, status: '' },
    rank: { page: 1, pageSize: 20 },
    form: null,
    loaded: {}
  };

  // ---------- 地址栏 ----------
  function syncUrl(push) {
    var params = new URLSearchParams(window.location.search);
    params.set('main', 'feedback');
    params.set('sub', state.sub);
    if (state.detailId) params.set('feedback', state.detailId);
    else params.delete('feedback');
    var url = '/?' + params.toString();
    if (!push) return;
    if (window.location.pathname + window.location.search !== url) history.pushState(null, '', url);
  }

  function readUrl() {
    var params = new URLSearchParams(window.location.search);
    var sub = params.get('sub');
    // 默认落在「版本更新」：只看看版本改了什么，不默认把人丢进反馈列表（2026-10-25 反馈）
    state.sub = SUBS.indexOf(sub) >= 0 ? sub : 'versions';
    state.detailId = params.get('feedback') || null;
  }

  // ---------- 请求 ----------
  async function requestJson(url, options) {
    var res = await window.siteApi.request(url, options);
    if (!res.ok) {
      var msg = (res.payload && res.payload.error) || ('请求失败（' + res.status + '）');
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.payload || {};
  }

  function buildQuery(base) {
    var params = [];
    Object.keys(base).forEach(function (k) {
      var v = base[k];
      if (v === '' || v == null) return;
      params.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return params.length ? '?' + params.join('&') : '';
  }

  // ---------- 列表（全部 / 我的） ----------
  async function loadList() {
    if (!window.feedbackPaintListPrepare()) return;
    var isMine = state.sub === 'mine';
    var st = isMine ? state.mine : state.list;
    var seq = ++state.seq;
    try {
      var filter = isMine
        ? { status: st.status, page: st.page, pageSize: st.pageSize }
        : {
          q: st.q, type: st.type, status: st.status, from: st.from, to: st.to,
          sort: st.sort, page: st.page, pageSize: st.pageSize
        };
      var countFilter = Object.assign({}, filter);
      delete countFilter.page; delete countFilter.pageSize; delete countFilter.status;
      var results = await Promise.all([
        requestJson('/api/feedback' + (isMine ? '/mine' : '') + buildQuery(filter)),
        requestJson('/api/feedback/counts' + buildQuery(Object.assign({ scope: isMine ? 'mine' : 'public' }, countFilter))),
      ]);
      if (seq !== state.seq) return; // 乱序响应不覆盖当前子页
      window.feedbackPaintListResults(results, st);
    } catch (err) {
      if (seq !== state.seq) return;
      window.feedbackPaintListError(err);
    }
  }

  // ---------- 详情 ----------
  async function loadDetail() {
    if (!window.feedbackPaintDetailPrepare()) return;
    var seq = ++state.seq;
    try {
      var data = await requestJson('/api/feedback/' + encodeURIComponent(state.detailId));
      if (seq !== state.seq) return;
      window.feedbackPaintDetail(data);
    } catch (err) {
      if (seq !== state.seq) return;
      window.feedbackPaintDetailMissing();
    }
  }

  // ---------- 排名 ----------
  async function loadRanking() {
    if (!window.feedbackPaintRankingPrepare()) return;
    var seq = ++state.seq;
    try {
      var data = await requestJson('/api/feedback/ranking' + buildQuery(state.rank));
      if (seq !== state.seq) return;
      window.feedbackPaintRanking(data);
    } catch (err) {
      if (seq !== state.seq) return;
      window.feedbackPaintRankingError(err);
    }
  }

  // ---------- 版本更新 ----------
  async function loadVersions() {
    if (!window.feedbackPaintVersionsPrepare()) return;
    var seq = ++state.seq;
    var merged = [];
    var loadError = null;
    try {
      var res = await window.siteApi.get('/changelog.json');
      if (!res.ok) throw new Error('版本记录读取失败');
      merged = mergeChangelogByDate(res.payload);
    } catch (err) { loadError = err; }
    // 版本关联映射失败时不影响版本正文展示
    var linkMap = {};
    var linkNote = '';
    try {
      var versions = merged.map(function (d) { return d.version; }).filter(Boolean).slice(0, 50);
      if (versions.length) {
        var res = await requestJson('/api/feedback/version-links?versions=' + encodeURIComponent(versions.join(',')));
        linkMap = res.map || {};
      }
    } catch (e) {
      linkNote = '<p class="fb-upload-tip u-mb-12">关联反馈暂不可用，版本内容仍可正常查看。</p>';
    }
    if (seq !== state.seq) return;
    window.feedbackPaintVersions(merged, linkMap, linkNote, loadError);
  }

  // ---------- 提交 / 编辑表单 ----------
  async function submitForm() {
    if (!state.form || state.form.submitting) return;
    var form = state.form;
    var values = window.feedbackReadSubmitForm();
    var title = values.title;
    var description = values.description;
    var type = values.type;
    var pagePath = values.pagePath;
    if (!title.trim()) { window.feedbackToast('请填写标题'); return; }
    if (!description.trim()) { window.feedbackToast('请填写描述'); return; }
    window.feedbackBeginSubmit();
    form.submitting = true;
    try {
      if (form.mode === 'edit') {
        var result = await requestJson('/api/feedback/' + encodeURIComponent(form.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title, description: description, type: type, pagePath: pagePath, expectedRevision: form.revision }),
        });
        window.feedbackCloseForm(true);
        window.feedbackToast('已保存');
        state.detailId = String(form.id);
        await refreshCurrent();
        return;
      }
      var body = new FormData();
      body.append('type', type);
      body.append('title', title);
      body.append('description', description);
      body.append('pagePath', pagePath);
      body.append('visibility', window.feedbackReadVisibility());
      body.append('clientRequestId', form.requestId);
      form.files.forEach(function (f) { body.append('images', f); });
      var created = await requestJson('/api/feedback', { method: 'POST', body: body });
      var fromFab = form.source === 'fab';
      window.feedbackCloseForm(true);
      window.feedbackToast('已提交，感谢反馈');
      // 全局悬浮入口提交后停留当前页；反馈栏目内提交则落到「全部反馈」并打开新记录
      if (fromFab) return;
      // 不走 switchFeedbackSub（那里会清空 detailId）
      state.sub = 'all';
      state.detailId = String(created.id);
      window.feedbackRenderSubTabs();
      syncUrl(true);
      await loadDetail();
    } catch (err) {
      window.feedbackEndSubmit(form);
      form.submitting = false;
      window.feedbackToast(err.message || '提交失败，请重试');
    }
  }

  // ---------- 子页切换 ----------
  async function switchFeedbackSub(sub, noPush) {
    window.feedbackCloseForm();
    state.sub = SUBS.indexOf(sub) >= 0 ? sub : 'versions';
    state.detailId = null;
    if (!noPush) syncUrl(true);
    window.feedbackRenderSubTabs();
    await refreshCurrent();
  }

  async function refreshCurrent() {
    if (state.detailId) return loadDetail();
    if (state.sub === 'all') return loadList();
    if (state.sub === 'mine') return loadList();
    if (state.sub === 'ranking') return loadRanking();
    if (state.sub === 'versions') return loadVersions();
    return null;
  }

  // ---------- 详情动作 ----------
  async function detailAction(action, el) {
    var id = state.detailId;
    if (!id) return;
    var data = await requestJson('/api/feedback/' + encodeURIComponent(id));
    var revision = data.feedback.revision;
    if (action === 'withdraw') {
      if (!window.projectConfirm) return;
      if (!await window.projectConfirm('撤回后不再出现在公开列表和排名中，确定撤回？')) return;
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/withdraw', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      window.feedbackToast('已撤回');
      await loadDetail();
      return;
    }
    if (action === 'visibility') {
      var to = window.feedbackReadActionTo(el);
      if (to === 'public' && window.projectConfirm && !await window.projectConfirm('改为公开后所有人可见，确认？')) return;
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/visibility', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: to, expectedRevision: revision }),
      });
      window.feedbackToast(to === 'public' ? '已设为公开' : '已收为私密');
      await loadDetail();
      return;
    }
    if (action === 'complete-info') {
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/complete-info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      window.feedbackToast('已提交补充，状态回到未处理');
      await loadDetail();
      return;
    }
    if (action === 'edit') {
      window.feedbackOpenEditForm(data);
      return;
    }
    if (action === 'reply') {
      var content = window.feedbackReadReplyContent();
      if (content == null) return;
      var requestId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('c-' + Date.now());
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/comments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content, clientRequestId: requestId }),
      });
      window.feedbackToast('已回复');
      await loadDetail();
      return;
    }
    if (action === 'del-comment') {
      var cid = window.feedbackReadActionCid(el);
      if (window.projectConfirm && !await window.projectConfirm('删除后该回复正文不再展示，确认删除？')) return;
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/comments/' + encodeURIComponent(cid), { method: 'DELETE' });
      window.feedbackToast('已删除');
      await loadDetail();
      return;
    }
    if (action === 'del-shot') {
      var aid = window.feedbackReadActionAid(el);
      if (window.projectConfirm && !await window.projectConfirm('移除这张截图？移除后只有你和管理员还能看到。')) return;
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/attachments/' + encodeURIComponent(aid)
        + '?expectedRevision=' + encodeURIComponent(revision), { method: 'DELETE' });
      window.feedbackToast('截图已移除');
      await loadDetail();
      return;
    }
    if (action === 'add-shots') {
      var form = await window.feedbackBuildAttachForm(revision);
      if (!form) return;
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/attachments', { method: 'POST', body: form });
      window.feedbackToast('截图已追加');
      await loadDetail();
    }
  }

  // ---------- 对外入口 ----------
  // navigation.js 在栏目懒加载完成后经 window.initFeedbackSub 等入口调用（View 按原名转发至此）。
  function initFeedbackSub() {
    readUrl();
    window.feedbackRenderSubTabs();
    if (state.detailId) return loadDetail();
    return refreshCurrent();
  }

  // 最小桥：View（DOM、事件委托与表单）经此转调取数；state 供事件绑定读写子页与筛选。
  window.feedbackPresenter = {
    state: state,
    loadList: loadList,
    loadDetail: loadDetail,
    loadRanking: loadRanking,
    loadVersions: loadVersions,
    submitForm: submitForm,
    detailAction: detailAction,
    switchFeedbackSub: switchFeedbackSub,
    refreshCurrent: refreshCurrent,
    initFeedbackSub: initFeedbackSub,
    syncUrl: syncUrl
  };
})();
