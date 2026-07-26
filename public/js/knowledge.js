// ========== 知识分享模块前端逻辑 ==========
let ksState = {
  categories: [],
  articles: [],
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
};

function ksEl(id) { return document.getElementById(id); }

// 写操作失败的统一友好提示（不回显服务器内部错误）
function ksWriteErrMsg(status) {
  if (status === 401) return '请先登录后再操作';
  if (status === 403) return '你没有权限执行此操作';
  if (status === 404) return '内容不存在或已被删除';
  if (status === 413) return '内容过大，请精简后重试';
  return '操作失败，请稍后重试';
}

// ---------- 初始化（每次进入知识分享时调用） ----------
async function loadKnowledge() {
  try {
    const [catRes, listRes, meRes] = await Promise.all([
      fetch(api('/api/knowledge/categories')).then(r => r.json()),
      fetch(api('/api/knowledge/articles')).then(r => r.json()),
      username ? fetch(api('/api/knowledge/can-write')).then(r => r.json()).catch(() => ({ canWrite: false })) : Promise.resolve({ canWrite: false }),
    ]);
    ksState.categories = Array.isArray(catRes) ? catRes : [];
    ksState.articles = Array.isArray(listRes) ? listRes : [];
    ksState.canWrite = !!(meRes && meRes.canWrite);
    ksState.isAdmin = !!(meRes && meRes.isAdmin);
    // 无写权限时隐藏写按钮
    const ksNew = ksEl('ks-new');
    const ksImportUrl = ksEl('ks-import-url');
    const ksImportFile = ksEl('ks-import-file');
    const ksCatAdd = ksEl('ks-cat-add');
    const ksCatTools = ksEl('ks-cat-tools');
    const ksFilter = ksEl('ks-filter');
    if (ksNew) ksNew.style.display = ksState.canWrite ? '' : 'none';
    if (ksImportUrl) ksImportUrl.style.display = ksState.canWrite ? '' : 'none';
    if (ksImportFile) ksImportFile.style.display = ksState.canWrite ? '' : 'none';
    if (ksCatAdd) ksCatAdd.style.display = ksState.canWrite ? '' : 'none';
    if (ksCatTools) ksCatTools.style.display = ksState.canWrite ? '' : 'none';
    if (ksFilter) ksFilter.style.display = username ? '' : 'none';
    if (!ksState.canWrite && username) {
      const act = ksEl('ks-actions');
      if (act && !ksEl('ks-no-write-tip')) {
        const tip = document.createElement('div');
        tip.id = 'ks-no-write-tip';
        tip.className = 'ks-no-write-tip';
        tip.textContent = '你暂无写文章权限，可阅读与评论';
        act.appendChild(tip);
      }
    }
    ksRenderTree();
    ksRenderList();
    ksShowView('list');
  } catch (e) {
    showToast('投资笔记加载失败: ' + (e.message || e));
  }
}

// ---------- 目录树 ----------
function ksRenderTree() {
  const tree = ksEl('ks-tree');
  if (!tree) return;
  let html = '<li class="ks-tree-item ks-tree-overview' + (ksState.currentCategory === null ? ' active' : '') + '" data-cat="all"><span>全部文章</span><em>总览</em></li>';
  if (ksState.categories.length) html += '<li class="ks-tree-section-label">文章分类</li>';
  html += ksRenderNodes(ksState.categories, 0);
  tree.innerHTML = html;
  tree.querySelectorAll('.ks-tree-item').forEach(li => {
    li.addEventListener('click', function (event) {
      if (event.target.closest('.ks-cat-menu-wrap')) return;
      const v = li.dataset.cat;
      ksState.currentCategory = v === 'all' ? null : parseInt(v, 10);
      ksToggleCategoryCreate(false);
      ksToggleCategoryEdit(false);
      ksRenderTree();
      ksLoadArticles();
    });
  });
  ksBindCategoryMenus(tree);
  ksBindCategoryDrag(tree);
}

function ksRenderNodes(nodes, depth) {
  let html = '';
  (nodes || []).forEach(n => {
    const active = ksState.currentCategory === n.id ? ' active' : '';
    const manageable = n.can_manage ? ' ks-tree-manageable' : '';
    const pad = 12 + depth * 16;
    const menu = n.can_manage
      ? '<div class="ks-cat-menu-wrap">' +
          '<button class="ks-cat-menu-trigger" type="button" aria-label="管理分类 ' + escapeHtml(n.name) + '">⋮</button>' +
          '<div class="ks-cat-menu">' +
            '<button type="button" data-cat-action="move">移动</button>' +
            '<button type="button" data-cat-action="rename">重命名</button>' +
            '<button type="button" data-cat-action="delete" class="danger">删除</button>' +
          '</div>' +
        '</div>'
      : '';
    html += '<li class="ks-tree-item' + active + manageable + '" data-cat="' + n.id + '" data-parent="' +
      (n.parent_id || '') + '" draggable="' + (n.can_manage ? 'true' : 'false') +
      '" style="padding-left:' + pad + 'px;">' +
      '<span>' + escapeHtml(n.name) + '</span>' + menu + '</li>';
    if (n.children && n.children.length) html += ksRenderNodes(n.children, depth + 1);
  });
  return html;
}

