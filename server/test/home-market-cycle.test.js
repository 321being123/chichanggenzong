const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'home-dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'shared', 'style.css'), 'utf8');

assert.ok(html.includes('id="home-bond-cycle-chart"'), '首页缺少可转债周期图');
assert.ok(html.includes('id="home-graham-chart"'), '首页缺少格雷厄姆指数图');
assert.ok(html.indexOf('<h2>市场周期</h2>') < html.indexOf('<h2>常用工具</h2>'), '首页市场周期应位于常用工具上方');
assert.ok(html.includes('js/home-dashboard.js?v=11'), '首页市场周期脚本静态版本未更新');
assert.ok(js.includes('/api/bond-cycle?range=all'), '首页未读取可转债周期历史数据');
assert.ok(js.includes('/api/market-volatility/history?market=CN&benchmark=CSI300&range=20y'), '首页未读取格雷厄姆指数历史数据');
assert.ok(js.includes('homeBindCycleTooltip'), '首页市场周期图缺少悬浮提示');
assert.ok(js.includes("raw === null || raw === undefined || raw === ''"), '首页周期图未跳过历史空值');
assert.ok(js.includes('currentValue * .75') && js.includes('currentValue * 1.25'), '格雷厄姆指数缺少默认仓位边界');
assert.ok(css.includes('.home-market-cycle-grid') && css.includes('.home-cycle-tooltip'), '首页市场周期图样式缺失');

console.log('home market cycle tests passed');
