const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const parser = require('../services/arbitrageParser');

test('PDF 解析重试入口统一阻止未到期和超过上限的调用', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(parser.getParseRetryDecision({
    parser_version: parser.PARSER_VERSION, parse_status: 'failed', parse_attempts: 2, next_parse_attempt_at: future,
  }, true).reason, 'not_due');
  assert.equal(parser.getParseRetryDecision({
    parser_version: parser.PARSER_VERSION, parse_status: 'failed', parse_attempts: 3, next_parse_attempt_at: null,
  }, true).reason, 'exhausted');
  assert.equal(parser.getParseRetryDecision({
    parser_version: 'old-version', parse_status: 'failed', parse_attempts: 3, next_parse_attempt_at: null,
  }, true).shouldParse, true);
});

test('创维集团复合私有化对价：只按现金计算，公司估值写入备注', () => {
  const code = [
    'import importlib.util, json, sys',
    'spec=importlib.util.spec_from_file_location("arb", sys.argv[1])',
    'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'text="創維集團有限公司公告。創維集團有限公司股份回購計劃。現金選擇，即每股計劃股份兌換港幣4.03元的現金。每股計劃股份理論總額相等於每股計劃股份約港幣10.16元。"',
    'print(json.dumps(m.parse_fields(text), ensure_ascii=False))',
  ].join(';');
  const run = spawnSync(parser.resolvePython(), ['-c', code, parser.SCRIPT], {
    encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.cash_offer_price, 4.03);
  assert.equal(parsed.cash_choice_price, 4.03);
  assert.match(parsed.consideration_note, /10\.16/);
  assert.equal(parsed.clear_offeror_holding_pct, true);
  assert.equal(parsed.clear_offeror, false);
  assert.equal(parsed.offeror, '創維集團有限公司');
  assert.equal(parser.mapParserFields(parsed).offer_price, 4.03);
  assert.match(parser.mapParserFields(parsed).description, /不用于套利空间计算/);
});

test('苏威孚B：B转H现金选择权价格使用港币', () => {
  const code = [
    'import importlib.util, json, sys',
    'spec=importlib.util.spec_from_file_location("arb", sys.argv[1])',
    'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'text="证券代码：000581、200581 证券简称：威孚高科 苏威孚B。现金选择权具体的价格为每股12.68元港币。"',
    'print(json.dumps(m.parse_fields(text, "200581"), ensure_ascii=False))',
  ].join(';');
  const run = spawnSync(parser.resolvePython(), ['-c', code, parser.SCRIPT], {
    encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.target_codes[0], '200581');
  assert.equal(parsed.cash_offer_price, 12.68);
  assert.equal(parsed.cash_choice_price, 12.68);
});

test('苏威孚B：财务顾问代码不应覆盖B股标的代码', () => {
  const parsed = parseSnippet(
    '证券代码：913202。境内上市外资股转换上市地，以介绍方式在香港上市。现金选择权具体的价格为每股12.68元港币。',
    '200581',
  );
  assert.deepEqual(parsed.observed_codes, ['913202']);
  assert.deepEqual(parsed.target_codes, ['200581']);
  assert.equal(parsed.target_code_match, true);
  assert.equal(parsed.cash_choice_price, 12.68);
});

test('港股私有化：现金注销价优先于购股权行使价', () => {
  const code = [
    'import importlib.util, json, sys',
    'spec=importlib.util.spec_from_file_location("arb", sys.argv[1])',
    'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'text="每股计划股份现金注销价3.00港元。购股权的行使价为1.45港元。"',
    'print(json.dumps(m.parse_fields(text), ensure_ascii=False))',
  ].join(';');
  const run = spawnSync(parser.resolvePython(), ['-c', code, parser.SCRIPT], {
    encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).cash_offer_price, 3);
});

function parseSnippet(text, targetCode) {
  const code = [
    'import importlib.util, json, sys',
    'spec=importlib.util.spec_from_file_location("arb", sys.argv[1])',
    'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `text=${JSON.stringify(text)}`,
    `print(json.dumps(m.parse_fields(text, ${JSON.stringify(targetCode || null)}), ensure_ascii=False))`,
  ].join(';');
  const run = spawnSync(parser.resolvePython(), ['-c', code, parser.SCRIPT], {
    encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('中金、信达、东兴：现金选择权与固定换股价分字段、分主体提取', () => {
  const text = [
    '证券代码：601995 证券简称：中金公司。证券代码：601059 证券简称：信达证券。证券代码：601198 证券简称：东兴证券。',
    '中金公司换股吸收合并东兴证券、信达证券。',
    '中金公司异议股东收购请求权价格为每股34.80元，中金公司的A股换股价格为36.91元。',
    '信达证券异议股东收购请求权价格为每股17.79元，信达证券的A股换股价格为19.15元。',
    '东兴证券异议股东收购请求权价格为每股13.13元，东兴证券的A股换股价格为16.14元。',
  ].join(' ');
  const cicc = parseSnippet(text, '601995');
  const cinda = parseSnippet(text, '601059');
  const dongxing = parseSnippet(text, '601198');
  assert.equal(cicc.cash_offer_price, 34.8);
  assert.equal(cicc.target_swap_price, 36.91);
  assert.equal(cinda.cash_offer_price, 17.79);
  assert.equal(cinda.target_swap_price, 19.15);
  assert.equal(dongxing.cash_offer_price, 13.13);
  assert.equal(dongxing.target_swap_price, 16.14);
});

test('吸收合并双方的收购请求权长句按目标公司分别提取', () => {
  const text = [
    '证券代码：600095 证券简称：湘财股份。证券代码：601519 证券简称：大智慧。',
    '湘财股份换股吸收合并大智慧。',
    '湘财股份异议股东收购请求权价格为本次吸收合并定价基准日前120个交易日内股票交易均价，即7.51元/股。',
    '大智慧异议股东现金选择权价格为本次吸收合并定价基准日前120个交易日内股票交易均价，即9.53元/股。',
  ].join(' ');
  assert.equal(parseSnippet(text, '600095').cash_offer_price, 7.51);
  assert.equal(parseSnippet(text, '601519').cash_offer_price, 9.53);
});

test('君亭酒店：要约价格不能被公告中的其他价格替代', () => {
  const parsed = parseSnippet('证券代码：301073 证券简称：君亭酒店。本次要约收购价格为每股人民币25.71元。协议转让价格为每股13.28元。', '301073');
  assert.equal(parsed.cash_offer_price, 25.71);
});

test('换股价格不得写入现金选择权字段', () => {
  const parsed = parseSnippet('证券代码：603213 证券简称：镇洋发展。浙江沪杭甬换股吸收合并镇洋发展。浙江沪杭甬的A股换股价格为13.50元，镇洋发展的A股换股价格为14.58元。现金选择权价格为每股13.21元。', '603213');
  assert.equal(parsed.cash_offer_price, 13.21);
  assert.equal(parsed.target_swap_price, 14.58);
});

test('正式报告中的除权除息调整价优先于历史价格', () => {
  const parsed = parseSnippet([
    '证券代码：601198 证券简称：东兴证券。证券代码：601995 证券简称：中金公司。',
    '中金公司换股吸收合并东兴证券。',
    '东兴证券异议股东现金选择权价格为13.13元，东兴证券的A股换股价格为16.14元。',
    '东兴证券异议股东现金选择权价格调整为13.04元。',
    '东兴证券的A股换股价格调整为16.05元，中金公司的A股换股价格调整为36.68元。',
  ].join(' '), '601198');
  assert.equal(parsed.cash_offer_price, 13.04);
  assert.equal(parsed.target_swap_price, 16.05);
  assert.equal(parsed.reference_swap_price, 36.68);
});

test('供股比例可推导每股所需整数供股权份数并识别临时代码', () => {
  const parsed = parseSnippet('股份代號：01234。供股權代碼：02999。按每持有2股獲發1股供股股份，供股價為每股港幣6.25元。', '01234');
  assert.equal(parsed.rights_units_per_new_share, 2);
  assert.equal(parsed.subscription_price, 6.25);
  assert.deepEqual(parsed.rights_codes, ['02999']);
});
