// 港股证券分析市场中立合同反例（方案 14.6.1）。
// 全部为夹具数据，不是实际公司数据；真实样本与来源权限另按 14.6.2 独立核验。
// 纯函数测试，不连库、不联网、不启服务。
const assert = require('assert');
const c = require('../domain/securityAnalysisContract');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}
function close(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);
}

console.log('--- 港股证券分析合同反例 ---');

// ===== 14.6.1 行1：代码归一与市场隔离 =====
test('00700 / 700.HK / 00700.HK 归一为同一标准身份', () => {
  const codes = ['00700', '700.HK', '00700.HK'].map(v => c.normalizeAnalyzableCode(v));
  assert.deepStrictEqual(codes.map(v => v.code), ['00700.HK', '00700.HK', '00700.HK']);
  assert.ok(codes.every(v => v.market === 'HK' && v.ok === true));
});

test('六位数字不静默改成港股，000700 也不被当作港股', () => {
  const six = c.normalizeAnalyzableCode('000700');
  assert.strictEqual(six.ok, false);
  assert.strictEqual(six.reason, 'cn_code_needs_suffix');
  assert.strictEqual(six.digits, '000700');
  assert.strictEqual(c.normalizeAnalyzableCode('000700.SZ').code, '000700.SZ');
  assert.strictEqual(c.marketOf('000700.SZ'), 'CN');
});

test('名称与歧义输入必须列出候选，不自动选首项', () => {
  const name = c.normalizeAnalyzableCode('腾讯控股');
  assert.strictEqual(name.ok, false);
  assert.strictEqual(name.ambiguous, true);
  assert.strictEqual(c.normalizeAnalyzableCode('').ok, false);
  assert.strictEqual(c.normalizeAnalyzableCode('X'.repeat(40)).reason, 'too_long');
});

test('主档类型闸门：ETF/REIT/权证与非股票明确拒绝，类型未知不猜', () => {
  const base = { asset_class: 'stock', market: 'HK', canonical_code: '00700.HK', name: '腾讯控股' };
  assert.strictEqual(c.classifyHkInstrument(base).ok, true);
  assert.strictEqual(c.classifyHkInstrument(Object.assign({}, base, { name: '盈富基金 ETF' })).reason, 'non_ordinary_security');
  assert.strictEqual(c.classifyHkInstrument(Object.assign({}, base, { raw_data: { instrument_type: 'REIT' } })).reason, 'non_ordinary_security');
  assert.strictEqual(c.classifyHkInstrument(Object.assign({}, base, { asset_class: 'convertible_bond' })).reason, 'not_a_stock');
  assert.strictEqual(c.classifyHkInstrument(null).status, c.FIELD_STATUS.MISSING);
  assert.strictEqual(c.classifyHkInstrument(base).securityTypeKnown, false);
  assert.strictEqual(c.classifyHkInstrument(Object.assign({}, base, { raw_data: { fs_table_type: 'bank' } })).financial, true);
});

// ===== 14.6.1 行3：非 12 月财年 TTM =====
test('6 月财年 TTM＝120＋50－40＝130', () => {
  const r = c.ttmForFiscalYear({ annual: 120, currentCumulative: 50, priorComparableCumulative: 40, comparable: true });
  assert.strictEqual(r.value, 130);
  assert.strictEqual(r.status, c.FIELD_STATUS.AVAILABLE);
});

test('上年同期缺失、财年变更、可比性缺失都不算 TTM', () => {
  assert.strictEqual(c.ttmForFiscalYear({ annual: 120, currentCumulative: 50, priorComparableCumulative: null }).status, c.FIELD_STATUS.INSUFFICIENT_HISTORY);
  assert.notStrictEqual(c.ttmForFiscalYear({ annual: 120, currentCumulative: 50, priorComparableCumulative: null }).value, 100);
  assert.strictEqual(c.ttmForFiscalYear({ annual: 120, currentCumulative: 50, priorComparableCumulative: 40, fiscalYearChanged: true }).status, c.FIELD_STATUS.NOT_APPLICABLE);
  assert.strictEqual(c.ttmForFiscalYear({ annual: 120, currentCumulative: 50, priorComparableCumulative: 40, comparable: false }).value, null);
});

// ===== 14.6.1 行4：A/H 股本范围、币种与 PE =====
test('匹配范围＋汇率证据齐全：市值 100000 HKD、利润 11000 HKD、PE≈9.09', () => {
  const cap = c.marketCapOf({ price: 100, shares: 1000, shareScope: c.SHARE_SCOPE.MATCHED, priceCurrency: 'HKD' });
  assert.strictEqual(cap.value, 100000);
  assert.strictEqual(cap.scope, 'matched_tradable');
  const profit = c.convertAmount({ value: 10000, from: 'CNY', to: 'HKD', rate: 1.1, rateDate: '2026-06-30', rateSource: 'market.fx_rates' });
  assert.strictEqual(profit.value, 11000);
  const pe = c.peOf(cap, profit.value);
  close(pe.value, 100000 / 11000);
  assert.notStrictEqual(pe.value, 10);
});

