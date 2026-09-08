const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const python = process.env.IPO_PYTHON_PATH || path.join(root, 'venv', 'Scripts', 'python.exe');
const script = path.join(root, 'server', 'scripts', 'extractConvertibleBondLifecycle.py');
const sample = [
  '股票代码：301459 股票简称：丰茂股份',
  '债券代码：123283 债券简称：丰茂转债',
  '上市日期：2026年9月9日 发行规模：6.075亿元',
  '网上申购日（T日）：2026年9月8日 原股东优先配售股权登记日：2026年9月7日',
].join('\n');
const code = [
  'import importlib.util,json,sys',
  'spec=importlib.util.spec_from_file_location("l",sys.argv[1])',
  'mod=importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  'print(json.dumps(mod.parse_text(sys.stdin.read()),ensure_ascii=False))',
].join(';');
const result = spawnSync(python, ['-c', code, script], {
  cwd: root, input: sample, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' },
});
assert.strictEqual(result.status, 0, result.stderr || '生命周期解析器执行失败');
const parsed = JSON.parse(result.stdout);
assert.strictEqual(parsed.bond_code, '123283');
assert.strictEqual(parsed.bond_name, '丰茂转债');
assert.strictEqual(parsed.stock_code, '301459');
assert.strictEqual(parsed.stock_name, '丰茂股份');
assert.strictEqual(parsed.listing_date, '2026-09-09');
assert.strictEqual(parsed.online_date, '2026-09-08');
assert.strictEqual(parsed.shareholder_record_date, '2026-09-07');
assert.strictEqual(parsed.issue_scale, 6.075);
console.log('convertible bond lifecycle parser tests passed');
