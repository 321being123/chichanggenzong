const assert = require('assert');
const { mergeCalendarDays } = require('../routes/ipo');

const merged = mergeCalendarDays(
  [{ date: '2026-09-10', apply_stocks: [{ code: '600000', name: 'A股' }], list_stocks: [] }],
  [{ date: '2026-09-10', apply_stocks: [{ code: '00001.HK', name: '港股' }], list_stocks: [{ code: '00002.HK', name: '港股上市' }] }],
  [{ date: '2026-09-10', apply_bonds: [{ code: '123001', name: '转债' }], list_bonds: [] }],
);

assert.strictEqual(merged.length, 1);
assert.deepStrictEqual(merged[0].apply_stocks.map(item => item.code), ['600000', '00001.HK']);
assert.strictEqual(merged[0].list_stocks[0].code, '00002.HK');
assert.strictEqual(merged[0].apply_bonds[0].code, '123001');
console.log('ipo-calendar-merge.test.js passed');
