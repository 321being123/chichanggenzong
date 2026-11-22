const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public', 'shared', 'core-account.js'), 'utf8');

function renderCards(record) {
  const dom = new JSDOM('<!doctype html><html><body><div id="earnings-stats"></div><div id="earnings-table"></div></body></html>');
  const context = {
    window: dom.window,
    document: dom.window.document,
    buildRealReturnsSeries: () => [record],
    fmt: value => Number(value).toFixed(2),
  };
  dom.window.SiteChartTheme = {
    get: () => ({ up: '#dc2626', down: '#059669', textMuted: '#64748b', textPrimary: '#0f172a' }),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  // 只验证卡片着色，不让图表实现参与；函数声明在脚本加载后覆盖，需在运行后替换。
  context.renderEarningsReturnsChart = () => {};
  context.renderEarningsChart = () => {};
  context.renderEarningsTable = () => {};
  context.renderEarnings();
  return dom.window.document.getElementById('earnings-stats');
}

function cardColor(container, label) {
  const cards = [...container.querySelectorAll('.stat-card')];
  const card = cards.find(node => node.querySelector('.label').textContent === label);
  assert.ok(card, `缺少卡片：${label}`);
  return { value: card.querySelector('.value').textContent.trim(), color: card.querySelector('.value').getAttribute('data-style') };
}

// #48：回撤是负向指标，按站内涨红跌绿显示；零和缺失必须中性。
const negative = renderCards({ date: '2026-11-22', totalMarketValue: 100, totalInvested: 100, nav: 1, totalReturn: -0.05, capitalGain: -5, annualizedReturn: -0.05, yearReturn: -0.03, currentDrawdown: -0.05, maxDrawdown: -0.12 });
const current = cardColor(negative, '当前回撤');
const max = cardColor(negative, '最大回撤');
const year = cardColor(negative, '今年收益');
assert.strictEqual(current.value, '-5.00%');
assert.strictEqual(max.value, '-12.00%');
assert.strictEqual(current.color, 'color:#059669', '负的当前回撤必须为绿色');
assert.strictEqual(max.color, 'color:#059669', '负的最大回撤必须为绿色');
assert.strictEqual(year.color, 'color:#059669', '负的今年收益保持绿色，作为同页口径对照');

const neutral = renderCards({ date: '2026-11-22', totalMarketValue: 100, totalInvested: 100, nav: 1, totalReturn: 0, capitalGain: 0, annualizedReturn: 0, yearReturn: 0, currentDrawdown: 0, maxDrawdown: null });
assert.strictEqual(cardColor(neutral, '当前回撤').color, 'color:#64748b', '零回撤必须中性');
assert.strictEqual(cardColor(neutral, '最大回撤').color, 'color:#64748b', '缺失回撤必须中性');
assert.strictEqual(cardColor(neutral, '最大回撤').value, '—');

console.log('earnings drawdown color tests passed');
