// G0 三项前置审计（投资策略选股 V2 方案 27.14.1 / 27.19 AC-01）。
// 只读库内已落库事实，不联网、不写业务表；输出可复核的覆盖分布、逐层数量与证据容量。
// 用法：
//   node server/scripts/stockSelectionG0Audit.js --market=CN --as-of=2026-11-06
//   node server/scripts/stockSelectionG0Audit.js --market=CN,HK --out=data/test-evidence/g0.json
'use strict';

const fs = require('fs');
const path = require('path');
const CoreDate = require('../../public/shared/core-date.js');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const hit = args.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const MARKETS = String(flag('market', 'CN')).toUpperCase().split(',').map(item => item.trim()).filter(Boolean);
const AS_OF = flag('as-of', null);
const OUT = flag('out', null);
const WORST_LIMIT = Number(flag('worst', '20'));

/** 覆盖率分桶（按有效正 PB / 应有日）。 */
const BUCKETS = [
  { label: '<25%', test: ratio => ratio < 0.25 },
  { label: '25-50%', test: ratio => ratio >= 0.25 && ratio < 0.5 },
  { label: '50-75%', test: ratio => ratio >= 0.5 && ratio < 0.75 },
  { label: '75-90%', test: ratio => ratio >= 0.75 && ratio < 0.9 },
  { label: '90-99%', test: ratio => ratio >= 0.9 && ratio < 0.999999 },
  { label: '100%', test: ratio => ratio >= 0.999999 },
];

function coverageRatio(coveredDays, expectedDays) {
  if (!expectedDays || expectedDays <= 0) return null;
  return Math.max(0, Math.min(1, coveredDays / expectedDays));
}

/**
 * G0-1 逐股十年 PB 覆盖分布：直接复用 loadPbWindow（同一套逐日核验），
 * 不另写一遍 SQL，避免审计口径与生产口径分叉。
 */
async function g01Coverage({ repo, market, asOfDate }) {
  const windowStart = CoreDate.subtractYears(asOfDate, 10);
  const pb = await repo.loadPbWindow({ market, windowStart, asOfDate });
  const rows = [...pb.byInstrument.entries()].map(([instrumentId, evidence]) => {
    const expectedDays = Number(evidence.expectedDays || 0);
    const coveredDays = Number(evidence.positiveDays === undefined ? evidence.coveredDays : evidence.positiveDays) || 0;
    const ratio = coverageRatio(coveredDays, expectedDays);
    return {
      instrumentId: Number(instrumentId),
      expectedDays,
      coveredDays,
      gapDays: evidence.positiveGapDays === undefined ? evidence.gapDays : evidence.positiveGapDays,
      observedDays: evidence.observedDays === undefined ? null : evidence.observedDays,
      nonPositiveDays: evidence.nonPositiveDays === undefined ? null : evidence.nonPositiveDays,
      calendarComplete: evidence.calendarComplete === undefined ? null : evidence.calendarComplete,
      historyYears: evidence.historyYears === undefined ? null : evidence.historyYears,
      effectiveStart: evidence.effectiveStart || null,
      coverageRatio: ratio,
    };
  });
  const withExpected = rows.filter(row => row.expectedDays > 0);
  const buckets = BUCKETS.map(bucket => ({
    label: bucket.label,
    count: withExpected.filter(row => row.coverageRatio !== null && bucket.test(row.coverageRatio)).length,
  }));
  const ratios = withExpected.map(row => row.coverageRatio).filter(value => value !== null).sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  const fullCoverage = withExpected.filter(row => row.coverageRatio !== null && row.coverageRatio >= 0.999999).length;
  const calendarUnknown = rows.filter(row => row.calendarComplete === false).length;
  const worst = withExpected
    .filter(row => row.coverageRatio !== null)
    .sort((a, b) => a.coverageRatio - b.coverageRatio)
    .slice(0, Number.isFinite(WORST_LIMIT) ? WORST_LIMIT : 20);
  return {
    market,
    asOfDate,
    windowStart,
    instrumentCount: rows.length,
    withExpectedDays: withExpected.length,
    medianCoverageRatio: median,
    zeroCoverageCount: withExpected.filter(row => row.coverageRatio === 0).length,
    fullCoverageCount: fullCoverage,
    fullCoverageRatio: withExpected.length ? Number((fullCoverage / withExpected.length).toFixed(4)) : null,
    calendarIncompleteCount: calendarUnknown,
    nonPositivePresentCount: rows.filter(row => Number(row.nonPositiveDays || 0) > 0).length,
    buckets,
    worst,
  };
}

/**
 * G0-2 V2 可行性与逐层数量：同一目标日跑一次真实计算（不落库），
 * 逐层给出全池 → R01 → R02 → 最终通过 → 排名就绪 → 席位，并同时给 V1 对照。
 */
