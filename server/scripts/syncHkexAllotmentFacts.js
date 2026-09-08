// 从港交所披露易官方配发结果英文 PDF 增量补齐港股 IPO 初始发售结构。
// 用法：node server/scripts/syncHkexAllotmentFacts.js [--from-date=YYYY-MM-DD] [--to-date=YYYY-MM-DD] [--limit=20] [--refresh-lottery=true]
require('dotenv').config();
const { syncHkexAllotmentFacts } = require('../services/hkexIpo');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

(async () => {
  const result = await syncHkexAllotmentFacts({
    fromDate: arg('from-date', '2025-08-04'),
    toDate: arg('to-date'),
    limit: Number(arg('limit', 20)),
    refreshLottery: ['1', 'true', 'yes'].includes(String(arg('refresh-lottery', 'false')).toLowerCase()),
  });
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  console.error('[hkex-allotment] failed:', error.message || error);
  process.exitCode = 1;
});
