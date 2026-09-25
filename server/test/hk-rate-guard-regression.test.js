const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const hkRate = read('server/jobs/hkRate.js');
const marketRoute = read('server/routes/market.js');
const positionRoute = read('server/routes/positionComparison.js');
const migrations = read('server/db/migrations.js');
const coreAccount = read('public/shared/core-account.js');
const coreQuote = read('public/shared/core-quote.js');
const utils = read('public/js/utils.js');
const { getJobDefinition } = require('../services/jobDefinitions');

assert.ok(
  /e\.errorType === 'rate_limit'\s*&&\s*e\.code !== 'BUDGET_WAIT'/.test(hkRate),
  '汇率适配器不得把内部 BUDGET_WAIT 写成来源熔断',
);
assert.ok(/errorCode:\s*e\.code/.test(hkRate) && /recoverAt:\s*e\.recoverAt/.test(hkRate),
  '真实上游限流熔断必须保留错误码和恢复时间');
assert.ok(/ensureRealtimeHkRate/.test(marketRoute) && /realtimeRequested/.test(marketRoute)
  && /const rate = await getCurrentFxRate\(\)/.test(marketRoute),
  '汇率页面接口必须区分盘中实时刷新和普通缓存读取');
assert.ok(/getCurrentFxRate\(\)/.test(positionRoute) && !/ensureHkRate\(\)/.test(positionRoute),
  '持仓对比必须只读汇率缓存，不能触发外部刷新');
assert.ok(/getCurrentFxRateSnapshot\(\)/.test(hkRate) && /FRESH_RATE_MS/.test(hkRate)
  && /status: 'fresh'/.test(hkRate) && /externalCalls: 0/.test(hkRate),
  '汇率任务必须先做24小时新鲜度门禁');
assert.strictEqual(getJobDefinition('hk_rate').freshnessGate, false,
  '调度器不得用24小时新鲜度门禁跳过收盘后的最终汇率刷新');
assert.ok(/REALTIME_RATE_MAX_AGE_MS/.test(hkRate)
  && /exchange_rate_realtime/.test(hkRate)
  && /ensureRealtimeHkRate\(\{ force: true \}\)/.test(hkRate),
  '汇率必须支持盘中 5 分钟缓存和收盘强制刷新');
assert.ok(/finance\.yahoo\.co\.jp\/quote\/HKDCNY%3DX/.test(hkRate)
  && /parseRealtimeHkRateHtml/.test(hkRate),
  '盘中汇率必须使用生产可访问的实时行情页并解析有效报价');
assert.ok(/300000/.test(coreAccount) && /fetchHKRate\(realtime\)/.test(coreQuote)
  && /timeZone: 'Asia\/Shanghai'/.test(utils),
  '港股持仓必须每5分钟请求盘中汇率，并按北京时间判断交易时段');
assert.ok(/apiName: e\.apiName/.test(hkRate) && /credentialProfile: e\.credentialProfile/.test(hkRate)
  && /budgetWindow: e\.budgetWindow/.test(hkRate), '汇率任务必须完整传递结构化 Guard 字段');
assert.ok(/migration135ExchangeRateBudgetRecovery/.test(migrations)
  && /min_interval_ms=86400000/.test(migrations)
  && /detail LIKE '%达到日保护线%'/.test(migrations)
  && /migration158RealtimeExchangeRatePolicy/.test(migrations)
  && /exchange_rate_realtime/.test(migrations),
  '必须提供每日汇率策略恢复和盘中实时接口策略迁移');

console.log('港币汇率限额/熔断回归检查通过');
