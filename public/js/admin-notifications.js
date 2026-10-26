// ============== 后台站内通知群发（2026-10-25） ==============
// 契约见 docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.5 节。
// 首期仅系统管理员；只支持纯文本标题/正文，不接富文本、附件或任意外链。
// 约定：CSP 已关闭内联脚本属性，所有交互走 data-act 全局委托（shared/ui-actions.js）。
let anState = {
  mode: 'all',
  picked: [],          // 指定多人：已选账号
  search: { q: '', items: [], total: 0 },
  preview: null,       // 预览结果（batchId/revision/contentAudienceHash/snapshotCount）
  draft: {},          // 重绘时保留当前输入，只有清空或发送成功才重置
  page: 1,
  pageSize: 20,
  detailId: null,
  detail: null,
  detailItems: [],
  detailCursor: null,
};

const AN_STATUS_LABELS = {
  draft: '草稿', queued: '已排队', running: '投递中', partial: '部分完成',
  completed: '已完成', cancelled: '已取消',
};
const AN_MODE_LABELS = { all: '全发', selected: '指定多人', filter: '条件筛选' };
const AN_RECIPIENT_LABELS = { pending: '待处理', delivered: '已投递', skipped: '已跳过', failed: '失败' };

function anUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'an-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

async function anRequest(path, options) {
  const opt = options || {};
  const init = { method: opt.method || 'GET', headers: {} };
  if (opt.body != null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opt.body);
  }
  const r = await fetch(api(path), init);
  let payload = null;
  try { payload = await r.json(); } catch (e) { payload = null; }
  if (!r.ok) {
    const err = new Error((payload && payload.error) || ('请求失败（' + r.status + '）'));
    err.status = r.status;
    throw err;
  }
  return payload || {};
}

function anHost() { return document.getElementById('view-notifications'); }

function anComposeHtml() {
  return '<div class="an-card">'
    + '<h3 class="an-card-title">新建通知</h3>'
    + '<label class="an-field"><span>标题</span>'
    + '<input id="an-title" type="text" maxlength="100" placeholder="一句话说明这条通知（纯文本）"></label>'
    + '<label class="an-field"><span>正文</span>'
    + '<textarea id="an-body" rows="4" maxlength="2000" placeholder="纯文本正文，最多 2000 字"></textarea></label>'
    + '<div class="an-field"><span>发送范围</span><div class="an-mode-group">'
    + ['all', 'selected', 'filter'].map(function (m) {
      return '<button type="button" class="an-mode' + (anState.mode === m ? ' active' : '')
        + '" data-act="adminNotifMode" data-arg="' + m + '">' + AN_MODE_LABELS[m] + '</button>';
    }).join('')
    + '</div></div>'
    + (anState.mode === 'selected' ? anSelectedHtml() : '')
    + (anState.mode === 'filter' ? anFilterHtml() : '')
    + '<div class="an-actions">'
    + '<button type="button" class="btn btn-primary btn-sm" data-act="adminNotifPreview">预览名单</button>'
    + '<button type="button" class="btn btn-warning btn-sm" data-act="adminNotifSend"'
    + (anState.preview ? '' : ' disabled') + '>确认发送</button>'
    + '<button type="button" class="btn btn-outline btn-sm" data-act="adminNotifReset">清空</button>'
    + '</div>'
    + (anState.preview ? anPreviewHtml() : '')
    + '</div>';
}

function anSelectedHtml() {
  const picked = anState.picked.map(function (u) {
    return '<span class="an-chip">' + escapeHtml(u)
      + '<button type="button" aria-label="移除 ' + escapeHtml(u) + '" data-act="adminNotifRemove" data-arg="'
      + escapeHtml(u) + '">×</button></span>';
  }).join('');
  const rows = (anState.search.items || []).map(function (it) {
    return '<div class="an-user-row"><span>' + escapeHtml(it.username)
      + (it.nickname ? '（' + escapeHtml(it.nickname) + '）' : '')
      + '</span><button type="button" class="btn btn-outline btn-sm" data-act="adminNotifPick" data-arg="'
      + escapeHtml(it.username) + '">加入</button></div>';
  }).join('') || '<div class="an-hint">输入关键字后搜索账号</div>';
  return '<div class="an-field"><span>指定账号</span>'
    + '<div class="an-search">'
    + '<input id="an-search" type="text" maxlength="60" placeholder="用户名或昵称" value="'
    + escapeHtml(anState.search.q || '') + '">'
    + '<button type="button" class="btn btn-outline btn-sm" data-act="adminNotifSearch">搜索</button>'
    + '</div>'
    + '<div class="an-user-list">' + rows + '</div>'
    + '<div class="an-chips">' + (picked || '<span class="an-hint">尚未选择账号</span>') + '</div>'
    + '</div>';
}

