'use strict';

const assert = require('assert');
const rules = require('../domain/classroomRules');
const { buildDemoScenario } = require('../domain/classroomDemoScenario');
const { resolveYearStockCoverage } = require('../services/classroomPrecheckService');
const presenter = require('../../public/js/presenters/classroom-presenter');

function run() {
  // 1. 定点分解析与满仓精确到分
  const p1 = rules.parseWanToCents('108.473201');
  assert.strictEqual(p1.ok, true);
  assert.strictEqual(p1.cents, 108473201);
  assert.strictEqual(rules.centsToWanStr(108473201), '108.473201');

  assert.strictEqual(rules.parseWanToCents('').cents, 0);
  assert.strictEqual(rules.parseWanToCents('-1').ok, false);
  assert.strictEqual(rules.parseWanToCents('1.1234567').ok, false);

  // 2. 单项上限联动与百分比/满仓
  const allocs = { stk_a: 50000000, bond_10y: 10000000 };
  assert.strictEqual(presenter.computeAssetCapCents(100000000, allocs, 'stk_b'), 40000000);
  delete allocs.stk_a;
  assert.strictEqual(presenter.computeAssetCapCents(100000000, allocs, 'stk_b'), 90000000);
  assert.strictEqual(presenter.computePercentCapCents(108473201, 100), 108473201);
  assert.strictEqual(presenter.computePercentCapCents(108473201, 25), Math.floor((108473201 * 25) / 100));

  // 3. 国债 20 万涨 4% -> 20.8 万
  assert.strictEqual(rules.settleAmountHalfUp(20000000, 0.04), 20800000);
  // half-up 舍入测试：1 分 * 1.5 -> 2 分
  assert.strictEqual(rules.settleAmountHalfUp(1, '0.5'), 2);

  // 4. 账号隔离本地草稿
  const store = new Map();
  const mockStorage = {
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i]; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, v); },
    removeItem(k) { store.delete(k); },
  };
  presenter.writeLocalDraft(mockStorage, 'subj_1', 10, 1, { allocations: { stk_a: 1000000 }, dirty: true });
  assert.ok(presenter.readLocalDraft(mockStorage, 'subj_1', 10, 1));
  assert.strictEqual(presenter.readLocalDraft(mockStorage, 'subj_2', 10, 1), null);
  presenter.clearAccountLocalDrafts(mockStorage, 'subj_1');
  assert.strictEqual(presenter.readLocalDraft(mockStorage, 'subj_1', 10, 1), null);

  // 4b. 跨设备离线草稿恢复必须保留原始 baseVersion，禁止被服务端新版本静默覆盖
  const conflictResolved = presenter.resolveInitialDraftState({
    localDraft: { dirty: true, baseVersion: 1, allocations: { stk_energy_a: 1000000 } },
    serverDraft: { draftVersion: 2, allocations: { stk_energy_a: 2000000 }, updatedAt: '2026-11-23T01:00:00Z' },
    serverSubmission: null,
    defaultAllocations: {},
  });
  assert.strictEqual(conflictResolved.draftVersion, 1);
  assert.strictEqual(conflictResolved.syncStatus, 'conflict');
  assert.strictEqual(conflictResolved.conflictInfo.serverVersion, 2);
  assert.strictEqual(conflictResolved.conflictInfo.serverAllocations.stk_energy_a, 2000000);
  assert.strictEqual(conflictResolved.draftAllocations.stk_energy_a, 1000000);

  const nonConflictResolved = presenter.resolveInitialDraftState({
    localDraft: { dirty: true, baseVersion: 2, allocations: { stk_energy_a: 3000000 } },
    serverDraft: { draftVersion: 2, allocations: { stk_energy_a: 2000000 }, updatedAt: '2026-11-23T01:00:00Z' },
    serverSubmission: null,
    defaultAllocations: {},
  });
  assert.strictEqual(nonConflictResolved.draftVersion, 2);
  assert.strictEqual(nonConflictResolved.syncStatus, 'saved_local');
  assert.strictEqual(nonConflictResolved.conflictInfo, null);

  // 4c. 保存请求在途期间继续编辑：旧请求返回不得把新编辑误标为「已同步」
  const sentJson = presenter.canonicalizeAllocationsJson({ stk_energy_a: 1000000 });
  const editedInFlight = presenter.reconcileDraftSyncSuccess({
    sentClassroomId: 10,
    sentRoundNo: 1,
    sentJson,
    currentClassroomId: 10,
    currentRoundNo: 1,
    currentAllocations: { stk_energy_a: 2500000 },
    serverVersion: 3,
    currentSyncStatus: 'saved_local',
  });
  assert.strictEqual(editedInFlight.sameContext, true);
  assert.strictEqual(editedInFlight.matchesSent, false);
  assert.strictEqual(editedInFlight.nextSyncStatus, 'saved_local');
  assert.strictEqual(editedInFlight.dirty, true);
  assert.strictEqual(editedInFlight.draftVersion, 3);

  const untouchedInFlight = presenter.reconcileDraftSyncSuccess({
    sentClassroomId: 10,
    sentRoundNo: 1,
    sentJson,
    currentClassroomId: 10,
    currentRoundNo: 1,
    currentAllocations: { stk_energy_a: 1000000 },
    serverVersion: 3,
    currentSyncStatus: 'saved_local',
  });
  assert.strictEqual(untouchedInFlight.matchesSent, true);
  assert.strictEqual(untouchedInFlight.nextSyncStatus, 'synced');
  assert.strictEqual(untouchedInFlight.dirty, false);

  const switchedRoundInFlight = presenter.reconcileDraftSyncSuccess({
    sentClassroomId: 10,
    sentRoundNo: 1,
    sentJson,
    currentClassroomId: 10,
    currentRoundNo: 2,
    currentAllocations: { stk_energy_a: 1000000 },
    serverVersion: 3,
    currentSyncStatus: 'saved_local',
  });
  assert.strictEqual(switchedRoundInFlight.sameContext, false);

  // 4d. 正式提交在途期间继续编辑（1 万 -> 2 万）：响应回来不得把 2 万新编辑标为已提交/已同步
  const submitSentJson = presenter.canonicalizeAllocationsJson({ stk_energy_a: 1000000 });
  const submitEdited = presenter.reconcileSubmitSuccess({
    sentClassroomId: 10,
    sentRoundNo: 1,
    sentJson: submitSentJson,
    currentClassroomId: 10,
    currentRoundNo: 1,
    currentAllocations: { stk_energy_a: 2000000 },
    currentSyncStatus: 'saved_local',
  });
  assert.strictEqual(submitEdited.sameContext, true);
  assert.strictEqual(submitEdited.matchesSent, false);
  assert.strictEqual(submitEdited.nextSyncStatus, 'saved_local');
  assert.strictEqual(submitEdited.dirty, true);

  const submitUntouched = presenter.reconcileSubmitSuccess({
    sentClassroomId: 10,
    sentRoundNo: 1,
    sentJson: submitSentJson,
    currentClassroomId: 10,
    currentRoundNo: 1,
    currentAllocations: { stk_energy_a: 1000000 },
    currentSyncStatus: 'saved_local',
  });
  assert.strictEqual(submitUntouched.matchesSent, true);
  assert.strictEqual(submitUntouched.nextSyncStatus, 'submitted');
  assert.strictEqual(submitUntouched.dirty, false);

  // 5. 停牌顺延取价预检
  const yDates = ['2015-01-05', '2015-01-06', '2015-01-07', '2015-01-08', '2015-12-25', '2015-12-28', '2015-12-29', '2015-12-30', '2015-12-31'];
  const prevDates = ['2014-12-29', '2014-12-30', '2014-12-31'];
  const barByDate = new Map([
    ['2015-01-07', { close: '10', adj_factor: '1.2' }],
    ['2015-12-25', { close: '15', adj_factor: '1.2' }],
  ]);
  const valByDate = new Map([
    ['2014-12-31', { pe_ttm: '12.5', pb: '1.4', total_market_cap: '5000000000' }],
  ]);
  const suspendDates = new Set(['2015-01-05', '2015-01-06', '2015-12-31', '2015-12-30', '2015-12-29', '2015-12-28']);
  const cov = resolveYearStockCoverage({ year: 2015, yearTradeDates: yDates, prevYearTailTradeDates: prevDates, barByDate, valByDate, suspendDates });
  assert.strictEqual(cov.status, 'yellow');
  assert.strictEqual(cov.startAdopted, '2015-01-07');
  assert.strictEqual(cov.startOffset, 2);
  assert.strictEqual(cov.endAdopted, '2015-12-25');
  assert.strictEqual(cov.endOffset, 4);
  assert.strictEqual(cov.valAdopted, '2014-12-31');
  assert.strictEqual(cov.returnRate, 0.5);

  // 无停牌证据缺数 -> red
  const covRed = resolveYearStockCoverage({ year: 2015, yearTradeDates: yDates, prevYearTailTradeDates: prevDates, barByDate, valByDate, suspendDates: new Set() });
  assert.strictEqual(covRed.status, 'red');

  // 6. 策略选样、暂停转现金与第 11 轮可转债 100 元期初锚点
  const demo = buildDemoScenario({ startYear: 2011, totalRounds: 15 });
  const r10Open = rules.buildRoundOpenCatalog(demo.rounds[9], { indexEndLevel: 1200 }, null);
  const lowPe8 = r10Open.strategies.find((s) => s.assetId === 'strat_low_pe_8');
  assert.strictEqual(lowPe8.paused, true);

  const openingAfterPause = rules.computeMemberRoundOpening({
    prevSettlement: {
      ending_total_cents: 100000000,
      ending_cash_cents: 48000000,
      item_details: [
        { assetId: 'strat_low_pe_8', alias: '低市盈率 8', endingCents: 12000000 },
        { assetId: 'stk_energy_a', alias: '能源 A', endingCents: 40000000 },
      ],
    },
    openSnapshot: r10Open,
  });
  assert.strictEqual(openingAfterPause.defaultCashCents, 60000000);
  assert.strictEqual(openingAfterPause.defaultAllocations.stk_energy_a, 40000000);
  assert.strictEqual(openingAfterPause.defaultAllocations.strat_low_pe_8, undefined);
  assert.strictEqual(openingAfterPause.liquidationEvents.length, 1);

  const r11Open = rules.buildRoundOpenCatalog(demo.rounds[10], { indexEndLevel: 1300 }, null);
  const cb0 = r11Open.assets.find((a) => a.assetId === 'cb_0');
  assert.strictEqual(cb0.cbInfo.openPrice, 100);
  assert.strictEqual(cb0.cbInfo.remainingYears, 6);

  // 7. 盲玩白名单裁剪不泄露代码/公司/年份/未揭晓收益
  const blindAssets = rules.projectAssetsForViewer({
    openSnapshot: r11Open,
    settledMarket: { assetReturns: { stk_energy_a: 0.25 } },
    blindActive: true,
    isRevealed: false,
  });
  const firstStock = blindAssets[0];
  assert.strictEqual(firstStock.canonicalCode, undefined);
  assert.strictEqual(firstStock.stockName, undefined);
  assert.strictEqual(firstStock.returnRate, undefined);
  assert.ok(firstStock.peDisplay.includes('倍') || firstStock.peDisplay === '亏损');

  // 8. 并列跳位排名与迟到参考名次
  const ranked = rules.rankOfficialSettlements([
    { memberId: 1, endingTotalCents: 120000000 },
    { memberId: 2, endingTotalCents: 120000000 },
    { memberId: 3, endingTotalCents: 95000000 },
  ]);
  assert.deepStrictEqual(ranked.map((r) => r.officialRank), [1, 1, 3]);
  assert.strictEqual(rules.computeLateReferenceRank([120000000, 120000000, 95000000], 100000000), 3);

  console.log('stock-classroom-domain.test.js: ALL PASSED');
}

run();
