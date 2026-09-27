// 港股 IPO 页面字段契约：验证申购倍数、预计孖展和盘中快照不会再次混成一列。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/ipo.js'), 'utf8');

assert.match(source, /申购期认购倍数（参考）/);
assert.match(source, /申购期预计孖展倍数（每日）/);
assert.ok(!source.includes('采集记录'), '采集快照应保留在后台记录中，不在历史表格逐条展示');
assert.match(source, /ipoHkSubscriptionCell\(it\)/);
assert.match(source, /ipoHkLiveOversubscriptionCell\(it\)/);
assert.match(source, /current_subscription_signal/);
assert.match(source, /current_margin_signal/);
assert.ok(!source.includes('intraday_signal_history'), '历史快照数组不应渲染到打新历史表格');
assert.ok(!source.includes('可能过期'), '申购倍数显示中不应出现可能过期提示');
assert.match(source, /暂无可验证数据/);
assert.match(source, /offerPhase/);
assert.match(source, /ipoHkOfferWindowCell/);
assert.match(source, /待官方配发公告/);
assert.match(source, /phase === 'postponed'.*全球发售及上市已延期/);
assert.match(source, /发售延期，无官方最终倍数/);
assert.match(source, /发售已延期，等待新安排/);
assert.match(source, /公布配发结果/);
assert.match(source, /预计 /);
assert.match(source, /function ipoHkListingCell/);
assert.match(source, /listing_date_is_estimated/);
assert.match(source, /关键事实已核实/);
assert.match(source, /官方资料待补/);
assert.match(source, /中文名待补/);
assert.match(source, /来源时间/);
assert.match(source, /本地采集/);
assert.ok(source.includes("'申购期认购倍数（参考）', '申购期预计孖展倍数（每日）', '最终超额认购倍数'"),
  '历史页应分别展示申购期认购参考、预计孖展和官方最终超购');

console.log('OK hk-ipo-frontend-contract: 港股动态信号显示和隐藏采集历史契约通过');
