const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const tables = fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8');
const trade = fs.readFileSync(path.join(root, 'public', 'shared', 'core-trade.js'), 'utf8');
const ledger = fs.readFileSync(path.join(root, 'server', 'services', 'tradeLedger.js'), 'utf8');

// “今日盈亏”必须按行情涨跌计算，不能误用上一条净值快照价格。
// 例如当前价 4.83、行情涨跌 0%、旧快照价 4.81、数量 3000 时，结果应为 0 而不是 +60。
const todayProfitSource = tables.slice(
  tables.indexOf('function getTodayProfit'),
  tables.indexOf('// 估值列颜色')
);
const todayProfitSandbox = {
  previousPriceMap: { '600219': 4.81 },
  priceChangeMap: { '600219': 0 },
  data: { hkRate: 0.868 }
};
vm.runInNewContext(`${todayProfitSource}; result = getTodayProfit({ code: '600219', price: 4.83, quantity: 3000 });`, todayProfitSandbox);
assert.strictEqual(todayProfitSandbox.result, 0, '涨跌为0%时，今日盈亏不能沿用旧快照价格计算');

assert.ok(
  tables.includes("filter(function(p) { return Number(p.quantity) > 0; })"),
  '持仓列表未过滤数量为0的历史记录'
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
  todayProfitSource.includes('var change = priceChangeMap[position.code];') &&
    !todayProfitSource.includes('previousPriceMap[position.code]'),
  'getTodayProfit 必须使用实时行情涨跌，不能读取净值归因基准价'
);

console.log('zero quantity position tests passed');
