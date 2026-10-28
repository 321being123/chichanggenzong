#!/usr/bin/env node
// 应用分层同源耦合扫描器（批次0，整改方案 2.2 / 6.3）。
//
// 职责：对指定 Git 提交（或工作区）的跟踪文件，按固定规则版本输出
//   1) 纳入/排除路径、文件数、逻辑行数（CRLF/CR 归一成 LF，保留注释与内部空行，
//      不计末尾换行产生的虚拟空行）
//   2) 每个文件的角色解析结果与待登记状态
//   3) 稳定违规 ID（文件 + 符号 + 规则，行号仅作证据）
// 同一规则版本的报告可直接比较；规则版本变化时必须对前后提交按同版重算，
// 不得把统计口径变化当成整改收益。
//
// 用法：
//   node scripts/audit-layer-coupling.js                      # 扫 HEAD，文本摘要
//   node scripts/audit-layer-coupling.js --json               # 扫 HEAD，完整 JSON
//   node scripts/audit-layer-coupling.js --commit 449254fa    # 指定提交
//   node scripts/audit-layer-coupling.js --worktree           # 扫工作区（含未跟踪新文件）
//   node scripts/audit-layer-coupling.js --write <path>       # 写报告文件
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BOUNDARIES_PATH = path.join(ROOT_DIR, 'governance', 'architecture-boundaries.json');
const SCANNER_VERSION = '1.1.0';

