// ========== 站内通知缓存隔离（2026-10-25 验收反例） ==========
// 直接复现用户报告：删号后同名重注册，后端返回 0 条通知，前端却仍显示旧账号的私密反馈标题。
// 做法：jsdom 里加载真实的 public/js/notifications.js，预置上一个人的 sessionStorage 快照，
// 再用「同名但账号身份不同」的登录态进入通知页，断言旧内容不被渲染且重新拉取。
// 不启动浏览器、不访问外部数据。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 40));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
}

const HTML = '<div class="main-page active" id="main-notifications">'
  + '<div class="nt-body" id="nt-body"></div></div>';

// responses：可选，按调用次序返回不同响应，用于模拟「换人后数据不同」
async function fixture(responses) {
  const dom = new JSDOM(HTML, { url: 'https://example.test/?main=notifications', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.BASE_URL = '';
  const queue = Array.isArray(responses) && responses.length ? responses.slice() : null;
  let fetches = 0;
  w.fetch = function () {
    fetches++;
    const payload = queue && queue.length ? queue.shift() : { items: [], complete: true, nextCursor: null };
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(payload); } });
  };
  w.showToast = function () {};
  w.eval(read('public/js/utils.js'));
  w.eval(read('public/js/notifications.js'));
  await tick();
  return { dom: dom, w: w, fetches: function () { return fetches; } };
}

function seedSnapshot(w, payload) {
  w.sessionStorage.setItem('nt-state-v1', JSON.stringify(payload));
}

function oldItem(title) {
  return {
    id: '9', recipientId: '9', type: 'feedback', category: 'feedback',
    title: title, body: '正文', createdAt: '2026-10-25T00:00:00Z',
    read: false, invalidated: false, feedback: { id: '5', title: title, status: 'implemented', version: '0.8.4.41' },
    target: { kind: 'feedback', feedbackId: '5', path: '/?main=feedback&sub=mine&feedback=5' },
  };
}

