// ========== 迁移已有旧表升级测试（P2-2 验收）==========
// 运行：node server/test/migration-legacy-upgrade.test.js
// 目的：验证 034/035 迁移在「空库完整执行」和「已有旧表（缺 list_date 列/缺视图与函数）」
//       两种场景下都能执行成功且幂等。
// 依赖本地 PostgreSQL 且有 CREATEDB 权限；否则自动跳过（不影响通过）。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

function pgConfig(dbName) {
  return {
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT || 5432,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: dbName,
  };
}

(async () => {
  const origDb = process.env.PGDATABASE || 'portfolio';
  let tmpDb = null;
  let origClient = null;
  let db = null;
  try {
    origClient = new Client(pgConfig(origDb));
    await origClient.connect();
    tmpDb = 'portfolio_migtest_' + Date.now();
    await origClient.query('CREATE DATABASE "' + tmpDb + '"');
    await origClient.end();
    origClient = null;

    process.env.PGDATABASE = tmpDb;
    db = require('../../server/db');
    const migrations = require('../../server/db/migrations');

    // A. 空库完整迁移（覆盖 031—035）
    await db.initSchema();
    const appliedA = await db.pool.query(
      `SELECT version FROM schema_migrations WHERE version LIKE '03%' ORDER BY version`
    );
    check('空库场景：031—035 全部登记', () => {
      const versions = appliedA.rows.map(r => r.version);
      for (const v of ['031_bond_unified', '032_bond_safety_structured', '033_stock_unified',
        '034_bond_profile_list_date', '035_bond_unified_stk_fallback']) {
        assert.ok(versions.includes(v), '缺少迁移记录: ' + v);
      }
    });
    const viewA = await db.pool.query(
      `SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name='bond_unified'`
    );
    const fnA = await db.pool.query(`SELECT 1 FROM pg_proc WHERE proname='normalize_stock_code'`);
    const colA = await db.pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='fundamental'
       AND table_name='convertible_bond_profiles' AND column_name='list_date'`
    );
    check('空库场景：bond_unified 视图/函数/列均存在', () => {
      assert.ok(viewA.rows.length === 1, 'bond_unified 视图缺失');
      assert.ok(fnA.rows.length === 1, 'normalize_stock_code 缺失');
      assert.ok(colA.rows.length === 1, 'profiles.list_date 缺失');
    });
    const legacyBondTableName = ['bond', 'history'].join('_');
    const oldBondTableA = await db.pool.query('SELECT to_regclass($1) AS name', [`public.${legacyBondTableName}`]);
    check('空库场景：直接切换后旧债表已移除', () => {
      assert.strictEqual(oldBondTableA.rows[0].name, null);
    });

    // B. 模拟"已有旧表"：删除 034 加列、035 视图与函数，并恢复 058 前的旧表与迁移状态
    await db.pool.query('DROP VIEW IF EXISTS public.bond_unified CASCADE');
    await db.pool.query('DROP FUNCTION IF EXISTS normalize_stock_code(TEXT)');
    await db.pool.query('ALTER TABLE fundamental.convertible_bond_profiles DROP COLUMN IF EXISTS list_date');
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS public.bond_history (
        security_code TEXT PRIMARY KEY,
        security_name TEXT,
        listing_date TEXT,
        first_day_return REAL,
        updated_at TEXT,
        ann_date TEXT,
        res_ann_date TEXT,
        issue_size REAL,
        issue_type TEXT,
        rating TEXT,
        shd_ration_ratio REAL,
        issue_price REAL,
        shd_ration_record_date TEXT,
        onl_date TEXT,
        onl_size REAL,
        onl_pch_num REAL,
        offl_size REAL,
        shd_ration_size REAL,
        conv_price REAL,
        stk_code TEXT,
        stk_name TEXT
      )
    `);
    await db.pool.query(`
      INSERT INTO public.bond_history
        (security_code,security_name,listing_date,first_day_return,updated_at,ann_date,res_ann_date,issue_size,issue_type,rating,
         shd_ration_ratio,issue_price,shd_ration_record_date,onl_date,onl_size,onl_pch_num,offl_size,shd_ration_size,conv_price,stk_code,stk_name)
      VALUES
        ('113001','测试转债一','20260801',12.5,'2026-08-02T10:00:00Z','20260720','20260729',20.5,'配债','AA+',0.12,100,'20260725','20260728',10,100,10,5,18.8,'600001','测试股份'),
        ('123001','测试转债二','20260805',NULL,'2026-08-06T10:00:00Z','20260721','20260730',8.5,'网上','AA',0.08,100,'20260726','20260729',4,80,4,2,19.2,'000001','测试股份二')
    `);
    await db.pool.query(
      `DELETE FROM schema_migrations WHERE version IN ('034_bond_profile_list_date','035_bond_unified_stk_fallback','058_convertible_bond_issue_unified')`
    );

    await migrations.runMigrations();
    const appliedB = await db.pool.query(
      `SELECT version FROM schema_migrations WHERE version IN ('034_bond_profile_list_date','035_bond_unified_stk_fallback','058_convertible_bond_issue_unified')`
    );
    check('旧表升级场景：重跑后 034/035/058 重新登记', () => {
      assert.strictEqual(appliedB.rows.length, 3);
    });
    const viewB = await db.pool.query(
      `SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name='bond_unified'`
    );
    const fnB = await db.pool.query(`SELECT 1 FROM pg_proc WHERE proname='normalize_stock_code'`);
    const colB = await db.pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='fundamental'
       AND table_name='convertible_bond_profiles' AND column_name='list_date'`
    );
    check('旧表升级场景：视图/函数/列均恢复', () => {
      assert.ok(viewB.rows.length === 1, 'bond_unified 视图未恢复');
      assert.ok(fnB.rows.length === 1, 'normalize_stock_code 未恢复');
      assert.ok(colB.rows.length === 1, 'profiles.list_date 未恢复');
    });
    const oldBondTableB = await db.pool.query('SELECT to_regclass($1) AS name', [`public.${legacyBondTableName}`]);
    check('旧表升级场景：旧债表仍不回归运行链路', () => {
      assert.strictEqual(oldBondTableB.rows[0].name, null);
    });
    const archiveB = await db.pool.query('SELECT COUNT(*)::int AS c FROM ops.legacy_bond_history_20260812');
    const migratedB = await db.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM core.instruments WHERE asset_class='convertible_bond')::int AS instruments,
        (SELECT COUNT(*) FROM fundamental.convertible_bond_issuance)::int AS issuance,
        (SELECT COUNT(*) FROM event.instrument_events)::int AS events,
        (SELECT COUNT(*) FROM analytics.convertible_bond_listing_performance)::int AS performance
    `);
    check('旧表升级场景：旧数据先完成归档再删除', () => {
      assert.strictEqual(archiveB.rows[0].c, 2);
      assert.ok(migratedB.rows[0].instruments >= 2, '统一标的未完整迁移');
      assert.ok(migratedB.rows[0].issuance >= 2, '发行事实未迁移');
      assert.ok(migratedB.rows[0].events >= 2, '发行事件未迁移');
      assert.ok(migratedB.rows[0].performance >= 1, '已有首日表现未迁移');
    });
  } catch (e) {
    if (!tmpDb) {
      console.log('  [SKIP] 无可用 PostgreSQL / 无 CREATEDB 权限，跳过迁移升级测试');
      results.push(['SKIP', 'SKIP-迁移升级']);
    } else {
      results.push(['FAIL', '异常: ' + (e && e.message ? e.message : e)]);
      console.log('  [FAIL] 异常: ' + (e && e.stack ? e.stack : e));
    }
  } finally {
    if (db && db.pool) { try { await db.pool.end(); } catch (_) {} }
    if (origClient) { try { await origClient.end(); } catch (_) {} }
    if (tmpDb) {
      try {
        const drop = new Client(pgConfig(origDb));
        await drop.connect();
        await drop.query('DROP DATABASE IF EXISTS "' + tmpDb + '"');
        await drop.end();
        console.log('  [cleanup] 已删除临时库 ' + tmpDb);
      } catch (e2) {
        console.log('  [warn] 清理临时库失败（请手动删除 ' + tmpDb + '）: ' + (e2 && e2.message ? e2.message : e2));
      }
    }
  }

  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL').length;
  const skip = results.filter(r => r[0] === 'SKIP').length;
  console.log('\n===== 迁移升级测试汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + skip);
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  if (skip > 0) {
    if (process.env.CI === '1') { console.log('CI 模式下不允许跳过关键测试'); process.exit(1); }
    console.log('SKIPPED');
    process.exit(0);
  }
  console.log('ALL PASS');
})();
