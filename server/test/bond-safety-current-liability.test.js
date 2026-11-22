const assert = require('assert');
const fs = require('fs');
const path = require('path');
const repository = require('../repositories/bondSafetyTushareRepository');

const base = {
  balance_report_id: 101,
  balance_source_id: 7,
  balance_source_version: 'v1',
  balance_source_code: 'lixinger_official',
  balance_wide_report_id: 101,
  balance_wide_source_id: 7,
  balance_wide_source_version: 'v1',
  balance_wide_currency: 'CNY',
  balance_wide_standard: 'CAS',
  balance_wide_current_liability: '590000000',
};

function row(overrides = {}, payload = {}) {
  return { balance_payload: payload, ...base, ...overrides };
}

(async () => {
  // 原始摘要字段优先：即使宽表有值也不能覆盖，0 是有效原始值而不是缺失。
  assert.strictEqual(repository.resolveCurrentLiability(row({}, { total_cur_liab: 120 })), 120);
  assert.strictEqual(repository.resolveCurrentLiability(row({}, { total_cur_liab: 0 })), 0,
    '原始 0 必须保留为 0，不能回退宽表');
  assert.strictEqual(repository.resolveCurrentLiability(row({}, { total_cur_liab: '0' })), 0);

  // 布尔和数组不是财务数字：不能经 Number() 变成 1 或 0；应视为摘要缺失并只用受控宽表。
  assert.strictEqual(repository.resolveCurrentLiability(row({}, { total_cur_liab: true })), 590000000,
    '布尔不得变成 1');
  assert.strictEqual(repository.resolveCurrentLiability(row({}, { total_cur_liab: false })), 590000000,
    '布尔不得变成 0');
  assert.strictEqual(repository.resolveCurrentLiability(row({}, { total_cur_liab: [] })), 590000000,
    '数组不得变成 0');
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_current_liability: true })), null,
    '宽表布尔不得变成 1');
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_current_liability: [] })), null,
    '宽表数组不得变成 0');

  // 理杏仁摘要缺失时，只接受同一 report_id/source_id/version 的 CNY/CAS bs_tcl。
  assert.strictEqual(repository.resolveCurrentLiability(row()), 590000000);
  assert.strictEqual(repository.resolveCurrentLiability(row({}, { total_cur_liab: '' })), 590000000);
  assert.strictEqual(repository.resolveCurrentLiability(row({}, { total_cur_liab: 'null' })), 590000000);
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_current_liability: 0 })), 0,
    '宽表 0 必须保留为 0，不能当作缺失');

  // 另一报告或版本、另一来源、跨币种都不能借用。
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_report_id: 102 })), null,
    '另一报告（同公司同期）的宽表不得补值');
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_source_version: 'v2' })), null,
    '另一来源版本的宽表不得补值');
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_source_id: 8 })), null,
    '另一来源的宽表不得补值');
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_currency: 'HKD' })), null,
    '非 CNY 报表不得补值');
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_standard: 'HKFRS' })), null,
    '非 CAS 报表不得补值');

  // Tushare 继续只读原始键，不因存在宽表而改口径。
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_source_code: 'tushare' })), null,
    'Tushare 缺失原始键时必须保留缺失');
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_source_code: 'tushare' }, { total_cur_liab: 88 })), 88);

  // 真实缺失：没有宽表证据、宽表值为空、或宽表值不是数字，都保持 null。
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_report_id: null })), null);
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_current_liability: null })), null);
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_wide_current_liability: '' })), null);
  assert.strictEqual(repository.resolveCurrentLiability(row({ balance_payload: null })), 590000000);

  // 仓储读取结果必须新增单字段，且不修改原始报文证据。
  const fake = {
    query: async sql => {
      assert.ok(sql.includes('LEFT JOIN fundamental.statement_balance_cas wide ON wide.report_id=bal.report_id'));
      return { rows: [{ ...base, bond_code: '113000.SH', balance_payload: { total_assets: 1 } }] };
    },
  };
  const result = await repository.loadBondSafetyFacts([null], fake);
  assert.strictEqual(result.rows[0].balance_current_liability, 590000000);
  assert.deepStrictEqual(result.rows[0].balance_payload, { total_assets: 1 }, '不得把回退值写回摘要');

  // SQL 必须按选中的 report_id 关联宽表，不能按公司/期间二次择一；服务消费仓储单字段。
  const repoSource = fs.readFileSync(path.resolve(__dirname, '..', 'repositories', 'bondSafetyTushareRepository.js'), 'utf8');
  const serviceSource = fs.readFileSync(path.resolve(__dirname, '..', 'services', 'bondSafetyTushare.js'), 'utf8');
  assert.ok(/LEFT JOIN fundamental\.statement_balance_cas wide ON wide\.report_id=bal\.report_id/.test(repoSource),
    '宽表必须按选中的 balance.report_id 关联');
  assert.ok(repoSource.includes('bal.report_id AS balance_report_id') && repoSource.includes('bal.source_id AS balance_source_id'),
    'balance lateral 必须同时返回 report_id/source_id');
  assert.ok(!/statement_balance_cas\s+\w+\s+ON\s+\w+\.company_id/.test(repoSource), '禁止按公司关联宽表');
  assert.ok(serviceSource.includes("current_liability: pick(row, 'balance_current_liability', null)"),
    '服务必须只消费仓储返回的单字段');
  assert.ok(!/current_liability: pick\(row, 'balance_current_liability', pick\(/.test(serviceSource),
    '服务不得再次兜底未经校验的 raw 字段');
  console.log('bond safety current liability fallback tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
