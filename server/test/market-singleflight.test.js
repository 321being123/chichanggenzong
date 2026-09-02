// P1-4 回归：行情缓存 single-flight 与失败负缓存
// 目标：冷缓存并发时上游只被打一次；命中有效缓存不再打；失败时短时负缓存防打穿。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  withSingleFlight, NEG_TTL_MS,
  quoteDateCN, isCnTradingDate, validateDailyPriceBatch, normalizeDailyQuoteRow,
} = require('../services/market');

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

async function main() {
  console.log('行情缓存 single-flight（P1-4）:');

  // 1. 冷缓存并发：同一刷新期内 loader 仅执行一次（single-flight 核心）
  await check('并发请求复用同一 Promise，loader 只跑一次', async () => {
    const state = { map: null, ts: 0, inflight: null, failedAt: 0 };
    let calls = 0;
    const loader = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return new Map([['a', 1]]); };
    const [m1, m2] = await Promise.all([
      withSingleFlight(state, 60000, loader),
      withSingleFlight(state, 60000, loader)
    ]);
    assert.strictEqual(calls, 1, '并发时 loader 应只执行一次');
    assert.strictEqual(m1, m2, '两次应返回同一结果对象');
    assert.ok(state.map && state.map.get('a') === 1, '结果应已写入缓存');
  });

  // 2. 命中有效缓存：不再调用 loader
  await check('命中有效缓存不重复调用 loader', async () => {
    const state = { map: new Map([['x', 9]]), ts: Date.now(), inflight: null, failedAt: 0 };
    let calls = 0;
    const m = await withSingleFlight(state, 60000, async () => { calls++; return new Map(); });
    assert.strictEqual(calls, 0, '命中缓存不应再调用 loader');
    assert.strictEqual(m.get('x'), 9, '应返回已缓存数据');
  });

  // 3. 失败负缓存：失败后短期内复用空结果，不重复打穿上游
  await check('失败负缓存：期内不重试，过期后重试', async () => {
    const state = { map: null, ts: 0, inflight: null, failedAt: 0 };
    let calls = 0;
    const loader = async () => { calls++; throw new Error('upstream fail'); };
    await withSingleFlight(state, 60000, loader);
    assert.strictEqual(calls, 1, '首次失败应调用一次 loader');
    assert.ok(state.failedAt > 0, '应记录失败时间');
    await withSingleFlight(state, 60000, loader); // 期内
    assert.strictEqual(calls, 1, '负缓存期内不应重试');
    state.failedAt = Date.now() - (NEG_TTL_MS + 1000); // 模拟过期
    await withSingleFlight(state, 60000, loader);
    assert.strictEqual(calls, 2, '负缓存过期后应再次尝试');
  });

  await check('Tushare 日线保留交易日期供收盘校验', async () => {
    const quote = normalizeDailyQuoteRow({ trade_date: '20260824', close: '12.30', pre_close: '12.00', pct_chg: '2.50' });
    assert.strictEqual(quote.quote_time, '2026-08-24T15:00:00+08:00');
    assert.strictEqual(quoteDateCN(quote.quote_time), '2026-08-24');
  });

  await check('收盘价批次拒绝休市日、缺日期和跨日行情', async () => {
    assert.strictEqual(isCnTradingDate('2026-08-22'), false, '周末不得写收盘价');
    assert.strictEqual(isCnTradingDate('2026-10-01'), false, '法定节假日不得写收盘价');
    assert.strictEqual(validateDailyPriceBatch('2026-08-24', [{ code: '600000', quote_time: null }]).ok, false);
    assert.strictEqual(validateDailyPriceBatch('2026-08-24', [{ code: '600000', quote_time: '2026-08-21T15:00:00+08:00' }]).ok, false);
    assert.strictEqual(validateDailyPriceBatch('2026-08-24', [{ code: '600000', quote_time: '2026-08-24T15:00:00+08:00' }]).ok, true);
  });

  await check('行情与收盘价路由接入日期校验', async () => {
    const routesDir = path.join(__dirname, '..', 'routes');
    const servicesDir = path.join(__dirname, '..', 'services');
    const marketRoute = fs.readFileSync(path.join(routesDir, 'market.js'), 'utf8');
    const marketService = fs.readFileSync(path.join(servicesDir, 'market.js'), 'utf8');
    const accountsRoute = fs.readFileSync(path.join(routesDir, 'accounts.js'), 'utf8');
    assert.ok(marketService.includes("quote_time: quote ? quote.quote_time : (d && d.quote_time || null)"), '批量行情回退未透传 Tushare 日期');
    assert.ok(accountsRoute.includes('validateDailyPriceBatch(targetDate, prices)'), '收盘价写接口未执行服务端日期校验');
  });

  console.log('\n通过 ' + passed + ' 项');
}

main()
  .then(() => { if (process.exitCode) { console.error('存在失败用例'); process.exit(1); } process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
