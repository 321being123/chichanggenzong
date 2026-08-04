const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'home-dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'shared', 'style.css'), 'utf8');
const route = fs.readFileSync(path.join(root, 'server', 'routes', 'marketVolatility.js'), 'utf8');

assert.ok(html.includes('id="home-bond-cycle-chart"'), '首页缺少可转债周期图');
assert.ok(html.includes('id="home-market-chart"'), '首页缺少可配置的股市周期图');
assert.ok(html.indexOf('<h2>市场周期</h2>') < html.indexOf('<h2>常用工具</h2>'), '首页市场周期应位于常用工具上方');
assert.ok(html.includes('js/home-dashboard.js?v=13'), '首页市场周期脚本静态版本未更新');
assert.ok(js.includes('/api/bond-cycle?range=all'), '首页未读取可转债周期历史数据');
assert.ok(js.includes('/api/market-volatility/home-cycle?range=20y'), '首页未读取管理员选择的股市周期指标');
assert.ok(js.includes('renderHomeMarketCycle') && js.includes('homeMarketCycleMetric'), '首页不能根据管理员设置动态绘图');
assert.ok(js.includes('homeBindCycleTooltip'), '首页市场周期图缺少悬浮提示');
assert.ok(js.includes("raw === null || raw === undefined || raw === ''"), '首页周期图未跳过历史空值');
assert.ok(route.includes("router.get('/home-cycle'") && route.includes("router.put('/home-cycle/config', requireCapability('ops_manage')"), '首页指标读取或运维设置接口缺失');
assert.ok(route.includes('const { actualPosition, deviation, hasUsPosition, ...publicOverview }'), '首页接口暴露了管理员账户仓位');
assert.ok(css.includes('.home-market-cycle-grid') && css.includes('.home-cycle-tooltip'), '首页市场周期图样式缺失');

console.log('home market cycle tests passed');
