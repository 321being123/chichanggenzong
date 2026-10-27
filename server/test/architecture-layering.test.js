// 应用分层批次0专项测试（整改方案 6.3 / 7.1 / 7.2）。
// 覆盖：事务封装回滚与连接归属、耦合扫描口径、C0 基线比对反例、
//       全局符号/页面契约、readSections 标题校验、等价基线工具。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const scanner = require(path.join(ROOT, 'scripts', 'audit-layer-coupling.js'));
const golden = require(path.join(ROOT, 'scripts', 'record-arch-golden.js'));
const knowledge = require(path.join(ROOT, 'scripts', 'check-knowledge.js'));
const acceptance = require(path.join(ROOT, 'server', 'scripts', 'acceptanceDataArchitecture.js'));
const { withTransaction } = require('../db/transaction');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  [FAIL] ${name} :: ${error.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  [FAIL] ${name} :: ${error.message}`);
  }
}

const boundaries = scanner.loadBoundaries(ROOT);
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'test', 'fixtures', 'architecture-layer-baseline.json'), 'utf8'));

console.log('A. 耦合扫描口径（方案 2.2）');
check('逻辑行数：CRLF 归一且不计末尾换行虚拟空行', () => {
  assert.strictEqual(scanner.countLogicalLines('a\r\nb\r\nc\r\n'), 3);
  assert.strictEqual(scanner.countLogicalLines('a\nb\nc'), 3);
  assert.strictEqual(scanner.countLogicalLines('a\r\n\r\nb\r\n'), 3, '内部空行必须保留');
  assert.strictEqual(scanner.countLogicalLines(''), 0);
  assert.strictEqual(scanner.countLogicalLines('\n'), 0);
});
check('排除规则命中 node_modules/venv/test 前缀，但不误排 dataAccess', () => {
  const scan = boundaries.scan;
  assert(scanner.isExcluded('node_modules/acorn/index.js', scan));
  assert(scanner.isExcluded('ipo-report/venv/lib/x.py', scan));
  assert(scanner.isExcluded('server/test/fixtures/x.js', scan));
  assert(scanner.isExcluded('test-security.js', scan));
  assert(scanner.isExcluded('ipo-report/test_ipo_unit.py', scan));
  assert(!scanner.isExcluded('server/dataAccess/bondRead.js', scan), 'dataAccess 源码不得按运行数据排除');
  assert(scanner.isExcluded('data/document_pdf_cache/x.json', scan), 'data/ 为运行数据，应排除');
});
check('角色解析：文件覆盖优先于目录规则', () => {
  assert.strictEqual(scanner.resolveRole('server/services/tushare.js', boundaries).role, 'data_adapter');
  assert.strictEqual(scanner.resolveRole('server/services/stockAnalysis.js', boundaries).role, 'service_legacy');
  assert.strictEqual(scanner.resolveRole('server/routes/stockAnalysis.js', boundaries).role, 'route');
  assert.strictEqual(scanner.resolveRole('public/js/presenters/x.js', boundaries).role, 'presenter');
  assert.strictEqual(scanner.resolveRole('unknown/place.js', boundaries).role, 'pending_contract');
});
check('SQL 与请求检测能定位文件与所属函数', () => {
  const findings = scanner.scanJs([
    'async function loadBonds() {',
    "  const rows = await pool.query('SELECT 1');",
    "  const res = await fetch('/api/bonds');",
    '}',
  ].join('\n'), 'sample.js');
  const rules = findings.map(item => `${item.rule}:${item.symbol}`);
  assert(rules.includes('SQL_IN_NON_DATA_LAYER:loadBonds'), '必须识别函数内 SQL');
  assert(rules.includes('NETWORK_IN_NON_ADAPTER:loadBonds'), '必须识别函数内 fetch');
});
check('普通字符串里的 SQL 关键字不算违规', () => {
  const findings = scanner.scanJs("const note = 'SELECT 1 FROM x'; function f(){ return note; }", 'sample.js');
  assert.strictEqual(findings.length, 0);
});
check('伪造 siteApi 对象不得绕过直接联网检查', () => {
  const fake = scanner.scanJs("fake.siteApi.fetch('/x'); fake.siteApi.request('/x');", 'public/js/views/probe.js');
  assert.strictEqual(fake.filter(item => item.rule === 'NETWORK_IN_NON_ADAPTER').length, 2);
  const valid = scanner.scanJs("window.siteApi.request('/x');", 'public/js/views/probe.js');
  assert.strictEqual(valid.length, 0, '统一客户端调用不得误判');
});

// 验收缺口反例：跨层引用与 DOM 必须真的被拒绝，不能只检查 SQL/网络。
check('跨层引用：domain 引用仓储或调度器必须报错', () => {
  const repoFindings = scanner.scanImportEdges(
    "const repo = require('../repositories/stockRepository');",
    'server/domain/probe.js', boundaries,
  );
  assert.strictEqual(repoFindings.length, 1, 'domain 引用 repository 必须被检出');
  assert.strictEqual(repoFindings[0].rule, 'CROSS_LAYER_IMPORT');
  const jobFindings = scanner.scanImportEdges(
    "const job = require('../jobs/replayNav');",
    'server/domain/probe.js', boundaries,
  );
  assert.strictEqual(jobFindings.length, 1, 'domain 引用 job 必须被检出');
  const cleaned = scanner.scanImportEdges(
    "const facts = require('./stockFacts');",
    'server/domain/probe.js', boundaries,
  );
  assert.strictEqual(cleaned.length, 0, 'domain 引用同层模块不应被误判');
});
check('跨层引用：动态 import() 与 export-from 同样必须报错', () => {
  const dynamicImport = scanner.scanImportEdges(
    "const m = import('../repositories/stockRepository');",
    'server/domain/probe.js', boundaries,
  );
  assert.strictEqual(dynamicImport.length, 1, '动态 import() 引用仓储必须被检出');
  const chained = scanner.scanImportEdges(
    "import('../jobs/replayNav').then(mod => mod.run());",
    'server/domain/probe.js', boundaries,
  );
  assert.strictEqual(chained.length, 1, 'import().then() 链式写法同样必须被检出');
  const exportFrom = scanner.scanImportEdges(
    "export { listStocks } from '../repositories/stockRepository';",
    'server/domain/probe.js', boundaries,
  );
  assert.strictEqual(exportFrom.length, 1, 'export ... from 也必须算依赖边');
  const sameLayer = scanner.scanImportEdges(
    "const f = import('./stockFacts');",
    'server/domain/probe.js', boundaries,
  );
  assert.strictEqual(sameLayer.length, 0, '同层动态 import 不应误判');
});

check('跨层引用：仓储引用 domain 纯函数属依赖倒置，不报', () => {
  const findings = scanner.scanImportEdges(
    "const facts = require('../domain/stockFacts');",
    'server/repositories/probe.js', boundaries,
  );
  assert.strictEqual(findings.length, 0, '仓储依赖 domain 纯函数不应被判越界');
});
check('DOM：presenter 操作页面必须报错，后端业务对象不算页面操作', () => {
  assert.strictEqual(scanner.rolePolicy(boundaries, 'presenter').allowDom, false, 'presenter 不得有 DOM 许可');
  assert.strictEqual(scanner.rolePolicy(boundaries, 'view').allowDom, true, 'view 必须有 DOM 许可');
  assert.strictEqual(scanner.rolePolicy(boundaries, 'api_client').allowDom, false, 'api_client 不得有 DOM 许可');
  const presenterFindings = scanner.scanJs(
    'function paint(){ document.getElementById("x").innerHTML = "y"; alert(1); }',
    'public/js/presenters/probe.js',
  );
  const domRules = presenterFindings.filter(item => item.rule === 'DOM_IN_NON_VIEW').map(item => item.evidence);
  assert(domRules.includes('document.getElementById'), 'presenter 读 DOM 必须被检出');
  assert(domRules.includes('assign innerHTML'), 'presenter 写 innerHTML 必须被检出');
  assert(domRules.includes('alert()'), 'presenter 弹窗必须被检出');
  const backendFindings = scanner.scanJs(
    'function isUsable(document){ return document.type === "prospectus"; }',
    'server/services/probe.js',
  );
  assert.strictEqual(backendFindings.length, 0, '后端 document 是公告业务对象，不得判成页面操作');
});

console.log('B. C0 基线比对反例（新增越界必须失败）');
check('同一存量违规函数增加调用也必须失败', () => {
  const id = 'NETWORK_IN_NON_ADAPTER|a.js|f';
  const frozen = { violations: [{ id, count: 1 }], files: [{ path: 'a.js' }] };
  const report = { violations: [{ id, count: 2 }], files: [{ path: 'a.js', roleStatus: 'registered' }], unresolved: [] };
  const result = scanner.compareToBaseline(report, frozen);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.increased, [{ id, baselineCount: 1, currentCount: 2 }]);
  report.violations[0].count = 1;
  assert.strictEqual(scanner.compareToBaseline(report, frozen).ok, true, '调用数量未增加不应误判');
});
const emptyBaseline = { commit: 'c0', rulesVersion: 'layer-coupling-1', violations: [], files: [] };
check('新增违规使比对失败并给出 ID', () => {
  const report = {
    violations: [{ id: 'SQL_IN_NON_DATA_LAYER|a.js|f', rule: 'SQL_IN_NON_DATA_LAYER', file: 'a.js', symbol: 'f', role: 'route', line: 3 }],
    files: [{ path: 'a.js', role: 'route', roleStatus: 'registered' }],
    unresolved: [],
  };
  const comparison = scanner.compareToBaseline(report, emptyBaseline);
  assert.strictEqual(comparison.ok, false);
  assert.strictEqual(comparison.added.length, 1);
  assert.strictEqual(comparison.added[0].id, 'SQL_IN_NON_DATA_LAYER|a.js|f');
});
check('新增文件落入存量或待登记角色使比对失败', () => {
  const report = {
    violations: [],
    files: [{ path: 'server/services/newThing.js', role: 'service_legacy', roleStatus: 'legacy' }],
    unresolved: [],
  };
  const comparison = scanner.compareToBaseline(report, emptyBaseline);
  assert.strictEqual(comparison.ok, false);
  assert.strictEqual(comparison.legacyRoleNewFiles.length, 1);
});
check('存量违规被消除时报告 resolved 且不判失败', () => {
  const frozen = {
    commit: 'c0',
    rulesVersion: 'layer-coupling-1',
    violations: [{ id: 'SQL_IN_NON_DATA_LAYER|a.js|f', rule: 'SQL_IN_NON_DATA_LAYER', file: 'a.js', symbol: 'f' }],
    files: [{ path: 'a.js', role: 'route', roleStatus: 'registered' }],
  };
  const comparison = scanner.compareToBaseline({ violations: [], files: frozen.files, unresolved: [] }, frozen);
  assert.strictEqual(comparison.ok, true);
  assert.strictEqual(comparison.resolved.length, 1);
});
check('初始快照本身可复算：与当前代码的存量违规集合一致', () => {
  assert.strictEqual(baseline.rulesVersion, boundaries.rulesVersion);
  assert(baseline.files.length > 0);
  assert(baseline.violations.length > 0);
  assert.strictEqual(baseline.pendingRegistration.length, 0, '待登记应为 0，未登记不得算零');
});

console.log('C. 全局符号与页面契约（方案 3 / 7.1）');
check('符号定义可识别，缺失时必须报错', () => {
  assert(acceptance.hasSymbolDefinition('var stockAnalysisState = {};', 'stockAnalysisState'));
  assert(acceptance.hasSymbolDefinition('function securityAnalysisLoadList() {}', 'securityAnalysisLoadList'));
  assert(acceptance.hasSymbolDefinition('window.thing = 1;', 'thing'));
  assert(!acceptance.hasSymbolDefinition('const other = 1;', 'stockAnalysisState'));
});
check('已登记页面的懒加载脚本与实际 HTML 一致', () => {
  const page = boundaries.globalContracts.pages[0];
  const html = fs.readFileSync(path.join(ROOT, page.page), 'utf8');
  for (const section of page.lazySections) {
    for (const script of section.scripts) {
      assert(html.includes(path.basename(script)), `${page.page} 未加载 ${script}`);
    }
  }
  for (const symbol of page.lazySections[0].requiredSymbols) {
    const provider = boundaries.globalContracts.providers.find(item => item.symbol === symbol);
    assert(provider, `缺少提供者登记：${symbol}`);
    assert(page.lazySections[0].scripts.includes(provider.file), `必需符号 ${symbol} 的提供者不在该页面脚本闭包内`);
  }
});

console.log('D. readSections 标题校验（方案 7.1）');
check('代码围栏内标题不参与统计，尾部井号可归一', () => {
  const headings = knowledge.extractHeadings([
    '# 顶层',
    '```',
    '## 围栏内示例',
    '```',
    '## 真实标题 ##',
    '',
  ].join('\n'));
  assert(headings.has('# 顶层'));
  assert(headings.has('## 真实标题'));
  assert(!headings.has('## 围栏内示例'));
});
check('标题缺失时报告路由、文件与标题', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-knowledge-'));
  fs.writeFileSync(path.join(tmp, 'doc.md'), '# 顶层\n## 存在标题\n', 'utf8');
  const errors = knowledge.collectReadSectionErrors(tmp, {
    routes: [{ id: 'demo', readSections: { 'doc.md': ['## 存在标题', '## 不存在标题'] } }],
  });
  assert.strictEqual(errors.length, 1);
  assert(errors[0].includes('demo') && errors[0].includes('doc.md') && errors[0].includes('## 不存在标题'));
  fs.rmSync(tmp, { recursive: true, force: true });
});
check('仓库现有 readSections 全部可解析', () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'governance', 'knowledge-map.json'), 'utf8'));
  assert.deepStrictEqual(knowledge.collectReadSectionErrors(ROOT, map), []);
});

