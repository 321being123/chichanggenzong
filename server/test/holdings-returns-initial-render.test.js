const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const source = file => fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8');
assert(source('index.html').includes('shared/core-account.js?v=__APP_VERSION__'), '账户渲染脚本必须跟随应用版本，避免旧缓存继续漏绘');
let checks = 0;
for (const width of [320, 360, 390, 430, 760, 768, 900, 1024, 1440]) {
  const dom = new JSDOM('<div id="returns-section"></div><canvas id="chart-earnings-returns"></canvas>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.innerWidth = width;
  w.NavMath = { isExternalTransfer: () => true };
  w.fmt = n => '¥' + n.toFixed(2);
  w.appChartTooltip = opts => opts;
  let requests = 0;
  w.fetch = () => { requests++; throw new Error('绘图不得取数'); };
  w.HTMLCanvasElement.prototype.getContext = function () { return { canvas: this }; };
  w.Chart = function (ctx, config) {
    this.canvas = ctx.canvas;
    this.data = config.data;
    this.destroy = () => { this.destroyed = true; };
  };
  // 读取脚本实际的词法图表缓存，不使用同名 window 属性替代真实状态。
  w.eval(source('shared/core-returns.js') + '\nwindow.chartMap = chartMap; returnMode = "all";');
  w.eval(source('shared/core-account.js') + '\nearnReturnMode = "all";');
  for (const name of ['renderHomeHoldings', 'renderStats', 'renderCharts', 'renderPositionsTable', 'renderTrades']) w[name] = () => {};
  // 保留收益页实际共用的绘图入口，省略本用例无关的表格与资产图。
  w.renderEarnings = () => w.renderEarningsReturnsChart();
  const account = multiplier => ({
    navHistory: [{ date: '2026-10-08', nav: 1, totalAsset: 100 }, { date: '2026-10-09', nav: multiplier, totalAsset: 100 * multiplier }],
    indexHistory: [{ date: '2026-10-08', '沪深300': 4000 }, { date: '2026-10-09', '沪深300': 4040 }],
    cashFlows: []
  });
  // 完整数据到齐后首次进入持仓：只走真实全量渲染，不点击周期。
  w.data = account(1.1);
  w.renderAll();
  assert(w.chartMap['chart-returns'], '首次进入必须创建收益走势图'); checks++;
  assert.deepStrictEqual(Array.from(w.chartMap['chart-returns'].data.datasets[0].data), [1, 1.1]); checks++;
  assert.equal(w.chartMap['chart-returns'].data.datasets[1].label, '沪深300'); checks++;
  // 切换账户：销毁旧图并显示新账户数据，两处收益图一致。
  const previous = w.chartMap['chart-returns'];
  w.data = account(1.2);
  w.renderAll();
  assert(previous.destroyed); checks++;
  assert.equal(w.chartMap['chart-returns'].data.datasets[0].data[1], 1.2); checks++;
  assert.equal(w.chartMap['chart-earnings-returns'].data.datasets[0].data[1], 1.2); checks++;
  // 摘要/空账户后完整数据到达：清理旧曲线，恢复完整数据后直接绘图。
  w.data = { navHistory: [], cashFlows: [] };
  w.renderAll();
  assert.equal(w.chartMap['chart-returns'], null); checks++;
  w.data = account(1.3);
  w.renderAll();
  assert.equal(w.chartMap['chart-returns'].data.datasets[0].data[1], 1.3); checks++;
  w.renderAll();
  assert.equal(w.chartMap['chart-returns'].data.datasets[0].data[1], 1.3); checks++;
  assert.equal(requests, 0, '首次绘图、账户切换和重入不得额外取数'); checks++;
  w.close();
}
console.log(`holdings returns initial render: ${checks} DOM/Chart contract checks passed across nine widths; no browser/layout claims`);