async function g02Feasibility({ service, market, asOfDate }) {
  const layers = {};
  const codes = service.STRATEGY_CODES;
  for (const strategyCode of codes) {
    const computed = await service.computeSelection({
      market, asOfDate, positionRatio: 1, strategyCode,
      // 只读审计：不固化股票池 artifact，避免审计脚本写业务表。
      writeUniverseArtifact: false,
    });
    const evaluated = computed.evaluated || [];
    const countRule = status => evaluated.filter(item => (item.rules && item.rules.R02) && item.rules.R02.status === status).length;
    // R01 双路径与交集：PB 通道、乘积通道，以及"PB≤1.5 且乘积也 <22.5"的重叠数。
    const pbThreshold = evaluated.filter(item => item.rules && item.rules.R01
      && item.rules.R01.status === 'PASS' && item.rules.R01.reason === 'PB_THRESHOLD');
    const pbPeProductPath = evaluated.filter(item => item.rules && item.rules.R01
      && item.rules.R01.status === 'PASS' && item.rules.R01.reason === 'PB_PE_PRODUCT');
    const intersection = pbThreshold.filter(item => {
      const product = item.pbPeProduct;
      return product !== null && product !== undefined && Number(product) < 22.5;
    }).length;
    // 行业层次：按成员的一级行业分布（成员为空时给空对象，不伪造）。
    const industries = {};
    (computed.portfolio.members || []).forEach(member => {
      const code = member.industry && member.industry.code ? member.industry.code : 'unknown';
      industries[code] = (industries[code] || 0) + 1;
    });
    layers[strategyCode] = {
      universe: (computed.coverage && computed.coverage.universeCount) || 0,
      universeArtifact: computed.universeEvidence || null,
      r01Paths: {
        pbThreshold: pbThreshold.length,
        pbPeProduct: pbPeProductPath.length,
        intersection,
      },
      r02Status: {
        PASS: countRule('PASS'),
        FAIL: countRule('FAIL'),
        PENDING: countRule('PENDING'),
        NOT_APPLICABLE: countRule('NOT_APPLICABLE'),
      },
      filterPass: evaluated.filter(item => item.filterStatus === 'PASS').length,
      rankReady: evaluated.filter(item => item.filterStatus === 'PASS' && item.rankReady === true).length,
      ranked: (computed.ranked || []).length,
      members: computed.portfolio.members.length,
      industries,
      qualityPublishable: computed.quality.publishable,
      qualityReasons: computed.quality.reasons || [],
      pendingCount: computed.quality.pendingCount || 0,
    };
  }
  // 两种 R02 证据政策并排：政策裁决需要逐股差异证据，而不是只看一个布尔。
  const r02Policies = {};
  const v2Code = service.RULES_V2.STRATEGY_CODE_V2;
  for (const policy of ['positive_evidence', 'strict_complete']) {
    const computed = await service.computeSelection({
      market, asOfDate, positionRatio: 1, strategyCode: v2Code,
      internalParams: { pbExtremaPolicy: policy },
      writeUniverseArtifact: false,
    });
    const evaluated = computed.evaluated || [];
    r02Policies[policy] = {
      pass: evaluated.filter(item => item.rules && item.rules.R02 && item.rules.R02.status === 'PASS').length,
      fail: evaluated.filter(item => item.rules && item.rules.R02 && item.rules.R02.status === 'FAIL').length,
      notApplicable: evaluated.filter(item => item.rules && item.rules.R02 && item.rules.R02.status === 'NOT_APPLICABLE').length,
      pending: evaluated.filter(item => item.rules && item.rules.R02 && item.rules.R02.status === 'PENDING').length,
      filterPass: evaluated.filter(item => item.filterStatus === 'PASS').length,
      members: computed.portfolio.members.length,
      publishable: computed.quality.publishable,
      qualityReasons: computed.quality.reasons || [],
    };
  }
  return { market, asOfDate, layers, r02Policies };
}

/** G0-3 证据容量与恢复成本：表大小、行数、候选 detail 平均字节。 */
async function g03Capacity({ pool }) {
  const { rows } = await pool.query(`
    SELECT 'analytics.stock_selection_candidates' AS object_name,
           pg_total_relation_size('analytics.stock_selection_candidates') AS total_bytes,
           (SELECT count(*) FROM analytics.stock_selection_candidates) AS row_count,
           (SELECT avg(pg_column_size(detail))::numeric(14,1) FROM analytics.stock_selection_candidates) AS avg_detail_bytes
    UNION ALL
    SELECT 'analytics.stock_selection_runs',
           pg_total_relation_size('analytics.stock_selection_runs'),
           (SELECT count(*) FROM analytics.stock_selection_runs), NULL
    UNION ALL
    SELECT 'analytics.stock_selection_universe_artifacts',
           pg_total_relation_size('analytics.stock_selection_universe_artifacts'),
           (SELECT count(*) FROM analytics.stock_selection_universe_artifacts), NULL
    UNION ALL
    SELECT 'market.daily_valuations',
           pg_total_relation_size('market.daily_valuations'),
           (SELECT count(*) FROM market.daily_valuations), NULL
    UNION ALL
    SELECT 'market.daily_bars',
           pg_total_relation_size('market.daily_bars'),
           (SELECT count(*) FROM market.daily_bars), NULL`);
  const backup = await pool.query(`
    SELECT count(*)::int AS artifacts,
           COALESCE(sum(pg_column_size(members)), 0)::bigint AS members_bytes,
           COALESCE(avg(pg_column_size(members)), 0)::numeric(14,1) AS avg_members_bytes
      FROM analytics.stock_selection_universe_artifacts`);
  return {
    objects: rows.map(row => ({
      name: row.object_name,
      totalBytes: Number(row.total_bytes || 0),
      totalMb: Number((Number(row.total_bytes || 0) / 1048576).toFixed(2)),
      rowCount: Number(row.row_count || 0),
      avgDetailBytes: row.avg_detail_bytes === null ? null : Number(row.avg_detail_bytes),
    })),
    universeArtifacts: backup.rows[0] ? {
      artifacts: Number(backup.rows[0].artifacts || 0),
      membersBytes: Number(backup.rows[0].members_bytes || 0),
      avgMembersBytes: Number(backup.rows[0].avg_members_bytes || 0),
    } : null,
  };
}

