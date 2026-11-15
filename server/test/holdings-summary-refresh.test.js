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

// 统一估值：刷新链路必须是「取行情 → 整批重读服务端 → 记录净值 → 重绘」，浏览器不再提交持仓价。
const reloadAt = quote.indexOf('await loadData(currentAccount)', quote.indexOf('async function refreshAllPrices'));
const navAt = quote.indexOf('await recordNav()', reloadAt);
const renderAt = quote.indexOf('renderAll();', navAt);
const attributionRenderAt = quote.indexOf('renderStats();', navAt);
assert.ok(reloadAt >= 0, '刷新后必须整批重读服务端统一估值');
assert.ok(!quote.includes('window.holdingsQuoteApi.savePrices('), '浏览器不得再提交持仓价格');
assert.ok(navAt > reloadAt, '净值必须在服务端估值返回后记录');
assert.ok(renderAt > navAt && attributionRenderAt > navAt, '净值归因返回后必须立即重绘总资产');
assert.ok(quote.includes("Number(data.hkRate) > 0 ? Number(data.hkRate) : 0.868"), '汇率接口失败时必须保留账户上一份有效汇率');
assert.ok(returns.includes('data.navAttribution = _j2.data.navAttribution'), '记录净值后未同步最新导入口径归因');
assert.ok(tables.includes('导入口径切换差异') && tables.includes('importBasisAdjustment'), '涨跌浮框未展示首次口径切换差异');
assert.strictEqual(context.countTradingDaysBetween('2026-08-15', '2026-08-17'), 0, '周末不应被算作完整交易日');
assert.strictEqual(context.countTradingDaysBetween('2026-08-13', '2026-08-17'), 1, '周四到周一应识别中间的周五交易日');
assert.strictEqual(context.quoteDateCN('2026-08-24T15:00:00+08:00'), '2026-08-24', '行情日期必须按北京时间解析');
assert.strictEqual(context.isTradingDateCN('2026-08-22'), false, '页面不得在周末写入收盘价');
assert.ok(tables.includes('liveAttribution.complete === true') && tables.includes('liveAttribution.currentDate === todayCN()'),
  '今日涨跌应按服务端跨市场归因状态判断');
assert.ok(quote.includes('marketOpenToday && quoteIsToday'), '只有该证券所属市场今天开市且报价属于当日时才显示涨跌');
assert.ok(quote.includes('var quoteDate = quoteDateCN(result.quote_time)') && quote.includes('var quoteIsToday = quoteDate === today'), '页面必须验证行情时间属于当天后才能写收盘价');
assert.ok(quote.includes('fetchQuoteBatch') && quote.includes('retryCodes'), '持仓刷新必须使用有界批量重试');
assert.ok(!quote.includes('return await fetchQuote(c, true)'), '持仓批量失败后不得退化成逐只行情请求');
assert.ok(!quote.includes('syncIndexPoints().catch(function(){});'), '持仓刷新不得在浏览器侧同步外部指数行情');
assert.ok(!returns.includes('/api/kline') && !returns.includes('fetchIndexKline'), '收益图缺失指数快照时不得在页面侧回源外部行情');
assert.ok(!quote.includes('saveDailyPricesToDB') && !quote.includes("holdingsQuoteApi.saveDailyPrices"), '浏览器不得再写收盘价：收盘事实只能由服务端收盘任务落库');
assert.ok(quote.includes('await loadData(currentAccount)') && quote.includes('renderAll()'), '刷新成功后必须整批重读服务端统一估值结果，不再保留浏览器自算资产');
assert.ok(quote.includes('validatedPriceQuotes.set(c,'), '同一证券多条持仓只记录一份行情（按代码去重）');
assert.ok(!quote.includes('position.price = price'), '浏览器不得再改写持仓价：同批价格由服务端统一返回');
const incompleteTip = context.buildChangeTipHtml(100, 1, 0, 0, null, null, null, null, true);
assert.ok(incompleteTip.includes('归因不完整，未进行明细加总'), '归因不完整时必须明确提示未进行明细加总');
assert.ok(!incompleteTip.includes('合计 = 股价影响 + 汇率影响'), '归因不完整时不得伪装成明细已闭合');
const partialTip = context.buildChangeTipHtml(100, 1, null, null, null, null, null, null, true, ['404002'], 'missing_exact_price_or_fx');
assert.ok(partialTip.includes('404002') && partialTip.includes('—'), '归因不完整时必须显示缺失标的并以破折号表示未计算项');
const driftTip = context.buildChangeTipHtml(100, 1, 70, 20, 0, null, 10, null, false);
assert.ok(driftTip.includes('未归因差额') && driftTip.includes('合计 = 股价影响 + 汇率影响 + 其他变动 + 未归因差额'), '存在明显残差时必须在浮框中展示并纳入合计');
const incompleteValuationTip = context.buildChangeTipHtml(102, 1, 180, 22, 0, null, 0, null, false, [], null, { complete: false, missingCount: 2 });
assert.ok(incompleteValuationTip.includes('当前估值不完整') && incompleteValuationTip.includes('2 只证券'), '价格证据不足时必须显式说明缺失范围，而不是用校准金额凑平');
assert.ok(!incompleteValuationTip.includes('休市行情校准'), '统一估值后不得再出现休市行情校准项');
const completeValuationTip = context.buildChangeTipHtml(102, 1, 180, 22, 0, null, 0, null, false, [], null, { complete: true, missingCount: 0 });
assert.ok(!completeValuationTip.includes('当前估值不完整'), '估值完整时不得提示缺失');

