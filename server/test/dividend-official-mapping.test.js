// 官方分红映射 → 落库口径（隔离样本，不发真实请求）。
//
// 2026-10-31 实测发现：官方 `cn/company/dividend` 对「预案」阶段（board_director_plan）
// 返回 dividend=0、dividendAmount=null，含义是"金额未定"。若把 0 当成"每股派 0 元"落库，
// 这条零金额行会成为已定金额的分红，在现金收益里按来源权威等级（官方 2 > Tushare 3）
// 压过备源的真实金额。这里钉住映射：金额未定必须是 null，真实的 0 才保留 0。
process.env.NODE_ENV = 'test';

const assert = require('assert');

const FIXTURE_ROWS = [
  // 预案，金额未定 → 每股金额与股本都必须为空
  { fsEndDate: '2026-06-30T00:00:00+08:00', status: 'board_director_plan', dividend: 0, dividendAmount: null, date: '2026-08-15T00:00:00+08:00' },
  // 实施，金额齐备 → 反推股本（万股）
  { fsEndDate: '2025-12-31T00:00:00+08:00', status: 'implemented', dividend: 28.02423, dividendAmount: 35032574305, date: '2026-04-17T00:00:00+08:00', registerDate: '2026-06-25T00:00:00+08:00', exDate: '2026-06-26T00:00:00+08:00', paymentDate: '2026-06-26T00:00:00+08:00' },
  // 纯送股：现金确为 0 且总额也是 0 → 保留 0，不当成"未定"
  { fsEndDate: '2024-12-31T00:00:00+08:00', status: 'implemented', dividend: 0, dividendAmount: 0, bonusSharesFromProfit: 0.5, date: '2025-04-03T00:00:00+08:00' },
];

const officialPath = require.resolve('../services/lixingerOfficial');
require.cache[officialPath] = {
  id: officialPath, filename: officialPath, loaded: true,
  exports: {
    SOURCE: 'lixinger_official',
    callEndpoint: async () => ({ rows: FIXTURE_ROWS }),
    unwrapPayload: payload => payload,
  },
};

const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');

(async () => {
  const rows = await adapter.resolveDividendRows({ tsCode: '600519.SH', startDate: '2024-01-01', endDate: '2026-10-30' });
  const byPeriod = new Map(rows.map(row => [String(row.end_date), row]));

  const plan = byPeriod.get('20260630');
  assert.ok(plan, '预案行必须返回（状态与日期是有效事实）');
  assert.strictEqual(plan.cash_div_tax, null, '预案阶段金额未定，必须落 null 而不是 0');
  assert.strictEqual(plan.base_share, null, '金额未定时算不出股本，必须为空');
  assert.strictEqual(plan.div_proc, '预案');

  const implemented = byPeriod.get('20251231');
  assert.strictEqual(Number(implemented.cash_div_tax), 28.02423, '实施行保留官方每股金额（元）');
  assert.ok(Math.abs(Number(implemented.base_share) - 125008.1601) < 0.01, `股本应反推为万股，实际 ${implemented.base_share}`);
  assert.strictEqual(implemented.source_code, 'lixinger_official');

  const bonusOnly = byPeriod.get('20241231');
  assert.strictEqual(Number(bonusOnly.cash_div_tax), 0, '真实的每股 0 元（纯送股）不能被当成未定');

  console.log('dividend-mapping：预案金额未定落 null、真实 0 保留、股本反推正确');
})().catch(error => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
