// 手动补可转债周期数据（2026-07-27）
// 用法：在 /opt/portfolio 目录下执行：node scripts_manual/backfill_cycle_0727.js
// 逻辑：先探测 Tushare 上 20260728 / 20260727 是否有 cb_daily 数据。
//   - 若 20260728 暂无数据（盘前/盘中预期），syncConvertibleBondUniverse 会自动退回到 20260727 并补齐周期。
//   - 若 20260728 已有数据，则本次不跑（否则会跳过 27 日），改由用户另行处理。

const path = require('path');
const { tushareQuery, tsRows } = require('../server/services/market');
const { syncConvertibleBondUniverse } = require('../server/services/convertibleBondAnalysis');

async function probe(tradeDate) {
  const data = await tushareQuery('cb_daily', { trade_date: tradeDate }, 'ts_code,close');
  const rows = tsRows(data);
  return rows.length;
}

(async () => {
  try {
    console.log('[probe] 探测 Tushare cb_daily 数据可用性...');
    const cnt28 = await probe('20260728');
    const cnt27 = await probe('20260727');
    console.log(`[probe] 20260728 行数=${cnt28}，20260727 行数=${cnt27}`);

    if (cnt28 > 0) {
      console.log('[abort] Tushare 已有 20260728 数据，本次若跑会跳过 27 日，已中止。请改用其他方式强制补 27 日。');
      process.exit(2);
    }
    if (cnt27 === 0) {
      console.log('[abort] Tushare 20260727 也无数据（可能网络/接口异常），已中止，避免写入空数据。');
      process.exit(3);
    }

    console.log('[run] 开始手动同步（预期回退到 20260727）...');
    const result = await syncConvertibleBondUniverse('manual_backfill_0727');
    console.log('[result]', JSON.stringify(result));
    console.log('[done] 同步结束。');
    process.exit(0);
  } catch (e) {
    console.error('[error]', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
