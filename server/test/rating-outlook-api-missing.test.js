// 接口来源缺展望不算缺项；原文来源缺展望仍必须判不完整（0.8.4.30）
const assert = require('assert');
const { ratingRequirement } = require('../services/convertibleBondAnalysisInputs');
const bond = { instrument_id: 1, ts_code: '110081.SH', stock_code: '600745.SH', bond_short_name: '闻泰转债' };
const docs = [];
const base = { rating: 'BBB-', rating_date: '2026-09-15', announced_at: '2026-09-17', rating_company: '中诚信',
  raw_payload: { ts_code: '110081.SH', ann_date: '20260917', rating_way: 'api', rating: 'BBB-', rating_com_name: '中诚信', rating_date: '2026-09-15' } };
const apiMissing = { ...base, raw_payload: { ...base.raw_payload, rating_outlook: '', outlook_status: 'api_unavailable' } };
const originalMissing = { ...base, raw_payload: { ...base.raw_payload, rating_outlook: '' } };
assert.strictEqual(ratingRequirement(bond, [apiMissing], docs, '2026-10-24').latest_complete, true, '接口缺展望可判完整');
assert.strictEqual(ratingRequirement(bond, [apiMissing], docs, '2026-10-24').outlook_status, 'api_unavailable');
assert.strictEqual(ratingRequirement(bond, [originalMissing], docs, '2026-10-24').latest_complete, false, '原文缺展望仍不完整');
console.log('RATING-OUTLOOK-API: 接口缺展望放行、原文缺展望仍拒绝');
