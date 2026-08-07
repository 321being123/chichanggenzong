const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const tables = fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8');
const trade = fs.readFileSync(path.join(root, 'public', 'shared', 'core-trade.js'), 'utf8');
const ledger = fs.readFileSync(path.join(root, 'server', 'services', 'tradeLedger.js'), 'utf8');

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
// 2026-08-07：拆分「股价影响」时必须用真实昨收价，否则行情涨跌幅反推会产生 ~4 元级精度误差，流入「其他变动」
assert.ok(
  tables.includes("previousPriceMap[position.code]"),
  'getTodayProfit 未优先使用 previousPriceMap 真实昨收价'
);
assert.ok(
  tables.includes("previousPriceMap[position.code] != null"),
  'getTodayProfit 未正确判断 previousPriceMap 存在性'
);

console.log('zero quantity position tests passed');