function anFilterHtml() {
  return '<div class="an-field"><span>筛选条件</span><div class="an-filter-grid">'
    + '<label>角色<select id="an-f-role"><option value="">不限</option><option value="user">普通用户</option>'
    + '<option value="admin">管理员</option></select></label>'
    + '<label>注册起<input id="an-f-reg-from" type="date"></label>'
    + '<label>注册止<input id="an-f-reg-to" type="date"></label>'
    + '<label>最后登录起<input id="an-f-login-from" type="date"></label>'
    + '<label>最后登录止<input id="an-f-login-to" type="date"></label>'
    + '<label>登录情况<select id="an-f-ever"><option value="">不限</option><option value="1">曾登录</option>'
    + '<option value="0">从未登录</option></select></label>'
    + '<label>反馈情况<select id="an-f-feedback"><option value="">不限</option><option value="1">提交过反馈</option>'
    + '<option value="0">未提交过反馈</option></select></label>'
    + '</div><div class="an-hint">条件之间为“同时满足”；空日期不限制；分页不截断收件范围。</div></div>';
}

function anPreviewHtml() {
  const p = anState.preview;
  return '<div class="an-preview">'
    + '<div class="an-preview-line">预览结果：<strong>' + Number(p.snapshotCount || 0) + '</strong> 位收件人'
    + '（' + AN_MODE_LABELS[p.audienceMode] + '，批次 #' + escapeHtml(p.batchId) + '，修订 ' + escapeHtml(p.revision) + '）</div>'
    + (Number(p.snapshotCount || 0) === 0
      ? '<div class="an-warn">没有符合条件的账号，不能发送。</div>'
      : '<div class="an-hint">名单已在预览时固定；确认后新注册或新符合条件的账号不会追加。</div>')
    + '</div>';
}

function anTimeText(iso) {
  if (!iso) return '';
  if (typeof adminFmtTime === 'function') return adminFmtTime(iso);
  if (window.CoreDate && CoreDate.dateTimeInZone) {
    const t = CoreDate.dateTimeInZone(iso, 'Asia/Shanghai');
    if (t) return t;
  }
  return String(iso).replace('T', ' ').slice(0, 16);
}

function anBatchRowsHtml() {
  const items = anState.batches || [];
  return items.map(function (b) {
    return '<tr>'
      + '<td>' + escapeHtml(b.id) + '</td>'
      + '<td>' + escapeHtml(b.title) + '</td>'
      + '<td>' + escapeHtml(AN_MODE_LABELS[b.audienceMode] || b.audienceMode) + '</td>'
      + '<td><span class="an-status an-status--' + escapeHtml(b.status) + '">'
      + escapeHtml(AN_STATUS_LABELS[b.status] || b.status) + '</span></td>'
      + '<td>' + Number(b.snapshotCount) + ' / ' + Number(b.deliveredCount) + ' / '
      + Number(b.skippedCount) + ' / ' + Number(b.failedCount) + ' / ' + Number(b.pendingCount) + '</td>'
      + '<td>' + escapeHtml(anTimeText(b.createdAt)) + '</td>'
      + '<td class="an-ops">'
      + '<button type="button" class="btn btn-outline btn-sm" data-act="adminNotifDetail" data-arg="'
      + escapeHtml(b.id) + '">详情</button>'
      + (['partial', 'running', 'queued'].indexOf(b.status) >= 0
        ? '<button type="button" class="btn btn-outline btn-sm" data-act="adminNotifRetry" data-arg="'
          + escapeHtml(b.id) + '">重试</button>' : '')
      + (b.status === 'draft'
        ? '<button type="button" class="btn btn-outline btn-sm" data-act="adminNotifCancel" data-arg="'
          + escapeHtml(b.id) + '">取消</button>' : '')
      + '</td></tr>';
  }).join('') || '<tr><td colspan="7" class="biz-table-state-cell">暂无发送批次</td></tr>';
}

