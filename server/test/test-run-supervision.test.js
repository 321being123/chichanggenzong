// 独立监督与安全释放的反例（2026-11-02 第二轮验收遗留 2 个 P1）
//
// 第一版修复只做到「入口打印保留资源」和「同进程 setTimeout」，两条在真实故障下都不成立：
//   P1-1 终止失败后 exit 钩子仍无条件删锁 → 下一轮会和遗留测试重叠；
//   P1-2 监督定时器与被监督入口同进程 → 入口同步阻塞时定时器根本没机会执行。
//
// 本文件用真实入口（node server/test/run-one.js、run-all.js）复现两种故障：
//   A. 让 spawnWithTimeout 返回「超时 + 终止失败」，并登记一个由**独立探针进程**持有的存活 PID；
//      断言入口退出后锁仍在、登记仍在，探针退出后才可回收。
//   B. 让 pg.Client.connect 内部同步 while(true)，整轮预算 100ms；
//      断言 run-all 由自己的父监督进程结束，而不是靠外部超时杀进程。
//
// 边界：不连接任何真实数据库（pg 全部 mock）；探针进程是本文件自己创建的隔离进程，
// 不结束他人进程；不声称已验证 Windows 上真实 taskkill 失败的情形。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const SANDBOX = path.join(os.tmpdir(), 'test-run-supervision-' + process.pid + '-' + Date.now());
fs.mkdirSync(SANDBOX, { recursive: true });
const CONTROL = path.join(SANDBOX, 'control');
const LOCK_DIR = path.join(CONTROL, 'locks');

const REPO_ROOT = path.join(__dirname, '..', '..');
const RUN_ONE = path.join(__dirname, 'run-one.js');
const RUN_ALL = path.join(__dirname, 'run-all.js');
const TRIVIAL_TEST = path.join(__dirname, 'nav-math.test.js');

let pass = 0;
let fail = 0;
const failures = [];
const probes = [];

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

function lockFiles() {
  if (!fs.existsSync(LOCK_DIR)) return [];
  return fs.readdirSync(LOCK_DIR).filter(f => f.endsWith('.lock'));
}

function clearControl() {
  try { fs.rmSync(CONTROL, { recursive: true, force: true }); } catch (_) { /* 首次不存在 */ }
}

function runRecordFiles() {
  const dir = path.join(CONTROL, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
}

function readRunRecords() {
  const dir = path.join(CONTROL, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; }
  }).filter(Boolean);
}

// 独立探针：模拟「没被杀掉的已登记子进程」。不是本轮入口创建的，所以不会被它的进程树终止。
function startProbe() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  probes.push(child);
  return child;
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch (_) { /* 已退出 */ }
}

// 必须**异步**等待：Atomics.wait 会阻塞事件循环，Node 收不到 SIGCHLD、子进程一直停在僵尸态，
// process.kill(pid, 0) 就永远成功，于是"确认已退出"这一步在 Linux 上必然超时失败
// （这正是 F14 记的"同步等待导致残锁/残进程"同类缺陷）。改成交还事件循环的定时等待后，
// 被 SIGKILL 的子进程会被正常回收，判定才有意义。
async function waitGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { alive = error.code === 'EPERM'; }
    if (!alive) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function runNode(script, extraEnv = {}, timeoutMs = 15000) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, script.args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env, ...extraEnv,
        TEST_CONTROL_ROOT: CONTROL,
        TEST_RUN_WAIT_TIMEOUT_MS: '3000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', c => { out += c.toString('utf8'); });
    child.stderr.on('data', c => { out += c.toString('utf8'); });
    const killer = setTimeout(() => {
      killPid(child.pid);
      resolve({ out, code: 'OUTER_TIMEOUT', ms: Date.now() - startedAt });
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(killer);
      resolve({ out, code, ms: Date.now() - startedAt });
    });
  });
}

// mock 注入：只在本文件起的子进程里生效，不改仓库文件。
function writeMocks() {
  const mockPath = path.join(SANDBOX, 'mock.js');
  fs.writeFileSync(mockPath, `
    const Module = require('module');
    const originalLoad = Module._load;
    const livePid = Number(process.env.MOCK_LIVE_PID || 0);
    const hangSync = process.env.MOCK_SYNC_HANG === '1';
    let patchedControl = null;
    Module._load = function (request, parent, isMain) {
      const loaded = originalLoad.apply(this, arguments);
      const name = String(request);
      if (/testRunControl(\\.js)?$/.test(name) && parent && /run-one\\.js$/.test(parent.filename || '')) {
        if (patchedControl) return patchedControl;
        patchedControl = Object.assign({}, loaded);
        patchedControl.spawnWithTimeout = async function (cmd, argv, options = {}) {
          if (typeof options.onSpawn === 'function') options.onSpawn(livePid);
          return {
            status: null, signal: 'TIMEOUT', timedOut: true,
            treeKill: { killed: false, method: 'mock-kill-failed' },
            out: '', durationMs: 1, pid: livePid,
          };
        };
        return patchedControl;
      }
      if (/testDatabase(\\.js)?$/.test(name)) {
        return Object.assign({}, loaded, { ensureTestDatabase: async () => {} });
      }
      if (name === 'pg') {
        class SyncHangClient {
          constructor() {}
          connect() { if (hangSync) { while (true) { /* 同步卡死，事件循环完全停摆 */ } } return Promise.resolve(); }
          query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
          end() { return Promise.resolve(); }
        }
        return { Client: SyncHangClient, Pool: SyncHangClient };
      }
      return loaded;
    };
  `);
  return mockPath;
}

