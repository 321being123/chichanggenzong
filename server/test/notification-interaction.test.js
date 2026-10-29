// 真实前端脚本的确定性交互回归；不启动浏览器、不发送通知。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const response = data => ({ ok: true, json: async () => data });
let pass = 0;

async function adminForm(width) {
  const dom = new JSDOM('<div id="view-notifications"></div>', {
    url: 'https://example.test/', runScripts: 'outside-only',
  });
  const w = dom.window;
  w.innerWidth = width;
  w.adminProfile = { role: 'admin' };
  w.api = x => x;
  w.escapeHtml = x => String(x);
  w.showToast = () => {};
  w.projectConfirm = async () => true;
  const sent = [];
  w.fetch = async (url, init) => {
    if (url.endsWith('/preview')) {
      sent.push(JSON.parse(init.body));
      return response({ batchId: '1', revision: '1', contentAudienceHash: 'hash', snapshotCount: 1 });
    }
    return response({ items: [{ username: 'alice' }], total: 1 });
  };
  try {
    w.eval(read('public/js/api/client.js'));
    w.eval(read('public/js/admin-notifications.js'));
    // 批次4：取数与状态（anState）已拆入 Presenter（presenters/admin-notifications-presenter.js），
    // 按 HTML 待接入的加载顺序补载。
    w.eval(read('public/js/presenters/admin-notifications-presenter.js'));
    w.renderAdminNotifications();
    const input = (id, value) => { w.document.getElementById(id).value = value; };
    input('an-title', '保留标题');
    input('an-body', '保留正文\n第二行');
    await w.adminNotifMode('filter');
    input('an-f-role', 'user');
    input('an-f-reg-from', '2026-10-01');
    input('an-f-feedback', '1');
    await w.adminNotifPreview();
    assert.strictEqual(w.document.getElementById('an-title').value, '保留标题');
    assert.strictEqual(w.document.getElementById('an-body').value, '保留正文\n第二行');
    assert.strictEqual(w.document.getElementById('an-f-reg-from').value, '2026-10-01');
    assert.strictEqual(sent[0].filters.submittedFeedback, true);
    const title = w.document.getElementById('an-title');
    title.focus();
    title.value = '改过标题';
    title.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.strictEqual(w.document.getElementById('an-title'), title, '编辑不能重建输入框');
    assert.strictEqual(w.document.activeElement, title, '保留编辑焦点');
    assert.strictEqual(title.value, '改过标题');
    assert.ok(w.document.querySelector('[data-act="adminNotifSend"]').disabled, '编辑后撤销旧预览');
    await w.adminNotifMode('selected');
    input('an-search', 'alice');
    await w.adminNotifSearch();
    w.adminNotifPick('alice');
    w.adminNotifRemove('alice');
    assert.strictEqual(w.document.getElementById('an-title').value, '改过标题');
    await w.adminNotifMode('filter');
    assert.strictEqual(w.document.getElementById('an-f-role').value, 'user');
    assert.strictEqual(w.document.getElementById('an-f-feedback').value, '1');
    await w.adminNotifPreview();
    await w.adminNotifSend();
    assert.strictEqual(w.document.getElementById('an-title').value, '', '发送成功应清空草稿');
    input('an-title', '待清空');
    w.adminNotifReset();
    assert.strictEqual(w.document.getElementById('an-title').value, '', '主动清空仍有效');
    pass++;
  } finally { await tick(); dom.window.close(); }
}

async function pendingList() {
  const dom = new JSDOM('<div id="main-notifications"><div id="nt-body"></div></div>', {
    url: 'https://example.test/?main=notifications', runScripts: 'outside-only',
  });
  const w = dom.window;
  let finishPage;
  w.username = 'alice'; w.accountIdentity = '1';
  w.api = x => x; w.escapeHtml = x => String(x); w.showToast = () => {};
  w.fetch = async url => {
    if (url.includes('cursor=')) return new Promise(resolve => { finishPage = resolve; });
    if (url === '/api/notifications/9') return response({ id: '9', title: '通知', body: '正文' });
    if (url.endsWith('/read')) return response({});
    return response({ items: [{ id: '9', title: '通知', body: '', target: { kind: 'notification' } }], nextCursor: '9', complete: false });
  };
  try {
    w.eval(read('public/js/api/client.js'));
    w.eval(read('public/js/presenters/notifications-presenter.js'));
    w.eval(read('public/js/notifications.js'));
    w.AppNotifications.load(); await tick();
    w.document.querySelector('[data-nt-act="more"]').click();
    w.document.querySelector('[data-nt-act="item"]').click();
    await tick();
    w.document.querySelector('[data-nt-act="back"]').click();
    assert.strictEqual(w.document.querySelector('[data-nt-act="more"]').disabled, false,
      '详情作废旧分页后，返回列表仍可继续分页');
    finishPage(response({ items: [], complete: true })); await tick();
    assert.ok(w.document.querySelector('[data-nt-act="more"]'), '旧分页不能关闭当前分页入口');
    pass++;
  } finally { dom.window.close(); }
}

async function detailRace(kind) {
  const dom = new JSDOM('<div id="main-notifications"><div id="nt-body"></div></div>', {
    url: 'https://example.test/?main=notifications&notification=9', runScripts: 'outside-only',
  });
  const w = dom.window;
  let finishOld;
  const marked = [];
  w.username = 'alice';
  w.accountIdentity = '1';
  w.api = x => x;
  w.escapeHtml = x => String(x);
  w.showToast = () => {};
  w.fetch = async url => {
    if (url.endsWith('/read')) { marked.push(url); return response({}); }
    if (url === '/api/notifications/9') return new Promise(resolve => { finishOld = resolve; });
    if (url === '/api/notifications/10') return response({ id: '10', title: '新通知', body: '新正文' });
    return response({ items: [], complete: true });
  };
  try {
    w.eval(read('public/js/api/client.js'));
    w.eval(read('public/js/presenters/notifications-presenter.js'));
    w.eval(read('public/js/notifications.js'));
    w.AppNotifications.load();
    await tick();
    if (kind === 'account') {
      w.AppNotifications.clearCache();
      w.username = 'bob';
      w.accountIdentity = '2';
    }
    w.history.replaceState(null, '', '/?main=notifications&notification=10');
    w.AppNotifications.load();
    await tick();
    if (kind === 'back') {
      w.document.querySelector('[data-nt-act="back"]').click();
    }
    finishOld(kind === 'error'
      ? { ok: false, status: 500, json: async () => ({ error: '旧请求失败' }) }
      : response({ id: '9', title: '旧通知', body: '旧账号私密正文' }));
    await tick(); await tick();
    const text = w.document.getElementById('nt-body').textContent;
    assert.ok(!text.includes('旧账号私密正文'), '旧正文不能重新进入页面');
    if (kind !== 'back') assert.ok(text.includes('新正文'), '旧成功或失败不能覆盖当前详情');
    assert.ok(!marked.includes('/api/notifications/9/read'), '作废详情不能触发已读');
    pass++;
  } finally { dom.window.close(); }
}

(async () => {
  for (const width of [320, 360, 390, 430, 760, 768, 900, 1024, 1440]) await adminForm(width);
  for (const kind of ['account', 'detail', 'error', 'back']) await detailRace(kind);
  await pendingList();
  console.log('notification interaction: ' + pass + ' 组表单/延迟响应回归通过（DOM，非视觉验收）');
})().catch(error => { console.error(error); process.exitCode = 1; });