async function ksLoadArticles() {
  let url = api('/api/knowledge/articles');
  const params = [];
  if (ksState.currentCategory) params.push('category_id=' + ksState.currentCategory);
  if (username) {
    const f = ksEl('ks-filter') && ksEl('ks-filter').value;
    if (f) params.push('status=' + f);
  }
  const q = ksEl('ks-search') && ksEl('ks-search').value.trim();
  if (q) params.push('q=' + encodeURIComponent(q));
  if (params.length) url += '?' + params.join('&');
  const r = await fetch(url);
  ksState.articles = await r.json();
  ksRenderList();
}

// ---------- 文章列表 ----------
function ksFindCategory(nodes, id) {
  for (const node of (nodes || [])) {
    if (node.id === id) return node;
    const child = ksFindCategory(node.children, id);
    if (child) return child;
  }
  return null;
}

function ksFindCategoryName(nodes, id) {
  const category = ksFindCategory(nodes, id);
  return category ? category.name : '';
}

function ksFlattenCategories(nodes, depth, result) {
  const list = result || [];
  (nodes || []).forEach(function (node) {
    list.push({ id: node.id, name: node.name, depth: depth || 0 });
    ksFlattenCategories(node.children, (depth || 0) + 1, list);
  });
  return list;
}

function ksCollectCategoryIds(node, result) {
  const ids = result || new Set();
  if (!node) return ids;
  ids.add(node.id);
  (node.children || []).forEach(function (child) { ksCollectCategoryIds(child, ids); });
  return ids;
}

function ksRenderList() {
  const box = ksEl('ks-article-list');
  if (!box) return;
  const listTitle = ksEl('ks-list-title');
  const listCount = ksEl('ks-list-count');
  const categoryName = ksState.currentCategory
    ? ksFindCategoryName(ksState.categories, ksState.currentCategory)
    : '';
  if (listTitle) listTitle.textContent = categoryName || '全部文章';
  if (listCount) listCount.textContent = ksState.articles.length + ' 篇';
  if (!ksState.articles.length) {
    box.innerHTML = '<div class="ks-empty">当前范围内没有文章</div>';
    return;
  }
  let html = '';
  ksState.articles.forEach(a => {
    const statusTag = a.status === 'draft'
      ? '<span class="ks-tag ks-tag-draft">草稿</span>'
      : '<span class="ks-tag ks-tag-pub">已发布</span>';
    const date = (a.published_at || a.updated_at || '').toString().slice(0, 10);
    html += '<div class="ks-card" data-id="' + a.id + '" role="button" tabindex="0">' +
      '<div class="ks-card-labels"><span class="ks-category-label">' + escapeHtml(a.category_name || '未分类') + '</span>' + statusTag + '</div>' +
      '<div class="ks-card-head"><h3>' + escapeHtml(a.title || '无标题') + '</h3></div>' +
      (a.summary ? '<p class="ks-card-sum">' + escapeHtml(a.summary) + '</p>' : '') +
      '<div class="ks-card-meta">' +
        '<span>' + (date || '日期未知') + '</span>' +
        '<span>' + (a.view_count || 0) + ' 次阅读</span>' +
      '</div>' +
      (a.can_edit ?
        '<div class="ks-card-ops">' +
          '<button class="ks-btn-mini" data-act="edit" data-id="' + a.id + '">编辑</button>' +
          (a.status === 'published'
            ? '<button class="ks-btn-mini" data-act="unpublish" data-id="' + a.id + '">撤回</button>'
            : '<button class="ks-btn-mini" data-act="publish" data-id="' + a.id + '">发布</button>') +
          '<button class="ks-btn-mini ks-danger" data-act="del" data-id="' + a.id + '">删除</button>' +
        '</div>' : '') +
      '</div>';
  });
  box.innerHTML = html;
  box.querySelectorAll('.ks-card').forEach(card => {
    card.addEventListener('click', function (e) {
      if (e.target.dataset.act) { e.stopPropagation(); return ksCardOp(e.target.dataset.act, parseInt(e.target.dataset.id, 10)); }
      ksOpenArticle(parseInt(card.dataset.id, 10));
    });
    card.addEventListener('keydown', function (e) {
      if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      ksOpenArticle(parseInt(card.dataset.id, 10));
    });
  });
}

async function ksCardOp(act, id) {
  if (act === 'edit') { ksOpenEditor(id); return; }
  if (act === 'del') {
    await ksDeleteArticle(id);
    return;
  }
  try {
    const path = act === 'publish' ? '/publish' : '/unpublish';
    const r = await fetch(api('/api/knowledge/articles/' + id + path), { method: 'POST' });
    if (!r.ok) { showToast(ksWriteErrMsg(r.status)); return; }
    const d = await r.json().catch(() => ({}));
    showToast(act === 'publish' && d.share_token ? '已发布，分享链接已生成' : '已撤回为草稿');
    await ksLoadArticles();
  } catch (e) {
    showToast('网络异常，请检查后重试');
  }
}

