// 可转债周期：手动补缺入口（应急用）
// 复用每日同步同一套逻辑：先更新最新一个交易日，再自动补齐最近窗口内的历史空缺日（含全量漫游）。
// 用法：node server/scripts/backfillConvertibleBondCycle.js
const { syncConvertibleBondUniverseWithBackfill } = require('../services/convertibleBondAnalysis');

(async () => {
  try {
    // windowDays 传大值以覆盖从最早游标至今的全部历史空缺（日常自动化已用默认 90 天窗口）
    await syncConvertibleBondUniverseWithBackfill('manual_backfill', { windowDays: 4000 });
    console.log('[回填] 已完成（含历史空缺补齐）');
    process.exit(0);
  } catch (e) {
    console.error('[回填] 失败：', e.message);
    process.exit(1);
  }
})();
