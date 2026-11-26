'use strict';

// INC-0054 第一阶段第 2 条：补采缺口从「缺证券」细化到「报告期、财报种类、必需字段」。
// 原来队列只知道"这只股票缺财报"，补采一律 12 年 × 四类全量重拉，真正的缺口被整批历史数据淹没。
// 这里验证两段纯函数：缺口审计时怎么定计划、补采时怎么按计划收窄取数范围。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { collectionPlanOf } = require('../services/stockSelectionService');
const { collectionWindowOf, collectOne, REPORT_KINDS, HISTORY_YEARS } = require('../services/stockSelectionInputsSync');
const { historyCollectionSuspended } = require('../services/diskGuard');
const { runCompanyFinancialBackfill } = require('../services/companyFinancialIncrementalSync');

function run() {
  // --- 1) 缺口审计：按规则原因与年度异常推出真正需要补的种类/报告期 ---
  const equityPlan = collectionPlanOf({
    domains: ['financial_reports'],
    reasons: ['R05:equity_unavailable'],
    rules: { R05: { status: 'PENDING', reason: 'equity_unavailable' } },
    anomaly: null,
  });
  assert.deepStrictEqual(equityPlan.report_kinds, ['balance'], '净资产缺口只需要资产负债表');
  assert.deepStrictEqual(equityPlan.required_fields, ['total_hldr_eqy_exc_min_int'], '必须写明缺哪个字段');

  const profitPlan = collectionPlanOf({
    domains: ['financial_reports'],
    reasons: ['RANK:profit_status_unknown'],
    rules: {},
    anomaly: null,
  });
  assert.deepStrictEqual(profitPlan.report_kinds, ['income', 'indicator'], '利润口径未知要补利润表与指标表');

  const annualPlan = collectionPlanOf({
    domains: ['financial_reports', 'dividends'],
    reasons: ['annual_anomaly:annual_missing'],
    rules: {},
    anomaly: { missingYears: [2020, 2019, 'bad'], dividendUnknownYears: [2021] },
  });
  assert.deepStrictEqual(annualPlan.report_periods, ['2019', '2020'], '缺口年份必须冻结成报告期清单');
  assert.deepStrictEqual(annualPlan.report_kinds, [], '原因推不出种类时不得瞎猜，交给补采端保守回退');

  // 混合原因：只要有一个财报原因映射不到具体报表，就整体回退四类，不得只补能识别的那一张表
  const mixedPlan = collectionPlanOf({
    domains: ['financial_reports'],
    reasons: ['R05:equity_unavailable', 'annual_anomaly:annual_missing'],
    rules: { R05: { status: 'PENDING', reason: 'equity_unavailable' } },
    anomaly: { missingYears: [2021] },
  });
  assert.deepStrictEqual(mixedPlan.report_kinds, [],
    '混合原因时 report_kinds 必须为空，让补采端保守回退四类（否则只补 balance，其余三表永远漏补）');
  assert.deepStrictEqual(mixedPlan.report_periods, ['2021'], '混合原因仍要保留能确定的缺口年份');

  // 非财报域原因不得把财报收窄判成"未映射"而误触发全量回退
  const mixedDomainPlan = collectionPlanOf({
    domains: ['financial_reports', 'industry'],
    reasons: ['R05:equity_unavailable', 'industry_unverified'],
    rules: { R05: { status: 'PENDING', reason: 'equity_unavailable' } },
  });
  assert.deepStrictEqual(mixedDomainPlan.report_kinds, ['balance'],
    '行业/估值原因不参与"补哪几张表"的判断');

  // 没有财报缺口时不产出计划（只缺行业/估值）
  assert.deepStrictEqual(collectionPlanOf({ domains: ['industry'], reasons: ['industry_unverified'] }), {});

  // --- 2) 补采：按计划收窄取数范围，推不出来就保守回退 ---
  const asOf = '2026-11-04';
  const fallback = collectionWindowOf({ domains: ['financial_reports'], reasons: [] }, asOf);
  assert.deepStrictEqual(fallback.kinds, REPORT_KINDS, '没有计划时必须退回四类全量，不能少补');
  assert.strictEqual(fallback.startDate.length, 10, '回退窗口必须是 12 年区间的起点');
  assert.strictEqual(fallback.narrowed, false);

  const equityWindow = collectionWindowOf({
    domains: ['financial_reports'],
    collection_plan: { report_kinds: ['balance'], report_periods: [] },
  }, asOf);
  assert.deepStrictEqual(equityWindow.kinds, ['balance'], '有明确计划时只补需要的表');
  assert.strictEqual(equityWindow.narrowed, true);

  const yearWindow = collectionWindowOf({
    domains: ['financial_reports'],
    collection_plan: { report_kinds: ['balance'], report_periods: ['2020', '2021'] },
  }, asOf);
  assert.strictEqual(yearWindow.startDate, '2020-01-01', '缺口年份明确时只从最早缺口年份取数');

  // 缺口年份比 12 年窗口更早：仍以窗口起点为准，不能因为缺口把该覆盖的历史丢掉
  const tooOld = collectionWindowOf({
    domains: ['financial_reports'],
    collection_plan: { report_kinds: ['balance'], report_periods: ['1998'] },
  }, asOf);
  const expectedStart = `${Number(asOf.slice(0, 4)) - HISTORY_YEARS}-${asOf.slice(5, 10)}`;
  assert.strictEqual(tooOld.startDate, expectedStart, '缺口年份早于窗口时取窗口起点');

  // 只缺分红：不再拉财报（方案：只缺分红就单独补分红）
  const dividendOnly = collectionWindowOf({ domains: ['dividends'], reasons: ['R04:PENDING'] }, asOf);
  assert.deepStrictEqual(dividendOnly.kinds, [], '只缺分红时不得再拉一遍财报');
  assert.strictEqual(dividendOnly.onlyDividends, true);
  assert.strictEqual(dividendOnly.needDividends, true, '只缺分红时必须拉分红');

  // 只缺财报：不得顺带拉分红（原先无条件拉，白耗一次外部请求）
  const financialOnly = collectionWindowOf({
    domains: ['financial_reports'],
    collection_plan: { report_kinds: [], report_periods: ['2020'] },
  }, asOf);
  assert.strictEqual(financialOnly.needDividends, false, 'domains 不含 dividends 时不得拉分红');

  // 分红窗口不得被财报缺口年份收窄：否则港股 dividends 游标会被写成 2020-01-01，更早历史永不再补
  assert.strictEqual(financialOnly.startDate, '2020-01-01', '财报按缺口年份收窄');
  assert.strictEqual(financialOnly.dividendStartDate, fallback.startDate,
    '分红起点必须保持 12 年窗口，不受财报缺口年份影响');
  // 没有 domains 信息时保守照拉分红
  assert.strictEqual(collectionWindowOf({ reasons: [] }, asOf).needDividends, true,
    'domains 缺失时无法判断缺口，分红必须保守照拉');

  // --- 3) 根盘余量停止线：低于阈值必须暂停历史补采 ---
  const giB = n => n * 1024 ** 3;
  const small = historyCollectionSuspended({ freeBytes: giB(5), totalBytes: giB(100) });
  assert.strictEqual(small.suspended, true, '可用 5 GiB 必须暂停（低于 8 GiB 与 15% 两条线）');
  assert.strictEqual(small.minFreeBytes, giB(15), '停止线取 8 GiB 与总量 15% 的较大值');
  assert.strictEqual(historyCollectionSuspended({ freeBytes: giB(20), totalBytes: giB(100) }).suspended, false,
    '可用 20 GiB 高于停止线时不得误停');
  assert.strictEqual(historyCollectionSuspended({ freeBytes: giB(20), totalBytes: giB(200) }).suspended, true,
    '大盘按比例算：200 GiB 的 15% = 30 GiB，可用 20 GiB 必须暂停');
  assert.strictEqual(historyCollectionSuspended({ freeBytes: giB(10), totalBytes: giB(40) }).suspended, false,
    '小盘按绝对值兜底：40 GiB 的 15% 只有 6 GiB，8 GiB 才是不越过的底线');
  const overridden = historyCollectionSuspended({ freeBytes: giB(9), totalBytes: giB(100) }, {
    env: { HISTORY_COLLECTION_MIN_FREE_BYTES: String(giB(10)), HISTORY_COLLECTION_TOTAL_RATIO: '0.01' },
  });
  assert.strictEqual(overridden.suspended, true, '阈值必须可通过环境变量覆盖（演练与临时放行都用它）');

  console.log('补采缺口细化（报告期/财报种类/必需字段）与根盘停止线验证通过');
}

