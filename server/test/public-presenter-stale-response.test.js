// 公开数据 presenter 旧响应反例（请求序号守卫）：A 请求未结束时同函数再次发起 B（代表切换筛选/子页/标签），
// B 必须能发起（不被 loading 拦截）且先渲染，A 的旧返回必须被丢弃——不渲染、不写状态、不提示。
// 覆盖 bond-list 与 ipo 两个场景（vm + pending promise 模式，同 account-switch-stale-response.test.js）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, 'public/js/presenters', name), 'utf8');

function makePendingGet() {
  const pending = [];
  return {
    pending,
    get: (url) => new Promise(resolve => pending.push({ url, resolve })),
  };
}
const ok = payload => ({ ok: true, status: 200, payload });

function makeBondListContext() {
  const rendered = [];
  const errors = [];
  const { pending, get } = makePendingGet();
  const context = vm.createContext({
    BOND_LIST_REFRESH_MS: 30000,
    bondListSetRefreshButton() {},
    bondListShowUpdated() {},
    bondListApplyFilters() {},
    bondListShowError: (e) => errors.push(String((e && e.message) || e)),
    bondListStartAutoRefresh() {},
    window: { siteApi: { get } },
  });
  vm.runInContext(read('bond-list-presenter.js'), context);
  context.bondListApplyFilters = () => rendered.push((context.bondListState.rows[0] || {}).tag);
  return { context, pending, rendered, errors };
}

(async () => {
  // ===== bond-list：A 在途时同函数再次调用（代表切换筛选），B 先返回、A 后返回 =====
  {
    const { context, pending, rendered, errors } = makeBondListContext();

    const pA = context.loadBondList(true);               // A 在途
    const pB = context.loadBondList(true);               // 同函数再次调用：必须能发起（不被 A 的 loading 拦截）
    assert.strictEqual(pending.length, 2, 'B 的请求被 loading 拦截，新调用必须能发起');

    // B 先返回：正常渲染 B
    pending[1].resolve(ok({ data: [{ tag: 'B' }] }));
    await pB;
    assert.deepStrictEqual(rendered, ['B'], 'B 的响应应正常绘制');

    // A 后返回：旧响应必须被丢弃，不渲染、不写状态、不提示
    pending[0].resolve(ok({ data: [{ tag: 'A' }] }));
    await pA;
    assert.deepStrictEqual(rendered, ['B'], 'A 的旧响应不得覆盖 B 的渲染');
    assert.strictEqual(context.bondListState.rows[0].tag, 'B', 'A 的旧数据不得写入状态');
    assert.deepStrictEqual(errors, [], 'A 的旧响应不得产生错误提示');
  }

  // ===== bond-list：A 的旧响应失败也必须静默丢弃（不得给新状态弹错误提示） =====
  {
    const { context, pending, rendered, errors } = makeBondListContext();

    const pA = context.loadBondList(true);
    const pB = context.loadBondList(true);
    assert.strictEqual(pending.length, 2, 'B 的请求被 loading 拦截，新调用必须能发起');

    pending[1].resolve(ok({ data: [{ tag: 'B' }] }));
    await pB;
    assert.deepStrictEqual(rendered, ['B'], 'B 的响应应正常绘制');

    pending[0].resolve({ ok: false, status: 500 });       // A 的旧响应失败
    await pA;
    assert.deepStrictEqual(rendered, ['B'], 'A 的旧失败不得覆盖 B 的渲染');
    assert.strictEqual(context.bondListState.rows[0].tag, 'B', 'A 的旧失败不得写状态');
    assert.deepStrictEqual(errors, [], 'A 的旧失败不得弹错误提示');
  }

  // ===== ipo：loadIpo 双调用（A 在途时再次进入），日报/日历/历史三条流均不得被旧响应覆盖 =====
  {
    const painted = { advice: [], cal: [], hist: [], adviceErr: 0, calErr: 0, histErr: 0 };
    const { pending, get } = makePendingGet();
    const context = vm.createContext({
      showToast() {},
      window: {
        siteApi: { get },
        ipoPaintAdviceResult: (rep, cal) => painted.advice.push((rep && rep.tag) + '|' + (cal && cal.tag)),
        ipoPaintAdviceError: () => { painted.adviceErr++; },
        ipoPaintCalendarLoading() {},
        ipoPaintCalendarResult: (d) => painted.cal.push(d.tag),
        ipoPaintCalendarError: () => { painted.calErr++; },
        ipoPaintHistoryLoading: () => 0,
        ipoPaintHistoryResult: (type, d) => painted.hist.push(type + ':' + d.tag),
        ipoPaintHistoryError: () => { painted.histErr++; },
        ipoPaintHistoryDone() {},
      },
    });
    vm.runInContext(read('ipo-presenter.js'), context);

    const pA = context.loadIpo();                          // A 在途（日报＋日历＋历史三请求）
    const pB = context.loadIpo();                          // 同函数再次调用（代表再次进入/切换）：必须能发起
    assert.strictEqual(pending.length, 6, 'B 的请求被 loading 拦截，新调用必须能发起');

    // B 的三条响应先返回：正常渲染 B
    pending[3].resolve(ok({ tag: 'B-cal', calendar: [] }));                 // B 日历
    pending[4].resolve(ok({ type: 'stock', tag: 'B-hist', rows: [] }));     // B 历史
    pending[5].resolve(ok({ tag: 'B-report' }));                            // B 日报
    await pB;
    assert.deepStrictEqual(painted.advice, ['B-report|B-cal'], 'B 的日报应正常绘制');
    assert.deepStrictEqual(painted.cal, ['B-cal'], 'B 的日历应正常绘制');
    assert.deepStrictEqual(painted.hist, ['stock:B-hist'], 'B 的历史应正常绘制');

    // A 的旧响应后返回：全部丢弃（不渲染、不写状态、不提示）
    pending[0].resolve(ok({ tag: 'A-cal', calendar: [] }));                 // A 日历（旧）
    pending[1].resolve(ok({ type: 'stock', tag: 'A-hist', rows: [] }));     // A 历史（旧）
    pending[2].resolve({ ok: false, status: 500 });                         // A 日报（旧且失败）
    await pA;
    assert.deepStrictEqual(painted.advice, ['B-report|B-cal'], 'A 的旧日报不得覆盖 B');
    assert.deepStrictEqual(painted.cal, ['B-cal'], 'A 的旧日历不得覆盖 B');
    assert.deepStrictEqual(painted.hist, ['stock:B-hist'], 'A 的旧历史不得覆盖 B');
    assert.strictEqual(painted.adviceErr + painted.calErr + painted.histErr, 0, 'A 的旧响应不得产生任何错误提示');
  }

  console.log('public-presenter-stale-response tests passed');
})().catch(err => { console.error(err); process.exit(1); });
