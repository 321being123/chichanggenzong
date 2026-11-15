// ========== 评论通知与提醒设置的前端行为回归（2026-11-15，jsdom，真实脚本） ==========
// 只做确定性 DOM 行为回归，不是浏览器视觉/真机验收。
// 覆盖：@ 区间按编辑平移与失效（不靠文字搜索，同昵称可区分）、提醒设置面板读写与版本冲突、
//       结果不明（502/断网）时保留请求标识且持久化、失效通知只显示「内容已不可用」。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let pass = 0;

function escaper() {
  return function (v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
}

function mkResponse(status, data) {
  return { ok: status >= 200 && status < 300, status: status, json: async function () { return data; } };
}

function input(w, el) { el.dispatchEvent(new w.Event('input', { bubbles: true })); }

// ---------- 1. @ 区间 ----------
async function mentionRanges() {
  const dom = new JSDOM(
    '<textarea id="ta"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    w.escapeHtml = escaper();
    w.showToast = function () {};
    w.siteApi = { get: async function () { return { ok: true, payload: [] }; } };
    w.eval(read('public/js/knowledge.js'));

    const ta = w.document.getElementById('ta');
    w.ksInitMentionBox('main', ta, w.document.getElementById('panel'), w.document.getElementById('chips'));

    // 输入 @ 触发候选提示
    ta.value = '@';
    ta.selectionStart = ta.selectionEnd = 1;
    input(w, ta);
    assert.strictEqual(w.document.getElementById('panel').hidden, false, '输入 @ 应给出候选提示');

    // 选中第一个账号（昵称「读者」）
    w.ksApplyMention('main', { subjectId: '11111111-1111-1111-1111-111111111111', nickname: '读者', username: 'reader_a' });
    assert.strictEqual(ta.value, '@读者 ', '选中后应插入 @昵称 与空格');
    let list = w.ksReadMentions('main', ta.value);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].start, 0);
    assert.strictEqual(list[0].end, 3);

    // 在开头插入文字：区间必须整体平移
    ta.value = '开头 ' + ta.value;
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    input(w, ta);
    list = w.ksReadMentions('main', ta.value);
    assert.strictEqual(list.length, 1, '前面插入文字不能丢掉选择');
    assert.strictEqual(list[0].start, 3, '区间应随插入平移');
    assert.strictEqual(ta.value.slice(list[0].start, list[0].end), '@读者');

    // 再选一个同昵称的不同账号（第二个 @ 在末尾）
    ta.value = ta.value + '@';
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    input(w, ta);
    w.ksApplyMention('main', { subjectId: '22222222-2222-2222-2222-222222222222', nickname: '读者', username: 'reader_b' });
    list = w.ksReadMentions('main', ta.value);
    assert.strictEqual(list.length, 2, '同昵称的两个账号必须都能保留');
    assert.notStrictEqual(list[0].start, list[1].start);
    assert.strictEqual(list[0].subjectId, '11111111-1111-1111-1111-111111111111');
    assert.strictEqual(list[1].subjectId, '22222222-2222-2222-2222-222222222222',
      '第二个 @ 必须绑定第二个账号，不能靠文字搜索撞到第一个');
    assert.strictEqual(list[0].start, 3);
    assert.strictEqual(list[1].start, 7);

    // 开头再手打一段同样的「@读者」（不是从候选选的）：不能被当成选择，也不能抢走真正的区间。
    // 靠文字搜索的实现会在这里把 A 绑到手动文字上（start 变 3），区间跟踪则整体平移 +7。
    ta.value = '手动 @读者 ' + ta.value;
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    input(w, ta);
    list = w.ksReadMentions('main', ta.value);
    assert.strictEqual(list.length, 2, '手打的同样文字不得新增或吞掉选择');
    assert.strictEqual(list[0].start, 10, '第一个选择的区间应随前缀平移（不是手打那段）');
    assert.strictEqual(list[1].start, 14);
    assert.strictEqual(ta.value.slice(list[0].start, list[0].end), '@读者');

    // 编辑第一个选择的文字：该选择作废，第二个保留并保持自己的主体
    const first = list[0];
    ta.value = ta.value.slice(0, first.start) + '@同事' + ta.value.slice(first.end);
    ta.selectionStart = ta.selectionEnd = first.start + 3;
    input(w, ta);
    list = w.ksReadMentions('main', ta.value);
    assert.strictEqual(list.length, 1, '被编辑过的 @ 必须撤销');
    assert.strictEqual(list[0].subjectId, '22222222-2222-2222-2222-222222222222');
    assert.strictEqual(ta.value.slice(list[0].start, list[0].end), '@读者');

    // 退格删掉第二个选择的文字：同样撤销
    ta.value = ta.value.slice(0, list[0].start) + '@读';
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    input(w, ta);
    assert.strictEqual(w.ksReadMentions('main', ta.value).length, 0, '删掉选中文字后不再提交该 @');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 2. 提醒设置面板 ----------
async function settingsPanel() {
  const dom = new JSDOM('<div id="main-notifications"><div id="nt-body"></div></div>', {
    url: 'https://example.test/?main=notifications', runScripts: 'outside-only',
  });
  const w = dom.window;
  try {
    const toasts = [];
    let prefs = { articleComment: true, commentReply: true, commentMention: true, feedbackImplemented: true, version: 3, defaults: false };
    const puts = [];
    let failNextPutStatus = 0;
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function (m) { toasts.push(String(m)); };
    w.api = x => x;
    w.siteApi = {
      requestRaw: async function (url, opts) {
        const method = (opts && opts.method) || 'GET';
        if (url.indexOf('/preferences') >= 0) {
          if (method === 'PUT') {
            const body = JSON.parse(opts.body);
            puts.push(body);
            if (failNextPutStatus) {
              const s = failNextPutStatus;
              failNextPutStatus = 0;
              return { ok: false, status: s, response: mkResponse(s, { error: '提醒设置已在其他设备更新，请重新获取' }) };
            }
            prefs = Object.assign({}, body, { version: body.version + 1, defaults: false });
            return { ok: true, status: 200, response: mkResponse(200, prefs) };
          }
          return { ok: true, status: 200, response: mkResponse(200, prefs) };
        }
        return { ok: true, status: 200, response: mkResponse(200, { items: [], complete: true, category: 'all' }) };
      },
      post: async function () { return { ok: true, status: 200, payload: {} }; },
    };
    w.eval(read('public/js/presenters/notifications-presenter.js'));
    w.eval(read('public/js/notifications.js'));

    w.AppNotifications.load();
    await tick();
    await w.appNotificationsPresenter.openPreferences();
    await tick();

    const boxes = w.document.querySelectorAll('[data-nt-pref]');
    assert.strictEqual(boxes.length, 4, '设置面板应有四项开关');
    assert.ok(w.document.querySelector('[data-nt-pref="feedbackImplemented"]').checked, '默认开启时应勾选');
    assert.ok(w.document.body.textContent.indexOf('自己反馈的处理结果') >= 0, '反馈项应面向用户命名');
    assert.ok(w.document.body.textContent.indexOf('不会补发') >= 0, '应说明重开不补发');

    // 取消「文章收到评论」后保存：必须带上四项布尔与当前版本
    w.document.querySelector('[data-nt-pref="articleComment"]').checked = false;
    w.document.querySelector('[data-nt-act="prefs-save"]').click();
    await tick();
    await tick();
    assert.strictEqual(puts.length, 1, '保存应发出一次请求');
    assert.strictEqual(puts[0].version, 3, '保存必须带服务端当前版本');
    assert.strictEqual(puts[0].articleComment, false);
    assert.strictEqual(puts[0].commentReply, true);
    assert.strictEqual(puts[0].commentMention, true);
    assert.strictEqual(puts[0].feedbackImplemented, true);
    assert.strictEqual(w.appNotificationsPresenter.state.prefsVersion, 4, '保存成功后版本应更新');
    assert.ok(toasts.some(function (m) { return m.indexOf('已保存') >= 0; }));

    // 版本冲突：不覆盖，提示并重新获取（GET 再次读回最新值）
    failNextPutStatus = 409;
    w.document.querySelector('[data-nt-act="prefs-save"]').click();
    await tick();
    await tick();
    assert.ok(toasts.some(function (m) { return m.indexOf('其他设备') >= 0; }), '冲突必须明确提示');
    assert.strictEqual(puts.length, 2, '冲突不能写入第二次覆盖');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 3. 结果不明时的请求标识 ----------
async function retryRequestId() {
  const dom = new JSDOM('<div id="ks-comment-list"></div>', {
    url: 'https://example.test/?main=knowledge', runScripts: 'outside-only',
  });
  const w = dom.window;
  try {
    const toasts = [];
    const posts = [];
    let nextResult = { ok: false, status: 502, payload: null };
    w.username = 'alice';
    w.accountIdentity = '100';
    w.showToast = function (m) { toasts.push(String(m)); };
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.ksClearCommentInput = function () {};
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        const r = nextResult;
        nextResult = { ok: true, status: 200, payload: { id: 1 } };
        return r;
      },
    };
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    // 第一次：502（服务端可能已提交）
    await w.ksSubmitComment(null, '这条评论', null);
    assert.ok(toasts.some(function (m) { return m.indexOf('可能已提交') >= 0; }), '5xx 应提示可能已提交');
    const firstId = posts[0].client_request_id;
    assert.ok(firstId, '提交必须带请求标识');
    const stored = JSON.parse(w.sessionStorage.getItem('ks-pending-comments') || '{}');
    assert.ok(Object.keys(stored).some(function (k) { return stored[k] && stored[k].id === firstId; }),
      '结果不明时待确认记录必须持久化（刷新后仍能复用同一标识）');

    // 第二次同样内容：必须复用同一标识（服务端据此返回原评论，不重复发表）
    await w.ksSubmitComment(null, '这条评论', null);
    assert.strictEqual(posts[1].client_request_id, firstId, '重试必须复用同一请求标识');

    // 服务端明确拒绝（400）：丢弃标识，下一次换新
    nextResult = { ok: false, status: 400, payload: { error: '@ 与所选账号的当前昵称不一致' } };
    await w.ksSubmitComment(null, '另一条评论', null);
    const rejectedId = posts[2].client_request_id;
    await w.ksSubmitComment(null, '另一条评论', null);
    assert.notStrictEqual(posts[3].client_request_id, rejectedId, '4xx 之后应换新标识，避免永远撞旧失败');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 4. 失效通知展示 ----------
async function invalidatedItem() {
  const dom = new JSDOM('<div id="main-notifications"><div id="nt-body"></div></div>', {
    url: 'https://example.test/?main=notifications', runScripts: 'outside-only',
  });
  const w = dom.window;
  try {
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function () {};
    w.api = x => x;
    w.CoreDate = { dateTimeInZone: function () { return '2026-11-15 10:00'; } };
    w.siteApi = { requestRaw: async function () { return { ok: true, status: 200, response: mkResponse(200, { items: [], complete: true }) }; } };
    w.eval(read('public/js/presenters/notifications-presenter.js'));
    w.eval(read('public/js/notifications.js'));
    w.AppNotifications.load();
    await tick();

    const state = w.appNotificationsPresenter.state;
    state.items = [{
      id: '9', recipientId: '9', type: 'comment', category: 'comment',
      title: '你的文章收到了新评论', body: '', unavailable: true, invalidated: true,
      read: false, createdAt: '2026-11-15T02:00:00Z', target: { kind: 'none' },
    }];
    w.AppNotifications.refresh === 'function' && null;
    w.appNotificationsRender();
    const text = w.document.getElementById('nt-body').textContent;
    assert.ok(text.indexOf('内容已不可用') >= 0, '失效条目必须显示「内容已不可用」');
    assert.ok(text.indexOf('文章标题') < 0, '失效条目不得显示原正文');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 5. 正文首尾空格不能丢 @ ----------
async function leadingSpaceMention() {
  const dom = new JSDOM(
    '<textarea id="ta"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const posts = [];
    w.username = 'alice';
    w.escapeHtml = escaper();
    w.showToast = function () {};
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: true, status: 200, payload: { id: 1 } };
      },
    };
    w.eval(read('public/js/knowledge.js'));
    // 函数声明会覆盖预先挂到 window 上的桩，加载脚本后再替换阅读视图与评论渲染
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.ksClearCommentInput = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    const ta = w.document.getElementById('ta');
    w.ksInitMentionBox('main', ta, w.document.getElementById('panel'), w.document.getElementById('chips'));
    // 先打两个空格再输入 @ 并从候选选中「读者」
    ta.value = '  ';
    ta.selectionStart = ta.selectionEnd = 2;
    input(w, ta);
    ta.value = '  @';
    ta.selectionStart = ta.selectionEnd = 3;
    input(w, ta);
    w.ksApplyMention('main', { subjectId: '11111111-1111-1111-1111-111111111111', nickname: '读者', username: 'reader_a' });
    assert.strictEqual(ta.value, '  @读者 ', '前置空格应保留在输入框里');
    assert.strictEqual(w.ksReadMentions('main', ta.value).length, 1);

    // 提交：正文会去掉首尾空格，@ 的区间必须同步平移
    await w.ksSubmitComment(null, ta.value, 'main');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].content, '@读者', '提交正文应去首尾空格');
    assert.ok(Array.isArray(posts[0].mentions) && posts[0].mentions.length === 1,
      '开头有空格时也不能丢掉已选的 @');
    assert.strictEqual(posts[0].mentions[0].start, 0, '区间必须按去掉的首部字符数平移');
    assert.strictEqual(posts[0].mentions[0].end, 3);
    assert.strictEqual(posts[0].content.slice(posts[0].mentions[0].start, posts[0].mentions[0].end), '@读者',
      '提交的区间必须与提交的正文一致，否则服务端会拒绝或漏发');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 6. 会话存储不可用时的标识兜底 ----------
async function storageUnavailable() {
  const dom = new JSDOM('<div id="ks-comment-list"></div>', {
    url: 'https://example.test/?main=knowledge', runScripts: 'outside-only',
  });
  const w = dom.window;
  try {
    const posts = [];
    const toasts = [];
    w.username = 'alice';
    w.showToast = function (m) { toasts.push(String(m)); };
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.ksClearCommentInput = function () {};
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: false, status: 502, payload: null };
      },
    };
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    // 模拟隐私模式/存储被禁用：任何访问 sessionStorage 都抛错
    Object.defineProperty(w, 'sessionStorage', {
      configurable: true,
      get: function () { throw new Error('storage denied'); },
    });
    await w.ksOpenArticle(7);

    await w.ksSubmitComment(null, '存储不可用时的评论', null);
    await w.ksSubmitComment(null, '存储不可用时的评论', null);
    assert.strictEqual(posts.length, 2);
    assert.ok(posts[0].client_request_id, '第一次提交必须带请求标识');
    assert.strictEqual(posts[1].client_request_id, posts[0].client_request_id,
      '存储不可用时仍要靠内存副本复用同一标识，否则重试会重复发表');
    assert.ok(toasts.some(function (m) { return m.indexOf('可能已提交') >= 0; }));
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 7. 待确认提交的完整内容与 @ 目标 ----------
async function pendingDraftWithMentions() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const toasts = [];
    const posts = [];
    let response = { ok: false, status: 502, payload: null };
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function (m) { toasts.push(String(m)); };
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        const r = response;
        response = { ok: true, status: 200, payload: { id: 99 } };
        return r;
      },
    };
    w.eval(read('public/js/knowledge.js'));
    // 函数声明会覆盖预设桩，加载脚本后再替换阅读视图与评论渲染
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.ksClearCommentInput = function () { w.document.getElementById('ks-comment').value = ''; };
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    const ta = w.document.getElementById('ks-comment');
    w.ksInitMentionBox('main', ta, w.document.getElementById('panel'), w.document.getElementById('chips'));
    ta.value = '@';
    ta.selectionStart = ta.selectionEnd = 1;
    input(w, ta);
    w.ksApplyMention('main', { subjectId: '11111111-1111-1111-1111-111111111111', nickname: '读者', username: 'reader_a' });
    ta.value = ta.value + '请看这条';
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    input(w, ta);

    // 第一次提交：502（结果不明），待确认记录必须带 @ 目标
    await w.ksSubmitComment(null, ta.value, 'main');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].mentions.length, 1, '第一条提交应带 1 条 @');
    const stored = JSON.parse(w.sessionStorage.getItem('ks-pending-comments') || '{}');
    const record = Object.keys(stored).map(function (k) { return stored[k]; })[0];
    assert.ok(record && record.id === posts[0].client_request_id, '待确认记录应保存编号');
    assert.ok(Array.isArray(record.mentions) && record.mentions.length === 1,
      '待确认记录必须连 @ 目标一起保存，不能只存编号');
    assert.strictEqual(record.content, posts[0].content);

    // 用户移除了 @ 选择后重试：必须拒绝，不能换编号，也不能静默改内容
    w.ksResetMentions('main');
    await w.ksSubmitComment(null, ta.value, 'main');
    assert.strictEqual(posts.length, 1, '结果未确认期间不得再发一条');
    assert.ok(toasts.some(function (m) { return m.indexOf('还没确认') >= 0; }), '应提示先原样重试或放弃');

    // 刷新/重新进入文章：正文与 @ 选择都要恢复
    await w.ksOpenArticle(7);
    assert.strictEqual(ta.value, record.content, '应把未确认的正文恢复为草稿');
    const restored = w.ksReadMentions('main', record.content);
    assert.strictEqual(restored.length, 1, '恢复草稿时 @ 选择必须一起回来');
    assert.strictEqual(restored[0].subjectId, '11111111-1111-1111-1111-111111111111');
    assert.strictEqual(w.document.getElementById('ks-comment-notice').hidden, false, '应提示这是未确认的草稿');

    // 原样重试：复用同一编号
    await w.ksSubmitComment(null, ta.value, 'main');
    assert.strictEqual(posts.length, 2);
    assert.strictEqual(posts[1].client_request_id, posts[0].client_request_id, '原样重试必须复用编号');
    assert.deepStrictEqual(posts[1].mentions, posts[0].mentions, '@ 目标也必须原样带上');

    // 成功之后记录被清掉，再发新内容就是新编号
    assert.ok(!w.sessionStorage.getItem('ks-pending-comments') || Object.keys(JSON.parse(w.sessionStorage.getItem('ks-pending-comments'))).length === 0,
      '提交成功后不能留下待确认记录');
    await w.ksSubmitComment(null, '第二条完全不同的评论', 'main');
    assert.notStrictEqual(posts[2].client_request_id, posts[0].client_request_id);
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 8. 明确放弃未确认提交 ----------
async function discardPending() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const posts = [];
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function () {};
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: false, status: 502, payload: null };
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    const ta = w.document.getElementById('ks-comment');
    w.ksInitMentionBox('main', ta, w.document.getElementById('panel'), w.document.getElementById('chips'));
    await w.ksSubmitComment(null, '要放弃的评论', 'main');
    assert.strictEqual(posts.length, 1);

    w.ksDiscardPendingComment();
    const stored = w.sessionStorage.getItem('ks-pending-comments');
    assert.ok(!stored || Object.keys(JSON.parse(stored)).length === 0, '放弃后必须清掉待确认记录');
    assert.strictEqual(w.document.getElementById('ks-comment-notice').hidden, true, '放弃后提示应消失');

    // 放弃之后再发新内容：允许，且用新编号
    await w.ksSubmitComment(null, '放弃后的新评论', 'main');
    assert.strictEqual(posts.length, 2);
    assert.notStrictEqual(posts[1].client_request_id, posts[0].client_request_id);
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 9. 待确认草稿必须绑定账号 ----------
async function pendingBoundToAccount() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const posts = [];
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function () {};
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: false, status: 502, payload: null };
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    const ta = w.document.getElementById('ks-comment');
    w.ksInitMentionBox('main', ta, w.document.getElementById('panel'), w.document.getElementById('chips'));
    ta.value = '@';
    ta.selectionStart = ta.selectionEnd = 1;
    input(w, ta);
    w.ksApplyMention('main', { subjectId: '11111111-1111-1111-1111-111111111111', nickname: '读者', username: 'reader_a' });
    ta.value = ta.value + '甲账号的草稿';
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    input(w, ta);
    await w.ksSubmitComment(null, ta.value, 'main');
    assert.strictEqual(posts.length, 1);
    const pendingContent = posts[0].content;

    // 切到另一个账号（不同身份）再看同一篇文章：上一个人的草稿不能出现
    w.username = 'bob';
    w.accountIdentity = '200';
    ta.value = '';
    w.ksResetMentions('main');
    w.document.getElementById('ks-comment-notice').hidden = true;
    await w.ksOpenArticle(7);
    assert.strictEqual(ta.value, '', '换账号后不得恢复上一个账号的草稿正文');
    assert.strictEqual(w.ksReadMentions('main', ta.value || '').length, 0, '也不得恢复上一个人的 @ 选择');
    assert.strictEqual(w.document.getElementById('ks-comment-notice').hidden, true, '不得显示他人草稿的提示');

    // 换回原账号：草稿仍在（记录没被其他人的访问破坏）
    w.username = 'alice';
    w.accountIdentity = '100';
    await w.ksOpenArticle(7);
    assert.strictEqual(ta.value, pendingContent, '原账号回来应能恢复自己的草稿');
    assert.strictEqual(w.ksReadMentions('main', ta.value).length, 1);
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 10. 回复的待确认内容可恢复 / 重试 / 放弃 ----------
async function pendingReplyDraft() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div>'
    + '<div id="ks-comment-list"><div class="ks-comment-item" data-cid="55">'
    + '<button class="ks-reply-btn" data-id="55" data-nick="读者">回复</button></div></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const toasts = [];
    const posts = [];
    let response = { ok: false, status: 502, payload: null };
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function (m) { toasts.push(String(m)); };
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        const r = response;
        response = { ok: true, status: 200, payload: { id: 99 } };
        return r;
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    // 打开 55 号评论的回复框并选中一个 @，提交（502 结果不明）
    const wrap = w.ksEnsureReplyBox(55);
    assert.ok(wrap, '应能创建回复框');
    const replyText = wrap.querySelector('.ks-reply-text');
    replyText.value = '@';
    replyText.selectionStart = replyText.selectionEnd = 1;
    input(w, replyText);
    w.ksApplyMention('reply-55', { subjectId: '11111111-1111-1111-1111-111111111111', nickname: '读者', username: 'reader_a' });
    replyText.value = replyText.value + '这条回复很重要';
    replyText.selectionStart = replyText.selectionEnd = replyText.value.length;
    input(w, replyText);
    await w.ksSubmitComment(55, replyText.value, 'reply-55');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].parent_id, 55, '回复必须带父评论编号');
    const replyContent = posts[0].content;

    // 模拟刷新/重新进入文章：回复不能消失，也不能只剩一个「必须原样重试」的死胡同
    w.document.getElementById('ks-comment-list').innerHTML = ''
      + '<div class="ks-comment-item" data-cid="55">'
      + '<button class="ks-reply-btn" data-id="55" data-nick="读者">回复</button></div>';
    await w.ksOpenArticle(7);
    const restoredWrap = w.document.querySelector('.ks-reply-box[data-pid="55"]');
    assert.ok(restoredWrap, '重新进入文章时应自动恢复未确认的回复框');
    assert.strictEqual(restoredWrap.querySelector('.ks-reply-text').value, replyContent, '回复正文应恢复');
    assert.strictEqual(w.ksReadMentions('reply-55', replyContent).length, 1, '回复里的 @ 选择也应恢复');
    assert.strictEqual(restoredWrap.querySelector('.ks-comment-notice').hidden, false, '应提示这是未确认的回复');

    // 改内容重试：必须被拒（否则可能重复）
    const changed = replyContent + '（改了）';
    restoredWrap.querySelector('.ks-reply-text').value = changed;
    input(w, restoredWrap.querySelector('.ks-reply-text'));
    await w.ksSubmitComment(55, changed, 'reply-55');
    assert.strictEqual(posts.length, 1, '回复结果未确认期间不得再发一条');
    assert.ok(toasts.some(function (m) { return m.indexOf('还没确认') >= 0; }));

    // 放弃这条回复：记录与草稿都清掉，之后可以按新回复重发
    restoredWrap.querySelector('[data-ks-draft="discard"]').click();
    assert.strictEqual(restoredWrap.querySelector('.ks-comment-notice').hidden, true, '放弃后提示应消失');
    assert.strictEqual(restoredWrap.querySelector('.ks-reply-text').value, '', '放弃后草稿应清空');
    await w.ksSubmitComment(55, '放弃后重新写的回复', 'reply-55');
    assert.strictEqual(posts.length, 2);
    assert.notStrictEqual(posts[1].client_request_id, posts[0].client_request_id, '放弃后应使用新编号');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 11. 账号身份缺失时只在本页保留 ----------
