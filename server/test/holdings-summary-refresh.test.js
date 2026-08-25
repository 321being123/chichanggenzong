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
  window: {},
  document: { querySelector: function() { return null; }, addEventListener: function() {} }
};
vm.createContext(context);
vm.runInContext(utils, context);
vm.runInContext(tables, context);

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
assert.strictEqual(context.countTradingDaysBetween('2026-08-15', '2026-08-17'), 0, '周末不应被算作完整交易日');
assert.strictEqual(context.countTradingDaysBetween('2026-08-13', '2026-08-17'), 1, '周四到周一应识别中间的周五交易日');
assert.strictEqual(context.quoteDateCN('2026-08-24T15:00:00+08:00'), '2026-08-24', '行情日期必须按北京时间解析');
assert.strictEqual(context.isTradingDateCN('2026-08-22'), false, '页面不得在周末写入收盘价');
assert.ok(quote.includes('quoteDateCN(result.quote_time) === todayCN()'), '页面必须验证行情时间属于当天后才能写收盘价');
assert.ok(quote.includes('Array.from(validatedQuotes.entries())') && quote.includes('quote_time: quote.quote_time') && quote.includes('if (!response.ok) throw new Error'), '页面必须按代码去重后把行情时间交给服务端复核，且保存失败不得标记完成');
assert.ok(quote.includes('matchingPositions.forEach(function(position)'), '同一证券存在多条持仓时必须统一更新为同一份最新行情');
const incompleteTip = context.buildChangeTipHtml(100, 1, 0, 0, null, null, null, null, true);
assert.ok(incompleteTip.includes('归因不完整，未进行明细加总'), '归因不完整时必须明确提示未进行明细加总');
assert.ok(!incompleteTip.includes('合计 = 股价影响 + 汇率影响'), '归因不完整时不得伪装成明细已闭合');
const partialTip = context.buildChangeTipHtml(100, 1, null, null, null, null, null, null, true, ['404002'], 'missing_exact_price_or_fx');
assert.ok(partialTip.includes('404002') && partialTip.includes('—'), '归因不完整时必须显示缺失标的并以破折号表示未计算项');
const driftTip = context.buildChangeTipHtml(100, 1, 70, 20, 0, null, 10, null, false);
assert.ok(driftTip.includes('未归因差额') && driftTip.includes('合计 = 股价影响 + 汇率影响 + 其他变动 + 未归因差额'), '存在明显残差时必须在浮框中展示并纳入合计');

console.log('holdings summary refresh tests passed');
