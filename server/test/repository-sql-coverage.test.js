// 数据层 SQL 可执行性覆盖（2026-10-30）
//
// 两类断言：
//   ① 纯函数：提取器要能正确处理模板串、单引号、SQL 的 '' 转义、JS 的 \' 转义，以及拼接/插值；
//   ② 连库：把 986 条静态 SQL 逐条 PREPARE，失败集合必须与 governance/repository-sql-known-failures.json
//      完全一致——出现未登记失败=回归；登记了却已通过=清单过期（要求同步删除登记）。
// 没有可用 PostgreSQL 时按项目协议打印 [SKIP]，不冒充通过。
const assert = require('assert');
const path = require('path');
const coverage = require('../scripts/acceptanceRepositorySql');

const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    failures.push(name + ' :: ' + error.message);
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}

// ---------- 1) 提取器纯函数 ----------
check('模板字符串 SQL 能被完整提取', function () {
  const source = [
    'async function list() {',
    '  return client.query(`SELECT id, name',
    '    FROM users WHERE id=$1`, [1]);',
    '}',
  ].join('\n');
  const items = coverage.extractFromSource(source, 'x.js');
  assert.strictEqual(items.length, 1);
  assert.ok(items[0].sql.includes('FROM users'));
  assert.strictEqual(items[0].dynamic, false);
  assert.strictEqual(items[0].fn, 'list');
});

check('JS 的 \\\' 转义要还原成 SQL 的单引号', function () {
  const source = "pool.query('SELECT to_char(now(),\\'YYYY-MM-DD\\') AS d FROM t')";
  const items = coverage.extractFromSource(source, 'x.js');
  assert.strictEqual(items.length, 1);
  assert.ok(!items[0].sql.includes('\\'), '不能把反斜杠留给数据库：' + items[0].sql);
  assert.ok(items[0].sql.includes("to_char(now(),'YYYY-MM-DD')"));
});

check('SQL 里的 \'\'（两个单引号）不会被当成字符串结束', function () {
  // 真实写法：把字段置空字符串 a=''，提取器不能在这里误判字符串结束
  const source = [
    'client.query(`UPDATE accounts SET fee_settings=\'\' WHERE username=$1`, [u])',
  ].join('\n');
  const items = coverage.extractFromSource(source, 'x.js');
  assert.strictEqual(items.length, 1);
  assert.ok(items[0].sql.includes("fee_settings='' WHERE username=$1"), items[0].sql);
  assert.strictEqual(items[0].dynamic, false);
});

check('模板插值 ${...} 记为动态、不参与校验', function () {
  const source = 'pool.query(`SELECT * FROM t WHERE ${clause}`)';
  const items = coverage.extractFromSource(source, 'x.js');
  assert.strictEqual(items[0].dynamic, true);
  assert.strictEqual(items[0].reason, 'template');
});

check('字符串拼接（字面量后紧跟 +）记为动态', function () {
  const source = "pool.query('SELECT id FROM t ' + (where ? 'WHERE ' + where : ''))";
  const items = coverage.extractFromSource(source, 'x.js');
  assert.strictEqual(items[0].dynamic, true);
  assert.strictEqual(items[0].reason, 'concatenation');
});

check('不以语句关键字开头的字符串不当作 SQL', function () {
  const items = coverage.extractFromSource("logger.info('账户不存在，请重试')", 'x.js');
  assert.strictEqual(items.length, 0);
});

check('白名单比对：新增失败与过期登记都要被发现', function () {
  const known = [{ file: 'a.js', line: 1, fn: 'x' }, { file: 'b.js', line: 2, fn: 'y' }];
  const failed = [{ file: 'a.js', line: 1, fn: 'x' }, { file: 'c.js', line: 3, fn: 'z' }];
  const diff = coverage.compareWithKnown(failed, known);
  assert.deepStrictEqual(diff.unexpected.map(item => item.file), ['c.js'], '未登记的失败要被标出');
  assert.deepStrictEqual(diff.stale.map(item => item.file), ['b.js'], '已登记但已修好的要被标出');
});

// ---------- 2) 真实扫描 + PREPARE ----------
(async function main() {
  const single = coverage.collectStatements(['server/repositories'], ROOT);
  check('真实源码里能扫到成规模的 SQL（防止提取器悄悄退化）', function () {
    assert.ok(single.length > 800, 'repositories 下扫到的 SQL 太少：' + single.length);
    assert.ok(single.some(item => item.dynamic), '动态拼接应被识别出来而不是漏掉');
  });

  const database = process.env.PGTESTDATABASE || 'portfolio_test';
  const { Client } = require('pg');
  const client = new Client({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
  } catch (error) {
    console.log('[SKIP] 本地 PostgreSQL 不可用（' + error.message + '），未做连库校验');
  }

  if (connected) {
    try {
      const statements = coverage.collectStatements(coverage.DEFAULT_DIRS, ROOT);
      const result = await coverage.prepareStatements(client, statements);
      const known = coverage.loadKnownFailures();
      const diff = coverage.compareWithKnown(result.failed, known);
      const key = item => item.file + ':' + item.line;

      console.log(`  连库结果：${statements.length} 条，可校验 ${result.passed.length + result.failed.length} 条，`
        + `通过 ${result.passed.length}，失败 ${result.failed.length}（已登记 ${known.length}）`);

      check('没有未登记的 SQL 解析失败（新增坏 SQL 会在这里红）', function () {
        assert.deepStrictEqual(diff.unexpected.map(key), [],
          '未登记失败：' + diff.unexpected.map(item => `${key(item)} [${item.code}] ${item.message}`).join('；'));
      });
      check('已知失败清单与事实一致（修好后要同步删登记）', function () {
        assert.deepStrictEqual(diff.stale.map(key), [],
          '这些条目本次已通过，请从 governance/repository-sql-known-failures.json 删除：' + diff.stale.map(key).join('；'));
      });
      check('可静态校验的语句占多数（动态拼接不能成为免检借口）', function () {
        const preparable = result.passed.length + result.failed.length;
        assert.ok(preparable > 900, '可校验语句只有 ' + preparable + ' 条，检查是否有大范围漏抓');
      });
    } finally {
      await client.end().catch(function () {});
    }
  }

  console.log('\n数据层 SQL 可执行性：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) failures.forEach(function (item) { console.log(' - ' + item); });
  process.exit(fail ? 1 : 0);
})();
