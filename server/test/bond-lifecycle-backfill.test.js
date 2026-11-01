// 已退市债生命周期回写（2026-10-31 反馈 #17）：
// 岭南发债 128044 到期退市后，主档的到期日/转股截止日/摘牌日一直是空，status 还停在 listed，
// 行情源给出冻结价行（成交量 0）就混进「上市可转债」列表。
// 这里验证两件事：①判定函数能按目标日识别已退市/已到期；②回写只补空值、并把 status 落成 delisted。
const assert = require('assert');
const { pool } = require('../db/connection');
const { isDelistedBond, isActiveBond, isPendingListingBond } = require('../services/bondSafetyTushare');
const repository = require('../repositories/convertibleBondAnalysisSyncRepository');

const tests = [];
function check(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

const TODAY = '2026-10-31';

console.log('A. 生命周期判定（目标日口径）');
check('摘牌日已过 → 判为已退市', () => {
  assert.strictEqual(isDelistedBond({ ts_code: '128044.SZ', list_date: '20180904', delist_date: '20240930', maturity_date: '20240814' }, TODAY), true);
});
check('到期日已过但没摘牌日 → 判为已退市', () => {
  assert.strictEqual(isDelistedBond({ ts_code: '128044.SZ', list_date: '20180904', maturity_date: '20240814' }, TODAY), true);
});
check('转股截止日已过 → 判为已退市', () => {
  assert.strictEqual(isDelistedBond({ ts_code: '128044.SZ', list_date: '20180904', conv_end_date: '20240814' }, TODAY), true);
});
check('仍在市（三者都在目标日之后）→ 不判退市', () => {
  assert.strictEqual(isDelistedBond({ ts_code: '113001.SH', list_date: '20200101', delist_date: '20280101', maturity_date: '20280101', conv_end_date: '20280101' }, TODAY), false);
});
check('尚未上市 → 归待上市，不判退市', () => {
  assert.strictEqual(isDelistedBond({ ts_code: '113099.SH', list_date: '20261120', maturity_date: '20321120' }, TODAY), false);
  assert.strictEqual(isPendingListingBond({ ts_code: '113099.SH', list_date: '20261120', maturity_date: '20321120' }, TODAY), true);
});
check('三个判定互斥：同一行只能落在一个集合里', () => {
  const delisted = { ts_code: '128044.SZ', list_date: '20180904', delist_date: '20240930', maturity_date: '20240814' };
  const active = { ts_code: '113001.SH', list_date: '20200101', maturity_date: '20280101', conv_end_date: '20280101' };
  const pending = { ts_code: '113099.SH', list_date: '20261120', maturity_date: '20321120' };
  for (const row of [delisted, active, pending]) {
    const hits = [isDelistedBond, isActiveBond, isPendingListingBond].filter(fn => fn(row, TODAY)).length;
    assert.strictEqual(hits, 1, `${row.ts_code} 判定集合数应为 1，实际 ${hits}`);
  }
});
check('非可转债代码不参与判定', () => {
  assert.strictEqual(isDelistedBond({ ts_code: '600519.SH', list_date: '20010827', maturity_date: '20200101' }, TODAY), false);
});

console.log('B. 生命周期回写（需 PG）');
const TEST_CODE = '899901.SZ';
async function withRollback(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

(async () => {
  if (!pool) {
    console.log('  [SKIP] 无数据库连接，跳过回写集成用例');
  } else {
    await checkAsync('回写补齐到期日/摘牌日，并把 status 落成 delisted', async () => {
      await withRollback(async client => {
        await client.query("DELETE FROM core.instruments WHERE canonical_code=$1", [TEST_CODE]);
        const { rows: [inst] } = await client.query(
          `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status,raw_data)
           VALUES($1,'测试退市债','convertible_bond','CN','SZSE','CNY','2018-09-04','listed','{}'::jsonb)
           RETURNING instrument_id`, [TEST_CODE]);
        await client.query(
          `INSERT INTO fundamental.convertible_bond_profiles(instrument_id,bond_short_name)
           VALUES($1,'测试退市债')`, [inst.instrument_id]);

        const facts = [{
          ts_code: TEST_CODE, delist_date: '2024-09-30', maturity_date: '2024-08-14',
          conv_end_date: '2024-08-14', conv_stop_date: null,
        }];
        await repository.updateBondLifecycleFacts([JSON.stringify(facts), TODAY], client);

        const { rows: [after] } = await client.query(
          'SELECT status, delist_date::text AS delist_date FROM core.instruments WHERE instrument_id=$1', [inst.instrument_id]);
        assert.strictEqual(after.status, 'delisted', '摘牌日已过应落 delisted');
        assert.strictEqual(after.delist_date, '2024-09-30');
        const { rows: [profile] } = await client.query(
          'SELECT maturity_date::text AS maturity_date, conv_end_date::text AS conv_end_date FROM fundamental.convertible_bond_profiles WHERE instrument_id=$1', [inst.instrument_id]);
        assert.strictEqual(profile.maturity_date, '2024-08-14');
        assert.strictEqual(profile.conv_end_date, '2024-08-14');
      });
    });

    await checkAsync('空值不覆盖已有生命周期（接口缺字段不清库里的有效值）', async () => {
      await withRollback(async client => {
        await client.query("DELETE FROM core.instruments WHERE canonical_code=$1", [TEST_CODE]);
        const { rows: [inst] } = await client.query(
          `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status,delist_date,raw_data)
           VALUES($1,'测试退市债','convertible_bond','CN','SZSE','CNY','2018-09-04','delisted','2024-09-30','{}'::jsonb)
           RETURNING instrument_id`, [TEST_CODE]);
        await client.query(
          `INSERT INTO fundamental.convertible_bond_profiles(instrument_id,bond_short_name,maturity_date)
           VALUES($1,'测试退市债','2024-08-14')`, [inst.instrument_id]);

        await repository.updateBondLifecycleFacts([JSON.stringify([{ ts_code: TEST_CODE, delist_date: null, maturity_date: null, conv_end_date: null }]), TODAY], client);
        const { rows: [after] } = await client.query(
          'SELECT delist_date::text AS delist_date FROM core.instruments WHERE instrument_id=$1', [inst.instrument_id]);
        assert.strictEqual(after.delist_date, '2024-09-30', '空值不得覆盖已有摘牌日');
        const { rows: [profile] } = await client.query(
          'SELECT maturity_date::text AS maturity_date FROM fundamental.convertible_bond_profiles WHERE instrument_id=$1', [inst.instrument_id]);
        assert.strictEqual(profile.maturity_date, '2024-08-14', '空值不得覆盖已有到期日');
      });
    });
  }

  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.filter(item => item[0] === 'FAIL').length;
  console.log('\n===== bond-lifecycle-backfill 测试汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail) process.exit(1);
  process.exit(0);
})();
