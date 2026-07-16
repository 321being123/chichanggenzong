// P1-4 回归：行情缓存 single-flight 与失败负缓存
// 目标：冷缓存并发时上游只被打一次；命中有效缓存不再打；失败时短时负缓存防打穿。
const assert = require('assert');
const { withSingleFlight, NEG_TTL_MS } = require('../services/market');

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

  console.log('\n通过 ' + passed + ' 项');
}

main()
  .then(() => { if (process.exitCode) { console.error('存在失败用例'); process.exit(1); } process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