async function identityMissingPending() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const toasts = [];
    const posts = [];
    let response = { ok: false, status: 502, payload: null };
    w.username = 'alice';
    w.accountIdentity = '';   // 身份缺失：无法区分「删号后同名重建」
    w.escapeHtml = escaper();
    w.showToast = function (m) { toasts.push(String(m)); };
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        const r = response;
        response = { ok: true, status: 200, payload: { id: 99 } };
        return r;
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    const ta = w.document.getElementById('ks-comment');
    w.ksInitMentionBox('main', ta, w.document.getElementById('panel'), w.document.getElementById('chips'));
    await w.ksSubmitComment(null, '身份缺失时的评论', 'main');
    assert.strictEqual(posts.length, 1);
    assert.ok(toasts.some(function (m) { return m.indexOf('不要刷新') >= 0; }),
      '身份缺失时必须明确提示只能在本页重试');

    // 不能写进会话存储：同名重建的账号下次会拿不到身份，无法区分新旧
    const stored = w.sessionStorage.getItem('ks-pending-comments');
    assert.ok(!stored || Object.keys(JSON.parse(stored)).length === 0,
      '身份缺失的待确认记录不得跨会话保存');

    // 同一页面内仍可恢复并可安全重试
    ta.value = '';
    w.ksResetMentions('main');
    await w.ksOpenArticle(7);
    assert.strictEqual(ta.value, '身份缺失时的评论', '本页内仍应恢复草稿');

    // 换成同名但拿到身份的账号：不得看到上一条草稿
    w.username = 'alice';
    w.accountIdentity = '999';
    ta.value = '';
    w.ksResetMentions('main');
    await w.ksOpenArticle(7);
    assert.strictEqual(ta.value, '', '身份不同（同名重建）不得恢复旧草稿');

    // 回到身份缺失的同一页面：记录还在内存里，仍可原样重试
    w.accountIdentity = '';
    await w.ksOpenArticle(7);
    assert.strictEqual(ta.value, '身份缺失时的评论');
    await w.ksSubmitComment(null, ta.value, 'main');
    assert.strictEqual(posts[1].client_request_id, posts[0].client_request_id, '本页重试必须复用同一编号');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 12. 同一文章多条待确认回复都要能恢复 ----------