function anPagerHtml(total) {
  const totalPages = Math.max(Math.ceil((Number(total) || 0) / anState.pageSize), 1);
  return '<button type="button" class="btn btn-outline btn-sm" data-act="adminNotifPrev"'
    + (anState.page <= 1 ? ' disabled' : '') + '>上一页</button>'
    + '<span class="an-pager-info">第 ' + anState.page + ' / ' + totalPages + ' 页，共 '
    + Number(total || 0) + ' 条</span>'
    + '<button type="button" class="btn btn-outline btn-sm" data-act="adminNotifNext"'
    + (anState.page >= totalPages ? ' disabled' : '') + '>下一页</button>';
}

function anBatchesHtml() {
  return '<div class="an-card"><h3 class="an-card-title">发送批次</h3>'
    + '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table">'
    + '<thead><tr><th>批次</th><th>标题</th><th>范围</th><th>状态</th>'
    + '<th>快照/投递/跳过/失败/待处理</th><th>创建时间</th><th>操作</th></tr></thead>'
    + '<tbody class="an-batches-tbody">' + anBatchRowsHtml() + '</tbody></table></div>'
    + '<div class="earnings-pager" id="an-pager"></div></div>';
}

function renderAdminNotifications(resetDraft) {
  const el = anHost();
  if (!el) return;
  if (!adminProfile || adminProfile.role !== 'admin') {
    el.innerHTML = '<div class="an-card"><p class="an-hint">站内通知群发仅限系统管理员。</p></div>';
    return;
  }
  if (resetDraft === true) anState.draft = {};
  else el.querySelectorAll('#an-title, #an-body, [id^="an-f-"]').forEach(function (input) {
    anState.draft[input.id] = input.value;
  });
  el.innerHTML = anComposeHtml() + anBatchesHtml();
  Object.keys(anState.draft).forEach(function (id) {
    const input = document.getElementById(id);
    if (input && el.contains(input)) input.value = anState.draft[id];
  });
  bindAnEvents();
  loadAnBatches();
}

function anBindOnce() {
  const el = anHost();
  if (!el || el.__anBound) return;
  el.__anBound = true;
  el.addEventListener('input', function (e) {
    // 内容或范围一变，旧预览凭据立即失效（后端也会再校验）
    if (e.target && ['an-title', 'an-body'].indexOf(e.target.id) >= 0) anClearPreview();
  });
  el.addEventListener('change', function (e) {
    const id = e.target && e.target.id ? String(e.target.id) : '';
    if (id.indexOf('an-f-') === 0) anClearPreview();
  });
}
function bindAnEvents() { anBindOnce(); }

function anClearPreview() {
  if (!anState.preview) return;
  anState.preview = null;
  // 输入期间只撤销凭据，不能重建正在编辑的控件（否则会丢焦点与光标）。
  const host = anHost();
  const send = host && host.querySelector('[data-act="adminNotifSend"]');
  if (send) send.disabled = true;
  const preview = host && host.querySelector('.an-preview');
  if (preview) preview.remove();
}

async function loadAnBatches() {
  try {
    const data = await anRequest('/api/admin/notifications/batches?page=' + anState.page
      + '&pageSize=' + anState.pageSize);
    anState.batches = data.items || [];
    const tbody = document.querySelector('#view-notifications .an-batches-tbody');
    if (tbody) tbody.innerHTML = anBatchRowsHtml();
    const pager = document.getElementById('an-pager');
    if (pager) pager.innerHTML = anPagerHtml(data.total);
  } catch (e) {
    showToast('批次列表加载失败：' + e.message);
  }
}

async function adminNotifMode(v) {
  anState.mode = v;
  anState.preview = null;
  renderAdminNotifications();
}