// ---------- 阅读视图 ----------
async function ksOpenArticle(id) {
  const r = await fetch(api('/api/knowledge/articles/' + id));
  if (!r.ok) { showToast('文章不存在或未发布'); return; }
  const a = await r.json();
  ksState.currentArticle = a;
  ksEl('ks-read-title').textContent = a.title || '无标题';
  const date = (a.published_at || a.updated_at || '').toString().slice(0, 19).replace('T', ' ');
  let meta = '<span>' + escapeHtml(a.category_name || '未分类') + '</span>' +
    '<span>作者：' + escapeHtml(a.author_username || '未知') + '</span>' +
    '<span>' + date + '</span><span>' + (a.view_count || 0) + ' 次阅读</span>';
  // 阅读量 +1
  fetch(api('/api/knowledge/articles/' + id + '/view'), { method: 'POST' }).catch(() => {});
  ksEl('ks-read-meta').innerHTML = meta;
  // 渲染正文（统一安全渲染：Vditor 优先，marked+DOMPurify 兜底净化）
  const content = ksEl('ks-read-content');
  const outlineWrap = ksEl('ks-read-outline-wrap');
  const outline = ksEl('ks-read-outline');
  if (outlineWrap) outlineWrap.classList.add('hidden');
  if (outline) outline.innerHTML = '';
  Promise.resolve(renderMarkdownSafe(content, a.content || '')).then(function () {
    if (!outlineWrap || !outline || typeof Vditor === 'undefined' || !Vditor.outlineRender) return;
    const outlineHtml = Vditor.outlineRender(content, outline);
    outlineWrap.classList.toggle('hidden', !outlineHtml || !outline.textContent.trim());
  }).catch(function () {
    if (outlineWrap) outlineWrap.classList.add('hidden');
  });

  // 操作按钮（有写权限可编辑/分享/删除）
  const ops = ksEl('ks-read-ops');
  if (a.can_edit) {
    let html = '<button class="ks-btn" onclick="ksOpenEditor(' + a.id + ')">编辑文章</button>';
    if (a.status === 'published' && a.share_token) {
      html += '<button class="ks-btn" onclick="ksCopyShare(\'' + a.share_token + '\')">复制分享链接</button>';
    }
    html += '<button class="ks-btn ks-danger" onclick="ksDeleteArticle(' + a.id + ')">删除文章</button>';
    ops.innerHTML = html;
  } else {
    ops.innerHTML = '';
  }
  // 评论表单：未登录提示登录，已登录显示输入框
  const commentForm = ksEl('ks-comment-form');
  if (commentForm) {
    if (!username) {
      commentForm.innerHTML = '<div class="ks-comment-login-tip">请 <a href="' + api('/login.html?redirect=' + encodeURIComponent('/?main=knowledge')) + '">登录</a> 后发表评论</div>';
    } else {
      commentForm.innerHTML = '<textarea id="ks-comment" placeholder="写下你的评论…"></textarea>' +
        '<button class="ks-btn ks-btn-primary" id="ks-comment-submit">发表评论</button>';
      const btn = ksEl('ks-comment-submit');
      if (btn) btn.addEventListener('click', function () { ksSubmitComment(null, ksEl('ks-comment').value); });
    }
  }
  ksShowView('read');
  ksLoadComments(id);
}

function ksCopyShare(token) {
  const link = location.origin + api('/share-knowledge.html?token=' + token);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link).then(() => showToast('分享链接已复制')).catch(() => {
      projectPrompt('请复制下面的分享链接', { title: '复制分享链接', value: link, confirmText: '完成' });
    });
  } else {
    projectPrompt('请复制下面的分享链接', { title: '复制分享链接', value: link, confirmText: '完成' });
  }
}

async function ksDeleteArticle(id) {
  if (!await projectConfirm('确定删除这篇文章？', { title: '删除文章', confirmText: '删除', danger: true })) return;
  let r;
  try {
    r = await fetch(api('/api/knowledge/articles/' + id), { method: 'DELETE' });
  } catch (e) {
    showToast('网络异常，请检查后重试'); return;
  }
  if (!r.ok) { showToast(ksWriteErrMsg(r.status)); return; }
  showToast('已删除');
  ksShowView('list');
  ksLoadArticles();
}

// ---------- 评论（楼中楼嵌套） ----------
async function ksLoadComments(id) {
  const box = ksEl('ks-comment-list');
  if (!box) return;
  const r = await fetch(api('/api/knowledge/articles/' + id + '/comments'));
  const list = await r.json();
  if (!list.length) { box.innerHTML = '<div class="ks-comment-empty">暂无评论</div>'; return; }
  box.innerHTML = ksRenderComments(list, 0);
  // 绑定回复按钮与提交
  box.querySelectorAll('.ks-reply-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      const cid = btn.dataset.id;
      const exist = box.querySelector('.ks-reply-box[data-pid="' + cid + '"]');
      if (exist) { exist.remove(); return; }
      box.querySelectorAll('.ks-reply-box').forEach(b => b.remove());
      const wrap = document.createElement('div');
      wrap.className = 'ks-reply-box';
      wrap.dataset.pid = cid;
      wrap.innerHTML = '<textarea class="ks-reply-text" placeholder="回复 @' + escapeHtml(btn.dataset.nick) + '…"></textarea>' +
        '<button class="ks-btn ks-btn-primary ks-reply-submit" data-pid="' + cid + '">回复</button>';
      btn.parentElement.appendChild(wrap);
      wrap.querySelector('.ks-reply-submit').addEventListener('click', function () {
        ksSubmitComment(parseInt(cid, 10), wrap.querySelector('.ks-reply-text').value);
      });
    });
  });
  // 绑定删除（已登录且有权限时按钮存在）
  box.querySelectorAll('.ks-comment-del').forEach(btn => {
    btn.addEventListener('click', async function () {
      if (!await projectConfirm('确定删除这条评论？', { title: '删除评论', confirmText: '删除', danger: true })) return;
      fetch(api('/api/knowledge/comments/' + btn.dataset.id), { method: 'DELETE' })
        .then(r => {
          if (!r.ok) { showToast(ksWriteErrMsg(r.status)); return; }
          showToast('已删除'); ksLoadComments(ksState.currentArticle.id);
        })
        .catch(() => showToast('网络异常，请检查后重试'));
    });
  });
}