async function multiplePendingReplies() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div>'
    + '<div id="ks-comment-list">'
    + '<div class="ks-comment-item" data-cid="55"><button class="ks-reply-btn" data-id="55" data-nick="甲">回复</button></div>'
    + '<div class="ks-comment-item" data-cid="66"><button class="ks-reply-btn" data-id="66" data-nick="乙">回复</button></div>'
    + '</div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const posts = [];
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function () {};
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: false, status: 502, payload: null };
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    // 两条不同楼层的回复都提交，结果都不明
    await w.ksSubmitComment(55, '对甲的回复', 'reply-55');
    assert.strictEqual(posts.length, 1);
    w.ksEnsureReplyBox(55);
    w.document.querySelector('.ks-reply-box[data-pid="55"] .ks-reply-text').value = '对甲的回复';
    await w.ksSubmitComment(66, '对乙的回复', 'reply-66');
    assert.strictEqual(posts.length, 2);

    // 重新进入文章：两条回复都必须各自恢复，不能只剩最后一条
    await w.ksOpenArticle(7);
    const boxA = w.document.querySelector('.ks-reply-box[data-pid="55"]');
    const boxB = w.document.querySelector('.ks-reply-box[data-pid="66"]');
    assert.ok(boxA, '第一条回复的框必须恢复');
    assert.ok(boxB, '第二条回复的框必须恢复');
    assert.strictEqual(boxA.querySelector('.ks-reply-text').value, '对甲的回复');
    assert.strictEqual(boxB.querySelector('.ks-reply-text').value, '对乙的回复');
    assert.strictEqual(boxA.querySelector('.ks-comment-notice').hidden, false, '第一条也要有提示与放弃入口');
    assert.strictEqual(boxB.querySelector('.ks-comment-notice').hidden, false);

    // 放弃第一条：只清第一条，第二条保持
    boxA.querySelector('[data-ks-draft="discard"]').click();
    assert.strictEqual(boxA.querySelector('.ks-comment-notice').hidden, true);
    assert.strictEqual(boxA.querySelector('.ks-reply-text').value, '');
    assert.strictEqual(boxB.querySelector('.ks-reply-text').value, '对乙的回复', '放弃一条不得波及另一条');
    assert.strictEqual(boxB.querySelector('.ks-comment-notice').hidden, false);
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 13. 旧版本遗留的待确认记录不得恢复 ----------
async function legacyPendingIgnored() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const posts = [];
    w.username = 'alice';
    w.accountIdentity = '';   // 身份缺失：同名重建无法区分
    w.escapeHtml = escaper();
    w.showToast = function () {};
    // 更早版本写入的遗留记录：键已退化成 u:用户名|id:，且没有 persistable 标记
    w.sessionStorage.setItem('ks-pending-comments', JSON.stringify({
      'u:alice|id:|7|': {
        id: 'legacy-id', owner: 'u:alice|id:', articleId: '7', parentId: null,
        content: '旧版本遗留的草稿', mentions: [],
      },
    }));
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: false, status: 502, payload: null };
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    // 主评论框必须在打开文章前就存在：否则恢复函数拿不到输入框，测出来的「没恢复」是假象
    const ta = w.document.getElementById('ks-comment');
    w.ksInitMentionBox('main', ta, w.document.getElementById('panel'), w.document.getElementById('chips'));
    await w.ksOpenArticle(7);

    assert.strictEqual(ta.value, '', '身份缺失时不得恢复旧版本遗留的草稿');
    assert.strictEqual(w.document.getElementById('ks-comment-notice').hidden, true, '不得显示遗留草稿的提示');
    const afterLoad = w.sessionStorage.getItem('ks-pending-comments');
    assert.ok(!afterLoad || Object.keys(JSON.parse(afterLoad)).length === 0,
      '遗留记录应在载入时被清掉，不能一直留在存储里');

    // 本页新提交仍然只留内存：结果不明也不落盘
    await w.ksSubmitComment(null, '新的评论', 'main');
    assert.strictEqual(posts.length, 1);
    const afterSubmit = w.sessionStorage.getItem('ks-pending-comments');
    assert.ok(!afterSubmit || Object.keys(JSON.parse(afterSubmit)).length === 0,
      '身份缺失时新提交也不得写入会话存储');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 14. 收起回复框 / 刷新评论列表后仍可恢复 ----------