async function adminNotifSearch() {
  const input = document.getElementById('an-search');
  anState.search.q = input ? input.value.trim() : '';
  if (!anState.search.q) { showToast('请输入用户名或昵称'); return; }
  try {
    const data = await anRequest('/api/admin/notifications/recipients?q='
      + encodeURIComponent(anState.search.q) + '&limit=20');
    anState.search.items = data.items || [];
    anState.search.total = data.total || 0;
    renderAdminNotifications();
  } catch (e) {
    showToast('搜索失败：' + e.message);
  }
}

function adminNotifPick(username) {
  if (!username) return;
  if (anState.picked.indexOf(username) < 0) anState.picked.push(username);
  anState.preview = null;
  renderAdminNotifications();
}

function adminNotifRemove(username) {
  anState.picked = anState.picked.filter(function (u) { return u !== username; });
  anState.preview = null;
  renderAdminNotifications();
}

function anReadFilter() {
  const val = function (id) { const el = document.getElementById(id); return el ? el.value : ''; };
  const boolOf = function (v) { return v === '' ? null : v === '1'; };
  return {
    role: val('an-f-role') || '',
    registeredFrom: val('an-f-reg-from') || '',
    registeredTo: val('an-f-reg-to') || '',
    lastLoginFrom: val('an-f-login-from') || '',
    lastLoginTo: val('an-f-login-to') || '',
    everLoggedIn: boolOf(val('an-f-ever')),
    submittedFeedback: boolOf(val('an-f-feedback')),
  };
}

async function adminNotifPreview() {
  const titleEl = document.getElementById('an-title');
  const bodyEl = document.getElementById('an-body');
  const title = titleEl ? titleEl.value.trim() : '';
  const body = bodyEl ? bodyEl.value : '';
  if (!title) { showToast('请填写通知标题'); return; }
  try {
    const result = await anRequest('/api/admin/notifications/preview', {
      method: 'POST',
      body: {
        title: title,
        body: body,
        audienceMode: anState.mode,
        usernames: anState.mode === 'selected' ? anState.picked : undefined,
        filters: anState.mode === 'filter' ? anReadFilter() : undefined,
        clientRequestId: anUuid(),
      },
    });
    anState.preview = result;
    renderAdminNotifications();
    showToast('预览完成：' + Number(result.snapshotCount || 0) + ' 位收件人');
  } catch (e) {
    showToast('预览失败：' + e.message);
  }
}

async function adminNotifSend() {
  if (!anState.preview) { showToast('请先预览名单'); return; }
  if (!(Number(anState.preview.snapshotCount) > 0)) { showToast('没有符合条件的账号，不能发送'); return; }
  if (typeof projectConfirm === 'function') {
    const ok = await projectConfirm('确认向 ' + anState.preview.snapshotCount + ' 位收件人发送这条通知？确认后内容与名单冻结。');
    if (!ok) return;
  }
  try {
    await anRequest('/api/admin/notifications/batches/' + encodeURIComponent(anState.preview.batchId) + '/send', {
      method: 'POST',
      body: {
        revision: anState.preview.revision,
        contentAudienceHash: anState.preview.contentAudienceHash,
        clientRequestId: anUuid(),
      },
    });
    showToast('已进入投递队列，可在批次列表查看进度');
    anState.preview = null;
    renderAdminNotifications(true);
    loadAnBatches();
  } catch (e) {
    showToast('发送失败：' + e.message);
  }
}

function adminNotifReset() {
  anState.mode = 'all';
  anState.picked = [];
  anState.search = { q: '', items: [], total: 0 };
  anState.preview = null;
  renderAdminNotifications(true);
}

async function adminNotifDetail(id) {
  try {
    const data = await anRequest('/api/admin/notifications/batches/' + encodeURIComponent(id));
    anState.detailId = String(id);
    anState.detail = data;
    anState.detailItems = [];
    anState.detailCursor = null;
    openAdminModal('通知批次 #' + id, '<div id="an-detail-body">加载中…</div>', '', { wide: true });
    renderAnDetail();
    await loadAnDetailRecipients(true);
  } catch (e) {
    showToast('批次详情加载失败：' + e.message);
  }
}

