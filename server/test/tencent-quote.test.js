const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { toTsCode } = require('../services/market');
const { describeTencentCode, isConvertibleBondCode, isFundEtfCode, parseQuoteTime, parseTencentQuoteText, quoteLookupKeys } = require('../services/tencentQuote');
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
assert.strictEqual(toTsCode('160719'), '160719.SZ', '16 开头 LOF 必须映射到深市');
assert.strictEqual(toTsCode('161226'), '161226.SZ', '16 开头 LOF 必须映射到深市');
assert.strictEqual(toTsCode('511880'), '511880.SH', '51 开头 ETF 必须映射到沪市');
assert.strictEqual(toTsCode('180101'), '180101.SZ', '180 开头 REITs 必须映射到深市');
assert.strictEqual(toTsCode('181001'), '181001.SZ', '181 开头商业不动产 REITs 必须映射到深市');
assert.strictEqual(toTsCode('520500'), '520500.SH', '52 开头 ETF 必须映射到沪市');
assert.strictEqual(toTsCode('189500'), '189500.SZ', '1895 开头深市跨境债必须映射到深市');
assert.strictEqual(describeTencentCode('128044').symbol, 'sz128044');
assert.strictEqual(describeTencentCode('113575.SH').symbol, 'sh113575');
assert.strictEqual(describeTencentCode('SH128044').symbol, 'sh128044', '显式市场前缀优先于代码推断');
assert.strictEqual(describeTencentCode('920002').symbol, 'bj920002', '北交所裸代码必须映射到 bj');
assert.strictEqual(describeTencentCode('920002.BJ').symbol, 'bj920002', '北交所后缀必须被识别');
assert.strictEqual(describeTencentCode('BJ920002').symbol, 'bj920002', '北交所前缀必须被识别');
assert.deepStrictEqual(quoteLookupKeys(describeTencentCode('00751.HK')), ['00751', '00751.HK']);
assert.strictEqual(isConvertibleBondCode('128044'), true);
assert.strictEqual(isFundEtfCode('160719'), true);
assert.strictEqual(isFundEtfCode('511880'), true);
assert.strictEqual(isFundEtfCode('180101'), true);
assert.strictEqual(isFundEtfCode('181001'), true);
assert.strictEqual(isFundEtfCode('520500'), true);
assert.strictEqual(isFundEtfCode('600519'), false);

const marketServiceSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'market.js'), 'utf8');
const marketRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'market.js'), 'utf8');
assert.ok(marketServiceSource.includes('fetchTencentQuotes(stockCodes.concat(fundCodes, bondCodes, hkCodes))'), '批量行情应统一调用腾讯实时行情');
assert.ok(marketServiceSource.includes('async function fetchQuotesByCodes'), '行情服务必须提供统一批量入口');
assert.ok(marketRouteSource.includes('fetchQuotesByCodes(codes)'), '行情路由必须调用统一批量入口');
assert.ok(!marketRouteSource.includes('ensureTsRealtime(stockCodes)'), '页面批量行情不得调用 Tushare rt_min');
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

console.log('PASS=22 FAIL=0');
