// LAYER-CONTRACT-01：仓储层返回契约静态校验
// 背景：0.9.0.2 分层改造后，repositories 内多数函数返回 pg 的 Result（{rows,...}），
//       个别函数返回裸数组；调用方若按另一种形态取值不会报编译错，只会在运行时抛
//       “profiles is not iterable”这类错误（0.9.0.2 上线后 revisionStartupCatchup 即为此故障）。
// 约束：调用方按 { rows } 解构的函数必须返回 Result；按数组使用的函数不得被当成 Result 取 .rows。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverDir = path.join(__dirname, '..');
const repoDir = path.join(serverDir, 'repositories');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 解析每个仓储函数的返回形态：array（裸数组）/ result（pg Result 或 {rows}）/ unknown
function collectRepositoryReturnTypes() {
  const types = new Map();
  for (const file of fs.readdirSync(repoDir).filter(name => name.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(repoDir, file), 'utf8').split('\n');
    let current = null;
    let body = [];
    const flush = () => {
      if (!current) { body = []; return; }
      const text = body.join('\n');
      let type = 'unknown';
      if (/return\s+(rows|list|items|arr)\s*;/.test(text)) type = 'array';
      else if (/return\s+(client|pool|executor|conn)\s*\.\s*query\(/.test(text)) type = 'result';
      else if (/return\s+\{[^}]*\brows\b[^}]*\}/.test(text)) type = 'result';
      types.set(`${file}:${current}`, type);
      body = [];
    };
    for (const line of lines) {
      const match = line.match(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
      if (match) { flush(); current = match[1]; continue; }
      if (current) body.push(line);
    }
    flush();
  }
  return types;
}

const returnTypes = collectRepositoryReturnTypes();
const problems = [];

for (const file of walk(serverDir).filter(p => !p.includes(`${path.sep}repositories${path.sep}`))) {
  const src = fs.readFileSync(file, 'utf8');
  const aliases = new Map();
  let match;
  const requireRe = /const\s+([A-Za-z0-9_]+)\s*=\s*require\((['"])([^'"]*repositories\/[^'"]+)\2\)/g;
  while ((match = requireRe.exec(src))) aliases.set(match[1], path.basename(match[3]));
  if (!aliases.size) continue;

  for (const [alias, repoFile] of aliases) {
    const rowsDestructure = new RegExp(`const\\s*\\{\\s*rows[^}]*\\}\\s*=\\s*await\\s+${alias}\\.([A-Za-z0-9_]+)\\s*\\(`, 'g');
    while ((match = rowsDestructure.exec(src))) {
      const fn = match[1];
      if (returnTypes.get(`${repoFile}:${fn}`) !== 'array') continue;
      const line = src.slice(0, match.index).split('\n').length;
      problems.push(`${path.relative(serverDir, file)}:${line} ${alias}.${fn}() 返回裸数组，却被按 { rows } 解构`);
    }

    const plainCall = new RegExp(`const\\s+([A-Za-z0-9_]+)\\s*=\\s*await\\s+${alias}\\.([A-Za-z0-9_]+)\\s*\\(`, 'g');
    while ((match = plainCall.exec(src))) {
      const varName = match[1];
      const fn = match[2];
      if (returnTypes.get(`${repoFile}:${fn}`) !== 'array') continue;
      const rest = src.slice(match.index + match[0].length);
      if (!new RegExp(`\\b${varName}\\s*(\\?\\.)?\\.rows\\b`).test(rest)) continue;
      const line = src.slice(0, match.index).split('\n').length;
      problems.push(`${path.relative(serverDir, file)}:${line} ${varName} = ${alias}.${fn}() 返回裸数组，却被当 Result 访问 ${varName}.rows`);
    }
  }
}

assert.ok(returnTypes.size > 100, `仓储函数解析数量异常：${returnTypes.size}`);
assert.deepStrictEqual(problems, [], '仓储层返回契约冲突：\n' + problems.join('\n'));
console.log(`OK repository-layer-contract: 扫描 ${returnTypes.size} 个仓储函数，调用方返回值契约一致`);
process.exit(0);
