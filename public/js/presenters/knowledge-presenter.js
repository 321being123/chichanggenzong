// 知识分享 Presenter（批次4：View／Presenter 分离）。
// 职责：持有 ksState（阅读意图 readingId 与请求状态）、取数协调（window.siteApi）与写操作编排。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的 window.ks* 入口；View 不取数，只渲染并上报用户操作。
let ksState = {
  categories: [],
  articles: [],
  loaded: false,   // 已完成一次进入页面的数据加载；返回本页不再全量重拉（2026-10-21 审查 U-3）
  readingId: null, // 阅读意图：打开文章时立即置位，防止并行的 loadKnowledge 把用户踢回列表
  commentsSeq: 0,  // 评论列表请求序号：切文章后旧请求的响应不得画到当前页面
  articleSeq: 0,   // 文章页面实例序号：每次打开自增，A→B→A 也算新页面
  currentCategory: null,
  currentArticle: null,
  editingId: null,   // 正在编辑的文章 id（新建为 null）
  editingStatus: 'draft',
  vditor: null,
  vditorReady: null,
  canWrite: false,   // 当前用户是否有写权限
  isAdmin: false,
  categoryActionId: null,
  categoryActionMode: null,
  draggedCategoryId: null,
  draggedArticleId: null,
  articleDragOriginalOrder: [],
};

// 写操作失败的统一友好提示（不回显服务器内部错误）
function ksWriteErrMsg(status) {
  if (status === 401) return '请先登录后再操作';
  if (status === 403) return '你没有权限执行此操作';
  if (status === 404) return '内容不存在或已被删除';
  if (status === 413) return '内容过大，请精简后重试';
  return '操作失败，请稍后重试';
}

// 分类树纯查询（Presenter 编排与 View 渲染共用）
function ksFindCategory(nodes, id) {
  for (const node of (nodes || [])) {
    if (node.id === id) return node;
    const child = ksFindCategory(node.children, id);
    if (child) return child;
  }
  return null;
}

// ---------- 初始化（每次进入知识分享时调用） ----------
async function loadKnowledge(force) {
  // 已加载且非强制：保留阅读/编辑上下文，不全量重拉、不强制踢回列表（2026-10-21 审查 U-3）
  if (ksState.loaded && !force) return;
  try {
    const [catRes, listRes, meRes] = await Promise.all([
      window.siteApi.get('/api/knowledge/categories').then(r => r.payload),
      window.siteApi.get('/api/knowledge/articles').then(r => r.payload),
      username ? window.siteApi.get('/api/knowledge/can-write').then(r => r.payload || { canWrite: false }) : Promise.resolve({ canWrite: false }),
    ]);
    ksState.categories = Array.isArray(catRes) ? catRes : [];
    ksState.articles = Array.isArray(listRes) ? listRes : [];
    ksState.canWrite = !!(meRes && meRes.canWrite);
    ksState.isAdmin = !!(meRes && meRes.isAdmin);
    window.ksApplyAccessUI();
    window.ksRenderTree();
    window.ksRenderList();
    ksState.loaded = true;
    if (!ksState.readingId) window.ksShowView('list');
    if (window.SiteTelemetry) window.SiteTelemetry.trackPage('knowledge.list', 'knowledge', 'nav');
  } catch (e) {
    showToast('投资笔记加载失败: ' + (e.message || e));
  }
}

async function ksLoadArticles() {
  let url = '/api/knowledge/articles';
  const params = [];
  if (ksState.currentCategory) params.push('category_id=' + ksState.currentCategory);
  const query = window.ksReadListQuery();
  if (username) {
    if (query.status) params.push('status=' + query.status);
  }
  if (query.q) params.push('q=' + encodeURIComponent(query.q));
  if (params.length) url += '?' + params.join('&');
  try {
    const r = await window.siteApi.get(url);
    if (!r.ok) throw new Error('接口返回 ' + r.status);
    const data = r.payload;
    ksState.articles = Array.isArray(data) ? data : [];
    window.ksRenderList();
  } catch (e) {
    // 搜索/分类切换分支失败时保留原列表并提示，不再无声卡死（2026-10-21 审查 U-1）
    showToast('文章列表加载失败: ' + (e.message || e));
  }
}

