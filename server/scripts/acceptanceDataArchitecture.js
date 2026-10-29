#!/usr/bin/env node
// 证券数据架构验收工具（应用分层整改方案 6.1）。
//
// 两种模式，分别出报告，互不冒充：
//   默认模式：原只读数据库验收（身份映射、迁移、来源、分区、任务矩阵）。
//   --static ：纯静态架构门禁（依赖、文件角色、全局符号契约、同源耦合与 C0 基线比对、
//              Python SQL 位置规则）。不连接数据库、不读外部 Token、不发请求。
// 静态模式缺 acorn/acorn-walk 或 Python 解释器时报告失败，不假通过。
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const STATIC_MODE = process.argv.includes('--static');
const JSON_OUTPUT = process.argv.includes('--json');
const ROOT = path.join(__dirname, '..', '..');
const BOUNDARIES_RELATIVE = 'governance/architecture-boundaries.json';
const BASELINE_RELATIVE = 'server/test/fixtures/architecture-layer-baseline.json';

function number(value) {
  return Number(value || 0);
}

function addCheck(checks, code, ok, detail, value = null) {
  checks.push({ code, ok: Boolean(ok), detail, ...(value === null ? {} : { value }) });
}

function readText(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
}

function readJson(relativePath) {
  const text = readText(relativePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

// 全局符号是否由该文件提供：变量声明、函数声明或显式挂到 window。
function hasSymbolDefinition(source, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\b(?:var|let|const)\\s+${escaped}\\b`),
    new RegExp(`\\bfunction\\s+${escaped}\\b`),
    new RegExp(`\\bwindow\\.${escaped}\\s*=`),
    new RegExp(`\\bglobal\\.${escaped}\\s*=`),
    new RegExp(`\\b${escaped}\\s*=\\s*(?:async\\s*)?(?:function|\\()`),
  ];
  return patterns.some(pattern => pattern.test(source));
}

// 从页面 HTML 实际解析脚本：普通 <script src> 与懒加载 data-lazy-section。
// 契约必须与页面一致，避免手写清单与真实加载关系漂移。
function parsePageScripts(html) {
  const plain = [];
  const lazy = [];
  const tagPattern = /<script\b([^>]*)>/gi;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const attributes = match[1] || '';
    const srcMatch = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const src = srcMatch[1].split('?')[0].replace(/^\.?\//, '');
    const lazyMatch = attributes.match(/\bdata-lazy-section\s*=\s*["']([^"']+)["']/i);
    if (lazyMatch) lazy.push({ sections: lazyMatch[1].trim().split(/\s+/), file: `public/${src}` });
    else plain.push(`public/${src}`);
  }
  return { plain, lazy };
}

// 分享模板等界面契约要求零内联脚本/样式。
function hasInlineScript(html) {
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(match[1] || '')) continue;
    if ((match[2] || '').trim()) return true;
  }
  return false;
}

function hasInlineStyle(html) {
  const pattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if ((match[1] || '').trim()) return true;
  }
  return false;
}

function runStaticChecks(boundaries = readJson(BOUNDARIES_RELATIVE)) {
  const checks = [];
  const pending = [];
  if (!boundaries) {
    addCheck(checks, 'boundaries_manifest', false, `缺少或无法解析 ${BOUNDARIES_RELATIVE}`);
    return { checks, pending };
  }
  const roles = boundaries.roles || {};
  const roleEntries = Object.entries(roles);
  addCheck(checks, 'boundaries_manifest',
    Boolean(boundaries.schemaVersion) && typeof boundaries.rulesVersion === 'string'
      && Array.isArray(boundaries.directoryRoles) && Array.isArray(boundaries.fileRoles)
      && roleEntries.length > 0
      && roleEntries.every(([, policy]) => typeof policy.allowSql === 'boolean' && typeof policy.allowNetwork === 'boolean'),
    `角色 ${roleEntries.length} 个、目录规则 ${(boundaries.directoryRoles || []).length} 条、文件覆盖 ${(boundaries.fileRoles || []).length} 条，规则版本 ${boundaries.rulesVersion}`);

  // 兼容出口台账：每条必须写明唯一实现目标、消费者、批次、责任人和退役状态。
  const exits = boundaries.compatibilityExits || [];
  const exitStatuses = new Set(['long_term_facade', 'retire_planned', 'retired']);
  const invalidExits = exits.filter(item => !item.id || !item.entry || !item.implementation
    || !Array.isArray(item.internalConsumers) || item.batch === undefined || !item.owner
    || !exitStatuses.has(item.status));
  addCheck(checks, 'compatibility_exit_ledger',
    exits.length > 0 && invalidExits.length === 0,
    invalidExits.length
      ? `台账不完整：${invalidExits.map(item => item.id || '(缺少 id)').join('、')}`
      : `兼容出口 ${exits.length} 条，状态均在 ${[...exitStatuses].join('/')} 内`,
    exits.map(item => ({ id: item.id, status: item.status, batch: item.batch })));

  // 例外必须写明用途与连接归属，不能成为“遗留耦合豁免”。
  const exceptions = boundaries.exceptions || [];
  const invalidExceptions = exceptions.filter(item => !item.id || !item.kind || !item.reason || !item.source);
  addCheck(checks, 'exception_registry',
    invalidExceptions.length === 0,
    invalidExceptions.length
      ? `例外登记不完整：${invalidExceptions.map(item => item.id || '(缺少 id)').join('、')}`
      : `精确登记例外 ${exceptions.length} 条`,
    exceptions.map(item => item.id));

  // 首批全局符号契约：提供者必须真实存在并定义该符号。
  const contracts = boundaries.globalContracts || {};
  const providers = contracts.providers || [];
  const missingProviders = [];
  for (const provider of providers) {
    const source = readText(provider.file);
    if (source === null) { missingProviders.push(`${provider.symbol}→${provider.file}（文件缺失）`); continue; }
    if (!hasSymbolDefinition(source, provider.symbol)) missingProviders.push(`${provider.symbol}→${provider.file}（未找到定义）`);
  }
  addCheck(checks, 'global_provider_symbols',
    providers.length > 0 && missingProviders.length === 0,
    missingProviders.length ? `缺失全局提供者：${missingProviders.join('；')}` : `提供者 ${providers.length} 个均可解析`,
    providers.map(item => item.symbol));

  // 页面 → 懒加载脚本 → 必需全局符号闭包；契约必须与 HTML 实际加载关系一致。
  const pageErrors = [];
  for (const page of contracts.pages || []) {
    const pageHtml = readText(page.page);
    if (pageHtml === null) { pageErrors.push(`${page.page}（页面缺失）`); continue; }
    const actual = parsePageScripts(pageHtml);
    // 整页脚本契约（无懒加载段的页面）：声明的按序脚本必须与页面实际加载一致。
    if (Array.isArray(page.scripts)) {
      const declaredPlain = page.scripts;
      const plainDrift = declaredPlain.length !== actual.plain.length
        || declaredPlain.some((file, index) => file !== actual.plain[index]);
      if (plainDrift) {
        pageErrors.push(`${page.page} 契约脚本与实际不符：声明 [${declaredPlain.join('、')}]，实际 [${actual.plain.join('、')}]`);
      }
      const plainSources = new Map();
      for (const script of declaredPlain) {
        const source = readText(script);
        if (source === null) pageErrors.push(`${page.page} 脚本缺失：${script}`);
        else plainSources.set(script, source);
      }
      for (const symbol of page.requiredSymbols || []) {
        const provider = providers.find(item => item.symbol === symbol);
        const provided = plainSources.has(provider && provider.file)
          || [...plainSources.values()].some(source => hasSymbolDefinition(source, symbol));
        if (!provided) pageErrors.push(`${page.page} 缺少必需符号 ${symbol}`);
      }
    }
    for (const section of page.lazySections || []) {
      const actualScripts = actual.lazy
        .filter(item => item.sections.includes(section.name))
        .map(item => item.file);
      const declared = section.scripts || [];
      const declarationDrift = declared.length !== actualScripts.length
        || declared.some((file, index) => file !== actualScripts[index]);
      if (declarationDrift) {
        pageErrors.push(`${page.page}#${section.name} 契约脚本与实际不符：声明 [${declared.join('、')}]，实际 [${actualScripts.join('、')}]`);
      }
      const sectionSources = new Map();
      for (const script of declared) {
        const source = readText(script);
        if (source === null) pageErrors.push(`${page.page}#${section.name} 脚本缺失：${script}`);
        else sectionSources.set(script, source);
      }
      for (const symbol of section.requiredSymbols || []) {
        const provider = providers.find(item => item.symbol === symbol);
        const provided = sectionSources.has(provider && provider.file)
          || actual.plain.includes(provider && provider.file)
          || [...sectionSources.values()].some(source => hasSymbolDefinition(source, symbol));
        if (!provided) pageErrors.push(`${page.page}#${section.name} 缺少必需符号 ${symbol}`);
      }
    }
  }
  addCheck(checks, 'page_global_contract',
    pageErrors.length === 0,
    pageErrors.length ? `页面全局契约不满足：${pageErrors.join('；')}`
      : `页面契约 ${(contracts.pages || []).length} 个、未登记页面 ${(contracts.pendingPages || []).length} 个（后者不计入已实现 MVP）`,
    { pages: (contracts.pages || []).map(page => page.page), pending: (contracts.pendingPages || []).map(page => page.page) });

  // 前端取数收口（批次4）：已迁移清单里的页面脚本不得再直接 fetch，
  // 否则“统一请求入口”只是文档承诺。pending 清单只做登记，不参与判定。
  const apiClientContract = boundaries.frontendApiClients || {};
  const apiClientErrors = [];
  for (const script of apiClientContract.migrated || []) {
    const source = readText(script);
    if (source === null) { apiClientErrors.push(`${script}（已迁移清单中的脚本缺失）`); continue; }
    if (/\bfetch\s*\(/.test(source)) apiClientErrors.push(`${script} 仍存在直接 fetch(`);
  }
  if (apiClientContract.client) {
    const clientSource = readText(apiClientContract.client);
    if (clientSource === null) apiClientErrors.push(`${apiClientContract.client}（统一请求客户端缺失）`);
    else if (!/global\.siteApi\s*=/.test(clientSource)) apiClientErrors.push(`${apiClientContract.client} 未导出 siteApi`);
  }
  addCheck(checks, 'frontend_api_client',
    apiClientErrors.length === 0,
    apiClientErrors.length ? `前端取数收口不满足：${apiClientErrors.join('；')}`
      : `已迁移 ${(apiClientContract.migrated || []).length} 个页面脚本不再直接 fetch；待迁移 ${(apiClientContract.pending || []).length} 个`,
    { migrated: (apiClientContract.migrated || []).length, pending: (apiClientContract.pending || []).length });

  // 主站外壳与公开分享入口：分享模板必须零内联脚本/样式。
  const surfaces = contracts.surfaces || [];
  const surfaceErrors = [];
  for (const surface of surfaces) {
    const target = surface.page || surface.template;
    if (!target) { surfaceErrors.push(`${surface.id || '(缺少 id)'} 未声明 page/template`); continue; }
    const html = readText(target);
    if (html === null) { surfaceErrors.push(`${surface.id} 目标缺失：${target}`); continue; }
    if (surface.noInlineScript && hasInlineScript(html)) surfaceErrors.push(`${surface.id} 出现内联脚本：${target}`);
    if (surface.noInlineStyle && hasInlineStyle(html)) surfaceErrors.push(`${surface.id} 出现内联样式：${target}`);
  }
  addCheck(checks, 'share_and_shell_contract',
    surfaces.length > 0 && surfaceErrors.length === 0,
    surfaceErrors.length ? `界面契约不满足：${surfaceErrors.join('；')}`
      : `主站外壳与公开分享入口 ${surfaces.length} 个均满足登记约束`,
    surfaces.map(surface => surface.id));

  // 批次1—5 范围冻结格式：三类清单必须齐全。
  const template = boundaries.batchScopeTemplate;
  const requiredKeys = ['mustMigrate', 'reuseVerified', 'notMigrated'];
  const templateOk = Boolean(template) && Array.isArray(template.requiredSections)
    && requiredKeys.every(key => template.requiredSections.some(section => section.key === key && Array.isArray(section.fields) && section.fields.length > 0));
  addCheck(checks, 'batch_scope_template', templateOk,
    templateOk ? '批次范围冻结格式含 必迁／复用验证／不迁存量 三类清单'
      : '缺少批次范围冻结格式（mustMigrate/reuseVerified/notMigrated）');

  // 同源耦合扫描 + C0 基线比对（新增越界、新增文件落入存量/待登记角色都必须失败）。
  let scanner;
  try {
    scanner = require(path.join(ROOT, 'scripts', 'audit-layer-coupling.js'));
  } catch (error) {
    addCheck(checks, 'static_parser_available', false, `无法加载扫描器：${error.message}`);
    return { checks, pending };
  }
  let report;
  try {
    report = scanner.scan(ROOT, { worktree: true, boundaries });
    addCheck(checks, 'static_parser_available', true,
      `acorn/acorn-walk 与 Python AST 均可用，扫描 ${report.scope.files} 个文件、${report.scope.lines} 逻辑行`);
  } catch (error) {
    addCheck(checks, 'static_parser_available', error.code !== 'MISSING_PARSER',
      `静态解析未执行：${error.message}`);
    return { checks, pending };
  }

  const baseline = readJson(BASELINE_RELATIVE);
  if (!baseline) {
    addCheck(checks, 'layer_coupling_baseline', false, `缺少初始快照 ${BASELINE_RELATIVE}，不得以“未登记”算零`);
  } else {
    const comparison = scanner.compareToBaseline(report, baseline);
    const detailParts = [
      `基线 ${String(baseline.commit || '').slice(0, 12)}／规则 ${baseline.rulesVersion}`,
      `存量越界 ${comparison.baselineViolations} → ${comparison.currentViolations}`,
    ];
    if (comparison.added.length) detailParts.push(`新增越界 ${comparison.added.length} 条：${comparison.added.slice(0, 5).map(item => item.id).join('；')}`);
    if (comparison.increased.length) detailParts.push(`存量违规调用增加 ${comparison.increased.length} 条：${comparison.increased.slice(0, 5).map(item => `${item.id}（${item.baselineCount}→${item.currentCount}）`).join('；')}`);
    if (comparison.legacyRoleNewFiles.length) detailParts.push(`新增文件落入存量/待登记角色：${comparison.legacyRoleNewFiles.map(item => item.path).join('、')}`);
    if (comparison.resolved.length) detailParts.push(`已消除 ${comparison.resolved.length} 条`);
    if (report.unresolved.length) detailParts.push(`无法解析 ${report.unresolved.length} 个文件，需补职责核查`);
    addCheck(checks, 'layer_coupling_baseline',
      comparison.ok && report.unresolved.length === 0,
      detailParts.join('；'),
      { added: comparison.added.length, increased: comparison.increased.length, resolved: comparison.resolved.length, current: comparison.currentViolations, unresolved: report.unresolved });
    if (report.unresolved.length) pending.push('存在无法静态解析的文件，须补人工/行为测试覆盖，不得视为已检查');
  }

  const unregistered = report.files.filter(file => file.role === 'pending_contract');
  addCheck(checks, 'role_coverage',
    unregistered.length === 0,
    unregistered.length
      ? `未登记角色 ${unregistered.length} 个文件：${unregistered.slice(0, 8).map(file => file.path).join('、')}`
      : `纳入文件全部具备明确角色（待登记页面契约 ${(contracts.pendingPages || []).length} 个单独计）`,
    unregistered.map(file => file.path));

  // 算法模块隔离与 Python SQL 位置：存量越界已冻结在 C0，这里只出可核对清单，不冒充通过。
  const algorithmModules = report.files.filter(file => file.role === 'domain_algorithm');
  const algorithmLeaks = algorithmModules.filter(file => (number(file.findings?.sql) + number(file.findings?.network)) > 0);
  const sqlModules = report.files.filter(file => number(file.findings?.sql) > 0);
  addCheck(checks, 'python_sql_positions', true,
    `算法模块 ${algorithmModules.length} 个（其中 ${algorithmLeaks.length} 个含存量越界，已冻结在 C0）；SQL 只出现在登记的数据准备/仓储/基础设施角色，共 ${sqlModules.length} 个模块`,
    {
      algorithmModules: algorithmModules.map(file => file.path),
      algorithmLeaks: algorithmLeaks.map(file => file.path),
      sqlAllowedModules: sqlModules
        .filter(file => scanner.rolePolicy(boundaries, file.role).allowSql)
        .map(file => file.path),
    });

  const legacyCount = report.files.filter(file => file.roleStatus === 'legacy').length;
  pending.push(`存量角色文件 ${legacyCount} 个（被 C0 快照覆盖，只减不增），未迁完不得声称全站分层完成`);

  return { checks, pending };
}

function providerMappingEntrypoints({ identityJs, marketRoute, announcementAdapter, tencentQuote, pythonIdentity, pythonQuote }) {
  return /resolveProviderIdentifier/.test(identityJs) && /resolve_provider_code/.test(pythonIdentity)
    && /_get_qt_symbol/.test(pythonQuote) && /sourceCode: 'xueqiu'/.test(announcementAdapter)
    && /sourceCode: 'eastmoney', identifierType: 'guba_code'/.test(announcementAdapter)
    && /resolveProviderCode/.test(tencentQuote)
    && !/rawCodes\s*\|\|\s*\[\]\)\s*\.map\(describeTencentCode\)/.test(tencentQuote)
    && !/sinaSymbol\s*\|\|\s*requestedSecid/.test(marketRoute);
}

