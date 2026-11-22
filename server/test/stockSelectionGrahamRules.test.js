'use strict';

const assert = require('assert');
const { STATUS } = require('../domain/stockSelectionRules');
const {
  STRATEGY_CODE_GRAHAM,
  evaluateGrahamCandidate,
  rankGrahamCandidates,
} = require('../domain/stockSelectionGrahamRules');

assert.strictEqual(STRATEGY_CODE_GRAHAM, 'graham_net_net_v1');

// 1. G01 精确 BigInt 计算：流动资产 - 流动负债 - 总市值 > 0
const passRes = evaluateGrahamCandidate({
  market: 'CN',
  asOfDate: '2026-11-20',
  tsCode: '000001.SZ',
  hasBalanceReport: true,
  reportId: 101,
  periodEnd: '2026-09-30',
  currentAssets: '5000000000.00',
  currentLiabilities: '2000000000.00',
  totalMarketCap: '2000000000.00',
  balanceCurrency: 'CNY',
  valuationCurrency: 'CNY',
});
assert.strictEqual(passRes.status, STATUS.PASS);
assert.strictEqual(passRes.metrics.ncav, 3000000000);
assert.strictEqual(passRes.metrics.netNetSurplus, 1000000000);
assert.strictEqual(passRes.rankingScore, 0.5);

// 2. 恰好等于 0 不通过（FAIL）
const boundaryZero = evaluateGrahamCandidate({
  market: 'CN',
  asOfDate: '2026-11-20',
  tsCode: '000002.SZ',
  hasBalanceReport: true,
  currentAssets: '3000000000',
  currentLiabilities: '1000000000',
  totalMarketCap: '2000000000',
  balanceCurrency: 'CNY',
  valuationCurrency: 'CNY',
});
assert.strictEqual(boundaryZero.status, STATUS.FAIL);
assert.strictEqual(boundaryZero.g01.reason, 'net_net_surplus_non_positive');

// 3. 金融企业不区分流动科目 -> NOT_APPLICABLE（不计入 PENDING）
for (const fsType of ['bank', 'insurance', 'security', 'other_financial']) {
  const finRes = evaluateGrahamCandidate({
    market: 'CN',
    asOfDate: '2026-11-20',
    tsCode: '601398.SH',
    fsTableType: fsType,
    hasBalanceReport: true,
    currentAssets: null,
    currentLiabilities: null,
    totalMarketCap: '1000000000',
  });
  assert.strictEqual(finRes.status, STATUS.NOT_APPLICABLE);
  assert.strictEqual(finRes.g01.reason, 'financial_statement_no_current_classification');
}

// 4. 非金融类有财报但缺流动科目 -> PENDING
const pendingRes = evaluateGrahamCandidate({
  market: 'CN',
  asOfDate: '2026-11-20',
  tsCode: '600519.SH',
  fsTableType: 'non_financial',
  hasBalanceReport: true,
  currentAssets: null,
  currentLiabilities: '1000000000',
  totalMarketCap: '1000000000',
});
assert.strictEqual(pendingRes.status, STATUS.PENDING);
assert.strictEqual(pendingRes.g01.reason, 'current_assets_or_liabilities_unavailable');

// 5. 港股跨币种折算（CNY 财报 vs HKD 市值，按汇率 1.08 折算）
const hkFxPass = evaluateGrahamCandidate({
  market: 'HK',
  asOfDate: '2026-11-20',
  tsCode: '00700.HK',
  hasBalanceReport: true,
  currentAssets: '5000000000',
  currentLiabilities: '2000000000',
  totalMarketCap: '3000000000',
  balanceCurrency: 'CNY',
  valuationCurrency: 'HKD',
  fxRate: 1.08,
  fxDate: '2026-11-20',
});
// NCAV in HKD = 30亿 * 1.08 = 32.4亿 > 30亿市值 -> surplus = 2.4亿 -> surplusRatio = 0.08
assert.strictEqual(hkFxPass.status, STATUS.PASS);
assert.strictEqual(hkFxPass.metrics.ncav, 3240000000);
assert.strictEqual(hkFxPass.metrics.netNetSurplus, 240000000);
assert.strictEqual(hkFxPass.rankingScore, 0.08);

// 6. 跨币种缺失汇率 -> PENDING
const hkFxMissing = evaluateGrahamCandidate({
  market: 'HK',
  asOfDate: '2026-11-20',
  tsCode: '00700.HK',
  hasBalanceReport: true,
  currentAssets: '5000000000',
  currentLiabilities: '2000000000',
  totalMarketCap: '3000000000',
  balanceCurrency: 'CNY',
  valuationCurrency: 'HKD',
  fxRate: null,
});
assert.strictEqual(hkFxMissing.status, STATUS.PENDING);
assert.strictEqual(hkFxMissing.g01.reason, 'fx_rate_missing');

// 7. 排序：净流动资产盈余占市值比降序
const ranked = rankGrahamCandidates([
  { tsCode: '000001.SZ', status: STATUS.PASS, rankingScore: 0.2 },
  { tsCode: '000002.SZ', status: STATUS.PASS, rankingScore: 0.8 },
  { tsCode: '000003.SZ', status: STATUS.FAIL, rankingScore: null },
]);
assert.deepStrictEqual(ranked.map(r => r.tsCode), ['000002.SZ', '000001.SZ']);

console.log('stockSelectionGrahamRules.test.js passed');