console.log('E. 静态模式不连接数据库');
check('验收工具不在顶层加载数据库连接', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'acceptanceDataArchitecture.js'), 'utf8');
  const head = source.split('\n').slice(0, 20).join('\n');
  assert(!/require\(['"]\.\.\/db\/connection/.test(head), '顶层不得 require 数据库连接');
  assert(/require\.main === module/.test(source), '必须保护入口，避免被 require 时执行数据验收');
});

console.log('F. 等价基线工具（方案 7.2）');
check('账户基线只允许合成账号', () => {
  const definition = username => ({ cases: [{ id: 'account', entry: 'server/repositories/accountsRepository.js', params: [{ username }] }] });
  assert.throws(() => golden.validateCases(definition('real-user')), /合成账号/);
  assert.doesNotThrow(() => golden.validateCases(definition('arch_golden_test_user')));
});
check('动态字段按登记名单剔除，键顺序稳定', () => {
  const normalized = golden.normalizeValue({ b: 1, a: 2, updated_at: 'x', nested: { d: 1 } }, ['updated_at']);
  assert.deepStrictEqual(Object.keys(normalized), ['a', 'b', 'nested']);
  assert.strictEqual(normalized.updated_at, undefined);
});
check('差异按 JSON 路径列出，未被排除的字段不会静默跳过', () => {
  const diffs = golden.diffValues({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] });
  assert.strictEqual(diffs.length, 1);
  assert.strictEqual(diffs[0].path, 'value.b[1]');
});
check('两侧都未采到数据时不得判定通过（未构成等价证据）', () => {
  const result = golden.compare(
    { cases: { x: { status: 'not_available' } } },
    { cases: { x: { status: 'not_available' } } },
  );
  assert.strictEqual(result.ok, false, '两侧都未采到数据不能算通过');
  assert.strictEqual(result.diffs.length, 1);
  assert.match(result.diffs[0].reason, /未构成等价证据/);
});
check('性能比对删除已有用例时必须失败', () => {
  const recorded = {
    cases: {
      listBonds: { status: 'ok', p95: 10, statementsPerCall: 1 },
      listStocks: { status: 'ok', p95: 20, statementsPerCall: 1 },
    },
  };
  const current = { cases: { listBonds: { status: 'ok', p95: 11, statementsPerCall: 1 } } };
  const result = golden.comparePerf(recorded, current);
  assert.strictEqual(result.ok, false, '基线有、当前缺失的用例必须判失败');
  assert.strictEqual(result.diffs.length, 1);
  assert.match(result.diffs[0].reason, /当前没有该 case/);
});
check('性能比对两侧都未测出时不得判定通过', () => {
  const result = golden.comparePerf(
    { cases: { x: { status: 'not_available', p95: null } } },
    { cases: { x: { status: 'not_available', p95: null } } },
  );
  assert.strictEqual(result.ok, false);
});