test('币种、汇率方向、来源或股份范围任一缺失即不计算，不会得到 10', () => {
  const missingRate = c.convertAmount({ value: 10000, from: 'CNY', to: 'HKD', rate: 1.1, rateDate: null, rateSource: null });
  assert.strictEqual(missingRate.value, null);
  assert.strictEqual(missingRate.status, c.FIELD_STATUS.MISSING);
  assert.strictEqual(c.convertAmount({ value: 10000, from: 'CNY', to: 'HKD', rate: 1.1, rateDate: '2026-06-30', rateSource: 'fx', direction: 'to_from' }).value, 10000 / 1.1);
  const badScope = c.marketCapOf({ price: 100, shares: 1000, shareScope: c.SHARE_SCOPE.UNKNOWN, priceCurrency: 'HKD' });
  assert.strictEqual(badScope.value, null);
  assert.strictEqual(c.peOf(badScope, 10000).value, null);
});

// ===== 14.6.1 行5：H 股价 × 全体股本禁止生成误导市值 =====
test('只有公司全体股本或范围未知时不算市值；已验证来源估值可独立显示', () => {
  const forbidden = c.marketCapOf({ price: 100, shares: 5000, shareScope: c.SHARE_SCOPE.COMPANY_TOTAL, priceCurrency: 'HKD' });
  assert.strictEqual(forbidden.value, null);
  const verified = c.marketCapOf({ price: 100, shares: null, shareScope: c.SHARE_SCOPE.UNKNOWN, priceCurrency: 'HKD', verifiedMarketCap: 98000, verifiedScope: 'source_verified' });
  assert.strictEqual(verified.value, 98000);
  assert.strictEqual(verified.source, 'verified_source_valuation');
});

// ===== 14.6.1 行6：十年稳定性与负 PE =====
test('仅 3 年均盈利/均派现属历史不足，不给十年通过也不判失败', () => {
  const three = c.tenYearStability([1, 2, 3].map(y => ({ year: y, profit: 10, dividend: 1, evidence: true })));
  assert.strictEqual(three.status, c.FIELD_STATUS.INSUFFICIENT_HISTORY);
  assert.strictEqual(three.value, null);
});

test('十年中一财年未知仍是资料不足，不能判确定失败', () => {
  const years = Array.from({ length: 10 }, (_, i) => ({ year: 2016 + i, profit: 10, dividend: 1, evidence: i !== 4 }));
  const r = c.tenYearStability(years);
  assert.strictEqual(r.status, c.FIELD_STATUS.INSUFFICIENT_HISTORY);
  assert.strictEqual(r.coveredYears, 9);
});

test('十个完整可比财年才给结论；负 PE 保留亏损且无正估值分位', () => {
  const years = Array.from({ length: 10 }, (_, i) => ({ year: 2016 + i, profit: 10, dividend: 1, evidence: true }));
  assert.deepStrictEqual(c.tenYearStability(years).value, { profitable: true, dividends: true });
  const negPe = c.peOf({ value: 100000 }, -5000);
  assert.strictEqual(negPe.value, -20);
  assert.strictEqual(negPe.note, 'negative_pe_loss_fact');
  const percentile = c.positiveValuationPercentile([8, 12, 15, -3, 20], -2);
  assert.strictEqual(percentile.status, c.FIELD_STATUS.NOT_APPLICABLE);
  assert.strictEqual(percentile.value, null);
  assert.strictEqual(c.positiveValuationPercentile([8, 12, 15, -3, 20], 14).excluded, 1);
});

// ===== 14.6.1 行7：分红去重、同日独立事件、仅每股现金 =====
test('两来源同一分红去重；同日两笔独立分红都保留', () => {
  const duplicate = [{ source_event_key: 'HKEX:1', ex_date: '2026-06-01', cash_per_share: 1 }, { source_event_key: 'HKEX:1', ex_date: '2026-06-01', cash_per_share: 1 }];
  assert.strictEqual(c.dividendEventsOf(duplicate).length, 1);
  const independent = [{ source_event_key: 'HKEX:1', ex_date: '2026-06-01', cash_per_share: 1 }, { source_event_key: 'HKEX:2', ex_date: '2026-06-01', cash_per_share: 2 }];
  assert.strictEqual(c.dividendEventsOf(independent).length, 2);
});

