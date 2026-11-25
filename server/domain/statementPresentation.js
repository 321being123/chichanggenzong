'use strict';

// 三表展示元数据只依赖调用方传入的版本化科目元数据，不取数、不访问数据库。
const PRESENTATION_VERSION = '2026-11-23.1';
const CONFLICT_GROUP_PATH = '其他已披露科目';
// HKFRS 18 与财会〔2026〕11号会重构利润表的经营/投资/筹资分类；缺少明确列报版本时，不得启用依赖旧版列报分类的利润表父项。
const FORMAT_SENSITIVE_PARENTS = new Set(['ps.fe', 'ps.ivi', 'ps.noi', 'ps.noe']);

const PARENT_CODES = new Set([
  'bs.ta', 'bs.tca', 'bs.tnca', 'bs.tl', 'bs.tcl', 'bs.tncl', 'bs.toe', 'bs.tetoshopc', 'bs.cabwcb',
  'bs.nraar', 'bs.or', 'bs.i', 'bs.fa', 'bs.cip', 'bs.ia', 'bs.rade', 'bs.npaap', 'bs.oap', 'bs.bp', 'bs.ltap', 'bs.oei',
  'ps.toi', 'ps.oi', 'ps.toc', 'ps.tc', 'ps.op', 'ps.tp', 'ps.np', 'ps.fe', 'ps.ivi', 'ps.noi', 'ps.noe',
  'cfs.stciffoa', 'cfs.stcoffoa', 'cfs.ncffoa', 'cfs.niicdadfbaofi',
  'cfs.stcifia', 'cfs.stcoffia', 'cfs.ncffia',
  'cfs.stcifffa', 'cfs.stcofffa', 'cfs.ncfffa', 'cfs.niicace',
  'cfs.ncrfdossajvaou', 'cfs.ncpfbssajvaou', 'cfs.crfai', 'cfs.cpfdapdoi',
]);

