// 选股输入补齐的任务归属边界（2026-11-05 静态核查后的行为回归）。
// 两个任务都有同名 selection_inputs 模式：个股分析刷新只审计缺口、不联网；
// 公司财务增量同步才是唯一会外采的补数入口。本文件锁住这条边界，避免再被写反。
'use strict';
// 本文件会替换 ../db，config.js 加载时需要会话密钥；给测试用值，避免它去 DATA_DIR 写文件。
process.env.SECRET = process.env.SECRET || 'stock-selection-inputs-ownership-test';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const definitions = require('../services/jobDefinitions');
const tests = [];

async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    const detail = String(error && (error.stack || error.message || error)).split('\n').slice(0, 3).join(' | ');
    tests.push(['FAIL', name + ' :: ' + detail]); console.log('  [FAIL] ' + name + ' :: ' + detail);
  }
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

async function main() {
  await check('个股分析刷新：selection_inputs 上限保持 0，Runner 取值仍为 0', () => {
    const def = definitions.getJobDefinition('stock_analysis_refresh');
    assert.strictEqual(def.modeExternalCallLimits.selection_inputs, 0);
    assert.strictEqual(definitions.externalCallLimitForMode(def, 'selection_inputs'), 0,
      '0 必须真的送到外呼保护器，不能被当成未设置而回退');
    assert.strictEqual(def.maxExternalCallsPerRun, 0);
    assert.deepStrictEqual(def.externalApis, []);
    assert.strictEqual(def.mayConsumeQuota, false);
  });

  await check('财务增量同步：selection_inputs 上限为 null，不被误转成 0', () => {
    const def = definitions.getJobDefinition('company_financial_incremental_sync');
    assert.strictEqual(def.maxExternalCallsPerRun, null);
    assert.strictEqual(definitions.externalCallLimitForMode(def, 'selection_inputs'), null,
      '未知额度保持空值，不编造单批上限');
    assert.strictEqual(def.mayConsumeQuota, true);
  });

  await check('Runner：有上限时启用外呼保护，null 时清除上限', () => {
    const source = read('server/services/jobRunnerProcess.js');
    assert.match(source, /externalCallLimitForMode\(definition, mode\)/);
    assert.match(source, /if \(externalCallLimit === null\)/);
    assert.match(source, /delete process\.env\.JOB_EXTERNAL_CALL_LIMIT_ACTIVE/);
    assert.match(source, /process\.env\.JOB_EXTERNAL_CALL_LIMIT = String\(externalCallLimit\)/);
  });

  await check('财务任务接口清单：官方端点按目录登记 key，备源按既有接口名登记', () => {
    const def = definitions.getJobDefinition('company_financial_incremental_sync');
    const catalog = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'server/dataAccess/catalog/lixingerEndpoints.json'), 'utf8'));
    const registered = new Set((catalog.endpoints || []).map(item => item.key));
    const official = def.externalApis.filter(name => name.includes('/'));
    assert.ok(official.length >= 8, '官方接口不能只登记一个来源名');
    official.forEach(name => assert.ok(registered.has(name), name + ' 未在理杏仁接口目录登记'));
    ['dividend', 'index_member_all', 'tencent_hk_daily'].forEach(name =>
      assert.ok(def.externalApis.includes(name), '缺少备源接口 ' + name));
    assert.ok(!def.externalApis.includes('lixinger_official'), '来源代码不是接口名，不能混进接口清单');
  });

  await check('财务任务：来源与手动模式说明已反映选股补数', () => {
    const def = definitions.getJobDefinition('company_financial_incremental_sync');
    assert.ok(def.externalSources.includes('lixinger_official'));
    assert.ok(def.externalSources.includes('tencent'));
    assert.match(def.manualTargetScope, /selection_inputs/);
    assert.match(def.sourceDescription, /Tushare/);
  });

  await check('接线：个股分析不含采集入口，补数模式与路由都指向财务任务', () => {
    const refresh = read('server/jobs/stockAnalysisRefresh.js');
    assert.ok(!/syncSelectionInputs|readFinancialReportRows|readDividendRows/.test(refresh),
      '个股分析任务不得自行补数');
    assert.match(refresh, /service\.auditInputs/);
    assert.match(read('server/services/companyFinancialIncrementalSync.js'), /syncSelectionInputs\(\{/);
    assert.match(read('server/routes/stockSelection.js'), /enqueueManualJob\('company_financial_incremental_sync'/);
  });

  await check('行为：个股分析的审计模式不触发补数采集入口', async () => {
    const calls = { audit: 0, publish: 0, collect: 0 };
    stub('../services/stockSelectionService', {
      auditInputs: async () => {
        calls.audit += 1;
        return { gapCount: 0, gaps: [], coverage: { universeCount: 10, withValuation: 10 }, domainCounts: {} };
      },
      quarterEndDate: () => '2026-09-30',
      pendingQuarter: async () => ({ quarter: '2026Q3' }),
      runQuarterly: async () => ({ ok: true }),
    });
    stub('../services/datasetPartitionRegistry', {
      publishDatasetSnapshot: async () => { calls.publish += 1; return { published: true }; },
    });
    stub('../services/stockSelectionInputsSync', {
      syncSelectionInputs: async () => { calls.collect += 1; throw new Error('审计模式不得进入补数采集入口'); },
    });
    stub('../db', {
      pool: { query: async () => ({ rows: [] }) },
      tryClaimJob: async () => true, releaseJob: async () => {},
      startJobRun: async () => 1, finishJobRun: async () => {},
    });
    const refresh = require('../jobs/stockAnalysisRefresh');
    const result = await refresh.runSelectionMode('selection_inputs', 'test',
      { market: 'CN', targetDate: '2026-11-04' });
    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(calls.audit, 1);
    assert.strictEqual(calls.publish, 1);
    assert.strictEqual(calls.collect, 0, '审计模式不得调用补数采集入口');
  });

  await check('行为：财务补数模式进入既有采集入口，失败剩余时保持续跑', async () => {
    const calls = [];
    stub('../services/stockSelectionInputsSync', {
      syncSelectionInputs: async input => {
        calls.push(input);
        return {
          ok: false, status: 'partial', processed: 2, succeeded: 1,
          remainingFinancial: 1, remainingIndustry: 0, remainingValuation: 0, remainingUnclassified: 0,
        };
      },
    });
    const financial = require('../services/companyFinancialIncrementalSync');
    const result = await financial.runCompanyFinancialIncrementalSync('test', {
      mode: 'selection_inputs', market: 'CN', targetTradeDate: '2026-11-04', batchLimit: 5,
    });
    assert.strictEqual(calls.length, 1, '补数必须走既有采集入口');
    assert.strictEqual(calls[0].market, 'CN');
    assert.strictEqual(calls[0].asOfDate, '2026-11-04');
    assert.strictEqual(calls[0].batchLimit, 5);
    assert.strictEqual(result.remaining, 1, '剩余量必须按全域口径合计');
    assert.strictEqual(result.continuationRequired, true, '有剩余必须续跑');
    assert.strictEqual(result.stageComplete, false);
    assert.strictEqual(result.status, 'partial');
  });

  await check('官方空结果：三条备源仍在，调用统计与失败续跑不被绕过', () => {
    const datasets = read('server/dataAccess/marketDatasets.js');
    assert.match(datasets, /tushareQuery\('dividend'/, '分红官方空结果必须回退 Tushare');
    assert.match(datasets, /tushareQuery\('index_member_all'/, 'A股行业官方空结果必须回退 Tushare');
    assert.match(datasets, /requestTencentHkKline/, '港股日线官方空结果必须回退腾讯');
    const sync = read('server/services/stockSelectionInputsSync.js');
    assert.match(sync, /source_returned_empty/, '官方空结果不得当成已补齐');
    assert.match(sync, /failedCodes|deferredCodes/, '失败与无进展对象必须留下轮转证据');
    const financial = read('server/services/companyFinancialIncrementalSync.js');
    assert.match(financial, /finishJobRun\(runId, cleared/);
    assert.match(financial, /continuationRequired: !cleared/, '未清空剩余不得宣告阶段完成');
  });
}

main().then(() => {
  const failed = tests.filter(item => item[0] === 'FAIL');
  console.log('\n[stock-selection-inputs-ownership] ' + (tests.length - failed.length) + '/' + tests.length + ' passed');
  if (failed.length) process.exit(1);
}).catch(error => { console.error(error); process.exit(1); });
