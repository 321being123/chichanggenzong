// 后台站内通知群发 Presenter（批次4：View／Presenter 分离）。
// 职责：持有群发状态（anState，含批次分页/详情游标）、经 siteApi 取数与提交、把数据交给 View 渲染。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
// 契约见 docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.5 节。
var anState = {
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
  const result = await window.siteApi.requestRaw(path, Object.assign({ timeoutMs: 0 }, init));
  if (!result.response) throw new Error(result.error || '网络异常');
  const r = result.response;
  let payload = null;
  try { payload = await r.json(); } catch (e) { payload = null; }
  if (!r.ok) {
    const err = new Error((payload && payload.error) || ('请求失败（' + r.status + '）'));
    err.status = r.status;
    throw err;
  }
  return payload || {};
}

async function loadAnBatches() {
  try {
    const data = await anRequest('/api/admin/notifications/batches?page=' + anState.page
      + '&pageSize=' + anState.pageSize);
    anState.batches = data.items || [];
    window.anPaintBatches(data.total);
  } catch (e) {
    showToast('批次列表加载失败：' + e.message);
  }
}

async function adminNotifSearch() {
  anState.search.q = window.anReadSearchInput();
  if (!anState.search.q) { showToast('请输入用户名或昵称'); return; }
  try {
    const data = await anRequest('/api/admin/notifications/recipients?q='
      + encodeURIComponent(anState.search.q) + '&limit=20');
    anState.search.items = data.items || [];
    anState.search.total = data.total || 0;
    window.renderAdminNotifications();
  } catch (e) {
    showToast('搜索失败：' + e.message);
  }
}

async function adminNotifPreview() {
  const form = window.anReadComposeForm();
  const title = form.title;
  const body = form.body;
  if (!title) { showToast('请填写通知标题'); return; }
  try {
    const result = await anRequest('/api/admin/notifications/preview', {
      method: 'POST',
      body: {
        title: title,
        body: body,
        audienceMode: anState.mode,
        usernames: anState.mode === 'selected' ? anState.picked : undefined,
        filters: anState.mode === 'filter' ? window.anReadFilter() : undefined,
        clientRequestId: anUuid(),
      },
    });
    anState.preview = result;
    window.renderAdminNotifications();
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
    window.renderAdminNotifications(true);
    loadAnBatches();
  } catch (e) {
    showToast('发送失败：' + e.message);
  }
}

async function adminNotifDetail(id) {
  try {
    const data = await anRequest('/api/admin/notifications/batches/' + encodeURIComponent(id));
    anState.detailId = String(id);
    anState.detail = data;
    anState.detailItems = [];
    anState.detailCursor = null;
    window.openAdminModal('通知批次 #' + id, '<div id="an-detail-body">加载中…</div>', '', { wide: true });
    window.renderAnDetail();
    await loadAnDetailRecipients(true);
  } catch (e) {
    showToast('批次详情加载失败：' + e.message);
  }
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
    window.renderAnDetail();
  } catch (e) {
    showToast('收件记录加载失败：' + e.message);
  }
}

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
