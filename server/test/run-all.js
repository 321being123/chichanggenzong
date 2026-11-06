// 统一测试入口（P2-1）：逐个在独立的 Node 子进程里跑下列全部自动测试：
//   1) server/test/*.test.js        —— 单元/集成测试（含空库迁移、PG 集成）
//   2) test-security.js             —— 零依赖安全专项测试
//   3) ipo-report/test_ipo_frontend.js —— IPO 前端纯函数测试
//   4) ipo-report/*.py 功能测试      —— Python 功能回归（需 venv 依赖）
//      注：此处只跑「确定性单元 + PostgreSQL 集成」两类（CI 门禁）。
//          外部行情合约测试见 ipo-report/test_ipo_contract.py，由 CI 单独步骤
//          以 continue-on-error 运行，不阻断普通 PR。
// 每个文件进程隔离（互不污染状态），汇总通过/失败数量并给出非零退出码。
// 用法：node server/test/run-all.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const runControl = require('./lib/testRunControl');
const { classifyTestResult } = require('./lib/testResultVerdict');
const { TEST_DATABASE, ensureTestDatabase, cleanupTestArtifacts } = require('./lib/testDatabase');
const { templateName, dropTemplate } = require('./helpers/migrated-database');
const { formatDuration, summarizeTimings } = require('./lib/testTimings');

const testDir = __dirname;
const rootDir = path.join(__dirname, '..', '..');

let pass = 0, fail = 0, skip = 0;
// 部分跳过（文件里有 [SKIP] 段，但整份文件仍跑完并正常退出）单独计数：
// 修复前它与「整份文件被跳过」共用一个计数，导致非零退出 + [SKIP] 被当成跳过（F11）。
let partialSkip = 0;
// CI 上「按设计跳过」的项：skill-host-contract 校验的是工作区级 Skill 目录
// （D:\Users\存在小站\.codebuddy\skills），该目录只存在于开发机，CI 检出必然没有。
// 这类跳过不算关键测试缺失，否则每次 CI 都会红；其余跳过在 CI 仍判失败。
const CI_ALLOWED_SKIPS = new Set(['skill-host-contract.test.js']);
let allowedSkip = 0;
const failed = [];
const timings = [];
const isCI = process.env.CI === '1';
// 所有测试子进程统一隔离真实邮件；空字符串可阻止 dotenv 从开发机 .env 回填真实收件人。
// Python Guard 生产默认开启；测试进程显式关闭，避免纯函数回归因本机数据库状态产生外部副作用。
// 注入 PYTHON：测试子进程内部再 spawn Python 时（如 PDF 夹具生成）统一使用同一解释器，
// 避免 CI 上 venv 位于 ipo-report/venv 而各处硬编码 root/venv 导致回退到缺包的系统 python3。
const resolvedPython = findPython();
// Python 输出与 Node 的 UTF-8 解码保持一致，避免 Windows GBK 破坏中文证据或无法输出 Unicode。
const testEnv = { ...process.env, NODE_ENV: 'test', EXTERNAL_CALL_GUARD: '0', ALERT_EMAIL_TO: '', ALERT_EMAIL_FROM: '',
  PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
// 必需真库回归段（F12）：R3/R4/R5 的 PostgreSQL 段默认必须真的执行。
// 本入口自己会 ensureTestDatabase() 并把子进程 PGDATABASE 指向隔离测试库，
// 因此「没设开关」不再等于「环境不具备」——不默认开启就等于把金融 SQL 与恢复边界的
// 验收长期挂空。确需离线快速回归时才用 TEST_SKIP_REQUIRED_DB=1 显式降级（CI 不允许）。
const REQUIRED_DB_SUITES = (() => {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(rootDir, 'deploy', 'required-ci-checks.json'), 'utf8')).requiredDbSuites;
    if (Array.isArray(list) && list.length) return list.map(String);
  } catch (error) {
    console.error('读取必需真库回归清单失败（deploy/required-ci-checks.json）：' + error.message);
  }
  // 读不到清单时按内置默认执行，绝不因此把必需段降级为"没有"。
  return ['STOCK_SELECTION_R3_DB', 'STOCK_SELECTION_R4_DB', 'STOCK_SELECTION_R5_DB'];
})();
const requiredDbSuitesEnabled = String(process.env.TEST_SKIP_REQUIRED_DB || '') !== '1';
if (requiredDbSuitesEnabled) {
  REQUIRED_DB_SUITES.forEach(key => { testEnv[key] = '1'; });
} else if (process.env.CI === '1') {
  console.error('CI 模式下不允许关闭必需真库回归段（TEST_SKIP_REQUIRED_DB=1 仅限本地离线回归）');
  process.exit(2);
}
if (!testEnv.PYTHON && resolvedPython) testEnv.PYTHON = resolvedPython;
// 单文件超时：spawnSync 不设超时，卡住的用例会把整轮门禁永久挂起（2026-11-01 实测：
// backup-retention 的 bash 子进程在本机被 shell 运行时垫片卡住，全量测试停住 40 分钟无任何输出，
// 而数据库连接是空闲的，从日志完全看不出卡在哪个文件）。超时按失败处理并打印最后一行输出。
const NODE_TEST_TIMEOUT_MS = 5 * 60 * 1000;
const PY_TEST_TIMEOUT_MS = 5 * 60 * 1000;
// N0 整轮硬截止：外部计时，单个文件卡死之外再加一道总时长上限，
// 超出后剩余文件记为「未执行」而不是通过（方案 10.7 C）。
const TOTAL_DEADLINE_MS = Number(process.env.TEST_RUN_DEADLINE_MS || 4 * 60 * 60 * 1000);
const WAIT_TIMEOUT_MS = Number(process.env.TEST_RUN_WAIT_TIMEOUT_MS || 30 * 60 * 1000);
let runStartedAt = Date.now();
let runId = null;