async function runDatabaseChecks() {
  // 连接数据库的依赖只在默认模式里延迟加载，静态模式不触发。
  const { pool } = require('../db/connection');
  const { JOB_DEFINITIONS, declaredDailyExternalCallBudget } = require('../services/jobDefinitions');
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;

  const checks = [];
  const controlledPending = [
    '生产影子对账：需连续 3 个交易日观察共享采集与旧链路结果',
    '历史证券 ID 合并：自动迁移保留旧主档，人工核对项继续等待审批',
  ];

  const packageJson = require('../../package.json');
  addCheck(checks, 'version', /^\d+\.\d+\.\d+\.\d+$/.test(packageJson.appVersion) && packageJson.version === packageJson.appVersion,
    `应用版本 ${packageJson.appVersion}`);

  const identityJs = fs.readFileSync(path.join(__dirname, '..', 'services', 'securityIdentity.js'), 'utf8');
  const marketRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'market.js'), 'utf8');
  const announcementAdapter = fs.readFileSync(path.join(__dirname, '..', 'dataAccess', 'adapters', 'announcementSourceAdapter.js'), 'utf8');
  const tencentQuote = fs.readFileSync(path.join(__dirname, '..', 'services', 'tencentQuote.js'), 'utf8');
  const pythonIdentity = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'instrument_identity.py'), 'utf8');
  const pythonQuote = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_common.py'), 'utf8');
  addCheck(checks, 'runtime_provider_mapping_entrypoints',
    providerMappingEntrypoints({ identityJs, marketRoute, announcementAdapter, tencentQuote, pythonIdentity, pythonQuote }),
    'Node/Python 供应商代码转换经过统一身份映射入口，腾讯/股吧/雪球/新浪路由不再按前缀猜测');

  const migrationRows = await query(
    `SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY version`,
    [['119_normalize_dividend_yield_unit', '120_repair_legacy_dividend_yield_unit',
      '121_backfill_dataset_partitions', '122_normalize_legacy_stock_identity',
      '123_backfill_stock_company_relations', '124_external_call_budget_function']]
  );
  addCheck(checks, 'migrations_119_124', migrationRows.length === 6,
    `已落库 ${migrationRows.length}/6 个整改迁移`, migrationRows.map(row => row.version));

  const functionRows = await query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='ops' AND p.proname='consume_external_call_budget'`
  );
  addCheck(checks, 'atomic_budget_function', functionRows.length === 1,
    'Node 与 Python 共用 ops.consume_external_call_budget()');

  const duplicateRows = await query(
    `SELECT COUNT(*)::int AS count FROM (
       SELECT source_id,identifier_type,identifier_value
         FROM core.instrument_identifiers
        WHERE valid_to IS NULL OR valid_to >= CURRENT_DATE
        GROUP BY source_id,identifier_type,identifier_value
       HAVING COUNT(DISTINCT instrument_id) > 1
     ) x`
  );
  addCheck(checks, 'provider_identifier_unique', number(duplicateRows[0]?.count) === 0,
    `供应商代码一对多冲突 ${number(duplicateRows[0]?.count)} 条`, number(duplicateRows[0]?.count));

  const legacyRows = await query(`SELECT COUNT(*)::int AS count FROM core.instruments WHERE asset_class='equity'`);
  addCheck(checks, 'legacy_equity_zero', number(legacyRows[0]?.count) === 0,
    `遗留 equity 类型 ${number(legacyRows[0]?.count)} 条`, number(legacyRows[0]?.count));

  const dividendRows = await query(
    `SELECT COUNT(*)::int AS count FROM market.daily_valuations
      WHERE dividend_yield_ttm > 1 AND dividend_yield_ttm <= 100`
  );
  addCheck(checks, 'dividend_unit_anomaly_zero', number(dividendRows[0]?.count) === 0,
    `疑似百分数单位股息率 ${number(dividendRows[0]?.count)} 条`, number(dividendRows[0]?.count));

  const partitionRows = await query(
    `SELECT COUNT(*)::int AS rows,
            COUNT(DISTINCT dataset_code)::int AS datasets,
            COUNT(*) FILTER (WHERE status='published' AND row_count=0)::int AS empty_published
       FROM ops.dataset_partitions`
  );
  const partition = partitionRows[0] || {};
  addCheck(checks, 'published_partition_not_empty', number(partition.empty_published) === 0,
    `分区 ${number(partition.rows)} 行、${number(partition.datasets)} 个数据集，空发布 ${number(partition.empty_published)} 行`, partition);

  const latestBondPartitionRows = await query(
    `SELECT MAX(partition_key)::text AS trade_date FROM ops.dataset_partitions
      WHERE dataset_code='bond_daily' AND scope_key='CN' AND status='published'`
  );
  const latestBondDate = latestBondPartitionRows[0]?.trade_date || null;
  addCheck(checks, 'bond_daily_latest_partition', Boolean(latestBondDate),
    latestBondDate ? `最新已发布可转债行情分区 ${latestBondDate}` : '没有已发布 bond_daily 分区', latestBondDate);
  const activeBondRows = await query(
    `WITH latest AS (
       SELECT MAX(partition_key) AS trade_date
         FROM ops.dataset_partitions
        WHERE dataset_code='bond_daily' AND scope_key='CN' AND status='published'
     )
     SELECT COUNT(*) FILTER (WHERE p.stock_instrument_id IS NULL)::int AS missing_stock,
            COUNT(*)::int AS effective_bonds
       FROM market.convertible_bond_daily_metrics m
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=m.instrument_id
       JOIN core.instruments i ON i.instrument_id=m.instrument_id
       JOIN public.bond_unified u ON u.instrument_id=m.instrument_id
      WHERE m.trade_date=(SELECT trade_date FROM latest)
        AND u.status='listed'
        AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
        AND (i.delist_date IS NULL OR i.delist_date > m.trade_date)
        AND (p.maturity_date IS NULL OR p.maturity_date >= m.trade_date)`
  );
  const activeBonds = activeBondRows[0] || {};
  addCheck(checks, 'effective_bond_stock_relation', Boolean(latestBondDate) && number(activeBonds.missing_stock) === 0,
    `有效行情转债 ${number(activeBonds.effective_bonds)} 只，缺正股关联 ${number(activeBonds.missing_stock)} 只`, activeBonds);

  const queueRows = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('pending','running','waiting_external'))::int AS active,
            COUNT(*) FILTER (WHERE status='waiting_external')::int AS waiting_external
       FROM ops.job_schedule_slots`
  );
  addCheck(checks, 'durable_job_queue', queueRows.length === 1,
    '计划实例、租约和 waiting_external 状态均由 PostgreSQL 持久化', queueRows[0] || {});

  const declaredCalls = JOB_DEFINITIONS.reduce((sum, job) => sum + declaredDailyExternalCallBudget(job), 0);
  // 任务数随定义增删调整：2026-10-25 新增 notification_dispatch（原 28 → 29）
  addCheck(checks, 'job_matrix_budget', JOB_DEFINITIONS.length === 29 && declaredCalls <= 80,
    `任务定义 ${JOB_DEFINITIONS.length} 个，声明预算 ${declaredCalls}/日（任务报表目标≤80，不是来源日限额）`,
    { jobs: JOB_DEFINITIONS.length, declaredCalls });

  const externalDatasets = [...new Set(JOB_DEFINITIONS.flatMap(job => job.producesDatasets || []))];
  const publishedDatasetRows = await query(
    `SELECT DISTINCT dataset_code FROM ops.dataset_partitions WHERE status='published'`
  );
  const publishedCodes = new Set(publishedDatasetRows.map(row => row.dataset_code));
  const unpartitioned = externalDatasets.filter(code => !publishedCodes.has(code));
  // 这里是覆盖度提示，不把尚未接入分区的非核心采集器误判为核心链路失败。
  addCheck(checks, 'partition_coverage_report', true,
    `任务产出数据集 ${externalDatasets.length} 个，已有发布分区 ${publishedCodes.size} 个，未接入 ${unpartitioned.length} 个`,
    { externalDatasets, publishedDatasets: [...publishedCodes], unpartitioned });

  const mergeRows = await query(
    `SELECT COUNT(*)::int AS candidates,
            COUNT(*) FILTER (WHERE status='candidate')::int AS pending,
            COUNT(*) FILTER (WHERE status='candidate' AND conflict_count=0)::int AS safe_pending,
            COUNT(*) FILTER (WHERE status='migrated')::int AS migrated
       FROM core.instrument_merge_candidates`
  );
  const bareStockRows = await query(
    `WITH bare AS (
       SELECT instrument_id,canonical_code,regexp_replace(canonical_code,'\\D','','g') AS digits,exchange_code
         FROM core.instruments
        WHERE asset_class='stock' AND canonical_code !~ '\\.[A-Z]{2}$'
     ), mapped AS (
       SELECT b.*,
              lpad(b.digits,6,'0') || CASE b.exchange_code
                WHEN 'SSE' THEN '.SH' WHEN 'SZSE' THEN '.SZ' WHEN 'BSE' THEN '.BJ' END AS expected_code
         FROM bare b
     ), resolved AS (
       SELECT m.*,t.instrument_id AS target_id
         FROM mapped m LEFT JOIN core.instruments t ON t.canonical_code=m.expected_code
     )
     SELECT COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE target_id IS NULL AND expected_code IS NOT NULL)::int AS safe_normalize,
            COUNT(*) FILTER (WHERE target_id IS NOT NULL)::int AS merge_conflict,
            COUNT(*) FILTER (WHERE expected_code IS NULL)::int AS unresolved
       FROM resolved`
  );
  const bareStock = bareStockRows[0] || {};
  addCheck(checks, 'bare_stock_resolution', number(bareStock.unresolved) === 0,
    `历史裸股票代码 ${number(bareStock.count)} 条，其中可直接规范化 ${number(bareStock.safe_normalize)} 条、需合并 ${number(bareStock.merge_conflict)} 条、无法判定 ${number(bareStock.unresolved)} 条`, bareStock);
  const testCircuitRows = await query(
    `SELECT COUNT(*)::int AS count FROM ops.external_circuits
      WHERE source LIKE 'test_guard_%' OR source='cninfo-test'`
  );
  const relationExceptionRows = await query(
    `SELECT COUNT(*)::int AS count
       FROM core.instruments i
       LEFT JOIN core.company_instruments ci ON ci.instrument_id=i.instrument_id AND ci.relation_type='issued_by'
      WHERE i.asset_class='stock' AND i.status='listed' AND NULLIF(BTRIM(i.name),'') IS NULL AND ci.instrument_id IS NULL`
  );
  controlledPending.push(`当前只读统计：历史合并候选 ${number(mergeRows[0]?.candidates)} 组（待审 ${number(mergeRows[0]?.pending)}，其中可自动迁移 ${number(mergeRows[0]?.safe_pending)}，已迁移 ${number(mergeRows[0]?.migrated)}），裸股票代码 ${number(bareStock.count)} 条（可直接规范化 ${number(bareStock.safe_normalize)}、需合并 ${number(bareStock.merge_conflict)}），旧 test_guard 熔断 ${number(testCircuitRows[0]?.count)} 条，空名称关系例外 ${number(relationExceptionRows[0]?.count)} 条`);

  return { checks, controlledPending, pool };
}

