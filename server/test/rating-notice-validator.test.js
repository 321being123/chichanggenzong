// 评级结果公告校验：出具文书标题允许以评级机构开头（评级调整公告），但仍必须指明发行人（0.8.4.27）
const assert = require('assert');
const { validateRatingResultNotice } = require('../services/convertibleBondAnalysisInputs');

const bond = { ts_code: '110081.SH', bond_short_name: '闻泰转债', bond_full_name: '闻泰科技股份有限公司公开发行可转换公司债券' };
const event = { source: 'sse', url: 'https://example.test/a.pdf', title: '关于“闻泰转债”不定期跟踪评级结果的公告', event_date: '2026-09-17' };
const agency = '中诚信国际信用评级有限责任公司';
const base = {
  source_url: event.url, document_hash: 'a'.repeat(64), rating_com_name: agency,
  rating: 'BBB-', rating_outlook: '负面', rating_date: '2026-09-15',
  rating_date_source: 'official_document', rating_conflicts: []
};
const notice = {
  version: 'named-result-v1', bond_code: '110081.SH', bond_name: '闻泰转债',
  issuer_name: '闻泰科技股份有限公司', rating_company: agency,
  report_reference: { title: '中诚信国际关于调降闻泰科技股份有限公司主体及相关债项信用等级的公告', issued_at: '2026-09-15' },
  previous_ratings: []
};
const withNotice = (patch) => ({ ...base, rating_result_notice: { ...notice, ...patch } });

// 标题以机构开头的评级调整公告：只要含发行人即通过
validateRatingResultNotice(event, withNotice({}), bond);

// 标题不含发行人：仍必须拒绝（不能拿别家公司的公告顶替）
assert.throws(() => validateRatingResultNotice(event, withNotice({
  report_reference: { title: '关于调降某公司信用等级的公告', issued_at: '2026-09-15' }
}), bond), /缺目标代码、发行人或本次原文证据/);

// 出具日与本期评级日不一致：仍拒绝
assert.throws(() => validateRatingResultNotice(event, withNotice({
  report_reference: { ...notice.report_reference, issued_at: '2026-09-16' }
}), bond), /缺目标代码、发行人或本次原文证据/);

// 债码指向别的债：仍拒绝
assert.throws(() => validateRatingResultNotice(event, withNotice({ bond_code: '110082.SH' }), bond), /缺目标代码、发行人或本次原文证据/);

// 缺展望：仍拒绝
assert.throws(() => validateRatingResultNotice(event, { ...withNotice({}), rating_outlook: null }, bond), /缺目标代码、发行人或本次原文证据/);

console.log('RATING-NOTICE-VALIDATOR: 机构开头标题可用、无发行人/错日期/错债码/缺展望仍拒绝');
