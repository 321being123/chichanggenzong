// 理杏仁行业分类选体系/判级的纯函数验收（不发网络、不连数据库）。
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { selectIndustryPath } = require('../domain/lixingerIndustry');

// 2026-10-30 官方 cn/company/industries 对 600519 的真实返回（三套体系混排）。
const rows600519 = [
  { areaCode: 'cn', stockCode: '340000', source: 'sw_2021', name: '食品饮料' },
  { areaCode: 'cn', stockCode: '340500', source: 'sw_2021', name: '白酒' },
  { areaCode: 'cn', stockCode: '340501', source: 'sw_2021', name: '白酒' },
  { areaCode: 'cn', stockCode: '340000', source: 'sw', name: '食品饮料' },
  { areaCode: 'cn', stockCode: '340300', source: 'sw', name: '饮料制造' },
  { areaCode: 'cn', stockCode: '340301', source: 'sw', name: '白酒' },
  { areaCode: 'cn', stockCode: 'C050302', source: 'cni', name: '饮料' },
  { areaCode: 'cn', stockCode: 'C0503', source: 'cni', name: '食品饮料与烟草' },
  { areaCode: 'cn', stockCode: 'C05', source: 'cni', name: '主要消费' },
];

const picked = selectIndustryPath(rows600519);
assert.strictEqual(picked.industry, '白酒');
assert.strictEqual(picked.industry_system, '申万2021');
assert.strictEqual(picked.industry_level, '3级');
assert.deepStrictEqual(picked.industry_path, ['食品饮料', '白酒', '白酒']);
assert.strictEqual(picked.industry_code, '340501');

// 只给申万2021，不受 sw / cni 干扰；行业代码非6位（如 cni）不参与判级。
assert.deepStrictEqual(selectIndustryPath(rows600519.filter(r => r.source === 'cni')), null);
assert.strictEqual(selectIndustryPath(rows600519, { system: 'cni' }), null);

// 同一级出现两行 = 歧义，返回 null 保留原来源，不猜。
assert.strictEqual(selectIndustryPath([
  { areaCode: 'cn', stockCode: '110000', source: 'sw_2021', name: '农林牧渔' },
  { areaCode: 'cn', stockCode: '220000', source: 'sw_2021', name: '基础化工' },
]), null);

// 只有一级时按一级返回。
const levelOne = selectIndustryPath([{ areaCode: 'cn', stockCode: '340000', source: 'sw_2021', name: '食品饮料' }]);
assert.strictEqual(levelOne.industry_level, '1级');
assert.deepStrictEqual(levelOne.industry_path, ['食品饮料']);

// 空数据、非数组、脏数据都返回 null，不抛异常。
assert.strictEqual(selectIndustryPath([]), null);
assert.strictEqual(selectIndustryPath(null), null);
assert.strictEqual(selectIndustryPath([{ source: 'sw_2021', stockCode: 'bad', name: '' }]), null);
assert.strictEqual(selectIndustryPath([{ source: 'sw_2021', stockCode: '340000', name: '   ' }]), null);

console.log('lixinger-industry.test.js 通过');
