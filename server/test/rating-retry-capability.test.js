const assert=require('assert');
const {shouldRetryRatingFailure,RATING_RETRY_CAPABILITY}=require('../services/convertibleBondAnalysisInputs');
// 只让评级文档的历史 failed 在能力版本变化后重试一次；blocked（需 OCR）、complete、其他文种都不得重试。
assert.strictEqual(shouldRetryRatingFailure('rating',{status:'failed'}),true,'历史失败无能力版本应重试');
assert.strictEqual(shouldRetryRatingFailure('rating',{status:'failed',ratingCapability:'rating-retry-2025-01-01'}),true,'旧能力版本应重试');
assert.strictEqual(shouldRetryRatingFailure('rating',{status:'failed',ratingCapability:RATING_RETRY_CAPABILITY}),false,'同能力版本已试过不得反复重试');
assert.strictEqual(shouldRetryRatingFailure('rating',{status:'blocked'}),false,'需OCR的文章不得重试');
assert.strictEqual(shouldRetryRatingFailure('rating',{status:'complete'}),false,'已完成不得重试');
assert.strictEqual(shouldRetryRatingFailure('rating',undefined),false,'无历史记录不得伪造重试');
assert.strictEqual(shouldRetryRatingFailure('prospectus',{status:'failed'}),false,'其他文种不受评级能力版本影响');
assert.strictEqual(shouldRetryRatingFailure('holders',{status:'failed'}),false,'持有人文种不受评级能力版本影响');
console.log('评级失败重试：仅 rating 的 failed 且能力版本变化时重试一次');
