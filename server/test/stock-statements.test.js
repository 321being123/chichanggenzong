const assert = require('assert');
const { STATEMENTS } = require('../services/stockStatements');

assert.deepStrictEqual(Object.keys(STATEMENTS), ['balance','income','cashflow']);
assert.ok(STATEMENTS.balance.fields.some(([code]) => code === 'total_assets'));
assert.ok(STATEMENTS.income.fields.some(([code]) => code === 'n_income_attr_p'));
assert.ok(STATEMENTS.cashflow.fields.some(([code]) => code === 'n_cashflow_act'));
assert.ok(STATEMENTS.balance.fields.length > 20, '资产负债表展示字段不足');
assert.ok(STATEMENTS.balance.sections.length >= 8, '资产负债表未区分资产、负债和所有者权益');
assert.ok(STATEMENTS.income.sections.length >= 5, '利润表未区分收入、成本和利润');
assert.ok(STATEMENTS.cashflow.sections.length >= 5, '现金流量表未区分经营、投资和筹资活动');
const receivableParent = STATEMENTS.balance.fields.find(([code]) => code === 'accounts_receiv_bill');
const receivableChildren = STATEMENTS.balance.fields.filter(([, , , , parent]) => parent === 'accounts_receiv_bill');
assert.ok(receivableParent && receivableChildren.some(([code]) => code === 'notes_receiv') && receivableChildren.some(([code]) => code === 'accounts_receiv'), '应收票据及应收账款父子关系不完整');

(async () => {
  const repo = require('../repositories/stockStatementsRepository');
  const service = require('../services/stockStatementService');
  const origList = repo.listStatementRows;
  try {
    const makeRows = (rev21) => Array.from({ length: 24 }, (_, idx) => {
      const year = 2025 - Math.floor(idx / 4);
      const q = idx % 4;
      const ends = ['12-31', '09-30', '06-30', '03-31'];
      const types = ['annual', 'q3', 'semiannual', 'q1'];
      return {
        report_id: 100 - idx,
        company_id: 9,
        period_end: `${year}-${ends[q]}`,
        period_type: types[q],
        currency_code: 'HKD',
        source_currency: 'HKD',
        accounting_standard: 'HKFRS',
        source_id: 30,
        source_code: 'lixinger_official',
        source_version: idx === 20 ? `v-${rev21}` : 'v-1',
        statement_revision: idx === 20 ? `2026-11-24T0${rev21}:00:00.000000` : '2026-11-24T00:00:00.000000',
        update_flag: null,
        comp_type: '1',
        statement_scope: 'consolidated',
        announced_at: `${year}-12-31`,
        bs_ta: idx === 20 ? (rev21 === 1 ? 100 : 200) : 240,
        statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['bs.ta'], returned_metric_codes: ['bs.ta'], complete: true },
      };
    });
    let revision = 1;
    let capturedLimits = [];
    repo.listStatementRows = async ({ limit }) => {
      capturedLimits.push(limit);
      return makeRows(revision).slice(0, limit);
    };
    const v1 = await service.getStockStatementVersions({ tsCode: '00001.HK', market: 'HK' });
    const s1 = await service.getStockStatements({ tsCode: '00001.HK', market: 'HK', type: 'balance', limit: 20, requestedVersion: v1.balance });
    assert.strictEqual(s1.analysis_version, v1.balance, '详情版本与三表版本必须一致');
    assert.ok(capturedLimits.includes(48), '版本与基期池应覆盖超过 20 条的历史报告');

    revision = 2;
    const v2 = await service.getStockStatementVersions({ tsCode: '00001.HK', market: 'HK' });
    assert.notStrictEqual(v2.balance, v1.balance, '修订第 21 条报告后版本摘要必须变化');
    await assert.rejects(
      () => service.getStockStatements({ tsCode: '00001.HK', market: 'HK', type: 'balance', limit: 20, requestedVersion: v1.balance }),
      (err) => err && err.status === 409,
      '第 21 条报告修订后携带旧版本必须返回 409'
    );
  } finally {
    repo.listStatementRows = origList;
  }
  console.log('stock statements tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
