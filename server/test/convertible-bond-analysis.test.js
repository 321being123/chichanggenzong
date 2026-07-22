const assert = require('assert');
const {
  normalizeBondCode, isoDate, remainingYears, parseTriggerRatio, parseWindow, yuanToHundredMillion,
  earliestPutDate, currentPutPeriod, putOpportunityState, annualizedVolatility, simplifyClause, triggerProgress, resetWindowState, estimatePutTimeline, parseCouponRates,
  yieldToMaturity, blackScholesConvertible, fallbackPe, currentInterestYear, presentValue, derivedDividendYield, revisionDecision,
} = require('../services/convertibleBondAnalysis');

assert.strictEqual(normalizeBondCode('113001'), '113001.SH');
assert.strictEqual(normalizeBondCode('123001.SZ'), '123001.SZ');
assert.strictEqual(normalizeBondCode('600519'), null);
assert.strictEqual(yuanToHundredMillion(2449880700), 24.498807);
assert.strictEqual(isoDate('2026-07-22'), '2026-07-22');
assert.strictEqual(isoDate('20260722'), '2026-07-22');
assert.strictEqual(parseTriggerRatio('连续30个交易日中至少15个交易日高于转股价格的130%'), 1.3);
assert.deepStrictEqual(parseWindow('连续30个交易日中至少15个交易日'), { observation_days:30, required_days:15 });
assert.deepStrictEqual(parseWindow('连续三十个交易日中至少十五个交易日'), { observation_days:30, required_days:15 });
assert.strictEqual(earliestPutDate('2030-01-01', '最后两个计息年度'), '2028-01-01');
assert.deepStrictEqual(currentPutPeriod('2027-07-15', '最后两个计息年度', '2026-07-22'), {
  active:true, eligible_from:'2025-07-15', period_start:'2026-07-15', period_end:'2027-07-14',
});
assert.strictEqual(putOpportunityState([
  {event_date:'2026-07-20',title:'关于太平转债回售结果的公告'},
], '2026-07-15', '2027-07-14').used, true);
assert.ok(remainingYears('2028-01-01', new Date('2026-01-01T00:00:00+08:00')) > 1.9);
const rows = Array.from({ length:40 }, (_, i) => ({ trade_date:String(20260101+i), close:100+i*0.2 }));
assert.ok(annualizedVolatility(rows) > 0);
const reset = simplifyClause('reset', '当公司股票在任意连续三十个交易日中至少有十五个交易日的收盘价格低于当期转股价格的85%时，修正后的转股价格不得低于每股净资产');
assert.strictEqual(reset.ratio, 0.85);
assert.ok(reset.text.includes('30个交易日') && reset.note.includes('净资产'));
const progress = triggerProgress(Array.from({length:30},(_,i)=>({trade_date:String(20260701+i),close:i<16?8:9})), reset, 10);
assert.strictEqual(progress.matched_days, 16);
assert.strictEqual(progress.met, true);
const locked = resetWindowState([{announced_at:'20260417',valid_until:'20261019',next_eligible_date:'20261020'}], '20260722');
assert.strictEqual(locked.active, false);
assert.strictEqual(locked.eligible_from, '2026-10-20');
const lockedProgress = triggerProgress(rows, reset, 10, locked.active, locked.eligible_from);
assert.strictEqual(lockedProgress.matched_days, 0);
assert.strictEqual(lockedProgress.met, false);
const restarted = resetWindowState([{announced_at:'20260417',valid_until:'20261019',next_eligible_date:'20261020'}], '20261020');
assert.strictEqual(restarted.active, true);
assert.strictEqual(restarted.eligible_from, '2026-10-20');
const putTerm = { ratio:0.7, observation_days:30, required_days:30, comparison:'lt' };
const putRows = Array.from({length:16},(_,i)=>({trade_date:`202607${String(i+1).padStart(2,'0')}`,close:6}));
const putProgress = triggerProgress(putRows, putTerm, 10, true, '2026-06-30');
assert.strictEqual(putProgress.observed_days, 16);
assert.strictEqual(putProgress.met, false);
const calendar = Array.from({length:50},(_,i)=>`2026-08-${String(i+1).padStart(2,'0')}`);
const timeline = estimatePutTimeline(putRows, putTerm, 10, '20260630', calendar, 6, '20260722');
assert.strictEqual(timeline.remaining_days, 14);
assert.ok(timeline.trigger_date);
assert.deepStrictEqual(parseCouponRates('第一年0.3%、第二年0.5%、第三年1.0%'), [0.3,0.5,1]);
assert.ok(Math.abs(yieldToMaturity(95,[{years:1,amount:5},{years:2,amount:105}])-0.078)<0.002);
assert.ok(blackScholesConvertible(10,10,2,0.25,0.015,0)>0);
assert.strictEqual(currentInterestYear('2023-02-22','2029-02-22','2026-07-22'), 4);
assert.ok(presentValue([{years:1,amount:5},{years:2,amount:105}],0.05)>99);
assert.strictEqual(derivedDividendYield([{cash_div_tax:0}],10,'2026-07-22'), 0);
assert.strictEqual(fallbackPe({}, 1000000000, [{end_date:'20251231',n_income_attr_p:-50000000}]), -20);
assert.strictEqual(revisionDecision('关于董事会提议向下修正某转债转股价格的公告'), null);
assert.strictEqual(revisionDecision('关于预计触发转股价格向下修正条件的提示性公告'), null);
assert.strictEqual(revisionDecision('关于不向下修正某转债转股价格的公告'), 'no_revision');
assert.strictEqual(revisionDecision('关于向下修正某转债转股价格的公告'), 'revised');
assert.strictEqual(revisionDecision('关于可转换公司债券转股价格调整的公告'), 'adjusted');

console.log('convertible bond analysis tests passed');
