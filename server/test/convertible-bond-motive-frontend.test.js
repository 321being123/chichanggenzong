const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const service = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondRevisionMotiveService.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'bond-revision-motive.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'js', 'bond-revision-motive.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'bond-revision-motive.css'), 'utf8');

assert.ok(service.includes("tushareQuery('top10_cb_holders'") && service.includes("tushareQuery('pledge_stat'"), '持有人和质押同步接口缺失');
assert.ok(!service.includes('TUSHARE_ENABLE_5000_ENDPOINTS') && service.includes("dataset: 'top10_cb_holders'") && service.includes("dataset: 'pledge_stat'"), '持有人和质押同步不应被同一个权限开关整体拦截');
assert.ok(service.includes('holderStopError') && service.includes('pledgeStopError') && service.includes('RATE_LIMIT') && service.includes('CIRCUIT_OPEN') && service.includes('md.trade_date'), '同步任务应区分单对象空结果与接口限速并只处理当前行情候选');
assert.ok(service.includes('raw_records') && service.includes('sync_cursors'), '同步任务缺少原始响应或游标留痕');
assert.ok(service.includes('hold_amount,hold_ratio') && service.includes('pledge_count,unrest_pledge,rest_pledge,total_share,pledge_ratio'), 'Tushare字段契约未锁定');
assert.ok(!service.includes("top10_cb_holders', holderParams, 'ts_code,end_date,ann_date") && !service.includes("pledge_stat', pledgeParams, 'ts_code,end_date,pledge_amount"), '不得请求接口不支持的字段');
assert.ok(service.includes('announced_at IS NOT NULL AND announced_at <= $2'), '历史评分必须按公告可见日隔离');
assert.ok(service.includes('same report period') || service.includes('同一报告期'), '财务指标应锁定同一报告期');
assert.ok(html.includes('motive-inputs') && !html.includes('motive-sources') && html.includes('返回可转债监控'), '详情页结构不完整');
assert.ok(html.includes('href="/?main=bond-safety&sub=revision"') && html.indexOf('bond-motive-back') < html.indexOf('bond-feature-hero'), '返回链接应位于蓝色标题外');
assert.ok(script.includes('raw_value') && script.includes('input_snapshot') && script.includes('financialText') && script.includes('cycleText') && script.includes('proposalHistoryText') && !script.includes('motive-json'), '详情页原始输入展示不符合要求');
assert.ok(script.includes('motive-core') && script.includes('dimensionNames') && script.includes('calculations'), '详情页缺少核心动机或五维计算项');
assert.ok(script.includes('bond_price_percentile') && script.includes('remain_issue_ratio') && script.includes('market_cap') && script.includes('亿元') && script.includes("toFixed(2)"), '详情页未格式化百分位、比例、金额或年数');
assert.ok(script.includes("'false': '否'") && script.includes('displayText'), '详情页仍可能展示英文状态值');
assert.ok(!script.includes('sourceCell') && !script.includes('source_references'), '详情页不应展示来源引用');
assert.ok(css.includes('.motive-calculations') && !css.includes('.motive-json'), '详情页计算项或JSON样式不符合要求');
assert.ok(!script.includes('Tushare') && !script.includes('tushareQuery'), '详情页不得调用外部数据接口');

console.log('convertible-bond-motive-frontend.test.js 通过');
