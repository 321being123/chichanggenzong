// 投资策略选股中心 V2：纯规则计算（方案第 27.4、27.5 节）。
// 与 V1（stockSelectionRules）并存：V1 冻结不动，V2 独立登记策略/公式/参数版本，服务按策略分派。
// 本文件只接收事实对象做判断，不含 SQL、不联网、不读环境变量。
//
// V2 与 V1 的差别只有三处（其余 R04/R05、11 财年异常、竞赛排名、风险、行业预算沿用基线）：
//   1) R01：0<PB<=1.5，或 PB>1.5 且 PE(TTM)>0 且 PB×PE(TTM)<22.5（严格小于，等于不通过）；
//   2) R02：十年 PB「正极值比」max/min>=3（旧称 PB 波动倍数），不是「十年内出现过 PB>1」；
//   3) 取消市场指数 PB 配置门槛：指数估值只做可选展示，不参与质量/发布判定。
//
// 十进制合同：PB/PE/乘积/极值比/排名/行业预算全部用十进制比较，不先转 JS Number 再比。
'use strict';

const V1 = require('./stockSelectionRules');

const STATUS = V1.STATUS;

const STRATEGY_CODE_V2 = 'investment_essentials_adapted_v2';

/**
 * R02 证据政策（方案 27.5 的待裁决基线）：
 * - positive_evidence（默认，本版采用）：同窗口同身份同口径的**正 PB 有效子集**里
 *   已观测 max/min>=3 即可判通过。数学依据：补入其他正值只会让比值维持或变大，
 *   已观测比值是全正序列波动的下界，通常只需两个可靠极值，不要求零缺口。
 *   反之，已观测比值<3 且仍有缺口时不能判 FAIL，只能待补。
 * - strict_complete：零缺口才允许判定（原稿设计基线），保留用于对照与受控回归。
 * 审计脚本 G0-1 会用两种政策并列输出，最终采纳口径记在方案第 27.5 节。
 */
const PB_EXTREMA_POLICIES = Object.freeze(['positive_evidence', 'strict_complete']);

// V2 参数：阈值与比较方式固化在公式/策略版本，浏览器请求不能覆盖公共策略。
const V2_PARAMS = Object.freeze({
  maxPb: 1.5,
  maxPbPeProduct: 22.5,
  pbLookbackYears: 10,
  pbPositiveExtremaMultiple: 3,
  pbExtremaPolicy: 'positive_evidence',
  // R02 正式口径：老口径「十年内出现过 PB>1」与新口径「正极值比达倍数」取**或**。
  // 之所以新增极值比，是因为港股大量标的十年 PB 从未破 1（老口径永远不合格），
  // 但它们的估值落差可以超过三倍。所以新口径是补充，不是替代。
  // 另两个值 v1_any_above_one / v2_positive_ratio 只用于单因素阶梯与审计对照。
  r02Rule: 'v1_or_v2',
  minEquityCny: 10000000000,
  dividendWindowMonths: 12,
  slotsPerMarket: 30,
  industryLimitRatio: 0.2,
  anomalyLookbackYears: 10,
  requiredFiscalYears: 11,
  strategyCode: STRATEGY_CODE_V2,
  formulaVersion: 'selection-formula-v2',
  adapterVersion: 'selection-adapter-v1',
  riskVersion: 'selection-risk-v1',
  industryVersion: 'selection-industry-v1',
  precisionPolicyVersion: 'selection-decimal-v1',
});

const RULE_CODES = Object.freeze(['R01', 'R02', 'R04', 'R05']);

/* ------------------------------------------------------------------ *
 * 十进制比较（方案 27.4「全链路十进制合同」）
 * 只在这里实现一次：解析成 BigInt 有效数字 + 标度，比较用交叉对齐，
 * 不经过 Number，避免 2*11.2499 这类边界被二进制浮点改判。
 * ------------------------------------------------------------------ */

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function parseDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return { neg: false, digits: value, scale: 0 };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Number 转字符串是这里唯一可能已经丢失精度的入口；调用方应优先传 NUMERIC 原始字符串。
    return parseDecimal(String(value));
  }
  const text = String(value).trim();
  if (!DECIMAL_RE.test(text)) return null;
  const match = DECIMAL_RE.exec(text);
  const sign = match[1] === '-';
  const intPart = match[2] || '';
  const fracPart = match[3] || '';
  const expPart = match[4] ? Number(match[4]) : 0;
  if (!intPart && !fracPart) return null;
  let digitsText = `${intPart}${fracPart}`;
  let scale = fracPart.length - expPart;
  if (!Number.isFinite(scale)) return null;
  let digits = BigInt(digitsText.replace(/^0+(?=\d)/, '') || '0');
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (digits === 0n) return { neg: false, digits: 0n, scale: 0 };
  return { neg: sign, digits, scale };
}

function compareScaled(a, b) {
  const scale = Math.max(a.scale, b.scale);
  const left = a.digits * 10n ** BigInt(scale - a.scale);
  const right = b.digits * 10n ** BigInt(scale - b.scale);
  const leftSigned = a.neg ? -left : left;
  const rightSigned = b.neg ? -right : right;
  if (leftSigned === rightSigned) return 0;
  return leftSigned > rightSigned ? 1 : -1;
}

/** 十进制比较：返回 -1/0/1；任一侧不是有限十进制返回 null（未知不等于 0）。 */
function compareDecimal(a, b) {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (!left || !right) return null;
  return compareScaled(left, right);
}

