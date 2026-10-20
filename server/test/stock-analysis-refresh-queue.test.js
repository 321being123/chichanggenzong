const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const servicePath = path.join(root, 'server/services/companyFinancialIncrementalSync.js');
const nativeRequire = require('module').createRequire(servicePath);
let targets = [{ instrument_id: 158867, company_id: 5388, list_date: '1996-11-01' }];
let cursors = new Map(), requests = [], snapshots = [], failKind = null, slotCalls = [];
const stock = {
  normalizeStockCode: code => code === '600763' ? '600763.SH' : code,
  isOrdinaryAStock: code => /^60\d{4}\.SH$/.test(code),
  refreshStockAnalysis: async (...args) => snapshots.push(args),
};
const context = { module: { exports: {} }, Date, console, process,
  require: name => name === '../db' ? { pool: { query: async () => ({ rows: targets }) } }
    : name === './stockAnalysis' ? stock
    : name === './jobScheduleSlots' ? { enqueueManualJob: async (...args) => { slotCalls.push(args); return { slot_id: 42 }; } }
    : nativeRequire(name),
  getCursors: () => cursors,
  fetchReports: async (target, options) => { requests.push({ target, options }); return {}; },
  persistReports: async target => ({ ok: target.needs[0] !== failKind, failed: [{ kind: failKind, error: '采集失败' }] }),
};
vm.runInNewContext(fs.readFileSync(servicePath, 'utf8') + '\nreadFinancialCursors = async () => getCursors(); fetchCompanyReports = fetchReports; persistCompanyReports = persistReports;', context);
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
  requests = []; snapshots = [];
  for (const kind of ['income', 'balance', 'cashflow', 'indicator']) cursors.set(`company:5388:${kind}`,
    { last_attempt_at: new Date('2026-10-20T02:00:00Z'), last_source_update: new Date('2026-08-20T00:00:00Z'), last_error: '' });
  await service.syncRequestedStockAnalysis(options);
  assert.strictEqual(requests.length, 0, '同日成功财报不重复调用上游');
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

  const frontend = fs.readFileSync(path.join(root, 'public/js/stock-analysis.js'), 'utf8');
  const messages = [];
  const ui = { stockAnalysisState: { selected: '600763.SH', loading: false }, username: 'test',
    document: { getElementById: () => null }, api: value => value,
    stockAnalysisSetMessage: message => messages.push(message), stockAnalysisRender() {},
    fetch: async () => ({ ok: true, status: 202, json: async () => ({ queued: { queued: true } }) }),
  };
  vm.runInNewContext(frontend.slice(frontend.indexOf('async function stockAnalysisRefresh()'), frontend.indexOf('async function stockAnalysisAddWatchlist()')), ui);
  await ui.stockAnalysisRefresh();
  assert(messages.at(-1).includes('后台刷新队列'));
  ui.fetch = async () => ({ ok: true, status: 202, json: async () => ({ queued: { queued: false }, warning: '未能排队' }) });
  await ui.stockAnalysisRefresh();
  assert.strictEqual(messages.at(-1), '未能排队');
  console.log('stock analysis refresh queue tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
