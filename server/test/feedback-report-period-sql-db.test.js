// F-06 反例：period_type='unknown' + annual_report 的年度读取必须在真实 PostgreSQL 中返回 annual。
// 只连接隔离测试库（run-one/run-all 已把 PGDATABASE 指向 portfolio_test），不写业务库。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/connection');
const { reportPeriodTypeExpression } = require('../repositories/reportPeriodSql');

const ROOT = path.join(__dirname, '..', '..');

(async () => {
  try {
    const expression = reportPeriodTypeExpression('r');
    const { rows } = await pool.query(`
      SELECT r.label, ${expression} AS resolved
        FROM (VALUES
          ('annual_label', 'unknown', '{"report_period_label":"annual_report"}'::jsonb),
          ('semi_annual', 'unknown', '{"reportType":"semi_annual"}'::jsonb),
          ('no_label', 'unknown', '{}'::jsonb),
          ('q1_label', 'unknown', '{"report_period_label":"first_quarterly_report"}'::jsonb),
          ('q3_label', 'unknown', '{"report_period_label":"third_quarterly_report"}'::jsonb),
          ('declared_wins', 'annual', '{"report_period_label":"semi_annual"}'::jsonb),
          ('empty_declared', '', '{"reportType":"annual"}'::jsonb),
          ('null_declared', NULL, '{"report_period_label":"semiannual_report"}'::jsonb)
        ) AS r(label, period_type, raw_payload)`);
    const resolved = Object.fromEntries(rows.map((row) => [row.label, row.resolved]));
    assert.strictEqual(resolved.annual_label, 'annual', 'unknown + annual_report 必须识别为 annual');
    assert.strictEqual(resolved.semi_annual, 'semiannual', 'unknown + semi_annual 必须识别为 semiannual');
    assert.strictEqual(resolved.no_label, 'unknown', '无标签时必须回退 unknown');
    assert.strictEqual(resolved.q1_label, 'q1');
    assert.strictEqual(resolved.q3_label, 'q3');
    assert.strictEqual(resolved.declared_wins, 'annual', '声明类型优先于标签');
    assert.strictEqual(resolved.empty_declared, 'annual', '空声明类型必须继续读标签');
    assert.strictEqual(resolved.null_declared, 'semiannual', '空值声明类型必须继续读标签');

    // 年度估值、年度分红使用同一 SQL 表达式；最近报告与 TTM 的 JS 归一化读同一组标签。
    const repo = fs.readFileSync(path.join(ROOT, 'server', 'repositories', 'stockSelectionRepository.js'), 'utf8');
    const annualFilterUses = repo.match(/\$\{reportPeriodTypeExpression\('r'\)\} = 'annual'/g) || [];
    assert.strictEqual(annualFilterUses.length, 2, '年度利润/年度分红必须共用同一个报告期表达式');
    assert.ok(repo.includes("raw_payload->>'reportType' AS report_type"), '最近报告与 TTM 读端必须读取 reportType 别名');
    assert.ok(repo.includes("raw_payload->>'report_type_label' AS report_type_label"), '最近报告与 TTM 读端必须读取 report_type_label 别名');
    assert.ok(!/NULLIF\(r\.period_type,'unknown'\),NULLIF\(r\.period_type,''\)/.test(repo),
      '旧的 NULLIF 写法会提前返回 unknown，不得回退');

    const period = require('../domain/financialReportPeriod');
    assert.strictEqual(period.resolveFinancialPeriodType({ periodType: 'unknown', reportPeriodLabel: 'annual_report' }), 'annual');
    assert.strictEqual(period.resolveFinancialPeriodType({ periodType: 'unknown', rawPayload: { reportType: 'semi_annual' } }), 'semiannual');
    assert.strictEqual(period.resolveFinancialPeriodType({ periodType: 'unknown' }), 'unknown');
    console.log('feedback report period SQL: unknown + annual_report / semi_annual passed');
  } finally {
    await pool.end().catch(() => {});
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
