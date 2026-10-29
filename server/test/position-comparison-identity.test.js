// 同一登录用户切换持仓账户，以及标杆并发选择的隔离反例。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/presenters/position-comparison-presenter.js'), 'utf8');
function setup() {
  const pending = [], renders = [], messages = [];
  let confirm;
  const window = {
    currentAccount: 'A',
    siteApi: {
      get: url => new Promise(resolve => pending.push({ url, resolve })),
      post: (url, body) => new Promise(resolve => pending.push({ url, body, resolve })),
      put: (url, body) => new Promise(resolve => pending.push({ url, body, resolve })),
    },
    projectConfirm: () => new Promise(resolve => { confirm = resolve; }),
    switchMain() {},
    positionComparisonView: {
      closeSelf() {}, renderCompare(data) { renders.push(data.tag); }, renderReplicate(data) { renders.push(data.tag); },
      initPositionControls() {}, readAvailableCash() { return 100; }, visibilitySelectReady() { return true; },
      applyVisibility(data) { renders.push(data); },
    },
  };
  const context = vm.createContext({ username: 'user', accountIdentity: 'identity', window, showToast(message) { messages.push(message); } });
  vm.runInContext(source, context);
  return { window, pending, renders, messages, confirm: value => confirm(value) };
}
(async () => {
  {
    const t = setup(), p = t.window.positionComparisonPresenter;
    const first = p.startCompare('benchmark');
    t.window.currentAccount = 'B';
    t.pending[0].resolve({ ok: true, payload: { tag: 'old-account' } });
    await first;
    assert.deepStrictEqual(t.renders, [], '旧账户结果不能展示到新账户');
  }
  {
    const t = setup(), p = t.window.positionComparisonPresenter;
    const saving = p.changeVisibility('public');
    t.window.currentAccount = 'B'; t.confirm(true);
    await saving;
    assert.strictEqual(t.pending.length, 0, '切换账户后不得执行旧账户的发布确认');
  }
  {
    const t = setup(), p = t.window.positionComparisonPresenter;
    const first = p.startCompare('old'), second = p.startCompare('new');
    t.pending[1].resolve({ ok: true, payload: { tag: 'new' } }); await second;
    t.pending[0].resolve({ ok: true, payload: { tag: 'old' } }); await first;
    assert.deepStrictEqual(t.renders, ['new'], '迟到的旧标杆不能覆盖新选择');
  }
  {
    const t = setup(), p = t.window.positionComparisonPresenter;
    const compare = p.startCompare('first');
    t.pending[0].resolve({ ok: true, payload: { tag: 'comparison' } }); await compare;
    const first = p.doReplicate(), second = p.doReplicate();
    t.pending[2].resolve({ ok: true, payload: { tag: 'new-replicate' } }); await second;
    t.pending[1].resolve({ ok: true, payload: { tag: 'old-replicate' } }); await first;
    assert.deepStrictEqual(t.renders, ['comparison', 'new-replicate'], '迟到的旧测算不能覆盖新测算');
    const pendingReplicate = p.doReplicate(), nextCompare = p.startCompare('second');
    t.pending[3].resolve({ ok: true, payload: { tag: 'obsolete-replicate' } }); await pendingReplicate;
    t.pending[4].resolve({ ok: true, payload: { tag: 'new-comparison' } }); await nextCompare;
    assert.deepStrictEqual(t.renders, ['comparison', 'new-replicate', 'new-comparison'], '换标杆后旧测算不得展示');
    t.window.currentAccount = 'B';
    assert.strictEqual(p.getCompareData(), null, '重新进入页面不能读取旧账户对比数据');
    const before = t.pending.length; await p.doReplicate();
    assert.strictEqual(t.pending.length, before, '未重新选择标杆时不能发起测算');
  }
  console.log('仓位对比账户及请求顺序隔离通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
