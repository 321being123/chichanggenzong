const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const python = process.platform === 'win32'
  ? path.join(root, 'venv', 'Scripts', 'python.exe')
  : path.join(root, 'venv', 'bin', 'python');
if (!fs.existsSync(python)) {
  console.log('[SKIP] convertible bond report parser: Python venv 不存在');
  process.exit(0);
}

const fixture = `前十名转债持有人情况如下：
序号
1
某银行－稳健债券型
其他
100,000
10,000,000.00
5.00%
证券投资基金
2
张三
境内自然人
80,000
8,000,000.00
4.00%
3、报告期转债变动情况`;
const script = path.join(root, 'server', 'scripts', 'extractConvertibleBondFundHoldings.py');
const result = spawnSync(python, [script, '--stdin'], {
  input: fixture, encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONUTF8: '1' }),
});
assert.strictEqual(result.status, 0, result.stderr);
const parsed = JSON.parse(result.stdout);
assert.strictEqual(parsed.fund_count, 1);
assert.strictEqual(parsed.holding_quantity, 10);
assert.strictEqual(parsed.holding_market_value, 1000);
assert.strictEqual(parsed.remain_size_ratio, 0.05);
assert.ok(parsed.holders[0].name.includes('证券投资基金'));
console.log('convertible bond report parser tests passed');
