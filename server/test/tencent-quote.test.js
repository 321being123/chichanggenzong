const assert = require('assert');
const { toTsCode } = require('../services/market');
const { describeTencentCode, isConvertibleBondCode, parseQuoteTime, parseTencentQuoteText, quoteLookupKeys } = require('../services/tencentQuote');
const { evaluateBondSafety } = require('../services/bondSafety');

const fields = Array(33).fill('');
fields[1] = '示例转债';
fields[2] = '128044';
fields[3] = '101.234';
fields[30] = '20260717145959';
fields[32] = '1.25';
const parsed = parseTencentQuoteText(`v_sz128044="${fields.join('~')}";`);
const bjFields = fields.slice();
bjFields[1] = '万达轴承';
bjFields[2] = '920002';
const parsedBj = parseTencentQuoteText(`v_bj920002="${bjFields.join('~')}";`);

assert.strictEqual(toTsCode('128044'), '128044.SZ', '12x 深市转债必须映射到 .SZ');
assert.strictEqual(toTsCode('113575'), '113575.SH', '11x 沪市转债必须映射到 .SH');
assert.strictEqual(describeTencentCode('128044').symbol, 'sz128044');
assert.strictEqual(describeTencentCode('113575.SH').symbol, 'sh113575');
assert.strictEqual(describeTencentCode('SH128044').symbol, 'sh128044', '显式市场前缀优先于代码推断');
assert.strictEqual(describeTencentCode('920002').symbol, 'bj920002', '北交所裸代码必须映射到 bj');
assert.strictEqual(describeTencentCode('920002.BJ').symbol, 'bj920002', '北交所后缀必须被识别');
assert.strictEqual(describeTencentCode('BJ920002').symbol, 'bj920002', '北交所前缀必须被识别');
assert.deepStrictEqual(quoteLookupKeys(describeTencentCode('00751.HK')), ['00751', '00751.HK']);
assert.strictEqual(isConvertibleBondCode('128044'), true);
assert.strictEqual(parsed.get('sz128044').price, 101.234);
assert.strictEqual(parsed.get('sz128044').change, 1.25);
assert.strictEqual(parsed.get('sz128044').quote_time, '2026-07-17T14:59:59+08:00');
assert.strictEqual(parsedBj.get('bj920002').market, 'bj');
assert.strictEqual(parsedBj.get('bj920002').code, '920002');
assert.strictEqual(parseQuoteTime('2026/07/17 16:08:19'), '2026-07-17T16:08:19+08:00');

const result = evaluateBondSafety([], [{
  bond_code: '128044', bond_name: '示例转债', stock_name: '示例公司',
  convert_update_date: '2026-01-01', bond_price: 101.234,
}]);
assert.strictEqual(Object.hasOwn(result.data[0], 'convert_update_date'), false, '输出表格数据不再包含最近转股更新日');

console.log('PASS=16 FAIL=0');