async function ksSaveArticleOrder() {
  const articleIds = window.ksReadArticleOrder();
  try {
    const r = await window.siteApi.put('/api/knowledge/articles/reorder', { category_id: ksState.currentCategory, article_ids: articleIds });
    if (!r.ok) { showToast((r.payload || {}).error || '排序保存失败'); await ksLoadArticles(); return false; }
    showToast('排序已保存');
    return true;
  } catch (e) {
    showToast('排序保存失败');
    await ksLoadArticles();
    return false;
  }
}

async function ksCardOp(act, id) {
  if (act === 'edit') { ksOpenEditor(id); return; }
  if (act === 'del') {
    await ksDeleteArticle(id);
    return;
  }
  try {
    const path = act === 'publish' ? '/publish' : '/unpublish';
    const r = await window.siteApi.post('/api/knowledge/articles/' + id + path, {});
    if (!r.ok) { showToast(r.status ? ksWriteErrMsg(r.status) : '网络异常，请检查后重试'); return; }
    const d = r.payload || {};
    showToast(act === 'publish' && d.share_token ? '已发布，分享链接已生成' : '已撤回为草稿');
    await ksLoadArticles();
  } catch (e) {
    showToast('网络异常，请检查后重试');
  }
}

// ---------- 阅读视图 ----------
// focusCommentId：评论通知深链带来的目标评论，加载完成后定位；缺失（已删除/无权）提示内容已不可用
async function ksOpenArticle(id, focusCommentId) {
  ksState.readingId = id;
  // 每次打开都是一个新页面实例：A→B→再回 A 时编号虽相同，旧的评论请求/结果也不得作用在这里
  ksState.articleSeq++;
  const r = await window.siteApi.get('/api/knowledge/articles/' + id);
  if (!r.ok) {
    ksState.readingId = null;
    showToast(focusCommentId ? '内容已不可用' : '文章不存在或未发布');
    return false;
  }
  const a = r.payload || {};
  ksState.currentArticle = a;
  if (window.SiteTelemetry) {
    window.SiteTelemetry.trackPage('knowledge.detail', 'knowledge', 'article');
    window.SiteTelemetry.trackEvent('detail_open', { page_key: 'knowledge.detail', module: 'knowledge', entry: 'list', properties: { detail_type: 'article' } });
  }
  // 阅读量 +1
  window.siteApi.post('/api/knowledge/articles/' + id + '/view', {});
  window.ksPaintArticle(a);
  window.ksShowView('read');
  await ksLoadComments(id);
  // 有结果未确认的提交时，把正文与 @ 选择还原成草稿（刷新后也能原样重试，不会重复发布）
  ksResumePendingComment(id);
  if (focusCommentId) {
    const found = window.ksFocusComment(String(focusCommentId));
    if (!found) { showToast('内容已不可用'); return false; }
  }
  return true;
}

async function ksDeleteArticle(id) {
  if (!await projectConfirm('确定删除这篇文章？', { title: '删除文章', confirmText: '删除', danger: true })) return;
  // 入口不抛错：网络异常表现为 status 0，提示文案与原来的 catch 一致。
  const r = await window.siteApi.del('/api/knowledge/articles/' + id);
  if (!r.ok) { showToast(r.status ? ksWriteErrMsg(r.status) : '网络异常，请检查后重试'); return; }
  showToast('已删除');
  window.ksShowView('list');
  ksLoadArticles();
}

// ---------- 评论（楼中楼嵌套） ----------
// 列表请求是异步的：返回时用户可能已经切到别的文章，必须按序号与目标文章双重校验，
// 否则上一篇文章的评论会被画到当前页面上（正在看 B，却显示 A 的评论）。
async function ksLoadComments(id) {
  const seq = ++ksState.commentsSeq;
  if (!window.ksPaintCommentsPrepare()) return;
  const r = await window.siteApi.get('/api/knowledge/articles/' + id + '/comments');
  if (seq !== ksState.commentsSeq) return;
  if (!ksStillOnArticle(id)) return;
  const list = r.payload || [];
  window.ksPaintComments(list);
}

// 评论删除按钮的请求段（DOM 绑定在 View 的 ksPaintComments）
async function ksDeleteComment(commentId) {
  if (!await projectConfirm('确定删除这条评论？', { title: '删除评论', confirmText: '删除', danger: true })) return;
  try {
    const r = await window.siteApi.del('/api/knowledge/comments/' + commentId);
    if (!r.ok) { showToast(r.status ? ksWriteErrMsg(r.status) : '网络异常，请检查后重试'); return; }
    showToast('已删除');
    ksLoadComments(ksState.currentArticle.id);
  } catch (e) {
    showToast('网络异常，请检查后重试');
  }
}

