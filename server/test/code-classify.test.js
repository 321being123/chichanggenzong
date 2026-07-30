const assert = require('assert');
const classifyCode = require('../../public/js/code-classify');

assert.strictEqual(classifyCode('600519.SH').market, 'sh');
assert.strictEqual(classifyCode('000001.SZ').market, 'sz');
assert.strictEqual(classifyCode('920002.BJ').market, 'bj');
assert.strictEqual(classifyCode('BJ920002').market, 'bj');
assert.strictEqual(classifyCode.normalizeCode('920002.BJ'), '920002');
assert.strictEqual(classifyCode.normalizeCode('BJ920002'), '920002');

console.log('code classify tests passed');
