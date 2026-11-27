// 股票筛选优化第一批 B1-1 回归：缺口队列增量化与续批定点复核。
//
// 锁定四件事：
// 1. 四维身份（market/asOfDate/strategyCode/inputVersion）任一变化 → 批前全市场审计；
//    同身份续批批前与批后都 0 次全市场 auditInputs，只对本批对象做定点复核；
// 2. attempts / failedCodes / deferredCodes 的跨批轮转语义不变；
// 3. 剩余量归零前强制全市场终审；终审新发现缺口必须回写队列并保持 partial；
//    但批前刚全审且本批 0 标的时不得重复终审（0 缺口稳态只允许一次全市场审计）；
// 4. 港股目标池未补到行情时不得提前宣告完成（auditHkTargetPoolAfterBatch 守护）。
'use strict';
const assert = require('assert');
const path = require('path');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function industryGap(code, name = code) {
  return { code, name, companyId: 100, filterStatus: 'PENDING', domains: ['industry'], reasons: ['industry_unverified'] };
}

function financialGap(code, name = code) {
  return { code, name, companyId: 101, filterStatus: 'PENDING', domains: ['financial_reports'], reasons: ['R01:PENDING'] };
}

// collectIndustryOne 需要完整一级路径才会写库；只返回 industry 字符串会被判"源端为空"。
const industryInfo = {
  industry_nodes: [{ code: '480000', name: '银行', level: 1 }],
  industry: '银行', industry_level: 1, industry_path: ['银行'], sourceCode: 'test',
};

/**
 * 选股补数夹具：真实 inputsSync + 真实仓储替身（保存/读取同一份载荷），
 * 全市场审计与定点复核由场景决定返回值，并被计数。
 */
function createHarness(options = {}) {
  const state = {
    queue: options.queue ? clone(options.queue) : null,
    universeHash: options.universeHash === undefined ? 'hash-a' : options.universeHash,
    fullAuditCalls: 0,
    targetedCalls: [],
    fullAuditQueue: (options.fullAudits || []).map(clone),
    targetedPlan: options.targeted || {},
    industryBehavior: options.industryBehavior || (async () => ({ ok: false, reason: 'industry_source_returned_empty' })),
    recentBarCodes: new Set(options.recentBarCodes || []),
  };
  const repoPath = path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js');
  const repo = {
    async saveInputGapQueue({ payload }) { state.queue = clone(payload); return 1; },
    async readInputGapQueue() { return state.queue ? { cursor_payload: clone(state.queue) } : null; },
    async findInstrumentMeta({ tsCode }) {
      return { instrument_id: 1, ts_code: tsCode, name: tsCode, market: /\.HK$/i.test(tsCode) ? 'HK' : 'CN', list_date: '2010-01-01', currency_code: 'CNY', raw_data: {} };
    },
    async findUniverseArtifact() { return state.universeHash ? { content_hash: state.universeHash } : null; },
    async listCodesWithRecentBars({ codes = [] }) {
      return new Set(codes.filter(code => state.recentBarCodes.has(code)));
    },
  };
  stub(repoPath, repo);
  // 根盘空间判定必须可注入：真实机器磁盘状态不能被测试用来决定"能否宣告完成"。
  const diskGuardPath = path.join(__dirname, '..', 'services', 'diskGuard.js');
  stub(diskGuardPath, {
    checkHistoryCollectionSpace: async () => (options.diskSuspended
      ? { suspended: true, reason: 'root_disk_low', freeBytes: 0, requiredBytes: 1 }
      : { suspended: false, reason: null }),
  });
  const servicePath = path.join(__dirname, '..', 'services', 'stockSelectionService.js');
  stub(servicePath, {
    DEFAULT_STRATEGY_CODE: 'investment_essentials_adapted_v1',
    async auditInputs() {
      state.fullAuditCalls += 1;
      const next = state.fullAuditQueue.length ? state.fullAuditQueue.shift() : [];
      if (next && next.__error) throw new Error(next.__error);
      const gaps = Array.isArray(next) ? next : [];
      return {
        queueId: state.fullAuditCalls,
        gaps,
        gapCount: gaps.length,
        domainCounts: {},
        coverage: { universeCount: gaps.length },
        quality: {},
      };
    },
    async auditInputsForCodes({ codes }) {
      state.targetedCalls.push(codes.slice());
      const plan = typeof state.targetedPlan === 'function' ? state.targetedPlan(codes, state) : state.targetedPlan;
      return {
        gaps: plan && plan.gaps ? clone(plan.gaps) : [],
        evaluatedCodes: plan && plan.evaluatedCodes ? plan.evaluatedCodes.slice() : codes.slice(),
        universeCount: codes.length,
      };
    },
  });
  const datasets = require('../dataAccess/marketDatasets');
  datasets.readIndustryClassification = async ({ tsCode }) => state.industryBehavior(tsCode);
  datasets.readFinancialReportRows = async () => null;
  datasets.readDividendRows = async () => null;
  require('../repositories/industryRepository').upsertIndustryPath = async () => {};
  // 港股目标池夹具（只在 HK 场景使用）：不发起外部请求，只验证批后真实差集。
  datasets.readIndexConstituents = async () => [{ code: '00700.HK', name: '腾讯' }];
  datasets.readMutualMarketCompanies = async () => [];
  datasets.readCompanyProfiles = async () => [{ code: '00700.HK', fsTableType: 'non_financial' }];
  datasets.readStockDailySeries = async () => [];
  require('../services/convertibleBondAnalysisStore').sourceIds = async () => ({ lixinger_official: 1 });
  delete require.cache[require.resolve('../services/stockSelectionInputsSync')];
  const sync = require('../services/stockSelectionInputsSync');
  return { sync, state };
}

