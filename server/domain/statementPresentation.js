'use strict';

// 三表展示元数据只依赖调用方传入的版本化科目元数据，不取数、不访问数据库。

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

module.exports = { measureType, sectionOf, unitOf, presentationOf, rebaseVisibleHierarchy, normalizeMetricValue, inferTableTypeFromIndustry };