const PARENT_HINTS = Object.freeze({
  'bs.tca': 'bs.ta', 'bs.tnca': 'bs.ta',
  'bs.c': 'bs.cabwcb', 'bs.bwcb': 'bs.cabwcb',
  'bs.tl': null, 'bs.tcl': 'bs.tl', 'bs.tncl': 'bs.tl',
  'bs.toe': null, 'bs.tetshaoehopc': 'bs.toe', 'bs.tetoshopc': 'bs.toe',
  'ps.oi': 'ps.toi', 'ps.toc': null, 'ps.op': null, 'ps.tp': null,
  'ps.oc': 'ps.toc', 'ps.ie': 'ps.toc', 'ps.face': 'ps.toc', 'ps.s': 'ps.toc',
  'ps.ce': 'ps.toc', 'ps.iiicr': 'ps.toc', 'ps.phdrfpip': 'ps.toc', 'ps.rie': 'ps.toc',
  'ps.tas': 'ps.toc', 'ps.se': 'ps.toc', 'ps.ae': 'ps.toc', 'ps.rade': 'ps.toc',
  'ps.ooe': 'ps.toc', 'ps.oail': 'ps.toc',
  // 净利润归属是净利润的分类维度；综合收益不属于利润总额的普通明细。
  'ps.npatshaoehopc': 'ps.np', 'ps.npatoshopc': 'ps.np', 'ps.npatmsh': 'ps.np',
  'ps.tci': null, 'ps.tciatshaoehopc': 'ps.tci', 'ps.tciatoshopc': 'ps.tci', 'ps.tciatmsh': 'ps.tci',
  'cfs.crfscapls': 'cfs.stciffoa', 'cfs.ndilaatc': 'cfs.stciffoa', 'cfs.niicdadfbaofi': 'cfs.stciffoa',
  'cfs.niibfcb': 'cfs.stciffoa', 'cfs.niipfofi': 'cfs.stciffoa', 'cfs.crfp': 'cfs.stciffoa',
  'cfs.niicd': 'cfs.niicdadfbaofi', 'cfs.niidfbaofi': 'cfs.niicdadfbaofi',
  'cfs.ncrfrib': 'cfs.stciffoa', 'cfs.niiphd': 'cfs.stciffoa', 'cfs.ndifahftp': 'cfs.stciffoa',
  'cfs.niipfbaofi': 'cfs.stciffoa', 'cfs.niifasurpaioa': 'cfs.stciffoa', 'cfs.crfifac': 'cfs.stciffoa',
  'cfs.ncrfstoa': 'cfs.stciffoa', 'cfs.crfwbot': 'cfs.stciffoa', 'cfs.crrtooa': 'cfs.stciffoa',
  'cfs.cpfpcarls': 'cfs.stcoffoa', 'cfs.niilaatc': 'cfs.stcoffoa', 'cfs.niibwcbbaofi': 'cfs.stcoffoa',
  'cfs.ndipfofi': 'cfs.stcoffoa', 'cfs.cpfc': 'cfs.stcoffoa', 'cfs.niipwbaofi': 'cfs.stcoffoa',
  'cfs.niifahursaioa': 'cfs.stcoffoa', 'cfs.cpfphd': 'cfs.stcoffoa', 'cfs.niifahftp': 'cfs.stcoffoa',
  'cfs.cpfifac': 'cfs.stcoffoa', 'cfs.cptofe': 'cfs.stcoffoa', 'cfs.cpft': 'cfs.stcoffoa',
  'cfs.cprtooa': 'cfs.stcoffoa',
  'cfs.crfrci': 'cfs.stcifia', 'cfs.crfii': 'cfs.stcifia', 'cfs.crfdofiaolta': 'cfs.stcifia',
  'cfs.crrtoia': 'cfs.stcifia',
  'cfs.cpfpfiaolta': 'cfs.stcoffia', 'cfs.cpfi': 'cfs.stcoffia',
  'cfs.niipl': 'cfs.stcoffia', 'cfs.cprtoia': 'cfs.stcoffia',
  'cfs.crfai': 'cfs.stcifffa', 'cfs.crfl': 'cfs.stcifffa',
  'cfs.crfib': 'cfs.stcifffa', 'cfs.crrtofa': 'cfs.stcifffa', 'cfs.cpfbrp': 'cfs.stcofffa',
  'cfs.cpfdapdoi': 'cfs.stcofffa', 'cfs.cprtofa': 'cfs.stcofffa',
  'cfs.ncffoa': null, 'cfs.ncffia': null, 'cfs.ncfffa': null, 'cfs.niicace': null,
});

