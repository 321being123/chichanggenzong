// 从港交所披露易官方招股书增量补齐申购事实和保荐人证据。
// 用法：node server/scripts/syncHkexProspectusFacts.js [--from-date=YYYY-MM-DD] [--to-date=YYYY-MM-DD] [--limit=18] [--refresh-sponsor=true]
require('dotenv').config();
const { syncHkexProspectusFacts } = require('../services/hkexIpo');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

(async () => {
  const result = await syncHkexProspectusFacts({
    fromDate: arg('from-date', '2025-08-04'),
    toDate: arg('to-date'),
    limit: Number(arg('limit', 18)),
    refreshSponsor: ['1', 'true', 'yes'].includes(String(arg('refresh-sponsor', 'false')).toLowerCase()),
  });
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  console.error('[hkex-prospectus] failed:', error.message || error);
  process.exitCode = 1;
});
