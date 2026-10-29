// TEMPLATE-INJECT-01：模板字符串内不得出现 JS 导出块/代码片段
// 背景：0.9.0.2 的分层重构在把 SQL 与代码来回搬移时，把 `module.exports = {...}` 整块
//       插进了两条 SQL 模板字符串中间（convertibleBondRedemptionSyncRepository 的待解析公告查询、
//       jobScheduleSlotsRepository 的 IPO 日历水位查询），文件语法仍然合法，只在运行时
//       报 `syntax error at or near ...`。此前两道门禁（返回契约、未声明标识符）都查不出文本被污染。
//       本门禁扫描 server/ 与 scripts/ 的模板字符串原文，禁止出现导出块特征。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const RULE_ID = 'TEMPLATE-INJECT-01';
const ROOT = path.join(__dirname, '..', '..');
const TARGETS = ['server', 'scripts'];

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'vendor') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 测试文件可能合法携带代码片段文本（如用 String.raw 生成探针脚本），只查生产代码
      if (entry.name === 'test') continue;
      listFiles(full, out);
    } else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const problems = [];
let scanned = 0;
for (const target of TARGETS) {
  const base = path.join(ROOT, target);
  if (!fs.existsSync(base)) continue;
  for (const file of listFiles(base)) {
    scanned++;
    let ast;
    try {
      ast = acorn.parse(fs.readFileSync(file, 'utf8'), {
        ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true,
        allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      });
    } catch (error) {
      problems.push(`${path.relative(ROOT, file)} 语法解析失败：${error.message}`);
      continue;
    }
    walk.full(ast, node => {
      if (node.type !== 'TemplateLiteral') return;
      for (const quasi of node.quasis) {
        const raw = quasi.value.raw;
        const line = quasi.loc ? quasi.loc.start.line : 0;
        if (/module\.exports/.test(raw)) {
          problems.push(`${path.relative(ROOT, file)}:${line} 模板字符串内出现 module.exports（导出块被插进文本）`);
        }
        if (/^\s*[A-Za-z_$][\w$]*,\s*$/m.test(raw) && /^\s*\};\s*$/m.test(raw)) {
          problems.push(`${path.relative(ROOT, file)}:${line} 模板字符串内疑似包含 JS 导出列表`);
        }
      }
    });
  }
}

const unique = [...new Set(problems)].sort();
assert.deepStrictEqual(unique, [], `模板字符串被代码污染 ${unique.length} 处：\n` + unique.slice(0, 20).join('\n'));
console.log(`OK ${RULE_ID} template-injection: 扫描 ${scanned} 个后端文件，模板字符串未见代码污染`);
process.exit(0);