// 仅对已取得同类型来源证据的“其中”关系启用父子树；未提供类型上下文时保持无父项，避免把一个类型的排列语义外推到其他类型。
const VERIFIED_RELATIONS = Object.freeze({
  'bs.nr': { parent: 'bs.nraar', contexts: ['CN|non_financial', 'HK|non_financial'] },
  'bs.ar': { parent: 'bs.nraar', contexts: ['CN|non_financial', 'HK|non_financial'] },
  'bs.ir': { parent: 'bs.or', contexts: ['CN|non_financial'] },
  'bs.dr': { parent: 'bs.or', contexts: ['CN|non_financial'] },
  'bs.i_dr': { parent: 'bs.i', contexts: ['CN|non_financial'] },
  'bs.dofa': { parent: 'bs.fa', contexts: ['CN|non_financial'] },
  'bs.es': { parent: 'bs.cip', contexts: ['CN|non_financial'] },
  'bs.ia_dr': { parent: 'bs.ia', contexts: ['CN|non_financial', 'CN|security'] },
  'bs.rade_dr': { parent: 'bs.rade', contexts: ['CN|non_financial'] },
  'bs.np': { parent: 'bs.npaap', contexts: ['CN|non_financial', 'HK|non_financial'] },
  'bs.ap': { parent: 'bs.npaap', contexts: ['CN|non_financial', 'HK|non_financial'] },
  'bs.intp': { parent: 'bs.oap', contexts: ['CN|non_financial'] },
  'bs.dp': { parent: 'bs.oap', contexts: ['CN|non_financial'] },
  'bs.psibp': { parent: 'bs.bp', contexts: ['CN|non_financial'] },
  'bs.pcsibp': { parent: 'bs.bp', contexts: ['CN|non_financial'] },
  'bs.sap': { parent: 'bs.ltap', contexts: ['CN|non_financial'] },
  'bs.psioei': { parent: 'bs.oei', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial', 'HK|non_financial', 'HK|other_financial'] },
  'bs.pcsioei': { parent: 'bs.oei', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial', 'HK|non_financial', 'HK|other_financial'] },
  'ps.ieife': { parent: 'ps.fe', contexts: ['CN|non_financial'] },
  'ps.iiife': { parent: 'ps.fe', contexts: ['CN|non_financial', 'HK|non_financial'] },
  'ps.iifaajv': { parent: 'ps.ivi', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
  'ps.iftdofamaac': { parent: 'ps.ivi', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
  'ps.ncadarg': { parent: 'ps.noi', contexts: ['CN|non_financial'] },
  'ps.ncadarl': { parent: 'ps.noe', contexts: ['CN|non_financial'] },
  'cfs.ncrfdossajvaou': { parent: 'cfs.stcifia', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
  'cfs.ncrfdossaou': { parent: 'cfs.ncrfdossajvaou', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
  'cfs.ncrfdoaajv': { parent: 'cfs.ncrfdossajvaou', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
  'cfs.ncpfbssajvaou': { parent: 'cfs.stcoffia', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
  'cfs.ncpfbssaou': { parent: 'cfs.ncpfbssajvaou', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
  'cfs.ncpfbajv': { parent: 'cfs.ncpfbssajvaou', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
  'cfs.crfamshibss': { parent: 'cfs.crfai', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
  'cfs.cpfdapomshpbss': { parent: 'cfs.cpfdapdoi', contexts: ['CN|non_financial', 'CN|insurance', 'CN|security', 'CN|other_financial'] },
});

const CASHFLOW_SECTIONS = Object.freeze({
  operating: new Set(['cfs.stciffoa', 'cfs.stcoffoa', 'cfs.ncffoa', ...Object.keys(PARENT_HINTS).filter(code => PARENT_HINTS[code] === 'cfs.stciffoa' || PARENT_HINTS[code] === 'cfs.stcoffoa')]),
  investing: new Set(['cfs.stcifia', 'cfs.stcoffia', 'cfs.ncffia', ...Object.keys(PARENT_HINTS).filter(code => PARENT_HINTS[code] === 'cfs.stcifia' || PARENT_HINTS[code] === 'cfs.stcoffia')]),
  financing: new Set(['cfs.stcifffa', 'cfs.stcofffa', 'cfs.ncfffa', ...Object.keys(PARENT_HINTS).filter(code => PARENT_HINTS[code] === 'cfs.stcifffa' || PARENT_HINTS[code] === 'cfs.stcofffa')]),
  netChange: new Set(['cfs.iocacedtfier', 'cfs.bocaceatpb', 'cfs.niicace', 'cfs.bocaceatpe']),
});

function measureType(metric) {
  if (metric.measure_type) return metric.measure_type;
  // These are amounts or liquidity multiples, despite the Chinese word “率”.
  if (metric.code === 'cfs.iocacedtfier') return 'currency';
  if (metric.code === 'bs.tca_tcl_r' || metric.code === 'bs.q_r') return 'multiple';
  const code = String(metric.code || '').toLowerCase();
  const text = `${code} ${metric.name}`.toLowerCase();
  if (/eps|per_share|每股/.test(text)) return 'per_share';
  if (/_r(?:$|_)/.test(code) || /margin|roe|roa|yield|率|比率|比例|占比|利差/.test(text)) return 'percent';
  if (/days|day|天数|周转天数/.test(text)) return 'days';
  if (/turnover|tor|倍数|倍/.test(text)) return 'multiple';
  if (/count|number|数量|股数|人数|户数/.test(text)) return 'count';
  return 'currency';
}

function sectionOf(metric, statement) {
  if (metric.source_section) return metric.source_section;
  const text = String(metric.name || '');
  if (statement === 'cashflow') {
    if (CASHFLOW_SECTIONS.operating.has(metric.code)) return '经营活动现金流';
    if (CASHFLOW_SECTIONS.investing.has(metric.code)) return '投资活动现金流';
    if (CASHFLOW_SECTIONS.financing.has(metric.code)) return '筹资活动现金流';
    if (CASHFLOW_SECTIONS.netChange.has(metric.code)) return '现金净变动';
    if (/经营|operating|ncffoa|niicace/.test(`${metric.code} ${text}`.toLowerCase())) return '经营活动现金流';
    if (/投资|investing|ncffia/.test(`${metric.code} ${text}`.toLowerCase())) return '投资活动现金流';
    if (/筹资|融资|financing|ncfffa/.test(`${metric.code} ${text}`.toLowerCase())) return '筹资活动现金流';
    return '现金流补充资料';
  }
  if (statement === 'income') {
    if (/收入|revenue|营业额/.test(text.toLowerCase())) return '营业收入';
    if (/成本|费用|cost|expense/.test(text.toLowerCase())) return '成本及费用';
    if (/利润|profit|收益|income/.test(text.toLowerCase())) return '利润形成';
    if (measureType(metric) === 'per_share') return '每股及补充指标';
    return '利润表其他项目';
  }
  if (/负债|liabil|应付|借款|债券|存款|准备金|税/.test(text.toLowerCase())) return '负债';
  if (/权益|equity|股本|资本|公积|留存|少数/.test(text.toLowerCase())) return '所有者权益';
  if (/资产|asset|现金|应收|存货|投资|物业|设备|商誉|无形|预付/.test(text.toLowerCase())) return '资产';
  return '资产负债表其他项目';
}

function unitOf(metric, currency) {
  const kind = measureType(metric);
  if (kind === 'per_share') return `${currency || '原币'}/股`;
  if (kind === 'percent') return '%';
  if (kind === 'days') return '天';
  if (kind === 'multiple') return '倍';
  if (kind === 'count') {
    if (/人数/.test(metric.name)) return '人';
    if (/户数/.test(metric.name)) return '户';
    if (/股数/.test(metric.name)) return '股';
    return '个';
  }
  return currency ? `${currency}·亿元` : '原币·亿元';
}

// A 股财报历史上没有写入 __statement_coverage，采集侧的公司行业分类是唯一可核验的类型依据。
// 只做保守映射：金融类行业按各自类型返回，其余视为非金融；行业缺失或多值一律不推断。
// 精确值之外再按关键词兜底（生产 2026-11-16 实测为 证券/银行/多元金融/保险 四种写法，
// 但分类标准可能带 Ⅰ/Ⅱ/Ⅲ 后缀或改写），认错方向只会更保守（金融类保持平级），不会错挂父子。
const INDUSTRY_TABLE_TYPES = Object.freeze({
  '银行': 'bank',
  '保险': 'insurance',
  '证券': 'security',
  '多元金融': 'other_financial',
  '信托': 'other_financial',
  '其他金融': 'other_financial',
});

const INDUSTRY_TABLE_PATTERNS = Object.freeze([
  [/银行/, 'bank'],
  [/保险/, 'insurance'],
  [/证券/, 'security'],
  [/金融|信托|期货|基金|租赁/, 'other_financial'],
]);

function inferTableTypeFromIndustry(market, industries) {
  if (String(market || '').toUpperCase() !== 'CN') return null;
  const list = [...new Set((Array.isArray(industries) ? industries : [])
    .map(item => String(item || '').trim()).filter(Boolean))];
  // 多值或缺值都说明依据不唯一，不能推断。
  if (list.length !== 1) return null;
  const industry = list[0];
  if (Object.prototype.hasOwnProperty.call(INDUSTRY_TABLE_TYPES, industry)) {
    return INDUSTRY_TABLE_TYPES[industry];
  }
  const matched = INDUSTRY_TABLE_PATTERNS.find(([pattern]) => pattern.test(industry));
  return matched ? matched[1] : 'non_financial';
}

function groupIdOf(groupPath) {
  return `group:${String(groupPath || CONFLICT_GROUP_PATH)}`;
}

function relationHintOf(metric) {
  const code = metric && metric.code;
  if (Object.prototype.hasOwnProperty.call(VERIFIED_RELATIONS, code)) {
    const relation = VERIFIED_RELATIONS[code];
    const contexts = Array.isArray(metric.relation_contexts) ? metric.relation_contexts.filter(Boolean) : [];
    // 没有类型上下文，或同一响应混有未核验类型时，明确阻断关系，不能回退到相邻字段猜测。
    return contexts.length && contexts.every(context => relation.contexts.includes(context)) ? relation.parent : null;
  }
  // 旧通用映射仅供现金流分区使用，没有逐类型证据时不能作为父子关系。
  return null;
}

function resolveRuleFromContexts(metric, statement) {
  const contextRules = Array.isArray(metric && metric.context_rules) ? metric.context_rules : null;
  if (!contextRules || !contextRules.length) {
    const fallbackSection = sectionOf(metric, statement);
    const parent = relationHintOf(metric);
    const rowRole = parent ? 'detail'
      : (metric && metric.source_heading ? 'subtotal' : (measureType(metric) === 'currency' ? 'line' : 'supplement'));
    return {
      group_path: fallbackSection,
      row_role: rowRole,
      parent_code: parent,
      evidence_status: parent ? 'source_verified' : 'unverified',
      relation_status: parent ? 'verified' : 'group_only',
      candidate_parent: null,
      rep_group: null,
      rule_version: null,
    };
  }

  const allHaveRule = contextRules.every(item => item && item.rule);
  const rules = contextRules.map(item => item && item.rule).filter(Boolean);
  const groupPaths = [...new Set(rules.map(rule => rule.group_path).filter(Boolean))];
  const firstRule = rules[0] || null;
  const hasBasisConflict = Boolean(metric && metric.has_basis_conflict)
    || contextRules.some(item => item && item.reason === 'basis_conflict');

  if (!allHaveRule) {
    // 含未知类型或未登记来源：阻断直接父子，仅当已知规则一致时保留安全分组，否则归入其他已披露科目或基础分组。
    const safeGroup = groupPaths.length === 1 ? groupPaths[0] : (groupPaths.length > 1 ? CONFLICT_GROUP_PATH : sectionOf(metric, statement));
    const safeRole = firstRule ? (firstRule.row_role === 'detail' ? 'line' : firstRule.row_role) : 'line';
    return {
      group_path: safeGroup,
      row_role: safeRole,
      parent_code: null,
      evidence_status: 'unverified',
      relation_status: groupPaths.length > 1 ? 'group_conflict' : (hasBasisConflict ? 'basis_conflict' : 'unverified_context'),
      candidate_parent: null,
      rep_group: firstRule && firstRule.rep_group === safeGroup ? safeGroup : null,
      rule_version: firstRule ? firstRule.rule_version : null,
    };
  }

  if (groupPaths.length !== 1) {
    const safeRole = firstRule && firstRule.row_role === 'detail' ? 'line' : (firstRule ? firstRule.row_role : 'line');
    return {
      group_path: CONFLICT_GROUP_PATH,
      row_role: safeRole,
      parent_code: null,
      evidence_status: 'conflict',
      relation_status: 'group_conflict',
      candidate_parent: null,
      rep_group: null,
      rule_version: firstRule ? firstRule.rule_version : null,
    };
  }

  const groupPath = groupPaths[0];
  const repGroup = rules.every(rule => rule.rep_group === groupPath) ? groupPath : null;
  const baseRole = firstRule.row_role || 'line';

  if (hasBasisConflict) {
    return {
      group_path: groupPath,
      row_role: baseRole === 'detail' ? 'line' : baseRole,
      parent_code: null,
      evidence_status: 'conflict',
      relation_status: 'basis_conflict',
      candidate_parent: null,
      rep_group: repGroup,
      rule_version: firstRule.rule_version,
    };
  }

  const allVerified = rules.every(rule => rule.evidence_status === 'source_verified' && rule.parent_code);
  const parentCodes = [...new Set(rules.map(rule => rule.parent_code).filter(Boolean))];
  const hasUnknownFormat = Boolean(metric && metric.has_unknown_format);

  if (allVerified && parentCodes.length === 1) {
    if (hasUnknownFormat && FORMAT_SENSITIVE_PARENTS.has(parentCodes[0])) {
      return {
        group_path: groupPath,
        row_role: baseRole === 'detail' ? 'line' : baseRole,
        parent_code: null,
        evidence_status: 'source_verified',
        relation_status: 'format_version_unverified',
        candidate_parent: null,
        rep_group: repGroup,
        rule_version: firstRule.rule_version,
      };
    }
    return {
      group_path: groupPath,
      row_role: baseRole,
      parent_code: parentCodes[0],
      evidence_status: 'source_verified',
      relation_status: 'verified',
      candidate_parent: null,
      rep_group: repGroup,
      rule_version: firstRule.rule_version,
    };
  }

  const statuses = [...new Set(rules.map(rule => rule.evidence_status))];
  let relationStatus = 'group_only';
  let candidateParent = null;
  if (rules.some(rule => rule.parent_code) && (!allVerified || parentCodes.length > 1)) {
    relationStatus = 'parent_conflict';
  } else if (statuses.length === 1 && statuses[0] === 'candidate') {
    relationStatus = 'candidate';
    candidateParent = firstRule.candidate_parent || null;
  } else if (statuses.length === 1 && statuses[0] === 'issuer_sample') {
    relationStatus = 'issuer_sample_unmatched';
    candidateParent = firstRule.candidate_parent || null;
  } else if (statuses.length === 1 && statuses[0] === 'undecided') {
    relationStatus = 'undecided';
  }

  return {
    group_path: groupPath,
    row_role: baseRole === 'detail' ? 'line' : baseRole,
    parent_code: null,
    evidence_status: statuses.length === 1 ? statuses[0] : 'mixed',
    relation_status: relationStatus,
    candidate_parent: candidateParent,
    rep_group: repGroup,
    rule_version: firstRule.rule_version,
  };
}

function presentationOf(metrics, statement, currency) {
  if (!Array.isArray(metrics)) throw new TypeError('三表展示需要受控科目元数据');
  const byCode = new Map(metrics.map(metric => [metric.code, metric]));
  const presented = metrics.map(metric => {
    const hintedParent = relationHintOf(metric);
    const parentCode = hintedParent;
    const parent = parentCode ? byCode.get(parentCode) || null : null;
    // 官方文档将“其中”“加”“减”等前缀与科目名称分开；保留原文，不据此猜测父科目。
    const sourcePrefix = String(metric.source_prefix || '').replace(/^#\s*/, '');
    const labelPrefix = /其中|备注|^加|^减/.test(sourcePrefix) ? sourcePrefix : '';
    return {
      code: metric.code,
      label: labelPrefix && !String(metric.name).startsWith(labelPrefix) ? `${labelPrefix}${metric.name}` : metric.name,
      source_label: metric.name,
      source_prefix: metric.source_prefix || null,
      section: sectionOf(metric, statement),
      parent: parent ? parent.code : null,
      level: 0,
      is_parent: metric.source_heading === true || PARENT_CODES.has(metric.code),
      measure_type: measureType(metric),
      unit: unitOf(metric, currency),
    };
  });
  const parentByCode = new Map(presented.map(item => [item.code, item.parent]));
  const depthOf = (code, trail = new Set()) => {
    if (!code || trail.has(code)) return 0;
    const parent = parentByCode.get(code);
    if (!parent || !byCode.has(parent)) return 0;
    const next = new Set(trail);
    next.add(code);
    return Math.min(8, depthOf(parent, next) + 1);
  };
  const parents = new Set([...PARENT_CODES, ...presented.map(item => item.parent).filter(Boolean)]);
  return presented.map(item => ({
    ...item,
    level: depthOf(item.code),
    is_parent: item.is_parent || parents.has(item.code),
  }));
}

// 按字典组序与父先于子生成新版 presentation 结构，不改写调用方传入的旧 fields 数组。
function buildStatementPresentation(visibleFields, { metrics = [], statement = 'balance', ruleVersion = null } = {}) {
  const metricByCode = new Map((Array.isArray(metrics) ? metrics : []).map((metric, index) => [metric.code, { metric, index }]));
  const visibleCodes = new Set(visibleFields.map(field => field.code));
  const resolvedFields = visibleFields.map((field, index) => {
    const entry = metricByCode.get(field.code);
    const metric = entry ? entry.metric : field;
    const resolved = resolveRuleFromContexts(metric, statement);
    const visibleParent = resolved.parent_code && visibleCodes.has(resolved.parent_code) ? resolved.parent_code : null;
    return {
      code: field.code,
      section: field.section,
      values: field.values,
      group_path: resolved.group_path,
      group_id: groupIdOf(resolved.group_path),
      row_role: visibleParent ? resolved.row_role : (resolved.row_role === 'detail' ? 'line' : resolved.row_role),
      parent: visibleParent,
      relation_status: resolved.relation_status,
      candidate_parent: resolved.candidate_parent,
      rep_group: resolved.rep_group,
      rule_version: resolved.rule_version,
      catalog_order: entry ? entry.index : index,
    };
  });
  const byCode = new Map(resolvedFields.map(field => [field.code, field]));
  const groupOrder = new Map();
  resolvedFields.forEach(field => {
    const gp = field.group_path || field.section || CONFLICT_GROUP_PATH;
    if (!groupOrder.has(gp)) {
      groupOrder.set(gp, gp === CONFLICT_GROUP_PATH ? Number.MAX_SAFE_INTEGER : groupOrder.size);
    }
  });

  // 保证同组连续、父先于子、组内其余字段保持原顺序。
  const orderedGroups = [...groupOrder.keys()].sort((a, b) => groupOrder.get(a) - groupOrder.get(b));
  const sortedFields = [];
  const emittedCodes = new Set();

  for (const groupPath of orderedGroups) {
    const groupFields = resolvedFields
      .filter(field => (field.group_path || field.section || CONFLICT_GROUP_PATH) === groupPath)
      .sort((a, b) => (a.catalog_order ?? 0) - (b.catalog_order ?? 0));
    const groupSet = new Set(groupFields.map(field => field.code));
    const childrenByParent = new Map();
    const roots = [];

    for (const field of groupFields) {
      const parentInGroup = field.parent && groupSet.has(field.parent) ? field.parent : null;
      if (parentInGroup) {
        if (!childrenByParent.has(parentInGroup)) childrenByParent.set(parentInGroup, []);
        childrenByParent.get(parentInGroup).push(field);
      } else {
        roots.push(field);
      }
    }

    const visit = (field, trail = new Set()) => {
      if (!field || emittedCodes.has(field.code) || trail.has(field.code)) return;
      emittedCodes.add(field.code);
      const nextTrail = new Set(trail);
      nextTrail.add(field.code);
      const children = childrenByParent.get(field.code) || [];
      const upgradedRole = children.length > 0 && field.row_role === 'line' ? 'subtotal' : (field.row_role || 'line');
      sortedFields.push({ ...field, row_role: upgradedRole });
      for (const child of children) visit(child, nextTrail);
    };

    for (const root of roots) visit(root);
    // 兜底：若存在环导致未遍历到的节点，打破环后按原序输出。
    for (const field of groupFields) {
      if (!emittedCodes.has(field.code)) visit({ ...field, parent: null });
    }
  }

  const topGroupCounts = new Map();
  for (const field of sortedFields) {
    const groupPath = field.group_path || field.section || CONFLICT_GROUP_PATH;
    const parts = groupPath.split(' › ');
    topGroupCounts.set(parts[0], (topGroupCounts.get(parts[0]) || 0) + 1);
  }

  const rows = [];
  const depthByCode = new Map();
  let currentTopGroup = null;
  let currentSubGroup = null;

  for (const field of sortedFields) {
    const groupPath = field.group_path || field.section || CONFLICT_GROUP_PATH;
    const parts = groupPath.split(' › ');
    const topGroup = parts[0];
    const subGroup = parts[1] || null;
    const hasAvailableValue = Array.isArray(field.values) && field.values.some(item => item && item.value != null);
    let isGroupRep = false;

    if (topGroup !== currentTopGroup) {
      currentTopGroup = topGroup;
      currentSubGroup = null;
      if (!subGroup && field.rep_group === topGroup && (hasAvailableValue || topGroupCounts.get(topGroup) === 1)) {
        isGroupRep = true;
      } else {
        rows.push({
          kind: 'section',
          row_role: 'section',
          group_id: groupIdOf(topGroup),
          label: topGroup,
          depth: 0,
        });
      }
    }

    if (subGroup && subGroup !== currentSubGroup) {
      currentSubGroup = subGroup;
      if (field.rep_group === groupPath && hasAvailableValue) {
        isGroupRep = true;
      } else {
        rows.push({
          kind: 'section',
          row_role: 'section',
          group_id: groupIdOf(groupPath),
          label: subGroup,
          depth: 1,
        });
      }
    }

    let depth = subGroup ? 2 : 1;
    if (isGroupRep) {
      depth = subGroup ? 1 : 0;
    } else if (field.parent && depthByCode.has(field.parent)) {
      const parentField = byCode.get(field.parent);
      if (parentField && (parentField.group_path || parentField.section) === groupPath) {
        depth = Math.min(8, depthByCode.get(field.parent) + 1);
      }
    }

    depthByCode.set(field.code, depth);
    rows.push({
      kind: 'field',
      code: field.code,
      row_role: field.row_role || 'line',
      group_id: field.group_id || groupIdOf(groupPath),
      parent_code: field.parent || null,
      depth,
      relation_status: field.relation_status || 'group_only',
      candidate_parent: field.candidate_parent || null,
      is_group_rep: isGroupRep,
    });
  }

  return {
    version: PRESENTATION_VERSION,
    rule_version: ruleVersion || (sortedFields.find(f => f.rule_version) || {}).rule_version || null,
    rows,
  };
}

// 过滤无值字段后重新计算深度，避免返回不可见的父项和错误缩进。
function rebaseVisibleHierarchy(fields) {
  const visible = new Map(fields.map(field => [field.code, field]));
  function depth(field, trail = new Set()) {
    if (!field.parent || !visible.has(field.parent) || trail.has(field.code)) return 0;
    const next = new Set(trail);
    next.add(field.code);
    return Math.min(8, depth(visible.get(field.parent), next) + 1);
  }
  return fields.map(field => ({
    ...field,
    parent: visible.has(field.parent) ? field.parent : null,
    level: depth(field),
  }));
}

function normalizeMetricValue(raw, metric, currency) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const kind = measureType(metric);
  if (kind === 'currency') return value / 1e8;
  if (kind === 'percent') return value * 100;
  return value;
}

module.exports = {
  PRESENTATION_VERSION,
  measureType,
  sectionOf,
  unitOf,
  groupIdOf,
  presentationOf,
  rebaseVisibleHierarchy,
  buildStatementPresentation,
  normalizeMetricValue,
  inferTableTypeFromIndustry,
};
