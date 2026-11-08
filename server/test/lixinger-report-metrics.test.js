// 理杏仁财报字段映射：同义字段回退（2026-11-08）
//
// 背景：官方对个别年份只返回同义字段里的另一个名字。生产实测（2026-11-07）601398 的
// 2018/2019 年报、601658 的 2018 年报都只有 ps.npatoshopc，没有 ps.npatshaoehopc；
// 只认单一字段名会把「利润表其实齐全」的年份判成没有归母净利润，进而让年度异常一直挂在
// 待补，整批选股发不出来。这里锁住回退行为，避免以后有人把映射改回单字段。
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { REPORT_METRICS, pickFirstMetric } = require('../dataAccess/adapters/lixingerDatasetAdapter');

// 一、映射登记了同义字段，且主字段在前（先取主字段，保持历史口径不变）
const attr = REPORT_METRICS.income.n_income_attr_p;
assert.ok(Array.isArray(attr), '归母净利必须登记为候选数组，否则单字段缺失就判成"没有归母净利"');
assert.deepStrictEqual(attr, ['ps.npatshaoehopc', 'ps.npatoshopc'],
  '主字段必须排在前面，同义字段作为回退');

// 二、真实形状：只有 ps.npatoshopc（601398 的 2019 年报就是 312,224,000,000）
assert.strictEqual(
  pickFirstMetric({ 'ps.npatoshopc.t': 312224000000 }, attr),
  312224000000,
  '主字段缺失时必须回退到同义字段，不能返回 null',
);

// 三、两个都在时取主字段（不能因为回退把口径换掉）
assert.strictEqual(
  pickFirstMetric({ 'ps.npatshaoehopc.t': 111, 'ps.npatoshopc.t': 999 }, attr),
  111,
  '两个字段都有值时仍取主字段',
);

// 四、两个都没有才是真的没有，返回 null 而不是 0
assert.strictEqual(pickFirstMetric({}, attr), null, '两个字段都缺失时必须返回 null，不能编造 0');
assert.strictEqual(
  pickFirstMetric({ 'ps.npatshaoehopc.t': '', 'ps.npatoshopc.t': null }, attr),
  null,
  '空串与 null 都算缺失',
);

// 五、单字段映射（字符串）不受影响，仍按原样取值
assert.strictEqual(pickFirstMetric({ 'ps.oi.t': 888 }, REPORT_METRICS.income.revenue), 888);
assert.strictEqual(pickFirstMetric({ 'ps.oi.t': 0 }, REPORT_METRICS.income.revenue), 0,
  '0 是有效取值，不能被当成缺失而过继到下一个候选');
assert.strictEqual(pickFirstMetric({}, REPORT_METRICS.income.revenue), null);

// 六、其它三表的标准映射保持单字段，本轮只改归母净利这一项
assert.strictEqual(typeof REPORT_METRICS.income.revenue, 'string');
assert.strictEqual(typeof REPORT_METRICS.balance.total_assets, 'string');
assert.strictEqual(typeof REPORT_METRICS.cashflow.n_cashflow_act, 'string');

console.log('lixinger-report-metrics.test.js 通过');
