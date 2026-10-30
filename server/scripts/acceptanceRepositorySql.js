#!/usr/bin/env node
// 数据层 SQL 可执行性验收（2026-10-30）
//
// 目的：把数据层里写死的 SQL 逐条拿到真实库结构上做 `PREPARE`，验证「语法 + 表/列 + 类型」
// 真的能被数据库解析。只分析、不执行、不写任何数据。
//
// 为什么需要：2026-10-30 发现补「持仓基准快照」的 INSERT 自 0.9.1.2 起从未成功执行——
// `daily_prices.date` 是 TEXT 却与 `$3::date` 争抢参数类型（PG 报「操作符不存在: text = date」），
// `round(double precision, int)` 也不存在。两处都是纯 SQL 解析错误，但当时的分层静态扫描
// 是 505 文件、越界 0/0/0，完全看不出来。静态合规、职责清晰、SQL 能跑是三件事。
//
// 覆盖口径：
//   - 扫描 server/repositories/ 与 server/db/ 下的 .query(`...`) / .query('...') 字面量；
//   - 含 `${}` 动态拼接的语句静态无法还原，单独统计并在报告里列出，不当作已覆盖；
//   - 每条语句在隔离库上 PREPARE，失败按 PostgreSQL 错误码归类。
// 已登记的历史失败放在 governance/repository-sql-known-failures.json：登记必须与事实一致——
// 出现白名单外的失败即视为回归，白名单内的条目修好后要求同步删除登记。
//
// 用法：
//   node server/scripts/acceptanceRepositorySql.js [--json <输出文件>] [--dirs a,b] [--quiet]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_DIRS = ['server/repositories', 'server/db'];
const KNOWN_FAILURES_PATH = path.join(ROOT, 'governance', 'repository-sql-known-failures.json');

// 只认「以语句关键字开头」的字符串，避免把日志文本、WHERE 片段误当成 SQL。
const STATEMENT_START = /^\s*(select|insert|update|delete|with|values)\b/i;
// SQL 里用两个单引号表示引号（`''`），JS 里又可能写 `\'`；两种都要能跨过，
// 否则会在第一个引号处截断，产出一堆「语法错误」的假失败（2026-10-30 实测踩到）。
// 注意：单引号分支里不要再加 `''`——在 JS 源码层面 `'a''b'` 本身就是非法写法，
// SQL 的 `''` 只会出现在模板字符串里，而那由反引号分支负责，加了反而会跨语句吞掉后续 SQL。
// 也允许 `query(` 与 SQL 之间夹注释：加了注释就漏扫，等于这条 SQL 悄悄免检（2026-10-30 实测）。
const QUERY_LITERAL = /\.query\(\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g;

// 去掉外层引号并把 JS 转义还原成 SQL 原文：`\'` → `'`、`\\` → `\`、`\n` → 换行。
// 直接用 slice 取内容会把 `\'` 原样交给数据库，PG 在标准字符串里不认这个转义。
function decodeLiteral(raw) {
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = body[i + 1];
    if (next === undefined) { out += ch; continue; }
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else out += next;
  }
  return out;
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

// 语句所属函数/常量名：报告里要能直接定位到「哪个函数写了这条坏 SQL」。
function enclosingName(source, index) {
  const before = source.slice(0, index).split('\n');
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const match = before[i].match(/^(?:async\s+)?function\s+(\w+)/) || before[i].match(/^const\s+(\w+)\s*=/);
    if (match) return match[1];
  }
  return '(module-scope)';
}

function extractFromSource(source, file) {
  const out = [];
  QUERY_LITERAL.lastIndex = 0;
  let match;
  while ((match = QUERY_LITERAL.exec(source))) {
    const sql = decodeLiteral(match[1]).trim();
    if (!sql || !STATEMENT_START.test(sql)) continue;
    // 两种静态还原不了的写法都要排除，否则会产出一堆「语法错误」的假失败：
    //   ① 模板里插值 ${...}；② 字面量后面紧跟 + （SQL 由多段拼起来，如 'SELECT ...' + where + ' ORDER BY'）。
    const afterLiteral = source.slice(match.index + match[0].length).replace(/^\s+/, '');
    const concatenated = afterLiteral.startsWith('+');
    const hasInterpolation = match[1].startsWith('`') && sql.includes('${');
    const dynamic = concatenated || hasInterpolation;
    out.push({
      file,
      line: lineAt(source, match.index),
      fn: enclosingName(source, match.index),
      dynamic,
      reason: hasInterpolation ? 'template' : (concatenated ? 'concatenation' : null),
      sql: dynamic ? null : sql,
    });
  }
  return out;
}

function collectStatements(dirs = DEFAULT_DIRS, root = ROOT) {
  const statements = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) {
      if (!name.endsWith('.js')) continue;
      const file = path.posix.join(dir.split(path.sep).join('/'), name);
      const source = fs.readFileSync(path.join(abs, name), 'utf8');
      statements.push(...extractFromSource(source, file));
    }
  }
  return statements;
}

