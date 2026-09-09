const assert = require('assert');
const { parseLivermoreHistory, parseLivermoreCurrent, parseFutuIpoHtml, normalizeCode } = require('../services/hkIpoMarketSignals');
const { assessHkGreenshoe } = require('../routes/ipo');

const livermoreFixture = {
  data: {
    fields: ['stock_code', 'stock_name', 'over_subscribed_multiple', 'issue_date', 'actualquotation_price', 'actualquotation_change_rate'],
    list: [['03231', '优地机器人', 139.02, '2026-09-09', 29.86, 106.64]],
  },
};
const parsed = parseLivermoreHistory(livermoreFixture);
assert.strictEqual(parsed[0].securityCode, '03231.HK');
assert.strictEqual(parsed[0].subscriptionMultiple, 139.02);
assert.strictEqual(parsed[0].greyMarketChangePct, 106.64);
assert.strictEqual(parseLivermoreCurrent(livermoreFixture).length, 1);
assert.strictEqual(normalizeCode('700'), '00700.HK');

const futuFixture = '<a class="list-item"><span title="03231" class="ellipsis code">03231</span><span title="优地机器人" class="ellipsis name">优地机器人</span><span title="+105.54%" class="value ellipsis value-darkChangeRatio direct-up">+105.54%</span><span title="2026/09/09" class="value value-listingDate">2026/09/09</span></a>';
const futu = parseFutuIpoHtml(futuFixture);
assert.strictEqual(futu[0].securityCode, '03231.HK');
assert.strictEqual(futu[0].greyMarketChangePct, 105.54);
assert.strictEqual(assessHkGreenshoe({ status: 'exercised' }, null), '偏利好：有稳价安排');
assert.strictEqual(assessHkGreenshoe({ status: 'not_available' }, null), '偏不利：缺少绿鞋保护');
assert.strictEqual(assessHkGreenshoe({ status: 'not_disclosed' }, null), '待确认');

console.log('OK hk-ipo-market-signals: 申购倍数、暗盘解析和绿鞋判断通过');