async function main() {
  require('dotenv').config();
  const service = require('../services/stockSelectionService');
  const repo = require('../repositories/stockSelectionRepository');
  const { pool } = require('../db/connection');

  const asOfDate = AS_OF || CoreDate.todayInZone('Asia/Shanghai');
  const report = {
    generatedAt: new Date().toISOString(),
    asOfDate,
    // 源库身份：报告必须能说明"这是哪个库、什么版本、什么时刻的快照"（27.20.3）。
    source: null,
    inputVersions: {},
    markets: {},
    g01: {},
    g02: {},
    g03: null,
    errors: [],
  };

  for (const market of MARKETS) {
    if (!['CN', 'HK'].includes(market)) {
      report.errors.push(`市场参数不合法：${market}`);
      continue;
    }
    try {
      report.g01[market] = await g01Coverage({ repo, market, asOfDate });
      report.g02[market] = await g02Feasibility({ service, market, asOfDate });
    } catch (error) {
      report.errors.push(`${market} 审计失败：${error.message}`);
    }
  }
  try {
    const identity = await pool.query(`
      SELECT current_database() AS database, current_user AS db_user, version() AS server_version,
             now() AS snapshot_at,
             (SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1) AS latest_migration`);
    report.source = {
      database: identity.rows[0].database,
      dbUser: identity.rows[0].db_user,
      serverVersion: identity.rows[0].server_version,
      snapshotAt: identity.rows[0].snapshot_at,
      latestMigration: identity.rows[0].latest_migration,
    };
  } catch (error) {
    report.errors.push(`源库身份读取失败：${error.message}`);
  }
  // 输入版本：股票池 artifact 的内容哈希 + 信息可见截止，是"同一目标日同一份名单"的证据。
  report.inputVersions = Object.fromEntries(Object.entries(report.g02).map(([market, item]) => {
    const firstLayer = Object.values(item.layers || {})[0] || {};
    const artifact = firstLayer.universeArtifact || {};
    return [market, {
      universeContentHash: artifact.contentHash || null,
      universeMemberCount: artifact.memberCount === undefined ? null : artifact.memberCount,
      knowledgeCutoff: artifact.knowledgeCutoff || null,
      poolDefinition: artifact.poolDefinition || null,
      excludedCount: artifact.excludedCount === undefined ? null : artifact.excludedCount,
    }];
  }));
  try {
    report.g03 = await g03Capacity({ pool });
  } catch (error) {
    report.errors.push(`容量审计失败：${error.message}`);
  }

  const text = JSON.stringify(report, null, 2);
  if (OUT) {
    const target = path.resolve(process.cwd(), OUT);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    console.log(`G0 审计报告已写入 ${target}`);
  } else {
    console.log(text);
  }
  // 控制台摘要：只报关键数字，便于人工快速判断是否具备启用条件。
  Object.entries(report.g01).forEach(([market, item]) => {
    console.log(`[G0-1] ${market} 标的 ${item.instrumentCount}，有应有日 ${item.withExpectedDays}，`
      + `覆盖中位数 ${item.medianCoverageRatio === null ? 'n/a' : (item.medianCoverageRatio * 100).toFixed(1) + '%'}，`
      + `100% 覆盖 ${item.fullCoverageCount}，日历不完整 ${item.calendarIncompleteCount}`);
  });
  Object.entries(report.g02).forEach(([market, item]) => {
    Object.entries(item.layers).forEach(([code, layer]) => {
      console.log(`[G0-2] ${market} ${code}：池 ${layer.universe} → R01 ${layer.r01Pass} → `
        + `R02通过 ${layer.r02Status.PASS} → 通过 ${layer.filterPass} → 席位 ${layer.members}`);
    });
  });
  if (report.g03) {
    const candidates = report.g03.objects.find(item => item.name === 'analytics.stock_selection_candidates');
    if (candidates) {
      console.log(`[G0-3] 候选表 ${candidates.totalMb}MB / ${candidates.rowCount} 行，`
        + `detail 平均 ${candidates.avgDetailBytes === null ? 'n/a' : Math.round(candidates.avgDetailBytes)} 字节`);
    }
  }
  if (report.errors.length) {
    report.errors.forEach(item => console.error(`[G0] ${item}`));
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