function deadlineExceeded() {
  return Date.now() - runStartedAt > TOTAL_DEADLINE_MS;
}

function deadlineEvidence(file) {
  return '整轮超过 ' + Math.round(TOTAL_DEADLINE_MS / 60000) + ' 分钟硬截止，未执行：' + file;
}

// ---- 全生命周期监督（2026-11-02 第二轮验收后重做） ----
// 第一版是「同进程 setTimeout」，只能处理 await 卡住；一旦入口自身同步阻塞
// （同步初始化、同步子命令、第三方代码死循环），定时器回调根本没机会执行，也就谈不上截止。
// 现在改成「独立父进程监督 + 子进程执行」：
//   监督者只做计时与终止，不做任何可能阻塞的工作；
//   执行者跑建库/测试/清理，同步卡死只卡住它自己，父进程照常到点终止整棵进程树。
let currentChildPid = null;

function remainingBudgetMs() {
  return Math.max(0, TOTAL_DEADLINE_MS - (Date.now() - runStartedAt));
}

function trackChild(pid, label) {
  currentChildPid = pid || null;
  if (runId && pid) {
    try { runControl.registerChild(runId, pid, label); } catch (_) { /* 登记失败不拖垮执行 */ }
  }
}

// 未确认退出的子进程**不注销登记**：登记是释放判据唯一的证据，
// 提前注销会让「保留资源」的意图落不到磁盘上（第一版的缺陷）。
function untrackChild(pid, confirmedExit) {
  if (currentChildPid === pid) currentChildPid = null;
  if (!confirmedExit) return;
  if (runId && pid) {
    try { runControl.unregisterChild(runId, pid); } catch (_) { /* 同上 */ }
  }
}

// 每个子文件的超时不能超过整轮剩余预算，否则「硬截止」会被单文件拖穿。
function childTimeoutMs(base) {
  return Math.max(1000, Math.min(base, remainingBudgetMs()));
}

