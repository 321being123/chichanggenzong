const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const servicePath = path.join(root, 'server/services/companyFinancialIncrementalSync.js');
const nativeRequire = require('module').createRequire(servicePath);
let targets = [{ instrument_id: 158867, company_id: 5388, list_date: '1996-11-01' }];
let cursors = new Map(), historyCursors = new Map(), requests = [], snapshots = [], failKind = null, slotCalls = [], eventCalls = [], eventsFail = false;
const stock = {
  normalizeStockCode: code => code === '600763' ? '600763.SH' : code,
  isOrdinaryAStock: code => /^60\d{4}\.SH$/.test(code),
  refreshStockAnalysis: async (...args) => snapshots.push(args),
  refreshEvents: async (...args) => { eventCalls.push(args); if (eventsFail) throw new Error('公告采集失败'); },
  refreshDividends: async () => {},
  ranges: nativeRequire('./stockAnalysis').ranges,
};
const context = { module: { exports: {} }, Date, console, process,
  require: name => name === '../db' ? { pool: { query: async () => ({ rows: targets }) } }
    : name === './stockAnalysis' ? stock
    : name === './jobScheduleSlots' ? { enqueueManualJob: async (...args) => { slotCalls.push(args); return { slot_id: 42 }; } }
    : nativeRequire(name),
  getCursors: dataset => dataset === 'financial_history' ? historyCursors : cursors,
  fetchReports: async (target, options) => { requests.push({ target, options }); return {}; },
  persistReports: async (target, result, options) => {
    if (target.needs[0] !== failKind && options.historyStart) historyCursors.set(`company:${target.companyId}:${target.needs[0]}`, { last_success_date: options.historyStart });
    return { ok: target.needs[0] !== failKind, failed: [{ kind: failKind, error: '采集失败' }] };
  },
};
vm.runInNewContext(fs.readFileSync(servicePath, 'utf8') + '\nreadFinancialCursors = async (targets, client, dataset) => getCursors(dataset); fetchCompanyReports = fetchReports; persistCompanyReports = persistReports;', context);
const service = context.module.exports;
(async () => {
  const queued = await service.enqueueStockAnalysisSync('600763');
  assert.strictEqual(queued.queued, true);
  assert.strictEqual(slotCalls[0][0], 'company_financial_incremental_sync');
  assert.strictEqual(slotCalls[0][1].targetCodes.join(), '600763.SH');
  await assert.rejects(service.enqueueStockAnalysisSync('110001.SH'), /普通股票/);
  const options = { mode: 'stock_analysis', targetCodes: ['600763.SH'], asOfDate: '2026-10-20' };
  const result = await service.syncRequestedStockAnalysis(options);
  assert.strictEqual(result.publishDatasets, false, '单股成功不能发布全市场分区');
  const { stageCompletionEvidence, getJobDefinition } = require('../services/jobDefinitions');
  assert(stageCompletionEvidence(getJobDefinition('company_financial_incremental_sync'), result, options), '单股完成证据须匹配原请求范围');
  assert.deepStrictEqual(await require('../services/datasetPartitionRegistry').publishJobDatasets(
    'company_financial_incremental_sync', '2026-10-20', result), [], '单股模式通过真实发布契约且不发布全市场分区');
  assert.strictEqual(requests.length, 4);
  assert.strictEqual(requests[0].options.startDate, '19961101', '首次采集从上市日开始');
  assert(requests[3].options.reportPeriods.includes('20001231'), '指标截断补漏需覆盖历史报告期');
  assert.strictEqual(snapshots[0][2].readOnly, true);
  assert.strictEqual(eventCalls[0][0], '600763.SH', '单股正常刷新必须采集公告');
  snapshots = []; eventsFail = true;
  await assert.rejects(service.syncRequestedStockAnalysis(options), /公告采集失败/);
  assert.strictEqual(snapshots.length, 0, '公告失败不发布新的完整分析快照');
  eventsFail = false;
  requests = []; snapshots = [];
  for (const kind of ['income', 'balance', 'cashflow', 'indicator']) cursors.set(`company:5388:${kind}`,
    { last_attempt_at: new Date('2026-10-20T02:00:00Z'), last_source_update: new Date('2026-08-20T00:00:00Z'), last_error: '' });
  await service.syncRequestedStockAnalysis(options);
  assert.strictEqual(requests.length, 0, '同日成功财报不重复调用上游');
  historyCursors.clear();
  await service.syncRequestedStockAnalysis(options);
  assert.strictEqual(requests.length, 4, '仅有近期成功游标不能跳过完整历史采集');
  assert.strictEqual(requests[0].options.historyFull, true);
  assert.strictEqual(requests[0].options.startDate, '19961101');
  requests = [];
  cursors.get('company:5388:income').last_error = '失败';
  await service.syncRequestedStockAnalysis(options);
  assert.strictEqual(requests.length, 1, '只重试失败的报表');
  assert.strictEqual(requests[0].options.startDate, '20260721', '增量保留30日更正窗口');
  snapshots = []; failKind = 'income';
  await assert.rejects(service.syncRequestedStockAnalysis(options), /采集失败/);
  assert.strictEqual(snapshots.length, 0, '财报失败不覆盖旧快照');
  await assert.rejects(service.syncRequestedStockAnalysis({ ...options, targetCodes: [] }), /指定一只/);
  targets = [];
  await assert.rejects(service.syncRequestedStockAnalysis(options), /档案缺失/);

  // 批次4：选择与请求序号已迁入 Presenter，提取对象随之改到 Presenter 文件。
  const frontend = fs.readFileSync(path.join(root, 'public/js/presenters/stock-analysis-presenter.js'), 'utf8');
  const messages = [];
  const ui = { stockAnalysisState: { selected: '600763.SH', loading: false }, username: 'test',
    document: { getElementById: () => null }, api: value => value,
    stockAnalysisSetMessage: message => messages.push(message), stockAnalysisRender() {},
    // 刷新按钮的禁用与文案由 View 负责，Presenter 只发指令。
    stockAnalysisSetRefreshButton() {},
    fetch: async () => ({ ok: true, status: 202, json: async () => ({ queued: { queued: true } }) }),
  };
  // 批次2c：站内 HTTP 已迁入 API 客户端，在同一上下文加载真实客户端后仅执行刷新函数
  ui.window = ui;
  // 批次4：统一请求底座 client.js 提供 window.siteApi，分析客户端依赖它，须先加载。
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/api/client.js'), 'utf8'), ui);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/api/stock-analysis-api.js'), 'utf8'), ui);
  vm.runInNewContext(frontend.slice(frontend.indexOf('async function stockAnalysisRefresh()'), frontend.indexOf('async function stockAnalysisAddWatchlist()')), ui);
  await ui.stockAnalysisRefresh();
  assert(messages.at(-1).includes('后台刷新队列'));
  ui.fetch = async () => ({ ok: true, status: 202, json: async () => ({ queued: { queued: false }, warning: '未能排队' }) });
  await ui.stockAnalysisRefresh();
  assert.strictEqual(messages.at(-1), '未能排队');
  // 验收缺口回归：A→B→A 快速切换时，第一次 A 的迟到响应不得覆盖第三次 A 的结果。
  // 只比对 tsCode 的写法会让 A-old 通过检查，所以这里必须构造"乱序返回"才能暴露问题。
  const selectSource = frontend.slice(
    frontend.indexOf('async function stockAnalysisSelect('),
    frontend.indexOf('async function stockAnalysisRefresh('),
  );
  const pendingSnapshots = [];
  const rendered = [];
  const raceUi = {
    stockAnalysisState: { selected: '', stocks: [], data: null, loading: false, selectToken: 0 },
    username: 'test',
    document: { getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }) },
    api: value => value,
    stockAnalysisApi: {
      getSnapshot: tsCode => new Promise(resolve => pendingSnapshots.push({ tsCode, resolve })),
    },
    stockAnalysisSwitchView() {},
    stockAnalysisSetMessage() {},
    // View 对 Presenter 暴露的入口：这里只记录是否被调用，DOM 细节由 View 自己的测试覆盖。
    stockAnalysisApplyRemoveVisibility() {},
    stockAnalysisShowContent() {},
    stockAnalysisRender: payload => rendered.push(payload),
    showToast() {},
  };
  vm.runInNewContext(selectSource, raceUi);
  const firstA = raceUi.stockAnalysisSelect('AAA');
  const askB = raceUi.stockAnalysisSelect('BBB');
  const secondA = raceUi.stockAnalysisSelect('AAA');
  assert.strictEqual(pendingSnapshots.length, 3, '每次选择都应真正发出一次请求');
  // 乱序：先返回第三次 A（新），再返回第一次 A（旧）与 B
  pendingSnapshots[2].resolve({ ok: true, status: 200, payload: { tag: 'A-new' } });
  await secondA;
  pendingSnapshots[0].resolve({ ok: true, status: 200, payload: { tag: 'A-old' } });
  await firstA;
  pendingSnapshots[1].resolve({ ok: true, status: 200, payload: { tag: 'B' } });
  await askB;
  assert.deepStrictEqual(rendered.map(item => item.tag), ['A-new'],
    'A→B→A 时只允许渲染最后一次 A 的结果，旧 A 与 B 都必须被丢弃');

  console.log('stock analysis refresh queue tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
