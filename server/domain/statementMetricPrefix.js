'use strict';

// 一份财报行只携带本表口径的科目、比较值与请求清单（INC-0054 第一阶段）。
//
// 背景：适配层原先把三表全量科目、三表全量比较值和全量请求清单复制给
// 利润表/资产负债表/现金流量表/指标四类行，一份报告被撑成四份近 10 KiB 的副本，
// 一天近 9.5 GiB。读端（stockStatementService、hkSecurityAnalysis）取字段状态与
// 原生比较值时都只查本行所属报表，按表裁剪不改变任何取值语义。
//
// 这份规则只写一处：适配层裁剪出值、仓储层合并历史值都调用它，
// 否则「新值窄、旧值宽」会让内容没变的报告永远判成有变化。
const KIND_PREFIX = { income: 'ps', balance: 'bs', cashflow: 'cfs' };

// 指标行没有自己的表：按它实际引用的科目保留（扣非净利润 ps、带息负债 bs）。
// m.* 是衍生指标，没有三表前缀，任何情况下都保留。
const INDICATOR_PREFIXES = ['ps', 'bs'];

const COMPARISON_BUCKETS = ['yoy', 'qoq', 'single', 'single_yoy', 'single_qoq'];

function statementPrefixOf(code) {
  const matched = /^(bs|ps|cfs)\./.exec(String(code == null ? '' : code));
  return matched ? matched[1] : '';
}

function allowedPrefixesOf(kind, extra) {
  const own = KIND_PREFIX[kind];
  if (own) return new Set([own]);
  if (extra && extra.size) return new Set(extra);
  return new Set(INDICATOR_PREFIXES);
}

// 单个科目代码是否属于本表口径：没有三表前缀的（m.* 衍生指标）任何情况下都保留。
// 存量行的覆盖清单同样要走这条判断，否则「存量宽、新采集窄」会让覆盖清单永远不收敛。
function keepCodeForAllowed(code, allowed) {
  const prefix = statementPrefixOf(code);
  return !prefix || allowed.has(prefix);
}

function trimMetricMap(metrics, allowed) {
  const out = {};
  for (const [code, value] of Object.entries(metrics || {})) {
    if (!keepCodeForAllowed(code, allowed)) continue;
    out[code] = value;
  }
  return out;
}

function trimComparisonBuckets(buckets, allowed) {
  const out = {};
  for (const [bucket, map] of Object.entries(buckets || {})) {
    if (!map || typeof map !== 'object') continue;
    const kept = trimMetricMap(map, allowed);
    if (Object.keys(kept).length) out[bucket] = kept;
  }
  return out;
}

// 原生比较值按桶合并：同一份报告分散在多批响应里，某批失败时不能覆盖已采到的旧比较值。
// 合并前先按本表前缀裁掉旧的全量宽值——不裁剪的话存量行永远比新采集宽，
// 「内容没变就跳过更新」对它永远不成立（每次重采都要重写整条 JSON 和索引）。
function mergeComparisonBuckets(previous, incoming, allowed) {
  const oldTrimmed = trimComparisonBuckets(previous, allowed);
  const newTrimmed = trimComparisonBuckets(incoming, allowed);
  const out = {};
  for (const bucket of COMPARISON_BUCKETS) {
    const merged = { ...(oldTrimmed[bucket] || {}), ...(newTrimmed[bucket] || {}) };
    if (Object.keys(merged).length) out[bucket] = merged;
  }
  return out;
}

module.exports = {
  KIND_PREFIX,
  INDICATOR_PREFIXES,
  COMPARISON_BUCKETS,
  statementPrefixOf,
  allowedPrefixesOf,
  keepCodeForAllowed,
  trimMetricMap,
  trimComparisonBuckets,
  mergeComparisonBuckets,
};
