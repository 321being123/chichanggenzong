// 可转债周期：纯算法模块（不访问数据库/网络，便于单元测试）
// 口径：价格中位数 + 转股溢价率中位数 × 动态权重（20%～55%）
// 公式版本固定为 cycle-v1-135-55

const FORMULA_VERSION = 'cycle-v1-135-55';
const UNIVERSE_VERSION = 'cb-daily-v1';

const MIN_BONDS = 100;            // 有效价格样本下限
const MIN_COVERAGE = 0.9;         // 溢价率覆盖率下限
const LOOKBACK_DAYS = 1260;       // 滚动分位窗口（约 5 年有效交易日）
const MIN_PERCENTILE_DAYS = 252;  // 少于此天数不输出正式分位
const MAX_ROWS = 2000;            // 上游单日返回上限，视为可能截断

const BOND_CODE = /^(110|111|113|118|123|127|128)\d{3}(\.(SH|SZ))?$/;

function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round4(v) {
  if (v === null || v === undefined) return null;
  const n = toNumber(v);
  return n === null ? null : Math.round(n * 1e4) / 1e4;
}

function isConvertibleBondCode(tsCode) {
  return typeof tsCode === 'string' && BOND_CODE.test(tsCode.trim().toUpperCase());
}

// 中位数：忽略无效值；奇数取中值，偶数取中间两值平均；无有效值返回 null
function median(values) {
  const nums = (values || []).map(toNumber).filter(v => v !== null).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

// 动态权重：W = min(55%, max(20%, 20% + (P-100) × 1%))，返回 0～1 小数
function computeWeight(priceMedian) {
  const p = toNumber(priceMedian);
  if (p === null) return null;
  const raw = 0.20 + (p - 100) * 0.01;
  const clamped = Math.min(0.55, Math.max(0.20, raw));
  return Math.round(clamped * 1e6) / 1e6;
}

// 综合估值：S = P + R × W（R 为百分点，如 35 表示 35%；W 为 0～1 小数）
function computeComposite(priceMedian, premiumMedianPct, weight) {
  const p = toNumber(priceMedian);
  const r = toNumber(premiumMedianPct);
  const w = toNumber(weight);
  if (p === null || r === null || w === null) return null;
  return Math.round((p + r * w) * 1e4) / 1e4;
}

// 覆盖率 = 有效溢价率样本数 ÷ 有效价格样本数
function coverageRatio(premiumCount, priceCount) {
  if (!priceCount || priceCount <= 0) return null;
  return premiumCount / priceCount;
}

// 数据质量校验：返回 { ok, reason }
// premium_fields_missing / upstream_row_limit_reached 属于数据异常（当日不得标记成功），
// insufficient_bond_count / insufficient_coverage 属于市场客观状态（存事实、不发布指标）。
function validateDataQuality({ rowCount, bondCount, premiumCount, coverageRatio: cov }) {
  if (rowCount != null && rowCount >= MAX_ROWS) return { ok: false, reason: 'upstream_row_limit_reached' };
  if (bondCount != null && bondCount > 0 && premiumCount === 0) return { ok: false, reason: 'premium_fields_missing' };
  if (bondCount == null || bondCount < MIN_BONDS) return { ok: false, reason: 'insufficient_bond_count' };
  if (cov == null || cov < MIN_COVERAGE) return { ok: false, reason: 'insufficient_coverage' };
  return { ok: true, reason: null };
}

// 数据异常类原因（请求成功但内容异常）：当日不得写入事实、不得推进游标
const ANOMALY_REASONS = ['upstream_row_limit_reached', 'premium_fields_missing'];

// 历史分位：窗口含当前值；Q = (小于数 + 0.5×等于数) ÷ 窗口有效样本数 × 100
// 等于数包含当天自身（全部相等时结果为 50.0）；历史不足 MIN_PERCENTILE_DAYS 时返回 null
function computePercentile(currentValue, historyValues) {
  const cur = toNumber(currentValue);
  if (cur === null) return null;
  const prior = (historyValues || []).map(toNumber).filter(v => v !== null);
  const total = prior.length + 1;
  if (total < MIN_PERCENTILE_DAYS) return null;
  let less = 0, equal = 1; // equal 含当天自身
  for (const v of prior) {
    if (v < cur) less++;
    else if (Math.abs(v - cur) < 1e-9) equal++;
  }
  return Math.round(((less + 0.5 * equal) / total) * 100 * 10) / 10;
}

// 周期分档：低位 / 偏低 / 中位 / 偏高 / 高位
function cycleLevel(percentile) {
  const q = toNumber(percentile);
  if (q === null) return null;
  if (q < 20) return '低位';
  if (q < 40) return '偏低';
  if (q < 60) return '中位';
  if (q < 80) return '偏高';
  return '高位';
}

// 按方案 3.1 过滤样本：代码符合规则、close>0、按 ts_code 去重；溢价率样本额外要求 cb_value>0 且 cb_over_rate 有效
function filterSampleRows(rows) {
  const diag = {
    raw_row_count: rows ? rows.length : 0,
    deduped: 0,
    invalid_price: 0,
    missing_conversion_value: 0,
    missing_premium: 0,
    extreme_price: 0,
    extreme_premium: 0,
  };
  const byCode = new Map();
  for (const r of (rows || [])) {
    const code = r && r.ts_code;
    if (!isConvertibleBondCode(code)) continue;
    byCode.set(String(code).toUpperCase(), r); // 同 ts_code 保留最后一条
  }
  diag.deduped = byCode.size;

  const priceRows = [];
  const premiumRows = [];
  for (const r of byCode.values()) {
    const close = toNumber(r.close);
    if (close === null || close <= 0) { diag.invalid_price++; continue; }
    if (close > 500) diag.extreme_price++;
    priceRows.push(r);

    const conv = toNumber(r.cb_value);
    const prem = toNumber(r.cb_over_rate);
    if (conv === null || conv <= 0) { diag.missing_conversion_value++; }
    else if (prem === null) { diag.missing_premium++; }
    else {
      premiumRows.push(r);
      if (Math.abs(prem) > 200) diag.extreme_premium++;
    }
  }
  return { priceRows, premiumRows, diagnostics: diag };
}

// 聚合单日：返回 { metrics, quality }，不含历史分位（分位需结合历史，由 finalizeCycle 补）
function aggregateDaily({ rows, tradeDate, formulaVersion, universeVersion, sourceId }) {
  const { priceRows, premiumRows, diagnostics } = filterSampleRows(rows);
  const bondCount = priceRows.length;
  const premiumCount = premiumRows.length;
  const coverage = coverageRatio(premiumCount, bondCount);
  const medianPrice = round4(median(priceRows.map(r => r.close)));
  const medianConversionValue = round4(median(priceRows.map(r => r.cb_value)));
  const medianPremium = round4(median(premiumRows.map(r => r.cb_over_rate)));
  const weight = computeWeight(medianPrice);
  const composite = computeComposite(medianPrice, medianPremium, weight);
  const quality = validateDataQuality({
    rowCount: diagnostics.raw_row_count,
    bondCount,
    premiumCount,
    coverageRatio: coverage,
  });
  return {
    metrics: {
      trade_date: tradeDate,
      formula_version: formulaVersion || FORMULA_VERSION,
      universe_version: universeVersion || UNIVERSE_VERSION,
      bond_count: bondCount,
      premium_count: premiumCount,
      coverage_ratio: coverage,
      median_price: medianPrice,
      median_conversion_value: medianConversionValue,
      median_conversion_premium_pct: medianPremium,
      premium_weight: weight,
      composite_value: composite,
      diagnostics,
      source_id: sourceId,
    },
    quality,
  };
}

// 结合历史综合估值，补充分位与周期位置；priorComposites 为当前日之前的同版本有效综合估值数组
function finalizeCycle(aggregate, priorComposites) {
  const out = Object.assign({}, aggregate.metrics);
  const q = computePercentile(aggregate.metrics.composite_value, priorComposites);
  out.rolling_percentile = q;
  out.cycle_level = cycleLevel(q);
  return out;
}

module.exports = {
  FORMULA_VERSION,
  UNIVERSE_VERSION,
  MIN_BONDS,
  MIN_COVERAGE,
  LOOKBACK_DAYS,
  MIN_PERCENTILE_DAYS,
  MAX_ROWS,
  toNumber,
  isConvertibleBondCode,
  median,
  computeWeight,
  computeComposite,
  coverageRatio,
  validateDataQuality,
  ANOMALY_REASONS,
  computePercentile,
  cycleLevel,
  filterSampleRows,
  aggregateDaily,
  finalizeCycle,
};
