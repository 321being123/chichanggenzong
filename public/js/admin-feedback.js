// ========== 后台反馈管理（2026-10-23） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第四、六节。
// 只负责展示与提交，权限由后端按 content_manage 校验；状态规则与事件留痕在 feedbackService。
(function () {
  'use strict';

  var TYPE_LABELS = { bug: '错误', improvement: '改进', feature: '需求' };
  var STATUS_LABELS = {
    new: '未处理', needs_info: '待补充', accepted: '已采纳', in_progress: '进行中',
    implemented: '已实施', duplicate: '重复', declined: '不采纳'
  };
  var STATUS_ORDER = ['new', 'needs_info', 'accepted', 'in_progress', 'implemented', 'duplicate', 'declined'];
  var state = { page: 1, pageSize: 20, status: '', type: '', author: '', q: '', from: '', to: '', detailId: null, data: null };

  function esc(v) { return escapeHtml(String(v == null ? '' : v)); }
  function byId(id) { return document.getElementById(id); }
  function fmtTime(iso) {
    if (!iso) return '';
    if (window.CoreDate && CoreDate.dateTimeInZone) {
      var t = CoreDate.dateTimeInZone(iso, 'Asia/Shanghai');
      if (t) return t;
    }
    return String(iso).replace('T', ' ').slice(0, 16);
  }
  function toast(msg) { if (typeof showToast === 'function') showToast(msg); }

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
    var el = byId('view-feedback');
    if (!el) return;
    el.innerHTML = '<div class="admin-placeholder">加载中…</div>';
    try {
      var data = await apiJson('/api/admin/feedback' + query());
      state.data = data;
      var html = '<div class="filter-bar">'
        + '<input id="fba-q" placeholder="搜索标题或内容" value="' + esc(state.q) + '" data-style="min-width:180px">'
        + '<select id="fba-status"><option value="">全部状态</option>' + STATUS_ORDER.map(function (s) {
          return '<option value="' + esc(s) + '"' + (state.status === s ? ' selected' : '') + '>' + esc(STATUS_LABELS[s]) + '</option>';
        }).join('') + '</select>'
        + '<select id="fba-type"><option value="">全部类型</option>' + Object.keys(TYPE_LABELS).map(function (t) {
          return '<option value="' + esc(t) + '"' + (state.type === t ? ' selected' : '') + '>' + esc(TYPE_LABELS[t]) + '</option>';
        }).join('') + '</select>'
        + '<input id="fba-author" placeholder="提交人账号" value="' + esc(state.author) + '">'
        + '<input type="date" id="fba-from" value="' + esc(state.from) + '">'
        + '<input type="date" id="fba-to" value="' + esc(state.to) + '">'
        + '<button type="button" class="btn btn-primary" data-fbadmin-act="search">查询</button>'
        + '<button type="button" class="btn btn-outline" data-fbadmin-act="reset">重置</button>'
        + '</div>';

      if (!data.items || !data.items.length) {
        html += '<div class="admin-placeholder">没有符合条件的反馈</div>';
        el.innerHTML = html;
        return;
      }
      html += '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table"><thead><tr>'
        + '<th>编号</th><th>类型</th><th>标题</th><th>状态</th><th>提交人</th><th>范围</th><th>回复</th><th>提交时间</th><th>实施版本</th><th>操作</th>'
        + '</tr></thead><tbody>';
      data.items.forEach(function (it) {
        // 类型/状态/范围与前台反馈列表同一 badge 视觉（fb-badge），短列 nowrap 对齐后台其他表格
        var scope = '<span class="fb-badge fb-badge--accepted">公开</span>';
        if (it.visibility === 'private') scope = '<span class="fb-badge fb-badge--private">私密</span>';
        if (it.moderation === 'hidden') scope += '<span class="fb-badge fb-badge--withdrawn">已隐藏</span>';
        if (it.withdrawnAt) scope += '<span class="fb-badge fb-badge--withdrawn">已撤回</span>';
        html += '<tr>'
          + '<td class="biz-table-nowrap">' + esc(it.id) + '</td>'
          + '<td class="biz-table-nowrap"><span class="fb-badge fb-badge--' + esc(it.type) + '">' + esc(TYPE_LABELS[it.type] || it.type) + '</span></td>'
          + '<td>' + esc(it.title) + '</td>'
          + '<td class="biz-table-nowrap"><span class="fb-badge fb-badge--' + esc(it.status) + '">' + esc(STATUS_LABELS[it.status] || it.status) + '</span></td>'
          + '<td class="biz-table-nowrap">' + esc(it.nickname) + '</td>'
          + '<td class="biz-table-nowrap">' + scope + '</td>'
          + '<td class="biz-table-nowrap">' + (it.commentCount || 0) + '</td>'
          + '<td class="biz-table-nowrap">' + esc(fmtTime(it.createdAt)) + '</td>'
          + '<td class="biz-table-nowrap">' + esc(it.implementedVersion || '-') + '</td>'
          + '<td class="biz-table-nowrap"><button type="button" class="btn btn-outline btn-xs" data-fbadmin-act="detail" data-id="' + esc(it.id) + '">处理</button></td>'
          + '</tr>';
      });
      html += '</tbody></table></div>';
      var pageCount = Math.max(1, Math.ceil((data.total || 0) / state.pageSize));
      html += '<div class="fb-pager">'
        + '<button type="button" class="btn btn-outline btn-sm" data-fbadmin-act="page" data-page="' + (state.page - 1) + '"' + (state.page <= 1 ? ' disabled' : '') + '>上一页</button>'
        + '<span>第 ' + state.page + ' / ' + pageCount + ' 页（共 ' + data.total + ' 条）</span>'
        + '<button type="button" class="btn btn-outline btn-sm" data-fbadmin-act="page" data-page="' + (state.page + 1) + '"' + (state.page >= pageCount ? ' disabled' : '') + '>下一页</button></div>';
      el.innerHTML = html;
    } catch (err) {
      el.innerHTML = '<div class="admin-placeholder">加载失败：' + esc(err.message) + '</div>';
    }
  }

  // ===== 详情与处理 =====
  async function openDetail(id) {
    var data;
    try {
      data = await apiJson('/api/admin/feedback/' + encodeURIComponent(id));
    } catch (err) {
      toast(err.message);
      return;
    }
    state.detailId = id;
    state.detailRevision = data.feedback.revision;
    var fb = data.feedback;
    var html = '<div class="fb-detail-body" data-style="max-height:200px;overflow:auto">' + esc(fb.description) + '</div>'
      + '<div class="fb-card-meta"><span>' + esc(fb.nickname) + '</span><span>' + esc(fmtTime(fb.createdAt)) + '</span>'
      + '<span>编号 #' + esc(fb.id) + '</span><span>revision ' + esc(fb.revision) + '</span>'
      + (fb.pagePath ? '<span>' + esc(fb.pagePath) + '</span>' : '') + '</div>';

    if (fb.attachments && fb.attachments.length) {
      html += '<div class="fb-detail-shots">' + fb.attachments.map(function (a) {
        var label = a.removedAt ? '（已移除）' : '';
        var src = a.removedAt
          ? api('/api/feedback/' + fb.id + '/attachments/' + a.id + '/history')
          : api('/api/feedback/attachments/' + a.id);
        return '<a href="' + esc(src) + '" target="_blank" rel="noopener"><img src="' + esc(src) + '" alt="截图" loading="lazy">'
          + '</a><span class="fb-upload-tip">#' + esc(a.id) + label + '</span>';
      }).join('') + '</div>';
    }

    // 回复（含隐藏/恢复）
    html += '<div class="fb-section-title">回复</div>';
    if (!data.comments || !data.comments.length) html += '<p class="fb-upload-tip">暂无回复</p>';
    (data.comments || []).forEach(function (c) {
      html += '<div class="fb-reply' + (c.hidden || c.deleted ? ' is-hidden' : '') + '">'
        + '<div class="fb-reply-head"><span class="fb-reply-author">' + esc(c.nickname) + '</span>'
        + (c.isOfficial ? '<span class="fb-badge fb-badge--accepted">官方</span>' : '')
        + '<span>' + esc(fmtTime(c.createdAt)) + '</span>'
        + (c.deleted ? '<span>已删除</span>' : '') + (c.hidden ? '<span>已隐藏</span>' : '')
        + '<button type="button" class="btn btn-outline btn-xs" data-fbadmin-act="comment-' + (c.hidden ? 'restore' : 'hide')
        + '" data-cid="' + esc(c.id) + '">' + (c.hidden ? '恢复' : '隐藏') + '</button>'
        + '</div>'
        + (c.hidden || c.deleted ? '' : '<div class="fb-reply-body">' + esc(c.content) + '</div>')
        + '</div>';
    });

    // 处理表单
    html += '<div class="fb-section-title">处理</div><div class="fb-form">'
      + '<label class="fb-field"><span>类型</span><select id="fba-form-type">'
      + Object.keys(TYPE_LABELS).map(function (t) {
        return '<option value="' + esc(t) + '"' + (fb.type === t ? ' selected' : '') + '>' + esc(TYPE_LABELS[t]) + '</option>';
      }).join('') + '</select></label>'
      + '<label class="fb-field"><span>状态</span><select id="fba-form-status">'
      + STATUS_ORDER.map(function (s) {
        return '<option value="' + esc(s) + '"' + (fb.status === s ? ' selected' : '') + '>' + esc(STATUS_LABELS[s]) + '</option>';
      }).join('') + '</select></label>'
      + '<label class="fb-field"><span>发布批次编号（标记「已实施」时必填）</span>'
      + '<input type="text" id="fba-form-run" value="" placeholder="如 3">'
      + '<small>版本与发布提交由批次自动带出；没有通过专项验收的批次不能关闭反馈。'
      + (fb.implementedVersion ? '当前记录已随 ' + esc(fb.implementedVersion) + ' 关闭。' : '') + '</small></label>'
      + '<label class="fb-field"><span>重复关联主反馈编号（标记重复时必填）</span>'
      + '<input type="text" id="fba-form-duplicate" value="' + esc(fb.duplicateOf || '') + '" placeholder="如 12"></label>'
      + '<label class="fb-field"><span>可见/隐藏</span><select id="fba-form-moderation">'
      + '<option value="normal"' + (fb.moderation === 'normal' ? ' selected' : '') + '>正常展示</option>'
      + '<option value="hidden"' + (fb.moderation === 'hidden' ? ' selected' : '') + '>隐藏（需填原因）</option>'
      + '</select></label>'
      + '<label class="fb-field"><span>处理原因 / 说明</span>'
      + '<textarea id="fba-form-reason" maxlength="500" data-style="min-height:80px" placeholder="待补充、重复、不采纳、重新打开或隐藏时必须填写"></textarea></label>'
      + '</div>';

    // 处理历史（内部证据仅管理端可见）
    if (data.events && data.events.length) {
      html += '<div class="fb-section-title">处理历史</div><ul class="fb-timeline">'
        + data.events.map(function (e) {
          return '<li><time>' + esc(fmtTime(e.createdAt)) + '</time>' + esc(e.eventType)
            + (e.summary ? ' · ' + esc(e.summary) : '') + (e.note ? '：' + esc(e.note) : '') + '</li>';
        }).join('') + '</ul>';
    }

    openAdminModal('反馈 #' + fb.id + '　' + fb.title, html,
      '<button type="button" class="btn btn-outline" data-act="closeAdminModal">关闭</button>'
      + '<button type="button" class="btn btn-primary" data-fbadmin-act="save" data-id="' + esc(fb.id) + '">保存处理</button>',
      { wide: true });
  }

  async function saveDetail(id) {
    var payload = {
      expectedRevision: state.detailRevision,
      type: (byId('fba-form-type') || {}).value,
      moderation: (byId('fba-form-moderation') || {}).value,
      reason: (byId('fba-form-reason') || {}).value,
      releaseRunId: (byId('fba-form-run') || {}).value || null,
      duplicateOf: (byId('fba-form-duplicate') || {}).value,
    };
    var statusEl = byId('fba-form-status');
    if (statusEl) payload.status = statusEl.value;
    if (!payload.expectedRevision) { toast('缺少并发版本，请重新打开该反馈'); return; }
    try {
      await apiJson('/api/admin/feedback/' + encodeURIComponent(id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast('已保存');
      closeAdminModal();
      renderAdminFeedback();
    } catch (err) {
      toast(err.message);
    }
  }

  // ===== 事件委托 =====
  function bind() {
    if (window.__fbAdminReady) return;
    window.__fbAdminReady = true;
    document.addEventListener('click', async function (e) {
      var el = e.target.closest('[data-fbadmin-act]');
      if (!el) return;
      var act = el.getAttribute('data-fbadmin-act');
      if (act === 'search') {
        state.q = (byId('fba-q') || {}).value || '';
        state.status = (byId('fba-status') || {}).value || '';
        state.type = (byId('fba-type') || {}).value || '';
        state.author = (byId('fba-author') || {}).value || '';
        state.from = (byId('fba-from') || {}).value || '';
        state.to = (byId('fba-to') || {}).value || '';
        state.page = 1;
        renderAdminFeedback();
        return;
      }
      if (act === 'reset') {
        state = Object.assign(state, { page: 1, status: '', type: '', author: '', q: '', from: '', to: '' });
        renderAdminFeedback();
        return;
      }
      if (act === 'page') {
        state.page = Math.max(1, parseInt(el.getAttribute('data-page'), 10) || 1);
        renderAdminFeedback();
        return;
      }
      if (act === 'detail') { openDetail(el.getAttribute('data-id')); return; }
      if (act === 'save') { saveDetail(el.getAttribute('data-id')); return; }
      if (act === 'comment-hide' || act === 'comment-restore') {
        var cid = el.getAttribute('data-cid');
        var id = state.detailId;
        var hide = act === 'comment-hide';
        var reason = '';
        if (hide) {
          reason = (window.projectPrompt ? (await window.projectPrompt('隐藏原因（必填）')) : '') || '';
          if (!String(reason).trim()) { toast('隐藏必须填写原因'); return; }
        }
        apiJson('/api/admin/feedback/' + encodeURIComponent(id) + '/comments/' + encodeURIComponent(cid), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: hide ? 'hide' : 'restore', reason: reason }),
        }).then(function () {
          toast(hide ? '已隐藏' : '已恢复');
          openDetail(id);
          renderAdminFeedback();
        }).catch(function (err) { toast(err.message); });
      }
    });
  }

  window.renderAdminFeedback = function () { bind(); return renderAdminFeedback(); };
})();
