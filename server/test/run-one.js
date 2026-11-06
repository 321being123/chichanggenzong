// 单文件测试统一准入引导（N0-A.4）。
//
// 直接 `node server/test/xxx.test.js` 会绕过统一入口：进程没有 NODE_ENV=test、
// 没有隔离测试库、也没有本机资源互斥，可能连到业务库或与别人同时在跑同一套样本。
// 因此单文件运行统一改走本入口：
//   node server/test/run-one.js server/test/xxx.test.js
//   npm.cmd run test:file -- server/test/xxx.test.js
//
// 2026-11-02 第二轮验收后改为「独立监督进程 + 执行进程」：
// 同进程 setTimeout 只能处理 await 卡住，入口自身同步阻塞时定时器根本没机会执行。
// 现在监督者在父进程（只持有资源、计时、终止），建库与测试执行在子进程。
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const runControl = require('./lib/testRunControl');
const { TEST_DATABASE, ensureTestDatabase } = require('./lib/testDatabase');

const rootDir = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const files = args.filter(a => !a.startsWith('--'));
const timeoutArg = flags.find(f => f.startsWith('--timeout-ms='));
const timeoutMs = timeoutArg ? Number(timeoutArg.split('=')[1]) : 5 * 60 * 1000;
const IS_WORKER = flags.includes('--worker');

if (!files.length) {
  console.error('用法：node server/test/run-one.js <测试文件> [--timeout-ms=300000]');
  process.exit(2);
}

const target = path.resolve(rootDir, files[0]);
if (!fs.existsSync(target)) {
  console.error('测试文件不存在：' + target);
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('--timeout-ms 必须是正整数');
  process.exit(2);
}

const resources = [
  runControl.pgResource(TEST_DATABASE),
  runControl.dirResource(path.join(rootDir, 'data')),
];

// 整条链路的上限（含建库/连接）。默认比单文件超时多 2 分钟余量，可用环境变量压短做反例。
const overallDeadlineMs = (() => {
  const raw = Number(process.env.TEST_RUN_DEADLINE_MS || 0);
  const value = Number.isFinite(raw) && raw > 0 ? raw : timeoutMs + 120000;
  return Math.max(100, value);
})();

// ===== 执行进程：建库 + 跑单文件。同步卡死只影响它自己。 =====
async function runWorker() {
  const inherited = runControl.inheritRunContext({ resources });
  if (!inherited) {
    console.error('内部错误：执行进程必须由监督进程启动（缺少有效资源授权），本次未执行');
    return 2;
  }
  const runId = inherited.runId;

  try {
    await ensureTestDatabase();
  } catch (error) {
    // 纯函数用例不依赖数据库；库不可用只警告，不假装通过——真需要库的用例自己会失败。
    console.warn('[警告] 测试隔离库不可用（' + error.message + '），继续运行；依赖数据库的用例会自行失败。');
  }

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    EXTERNAL_CALL_GUARD: '0',
    ALERT_EMAIL_TO: '',
    ALERT_EMAIL_FROM: '',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PGDATABASE: TEST_DATABASE,
    TEST_RUN_ID: runId,
    TEST_RUN_LOCK_OWNER_PID: String(inherited.ownerPid),
  };
  delete env.DATABASE_URL;

  const result = await runControl.spawnWithTimeout(process.execPath, [target], {
    cwd: rootDir, env, timeoutMs: Math.min(timeoutMs, Math.max(1000, overallDeadlineMs - 1000)),
    onSpawn: pid => {
      // 登记到本轮：监督进程要靠它确认没有遗留测试还在跑。
      try { runControl.registerChild(runId, pid, path.basename(target)); } catch (_) { /* 登记失败不拖垮执行 */ }
    },
  });
  // 只有确认退出才注销；未确认时保留登记，让释放判据拒绝放行。
  if (result.pid && !runControl.isProcessAlive(result.pid)) {
    try { runControl.unregisterChild(runId, result.pid); } catch (_) { /* 同上 */ }
  }
  process.stdout.write(result.out || '');
  if (result.timedOut) {
    console.error('\n[超时] ' + Math.round(timeoutMs / 1000) + 's 未结束，已终止整棵进程树：' +
      (result.treeKill ? result.treeKill.method : '-'));
    return 1;
  }
  return result.status === 0 ? 0 : 1;
}