async function runNode(file) {
  const budget = childTimeoutMs(NODE_TEST_TIMEOUT_MS);
  const r = await runControl.spawnWithTimeout(process.execPath, [file], {
    cwd: rootDir, env: testEnv, timeoutMs: budget,
    onSpawn: pid => trackChild(pid, path.basename(file)),
  });
  // 只有确认已退出才注销登记；否则保留，交给释放判据决定是否放行
  untrackChild(r.pid, !runControl.isProcessAlive(r.pid));
  timings.push({ file: path.relative(rootDir, file), durationMs: r.durationMs, kind: 'file' });
  const out = r.out || '';
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] || '(无输出)') + ' · 耗时 ' + formatDuration(r.durationMs);
  const verdict = classifyTestResult(r, out);
  if (verdict.verdict === 'timeout') {
    fail++; failed.push(file);
    console.log('  ✗ ' + file + '  (超时 ' + Math.round(budget / 1000) + 's 未结束，已终止整棵进程树)  ——  ' + last);
    if (r.treeKill) console.log('    进程树终止：' + r.treeKill.method + (r.treeKill.output ? ' · ' + r.treeKill.output : ''));
    console.log(out);
    return;
  }
  if (verdict.verdict === 'spawn_error' || verdict.verdict === 'signal' || verdict.verdict === 'fail') {
    fail++; failed.push(file);
    const label = verdict.verdict === 'spawn_error' ? '启动失败：' + verdict.detail
      : verdict.verdict === 'signal' ? '被信号 ' + (verdict.detail || '未知') + ' 结束'
        : '退出码 ' + r.status;
    console.log('  ✗ ' + file + '  (' + label + ')  ——  ' + last);
    console.log(out);
    return;
  }
  // 正常退出后才发现跳过：非正常退出已在上面判失败，不会再被 [SKIP] 文本降级成跳过。
  if (verdict.verdict === 'partial_skip') {
    skip++; partialSkip++;
    if (CI_ALLOWED_SKIPS.has(path.basename(file))) allowedSkip += 1;
    console.log('  ⊘ ' + file + '  (部分跳过)  ——  ' + last);
    return;
  }
  pass++; console.log('  ✓ ' + file + '  ——  ' + last);
}

async function runNodeGlob() {
  const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
  console.log('【1/4 单元·集成测试】共 ' + files.length + ' 个文件');
  for (const f of files) {
    const file = path.join(testDir, f);
    if (deadlineExceeded()) { fail++; failed.push(f); console.log('  ✗ ' + deadlineEvidence(f)); continue; }
    await runNode(file);
  }
}

async function runExtraNode() {
  console.log('\n【2/4 安全专项 + IPO 前端】');
  const extras = [
    path.join(rootDir, 'test-security.js'),
    path.join(rootDir, 'ipo-report', 'test_ipo_frontend.js'),
  ];
  for (const file of extras) {
    if (!fs.existsSync(file)) { skip++; console.log('  ⊘ ' + file + '  (文件不存在，跳过)'); continue; }
    if (deadlineExceeded()) { fail++; failed.push(path.basename(file)); console.log('  ✗ ' + deadlineEvidence(path.basename(file))); continue; }
    await runNode(file);
  }
}

function findPython() {
  // 优先项目内 venv（Windows: Scripts/python.exe；类 Unix: bin/python）
  // 本地 .env 里的解释器覆盖优先（worktree 默认不含 venv，配置指向本机已有环境）。
  const candidates = [
    process.env.IPO_PYTHON_PATH,
    process.env.PYTHON,
    path.join(rootDir, 'ipo-report', 'venv', 'Scripts', 'python.exe'),
    path.join(rootDir, 'ipo-report', 'venv', 'bin', 'python'),
    path.join(rootDir, 'venv', 'Scripts', 'python.exe'),
    path.join(rootDir, 'venv', 'bin', 'python'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // 退回 PATH 上的 python / python3
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0) return cmd;
  }
  return null;
}