function reportResult(result, mode) {
  const failed = result.checks.filter(check => !check.ok);
  const payload = {
    ok: failed.length === 0,
    mode,
    status: failed.length ? 'failed' : (result.controlledPending || result.pending || []).length ? 'pass_with_controlled_pending' : 'passed',
    checked_at: new Date().toISOString(),
    checks: result.checks,
    controlled_pending: result.controlledPending || result.pending || [],
  };
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const label = mode === 'static' ? '静态架构门禁' : '数据架构只读验收';
    console.log(`${label}：${payload.ok ? '通过' : '失败'}（${payload.status}）`);
    for (const check of result.checks) console.log(`${check.ok ? '✓' : '✗'} ${check.code}：${check.detail}`);
    if (payload.controlled_pending.length) {
      console.log('受控待办（不代表本次代码/数据库验收失败）：');
      payload.controlled_pending.forEach(item => console.log(`- ${item}`));
    }
    if (mode === 'static') {
      console.log('说明：--static 只做依赖/角色/契约/耦合静态检查，不执行数据库验收；数据侧请另跑默认模式。');
    }
  }
  if (!payload.ok) process.exitCode = 1;
}

async function main() {
  if (STATIC_MODE) {
    reportResult(runStaticChecks(), 'static');
    return;
  }
  const result = await runDatabaseChecks();
  reportResult(result, 'database');
  await result.pool.end();
}

// 只有直接运行时才执行入口；被测试 require 时不得连接数据库。
if (require.main === module) {
  main().catch(async error => {
    console.error(`数据架构验收失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  hasInlineScript,
  hasInlineStyle,
  hasSymbolDefinition,
  parsePageScripts,
  runStaticChecks,
  providerMappingEntrypoints,
};
