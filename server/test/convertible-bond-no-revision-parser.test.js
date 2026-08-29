const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const python = process.platform === 'win32'
  ? path.join(root, 'venv', 'Scripts', 'python.exe')
  : path.join(root, 'venv', 'bin', 'python');
if (!fs.existsSync(python)) {
  console.log('[SKIP] 未找到项目 Python，跳过不下修公告解析测试');
  process.exit(0);
}

const modulePath = path.join(root, 'server', 'scripts', 'extractConvertibleBondNoRevision.py');
const fixture = [
  '公司于2025年11月5日召开董事会，决定未来六个月内不向下修正。',
  '在此期间之后（自2026年5月5日起重新计算）。',
  '公司于2026年5月26日召开董事会，决定本次不向下修正转股价格，',
  '同时在未来六个月内（自本公告日至2026年11月25日）亦不提出下修方案。',
  '在此期间之后（自2026年11月26日起重新计算）。',
].join('');
const code = [
  'import importlib.util,json,sys',
  'spec=importlib.util.spec_from_file_location("parser",sys.argv[1])',
  'module=importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  'print(json.dumps(module.extract_period(sys.argv[2])))',
].join(';');
const result = spawnSync(python, ['-c', code, modulePath, fixture], { encoding: 'utf8' });
assert.strictEqual(result.status, 0, result.stderr || result.stdout);
const parsed = JSON.parse(result.stdout);
assert.strictEqual(parsed.valid_until, '2026-11-25');
assert.strictEqual(parsed.next_eligible_date, '2026-11-26');
assert.strictEqual(parsed.parser_version, '7');

const relativeFixture = '公司董事会决定本次不向下修正转股价格，下一触发期间从本次董事会召开次日重新起算。特此公告。公司董事会2026年7月21日';
const relative = spawnSync(python, ['-c', code, modulePath, relativeFixture], { encoding: 'utf8' });
assert.strictEqual(relative.status, 0, relative.stderr || relative.stdout);
assert.strictEqual(JSON.parse(relative.stdout).next_eligible_date, '2026-07-22');

const afterFirstTradeFixture = '公司于2026年7月16日召开董事会，决定本次不向下修正转股价格；自2026年7月16日后首个交易日重新起算。';
const afterFirstTrade = spawnSync(python, ['-c', code, modulePath, afterFirstTradeFixture], { encoding: 'utf8' });
assert.strictEqual(afterFirstTrade.status, 0, afterFirstTrade.stderr || afterFirstTrade.stdout);
const afterFirstTradeParsed = JSON.parse(afterFirstTrade.stdout);
assert.strictEqual(afterFirstTradeParsed.valid_until, '2026-07-16');
assert.strictEqual(afterFirstTradeParsed.next_eligible_date, '2026-07-17');

const countingFixture = '公司于2026年7月13日召开董事会，决定未来两个月内不下修，即2026年7月14日至2026年9月13日。自2026年9月14日起算。';
const counting = spawnSync(python, ['-c', code, modulePath, countingFixture], { encoding: 'utf8' });
assert.strictEqual(counting.status, 0, counting.stderr || counting.stdout);
assert.strictEqual(JSON.parse(counting.stdout).next_eligible_date, '2026-09-14');

const symbolicFixture = [
  '公司董事会决定本次不向下修正转股价格。',
  '自本次董事会审议通过之日起至公司2026年半年度董事会会议召开之日，',
  '如再次触发下修条款，董事会亦不提4出向下修正方案。',
  '下一触发期间从该次董事会会议召开之日后一交易日重新起算。',
].join('');
const symbolic = spawnSync(python, ['-c', code, modulePath, symbolicFixture], { encoding: 'utf8' });
assert.strictEqual(symbolic.status, 0, symbolic.stderr || symbolic.stdout);
const symbolicParsed = JSON.parse(symbolic.stdout);
assert.strictEqual(symbolicParsed.lock_declared, true);
assert.strictEqual(symbolicParsed.next_eligible_date, null);

const maturityFixture = [
  '公司于2026年7月21日召开董事会，决定本次不向下修正转股价格；',
  '自本次董事会审议通过后至债券到期日（2026年11月4日），',
  '如再次触发下修条件，亦不提出向下修正方案。',
].join('');
const maturity = spawnSync(python, ['-c', code, modulePath, maturityFixture], { encoding: 'utf8' });
assert.strictEqual(maturity.status, 0, maturity.stderr || maturity.stdout);
const maturityParsed = JSON.parse(maturity.stdout);
assert.strictEqual(maturityParsed.valid_until, '2026-11-04');
assert.strictEqual(maturityParsed.next_eligible_date, '2026-11-05');

console.log('convertible bond no-revision parser tests passed');
