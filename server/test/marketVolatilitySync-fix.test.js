// ========== 市场波动同步整改回归（P0-1 / P2-2 验收）==========
// 运行：node server/test/marketVolatilitySync-fix.test.js
// 目的：防止 P0-1 问题回潮——总市值链路必须按目标交易日聚合、单位换算正确、
//       覆盖不足时回退 Tushare、写库统一使用 securityCount。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const job = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'marketVolatilitySync.js'), 'utf8');
const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'stockDataService.js'), 'utf8');

// P0-1-①：统一层必须显式接收目标交易日，不能无参聚合"每只最新值"
assert.ok(job.includes('getTotalMarketCap(normDate(day))'), '统一层聚合未传目标交易日');
assert.ok(svc.includes('async function getTotalMarketCap(tradeDate)'), 'getTotalMarketCap 未接收 tradeDate 参数');
assert.ok(svc.includes('dv.trade_date = $1'), 'getTotalMarketCap 未按 trade_date 过滤完整分区');
assert.ok(svc.includes("i.asset_class = 'stock'"), 'getTotalMarketCap 未限定股票资产类别');

// P0-1-②：单位换算——daily_valuations 为元，写入亿元列须除以 1e8；Tushare 万元 ÷ 1e4
assert.ok(job.includes('YUAN_TO_100M = 100000000'), '统一层元→亿元换算常量缺失');
assert.ok(job.includes('/ YUAN_TO_100M'), '统一层总市值未从元换算为亿元');
assert.ok(job.includes('/ 10000'), 'Tushare total_mv 未从万元换算为亿元');
assert.ok(!job.includes('totalWan / 10000'), '旧的万元误标注逻辑仍存在');
assert.ok(!job.includes('totalWan = Number(cap.total_cap)'), '统一层结果仍被误当万元');

// P0-1-③：覆盖完整性门禁——证券数不足时拒绝统一表并回退
assert.ok(job.includes('MIN_UNIFIED_MARKET_COUNT'), '统一表覆盖门禁常量缺失');
assert.ok(job.includes('cap.stock_count >= MIN_UNIFIED_MARKET_COUNT'), '统一表未按门禁校验证券数量');

// P0-1-④：写库统一使用 securityCount，禁止引用分支局部变量 rows
assert.ok(job.includes('[normDate(day), totalYi, securityCount,'), '写库未统一使用 securityCount');
assert.ok(!/\brows\.length\b/.test(job.split('INSERT INTO market.a_share_market_cap_daily')[1] || ''), '写库参数仍引用 rows.length');

// P0-1-⑤：回退数据验证（数量、有效市值占比）与异常保留上一份数据
assert.ok(job.includes('rows.length < 1000'), '回退未验证证券数量下限');
assert.ok(job.includes('valid.length / rows.length < 0.8'), '回退未验证有效市值占比');
assert.ok(job.includes('if (!fromUnified) await wait(350)'), '回退 Tushare 后未限流');

// 验收结论
console.log('marketVolatilitySync fix tests passed');