/** 十进制乘法：返回规范化字符串（去掉尾零与负零），任一侧未知返回 null。 */
function multiplyDecimal(a, b) {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (!left || !right) return null;
  if (left.digits === 0n || right.digits === 0n) return '0';
  const digits = left.digits * right.digits;
  const scale = left.scale + right.scale;
  const neg = left.neg !== right.neg;
  let text = digits.toString();
  if (scale > 0) {
    if (text.length <= scale) text = `${'0'.repeat(scale - text.length + 1)}${text}`;
    text = `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
  }
  return normalizeDecimalText(`${neg ? '-' : ''}${text}`);
}

/** 规范文本：去尾零、去负零。同值不同写法得到同一字符串（哈希因此稳定）。 */
function normalizeDecimalText(text) {
  if (text === null || text === undefined) return null;
  const parsed = parseDecimal(text);
  if (!parsed) return null;
  if (parsed.digits === 0n) return '0';
  let digits = parsed.digits.toString();
  let scale = parsed.scale;
  while (scale > 0 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    scale -= 1;
  }
  let body;
  if (scale <= 0) body = digits;
  else if (digits.length <= scale) body = `0.${'0'.repeat(scale - digits.length)}${digits}`;
  else body = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return `${parsed.neg ? '-' : ''}${body}`;
}

/** 十进制转为展示用 Number：只用于页面/接口数值，不参与判定。 */
function decimalToNumber(value) {
  const parsed = parseDecimal(value);
  if (!parsed) return null;
  return Number(normalizeDecimalText(value));
}

/**
 * 正极值比 = max/min。展示需要商，判定走交叉相乘（max >= min*multiple）。
 * 分母为 0/非正/未知时返回 null，不输出 Infinity。
 */
function extremaRatio(maxPb, minPb) {
  const cmp = compareDecimal(minPb, '0');
  if (cmp === null || cmp <= 0) return null;
  const max = decimalToNumber(maxPb);
  const min = decimalToNumber(minPb);
  if (max === null || min === null) return null;
  // 展示用商保留 6 位有效小数：判定始终走交叉相乘，舍入不会影响通过/不通过。
  return Number((max / min).toFixed(6));
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rule(code, status, fields) {
  return Object.assign({ code, status }, fields || {});
}

function worstStatus(statuses) {
  if (statuses.includes(STATUS.PENDING)) return STATUS.PENDING;
  if (statuses.includes(STATUS.FAIL)) return STATUS.FAIL;
  if (statuses.includes(STATUS.NOT_APPLICABLE)) return STATUS.NOT_APPLICABLE;
  return STATUS.PASS;
}

/* ------------------------------------------------------------------ *
 * TTM 状态（方案 27.4「TTM状态与血缘合同」）
 * ------------------------------------------------------------------ */

/**
 * TTM 盈利状态只认「同一 T、同一权益范围」的滚动十二个月口径证据：
 * - provider_reported：供应商直接给出的 PE(TTM)。正号=盈利、负号=亏损；
 *   PE=0 不能无证据推断利润恰为零，判 unknown（判据来自 pe 符号，不来自最新年报）。
 * - computed：站内按「完整年度＋本期累计－上年同期累计」自算的 ttmProfit。
 * 两者都拿到且符号相反 → 冲突待核验，不用最新年报强解释。
 */
function resolveTtmStatus(facts) {
  const peRaw = facts.peTtmRaw === undefined ? facts.peTtm : facts.peTtmRaw;
  const peCmp = compareDecimal(peRaw, '0');
  const computed = num(facts.ttmProfit);
  const providerStatus = peCmp === null || peCmp === 0 ? null : (peCmp > 0 ? 'profit' : 'loss');
  let computedStatus = null;
  if (computed !== null) computedStatus = computed > 0 ? 'profit' : computed < 0 ? 'loss' : 'zero';

  if (providerStatus && computedStatus) {
    const agree = (providerStatus === 'profit' && computedStatus === 'profit')
      || (providerStatus === 'loss' && computedStatus === 'loss');
    if (!agree) {
      return {
        status: 'unknown',
        basis: 'provider_vs_computed_conflict',
        evidenceRef: facts.ttmEvidenceRef || null,
        peTtm: num(peRaw),
        conflict: { providerStatus, computedStatus },
      };
    }
    return {
      status: providerStatus,
      basis: 'provider_reported_pe_ttm+computed_ttm',
      evidenceRef: facts.ttmEvidenceRef || null,
      peTtm: num(peRaw),
    };
  }
  if (providerStatus) {
    return { status: providerStatus, basis: 'provider_reported_pe_ttm', evidenceRef: facts.ttmEvidenceRef || null, peTtm: num(peRaw) };
  }
  if (computedStatus) {
    return { status: computedStatus, basis: 'computed_ttm', evidenceRef: facts.ttmEvidenceRef || null, peTtm: num(peRaw) };
  }
  // PE 恰为 0 且无自算证据：口径未知，不猜成零利润。
  return { status: 'unknown', basis: 'ttm_unavailable', evidenceRef: facts.ttmEvidenceRef || null, peTtm: num(peRaw) };
}

/* ------------------------------------------------------------------ *
 * R01：PB 与 PE(TTM) 联合估值
 * ------------------------------------------------------------------ */

/**
 * 判定表（方案 27.4）：
 * | 有效 PB≤1.5，PE 任意/缺失      | PASS  PB_THRESHOLD |
 * | PB>1.5，有效正 PE，乘积<22.5    | PASS  PB_PE_PRODUCT |
 * | PB>1.5，正 PE 但乘积≥22.5       | FAIL  VALUATION_FAILED（等于也不通过） |
 * | PB>1.5，PE≤0 且已核实利润事实   | FAIL  PE_NON_POSITIVE |
 * | PB>1.5，PE 缺失/无穷/口径不一致 | PENDING PE_PENDING（不回退静态 PE） |
 * | PB<0                            | FAIL  pb_negative_equity |
 * | PB=0 或可补异常                 | PENDING |
 * | PB 缺失                         | 无报告→不可评估；有报告→待补 |
 */
function evaluateValuationV2(facts, params) {
  const pbRaw = facts.pbRaw === undefined ? facts.pb : facts.pbRaw;
  const pbCmpZero = compareDecimal(pbRaw, '0');
  const pb = num(pbRaw);
  const peRaw = facts.peTtmRaw === undefined ? facts.peTtm : facts.peTtmRaw;
  const pe = num(peRaw);
  const ttm = facts.ttmStatus || resolveTtmStatus(facts);
  const base = {
    pb, pe, peTtm: pe, ttmProfitStatus: ttm.status, ttmStatusBasis: ttm.basis,
    pbPeProduct: null, valuationPass: null, valuationPassReason: null,
  };

  // PB 未知
  if (pbCmpZero === null) {
    const years = (facts.annual && facts.annual.years) || [];
    if (!years.length) {
      return Object.assign(base, {
        rule: rule('R01', STATUS.NOT_APPLICABLE, { value: null, threshold: params.maxPb, reason: 'pb_not_evaluable_no_report' }),
        valuationStatus: STATUS.NOT_APPLICABLE,
        valuationPassReason: 'pb_not_evaluable_no_report',
      });
    }
    return Object.assign(base, {
      rule: rule('R01', STATUS.PENDING, { value: null, threshold: params.maxPb, reason: 'pb_unavailable' }),
      valuationStatus: STATUS.PENDING,
      valuationPassReason: 'pb_unavailable',
    });
  }
  // 负 PB：净资产为负的真实事实，永远不满足，判不通过而不是待补。
  if (pbCmpZero < 0) {
    return Object.assign(base, {
      rule: rule('R01', STATUS.FAIL, { value: pb, threshold: params.maxPb, reason: 'pb_negative_equity' }),
      valuationStatus: STATUS.FAIL,
      valuationPass: false,
      valuationPassReason: 'pb_negative_equity',
    });
  }
  // PB=0：数据异常，不补零、不当便宜。
  if (pbCmpZero === 0) {
    return Object.assign(base, {
      rule: rule('R01', STATUS.PENDING, { value: pb, threshold: params.maxPb, reason: 'pb_non_positive' }),
      valuationStatus: STATUS.PENDING,
      valuationPassReason: 'pb_non_positive',
    });
  }
  // 第一条通道：0<PB<=1.5（闭边界）。PE 缺失不影响估值通过，但排名会另判就绪。
  if (compareDecimal(pbRaw, params.maxPb) <= 0) {
    return Object.assign(base, {
      rule: rule('R01', STATUS.PASS, { value: pb, threshold: params.maxPb, reason: 'PB_THRESHOLD', path: 'PB_THRESHOLD' }),
      valuationStatus: STATUS.PASS,
      valuationPass: true,
      valuationPassReason: 'PB_THRESHOLD',
    });
  }
  // 单因素阶梯（B03）：只启用 PB 通道，等价 V1 的 R01。
  // 这是"关闭 PE 乘积通道"，不是把阈值放宽成某个宽松值——归因时必须能区分通道差异与阈值差异。
  if (String(params.r01Channel || 'pb_or_product') === 'pb_only') {
    return Object.assign(base, {
      rule: rule('R01', STATUS.FAIL, { value: pb, threshold: params.maxPb, reason: 'VALUATION_FAILED', channel: 'pb_only' }),
      valuationStatus: STATUS.FAIL,
      valuationPass: false,
      valuationPassReason: 'VALUATION_FAILED',
    });
  }
  // 第二条通道：PB>1.5 必须正 PE 且乘积严格小于 22.5。
  const ttmConflict = ttm.basis === 'provider_vs_computed_conflict';
  if (ttmConflict) {
    return Object.assign(base, {
      rule: rule('R01', STATUS.PENDING, { value: pb, threshold: params.maxPb, reason: 'PE_PENDING', detail: 'ttm_sign_conflict' }),
      valuationStatus: STATUS.PENDING,
      valuationPassReason: 'PE_PENDING',
    });
  }
  const peCmpZero = compareDecimal(peRaw, '0');
  if (peCmpZero === null) {
    return Object.assign(base, {
      rule: rule('R01', STATUS.PENDING, { value: pb, threshold: params.maxPb, reason: 'PE_PENDING' }),
      valuationStatus: STATUS.PENDING,
      valuationPassReason: 'PE_PENDING',
    });
  }
  if (peCmpZero <= 0) {
    // PE≤0 且 TTM 状态未知 → 待核验；已核实亏损/零利润 → 明确不符合，不让负乘积通过。
    if (ttm.status === 'loss' || ttm.status === 'zero') {
      return Object.assign(base, {
        rule: rule('R01', STATUS.FAIL, { value: pb, threshold: params.maxPb, reason: 'PE_NON_POSITIVE', ttmProfitStatus: ttm.status }),
        valuationStatus: STATUS.FAIL,
        valuationPass: false,
        valuationPassReason: 'PE_NON_POSITIVE',
      });
    }
    return Object.assign(base, {
      rule: rule('R01', STATUS.PENDING, { value: pb, threshold: params.maxPb, reason: 'PE_PENDING', detail: 'pe_non_positive_unverified' }),
      valuationStatus: STATUS.PENDING,
      valuationPassReason: 'PE_PENDING',
    });
  }
  const product = multiplyDecimal(pbRaw, peRaw);
  const productCmp = compareDecimal(product, params.maxPbPeProduct);
  if (productCmp === null) {
    return Object.assign(base, {
      rule: rule('R01', STATUS.PENDING, { value: pb, threshold: params.maxPb, reason: 'PE_PENDING', detail: 'product_unresolved' }),
      valuationStatus: STATUS.PENDING,
      valuationPassReason: 'PE_PENDING',
    });
  }
  const passed = productCmp < 0;
  return Object.assign(base, {
    pbPeProduct: decimalToNumber(product),
    rule: rule('R01', passed ? STATUS.PASS : STATUS.FAIL, {
      value: pb, threshold: params.maxPb, reason: passed ? 'PB_PE_PRODUCT' : 'VALUATION_FAILED',
      path: passed ? 'PB_PE_PRODUCT' : null,
      peTtm: pe, product, productThreshold: params.maxPbPeProduct,
    }),
    valuationStatus: passed ? STATUS.PASS : STATUS.FAIL,
    valuationPass: passed,
    valuationPassReason: passed ? 'PB_PE_PRODUCT' : 'VALUATION_FAILED',
  });
}

/* ------------------------------------------------------------------ *
 * R02：十年 PB 正极值比 + 覆盖证据
 * ------------------------------------------------------------------ */

/**
 * 覆盖统计全部来自同一冻结序列（仓储按证券逐日去重后聚合）：
 * expectedDays 应有日、coveredDays 有效正 PB、observedDays 有可解析 PB、
 * nonPositiveDays 已核实非正、invalidDays 格式/单位异常、missingDays 应有却无观测。
 * gapDays = expectedDays - coveredDays，按集合核对，不做两个 COUNT 相减后截零。
 */
function evaluatePbExtremaV2(facts, params) {
  const window = facts.pbWindow || {};
  const minPbRaw = window.minPbRaw === undefined ? window.minPb : window.minPbRaw;
  const maxPbRaw = window.maxPbRaw === undefined ? window.maxPb : window.maxPbRaw;
  // 覆盖口径：正极值比只认「有效正 PB」序列，因此用 positiveDays/positiveGapDays；
  // V1 的 coveredDays 含负 PB（真实非正事实），两者不能互相顶替。
  const covered = num(window.positiveDays !== undefined && window.positiveDays !== null
    ? window.positiveDays : window.coveredDays) || 0;
  const expected = num(window.expectedDays);
  const gap = num(window.positiveGapDays !== undefined && window.positiveGapDays !== null
    ? window.positiveGapDays : window.gapDays);
  const observed = num(window.observedDays);
  const nonPositive = num(window.nonPositiveDays) || 0;
  const ratio = extremaRatio(maxPbRaw, minPbRaw);
  // 倍数只允许显式 0（表示"该政策下不再要求倍数"）；旧写法 `num(x) || 3` 会把 0 悄悄还原成 3，
  // 让"阶梯放宽"变成假动作（B03）。
  const multipleRaw = params.pbPositiveExtremaMultiple;
  const multiple = multipleRaw === undefined || multipleRaw === null ? 3 : (num(multipleRaw) === null ? 3 : num(multipleRaw));
  const policy = PB_EXTREMA_POLICIES.includes(params.pbExtremaPolicy) ? params.pbExtremaPolicy : 'positive_evidence';
  const evidence = {
    minPb: num(minPbRaw), maxPb: num(maxPbRaw), pbPositiveExtremaRatio: ratio,
    coveredDays: covered, expectedDays: expected, gapDays: gap,
    observedDays: observed, nonPositiveDays: nonPositive,
    invalidDays: num(window.invalidDays) || 0,
    missingDays: num(window.missingDays) || 0,
    exemptDays: num(window.exemptDays) || 0,
    historyComplete: null, historyYears: num(window.historyYears),
    windowStart: window.windowStart || null, windowEnd: window.windowEnd || null,
    effectiveStart: window.effectiveStart || null, listDate: window.listDate || null,
    minPbDate: window.minPbDate || null, maxPbDate: window.maxPbDate || null,
    calendarComplete: window.calendarComplete !== false,
    multiple, policy,
  };
  const cmpMaxMin = compareDecimal(maxPbRaw, '0');
  const cmpMinMin = compareDecimal(minPbRaw, '0');
  const hasPositiveExtrema = cmpMaxMin !== null && cmpMaxMin > 0 && cmpMinMin !== null && cmpMinMin > 0;
  const calendarVerified = window.calendarComplete !== false;

  // 覆盖完整性如实返回，不因最终判 PASS 而伪造完整（方案 27.5 第 5 条）。
  // 日历未核验时"应有日集合"本身不可信，不能据此宣称完整（AC-03 A02）。
  evidence.historyComplete = calendarVerified && expected !== null && gap !== null && gap === 0 && expected > 0;

  // 一份年报都没有 → 没有净资产，PB 客观上不存在，无从评估极值（2026-11-08 生产实测）：
  // 01256.HK（2026-10-09 上市）、02636.HK（2026-10-15 上市）、03774.HK（2026-06-30 上市）
  // 三只都是 `annual_reports=0`，R01 早已判 `pb_not_evaluable_no_report`、
  // R05 判 `equity_not_evaluable_no_report`，唯独 R02 按 `pb_series_unavailable` 待补，
  // 三只合起来把整批港股卡在 `publishable=false` 上——同一事实在不同规则里给了两种口径。
  // 判据与 R01 完全一致：只认「年报年份集合为空」，不看 PB 行数（有行也是数据异常，不是可评估）。
  const annualYearsR02 = (facts.annual && facts.annual.years) || [];
  if (!annualYearsR02.length) {
    return Object.assign(evidence, {
      rule: rule('R02', STATUS.NOT_APPLICABLE, { value: null, reason: 'pb_not_evaluable_no_report', threshold: multiple }),
      status: STATUS.NOT_APPLICABLE,
      reason: 'pb_not_evaluable_no_report',
    });
  }

  // 单因素阶梯（B03）：R02 回退成 V1 判据「窗口内存在 PB>1 即通过」，
  // 把"改 R01"与"改 R02"分开归因；不借用放宽倍数冒充规则切换。
  if (String(params.r02Rule || 'v1_or_v2') === 'v1_any_above_one') {
    const aboveOne = compareDecimal(maxPbRaw, '1');
    if (aboveOne === null) {
      return Object.assign(evidence, {
        rule: rule('R02', STATUS.NOT_APPLICABLE, { value: null, reason: 'history_coverage_unknown', ruleSet: 'v1' }),
        status: STATUS.NOT_APPLICABLE,
        reason: 'history_coverage_unknown',
      });
    }
    if (aboveOne > 0) {
      return Object.assign(evidence, {
        rule: rule('R02', STATUS.PASS, { value: num(maxPbRaw), reason: null, ruleSet: 'v1', evidence: 'v1_any_above_one' }),
        status: STATUS.PASS,
        reason: null,
      });
    }
    if (!calendarVerified || gap === null || gap > 0) {
      return Object.assign(evidence, {
        rule: rule('R02', STATUS.NOT_APPLICABLE, { value: num(maxPbRaw), reason: 'history_gap_not_evaluable', ruleSet: 'v1' }),
        status: STATUS.NOT_APPLICABLE,
        reason: 'history_gap_not_evaluable',
      });
    }
    return Object.assign(evidence, {
      rule: rule('R02', STATUS.FAIL, { value: num(maxPbRaw), reason: 'no_pb_above_one_evidence', ruleSet: 'v1' }),
      status: STATUS.FAIL,
      reason: 'no_pb_above_one_evidence',
    });
  }

  // 正式口径 v1_or_v2：老口径的「十年内出现过 PB>1」与新口径的「正极值比达倍数」是**或**关系。
  // 只出现可靠 PB>1 的正证就直接通过；没出现（港股常见的十年不破 1）才继续用极值比判定。
  // 放在非正 PB 拦截之前是有意的：max>1 是正证，负权益（非正 PB）不推翻它。
  if (String(params.r02Rule || 'v1_or_v2') === 'v1_or_v2') {
    const aboveOne = compareDecimal(maxPbRaw, '1');
    if (aboveOne !== null && aboveOne > 0) {
      return Object.assign(evidence, {
        rule: rule('R02', STATUS.PASS, { value: num(maxPbRaw), reason: null, evidence: 'v1_or_v2_pb_above_one' }),
        status: STATUS.PASS,
        reason: null,
      });
    }
  }

  // 已核实非正 PB（负权益）使正 PB 极值比不可评估，**不能因剔除后比值达标而通过**（方案 27.5 第 6 条）。
  // 这一条必须先于"极值达标即通过"，否则混合了非正事实的窗口会被算成 PASS（AC-03 A10）。
  if (nonPositive > 0) {
    return Object.assign(evidence, {
      rule: rule('R02', STATUS.NOT_APPLICABLE, { value: ratio, reason: 'pb_non_positive_not_evaluable', threshold: multiple }),
      status: STATUS.NOT_APPLICABLE,
      reason: 'pb_non_positive_not_evaluable',
    });
  }

  if (!hasPositiveExtrema) {
    if (gap === null) {
      return Object.assign(evidence, {
        rule: rule('R02', STATUS.NOT_APPLICABLE, { value: null, reason: 'history_coverage_unknown', threshold: multiple }),
        status: STATUS.NOT_APPLICABLE,
        reason: 'history_coverage_unknown',
      });
    }
    // 没有任何有效正 PB（应有日为 0 或全缺）
    if (expected !== null && expected === 0) {
      return Object.assign(evidence, {
        rule: rule('R02', STATUS.NOT_APPLICABLE, { value: null, reason: 'pb_window_empty', threshold: multiple }),
        status: STATUS.NOT_APPLICABLE,
        reason: 'pb_window_empty',
      });
    }
    return Object.assign(evidence, {
      rule: rule('R02', STATUS.PENDING, { value: null, reason: 'pb_series_unavailable', threshold: multiple }),
      status: STATUS.PENDING,
      reason: 'pb_series_unavailable',
    });
  }

  // 正证路径：max >= min × 3。用交叉比较，展示再求商。
  const bound = multiplyDecimal(minPbRaw, String(multiple));
  const passed = compareDecimal(maxPbRaw, bound) !== null && compareDecimal(maxPbRaw, bound) >= 0;

  // 日历未核验时，两种证据政策都不能给出正式结论：缺口里是否藏极值本身不可知（方案 27.5 第 1/5 条）。
  if (!calendarVerified) {
    return Object.assign(evidence, {
      rule: rule('R02', STATUS.NOT_APPLICABLE, { value: ratio, reason: 'history_calendar_unverified', threshold: multiple }),
      status: STATUS.NOT_APPLICABLE,
      reason: 'history_calendar_unverified',
    });
  }

  if (policy === 'strict_complete') {
    // 严格基线（27.5 零缺口）：historyComplete 才允许判 PASS/FAIL；
    // 有缺口一律不可评估，即使已观测极值已达标——这正是旧实现把 A01 判 PASS 的缺口（AC-03）。
    if (evidence.historyComplete !== true) {
      return Object.assign(evidence, {
        rule: rule('R02', STATUS.NOT_APPLICABLE, { value: ratio, reason: 'history_gap_not_evaluable', threshold: multiple }),
        status: STATUS.NOT_APPLICABLE,
        reason: 'history_gap_not_evaluable',
      });
    }
    if (passed) {
      return Object.assign(evidence, {
        rule: rule('R02', STATUS.PASS, { value: ratio, reason: null, threshold: multiple, evidence: 'strict_complete' }),
        status: STATUS.PASS,
        reason: null,
      });
    }
    return Object.assign(evidence, {
      rule: rule('R02', STATUS.FAIL, { value: ratio, reason: 'pb_extrema_below_multiple', threshold: multiple }),
      status: STATUS.FAIL,
      reason: 'pb_extrema_below_multiple',
    });
  }

  if (passed) {
    return Object.assign(evidence, {
      // 正证是数学下界，缺口不推翻它（方案 27.5 候选口径）。
      rule: rule('R02', STATUS.PASS, { value: ratio, reason: null, threshold: multiple, evidence: 'positive_extrema' }),
      status: STATUS.PASS,
      reason: null,
    });
  }
  // positive_evidence：比值不足且有缺口 → 未知（不能断言十年内没有三倍）；
  // 完整覆盖且比值不足 → 明确不符合。
  if (evidence.historyComplete === true) {
    return Object.assign(evidence, {
      rule: rule('R02', STATUS.FAIL, { value: ratio, reason: 'pb_extrema_below_multiple', threshold: multiple }),
      status: STATUS.FAIL,
      reason: 'pb_extrema_below_multiple',
    });
  }
  // 缺口已核实为源端不可恢复（窗口内缺失日**全部**被 governance 登记覆盖）→ 与 601528 的财报缺口
  // 同一口径（方案 27.5 第 6 条）：不入选、不进补数队列、不阻断整批发布。登记没覆盖到全部缺失日、
  // 或压根没登记的，仍走下面的待补——登记不是放行条（2026-11-08 生产实测 06963.HK 缺 2023-06 的 4 天）。
  if (gap !== null && gap > 0 && facts.pbGapSourceUnrecoverable === true) {
    return Object.assign(evidence, {
      rule: rule('R02', STATUS.NOT_APPLICABLE, { value: ratio, reason: 'pb_gap_source_unrecoverable', threshold: multiple }),
      status: STATUS.NOT_APPLICABLE,
      reason: 'pb_gap_source_unrecoverable',
    });
  }
  if (gap === null || gap > 0) {
    return Object.assign(evidence, {
      rule: rule('R02', STATUS.PENDING, { value: ratio, reason: 'pb_extrema_gap_pending', threshold: multiple }),
      status: STATUS.PENDING,
      reason: 'pb_extrema_gap_pending',
    });
  }
  return Object.assign(evidence, {
    rule: rule('R02', STATUS.FAIL, { value: ratio, reason: 'pb_extrema_below_multiple', threshold: multiple }),
    status: STATUS.FAIL,
    reason: 'pb_extrema_below_multiple',
  });
}

/* ------------------------------------------------------------------ *
 * 单只股票四项规则（V2）
 * ------------------------------------------------------------------ */

function evaluateInstrumentV2(facts, params = V2_PARAMS) {
  const p = Object.assign({}, V2_PARAMS, params || {});
  const ttmStatus = resolveTtmStatus(facts);
  const factsWithTtm = Object.assign({}, facts, { ttmStatus });
  const r01 = evaluateValuationV2(factsWithTtm, p);
  const r02 = evaluatePbExtremaV2(facts, p);
  // R04/R05 沿用基线合同（V1 实现即权威），不在此复制第二套。
  const r04 = V1.evaluateDividendYield(facts, p);
  const r05 = V1.evaluateEquity(facts, p);
  const rules = { R01: r01.rule, R02: r02.rule, R04: r04.rule, R05: r05.rule };
  const ruleStatus = worstStatus(RULE_CODES.map(code => rules[code].status));

  // 风险暂缓：可靠停牌证据 → 本轮 RISK，不执行依赖当日价的 R01（valuationStatus=null）。
  const risks = [];
  if (facts.suspended) risks.push({ code: 'suspended_at_target_date', detail: facts.suspensionReason || null });
  if (facts.delistedAtTargetDate) risks.push({ code: 'delisted_at_target_date' });
  if (facts.riskWarning) risks.push({ code: 'risk_warning_name', detail: facts.riskWarning });
  const riskHeld = risks.length > 0;
  const riskStatus = riskHeld ? STATUS.RISK : null;
  const filterStatus = riskHeld && ruleStatus !== STATUS.FAIL ? STATUS.RISK : ruleStatus;
  const valuationStatus = riskHeld && ruleStatus !== STATUS.FAIL ? null : r01.valuationStatus;

  const pe = num(facts.peTtmRaw === undefined ? facts.peTtm : facts.peTtmRaw);
  const peNegative = pe !== null && pe < 0;
  const ttmResolved = ttmStatus.status === 'profit' || ttmStatus.status === 'loss' || ttmStatus.status === 'zero';
  // 排名就绪：四项通过、无风险暂缓，且 TTM 口径已定（盈利股还必须有正 PE 才能进 PE 排名）。
  const rankBlockReasons = [];
  if (filterStatus === STATUS.PASS && !ttmResolved) {
    // PE 直接缺失时给更具体的"排名待补 PE(TTM)"，而不是笼统的"TTM 状态未知"。
    rankBlockReasons.push(pe === null ? 'pe_ttm_unavailable' : 'ttm_status_unknown');
  }
  if (filterStatus === STATUS.PASS && ttmResolved && ttmStatus.status === 'profit' && (pe === null || pe === 0)) {
    rankBlockReasons.push('pe_ttm_unavailable');
  }
  const rankReady = filterStatus === STATUS.PASS && rankBlockReasons.length === 0;

  const exclusionReasons = [];
  risks.forEach(risk => exclusionReasons.push(risk));
  RULE_CODES.forEach(code => {
    const r = rules[code];
    if (r.status === STATUS.FAIL || r.status === STATUS.PENDING) {
      exclusionReasons.push({ code: `${code}:${r.reason || r.status}`, rule: code, status: r.status });
    }
  });
  rankBlockReasons.forEach(reason => exclusionReasons.push({ code: `RANK:${reason}`, rule: 'RANK', status: STATUS.PENDING }));

  return {
    instrumentId: facts.instrumentId,
    companyId: facts.companyId || null,
    code: facts.code,
    name: facts.name || null,
    market: facts.market,
    industry: facts.industry || null,
    strategyCode: STRATEGY_CODE_V2,
    currentPb: r01.pb,
    pbPeProduct: r01.pbPeProduct,
    historicalPbMin: r02.minPb,
    historicalPbMax: r02.maxPb,
    pbPositiveExtremaRatio: r02.pbPositiveExtremaRatio,
    pbCoverage: {
      coveredDays: r02.coveredDays, expectedDays: r02.expectedDays, gapDays: r02.gapDays,
      observedDays: r02.observedDays, nonPositiveDays: r02.nonPositiveDays,
      invalidDays: r02.invalidDays, missingDays: r02.missingDays, exemptDays: r02.exemptDays,
      historyComplete: r02.historyComplete, historyYears: r02.historyYears,
      windowStart: r02.windowStart, windowEnd: r02.windowEnd,
      effectiveStart: r02.effectiveStart, listDate: r02.listDate,
      minPbDate: r02.minPbDate, maxPbDate: r02.maxPbDate,
      calendarComplete: r02.calendarComplete, policy: r02.policy, multiple: r02.multiple,
    },
    currentPe: pe,
    peNegative,
    // V2 的「盈利/亏损」分类一律用 TTM 口径，不再用最新年报状态替代。
    profitStatus: ttmStatus.status,
    ttmProfitStatus: ttmStatus.status,
    ttmStatusBasis: ttmStatus.basis,
    ttmEvidenceRef: ttmStatus.evidenceRef,
    ttmConflict: ttmStatus.conflict || null,
    valuationStatus,
    valuationPass: riskHeld && ruleStatus !== STATUS.FAIL ? null : r01.valuationPass,
    valuationPassReason: riskHeld && ruleStatus !== STATUS.FAIL ? null : r01.valuationPassReason,
    dividendYield: r04.yield,
    equityAmount: num((facts.equity || {}).amount),
    equityCurrency: (facts.equity || {}).currency || null,
    equityCny: r05.equityCny,
    fxRate: r05.fxRate,
    fxDate: r05.fxDate,
    rules,
    filterStatus,
    riskHeld,
    riskStatus,
    riskReasons: risks,
    rankReady,
    rankBlockReasons,
    dataQualityStatus: filterStatus === STATUS.PASS && rankReady ? 'complete' : 'partial',
    exclusionReasons,
    detail: {
      price: num(facts.price),
      priceDate: facts.priceDate || null,
      priceCurrency: facts.priceCurrency || null,
      valuationAsOf: facts.valuationAsOf || null,
      peTtm: pe,
      peStatic: num(facts.peStatic),
      pbPeProduct: r01.pbPeProduct,
      dividend: facts.dividend || null,
      annual: facts.annual || null,
      equity: facts.equity || null,
      pbWindow: {
        minPb: r02.minPb, maxPb: r02.maxPb, ratio: r02.pbPositiveExtremaRatio,
        coveredDays: r02.coveredDays, expectedDays: r02.expectedDays, gapDays: r02.gapDays,
        observedDays: r02.observedDays, nonPositiveDays: r02.nonPositiveDays,
        invalidDays: r02.invalidDays, missingDays: r02.missingDays, exemptDays: r02.exemptDays,
        historyComplete: r02.historyComplete, historyYears: r02.historyYears,
        windowStart: r02.windowStart, windowEnd: r02.windowEnd,
        effectiveStart: r02.effectiveStart, minPbDate: r02.minPbDate, maxPbDate: r02.maxPbDate,
        calendarComplete: r02.calendarComplete, policy: r02.policy, multiple: r02.multiple,
        pbSeriesHash: facts.pbSeriesHash || null,
      },
      ttm: {
        status: ttmStatus.status, basis: ttmStatus.basis,
        evidenceRef: ttmStatus.evidenceRef || null, conflict: ttmStatus.conflict || null,
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 排名（十进制，方案 27.4「全链路十进制合同」）
 * ------------------------------------------------------------------ */

/** 竞赛排名 1,2,2,4：并列占位、下一名次跳号；等值判定用十进制精确相等。 */
function competitionRankDecimal(items, valueOf, direction) {
  const ranked = items.map(item => ({ item, raw: valueOf(item) }))
    .filter(row => parseDecimal(row.raw) !== null);
  ranked.sort((a, b) => {
    const cmp = compareDecimal(a.raw, b.raw);
    if (cmp === 0) return 0;
    return direction === 'desc' ? -cmp : cmp;
  });
  const map = new Map();
  let lastRaw = null;
  let lastRank = 0;
  ranked.forEach((row, index) => {
    const same = lastRaw !== null && compareDecimal(row.raw, lastRaw) === 0;
    const rank = same ? lastRank : index + 1;
    map.set(row.item.instrumentId, rank);
    lastRaw = row.raw;
    lastRank = rank;
  });
  return { map, count: ranked.length };
}

/**
 * V2 排名：PB 升序、PE(TTM) 升序、股息率降序，三项竞赛名次求和。
 * 盈利/亏损分类用同一 TTM 口径：盈利且 PE>0 的进 PE 排名，其余（亏损/零利润/PE 缺失）统一记 P；
 * P=0 时统一记 N。负 PE 不参与升序，避免"负得越多越便宜"。
 */
function rankCandidatesV2(candidates) {
  const pool = candidates.filter(item => item.filterStatus === STATUS.PASS && item.rankReady !== false);
  const n = pool.length;
  const pbRank = competitionRankDecimal(pool, item => item.currentPb, 'asc');
  const dyRank = competitionRankDecimal(pool, item => item.dividendYield, 'desc');
  const profitPool = pool.filter(item => item.ttmProfitStatus === 'profit' && parseDecimal(item.currentPe) !== null
    && compareDecimal(item.currentPe, '0') > 0);
  const peRank = competitionRankDecimal(profitPool, item => item.currentPe, 'asc');
  const profitCount = profitPool.length;

  const ranked = pool.map(item => {
    const pe = item.ttmProfitStatus === 'profit' ? peRank.map.get(item.instrumentId) : undefined;
    const peRankValue = pe !== undefined ? pe : (profitCount > 0 ? profitCount : n);
    const pbRankValue = pbRank.map.get(item.instrumentId);
    const dyRankValue = dyRank.map.get(item.instrumentId);
    return Object.assign({}, item, {
      pbRank: pbRankValue === undefined ? null : pbRankValue,
      peRank: peRankValue,
      dividendRank: dyRankValue === undefined ? null : dyRankValue,
      totalScore: (pbRankValue || 0) + peRankValue + (dyRankValue || 0),
    });
  });

  // 总分并列 → PB 升序 → 股息率降序 → 标准代码字典序，稳定决胜后写 selection_order。
  ranked.sort((a, b) => {
    if (a.totalScore !== b.totalScore) return a.totalScore - b.totalScore;
    const pbCmp = compareDecimal(a.currentPb, b.currentPb);
    if (pbCmp !== null && pbCmp !== 0) return pbCmp;
    const dyCmp = compareDecimal(a.dividendYield, b.dividendYield);
    if (dyCmp !== null && dyCmp !== 0) return -dyCmp;
    return String(a.code).localeCompare(String(b.code));
  });
  ranked.forEach((item, index) => { item.selectionOrder = index + 1; });
  return { ranked, profitCount, poolSize: n, peRankFallback: profitCount === 0 ? n : null };
}

/* ------------------------------------------------------------------ *
 * 市场估值：V2 不设门槛
 * ------------------------------------------------------------------ */

/**
 * V2 取消指数 PB 配置门槛（2026-11-06 用户补正）：
 * 指数 PB/PE 只做可选市场环境展示，等于 2、大于 2、缺失或异常都不得关闭组合或阻断发布。
 * 保留 gate 结构只是为了兼容旧消费者，`status='not_required'` 与 `eligible=true` 表明"不适用"，
 * 不伪造指数 PB 数值绕过。
 */
function evaluateMarketGateV2(valuation) {
  const v = valuation || {};
  return {
    status: 'not_required',
    eligible: true,
    reason: null,
    applied: false,
    policyVersion: 'selection-market-gate-v2',
    tradeDate: v.tradeDate || null,
    valuationMethod: v.valuationMethod || null,
    benchmarkCode: v.benchmarkCode || null,
    pb: num(v.pb),
    pe: num(v.pe),
    displayOnly: true,
  };
}

/** 策略分派：服务只调这一个入口，不在各处散落 if (v2)。 */
function evaluateByStrategy(strategyCode, facts, params) {
  if (String(strategyCode || '').toLowerCase() === STRATEGY_CODE_V2) return evaluateInstrumentV2(facts, params);
  return V1.evaluateInstrument(facts, params);
}

module.exports = {
  STATUS,
  STRATEGY_CODE_V2,
  V2_PARAMS,
  PB_EXTREMA_POLICIES,
  RULE_CODES,
  parseDecimal,
  compareDecimal,
  multiplyDecimal,
  normalizeDecimalText,
  decimalToNumber,
  extremaRatio,
  resolveTtmStatus,
  evaluateValuationV2,
  evaluatePbExtremaV2,
  evaluateInstrumentV2,
  competitionRankDecimal,
  rankCandidatesV2,
  evaluateMarketGateV2,
  evaluateByStrategy,
  num,
};
