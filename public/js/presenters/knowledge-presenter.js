// 知识分享 Presenter（批次4：View／Presenter 分离）。
// 职责：持有 ksState（阅读意图 readingId 与请求状态）、取数协调（window.siteApi）与写操作编排。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的 window.ks* 入口；View 不取数，只渲染并上报用户操作。
let ksState = {
  categories: [],
  articles: [],
  loaded: false,   // 已完成一次进入页面的数据加载；返回本页不再全量重拉（2026-10-21 审查 U-3）
  readingId: null, // 阅读意图：打开文章时立即置位，防止并行的 loadKnowledge 把用户踢回列表
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
async function ksOpenArticle(id) {
  ksState.readingId = id;
  const r = await window.siteApi.get('/api/knowledge/articles/' + id);
  if (!r.ok) { ksState.readingId = null; showToast('文章不存在或未发布'); return; }
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
  ksLoadComments(id);
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
async function ksLoadComments(id) {
  if (!window.ksPaintCommentsPrepare()) return;
  const r = await window.siteApi.get('/api/knowledge/articles/' + id + '/comments');
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

async function ksSubmitComment(parentId, textInput) {
  const a = ksState.currentArticle;
  if (!a) return;
  const text = (textInput || '').trim();
  if (!text) { showToast('评论内容不能为空'); return; }
  const body = { content: text };
  if (parentId) body.parent_id = parentId;
  const r = await window.siteApi.post('/api/knowledge/articles/' + a.id + '/comments', body);
  if (!r.ok) {
    if (!r.status) { showToast('网络异常，请检查后重试'); return; }
    if (r.status === 400 || r.status === 429) { const d = r.payload || {}; showToast(d.error || ksWriteErrMsg(r.status)); }
    else showToast(ksWriteErrMsg(r.status));
    return;
  }
  // 刷新并清空主评论框
  window.ksClearCommentInput();
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