// PREPARE 只让数据库做语法/名称/类型解析：不产生行、不写数据，也不需要真实参数值。
async function prepareStatements(client, statements) {
  const passed = [];
  const failed = [];
  let index = 0;
  for (const statement of statements) {
    if (statement.dynamic || !statement.sql) continue;
    index += 1;
    const name = 'acceptance_sql_' + index;
    try {
      await client.query(`PREPARE ${name} AS ${statement.sql}`);
      passed.push({ file: statement.file, line: statement.line, fn: statement.fn });
    } catch (error) {
      failed.push({
        file: statement.file,
        line: statement.line,
        fn: statement.fn,
        code: error.code || 'unknown',
        message: String(error.message || error).slice(0, 300),
      });
    }
  }
  await client.query('DEALLOCATE ALL').catch(() => {});
  return { passed, failed };
}

function loadKnownFailures(file = KNOWN_FAILURES_PATH) {
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.items) ? data.items : [];
  } catch (error) {
    throw new Error('已登记失败清单无法解析：' + error.message);
  }
}

function keyOf(item) {
  return `${item.file}:${item.line}`;
}

// 比对白名单：新增失败是回归，白名单里修好的要求同步删除登记，避免清单和事实脱节。
function compareWithKnown(failed, known) {
  const knownKeys = new Set(known.map(keyOf));
  const actualKeys = new Set(failed.map(keyOf));
  return {
    unexpected: failed.filter(item => !knownKeys.has(keyOf(item))),
    stale: known.filter(item => !actualKeys.has(keyOf(item))),
  };
}

function summarize(statements, result) {
  const staticCount = statements.filter(item => !item.dynamic).length;
  const dynamic = statements.filter(item => item.dynamic);
  return {
    scannedFiles: new Set(statements.map(item => item.file)).size,
    statements: statements.length,
    preparable: staticCount,
    dynamic: dynamic.length,
    passed: result.passed.length,
    failed: result.failed.length,
  };
}

async function main(argv) {
  const args = argv.slice(2);
  const getValue = flag => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };
  const quiet = args.includes('--quiet');
  const outputPath = getValue('--json');
  const dirs = getValue('--dirs') ? getValue('--dirs').split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_DIRS;

  require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
  const { Client } = require('pg');
  const database = process.env.PGPREPAREDB || process.env.PGTESTDATABASE || process.env.PGDATABASE;
  if (!database) throw new Error('缺少数据库配置：请设置 PGTESTDATABASE 或 PGDATABASE');
  if (!/test|ci|accept/i.test(database)) {
    throw new Error(`拒绝在非隔离库上运行：${database}（这条命令只做解析，但仍不允许连业务库）`);
  }

  const statements = collectStatements(dirs);
  if (!statements.length) throw new Error('没有扫描到任何 SQL 语句，检查目录参数');

  const client = new Client({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database,
  });
  await client.connect();
  let result;
  try {
    result = await prepareStatements(client, statements);
  } finally {
    await client.end().catch(() => {});
  }

  const known = loadKnownFailures();
  const { unexpected, stale } = compareWithKnown(result.failed, known);
  const report = {
    generatedAt: new Date().toISOString(),
    database,
    dirs,
    summary: summarize(statements, result),
    unexpected,
    stale,
    failed: result.failed,
    dynamicStatements: statements
      .filter(item => item.dynamic)
      .map(item => ({ file: item.file, line: item.line, fn: item.fn, reason: item.reason })),
  };

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }

  if (!quiet) {
    const s = report.summary;
    console.log(`扫描 ${s.scannedFiles} 个文件 / ${s.statements} 条 SQL：可静态校验 ${s.preparable} 条，动态拼接 ${s.dynamic} 条`);
    console.log(`可解析 ${s.passed} 条，解析失败 ${s.failed} 条（已登记 ${known.length} 条）`);
    if (unexpected.length) {
      console.log('未登记的解析失败（视为回归）：');
      unexpected.forEach(item => console.log(`  ${item.file}:${item.line} [${item.code}] ${item.fn} —— ${item.message}`));
    }
    if (stale.length) {
      console.log('已登记但本次通过（请同步删除 governance/repository-sql-known-failures.json 中的登记）：');
      stale.forEach(item => console.log(`  ${item.file}:${item.line} ${item.fn}`));
    }
    if (outputPath) console.log('报告已写入：' + outputPath);
  }
  return unexpected.length || stale.length ? 1 : 0;
}

module.exports = {
  collectStatements,
  extractFromSource,
  prepareStatements,
  compareWithKnown,
  loadKnownFailures,
  summarize,
  DEFAULT_DIRS,
  KNOWN_FAILURES_PATH,
};

if (require.main === module) {
  main(process.argv)
    .then(code => process.exit(code))
    .catch(error => {
      console.error('数据层 SQL 可执行性验收失败：' + (error && error.message));
      process.exit(2);
    });
}