async function pendingReplySurvivesPaint() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div>'
    + '<div id="ks-comment-list">'
    + '<div class="ks-comment-item" data-cid="55"><button class="ks-reply-btn" data-id="55" data-nick="甲">回复</button></div>'
    + '</div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const toasts = [];
    const posts = [];
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function (m) { toasts.push(String(m)); };
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: false, status: 502, payload: null };
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    await w.ksSubmitComment(55, '待确认的回复', 'reply-55');
    assert.strictEqual(posts.length, 1);

    const box = () => w.document.querySelector('.ks-reply-box[data-pid="55"]');
    const paintList = () => w.ksPaintComments([{
      id: 55, nickname: '甲', content: '父评论', created_at: '2026-11-15T02:00:00Z',
      can_delete: false, replies: [],
    }]);

    // 评论列表刷新（整块重绘会销毁回复框）：恢复必须跟着重建，而且重绘时按钮才是真绑定
    paintList();
    assert.ok(box(), '列表刷新后仍要恢复未确认的回复框');
    assert.strictEqual(box().querySelector('.ks-reply-text').value, '待确认的回复');
    assert.strictEqual(box().querySelector('.ks-comment-notice').hidden, false);

    // 连点两次「回复」：不能把待确认的框收起（收起后正文与放弃入口都没了）
    const replyBtn = w.document.querySelector('.ks-reply-btn[data-id="55"]');
    replyBtn.click();
    assert.ok(box(), '第一次点「回复」不得收起未确认的框');
    replyBtn.click();
    assert.ok(box(), '第二次点「回复」也不得收起未确认的框');
    assert.strictEqual(box().querySelector('.ks-reply-text').value, '待确认的回复', '正文必须还在');
    assert.strictEqual(box().querySelector('.ks-comment-notice').hidden, false, '放弃入口必须还在');
    assert.ok(toasts.some(function (m) { return m.indexOf('还没确认') >= 0; }), '应提示先重试或放弃');

    // 再刷新一次：仍然恢复
    paintList();
    assert.ok(box(), '再次刷新列表后仍要恢复');
    assert.strictEqual(box().querySelector('.ks-reply-text').value, '待确认的回复');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 15. 存储写入失败时提示刷新风险 ----------
