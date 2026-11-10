// 港股单股刷新：复用现役采集链路补缺口，逐域审计 + 持久化续跑 + 只读重算快照。
// 不发布整个 HK 市场财务/行情分区；单股只保留自身 scope 证据；失败域下次只续这些域。
'use strict';

const { datasetScope, getDatasetCursors, markDatasetSuccess } = require('./datasetCursors');
const { readHkCoverage } = require('../repositories/hkSecurityAnalysisRepository');
const contract = require('../domain/securityAnalysisContract');

// 必需域决定「核心可用性」；官方未提供的域标客观不可得，不算失败也不伪装完成。
const REQUIRED_DOMAINS = Object.freeze(['master', 'bars', 'valuation', 'reports', 'snapshot']);
const OPTIONAL_DOMAINS = Object.freeze(['dividends', 'announcements']);
const NOT_APPLICABLE_DOMAINS = Object.freeze(['adjustment']);
const ALL_DOMAINS = Object.freeze([...REQUIRED_DOMAINS, ...OPTIONAL_DOMAINS]);

function coverageOf(domain, coverage) {
  switch (domain) {
    case 'master': return coverage.master;
    case 'bars': return coverage.bars > 0;
    case 'valuation': return coverage.valuations > 0;
    case 'reports': return coverage.reports > 0;
    case 'dividends': return coverage.dividends > 0;
    case 'announcements': return false; // 港股公告统一采集层尚未覆盖，明确登记能力边界
    case 'snapshot': return coverage.snapshots > 0;
    default: return false;
  }
}

function cursorSucceeded(cursor, targetDate) {
  if (!cursor || cursor.last_error) return false;
  if (!targetDate) return Boolean(cursor.last_success_date);
  return String(cursor.last_success_date || '').slice(0, 10) >= String(targetDate).slice(0, 10);
}

async function collectMissingDomains({ tsCode, asOfDate, missing }) {
  // 复用现役港股补数入口（已准入来源 + 统一 Guard + 标准层落库），不新建采集器。
  // 只按单只证券调用，不启动整个选股补数流程；helper 的 ok 不等于分析完整，下面仍按本地覆盖复查。
  const inputs = require('./stockSelectionInputsSync');
  const attempts = [];
  const needsMarket = missing.some(domain => domain === 'bars' || domain === 'valuation');
  const needsFacts = missing.some(domain => domain === 'reports' || domain === 'dividends');
  if (needsMarket) {
    try { attempts.push({ domain: 'hk_market', result: await inputs.collectHkMarketData({ code: tsCode }, asOfDate) }); }
    catch (error) { attempts.push({ domain: 'hk_market', error: error.message }); }
  }
  if (needsFacts) {
    try { attempts.push({ domain: 'hk_facts', result: await inputs.collectOne({ code: tsCode }, asOfDate) }); }
    catch (error) { attempts.push({ domain: 'hk_facts', error: error.message }); }
  }
  return attempts;
}

/**
 * 单股刷新结果始终带阶段结果、剩余进度、有效数据日与快照版本。
 * 成功域按目标日推进水位；失败/空结果不推进，下次只续这些域。
 */
async function runHkSingleStockRefresh(options = {}) {
  const tsCode = String(options.tsCode || '').toUpperCase();
  if (!contract.HK_CODE_RE.test(tsCode)) throw new Error('港股刷新必须指定完整标准代码');
  const targetDate = String(options.targetDate || options.asOfDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const scope = datasetScope('hk_stock_analysis', tsCode);
  const cursors = await getDatasetCursors(scope, ALL_DOMAINS);
  let coverage = await readHkCoverage(tsCode);

  const pending = ALL_DOMAINS.filter(domain => !cursorSucceeded(cursors.get(domain), targetDate));
  const attempts = await collectMissingDomains({
    tsCode, asOfDate: targetDate,
    missing: pending.filter(domain => ['bars', 'valuation', 'reports', 'dividends'].includes(domain)),
  });
  // 采集后重查本地事实：接口成功但没落库不算覆盖。
  coverage = await readHkCoverage(tsCode);

  const stageResults = [];
  const remaining = [];
  for (const domain of ALL_DOMAINS) {
    if (cursorSucceeded(cursors.get(domain), targetDate)) {
      stageResults.push({ domain, status: 'skipped_already_succeeded', targetDate });
      continue;
    }
    const covered = coverageOf(domain, coverage);
    if (covered) {
      await markDatasetSuccess(scope, domain, { lastSuccessDate: targetDate });
      stageResults.push({ domain, status: 'succeeded', targetDate, source: 'local_coverage' });
    } else if (OPTIONAL_DOMAINS.includes(domain)) {
      remaining.push({ domain, status: 'source_unavailable', reason: domain === 'announcements'
        ? '港股公告统一采集层尚未覆盖该市场' : '暂无已实施的现金分红记录', required: false });
      stageResults.push({ domain, status: 'blocked_optional', targetDate });
    } else {
      remaining.push({ domain, status: 'pending', reason: '本地覆盖缺失或来源未提供', required: true });
      stageResults.push({ domain, status: 'failed', targetDate });
    }
  }
  for (const domain of NOT_APPLICABLE_DOMAINS) {
    stageResults.push({ domain, status: 'not_applicable', reason: coverage.adjustments > 0
      ? '已有复权因子' : '港股官方现金流/复权暂未提供可靠因子，相关指标按未复权展示' });
  }

  // 快照：核心域齐备才只读重算；失败保留上次完整快照，不登记整股同步成功。
  let analysisVersion = null, snapshotStatus = 'retained_previous';
  const blocking = remaining.filter(item => item.required).map(item => item.domain);
  if (!blocking.includes('snapshot') || coverage.reports > 0) {
    try {
      const hk = require('./hkSecurityAnalysis');
      const analysis = await hk.refreshHkAnalysis(tsCode, {
        reason: 'manual-hk-single-stock', isoToday: targetDate,
        financial: options.financial === true,
      });
      analysisVersion = analysis && analysis.display ? analysis.display.analysis_version : null;
      snapshotStatus = 'rebuilt_read_only';
    } catch (error) {
      remaining.push({ domain: 'snapshot', status: 'pending', reason: error.message, required: true });
      snapshotStatus = 'retained_previous';
    }
  }
  const requiredMissing = remaining.filter(item => item.required).map(item => item.domain);
  const stageComplete = requiredMissing.length === 0;
  const effectiveDataDate = coverage.valuationDate || coverage.barsDate || null;
  const scopeEvidence = contract.datasetScopeOf({ market: 'HK', targetDate, targetCodes: [tsCode] });

  return {
    ok: true,
    status: stageComplete ? 'succeeded' : 'partial',
    stageComplete,
    mode: 'stock_analysis',
    market: 'HK',
    tsCode,
    codes: [tsCode],
    targetFields: [],
    publishDatasets: false,
    publishDatasetCodes: [],
    stageResults,
    remaining,
    remainingCount: remaining.length,
    nextRunAt: stageComplete ? null : `${targetDate}T00:00:00+08:00`,
    effectiveDataDate,
    analysisVersion,
    snapshotStatus,
    attempts,
    scopeEvidence,
    // 单股完成不代表市场全集分区已发布，A 股分区也不能抵消 HK 缺口。
    datasetPublication: { market: 'HK', scope: scopeEvidence.scope, published: false, reason: 'single_stock_only' },
  };
}

module.exports = { runHkSingleStockRefresh, REQUIRED_DOMAINS, OPTIONAL_DOMAINS, coverageOf, cursorSucceeded };
