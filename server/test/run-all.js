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
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client } = require('pg');

const testDir = __dirname;
const rootDir = path.join(__dirname, '..', '..');

let pass = 0, fail = 0, skip = 0;
const failed = [];
const isCI = process.env.CI === '1';
// 所有测试子进程统一隔离真实邮件；空字符串可阻止 dotenv 从开发机 .env 回填真实收件人。
// Python Guard 生产默认开启；测试进程显式关闭，避免纯函数回归因本机数据库状态产生外部副作用。
const testEnv = { ...process.env, NODE_ENV: 'test', EXTERNAL_CALL_GUARD: '0', ALERT_EMAIL_TO: '', ALERT_EMAIL_FROM: '' };
const TEST_DATABASE = String(process.env.PGTESTDATABASE || 'portfolio_test').replace(/[^a-zA-Z0-9_]/g, '_');

function testDatabaseConfig() {
  const configured = process.env.DATABASE_URL;
  if (configured) {
    const url = new URL(configured);
    url.pathname = '/' + TEST_DATABASE;
    return { connectionString: url.toString() };
  }
  return {
    host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || '', database: TEST_DATABASE,
  };
}

// 测试用例会故意创建 test_guard_* / cninfo-test 熔断记录验证持久化行为。
// 测试库是从业务库模板复制而来，必须在每轮测试前后清掉这些测试专属记录，
// 防止历史测试数据进入验收统计；绝不连接或修改业务库。
async function cleanupTestArtifacts() {
  const client = new Client(testDatabaseConfig());
  try {
    await client.connect();
    await client.query(`
      DELETE FROM ops.external_call_budgets
       WHERE source LIKE 'test_guard_%' OR source = 'cninfo-test'
    `);
    await client.query(`
      DELETE FROM ops.external_circuits
       WHERE source LIKE 'test_guard_%' OR source = 'cninfo-test'
    `);
  } finally {
    await client.end().catch(() => {});
  }
}

async function ensureTestDatabase() {
  // 测试必须运行在独立数据库；首次运行从当前业务库复制结构和本地样例数据。
  const configured = process.env.DATABASE_URL;
  let adminConfig;
  if (configured) {
    const url = new URL(configured);
    url.pathname = '/postgres';
    adminConfig = { connectionString: url.toString() };
  } else {
    adminConfig = {
      host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || '', database: 'postgres',
    };
  }
  const client = new Client(adminConfig);
  try {
    await client.connect();
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [TEST_DATABASE]);
    if (!exists.rowCount) {
      const source = String(process.env.PGDATABASE || 'portfolio').replace(/[^a-zA-Z0-9_]/g, '_');
      if (source !== TEST_DATABASE) await client.query(`CREATE DATABASE "${TEST_DATABASE}" TEMPLATE "${source}"`);
      else await client.query(`CREATE DATABASE "${TEST_DATABASE}"`);
    }
  } finally {
    await client.end().catch(() => {});
  }
  delete testEnv.DATABASE_URL;
  testEnv.PGDATABASE = TEST_DATABASE;
}

function runNode(file) {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: testEnv });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '(无输出)';
  // 识别测试自身标记的跳过（如空库迁移在无 PG 时打印 [SKIP]），不计入通过
  if (/\[SKIP\]|SKIP-/.test(out)) {
    skip++; console.log('  ⊘ ' + file + '  (跳过)  ——  ' + last);
  } else if (r.status === 0) { pass++; console.log('  ✓ ' + file + '  ——  ' + last); }
  else {
    fail++; failed.push(file);
    console.log('  ✗ ' + file + '  (退出码 ' + r.status + ')  ——  ' + last);
    console.log(out);
  }
}

function runNodeGlob() {
  const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
  console.log('【1/4 单元·集成测试】共 ' + files.length + ' 个文件');
  for (const f of files) runNode(path.join(testDir, f));
}

function runExtraNode() {
  console.log('\n【2/4 安全专项 + IPO 前端】');
  const extras = [
    path.join(rootDir, 'test-security.js'),
    path.join(rootDir, 'ipo-report', 'test_ipo_frontend.js'),
  ];
  for (const file of extras) {
    if (!fs.existsSync(file)) { skip++; console.log('  ⊘ ' + file + '  (文件不存在，跳过)'); continue; }
    runNode(file);
  }
}

function findPython() {
  // 优先项目内 venv（Windows: Scripts/python.exe；类 Unix: bin/python）
  const candidates = [
    path.join(rootDir, 'ipo-report', 'venv', 'Scripts', 'python.exe'),
    path.join(rootDir, 'ipo-report', 'venv', 'bin', 'python'),
    path.join(rootDir, 'venv', 'Scripts', 'python.exe'),
    path.join(rootDir, 'venv', 'bin', 'python'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // 退回 PATH 上的 python / python3
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0) return cmd;
  }
  return null;
}

function runPython() {
  console.log('\n【3/4 + 4/4 Python 功能测试】');
  const py = findPython();
  if (!py) { skip++; console.log('  ⊘ 未找到 Python 解释器，跳过 Python 功能测试'); return; }
  const pyFiles = [
    path.join(rootDir, 'ipo-report', 'test_ipo_unit.py'),
    path.join(rootDir, 'ipo-report', 'test_ipo_integration.py'),
    path.join(rootDir, 'ipo-report', 'test_ipo_history_sync.py'),
    path.join(rootDir, 'ipo-report', 'test_unit_fixes.py'),
    path.join(testDir, 'test_valuation_regression.py'),
  ].filter(f => fs.existsSync(f));
  if (pyFiles.length === 0) { skip++; console.log('  ⊘ 未找到 Python 测试文件，跳过'); return; }
  for (const file of pyFiles) {
    const r = spawnSync(py, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: testEnv });
    const out = (r.stdout || '') + (r.stderr || '');
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || '(无输出)';
    // 缺依赖/解释器环境异常：本地标 SKIP；CI 模式下视为失败（不允许关键测试跳过）
    const envErr = /ModuleNotFoundError|No module named|ImportError|Can't open file/.test(out);
    if (envErr) {
      if (isCI) { fail++; failed.push(path.basename(file)); console.log('  ✗ ' + path.basename(file) + '  (CI 模式下环境缺失视为失败)  ——  ' + last); }
      else { skip++; console.log('  ⊘ ' + path.basename(file) + '  (环境/依赖缺失，跳过)  ——  ' + last); }
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

(async () => {
  try {
    await ensureTestDatabase();
    await cleanupTestArtifacts();
  } catch (error) {
    console.error('测试隔离库初始化失败：', error.message);
    process.exit(1);
  }
  try {
    runNodeGlob();
    runExtraNode();
    runPython();
  } finally {
    try {
      await cleanupTestArtifacts();
    } catch (error) {
      fail++;
      failed.push('test-artifact-cleanup');
      console.error('测试专属熔断记录清理失败：', error.message);
    }
  }

  console.log('\n========================================');
  console.log('测试库 ' + TEST_DATABASE + ' · 通过 ' + pass + ' · 失败 ' + fail + ' · 跳过 ' + skip +
    (fail ? ' · 失败项：' + failed.join('、') : (skip ? '' : ' · 全部通过 ✅')));
  if (isCI && skip > 0) {
    console.log('CI 模式下不允许跳过关键测试（共跳过 ' + skip + ' 项），判定失败');
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})();
