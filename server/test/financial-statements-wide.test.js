// 理杏仁三表科目字典 + 宽表迁移 + 落库列映射专项（2026-11-03）。
//
// 背景：此前只向来源要 17 个指标、只落 20 个标准科目；官方同接口能给三表上百科目。
// 本文件锁住三件事：
//   1) A股（CAS）与港股（HKFRS）科目集必须分开，禁止互相套用；
//   2) 单只股票一次最多 128 个指标 → 必须分批请求；
//   3) 迁移生成的宽表列 = 字典科目（列名由代码转换，白名单校验）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dict = require('../dataAccess/lixingerReportMetrics');
const { migration186FinancialStatementWide } = require('../db/migrations/era11FinancialStatements');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

const CN = dict.statsOf('CN');
const HK = dict.statsOf('HK');

async function main() {
  await check('字典：A股三表科目齐全（资产/利润/现金流均上百或数十）', () => {
    assert.ok(CN.balance >= 100, `A股资产负债表科目过少：${CN.balance}`);
    assert.ok(CN.income >= 90, `A股利润表科目过少：${CN.income}`);
    assert.ok(CN.cashflow >= 80, `A股现金流科目过少：${CN.cashflow}`);
  });

  await check('字典：港股按 HKFRS 独立一套，且现金流明细只有官方的 7 个汇总项', () => {
    assert.strictEqual(HK.cashflow, 7, `港股现金流应为官方 7 项，实际 ${HK.cashflow}`);
    assert.ok(HK.balance >= 90, `港股资产负债表科目过少：${HK.balance}`);
    assert.ok(HK.income >= 50, `港股利润表科目过少：${HK.income}`);
  });

  await check('字典：两套准则科目不混用（港股独有与 A 股独有各自成立）', () => {
    const cnCodes = new Set(dict.metricsOf('CN').map(item => item.code));
    const hkCodes = new Set(dict.metricsOf('HK').map(item => item.code));
    // A股独有：交易性金融资产、开发支出；港股独有：物业厂房及设备、非国际准则净利润
    assert.ok(cnCodes.has('bs.tfa') && !hkCodes.has('bs.tfa'), '交易性金融资产应只属 A 股');
    assert.ok(cnCodes.has('bs.rade') && !hkCodes.has('bs.rade'), '开发支出应只属 A 股');
    assert.ok(hkCodes.has('bs.ppe') && !cnCodes.has('bs.ppe'), '物业厂房及设备应只属港股');
    assert.ok(hkCodes.has('ps.nonifrs_op') && !cnCodes.has('ps.nonifrs_op'), '非国际准则净利润应只属港股');
  });

  await check('字典：单只股票 128 指标上限 → A股与港股都必须分批', () => {
    const cnBatches = dict.requestBatchesOf('CN');
    const hkBatches = dict.requestBatchesOf('HK');
    assert.ok(cnBatches.length >= 3, `A股应至少 3 批，实际 ${cnBatches.length}`);
    assert.ok(hkBatches.length >= 2, `港股应至少 2 批，实际 ${hkBatches.length}`);
    for (const batch of [...cnBatches, ...hkBatches]) {
      assert.ok(batch.length <= 128, `单批超过 128 个指标：${batch.length}`);
      assert.ok(batch.every(code => /^q\.(bs|ps|cfs)\.[a-z0-9_]+\.t$/.test(code)), '请求串格式必须是 q.<表>.<字段>.t');
    }
    // 每个市场各自都要被完整请求到（两市场有同名科目，不能合并去重）
    assert.strictEqual(new Set(cnBatches.flat()).size, CN.total, 'A股分批后指标总数应与字典一致');
    assert.strictEqual(new Set(hkBatches.flat()).size, HK.total, '港股分批后指标总数应与字典一致');
  });

  await check('列名映射：代码转下划线且拒绝非法代码', () => {
    assert.strictEqual(dict.columnOf('bs.ta'), 'bs_ta');
    assert.strictEqual(dict.columnOf('cfs.ncffoa'), 'cfs_ncffoa');
    assert.throws(() => dict.columnOf('bs.ta;drop'), /非法指标代码/);
    const cnColumns = dict.metricsOf('CN').map(item => dict.columnOf(item.code));
    assert.strictEqual(new Set(cnColumns).size, cnColumns.length, 'A股列名必须唯一');
  });

  await check('宽表命名：A股与港股落到不同表', () => {
    assert.strictEqual(dict.tableNameOf('CN', 'balance'), 'fundamental.statement_balance_cas');
    assert.strictEqual(dict.tableNameOf('HK', 'balance'), 'fundamental.statement_balance_hkfrs');
    assert.strictEqual(dict.tableNameOf('CN', 'cashflow'), 'fundamental.statement_cashflow_cas');
    assert.throws(() => dict.tableNameOf('CN', 'unknown'), /不支持的报表/);
  });

  await check('迁移 186 建 6 张宽表，列数与字典一致并带准则约束', async () => {
    const statements = [];
    const fakePg = { query: async sql => { statements.push(String(sql)); return { rows: [] }; } };
    const created = await migration186FinancialStatementWide(fakePg);
    assert.strictEqual(created.length, 6, '应为 2 个市场 × 3 张表');
    const creates = statements.filter(sql => /CREATE TABLE IF NOT EXISTS fundamental\.statement_/.test(sql));
    assert.strictEqual(creates.length, 6, `建表语句应有 6 条，实际 ${creates.length}`);
    const balanceCas = creates.find(sql => sql.includes('fundamental.statement_balance_cas'));
    const balanceColumns = (balanceCas.match(/\n {6}[a-z0-9_]+ NUMERIC/g) || []).length;
    assert.strictEqual(balanceColumns, CN.balance, `A股资产负债表列数应为 ${CN.balance}，实际 ${balanceColumns}`);
    assert.ok(/accounting_standard TEXT NOT NULL DEFAULT 'CAS'/.test(balanceCas), 'A股宽表必须声明 CAS 准则');
    const hkCas = creates.find(sql => sql.includes('fundamental.statement_balance_hkfrs'));
    assert.ok(/DEFAULT 'HKFRS'/.test(hkCas), '港股宽表必须声明 HKFRS 准则');
    // 港口现金流宽表只应有 7 个科目列，不能把 A 股明细塞进来
    const cashHk = creates.find(sql => sql.includes('fundamental.statement_cashflow_hkfrs'));
    const hkCashColumns = (cashHk.match(/\n {6}cfs_[a-z0-9_]+ NUMERIC/g) || []).length;
    assert.strictEqual(hkCashColumns, 7, `港股现金流列数应为 7，实际 ${hkCashColumns}`);
  });

  await check('落库写入：只写有值的科目，空值不覆盖已有列', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'stockProjectionRepository.js'), 'utf8');
    assert.ok(/writeStatementWideRow/.test(source), '写入层必须有三表宽表写入函数');
    assert.ok(/if \(value === null\) continue;/.test(source), '空值必须跳过，避免用 null 覆盖历史正确值');
    assert.ok(/ON CONFLICT \(report_id\) DO UPDATE SET/.test(source), '同一报告必须幂等覆盖');
    assert.ok(/\$\{reportMetrics\.columnOf\(metric\.code\)\}/.test(source) || /reportMetrics\.columnOf\(metric\.code\)/.test(source),
      '列名必须来自字典白名单，不能拼接外部输入');
  });

  const failed = tests.filter(item => item[0] === 'FAIL');
  console.log(`\n三表科目与宽表：${tests.length - failed.length}/${tests.length} 通过`);
  console.log(`  A股：资产 ${CN.balance} / 利润 ${CN.income} / 现金流 ${CN.cashflow}（共 ${CN.total}）`);
  console.log(`  港股：资产 ${HK.balance} / 利润 ${HK.income} / 现金流 ${HK.cashflow}（共 ${HK.total}）`);
  if (failed.length) {
    failed.forEach(item => console.log('  ' + item[1]));
    process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