async function runPython() {
  console.log('\n【3/4 + 4/4 Python 功能测试】');
  const py = findPython();
  if (!py) { skip++; console.log('  ⊘ 未找到 Python 解释器，跳过 Python 功能测试'); return; }
  const pyFiles = [
    path.join(rootDir, 'ipo-report', 'test_ipo_unit.py'),
    path.join(rootDir, 'ipo-report', 'test_ipo_training_boundary.py'),
    path.join(rootDir, 'ipo-report', 'test_ipo_integration.py'),
    path.join(rootDir, 'ipo-report', 'test_ipo_history_sync.py'),
    path.join(rootDir, 'ipo-report', 'test_unit_fixes.py'),
    path.join(testDir, 'test_hk_ipo_prospectus_parser.py'),
    path.join(testDir, 'test_hk_ipo_actual_pricing.py'),
    path.join(testDir, 'test_valuation_regression.py'),
    path.join(testDir, 'test_audit_20261021.py'),
  ].filter(f => fs.existsSync(f));
  if (pyFiles.length === 0) { skip++; console.log('  ⊘ 未找到 Python 测试文件，跳过'); return; }
  for (const file of pyFiles) {
    if (deadlineExceeded()) { fail++; failed.push(path.basename(file)); console.log('  ✗ ' + deadlineEvidence(path.basename(file))); continue; }
    const pyBudget = childTimeoutMs(PY_TEST_TIMEOUT_MS);
    const r = await runControl.spawnWithTimeout(py, [file], {
      cwd: rootDir, env: testEnv, timeoutMs: pyBudget,
      onSpawn: pid => trackChild(pid, path.basename(file)),
    });
    untrackChild(r.pid, !runControl.isProcessAlive(r.pid));
    timings.push({ file: path.relative(rootDir, file), durationMs: r.durationMs, kind: 'file' });
    const out = r.out || '';
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    const last = (lines[lines.length - 1] || '(无输出)') + ' · 耗时 ' + formatDuration(r.durationMs);
    if (r.timedOut) {
      fail++; failed.push(path.basename(file));
      console.log('  ✗ ' + path.basename(file) + '  (超时 ' + Math.round(pyBudget / 1000) + 's 未结束，已终止整棵进程树)  ——  ' + last);
      if (r.treeKill) console.log('    进程树终止：' + r.treeKill.method + (r.treeKill.output ? ' · ' + r.treeKill.output : ''));
      console.log(out);
      continue;
    }
    // 缺依赖/解释器环境异常：本地标 SKIP；CI 模式下视为失败（不允许关键测试跳过）
    const envErr = /ModuleNotFoundError|No module named|ImportError|Can't open file/.test(out);
    if (envErr) {
      if (isCI) { fail++; failed.push(path.basename(file)); console.log('  ✗ ' + path.basename(file) + '  (CI 模式下环境缺失视为失败)  ——  ' + last); }
      else { skip++; console.log('  ⊘ ' + path.basename(file) + '  (环境/依赖缺失，跳过)  ——  ' + last); }
      continue;
    }
    // 启动失败与信号结束没有退出码，必须先按客观失败处理，不能被后面的输出文本解释覆盖。
    if (r.spawnError) {
      fail++; failed.push(path.basename(file));
      console.log('  ✗ ' + path.basename(file) + '  (启动失败：' + r.spawnError + ')  ——  ' + last);
      console.log(out);
      continue;
    }
    // 解析测试自身汇总行「PASS=x  FAIL=y  ERROR=z」，避免退出码为 0 却内部失败被误判通过
    const m = out.match(/PASS=(\d+)\s+FAIL=(\d+)\s+ERROR=(\d+)/);
    const hasIssues = /HAS_ISSUES/.test(out) || (m && (Number(m[2]) > 0 || Number(m[3]) > 0));
    if (hasIssues || r.status !== 0) {
      fail++; failed.push(path.basename(file));
      console.log('  ✗ ' + path.basename(file) + '  ——  ' + last);
      console.log(out);
    }
    else { pass++; console.log('  ✓ ' + path.basename(file) + '  ——  ' + last); }
  }
}

function currentResources() {
  return [
    runControl.pgResource(TEST_DATABASE),
    runControl.dirResource(path.join(rootDir, 'data')),
  ];
}