// 递归渲染评论树（最多缩进 3 层）
function ksRenderComments(list, depth) {
  let html = '';
  list.forEach(c => {
    const t = (c.created_at || '').toString().slice(0, 19).replace('T', ' ');
    const nick = escapeHtml(c.nickname);
    html += '<div class="ks-comment-item' + (depth > 0 ? ' ks-comment-child' : '') + '">' +
      '<div class="ks-comment-head"><b>' + nick + '</b><span>' + t + '</span>' +
      (c.can_delete ? '<button class="ks-comment-del" data-id="' + c.id + '">删除</button>' : '') +
      '</div>' +
      '<div class="ks-comment-body">' + escapeHtml(c.content) + '</div>' +
      '<button class="ks-reply-btn" data-id="' + c.id + '" data-nick="' + nick + '">回复</button>' +
      (c.replies && c.replies.length ? ksRenderComments(c.replies, depth + 1) : '') +
      '</div>';
  });
  return html;
}

async function ksSubmitComment(parentId, textInput) {
  const a = ksState.currentArticle;
  if (!a) return;
  const text = (textInput || '').trim();
  if (!text) { showToast('评论内容不能为空'); return; }
  const body = { content: text };
  if (parentId) body.parent_id = parentId;
  let r;
  try {
    r = await fetch(api('/api/knowledge/articles/' + a.id + '/comments'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    showToast('网络异常，请检查后重试'); return;
  }
  if (!r.ok) {
    if (r.status === 400 || r.status === 429) { const d = await r.json().catch(() => ({})); showToast(d.error || ksWriteErrMsg(r.status)); }
    else showToast(ksWriteErrMsg(r.status));
    return;
  }
  // 刷新并清空主评论框
  const main = ksEl('ks-comment');
  if (main) main.value = '';
  ksLoadComments(a.id);
  showToast('评论已发表');
}

// ---------- 编辑器 ----------
let ksTablePickerOutsideHandler = null;

function ksCloseTablePicker() {
  const picker = document.querySelector('.ks-table-picker');
  if (picker) picker.remove();
  if (ksTablePickerOutsideHandler) {
    document.removeEventListener('mousedown', ksTablePickerOutsideHandler);
    ksTablePickerOutsideHandler = null;
  }
}

function ksBuildTableMarkdown(rows, columns) {
  const header = [];
  const divider = [];
  const body = [];
  for (let column = 1; column <= columns; column++) {
    header.push('列' + column);
    divider.push('---');
  }
  for (let row = 1; row < rows; row++) {
    body.push('| ' + new Array(columns).fill(' ').join(' | ') + ' |');
  }
  return '| ' + header.join(' | ') + ' |\n| ' + divider.join(' | ') + ' |\n' +
    (body.length ? body.join('\n') + '\n' : '');
}

function ksOpenTablePicker(event) {
  const toolbarButton = event.currentTarget;
  const toolbarItem = toolbarButton && toolbarButton.parentElement;
  if (!toolbarItem) return;
  if (toolbarItem.querySelector('.ks-table-picker')) {
    ksCloseTablePicker();
    return;
  }

  const selection = window.getSelection();
  const selectedNode = selection && selection.anchorNode;
  const selectedElement = selectedNode && (selectedNode.nodeType === 1 ? selectedNode : selectedNode.parentElement);
  if (selectedElement && selectedElement.closest && selectedElement.closest('table')) {
    showToast('请先将光标移到表格外，再插入新表格');
    return;
  }

  ksCloseTablePicker();
  const picker = document.createElement('div');
  picker.className = 'ks-table-picker';
  picker.addEventListener('mousedown', function (pickerEvent) {
    pickerEvent.preventDefault();
    pickerEvent.stopPropagation();
  });

  const label = document.createElement('div');
  label.className = 'ks-table-picker-label';
  label.textContent = '选择表格行列';
  picker.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'ks-table-picker-grid';
  for (let row = 1; row <= 10; row++) {
    for (let column = 1; column <= 10; column++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.dataset.row = String(row);
      cell.dataset.column = String(column);
      cell.setAttribute('aria-label', row + ' 行 × ' + column + ' 列');
      cell.addEventListener('mouseenter', function () {
        label.textContent = row + ' 行 × ' + column + ' 列';
        grid.querySelectorAll('button').forEach(function (item) {
          item.classList.toggle(
            'active',
            Number(item.dataset.row) <= row && Number(item.dataset.column) <= column
          );
        });
      });
      cell.addEventListener('click', function () {
        const editor = ksState.vditor;
        if (!editor) return;
        editor.insertMD(ksBuildTableMarkdown(row, column));
        editor.focus();
        ksCloseTablePicker();
        showToast('表格已插入，点击单元格可继续增删行列');
      });
      grid.appendChild(cell);
    }
  }
  picker.appendChild(grid);
  toolbarItem.appendChild(picker);

  ksTablePickerOutsideHandler = function (outsideEvent) {
    if (!picker.contains(outsideEvent.target) && outsideEvent.target !== toolbarButton) {
      ksCloseTablePicker();
    }
  };
  setTimeout(function () {
    document.addEventListener('mousedown', ksTablePickerOutsideHandler);
  }, 0);
}

function ksEnsureVditor() {
  if (ksState.vditorReady) return ksState.vditorReady;
  ksState.vditorReady = new Promise(function (resolve, reject) {
    if (typeof Vditor === 'undefined') {
      ksState.vditorReady = null;
      reject(new Error('Vditor 未加载'));
      return;
    }
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      ksState.vditor = null;
      ksState.vditorReady = null;
      reject(new Error('Vditor 初始化超时'));
    }, 15000);
    try {
      let editor;
      editor = new Vditor('ks-editor', {
        mode: 'wysiwyg',
        cache: { enable: false },
        height: 460,
        placeholder: '开始写作…（支持 Markdown，所见即所得）',
        cdn: '/vendor/vditor',
        customWysiwygToolbar: function (type, element) {
          element.classList.toggle('ks-vditor-table-tools', type === 'table');
        },
        toolbar: [
          'emoji', 'headings', 'bold', 'italic', 'strike', 'link', '|',
          'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
          'quote', 'line', 'code', 'inline-code', 'insert-before', 'insert-after', '|',
          'upload',
          {
            name: 'table-picker',
            tip: '插入表格（选择行列）',
            tipPosition: 'n',
            icon: '<svg><use xlink:href="#vditor-icon-table"></use></svg>',
            click: ksOpenTablePicker,
          },
          '|', 'undo', 'redo', '|', 'fullscreen', 'edit-mode',
          {
            name: 'more',
            toolbar: ['both', 'preview', 'outline', 'content-theme', 'code-theme', 'export', 'help'],
          },
        ],
        upload: { url: '', linkToImgUrl: '', handler: ksUploadHandler },
        after: function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ksState.vditor = editor;
          resolve(editor);
        },
      });
      ksState.vditor = editor;
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      ksState.vditor = null;
      ksState.vditorReady = null;
      reject(e);
    }
  });
  return ksState.vditorReady;
}

