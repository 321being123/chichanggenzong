// 评级输入解析与校验合并单测（合并原 rating-document-selection / issuer-name / notice-requirement /
// notice-validator / outlook-api-missing / retry-capability 6 个小文件）。
const assert = require('assert');
const {
  isBondRatingDocument,
  issuerNameOf,
  RATING_RETRY_CAPABILITY,
  needRatingResultNotices,
  validateRatingResultNotice,
  ratingRequirement,
  shouldRetryRatingFailure,
} = require('../services/convertibleBondAnalysisInputs');

// 1. 评级来源文书必须含债项结论：主体（发行人）报告不得当债项评级来源（0.8.4.29）
assert.strictEqual(isBondRatingDocument({ title: '关于“闻泰转债”不定期跟踪评级结果的公告' }), true);
assert.strictEqual(isBondRatingDocument({ title: '闻泰科技股份有限公司公开发行可转换公司债券跟踪评级报告' }), true);
assert.strictEqual(isBondRatingDocument({ title: '关于调降某某公司信用等级的公告' }), true);
assert.strictEqual(isBondRatingDocument({ title: '2026年度韵达控股集团股份有限公司信用评级报告' }), false);
assert.strictEqual(isBondRatingDocument({ title: '某某股份有限公司主体信用评级报告' }), false);
console.log('RATING-DOCUMENT-SELECTION: 债项文书保留、主体报告排除');

// 2. 发行人全称写法与解析能力版本（0.8.4.28）
assert.strictEqual(issuerNameOf('海天水务集团股份公司向不特定对象发行可转换公司债券'), '海天水务集团股份公司');
assert.strictEqual(issuerNameOf('神宇通信科技股份公司向不特定对象发行可转换公司债券'), '神宇通信科技股份公司');
assert.strictEqual(issuerNameOf('闻泰科技股份有限公司公开发行可转换公司债券'), '闻泰科技股份有限公司');
assert.strictEqual(issuerNameOf('某某有限责任公司发行'), '某某有限责任公司');
assert.strictEqual(issuerNameOf(''), undefined);
assert.strictEqual(issuerNameOf(null), undefined);
assert.ok(/^rating-retry-\d{4}-\d{2}-\d{2}[a-z]?$/.test(RATING_RETRY_CAPABILITY), RATING_RETRY_CAPABILITY);
console.log('RATING-ISSUER-NAME: 三种发行人写法与能力版本格式通过');

// 3. 结果公告处理条件：最新评级不完整时不得跳过
assert.strictEqual(needRatingResultNotices({ reportCount: 0, latestComplete: false, hasIncompleteReport: false }), true, '无评级报告必须找结果公告');
assert.strictEqual(needRatingResultNotices({ reportCount: 2, latestComplete: false, hasIncompleteReport: false }), true, '报告都完整但最新评级不完整时仍要处理结果公告');
assert.strictEqual(needRatingResultNotices({ reportCount: 2, latestComplete: true, hasIncompleteReport: true }), true, '有报告解析不完整要处理结果公告');
assert.strictEqual(needRatingResultNotices({ reportCount: 2, latestComplete: true, hasIncompleteReport: false }), false, '报告完整且最新评级已完整才可跳过');
assert.strictEqual(needRatingResultNotices({ reportCount: 1, latestComplete: undefined, hasIncompleteReport: false }), false, '未给出完整性时不额外放宽');
console.log('评级结果公告处理条件：最新评级不完整时不得跳过');