function loadBoundaries(rootDir = ROOT_DIR) {
  const filePath = path.join(rootDir, 'governance', 'architecture-boundaries.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalize(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function gitLines(rootDir, args) {
  const result = childProcess.spawnSync('git', args, { cwd: rootDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${String(result.stderr || '').trim()}`);
  return result.stdout.split('\0').filter(Boolean).map(normalize);
}

function resolveCommit(rootDir, ref) {
  const result = childProcess.spawnSync('git', ['rev-parse', ref], { cwd: rootDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`无法解析提交 ${ref}：${String(result.stderr || '').trim()}`);
  return result.stdout.trim();
}

function listTrackedFiles(rootDir, { commit = 'HEAD', worktree = false } = {}) {
  if (worktree) {
    return {
      commit: resolveCommit(rootDir, 'HEAD'),
      dirty: true,
      files: gitLines(rootDir, ['ls-files', '-co', '--exclude-standard', '-z']),
    };
  }
  const sha = resolveCommit(rootDir, commit);
  return { commit: sha, dirty: false, files: gitLines(rootDir, ['ls-tree', '-r', '--name-only', '-z', sha]) };
}

function readFileAt(rootDir, relativePath, { commit, worktree = false } = {}) {
  if (worktree) {
    const absolute = path.join(rootDir, relativePath);
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
  }
  const result = childProcess.spawnSync('git', ['show', `${commit}:${relativePath}`], {
    cwd: rootDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

// 历史提交批量读取：逐个 git show 在 Windows 上是分钟级开销，
// 这里用一次 git cat-file --batch 取回全部 blob。
function readFilesAtCommit(rootDir, commit, paths) {
  const out = new Map();
  if (!paths.length) return out;
  const treeResult = childProcess.spawnSync('git', ['ls-tree', '-r', '-z', '--long', commit], {
    cwd: rootDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (treeResult.status !== 0) throw new Error(`git ls-tree ${commit} 失败：${String(treeResult.stderr || '').trim()}`);
  const shaByPath = new Map();
  for (const entry of treeResult.stdout.split('\0')) {
    if (!entry) continue;
    const tabIndex = entry.indexOf('\t');
    if (tabIndex < 0) continue;
    const meta = entry.slice(0, tabIndex).trim().split(/\s+/);
    shaByPath.set(normalize(entry.slice(tabIndex + 1)), meta[2]);
  }
  const wanted = [];
  for (const file of paths) {
    const sha = shaByPath.get(file);
    if (sha) wanted.push({ file, sha });
  }
  if (!wanted.length) return out;
  const batchResult = childProcess.spawnSync('git', ['cat-file', '--batch'], {
    cwd: rootDir, input: `${wanted.map(item => item.sha).join('\n')}\n`,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (batchResult.status !== 0) throw new Error(`git cat-file 失败：${String(batchResult.stderr || '').trim()}`);
  const buffer = batchResult.stdout;
  let offset = 0;
  for (const item of wanted) {
    const newline = buffer.indexOf(10, offset);
    if (newline < 0) break;
    const header = buffer.slice(offset, newline).toString('utf8').split(' ');
    if (header[1] !== 'blob') { offset = newline + 1; continue; }
    const size = Number(header[2]);
    out.set(item.file, buffer.slice(newline + 1, newline + 1 + size).toString('utf8'));
    offset = newline + 1 + size + 1;
  }
  return out;
}

function countLogicalLines(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  if (!trimmed) return 0;
  return trimmed.split('\n').length;
}

function segmentMatch(filePath, segments) {
  const parts = filePath.split('/');
  return segments.some(segment => parts.includes(segment));
}

function isExcluded(filePath, scan) {
  const excluded = scan.excludePaths || [];
  for (const entry of excluded) {
    if (entry.endsWith('/')) {
      const prefix = entry;
      if (filePath === prefix.slice(0, -1)) return true;
      if (filePath.startsWith(prefix)) return true;
    } else if (filePath === entry) return true;
  }
  for (const segment of scan.excludeSegments || []) {
    if (segmentMatch(filePath, [segment])) return true;
  }
  const base = filePath.split('/').pop();
  for (const pattern of scan.excludeFilePatterns || []) {
    if (new RegExp(pattern).test(base)) return true;
  }
  return false;
}

function isScanned(filePath, scan) {
  const extensions = scan.includeExtensions || ['.js', '.py'];
  if (!extensions.some(ext => filePath.endsWith(ext))) return false;
  return !isExcluded(filePath, scan);
}

function matchLongestPrefix(filePath, entries) {
  let best = null;
  for (const entry of entries || []) {
    const prefix = normalize(entry.path || entry.prefix || '');
    if (!prefix) continue;
    const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (filePath === prefix || filePath.startsWith(withSlash)) {
      if (!best || prefix.length > normalize(best.path || best.prefix || '').length) best = entry;
    }
  }
  return best;
}

// 角色解析优先级：文件级覆盖 > 目录级规则 > 默认待登记。
function resolveRole(filePath, boundaries) {
  const override = (boundaries.fileRoles || []).find(entry => normalize(entry.path) === filePath);
  if (override) return { ...override, source: 'file' };
  const directory = matchLongestPrefix(filePath, boundaries.directoryRoles);
  if (directory) return { ...directory, source: 'directory' };
  return { role: boundaries.defaultRole || 'pending_contract', batch: 4, status: 'pending_contract', source: 'default' };
}

function rolePolicy(boundaries, role) {
  const roles = boundaries.roles || {};
  return roles[role] || roles.pending_contract || { allowSql: false, allowNetwork: false, allowDom: false, newFilesAllowed: false };
}

function loadAcorn() {
  try {
    return { acorn: require('acorn'), walk: require('acorn-walk') };
  } catch (error) {
    const wrapped = new Error(`缺少 AST 解析依赖 acorn/acorn-walk：${error.message}`);
    wrapped.code = 'MISSING_PARSER';
    throw wrapped;
  }
}

function parseJs(source, filePath) {
  const { acorn } = loadAcorn();
  const baseOptions = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowAwaitOutsideFunction: true };
  try {
    return acorn.parse(source, { ...baseOptions, sourceType: 'script' });
  } catch (scriptError) {
    try {
      return acorn.parse(source, { ...baseOptions, sourceType: 'module' });
    } catch (moduleError) {
      const error = new Error(`无法解析 JS：${filePath}：${scriptError.message}`);
      error.code = 'UNRESOLVED_PARSE';
      throw error;
    }
  }
}

// 符号归属：命名函数/方法/属性名优先；匿名回调继续向外层具名函数回溯，
// 避免同一处代码被包进 withTransaction 等包装器后 ID 从函数名漂移成 <anonymous>。
// 模块顶层代码统一记 <module>。
function functionNameOf(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (!node) continue;
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) continue;
    if (node.id && node.id.name) return node.id.name;
    const parent = ancestors[index - 1];
    if (parent && parent.type === 'VariableDeclarator' && parent.id && parent.id.name) return parent.id.name;
    if (parent && parent.type === 'AssignmentExpression' && parent.left) {
      if (parent.left.type === 'Identifier') return parent.left.name;
      if (parent.left.type === 'MemberExpression' && parent.left.property && parent.left.property.name) return parent.left.property.name;
    }
    if (parent && parent.type === 'MethodDefinition' && parent.key) return parent.key.name || '<method>';
    if (parent && (parent.type === 'Property' || parent.type === 'PropertyDefinition') && parent.key) {
      return parent.key.name || parent.key.value || '<property>';
    }
    // 匿名回调：继续向外层回溯，不提前返回 <anonymous>
  }
  return '<module>';
}

const SQL_KEYWORD = /\b(?:select\s+[\s\S]*?\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|with\s+\w+\s+as\s*\()/i;

function calleeName(node) {
  const callee = node.callee;
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) {
    const object = callee.object.type === 'Identifier' ? callee.object.name : null;
    const property = callee.property.name;
    return object ? `${object}.${property}` : property;
  }
  return null;
}

// 拼出完整调用路径（如 window.siteApi.request），用于识别统一请求入口。
function calleePath(node) {
  const callee = node && node.callee;
  if (!callee) return null;
  const parts = [];
  let cursor = callee;
  while (cursor && cursor.type === 'MemberExpression' && !cursor.computed) {
    parts.unshift(cursor.property.name);
    cursor = cursor.object;
  }
  if (!cursor || cursor.type !== 'Identifier') return null;
  parts.unshift(cursor.name);
  return parts.join('.');
}

// 统一请求入口（public/js/api/client.js）是页面唯一的传输点：
// 页面调用 siteApi.* 属于走适配层，不再算"非适配层直接联网"。
function viaSiteApi(node) {
  const path = calleePath(node);
  return !!path && /^(?:(?:window|globalThis|global)\.)?siteApi\.(?:request|requestRaw|requestOrThrow|fetchResponse|get|getRaw|post|put|del)$/.test(path);
}

function firstStringArgument(node) {
  const arg = node.arguments && node.arguments[0];
  if (!arg) return null;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral') {
    return arg.quasis.map(quasi => quasi.value.cooked || '').join('${}');
  }
  if (arg.type === 'BinaryExpression') {
    const collect = current => {
      if (!current) return '';
      if (current.type === 'Literal' && typeof current.value === 'string') return current.value;
      if (current.type === 'BinaryExpression') return collect(current.left) + collect(current.right);
      return '';
    };
    return collect(arg);
  }
  return null;
}

const JS_SQL_CALLEES = new Set([
  'pool.query', 'client.query', 'conn.query', 'connection.query', 'db.query', 'pgClient.query',
  'pool.execute', 'client.execute',
]);
const JS_NETWORK_CALLEES = new Set([
  'fetch', 'window.fetch', 'global.fetch', 'https.request', 'https.get',
  'http.request', 'http.get', 'axios', 'axios.get', 'axios.post', 'axios.request',
  'undici.request', 'request', 'got', 'got.get', 'got.post',
]);
const JS_NETWORK_CONSTRUCTORS = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource']);

// DOM 归属判定：只认 document / window.document 两类根，避免把同名局部变量当成页面操作。
function domObjectName(node) {
  if (!node) return null;
  if (node.type === 'Identifier' && node.name === 'document') return 'document';
  if (node.type === 'MemberExpression' && !node.computed) {
    const object = node.object;
    if (object && object.type === 'Identifier' && object.name === 'window'
      && node.property && node.property.name === 'document') return 'window.document';
  }
  return null;
}

function scanJs(source, filePath) {
  const { walk } = loadAcorn();
  const ast = parseJs(source, filePath);
  // DOM 规则只对前端资源生效：后端代码里的 document 是业务对象（如公告文档 document.type），
  // 不按浏览器全局处理，否则会把招股书/公告对象误判成页面操作。
  const domScope = /^public\//.test(filePath);
  const found = [];
  const push = (rule, node, symbol, evidence) => {
    found.push({ rule, file: filePath, symbol, line: node.loc ? node.loc.start.line : null, evidence });
  };
  walk.ancestor(ast, {
    CallExpression(node, _state, ancestors) {
      const name = calleeName(node);
      if (!name) return;
      const symbol = functionNameOf(ancestors);
      if (JS_SQL_CALLEES.has(name)) {
        push('SQL_IN_NON_DATA_LAYER', node, symbol, `${name}()`);
      } else if (name.endsWith('.query') || name.endsWith('.execute') || /^(?:query|executor)$/.test(name)) {
        const sql = firstStringArgument(node);
        if (sql && SQL_KEYWORD.test(sql)) push('SQL_IN_NON_DATA_LAYER', node, symbol, `${name}(<sql>)`);
      }
      if (JS_NETWORK_CALLEES.has(name) && !viaSiteApi(node)) {
        push('NETWORK_IN_NON_ADAPTER', node, symbol, `${name}()`);
      }
      if (domScope && (name === 'alert' || name === 'confirm' || name === 'prompt')) {
        push('DOM_IN_NON_VIEW', node, symbol, `${name}()`);
      }
    },
    NewExpression(node, _state, ancestors) {
      if (node.callee && node.callee.type === 'Identifier' && JS_NETWORK_CONSTRUCTORS.has(node.callee.name)) {
        push('NETWORK_IN_NON_ADAPTER', node, functionNameOf(ancestors), `new ${node.callee.name}`);
      }
    },
    AssignmentExpression(node, _state, ancestors) {
      if (!domScope) return;
      const left = node.left;
      if (!left || left.type !== 'MemberExpression') return;
      const prop = left.property && (left.property.name || left.property.value);
      if (prop === 'innerHTML' || prop === 'outerHTML') {
        push('DOM_IN_NON_VIEW', node, functionNameOf(ancestors), 'assign ' + prop);
      }
    },
    MemberExpression(node, _state, ancestors) {
      const root = domScope ? domObjectName(node.object) : null;
      if (root) {
        const prop = node.property && (node.property.name || node.property.value);
        push('DOM_IN_NON_VIEW', node, functionNameOf(ancestors), root + (prop ? '.' + prop : ''));
      }
      if (node.computed || !node.object || node.object.type !== 'Identifier') return;
      const name = `${node.object.name}.${node.property.name}`;
      if (name === 'navigator.sendBeacon') {
        push('NETWORK_IN_NON_ADAPTER', node, functionNameOf(ancestors), 'navigator.sendBeacon');
      }
    },
  });
  return found;
}

// 跨层引用：解析相对 require/import 落到哪个角色，与契约 layerRules.forbiddenImports 对照。
// 只解析项目内存量文件；指向第三方包或缺失文件的说明符不参与判定（不静默当成通过，
// 因为目标文件是否存在由 role_coverage 与 resolved 检出）。
function scanImportEdges(source, filePath, config, { rootDir = path.resolve(__dirname, '..') } = {}) {
  const sourceRole = resolveRole(filePath, config).role;
  const forbidden = new Set(((config.layerRules || {}).forbiddenImports || {})[sourceRole] || []);
  if (!forbidden.size) return [];
  const specifiers = new Set();
  const ast = parseJs(source, filePath);
  const { walk } = loadAcorn();
  walk.simple(ast, {
    CallExpression(node) {
      if (calleeName(node) !== 'require') return;
      const arg = node.arguments && node.arguments[0];
      if (arg && arg.type === 'Literal' && typeof arg.value === 'string') specifiers.add(arg.value);
    },
    ImportDeclaration(node) {
      if (node.source && typeof node.source.value === 'string') specifiers.add(node.source.value);
    },
    // 动态 import() 与 export ... from 同样构成依赖边：漏掉它们，改写成 import() 就能绕过跨层检查。
    ImportExpression(node) {
      const source = node.source;
      if (source && source.type === 'Literal' && typeof source.value === 'string') specifiers.add(source.value);
    },
    ExportNamedDeclaration(node) {
      if (node.source && typeof node.source.value === 'string') specifiers.add(node.source.value);
    },
    ExportAllDeclaration(node) {
      if (node.source && typeof node.source.value === 'string') specifiers.add(node.source.value);
    },
  });
  const findings = [];
  for (const spec of specifiers) {
    if (!spec.startsWith('.')) continue;
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), spec));
    const candidates = [joined, `${joined}.js`, `${joined}/index.js`];
    const target = candidates.find(candidate => fs.existsSync(path.join(rootDir, candidate)));
    if (!target) continue;
    const targetRole = resolveRole(target, config).role;
    if (!forbidden.has(targetRole)) continue;
    findings.push({
      rule: 'CROSS_LAYER_IMPORT',
      file: filePath,
      symbol: `import:${spec}`,
      line: null,
      evidence: `${sourceRole} 引用 ${targetRole}：require('${spec}') → ${target}`,
    });
  }
  return findings;
}

// Python 侧使用标准库 ast，由项目 Python 解释器执行；解析失败按未覆盖上报，不静默通过。
// 源码经 stdin 传入（显式 UTF-8 解码），不落临时文件。
const PYTHON_SCANNER = `
import ast, json, sys
SQL_CALLS = {"execute", "executemany", "read_sql", "read_sql_query", "read_sql_table", "to_sql"}
NETWORK_MODULES = {"requests", "httpx", "aiohttp", "urllib", "urllib3", "websocket", "websockets"}
def symbol_of(stack):
    for node in reversed(stack):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return node.name
    return "<module>"
def scan_one(path, source):
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as error:
        return {"unresolved": str(error), "findings": []}
    found = []
    class Visitor(ast.NodeVisitor):
        def __init__(self):
            self.stack = []
        def visit_FunctionDef(self, node):
            self.stack.append(node); self.generic_visit(node); self.stack.pop()
        def visit_AsyncFunctionDef(self, node):
            self.stack.append(node); self.generic_visit(node); self.stack.pop()
        def visit_ClassDef(self, node):
            self.stack.append(node); self.generic_visit(node); self.stack.pop()
        def visit_Import(self, node):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in NETWORK_MODULES:
                    found.append({"rule": "NETWORK_IN_NON_ADAPTER", "symbol": symbol_of(self.stack),
                                  "line": node.lineno, "evidence": "import " + alias.name})
            self.generic_visit(node)
        def visit_ImportFrom(self, node):
            root = (node.module or "").split(".")[0]
            if root in NETWORK_MODULES:
                found.append({"rule": "NETWORK_IN_NON_ADAPTER", "symbol": symbol_of(self.stack),
                              "line": node.lineno, "evidence": "from " + (node.module or "")})
            self.generic_visit(node)
        def visit_Call(self, node):
            func = node.func
            name = None
            if isinstance(func, ast.Attribute):
                base = func.value
                base_name = base.id if isinstance(base, ast.Name) else ""
                name = base_name + "." + func.attr if base_name else func.attr
            elif isinstance(func, ast.Name):
                name = func.id
            if name:
                leaf = name.split(".")[-1]
                if leaf in SQL_CALLS:
                    found.append({"rule": "SQL_IN_NON_DATA_LAYER", "symbol": symbol_of(self.stack),
                                  "line": node.lineno, "evidence": name + "()"})
                if name.split(".")[0] in ("requests", "httpx", "aiohttp"):
                    found.append({"rule": "NETWORK_IN_NON_ADAPTER", "symbol": symbol_of(self.stack),
                                  "line": node.lineno, "evidence": name + "()"})
            self.generic_visit(node)
    Visitor().visit(tree)
    return {"findings": found}
payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
print(json.dumps({item["file"]: scan_one(item["file"], item["source"]) for item in payload}))
`;

function resolvePython(rootDir) {
  const candidates = [
    path.join(rootDir, 'ipo-report', 'venv', 'Scripts', 'python.exe'),
    path.join(rootDir, 'ipo-report', 'venv', 'bin', 'python'),
    path.join(rootDir, 'venv', 'Scripts', 'python.exe'),
    path.join(rootDir, 'venv', 'bin', 'python'),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  for (const command of ['python', 'python3']) {
    const probe = childProcess.spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return command;
  }
  return null;
}

// 一次进程批量解析全部 Python 文件：Windows 下逐个启动解释器会把扫描拖到分钟级。
function scanPythonBatch(rootDir, entries) {
  if (!entries.length) return new Map();
  const python = resolvePython(rootDir);
  if (!python) {
    const error = new Error('未找到 Python 解释器，无法执行 Python AST 检查');
    error.code = 'MISSING_PARSER';
    throw error;
  }
  const result = childProcess.spawnSync(python, ['-c', PYTHON_SCANNER], {
    input: JSON.stringify(entries), encoding: 'utf8', cwd: rootDir, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  if (result.status !== 0) {
    const error = new Error(`Python AST 检查失败：${String(result.stderr || '').trim()}`);
    error.code = 'UNRESOLVED_PARSE';
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(String(result.stdout || '').trim().split('\n').pop());
  } catch (error) {
    const wrapped = new Error('Python AST 输出无法解析');
    wrapped.code = 'UNRESOLVED_PARSE';
    throw wrapped;
  }
  return new Map(Object.entries(payload).map(([file, value]) => [file, value]));
}

function violationId(rule, filePath, symbol) {
  return `${rule}|${filePath}|${symbol}`;
}

function summarizeDirectories(files) {
  const map = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    const directory = parts.length > 1 ? parts.slice(0, -1).join('/') : '<root>';
    const current = map.get(directory) || {
      directory, files: 0, lines: 0, sqlCandidates: 0, networkCandidates: 0, sqlModules: 0, networkModules: 0,
    };
    current.files += 1;
    current.lines += file.lines;
    const sqlHits = file.findings.sql || 0;
    const networkHits = file.findings.network || 0;
    current.sqlCandidates += sqlHits;
    current.networkCandidates += networkHits;
    if (sqlHits) current.sqlModules += 1;
    if (networkHits) current.networkModules += 1;
    map.set(directory, current);
  }
  return [...map.values()].sort((a, b) => b.lines - a.lines);
}

// 稳定违规 ID 按「规则 + 文件 + 符号」聚合：同一函数里的多处调用只算一条，
// 行号只作证据，避免代码上下移动造成台账漂移。
function aggregateViolations(entries) {
  const map = new Map();
  for (const entry of entries) {
    const existing = map.get(entry.id);
    if (!existing) {
      map.set(entry.id, { ...entry, count: 1, locations: [{ line: entry.line, evidence: entry.evidence }] });
      continue;
    }
    existing.count += 1;
    existing.locations.push({ line: entry.line, evidence: entry.evidence });
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const HTML_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function scanHtmlInlineScripts(rootDir, { commit, worktree = false } = {}) {
  const htmlFiles = listTrackedFiles(rootDir, { commit, worktree }).files.filter(file => /^public\/[^/]+\.html$/.test(file));
  const report = [];
  for (const file of htmlFiles) {
    const source = readFileAt(rootDir, file, { commit, worktree });
    if (source === null) continue;
    let match;
    let index = 0;
    const inline = [];
    while ((match = HTML_SCRIPT.exec(source)) !== null) {
      index += 1;
      const attributes = match[1] || '';
      const body = (match[2] || '').trim();
      inline.push({
        index,
        src: /src\s*=/i.test(attributes),
        module: /type\s*=\s*["']module["']/i.test(attributes),
        characters: body.length,
      });
    }
    report.push({ file, scripts: inline, nonEmptyInline: inline.filter(item => !item.src && item.characters > 0).length });
  }
  return report;
}

function scan(rootDir, { commit = 'HEAD', worktree = false, boundaries = null } = {}) {
  const config = boundaries || loadBoundaries(rootDir);
  const scanConfig = config.scan || {};
  const listing = listTrackedFiles(rootDir, { commit, worktree });
  const candidates = listing.files.filter(file => isScanned(file, scanConfig));
  const files = [];
  const rawViolations = [];
  const unresolved = [];
  const pendingMap = new Map();

  // 先一次性读源码（历史提交走批量 cat-file），再批量解析 Python，最后逐文件归类。
  const sources = new Map();
  if (worktree) {
    for (const file of candidates) {
      const source = readFileAt(rootDir, file, { commit: listing.commit, worktree: true });
      if (source !== null) sources.set(file, source);
    }
  } else {
    const batch = readFilesAtCommit(rootDir, listing.commit, candidates);
    for (const [file, source] of batch) sources.set(file, source);
  }
  const pythonResults = scanPythonBatch(
    rootDir,
    [...sources.entries()].filter(([file]) => file.endsWith('.py')).map(([file, source]) => ({ file, source })),
  );

  for (const [file, source] of sources) {
    const resolved = resolveRole(file, config);
    const policy = rolePolicy(config, resolved.role);
    const entry = {
      path: file,
      role: resolved.role,
      roleSource: resolved.source,
      batch: resolved.batch === undefined ? null : resolved.batch,
      roleStatus: resolved.status || 'registered',
      lines: countLogicalLines(source),
      findings: { sql: 0, network: 0 },
    };
    let findings = [];
    if (file.endsWith('.py')) {
      const result = pythonResults.get(file) || { findings: [] };
      if (result.unresolved) {
        unresolved.push({ file, reason: result.unresolved });
        entry.roleStatus = 'unresolved';
      }
      findings = (result.findings || []).map(item => ({ ...item, file }));
    } else {
      try {
        findings = scanJs(source, file);
        // 跨层引用按契约判定，不受 allowSql/allowNetwork 影响。
        findings = findings.concat(scanImportEdges(source, file, config, { rootDir }));
      } catch (error) {
        if (error.code === 'MISSING_PARSER') throw error;
        unresolved.push({ file, reason: error.message });
        entry.roleStatus = 'unresolved';
      }
    }
    entry.findings = findings.reduce((acc, finding) => {
      if (finding.rule === 'SQL_IN_NON_DATA_LAYER') acc.sql += 1;
      if (finding.rule === 'NETWORK_IN_NON_ADAPTER') acc.network += 1;
      if (finding.rule === 'DOM_IN_NON_VIEW') acc.dom += 1;
      if (finding.rule === 'CROSS_LAYER_IMPORT') acc.crossLayer += 1;
      return acc;
    }, { sql: 0, network: 0, dom: 0, crossLayer: 0 });
    for (const finding of findings) {
      // 每条规则由对应许可位决定：SQL 看 allowSql、DOM 看 allowDom、外采看 allowNetwork；
      // 跨层引用没有许可位，一律按契约 forbiddenImports 判定。
      const allowed = finding.rule === 'SQL_IN_NON_DATA_LAYER' ? policy.allowSql
        : finding.rule === 'DOM_IN_NON_VIEW' ? policy.allowDom
          : finding.rule === 'CROSS_LAYER_IMPORT' ? false
            : policy.allowNetwork;
      if (allowed) continue;
      if (resolved.role === 'pending_contract' || entry.roleStatus === 'pending_contract') {
        const pendingId = `${finding.rule}|${file}|${finding.symbol}`;
        if (!pendingMap.has(pendingId)) {
          pendingMap.set(pendingId, { id: pendingId, file, rule: finding.rule, symbol: finding.symbol, line: finding.line });
        }
        continue;
      }
      rawViolations.push({
        id: violationId(finding.rule, file, finding.symbol),
        rule: finding.rule,
        file,
        symbol: finding.symbol,
        role: resolved.role,
        batch: entry.batch,
        line: finding.line,
        evidence: finding.evidence,
      });
    }
    files.push(entry);
  }

  const violations = aggregateViolations(rawViolations);
  const pendingRegistration = [...pendingMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  const totals = files.reduce((acc, file) => {
    acc.files += 1;
    acc.lines += file.lines;
    return acc;
  }, { files: 0, lines: 0 });

  return {
    schemaVersion: 1,
    scanner: 'audit-layer-coupling',
    scannerVersion: SCANNER_VERSION,
    rulesVersion: config.rulesVersion || 'layer-coupling-1',
    commit: listing.commit,
    dirty: listing.dirty,
    scannedAt: new Date().toISOString(),
    scope: {
      includeExtensions: scanConfig.includeExtensions || ['.js', '.py'],
      excludePaths: scanConfig.excludePaths || [],
      excludeSegments: scanConfig.excludeSegments || [],
      excludeFilePatterns: scanConfig.excludeFilePatterns || [],
      excludedFiles: listing.files.filter(file => !isScanned(file, scanConfig)),
      files: totals.files,
      lines: totals.lines,
    },
    directories: summarizeDirectories(files),
    files,
    violations,
    pendingRegistration,
    unresolved,
    exceptions: config.exceptions || [],
    htmlInlineScripts: scanHtmlInlineScripts(rootDir, { commit: listing.commit, worktree }),
  };
}

function compareToBaseline(report, baseline) {
  const baselineIds = new Set((baseline.violations || []).map(item => item.id));
  const baselineById = new Map((baseline.violations || []).map(item => [item.id, item]));
  const baselineFiles = new Map((baseline.files || []).map(item => [item.path, item]));
  const currentIds = new Set(report.violations.map(item => item.id));
  const added = report.violations.filter(item => !baselineIds.has(item.id));
  const increased = report.violations.filter(item => baselineById.has(item.id) &&
    (item.count || 1) > (baselineById.get(item.id).count || 1)).map(item => ({
    id: item.id, baselineCount: baselineById.get(item.id).count || 1, currentCount: item.count || 1,
  }));
  const resolved = [...baselineIds].filter(id => !currentIds.has(id));
  const newFiles = report.files.filter(file => !baselineFiles.has(file.path));
  const legacyRoleNewFiles = newFiles.filter(file => {
    const status = String(file.roleStatus || '');
    return status === 'legacy' || status === 'pending_contract';
  });
  return {
    ok: added.length === 0 && increased.length === 0 && legacyRoleNewFiles.length === 0,
    baselineCommit: baseline.commit || null,
    baselineViolations: baselineIds.size,
    currentViolations: currentIds.size,
    added,
    increased,
    resolved,
    newFiles: newFiles.map(file => ({ path: file.path, role: file.role, roleStatus: file.roleStatus })),
    legacyRoleNewFiles: legacyRoleNewFiles.map(file => ({ path: file.path, role: file.role, roleStatus: file.roleStatus })),
    unresolved: report.unresolved,
  };
}

function parseArgs(argv) {
  const options = { commit: 'HEAD', worktree: false, json: false, write: null, baseline: null, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') options.json = true;
    else if (value === '--worktree') options.worktree = true;
    else if (value === '--quiet') options.quiet = true;
    else if (value === '--commit') options.commit = argv[++index];
    else if (value === '--write') options.write = argv[++index];
    else if (value === '--baseline') options.baseline = argv[++index];
    else if (value === '--root') options.rootDir = path.resolve(argv[++index]);
    else throw new Error(`未知参数：${value}`);
  }
  return options;
}

function dirnameOf(filePath) {
  return path.dirname(path.resolve(filePath));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = options.rootDir || ROOT_DIR;
  let report;
  try {
    report = scan(rootDir, { commit: options.commit, worktree: options.worktree });
  } catch (error) {
    console.error(`分层耦合扫描失败：${error.message}`);
    process.exit(2);
  }

  let comparison = null;
  if (options.baseline) {
    const baseline = JSON.parse(fs.readFileSync(path.resolve(options.baseline), 'utf8'));
    comparison = compareToBaseline(report, baseline);
  }

  const output = comparison ? { ...report, comparison } : report;
  if (options.write) {
    const target = path.resolve(options.write);
    if (!fs.existsSync(dirnameOf(target))) fs.mkdirSync(dirnameOf(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else if (!options.quiet) {
    console.log(`分层耦合扫描：提交 ${report.commit.slice(0, 12)}${report.dirty ? '（工作区）' : ''}`);
    console.log(`扫描器 ${report.scannerVersion}／规则 ${report.rulesVersion}`);
    console.log(`纳入 ${report.scope.files} 个文件、${report.scope.lines} 逻辑行；排除 ${report.scope.excludedFiles.length} 个路径`);
    console.log(`未豁免越界 ${report.violations.length} 条；待登记 ${report.pendingRegistration.length} 条；无法解析 ${report.unresolved.length} 条`);
    for (const directory of report.directories.slice(0, 12)) {
      console.log(`  ${directory.directory}：${directory.files} 文件／${directory.lines} 行，SQL 模块 ${directory.sqlModules}（${directory.sqlCandidates} 处），请求模块 ${directory.networkModules}（${directory.networkCandidates} 处）`);
    }
    if (comparison) {
      console.log(`基线 ${comparison.baselineCommit ? comparison.baselineCommit.slice(0, 12) : '(未记录)'}：存量越界 ${comparison.baselineViolations} → ${comparison.currentViolations}`);
      if (comparison.added.length) {
        console.log('新增越界：');
        comparison.added.forEach(item => console.log(`  + ${item.id}（第 ${item.line} 行，${item.role}）`));
      }
      if (comparison.increased.length) {
        console.log('存量违规调用增加：');
        comparison.increased.forEach(item => console.log(`  + ${item.id}（${item.baselineCount} → ${item.currentCount}）`));
      }
      if (comparison.legacyRoleNewFiles.length) {
        console.log('新增文件落入存量/待登记角色：');
        comparison.legacyRoleNewFiles.forEach(item => console.log(`  + ${item.path}（${item.role}／${item.roleStatus}）`));
      }
      if (comparison.resolved.length) console.log(`已消除 ${comparison.resolved.length} 条存量越界`);
      console.log(`比对结论：${comparison.ok ? '通过' : '失败'}`);
    }
  }
  if (comparison && !comparison.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  SCANNER_VERSION,
  compareToBaseline,
  countLogicalLines,
  isExcluded,
  isScanned,
  loadBoundaries,
  normalize,
  parseArgs,
  resolveRole,
  rolePolicy,
  scanImportEdges,
  calleePath,
  viaSiteApi,
  scan,
  scanHtmlInlineScripts,
  scanJs,
  summarizeDirectories,
  violationId,
};
