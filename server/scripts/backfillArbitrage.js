#!/usr/bin/env node
// ========== 套利公告首次 1 年同步入口 ==========
// 用法：node server/scripts/backfillArbitrage.js
// 说明：首次同步范围为执行当天往前 1 个自然年（含当天），不自动扩大区间。
const sync = require('../services/arbitrageAnnouncementSync');

async function main() {
  console.log('[arbitrage-backfill] 开始首次 1 年同步...');
  const start = Date.now();
  try {
    const result = await sync.runFirstSync();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[arbitrage-backfill] 同步完成（${elapsed}s）`);
    console.log('  HKEX:', result.hkex.total, '条', result.hkex.errors.length ? `错误${result.hkex.errors.length}条` : '');
    console.log('  CNINFO:', result.cninfo.total, '条', result.cninfo.errors.length ? `错误${result.cninfo.errors.length}条` : '');
    if (result.hkex.errors.length) {
      console.log('  HKEX 错误详情:');
      result.hkex.errors.slice(0, 10).forEach(e => console.log('    -', e));
    }
    if (result.cninfo.errors.length) {
      console.log('  CNINFO 错误详情:');
      result.cninfo.errors.slice(0, 10).forEach(e => console.log('    -', e));
    }
    process.exit(0);
  } catch (err) {
    console.error('[arbitrage-backfill] 同步失败:', err.message);
    process.exit(1);
  }
}

// 仅在直接执行时运行（require 时不自动执行）
if (require.main === module) {
  main();
}
