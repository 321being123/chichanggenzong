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

console.log('stock statements tests passed');