// 待确认的评论提交：必须整份保存「正文 + @ 目标 + 编号」，不能只存编号。
// 只存编号会有两个漏洞：①用户改了 @ 却仍复用原编号，服务端按请求摘要判定为「同标识不同内容」返回 409，
// 前端若随后丢掉编号重发，就可能出现第二条评论；②刷新后没有 @ 目标，无法把选择还回输入框。
// 规则：结果未确认期间只允许「原样重试」（服务端按编号幂等返回原评论），要改内容需先放弃这条。
const KS_PENDING_KEY = 'ks-pending-comments';
const KS_PENDING_MAX = 10;

function ksNewRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// 待确认记录的权威副本放在页面内存里，sessionStorage 只做「跨刷新」的持久化副本。
// 存储被禁用/隐私模式/配额满时读写都会抛错，此时必须仍然保留内存副本，
// 否则「结果不明 → 重试」会拿到新标识，服务端无法幂等，变成第二条评论和通知。
let ksPendingComments = null;

function ksPendingStore() {
  if (ksPendingComments) return ksPendingComments;
  ksPendingComments = {};
  let dropped = 0;
  try {
    const raw = sessionStorage.getItem(KS_PENDING_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      Object.keys(parsed).forEach(function (k) {
        const record = parsed[k];
        // 只认「写入时身份可确认」的记录：更早版本没有 persistable 标记，
        // 其键可能在身份缺失时退化成 u:用户名|id:，载入就会把旧账号草稿恢复给同名新账号。
        if (record && record.id && record.persistable === true) {
          ksPendingComments[k] = record;
        } else {
          dropped++;
        }
      });
    }
  } catch (e) { /* 存储不可用：只用内存副本 */ }
  // 丢弃了遗留记录就顺手把存储洗干净，避免每次载入都再判一次
  if (dropped) ksPersistPendingStore();
  return ksPendingComments;
}

// 返回是否真的写进了会话存储：写不进去（隐私模式/配额满）时内存副本仍有效，但刷新后会丢，
// 提交结果不明时必须据此告诉用户「不要刷新」。
// 这里不再按数量截断：静默删掉最早一条会丢掉它的请求编号，重试就可能重复发表。
function ksPersistPendingStore() {
  const map = ksPendingStore();
  // 身份不可确认的记录只留在本页内存：它无法区分「删号后同名重建」的前后两个账号，
  // 一旦写进存储，下次开会话就可能把旧账号的草稿恢复给新账号。
  const persisted = {};
  Object.keys(map).forEach(function (k) {
    const record = map[k];
    if (record && record.persistable === true) persisted[k] = record;
  });
  try {
    sessionStorage.setItem(KS_PENDING_KEY, JSON.stringify(persisted));
    return true;
  } catch (e) {
    return false;
  }
}

// 键必须同时绑「账号 + 文章 + 父评论」：
// 只按文章+父评论索引，同一浏览器换账号后会把上一个人的草稿（含正文与 @ 目标）恢复给下一个人。
// 账号用「登录名 + 不可复用身份」双维度（与通知缓存一致）：只比用户名漏掉删号后同名重注册，
// 只比建号时间会把建号时间落在同一刻的不同账号判成同一人。
// 身份缺失时返回 persistable=false：本页仍可安全重试（同一账号同一页面），但不跨会话保存/恢复。
function ksPendingOwner() {
  const who = (typeof username === 'string' && username) ? username
    : (typeof window.username === 'string' ? window.username : '');
  const identity = (typeof accountIdentity === 'string' && accountIdentity) ? accountIdentity
    : (typeof window.accountIdentity === 'string' ? window.accountIdentity : '');
  if (!who) return { key: '', persistable: false };
  return {
    key: 'u:' + who + '|id:' + identity,
    persistable: !!identity,
  };
}

// 内容与 @ 不参与键（改了也要能找到旧记录），但账号必须参与
function ksPendingKey(articleId, parentId) {
  const owner = ksPendingOwner();
  if (!owner.key) return '';
  return owner.key + '|' + String(articleId) + '|' + (parentId || '');
}

