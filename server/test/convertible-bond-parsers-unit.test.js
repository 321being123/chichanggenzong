// 可转债解析与名称权威单测合并文件（合并原 convertible-bond-lifecycle-parser / report-parser / name-authority）。
'use strict';
(async () => {

  // --- convertible-bond-lifecycle-parser.test.js ---
  await (async () => {
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
// 指定 .env 绝对路径：测试可能以不同的工作目录被拉起（统一入口从项目根运行）。
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
// 解释器统一走项目已有的解析逻辑：PYTHON/IPO_PYTHON_PATH → 项目 venv → PATH，
// 不再硬拼 worktree 内的 venv 路径（worktree 默认不含 venv）。
const { resolvePython } = require('../services/arbitrageDocumentSource');

const root = path.resolve(__dirname, '..', '..');
const python = process.env.IPO_PYTHON_PATH || resolvePython();
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

// 深交所上市公告书「第二节 概览」逐条书写，去空白后简称与下一个条目序号连在一起：
// 「一、可转换公司债券简称：中科转债二、可转换公司债券代码：123289」→ 不得取成「中科转债二」。
const overview = '第二节概览一、可转换公司债券简称：中科转债二、可转换公司债券代码：123289三、可转换公司债券发行量：100,000.00万元';
const sectionResult = spawnSync(python, ['-c', code, script], {
  cwd: root, input: overview, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' },
});
assert.strictEqual(sectionResult.status, 0, sectionResult.stderr || '生命周期解析器执行失败');
const sectionParsed = JSON.parse(sectionResult.stdout);
assert.strictEqual(sectionParsed.bond_name, '中科转债');
assert.strictEqual(sectionParsed.bond_code, '123289');

console.log('convertible bond lifecycle parser tests passed');

  })();

  // --- convertible-bond-report-parser.test.js ---
  await (async () => {
const assert = require('assert');
const { spawnSync } = require('child_process');
// 指定 .env 绝对路径：测试可能以不同的工作目录被拉起（统一入口从项目根运行）。
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
// 解释器优先级：IPO_PYTHON_PATH / PYTHON（本地 .env）→ 项目 venv → 找不到则跳过。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
// 解释器候选：本地 .env 的显式配置优先（worktree 不含 venv），其次项目内 venv。
const python = [
  process.env.IPO_PYTHON_PATH,
  process.env.PYTHON,
  ...(process.platform === 'win32'
    ? [path.join(root, 'venv', 'Scripts', 'python.exe'), path.join(root, 'ipo-report', 'venv', 'Scripts', 'python.exe')]
    : [path.join(root, 'venv', 'bin', 'python'), path.join(root, 'ipo-report', 'venv', 'bin', 'python')]),
].filter(Boolean).find(candidate => fs.existsSync(candidate));
if (!python) {
  console.log('[SKIP] convertible bond report parser: Python venv 不存在');
  return;
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

  })();

  // --- convertible-bond-name-authority.test.js ---
  await (async () => {
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pickAuthoritativeName } = require('../domain/convertibleBondNameRules');

// 官方简称存在时一律以官方为准：公告正文残留「中科转债二」不得覆盖「中科转债」（2026-11-01 事故）。
assert.strictEqual(pickAuthoritativeName('中科转债', '中科转债二'), '中科转债');
assert.strictEqual(pickAuthoritativeName(' 中科转债 ', '中科转债二'), '中科转债');
// 真二期简称与官方简称一致时保持原样。
assert.strictEqual(pickAuthoritativeName('常青转债二', '常青转债二'), '常青转债二');
assert.strictEqual(pickAuthoritativeName('润禾转02', '润禾转债'), '润禾转02');
// 官方简称缺失时退回公告名 / 网上发行简称。
assert.strictEqual(pickAuthoritativeName('', '中科转债'), '中科转债');
assert.strictEqual(pickAuthoritativeName(null, '中科发债'), '中科发债');
assert.strictEqual(pickAuthoritativeName('', ''), '');

// 生命周期同步必须走这条裁决，不能退回「公告解析名优先」。
const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'convertibleBondLifecycleSync.js'), 'utf8');
assert.ok(service.includes('pickAuthoritativeName'), '生命周期同步必须用官方简称裁决名称');
assert.ok(/const name = await authoritativeBondName\(/.test(service), '主档名称必须经 authoritativeBondName 裁决');

console.log('convertible bond name authority tests passed');

  })();
})().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