// --- 4) collectOne 的实际取数行为（注入数据层替身，不连库、不联网）---
// 只缺分红时不应再查港股公司档案；只缺财报时不应拉分红；分红起点不得被财报缺口年份收窄。
async function verifyCollectOne() {
  const asOf = '2026-11-04';
  const fallbackStart = collectionWindowOf({ reasons: [] }, asOf).startDate;
  const metaByCode = {
    '00700.HK': { ts_code: '00700.HK', name: '测试港股', market: 'HK', list_date: '2004-06-16', raw_data: {} },
    '600519.SH': { ts_code: '600519.SH', name: '测试A股', market: 'CN', list_date: '2001-08-27', raw_data: {} },
  };
  const makeDeps = () => {
    const calls = { profiles: 0, financial: [], dividends: [], persisted: [] };
    const datasets = {
      readCompanyProfiles: async () => { calls.profiles += 1; return [{ code: '00700.HK', fsTableType: 'non_financial' }]; },
      readFinancialReportRows: async params => {
        calls.financial.push(params);
        return { balance: [{ ts_code: params.tsCode, end_date: '20231231', ann_date: '20240301', report_type: '1', total_assets: 1 }] };
      },
      readDividendRowsWithCoverage: async params => {
        calls.dividends.push(params);
        return { rows: [{ ts_code: params.tsCode, end_date: '20231231', ann_date: '20240301', div_proc: '实施', source_code: 'lixinger_official' }], coverage: null };
      },
      readDividendRows: async () => [],
    };
    const persist = async (metadata, bundle) => { calls.persisted.push({ metadata, bundle }); };
    const readMeta = async code => metaByCode[code] || null;
    return { calls, deps: { datasets, persist, readMeta } };
  };

  // 只缺分红（港股）：不查档案、不拉财报，分红按 12 年窗口起点
  {
    const { calls, deps } = makeDeps();
    const result = await collectOne({ code: '00700.HK', domains: ['dividends'], reasons: ['R04:PENDING'] }, asOf, null, deps);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.profiles, 0, 'window.kinds 为空时不得调用 readCompanyProfiles');
    assert.strictEqual(calls.financial.length, 0, '只缺分红时不得拉财报');
    assert.strictEqual(calls.dividends.length, 1, '只缺分红时必须拉分红');
    assert.strictEqual(calls.dividends[0].startDate, fallbackStart, '分红必须按完整窗口取数');
    assert.deepStrictEqual(result.collection.kinds, [], '回执必须如实记录本次未取财报');
    assert.strictEqual(result.collection.dividendStartDate, fallbackStart);
    assert.ok(calls.persisted[0].bundle.dividends, '分红必须落到标准层');
    assert.strictEqual(calls.persisted[0].bundle.income, undefined, '本次没有财报时不得写空财报数据集');
  }

  // 只缺财报（港股，缺口年份 2020）：查一次档案、按缺口年份取财报、不拉分红
  {
    const { calls, deps } = makeDeps();
    const result = await collectOne({
      code: '00700.HK', domains: ['financial_reports'], reasons: ['R05:equity_unavailable'],
      collection_plan: { report_kinds: ['balance'], report_periods: ['2020'] },
    }, asOf, null, deps);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.profiles, 1, '港股要补财报时必须先确认财报类型');
    assert.strictEqual(calls.financial.length, 1);
    assert.strictEqual(calls.financial[0].startDate, '2020-01-01', '财报按缺口年份收窄');
    assert.strictEqual(calls.financial[0].fsTableType, 'non_financial', '财报端点类型来自公司档案');
    assert.strictEqual(calls.dividends.length, 0, 'domains 不含 dividends 时不得拉分红');
    assert.strictEqual(result.collection.needDividends, false);
    assert.strictEqual(result.collection.dividendStartDate, fallbackStart,
      '分红起点不能被财报缺口年份污染');
  }

  // 只缺财报（A 股）：不查公司档案（档案查询只服务港股财报端点分流）
  {
    const { calls, deps } = makeDeps();
    await collectOne({ code: '600519.SH', domains: ['financial_reports'], reasons: ['R05:equity_unavailable'] }, asOf, null, deps);
    assert.strictEqual(calls.profiles, 0, 'A 股补财报不得白查港股公司档案');
    assert.strictEqual(calls.financial.length, 1);
  }

  console.log('collectOne 取数窗口与请求裁剪验证通过');
}

