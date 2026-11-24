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
    const makeRows = (rev49) => {
      const out = [];
      let id = 1000;
      for (let year = 2025; year >= 2005; year--) {
        for (const [md, pt] of [['12-31', 'annual'], ['09-30', 'q3'], ['06-30', 'semiannual'], ['03-31', 'q1']]) {
          for (const scope of ['consolidated', 'parent']) {
            const idx = out.length;
            out.push({
              report_id: id--,
              company_id: 9,
              period_end: `${year}-${md}`,
              period_type: pt,
              currency_code: 'HKD',
              source_currency: 'HKD',
              accounting_standard: 'HKFRS',
              source_id: 30,
              source_code: 'lixinger_official',
              source_version: idx === 48 ? `v-${rev49}` : 'v-1',
              statement_revision: idx === 48 ? `2026-11-24T0${rev49}:00:00.000000` : '2026-11-24T00:00:00.000000',
              update_flag: null,
              comp_type: '1',
              statement_scope: scope,
              announced_at: `${year}-12-31`,
              bs_ta: idx === 48 ? (rev49 === 1 ? 100 : 200) : 240,
              statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['bs.ta'], returned_metric_codes: ['bs.ta'], complete: true },
            });
          }
        }
      }
      return out;
    };
    let revision = 1;
    let queryCount = 0;
    repo.listStatementRows = async ({ limit }) => {
      queryCount++;
      const rows = makeRows(revision);
      return limit == null ? rows : rows.slice(0, limit);
    };
    const v1 = await service.getStockStatementVersions({ tsCode: '00001.HK', market: 'HK' });
    queryCount = 0;
    const sAnnual = await service.getStockStatements({
      tsCode: '00001.HK', market: 'HK', type: 'balance', periodType: 'annual', scope: 'consolidated', compare: 'yoy', limit: 20, requestedVersion: v1.balance,
    });
    assert.strictEqual(queryCount, 1, 'getStockStatements 必须单次快照读取，避免两路读取不一致');
    assert.strictEqual(sAnnual.analysis_version, v1.balance, '详情版本与三表版本必须一致');
    assert.strictEqual(sAnnual.fields[0].values.filter(v => v.yoy !== null).length, 20, '年报+合并口径+近20期应全部20/20算出同比');

    const sQuarterQoq = await service.getStockStatements({
      tsCode: '00001.HK', market: 'HK', type: 'balance', periodType: 'quarter', scope: 'consolidated', compare: 'qoq', limit: 20, requestedVersion: v1.balance,
    });
    assert.strictEqual(sQuarterQoq.fields[0].values.filter(v => v.change !== null).length, 20, '季报+合并口径+近20期应全部20/20算出环比');

    revision = 2;
    const v2 = await service.getStockStatementVersions({ tsCode: '00001.HK', market: 'HK' });
    assert.notStrictEqual(v2.balance, v1.balance, '修订第49条报告后版本摘要必须变化');
    await assert.rejects(
      () => service.getStockStatements({ tsCode: '00001.HK', market: 'HK', type: 'balance', periodType: 'annual', scope: 'consolidated', limit: 20, requestedVersion: v1.balance }),
      (err) => err && err.status === 409,
      '第49条报告修订后携带旧版本必须返回 409'
    );
  } finally {
    repo.listStatementRows = origList;
  }
  console.log('stock statements tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