test('仅每股现金可算股息率，不造分红总额与派息率', () => {
  const events = [{ source_event_key: 'A', ex_date: '2026-06-01', cash_per_share: 2, currency: 'HKD' }];
  const r = c.dividendYieldOf({ events, price: 40, priceCurrency: 'HKD', eventCurrency: 'HKD' });
  close(r.yield.value, 0.05);
  assert.strictEqual(r.totalAmount, null);
  assert.strictEqual(c.dividendYieldOf({ events, price: 40, priceCurrency: 'CNY' }).yield.value, null);
});

// ===== 14.6.1 行8：日线/估值/复权/资本开支各自独立 =====
test('日线有值但估值缺失仍可显示股价；复权缺失明确标注', () => {
  const s = c.priceSeriesStatus({ prices: [{ close: 10 }, { close: 11 }], valuations: [], adjustmentFactors: [] });
  assert.strictEqual(s.prices.available, true);
  assert.strictEqual(s.valuations.available, false);
  assert.strictEqual(s.prices.adjusted, false);
  assert.strictEqual(s.adjustedMetrics.status, c.FIELD_STATUS.NOT_APPLICABLE);
});

test('资本开支缺失时 FCF 不可算，不等于经营现金流', () => {
  const r = c.freeCashFlowOf({ operating: 100, capex: null });
  assert.strictEqual(r.value, null);
  assert.strictEqual(r.status, c.FIELD_STATUS.MISSING);
  assert.notStrictEqual(r.value, 100);
  assert.strictEqual(c.freeCashFlowOf({ operating: 100, capex: 30 }).value, 70);
});

// ===== 14.6.1 行9：三表报告版本绑定与 409 =====
test('三表绑定报告版本；版本不可读返回 409，旧 A 股无版本调用保持兼容', () => {
  const meta = c.statementMetadataOf({ report_id: 'r1', period_end: '2026-03-31', fiscal_year: '2026', report_type_label: '年报', accounting_standard: 'HKFRS', currency: 'HKD', version: 3, announced_at: '2026-06-20', company_id: 9 });
  assert.strictEqual(meta.report_type, '年报');
  assert.strictEqual(meta.period_end, '2026-03-31');
  assert.strictEqual(meta.currency, 'HKD');
  assert.strictEqual(c.statementUnitOf({ currency: 'HKD', scale: '亿元' }), 'HKD·亿元');
  assert.strictEqual(c.statementUnitOf({ currency: 'HKD', perShare: true }), 'HKD/股');
  assert.strictEqual(c.versionConflict(null, 'v2'), null);
  assert.strictEqual(c.versionConflict('v1', 'v1'), null);
  assert.strictEqual(c.versionConflict('v1', 'v2').status, 409);
  assert.strictEqual(c.statementMetadataOf(null).status, c.FIELD_STATUS.MISSING);
});

test('分析版本由完整身份＋公式版本＋输入摘要生成，同输入稳定、输入变化即变', () => {
  const args = { canonicalCode: '00700.HK', formulaVersion: 'hk-1', inputs: { bars: 'a', reports: 'b', dividends: 'c' } };
  const v1 = c.analysisVersionOf(args);
  assert.strictEqual(v1, c.analysisVersionOf(args));
  assert.notStrictEqual(v1, c.analysisVersionOf(Object.assign({}, args, { inputs: { bars: 'a', reports: 'b2', dividends: 'c' } })));
  assert.notStrictEqual(v1, c.analysisVersionOf(Object.assign({}, args, { canonicalCode: '00001.HK' })));
  assert.strictEqual(c.analysisVersionOf({ formulaVersion: 'hk-1' }), null);
});

// ===== 14.6.1 行10：单股与跨市场范围隔离 =====
test('单股只保留自身范围证据，不发布整个 HK 市场分区；HK 与 CN 不互相抵消', () => {
  const single = c.datasetScopeOf({ market: 'HK', targetDate: '2026-11-10', targetCodes: ['00700.HK'] });
  assert.strictEqual(single.market, 'HK');
  assert.strictEqual(single.scope, 'security:00700.HK');
  assert.strictEqual(single.targetDate, '2026-11-10');
  const cn = c.datasetScopeOf({ market: 'CN', targetDate: '2026-11-10', targetCodes: ['600519.SH'] });
  assert.notDeepStrictEqual(cn, single);
  assert.strictEqual(c.datasetScopeOf({ market: 'HK', targetDate: null }), null);
  assert.strictEqual(c.datasetScopeOf({ market: 'HK', targetDate: '2026-11-10' }).scope, 'market');
});

test('数值 0 是有效事实，未知保持 null 且带状态', () => {
  assert.strictEqual(c.metric(0).value, 0);
  assert.strictEqual(c.metric(0).status, c.FIELD_STATUS.AVAILABLE);
  assert.strictEqual(c.metric(null).value, null);
  assert.strictEqual(c.metric(null).status, c.FIELD_STATUS.MISSING);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
