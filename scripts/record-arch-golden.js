#!/usr/bin/env node
// 应用分层等价基线工具（批次0，整改方案 7.2）。
//
// 用途：用固定 case-set 记录/比对迁移前后的返回结构与关键数值，
// 替代逐批手工拼快照。case-set 与动态排除名单都写在
// governance/architecture-golden-cases.json，逐项固定，不得忽略整个
// diagnostics 或空字段来隐藏差异。
//
// 约束：
//   - 只调用登记为 readonly 的受控只读入口；不触发刷新、外采、补写快照或自动迁移。
//   - 连接前开启 default_transaction_read_only，并在报告中给出实际生效证据。
//   - 无法采集（无库/无数据/入口不可用）记 not_available 或 blocked，
//     不写成通过；CI 不允许自动重录预期值。
//
// 用法：
//   node scripts/record-arch-golden.js --record
//   node scripts/record-arch-golden.js --compare
//   node scripts/record-arch-golden.js --compare --json
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

// 注意：只读开关必须在建立连接前设置，且只在命令行入口内生效。
// 放在模块顶层会污染同进程的其他调用方（测试 require 本模块后连接会变成只读）。
const ROOT = path.resolve(__dirname, '..');
const TOOL_VERSION = '1.0.0';
const CASES_PATH = path.join(ROOT, 'governance', 'architecture-golden-cases.json');
const OUTPUT_DIR = path.join(ROOT, 'server', 'test', 'fixtures', 'architecture-golden');

function loadCases() {
  const definition = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  validateCases(definition);
  return definition;
}

function validateCases(definition) {
  for (const item of definition.cases || []) {
    if (item.entry === 'server/repositories/accountsRepository.js') {
      const username = item.params && item.params[0] && item.params[0].username;
      if (typeof username !== 'string' || !/^arch_golden_test_[a-z0-9_]+$/.test(username)) {
        throw new Error(`账户基线必须使用隔离库预置的合成账号：${item.id}`);
      }
    }
  }
}

function gitHead(rootDir = ROOT) {
  const result = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitDirty(rootDir = ROOT) {
  const result = childProcess.spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: rootDir, encoding: 'utf8' });
  return result.status === 0 ? Boolean(result.stdout.trim()) : null;
}

// 递归归一：对象键排序，逐项剔除登记的动态字段。
function normalizeValue(value, excludeFields, currentPath = '') {
  if (Array.isArray(value)) return value.map((item, index) => normalizeValue(item, excludeFields, `${currentPath}[${index}]`));
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      if (excludeFields.includes(key) || excludeFields.includes(childPath)) continue;
      output[key] = normalizeValue(value[key], excludeFields, childPath);
    }
    return output;
  }
  return value;
}

// 结构化差异：输出 JSON 路径，便于定位业务字段变化。
function diffValues(left, right, currentPath = 'value', diffs = []) {
  if (left === right) return diffs;
  const leftType = Array.isArray(left) ? 'array' : left === null ? 'null' : typeof left;
  const rightType = Array.isArray(right) ? 'array' : right === null ? 'null' : typeof right;
  if (leftType !== rightType) {
    diffs.push({ path: currentPath, expected: leftType, actual: rightType });
    return diffs;
  }
  if (leftType === 'array') {
    if (left.length !== right.length) diffs.push({ path: `${currentPath}.length`, expected: left.length, actual: right.length });
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) diffValues(left[index], right[index], `${currentPath}[${index}]`, diffs);
    return diffs;
  }
  if (leftType === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      diffValues(left[key], right[key], `${currentPath}.${key}`, diffs);
    }
    return diffs;
  }
  diffs.push({ path: currentPath, expected: left, actual: right });
  return diffs;
}

