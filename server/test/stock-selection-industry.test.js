// 投资策略选股中心：港股一级行业（恒生行业分类）接入回归。
// 覆盖三件容易出错的事：层级判定（H70/H7020/H702015）、体系与地区选择不可混用、
// 以及"缺一级就算未知"（不能因为拿到二级三级就当成有分类）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    const detail = error && (error.stack || error.message || String(error));
    tests.push(['FAIL', name + ' :: ' + String(detail).split('\n').slice(0, 3).join(' | ')]);
    console.log('  [FAIL] ' + name + ' :: ' + String(detail).split('\n').slice(0, 3).join(' | '));
  }
}

const INDUSTRY = require('../domain/lixingerIndustry');
const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');

// 官方 hk/company/industries 的真实形状：source=hsi，stockCode 是行业代码而不是证券代码。
const HSI_ROWS = [
  { areaCode: 'hk', source: 'hsi', stockCode: 'H70', name: '资讯科技业' },
  { areaCode: 'hk', source: 'hsi', stockCode: 'H7020', name: '软件服务' },
  { areaCode: 'hk', source: 'hsi', stockCode: 'H702015', name: '数码解决方案服务' },
];

// 申万沿用既有代码规则（尾部补零判级），这里只验证"混入港股行不会污染 A 股结果"。
const SW_ROWS = [
  { areaCode: 'cn', source: 'sw_2021', stockCode: '800000', name: '农林牧渔' },
  { areaCode: 'cn', source: 'sw_2021', stockCode: '801100', name: '种植业' },
  { areaCode: 'cn', source: 'cni', stockCode: '399001', name: '国证某行业' },
];

async function main() {
  await check('恒生行业代码按位数判级：H70 一级、H7020 二级、H702015 三级', () => {
    assert.strictEqual(INDUSTRY.hsiLevelOf('H70'), 1);
    assert.strictEqual(INDUSTRY.hsiLevelOf('H7020'), 2);
    assert.strictEqual(INDUSTRY.hsiLevelOf('H702015'), 3);
    assert.strictEqual(INDUSTRY.hsiLevelOf('700'), null);
    assert.strictEqual(INDUSTRY.hsiLevelOf('H7'), null);
  });

  await check('港股行业取到完整三级路径，最深为三级但保留一级节点', () => {
    const result = INDUSTRY.selectIndustryPath(HSI_ROWS, { system: 'hsi', areaCode: 'hk', requireRoot: true });
    assert.ok(result, '完整路径不应为空');
    assert.strictEqual(result.industry_code, 'H702015');
    assert.strictEqual(result.industry, '数码解决方案服务');
    assert.strictEqual(result.industry_system, '恒生行业分类');
    assert.strictEqual(result.industry_level, '3级');
    assert.deepStrictEqual(result.industry_nodes.map(node => [node.code, node.level]),
      [['H70', 1], ['H7020', 2], ['H702015', 3]], '全层级必须都留给标准层落库');
  });

  await check('港股只有二级三级、缺一级时判为无分类（不能当成已核验）', () => {
    const rows = HSI_ROWS.filter(row => row.stockCode !== 'H70');
    assert.strictEqual(INDUSTRY.selectIndustryPath(rows, { system: 'hsi', areaCode: 'hk', requireRoot: true }), null);
  });

  await check('同一级返回两行属歧义，宁可不判也不猜', () => {
    const rows = HSI_ROWS.concat([{ areaCode: 'hk', source: 'hsi', stockCode: 'H7010', name: '另一个二级' }]);
    assert.strictEqual(INDUSTRY.selectIndustryPath(rows, { system: 'hsi', areaCode: 'hk', requireRoot: true }), null);
  });

  await check('A 股读行业不会被港股行污染，申万行为保持原样', () => {
    const mixed = SW_ROWS.concat(HSI_ROWS);
    const result = INDUSTRY.selectIndustryPath(mixed, { system: 'sw_2021', areaCode: 'cn' });
    assert.ok(result);
    assert.strictEqual(result.industry_code, '801100', '国证体系（cni）不得被当成申万');
    assert.deepStrictEqual(result.industry_nodes.map(node => node.code), ['800000', '801100']);
  });

  await check('港股调用带 cn 地区参数时取不到行（体系与地区不可混用）', () => {
    assert.strictEqual(INDUSTRY.selectIndustryPath(HSI_ROWS, { system: 'hsi', areaCode: 'cn', requireRoot: true }), null);
  });

  await check('行业端点按市场分流：港股 hk/company/industries，A 股 cn/company/industries', () => {
    assert.strictEqual(adapter.industryEndpointOf('00700.HK'), 'hk/company/industries');
    assert.strictEqual(adapter.industryEndpointOf('600519.SH'), 'cn/company/industries');
    assert.strictEqual(adapter.industryEndpointOf('000001.SZ'), 'cn/company/industries');
  });

  await check('数据层对港股按 hsi/hk 取分类，且不为港股套用 A 股申万备源', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'dataAccess', 'marketDatasets.js'), 'utf8');
    assert.match(source, /system: 'hsi', areaCode: 'hk', requireRoot: true/, '港股必须显式用恒生体系并要求一级完整');
    assert.match(source, /if \(isHk\) return null;/, 'Tushare 申万成分表不能给港股兜底');
  });

  await check('标准层写入按父子链落全层级，且只顶掉同体系旧归属', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'industryRepository.js'), 'utf8');
    assert.match(source, /parent_id/, '节点必须写父子关系，否则一级行业无法回溯');
    assert.match(source, /AND n\.taxonomy_id = \$1/, '旧归属清理必须限定同一分类体系');
  });

  await check('选股读一级行业沿 parent 链回溯，不再直接要求 level=1 的归属节点', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), 'utf8');
    assert.match(source, /WITH RECURSIVE picked AS/, '需要递归回溯一级行业');
    assert.match(source, /WHERE level = 1/, '最终仍只取一级行业用于行业上限');
  });

  const failed = tests.filter(item => item[0] === 'FAIL');
  console.log(`股票筛选行业分类：${tests.length - failed.length}/${tests.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