// ===== 监督进程：只持有资源、计时、终止；绝不做可能阻塞的工作 =====
async function runSupervisor() {
  const inherited = runControl.inheritRunContext({ resources });
  let lease = null;
  if (!inherited) {
    try {
      lease = await runControl.acquireLock({
        prefix: 'test-one',
        label: path.basename(target) + ' @ ' + rootDir,
        resources,
        waitTimeoutMs: Number(process.env.TEST_RUN_WAIT_TIMEOUT_MS || 30 * 60 * 1000),
      });
    } catch (error) {
      console.error('测试资源准入失败（本次未执行）：', error.message);
      return 2;
    }
  }
  const runId = inherited ? inherited.runId : lease.runId;
  const ownerPid = inherited ? inherited.ownerPid : process.pid;

  console.log('runId=' + runId + ' · 库 ' + TEST_DATABASE + ' · ' + path.basename(target) +
    (inherited ? ' · 复用父入口授权' : (lease && lease.waitMs > 0 ? ' · 排队 ' + Math.round(lease.waitMs / 1000) + 's' : '')) +
    ' · 监督进程 pid=' + process.pid);

  const env = { ...process.env, TEST_RUN_ID: runId, TEST_RUN_LOCK_OWNER_PID: String(ownerPid) };
  // F14：执行进程自成进程组，超时时连同它启动的测试子进程（含孙进程）一起结束。
  const useGroup = process.platform !== 'win32';
  const worker = spawn(process.execPath,
    [__filename, target, '--worker', '--timeout-ms=' + timeoutMs],
    { cwd: rootDir, env, stdio: 'inherit', windowsHide: true, detached: useGroup });
  try { runControl.registerChild(runId, worker.pid, 'run-one worker'); } catch (_) { /* 登记失败不拖垮执行 */ }

  const finish = (code, note, options = {}) => {
    if (!lease) return code; // 继承父授权时不负责释放
    if (options.treeConfirmedDead) {
      lease.forceRelease();
      console.error('[测试资源] ' + (note ? note + '时' : '') + '整组已确认退出，资源已释放');
      return code;
    }
    const retained = lease.release();
    if (retained) {
      console.error('[测试资源] ' + (note ? note + '时' : '') + '仍有未确认退出的子进程，保留资源占用：' + JSON.stringify(retained));
      console.error('[测试资源] 请用 node server/test/testctl.js status 核查；不要手工删锁抢跑');
      return 1;
    }
    if (note) console.error('[测试资源] ' + note + '，资源已释放');
    return code;
  };

  return await new Promise(resolve => {
    let settled = false;
    let killPending = false;
    const settleOnce = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      killPending = true;
      console.error('\n[超时] 单文件入口整体超过 ' + Math.round(overallDeadlineMs / 1000) + 's（含初始化，独立监督），强制结束');
      runControl.killProcessTreeAsync(worker.pid, { group: useGroup })
        .catch(error => ({ killed: false, method: 'error', output: error.message }))
        .then(kill => {
          killPending = false;
          console.error('[超时] 终止执行进程树：' + kill.method + ' · 已确认退出=' + kill.killed);
          if (kill.killed) runControl.unregisterChild(runId, worker.pid);
          settleOnce(finish(1, '整体超时', { treeConfirmedDead: kill.killed === true }));
        });
    }, overallDeadlineMs);

    worker.on('error', error => {
      if (settled || killPending) return;
      clearTimeout(timer);
      console.error('执行进程启动失败：' + error.message);
      settleOnce(finish(1, '执行进程启动失败'));
    });

    worker.on('close', code => {
      // 终止确认中：先别收尾，等 killProcessTreeAsync 判断整组是否真的退出。
      if (settled || killPending) return;
      clearTimeout(timer);
      if (!runControl.isProcessAlive(worker.pid)) runControl.unregisterChild(runId, worker.pid);
      settleOnce(finish(Number.isInteger(code) ? code : 1));
    });
  });
}

const entry = IS_WORKER ? runWorker() : runSupervisor();
entry
  .then(code => process.exit(code || 0))
  .catch(error => { console.error((error && error.stack) || error); process.exit(1); });
