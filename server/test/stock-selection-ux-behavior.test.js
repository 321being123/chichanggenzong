// 股票筛选交互行为回归：验证 Presenter 的默认周期、已有排除自动派生和迟到响应隔离。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const presenterSource = fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'stock-selection-presenter.js'), 'utf8');

function createContext(api) {
  const context = { window: { StockSelectionApi: api }, console, username: 'stock-selection-ux-test' };
  vm.createContext(context);
  vm.runInContext(presenterSource, context, { filename: 'stock-selection-presenter.js' });
  return context;
}

async function main() {
  const calls = [];
  const v2 = createContext({
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', markets: [] }),
    listRuns: async query => { calls.push(query); return { runs: [], total: 0 }; },
    getSettings: async () => ({ revision: 1, settings: {} }),
    listIndustries: async () => ({ industries: [] }),
  });
  await v2.window.StockSelectionPresenter.load();
  assert.strictEqual(v2.ssState.periodType, 'weekly');
  assert.strictEqual(calls[0].kind, 'weekly');
  console.log('[PASS] V2 首次进入默认请求每周正式来源');

  const simulations = [];
  const withExclusion = createContext({
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', markets: [] }),
    listRuns: async () => ({ runs: [{ runId: 11 }], total: 1 }),
    getSettings: async () => ({ revision: 4, settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [{ market: 'CN', instrumentId: 8, code: 'X' }] } }),
    listIndustries: async () => ({ industries: [] }),
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ positionRatio: 0.7, members: [], runId }),
    getRun: async runId => ({ runId: Number(runId), runKind: Number(runId) === 11 ? 'weekly' : 'personal', sourceRunId: 11 }),
    simulate: async request => { simulations.push(request); return { runId: 12 }; },
  });
  await withExclusion.window.StockSelectionPresenter.load();
  assert.strictEqual(simulations.length, 1);
  assert.strictEqual(simulations[0].sourceRunId, 11);
  assert.strictEqual(simulations[0].settingsRevision, 4);
  console.log('[PASS] 已有个人排除进入页面后自动从当前公共来源派生');

  let resolveSimulation;
  const stale = createContext({ simulate: () => new Promise(resolve => { resolveSimulation = resolve; }) });
  Object.assign(stale.ssState, { market: 'CN', periodType: 'weekly', sourceRunId: 11, sourcePortfolio: { positionRatio: 0.7 }, settings: {}, settingsRevision: 1, ownerUser: 'stock-selection-ux-test' });
  const pending = stale.window.StockSelectionPresenter.simulate({});
  stale.ssState.market = 'HK';
  stale.ssState.sourceRunId = 22;
  stale.ssState.seq += 1;
  resolveSimulation({ runId: 99 });
  await pending;
  assert.strictEqual(stale.ssState.runId, null);
  assert.strictEqual(stale.ssState.sourceRunId, 22);
  console.log('[PASS] 切换市场后迟到的个人测算结果不覆盖当前上下文');

  let saveResolve;
  const saveWait = new Promise(resolve => { saveResolve = resolve; });
  const savedSimulation = [];
  const switching = createContext({
    saveSettings: async body => { await saveWait; return { revision: 5, settings: body }; },
    simulate: async request => { savedSimulation.push(request); return { runId: 51 }; },
  });
  Object.assign(switching.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 31,
    sourcePortfolio: { positionRatio: 0.6 }, settingsRevision: 4, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  const switchingSave = switching.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 9, code: '000009.SZ' });
  switching.ssState.market = 'HK'; switching.ssState.sourceRunId = 32; switching.ssState.contextVersion += 1;
  saveResolve();
  await switchingSave;
  assert.strictEqual(savedSimulation[0].sourceRunId, 31);
  assert.strictEqual(savedSimulation[0].positionRatio, 0.6);
  console.log('[PASS] 保存期间切换市场仍按原市场和公共来源派生');

  let resolveFirstSave;
  const queuedSaves = [];
  const queued = createContext({
    saveSettings: async body => {
      queuedSaves.push(body);
      if (queuedSaves.length === 1) return new Promise(resolve => { resolveFirstSave = () => resolve({ revision: 2, settings: Object.assign({}, body) }); });
      return { revision: 3, settings: Object.assign({}, body) };
    },
    simulate: async () => ({ runId: 71 }),
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, budgetRatio: 0.6, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(queued.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5, budgetRatio: 0.6 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  const queuedFirst = queued.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 1, code: '000001.SZ' });
  await Promise.resolve();
  const queuedSecond = queued.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 2, code: '000002.SZ' });
  assert.strictEqual(queuedSaves.length, 1);
  resolveFirstSave();
  await queuedFirst;
  await queuedSecond;
  assert.deepStrictEqual(Array.from(queuedSaves[1].excludedInstruments, item => item.code), ['000001.SZ', '000002.SZ']);
  console.log('[PASS] 连续排除操作串行合并，不丢失先前已保存的排除');

  let timeoutPayload;
  const recoveredSave = createContext({
    saveSettings: async body => { timeoutPayload = body; throw Object.assign(new Error('响应超时'), { status: 504 }); },
    getSettings: async () => ({ revision: 6, settings: Object.assign({}, timeoutPayload, { revision: undefined }) }),
    simulate: async request => ({ runId: 72, request }),
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, budgetRatio: 0.6, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(recoveredSave.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5, budgetRatio: 0.6 }, settingsRevision: 5, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  await recoveredSave.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 3, code: '000003.SZ' });
  assert.strictEqual(recoveredSave.ssState.settingsRevision, 6);
  assert.deepStrictEqual(Array.from(recoveredSave.ssState.settings.excludedInstruments, item => item.code), ['000003.SZ']);
  console.log('[PASS] 保存响应丢失但设置已落库时按重读结果继续派生');

  const conflictBodies = [];
  const rebased = createContext({
    saveSettings: async body => {
      conflictBodies.push(body);
      if (conflictBodies.length === 1) throw Object.assign(new Error('revision conflict'), { status: 409 });
      return { revision: 8, settings: body };
    },
    getSettings: async () => ({ revision: 7, settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [{ market: 'CN', instrumentId: 4, code: '000004.SZ' }] } }),
    simulate: async () => ({ runId: 73 }),
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, budgetRatio: 0.6, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(rebased.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5, budgetRatio: 0.6 }, settingsRevision: 6, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  await rebased.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 5, code: '000005.SZ' });
  assert.deepStrictEqual(Array.from(conflictBodies[1].excludedInstruments, item => item.code), ['000004.SZ', '000005.SZ']);
  console.log('[PASS] revision 冲突后按最新设置合并本次排除并重试');

  const unknownSave = createContext({
    saveSettings: async () => { throw new Error('连接中断'); },
    getSettings: async () => { throw new Error('读取也失败'); },
  });
  Object.assign(unknownSave.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5, budgetRatio: 0.6 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  await unknownSave.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 6, code: '000006.SZ' });
  assert.ok(unknownSave.ssState.pendingSettingsOperation);
  assert.ok(unknownSave.ssState.settingsSaveError);
  unknownSave.window.StockSelectionApi.saveSettings = async body => ({ revision: 2, settings: body });
  unknownSave.window.StockSelectionApi.simulate = async () => ({ runId: 74 });
  unknownSave.window.StockSelectionApi.getCandidates = async runId => ({ candidates: [], total: 0, runId });
  unknownSave.window.StockSelectionApi.getPortfolio = async runId => ({ runId, positionRatio: 0.5, members: [] });
  unknownSave.window.StockSelectionApi.getRun = async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 });
  await unknownSave.window.StockSelectionPresenter.retrySettings();
  assert.strictEqual(unknownSave.ssState.pendingSettingsOperation, null);
  assert.strictEqual(unknownSave.ssState.settingsRevision, 2);
  console.log('[PASS] 保存结果未知时保留操作意图并可单独重试保存');

  let blockedSaveCount = 0;
  const blockedBodies = [];
  const blockedQueue = createContext({
    saveSettings: async body => {
      blockedSaveCount += 1;
      blockedBodies.push(body);
      if (blockedSaveCount === 1) throw new Error('第一次保存连接中断');
      return { revision: blockedSaveCount, settings: body };
    },
    getSettings: async () => { throw new Error('设置暂不可读'); },
    simulate: async () => ({ runId: 75 }),
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(blockedQueue.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5, budgetRatio: 0.6 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  const blockedFirst = blockedQueue.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 7, code: '000007.SZ' });
  await Promise.resolve();
  const blockedSecond = blockedQueue.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 8, code: '000008.SZ' });
  await blockedFirst;
  assert.strictEqual(blockedBodies.length, 1);
  assert.ok(blockedQueue.ssState.pendingSettingsOperation, '第一次失败必须保留待重试操作');
  await blockedQueue.window.StockSelectionPresenter.retrySettings();
  await blockedSecond;
  assert.deepStrictEqual(Array.from(blockedBodies[2].excludedInstruments, item => item.code), ['000007.SZ', '000008.SZ']);
  assert.strictEqual(blockedQueue.ssState.pendingSettingsOperation, null);
  console.log('[PASS] 保存失败会暂停队列，重试后保留并继续后续排除意图');

  let persistedRevision = 1; let writesAfterLostResponse = 0; let readable = false;
  let persistedSettings = { industryFilters: { CN: [], HK: ['LEGACY'] }, excludedInstruments: [] };
  const lostResponse = createContext({
    saveSettings: async body => {
      writesAfterLostResponse += 1; persistedRevision += 1;
      // 模拟 PostgreSQL JSONB 的字段顺序及服务端补全默认字段/证券名称。
      persistedSettings = { totalCapital: null, schemaVersion: 2, positionRatioHk: null, positionRatioA: null,
        industryFilters: { HK: body.industryFilters.HK.map(item => typeof item === 'string' ? { code: item, name: null, version: null, system: null } : item), CN: body.industryFilters.CN },
        excludedInstruments: body.excludedInstruments.map(item => ({ note: item.note, name: '服务端名称', market: item.market, instrumentId: item.instrumentId, code: item.code })),
        customFilterVersion: 2, budgetRatioHk: null, budgetRatioA: null };
      if (writesAfterLostResponse === 1) throw new Error('响应丢失');
      return { revision: persistedRevision, settings: persistedSettings };
    },
    getSettings: async () => { if (!readable) throw new Error('暂不可读'); return { revision: persistedRevision, settings: persistedSettings }; },
    simulate: async () => ({ runId: 75 }),
  });
  Object.assign(lostResponse.ssState, { ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true, settings: persistedSettings });
  await lostResponse.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 9, code: '000009.SZ' });
  readable = true; Object.assign(lostResponse.ssState, { market: 'HK', sourceRunId: 42 }); lostResponse.ssState.contextVersion += 1;
  lostResponse.ssSettingsResult({ revision: persistedRevision, settings: persistedSettings });
  await lostResponse.window.StockSelectionPresenter.retrySettings();
  assert.strictEqual(writesAfterLostResponse, 1, '已确认落库的设置不得再次保存');
  assert.strictEqual(persistedRevision, 2);
  console.log('[PASS] 保存已落库而响应丢失，切市场重试不重复递增版本');

  let rebaseWrites = 0; let rebaseReadable = false; let rebaseSaved;
  const rebaseRetry = createContext({
    saveSettings: async body => { rebaseWrites += 1; if (rebaseWrites === 1) throw new Error('未知结果'); rebaseSaved = body; return { revision: 4, settings: body }; },
    getSettings: async () => {
      if (!rebaseReadable) throw new Error('暂不可读');
      return { revision: 3, settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [{ market: 'HK', instrumentId: 8, code: '00008.HK' }] } };
    },
    simulate: async () => ({ runId: 75 }),
    getCandidates: async () => ({ candidates: [], total: 0 }), getPortfolio: async () => ({ positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId, runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(rebaseRetry.ssState, { ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] } });
  await rebaseRetry.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 9, code: '000009.SZ' });
  rebaseReadable = true;
  await rebaseRetry.window.StockSelectionPresenter.retrySettings();
  assert.strictEqual(rebaseSaved.revision, 3);
  assert.deepStrictEqual(Array.from(rebaseSaved.excludedInstruments, item => item.code).sort(), ['000009.SZ', '00008.HK']);
  console.log('[PASS] 未知保存结果重试先读取最新设置并保留另一市场变更');

  let deniedWrites = 0;
  const deniedRetry = createContext({ saveSettings: async () => { deniedWrites += 1; throw new Error('未知结果'); },
    getSettings: async () => { throw Object.assign(new Error('禁止访问'), { status: deniedWrites ? 403 : 500 }); } });
  Object.assign(deniedRetry.ssState, { ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] } });
  await deniedRetry.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 9, code: '000009.SZ' });
  await deniedRetry.window.StockSelectionPresenter.retrySettings();
  assert.strictEqual(deniedWrites, 1, '403 后不得尝试写入');
  assert.strictEqual(deniedRetry.ssState.pendingSettingsOperation, null);
  assert.strictEqual(deniedRetry.ssSettingsMutationPaused, true);
  console.log('[PASS] 恢复读取返回 403 时清理待写入意图并停止写入');

  let releaseOldSave;
  const accountWrites = [];
  const accountSwitch = createContext({
    saveSettings: async body => {
      accountWrites.push({ user: accountSwitch.username, codes: Array.from(body.excludedInstruments, item => item.code) });
      if (accountWrites.length === 1) await new Promise(resolve => { releaseOldSave = resolve; });
      return { revision: 2, settings: body };
    },
    simulate: async () => ({ runId: 75 }),
  });
  Object.assign(accountSwitch.ssState, {
    ownerUser: accountSwitch.username, market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  const oldFirst = accountSwitch.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 1, code: 'A' });
  const oldSecond = accountSwitch.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 2, code: 'B' });
  accountSwitch.username = 'other-user';
  accountSwitch.ssBeginLoad('new-account');
  Object.assign(accountSwitch.ssState, { market: 'CN', periodType: 'weekly', sourceRunId: 42, sourcePortfolio: { positionRatio: 0.5 } });
  accountSwitch.ssSettingsResult({ revision: 1, settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] } });
  releaseOldSave();
  await Promise.all([oldFirst, oldSecond]);
  assert.strictEqual(accountWrites.length, 1, '旧账号的队列不得以新账号身份写入');
  assert.strictEqual(accountSwitch.ssState.pendingSettingsOperation, null);
  console.log('[PASS] 切换账号后丢弃旧主体排队操作和迟到状态');

  const routes = {};
  const fakeRouter = {};
  ['get', 'put', 'post'].forEach(method => { fakeRouter[method] = (path, ...handlers) => { routes[`${method} ${path}`] = handlers[handlers.length - 1]; }; });
  let routeWrites = 0;
  const routeModules = {
    express: { Router: () => fakeRouter }, crypto: require('crypto'),
    '../middleware/async': fn => fn,
    '../middleware/auth': { requireLogin: () => {}, requireCapability: () => () => {} },
    '../services/stockSelectionService': {
      saveSettings: async () => { routeWrites += 1; return { revision: 2 }; },
      createSimulation: async () => { routeWrites += 1; return { runId: 1, reused: false }; },
    },
    '../services/stockSelectionBacktest': {},
    '../db': { auditEvent: async () => {}, getUserAuth: async () => ({}) },
    '../services/jobScheduleSlots': {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server', 'routes', 'stockSelection.js'), 'utf8'), {
    require: name => { if (!(name in routeModules)) throw Error(name); return routeModules[name]; },
    module: { exports: {} }, console,
  });
  const oldSubjectToken = require('crypto').createHash('sha256').update('old-subject').digest('hex');
  for (const route of ['put /settings', 'post /simulations']) {
    const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await routes[route]({ session: { user: 'other-user', subjectId: 'new-subject' }, body: { sourceRunId: 1, expectedSubjectToken: oldSubjectToken } }, response);
    assert.strictEqual(response.code, 409, '切换 Cookie 后必须拒绝旧主体请求');
    assert.strictEqual(response.body.code, 'STOCK_SELECTION_SUBJECT_CHANGED', '旧主体拒绝必须保留可判别错误码');
  }
  assert.strictEqual(routeWrites, 0);
  console.log('[PASS] 登录 Cookie 被其他标签切换后拒绝旧主体写请求');

  const crossMarketBodies = [];
  let failCrossMarket = true;
  const crossMarket = createContext({
    saveSettings: async body => { crossMarketBodies.push(body); if (failCrossMarket) throw new Error('offline'); return { revision: 2, settings: body }; },
    getSettings: async () => { throw new Error('offline'); },
    simulate: async () => ({ runId: 75 }),
  });
  Object.assign(crossMarket.ssState, {
    ownerUser: crossMarket.username, market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  await crossMarket.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 9, code: 'C' });
  Object.assign(crossMarket.ssState, { market: 'HK', sourceRunId: 42 });
  crossMarket.ssState.contextVersion += 1;
  crossMarket.ssSettingsResult({ revision: 1, settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] } });
  assert.ok(crossMarket.ssState.settingsSaveError, '重载设置不能隐藏待重试状态');
  failCrossMarket = false;
  await crossMarket.window.StockSelectionPresenter.retrySettings();
  assert.strictEqual(crossMarket.ssState.pendingSettingsOperation, null);
  assert.strictEqual(crossMarket.ssSettingsMutationPaused, false);
  assert.strictEqual(crossMarket.ssState.settings.excludedInstruments[0].code, 'C');
  console.log('[PASS] 保存失败后切换市场仍可见并恢复原排除');

  const simulateConflictBodies = [];
  const simulateConflictSavedBodies = [];
  let simulateConflictCalls = 0;
  let simulateConflictSaves = 0;
  const simulateConflict = createContext({
    saveSettings: async body => { simulateConflictSavedBodies.push(body); return { revision: simulateConflictSaves++ === 0 ? 2 : 4, settings: body }; },
    getSettings: async () => ({ revision: 3, settings: {
      industryFilters: { CN: [], HK: [] },
      excludedInstruments: [{ market: 'CN', instrumentId: 30, code: 'EXTERNAL' }],
    } }),
    simulate: async request => {
      simulateConflictBodies.push(request); simulateConflictCalls += 1;
      if (simulateConflictCalls === 1) throw Object.assign(new Error('设置版本冲突'), { status: 409, code: 'STOCK_SELECTION_SETTINGS_REVISION_CONFLICT' });
      return { runId: 81 };
    },
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(simulateConflict.ssState, {
    ownerUser: simulateConflict.username, market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  await simulateConflict.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 31, code: 'USER_INTENT' });
  assert.strictEqual(simulateConflict.ssState.settingsRevision, 3);
  assert.strictEqual(simulateConflict.ssState.simulationError.code, 'STOCK_SELECTION_SETTINGS_REVISION_CONFLICT');
  const conflictRequestId = simulateConflict.ssState.pendingSimulation.clientRequestId;
  await simulateConflict.window.StockSelectionPresenter.retrySimulation();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(simulateConflict.ssState.pendingSimulation, null);
  assert.strictEqual(simulateConflict.ssState.personalRunId, 81);
  assert.strictEqual(simulateConflictBodies.length, 2);
  assert.strictEqual(simulateConflictBodies[0].clientRequestId, conflictRequestId);
  assert.strictEqual(simulateConflictBodies[1].clientRequestId, conflictRequestId);
  assert.strictEqual(simulateConflictBodies[1].settingsRevision, 4);
  assert.strictEqual(simulateConflictSaves, 2, '冲突合并完成后不得再次执行同一排除');
  assert.deepStrictEqual(Array.from(simulateConflictSavedBodies[1].excludedInstruments, item => item.code).sort(), ['EXTERNAL', 'USER_INTENT']);
  console.log('[PASS] 模拟阶段设置版本冲突先重读最新设置，再合并排除意图并复用原请求编号');

  let releaseConflictRead; let retryReadCount = 0; const retryFrozenRequests = [];
  const concurrentRetry = createContext({
    simulate: async request => { retryFrozenRequests.push(request); if (retryFrozenRequests.length === 1)
      throw Object.assign(new Error('冲突'), { status: 409, code: 'STOCK_SELECTION_SETTINGS_REVISION_CONFLICT' });
      return { runId: 81 }; },
    getSettings: async () => { retryReadCount += 1; if (retryReadCount === 2) await new Promise(resolve => { releaseConflictRead = resolve; });
      return { revision: 3, settings: { budgetRatioA: 0.9 } }; },
    getCandidates: async () => ({ candidates: [], total: 0 }),
    getPortfolio: async () => ({ positionRatio: 0.5, members: [] }),
    getRun: async () => ({ runId: 81, runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(concurrentRetry.ssState, { ownerUser: concurrentRetry.username, market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true, settings: { budgetRatioA: 0.3 } });
  await concurrentRetry.ssSimulate({});
  const retryOne = concurrentRetry.ssRetrySimulation();
  await Promise.resolve();
  const retryTwo = concurrentRetry.ssRetrySimulation();
  releaseConflictRead(); await Promise.all([retryOne, retryTwo]);
  assert.strictEqual(retryFrozenRequests.length, 2, '重复点击只允许一个重试');
  assert.strictEqual(retryFrozenRequests[1].budgetRatio, 0.3, '冲突恢复不能更改已冻结预算');
  console.log('[PASS] 并发重试只提交一次且保留冻结资金参数');

  let releaseStaleRetryRead;
  let staleRetryReadCount = 0;
  const staleRetryForbidden = createContext({
    simulate: async () => { throw Object.assign(new Error('冲突'), { status: 409, code: 'STOCK_SELECTION_SETTINGS_REVISION_CONFLICT' }); },
    getSettings: async () => {
      staleRetryReadCount += 1;
      if (staleRetryReadCount === 1) return { revision: 2, settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] } };
      return new Promise((resolve, reject) => { releaseStaleRetryRead = () => reject(Object.assign(new Error('禁止访问'), { status: 403 })); });
    },
  });
  Object.assign(staleRetryForbidden.ssState, {
    ownerUser: staleRetryForbidden.username, market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  await staleRetryForbidden.window.StockSelectionPresenter.simulate({});
  assert.ok(staleRetryForbidden.ssState.pendingSimulation);
  const staleRetry = staleRetryForbidden.window.StockSelectionPresenter.retrySimulation();
  await new Promise(resolve => setImmediate(resolve));
  staleRetryForbidden.username = 'new-account'; staleRetryForbidden.accountIdentity = 'new-identity';
  staleRetryForbidden.ssBeginLoad('new-account');
  Object.assign(staleRetryForbidden.ssState, {
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] }, settingsWritable: true,
  });
  releaseStaleRetryRead();
  await staleRetry;
  assert.strictEqual(staleRetryForbidden.ssState.ownerUser, 'new-account');
  assert.strictEqual(staleRetryForbidden.ssState.settingsWritable, true, '旧账号重试的 403 不得禁用新账号写入');
  assert.strictEqual(staleRetryForbidden.ssSettingsMutationPaused, false, '旧账号重试的 403 不得暂停新账号队列');
  console.log('[PASS] 旧账号模拟重试延迟 403 不污染新账号写入状态');

  let reloadWrites = 0;
  const forbiddenReload = createContext({
    saveSettings: async body => {
      reloadWrites += 1;
      if (reloadWrites === 1) throw Object.assign(new Error('禁止写入'), { status: 403 });
      return { revision: 3, settings: body };
    },
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', activePeriodType: 'week', markets: [] }),
    listRuns: async () => ({ runs: [], total: 0 }),
    getSettings: async () => ({ revision: 2, settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] } }),
    listIndustries: async () => ({ industries: [] }),
  });
  Object.assign(forbiddenReload.ssState, {
    ownerUser: forbiddenReload.username, market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  await forbiddenReload.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 9, code: 'FORBIDDEN' });
  assert.strictEqual(forbiddenReload.ssSettingsMutationPaused, true);
  await forbiddenReload.window.StockSelectionPresenter.load();
  assert.strictEqual(forbiddenReload.ssState.settingsWritable, true);
  assert.strictEqual(forbiddenReload.ssSettingsMutationPaused, false, '同账号成功重载设置后必须恢复新写入');
  await forbiddenReload.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 10, code: 'AFTER_RELOAD' });
  assert.strictEqual(reloadWrites, 2, '同账号重载后新的排除必须真正发起写入');
  console.log('[PASS] 403 后同账号成功重载设置可恢复新的排除写入');

  let missingPositionSimulations = 0;
  const missingPosition = createContext({
    getSettings: async () => ({ revision: 2, settings: { positionRatioA: 0.6, budgetRatioA: null, industryFilters: { CN: [], HK: [] }, excludedInstruments: [] } }),
    simulate: async request => { missingPositionSimulations += 1; assert.strictEqual(request.positionRatio, 0.6); return { runId: 82 }; },
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ runId, positionRatio: 0.6, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(missingPosition.ssState, {
    ownerUser: missingPosition.username, market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: null }, settingsRevision: 1, settingsWritable: true,
    settings: { positionRatioA: 0.8, industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
    run: { runId: 40, runKind: 'quarterly', sourceRunId: null }, runId: 40,
  });
  await missingPosition.window.StockSelectionPresenter.simulate({});
  assert.strictEqual(missingPosition.ssState.simulationError.code, 'STOCK_SELECTION_POSITION_REQUIRED');
  assert.ok(missingPosition.ssState.pendingSimulation);
  await missingPosition.window.StockSelectionPresenter.retrySimulation();
  assert.ok(missingPosition.ssState.pendingSimulation);
  assert.strictEqual(missingPositionSimulations, 0, '不得使用隐藏的旧目标仓位');
  console.log('[PASS] 来源仓位缺失时禁止使用旧设置仓位生成');

  const expired = createContext({
    simulate: async () => { throw Object.assign(new Error('会话失效'), { status: 401, code: 'AUTHENTICATION_REQUIRED' }); },
  });
  expired.accountIdentity = 'identity-a';
  Object.assign(expired.ssState, {
    ownerUser: expired.username, ownerIdentity: 'identity-a', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    runId: 91, personalRunId: 91, run: { runId: 91, runKind: 'personal', sourceRunId: 41 },
    settings: { excludedInstruments: [{ market: 'CN', instrumentId: 9, code: 'PRIVATE' }] },
    settingsRevision: 2, settingsWritable: true,
  });
  await expired.window.StockSelectionPresenter.simulate({ positionRatio: 0.5 });
  assert.strictEqual(expired.ssState.settings, null);
  assert.strictEqual(expired.ssState.pendingSimulation, null);
  assert.strictEqual(expired.ssState.personalRunId, null);
  assert.strictEqual(expired.ssState.run, null);
  console.log('[PASS] 模拟返回 401 时清理个人状态并终止旧请求');

  let readsAfterExpiredSettings = 0;
  const expiredSettings = createContext({
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', activePeriodType: 'week', markets: [] }),
    listRuns: async () => ({ runs: [{ runId: 41 }], total: 1 }),
    getSettings: async () => { throw Object.assign(new Error('会话失效'), { status: 401 }); },
    listIndustries: async () => ({ industries: [] }),
    getCandidates: async () => { readsAfterExpiredSettings += 1; return { candidates: [] }; },
    getPortfolio: async () => { readsAfterExpiredSettings += 1; return {}; },
    getRun: async () => { readsAfterExpiredSettings += 1; return {}; },
  });
  expiredSettings.window.location = { pathname: '/', search: '' };
  await expiredSettings.window.StockSelectionPresenter.load();
  assert.strictEqual(readsAfterExpiredSettings, 0, '认证失效后不得继续加载来源批次');
  assert.strictEqual(expiredSettings.ssState.run, null);
  assert.strictEqual(expiredSettings.ssState.loading, false);
  assert.ok(expiredSettings.window.location.href.includes('/login.html'));
  console.log('[PASS] 初始设置读取 401 后停止来源加载并释放加载状态');

  const readAuthCases = [
    {
      name: '历史来源分页',
      api: { listRuns: async () => { throw Object.assign(new Error('会话失效'), { status: 401 }); } },
      prepare: state => Object.assign(state, { runs: [{ runId: 41 }], runTotal: 2, runOffset: 1 }),
      invoke: context => context.window.StockSelectionPresenter.loadMoreRuns(),
    },
    {
      name: '候选分页',
      api: { getCandidates: async () => { throw Object.assign(new Error('会话失效'), { status: 401 }); } },
      prepare: state => Object.assign(state, { runId: 41, candidates: [{ code: 'PUBLIC' }], candidateTotal: 2, candidateOffset: 1 }),
      invoke: context => context.window.StockSelectionPresenter.loadMore(),
    },
    {
      name: '股票详情',
      api: { getStock: async () => { throw Object.assign(new Error('会话失效'), { status: 401 }); } },
      prepare: state => Object.assign(state, { runId: 41, detail: { code: 'PRIVATE' } }),
      invoke: context => context.window.StockSelectionPresenter.openStock('PRIVATE'),
    },
  ];
  for (const testCase of readAuthCases) {
    const readAuth = createContext(testCase.api);
    readAuth.accountIdentity = 'identity-a';
    readAuth.window.location = { pathname: '/index.html', search: '?main=stock-selection' };
    Object.assign(readAuth.ssState, {
      ownerUser: readAuth.username, ownerIdentity: 'identity-a', market: 'CN', periodType: 'weekly',
      settings: { excludedInstruments: [{ market: 'CN', instrumentId: 9, code: 'PRIVATE' }] }, settingsRevision: 2,
      settingsWritable: true, sourceRunId: 41,
    });
    testCase.prepare(readAuth.ssState);
    await testCase.invoke(readAuth);
    assert.strictEqual(readAuth.ssState.settings, null, testCase.name + ' 401 后必须清理私有设置');
    assert.strictEqual(readAuth.ssState.settingsWritable, false, testCase.name + ' 401 后必须停止写入');
    assert.strictEqual(readAuth.ssState.detail, null, testCase.name + ' 401 后不得保留私有详情');
    assert.ok(readAuth.window.location.href.includes('/login.html'), testCase.name + ' 401 后必须跳转登录');
  }
  console.log('[PASS] 来源分页、候选分页和股票详情 401 均清理私有态并跳转登录');

  let rejectOldRead;
  const staleAuth = createContext({ getCandidates: () => new Promise((resolve, reject) => { rejectOldRead = reject; }),
    getPortfolio: async () => ({}), getRun: async () => ({}) });
  staleAuth.accountIdentity = 'old';
  staleAuth.window.location = { pathname: '/', search: '' };
  Object.assign(staleAuth.ssState, { ownerUser: staleAuth.username, ownerIdentity: 'old', market: 'CN', periodType: 'weekly', sourceRunId: 41 });
  const oldRead = staleAuth.ssLoadRun(41, { source: true });
  staleAuth.username = 'new-user'; staleAuth.accountIdentity = 'new';
  staleAuth.ssBeginLoad('new-account'); staleAuth.ssState.settings = { privateValue: 'new-user' };
  rejectOldRead(Object.assign(new Error('旧会话失效'), { status: 401 }));
  await oldRead;
  assert.strictEqual(staleAuth.ssState.settings.privateValue, 'new-user');
  assert.strictEqual(staleAuth.window.location.href, undefined);
  console.log('[PASS] 旧账号迟到的 401 不清理新账号或跳转');

  let rejectStaleSimulation;
  const staleSimulation = createContext({
    simulate: async () => new Promise((resolve, reject) => { rejectStaleSimulation = reject; }),
  });
  staleSimulation.accountIdentity = 'identity-a';
  staleSimulation.window.location = { pathname: '/', search: '' };
  Object.assign(staleSimulation.ssState, {
    ownerUser: staleSimulation.username, ownerIdentity: 'identity-a', market: 'CN', periodType: 'weekly',
    sourceRunId: 41, runId: 41, sourcePortfolio: { positionRatio: 0.5 }, settings: { privateValue: 'old-market' },
    settingsWritable: true,
  });
  const oldSimulation = staleSimulation.window.StockSelectionPresenter.simulate({ positionRatio: 0.5 });
  Object.assign(staleSimulation.ssState, { market: 'HK', sourceRunId: 42, runId: 42, settings: { privateValue: 'new-market' } });
  staleSimulation.ssState.contextVersion += 1;
  rejectStaleSimulation(Object.assign(new Error('旧市场会话失效'), { status: 401 }));
  await oldSimulation;
  assert.strictEqual(staleSimulation.ssState.settings.privateValue, 'new-market');
  assert.strictEqual(staleSimulation.ssState.runId, 42);
  assert.strictEqual(staleSimulation.window.location.href, undefined);
  console.log('[PASS] 旧市场测算迟到的 401 不清理当前市场或跳转');

  const industriesExpired = createContext({
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', activePeriodType: 'week', markets: [] }),
    listRuns: async () => ({ runs: [{ runId: 41 }], total: 1 }),
    getSettings: async () => ({ revision: 1, settings: { excludedInstruments: [{ market: 'CN', instrumentId: 9, code: 'PRIVATE' }] } }),
    listIndustries: async () => { throw Object.assign(new Error('行业读取会话失效'), { status: 401 }); },
  });
  industriesExpired.window.location = { pathname: '/', search: '?main=stock-selection' };
  await industriesExpired.window.StockSelectionPresenter.load();
  assert.strictEqual(industriesExpired.ssState.settings, null);
  assert.strictEqual(industriesExpired.ssState.settingsWritable, false);
  assert.strictEqual(industriesExpired.ssState.runId, null);
  assert.ok(industriesExpired.window.location.href.includes('/login.html'));
  console.log('[PASS] 行业列表 401 清理私有态并停止页面继续使用旧数据');

  let rejectLateSettings;
  const lateSettingsAuth = createContext({
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', activePeriodType: 'week', markets: [] }),
    listRuns: async () => { throw Object.assign(new Error('批次列表失败'), { status: 500 }); },
    getSettings: () => new Promise((resolve, reject) => { rejectLateSettings = reject; }),
    listIndustries: async () => ({ industries: [] }),
  });
  lateSettingsAuth.window.location = { pathname: '/', search: '' };
  Object.assign(lateSettingsAuth.ssState, {
    settings: { privateValue: 'old' }, settingsWritable: true, ownerUser: lateSettingsAuth.username,
  });
  const lateSettingsLoad = lateSettingsAuth.window.StockSelectionPresenter.load();
  await lateSettingsLoad;
  rejectLateSettings(Object.assign(new Error('迟到的会话失效'), { status: 401 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(lateSettingsAuth.ssState.settings, null, '批次列表先失败时仍必须处理迟到的设置 401');
  assert.strictEqual(lateSettingsAuth.ssState.settingsWritable, false);
  assert.ok(lateSettingsAuth.window.location.href.includes('/login.html'));
  console.log('[PASS] 批次列表先失败时不漏掉迟到的设置 401');

  let rejectLateIndustries;
  const lateIndustriesAuth = createContext({
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', activePeriodType: 'week', markets: [] }),
    listRuns: async () => { throw Object.assign(new Error('批次列表失败'), { status: 500 }); },
    getSettings: async () => ({ revision: 1, settings: { privateValue: 'old' } }),
    listIndustries: () => new Promise((resolve, reject) => { rejectLateIndustries = reject; }),
  });
  lateIndustriesAuth.window.location = { pathname: '/', search: '' };
  const lateIndustriesLoad = lateIndustriesAuth.window.StockSelectionPresenter.load();
  await lateIndustriesLoad;
  rejectLateIndustries(Object.assign(new Error('迟到的行业会话失效'), { status: 401 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(lateIndustriesAuth.ssState.settings, null, '批次列表先失败时仍必须处理迟到的行业 401');
  assert.strictEqual(lateIndustriesAuth.ssState.settingsWritable, false);
  assert.ok(lateIndustriesAuth.window.location.href.includes('/login.html'));
  console.log('[PASS] 批次列表先失败时不漏掉迟到的行业 401');

  let rejectSettings401; let rejectIndustries401; let authToasts = 0;
  const duplicateAuth = createContext({
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', activePeriodType: 'week', markets: [] }),
    listRuns: async () => ({ runs: [], total: 0 }),
    getSettings: () => new Promise((resolve, reject) => { rejectSettings401 = reject; }),
    listIndustries: () => new Promise((resolve, reject) => { rejectIndustries401 = reject; }),
  });
  duplicateAuth.window.location = { pathname: '/', search: '' };
  duplicateAuth.ssShowToast = message => { if (String(message).includes('登录已失效')) authToasts += 1; };
  const duplicateAuthLoad = duplicateAuth.window.StockSelectionPresenter.load();
  await new Promise(resolve => setImmediate(resolve));
  rejectSettings401(Object.assign(new Error('设置会话失效'), { status: 401 }));
  rejectIndustries401(Object.assign(new Error('行业会话失效'), { status: 401 }));
  await duplicateAuthLoad;
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(authToasts, 1, '同一轮并发 401 只能清理并提示一次');
  console.log('[PASS] 并发请求同时 401 只触发一次登录失效处理');

  const legacyStrategy = 'investment_essentials_adapted_v1';
  const activeStrategy = 'investment_essentials_adapted_v2';
  const historyCalls = [];
  const historyRows = Array.from({ length: 22 }, (_, index) => ({
    runId: 100 + index, market: 'CN', runKind: 'quarterly', periodType: 'quarter',
    strategyCode: index === 0 ? activeStrategy : legacyStrategy,
    publishedAt: '2026-01-01T00:00:00.000Z', isShadow: false,
  }));
  const weeklyRun = { runId: 200, market: 'CN', runKind: 'weekly', periodType: 'week',
    strategyCode: activeStrategy, publishedAt: '2026-11-08T00:00:00.000Z', isShadow: false };
  const crossStrategyHistory = createContext({
    getMarkets: async query => ({ strategyCode: activeStrategy, activePeriodType: query.periodType || 'week', markets: [] }),
    listRuns: async query => {
      historyCalls.push(query);
      const rows = query.kind === 'quarterly' ? historyRows : [weeklyRun];
      const filtered = rows.filter(run => run.market === query.market && (!query.strategy || query.strategy === run.strategyCode));
      return { runs: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length };
    },
    getSettings: async () => ({ revision: 1, settings: {} }),
    listIndustries: async () => ({ industries: [] }),
    getCandidates: async () => ({ candidates: [], total: 0 }),
    getPortfolio: async () => ({ members: [], positionRatio: 0.5 }),
    getRun: async id => historyRows.find(run => run.runId === Number(id)) || weeklyRun,
  });
  await crossStrategyHistory.window.StockSelectionPresenter.load();
  assert.strictEqual(historyCalls[0].strategy, activeStrategy, '周渠道必须保留当前策略过滤');
  await crossStrategyHistory.window.StockSelectionPresenter.switchPeriod('quarter');
  assert.strictEqual(crossStrategyHistory.ssState.runTotal, 22, '季度列表必须包含 V1 和 V2 已发布来源');
  assert.strictEqual(historyCalls[historyCalls.length - 1].strategy, null, '季度首屏不能按当前策略过滤');
  await crossStrategyHistory.window.StockSelectionPresenter.loadMoreRuns();
  assert.strictEqual(historyCalls[historyCalls.length - 1].offset, 20);
  assert.strictEqual(historyCalls[historyCalls.length - 1].strategy, null, '季度分页不能按当前策略过滤');
  await crossStrategyHistory.window.StockSelectionPresenter.selectRun(121);
  assert.strictEqual(crossStrategyHistory.ssState.run.strategyCode, legacyStrategy, '所选结果必须保留来源实际策略');
  const ruleNodes = ['v1', 'v2'].map(rule => ({ hidden: null, getAttribute: () => rule }));
  const ruleView = { window: {}, document: { querySelectorAll: () => ruleNodes } };
  vm.createContext(ruleView);
  vm.runInContext(fs.readFileSync(path.join(root, 'public', 'js', 'stock-selection.js'), 'utf8'), ruleView);
  ruleView.window.StockSelectionView.renderRuleScope(crossStrategyHistory.ssState);
  assert.strictEqual(ruleNodes[0].hidden, false, 'V1 来源应显示 V1 规则说明');
  assert.strictEqual(ruleNodes[1].hidden, true, 'V1 来源不应显示 V2 规则说明');
  await crossStrategyHistory.window.StockSelectionPresenter.switchPeriod('weekly');
  ruleView.window.StockSelectionView.renderRuleScope(crossStrategyHistory.ssState);
  assert.strictEqual(ruleNodes[1].hidden, false, '切回 V2 周来源应显示 V2 规则说明');
  await crossStrategyHistory.window.StockSelectionPresenter.switchPeriod('quarter');
  assert.strictEqual(crossStrategyHistory.ssState.sourceRunId, 121, '首屏外 V1 来源切回后必须恢复');
  assert.strictEqual(crossStrategyHistory.ssState.run.strategyCode, legacyStrategy);
  assert.strictEqual(crossStrategyHistory.ssState.runOffset, 20);
  assert.strictEqual(crossStrategyHistory.ssIsValidRememberedSource(Object.assign({}, weeklyRun, { strategyCode: legacyStrategy })), false, '季度上下文不得接受周来源');
  await crossStrategyHistory.window.StockSelectionPresenter.switchPeriod('weekly');
  assert.strictEqual(crossStrategyHistory.ssIsValidRememberedSource(Object.assign({}, weeklyRun, { strategyCode: legacyStrategy })), false, '周渠道不得恢复其他策略的来源');
  console.log('[PASS] V2 下历史季度可分页选择并恢复首屏外 V1 来源，周渠道仍隔离策略');

  function sourceRun(runId, market) {
    return { runId: Number(runId), market: market, runKind: 'weekly', periodType: 'week',
      strategyCode: 'stock_selection_v2', publishedAt: '2026-11-08T00:00:00.000Z', isShadow: false };
  }
  const sourceRestoreCalls = [];
  const sourceRestoreGetRunCalls = [];
  const sourceRestore = createContext({
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', activePeriodType: 'week', markets: [] }),
    listRuns: async query => {
      sourceRestoreCalls.push({ type: 'listRuns', query });
      if (query.market === 'HK') return { runs: [sourceRun(30, 'HK')], total: 1 };
      if (Number(query.offset) >= 20) return { runs: [sourceRun(21, 'CN')], total: 21 };
      return { runs: Array.from({ length: 20 }, (_, index) => sourceRun(20 - index, 'CN')), total: 21 };
    },
    getSettings: async () => ({ revision: 1, settings: {} }),
    listIndustries: async () => ({ industries: [] }),
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ members: [], positionRatio: 0.5, runId }),
    getRun: async runId => { sourceRestoreGetRunCalls.push(Number(runId)); return sourceRun(runId, Number(runId) === 30 ? 'HK' : 'CN'); },
  });
  await sourceRestore.window.StockSelectionPresenter.load();
  await sourceRestore.window.StockSelectionPresenter.selectRun(21);
  assert.strictEqual(sourceRestore.ssState.sourceRunId, 21);
  await sourceRestore.window.StockSelectionPresenter.switchMarket('HK');
  assert.strictEqual(sourceRestore.ssState.sourceRunId, 30);
  await sourceRestore.window.StockSelectionPresenter.switchMarket('CN');
  assert.strictEqual(sourceRestore.ssState.sourceRunId, 21, '切回市场必须恢复用户选过的来源');
  assert.strictEqual(sourceRestore.ssState.runs[0].runId, 21, '首屏没有缓存批次时必须把已验证批次置于可选列表');
  assert.strictEqual(sourceRestore.ssState.runOffset, 20, '恢复首屏外批次不能把额外展示项计入 API offset');
  await sourceRestore.window.StockSelectionPresenter.loadMoreRuns();
  assert.strictEqual(sourceRestore.ssState.runOffset, 21);
  assert.strictEqual(sourceRestore.ssState.runs.filter(run => Number(run.runId) === 21).length, 1, '分页补回缓存批次时不得重复展示');
  assert.ok(sourceRestoreCalls.some(item => item.type === 'listRuns' && item.query.offset === 20));
  console.log('[PASS] 按主体恢复首屏外来源且分页 offset 与展示列表解耦');

  const invalidSourceToasts = [];
  const invalidSource = createContext({
    getMarkets: async () => ({ strategyCode: 'stock_selection_v2', activePeriodType: 'week', markets: [] }),
    listRuns: async query => ({ runs: [sourceRun(query.market === 'HK' ? 6 : 5, query.market)], total: 1 }),
    getSettings: async () => ({ revision: 1, settings: {} }),
    listIndustries: async () => ({ industries: [] }),
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ members: [], positionRatio: 0.5, runId }),
    getRun: async runId => Number(runId) === 99
      ? Object.assign(sourceRun(99, 'CN'), { publishedAt: null }) : sourceRun(runId, Number(runId) === 6 ? 'HK' : 'CN'),
  });
  invalidSource.ssShowToast = message => invalidSourceToasts.push(String(message));
  await invalidSource.window.StockSelectionPresenter.load();
  await invalidSource.window.StockSelectionPresenter.selectRun(99);
  await invalidSource.window.StockSelectionPresenter.switchMarket('HK');
  await invalidSource.window.StockSelectionPresenter.switchMarket('CN');
  assert.strictEqual(invalidSource.ssState.sourceRunId, 5, '失效缓存必须回到当前渠道最新来源');
  assert.ok(invalidSourceToasts.some(message => message.includes('来源已失效')));
  console.log('[PASS] 已发布状态失效时提示并回退最新来源');

  sourceRestoreGetRunCalls.splice(0);
  sourceRestore.username = 'stock-selection-new-account';
  await sourceRestore.window.StockSelectionPresenter.load();
  assert.strictEqual(sourceRestore.ssState.sourceRunId, 20, '切账号后不得继承旧主体来源缓存');
  assert.ok(!sourceRestoreGetRunCalls.includes(21), '切账号后的首次加载不得读取旧主体缓存批次');
  console.log('[PASS] 切账号清空来源缓存并隔离旧主体');

  let releaseForbidden; let forbiddenWrites = 0; let forbiddenSimulations = 0;
  const forbidden = createContext({
    saveSettings: async body => { forbiddenWrites += 1; return { revision: forbiddenWrites + 1, settings: body }; },
    simulate: async () => { forbiddenSimulations += 1; await new Promise(resolve => { releaseForbidden = resolve; }); throw Object.assign(new Error('无权限'), { status: 403 }); },
  });
  Object.assign(forbidden.ssState, { ownerUser: forbidden.username, market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] } });
  const firstForbidden = forbidden.ssExcludeTarget('instrument', { instrumentId: 1, code: 'A' });
  await new Promise(resolve => setImmediate(resolve));
  const queuedForbidden = forbidden.ssExcludeTarget('instrument', { instrumentId: 2, code: 'B' });
  releaseForbidden(); await Promise.all([firstForbidden, queuedForbidden]);
  await forbidden.ssExcludeTarget('instrument', { instrumentId: 3, code: 'C' });
  assert.strictEqual(forbiddenWrites, 1);
  assert.strictEqual(forbiddenSimulations, 1);
  assert.strictEqual(forbidden.ssState.settingsWritable, false);
  console.log('[PASS] 模拟 403 后排队与后续操作均停止写入');

  const retryIds = [];
  const retryContext = createContext({
    saveSettings: async body => ({ revision: Number(body.revision) + 1, settings: body }),
    simulate: async request => { retryIds.push(request.clientRequestId); throw new Error('模拟失败'); },
  });
  Object.assign(retryContext.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 0, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  await retryContext.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 1, code: '000001.SZ' });
  await retryContext.window.StockSelectionPresenter.excludeTarget('instrument', { instrumentId: 2, code: '000002.SZ' });
  assert.strictEqual(retryIds.length, 2);
  assert.notStrictEqual(retryIds[0], retryIds[1]);
  console.log('[PASS] 新排除操作不会复用上一次未知结果的请求编号');

  let resolvePagingSimulation;
  const paging = createContext({
    simulate: () => new Promise(resolve => { resolvePagingSimulation = resolve; }),
    getCandidates: async () => ({ candidates: [{ code: 'NEXT' }], total: 2 }),
    getPortfolio: async () => ({ positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId, runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(paging.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    runId: 41, sourcePortfolio: { positionRatio: 0.5 }, settings: {}, settingsRevision: 1,
    candidates: [{ code: 'FIRST' }], candidateTotal: 2, candidateOffset: 1,
  });
  const pagingSimulation = paging.window.StockSelectionPresenter.simulate({});
  await paging.window.StockSelectionPresenter.loadMore();
  resolvePagingSimulation({ runId: 52 });
  await pagingSimulation;
  assert.strictEqual(paging.ssState.personalRunId, 52);
  assert.strictEqual(paging.ssState.runId, 52);
  console.log('[PASS] 加载更多候选不会丢弃进行中的个人测算结果');

  let releaseResultCandidates;
  let resultReadCalls = 0;
  const resultReadPaging = createContext({
    simulate: async () => ({ runId: 53 }),
    getCandidates: async (runId, query) => {
      if (Number(runId) === 53) {
        resultReadCalls += 1;
        return new Promise(resolve => { releaseResultCandidates = () => resolve({ candidates: [{ code: 'PERSONAL' }], total: 1, runId }); });
      }
      return { candidates: [{ code: 'NEXT' }], total: 2, runId };
    },
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId, runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(resultReadPaging.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    runId: 41, sourcePortfolio: { positionRatio: 0.5 }, settings: {}, settingsRevision: 1,
    candidates: [{ code: 'FIRST' }], candidateTotal: 2, candidateOffset: 1,
  });
  const resultReadSimulation = resultReadPaging.window.StockSelectionPresenter.simulate({});
  await new Promise(resolve => setImmediate(resolve));
  await resultReadPaging.window.StockSelectionPresenter.loadMore();
  releaseResultCandidates();
  await resultReadSimulation;
  assert.strictEqual(resultReadPaging.ssState.personalRunId, 53);
  assert.strictEqual(resultReadPaging.ssState.pendingSimulation, null);
  assert.strictEqual(resultReadPaging.ssState.simulationError, null);
  assert.strictEqual(resultReadCalls, 1);
  console.log('[PASS] 结果读取期间点击加载更多不会使个人结果读取失效');

  let releaseHistoryResult;
  const historyPaging = createContext({
    simulate: async () => ({ runId: 54 }),
    getCandidates: async runId => Number(runId) === 54
      ? new Promise(resolve => { releaseHistoryResult = () => resolve({ candidates: [{ code: 'HISTORY_SAFE' }], total: 1, runId }); })
      : { candidates: [], total: 0, runId },
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
    listRuns: async () => ({ runs: [{ runId: 40 }], total: 2 }),
  });
  Object.assign(historyPaging.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    runId: 41, runs: [{ runId: 41 }], runTotal: 2, runOffset: 1,
    sourcePortfolio: { positionRatio: 0.5 }, settings: {}, settingsRevision: 1,
    candidates: [{ code: 'FIRST' }], candidateTotal: 2, candidateOffset: 1,
  });
  const historySimulation = historyPaging.window.StockSelectionPresenter.simulate({});
  await new Promise(resolve => setImmediate(resolve));
  await historyPaging.window.StockSelectionPresenter.loadMoreRuns();
  assert.strictEqual(historyPaging.ssState.runListLoading, false);
  releaseHistoryResult();
  await historySimulation;
  assert.strictEqual(historyPaging.ssState.personalRunId, 54);
  assert.strictEqual(historyPaging.ssState.pendingSimulation, null);
  assert.strictEqual(historyPaging.ssState.simulationError, null);
  assert.strictEqual(historyPaging.ssState.runId, 54);
  console.log('[PASS] 历史来源分页不会使个人结果读取失效');

  let releaseHistoryPage;
  let historyPageCalls = 0;
  const historyDouble = createContext({
    listRuns: async () => {
      historyPageCalls += 1;
      return new Promise(resolve => { releaseHistoryPage = () => resolve({ runs: [{ runId: 40 }], total: 2 }); });
    },
  });
  Object.assign(historyDouble.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly',
    runs: [{ runId: 41 }], runTotal: 2, runOffset: 1,
  });
  const historyFirstPage = historyDouble.window.StockSelectionPresenter.loadMoreRuns();
  await historyDouble.window.StockSelectionPresenter.loadMoreRuns();
  assert.strictEqual(historyPageCalls, 1);
  releaseHistoryPage();
  await historyFirstPage;
  assert.strictEqual(historyDouble.ssState.runs.length, 2);
  assert.strictEqual(historyDouble.ssState.runListLoading, false);
  console.log('[PASS] 历史来源分页重复点击只保留一个请求');

  let releaseFailedSaveHistory;
  let failedSaveHistoryCalls = 0;
  const failedSaveHistory = createContext({
    listRuns: async () => {
      failedSaveHistoryCalls += 1;
      return failedSaveHistoryCalls === 1 ? new Promise(resolve => { releaseFailedSaveHistory = resolve; }) : { runs: [{ runId: 39 }], total: 3 };
    },
    saveSettings: async () => { throw new Error('保存超时'); },
    getSettings: async () => { throw new Error('暂不可读'); },
  });
  Object.assign(failedSaveHistory.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    runId: 41, sourcePortfolio: { positionRatio: 0.5 }, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] }, settingsRevision: 1,
    runs: [{ runId: 41 }], runTotal: 3, runOffset: 1,
  });
  const failedSavePage = failedSaveHistory.window.StockSelectionPresenter.loadMoreRuns();
  await failedSaveHistory.window.StockSelectionPresenter.excludeTarget('instrument', { code: 'A', instrumentId: 1 });
  releaseFailedSaveHistory({ runs: [{ runId: 40 }], total: 3 });
  await failedSavePage;
  assert.strictEqual(failedSaveHistory.ssState.runListLoading, false);
  assert.strictEqual(failedSaveHistory.ssState.runs.length, 2);
  await failedSaveHistory.window.StockSelectionPresenter.loadMoreRuns();
  assert.strictEqual(failedSaveHistoryCalls, 2);
  assert.strictEqual(failedSaveHistory.ssState.runs.length, 3);
  console.log('[PASS] 保存失败不阻断在途历史分页及后续分页');

  let releaseProgressSimulation;
  const progress = createContext({
    saveSettings: async body => ({ revision: 2, settings: body }),
    simulate: async () => new Promise(resolve => { releaseProgressSimulation = resolve; }),
    getCandidates: async () => ({ candidates: [], total: 0 }),
    getPortfolio: async () => ({ members: [], positionRatio: 0.5 }),
    getRun: async () => ({ runId: 56, runKind: 'personal', sourceRunId: 41, settingsRevision: 2 }),
  });
  const progressHeaders = [];
  progress.ssRenderRunHeader = state => progressHeaders.push({ pending: !!state.pendingSimulation, error: !!state.simulationError });
  Object.assign(progress.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41, runId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsWritable: true, settingsRevision: 1,
    settings: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] },
  });
  const progressUpdate = progress.window.StockSelectionPresenter.excludeTarget('instrument', { code: 'A', instrumentId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(progressHeaders.some(item => item.pending && !item.error));
  assert.strictEqual(progress.ssState.settingsRevision, 2);
  releaseProgressSimulation({ runId: 56 });
  await progressUpdate;
  assert.strictEqual(progressHeaders[progressHeaders.length - 1].pending, false);
  console.log('[PASS] 设置保存后立即刷新更新状态，结果读取完成后解除');

  let rejectStaleDetail;
  const staleDetail = createContext({
    getStock: async () => new Promise((resolve, reject) => { rejectStaleDetail = reject; }),
    simulate: async () => ({ runId: 55 }),
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  const staleDetailToasts = [];
  staleDetail.ssShowToast = message => staleDetailToasts.push(message);
  Object.assign(staleDetail.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    runId: 41, sourcePortfolio: { positionRatio: 0.5 }, settings: {}, settingsRevision: 1,
  });
  const staleDetailRead = staleDetail.window.StockSelectionPresenter.openStock('OLD');
  await new Promise(resolve => setImmediate(resolve));
  await staleDetail.window.StockSelectionPresenter.simulate({});
  rejectStaleDetail(new Error('旧批次详情读取失败'));
  await staleDetailRead;
  assert.ok(!staleDetailToasts.some(message => String(message).includes('读取详情失败')));
  console.log('[PASS] 旧批次详情失败不会污染新个人结果提示');

  let candidateReads = 0;
  const retryRangeCalls = [];
  const readRetry = createContext({
    simulate: async () => ({ runId: 82 }),
    getCandidates: async (runId, query) => {
      candidateReads += 1; retryRangeCalls.push(query);
      if (candidateReads === 1) throw new Error('候选结果暂不可读');
      return { candidates: Array.from({ length: query.limit }, (_, index) => ({ code: String(query.offset + index) })), total: 200, runId };
    },
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(readRetry.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settings: {}, runId: 41,
    candidates: Array.from({ length: 100 }, (_, index) => ({ code: String(index) })), candidateTotal: 200, candidateOffset: 100,
  });
  await readRetry.window.StockSelectionPresenter.simulate({});
  assert.strictEqual(readRetry.ssState.pendingSimulation.resultRunId, 82);
  assert.ok(readRetry.ssState.simulationError);
  await readRetry.window.StockSelectionPresenter.simulate(Object.assign({}, readRetry.ssState.pendingSimulation));
  assert.strictEqual(readRetry.ssState.pendingSimulation, null);
  assert.strictEqual(readRetry.ssState.runId, 82);
  assert.strictEqual(JSON.stringify(retryRangeCalls.map(item => item.offset)), JSON.stringify([0, 0, 50]));
  assert.strictEqual(readRetry.ssState.candidates.length, 100, '结果读取重试必须保留原已加载候选范围');
  console.log('[PASS] 个人结果读取失败保留结果 ID，并按原候选范围重试读取阶段');

  let inheritedRequest;
  const inherited = createContext({
    simulate: async request => { inheritedRequest = request; return { runId: 83 }; },
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ runId, positionRatio: 0.8, budgetRatio: 0.7, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(inherited.ssState, {
    ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5, budgetRatio: 0.6 }, run: { runKind: 'personal', sourceRunId: 41 },
    portfolio: { positionRatio: 0.8, budgetRatio: 0.7, members: [] }, settingsRevision: 1, settings: {}, runId: 82,
  });
  await inherited.window.StockSelectionPresenter.simulate({});
  assert.strictEqual(inheritedRequest.positionRatio, 0.8);
  assert.strictEqual(inheritedRequest.budgetRatio, 0.7);
  console.log('[PASS] 后续个人排除沿用当前个人组合的仓位和预算');
  inherited.ssState.run = { runKind: 'personal', sourceRunId: 41 };
  inherited.ssState.portfolio = { positionRatio: 0.8, budgetRatio: null, members: [] };
  inherited.ssState.settings = { budgetRatioA: 0.6 };
  await inherited.window.StockSelectionPresenter.simulate({});
  assert.strictEqual(inheritedRequest.budgetRatio, null, '个人结果明确的空预算不得回退为设置中的预算');
  console.log('[PASS] 个人结果明确空预算时后续派生继续保留空值');

  let firstDerivedRequest;
  const firstDerived = createContext({
    simulate: async request => { firstDerivedRequest = request; return { runId: 85 }; },
    getCandidates: async runId => ({ candidates: [], total: 0, runId }),
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, budgetRatio: 0.2, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: Number(runId) === 41 ? 'weekly' : 'personal', sourceRunId: 41 }),
  });
  Object.assign(firstDerived.ssState, { ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5, budgetRatio: 0.2 }, run: { runKind: 'weekly', sourceRunId: null },
    settingsRevision: 1, settings: { budgetRatioA: 0.6 }, runId: 41 });
  await firstDerived.window.StockSelectionPresenter.simulate({});
  assert.strictEqual(firstDerivedRequest.budgetRatio, 0.6, '首次个人派生必须使用用户本市场预算，不得继承公共组合预算');
  console.log('[PASS] 首次个人派生使用用户本市场预算');

  const rangeCalls = [];
  const preservedRange = createContext({
    simulate: async () => ({ runId: 86 }),
    getCandidates: async (runId, query) => {
      rangeCalls.push({ runId, query });
      return { candidates: Array.from({ length: query.limit }, (_, index) => ({ code: String(query.offset + index) })), total: 200, runId };
    },
    getPortfolio: async runId => ({ runId, positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId: Number(runId), runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(preservedRange.ssState, { ownerUser: 'stock-selection-ux-test', market: 'CN', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, run: { runKind: 'weekly', sourceRunId: null }, settingsRevision: 1,
    settings: {}, runId: 41, candidates: Array.from({ length: 100 }, (_, index) => ({ code: String(index) })), candidateTotal: 200, candidateOffset: 100 });
  await preservedRange.window.StockSelectionPresenter.simulate({});
  assert.strictEqual(JSON.stringify(rangeCalls.map(item => item.query)), JSON.stringify([{ limit: 50, offset: 0 }, { limit: 50, offset: 50 }]));
  assert.strictEqual(preservedRange.ssState.candidates.length, 100, '个人结果更新必须保留已加载的候选范围');
  console.log('[PASS] 更新个人结果保留已加载候选范围');

  let restoredLegacy;
  const legacyRestore = createContext({
    saveSettings: async body => { restoredLegacy = body; return { revision: 2, settings: body }; },
    simulate: async () => ({ runId: 84 }), getCandidates: async () => ({ candidates: [], total: 0 }),
    getPortfolio: async () => ({ positionRatio: 0.5, members: [] }),
    getRun: async runId => ({ runId, runKind: 'personal', sourceRunId: 41 }),
  });
  Object.assign(legacyRestore.ssState, { ownerUser: 'stock-selection-ux-test', market: 'HK', periodType: 'weekly', sourceRunId: 41,
    sourcePortfolio: { positionRatio: 0.5 }, settingsRevision: 1, settingsWritable: true,
    settings: { industryFilters: { CN: [], HK: ['LEGACY', { code: 'OTHER', system: null, version: null }] }, excludedInstruments: [] } });
  await legacyRestore.window.StockSelectionPresenter.restoreExclusion('industry', { industry: { code: 'LEGACY', system: null, version: null } });
  assert.deepStrictEqual(Array.from(restoredLegacy.industryFilters.HK, item => item.code || item), ['OTHER']);
  console.log('[PASS] 历史字符串行业项可单独恢复且保留其他配置');

  let resolveA; let resolveB;
  const detail = createContext({
    getStock: (runId, code) => code === 'A' ? new Promise(resolve => { resolveA = resolve; }) : new Promise(resolve => { resolveB = resolve; }),
  });
  Object.assign(detail.ssState, { runId: 61, contextVersion: 1 });
  const detailA = detail.window.StockSelectionPresenter.openStock('A');
  const detailB = detail.window.StockSelectionPresenter.openStock('B');
  resolveB({ code: 'B' });
  await detailB;
  resolveA({ code: 'A' });
  await detailA;
  assert.strictEqual(detail.ssState.detail.code, 'B');
  console.log('[PASS] 快速查看多只股票时最后一次详情选择胜出');

  console.log('PASS=50 FAIL=0');
}

main().catch(error => { console.error(error); process.exit(1); });
