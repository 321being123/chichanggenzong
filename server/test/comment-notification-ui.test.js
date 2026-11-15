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
    assert.ok(Object.keys(stored).some(function (k) { return stored[k] === firstId; }),
      '结果不明时标识必须持久化（刷新后仍能复用）');

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

(async () => {
  const suites = [
    ['@ 区间随编辑平移与失效（同昵称可区分）', mentionRanges],
    ['提醒设置面板读写与版本冲突', settingsPanel],
    ['结果不明时保留并持久化请求标识', retryRequestId],
    ['失效通知只显示内容已不可用', invalidatedItem],
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