function ksPendingRecord(articleId, parentId) {
  const owner = ksPendingOwner();
  const key = ksPendingKey(articleId, parentId);
  if (!owner.key || !key) return null;
  const record = ksPendingStore()[key];
  // 双保险：记录内再存一份归属，键被手工篡改或旧数据缺归属时不还原
  if (!record || !record.id || record.owner !== owner.key) return null;
  return record;
}

// 未确认记录按账号分开计数：别的账号留下的记录既不该挡住这个人发评论，
// 这个人也没有入口去处理别人的记录（原样重试/放弃都只作用于自己的键）。
function ksPendingCountForOwner(ownerKey) {
  if (!ownerKey) return 0;
  const map = ksPendingStore();
  return Object.keys(map).filter(function (k) {
    const record = map[k];
    return record && record.id && record.owner === ownerKey;
  }).length;
}

function ksSavePendingRecord(articleId, parentId, record) {
  const owner = ksPendingOwner();
  const key = ksPendingKey(articleId, parentId);
  if (!owner.key || !key) return false;
  const map = ksPendingStore();
  // 新增一条会超过上限时直接拒绝，而不是悄悄删掉最早那条：
  // 被删的记录若其实已经提交，用户之后重试就会拿新编号再发一条。
  if (!map[key] && ksPendingCountForOwner(owner.key) >= KS_PENDING_MAX) {
    return { ok: false, reason: 'limit', pendingCount: ksPendingCountForOwner(owner.key) };
  }
  map[key] = Object.assign({}, record, {
    owner: owner.key, persistable: owner.persistable,
    articleId: String(articleId), parentId: parentId || null,
  });
  const written = ksPersistPendingStore();
  // persisted 表示「刷新后这条还在」：身份不可确认或存储写不进去时为 false
  map[key].persisted = owner.persistable && written;
  return { ok: true, persisted: map[key].persisted };
}

// 按「发起请求那一刻的账号」清除记录，而不是按「响应回来时的当前账号」：
// 用户可能在请求飞行中切换了账号，用当前账号算键就会清掉新账号在同一位置的待确认记录。
// 若那条记录其实已经提交、记录却被清掉，用户之后重试就会用新编号再发一条。
function ksClearPendingRecordByOwner(ownerKey, articleId, parentId) {
  if (!ownerKey) return;
  const key = ownerKey + '|' + String(articleId) + '|' + (parentId || '');
  const map = ksPendingStore();
  if (!map[key]) return;
  delete map[key];
  ksPersistPendingStore();
}

function ksClearPendingRecord(articleId, parentId) {
  ksClearPendingRecordByOwner(ksPendingOwner().key, articleId, parentId);
}

// 当前账号在这篇文章下所有未确认的提交（一级 + 各条回复），用于打开文章时统一恢复
function ksPendingRecordsForArticle(articleId) {
  const owner = ksPendingOwner();
  if (!owner.key) return [];
  const map = ksPendingStore();
  return Object.keys(map).map(function (k) { return map[k]; })
    .filter(function (r) {
      return r && r.id && r.owner === owner.key && String(r.articleId) === String(articleId);
    });
}

// 是否就是同一次提交：正文与每条 @ 的主体、区间、文字都要一致
function ksSameMentions(left, right) {
  const norm = function (list) {
    return (list || []).map(function (m) {
      return {
        subjectId: String(m.subjectId || ''), text: String(m.text || ''),
        start: Number(m.start), end: Number(m.end),
      };
    }).sort(function (a, b) {
      return a.start - b.start || (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0);
    });
  };
  const a = norm(left);
  const b = norm(right);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].subjectId !== b[i].subjectId || a[i].text !== b[i].text
      || a[i].start !== b[i].start || a[i].end !== b[i].end) return false;
  }
  return true;
}

// 结果不明：保留记录，提示用户可安全原样重试（重试不会产生第二条评论）
function ksMayHaveCommitted(status) {
  return status === 0 || status >= 500;
}

