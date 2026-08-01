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
assert.ok(job.includes('tushareQuery(\'daily_basic\''), '未接入A股总市值');
assert.ok(job.includes('/ 10000'), 'daily_basic.total_mv 未从万元换算为亿元');
assert.ok(job.includes('/ YUAN_TO_100M'), '统一层 total_market_cap 未从元换算为亿元');
assert.ok(job.includes('getTotalMarketCap(normDate(day))'), '统一层总市值未按目标交易日聚合');
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
assert.ok(frontend.includes("button.textContent='保存中...'") && frontend.includes("showToast('边界保存成功')"), 'PE/PB/M2保存边界缺少进度或成功反馈');
assert.ok(frontend.includes("credentials:'same-origin'"), 'PE/PB/M2保存边界未携带登录凭据');
assert.ok(frontend.includes("window.location.href=api('/login.html?redirect='") && frontend.includes("metric='+mvcState.metric"), '未登录保存边界未跳转登录并保留指标页');
assert.ok(frontend.includes("getElementById('mvc-save').disabled=!valid"), '未登录时保存边界按钮仍不可点击');
assert.ok(html.includes("startParams.get('metric')") && html.includes('switchMarketCycleMetric(requestedMetric)'), '登录返回后未恢复原指标页');
assert.ok(html.includes('id="mv-home" hidden') && html.includes('id="mvc-home" hidden'), '四个指标缺少管理员“设为首页”按钮');
assert.ok(frontend.includes("myProfile.role === 'admin'") && frontend.includes("metricButton.hidden=!admin"), '普通账户仍会显示“设为首页”按钮');
assert.ok(frontend.includes("?'已设为首页':'设为首页'") && frontend.includes('metricButton.disabled=metricCurrent'), '当前首页指标未进入不可点击状态');
assert.ok(frontend.includes("method:'PUT'") && frontend.includes('/home-cycle/config'), '管理员设置首页指标未接入接口');
assert.ok(html.includes('id="mvc-boundary-controls" hidden'), 'PE/PB/M2仍显示边界输入框');
assert.ok(!frontend.includes("getElementById('mvc-boundary-controls').hidden=false"), '边界输入框会被重新显示');

const grahamFrontend = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'market-volatility.js'), 'utf8');
assert.ok(grahamFrontend.includes("button.textContent='保存中...'") && grahamFrontend.includes("showToast('边界保存成功')"), '格雷厄姆指数保存边界缺少进度或成功反馈');
assert.ok(grahamFrontend.includes("credentials:'same-origin'"), '格雷厄姆指数保存边界未携带登录凭据');
assert.ok(grahamFrontend.includes('metric=graham') && grahamFrontend.includes('window.location.href'), '格雷厄姆指数未登录保存未跳转登录');
assert.ok(html.includes("['graham','pe','pb','m2_market_cap'].includes(requestedMetric)"), '登录返回后未恢复格雷厄姆指数页');
assert.ok(grahamFrontend.includes("getElementById('mv-home').onclick") && grahamFrontend.includes("setMarketCycleHome('graham'"), '格雷厄姆指数未接入设为首页');
const sharedStyle = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'shared', 'style.css'), 'utf8');
assert.ok(html.includes('<div class="mv-header">') && html.indexOf('class="mv-header"') < html.indexOf('class="market-volatility-shell'), '股市周期二级导航未移到统一标题栏');
assert.ok(sharedStyle.includes('#main-market-volatility .mv-sub-tab.active::after') && sharedStyle.includes('height: 46px'), '股市周期二级导航未使用统一标签栏样式');
const migrations = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations.js'), 'utf8');
assert.ok(migrations.includes("030_market_cycle_home_setting") && migrations.includes('market_cycle_home_setting'), '首页股市周期唯一设置表迁移缺失');

console.log('marketCycleMetrics tests passed');
