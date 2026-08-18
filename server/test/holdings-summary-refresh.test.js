const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const utils = fs.readFileSync(path.join(root, 'public', 'js', 'utils.js'), 'utf8');
const quote = fs.readFileSync(path.join(root, 'public', 'shared', 'core-quote.js'), 'utf8');
const returns = fs.readFileSync(path.join(root, 'public', 'shared', 'core-returns.js'), 'utf8');
const tables = fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8');
const context = {
  data: {
    hkRate: 0.9,
    cash: 200,
    authoritativeCash: 200,
    authoritativePositionValue: 800,
    authoritativeTotalAsset: 1000,
    totalAssetSource: 'system_calculated',
    positions: [
      { code: '600000', type: '股权', subtype: '沪市', price: 10, quantity: 50 },
      { code: '00700', type: '股权', subtype: '港股', price: 50, quantity: 10 }
    ]
  },
  console,
  document: { querySelector: function() { return null; } }
};
vm.createContext(context);
vm.runInContext(utils, context);

const before = context.getSystemPositionValue();
assert.strictEqual(before, 950, '刷新前系统持仓市值错误');
context.data.positions[0].price = 11;
context.data.positions[1].price = 52;
context.applyAuthoritativeMarketDelta(before);
assert.strictEqual(context.data.authoritativePositionValue, 1018, '导入次日起必须直接采用系统绝对持仓市值');
assert.strictEqual(context.data.authoritativeTotalAsset, 1218, '总资产必须等于系统持仓市值加权威现金');
assert.strictEqual(context.calcSummary().total, 1218, '页面汇总仍在使用导入时点差额');

context.data.totalAssetSource = 'broker_exact';
context.data.authoritativePositionValue = 800;
context.data.authoritativeTotalAsset = 1000;
context.applyAuthoritativeMarketDelta(1018);
assert.strictEqual(context.data.authoritativePositionValue, 800, '导入当天无新行情变化时必须保留券商持仓总值');

context.data = {
  hkRate: 0.9,
  cash: 200,
  positions: [{ type: '股权', subtype: '沪市', price: 10, quantity: 50 }]
};
assert.strictEqual(context.calcSummary().total, 700, '普通账户总资产必须等于实时持仓市值加现金');

const renderAt = quote.indexOf('renderAll();', quote.indexOf('async function refreshAllPrices'));
const saveAt = quote.indexOf("fetch(api('/api/positions/prices", renderAt);
const navAt = quote.indexOf('if (pricesSaved) await recordNav();', saveAt);
const attributionRenderAt = quote.indexOf("if (pricesSaved && typeof renderStats === 'function') renderStats();", navAt);
assert.ok(renderAt >= 0 && saveAt > renderAt, '行情到齐后应先刷新页面，再等待价格落库');
assert.ok(navAt > saveAt, '净值必须在新价格落库后记录');
assert.ok(attributionRenderAt > navAt, '净值归因返回后必须立即刷新总资产浮框');
assert.ok(quote.includes("Number(data.hkRate) > 0 ? Number(data.hkRate) : 0.868"), '汇率接口失败时必须保留账户上一份有效汇率');
assert.ok(returns.includes('data.navAttribution = _j2.data.navAttribution'), '记录净值后未同步最新导入口径归因');
assert.ok(tables.includes('导入口径切换差异') && tables.includes('importBasisAdjustment'), '涨跌浮框未展示首次口径切换差异');

console.log('holdings summary refresh tests passed');
