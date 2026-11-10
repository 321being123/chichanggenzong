// 港股证券分析任务模式、市场分区隔离与失败续跑回归（方案 14.5 / 14.6.1）。
// 纯静态与纯函数断言，不连库、不联网、不启服务；真实运行与生产覆盖另按 14.6.2 核验。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');

const jobDefinitions = require('../services/jobDefinitions');
const registry = require('../services/datasetPartitionRegistry');
const refresh = require('../services/hkSingleStockRefresh');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

console.log('--- 港股证券分析任务与分区回归 ---');

const definition = jobDefinitions.JOB_DEFINITIONS.find(item => item.jobCode === 'stock_analysis_refresh');
const contract = jobDefinitions.JOB_CONTRACTS.stock_analysis_refresh;

test('HK 定向模式登记在原 Runner 的模式白名单，外采严格为 0', () => {
  assert.ok(definition.additionalSchedules.some(s => s.mode === 'stock_analysis_hk'));
  assert.strictEqual(definition.modeExternalCallLimits.stock_analysis_hk, 0);
  assert.strictEqual(contract.maxExternalCallsPerRun, 0);
  assert.deepStrictEqual(definition.modeDependencyCodes.stock_analysis_hk, []);
  assert.deepStrictEqual(definition.modeDatasetDependencies.stock_analysis_hk, []);
  assert.ok(contract.datasetPublicationByMode.stock_analysis_hk);
  assert.deepStrictEqual(contract.datasetPublicationByMode.stock_analysis_hk.publish, []);
});