(async () => {
  console.log('--- 站内通知缓存隔离测试（jsdom）---');

  await test('同名但账号身份不同：旧快照不得渲染，必须重新拉取', async function () {
    const f = await fixture();
    const w = f.w;
    seedSnapshot(w, { user: 'same_name', identity: '1700000000.1', sub: 'all', unreadOnly: false, items: [oldItem('A的私密反馈标题')], nextCursor: null, complete: true });
    // 删号后同名重注册：用户名相同、建号时间不同 = 另一个账号
    w.username = 'same_name';
    w.accountIdentity = '1799999999.9';
    w.AppNotifications.load();
    await tick();
    const text = w.document.getElementById('nt-body').textContent;
    assert.strictEqual(text.indexOf('A的私密反馈标题'), -1, '同名新账号不得看到上一个人的通知标题');
    assert.ok(f.fetches() >= 1, '身份不一致时必须重新向后端拉取');
    assert.strictEqual(w.sessionStorage.getItem('nt-state-v1'), null, '失效快照必须被清除');
  });

  await test('同一账号（身份一致）仍可恢复快照，避免每次返回都重排', async function () {
    const f = await fixture();
    const w = f.w;
    seedSnapshot(w, { user: 'alice', identity: '1700000000.1', sub: 'all', unreadOnly: false, items: [oldItem('自己的反馈标题')], nextCursor: null, complete: true });
    w.username = 'alice';
    w.accountIdentity = '1700000000.1';
    w.AppNotifications.load();
    await tick();
    const text = w.document.getElementById('nt-body').textContent;
    assert.ok(text.indexOf('自己的反馈标题') >= 0, '同账号应能恢复自己的列表');
    assert.strictEqual(f.fetches(), 0, '同账号恢复快照时不应重复拉取');
  });

  await test('快照缺账号身份时一律不恢复（fail-closed）', async function () {
    const f = await fixture();
    const w = f.w;
    seedSnapshot(w, { user: 'alice', sub: 'all', unreadOnly: false, items: [oldItem('旧版快照标题')], nextCursor: null, complete: true });
    w.username = 'alice';
    w.accountIdentity = '1700000000.1';
    w.AppNotifications.load();
    await tick();
    const text = w.document.getElementById('nt-body').textContent;
    assert.strictEqual(text.indexOf('旧版快照标题'), -1, '缺身份的快照必须丢弃');
  });

  await test('拿不到当前账号身份时不读也不写快照', async function () {
    const f = await fixture();
    const w = f.w;
    seedSnapshot(w, { user: 'alice', identity: '1700000000.1', sub: 'all', unreadOnly: false, items: [oldItem('无身份时旧标题')], nextCursor: null, complete: true });
    w.username = 'alice';
    w.accountIdentity = '';
    w.AppNotifications.load();
    await tick();
    const text = w.document.getElementById('nt-body').textContent;
    assert.strictEqual(text.indexOf('无身份时旧标题'), -1, '身份未知时不得按用户名恢复');
    assert.strictEqual(w.sessionStorage.getItem('nt-state-v1'), null, '身份未知时旧快照应清理');
  });

  await test('clearCache（退出登录）清空快照与内存列表', async function () {
    const f = await fixture();
    const w = f.w;
    seedSnapshot(w, { user: 'alice', identity: '1700000000.1', sub: 'all', unreadOnly: false, items: [oldItem('退出前标题')], nextCursor: null, complete: true });
    w.username = 'alice';
    w.accountIdentity = '1700000000.1';
    w.AppNotifications.load();
    await tick();
    w.AppNotifications.clearCache();
    assert.strictEqual(w.sessionStorage.getItem('nt-state-v1'), null, '退出登录必须清掉快照');
    // 清空后即使身份一致也不能再显示旧内容
    w.AppNotifications.load();
    await tick();
    const text = w.document.getElementById('nt-body').textContent;
    assert.strictEqual(text.indexOf('退出前标题'), -1, 'clearCache 后不得残留旧列表');
  });

  await test('同页面内切换账号：内存列表立即作废', async function () {
    const f = await fixture();
    const w = f.w;
    w.username = 'alice';
    w.accountIdentity = '1700000000.1';
    w.AppNotifications.load();
    await tick();
    // 模拟列表已有内容后切到另一个账号（不刷新页面）
    w.eval("window.__nt_items_probe = true");
    w.username = 'bob';
    w.accountIdentity = '1799999999.9';
    w.AppNotifications.load();
    await tick();
    const text = w.document.getElementById('nt-body').textContent;
    assert.strictEqual(text.indexOf('A的私密反馈标题'), -1, '切换账号后不得保留上一个人的列表');
  });

  await test('不同用户名但建号时间相同：切换账号仍必须重新请求，不沿用上一个人的列表', async function () {
    const f = await fixture([
      { items: [oldItem('A的私密通知标题')], complete: true, nextCursor: null },
      { items: [], complete: true, nextCursor: null },
    ]);
    const w = f.w;
    // 两个真实账号可能建号时间落在同一刻，此时身份相同但用户名不同
    const SAME_IDENTITY = '1700000000.5';
    w.username = 'alice_name';
    w.accountIdentity = SAME_IDENTITY;
    w.AppNotifications.load();
    await tick();
    assert.ok(w.document.getElementById('nt-body').textContent.indexOf('A的私密通知标题') >= 0,
      '先正常加载 A 自己的列表');

    w.username = 'bob_name';
    w.accountIdentity = SAME_IDENTITY;
    w.AppNotifications.load();
    await tick();
    const text = w.document.getElementById('nt-body').textContent;
    assert.strictEqual(text.indexOf('A的私密通知标题'), -1,
      '不同用户名即使建号时间相同，也不能沿用上一个人的列表');
    assert.strictEqual(f.fetches(), 2, '切换账号必须重新请求列表（归属键要含用户名）');
  });

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试执行失败：', e && e.stack || e);
  process.exit(1);
});
