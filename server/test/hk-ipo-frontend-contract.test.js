// 港股 IPO 页面字段契约：验证申购倍数、预计孖展和盘中快照不会再次混成一列。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/ipo.js'), 'utf8');

assert.match(source, /申购期认购倍数（已验证）/);
assert.match(source, /申购期预计孖展倍数（每日）/);
assert.match(source, /盘中变化（已落库）/);
assert.match(source, /ipoHkSubscriptionCell\(it\)/);
assert.match(source, /ipoHkLiveOversubscriptionCell\(it\)/);
assert.match(source, /current_subscription_signal/);
assert.match(source, /current_margin_signal/);
assert.match(source, /intraday_signal_history/);
assert.match(source, /暂无可验证数据/);
assert.match(source, /来源时间/);
assert.match(source, /本地采集/);
assert.ok(!source.includes('申购期预计孖展倍数（每日）\', \'最终超额认购倍数'), '预计孖展不应继续冒充最终倍数前的唯一动态列');

console.log('OK hk-ipo-frontend-contract: 港股动态信号分栏和已落库变化列表契约通过');
