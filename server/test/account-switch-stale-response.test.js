// 账户切换旧响应反例（2026-10-29 验收 P1）：A 请求未结束时切换到 B，
// B 的新请求必须能发起（不被 loading 拦截），A 的旧返回不得写入 B 的页面。
// 覆盖 market-volatility、market-cycle-metrics、home-dashboard 三个持账户相关状态的 presenter。
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
const okOverview = tag => ({ ok: true, status: 200, payload: { tag } });
const okHistory = { ok: true, status: 200, payload: { history: [] } };

(async () => {
  // 初始化占位账户变为真实账户时，两种市场指标都应自动读取真实账户。
  for (const [file, load, state, accountFn, prefix] of [
    ['market-volatility-presenter.js', 'loadMarketVolatility', 'mvState', 'mvAccount', 'mv'],
    ['market-cycle-metrics-presenter.js', 'mvcLoad', 'mvcState', 'mvcAccount', 'mvc'],
  ]) {
    let ready;
    const { pending, get } = makePendingGet();
    const context = vm.createContext({
      username: 'synthetic', accountIdentity: 'identity', currentAccountName: '默认账户',
      [accountFn]() { return context.currentAccountName; },
      initMarketVolatility() {}, [prefix + 'SetStatus']() {}, [prefix + 'SetLoadError'](error) { throw error; },
      [prefix + 'Render']() {}, window: { accountDataReady: new Promise(resolve => { ready = resolve; }), siteApi: { get } },
    });
    vm.runInContext(read(file), context);
    const loading = context[load]();
    context.currentAccountName = '真实账户';
    ready();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(pending.length, 2, file + ' 账户初始化后应发起请求');
    assert(pending[0].url.includes(encodeURIComponent('真实账户')), file + ' 应使用初始化后的账户');
    pending[0].resolve(okOverview('ready')); pending[1].resolve(okHistory);
    await loading;
    assert.strictEqual(context[state].loading, false, file + ' 加载结束后不能卡住');

    // 等待期间用户身份切换：旧调用不能越权发起，新调用正常显示。
    let nextReady;
    context.window.accountDataReady = new Promise(resolve => { nextReady = resolve; });
    const oldLoad = context[load]();
    context.username = 'new-user'; context.accountIdentity = 'new-identity'; context.currentAccountName = '新账户';
    const newLoad = context[load]();
    nextReady();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(pending.length, 4, file + ' 初始化时旧身份不得额外发请求');
    assert(pending[2].url.includes(encodeURIComponent('新账户')), file + ' 应使用新身份账户');
    pending[2].resolve(okOverview('new')); pending[3].resolve(okHistory);
    await Promise.all([oldLoad, newLoad]);
    assert.strictEqual(context[state].loading, false, file + ' 切换后应结束加载');
  }

  // 后台页面使用 adminProfile，而不是主站 username/accountIdentity 全局变量。
  {
    const { pending, get } = makePendingGet();
    const painted = [];
    const context = vm.createContext({
      adminProfile: { username: 'adminA', accountIdentity: 'identityA' },
      window: { siteApi: { get }, adminPaintUsers(data) { painted.push(data.tag); }, adminPaintUsersError() {} },
    });
    vm.runInContext(read('admin-presenter.js'), context);
    const oldLoad = context.loadUsersData();
    context.adminProfile = { username: 'adminB', accountIdentity: 'identityB' };
    pending[0].resolve({ ok: true, payload: { tag: 'old' } });
    await oldLoad;
    assert.deepStrictEqual(painted, [], '后台旧身份的响应不得绘制');
    const newLoad = context.loadUsersData();
    pending[1].resolve({ ok: true, payload: { tag: 'new' } });
    await newLoad;
    assert.deepStrictEqual(painted, ['new']);
  }

  // 退出后同一账号重新登录，旧会话响应也不得被接受。
  {
    const { pending, get } = makePendingGet(), painted = [];
    const context = vm.createContext({
      adminProfile: { username: 'admin', accountIdentity: 'identity' },
      window: { siteApi: { get, post: async () => ({ ok: true }) }, adminNavigateLoggedOut() {},
        adminPaintUsers(data) { painted.push(data.tag); }, adminPaintUsersError() {} },
    });
    vm.runInContext(read('admin-presenter.js'), context);
    const oldLoad = context.loadUsersData();
    await context.adminLogout();
    context.adminProfile = { username: 'admin', accountIdentity: 'identity' };
    pending[0].resolve({ ok: true, payload: { tag: 'old-session' } });
    await oldLoad;
    assert.deepStrictEqual(painted, [], '旧会话响应不能写回重新登录的账号');
  }

  // 补跑确认期间切换身份，不能以新身份提交旧确认的操作。
  {
    let confirm; const posts = [];
    const context = vm.createContext({
      adminProfile: { username: 'adminA', accountIdentity: 'A' },
      window: {
        siteApi: { get: async () => ({ ok: true, payload: { job_code: 'test' } }), post: async url => { posts.push(url); return { ok: true, payload: {} }; } },
        adminConfirmJobRetry: () => new Promise(resolve => { confirm = resolve; }), showToast() {}, loadJobsData() {},
      },
    });
    vm.runInContext(read('admin-presenter.js'), context);
    const retry = context.retryJobSlotFromUi(1);
    await new Promise(resolve => setImmediate(resolve));
    context.adminProfile = { username: 'adminB', accountIdentity: 'B' };
    confirm(true); await retry;
    assert.strictEqual(posts.length, 0, '身份变化后不得执行旧确认');
  }

  // 后台任务筛选和券商筛选的并发请求，由 Presenter 丢弃旧响应。
  {
    const { pending, get } = makePendingGet();
    const jobs = [], brokers = [];
    const context = vm.createContext({
      adminProfile: { username: 'admin', accountIdentity: 'identity' },
      window: {
        siteApi: { get }, adminPaintJobs(data) { jobs.push(data[0].tag); }, adminPaintJobsError() { throw Error('unexpected job error'); },
        adminPaintBrokers(data) { brokers.push(data.tag); }, adminPaintBrokersError() { throw Error('unexpected broker error'); },
      },
    });
    vm.runInContext(read('admin-presenter.js'), context);
    const oldJobs = context.adminLoadJobsData('&status=old');
    const newJobs = context.adminLoadJobsData('&status=new');
    assert(pending[1].url.includes('status=old')); assert(pending[6].url.includes('status=new'));
    for (let i = 5; i < 10; i++) pending[i].resolve({ ok: true, payload: { tag: 'new' } });
    await newJobs;
    for (let i = 0; i < 5; i++) pending[i].resolve({ ok: true, payload: { tag: 'old' } });
    await oldJobs;
    assert.deepStrictEqual(jobs, ['new'], '后台任务只显示最新筛选结果');
    context.brokersSearch = 'old'; const oldBrokers = context.loadBrokersData();
    context.brokersSearch = 'new'; const newBrokers = context.loadBrokersData();
    assert(pending[10].url.includes('search=old')); assert(pending[11].url.includes('search=new'));
    pending[11].resolve({ ok: true, payload: { tag: 'new' } }); await newBrokers;
    pending[10].resolve({ ok: true, payload: { tag: 'old' } }); await oldBrokers;
    assert.deepStrictEqual(brokers, ['new'], '后台券商只显示最新筛选结果');
  }

  // 同一账户快速切换时间范围时，新条件不能被旧 loading 拦截。
  for (const [file, load, state, accountFn, prefix] of [
    ['market-volatility-presenter.js', 'loadMarketVolatility', 'mvState', 'mvAccount', 'mv'],
    ['market-cycle-metrics-presenter.js', 'mvcLoad', 'mvcState', 'mvcAccount', 'mvc'],
  ]) {
    const { pending, get } = makePendingGet(), rendered = [];
    const context = vm.createContext({
      username: 'synthetic', accountIdentity: 'identity', [accountFn]() { return 'A'; },
      initMarketVolatility() {}, [prefix + 'SetStatus']() {}, [prefix + 'SetLoadError']() {},
      window: { siteApi: { get } },
    });
    vm.runInContext(read(file), context);
    context[prefix + 'Render'] = () => rendered.push(context[state].overview.tag);
    const oldLoad = context[load]();
    context[state].range = '5y';
    const newLoad = context[load]();
    assert.strictEqual(pending.length, 4, file + ' 新筛选请求不得被旧 loading 拦截');
    assert(pending[3].url.includes('range=5y'));
    pending[2].resolve(okOverview('new')); pending[3].resolve(okHistory); await newLoad;
    pending[0].resolve(okOverview('old')); pending[1].resolve(okHistory); await oldLoad;
    assert.deepStrictEqual(rendered, ['new']);
  }

  // 保存期间切换账户，旧保存结果不能修改新账户的按钮或提示。
  for (const [file, load, save, state, accountFn, prefix] of [
    ['market-volatility-presenter.js', 'loadMarketVolatility', 'mvSaveDraft', 'mvState', 'mvAccount', 'mv'],
    ['market-cycle-metrics-presenter.js', 'mvcLoad', 'mvcSave', 'mvcState', 'mvcAccount', 'mvc'],
  ]) {
    const { pending, get } = makePendingGet(), texts = [], toasts = [];
    let finishSave;
    const context = vm.createContext({
      username: 'user', accountIdentity: 'identity', currentAccountName: 'A',
      [accountFn]() { return context.currentAccountName; }, initMarketVolatility() {},
      [prefix + 'SetStatus']() {}, [prefix + 'SetLoadError']() {}, [prefix + 'SetSaveBusy']() {},
      [prefix + 'SetSaveText'](text) { texts.push(text); }, [prefix + 'HideDraftControls']() {},
      [prefix + 'ReadBoundaries']() { return { lower: 1, upper: 2 }; },
      showToast(text) { toasts.push(text); },
      window: { siteApi: { get, put: () => new Promise(resolve => { finishSave = resolve; }) } },
    });
    vm.runInContext(read(file), context);
    context[prefix + 'Render'] = () => {};
    context[state].overview = { setting: { version: 1 } };
    context[state].draft = { lower: 1, upper: 2, version: 1 };
    const saving = context[save]();
    context.currentAccountName = 'B';
    const loading = context[load]();
    pending[0].resolve(okOverview('B')); pending[1].resolve(okHistory); await loading;
    const textCount = texts.length;
    finishSave({ ok: true, payload: {} }); await saving;
    assert.strictEqual(texts.length, textCount, file + ' 旧保存不能改新账户按钮');
    assert.deepStrictEqual(toasts, [], file + ' 旧保存不能提示新账户');
  }

  // ===== market-volatility：账户 A 请求期间切到 B =====
  {
    const rendered = [];
    const { pending, get } = makePendingGet();
    const context = vm.createContext({
      username: 'userA', accountIdentity: 'accA',
      currentAccountName: '账户A',
      mvAccount() { return context.currentAccountName; },
      initMarketVolatility() {}, mvSetStatus() {}, mvSetLoadError() {},
      mvSetSaveBusy() {}, mvSetSaveText() {}, mvHideDraftControls() {},
      showToast() {}, api: (p) => p,
      window: { siteApi: { get, put: () => Promise.reject(new Error('unused')) } },
    });
    vm.runInContext(read('market-volatility-presenter.js'), context);
    context.mvRender = () => rendered.push((context.mvState.overview || {}).tag);

    const pA = context.loadMarketVolatility();               // A 在途
    context.username = 'userB'; context.accountIdentity = 'accB'; context.currentAccountName = '账户B';
    const pB = context.loadMarketVolatility();               // 切 B：必须能发起（不被 A 的 loading 挡住）
    assert.strictEqual(pending.length, 4, 'B 的请求被 loading 拦截，切换后必须能发起新请求');

    // A 的返回先到：必须被身份守卫丢弃
    pending[0].resolve(okOverview('A-overview')); pending[1].resolve(okHistory);
    await pA;
    assert.deepStrictEqual(rendered, [], 'A 的旧响应不得写入 B 的页面');

    // B 的返回正常绘制
    pending[2].resolve(okOverview('B-overview')); pending[3].resolve(okHistory);
    await pB;
    assert.deepStrictEqual(rendered, ['B-overview'], 'B 的响应应正常绘制');
  }

  // ===== market-cycle-metrics：同款反例 =====
  {
    const rendered = [];
    const { pending, get } = makePendingGet();
    const context = vm.createContext({
      username: 'userA', accountIdentity: 'accA',
      currentAccountName: '账户A',
      mvcAccount() { return context.currentAccountName; },
      mvcSetStatus() {}, mvcSetLoadError() {}, mvcSetSaveBusy() {}, mvcSetSaveText() {},
      mvcReadBoundaries() { return { lower: 1, upper: 2 }; },
      showToast() {}, api: (p) => p,
      window: { siteApi: { get, put: () => Promise.reject(new Error('unused')) } },
    });
    vm.runInContext(read('market-cycle-metrics-presenter.js'), context);
    context.mvcRender = () => rendered.push((context.mvcState.overview || {}).tag);

    const pA = context.mvcLoad();
    context.username = 'userB'; context.accountIdentity = 'accB'; context.currentAccountName = '账户B';
    const pB = context.mvcLoad();
    assert.strictEqual(pending.length, 4, 'B 的 mvcLoad 被 loading 拦截');

    pending[0].resolve(okOverview('A')); pending[1].resolve(okHistory);
    await pA;
    assert.deepStrictEqual(rendered, [], 'A 的旧响应不得写入 B 的页面');

    pending[2].resolve(okOverview('B')); pending[3].resolve(okHistory);
    await pB;
    assert.deepStrictEqual(rendered, ['B'], 'B 的响应应正常绘制');
  }

  // ===== home-dashboard：身份切换后能发起新请求且旧响应丢弃 =====
  {
    const painted = [];
    const { pending, get } = makePendingGet();
    const context = vm.createContext({
      username: 'userA', accountIdentity: 'accA',
      renderHomeHoldings() {}, renderHomeArticles() {},
      window: {
        siteApi: { get },
        homeApplyDashboardOrder() {},
        homeArticlesReady: () => false,
        homePaintMarketCycles() {}, homePaintMarketCyclesError() {},
        homePaintDashboardResults: (results) => painted.push(results[0].data && results[0].data.tag),
        homePaintArticles() {}, homePaintArticlesError() {},
      },
    });
    vm.runInContext(read('home-dashboard-presenter.js'), context);

    const pA = context.loadHomeDashboard();
    context.username = 'userB'; context.accountIdentity = 'accB';
    const pB = context.loadHomeDashboard();
    // A/B 各 4 个请求（周期卡 2 + 面板 2），B 的请求必须不被 A 的 loading 拦截
    assert.strictEqual(pending.length, 8, 'B 的首页加载被 loading 拦截');

    // A 的 4 个返回先到：全部丢弃
    for (const item of pending.splice(0, 4)) {
      item.resolve(item.url.indexOf('bond-safety') >= 0
        ? { ok: true, status: 200, payload: { tag: 'A-bond' } }
        : { ok: true, status: 200, payload: { tag: 'A-ipo' } });
    }
    await pA;
    assert.deepStrictEqual(painted, [], 'A 的旧响应不得写入 B 的首页');

    for (const item of pending.splice(0, 4)) {
      item.resolve(item.url.indexOf('bond-safety') >= 0
        ? { ok: true, status: 200, payload: { tag: 'B-bond' } }
        : { ok: true, status: 200, payload: { tag: 'B-ipo' } });
    }
    await pB;
    assert.deepStrictEqual(painted, ['B-ipo'], 'B 的响应应正常绘制');
  }

  console.log('account-switch-stale-response tests passed');
})().catch(err => { console.error(err); process.exit(1); });
