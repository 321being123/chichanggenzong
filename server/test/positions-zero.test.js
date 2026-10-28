const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const tables = fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8');
const trade = fs.readFileSync(path.join(root, 'public', 'shared', 'core-trade.js'), 'utf8');
const ledger = fs.readFileSync(path.join(root, 'server', 'services', 'tradeLedger.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'repositories', 'tradeLedgerRepository.js'), 'utf8');
const accountsRoute = fs.readFileSync(path.join(root, 'server', 'routes', 'accounts.js'), 'utf8');

// “今日盈亏”必须按行情涨跌计算，不能误用上一条净值快照价格。
// 例如当前价 4.83、行情涨跌 0%、旧快照价 4.81、数量 3000 时，结果应为 0 而不是 +60。
const todayProfitSource = tables.slice(
  tables.indexOf('function getPositionTodayChange'),
  tables.indexOf('// 估值列颜色')
);
const todayProfitSandbox = {
  previousPriceMap: { '600219': 4.81 },
  priceChangeMap: { '600219': 0 },
  data: { hkRate: 0.868 },
  todayCN: () => '2026-10-11'
};
vm.runInNewContext(`${todayProfitSource}; result = getTodayProfit({ code: '600219', price: 4.83, quantity: 3000 });`, todayProfitSandbox);
assert.strictEqual(todayProfitSandbox.result, 0, '涨跌为0%时，今日盈亏不能沿用旧快照价格计算');

todayProfitSandbox.marketForPosition = p => p.subtype === '港股' ? 'HK' : 'CN';
todayProfitSandbox.marketStateSnapshot = {businessDate:'2026-10-11',markets:{
  CN:{businessDate:'2026-10-11',status:'closed'},HK:{businessDate:'2026-10-11',status:'open',isTradingNow:false}
}};
todayProfitSandbox.priceChangeMap = {'600219':2,'00700':1};
vm.runInNewContext(`${todayProfitSource}; cn=getTodayProfit({code:'600219',price:10,quantity:100}); hk=getTodayProfit({code:'00700',subtype:'港股',price:10,quantity:100});`,todayProfitSandbox);
assert.strictEqual(todayProfitSandbox.cn,0,'明确休市不能沿用前一交易日涨跌');
assert(todayProfitSandbox.hk>0,'另一市场开市日盘前、午休或收盘不应强制清零');
assert.strictEqual(todayProfitSandbox.priceChangeMap['600219'],2,'不改原行情缓存');
todayProfitSandbox.marketStateSnapshot.businessDate='2026-10-10';
assert.strictEqual(todayProfitSandbox.getPositionTodayChange({code:'600219'}),2,'旧业务日状态不能清零当天涨跌');
todayProfitSandbox.marketStateSnapshot.businessDate='2026-10-11';
todayProfitSandbox.marketStateSnapshot.markets.CN.status='unknown';
todayProfitSandbox.priceChangeMap['600219']=null;
assert.strictEqual(todayProfitSandbox.getTodayProfit({code:'600219',price:10,quantity:100}),null,'日历未知且缺行情保持未知');

assert.ok(
  tables.includes("filter(function(p) { return Number(p.quantity) > 0; })"),
  '持仓列表未过滤数量为0的历史记录'
);
assert.ok(
  accountsRoute.includes("filter((p) => Number(p.quantity) > 0)"),
  '持仓导出未过滤数量为0的历史记录'
);
// 2026-08-03 账本整改：清仓由服务端统一交易事务处理（recomputeSecurity 重放后数量为 0 → 删除持仓行）。
// 前端不再自行实现清仓逻辑（删除原前端断言的旧实现）。
assert.ok(
  ledger.includes("DELETE FROM positions WHERE username=$1 AND account_name=$2 AND code=$3"),
  '服务端账本事务缺少清仓删除持仓逻辑'
);
assert.ok(
  ledger.includes("sec.quantity > 0"),
  '服务端账本事务缺少数量判断（0 时删除持仓）'
);
assert.ok(
  todayProfitSource.includes('var change = getPositionTodayChange(position);') &&
    !todayProfitSource.includes('previousPriceMap[position.code]'),
  'getTodayProfit 必须使用实时行情涨跌，不能读取净值归因基准价'
);

console.log('zero quantity position tests passed');
