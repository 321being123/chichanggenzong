// 发行人全称写法与解析能力版本（0.8.4.28）
const assert = require('assert');
const { issuerNameOf, RATING_RETRY_CAPABILITY } = require('../services/convertibleBondAnalysisInputs');

// 交易所公告里三种后缀都存在，取不到发行人会让整份公告的身份校验失败
assert.strictEqual(issuerNameOf('海天水务集团股份公司向不特定对象发行可转换公司债券'), '海天水务集团股份公司');
assert.strictEqual(issuerNameOf('神宇通信科技股份公司向不特定对象发行可转换公司债券'), '神宇通信科技股份公司');
assert.strictEqual(issuerNameOf('闻泰科技股份有限公司公开发行可转换公司债券'), '闻泰科技股份有限公司');
assert.strictEqual(issuerNameOf('某某有限责任公司发行'), '某某有限责任公司');
assert.strictEqual(issuerNameOf(''), undefined);
assert.strictEqual(issuerNameOf(null), undefined);

// 解析器能力改进后必须同步推进能力版本，否则历史失败文档永不重试
assert.ok(/^rating-retry-\d{4}-\d{2}-\d{2}[a-z]?$/.test(RATING_RETRY_CAPABILITY), RATING_RETRY_CAPABILITY);

console.log('RATING-ISSUER-NAME: 三种发行人写法与能力版本格式通过');
