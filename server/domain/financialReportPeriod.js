// 财报报告期类型归一化（唯一实现）。
//
// 背景（2026-11-25 线上反馈 #102）：港股财报由理杏仁官方接口落库，`reportType` 缺失或使用了
// 未登记的别名时会被写成 `period_type='unknown'`，股票筛选只认 annual/semiannual/q1/q3，
// 于是已经公告的 2026 中报被整条过滤掉，页面回落成 2025 年报。
//
// 规则边界：
// - 优先使用官方报告类型标签（含中英文/连字符/下划线别名）；
// - 标签缺失时，只用**同公司已明确标注为 annual 的财报期末**推导财年锚点，
//   再按「财年末 −3/−6/−9 个月」识别 q3/半年/q1。财年可以不是 12-31（3/6/7 月结束都常见）；
// - 锚点互相冲突（同公司存在多个不同财年末且结论不一致）时不猜，保持 unknown；
// - 绝不只按自然月份猜报告期类型。

const KNOWN_PERIOD_TYPES = new Set(['annual', 'semiannual', 'q1', 'q3']);

const PERIOD_TYPE_ALIASES = Object.freeze({
  annual: 'annual',
  annual_report: 'annual',
  annualreport: 'annual',
  year: 'annual',
  year_report: 'annual',
  yearly: 'annual',
  fy: 'annual',
  a: 'annual',
  q4: 'annual',
  fourth_quarter: 'annual',
  fourth_quarterly_report: 'annual',
  年报: 'annual',
  年度: 'annual',
  年度报告: 'annual',
  semiannual: 'semiannual',
  semiannual_report: 'semiannual',
  semi_annual: 'semiannual',
  semi_annual_report: 'semiannual',
  semi: 'semiannual',
  interim: 'semiannual',
  interim_report: 'semiannual',
  half: 'semiannual',
  half_year: 'semiannual',
  half_year_report: 'semiannual',
  h1: 'semiannual',
  q2: 'semiannual',
  second_quarter: 'semiannual',
  second_quarterly_report: 'semiannual',
  半年报: 'semiannual',
  半年度: 'semiannual',
  半年度报告: 'semiannual',
  中报: 'semiannual',
  中期: 'semiannual',
  中期报告: 'semiannual',
  q1: 'q1',
  first_quarter: 'q1',
  first_quarterly_report: 'q1',
  quarter: 'q1',
  quarterly: 'q1',
  quarterly_report: 'q1',
  一季报: 'q1',
  一季度: 'q1',
  第一季度: 'q1',
  第一季度报告: 'q1',
  q3: 'q3',
  third_quarter: 'q3',
  third_quarterly_report: 'q3',
  三季报: 'q3',
  三季度: 'q3',
  第三季度: 'q3',
  第三季度报告: 'q3',
});

function normalizeFinancialPeriodType(value) {
  let text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text || text === 'unknown' || text === 'other') return null;
  if (KNOWN_PERIOD_TYPES.has(text)) return text;
  // 中英文标签统一：空格/连字符转下划线；中文去掉「报告」后缀后再查表。
  text = text.replace(/[\s-]+/g, '_').replace(/_+/g, '_');
  if (PERIOD_TYPE_ALIASES[text]) return PERIOD_TYPE_ALIASES[text];
  const chinese = text.replace(/_/g, '');
  if (PERIOD_TYPE_ALIASES[chinese]) return PERIOD_TYPE_ALIASES[chinese];
  if (chinese.endsWith('报告')) {
    const stripped = chinese.slice(0, -2);
    if (PERIOD_TYPE_ALIASES[stripped]) return PERIOD_TYPE_ALIASES[stripped];
  }
  return null;
}

function parseYmd(value) {
  const text = String(value == null ? '' : value).replace(/-/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function formatYmd(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function anchorDate(year, month, day) {
  return formatYmd(year, month, Math.min(day, lastDayOfMonth(year, month)));
}

// 从财年期末向前推整数月；日期按目标月最后一天截断（2/29 → 2/28）。
// 财年期末本身是月末（如 6-30 / 12-31）时，推移后也保持月末，避免把 12-31 算成 12-30。
function addMonths(ymd, delta) {
  const parsed = typeof ymd === 'string' ? parseYmd(ymd) : ymd;
  if (!parsed) return null;
  const total = parsed.year * 12 + (parsed.month - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12 + 12) % 12 + 1;
  const monthEnd = parsed.day === lastDayOfMonth(parsed.year, parsed.month);
  const day = monthEnd ? lastDayOfMonth(year, month) : parsed.day;
  return formatYmd(year, month, Math.min(day, lastDayOfMonth(year, month)));
}

/** 从已确认为 annual 的期末提取财年锚点（月-日），按最近年份优先去重。 */
function fiscalYearEndAnchors(rows) {
  const seen = new Set();
  const anchors = [];
  (rows || [])
    .filter(row => row && normalizeFinancialPeriodType(row.periodType) === 'annual')
    .map(row => ({ periodEnd: String(row.periodEnd || '').slice(0, 10), parsed: parseYmd(row.periodEnd) }))
    .filter(row => row.parsed)
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))
    .forEach(row => {
      const key = `${row.parsed.month}-${row.parsed.day}`;
      if (seen.has(key)) return;
      seen.add(key);
      anchors.push({ month: row.parsed.month, day: row.parsed.day });
    });
  return anchors;
}

/**
 * 用财年锚点识别报告期。只有精确命中「财年末」「财年末 −3/6/9 个月」才返回类型；
 * 多个锚点给出不同结论时保持 null（不猜）。
 */
function inferFinancialPeriodType(periodEnd, anchors) {
  const parsed = parseYmd(periodEnd);
  if (!parsed || !Array.isArray(anchors) || !anchors.length) return null;
  const target = formatYmd(parsed.year, parsed.month, parsed.day);
  const matches = new Set();
  for (const anchor of anchors) {
    const month = Number(anchor && anchor.month);
    const day = Number(anchor && anchor.day);
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) continue;
    for (const year of [parsed.year - 1, parsed.year, parsed.year + 1]) {
      const fyEnd = anchorDate(year, month, day);
      if (target === fyEnd) matches.add('annual');
      else if (target === addMonths(fyEnd, -6)) matches.add('semiannual');
      else if (target === addMonths(fyEnd, -3)) matches.add('q3');
      else if (target === addMonths(fyEnd, -9)) matches.add('q1');
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

/**
 * 统一解析：声明类型 → 官方标签（行字段或 raw_payload）→ 同公司财年锚点。
 * 仍无法判断时返回 'unknown'，由调用方决定是否过滤。
 */
function resolveFinancialPeriodType({ periodType, periodEnd, reportPeriodLabel, rawPayload, anchors } = {}) {
  const declared = normalizeFinancialPeriodType(periodType);
  if (declared) return declared;
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  for (const label of [reportPeriodLabel, payload.report_period_label, payload.reportType, payload.report_type_label, payload.periodType]) {
    const normalized = normalizeFinancialPeriodType(label);
    if (normalized) return normalized;
  }
  return inferFinancialPeriodType(periodEnd, anchors) || 'unknown';
}

module.exports = {
  KNOWN_PERIOD_TYPES,
  PERIOD_TYPE_ALIASES,
  normalizeFinancialPeriodType,
  fiscalYearEndAnchors,
  inferFinancialPeriodType,
  resolveFinancialPeriodType,
  addMonths,
};