// 4. 评级结果公告校验：出具文书标题允许以评级机构开头（评级调整公告），但仍必须指明发行人（0.8.4.27）
{
  const bond = { ts_code: '110081.SH', bond_short_name: '闻泰转债', bond_full_name: '闻泰科技股份有限公司公开发行可转换公司债券' };
  const event = { source: 'sse', url: 'https://example.test/a.pdf', title: '关于“闻泰转债”不定期跟踪评级结果的公告', event_date: '2026-09-17' };
  const agency = '中诚信国际信用评级有限责任公司';
  const base = {
    source_url: event.url, document_hash: 'a'.repeat(64), rating_com_name: agency,
    rating: 'BBB-', rating_outlook: '负面', rating_date: '2026-09-15',
    rating_date_source: 'official_document', rating_conflicts: [],
  };
  const notice = {
    version: 'named-result-v1', bond_code: '110081.SH', bond_name: '闻泰转债',
    issuer_name: '闻泰科技股份有限公司', rating_company: agency,
    report_reference: { title: '中诚信国际关于调降闻泰科技股份有限公司主体及相关债项信用等级的公告', issued_at: '2026-09-15' },
    previous_ratings: [],
  };
  const withNotice = (patch) => ({ ...base, rating_result_notice: { ...notice, ...patch } });
  validateRatingResultNotice(event, withNotice({}), bond);
  assert.throws(() => validateRatingResultNotice(event, withNotice({
    report_reference: { title: '关于调降某公司信用等级的公告', issued_at: '2026-09-15' },
  }), bond), /缺目标代码、发行人或本次原文证据/);
  assert.throws(() => validateRatingResultNotice(event, withNotice({
    report_reference: { ...notice.report_reference, issued_at: '2026-09-16' },
  }), bond), /缺目标代码、发行人或本次原文证据/);
  assert.throws(() => validateRatingResultNotice(event, withNotice({ bond_code: '110082.SH' }), bond), /缺目标代码、发行人或本次原文证据/);
  assert.throws(() => validateRatingResultNotice(event, { ...withNotice({}), rating_outlook: null }, bond), /缺目标代码、发行人或本次原文证据/);
  console.log('RATING-NOTICE-VALIDATOR: 机构开头标题可用、无发行人/错日期/错债码/缺展望仍拒绝');
}

// 5. 接口来源缺展望不算缺项；原文来源缺展望仍必须判不完整（0.8.4.30）
{
  const bond = { instrument_id: 1, ts_code: '110081.SH', stock_code: '600745.SH', bond_short_name: '闻泰转债' };
  const docs = [];
  const base = {
    rating: 'BBB-', rating_date: '2026-09-15', announced_at: '2026-09-17', rating_company: '中诚信',
    raw_payload: { ts_code: '110081.SH', ann_date: '20260917', rating_way: 'api', rating: 'BBB-', rating_com_name: '中诚信', rating_date: '2026-09-15' },
  };
  const apiMissing = { ...base, raw_payload: { ...base.raw_payload, rating_outlook: '', outlook_status: 'api_unavailable' } };
  const originalMissing = { ...base, raw_payload: { ...base.raw_payload, rating_outlook: '' } };
  assert.strictEqual(ratingRequirement(bond, [apiMissing], docs, '2026-10-24').latest_complete, true, '接口缺展望可判完整');
  assert.strictEqual(ratingRequirement(bond, [apiMissing], docs, '2026-10-24').outlook_status, 'api_unavailable');
  assert.strictEqual(ratingRequirement(bond, [originalMissing], docs, '2026-10-24').latest_complete, false, '原文缺展望仍不完整');
  console.log('RATING-OUTLOOK-API: 接口缺展望放行、原文缺展望仍拒绝');
}

// 6. 评级失败重试：仅 rating 的 failed 且能力版本变化时重试一次
assert.strictEqual(shouldRetryRatingFailure('rating', { status: 'failed' }), true, '历史失败无能力版本应重试');
assert.strictEqual(shouldRetryRatingFailure('rating', { status: 'failed', ratingCapability: 'rating-retry-2025-01-01' }), true, '旧能力版本应重试');
assert.strictEqual(shouldRetryRatingFailure('rating', { status: 'failed', ratingCapability: RATING_RETRY_CAPABILITY }), false, '同能力版本已试过不得反复重试');
assert.strictEqual(shouldRetryRatingFailure('rating', { status: 'blocked' }), false, '需OCR的文章不得重试');
assert.strictEqual(shouldRetryRatingFailure('rating', { status: 'complete' }), false, '已完成不得重试');
assert.strictEqual(shouldRetryRatingFailure('rating', undefined), false, '无历史记录不得伪造重试');
assert.strictEqual(shouldRetryRatingFailure('prospectus', { status: 'failed' }), false, '其他文种不受评级能力版本影响');
assert.strictEqual(shouldRetryRatingFailure('holders', { status: 'failed' }), false, '持有人文种不受评级能力版本影响');
console.log('RATING-ANALYSIS-INPUTS: 6 项评级输入回归合并通过');
