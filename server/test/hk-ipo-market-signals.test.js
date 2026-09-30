const assert = require('assert');
const { parseLivermoreHistory, parseLivermoreCurrent, parseVbkrCurrent, parseFutuIpoHtml, parseHkIpoXHtml, normalizeCode, isOfferOpen, isCurrentSubscriptionRecord, buildSourceRecordHash, normalizeSnapshotNumber } = require('../services/hkIpoMarketSignals');
const { assessHkGreenshoe, resolveHkIpoDisplayName } = require('../routes/ipo');
const { isReparsableAllotmentDocument, isVerifiedAllotmentDocument, isUsableProspectusDocument, cancellationTitleLooksLikeIpo } = require('../services/hkexIpo');

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
assert.strictEqual(normalizeSnapshotNumber('1,000.00004', 0), '1000');
assert.strictEqual(normalizeSnapshotNumber('12.50004', 4), '12.5000');
assert.strictEqual(buildSourceRecordHash({
  code: '03231', sourceCode: 'VBKR-PUBLIC', signalType: 'subscription', signalKind: 'margin_estimate',
  dataDate: '2026-09-20', subscriptionMultiple: '12.50004', sourceObservedAt: '2026-09-20T02:00:00.999Z',
}), buildSourceRecordHash({
  code: '03231.HK', sourceCode: 'vbkr-public', signalType: 'subscription', signalKind: 'margin_estimate',
  dataDate: '2026-09-20', subscriptionMultiple: 12.5, sourceObservedAt: '2026-09-20T02:00:00Z',
}), '规范化哈希应忽略代码大小写、金额小数噪声和毫秒噪声');
assert.notStrictEqual(buildSourceRecordHash({
  code: '03231.HK', sourceCode: 'vbkr-public', signalType: 'subscription', signalKind: 'margin_estimate',
  dataDate: '2026-09-20', subscriptionMultiple: 12.5, sourceObservedAt: '2026-09-20T02:00:01Z',
}), buildSourceRecordHash({
  code: '03231.HK', sourceCode: 'vbkr-public', signalType: 'subscription', signalKind: 'margin_estimate',
  dataDate: '2026-09-20', subscriptionMultiple: 12.5, sourceObservedAt: '2026-09-20T02:00:00Z',
}), '上游时刻变化必须形成新哈希');
assert.notStrictEqual(buildSourceRecordHash({
  code: '03231.HK', sourceCode: 'hkipox-public', signalType: 'subscription', signalKind: 'subscription_estimate',
  dataDate: '2026-09-20', subscriptionMultiple: 12.5, collectionPoint: 'preopen',
}), buildSourceRecordHash({
  code: '03231.HK', sourceCode: 'hkipox-public', signalType: 'subscription', signalKind: 'subscription_estimate',
  dataDate: '2026-09-20', subscriptionMultiple: 12.5, collectionPoint: 'midday',
}), '同日盘前、午间、收盘的相同倍数也应保留为独立采集记录');
assert.strictEqual(buildSourceRecordHash({
  code: '03231.HK', sourceCode: 'hkipox-public', signalType: 'subscription', signalKind: 'subscription_estimate',
  dataDate: '2026-09-20', subscriptionMultiple: 12.5, collectionPoint: 'preopen',
}), buildSourceRecordHash({
  code: '03231.HK', sourceCode: 'hkipox-public', signalType: 'subscription', signalKind: 'subscription_estimate',
  dataDate: '2026-09-20', subscriptionMultiple: 12.5, collectionPoint: 'preopen',
}), '同一时段重试仍应幂等');

const activeIpo = { offer_open_at: '2026-09-01T01:00:00.000Z', offer_close_at: null, listing_at: null, ipo_status: 'active' };
assert.strictEqual(isOfferOpen(activeIpo, new Date('2026-09-03T08:00:00.000Z'), '2026-09-03'), true);
assert.strictEqual(isCurrentSubscriptionRecord({ subscriptionMultiple: 12.5, offerCloseDate: '2026-09-03', raw: { update_at: '2026-09-03T08:00:00.000Z' } }, activeIpo, '2026-09-03', new Date('2026-09-03T08:00:00.000Z')), true);
assert.strictEqual(isCurrentSubscriptionRecord({ subscriptionMultiple: 12.5, offerCloseDate: '2026-09-02', raw: {} }, activeIpo, '2026-09-03', new Date('2026-09-03T08:00:00.000Z')), false);
assert.strictEqual(isVerifiedAllotmentDocument({ parserEvidence: { factsParserVersion: 'hk-ipo-allotment-facts-v7', oversubscriptionParserStatus: 'missing', lotteryParserStatus: 'parsed', feeParserStatus: 'missing' } }), true);
assert.strictEqual(isVerifiedAllotmentDocument({ parserEvidence: { factsParserVersion: 'hk-ipo-allotment-facts-v5', oversubscriptionParserStatus: 'missing', lotteryParserStatus: 'parsed', feeParserStatus: 'missing' } }), false, '旧版本需重解析实际定价日期');
assert.strictEqual(isVerifiedAllotmentDocument({ parserEvidence: { factsParserVersion: 'hk-ipo-allotment-facts-v4', oversubscriptionParserStatus: 'parsed', lotteryParserStatus: 'parsed', feeParserStatus: 'parsed' } }), false);
assert.strictEqual(isVerifiedAllotmentDocument({ title: 'GLOBAL OFFERING - CLARIFICATION ANNOUNCEMENT', parserEvidence: { factsParserVersion: 'hk-ipo-allotment-facts-v5', oversubscriptionParserStatus: 'missing', lotteryParserStatus: 'missing', feeParserStatus: 'missing' } }), false);
assert.strictEqual(isUsableProspectusDocument({ type: 'prospectus', url: 'https://www1.hkexnews.hk/a.pdf', parserStatus: 'parsed' }), true);
assert.strictEqual(isUsableProspectusDocument({ type: 'prospectus', url: 'https://www1.hkexnews.hk/a.pdf', parserStatus: 'partial', parserEvidence: { offerCloseAt: 'x' } }), false);
assert.strictEqual(cancellationTitleLooksLikeIpo('Announcement - decision not to proceed with the global offering', {}), true);
assert.strictEqual(cancellationTitleLooksLikeIpo('Postponement of the global offering', {}), false);