// ===== 执行者：真正跑建库/测试/清理。同步卡死只影响它自己，父进程照常到点终止。 =====
async function runWorker() {
  runStartedAt = Date.now();
  const inherited = runControl.inheritRunContext({ resources: currentResources() });
  if (!inherited) {
    console.error('内部错误：工作进程必须由监督进程启动（缺少有效资源授权），本次未执行任何测试');
    return 2;
  }
  runId = inherited.runId;
  // 工作进程也执行模板清理等测试库操作，不能只给测试子文件设置 NODE_ENV。
  process.env.NODE_ENV = 'test';
  testEnv.TEST_RUN_ID = runId;
  testEnv.TEST_RUN_LOCK_OWNER_PID = String(inherited.ownerPid);
  console.log('本轮 runId=' + runId + ' · 测试库 ' + TEST_DATABASE +
    ' · 硬截止 ' + Math.round(TOTAL_DEADLINE_MS / 60000) + ' 分钟（由独立监督进程计时，pid=' + inherited.ownerPid + '）');

  let schemaTemplate = null;
  let initialized = false;
  try {
    await ensureTestDatabase();
    // 子进程统一指向隔离测试库，摘掉可能指回业务库的 DATABASE_URL。
    delete testEnv.DATABASE_URL;
    testEnv.PGDATABASE = TEST_DATABASE;
    initialized = true;
    await cleanupTestArtifacts();

    schemaTemplate = templateName(runId);
    const prepared = await runControl.spawnWithTimeout(process.execPath,
      [path.join(testDir, 'helpers/migrated-database.js'), schemaTemplate], {
        cwd: rootDir, env: testEnv, timeoutMs: childTimeoutMs(NODE_TEST_TIMEOUT_MS),
        onSpawn: pid => trackChild(pid, '迁移模板准备'),
      });
    untrackChild(prepared.pid, !runControl.isProcessAlive(prepared.pid));
    timings.push({ file: '迁移模板准备', durationMs: prepared.durationMs, kind: 'setup' });
    if (prepared.status !== 0 || prepared.timedOut) {
      throw new Error('迁移模板准备失败：' + (prepared.out || prepared.spawnError || '超时'));
    }
    process.env.TEST_SCHEMA_TEMPLATE = schemaTemplate;
    testEnv.TEST_SCHEMA_TEMPLATE = schemaTemplate;
    console.log('干净迁移模板准备完成 · 耗时 ' + formatDuration(prepared.durationMs) + '（五个业务测试分别克隆，迁移专项仍走空库）');

    await runNodeGlob();
    await runExtraNode();
    await runPython();
  } catch (error) {
    fail++;
    failed.push('test-setup-or-execution');
    console.error('测试准备/执行异常：', (error && error.stack) || error);
  } finally {
    if (schemaTemplate) {
      try { await dropTemplate(schemaTemplate); }
      catch (error) {
        fail++; failed.push('schema-template-cleanup');
        console.error('本轮迁移模板清理失败（' + schemaTemplate + '）：', error.message);
      }
    }
    if (initialized) {
      try { await cleanupTestArtifacts(); }
      catch (error) {
        fail++; failed.push('test-artifact-cleanup');
        console.error('测试专属熔断记录清理失败：', error.message);
      }
    }
    const report = summarizeTimings(timings, Date.now() - runStartedAt);
    console.log('\n耗时汇总：本轮执行 ' + formatDuration(report.elapsedMs) + '（不含排队） · 文件累计 ' +
      formatDuration(report.fileMs) + ' · 迁移模板准备 ' + formatDuration(report.setupMs));
    console.log('最慢测试文件（已执行且有计时的 ' + report.measuredFiles + ' 个文件，含失败/跳过）：');
    report.slowest.forEach(item => console.log('  ' + formatDuration(item.durationMs) + '  ' + item.file));
  }

  // 测试证据落盘（F15）：把本轮结果绑定到"哪份代码树"，供发布前置校验核对。
// 只覆盖影响运行结果的目录（见 lib/codeTreeHash.js），因此纯文档变更可复用有效证据，
// 源码一改指纹就变、必须重跑。写失败不改变本轮结论，但会让发布时缺少证据而阻断。
try {
  const { codeTreeHash, headCommit } = require('./lib/codeTreeHash');
  const evidenceDir = path.join(rootDir, 'data', 'test-evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = {
    command: 'node server/test/run-all.js',
    finishedAt: new Date().toISOString(),
    sha: headCommit(rootDir),
    codeTreeHash: codeTreeHash('HEAD', rootDir),
    node: process.version,
    pass, fail, skip, partialSkip,
    failedFiles: failed.slice(0, 200),
    runId,
  };
  fs.writeFileSync(path.join(evidenceDir, 'last-run.json'), JSON.stringify(evidence, null, 2));
  console.log('测试证据已写入 data/test-evidence/last-run.json（代码树 ' + String(evidence.codeTreeHash).slice(0, 12) + '…）');
} catch (error) {
  console.error('测试证据写入失败（不影响本轮判定，但发布前置会因缺少证据而阻断）：' + error.message);
}

console.log('\n========================================');
  console.log('runId ' + runId + ' · 测试库 ' + TEST_DATABASE + ' · 通过 ' + pass + ' · 失败 ' + fail + ' · 跳过 ' + skip +
    (partialSkip ? '（其中部分跳过 ' + partialSkip + '）' : '') +
    (fail ? ' · 失败项：' + failed.join('、') : (skip ? '' : ' · 全部通过 ✅')));
  if (isCI && skip - allowedSkip > 0) {
    console.log('CI 模式下不允许跳过关键测试（共跳过 ' + (skip - allowedSkip) + ' 项），判定失败');
    return 1;
  }
  return fail ? 1 : 0;
}