// 图片以 base64 内嵌（免服务器存储，兼容 CSP）
function ksUploadHandler(files) {
  return new Promise(function (resolve) {
    const succMap = {};
    const errFiles = [];
    let pending = files.length;
    if (!pending) return resolve({ code: 0, data: { errFiles: [], succMap: {} } });
    Array.prototype.forEach.call(files, function (file) {
      const reader = new FileReader();
      reader.onload = function () {
        succMap[file.name] = reader.result;
        pending -= 1;
        if (pending === 0) resolve({ code: 0, data: { errFiles: errFiles, succMap: succMap } });
      };
      reader.onerror = function () {
        errFiles.push(file.name);
        pending -= 1;
        if (pending === 0) resolve({ code: 0, data: { errFiles: errFiles, succMap: succMap } });
      };
      reader.readAsDataURL(file);
    });
  });
}

async function ksOpenEditor(id) {
  if (!ksState.canWrite) { showToast('你暂无写文章权限'); return; }
  let article = null;
  if (id) {
    try {
      const r = await fetch(api('/api/knowledge/articles/' + id));
      if (!r.ok) { showToast('无法加载文章'); return; }
      article = await r.json();
      if (!article.can_edit) { showToast('只能编辑自己创建的文章'); return; }
    } catch (e) {
      showToast('网络异常，无法加载文章');
      return;
    }
  }

  const sel = ksEl('ks-edit-cat');
  const categoryOptions = ksFlattenCategories(ksState.categories, 0, [])
    .map(function (category) {
      return '<option value="' + category.id + '">' +
        escapeHtml('　'.repeat(category.depth) + category.name) + '</option>';
    }).join('');
  sel.innerHTML = '<option value="">未分类</option>' + categoryOptions;
  ksState.editingId = article ? article.id : null;
  ksState.editingStatus = article ? article.status : 'draft';
  ksEl('ks-edit-title').value = article ? (article.title || '') : '';
  sel.value = article ? (article.category_id || '') : (ksState.currentCategory || '');
  const draftButton = ksEl('ks-save-draft');
  const publishButton = ksEl('ks-publish');
  if (draftButton) draftButton.textContent = article && article.status === 'published' ? '保存修改' : '保存草稿';
  if (publishButton) publishButton.textContent = article && article.status === 'published' ? '更新发布' : '发布文章';

  ksShowView('edit');
  let editor;
  try {
    editor = await ksEnsureVditor();
  } catch (e) {
    showToast('编辑器加载失败，请刷新后重试');
    ksShowView('list');
    return;
  }
  editor.setValue(article ? (article.content || '') : '');
}