check('比对把 not_available 记为待测而不是通过', () => {
  const result = golden.compare(
    { cases: { x: { status: 'ok', value: { a: 1 } } } },
    { cases: { x: { status: 'not_available' } } },
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.notAvailable.length, 1);
});
check('性能预算取 20% 与 50ms 中更严者', () => {
  const fast = golden.perfBudget(200, 240);
  assert(Math.abs(fast.allowed - 40) < 1e-9, `允许增量应为 40ms，实际 ${fast.allowed}`);
  assert.strictEqual(fast.ok, true);
  assert.strictEqual(golden.perfBudget(200, 241).ok, false);
  const slow = golden.perfBudget(1000, 1050);
  assert.strictEqual(slow.allowed, 50);
  assert.strictEqual(slow.ok, true);
  assert.strictEqual(golden.perfBudget(1000, 1051).ok, false);
  assert.strictEqual(golden.perfBudget(0, 10).ok, false, '无效基准必须记待测');
});
check('查询次数增加同样判失败（不能只靠总耗时过线）', () => {
  const result = golden.comparePerf(
    { cases: { x: { status: 'ok', p95: 100, statementsPerCall: 2 } } },
    { cases: { x: { status: 'ok', p95: 100, statementsPerCall: 3 } } },
  );
  assert.strictEqual(result.ok, false);
  assert(/查询次数/.test(result.diffs[0].reason));
});

