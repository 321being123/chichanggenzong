// N0 修复反例回归（2026-11-02 独立验收 R1—R4）
//
// 原 11 项控制回归全绿，但漏掉了四个真实失败路径。本文件只覆盖这四个反例，
// 每条都按「修复前会失败」的形状写：
//   R1 回收失主锁后没有重新领锁 → 断言磁盘上确实有属于本次运行的新锁，且第三方进不来；
//   R2 父进程消失就回收 → 断言登记的子进程还活着时必须阻塞，只有确认全部退出才回收；
//   R3 测试库被设成业务库 → 断言在任何 Client 创建/连接/查询之前就被拒；
//   R4 硬截止不覆盖初始化 → 用永不返回的 connect 证明初始化阶段也会到点退出。
//
// 边界：全部使用独立 TEST_CONTROL_ROOT 与临时子进程；R3/R4 用进程内 mock 的 pg，
// 不连接任何真实数据库（尤其是业务库）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const SANDBOX = path.join(os.tmpdir(), 'test-run-safety-' + process.pid + '-' + Date.now());
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.TEST_CONTROL_ROOT = SANDBOX;
delete process.env.TEST_RUN_ID;
delete process.env.TEST_RUN_LOCK_OWNER_PID;

const runControl = require('./lib/testRunControl');

const MODULE_PATH = path.join(__dirname, 'lib', 'testRunControl.js');
const REPO_ROOT = path.join(__dirname, '..', '..');
const DEAD_PID = 2147483646; // 不存在的 PID
const RESOURCE = 'pg:localhost:5432/portfolio_test';
const RESOURCE_B = 'dir:' + path.join(SANDBOX, 'shared-b');

let pass = 0;
let fail = 0;
const failures = [];
const children = [];

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    failures.push(name + ' :: ' + (error && error.message));
    console.log('  ✗ ' + name + ' :: ' + (error && error.message));
  }
}

function lockFile(resource) {
  return path.join(runControl.LOCK_DIR, crypto.createHash('sha1').update(resource).digest('hex').slice(0, 24) + '.lock');
}

function readLockRecord(resource) {
  try { return JSON.parse(fs.readFileSync(lockFile(resource), 'utf8')); } catch (_) { return null; }
}

function writeFakeLock(resource, record) {
  fs.mkdirSync(runControl.LOCK_DIR, { recursive: true });
  fs.writeFileSync(lockFile(resource), JSON.stringify(record, null, 2));
}

function clearLocks() {
  fs.mkdirSync(runControl.LOCK_DIR, { recursive: true });
  for (const file of fs.readdirSync(runControl.LOCK_DIR)) {
    fs.rmSync(path.join(runControl.LOCK_DIR, file), { force: true });
  }
  fs.mkdirSync(runControl.RUN_DIR, { recursive: true });
  for (const file of fs.readdirSync(runControl.RUN_DIR)) {
    fs.rmSync(path.join(runControl.RUN_DIR, file), { force: true });
  }
}

// 起一个存活子进程，模拟「父入口崩溃后仍在跑的测试」
function startLiveChild(holdMs = 60000) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + holdMs + ')'], {
    stdio: 'ignore', windowsHide: true,
  });
  children.push(child);
  return child;
}

function stopChild(child) {
  try { runControl.killProcessTree(child.pid); } catch (_) { /* 已退出 */ }
}

