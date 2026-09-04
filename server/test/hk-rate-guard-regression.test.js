const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const hkRate = read('server/jobs/hkRate.js');
const marketRoute = read('server/routes/market.js');
const positionRoute = read('server/routes/positionComparison.js');
const migrations = read('server/db/migrations.js');

assert.ok(
  /e\.errorType === 'rate_limit'\s*&&\s*e\.code !== 'BUDGET_WAIT'/.test(hkRate),
  '汇率适配器不得把内部 BUDGET_WAIT 写成来源熔断',
);
assert.ok(/errorCode:\s*e\.code/.test(hkRate) && /recoverAt:\s*e\.recoverAt/.test(hkRate),
  '真实上游限流熔断必须保留错误码和恢复时间');
assert.ok(/let result = \{ ok: false \}/.test(marketRoute)
  && /result = await ensureHkRate\(\)/.test(marketRoute)
  && /catch \(e\)/.test(marketRoute),
  '汇率接口必须在抓取失败时回退最近有效汇率');
assert.ok(/ensureHkRate\(\)[\s\S]*?\.catch\(\(\) => getCurrentFxRate\(\)\)/.test(positionRoute),
  '持仓对比必须在汇率抓取失败时回退缓存');
assert.ok(/migration135ExchangeRateBudgetRecovery/.test(migrations)
  && /min_interval_ms=86400000/.test(migrations)
  && /detail LIKE '%达到日保护线%'/.test(migrations),
  '必须提供汇率策略统一和历史误熔断恢复迁移');

console.log('港币汇率限额/熔断回归检查通过');