// 只有服务端「真的看过这条请求并明确拒绝」的状态才能断言没落库：
// 400 参数不合法、404 文章不存在、409 编号冲突或父评论失效、413/422 内容被拒。
// 429 限流、401/403 登录状态或权限、408/499 客户端中断都不代表这次请求被处理过——
// 若它其实是「上次结果不明」的重试，丢掉原编号后第三次提交就会再发一条。
// 409 还要看服务端给的 code：「该请求已处理」（并发下另一事务先写入）说明评论已经存在，
// 属于「已提交」而不是「明确没提交」，同样必须保留编号。
// 409 的 `request_comment_deleted` 是「已处理 + 评论之后被删除」的终态：重试永远是同一个结论，
// 所以按明确拒绝处理（清掉待确认记录、如实告知），绝不能再发一条把用户删掉的评论造回来。
// 404 之所以能当「明确没提交」，前提是服务端 `createComment` 先按请求编号回放、再判文章状态：
// 文章在结果不明期间被撤回/删除时，原请求仍会被认出来（或确认已无评论可回放），不会误报 404。
// 若把服务端这两步的顺序调换，这里就必须改成「重试遇 404 保留编号」。
function ksServerSaysProcessed(payload) {
  return !!payload && payload.code === 'request_already_processed';
}

function ksDefinitelyRejected(status, payload) {
  if (ksServerSaysProcessed(payload)) return false;
  return status === 400 || status === 404 || status === 409
    || status === 413 || status === 422;
}

// 响应回来时页面可能已经换了人，也可能换了文章：
// 记录按发起时的归属清除，界面更新只允许作用在「同一账号 + 仍在读发起时那篇文章」上。
function ksStillOnArticle(articleId) {
  const cur = ksState.currentArticle;
  if (!cur || String(cur.id) !== String(articleId)) return false;
  return String(ksState.readingId || '') === String(articleId);
}

// 只比文章编号不够：文章 A → B → 再回 A 时编号相同、账号相同，但这是新的一次打开，
// 旧响应不能动这次的草稿。用每次打开都自增的 articleSeq 区分「页面实例」。
function ksSameArticleInstance(articleId, seq) {
  if (!ksStillOnArticle(articleId)) return false;
  return ksState.articleSeq === seq;
}

// 回到文章时把未确认的提交还原成草稿（正文 + @ 一起）：
// 一级评论回到主输入框，每条回复回到对应楼层的回复框，都在该位置带「放弃这条」入口。
function ksResumePendingComment(articleId, options) {
  const silent = !!(options && options.silent);
  const records = ksPendingRecordsForArticle(articleId);
  if (!records.length) return;
  const owner = ksPendingOwner();
  let restored = 0;
  let failed = 0;
  records.forEach(function (pending) {
    if (pending.parentId) {
      const ok = (typeof window.ksRestoreReplyDraft === 'function')
        ? window.ksRestoreReplyDraft(pending.parentId, pending.content, pending.mentions) : false;
      if (ok) restored++; else failed++;
      return;
    }
    const okMain = (typeof window.ksRestoreCommentDraft === 'function')
      ? window.ksRestoreCommentDraft('main', pending.content, pending.mentions) : false;
    if (okMain) restored++; else failed++;
  });
  if (silent) return;
  if (restored) {
    showToast('有 ' + restored + ' 条评论结果还没确认，已恢复为草稿；再次提交不会重复发布'
      + (owner.persistable ? '' : '（当前无法确认账号身份，这份草稿只在本次页面有效）'));
  }
  // 回复的目标评论已被删除时无法恢复，需要明确告知，不能让用户以为已经没有了
  if (failed) showToast('有 ' + failed + ' 条未确认的回复所在评论已不存在，无法恢复');
}

// 评论列表被整块重绘后（View 调这里）：按待确认记录把草稿重新渲染出来。
// 重绘会销毁回复框，不重放一次恢复就等于把未确认的回复弄丢了。
function ksResumePendingAfterPaint() {
  const a = ksState.currentArticle;
  if (!a) return;
  ksResumePendingComment(a.id, { silent: true });
}
window.ksResumePendingAfterPaint = ksResumePendingAfterPaint;

// 放弃未确认的提交（用户明确不要了）：清记录与对应草稿，之后可按新评论重新开始。
// parentId 为空表示一级评论，否则是某条评论下的回复。
function ksDiscardPendingComment(parentId) {
  const a = ksState.currentArticle;
  if (!a) return;
  const pid = parentId ? parseInt(parentId, 10) : null;
  ksClearPendingRecord(a.id, pid);
  if (typeof window.ksClearCommentDraft === 'function') window.ksClearCommentDraft(pid);
  else if (typeof window.ksResetMentions === 'function') window.ksResetMentions('main');
  showToast('已放弃未确认的评论');
}