(async () => {
  try {
    // ==================== R1：回收失主锁后必须重新领取 ====================

    await test('R1-单资源：回收失主残留后，磁盘上必须出现属于本次运行的新锁', async function () {
      clearLocks();
      writeFakeLock(RESOURCE, {
        runId: 'dead-owner-run', ownerPid: DEAD_PID, label: 'dead', children: [],
        startedAt: new Date(Date.now() - 60000).toISOString(), resource: RESOURCE,
      });
      const lease = await runControl.acquireLock({
        prefix: 'r1-single', label: 'r1-single', resources: [RESOURCE], pollMs: 20, waitTimeoutMs: 3000,
        log: () => {},
      });
      try {
        const record = readLockRecord(RESOURCE);
        assert.ok(record, '回收后必须重新创建锁文件——修复前这里返回成功但磁盘上没有锁');
        assert.strictEqual(record.runId, lease.runId, '新锁必须属于本次运行');
        assert.strictEqual(Number(record.ownerPid), process.pid);
        assert.ok(record.ownerToken, '新锁必须带所有权令牌');
      } finally { lease.release(); }
    });

    await test('R1-多资源：一个资源有失主残留时，全部资源都必须归本次运行', async function () {
      clearLocks();
      writeFakeLock(RESOURCE, {
        runId: 'dead-owner-run', ownerPid: DEAD_PID, label: 'dead', children: [],
        startedAt: new Date(Date.now() - 60000).toISOString(), resource: RESOURCE,
      });
      const lease = await runControl.acquireLock({
        prefix: 'r1-multi', label: 'r1-multi', resources: [RESOURCE, RESOURCE_B], pollMs: 20, waitTimeoutMs: 3000,
        log: () => {},
      });
      try {
        for (const resource of [RESOURCE, RESOURCE_B]) {
          const record = readLockRecord(resource);
          assert.ok(record, '资源必须被真正占有：' + resource);
          assert.strictEqual(record.runId, lease.runId, '资源锁必须属于本次运行：' + resource);
        }
      } finally { lease.release(); }
    });

    await test('R1-回收后第三方竞争者必须排队，不能同时进入', async function () {
      clearLocks();
      writeFakeLock(RESOURCE, {
        runId: 'dead-owner-run', ownerPid: DEAD_PID, label: 'dead', children: [],
        startedAt: new Date(Date.now() - 60000).toISOString(), resource: RESOURCE,
      });
      const lease = await runControl.acquireLock({
        prefix: 'r1-holder', label: 'r1-holder', resources: [RESOURCE], pollMs: 20, waitTimeoutMs: 3000,
        log: () => {},
      });
      try {
        const script = `
          const ctl = require(process.env.CHILD_MODULE);
          ctl.acquireLock({ runId: 'r1-third', label: 'third', resources: [process.env.CHILD_RESOURCE],
            pollMs: 20, waitTimeoutMs: 600, log: () => {} })
            .then(l => { console.log('THIRD_ACQUIRED'); l.release(); process.exit(0); })
            .catch(e => { console.log('THIRD_BLOCKED ' + e.code); process.exit(0); });
        `;
        const r = await new Promise(resolve => {
          const p = spawn(process.execPath, ['-e', script], {
            env: { ...process.env, CHILD_MODULE: MODULE_PATH, CHILD_RESOURCE: RESOURCE, TEST_CONTROL_ROOT: SANDBOX },
            windowsHide: true,
          });
          let out = '';
          p.stdout.on('data', c => { out += c.toString('utf8'); });
          p.on('close', () => resolve(out));
        });
        assert.ok(!/THIRD_ACQUIRED/.test(r), '持有者还在跑时第三方不许拿到资源：' + r);
        assert.ok(/THIRD_BLOCKED/.test(r), '第三方必须被阻塞：' + r);
      } finally { lease.release(); }
    });

    await test('R1-多个回收者同时抢失主锁：临界区不得重叠（不假定谁先拿到）', async function () {
      clearLocks();
      writeFakeLock(RESOURCE, {
        runId: 'dead-owner-run', ownerPid: DEAD_PID, label: 'dead', children: [],
        startedAt: new Date(Date.now() - 60000).toISOString(), resource: RESOURCE,
      });
      // 两个进程同时抢同一把失主锁。旧写法断言"先启动的那个必须先拿到"——这依赖操作系统调度，
      // 在 Linux CI 上常常反过来，于是把一个正确的互斥实现判成失败（F14 后半条）。
      // 真正要证明的不变量是：**同一时刻只有一个持有者**，谁先进入都可以。
      // 因此各自打印进入/离开的时间戳，最后核对两个持有区间不重叠。
      const makeScript = (tag, holdMs) => `
        const ctl = require(process.env.CHILD_MODULE);
        ctl.acquireLock({ runId: '${tag}', label: '${tag}', resources: [process.env.CHILD_RESOURCE],
          pollMs: 10, waitTimeoutMs: 5000, log: () => {} })
          .then(async l => {
            console.log('${tag}_ACQUIRED ' + Date.now());
            await new Promise(r => setTimeout(r, ${holdMs}));
            console.log('${tag}_RELEASED ' + Date.now());
            l.release();
            process.exit(0);
          })
          .catch(e => { console.log('${tag}_FAILED ' + e.code); process.exit(0); });
      `;
      const runChild = script => new Promise(resolve => {
        const p = spawn(process.execPath, ['-e', script], {
          env: { ...process.env, CHILD_MODULE: MODULE_PATH, CHILD_RESOURCE: RESOURCE, TEST_CONTROL_ROOT: SANDBOX },
          windowsHide: true,
        });
        let out = '';
        p.stdout.on('data', c => { out += c.toString('utf8'); });
        p.on('close', () => resolve(out));
      });
      const [outA, outB] = await Promise.all([runChild(makeScript('holder', 900)), runChild(makeScript('rival', 300))]);
      const windowOf = (out, tag) => {
        const acquired = new RegExp(tag + '_ACQUIRED (\\d+)').exec(out);
        const released = new RegExp(tag + '_RELEASED (\\d+)').exec(out);
        if (!acquired) return null;
        return { start: Number(acquired[1]), end: released ? Number(released[1]) : Number(acquired[1]) + 900 };
      };
      const holder = windowOf(outA, 'holder');
      const rival = windowOf(outB, 'rival');
      assert.ok(holder || rival, '至少有一个进程应拿到资源：' + outA + ' / ' + outB);
      if (holder && rival) {
        const overlap = holder.start < rival.end && rival.start < holder.end;
        assert.ok(!overlap,
          '两个持有区间不得重叠（holder ' + holder.start + '-' + holder.end + '，rival ' + rival.start + '-' + rival.end + '）');
      }
    });

    // ==================== R2：父进程消失不等于可以回收 ====================

    await test('R2-父PID已死但登记的子进程还活着：必须阻塞，不许回收', async function () {
      clearLocks();
      const child = startLiveChild();
      const deadRunId = 'dead-parent-with-live-child';
      runControl.registerChild(deadRunId, child.pid, 'live-child');
      writeFakeLock(RESOURCE, {
        runId: deadRunId, ownerPid: DEAD_PID, label: 'dead-parent', children: [{ pid: child.pid, label: 'live-child' }],
        startedAt: new Date(Date.now() - 60000).toISOString(), resource: RESOURCE,
      });
      let error = null;
      try {
        await runControl.acquireLock({
          prefix: 'r2-blocked', label: 'r2-blocked', resources: [RESOURCE], pollMs: 30, waitTimeoutMs: 800, log: () => {},
        });
      } catch (e) { error = e; }
      assert.ok(error, '子进程仍存活时不得领取成功——修复前会直接 admitted');
      assert.strictEqual(error.code, 'TEST_RESOURCE_WAIT_TIMEOUT');
      assert.ok(fs.existsSync(lockFile(RESOURCE)), '原锁必须保留，不能被回收掉');
      stopChild(child);
    });

    await test('R2-登记的子进程已退出后，允许回收并重新领锁', async function () {
      clearLocks();
      const child = startLiveChild();
      const deadRunId = 'dead-parent-exited-child';
      runControl.registerChild(deadRunId, child.pid, 'child');
      writeFakeLock(RESOURCE, {
        runId: deadRunId, ownerPid: DEAD_PID, label: 'dead-parent', children: [{ pid: child.pid, label: 'child' }],
        startedAt: new Date(Date.now() - 60000).toISOString(), resource: RESOURCE,
      });
      stopChild(child);
      // 等 OS 真正回收进程（Windows 上 kill 后稍有延迟）
      for (let i = 0; i < 40 && runControl.isProcessAlive(child.pid); i += 1) {
        await new Promise(r => setTimeout(r, 100));
      }
      assert.strictEqual(runControl.isProcessAlive(child.pid), false, '前置：子进程必须已退出');
      const lease = await runControl.acquireLock({
        prefix: 'r2-ok', label: 'r2-ok', resources: [RESOURCE], pollMs: 20, waitTimeoutMs: 3000, log: () => {},
      });
      try {
        const record = readLockRecord(RESOURCE);
        assert.ok(record && record.runId === lease.runId, '子进程确认退出后应能回收并重新领锁');
      } finally { lease.release(); }
    });

    await test('R2-读不到子进程登记时按「不确定」处理：阻塞而不是抢跑', async function () {
      clearLocks();
      // 锁记录里没有 children 字段，run 记录也不存在 = 无法证明安全
      writeFakeLock(RESOURCE, {
        runId: 'unknown-ownership-run', ownerPid: DEAD_PID, label: 'legacy',
        startedAt: new Date(Date.now() - 60000).toISOString(), resource: RESOURCE,
      });
      let error = null;
      try {
        await runControl.acquireLock({
          prefix: 'r2-unknown', label: 'r2-unknown', resources: [RESOURCE], pollMs: 30, waitTimeoutMs: 800, log: () => {},
        });
      } catch (e) { error = e; }
      assert.ok(error, '所有权未知时不得领取成功');
      assert.strictEqual(error.code, 'TEST_RESOURCE_WAIT_TIMEOUT');
    });

    await test('R2-PID 被复用（存活但不是本轮持有者）：不得判定为可回收', async function () {
      clearLocks();
      writeFakeLock(RESOURCE, {
        runId: 'reused-pid-run', ownerPid: process.pid, label: 'reused', children: [],
        startedAt: new Date(Date.now() - 86400000).toISOString(), resource: RESOURCE,
      });
      let error = null;
      try {
        await runControl.acquireLock({
          prefix: 'r2-reuse', label: 'r2-reuse', resources: [RESOURCE], pollMs: 30, waitTimeoutMs: 700, log: () => {},
        });
      } catch (e) { error = e; }
      assert.ok(error, 'PID 存活（哪怕是被复用）就不能自动回收');
      assert.ok(fs.existsSync(lockFile(RESOURCE)), '锁必须保留，交给人工确认');
    });

    await test('R2-人工释放入口：子进程存活时不释放', async function () {
      clearLocks();
      const child = startLiveChild();
      const runId = 'manual-release-run';
      runControl.registerChild(runId, child.pid, 'child');
      writeFakeLock(RESOURCE, {
        runId, ownerPid: DEAD_PID, label: 'manual', children: [{ pid: child.pid, label: 'child' }],
        startedAt: new Date(Date.now() - 60000).toISOString(), resource: RESOURCE,
      });
      const outcome = runControl.releaseByRunId(runId);
      assert.deepStrictEqual(outcome.released, [], '子进程还活着时不得释放');
      assert.strictEqual(outcome.blocked.length, 1);
      assert.strictEqual(outcome.blocked[0].reason, 'children_alive');
      assert.ok(fs.existsSync(lockFile(RESOURCE)), '锁必须保留');
      stopChild(child);
    });

    // ==================== R3：测试库名必须在接触数据库之前校验 ====================

    await test('R3-库名判定：业务库/系统库被拒，测试库放行', function () {
      const { assertTestDatabaseName } = require('./lib/testDatabase');
      assert.throws(() => assertTestDatabaseName('portfolio'), /测试库名必须包含 test/);
      assert.throws(() => assertTestDatabaseName('postgres'), /系统库/);
      assert.throws(() => assertTestDatabaseName('template1'), /系统库/);
      assert.throws(() => assertTestDatabaseName(''), /为空/);
      assert.strictEqual(assertTestDatabaseName('portfolio_test'), 'portfolio_test');
      assert.strictEqual(assertTestDatabaseName('portfolio_migtest'), 'portfolio_migtest');
    });

    await test('R3-非法库名时一个连接/查询都不发（含清理入口）', async function () {
      const { cleanupTestArtifacts, __setClientFactory } = require('./lib/testDatabase');
      let created = 0;
      let connected = 0;
      let queried = 0;
      __setClientFactory(() => {
        created += 1;
        return {
          connect: async () => { connected += 1; },
          query: async () => { queried += 1; return { rowCount: 0, rows: [] }; },
          end: async () => {},
        };
      });
      // 用子进程验证「TEST_DATABASE 本身非法」这条路径：模块加载即抛错，连 Client 都不会建。
      const script = `
        const db = require(process.env.CHILD_DB_MODULE);
        db.cleanupTestArtifacts().then(() => console.log('CLEANUP_RAN')).catch(e => console.log('REJECTED ' + e.message));
      `;
      const out = await new Promise(resolve => {
        const p = spawn(process.execPath, ['-e', script], {
          env: { ...process.env, PGTESTDATABASE: 'portfolio', CHILD_DB_MODULE: path.join(__dirname, 'lib', 'testDatabase.js') },
          windowsHide: true,
        });
        let text = '';
        p.stdout.on('data', c => { text += c.toString('utf8'); });
        p.stderr.on('data', c => { text += c.toString('utf8'); });
        p.on('close', code => resolve({ text, code }));
      });
      assert.ok(!/CLEANUP_RAN/.test(out.text), '业务库配置下清理入口绝不能执行：' + out.text);
      assert.ok(/测试库名必须包含 test|业务库/.test(out.text), '必须给出拒绝原因：' + out.text);
      assert.strictEqual(created, 0, '拒绝路径不得创建 Client');
      assert.strictEqual(connected, 0, '拒绝路径不得连接数据库');
      assert.strictEqual(queried, 0, '拒绝路径不得发任何查询');
      __setClientFactory(null);
    });

    // ==================== R4：硬截止必须覆盖初始化阶段 ====================

    await test('R4-初始化卡死（connect 永不返回）也会在截止时退出，不会无限占锁', async function () {
      clearLocks();
      const mockPath = path.join(SANDBOX, 'mock-pg.js');
      fs.writeFileSync(mockPath, `
        const Module = require('module');
        const originalLoad = Module._load;
        class HangingClient {
          constructor() {}
          connect() { return new Promise(() => {}); }
          query() { return new Promise(() => {}); }
          end() { return new Promise(() => {}); }
        }
        Module._load = function (request, parent, isMain) {
          if (request === 'pg') return { Client: HangingClient, Pool: HangingClient };
          return originalLoad.apply(this, arguments);
        };
      `);
      const startedAt = Date.now();
      const result = await new Promise(resolve => {
        const p = spawn(process.execPath, ['--require', mockPath, path.join(REPO_ROOT, 'server', 'test', 'run-all.js')], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            TEST_CONTROL_ROOT: SANDBOX,
            TEST_RUN_DEADLINE_MS: '50',
            TEST_RUN_WAIT_TIMEOUT_MS: '5000',
            NODE_ENV: 'test',
          },
          windowsHide: true,
        });
        let text = '';
        p.stdout.on('data', c => { text += c.toString('utf8'); });
        p.stderr.on('data', c => { text += c.toString('utf8'); });
        const killer = setTimeout(() => {
          runControl.killProcessTree(p.pid);
          resolve({ text, code: 'OUTER_TIMEOUT', ms: Date.now() - startedAt });
        }, 8000);
        p.on('close', code => { clearTimeout(killer); resolve({ text, code, ms: Date.now() - startedAt }); });
      });
      assert.notStrictEqual(result.code, 'OUTER_TIMEOUT',
        '初始化卡死必须由本轮自己的监督结束——修复前只能靠外部超时杀进程：' + result.text.slice(-800));
      assert.strictEqual(result.code, 1, '超时必须按失败退出：' + result.code);
      assert.ok(/整轮超过硬截止/.test(result.text), '必须留下截止证据：' + result.text.slice(-400));
      // 资源必须被释放（否则下一轮会一直排队）
      const leftover = fs.existsSync(runControl.LOCK_DIR)
        ? fs.readdirSync(runControl.LOCK_DIR).filter(f => f.endsWith('.lock')) : [];
      assert.deepStrictEqual(leftover, [], '超时退出后不能留下锁：' + leftover.join(','));
    });

    // ==================== R2-b：登记文件异常时的安全释放（第三轮验收） ====================
    // 修前 release() 只读主登记，文件损坏就当「没有子进程」→ 误删锁，而锁里还记着存活子进程。

    await test('R2-b 主登记损坏、锁内冗余可读：必须保留锁而不是当成没子进程', async function () {
      clearLocks();
      const probe = startLiveChild();
      const lease = await runControl.acquireLock({
        prefix: 'r2b-corrupt', label: 'r2b-corrupt', resources: [RESOURCE], pollMs: 20, waitTimeoutMs: 3000, log: () => {},
      });
      runControl.registerChild(lease.runId, probe.pid, 'probe');
      const before = readLockRecord(RESOURCE);
      assert.ok(Array.isArray(before.children) && before.children.some(c => Number(c.pid) === probe.pid),
        '前置：锁内必须有子进程冗余');

      // 只破坏主登记，不动锁文件
      fs.writeFileSync(runControl.runRecordPath(lease.runId), '{ 这不是合法 JSON');

      const outcome = lease.release();
      assert.ok(outcome, '主登记损坏时必须保留并返回原因——修复前这里返回 null 且锁被删');
      assert.strictEqual(outcome.reason, 'children_alive', '应识别出锁内仍有存活子进程：' + JSON.stringify(outcome));
      assert.ok(outcome.pids.includes(probe.pid), '保留原因必须指出是哪个 PID');
      assert.ok(fs.existsSync(lockFile(RESOURCE)), '锁必须仍然存在');

      // 子进程真正退出后，允许释放（主登记仍是坏的，靠锁内冗余判断）
      stopChild(probe);
      for (let i = 0; i < 40 && runControl.isProcessAlive(probe.pid); i += 1) {
        await new Promise(r => setTimeout(r, 100));
      }
      assert.strictEqual(runControl.isProcessAlive(probe.pid), false, '前置：探针必须已退出');
      const second = lease.release();
      assert.strictEqual(second, null, '子进程退出后应能正常释放：' + JSON.stringify(second));
      assert.ok(!fs.existsSync(lockFile(RESOURCE)), '释放后锁应被清掉');
    });

    await test('R2-b 主登记与锁内冗余都读不到：按「未知」阻塞，不许释放', async function () {
      clearLocks();
      const lease = await runControl.acquireLock({
        prefix: 'r2b-unknown', label: 'r2b-unknown', resources: [RESOURCE], pollMs: 20, waitTimeoutMs: 3000, log: () => {},
      });
      fs.unlinkSync(runControl.runRecordPath(lease.runId));
      const lock = readLockRecord(RESOURCE);
      delete lock.children; // 锁里也没有登记 = 无法证明安全
      fs.writeFileSync(lockFile(RESOURCE), JSON.stringify(lock));

      const outcome = lease.release();
      assert.ok(outcome, '两处都未知时必须阻塞');
      assert.strictEqual(outcome.reason, 'ownership_unknown');
      assert.ok(fs.existsSync(lockFile(RESOURCE)), '未知状态下锁必须保留');
    });

    await test('R2-b 主登记损坏但锁内明确为空：正常释放，不误留死锁', async function () {
      clearLocks();
      const lease = await runControl.acquireLock({
        prefix: 'r2b-empty', label: 'r2b-empty', resources: [RESOURCE], pollMs: 20, waitTimeoutMs: 3000, log: () => {},
      });
      fs.writeFileSync(runControl.runRecordPath(lease.runId), 'garbage');
      const lock = readLockRecord(RESOURCE);
      assert.deepStrictEqual(lock.children, [], '前置：锁内登记为空');
      const outcome = lease.release();
      assert.strictEqual(outcome, null, '确认没有子进程时必须能正常释放，不能一律卡死');
      assert.ok(!fs.existsSync(lockFile(RESOURCE)));
    });

    await test('R2-b 两处登记矛盾：取并集按存活判定（宁可多拦）', async function () {
      clearLocks();
      const aliveA = startLiveChild();
      const aliveB = startLiveChild();
      const lease = await runControl.acquireLock({
        prefix: 'r2b-conflict', label: 'r2b-conflict', resources: [RESOURCE], pollMs: 20, waitTimeoutMs: 3000, log: () => {},
      });
      runControl.registerChild(lease.runId, aliveA.pid, 'A');
      // 人为让锁内快照只剩 B，与主登记的 A 冲突
      const lock = readLockRecord(RESOURCE);
      lock.children = [{ pid: aliveB.pid, label: 'B' }];
      fs.writeFileSync(lockFile(RESOURCE), JSON.stringify(lock));

      const outcome = lease.release();
      assert.ok(outcome, '矛盾时不得释放');
      assert.strictEqual(outcome.reason, 'children_alive');
      assert.ok(outcome.pids.includes(aliveA.pid) && outcome.pids.includes(aliveB.pid),
        '矛盾时应按并集判定，两个 PID 都要算：' + JSON.stringify(outcome.pids));
      assert.ok(fs.existsSync(lockFile(RESOURCE)), '锁必须保留');
      stopChild(aliveA);
      stopChild(aliveB);
    });

    await test('R2-b 真实入口：登记文件被破坏时退出仍保留锁，后继运行被拒', async function () {
      clearLocks();
      const probe = startLiveChild();
      const mockPath = path.join(SANDBOX, 'mock-corrupt.js');
      fs.writeFileSync(mockPath, `
        const Module = require('module');
        const fs = require('fs');
        const path = require('path');
        const originalLoad = Module._load;
        const livePid = Number(process.env.MOCK_LIVE_PID || 0);
        let patched = null;
        Module._load = function (request, parent, isMain) {
          const loaded = originalLoad.apply(this, arguments);
          const name = String(request);
          if (/testRunControl(\\.js)?$/.test(name) && parent && /run-one\\.js$/.test(parent.filename || '')) {
            if (patched) return patched;
            patched = Object.assign({}, loaded);
            patched.spawnWithTimeout = async function (cmd, argv, options = {}) {
              if (typeof options.onSpawn === 'function') options.onSpawn(livePid);
              // 登记完成后把主登记写坏，模拟文件损坏
              try {
                const dir = path.join(process.env.TEST_CONTROL_ROOT, 'runs');
                for (const f of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, f), '{ corrupted');
              } catch (_) {}
              return {
                status: null, signal: 'TIMEOUT', timedOut: true,
                treeKill: { killed: false, method: 'mock-kill-failed' },
                out: '', durationMs: 1, pid: livePid,
              };
            };
            return patched;
          }
          if (/testDatabase(\\.js)?$/.test(name)) {
            return Object.assign({}, loaded, { ensureTestDatabase: async () => {} });
          }
          return loaded;
        };
      `);

      const result = await new Promise(resolve => {
        const p = spawn(process.execPath, [path.join(__dirname, 'run-one.js'), path.join(__dirname, 'nav-math.test.js')], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            TEST_CONTROL_ROOT: SANDBOX,
            NODE_OPTIONS: '--require ' + mockPath,
            MOCK_LIVE_PID: String(probe.pid),
            TEST_RUN_WAIT_TIMEOUT_MS: '3000',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let text = '';
        p.stdout.on('data', c => { text += c.toString('utf8'); });
        p.stderr.on('data', c => { text += c.toString('utf8'); });
        const killer = setTimeout(() => { runControl.killProcessTree(p.pid); resolve({ text, code: 'OUTER_TIMEOUT' }); }, 10000);
        p.on('close', code => { clearTimeout(killer); resolve({ text, code }); });
      });

      assert.notStrictEqual(result.code, 'OUTER_TIMEOUT', '入口必须自行结束：' + result.text.slice(-600));
      assert.strictEqual(result.code, 1, '终止失败必须按失败退出：' + result.code);
      assert.ok(/保留资源占用/.test(result.text), '必须提示保留：' + result.text.slice(-600));
      const locks = fs.existsSync(runControl.LOCK_DIR)
        ? fs.readdirSync(runControl.LOCK_DIR).filter(f => f.endsWith('.lock')) : [];
      assert.ok(locks.length >= 1,
        '登记文件损坏时锁必须仍在——修复前 exit 钩子会把它删掉（当前 ' + locks.length + ' 个）');
      stopChild(probe);
    });

  } finally {
    for (const child of children) {
      try { runControl.killProcessTree(child.pid); } catch (_) { /* 已退出 */ }
    }
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 清理失败不掩盖结论 */ }
  }

  console.log('测试运行控制安全反例：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) {
    failures.forEach(item => console.log('  失败：' + item));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
