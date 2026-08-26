const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  latestFullBondDaily,
  activeProfile,
  isUnderlyingStockListed,
} = require('../services/convertibleBondAnalysis');
const { resolveMaxAttempts, classifyFailure } = require('../services/jobOrchestrator');
const { sanitizeJobResult } = require('../services/jobErrorSanitizer');

function response(rows) {
  const fields = ['ts_code', 'close', 'cb_value', 'bond_value'];
  return { fields, items: rows.map(row => fields.map(field => row[field])) };
}

function completeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    ts_code: `113${String(index).padStart(3, '0')}.SH`,
    close: 100,
    cb_value: 105,
    bond_value: 98,
  }));
}

(async () => {
  const activeCodes = new Set(completeRows(3).map(row => row.ts_code));
  const queried = [];
  const selected = await latestFullBondDaily(['20260824', '20260821'], {
    activeCodes,
    expectedBondCount: 3,
    query: async (apiName, params, fields, options) => {
      assert.strictEqual(apiName, 'cb_daily');
      assert.strictEqual(options.allowEmpty, true);
      queried.push(params.trade_date);
      return params.trade_date === '20260824' ? { fields: ['ts_code', 'close', 'cb_value', 'bond_value'], items: [] } : response(completeRows(3));
    },
  });
  assert.deepStrictEqual(queried, ['20260824', '20260821'], '目标日空数据必须继续回看上一交易日');
  assert.strictEqual(selected.tradeDate, '20260821');
  assert.strictEqual(selected.diagnostics[0].status, 'empty');
  assert.strictEqual(selected.diagnostics[1].status, 'usable');

  const incomplete = await latestFullBondDaily(['20260824'], {
    activeCodes,
    expectedBondCount: 3,
    query: async () => response(completeRows(2)),
  });
  assert.strictEqual(incomplete.tradeDate, null, '覆盖不足不得写成完整行情');
  assert.strictEqual(incomplete.reason, 'incomplete_data');
  assert.strictEqual(incomplete.diagnostics[0].coverage, 0.6667);

  assert.strictEqual(activeProfile({ ts_code: '113001.SH', list_date: '20260825' }, '20260824'), false, '未来上市债券不得进入已上市主档');
  assert.strictEqual(activeProfile({ ts_code: '113001.SH', list_date: '20260824' }, '20260824'), true);
  assert.strictEqual(isUnderlyingStockListed({ stk_code: '600000.SH' }, new Set(['600000.SH'])), true, '正股仍在上市才允许进入活跃主档');
  assert.strictEqual(isUnderlyingStockListed({ stk_code: '600000.SH' }, new Set(['000001.SZ'])), false, '正股已不在上市列表不得进入活跃主档');
  assert.strictEqual(resolveMaxAttempts({ maxAttempts: 4, retryPolicy: 'external' }, {}), 4, '外部任务必须执行配置的四次尝试');
  assert.strictEqual(classifyFailure({ code: 'RATE_LIMIT', errorType: 'rate_limit', recoverAt: new Date(Date.now() + 120000) }).retryable, true, '临时限流应按恢复时间重试');
  assert.strictEqual(sanitizeJobResult({ tokenFingerprint: 'sensitive' }).tokenFingerprint, '[已脱敏]');
  const analysisSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'convertibleBondAnalysis.js'), 'utf8');
  assert.ok(analysisSource.includes("tushareQuery('daily', { trade_date: tradeDate.replace(/-/g, '') }"), '正股日行情补齐必须使用 Tushare 要求的 YYYYMMDD 日期');
  assert.ok(analysisSource.includes("tushareQuery('daily_basic', { trade_date: tradeDate.replace(/-/g, '') }"), '正股估值补齐必须使用 Tushare 要求的 YYYYMMDD 日期');
  assert.ok(analysisSource.includes('setTimeout(resolve, 1200)'), '正股历史补齐必须在外部调用之间限速');
  console.log('convertible bond refresh regression tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