async function ksSave(status) {
  const title = ksEl('ks-edit-title').value.trim();
  const categoryId = ksEl('ks-edit-cat').value || null;
  let editor;
  try {
    editor = await ksEnsureVditor();
  } catch (e) {
    showToast('编辑器尚未加载完成，请刷新后重试');
    return;
  }
  const content = editor.getValue();
  const html = editor.getHTML();
  const summary = content.replace(/[#>*`\-\s]/g, ' ').slice(0, 120).trim();
  const body = JSON.stringify({ title: title || '无标题', content: content, html_content: html, summary: summary, category_id: categoryId, status: status });
  let r;
  try {
    if (ksState.editingId) {
      r = await fetch(api('/api/knowledge/articles/' + ksState.editingId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body });
    } else {
      r = await fetch(api('/api/knowledge/articles'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
    }
  } catch (e) {
    showToast('网络异常，请检查后重试'); return;
  }
  if (!r.ok) {
    if (r.status === 400) { const d = await r.json().catch(() => ({})); showToast(d.error || ksWriteErrMsg(r.status)); }
    else showToast(ksWriteErrMsg(r.status));
    return;
  }
  const d = await r.json();
  if (status === 'published' && d.share_token) showToast('已发布，分享链接已生成');
  else showToast(status === 'draft' ? '草稿已保存' : '已保存');
  ksState.editingId = d.id || ksState.editingId;
  ksState.editingStatus = status;
  ksLoadArticles();
  ksShowView('list');
}

// ---------- 导入（链接 / 文件） ----------
function ksToggleImport(kind) {
  const panel = ksEl('ks-import-panel');
  if (!panel) return;
  panel.classList.toggle('hidden', panel.classList.contains('hidden') ? false : (panel.dataset.kind !== kind));
  if (panel.classList.contains('hidden')) { panel.dataset.kind = kind; panel.classList.remove('hidden'); }
  else { panel.dataset.kind = kind; }
  const urlBox = ksEl('ks-import-url-box');
  const fileBox = ksEl('ks-import-file-box');
  if (urlBox) urlBox.classList.toggle('hidden', kind !== 'url');
  if (fileBox) fileBox.classList.toggle('hidden', kind !== 'file');
  const st = ksEl('ks-import-status');
  if (st) st.textContent = '';
}

async function ksImportUrlGo() {
  const url = ksEl('ks-import-url-input').value.trim();
  const st = ksEl('ks-import-status');
  if (!url) { showToast('请先粘贴链接'); return; }
  if (st) st.textContent = '正在抓取…';
  const r = await fetch(api('/api/knowledge/import-url'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url }),
  });
  if (!r.ok) { const d = await r.json().catch(() => ({})); if (st) st.textContent = '抓取失败：' + (d.error || ''); return; }
  const d = await r.json();
  if (st) st.textContent = '已抓取，已填入编辑器（请检查后发布）';
  ksState.editingId = null;
  let editor;
  try {
    editor = await ksEnsureVditor();
  } catch (e) {
    if (st) st.textContent = '编辑器加载失败，请刷新后重试';
    return;
  }
  ksEl('ks-edit-title').value = d.title || '';
  editor.setValue(d.content || '');
  ksShowView('edit');
}

async function ksImportFileGo() {
  const input = ksEl('ks-import-file-input');
  const st = ksEl('ks-import-status');
  if (!input.files || !input.files.length) { showToast('请选择文件'); return; }
  if (st) st.textContent = '正在解析…';
  const fd = new FormData();
  fd.append('file', input.files[0]);
  const r = await fetch(api('/api/knowledge/import-file'), { method: 'POST', body: fd });
  if (!r.ok) { const d = await r.json().catch(() => ({})); if (st) st.textContent = '解析失败：' + (d.error || ''); return; }
  const d = await r.json();
  if (st) st.textContent = '已解析，已填入编辑器（请检查后发布）';
  ksState.editingId = null;
  let editor;
  try {
    editor = await ksEnsureVditor();
  } catch (e) {
    if (st) st.textContent = '编辑器加载失败，请刷新后重试';
    return;
  }
  ksEl('ks-edit-title').value = d.title || '';
  editor.setValue(d.content || '');
  ksShowView('edit');
}

// ---------- 分类管理 ----------
function ksToggleCategoryCreate(show) {
  const form = ksEl('ks-cat-create');
  const addButton = ksEl('ks-cat-add');
  const input = ksEl('ks-cat-name');
  const hint = ksEl('ks-cat-parent-hint');
  if (!form || !addButton) return;
  form.classList.toggle('hidden', !show);
  addButton.classList.toggle('hidden', !!show);
  if (!show) {
    if (input) input.value = '';
    return;
  }
  ksToggleCategoryEdit(false);
  const parentName = ksState.currentCategory
    ? ksFindCategoryName(ksState.categories, ksState.currentCategory)
    : '';
  if (hint) hint.textContent = parentName ? '将创建在「' + parentName + '」下' : '将创建一级分类';
  if (input) input.focus();
}

async function ksAddCategory() {
  if (!ksState.canWrite) { showToast('你暂无投资笔记的写权限'); return; }
  const input = ksEl('ks-cat-name');
  const saveButton = ksEl('ks-cat-save');
  const name = input ? input.value.trim() : '';
  if (!name) { showToast('请输入分类名称'); if (input) input.focus(); return; }
  const parentId = ksState.currentCategory || null;
  if (saveButton) saveButton.disabled = true;
  try {
    const r = await fetch(api('/api/knowledge/categories'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, parent_id: parentId }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d.error || '新建分类失败');
      return;
    }
    ksToggleCategoryCreate(false);
    ksState.currentCategory = null;
    await loadKnowledge();
    showToast('分类已创建');
  } catch (e) {
    showToast('网络异常，请稍后重试');
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function ksToggleCategoryEdit(show, categoryId, mode) {
  const form = ksEl('ks-cat-edit');
  const heading = ksEl('ks-cat-edit-heading');
  const input = ksEl('ks-cat-edit-name');
  const parentSelect = ksEl('ks-cat-edit-parent');
  if (!form) return;
  form.classList.toggle('hidden', !show);
  if (!show) {
    ksState.categoryActionId = null;
    ksState.categoryActionMode = null;
    return;
  }
  ksToggleCategoryCreate(false);
  const category = ksFindCategory(ksState.categories, categoryId);
  if (!category || !category.can_manage) {
    form.classList.add('hidden');
    return;
  }
  ksState.categoryActionId = category.id;
  ksState.categoryActionMode = mode;
  const blockedIds = ksCollectCategoryIds(category);
  const options = ksFlattenCategories(ksState.categories, 0, [])
    .filter(function (item) { return !blockedIds.has(item.id); })
    .map(function (item) {
      return '<option value="' + item.id + '">' +
        escapeHtml('　'.repeat(item.depth) + item.name) + '</option>';
    }).join('');
  if (heading) heading.textContent = mode === 'move' ? '移动「' + category.name + '」' : '重命名「' + category.name + '」';
  const saveButton = ksEl('ks-cat-edit-save');
  if (saveButton) saveButton.textContent = mode === 'move' ? '确认移动' : '保存';
  if (input) {
    input.value = category.name;
    input.classList.toggle('hidden', mode === 'move');
  }
  if (parentSelect) {
    parentSelect.innerHTML = '<option value="">一级分类</option>' + options;
    parentSelect.value = category.parent_id || '';
    parentSelect.classList.toggle('hidden', mode !== 'move');
  }
  if (mode === 'move' && parentSelect) parentSelect.focus();
  else if (input) input.focus();
}

async function ksUpdateCategory() {
  const category = ksFindCategory(ksState.categories, ksState.categoryActionId);
  if (!category || !category.can_manage) return;
  const input = ksEl('ks-cat-edit-name');
  const parentSelect = ksEl('ks-cat-edit-parent');
  const saveButton = ksEl('ks-cat-edit-save');
  const name = input ? input.value.trim() : '';
  if (ksState.categoryActionMode === 'rename' && !name) {
    showToast('请输入分类名称');
    if (input) input.focus();
    return;
  }
  if (saveButton) saveButton.disabled = true;
  try {
    const isMove = ksState.categoryActionMode === 'move';
    const r = await fetch(api('/api/knowledge/categories/' + category.id + (isMove ? '/move' : '')), {
      method: isMove ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isMove
        ? { parent_id: parentSelect && parentSelect.value ? parentSelect.value : null, before_id: null }
        : { name: name }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d.error || (isMove ? '移动分类失败' : '重命名分类失败'));
      return;
    }
    ksToggleCategoryEdit(false);
    await loadKnowledge();
    await ksLoadArticles();
    showToast(isMove ? '分类已移动' : '分类已重命名');
  } catch (e) {
    showToast('网络异常，请稍后重试');
  } finally {
    if (saveButton) saveButton.disabled = false;
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
    const r = await fetch(api('/api/knowledge/categories/' + category.id), { method: 'DELETE' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d.error || '删除分类失败');
      return;
    }
    if (ksState.currentCategory === category.id) ksState.currentCategory = null;
    ksToggleCategoryEdit(false);
    await loadKnowledge();
    showToast('分类已删除');
  } catch (e) {
    showToast('网络异常，请稍后重试');
  }
}

function ksCloseCategoryMenus(except) {
  document.querySelectorAll('.ks-tree-item.ks-menu-open').forEach(function (item) {
    if (item !== except) item.classList.remove('ks-menu-open');
  });
}

function ksBindCategoryMenus(tree) {
  tree.querySelectorAll('.ks-cat-menu-trigger').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      const item = button.closest('.ks-tree-item');
      const willOpen = !item.classList.contains('ks-menu-open');
      ksCloseCategoryMenus(item);
      item.classList.toggle('ks-menu-open', willOpen);
    });
  });
  tree.querySelectorAll('[data-cat-action]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      const item = button.closest('.ks-tree-item');
      const id = parseInt(item.dataset.cat, 10);
      item.classList.remove('ks-menu-open');
      if (button.dataset.catAction === 'delete') ksDeleteCategory(id);
      else ksToggleCategoryEdit(true, id, button.dataset.catAction);
    });
  });
}