(async () => {
  const mockPath = writeMocks();

  try {
    // ============ P1-1：终止失败 → 入口退出后锁必须还在 ============
    await test('P1-1 终止失败：入口退出后锁与子进程登记都必须保留', async function () {
      clearControl();
      const probe = startProbe();
      assert.strictEqual(await waitGone(probe.pid, 200), false, '前置：探针进程必须存活');

      const result = await runNode(
        { args: [RUN_ONE, TRIVIAL_TEST] },
        { NODE_OPTIONS: '--require ' + mockPath, MOCK_LIVE_PID: String(probe.pid) },
        8000
      );
      assert.strictEqual(result.code, 1, '终止失败必须按失败退出：' + result.out.slice(-600));
      assert.ok(/保留资源占用/.test(result.out), '必须明确提示保留资源占用：' + result.out.slice(-600));

      const locks = lockFiles();
      // 锁是按资源各一把（PG 实例+库、工作树 data 目录），所以是 2 个；关键是有没有留下。
      assert.ok(locks.length >= 1,
        '入口退出后锁必须仍然存在——修复前 exit 钩子会把它删掉（当前 ' + locks.length + ' 个）');

      const records = readRunRecords();
      assert.strictEqual(records.length, 1, '本轮登记记录必须保留，供后继判定');
      const children = records[0].children || [];
      assert.ok(children.some(c => Number(c.pid) === probe.pid),
        '未确认退出的子进程必须仍在登记里（不能被提前注销）：' + JSON.stringify(children));

      const retained = locks.map(file => {
        try { return JSON.parse(fs.readFileSync(path.join(LOCK_DIR, file), 'utf8')).retainedReason; } catch (_) { return null; }
      }).filter(Boolean);
      assert.ok(retained.length >= 1 && retained[0].reason === 'children_alive',
        '锁记录必须留下「为什么没释放」的证据：' + JSON.stringify(retained));

      // 后继运行必须被挡住：锁还在，新运行只能排队
      const blocked = await runNode(
        { args: [RUN_ONE, TRIVIAL_TEST] },
        { TEST_RUN_WAIT_TIMEOUT_MS: '800' },
        12000
      );
      assert.strictEqual(blocked.code, 2, '有存活登记时后继运行必须准入失败（退出码 2）：' + blocked.out.slice(-400));
      assert.ok(/占用|排队/.test(blocked.out), '必须说明被占用：' + blocked.out.slice(-400));

      // 探针退出后，锁应可被回收（人工入口或下一轮自动回收）
      killPid(probe.pid);
      assert.strictEqual(await waitGone(probe.pid, 6000), true, '前置：探针必须真的退出');
      const afterExit = await runNode(
        { args: [RUN_ONE, TRIVIAL_TEST] },
        {},
        15000
      );
      assert.strictEqual(afterExit.code, 0, '子进程确认退出后应能回收并正常跑完：' + afterExit.out.slice(-600));
      assert.deepStrictEqual(lockFiles(), [], '正常跑完后不应残留锁');
    });

    // ============ P1-2：同步卡死 → 由独立父监督结束，而不是外部超时 ============
    await test('P1-2 同步卡死：run-all 由自己的父监督进程结束（不靠外部超时）', async function () {
      clearControl();
      const result = await runNode(
        { args: [RUN_ALL] },
        {
          NODE_OPTIONS: '--require ' + mockPath,
          MOCK_SYNC_HANG: '1',
          TEST_RUN_DEADLINE_MS: '100',
        },
        6000
      );
      assert.notStrictEqual(result.code, 'OUTER_TIMEOUT',
        '同步卡死必须由父监督结束——修复前定时器与入口同进程，只能靠外部杀进程：' + result.out.slice(-600));
      assert.strictEqual(result.code, 1, '超时必须按失败退出：' + result.code);
      assert.ok(/整轮超过硬截止/.test(result.out), '必须留下截止证据：' + result.out.slice(-600));
      assert.ok(/独立监督进程/.test(result.out), '监督必须来自独立进程：' + result.out.slice(-600));
      assert.ok(result.ms < 5000, '应在预算附近退出，实际耗时 ' + result.ms + 'ms');
      assert.deepStrictEqual(lockFiles(), [], '超时退出后不能残留锁');
    });

    // ============ 正常路径不能被新监督改坏 ============
    await test('正常路径：run-one 跑完后无残留锁、无残留登记', async function () {
      clearControl();
      const result = await runNode({ args: [RUN_ONE, TRIVIAL_TEST] }, {}, 15000);
      assert.strictEqual(result.code, 0, '正常用例必须通过：' + result.out.slice(-600));
      assert.ok(/ALL PASS|通过/.test(result.out), '必须能看到测试输出');
      assert.deepStrictEqual(lockFiles(), [], '正常结束不得残留锁');
      assert.deepStrictEqual(runRecordFiles(), [], '正常结束不得残留登记记录');
    });

  } finally {
    for (const probe of probes) {
      try { killPid(probe.pid); } catch (_) { /* 已退出 */ }
    }
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 清理失败不掩盖结论 */ }
  }

  console.log('独立监督与安全释放反例：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) {
    failures.forEach(item => console.log('  失败：' + item));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
