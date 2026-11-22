'use strict';

const { STATUS } = require('./stockSelectionRules');

function evaluateGrahamRisk(facts = {}) {
  if (facts.delistDate && facts.asOfDate && String(facts.delistDate) <= String(facts.asOfDate)) {
    return { code: 'RISK', status: STATUS.RISK, reason: 'delisted' };
  }
  if (facts.riskWarning) {
    return { code: 'RISK', status: STATUS.RISK, reason: 'risk_warning' };
  }
  if (facts.suspendType) {
    return { code: 'RISK', status: STATUS.RISK, reason: 'suspended' };
  }
  return { code: 'RISK', status: STATUS.PASS, reason: null };
}

const STRATEGY_CODE_GRAHAM = 'graham_net_net_v1';

const GRAHAM_PARAMS = Object.freeze({
  slotsPerMarket: 30,
  industryLimitRatio: 1,
  marketGate: 'off',
  formulaVersion: 'graham-net-net-formula-v1',
  adapterVersion: 'selection-adapter-v1',
  riskVersion: 'selection-risk-v1',
  industryVersion: 'selection-industry-v1',
  precisionPolicyVersion: 'graham-bigint-v1',
});

const FINANCIAL_FS_TYPES = new Set(['bank', 'insurance', 'security', 'other_financial']);
const SCALE = 1000000n; // 10^-6 精度定点 BigInt

function parseScaledBigInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  const num = Number(text);
  if (!Number.isFinite(num)) return null;
  // 处理科学计数法或普通小数字符串，统一转为定点 BigInt
  const normalized = /e/i.test(text) ? num.toFixed(6) : text;
  const match = normalized.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const intPart = BigInt(match[2]);
  const fracRaw = (match[3] || '').slice(0, 6).padEnd(6, '0');
  const fracPart = BigInt(fracRaw);
  return sign * (intPart * SCALE + fracPart);
}

function mulScaledBigInt(aScaled, bScaled) {
  return (aScaled * bScaled) / SCALE;
}

function scaledToNumber(scaled, digits = 2) {
  if (scaled === null || scaled === undefined) return null;
  const factor = 10 ** digits;
  const num = Number(scaled) / Number(SCALE);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * factor) / factor;
}

function ratioScaled(numeratorScaled, denominatorScaled, digits = 6) {
  if (numeratorScaled === null || denominatorScaled === null || denominatorScaled <= 0n) return null;
  const precision = 10n ** BigInt(digits);
  const scaled = (numeratorScaled * precision) / denominatorScaled;
  return Number(scaled) / (10 ** digits);
}