function ksClearDragMarks(tree) {
  tree.querySelectorAll('.ks-drag-before,.ks-drag-after,.ks-drag-inside').forEach(function (item) {
    item.classList.remove('ks-drag-before', 'ks-drag-after', 'ks-drag-inside');
  });
}

function ksDropPosition(item, clientY) {
  if (item.classList.contains('ks-tree-overview')) return 'inside';
  const rect = item.getBoundingClientRect();
  const ratio = (clientY - rect.top) / Math.max(rect.height, 1);
  if (ratio < 0.28) return 'before';
  if (ratio > 0.72) return 'after';
  return 'inside';
}

function ksSiblingNodes(parentId) {
  if (!parentId) return ksState.categories;
  const parent = ksFindCategory(ksState.categories, parentId);
  return parent && parent.children ? parent.children : [];
}

async function ksMoveCategory(categoryId, parentId, beforeId) {
  const category = ksFindCategory(ksState.categories, categoryId);
  if (!category || !category.can_manage) return;
  try {
    const r = await fetch(api('/api/knowledge/categories/' + categoryId + '/move'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: parentId || null, before_id: beforeId || null }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d.error || '移动分类失败');
      return;
    }
    await loadKnowledge();
    await ksLoadArticles();
  } catch (e) {
    showToast('网络异常，请稍后重试');
  }
}