// --- 5) F-08：同类历史补采入口必须共用根盘余量止损 ---
// 事故第一阶段只把停止线接在选股补采的缺口批次上，批量历史补采、单股全历史刷新和
// 港股目标池行情仍会先跑一批再暂停。这里用注入余量跑批量历史补采，并用源码顺序断言
// 其余入口的检查点位置，避免「低空间仍先写一批」再次出现。
async function verifyHistoryCollectionDiskGuards() {
  const giB = n => n * 1024 ** 3;
  const lowDisk = { freeBytes: giB(5), totalBytes: giB(100) };
  const financialRepository = require('../repositories/companyFinancialRepository');
  const originalList = financialRepository.listBondUnderlyingRows;
  let repositoryReads = 0;
  financialRepository.listBondUnderlyingRows = async () => {
    repositoryReads += 1;
    throw new Error('低空间下不得读取补采目标或发起外部采集');
  };
  let blocked;
  try {
    blocked = await runCompanyFinancialBackfill({ disk: lowDisk });
  } finally {
    financialRepository.listBondUnderlyingRows = originalList;
  }
  assert.strictEqual(repositoryReads, 0, 'F-08: 低空间时批量历史补采不得读取目标（更不得发起外部请求或写库）');
  assert.strictEqual(blocked.ok, false, 'F-08: 低空间时不得宣告补采成功');
  assert.strictEqual(blocked.status, 'blocked', 'F-08: 低空间时批量历史补采必须 blocked');
  assert.strictEqual(blocked.reason, 'root_disk_low', 'F-08: 暂停原因必须是 root_disk_low');
  assert.strictEqual(blocked.historySuspended, true, 'F-08: 必须把 historySuspended 回传给任务层');
  assert.strictEqual(blocked.processed, 0, 'F-08: 暂停时处理数必须为 0');
  assert.deepStrictEqual(blocked.results, [], 'F-08: 暂停时不得产生任何补采结果');
  assert.strictEqual(blocked.disk.suspended, true, 'F-08: 必须附带判定证据');

  const inputsSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'stockSelectionInputsSync.js'), 'utf8');
  const spaceIndex = inputsSrc.indexOf('const space = await checkHistoryCollectionSpace();');
  const hkBarsIndex = inputsSrc.indexOf('await syncHkTargetPoolBars({ asOfDate, maxCodes: limit })');
  assert.ok(spaceIndex >= 0, 'F-08: 选股补采必须检查根盘余量');
  assert.ok(hkBarsIndex >= 0, 'F-08: 港股目标池补采入口必须存在（顺序断言基准）');
  assert.ok(spaceIndex < hkBarsIndex,
    'F-08: 根盘检查必须在 syncHkTargetPoolBars 之前，否则低空间仍会先写一批港股历史行情');
  assert.ok(/if \(market === 'HK' && !historySuspended\)/.test(inputsSrc),
    'F-08: historySuspended 必须阻断港股目标池补采');

  const companySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'companyFinancialIncrementalSync.js'), 'utf8');
  assert.ok(companySrc.includes("error.code = 'ROOT_DISK_LOW'"),
    'F-08: 单股全历史刷新必须用受控错误阻止补采');
  assert.ok(/if \(historyFull\) \{[\s\S]*?checkHistoryCollectionSpace/.test(companySrc),
    'F-08: 单股刷新只在 historyFull 时检查根盘（普通增量不得被阻断）');
  assert.ok(/const space = await checkHistoryCollectionSpace\(\{ disk: options\.disk \}\);\s*\n\s*if \(space\.suspended === true\)/.test(companySrc),
    'F-08: 批量历史补采必须在执行前按可注入余量判定并立即返回');

  console.log('历史补采根盘余量止损（批量补采/港股目标池/单股全历史）验证通过');
}

async function Run() {
  run();
  await verifyCollectOne();
  await verifyHistoryCollectionDiskGuards();
}

Run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