async function storageWriteFailureTip() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const toasts = [];
    const posts = [];
    w.username = 'alice';
    w.accountIdentity = '100';   // 身份可用：单看身份会误判成「可以放心刷新」
    w.escapeHtml = escaper();
    w.showToast = function (m) { toasts.push(String(m)); };
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: false, status: 502, payload: null };
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    // 模拟配额满/隐私模式：能读到存储对象，但 setItem 抛错
    Object.defineProperty(w, 'sessionStorage', {
      configurable: true,
      get: function () {
        return {
          getItem: function () { return null; },
          setItem: function () { throw new Error('QuotaExceededError'); },
        };
      },
    });
    await w.ksOpenArticle(7);
    await w.ksSubmitComment(null, '存储写不进去的评论', 'main');

    assert.strictEqual(posts.length, 1);
    const tip = toasts.filter(function (m) { return m.indexOf('可能已提交') >= 0; }).join(' ');
    assert.ok(tip.indexOf('刷新') >= 0, '存储不可用时必须提醒刷新会丢：' + tip);
    assert.ok(tip.indexOf('不要刷新') >= 0 || tip.indexOf('刷新会丢失') >= 0, '提示要写明刷新风险');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 16. 超过上限不得静默丢弃最早记录 ----------
async function pendingLimitKeepsOldRecords() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const toasts = [];
    const posts = [];
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function (m) { toasts.push(String(m)); };
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: false, status: 502, payload: null };
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    for (let i = 1; i <= 10; i++) {
      await w.ksSubmitComment(1000 + i, '未确认的回复 ' + i, null);
    }
    assert.strictEqual(posts.length, 10);
    const firstId = posts[0].client_request_id;
    const stored = JSON.parse(w.sessionStorage.getItem('ks-pending-comments') || '{}');
    assert.strictEqual(Object.keys(stored).length, 10, '应存满 10 条');

    // 第 11 条：必须被拒绝并说明原因，不能悄悄丢掉最早那条
    await w.ksSubmitComment(2000, '第 11 条', null);
    assert.strictEqual(posts.length, 10, '超过上限时不得再发请求');
    assert.ok(toasts.some(function (m) { return m.indexOf('没确认') >= 0; }), '应提示先处理未确认的评论');
    const after = JSON.parse(w.sessionStorage.getItem('ks-pending-comments') || '{}');
    assert.strictEqual(Object.keys(after).length, 10, '不得因超限删除记录');
    assert.ok(Object.keys(after).some(function (k) { return after[k].id === firstId; }),
      '最早那条记录必须还在，否则它若已提交、重试就会重复发表');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 17. 请求飞行中切换账号：旧响应不得动新账号的记录 ----------
