const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const pythonCandidates = process.platform === 'win32'
  ? [
      path.join(root, 'ipo-report', 'venv', 'Scripts', 'python.exe'),
      path.join(root, 'venv', 'Scripts', 'python.exe'),
    ]
  : [
      path.join(root, 'ipo-report', 'venv', 'bin', 'python'),
      path.join(root, 'venv', 'bin', 'python'),
    ];
const python = pythonCandidates.find(file => fs.existsSync(file));
if (!python) {
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
const countingParsed = JSON.parse(counting.stdout);
assert.strictEqual(countingParsed.next_eligible_date, '2026-09-14');
assert.strictEqual(countingParsed.lock_declared, true);

const noDurationFixture = '公司于2026年3月7日召开董事会，决定本次不向下修正转股价格。';
const noDuration = spawnSync(python, ['-c', code, modulePath, noDurationFixture], { encoding: 'utf8' });
assert.strictEqual(noDuration.status, 0, noDuration.stderr || noDuration.stdout);
const noDurationParsed = JSON.parse(noDuration.stdout);
assert.strictEqual(noDurationParsed.lock_declared, false);
assert.strictEqual(noDurationParsed.no_revision_evidence, true);
assert.strictEqual(noDurationParsed.next_eligible_date, null);

const explicitRestartFixture = [
  '关于不向下修正康泰转2转股价格的公告。',
  '本次不向下修正康泰转2转股价格。',
  '自2026年8月24日起，若再次触发康泰转2转股价格的向下修正条款，届时公司将按照相关规定履行审议程序。',
  '债券存续期至债券到期日（2027年7月14日）。',
].join('');
const explicitRestart = spawnSync(python, ['-c', code, modulePath, explicitRestartFixture], { encoding: 'utf8' });
assert.strictEqual(explicitRestart.status, 0, explicitRestart.stderr || explicitRestart.stdout);
const explicitRestartParsed = JSON.parse(explicitRestart.stdout);
assert.strictEqual(explicitRestartParsed.lock_declared, false);
assert.strictEqual(explicitRestartParsed.valid_until, '2026-08-23');
assert.strictEqual(explicitRestartParsed.next_eligible_date, '2026-08-24');

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

const quarterBoardFixture = [
  '公司于2026年8月28日召开第五届董事会第十六次会议，审议通过本次不向下修正丝路转债转股价格，',
  '同时，自本次董事会审议通过之日起至公司召开审议《2026年第三季度报告》的董事会会议之日，',
  '如再次触发丝路转债转股价格向下修正条件，公司亦不提出向下修正方案。',
  '下一触发期间从公司召开审议《2026年第三季度报告》的董事会会议之日后一交易日重新起算。',
].join('');
const quarterBoard = spawnSync(python, ['-c', code, modulePath, quarterBoardFixture], { encoding: 'utf8' });
assert.strictEqual(quarterBoard.status, 0, quarterBoard.stderr || quarterBoard.stdout);
const quarterBoardParsed = JSON.parse(quarterBoard.stdout);
assert.strictEqual(quarterBoardParsed.symbolic_lock, true);
assert.strictEqual(quarterBoardParsed.symbolic_reference_type, 'quarterly_report_board_meeting');
assert.strictEqual(quarterBoardParsed.symbolic_report_period, '2026-Q3');
assert.strictEqual(quarterBoardParsed.symbolic_check_from, '2026-11-01');

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

// 已实施下修公告正文也可能声明一段时间内不得再次下修（火星转债样例）。
const implementedLockFixture = [
  '董事会决定将转股价格由33.10元/股向下修正为16.00元/股，修正后的转股价格自2026年8月7日起生效。',
  '自2026年8月6日至2026年9月30日，如再次触发转股价格的向下修正条件，公司将不再进行下修。',
  '下一触发转股价格修正条件的时间从2026年10月1日重新起算。',
].join('');
const implementedLock = spawnSync(python, ['-c', code, modulePath, implementedLockFixture], { encoding: 'utf8' });
assert.strictEqual(implementedLock.status, 0, implementedLock.stderr || implementedLock.stdout);
const implementedLockParsed = JSON.parse(implementedLock.stdout);
assert.strictEqual(implementedLockParsed.valid_until, '2026-09-30');
assert.strictEqual(implementedLockParsed.next_eligible_date, '2026-10-01');
assert.strictEqual(implementedLockParsed.lock_declared, true);
assert.strictEqual(implementedLockParsed.no_revision_evidence, false);

console.log('convertible bond no-revision parser tests passed');
