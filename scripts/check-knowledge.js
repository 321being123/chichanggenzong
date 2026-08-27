#!/usr/bin/env node
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

function normalize(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function globMatches(pattern, filePath) {
  const escaped = normalize(pattern)
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*\*/g, ':::DOUBLE_STAR:::')
    .replace(/\*/g, '[^/]*')
    .replace(/:::DOUBLE_STAR:::\//g, '(?:.*/)?')
    .replace(/:::DOUBLE_STAR:::/g, '.*');
  return new RegExp(`^${escaped}$`).test(normalize(filePath));
}

function loadMap(rootDir, errors) {
  const mapPath = path.join(rootDir, 'governance', 'knowledge-map.json');
  if (!fs.existsSync(mapPath)) {
    errors.push('缺少治理路由文件：governance/knowledge-map.json');
    return null;
  }
  try {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    if (!Array.isArray(map.requiredFiles) || !Array.isArray(map.routes)) {
      errors.push('知识路由文件必须包含 requiredFiles 和 routes 数组。');
      return null;
    }
    return map;
  } catch (error) {
    errors.push(`知识路由文件不是合法 JSON：${error.message}`);
    return null;
  }
}

function collectVersionErrors(rootDir) {
  const errors = [];
  if (!fs.existsSync(path.join(rootDir, 'package.json'))) return errors;
  const readJson = relativePath => {
    try { return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8')); }
    catch (error) { errors.push(`无法读取版本文件 ${relativePath}：${error.message}`); return null; }
  };
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const changelog = readJson('public/changelog.json');
  let changelogMd = '';
  try { changelogMd = fs.readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8'); }
  catch (error) { errors.push(`无法读取版本文件 CHANGELOG.md：${error.message}`); }
  if (!pkg || !lock || !changelog || !changelogMd) return errors;
  const expected = pkg.appVersion;
  if (!expected || pkg.version !== expected) errors.push('package.json 的 version 与 appVersion 必须一致。');
  if (lock.version !== expected || !lock.packages || !lock.packages[''] || lock.packages[''].version !== expected) {
    errors.push('package-lock.json 的 version 与根包 version 必须和 package.json.appVersion 一致。');
  }
  if (!Array.isArray(changelog) || !changelog[0] || changelog[0].version !== expected) {
    errors.push('public/changelog.json 最新版本必须和 package.json.appVersion 一致。');
  }
  const markdownVersion = (changelogMd.match(/^##\s+[^\n]*·\s*([^\s]+)\s*$/m) || [])[1];
  if (markdownVersion !== expected) errors.push('CHANGELOG.md 最新版本必须和 package.json.appVersion 一致。');
  return errors;
}

function runCheck({ rootDir = path.resolve(__dirname, '..'), changedFiles = [] } = {}) {
  const errors = [];
  const map = loadMap(rootDir, errors);
  if (!map) return { ok: false, errors, matchedRoutes: [] };

  for (const requiredFile of map.requiredFiles) {
    if (!fs.existsSync(path.join(rootDir, requiredFile))) {
      errors.push(`缺少必需知识入口：${requiredFile}`);
    }
  }

  errors.push(...collectVersionErrors(rootDir));
  const files = [...new Set(changedFiles.map(normalize).filter(Boolean))];
  const matchedRoutes = [];
  for (const route of map.routes) {
    if (!route.id || !Array.isArray(route.paths) || !Array.isArray(route.update)) {
      errors.push(`路由定义不完整：${route.id || '(缺少 id)'}`);
      continue;
    }
    const matchedFiles = files.filter(file => route.paths.some(pattern => globMatches(pattern, file)));
    if (matchedFiles.length === 0) continue;
    matchedRoutes.push({ id: route.id, files: matchedFiles, risk: route.risk || 'unknown' });
    for (const updateFile of route.update) {
      if (!files.includes(normalize(updateFile))) {
        errors.push(`路由「${route.id}」命中 ${matchedFiles.join('、')}，请同步核对并更新：${updateFile}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, matchedRoutes };
}

function parseArgs(argv) {
  const options = { rootDir: path.resolve(__dirname, '..'), changedFiles: [], base: null, staged: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--files') options.changedFiles = (argv[++index] || '').split(',').filter(Boolean);
    else if (value === '--base') options.base = argv[++index] || null;
    else if (value === '--staged') options.staged = true;
    else if (value === '--root') options.rootDir = path.resolve(argv[++index] || options.rootDir);
    else throw new Error(`未知参数：${value}`);
  }
  return options;
}

function splitGitOutput(output) {
  return output.split('\0').filter(Boolean);
}

function filesSinceBase(rootDir, base) {
  const result = childProcess.spawnSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`无法读取 Git 变更：${(result.stderr || '').trim()}`);
  }
  return splitGitOutput(result.stdout);
}

function stagedFiles(rootDir) {
  const result = childProcess.spawnSync('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`无法读取暂存变更：${(result.stderr || '').trim()}`);
  }
  return splitGitOutput(result.stdout);
}

function commandFiles(rootDir, args) {
  const result = childProcess.spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`无法读取 Git 变更：${(result.stderr || '').trim()}`);
  }
  return splitGitOutput(result.stdout);
}

function workingTreeFiles(rootDir) {
  return [...new Set([
    ...commandFiles(rootDir, ['diff', '--name-only', '-z']),
    ...commandFiles(rootDir, ['diff', '--cached', '--name-only', '-z']),
    ...commandFiles(rootDir, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])].sort();
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.base && options.staged) throw new Error('--base 与 --staged 不能同时使用');
    if (options.base) options.changedFiles = filesSinceBase(options.rootDir, options.base);
    else if (options.staged) options.changedFiles = stagedFiles(options.rootDir);
    else if (options.changedFiles.length === 0) options.changedFiles = workingTreeFiles(options.rootDir);
  } catch (error) {
    console.error(`知识治理检查失败：${error.message}`);
    process.exit(2);
  }

  const result = runCheck(options);
  for (const route of result.matchedRoutes) {
    console.log(`命中路由：${route.id}（${route.risk}）→ ${route.files.join('、')}`);
  }
  if (!result.ok) {
    for (const error of result.errors) console.error(`知识治理检查失败：${error}`);
    process.exit(1);
  }
  console.log(`知识治理检查通过：必需入口完整，命中 ${result.matchedRoutes.length} 条路由。`);
}

if (require.main === module) main();

module.exports = { collectVersionErrors, globMatches, parseArgs, runCheck, splitGitOutput, workingTreeFiles };
