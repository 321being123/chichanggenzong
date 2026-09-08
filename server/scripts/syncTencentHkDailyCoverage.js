// 使用项目已有腾讯行情源补齐港股 IPO 上市首日及上市后五个交易日日线。
// 仅写入本地标准层与审计表；正式建议仍必须通过独立回测门禁。
// 用法：node server/scripts/syncTencentHkDailyCoverage.js [--from-date=YYYY-MM-DD] [--to-date=YYYY-MM-DD] [--limit=200]
require('dotenv').config();
const { syncTencentHkDailyCoverage } = require('../services/hkDailyCoverage');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

(async () => {
  const result = await syncTencentHkDailyCoverage({
    fromDate: arg('from-date', '2025-08-04'),
    toDate: arg('to-date'),
    limit: Number(arg('limit', 200)),
  });
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  console.error('[tencent-hk-daily] failed:', error.message || error);
  process.exitCode = 1;
});