// ===== 监督者：只持有资源、计时、终止；绝不做任何可能阻塞的工作 =====
async function runSupervisor() {
  runStartedAt = Date.now();
  let lease;
  try {
    lease = await runControl.acquireLock({
      prefix: 'test-all',
      label: 'test:all @ ' + rootDir,
      resources: currentResources(),
      waitTimeoutMs: WAIT_TIMEOUT_MS,
    });
  } catch (error) {
    console.error('测试资源准入失败（本次未执行任何测试）：', error.message);
    return 2;
  }
  runId = lease.runId;
  console.log('本轮 runId=' + runId + ' · 测试库 ' + TEST_DATABASE +
    (lease.waitMs > 0 ? ' · 排队 ' + Math.round(lease.waitMs / 1000) + 's' : '') +
    ' · 硬截止 ' + Math.round(TOTAL_DEADLINE_MS / 60000) + ' 分钟 · 独立监督进程 pid=' + process.pid);

  const env = { ...process.env, TEST_RUN_ID: runId, TEST_RUN_LOCK_OWNER_PID: String(process.pid) };
  // F14：worker 自成进程组，超时终止能一并带走它启动的测试子进程（含孙进程）。
  const useGroup = process.platform !== 'win32';
  const child = spawn(process.execPath, [__filename, '--worker'], {
    cwd: rootDir, env, stdio: 'inherit', windowsHide: true, detached: useGroup,
  });
  runControl.registerChild(runId, child.pid, 'test:all worker');

  // 释放只有一条路径：lease.release() 自己检查登记的子进程是否都已退出。
  // 有存活就保留锁并返回原因——不再有「调用方标志 + 内部逻辑」两套判据。
  // 例外：超时路径已经**确认整组退出**（killProcessTreeAsync 的 killed=true）时，
  // 登记可能因为子进程刚被回收的时间差还挂着，此时强制释放是安全的；确认不了就照旧保留。
  const finish = (code, note, options = {}) => {
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
    // 到期下限 100ms：允许用极小预算复现「同步卡死」，不再被人为的 1s 下限吃掉。
    const timer = setTimeout(() => {
      if (settled) return;
      killPending = true;
      console.error('\n[测试资源] 整轮超过硬截止（' + Math.round(TOTAL_DEADLINE_MS / 1000) + 's，独立监督进程），强制结束');
      // 异步终止：先给整组 SIGTERM，有界等待后升级 SIGKILL，等确认退出再决定资源是否释放。
      runControl.killProcessTreeAsync(child.pid, { group: useGroup })
        .catch(error => ({ killed: false, method: 'error', output: error.message }))
        .then(kill => {
          killPending = false;
          console.error('[测试资源] 终止测试进程树：' + kill.method + ' · 已确认退出=' + kill.killed);
          if (kill.killed) runControl.unregisterChild(runId, child.pid);
          settleOnce(finish(1, '整轮超时', { treeConfirmedDead: kill.killed === true }));
        });
    }, Math.max(100, TOTAL_DEADLINE_MS));

    child.on('error', error => {
      if (settled || killPending) return;
      clearTimeout(timer);
      console.error('测试进程启动失败：' + error.message);
      settleOnce(finish(1, '测试进程启动失败'));
    });

    child.on('close', code => {
      // 终止确认中先不收尾：等整组退出后再判定资源能否释放。
      if (settled || killPending) return;
      clearTimeout(timer);
      const exited = !runControl.isProcessAlive(child.pid);
      if (exited) runControl.unregisterChild(runId, child.pid);
      settleOnce(finish(Number.isInteger(code) ? code : 1));
    });
  });
}

const entry = process.argv.includes('--worker') ? runWorker() : runSupervisor();
entry
  .then(code => process.exit(code || 0))
  .catch(error => { console.error((error && error.stack) || error); process.exit(1); });