async function readonlyEvidence(pool) {
  try {
    const result = await pool.query(
      `SELECT current_setting('default_transaction_read_only') AS default_read_only,
              current_setting('transaction_read_only') AS transaction_read_only,
              current_database() AS database`
    );
    return { ok: true, ...result.rows[0] };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function schemaFingerprint(pool) {
  try {
    const result = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')) AS tables,
              (SELECT COALESCE(MAX(version),'') FROM schema_migrations) AS latest_migration`
    );
    return result.rows[0];
  } catch (error) {
    return { tables: null, latest_migration: null, error: error.message };
  }
}

async function runCase(pool, testCase) {
  const startedAt = Date.now();
  try {
    const modulePath = path.join(ROOT, testCase.entry);
    const loaded = require(modulePath);
    const fn = loaded[testCase.export];
    if (typeof fn !== 'function') {
      return { status: 'blocked', reason: `入口未导出函数：${testCase.entry}#${testCase.export}`, durationMs: Date.now() - startedAt };
    }
    let value = await fn(...(testCase.params || []));
    // pick：入口返回 pg result 时只取关心的字段（rows 等），避免把驱动元数据写进基线。
    if (testCase.pick) value = value == null ? value : value[testCase.pick];
    const normalized = normalizeValue(value, []);
    const durationMs = Date.now() - startedAt;
    const empty = normalized === null || normalized === undefined
      || (Array.isArray(normalized) && normalized.length === 0)
      || (typeof normalized === 'object' && !Array.isArray(normalized) && Object.keys(normalized).length === 0);
    return { status: empty ? 'not_available' : 'ok', value: normalized, durationMs };
  } catch (error) {
    return { status: 'blocked', reason: error.message, durationMs: Date.now() - startedAt };
  }
}

async function collect({ pool }) {
  const definition = loadCases();
  const excludeFields = definition.excludeFields || [];
  const cases = {};
  for (const testCase of definition.cases || []) {
    const result = await runCase(pool, testCase);
    if (result.status === 'ok') {
      cases[testCase.id] = {
        ...result,
        value: normalizeValue(result.value, excludeFields),
        entry: testCase.entry,
        export: testCase.export,
      };
    } else {
      cases[testCase.id] = { ...result, entry: testCase.entry, export: testCase.export };
    }
  }
  return {
    schemaVersion: 1,
    caseSet: definition.caseSet,
    toolVersion: TOOL_VERSION,
    baselineCommit: gitHead(),
    dirty: gitDirty(),
    recordedAt: new Date().toISOString(),
    excludeFields,
    readonlyGuards: {
      entryRegistry: (definition.cases || []).every(item => item.readonly === true || item.readonly === undefined),
      pgOptions: process.env.PGOPTIONS,
      ...(await readonlyEvidence(pool)),
      schema: await schemaFingerprint(pool),
    },
    cases,
  };
}

function summarize(record) {
  const entries = Object.entries(record.cases || {});
  const counts = entries.reduce((acc, [, item]) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  return { total: entries.length, counts };
}

// ---------- 性能基线（方案 7.2 / 7.2.1） ----------
// 采样：默认预热 5 次，3 组各 30 次，以组 p95 的中位数作基准；
// 预算：T ≤ B + min(20%×B, 50ms)，20% 与 50ms 取更严者。
const PERF_DEFAULTS = { warmup: 5, groups: 3, samplesPerGroup: 30 };

function percentile(values, p) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function perfBudget(baseP95, currentP95) {
  if (!Number.isFinite(baseP95) || baseP95 <= 0) {
    return { ok: false, reason: '基准 p95 不是有效正数，按待测处理', allowed: null };
  }
  const allowed = Math.min(baseP95 * 0.2, 50);
  return { ok: currentP95 <= baseP95 + allowed, allowed, limit: baseP95 + allowed };
}

// EXPLAIN 只取摘要，不默认 ANALYZE；保存节点类型、代价、行数与是否含顺序扫描。
async function explainSummary(pool, sql, params) {
  try {
    const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${sql}`, params || []);
    const plan = rows[0]['QUERY PLAN'][0].Plan;
    return {
      nodeType: plan['Node Type'],
      totalCost: plan['Total Cost'],
      planRows: plan['Plan Rows'],
      sequentialScan: /"Node Type": "Seq Scan"/.test(JSON.stringify(plan)),
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function measurePerf(pool, testCase) {
  const settings = { ...PERF_DEFAULTS, ...(testCase.perf || {}) };
  const loaded = require(path.join(ROOT, testCase.entry));
  const fn = loaded[testCase.export];
  if (typeof fn !== 'function') return { status: 'blocked', reason: `入口未导出函数：${testCase.entry}#${testCase.export}` };
  for (let index = 0; index < settings.warmup; index += 1) await fn(...(testCase.params || []));

  const originalQuery = pool.query.bind(pool);
  let statementCount = 0;
  let timedCalls = 0;
  const groups = [];
  pool.query = (...args) => { statementCount += 1; return originalQuery(...args); };
  try {
    for (let group = 0; group < settings.groups; group += 1) {
      const samples = [];
      for (let index = 0; index < settings.samplesPerGroup; index += 1) {
        const startedAt = process.hrtime.bigint();
        await fn(...(testCase.params || []));
        samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
        timedCalls += 1;
      }
      groups.push({ p50: percentile(samples, 50), p95: percentile(samples, 95) });
    }
  } finally {
    pool.query = originalQuery;
  }
  const groupP95 = groups.map(group => group.p95);
  const groupP50 = groups.map(group => group.p50);
  return {
    status: 'ok',
    // 这是服务调用耗时，不是 HTTP 接口耗时；未测试 HTTP 栈时不得标为接口耗时。
    measure: 'service_call_ms',
    p50: percentile(groupP50, 50),
    p95: percentile(groupP95, 50),
    groups,
    settings,
    statementsPerCall: timedCalls ? Number((statementCount / timedCalls).toFixed(2)) : null,
    explain: testCase.explainSql ? await explainSummary(pool, testCase.explainSql, testCase.explainParams) : null,
  };
}

async function collectPerf(pool) {
  const definition = loadCases();
  const cases = {};
  for (const testCase of definition.cases || []) {
    if (!testCase.perf) continue;
    cases[testCase.id] = {
      ...(await measurePerf(pool, testCase)),
      entry: testCase.entry,
      export: testCase.export,
    };
  }
  return {
    schemaVersion: 1,
    kind: 'performance',
    caseSet: definition.caseSet,
    toolVersion: TOOL_VERSION,
    baselineCommit: gitHead(),
    dirty: gitDirty(),
    recordedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, cpus: require('os').cpus().length },
    schema: await schemaFingerprint(pool),
    budgetRule: 'T ≤ B + min(20%×B, 50ms)',
    readonlyGuards: { pgOptions: process.env.PGOPTIONS },
    cases,
  };
}

function comparePerf(recorded, current) {
  const diffs = [];
  // 遍历并集：只遍历当前侧会漏掉"基线有、当前被删除"的用例，从而假通过。
  const ids = new Set([...Object.keys(recorded.cases || {}), ...Object.keys(current.cases || {})]);
  for (const id of [...ids].sort()) {
    const expected = (recorded.cases || {})[id];
    const actual = (current.cases || {})[id];
    if (!expected) { diffs.push({ case: id, reason: '基线中没有该 case' }); continue; }
    if (!actual) { diffs.push({ case: id, reason: '当前没有该 case（用例被删除或未执行）' }); continue; }
    if (expected.status !== 'ok' || actual.status !== 'ok') {
      diffs.push({ case: id, reason: `任一侧未测出（基线 ${expected.status}／当前 ${actual.status}）` });
      continue;
    }
    const budget = perfBudget(expected.p95, actual.p95);
    const statementRegression = Number.isFinite(expected.statementsPerCall) && Number.isFinite(actual.statementsPerCall)
      && actual.statementsPerCall > expected.statementsPerCall;
    if (!budget.ok || statementRegression) {
      diffs.push({
        case: id,
        reason: budget.ok ? '查询次数增加（不能只靠总耗时过线掩盖 N+1）' : '超出默认性能预算',
        baseP95: expected.p95,
        currentP95: actual.p95,
        limit: budget.limit,
        statements: [expected.statementsPerCall, actual.statementsPerCall],
      });
    }
  }
  return { ok: diffs.length === 0, diffs };
}

function perfFixturePath(record) {
  return path.join(OUTPUT_DIR, `perf__${record.caseSet}__${String(record.baselineCommit || 'unknown').slice(0, 12)}.json`);
}

async function runPerfMode(options, pool) {
  if (options.mode === 'perf-record') {
    const record = await collectPerf(pool);
    if (!Object.keys(record.cases).length) throw new Error('没有登记 perf 的 case，拒绝生成空基线');
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const target = options.file ? path.resolve(options.file) : perfFixturePath(record);
    if (fs.existsSync(target)) throw new Error(`拒绝覆盖已存在的性能基线：${target}`);
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    console.log(`性能基线已记录：${path.relative(ROOT, target)}`);
    for (const [id, item] of Object.entries(record.cases)) {
      console.log(`  ${id}：p50 ${item.p50?.toFixed(1)}ms／p95 ${item.p95?.toFixed(1)}ms，每次调用 ${item.statementsPerCall} 条语句`);
    }
    console.log('说明：以上为服务调用耗时，不是 HTTP 接口耗时；EXPLAIN 未使用 ANALYZE。');
    return;
  }
  const latest = options.file
    ? path.resolve(options.file)
    : (() => {
        const caseSet = loadCases().caseSet;
        if (!fs.existsSync(OUTPUT_DIR)) return null;
        const files = fs.readdirSync(OUTPUT_DIR).filter(file => file.startsWith(`perf__${caseSet}__`)).sort();
        return files.length ? path.join(OUTPUT_DIR, files[files.length - 1]) : null;
      })();
  if (!latest || !fs.existsSync(latest)) throw new Error(`没有可比对的性能基线：${OUTPUT_DIR}/perf__*.json`);
  const recorded = JSON.parse(fs.readFileSync(latest, 'utf8'));
  const current = await collectPerf(pool);
  const result = comparePerf(recorded, current);
  console.log(`性能比对（基线 ${path.relative(ROOT, latest)}）：${result.ok ? '通过' : '失败'}`);
  for (const [id, item] of Object.entries(current.cases)) {
    if (item.status === 'ok') console.log(`  ${id}：p95 ${item.p95?.toFixed(1)}ms（基线 ${recorded.cases[id]?.p95?.toFixed(1)}ms）`);
  }
  for (const diff of result.diffs) console.log(`  ✗ ${diff.case}：${diff.reason} ${diff.baseP95 ? `基准 ${diff.baseP95.toFixed(1)}ms／当前 ${diff.currentP95.toFixed(1)}ms／上限 ${Number(diff.limit).toFixed(1)}ms` : ''}`);
  if (!result.ok) process.exitCode = 1;
}


function compare(recorded, current) {
  const diffs = [];
  const ids = new Set([...Object.keys(recorded.cases || {}), ...Object.keys(current.cases || {})]);
  for (const id of [...ids].sort()) {
    const expected = recorded.cases[id];
    const actual = current.cases[id];
    if (!expected) { diffs.push({ case: id, path: 'case', expected: '(未记录)', actual: '新增' }); continue; }
    if (!actual) { diffs.push({ case: id, path: 'case', expected: '已记录', actual: '(缺失)' }); continue; }
    if (expected.status !== actual.status) {
      diffs.push({ case: id, path: 'status', expected: expected.status, actual: actual.status });
      continue;
    }
    if (expected.status !== 'ok') {
      // 两侧都没采到数据（如本地无事实、诊断项不可用）不构成等价证据，不能算通过。
      diffs.push({
        case: id, path: 'status', expected: expected.status, actual: actual.status,
        reason: '两侧都未采到数据，未构成等价证据',
      });
      continue;
    }
    for (const item of diffValues(expected.value, actual.value, 'value')) diffs.push({ case: id, ...item });
  }
  const notAvailable = Object.entries(current.cases || {})
    .filter(([, item]) => item.status !== 'ok')
    .map(([id, item]) => ({ id, status: item.status, reason: item.reason || null }));
  return { ok: diffs.length === 0, diffs, notAvailable };
}

function parseArgs(argv) {
  const options = { mode: null, json: false, file: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--record') options.mode = 'record';
    else if (value === '--compare') options.mode = 'compare';
    else if (value === '--perf-record') options.mode = 'perf-record';
    else if (value === '--perf-compare') options.mode = 'perf-compare';
    else if (value === '--json') options.json = true;
    else if (value === '--file') options.file = argv[++index];
    else throw new Error(`未知参数：${value}`);
  }
  return options;
}

function fixturePath(record) {
  const name = `${record.caseSet}__${String(record.baselineCommit || 'unknown').slice(0, 12)}.json`;
  return path.join(OUTPUT_DIR, name);
}

function findLatestFixture(caseSet) {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const files = fs.readdirSync(OUTPUT_DIR).filter(file => file.startsWith(`${caseSet}__`) && file.endsWith('.json')).sort();
  return files.length ? path.join(OUTPUT_DIR, files[files.length - 1]) : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.mode) {
    console.error('用法：node scripts/record-arch-golden.js --record | --compare');
    process.exit(2);
  }
  // 采集前把连接置为只读事务：只允许读取已落库事实，禁止刷新/外采/补写。
  process.env.PGOPTIONS = `${process.env.PGOPTIONS || ''} -c default_transaction_read_only=on`.trim();
  let pool;
  try {
    ({ pool } = require(path.join(ROOT, 'server', 'db', 'connection.js')));
  } catch (error) {
    console.error(`等价基线无法连接数据库，记为待测而非通过：${error.message}`);
    process.exit(2);
  }

  if (options.mode === 'perf-record' || options.mode === 'perf-compare') {
    try {
      await runPerfMode(options, pool);
    } catch (error) {
      console.error(`性能基线未执行/失败：${error.message}`);
      await pool.end().catch(() => {});
      process.exit(2);
    }
    await pool.end().catch(() => {});
    return;
  }

  let record;
  try {
    record = await collect({ pool });
  } catch (error) {
    console.error(`等价基线采集失败，记为待测而非通过：${error.message}`);
    await pool.end().catch(() => {});
    process.exit(2);
  }

  const summary = summarize(record);
  if (options.mode === 'record') {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const target = options.file ? path.resolve(options.file) : fixturePath(record);
    if (fs.existsSync(target)) {
      console.error(`拒绝覆盖已存在的基线：${target}（基线只增不改，避免悄悄放宽容忍度）`);
      await pool.end().catch(() => {});
      process.exit(2);
    }
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    if (options.json) console.log(JSON.stringify({ ok: true, target, summary, readonlyGuards: record.readonlyGuards }, null, 2));
    else {
      console.log(`等价基线已记录：${path.relative(ROOT, target)}`);
      console.log(`case ${summary.total} 个：${JSON.stringify(summary.counts)}；基准提交 ${String(record.baselineCommit).slice(0, 12)}`);
      console.log(`只读保障：default_transaction_read_only=${record.readonlyGuards.default_read_only || '(未知)'}，库 ${record.readonlyGuards.database || '(未知)'}`);
      if (summary.counts.not_available) console.log('注意：存在 not_available 的 case，按待测记录，不视为通过。');
    }
    await pool.end().catch(() => {});
    return;
  }

  const fixture = options.file ? path.resolve(options.file) : findLatestFixture(record.caseSet);
  if (!fixture || !fs.existsSync(fixture)) {
    console.error(`没有可比对的基线：${fixture || `${OUTPUT_DIR}/${record.caseSet}__*.json`}`);
    await pool.end().catch(() => {});
    process.exit(2);
  }
  const recorded = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const result = compare(recorded, record);
  if (options.json) {
    console.log(JSON.stringify({ ok: result.ok, fixture: path.relative(ROOT, fixture), diffs: result.diffs, notAvailable: result.notAvailable }, null, 2));
  } else {
    console.log(`等价比对（基线 ${path.relative(ROOT, fixture)}）：${result.ok ? '通过' : '失败'}`);
    console.log(`case ${summary.total} 个：${JSON.stringify(summary.counts)}`);
    for (const diff of result.diffs.slice(0, 50)) {
      console.log(`  ✗ ${diff.case} ${diff.path}：期望 ${JSON.stringify(diff.expected)}，实际 ${JSON.stringify(diff.actual)}`);
    }
    if (result.diffs.length > 50) console.log(`  ……另有 ${result.diffs.length - 50} 条差异`);
    for (const item of result.notAvailable) console.log(`  ⊘ ${item.id} 未采集（${item.status}）：${item.reason || '无数据'}，按待测记录`);
  }
  await pool.end().catch(() => {});
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async error => {
    console.error(`等价基线工具失败：${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  validateCases,
  PERF_DEFAULTS,
  TOOL_VERSION,
  compare,
  comparePerf,
  diffValues,
  normalizeValue,
  parseArgs,
  percentile,
  perfBudget,
  summarize,
  fixturePath,
};