function ksBindCategoryDrag(tree) {
  tree.querySelectorAll('.ks-tree-item[draggable="true"]').forEach(function (item) {
    item.addEventListener('dragstart', function (event) {
      ksState.draggedCategoryId = parseInt(item.dataset.cat, 10);
      item.classList.add('ks-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(ksState.draggedCategoryId));
    });
  });

  tree.querySelectorAll('.ks-tree-item').forEach(function (item) {
    item.addEventListener('dragover', function (event) {
      if (!ksState.draggedCategoryId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      ksClearDragMarks(tree);
      const position = ksDropPosition(item, event.clientY);
      item.classList.add('ks-drag-' + position);
    });
    item.addEventListener('drop', function (event) {
      if (!ksState.draggedCategoryId) return;
      event.preventDefault();
      const draggedId = ksState.draggedCategoryId;
      const position = ksDropPosition(item, event.clientY);
      let parentId = null;
      let beforeId = null;
      if (!item.classList.contains('ks-tree-overview')) {
        const targetId = parseInt(item.dataset.cat, 10);
        const target = ksFindCategory(ksState.categories, targetId);
        if (position === 'inside') {
          parentId = targetId;
        } else {
          parentId = target ? target.parent_id : null;
          const siblings = ksSiblingNodes(parentId).filter(function (node) { return node.id !== draggedId; });
          const index = siblings.findIndex(function (node) { return node.id === targetId; });
          beforeId = position === 'before'
            ? targetId
            : (siblings[index + 1] ? siblings[index + 1].id : null);
        }
      }
      ksState.draggedCategoryId = null;
      tree.querySelectorAll('.ks-dragging').forEach(function (dragged) { dragged.classList.remove('ks-dragging'); });
      ksClearDragMarks(tree);
      ksMoveCategory(draggedId, parentId, beforeId);
    });
  });

  tree.addEventListener('dragend', function () {
    ksState.draggedCategoryId = null;
    ksClearDragMarks(tree);
    tree.querySelectorAll('.ks-dragging').forEach(function (item) { item.classList.remove('ks-dragging'); });
  });
}

// ---------- 视图切换 ----------
function ksShowView(view) {
  const page = document.querySelector('#main-knowledge .ks-page');
  if (page) page.dataset.view = view;
  ['list', 'read', 'edit'].forEach(function (v) {
    const el = ksEl('ks-' + v + '-view');
    if (el) el.classList.toggle('hidden', v !== view);
  });
}

// 绑定知识分享模块内的事件（在 index.html 末尾一次性绑定）
function initKnowledgeEvents() {
  const bind = function (id, ev, fn) { const e = ksEl(id); if (e) e.addEventListener(ev, fn); };
  bind('ks-new', 'click', function () { ksOpenEditor(null); });
  bind('ks-cat-add', 'click', function () { ksToggleCategoryCreate(true); });
  bind('ks-cat-save', 'click', ksAddCategory);
  bind('ks-cat-cancel', 'click', function () { ksToggleCategoryCreate(false); });
  bind('ks-cat-name', 'keydown', function (e) {
    if (e.key === 'Enter') ksAddCategory();
    if (e.key === 'Escape') ksToggleCategoryCreate(false);
  });
  bind('ks-cat-edit-save', 'click', ksUpdateCategory);
  bind('ks-cat-edit-cancel', 'click', function () { ksToggleCategoryEdit(false); });
  bind('ks-cat-edit-name', 'keydown', function (e) {
    if (e.key === 'Enter') ksUpdateCategory();
    if (e.key === 'Escape') ksToggleCategoryEdit(false);
  });
  bind('ks-back', 'click', function () { ksShowView('list'); });
  bind('ks-save-draft', 'click', function () {
    ksSave(ksState.editingStatus === 'published' ? 'published' : 'draft');
  });
  bind('ks-publish', 'click', function () { ksSave('published'); });
  bind('ks-edit-cancel', 'click', function () { ksShowView('list'); });
  bind('ks-search', 'input', function () { clearTimeout(ksState._t); ksState._t = setTimeout(ksLoadArticles, 300); });
  bind('ks-filter', 'change', ksLoadArticles);
  bind('ks-comment-submit', 'click', function () { ksSubmitComment(null, ksEl('ks-comment').value); });
  // 导入
  bind('ks-import-url', 'click', function () { ksToggleImport('url'); });
  bind('ks-import-file', 'click', function () { ksToggleImport('file'); });
  bind('ks-import-url-go', 'click', ksImportUrlGo);
  bind('ks-import-file-go', 'click', ksImportFileGo);
}