async function run() {
  // ---------- 1a. 批前全审已 0 缺口：不得再白跑第二遍全市场终审 ----------
  {
    const harness = createHarness({ fullAudits: [[]] });
    const result = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 10 });
    eq(harness.state.fullAuditCalls, 1, '首次建队 0 缺口只允许批前一次全市场审计');
    eq(result.auditMode, 'full', '首次建队必须走批前全审');
    eq(result.finalAuditPerformed, false, '批前全审已 0 缺口时不得再跑第二遍全市场终审');
    eq(harness.state.queue.lastRun.finalAudit.skippedByPreAudit, true,
      '跳过终审必须留明确证据（skippedByPreAudit），不能与“跑过终审”混淆');
    eq(harness.state.queue.gaps.length, 0, '0 缺口队列必须保持为空');
    eq(result.status, 'succeeded', '批前全审已确认清零时允许 succeeded');
    eq(result.ok, true, '批前全审已确认清零时 ok 必须为 true');
  }

  // ---------- 1b. forceFullAudit 0 缺口：同样只审一次 ----------
  {
    const gap = industryGap('600701.SH');
    const harness = createHarness({
      fullAudits: [[gap], []],
      // 第一批返回成功但缺口未解除，保持剩余量 > 0，避免第一批就进入终审。
      targeted: () => ({ gaps: [gap], evaluatedCodes: ['600701.SH'] }),
      industryBehavior: async () => industryInfo,
    });
    await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 5 });
    eq(harness.state.fullAuditCalls, 1, '首次建队批前全审一次');
    const forced = await harness.sync.syncSelectionInputs({
      market: 'CN', asOfDate: '2026-11-26', batchLimit: 5, forceFullAudit: true,
    });
    eq(harness.state.fullAuditCalls, 2, 'forceFullAudit 只增加批前全审一次，不得叠加第二遍终审');
    eq(forced.auditMode, 'full', '强制全审的审计模式必须是 full');
    eq(forced.finalAuditPerformed, false, '强制全审返回 0 缺口后不得再跑终审');
    eq(harness.state.queue.lastRun.finalAudit.skippedByPreAudit, true,
      '强制全审跳过终审必须留证据');
  }

  // ---------- 1c. 低磁盘 + 同身份空队列：不得把"没补"报成补齐（F-06） ----------
  {
    const harness = createHarness({ fullAudits: [[]], diskSuspended: true });
    const first = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 10 });
    eq(first.ok, false, '低磁盘时即使全审 0 缺口也不得报告完成');
    eq(first.status, 'blocked', '低磁盘必须保持 blocked');
    eq(first.reason, 'root_disk_low', '低磁盘必须给出 root_disk_low');
    eq(harness.state.queue.gaps.length, 0, '空队列仍然要如实保存（不能删队列掩盖暂停）');
    // 第二次同身份续批：批前冻结队列直接消费，空队列 + 低磁盘不得因为
    // "没有剩余 + 本轮没跑终审"而误报 succeeded。
    const second = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 10 });
    eq(second.auditMode, 'incremental', '同身份续批必须直接消费冻结队列');
    eq(second.ok, false, '低磁盘同身份空队列不得报告完成');
    eq(second.status, 'blocked', '低磁盘同身份空队列必须 blocked');
    eq(second.reason, 'root_disk_low', '低磁盘同身份空队列必须保留 root_disk_low');
    eq(harness.state.fullAuditCalls, 1, '同身份续批不得额外跑全市场审计');
  }

  // ---------- 1d. 统一批次配额：跨域同批证券数不得超过 batchLimit（F-08） ----------
  {
    const industryCode = '600601.SH';
    const financialCode = '600602.SH';
    const harness = createHarness({
      fullAudits: [[industryGap(industryCode), financialGap(financialCode)]],
      targeted: codes => ({ gaps: [], evaluatedCodes: codes }),
      industryBehavior: async () => industryInfo,
    });
    const result = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 1 });
    eq(result.attemptedCodes.length, 1,
      '行业缺口与财报缺口分属不同证券时，batchLimit=1 只能处理 1 只证券');
    eq(result.attemptedCodes[0], industryCode, '行业优先占额，财报缺口证券必须留到下一批');
    eq(harness.state.targetedCalls.length, 1, '本批只允许一次定点复核');
    eq(harness.state.targetedCalls[0].length, 1,
      '行业缺口与财报缺口分属不同证券时，batchLimit=1 只能处理 1 只证券');
    eq(harness.state.targetedCalls[0][0], industryCode, '行业优先占额，财报缺口证券必须留到下一批');
    eq(result.industryProcessed, 1, '行业证券必须被处理');
    eq(result.processed, 0, '超出配额的财报证券不得被处理');
  }

  // ---------- 1. 同身份续批：批前 0 次全市场审计，仅定点复核本批 ----------
  {
    const gaps = Array.from({ length: 30 }, (_, index) => industryGap(`6000${String(index).padStart(2, '0')}.SH`));
    const harness = createHarness({
      fullAudits: [gaps],
      targeted: codes => ({ gaps: [], evaluatedCodes: codes }),
      industryBehavior: async () => industryInfo,
    });
    const first = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 10 });
    eq(harness.state.fullAuditCalls, 1, '首次建队必须跑一次全市场审计');
    eq(first.auditMode, 'full', '首次建队的审计模式必须是 full');
    ok(first.queueIdentity && first.queueIdentity.inputVersion, '队列必须持久化四维身份与 inputVersion');
    const queueAfterFirst = harness.state.queue;
    eq(queueAfterFirst.gaps.length, 20, '本批 10 只已定点复核解除，队列应剩 20 只');
    eq(queueAfterFirst.lastRun.timing.auditMs >= 0, true, '摘要必须输出 auditMs 分阶段耗时');
    ok(queueAfterFirst.lastRun.timing.targetedReauditMs >= 0, '摘要必须输出 targetedReauditMs');
    eq(queueAfterFirst.lastRun.targeted.codes, 10, '定点复核只覆盖本批 10 只');
    eq(queueAfterFirst.lastRun.finalAudit.performed, false, '剩余未清零时不得跑全市场终审');

    const second = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 10 });
    eq(harness.state.fullAuditCalls, 1, '同身份续批批前不得再跑全市场审计');
    eq(second.timing.auditMs, 0, '同身份续批的 auditMs 必须为 0');
    eq(second.auditMode, 'incremental', '同身份续批的审计模式必须是 incremental');
    eq(harness.state.queue.gaps.length, 10, '第二批再解除 10 只，队列应剩 10 只');
    eq(harness.state.targetedCalls.length, 2, '两批各做一次定点复核，共 2 次');
    eq(second.finalAuditPerformed, false, '仍有剩余时批后不得跑全市场审计');
  }

  // ---------- 2. 四维身份任一变化 → 批前全审 ----------
  {
    const harness = createHarness({
      fullAudits: [[industryGap('600001.SH')], [industryGap('600001.SH'), industryGap('600002.SH')]],
      targeted: { gaps: [industryGap('600001.SH')], evaluatedCodes: ['600001.SH'] },
      industryBehavior: async () => industryInfo,
    });
    await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 5 });
    const before = harness.state.fullAuditCalls;
    const identityBefore = clone(harness.state.queue.queueIdentity);
    // 股票池 artifact 内容变化 = inputVersion 变化。
    harness.state.universeHash = 'hash-b';
    const changed = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 5 });
    eq(harness.state.fullAuditCalls, before + 1, 'inputVersion 变化必须触发批前全市场审计');
    eq(changed.auditMode, 'full', '身份变化后的审计模式必须是 full');
    ok(changed.queueIdentity.inputVersion !== identityBefore.inputVersion, 'artifact 内容变化必须改变 inputVersion');
    // 显式强制全审同样触发（不依赖身份变化）。
    const forced = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 5, forceFullAudit: true });
    eq(forced.auditMode, 'full', '显式 forceFullAudit 必须触发全市场审计');
    eq(harness.state.fullAuditCalls, before + 2, '强制全审只加一次批前审计，0 缺口时不再叠加终审');
    eq(forced.finalAuditPerformed, false, '强制全审返回 0 缺口时不得再跑终审');
  }

  // ---------- 3. attempts / failedCodes 轮转不变 ----------
  {
    const codes = ['600101.SH', '600102.SH', '600103.SH'];
    const harness = createHarness({
      fullAudits: [codes.map(code => industryGap(code))],
      targeted: codes => ({ gaps: codes.map(code => industryGap(code)), evaluatedCodes: codes }),
      industryBehavior: async () => { throw new Error('source down'); },
    });
    const seen = new Set();
    for (let round = 0; round < 4; round += 1) {
      await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 1 });
      const lastAttempted = harness.state.targetedCalls[harness.state.targetedCalls.length - 1] || [];
      lastAttempted.forEach(code => seen.add(code));
      const lastRun = harness.state.queue.lastRun;
      ok(lastRun.attempts && Object.keys(lastRun.attempts).length >= 1, '尝试计数必须跨批持久化');
    }
    eq(seen.size, 3, '三只对象必须都获得过重试机会（不被固定前缀挡住）');
    eq(Object.keys(harness.state.queue.lastRun.attempts).sort().join(','), codes.slice().sort().join(','),
      '四轮后三只对象都必须留下尝试计数');
    ok(harness.state.queue.lastRun.failedCodes.length >= 1, '失败对象必须持久化到 failedCodes');
  }

  // ---------- 3b. 返回成功但缺口仍在 → deferredCodes（不得占住队首） ----------
  {
    const codes = ['600111.SH', '600112.SH'];
    const harness = createHarness({
      fullAudits: [codes.map(code => industryGap(code))],
      targeted: codes => ({ gaps: codes.map(code => industryGap(code)), evaluatedCodes: codes }),
      industryBehavior: async () => industryInfo,
    });
    await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 1 });
    const lastRun = harness.state.queue.lastRun;
    eq(lastRun.failedCodes.length, 0, '本批取数成功时不应记为失败');
    eq(lastRun.deferredCodes.join(','), '600111.SH', '缺口未解除的成功对象必须进入 deferredCodes');
  }

  // ---------- 4. 清零门禁：终审新缺口 → 不得 succeeded ----------
  {
    const gap = industryGap('600201.SH');
    const newGap = { code: '600299.SH', name: '新缺口', companyId: 200, filterStatus: 'PENDING', domains: ['valuation'], reasons: ['R01:PENDING'] };
    const harness = createHarness({
      fullAudits: [[gap], [newGap]],
      targeted: { gaps: [], evaluatedCodes: ['600201.SH'] },
      industryBehavior: async () => industryInfo,
    });
    const result = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 5 });
    eq(harness.state.fullAuditCalls, 2, '剩余清零前必须额外执行一次全市场终审');
    eq(result.finalAuditPerformed, true, '返回摘要必须标记终审已执行');
    eq(result.status, 'partial', '终审发现新缺口时必须保持 partial');
    eq(result.ok, false, '终审发现新缺口时不得报告完成');
    eq(harness.state.queue.gaps.length, 1, '终审新缺口必须回写最新队列');
    eq(harness.state.queue.gaps[0].code, '600299.SH', '回写队列必须包含终审新缺口');
  }

  // ---------- 4b. 终审确认清零 → succeeded ----------
  {
    const gap = industryGap('600301.SH');
    const harness = createHarness({
      fullAudits: [[gap], []],
      targeted: { gaps: [], evaluatedCodes: ['600301.SH'] },
      industryBehavior: async () => industryInfo,
    });
    const result = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 5 });
    eq(result.status, 'succeeded', '终审确认无缺口才允许 succeeded');
    eq(result.ok, true, '终审确认清零后 ok 必须为 true');
    eq(harness.state.queue.gaps.length, 0, '清零后队列必须为空');
  }

  // ---------- 4c. 增量续批清零 → 必须终审（反向条件不得被 1a/1b 误伤） ----------
  {
    const gap = industryGap('600401.SH');
    const harness = createHarness({
      fullAudits: [[gap], []],
      // 第一批缺口未解除；第二批定点复核确认解除。
      targeted: (codes, state) => (state.targetedCalls.length === 1
        ? { gaps: [gap], evaluatedCodes: codes }
        : { gaps: [], evaluatedCodes: codes }),
      industryBehavior: async () => industryInfo,
    });
    const first = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 5 });
    eq(first.finalAuditPerformed, false, '第一批仍有缺口时不得跑终审');
    eq(harness.state.queue.gaps.length, 1, '第一批缺口未解除时必须留在队列');
    const second = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 5 });
    eq(second.auditMode, 'incremental', '第二批必须是同身份增量续批');
    eq(harness.state.fullAuditCalls, 2, '增量续批清零仍必须跑一次全市场终审');
    eq(second.finalAuditPerformed, true, '增量续批清零必须标记终审已执行');
    eq(second.status, 'succeeded', '增量续批终审确认清零后才允许 succeeded');
  }

  // ---------- 4d. 终审报错 → 不得 succeeded ----------
  {
    const gap = industryGap('600501.SH');
    const harness = createHarness({
      fullAudits: [[gap], { __error: 'full audit exploded' }],
      targeted: { gaps: [], evaluatedCodes: ['600501.SH'] },
      industryBehavior: async () => industryInfo,
    });
    const result = await harness.sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-26', batchLimit: 5 });
    eq(result.finalAuditPerformed, false, '终审报错不得标记为已执行');
    eq(result.ok, false, '终审报错不得报告完成');
    eq(result.status, 'blocked', '终审报错必须 blocked');
    eq(result.reason, 'selection_inputs_final_audit_failed', '终审报错必须给出明确原因');
  }

  // ---------- 5. 港股未补行情标的不得提前完成 ----------
  {
    const harness = createHarness({
      fullAudits: [[], []],
      targeted: { gaps: [], evaluatedCodes: [] },
      recentBarCodes: [],
    });
    const result = await harness.sync.syncSelectionInputs({ market: 'HK', asOfDate: '2026-11-26', batchLimit: 5 });
    eq(result.remainingTargetPool, 1, '目标池里未补到行情的港股必须计入真实剩余');
    eq(result.ok, false, '目标池仍有未补行情标的时不得宣告完成');
    eq(result.status, 'partial', '目标池未清空必须是 partial 而不是 succeeded');
    eq(result.reason, 'selection_target_pool_pending', '原因必须是目标池待补');
  }

  console.log(`OK stock-selection-inputs-queue-batch: ${checks} 项增量队列、轮转、清零终审与港股目标池守护通过`);
}

run().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