// 结果不明时的提示：只有「记录真的落到了存储」时才能说「稍后重试」，否则必须提醒不要刷新。
// 两种情况要分开说：身份不可确认、浏览器存储写不进去，刷新都会丢掉请求编号。
function ksUnknownOutcomeTip(status, saved) {
  const base = status
    ? '服务器繁忙，评论可能已提交，请稍后重试（不会重复发布）'
    : '网络异常，评论可能已提交，请稍后重试（不会重复发布）';
  const owner = ksPendingOwner();
  if (!owner.persistable) {
    return base + '；当前无法确认账号身份，请在本次页面内重试，不要刷新';
  }
  if (!saved || saved.persisted !== true) {
    return base + '；当前浏览器存储不可用，请在本次页面内重试，刷新会丢失这条待确认记录';
  }
  return base;
}

async function ksSubmitComment(parentId, textInput, boxKey) {
  const a = ksState.currentArticle;
  if (!a) return;
  const rawText = String(textInput || '');
  // 正文提交前要去掉首尾空白，但 @ 的区间是基于输入框原文的：必须按「去掉的首部字符数」平移，
  // 否则开头有空格时复核失败，用户明明选了人却一个 @ 都不提交（通知收不到，也没有报错）。
  const leading = rawText.length - rawText.replace(/^\s+/, '').length;
  const text = rawText.slice(leading).replace(/\s+$/, '');
  if (!text) { showToast('评论内容不能为空'); return; }
  // @ 区间按最终正文重算；正文里已删掉的 @ 自动不再提交
  const mentions = (boxKey && typeof window.ksReadMentions === 'function')
    ? window.ksReadMentions(boxKey, text, leading) : [];

  // 上一次结果还没确认时，只允许「原样重试」。换编号或换内容都可能在第一次已落库的情况下多发一条，
  // 因此这里直接拒绝并提示：要么原样重试，要么先放弃这条。
  const pending = ksPendingRecord(a.id, parentId);
  let requestId;
  if (pending) {
    if (pending.content !== text || !ksSameMentions(pending.mentions, mentions)) {
      showToast('上一条评论结果还没确认：请先原样重试，或点「放弃这条」后再发新的（不会重复发布）');
      return;
    }
    requestId = pending.id;
  } else {
    requestId = ksNewRequestId();
  }
  // 请求发出前把归属固定下来：await 期间用户可能切换账号、翻到别的文章，或离开后又回到同一篇
  const isRetry = !!pending;
  const ownerAtSend = ksPendingOwner();
  const articleSeqAtSend = ksState.articleSeq;
  const saved = ksSavePendingRecord(a.id, parentId, { id: requestId, content: text, mentions: mentions });
  if (!saved || saved.ok !== true) {
    if (saved && saved.reason === 'limit') {
      const cap = saved.pendingCount || KS_PENDING_MAX;
      showToast('当前账号还有 ' + cap + ' 条评论结果没确认，请先处理（原样重试或放弃）后再发新的（不会重复发布）');
      return;
    }
    showToast('请先登录后再评论');
    return;
  }

  const body = { content: text, client_request_id: requestId };
  if (parentId) body.parent_id = parentId;
  if (mentions.length) body.mentions = mentions;
  const r = await window.siteApi.post('/api/knowledge/articles/' + a.id + '/comments', body);
  // 响应回来时可能已经换了账号、换了文章，甚至离开后又回到同一篇：
  // 记录一律按发起时的账号与文章清除，界面（提示、清草稿、刷列表）只在「同一账号 + 同一个文章页面实例」时更新。
  const sameOwner = !!ownerAtSend.key && ksPendingOwner().key === ownerAtSend.key;
  const samePage = sameOwner && ksSameArticleInstance(a.id, articleSeqAtSend);
  if (!r.ok) {
    // 结果不明：服务端可能已提交，重试会拿回原评论而不是再发一条，必须保留整份记录。
    // 另外：如果这次本身就是「上次结果不明」的重试，那么限流/登录状态被拦也不能证明上次没落库
    // （请求可能根本没进到处理逻辑），此时同样要保留原编号，否则第三次提交就会用新编号再发一条。
    const uncertain = ksMayHaveCommitted(r.status)
      || (isRetry && !ksDefinitelyRejected(r.status, r.payload))
      || ksServerSaysProcessed(r.payload);
    if (uncertain) {
      if (samePage) {
        showToast(ksServerSaysProcessed(r.payload)
          ? '这条评论服务器已经在处理了，请稍后原样重试查看结果（不会重复发布）'
          : ksUnknownOutcomeTip(r.status, saved));
      }
      return;
    }
    // 服务端明确拒绝：丢弃这条失败请求的记录（只清发起时的账号，不碰当前账号）
    ksClearPendingRecordByOwner(ownerAtSend.key, a.id, parentId);
    if (!samePage) return;
    if (typeof window.ksHideCommentNotice === 'function') window.ksHideCommentNotice(boxKey || 'main');
    const d = r.payload || {};
    if (r.status === 400 || r.status === 409 || r.status === 429) showToast(d.error || ksWriteErrMsg(r.status));
    else showToast(ksWriteErrMsg(r.status));
    return;
  }
  ksClearPendingRecordByOwner(ownerAtSend.key, a.id, parentId);
  if (!samePage) return;
  // 清掉该输入框的草稿与提示（一级清主框，回复清对应楼层）
  if (typeof window.ksClearCommentDraft === 'function') window.ksClearCommentDraft(parentId || null);
  ksLoadComments(a.id);
  showToast('评论已发表');
}

