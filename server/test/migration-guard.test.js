// ========== 迁移静态守卫（2026-10-23 部署事故后强制） ==========
// 生产迁移账号没有库级 CREATE 权限：CREATE SCHEMA IF NOT EXISTS 即使模式已存在
// 也会先查库级权限并报 "permission denied for database portfolio"，导致整次部署回滚
// （实录见 docs/生产部署流程.md 与 deploy/部署说明.md 零节第 2 条）。
// 本测试扫描迁移目录：禁止新增迁移出现无条件 CREATE SCHEMA，一律走
// "先查 information_schema.schemata、缺模式才建"（样板 era07Feedback.ensureSchema）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
// 历史文件：规则生效前已在生产执行完毕，不回改已应用迁移
const HISTORICAL = ['era01CoreSchema.js'];

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + (e && e.message)); console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
}

console.log('--- 迁移静态守卫 ---');

const files = fs.readdirSync(MIGRATIONS_DIR).filter(function (f) { return f.endsWith('.js'); });

// 扫描前去掉注释：说明文字里引用命令原文不算违规代码
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

test('新增迁移不得出现无条件 CREATE SCHEMA（历史文件除外）', function () {
  const offenders = [];
  files.forEach(function (f) {
    if (HISTORICAL.indexOf(f) >= 0) return;
    const src = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    // 只要出现 CREATE SCHEMA IF NOT EXISTS 代码就算违规（注释不算）；
    // 正确写法是运行时按需 CREATE SCHEMA <name>（ensureSchema 样板）
    if (/CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS/i.test(src)) offenders.push(f);
  });
  assert.deepStrictEqual(offenders, [], '这些迁移含无条件 CREATE SCHEMA：' + offenders.join(', ')
    + '——请改为先查 information_schema.schemata、缺模式才建（era07Feedback.ensureSchema 样板）');
});

test('样板 ensureSchema 仍然存在且按需建模式', function () {
  const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, 'era07Feedback.js'), 'utf8');
  const src = stripComments(raw);
  assert.ok(raw.indexOf('information_schema.schemata') > 0, 'ensureSchema 必须先查模式是否存在');
  assert.ok(!/CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS/i.test(src), 'era07 不得回退到 CREATE SCHEMA IF NOT EXISTS');
});

console.log('\n--- 汇总 ---');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) failures.forEach(function (f) { console.log(' - ' + f); });
process.exit(fail ? 1 : 0);
