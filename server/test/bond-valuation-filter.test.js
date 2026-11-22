const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', '..');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const pageCss = fs.readFileSync(path.join(root, 'public', 'css', 'bond-valuation.css'), 'utf8');
const sharedCss = fs.readFileSync(path.join(root, 'public', 'shared', 'style.css'), 'utf8');
const view = fs.readFileSync(path.join(root, 'public', 'js', 'bond-valuation.js'), 'utf8');

// #47：估值筛选必须保持原生下拉语义，且共享箭头样式不被页面背景简写覆盖。
const evalSelect = index.match(/<select id="bond-val-eval"[\s\S]*?<\/select>/);
assert.ok(evalSelect, '估值筛选必须是 select 下拉框');
assert.ok(evalSelect[0].includes('aria-label="按估值结果筛选"'), '估值筛选必须有明确的估值语义');
assert.ok(evalSelect[0].includes('<option value="">全部估值</option>'), '首项必须显示“全部估值”');
assert.ok(!evalSelect[0].includes('全部评价'), '不得继续使用含混的“全部评价”文案');
for (const id of ['bond-val-safety', 'bond-val-alert', 'bond-val-data']) {
  assert.ok(new RegExp('<select id="' + id + '"').test(index), `${id} 必须保持下拉框，不能退化成按钮`);
}
const toolbarRule = pageCss.match(/\.bond-val-toolbar select \{[^}]*\}/);
assert.ok(toolbarRule && toolbarRule[0].includes('background-color:'), '页面样式必须用 background-color，保留共享箭头背景图');
assert.ok(!/\.bond-val-toolbar select \{[^}]*background:\s*var/.test(pageCss), '不得用 background 简写清除箭头');
const arrowRuleStart = sharedCss.indexOf('/* 下拉框统一箭头与搜索框统一图标 */');
const arrowRule = arrowRuleStart >= 0 ? sharedCss.slice(arrowRuleStart, sharedCss.indexOf('}', arrowRuleStart)) : '';
assert.ok(arrowRule.includes('.bond-val-toolbar select') && arrowRule.includes("url('/shared/icons/chevron-down.svg')"),
  '共享样式必须继续为估值筛选提供下拉箭头');
assert.ok(view.includes("final_evaluation: (document.getElementById('bond-val-eval') || {}).value || ''"),
  '估值筛选仍必须参与组合筛选');
assert.ok(view.includes("'bond-val-search', 'bond-val-eval', 'bond-val-safety', 'bond-val-alert', 'bond-val-data'"),
  '清除筛选必须覆盖估值筛选');
assert.ok(/@media \(max-width:760px\)[\s\S]*?\.bond-val-toolbar input\[type=search\], \.bond-val-toolbar select \{[^}]*min-height: 44px; height: 44px; font-size: 16px;/.test(pageCss),
  '手机端估值筛选必须保留 44px 触控高度和 16px 字号');
assert.ok(!/\.bond-val-toolbar select \{[^}]*padding-right/.test(toolbarRule[0]),
  '局部样式不得覆盖共享选择器的 30px 右留白');

// 真实 CSS 级联：箭头图的 16px 图标位于右侧 9px，文本区必须保留 30px 右留白。
const dom = new JSDOM('<!doctype html><html><head><style>' + sharedCss + '</style><style>' + pageCss + '</style></head><body>' +
  '<div class="bond-val-toolbar"><select id="bond-val-data"><option>全部价格数据</option></select></div></body></html>');
const select = dom.window.document.getElementById('bond-val-data');
const computed = dom.window.getComputedStyle(select);
assert.strictEqual(computed.paddingRight, '30px', '估值筛选必须保留共享 30px 右留白，箭头不得侵入文本区');
assert.strictEqual(computed.paddingLeft, '10px');
assert.ok(computed.backgroundImage.includes('chevron-down.svg'), '估值筛选必须显示共享下拉箭头');

console.log('bond valuation filter select tests passed');