const summaryElements = new Map();
const statsContainer = { innerHTML: '', querySelector: () => null };
context.document.getElementById = id => {
  if (id === 'stats-container') return statsContainer;
  if (!summaryElements.has(id)) summaryElements.set(id, {
    textContent: '', innerHTML: '', style: {}, removeAttribute() {},
  });
  return summaryElements.get(id);
};
context.todayCN = () => '2026-09-28';
context.bindChangeTip = () => {};
context.data = {
  cash: 4002,
  positions: [],
  navHistory: [
    { date: '2026-09-23', totalAsset: 400 },
    { date: '2026-09-24', totalAsset: 400 },
  ],
  navAttribution: {
    complete: false, reason: 'missing_intermediate_snapshot',
    currentDate: '2026-09-28', missingMarketDate: '2026-09-25', missingMarket: 'HK',
  },
};
context.renderStats();
assert.strictEqual(summaryElements.get('stat-change').textContent, '-',
  '港股开市中间日缺少快照时页面不得按 A 股日历显示多日变化');
context.data.navAttribution = {
  complete: true, currentDate: '2026-09-28', totalChange: 20, previousTotalAsset: 3982,
};
context.renderStats();
assert.ok(summaryElements.get('stat-change').innerHTML.includes('20.00'),
  '页面应直接展示完整的服务端跨市场归因变化');

context.todayCN = () => '2026-10-11';
context.marketStateSnapshot = { businessDate: '2026-10-11', markets: {
  CN: { businessDate: '2026-10-11', status: 'closed' },
  HK: { businessDate: '2026-10-11', status: 'closed' },
} };
context.data.positions = [{ code: '600000', subtype: '沪市', quantity: 1 }, { code: '00700', subtype: '港股', quantity: 1 }];
context.data.navAttribution = { complete: false, currentDate: '2026-10-11' };
const beforeClosedRender = JSON.stringify(context.data);
context.renderStats();
assert.strictEqual(summaryElements.get('stat-change').textContent, '-', '休市缺少完整归因仍为缺失');
assert.strictEqual(summaryElements.get('stat-change').onclick, null, '休市展示零不绑定缺失归因浮框');
assert.strictEqual(JSON.stringify(context.data), beforeClosedRender, '休市展示不得改写资产或归因');
for (const status of ['open', 'unknown']) {
  context.marketStateSnapshot.markets.HK.status = status;
  context.renderStats();
  assert.strictEqual(summaryElements.get('stat-change').textContent, '-', '部分开市或日历未知不得补零');
}
context.marketStateSnapshot.markets.HK.status = 'closed';
context.marketStateSnapshot.businessDate = '2026-10-10';
context.renderStats();
assert.strictEqual(summaryElements.get('stat-change').textContent, '-', '旧日期状态不得补零');
context.marketStateSnapshot.businessDate = '2026-10-11';
context.data.positions.push({ subtype: '美股', quantity: 1 });
context.renderStats();
assert.strictEqual(summaryElements.get('stat-change').textContent, '-', '未支持的市场不能套用CN休市');
context.data.positions = [];
context.renderStats();
assert.strictEqual(summaryElements.get('stat-change').textContent, '-', '纯现金账户缺少归因也不能猜0');
context.data.navAttribution = { complete: true, currentDate: '2026-10-11', totalChange: 12, previousTotalAsset: 3990 };
context.renderStats();
assert.ok(summaryElements.get('stat-change').innerHTML.includes('12.00'), '非交易日汇率等真实收益不能清零');
context.data.navAttribution.totalChange = 0;
context.renderStats();
assert.strictEqual(summaryElements.get('stat-change').innerHTML, '<span data-style="color:#d93025;">0</span>', '当日真实金额为0才显示红色0');
context.data.navAttribution.totalChange = null;
context.renderStats();
assert.strictEqual(summaryElements.get('stat-change').textContent, '-', '空金额不得转成0');
context.data.navAttribution.totalChange = -12;
context.renderStats();
assert.ok(summaryElements.get('stat-change').innerHTML.includes('#137333') && summaryElements.get('stat-change').innerHTML.includes('12.00'), '休市负汇率差照常绿色');
context.data.navAttribution.totalChange = 12;
context.marketStateSnapshot.markets.CN.status = 'open';
context.renderStats();
assert.ok(summaryElements.get('stat-change').innerHTML.includes('12.00'), '交易日完整归因正常展示');

console.log('holdings summary refresh tests passed');
