// 港股 IPO 页面字段契约：验证申购倍数、预计孖展和盘中快照不会再次混成一列。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/ipo.js'), 'utf8');

assert.match(source, /申购期认购倍数（参考）/);
assert.match(source, /申购期预计孖展倍数（每日）/);
assert.match(source, /采集记录/);
assert.match(source, /ipoHkSubscriptionCell\(it\)/);
assert.match(source, /ipoHkLiveOversubscriptionCell\(it\)/);
assert.match(source, /current_subscription_signal/);
assert.match(source, /current_margin_signal/);
assert.match(source, /intraday_signal_history/);
assert.match(source, /暂无可验证数据/);
assert.match(source, /offerPhase/);
assert.match(source, /ipoHkOfferWindowCell/);
assert.match(source, /待官方配发公告/);
assert.match(source, /公布配发结果/);
assert.match(source, /预计 /);
assert.match(source, /function ipoHkListingCell/);
assert.match(source, /listing_date_is_estimated/);
assert.match(source, /关键事实已核实/);
assert.match(source, /官方资料待补/);
assert.match(source, /中文名待补/);
assert.match(source, /来源时间/);
assert.match(source, /本地采集/);
assert.ok(!source.includes('申购期预计孖展倍数（每日）\', \'最终超额认购倍数'), '预计孖展不应继续冒充最终倍数前的唯一动态列');

console.log('OK hk-ipo-frontend-contract: 港股动态信号分栏和已落库变化列表契约通过');
