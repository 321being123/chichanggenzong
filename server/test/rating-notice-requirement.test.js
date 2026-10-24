const assert=require('assert');
const {needRatingResultNotices}=require('../services/convertibleBondAnalysisInputs');
// 结果公告可能才携带本期评级/展望/实际日的唯一原文证据，因此“最新评级不完整”时必须处理，
// 不能因为评级报告本身都 complete 就把结果公告跳过（这是 110081 等 37 只长期缺评级的真实卡点）。
assert.strictEqual(needRatingResultNotices({reportCount:0,latestComplete:false,hasIncompleteReport:false}),true,'无评级报告必须找结果公告');
assert.strictEqual(needRatingResultNotices({reportCount:2,latestComplete:false,hasIncompleteReport:false}),true,'报告都完整但最新评级不完整时仍要处理结果公告');
assert.strictEqual(needRatingResultNotices({reportCount:2,latestComplete:true,hasIncompleteReport:true}),true,'有报告解析不完整要处理结果公告');
assert.strictEqual(needRatingResultNotices({reportCount:2,latestComplete:true,hasIncompleteReport:false}),false,'报告完整且最新评级已完整才可跳过');
assert.strictEqual(needRatingResultNotices({reportCount:1,latestComplete:undefined,hasIncompleteReport:false}),false,'未给出完整性时不额外放宽');
console.log('评级结果公告处理条件：最新评级不完整时不得跳过');
