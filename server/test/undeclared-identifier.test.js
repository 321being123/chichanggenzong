// UNDEF-01：未声明标识符静态检查
// 背景：0.9.0.2 分层重构把 SQL 与编排搬来搬去时丢了变量定义——先是仓储返回值形态不一致，
//       接着是服务内 `configuredLimit` 定义被删、引用残留，两条都只在生产启动时以
//       ReferenceError 暴露（`profiles is not iterable`、`configuredLimit is not defined`）。
//       字符串断言（includes）看不出这类缺失，故用语法树做作用域级检查：任何标识符若在
//       自身作用域链上找不到声明、也不是运行时全局，即判失败。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const RULE_ID = 'UNDEF-01';
const ROOT = path.join(__dirname, '..', '..');
const TARGETS = ['server', 'scripts'];
const GLOBALS = new Set([
  'require', 'module', 'exports', 'process', 'console', 'Buffer', '__dirname', '__filename', 'arguments',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'fetch', 'AbortController', 'AbortSignal', 'structuredClone',
  'globalThis', 'global', 'Promise', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'ReferenceError', 'EvalError', 'URIError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'BigInt', 'Intl', 'Reflect', 'Proxy', 'ArrayBuffer', 'DataView',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray', 'performance', 'crypto', 'navigator', 'window', 'document',
  'localStorage', 'sessionStorage', 'undefined', 'NaN', 'Infinity', 'Function', 'eval', 'atob', 'btoa',
]);

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'vendor') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function collectPatternNames(node, names) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': names.add(node.name); break;
    case 'ObjectPattern': node.properties.forEach(p => collectPatternNames(p.value || p.argument, names)); break;
    case 'ArrayPattern': node.elements.forEach(e => collectPatternNames(e, names)); break;
    case 'AssignmentPattern': collectPatternNames(node.left, names); break;
    case 'RestElement': collectPatternNames(node.argument, names); break;
    default: break;
  }
}

// 宽松收集一个语句里可见的声明名（含 if/for 单语句体，宁可漏报不误报）
function collectStatementNames(statement, names) {
  if (!statement) return;
  switch (statement.type) {
    case 'VariableDeclaration':
      statement.declarations.forEach(d => collectPatternNames(d.id, names));
      break;
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      if (statement.id) names.add(statement.id.name);
      break;
    case 'IfStatement':
      collectStatementNames(statement.consequent, names);
      collectStatementNames(statement.alternate, names);
      break;
    case 'ForStatement':
      if (statement.init) collectStatementNames(statement.init, names);
      break;
    case 'ForOfStatement':
    case 'ForInStatement':
      if (statement.left && statement.left.type === 'VariableDeclaration') collectStatementNames(statement.left, names);
      break;
    case 'TryStatement':
      collectStatementNames(statement.block, names);
      break;
    case 'BlockStatement':
      statement.body.forEach(item => collectStatementNames(item, names));
      break;
    default: break;
  }
}

function scopeDeclares(scopeNode, name) {
  const names = new Set();
  if (scopeNode.type === 'Program' || scopeNode.type === 'BlockStatement' || scopeNode.type === 'StaticBlock') {
    (scopeNode.body || []).forEach(item => collectStatementNames(item, names));
  } else if (scopeNode.type === 'CatchClause') {
    collectPatternNames(scopeNode.param, names);
  } else if (scopeNode.params) {
    scopeNode.params.forEach(param => collectPatternNames(param, names));
    if (scopeNode.body && scopeNode.body.type === 'BlockStatement') {
      scopeNode.body.body.forEach(item => collectStatementNames(item, names));
    }
  }
  return names.has(name);
}

function isSkippableReference(node, parent) {
  if (!parent) return true;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return true;
  if (parent.type === 'OptionalMemberExpression' && parent.property === node && !parent.computed) return true;
  if (parent.type === 'Property' && parent.key === node && !parent.computed) return true;
  if ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed) return true;
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return true;
  if (parent.type === 'VariableDeclarator' && parent.id === node) return true;
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration'
    || parent.type === 'ClassExpression') && parent.id === node) return true;
  if (Array.isArray(parent.params) && parent.params.includes(node)) return true;
  if (parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern' || parent.type === 'AssignmentPattern' || parent.type === 'RestElement') return true;
  if (parent.type.endsWith('Specifier') || parent.type === 'ImportDeclaration') return true;
  if (parent.type === 'ExportSpecifier') return true;
  if (parent.type === 'CatchClause' && parent.param === node) return true;
  return false;
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
    walk.fullAncestor(ast, (node, _state, ancestors) => {
      if (node.type !== 'Identifier') return;
      if (!node.loc) return;
      const chain = ancestors || [];
      const parent = chain[chain.length - 2];
      if (isSkippableReference(node, parent)) return;
      if (GLOBALS.has(node.name)) return;
      for (let index = chain.length - 1; index >= 0; index--) {
        if (scopeDeclares(chain[index], node.name)) return;
      }
      problems.push(`${path.relative(ROOT, file)}:${node.loc.start.line} 引用未声明标识符 ${node.name}`);
    });
  }
}

const unique = [...new Set(problems)].sort();
assert.deepStrictEqual(unique, [], `未声明标识符 ${unique.length} 处：\n` + unique.slice(0, 40).join('\n'));
console.log(`OK ${RULE_ID} undeclared-identifier: 扫描 ${scanned} 个后端文件，未发现未声明标识符`);
process.exit(0);
