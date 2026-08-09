// ========== 套利模块迁移与数据库测试 ==========
// 测试迁移可重复执行、表结构正确、数据源已登记
const assert = require('assert');
const { pool, runMigrations } = require('../db');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { pass++; console.log('  ✓ ' + name); })
    .catch(e => { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); });
}

async function main() {
  console.log('--- 套利模块迁移与数据库测试 ---');

  // 迁移可重复执行
  await test('迁移 054 可重复执行（幂等）', async () => {
    await runMigrations(); // 应该跳过已执行的迁移，不报错
  });

  // 表存在
  await test('event.arbitrage_cases 表存在', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) as cnt FROM information_schema.tables WHERE table_schema='event' AND table_name='arbitrage_cases'`
    );
    assert.strictEqual(parseInt(rows[0].cnt), 1);
  });

  await test('event.arbitrage_case_documents 表存在', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) as cnt FROM information_schema.tables WHERE table_schema='event' AND table_name='arbitrage_case_documents'`
    );
    assert.strictEqual(parseInt(rows[0].cnt), 1);
  });

  // 数据源已登记
  await test('hkex_announcements 数据源已登记', async () => {
    const { rows } = await pool.query(
      `SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements'`
    );
    assert.ok(rows.length > 0, 'hkex_announcements not found in ops.data_sources');
  });

  await test('cninfo_announcements 数据源已登记', async () => {
    const { rows } = await pool.query(
      `SELECT source_id FROM ops.data_sources WHERE source_code='cninfo_announcements'`
    );
    assert.ok(rows.length > 0, 'cninfo_announcements not found in ops.data_sources');
  });

  // 约束检查
  await test('market 约束只允许 CN/HK', async () => {
    let err = null;
    try {
      await pool.query(`INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key)
        VALUES('US','a_cash_offer',1,'test_constraint')`);
    } catch (e) { err = e; }
    assert.ok(err, 'should reject market=US');
  });

  await test('strategy_type 约束只允许 4 种', async () => {
    let err = null;
    try {
      await pool.query(`INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key)
        VALUES('CN','invalid_type',1,'test_constraint2')`);
    } catch (e) { err = e; }
    assert.ok(err, 'should reject invalid strategy_type');
  });

  await test('(source_id, source_key) 唯一约束', async () => {
    // 先插入一条
    const { rows } = await pool.query(
      `INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key)
       VALUES('CN','a_cash_offer',1,'test_unique_001') RETURNING case_id`
    );
    const caseId = rows[0].case_id;
    // 再插入相同 source_id + source_key 应失败
    let err = null;
    try {
      await pool.query(
        `INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key)
         VALUES('CN','a_cash_offer',1,'test_unique_001')`
      );
    } catch (e) { err = e; }
    assert.ok(err, 'should reject duplicate (source_id, source_key)');
    // 清理
    await pool.query('DELETE FROM event.arbitrage_cases WHERE case_id=$1', [caseId]);
  });

  await test('价格约束 > 0', async () => {
    let err = null;
    try {
      await pool.query(
        `INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key,offer_price)
         VALUES('CN','a_cash_offer',1,'test_price_001',-1)`);
    } catch (e) { err = e; }
    assert.ok(err, 'should reject negative offer_price');
    // 清理可能的部分插入
    await pool.query(`DELETE FROM event.arbitrage_cases WHERE source_key LIKE 'test_%'`);
  });

  // 索引存在
  await test('索引 idx_arb_cases_type_status 存在', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) as cnt FROM pg_indexes WHERE schemaname='event' AND tablename='arbitrage_cases' AND indexname='idx_arb_cases_type_status'`
    );
    assert.strictEqual(parseInt(rows[0].cnt), 1);
  });

  await test('索引 idx_arb_cases_updated 存在', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) as cnt FROM pg_indexes WHERE schemaname='event' AND tablename='arbitrage_cases' AND indexname='idx_arb_cases_updated'`
    );
    assert.strictEqual(parseInt(rows[0].cnt), 1);
  });

  // 清理测试数据
  await pool.query(`DELETE FROM event.arbitrage_cases WHERE source_key LIKE 'test_%'`);

  console.log('\nPASS=' + pass + ' FAIL=' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
