const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = {
  console,
  document: { getElementById: () => null, querySelector: () => null },
  escapeHtml: value => String(value),
  fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }),
  api: value => value,
  myProfile: null,
  isFinite,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/bond-safety.js'), 'utf8'), context);

assert.strictEqual(context.bondSafetyCell({ bond_price: 71.372 }, 'bond_price'), '71.37');
assert.strictEqual(context.bondSafetyCell({ convert_value: 88 }, 'convert_value'), '88.00');
assert.strictEqual(context.bondSafetyCell({ dividend_yield: 0 }, 'dividend_yield'), '0.00%');
assert.strictEqual(context.bondSafetyCell({ convert_premium: 20.126 }, 'convert_premium'), '20.13%');
assert.match(context.bondSafetyCell({ change_pct: 1.2 }, 'change_pct'), /bond-change-up.*\+1\.20%/);
assert.match(context.bondSafetyCell({ change_pct: -0.5 }, 'change_pct'), /bond-change-down.*-0\.50%/);
assert.strictEqual(context.bondSafetyCell({ pe_ttm: '亏损' }, 'pe_ttm'), '亏损');

console.log('PASS=7 FAIL=0');