const futuFixture = '<a class="list-item"><span title="03231" class="ellipsis code">03231</span><span title="优地机器人" class="ellipsis name">优地机器人</span><span title="+105.54%" class="value ellipsis value-darkChangeRatio direct-up">+105.54%</span><span title="2026/09/09" class="value value-listingDate">2026/09/09</span></a>';
const futu = parseFutuIpoHtml(futuFixture);
assert.strictEqual(futu[0].securityCode, '03231.HK');
assert.strictEqual(futu[0].greyMarketChangePct, 105.54);
const hkipoxFixture = '<section><h2>今日申购</h2><table><tr><th>代码</th><th>名称</th><th>认购倍数</th><th>招股结束日</th></tr>'
  + '<tr><td data-label="代码">06731</td><td data-label="名称">星创新材</td><td data-label="认购倍数">6.59x</td><td data-label="招股结束日">2026-09-24</td></tr>'
  + '<tr><td data-label="代码">06802</td><td data-label="名称">欢创科技AH回拨无鞋</td><td data-label="认购倍数">10.5x</td><td data-label="招股结束日">2026-09-25</td></tr>'
  + '<tr><td data-label="代码">03228</td><td data-label="名称">景旺电子 AH 无鞋</td><td data-label="认购倍数">42x</td><td data-label="招股结束日">2026-09-25</td></tr>'
  + '<tr><td data-label="代码">09607</td><td data-label="名称">样本新股</td><td data-label="认购倍数">0x</td><td data-label="招股结束日">2026-09-24</td></tr></table></section>';
const hkipox = parseHkIpoXHtml(hkipoxFixture);
assert.strictEqual(hkipox.length, 3, '只保留有正申购倍数的今日申购项目');
assert.strictEqual(hkipox[0].securityCode, '06731.HK');
assert.strictEqual(hkipox[0].subscriptionMultiple, 6.59);
assert.strictEqual(hkipox[0].offerCloseDate, '2026-09-24');
assert.strictEqual(hkipox[1].securityName, '欢创科技', '同步申购倍数时同时清理并保存来源简称');
assert.strictEqual(hkipox[2].securityName, '景旺电子', '清理简称中的分隔后缀，不显示 AH/无鞋标记');
assert.strictEqual(resolveHkIpoDisplayName({
  hkipox_short_name: '欢创科技', quote_name: '欢创科技行情简称',
  security_name_cn: '深圳市欢创科技股份有限公司',
}), '欢创科技', '优先显示同步取得的简称');
assert.strictEqual(resolveHkIpoDisplayName({
  hkipox_short_name: 'ACME', security_name_cn: '示例股份有限公司',
}), 'ACME', 'HKIPOx 同步返回简称时直接展示，不被其他中文全称覆盖');
assert.strictEqual(resolveHkIpoDisplayName({
  hkipox_short_name: '景旺电子 AH 无鞋', security_name_cn: '深圳市景旺电子股份有限公司',
}), '景旺电子', '旧快照中的来源简称也应去除发行标记后再展示');
assert.throws(() => parseHkIpoXHtml('<html><h2>今日申购</h2><p>页面结构变化</p></html>'), /缺少预期数据列/);
assert.strictEqual(assessHkGreenshoe({ status: 'exercised' }, null), '偏利好：有稳价安排');
assert.strictEqual(assessHkGreenshoe({ status: 'not_available' }, null), '偏不利：缺少绿鞋保护');
assert.strictEqual(assessHkGreenshoe({ status: 'not_disclosed' }, null), '待确认');

console.log('OK hk-ipo-market-signals: 申购倍数、暗盘解析和绿鞋判断通过');

assert.strictEqual(isCurrentSubscriptionRecord({subscriptionMultiple: 10, offerCloseDate: '2026-10-02'}, {ipo_status: 'postponed', offer_open_at: '2026-09-28T09:00:00+08:00', offer_close_at: '2026-10-02T12:00:00+08:00'}, '2026-10-01', new Date('2026-10-01T09:00:00+08:00')), false, '延期公司不得继续参与实时申购信号');

const previousEvidence = {type: 'allotment_result', url: 'https://www1.hkexnews.hk/test.pdf', title: 'ALLOTMENT RESULTS', contentSha256: 'verified-hash', parserEvidence: {factsParserVersion: 'hk-ipo-allotment-facts-v6', oversubscriptionParserStatus: 'missing', lotteryParserStatus: 'parsed', feeParserStatus: 'missing'}};
assert.strictEqual(isReparsableAllotmentDocument(previousEvidence), true, '已核验旧版官方配发PDF升级应复用缓存');
assert.strictEqual(isReparsableAllotmentDocument({...previousEvidence, title: 'CLARIFICATION ANNOUNCEMENT'}), false, '澄清文件不得冒充配发升级');
assert.strictEqual(isReparsableAllotmentDocument({...previousEvidence, contentSha256: null}), false, '无原文哈希不得复用旧版证据');
assert.strictEqual(isReparsableAllotmentDocument({...previousEvidence, url: 'https://example.test/test.pdf'}), false, '非官方文档不得复用');