function evaluateGrahamCandidate(facts = {}) {
  const risk = evaluateGrahamRisk(facts);
  if (risk.status === STATUS.RISK) {
    return {
      status: STATUS.RISK,
      g01: { code: 'G01', status: STATUS.NOT_APPLICABLE, reason: risk.reason || 'risk_blocked' },
      rules: [risk],
      metrics: null,
      rankingScore: null,
      reason: risk.reason,
    };
  }

  const fsType = String(facts.fsTableType || '').trim().toLowerCase();
  if (FINANCIAL_FS_TYPES.has(fsType)) {
    const g01 = {
      code: 'G01',
      status: STATUS.NOT_APPLICABLE,
      reason: 'financial_statement_no_current_classification',
    };
    return { status: STATUS.NOT_APPLICABLE, g01, rules: [g01], metrics: null, rankingScore: null, reason: g01.reason };
  }

  if (!facts.hasBalanceReport) {
    const g01 = {
      code: 'G01',
      status: STATUS.NOT_APPLICABLE,
      reason: 'graham_not_evaluable_no_report',
    };
    return { status: STATUS.NOT_APPLICABLE, g01, rules: [g01], metrics: null, rankingScore: null, reason: g01.reason };
  }

  const caScaled = parseScaledBigInt(facts.currentAssets);
  const clScaled = parseScaledBigInt(facts.currentLiabilities);
  if (caScaled === null || clScaled === null) {
    const g01 = {
      code: 'G01',
      status: STATUS.PENDING,
      reason: 'current_assets_or_liabilities_unavailable',
    };
    return { status: STATUS.PENDING, g01, rules: [g01], metrics: null, rankingScore: null, reason: g01.reason };
  }

  const mcScaled = parseScaledBigInt(facts.totalMarketCap);
  if (mcScaled === null || mcScaled <= 0n) {
    const g01 = {
      code: 'G01',
      status: STATUS.PENDING,
      reason: 'market_cap_unavailable',
    };
    return { status: STATUS.PENDING, g01, rules: [g01], metrics: null, rankingScore: null, reason: g01.reason };
  }

  const balCcy = String(facts.balanceCurrency || facts.valuationCurrency || 'CNY').toUpperCase();
  const valCcy = String(facts.valuationCurrency || (facts.market === 'HK' ? 'HKD' : 'CNY')).toUpperCase();
  let fxScaled = SCALE;
  if (balCcy !== valCcy) {
    const parsedFx = parseScaledBigInt(facts.fxRate);
    if (parsedFx === null || parsedFx <= 0n) {
      const g01 = {
        code: 'G01',
        status: STATUS.PENDING,
        reason: 'fx_rate_missing',
        balanceCurrency: balCcy,
        valuationCurrency: valCcy,
      };
      return { status: STATUS.PENDING, g01, rules: [g01], metrics: null, rankingScore: null, reason: g01.reason };
    }
    fxScaled = parsedFx;
  }

  const caInValScaled = balCcy === valCcy ? caScaled : mulScaledBigInt(caScaled, fxScaled);
  const clInValScaled = balCcy === valCcy ? clScaled : mulScaledBigInt(clScaled, fxScaled);
  const ncavScaled = caInValScaled - clInValScaled;
  const surplusScaled = ncavScaled - mcScaled;
  const passed = surplusScaled > 0n;

  const surplusRatio = ratioScaled(surplusScaled, mcScaled, 6);
  const mcToNcav = ncavScaled > 0n ? ratioScaled(mcScaled, ncavScaled, 4) : null;

  const metrics = {
    currentAssetsRaw: scaledToNumber(caScaled, 2),
    currentLiabilitiesRaw: scaledToNumber(clScaled, 2),
    currentAssets: scaledToNumber(caInValScaled, 2),
    currentLiabilities: scaledToNumber(clInValScaled, 2),
    ncav: scaledToNumber(ncavScaled, 2),
    totalMarketCap: scaledToNumber(mcScaled, 2),
    netNetSurplus: scaledToNumber(surplusScaled, 2),
    surplusRatio,
    mcToNcav,
    balanceCurrency: balCcy,
    valuationCurrency: valCcy,
    fxRate: balCcy === valCcy ? 1 : Number(facts.fxRate),
    fxDate: facts.fxDate || null,
    periodEnd: facts.periodEnd || null,
    reportId: facts.reportId || null,
  };

  const g01 = {
    code: 'G01',
    status: passed ? STATUS.PASS : STATUS.FAIL,
    reason: passed ? 'net_net_surplus_positive' : 'net_net_surplus_non_positive',
    value: metrics.netNetSurplus,
    surplusRatio,
    mcToNcav,
  };

  return {
    status: passed ? STATUS.PASS : STATUS.FAIL,
    g01,
    rules: [g01],
    metrics,
    rankingScore: passed ? surplusRatio : null,
    reason: g01.reason,
  };
}

function rankGrahamCandidates(candidates = []) {
  return (candidates || [])
    .filter(c => c.status === STATUS.PASS && c.rankingScore !== null)
    .slice()
    .sort((a, b) => {
      if (b.rankingScore !== a.rankingScore) return b.rankingScore - a.rankingScore;
      return String(a.tsCode || '').localeCompare(String(b.tsCode || ''));
    });
}

module.exports = {
  STRATEGY_CODE_GRAHAM,
  GRAHAM_PARAMS,
  FINANCIAL_FS_TYPES,
  parseScaledBigInt,
  evaluateGrahamCandidate,
  rankGrahamCandidates,
};