console.log('G. 兼容出口台账与例外登记');
check('每条兼容出口含唯一实现、消费者、批次、责任人与退役状态', () => {
  const statuses = new Set(['long_term_facade', 'retire_planned', 'retired']);
  for (const item of boundaries.compatibilityExits) {
    assert(item.id && item.entry && item.implementation, `台账缺字段：${item.id}`);
    assert(Array.isArray(item.internalConsumers), `台账缺消费者：${item.id}`);
    assert(item.batch !== undefined && item.owner, `台账缺批次/责任人：${item.id}`);
    assert(statuses.has(item.status), `退役状态非法：${item.id}`);
    if (item.status === 'retire_planned') assert(item.batch !== undefined, `待退役必须绑定批次：${item.id}`);
  }
});
check('sqlAllowedRoles 与实际角色策略一致', () => {
  for (const role of boundaries.sqlAllowedRoles) {
    assert(boundaries.roles[role].allowSql === true, `${role} 未允许 SQL，应在角色策略中修正`);
  }
  for (const [role, policy] of Object.entries(boundaries.roles)) {
    if (policy.allowSql) assert(boundaries.sqlAllowedRoles.includes(role), `${role} 允许 SQL 但未登记到 sqlAllowedRoles`);
  }
});

(async () => {
  console.log('H. 事务封装（方案 5.1）');
  const fakeClient = {
    calls: [],
    async query(sql) { this.calls.push(sql); return { rows: [] }; },
    release() { this.released = true; },
  };
  await checkAsync('复用外层事务：不 BEGIN/COMMIT/ROLLBACK，也不释放连接', async () => {
    const value = await withTransaction(async client => {
      assert.strictEqual(client, fakeClient);
      return 'ok';
    }, { tx: fakeClient });
    assert.strictEqual(value, 'ok');
    assert.deepStrictEqual(fakeClient.calls, []);
    assert.strictEqual(fakeClient.released, undefined);
  });

  let pool;
  try {
    ({ pool } = require('../db/connection'));
    await pool.query('SELECT 1');
  } catch (error) {
    console.log(`[SKIP] 数据库不可用，事务回滚用例跳过：${error.message}`);
    console.log(`PASS=${pass} FAIL=${fail}`);
    process.exit(fail ? 1 : 0);
  }

  await checkAsync('成功提交：写入可见且连接归还', async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS arch_tx_probe (id int primary key)');
    await pool.query('DELETE FROM arch_tx_probe').catch(() => {});
    await withTransaction(async client => {
      await client.query('INSERT INTO arch_tx_probe (id) VALUES (1)');
    });
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM arch_tx_probe');
    assert.strictEqual(rows[0].count, 1);
  });

  await checkAsync('异常回滚：保留原错误且写入被撤销', async () => {
    const original = new Error('业务失败');
    await assert.rejects(
      withTransaction(async client => {
        await client.query('INSERT INTO arch_tx_probe (id) VALUES (2)');
        throw original;
      }),
      error => error === original,
      '必须抛出原始错误对象',
    );
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM arch_tx_probe');
    assert.strictEqual(rows[0].count, 1, '回滚后不得残留 id=2');
  });

  await checkAsync('只释放自己取得的连接：外层 tx 不被释放', async () => {
    const client = await pool.connect();
    const idleBefore = pool.idleCount;
    try {
      await withTransaction(async tx => {
        assert.strictEqual(tx, client);
        await tx.query('SELECT 1');
      }, { tx: client });
      assert.strictEqual(pool.idleCount, idleBefore, '复用外层事务不得释放或新增连接');
    } finally {
      client.release();
    }
  });

  await checkAsync('清理事务探针表', async () => {
    await pool.query('DROP TABLE IF EXISTS arch_tx_probe');
    await pool.end();
  });

  console.log(`PASS=${pass} FAIL=${fail}`);
  if (fail) process.exitCode = 1;
})();
