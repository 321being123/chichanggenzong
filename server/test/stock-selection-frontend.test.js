// 股票筛选：前端静态结构测试（不连数据库）。
// 覆盖 2026-11-05 三项页面口径：批次下拉只列已发布组合、证券名称可跳证券分析、PE 展示统一 TTM。
// 写法与既有 *-frontend.test.js 一致：读源码断言，不做 DOM 渲染。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const view = fs.readFileSync(path.join(root, 'public', 'js', 'stock-selection.js'), 'utf8');
const presenter = fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'stock-selection-presenter.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'stock-selection.css'), 'utf8');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { results.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

console.log('A. 批次下拉只列已发布组合');
check('页面请求批次时带 published=1，未发布预览不再进入下拉', () => {
  assert.ok(/listRuns\(\{ market: ssState\.market, published: '1'/.test(presenter), '批次请求必须带 published=1');
});
check('批次标签不再把个人测算标成未发布', () => {
  assert.ok(/run\.runKind === 'personal' \? '' :/.test(view), '个人测算批次不应重复标未发布');
});
check('空列表文案区分「暂无已发布组合」与港股缺数据', () => {
  assert.ok(view.includes('暂无已发布组合'), '空下拉文案应为「暂无已发布组合」');
  assert.ok(presenter.includes('本地暂无港股个股行情与估值数据'), '港股空列表必须说明缺的是数据');
});

console.log('B. 证券名称跳转证券分析');
check('候选表与组合表的证券名称都渲染成跳转入口', () => {
  const hits = view.match(/data-ss-analysis="/g) || [];
  assert.ok(hits.length >= 2, '候选表与目标组合表都要有 data-ss-analysis');
});
check('点击名称走 openInAnalysis，点击行其它位置仍开本页详情', () => {
  assert.ok(view.includes('StockSelectionPresenter.openInAnalysis('), '名称点击必须调用 openInAnalysis');
  assert.ok(view.includes('StockSelectionPresenter.openStock('), '行点击仍保留本页详情');
  assert.ok(/var jump = event\.target\.closest\('\[data-ss-analysis\]'\);\s*\n\s*if \(jump && window\.StockSelectionPresenter\)/.test(view),
    '必须先判断名称入口再判断整行，否则点名称会被行点击吃掉');
});
check('openInAnalysis 切页后复用证券分析既有入口', () => {
  assert.ok(/async function ssOpenInAnalysis/.test(presenter), '缺少 openInAnalysis');
  assert.ok(presenter.includes("switchMain('stock-analysis')"), '必须先切到证券分析页');
  assert.ok(presenter.includes('securityAnalysisSubmit(raw'), '必须复用证券分析既有提交入口，不另建取数链路');
  assert.ok(/openInAnalysis: ssOpenInAnalysis/.test(presenter), '必须导出给 View 调用');
});
check('名称入口有链接样式，不依赖鼠标悬停才能识别', () => {
  assert.ok(/\.ss-stock-link\s*\{[^}]*cursor:\s*pointer/.test(css), '缺少 .ss-stock-link 样式');
});

console.log('C. PE 统一 TTM');
check('候选表表头与详情都标 PE（TTM）', () => {
  assert.ok(view.includes('PE（TTM）</th>'), '表头必须写 PE（TTM）');
  assert.ok(view.includes("' · PE（TTM） '"), '详情面板必须写 PE（TTM）');
  assert.ok(!view.includes('静态 PE'), '页面不应再出现静态 PE 字样');
});
check('页面规则说明同步为 PE（TTM）排名', () => {
  assert.ok(html.includes('PB 升序、PE（TTM）升序、股息率降序'), '规则说明必须与排名口径一致');
  assert.ok(!html.includes('静态 PE 升序'), '规则说明不得保留旧口径');
});

const pass = results.filter(item => item[0] === 'PASS').length;
const fail = results.length - pass;
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
