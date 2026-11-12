'use strict';

// 三表展示元数据只依赖调用方传入的版本化科目元数据，不取数、不访问数据库。

const PARENT_CODES = new Set([
  'bs.ta', 'bs.tca', 'bs.tnca', 'bs.tl', 'bs.tcl', 'bs.tncl', 'bs.toe', 'bs.tetoshopc',
  'ps.toi', 'ps.oi', 'ps.toc', 'ps.tc', 'ps.op', 'ps.tp', 'ps.npatoshopc',
  'cfs.stciffoa', 'cfs.stcoffoa', 'cfs.ncffoa',
  'cfs.stcifia', 'cfs.stcoffia', 'cfs.ncffia',
  'cfs.stcifffa', 'cfs.stcofffa', 'cfs.ncfffa', 'cfs.niicace',
]);

const PARENT_HINTS = Object.freeze({
  'bs.tca': 'bs.ta', 'bs.tnca': 'bs.ta',
  'bs.tl': null, 'bs.tcl': 'bs.tl', 'bs.tncl': 'bs.tl',
  'bs.toe': null, 'bs.tetshaoehopc': 'bs.toe', 'bs.tetoshopc': 'bs.toe',
  'ps.oi': 'ps.toi', 'ps.toc': null, 'ps.op': null, 'ps.tp': null,
  'ps.oc': 'ps.toc', 'ps.ie': 'ps.toc', 'ps.face': 'ps.toc', 'ps.s': 'ps.toc',
  'ps.ce': 'ps.toc', 'ps.iiicr': 'ps.toc', 'ps.phdrfpip': 'ps.toc', 'ps.rie': 'ps.toc',
  'ps.tas': 'ps.toc', 'ps.se': 'ps.toc', 'ps.ae': 'ps.toc', 'ps.rade': 'ps.toc',
  'ps.crade': 'ps.toc', 'ps.fe': 'ps.toc', 'ps.ooe': 'ps.toc', 'ps.cilor': 'ps.toc',
  'ps.ailor': 'ps.toc', 'ps.oail': 'ps.toc',
  'ps.npatshaoehopc': 'ps.tp', 'ps.npatoshopc': 'ps.tp', 'ps.npatmsh': 'ps.tp',
  'ps.tci': 'ps.tp', 'ps.tciatshaoehopc': 'ps.tci', 'ps.tciatoshopc': 'ps.tci', 'ps.tciatmsh': 'ps.tci',
  'cfs.crfscapls': 'cfs.stciffoa', 'cfs.ndilaatc': 'cfs.stciffoa', 'cfs.niicdadfbaofi': 'cfs.stciffoa',
  'cfs.niibfcb': 'cfs.stciffoa', 'cfs.niipfofi': 'cfs.stciffoa', 'cfs.crfp': 'cfs.stciffoa',
  'cfs.ncrfrib': 'cfs.stciffoa', 'cfs.niiphd': 'cfs.stciffoa', 'cfs.ndifahftp': 'cfs.stciffoa',
  'cfs.niipfbaofi': 'cfs.stciffoa', 'cfs.niifasurpaioa': 'cfs.stciffoa', 'cfs.crfifac': 'cfs.stciffoa',
  'cfs.ncrfstoa': 'cfs.stciffoa', 'cfs.crfwbot': 'cfs.stciffoa', 'cfs.crrtooa': 'cfs.stciffoa',
  'cfs.cpfpcarls': 'cfs.stcoffoa', 'cfs.niilaatc': 'cfs.stcoffoa', 'cfs.niibwcbbaofi': 'cfs.stcoffoa',
  'cfs.ndipfofi': 'cfs.stcoffoa', 'cfs.cpfc': 'cfs.stcoffoa', 'cfs.niipwbaofi': 'cfs.stcoffoa',
  'cfs.niifahursaioa': 'cfs.stcoffoa', 'cfs.cpfphd': 'cfs.stcoffoa', 'cfs.niifahftp': 'cfs.stcoffoa',
  'cfs.cpfifac': 'cfs.stcoffoa', 'cfs.cptofe': 'cfs.stcoffoa', 'cfs.cpft': 'cfs.stcoffoa',
  'cfs.cprtooa': 'cfs.stcoffoa',
  'cfs.crfrci': 'cfs.stcifia', 'cfs.crfii': 'cfs.stcifia', 'cfs.crfdofiaolta': 'cfs.stcifia',
  'cfs.ncrfdossajvaou': 'cfs.stcifia', 'cfs.ncrfdossaou': 'cfs.stcifia', 'cfs.ncrfdoaajv': 'cfs.stcifia',
  'cfs.crrtoia': 'cfs.stcifia', 'cfs.cpfpfiaolta': 'cfs.stcoffia', 'cfs.cpfi': 'cfs.stcoffia',
  'cfs.niipl': 'cfs.stcoffia', 'cfs.ncpfbssajvaou': 'cfs.stcoffia', 'cfs.ncpfbssaou': 'cfs.stcoffia',
  'cfs.ncpfbajv': 'cfs.stcoffia', 'cfs.cprtoia': 'cfs.stcoffia',
  'cfs.crfai': 'cfs.stcifffa', 'cfs.crfamshibss': 'cfs.stcifffa', 'cfs.crfl': 'cfs.stcifffa',
  'cfs.crfib': 'cfs.stcifffa', 'cfs.crrtofa': 'cfs.stcifffa', 'cfs.cpfbrp': 'cfs.stcofffa',
  'cfs.cpfdapdoi': 'cfs.stcofffa', 'cfs.cpfdapomshpbss': 'cfs.stcofffa', 'cfs.cprtofa': 'cfs.stcofffa',
  'cfs.ncffoa': null, 'cfs.ncffia': null, 'cfs.ncfffa': null, 'cfs.niicace': null,
});

