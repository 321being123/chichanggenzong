const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const quote = fs.readFileSync(path.join(root, 'public', 'shared', 'core-quote.js'), 'utf8');
const tables = fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert.ok(quote.includes('fetchUnifiedHKRate') && quote.includes('unifiedHkRatePromise'), '持仓页必须只抓取一次统一汇率');
assert.ok(index.includes('await fetchUnifiedHKRate()'), '切换账户时必须套用统一汇率快照');
assert.ok(tables.includes('unifiedHkRate') && tables.includes('todayRate'), '汇率影响计算必须使用统一汇率');

console.log('holdings FX tests passed');