test('HK 开市而 CN 休市仍可运行：HK 槽按港交所日历，不继承 A 股依赖', () => {
  const hkSlot = definition.additionalSchedules.find(s => s.mode === 'stock_analysis_hk');
  assert.strictEqual(hkSlot.marketCalendarPolicy, 'hk-open');
  assert.strictEqual(hkSlot.afterTradingDay, false);
  assert.strictEqual(hkSlot.weekdays, false);
  assert.notStrictEqual(hkSlot.dataDatePolicy, 'previous_trading_day');
  assert.deepStrictEqual(definition.modeDependencyCodes.stock_analysis_hk, []);
  const runner = read('server/jobs/stockAnalysisRefresh.js');
  assert.ok(/getMarketState\(\{ market: 'HK'/.test(runner), 'Runner 必须实际读取 HK 日历');
  assert.ok(/日历缺失或冲突/.test(runner), '日历缺失必须阻塞并说明，不能按周一至五猜开市');
});

test('目标集是持仓与显式自选按证券去重，不以港股通/恒生成分作准入', () => {
  const sql = read('server/repositories/hkSecurityAnalysisRepository.js');
  assert.ok(/listTrackedHkCodes/.test(sql));
  assert.ok(/stock_watchlist/.test(sql) && /positions/.test(sql));
  assert.ok(/SELECT DISTINCT i\.canonical_code/.test(sql));
  assert.ok(!/hsi|constituents|港股通/i.test(sql.split('listTrackedHkCodes')[1] || ''), '目标集不得绑定成分股/港股通');
});

test('四个核心数据集旧调用默认 CN，HK 必须显式传市场且不得退回 CN', () => {
  for (const code of registry.MARKET_SCOPED_DATASETS) {
    assert.strictEqual(registry.resolveDatasetScope(code, {}), 'CN');
    assert.strictEqual(registry.resolveDatasetScope(code, { market: 'HK' }), 'HK');
    assert.strictEqual(registry.resolveDatasetScope(code, { market: 'hk' }), 'HK');
  }
  assert.strictEqual(registry.resolveDatasetScope('stock_daily', { market: 'US' }), 'CN');
  assert.strictEqual(registry.marketPredicateFor('stock_daily', 'CN'), '');
  assert.ok(registry.marketPredicateFor('stock_daily', 'HK').includes("market='HK'"));
  assert.ok(registry.marketPredicateFor('stock_financial_reports', 'HK').includes('company_instruments'));
  assert.strictEqual(registry.marketPredicateFor('other', 'HK'), '');
});

test('分区统计只在显式 HK 时按市场过滤，A 股统计口径不变', () => {
  const source = read('server/services/datasetPartitionRegistry.js');
  assert.ok(/const marketWhere = marketPredicateFor\(datasetCode, String\(options\.market/.test(source));
  assert.ok(/whereParts\[0\] \? `AND \$\{marketWhere\}` : `WHERE \$\{marketWhere\}`/.test(source));
});

test('单股刷新逐域覆盖判定与失败续跑：成功域跳过，失败域留下次', () => {
  assert.strictEqual(refresh.coverageOf('master', { master: true }), true);
  assert.strictEqual(refresh.coverageOf('bars', { bars: 0 }), false);
  assert.strictEqual(refresh.coverageOf('reports', { reports: 0 }), false);
  assert.strictEqual(refresh.coverageOf('reports', { reports: 3 }), true);
  assert.strictEqual(refresh.cursorSucceeded({ last_error: null, last_success_date: '2026-11-10' }, '2026-11-10'), true);
  assert.strictEqual(refresh.cursorSucceeded({ last_error: '失败', last_success_date: '2026-11-10' }, '2026-11-10'), false);
  assert.strictEqual(refresh.cursorSucceeded({ last_success_date: '2026-11-09' }, '2026-11-10'), false);
  const source = read('server/services/hkSingleStockRefresh.js');
  assert.ok(/markDatasetSuccess\(scope, domain/.test(source), '成功域必须持久化水位');
  assert.ok(/publishDatasetCodes: \[\]/.test(source), '单股不得发布整个市场分区');
  assert.ok(/retained_previous/.test(source), '失败必须保留上次完整快照');
});

test('刷新进度只按本人账号投影，不开放任意任务详情', () => {
  const repo = read('server/repositories/hkSecurityAnalysisRepository.js');
  assert.ok(/request_payload->>'requestedBy'=\$2/.test(repo));
  assert.ok(/request_payload->>'mode'='stock_analysis'/.test(repo));
  const route = read('server/routes/stockAnalysis.js');
  assert.ok(/router\.get\('\/refresh\/:slotId', requireLogin/.test(route));
  assert.ok(/req\.session\.user/.test(route));
  assert.ok(!/last_error|stack|request_payload\b/.test(route), '公开响应不得带内部错误栈或原始载荷');
});

test('港股详情只读已发布快照，公开响应裁剪运维字段', () => {
  const route = read('server/routes/stockAnalysis.js');
  assert.ok(/publicSnapshotOf\(snapshot\)/.test(route));
  assert.ok(/HK_ANALYSIS_NOT_READY/.test(route));
  const service = read('server/services/hkSecurityAnalysis.js');
  assert.ok(/const PUBLIC_FIELDS = \[/.test(service));
  assert.ok(!/PUBLIC_FIELDS[\s\S]{0,400}diagnostics/.test(service), '白名单不得含 diagnostics');
  assert.ok(!/PUBLIC_FIELDS[\s\S]{0,400}needs_refresh/.test(service), '白名单不得含 needs_refresh');
});

test('三表按版本只读，409 后最多有界重读一次', () => {
  const statements = read('server/services/hkStockStatements.js');
  assert.ok(/versionConflict\(requestedVersion, version\)/.test(statements));
  assert.ok(/error\.status = 409/.test(statements));
  assert.ok(/listHkStatementRows\(tsCode, type, table, columns, limit\)/.test(statements), 'SQL 必须留在仓储层');
  assert.ok(/is_current_version=true/.test(read('server/repositories/hkSecurityAnalysisRepository.js')));
  const presenter = read('public/js/presenters/stock-analysis-statements-presenter.js');
  assert.ok(/response\.status === 409/.test(presenter));
  assert.ok(/分析数据更新中/.test(presenter));
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
