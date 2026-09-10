const assert = require('assert');
const { parseLivermoreHistory, parseLivermoreCurrent, parseVbkrCurrent, parseFutuIpoHtml, normalizeCode, isOfferOpen, isCurrentSubscriptionRecord } = require('../services/hkIpoMarketSignals');
const { assessHkGreenshoe } = require('../routes/ipo');
const { isVerifiedAllotmentDocument, isUsableProspectusDocument, cancellationTitleLooksLikeIpo } = require('../services/hkexIpo');

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
assert.strictEqual(parsed[0].offerCloseDate, null);
assert.strictEqual(parseLivermoreCurrent(livermoreFixture).length, 1);
assert.strictEqual(parseLivermoreCurrent({ code: 2, msg_cn: '请升级您的APP' }).length, 0);
assert.strictEqual(parseLivermoreHistory({ data: { fields: ['stock_code', 'expiration_date'], list: [['03231', '2026-09-12']] } })[0].offerCloseDate, '2026-09-12');
assert.strictEqual(normalizeCode('700'), '00700.HK');
const vbkr = parseVbkrCurrent({ success: true, code: '00000', data: { applying: [{ ipoInfo: { securityCode: '03231.HK', securityNameTc: '優地機器人', applyRate: '12.50', applyEndTime: '2026-09-12 09:30:00' } }] } });
assert.strictEqual(vbkr.length, 1);
assert.strictEqual(vbkr[0].securityCode, '03231.HK');
assert.strictEqual(vbkr[0].subscriptionMultiple, 12.5);
assert.strictEqual(vbkr[0].offerCloseDate, '2026-09-12');
assert.strictEqual(parseVbkrCurrent({ success: true, code: '00000', data: { applying: [] } }).length, 0);

const activeIpo = { offer_open_at: '2026-09-01T01:00:00.000Z', offer_close_at: null, listing_at: null, ipo_status: 'active' };
assert.strictEqual(isOfferOpen(activeIpo, new Date('2026-09-03T08:00:00.000Z'), '2026-09-03'), true);
assert.strictEqual(isCurrentSubscriptionRecord({ subscriptionMultiple: 12.5, offerCloseDate: '2026-09-03', raw: { update_at: '2026-09-03T08:00:00.000Z' } }, activeIpo, '2026-09-03', new Date('2026-09-03T08:00:00.000Z')), true);
assert.strictEqual(isCurrentSubscriptionRecord({ subscriptionMultiple: 12.5, offerCloseDate: '2026-09-02', raw: {} }, activeIpo, '2026-09-03', new Date('2026-09-03T08:00:00.000Z')), false);
assert.strictEqual(isVerifiedAllotmentDocument({ parserEvidence: { factsParserVersion: 'hk-ipo-allotment-facts-v5', oversubscriptionParserStatus: 'missing', lotteryParserStatus: 'parsed', feeParserStatus: 'missing' } }), true);
assert.strictEqual(isVerifiedAllotmentDocument({ parserEvidence: { factsParserVersion: 'hk-ipo-allotment-facts-v4', oversubscriptionParserStatus: 'parsed', lotteryParserStatus: 'parsed', feeParserStatus: 'parsed' } }), false);
assert.strictEqual(isUsableProspectusDocument({ type: 'prospectus', url: 'https://www1.hkexnews.hk/a.pdf', parserStatus: 'parsed' }), true);
assert.strictEqual(isUsableProspectusDocument({ type: 'prospectus', url: 'https://www1.hkexnews.hk/a.pdf', parserStatus: 'partial', parserEvidence: { offerCloseAt: 'x' } }), false);
assert.strictEqual(cancellationTitleLooksLikeIpo('Announcement - decision not to proceed with the global offering', {}), true);
assert.strictEqual(cancellationTitleLooksLikeIpo('Postponement of the global offering', {}), false);

const futuFixture = '<a class="list-item"><span title="03231" class="ellipsis code">03231</span><span title="优地机器人" class="ellipsis name">优地机器人</span><span title="+105.54%" class="value ellipsis value-darkChangeRatio direct-up">+105.54%</span><span title="2026/09/09" class="value value-listingDate">2026/09/09</span></a>';
const futu = parseFutuIpoHtml(futuFixture);
assert.strictEqual(futu[0].securityCode, '03231.HK');
assert.strictEqual(futu[0].greyMarketChangePct, 105.54);
assert.strictEqual(assessHkGreenshoe({ status: 'exercised' }, null), '偏利好：有稳价安排');
assert.strictEqual(assessHkGreenshoe({ status: 'not_available' }, null), '偏不利：缺少绿鞋保护');
assert.strictEqual(assessHkGreenshoe({ status: 'not_disclosed' }, null), '待确认');

console.log('OK hk-ipo-market-signals: 申购倍数、暗盘解析和绿鞋判断通过');