async function ownerSwitchDuringRequest() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const toasts = [];
    const posts = [];
    let releaseFirst = null;
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function (m) { toasts.push(String(m)); };
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: function (url, body) {
        if (url.indexOf('/view') >= 0) return Promise.resolve({ ok: true, status: 200, payload: {} });
        posts.push(body);
        // 第一个请求挂起，模拟「A 的响应在切号之后才回来」
        if (posts.length === 1) {
          return new Promise(function (resolve) { releaseFirst = resolve; });
        }
        return Promise.resolve({ ok: false, status: 502, payload: null });
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    // A 提交（请求挂起，没有返回）
    const pendingA = w.ksSubmitComment(null, '甲账号的评论', null);
    assert.strictEqual(posts.length, 1, 'A 的请求应已发出');
    const idA = posts[0].client_request_id;

    // 切到 B，并在同一位置发一条：结果不明，必须保留 B 的待确认记录
    w.username = 'bob';
    w.accountIdentity = '200';
    await w.ksSubmitComment(null, '乙账号的评论', null);
    assert.strictEqual(posts.length, 2);
    const idB = posts[1].client_request_id;
    assert.notStrictEqual(idB, idA, '不同账号不能用同一个请求编号');

    // A 的成功响应此刻才回来：只能清 A 自己那条记录，不能清 B 的
    releaseFirst({ ok: true, status: 200, payload: { id: 99 } });
    await pendingA;

    const stored = JSON.parse(w.sessionStorage.getItem('ks-pending-comments') || '{}');
    const rows = Object.keys(stored).map(function (k) { return stored[k]; });
    assert.ok(rows.some(function (r) { return r.owner === 'u:bob|id:200' && r.id === idB; }),
      'B 的待确认记录必须还在，不能被 A 的响应清掉');
    assert.ok(!rows.some(function (r) { return r.owner === 'u:alice|id:100'; }),
      'A 已成功的记录应被清掉（它按发起时的账号清）');
    assert.ok(!toasts.some(function (m) { return m.indexOf('评论已发表') >= 0; }),
      'A 的成功结果不能提示到 B 的页面上');

    // B 原样重试：必须复用自己原来的编号（否则第一次若已落库就会多一条）
    await w.ksSubmitComment(null, '乙账号的评论', null);
    assert.strictEqual(posts.length, 3);
    assert.strictEqual(posts[2].client_request_id, idB, 'B 重试必须沿用自己原来的请求编号');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

// ---------- 18. 待确认上限按账号分别计算 ----------
async function pendingLimitPerAccount() {
  const dom = new JSDOM(
    '<textarea id="ks-comment"></textarea><div id="panel" role="listbox" hidden></div><div id="chips" hidden></div>'
    + '<div id="ks-comment-notice" hidden></div><div id="ks-comment-list"></div>',
    { url: 'https://example.test/?main=knowledge', runScripts: 'outside-only' }
  );
  const w = dom.window;
  try {
    const toasts = [];
    const posts = [];
    w.username = 'alice';
    w.accountIdentity = '100';
    w.escapeHtml = escaper();
    w.showToast = function (m) { toasts.push(String(m)); };
    w.siteApi = {
      get: async function () { return { ok: true, status: 200, payload: { id: 7, title: '文章', status: 'published' } }; },
      post: async function (url, body) {
        if (url.indexOf('/view') >= 0) return { ok: true, status: 200, payload: {} };
        posts.push(body);
        return { ok: false, status: 502, payload: null };
      },
    };
    w.eval(read('public/js/knowledge.js'));
    w.ksPaintArticle = function () {};
    w.ksShowView = function () {};
    w.ksPaintCommentsPrepare = function () { return false; };
    w.ksPaintComments = function () {};
    w.eval(read('public/js/presenters/knowledge-presenter.js'));
    await w.ksOpenArticle(7);

    // A 用自己的 10 条占满上限
    for (let i = 1; i <= 10; i++) {
      await w.ksSubmitComment(1000 + i, '甲的未确认回复 ' + i, null);
    }
    assert.strictEqual(posts.length, 10);
    await w.ksSubmitComment(2000, '甲的第 11 条', null);
    assert.strictEqual(posts.length, 10, 'A 自己超过上限仍应被拒绝');
    assert.ok(toasts.some(function (m) { return m.indexOf('当前账号还有 10 条') >= 0; }),
      '拒绝提示应说明是「当前账号」的未确认记录');

    // 切到 B：他自己的待确认是 0，不能被 A 的记录挡住
    w.username = 'bob';
    w.accountIdentity = '200';
    toasts.length = 0;
    await w.ksSubmitComment(null, '乙账号的第一条评论', null);
    assert.strictEqual(posts.length, 11, 'B 的未确认数为 0，必须允许发表');
    assert.ok(!toasts.some(function (m) { return m.indexOf('当前账号还有') >= 0; }),
      'B 不应收到「已达上限」的提示');

    // 两个账号的记录各自保留，互不影响
    const stored = JSON.parse(w.sessionStorage.getItem('ks-pending-comments') || '{}');
    const rows = Object.keys(stored).map(function (k) { return stored[k]; });
    assert.strictEqual(rows.filter(function (r) { return r.owner === 'u:alice|id:100'; }).length, 10,
      'A 的 10 条记录必须都还在');
    assert.strictEqual(rows.filter(function (r) { return r.owner === 'u:bob|id:200'; }).length, 1,
      'B 自己只有 1 条');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

(async () => {
  const suites = [
    ['@ 区间随编辑平移与失效（同昵称可区分）', mentionRanges],
    ['提醒设置面板读写与版本冲突', settingsPanel],
    ['结果不明时保留并持久化请求标识', retryRequestId],
    ['失效通知只显示内容已不可用', invalidatedItem],
    ['正文首尾空格时 @ 不丢失', leadingSpaceMention],
    ['会话存储不可用时仍复用请求标识', storageUnavailable],
    ['待确认提交连同 @ 目标一起保存并可原样重试', pendingDraftWithMentions],
    ['明确放弃未确认提交后可用新编号重发', discardPending],
    ['待确认草稿绑定账号，换账号不得串用', pendingBoundToAccount],
    ['回复的待确认内容可恢复、原样重试与放弃', pendingReplyDraft],
    ['身份缺失时只在本页保留，不跨会话恢复', identityMissingPending],
    ['同一文章多条待确认回复都能恢复与放弃', multiplePendingReplies],
    ['旧版本遗留的待确认记录不得恢复', legacyPendingIgnored],
    ['回复框收起与列表刷新后待确认内容仍可见', pendingReplySurvivesPaint],
    ['存储写不进去时提示刷新风险', storageWriteFailureTip],
    ['超过待确认上限不静默丢弃最早记录', pendingLimitKeepsOldRecords],
    ['请求飞行中切换账号，旧响应不得清除新账号的记录', ownerSwitchDuringRequest],
    ['待确认上限按账号分别计算', pendingLimitPerAccount],
  ];
  let failed = 0;
  for (const [name, fn] of suites) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
  }
  if (failed) {
    console.log('评论通知前端回归：' + (suites.length - failed) + ' 通过 / ' + failed + ' 失败');
    process.exit(1);
  }
  console.log('评论通知前端回归：' + pass + ' 组行为通过（DOM 行为，非视觉验收）');
})();