// ---------- 编辑器 ----------
async function ksOpenEditor(id) {
  if (!ksState.canWrite) { showToast('你暂无写文章权限'); return; }
  let article = null;
  if (id) {
    try {
      const r = await window.siteApi.get('/api/knowledge/articles/' + id);
      if (!r.ok) { showToast('无法加载文章'); return; }
      article = r.payload || {};
      if (!article.can_edit) { showToast('只能编辑自己创建的文章'); return; }
    } catch (e) {
      showToast('网络异常，无法加载文章');
      return;
    }
  }
  ksState.editingId = article ? article.id : null;
  ksState.editingStatus = article ? article.status : 'draft';
  await window.ksPaintEditor(article);
}

async function ksSave(status) {
  const form = await window.ksReadEditorForm();
  if (!form) {
    showToast('编辑器尚未加载完成，请刷新后重试');
    return;
  }
  const content = form.content;
  const summary = content.replace(/[#>*`\-\s]/g, ' ').slice(0, 120).trim();
  const body = JSON.stringify({ title: form.title || '无标题', content: content, html_content: form.html, summary: summary, category_id: form.categoryId, status: status });
  // body 已是序列化好的 JSON 串：这里透传，不再二次序列化。
  const r = ksState.editingId
    ? await window.siteApi.request('/api/knowledge/articles/' + ksState.editingId, { method: 'PUT', headers: window.siteApi.jsonHeaders(), body: body })
    : await window.siteApi.request('/api/knowledge/articles', { method: 'POST', headers: window.siteApi.jsonHeaders(), body: body });
  if (!r.ok) {
    if (!r.status) { showToast('网络异常，请检查后重试'); return; }
    if (r.status === 400) { const d = r.payload || {}; showToast(d.error || ksWriteErrMsg(r.status)); }
    else showToast(ksWriteErrMsg(r.status));
    return;
  }
  const d = r.payload || {};
  if (status === 'published' && d.share_token) showToast('已发布，分享链接已生成');
  else showToast(status === 'draft' ? '草稿已保存' : '已保存');
  ksState.editingId = d.id || ksState.editingId;
  ksState.editingStatus = status;
  ksLoadArticles();
  window.ksShowView('list');
}

// ---------- 导入（链接 / 文件） ----------
async function ksImportUrlGo() {
  const url = window.ksReadImportUrl();
  if (!url) { showToast('请先粘贴链接'); return; }
  window.ksSetImportStatus('正在抓取…');
  const r = await window.siteApi.post('/api/knowledge/import-url', { url: url });
  if (!r.ok) { const d = r.payload || {}; window.ksSetImportStatus('抓取失败：' + (d.error || '')); return; }
  const d = r.payload || {};
  window.ksSetImportStatus('已抓取，已填入编辑器（请检查后发布）');
  ksState.editingId = null;
  await window.ksPaintImportedArticle(d.title || '', d.content || '');
}

async function ksImportFileGo() {
  const file = window.ksReadImportFile();
  if (!file) { showToast('请选择文件'); return; }
  window.ksSetImportStatus('正在解析…');
  const fd = new FormData();
  fd.append('file', file);
  // 文件上传走原始请求：不设 JSON 头，浏览器自己带 multipart 边界。
  const r = await window.siteApi.request('/api/knowledge/import-file', { method: 'POST', body: fd });
  if (!r.ok) { const d = r.payload || {}; window.ksSetImportStatus('解析失败：' + (d.error || '')); return; }
  const d = r.payload || {};
  window.ksSetImportStatus('已解析，已填入编辑器（请检查后发布）');
  ksState.editingId = null;
  await window.ksPaintImportedArticle(d.title || '', d.content || '');
}

// ---------- 分类管理 ----------
async function ksAddCategory() {
  if (!ksState.canWrite) { showToast('你暂无投资笔记的写权限'); return; }
  const name = window.ksReadCategoryName();
  if (!name) { showToast('请输入分类名称'); window.ksFocusCategoryName(); return; }
  const parentId = ksState.currentCategory || null;
  window.ksSetCategoryCreateBusy(true);
  try {
    const r = await window.siteApi.post('/api/knowledge/categories', { name: name, parent_id: parentId });
    if (!r.ok) {
      const d = r.payload || {};
      showToast(d.error || '新建分类失败');
      return;
    }
    window.ksToggleCategoryCreate(false);
    ksState.currentCategory = null;
    await loadKnowledge(true);
    showToast('分类已创建');
  } catch (e) {
    showToast('网络异常，请稍后重试');
  } finally {
    window.ksSetCategoryCreateBusy(false);
  }
}

async function ksUpdateCategory() {
  const category = ksFindCategory(ksState.categories, ksState.categoryActionId);
  if (!category || !category.can_manage) return;
  const form = window.ksReadCategoryEditForm();
  if (ksState.categoryActionMode === 'rename' && !form.name) {
    showToast('请输入分类名称');
    window.ksFocusCategoryEditName();
    return;
  }
  window.ksSetCategoryEditBusy(true);
  try {
    const isMove = ksState.categoryActionMode === 'move';
    const categoryPayload = isMove
      ? { parent_id: form.parentId || null, before_id: null }
      : { name: form.name };
    const r = isMove
      ? await window.siteApi.post('/api/knowledge/categories/' + category.id + '/move', categoryPayload)
      : await window.siteApi.put('/api/knowledge/categories/' + category.id, categoryPayload);
    if (!r.ok) {
      const d = r.payload || {};
      showToast(d.error || (isMove ? '移动分类失败' : '重命名分类失败'));
      return;
    }
    window.ksToggleCategoryEdit(false);
    await loadKnowledge(true);
    await ksLoadArticles();
    showToast(isMove ? '分类已移动' : '分类已重命名');
  } catch (e) {
    showToast('网络异常，请稍后重试');
  } finally {
    window.ksSetCategoryEditBusy(false);
  }
}

async function ksDeleteCategory(categoryId) {
  const category = ksFindCategory(ksState.categories, categoryId);
  if (!category || !category.can_manage) return;
  const childWarning = category.children && category.children.length
    ? '，它的子分类会移到一级目录'
    : '';
  if (!await projectConfirm(
    '确定删除分类「' + category.name + '」吗？相关文章将变为未分类' + childWarning + '。',
    { title: '删除分类', confirmText: '删除', danger: true }
  )) return;
  try {
    const r = await window.siteApi.del('/api/knowledge/categories/' + category.id);
    if (!r.ok) {
      const d = r.payload || {};
      showToast(d.error || '删除分类失败');
      return;
    }
    if (ksState.currentCategory === category.id) ksState.currentCategory = null;
    window.ksToggleCategoryEdit(false);
    await loadKnowledge(true);
    showToast('分类已删除');
  } catch (e) {
    showToast('网络异常，请稍后重试');
  }
}

async function ksMoveCategory(categoryId, parentId, beforeId) {
  const category = ksFindCategory(ksState.categories, categoryId);
  if (!category || !category.can_manage) return;
  try {
    const r = await window.siteApi.post('/api/knowledge/categories/' + categoryId + '/move', { parent_id: parentId || null, before_id: beforeId || null });
    if (!r.ok) {
      const d = r.payload || {};
      showToast(d.error || '移动分类失败');
      return;
    }
    await loadKnowledge(true);
    await ksLoadArticles();
  } catch (e) {
    showToast('网络异常，请稍后重试');
  }
}
