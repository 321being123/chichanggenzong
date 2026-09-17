#!/usr/bin/env node
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

function normalize(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

const RELEASE_METADATA_FILES = new Set(['package.json', 'package-lock.json', 'CHANGELOG.md', 'public/changelog.json']);

function readGitFile(rootDir, relativePath) {
  const result = childProcess.spawnSync('git', ['show', `HEAD:${relativePath}`], {
    cwd: rootDir, encoding: 'utf8'
  });
  return result.status === 0 ? result.stdout : null;
}

function releaseFileHasRuntimeChange(rootDir, relativePath) {
  if (!['package.json', 'package-lock.json'].includes(relativePath)) return false;
  const currentPath = path.join(rootDir, relativePath);
  const baseText = readGitFile(rootDir, relativePath);
  if (!baseText || !fs.existsSync(currentPath)) return true;
  try {
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    const base = JSON.parse(baseText);
    delete current.version;
    delete current.appVersion;
    delete base.version;
    delete base.appVersion;
    if (relativePath === 'package-lock.json') {
      if (current.packages && current.packages['']) delete current.packages[''].version;
      if (base.packages && base.packages['']) delete base.packages[''].version;
    }
    return JSON.stringify(current) !== JSON.stringify(base);
  } catch (_) {
    return true;
  }
}

function isReleaseMetadataOnly(rootDir, files) {
  const normalized = files.map(normalize).filter(Boolean);
  if (!normalized.length || !normalized.every(file => RELEASE_METADATA_FILES.has(file))) return false;
  return !normalized.some(file => releaseFileHasRuntimeChange(rootDir, file));
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

function collectGeneratedMatrixErrors(rootDir) {
  // 纯知识路由单测只构造 docs/governance，不复制业务代码；没有任务定义时无需运行业务矩阵门禁。
  // 真实项目根目录必须同时具备任务定义和生成器，缺任一项都应直接报错。
  const definitionsPath = path.join(rootDir, 'server', 'services', 'jobDefinitions.js');
  if (!fs.existsSync(definitionsPath)) return [];
  const generatorPath = path.join(rootDir, 'scripts', 'generate-job-matrix.js');
  if (!fs.existsSync(generatorPath)) return ['缺少任务矩阵生成器：scripts/generate-job-matrix.js'];
  const result = childProcess.spawnSync(process.execPath, [generatorPath, '--check'], {
    cwd: rootDir, encoding: 'utf8'
  });
  if (result.status === 0) return [];
  return [`任务-接口-数据集矩阵与 JOB_DEFINITIONS 不一致：${String(result.stderr || result.stdout || '').trim()}`];
}

function collectTaskGovernanceImplementationErrors(rootDir) {
  const definitionsPath = path.join(rootDir, 'server', 'services', 'jobDefinitions.js');
  if (!fs.existsSync(definitionsPath)) return [];
  const read = relativePath => {
    const filePath = path.join(rootDir, relativePath);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  };
  const errors = [];
  const slots = read('server/services/jobScheduleSlots.js');
  const orchestrator = read('server/services/jobOrchestrator.js');
  const evidence = read('server/services/jobRecoveryEvidence.js');
  const runner = read('server/services/jobRunnerProcess.js');
  const externalGuard = read('server/services/externalCallGuard.js');
  const sourcePolicy = read('server/services/sourceEndpointPolicy.js');
  const hkexAnnouncement = read('server/services/hkexAnnouncement.js');
  const cninfoAnnouncement = read('server/services/cninfoAnnouncement.js');
  const stockAnalysis = read('server/services/stockAnalysis.js');
  const hkexIpo = read('server/services/hkexIpo.js');
  const convertibleBondAnalysis = read('server/services/convertibleBondAnalysis.js');
  const motiveService = read('server/services/convertibleBondRevisionMotiveService.js');
  const jobDefinitions = read('server/services/jobDefinitions.js');
  const migrations = read('server/db/migrations.js');
  const redemptionSync = read('server/services/convertibleBondRedemptionSync.js');
  const marketService = read('server/services/market.js');
  const stockFrontend = read('public/js/stock-analysis.js');
  const bondFrontend = read('public/js/bond-analysis.js');

  // 这些是跨业务不变量的最低实现门槛；事故测试仍可补充细节，但不能只靠事故编号保护。
  if (!/function continueSlot\(/.test(slots) || !/status='pending'/.test(slots) || !/attempt_count=GREATEST\(attempt_count-1,0\)/.test(slots)) {
    errors.push('任务续批必须使用 continueSlot，并恢复正常 attempt_count 语义。');
  }
  if (!/slotExternalCallsTotal/.test(slots) || !/slotExternalCallsLimit/.test(runner)) {
    errors.push('任务缺少槽位累计调用量与总止损实现。');
  }
  if (!/continuationRequired/.test(orchestrator) || !/pendingStages/.test(orchestrator)) {
    errors.push('任务缺少阶段级 partial 续跑编排。');
  }
  if (!/verifySlotRecoveryEvidence/.test(evidence)) {
    errors.push('任务缺少中立恢复证据服务。');
  }
  if (!/ops\.external_circuits/.test(externalGuard) || !/recover_at/.test(externalGuard) || !/BUDGET_WAIT/.test(externalGuard)) {
    errors.push('外部 Guard 必须统一使用 ops.external_circuits、recover_at 和 BUDGET_WAIT。');
  }
  if (!/禁止自行设置内部分钟\/日限额/.test(sourcePolicy)) {
    errors.push('来源接口策略必须拒绝所有自行设置的内部分钟/日限额。');
  }
  if (/maxExternalCallsPerRun:\s*[1-9]\d*/.test(jobDefinitions)
    || /slotExternalCallsLimit:\s*[1-9]\d*/.test(jobDefinitions)
    || /dailyBudget:\s*[1-9]\d*/.test(jobDefinitions)
    || /modeExternalCallLimits:\s*\{[^}]*[1-9]\d*/.test(jobDefinitions)) {
    errors.push('任务契约不得写入无上游依据的调用数预算；使用官方接口策略、任务超时和无进展保护。');
  }
  if (!/ck_source_endpoint_no_internal_limits/.test(migrations)
    || !/ck_external_circuits_open_recover_at/.test(migrations)
    || !/临时熔断必须提供有效 recover_at/.test(externalGuard)) {
    errors.push('数据库必须禁止内部分钟/日限额，并保证所有 open 熔断都有 recover_at。');
  }
  if (/HKEX_MAX_PAGES\s*=\s*\d+/.test(hkexAnnouncement) || /CNINFO_MAX_PAGES\s*=\s*\d+/.test(cninfoAnnouncement)
    || /maxPages\s*=\s*\d+|page\s*<=\s*5|pageNum\s*<=\s*20/.test(stockAnalysis)) {
    errors.push('公告采集适配器不得在业务函数内写死固定页数上限。');
  }
  if (/documents\.slice\(0,\s*3\)|uniqueParseDocuments\.slice\(0,\s*6\)/.test(hkexIpo)) {
    errors.push('招股书事实补全不得按固定文档数截断。');
  }
  if (/effectiveDefaultLimit|const defaultLimit = globalSync|limitValue = Math\.max\(1, Math\.min\(limit/.test(convertibleBondAnalysis)) {
    errors.push('可转债公告历史同步不得设置隐藏候选条数上限。');
  }
  if (/MAX_HOLDER_CALLS_PER_RUN|syncRevisionMotiveInputs\(\{ businessDate = null, limit = 2000/.test(motiveService)) {
    errors.push('下修动机输入不得设置来源接口级固定调用上限。');
  }
  if (!/convertible_bond_revision_motive_inputs_sync'[\s\S]*?maxExternalCallsPerRun:\s*null/.test(jobDefinitions)
    || /续批任务未声明槽位累计外部请求上限/.test(orchestrator)) {
    errors.push('下修动机输入不得按固定调用数截断，续批也不得因缺少臆造总量上限而永久阻塞。');
  }
  if (/retryFailed = false, limit = 2000|LIMIT \$4.*Math\.max\(1, Number\(limit\) \|\| 2000\)/.test(redemptionSync)) {
    errors.push('强赎公告重解析不得设置隐藏候选条数上限。');
  }
  if (/endsWith\('\.BJ'\)\)\.slice\(0,\s*1000\)/.test(marketService)) {
    errors.push('实时行情请求不得自行截断证券集合。');
  }
  if (/return stockAnalysisRefresh\(\)/.test(stockFrontend)
    || /response\.status===404&&!refresh[\s\S]*?return bondAnalysisLoad\(true/.test(bondFrontend)
    || /if \(payload\.needs_refresh\)[\s\S]*?return stockAnalysisRefresh\(\)/.test(stockFrontend)) {
    errors.push('分析页面读取不得在无快照或过期时自动触发外部刷新。');
  }
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
  errors.push(...collectGeneratedMatrixErrors(rootDir));
  errors.push(...collectTaskGovernanceImplementationErrors(rootDir));
  const files = [...new Set(changedFiles.map(normalize).filter(Boolean))];
  const releaseMetadataOnly = isReleaseMetadataOnly(rootDir, files);
  const matchedRoutes = [];
  for (const route of map.routes) {
    if (!route.id || !Array.isArray(route.paths) || !Array.isArray(route.update)) {
      errors.push(`路由定义不完整：${route.id || '(缺少 id)'}`);
      continue;
    }
    const matchedFiles = files.filter(file => route.paths.some(pattern => globMatches(pattern, file)));
    if (matchedFiles.length === 0) continue;
    if (releaseMetadataOnly && (route.id === 'deployment' || route.id === 'frontend')) continue;
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

module.exports = { collectVersionErrors, collectGeneratedMatrixErrors, globMatches, isReleaseMetadataOnly, parseArgs, runCheck, splitGitOutput, workingTreeFiles };
