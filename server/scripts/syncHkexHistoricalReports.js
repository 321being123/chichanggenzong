// 从港交所官方新上市 Excel 报表增量回填港股 IPO 历史事实。
// 用法：node server/scripts/syncHkexHistoricalReports.js [--from-date=YYYY-MM-DD] [--to-date=YYYY-MM-DD]
require('dotenv').config();
const { syncHkexHistoricalReports } = require('../services/hkexIpo');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

(async () => {
  const result = await syncHkexHistoricalReports({
    fromDate: arg('from-date', '2025-08-04'),
    toDate: arg('to-date'),
  });
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  console.error('[hkex-history] failed:', error.message || error);
  process.exitCode = 1;
});
