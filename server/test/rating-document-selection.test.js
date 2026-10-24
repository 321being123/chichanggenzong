// 评级来源文书必须含债项结论：主体（发行人）报告不得当债项评级来源（0.8.4.29）
const assert = require('assert');
const { isBondRatingDocument } = require('../services/convertibleBondAnalysisInputs');

assert.strictEqual(isBondRatingDocument({ title: '关于“闻泰转债”不定期跟踪评级结果的公告' }), true);
assert.strictEqual(isBondRatingDocument({ title: '闻泰科技股份有限公司公开发行可转换公司债券跟踪评级报告' }), true);
assert.strictEqual(isBondRatingDocument({ title: '关于调降某某公司信用等级的公告' }), true);
assert.strictEqual(isBondRatingDocument({ title: '2026年度韵达控股集团股份有限公司信用评级报告' }), false);
assert.strictEqual(isBondRatingDocument({ title: '某某股份有限公司主体信用评级报告' }), false);

console.log('RATING-DOCUMENT-SELECTION: 债项文书保留、主体报告排除');
