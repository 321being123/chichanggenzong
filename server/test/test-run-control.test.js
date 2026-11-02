// N0 同机测试运行控制回归（方案 10.7 A/B/C/D）。
//
// 覆盖：跨进程互斥与顺序等待、全有或全无领取、失主残留回收、存活持有者不可抢、
// 伪造授权不通过、父子复用授权、等待有上限、超时终止整棵进程树。
// 本文件使用独立的 TEST_CONTROL_ROOT，不触碰真实控制目录，也不连接数据库。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SANDBOX = path.join(os.tmpdir(), 'test-run-control-' + process.pid + '-' + Date.now());
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.TEST_CONTROL_ROOT = SANDBOX;
delete process.env.TEST_RUN_ID;
delete process.env.TEST_RUN_LOCK_OWNER_PID;

const runControl = require('./lib/testRunControl');

const MODULE_PATH = path.join(__dirname, 'lib', 'testRunControl.js');
const RESOURCE = 'pg:localhost:5432/portfolio_test';
const RESOURCE_B = 'dir:' + path.join(SANDBOX, 'shared-b');

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    failures.push(name + ' :: ' + error.message);
    console.log('  ✗ ' + name + ' :: ' + error.message);
  }
}

function readLockRecord(resource) {
  const file = path.join(runControl.LOCK_DIR, require('crypto').createHash('sha1').update(resource).digest('hex').slice(0, 24) + '.lock');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeFakeLock(resource, record) {
  fs.mkdirSync(runControl.LOCK_DIR, { recursive: true });
  const file = path.join(runControl.LOCK_DIR, require('crypto').createHash('sha1').update(resource).digest('hex').slice(0, 24) + '.lock');
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

const CHILD_ACQUIRE = `
const ctl = require(process.env.CHILD_MODULE);
const resource = process.env.CHILD_RESOURCE;
const holdMs = Number(process.env.CHILD_HOLD_MS || 0);
const t0 = Date.now();
ctl.acquireLock({
  runId: process.env.CHILD_RUN_ID,
  label: 'child',
  resources: [resource],
  waitTimeoutMs: 20000,
  pollMs: 50,
  log: (m) => console.log('CHILD_LOG ' + m),
}).then(async (lease) => {
  console.log('ACQUIRED_AT ' + Date.now());
  console.log('WAITED_MS ' + lease.waitMs);
  await new Promise(r => setTimeout(r, holdMs));
  lease.release();
  console.log('RELEASED_AT ' + Date.now());
  process.exit(0);
}).catch((error) => {
  console.log('CHILD_ERROR ' + error.code + ' ' + error.message);
  process.exit(3);
});
`;

function childEnv(extra) {
  return { ...process.env, TEST_CONTROL_ROOT: SANDBOX, CHILD_MODULE: MODULE_PATH, CHILD_RESOURCE: RESOURCE, ...extra };
}

function pickNumber(out, tag) {
  const m = out.match(new RegExp(tag + ' (\\d+)'));
  return m ? Number(m[1]) : null;
}

(async () => {
  console.log('【1】标识与基础令牌');
  await test('runId 唯一且带前缀', async () => {
    const a = runControl.newRunId('t');
    const b = runControl.newRunId('t');
    assert.notStrictEqual(a, b);
    assert.ok(/^t-/.test(a));
  });

  await test('资源标识不含密码等敏感值', async () => {
    const key = runControl.pgResource('portfolio_test');
    assert.strictEqual(key, 'pg:localhost:5432/portfolio_test');
    assert.ok(!/password|pwd/i.test(key));
  });

  console.log('\n【2】互斥与排队');
  await test('同一资源第二次领取会等待并超时（不抢跑）', async () => {
    const lease = await runControl.acquireLock({
      prefix: 't', label: 'holder', resources: [RESOURCE], waitTimeoutMs: 5000, pollMs: 50, log: () => {},
    });
    try {
      let code = null;
      try {
        await runControl.acquireLock({
          prefix: 't', label: 'second', resources: [RESOURCE], waitTimeoutMs: 600, pollMs: 50, log: () => {},
        });
      } catch (error) { code = error.code; }
      assert.strictEqual(code, 'TEST_RESOURCE_WAIT_TIMEOUT');
    } finally {
      lease.release();
    }
    // 释放后应立即可领
    const again = await runControl.acquireLock({
      prefix: 't', label: 'after-release', resources: [RESOURCE], waitTimeoutMs: 1000, pollMs: 50, log: () => {},
    });
    assert.ok(again);
    again.release();
    assert.strictEqual(readLockRecord(RESOURCE), null, '释放后不应残留锁记录');
  });

  await test('全有或全无：一个资源被占时不得留下部分领取', async () => {
    const holder = await runControl.acquireLock({
      prefix: 't', label: 'holder-b', resources: [RESOURCE_B], waitTimeoutMs: 5000, pollMs: 50, log: () => {},
    });
    try {
      let failed = false;
      try {
        await runControl.acquireLock({
          prefix: 't', label: 'all-or-nothing', resources: [RESOURCE, RESOURCE_B], waitTimeoutMs: 500, pollMs: 50, log: () => {},
        });
      } catch (error) { failed = error.code === 'TEST_RESOURCE_WAIT_TIMEOUT'; }
      assert.ok(failed, '应因第二个资源被占而失败');
      assert.strictEqual(readLockRecord(RESOURCE), null, '失败后不得残留第一个资源的锁');
    } finally {
      holder.release();
    }
  });

  await test('跨进程：后来者等前者退出后才进入，时间不重叠', async () => {
    const first = runControl.spawnWithTimeout(process.execPath, ['-e', CHILD_ACQUIRE], {
      env: childEnv({ CHILD_RUN_ID: 'child-first', CHILD_HOLD_MS: '900' }), timeoutMs: 15000,
    });
    await new Promise(r => setTimeout(r, 300));
    const second = runControl.spawnWithTimeout(process.execPath, ['-e', CHILD_ACQUIRE], {
      env: childEnv({ CHILD_RUN_ID: 'child-second', CHILD_HOLD_MS: '0' }), timeoutMs: 15000,
    });
    const [r1, r2] = await Promise.all([first, second]);
    assert.strictEqual(r1.status, 0, '第一个子进程应成功：' + r1.out);
    assert.strictEqual(r2.status, 0, '第二个子进程应成功：' + r2.out);
    const firstReleased = pickNumber(r1.out, 'RELEASED_AT');
    const secondAcquired = pickNumber(r2.out, 'ACQUIRED_AT');
    assert.ok(firstReleased && secondAcquired, '缺少时间戳证据');
    assert.ok(secondAcquired >= firstReleased, '后来者不得在前者释放前拿到资源');
    assert.ok(pickNumber(r2.out, 'WAITED_MS') >= 200, '后来者应记录等待时长');
  });

  console.log('\n【3】残留与异常');
  await test('持有进程已消失的残留锁可回收', async () => {
    // 2026-11-02 起锁记录必须带「子进程登记」：父进程消失只是必要条件，
    // 还要能证明它没有遗留子进程在跑。空数组＝已确认没有子进程。
    writeFakeLock(RESOURCE, {
      runId: 'dead-run', ownerPid: 999999, label: 'crashed', startedAt: new Date().toISOString(),
      host: os.hostname(), children: [],
    });
    const lease = await runControl.acquireLock({
      prefix: 't', label: 'reclaimer', resources: [RESOURCE], waitTimeoutMs: 3000, pollMs: 50, log: () => {},
    });
    assert.ok(lease);
    lease.release();
  });

  await test('持有进程仍存活时不回收（宁可阻塞不抢跑）', async () => {
    writeFakeLock(RESOURCE, {
      runId: 'alive-run', ownerPid: process.pid, label: 'alive', startedAt: new Date().toISOString(),
      host: os.hostname(),
    });
    let code = null;
    try {
      await runControl.acquireLock({
        prefix: 't', label: 'waiter', resources: [RESOURCE], waitTimeoutMs: 600, pollMs: 50, log: () => {},
      });
    } catch (error) { code = error.code; }
    assert.strictEqual(code, 'TEST_RESOURCE_WAIT_TIMEOUT');
    assert.strictEqual(readLockRecord(RESOURCE).runId, 'alive-run', '不得删除他人锁记录');
    fs.unlinkSync(path.join(runControl.LOCK_DIR,
      require('crypto').createHash('sha1').update(RESOURCE).digest('hex').slice(0, 24) + '.lock'));
  });

  await test('release 只认自己的 runId + PID', async () => {
    const lease = await runControl.acquireLock({
      prefix: 't', label: 'own', resources: [RESOURCE], waitTimeoutMs: 3000, pollMs: 50, log: () => {},
    });
    const before = readLockRecord(RESOURCE);
    // 冒名 release：把记录改成别人的 runId，再调用 releaseByRunId 也不应被清
    writeFakeLock(RESOURCE, { ...before, runId: 'someone-else', ownerPid: 999999 });
    const outcome = runControl.releaseByRunId(lease.runId);
    assert.deepStrictEqual(outcome.released, [], '不匹配的记录不得被回收');
    assert.strictEqual(readLockRecord(RESOURCE).runId, 'someone-else');
    fs.unlinkSync(path.join(runControl.LOCK_DIR,
      require('crypto').createHash('sha1').update(RESOURCE).digest('hex').slice(0, 24) + '.lock'));
  });

  console.log('\n【4】父子授权复用');
  await test('只有 runId/PID 与锁记录一致才复用，伪造不通过', async () => {
    const lease = await runControl.acquireLock({
      prefix: 't', label: 'parent', resources: [RESOURCE], waitTimeoutMs: 3000, pollMs: 50, log: () => {},
    });
    try {
      process.env.TEST_RUN_ID = lease.runId;
      process.env.TEST_RUN_LOCK_OWNER_PID = String(process.pid);
      const ok = runControl.inheritRunContext({ resources: [RESOURCE] });
      assert.ok(ok && ok.runId === lease.runId, '一致时应复用');

      process.env.TEST_RUN_ID = 'forged-run';
      assert.strictEqual(runControl.inheritRunContext({ resources: [RESOURCE] }), null, '伪造 runId 不得通过');

      process.env.TEST_RUN_ID = lease.runId;
      process.env.TEST_RUN_LOCK_OWNER_PID = '999999';
      assert.strictEqual(runControl.inheritRunContext({ resources: [RESOURCE] }), null, 'PID 不存活不得通过');
    } finally {
      delete process.env.TEST_RUN_ID;
      delete process.env.TEST_RUN_LOCK_OWNER_PID;
      lease.release();
    }
  });

  console.log('\n【5】监督与进程树退出');
  await test('正常退出返回原状态码与输出', async () => {
    const r = await runControl.spawnWithTimeout(process.execPath, ['-e', "console.log('hello'); process.exit(0)"], { timeoutMs: 10000 });
    assert.strictEqual(r.status, 0);
    assert.ok(/hello/.test(r.out));
    assert.ok(!r.timedOut);
  });

  await test('超时后连孙进程一起终止，并留下证据', async () => {
    // 子进程再拉一个孙进程：如果只杀直接子进程，孙进程会残留 60 秒。
    const script = `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      const grand = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(process.env.PID_DIR, 'grand.pid'), String(grand.pid));
      fs.writeFileSync(path.join(process.env.PID_DIR, 'child.pid'), String(process.pid));
      setTimeout(()=>{}, 60000);
    `;
    const pidDir = path.join(SANDBOX, 'pid-' + Date.now());
    fs.mkdirSync(pidDir, { recursive: true });
    const r = await runControl.spawnWithTimeout(process.execPath, ['-e', script], {
      env: { ...process.env, PID_DIR: pidDir }, timeoutMs: 2500,
    });
    assert.ok(r.timedOut, '应判定为超时');
    assert.ok(r.treeKill && /taskkill|SIGTERM/.test(r.treeKill.method), '应记录终止方式');
    const childPid = Number(fs.readFileSync(path.join(pidDir, 'child.pid'), 'utf8'));
    const grandPid = Number(fs.readFileSync(path.join(pidDir, 'grand.pid'), 'utf8'));
    // 给操作系统回收一点时间后确认两者都已不在
    await new Promise(res => setTimeout(res, 800));
    assert.strictEqual(runControl.isProcessAlive(childPid), false, '直接子进程应已退出');
    assert.strictEqual(runControl.isProcessAlive(grandPid), false, '孙进程也应随进程树一起退出');
  });

  console.log('\n========================================');
  console.log('run-control：通过 ' + pass + ' · 失败 ' + fail + (fail ? ' · ' + failures.join(' | ') : ''));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
  process.exit(fail ? 1 : 0);
})();