function renderAnDetail() {
  const host = document.getElementById('an-detail-body');
  if (!host) return;
  const d = anState.detail;
  if (!d) { host.innerHTML = '<p class="an-hint">加载中…</p>'; return; }
  const b = d.batch;
  const c = d.counts;
  const rows = anState.detailItems.map(function (r) {
    return '<tr><td>' + escapeHtml(r.id) + '</td>'
      + '<td>' + escapeHtml(r.recipientUsername || '（已注销）') + '</td>'
      + '<td>' + escapeHtml(AN_RECIPIENT_LABELS[r.status] || r.status) + '</td>'
      + '<td>' + escapeHtml(r.skipReason || r.lastError || '') + '</td>'
      + '<td>' + escapeHtml(r.deliveredAt ? String(r.deliveredAt).slice(0, 16) : '') + '</td>'
      + '<td>' + escapeHtml(r.readAt ? String(r.readAt).slice(0, 16) : '未读') + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="biz-table-state-cell">暂无收件记录</td></tr>';
  host.innerHTML = '<div class="an-detail">'
    + '<div class="an-detail-line"><strong>' + escapeHtml(b.title) + '</strong>（'
    + escapeHtml(AN_MODE_LABELS[b.audienceMode] || b.audienceMode) + '）</div>'
    + '<div class="an-detail-line">状态：' + escapeHtml(AN_STATUS_LABELS[b.status] || b.status)
    + '　修订：' + escapeHtml(b.revision)
    + '　槽位：' + escapeHtml(b.dispatchSlotId || '未建立')
    + '　代次：' + Number(b.dispatchGeneration || 0)
    + '　扫描轮次：' + Number(b.scanRound || 0) + '</div>'
    + '<div class="an-detail-line">快照 ' + Number(c.total) + ' / 投递 ' + Number(c.delivered)
    + ' / 跳过 ' + Number(c.skipped) + ' / 失败 ' + Number(c.failed)
    + ' / 待处理 ' + Number(c.pending) + ' / 已读 ' + Number(c.read)
    + (d.countsMatch ? '' : '（缓存计数与实际不一致，以实际为准）') + '</div>'
    + '<div class="admin-table-wrap biz-table-scroll"><table class="biz-table">'
    + '<thead><tr><th>编号</th><th>收件账号</th><th>状态</th><th>原因/错误</th><th>投递时间</th><th>阅读</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>'
    + '<div class="an-actions">'
    + '<button type="button" class="btn btn-outline btn-sm" data-act="adminNotifDetailMore">加载更多收件人</button>'
    + '</div></div>';
}

async function loadAnDetailRecipients(reset) {
  if (!anState.detailId) return;
  if (reset) { anState.detailItems = []; anState.detailCursor = null; }
  try {
    const data = await anRequest('/api/admin/notifications/batches/'
      + encodeURIComponent(anState.detailId) + '/recipients?limit=50'
      + (anState.detailCursor ? '&cursor=' + encodeURIComponent(anState.detailCursor) : ''));
    anState.detailItems = anState.detailItems.concat(data.items || []);
    anState.detailCursor = data.nextCursor || null;
    renderAnDetail();
  } catch (e) {
    showToast('收件记录加载失败：' + e.message);
  }
}

function adminNotifDetailMore() { loadAnDetailRecipients(false); }

async function adminNotifRetry(id) {
  try {
    const result = await anRequest('/api/admin/notifications/batches/' + encodeURIComponent(id) + '/retry', {
      method: 'POST', body: { clientRequestId: anUuid() },
    });
    showToast(result.merged ? '已有投递任务在执行，已合并请求' : '已重新排队，只处理未完成收件');
    loadAnBatches();
  } catch (e) {
    showToast('重试失败：' + e.message);
  }
}

async function adminNotifCancel(id) {
  if (typeof projectConfirm === 'function') {
    const ok = await projectConfirm('取消这条通知草稿？取消后不能恢复。');
    if (!ok) return;
  }
  try {
    await anRequest('/api/admin/notifications/batches/' + encodeURIComponent(id) + '/cancel', {
      method: 'POST', body: { clientRequestId: anUuid() },
    });
    showToast('草稿已取消');
    loadAnBatches();
  } catch (e) {
    showToast('取消失败：' + e.message);
  }
}

function adminNotifPrev() { anState.page = Math.max(anState.page - 1, 1); loadAnBatches(); }
function adminNotifNext() { anState.page += 1; loadAnBatches(); }

window.renderAdminNotifications = renderAdminNotifications;
