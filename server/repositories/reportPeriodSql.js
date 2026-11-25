// 财报报告期类型的 SQL 读取表达式（仓储层共享）。
// 官方标签可能落在 report_period_label / reportType / report_type_label 等字段；
// 中文别名与财年锚点推导在 server/domain/financialReportPeriod.js 的 JS 归一化中完成。
'use strict';

const LABEL_MAPPING = [
  ['annual_report', 'annual'], ['annual', 'annual'], ['annualreport', 'annual'],
  ['year_report', 'annual'], ['yearly', 'annual'], ['fy', 'annual'],
  ['semi_annual_report', 'semiannual'], ['semi_annual', 'semiannual'],
  ['semiannual_report', 'semiannual'], ['semiannual', 'semiannual'],
  ['semi-annual', 'semiannual'], ['interim_report', 'semiannual'], ['interim', 'semiannual'],
  ['half_year', 'semiannual'], ['half_year_report', 'semiannual'], ['half-year', 'semiannual'],
  ['second_quarterly_report', 'semiannual'], ['second_quarter', 'semiannual'], ['q2', 'semiannual'],
  ['first_quarterly_report', 'q1'], ['first_quarter', 'q1'], ['quarterly_report', 'q1'],
  ['quarterly', 'q1'], ['q1', 'q1'],
  ['third_quarterly_report', 'q3'], ['third_quarter', 'q3'], ['q3', 'q3'],
  ['fourth_quarterly_report', 'annual'], ['fourth_quarter', 'annual'], ['q4', 'annual'],
  ['年报', 'annual'], ['年度', 'annual'], ['年度报告', 'annual'],
  ['半年报', 'semiannual'], ['半年度', 'semiannual'], ['半年度报告', 'semiannual'],
  ['中报', 'semiannual'], ['中期', 'semiannual'], ['中期报告', 'semiannual'],
  ['一季报', 'q1'], ['一季度', 'q1'], ['第一季度', 'q1'], ['第一季度报告', 'q1'],
  ['三季报', 'q3'], ['三季度', 'q3'], ['第三季度', 'q3'], ['第三季度报告', 'q3'],
];

function reportPeriodLabelExpression(alias = 'r') {
  const column = `lower(COALESCE(NULLIF(${alias}.raw_payload->>'report_period_label',''),`
    + `NULLIF(${alias}.raw_payload->>'reportType',''),`
    + `NULLIF(${alias}.raw_payload->>'report_type_label',''),`
    + `NULLIF(${alias}.raw_payload->>'report_type',''),`
    + `NULLIF(${alias}.raw_payload->>'periodType',''),''))`;
  const whens = LABEL_MAPPING.map(([label, type]) => `WHEN '${label}' THEN '${type}'`).join(' ');
  return `CASE ${column} ${whens} END`;
}

/**
 * 声明类型优先，其次官方标签；不含财年锚点推导（由 JS 补足）。
 * period_type 为 'unknown' 或空时必须继续读在线标签，不能被原值提前短路。
 */
function reportPeriodTypeExpression(alias = 'r') {
  return `COALESCE(NULLIF(NULLIF(${alias}.period_type,'unknown'),''),`
    + `${reportPeriodLabelExpression(alias)},'unknown')`;
}

module.exports = { reportPeriodLabelExpression, reportPeriodTypeExpression };
