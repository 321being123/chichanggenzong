const assert = require('assert');
const fs = require('fs');
const path = require('path');
const classifyCode = require('../../public/js/code-classify');

assert.strictEqual(classifyCode('600519.SH').market, 'sh');
assert.strictEqual(classifyCode('000001.SZ').market, 'sz');
assert.strictEqual(classifyCode('920002.BJ').market, 'bj');
assert.strictEqual(classifyCode('BJ920002').market, 'bj');
assert.strictEqual(classifyCode.normalizeCode('920002.BJ'), '920002');
assert.strictEqual(classifyCode.normalizeCode('BJ920002'), '920002');
assert.strictEqual(classifyCode('000152', '深圳国际').subtype, '港股');
assert.strictEqual(classifyCode.normalizeCode('000152', '深圳国际'), '00152');
assert.strictEqual(classifyCode.normalizeCode('000152', '山航B'), '000152');

const accountsDb = fs.readFileSync(path.resolve(__dirname, '..', 'db', 'accounts.js'), 'utf8');
assert(/positions: dedupeByKey\(data\.positions \|\| \[\], 'id'\)\.map\(normalizeSecurityRow\)/.test(accountsDb));
assert(/trades: dedupeByKey\(data\.trades \|\| \[\], 'id'\)\.map\(normalizeSecurityRow\)/.test(accountsDb));
assert(/correctedHkAlias[\s\S]*quote_currency: 'HKD'/.test(accountsDb));

console.log('code classify tests passed');