const CASHFLOW_SECTIONS = Object.freeze({
  operating: new Set(['cfs.stciffoa', 'cfs.stcoffoa', 'cfs.ncffoa', ...Object.keys(PARENT_HINTS).filter(code => PARENT_HINTS[code] === 'cfs.stciffoa' || PARENT_HINTS[code] === 'cfs.stcoffoa')]),
  investing: new Set(['cfs.stcifia', 'cfs.stcoffia', 'cfs.ncffia', ...Object.keys(PARENT_HINTS).filter(code => PARENT_HINTS[code] === 'cfs.stcifia' || PARENT_HINTS[code] === 'cfs.stcoffia')]),
  financing: new Set(['cfs.stcifffa', 'cfs.stcofffa', 'cfs.ncfffa', ...Object.keys(PARENT_HINTS).filter(code => PARENT_HINTS[code] === 'cfs.stcifffa' || PARENT_HINTS[code] === 'cfs.stcofffa')]),
  netChange: new Set(['cfs.iocacedtfier', 'cfs.bocaceatpb', 'cfs.niicace', 'cfs.bocaceatpe']),
});

function measureType(metric) {
  const text = `${metric.code} ${metric.name}`.toLowerCase();
  if (/eps|per_share|每股/.test(text)) return 'per_share';
  if (/_r(?:$|_)|margin|roe|roa|yield|率|比率/.test(text)) return 'percent';
  if (/days|day|天数|周转天数/.test(text)) return 'days';
  if (/turnover|tor|倍数|倍/.test(text)) return 'multiple';
  if (/count|number|数量|股数/.test(text)) return 'count';
  return 'currency';
}

function sectionOf(metric, statement) {
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
  if (kind === 'count') return '个';
  return currency ? `${currency}·亿元` : '原币·亿元';
}

function presentationOf(metrics, statement, currency) {
  if (!Array.isArray(metrics)) throw new TypeError('三表展示需要受控科目元数据');
  const parents = new Set(metrics.filter(metric => PARENT_CODES.has(metric.code)).map(metric => metric.code));
  return metrics.map(metric => {
    const child = /其中|其中：|其中:/.test(String(metric.name || ''));
    const hintedParent = Object.prototype.hasOwnProperty.call(PARENT_HINTS, metric.code) ? PARENT_HINTS[metric.code] : null;
    const parent = hintedParent
      ? metrics.find(candidate => candidate.code === hintedParent) || null
      : (child ? metrics.find(candidate => candidate !== metric && sectionOf(candidate, statement) === sectionOf(metric, statement) && PARENT_CODES.has(candidate.code)) : null);
    return {
      code: metric.code,
      label: metric.name,
      source_label: metric.name,
      section: sectionOf(metric, statement),
      level: parent ? 1 : 0,
      parent: parent ? parent.code : null,
      is_parent: parents.has(metric.code),
      measure_type: measureType(metric),
      unit: unitOf(metric, currency),
    };
  });
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

module.exports = { measureType, sectionOf, unitOf, presentationOf, normalizeMetricValue };
