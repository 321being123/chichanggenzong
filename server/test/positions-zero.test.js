const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const tables = fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8');
const trade = fs.readFileSync(path.join(root, 'public', 'shared', 'core-trade.js'), 'utf8');

assert.ok(
  tables.includes("filter(function(p) { return Number(p.quantity) > 0; })"),
  '持仓列表未过滤数量为0的历史记录'
);
assert.ok(
  trade.includes("if (existing.quantity <= 0) data.positions = data.positions.filter"),
  '批量或导入交易清仓后未删除持仓'
);

console.log('zero quantity position tests passed');
