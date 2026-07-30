const assert = require('assert');
const fs = require('fs');
const path = require('path');
const service = require('../services/marketCycleMetrics');

assert.strictEqual(service.validMetric('pe'), true);
assert.strictEqual(service.validMetric('pb'), true);
assert.strictEqual(service.validMetric('m2_market_cap'), true);
assert.strictEqual(service.validMetric('buffett'), false);

const lowerCheap = service.metricLadder(10, 20, 'lower_is_cheaper');
assert.deepStrictEqual(lowerCheap.map(row => row.position), [80, 70, 60, 50, 40, 30, 20]);
assert.strictEqual(service.metricRecommendedPosition(9, 10, 20, 'lower_is_cheaper'), 80);
assert.strictEqual(service.metricRecommendedPosition(21, 10, 20, 'lower_is_cheaper'), 20);

const higherCheap = service.metricLadder(300, 450, 'higher_is_cheaper');
assert.deepStrictEqual(higherCheap.map(row => row.position), [20, 30, 40, 50, 60, 70, 80]);
assert.strictEqual(service.metricRecommendedPosition(299, 300, 450, 'higher_is_cheaper'), 20);
assert.strictEqual(service.metricRecommendedPosition(451, 300, 450, 'higher_is_cheaper'), 80);

const stats = service.metricStats([
  { date: '2026-01-01', value: 1 },
  { date: '2026-01-02', value: 2 },
  { date: '2026-01-03', value: 3 },
  { date: '2026-01-04', value: 4 },
  { date: '2026-01-05', value: 5 },
]);
assert.strictEqual(stats.min, 1);
assert.strictEqual(stats.p50, 3);
assert.strictEqual(stats.max, 5);
assert.strictEqual(stats.percentile, 90);
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(service.rangeCutoff('5y', Date.UTC(2026, 6, 30))));
assert.strictEqual(service.rangeCutoff('all'), null);

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
for (const metric of ['graham', 'pe', 'pb', 'm2_market_cap']) {
  assert.ok(html.includes(`data-mv-metric="${metric}"`), `缺少二级Tab ${metric}`);
}
const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'marketVolatility.js'), 'utf8');
assert.ok(route.includes("req.query.metric || 'graham'"), '旧接口未保留 graham 默认值');
assert.ok(route.includes('cycleMetrics.getOverview'), '新指标 overview 未接入');
assert.ok(route.includes('cycleMetrics.getHistory'), '新指标 history 未接入');

const job = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'marketVolatilitySync.js'), 'utf8');
assert.ok(job.includes("tushareQuery('index_dailybasic'"), '未接入指数 PE/PB');
assert.ok(job.includes("tushareQuery('cn_m'"), '未接入 M2');
assert.ok(job.includes("tushareQuery('daily_basic'"), '未接入A股总市值');
assert.ok(job.includes('totalWan / 10000'), 'daily_basic.total_mv 未从万元换算为亿元');
assert.ok(job.includes('ON CONFLICT(trade_date,formula_version)'), 'M2/市值比写入必须幂等');
assert.ok(job.includes("'nbs_via_tushare'"), 'M2未记录国家统计局来源');
assert.ok(job.includes('day > previous'), '月末交易日选择未处理上游倒序返回');
assert.ok(job.includes('/perf/indexCsiDsPe?indexCode='), '中证全指PE未使用中证指数官网历史接口');
assert.ok(!job.includes('tushare_all_a_aggregate_proxy'), '中证全指PB不应使用估算数据');

const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'marketCycleMetrics.js'), 'utf8');
assert.ok(!serviceSource.includes("metric !== 'm2_market_cap'"), 'PE/PB边界调整被错误禁用');
assert.ok(serviceSource.includes('indexPoint:'), '接口未返回对应指数点位');
const frontend = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'market-cycle-metrics.js'), 'utf8');
assert.ok(frontend.includes('mvcIndexLevel') && frontend.includes('点位</th>'), '前端未展示对应指数点位');
assert.ok(frontend.includes('mvcBeginDrag') && frontend.includes("addEventListener('pointerdown'"), 'PE/PB/M2边界线未接入鼠标拖拽');
assert.ok(frontend.includes('setPointerCapture') && frontend.includes('mvcRenderLadder(lower,upper)'), '拖拽未同步仓位阶梯');
assert.ok(frontend.includes('mvcShowTooltip') && frontend.includes("addEventListener('pointermove'"), 'PE/PB/M2历史图未接入鼠标浮框');
assert.ok(frontend.includes('M2：') && frontend.includes('A股总市值：'), 'M2浮框缺少基础数据');
assert.ok(frontend.includes("metric==='pb'&&mvcState.benchmark==='CSIALL')mvcState.benchmark='CSI300'"), 'PB未回退到已支持的沪深300');
assert.ok(frontend.includes("button.hidden=mvcState.metric==='pb'&&button.dataset.mvcBenchmark==='CSIALL'"), 'PB页面仍显示未支持的中证全指');
assert.ok(frontend.includes('未提供PB历史数据'), '中证全指PB缺少官网数据说明');
assert.ok(html.includes('id="mvc-boundary-controls" hidden'), 'PE/PB/M2仍显示边界输入框');
assert.ok(!frontend.includes("getElementById('mvc-boundary-controls').hidden=false"), '边界输入框会被重新显示');

console.log('marketCycleMetrics tests passed');
