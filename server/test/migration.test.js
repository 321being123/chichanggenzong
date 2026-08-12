// ========== 空数据库迁移回归测试（P0-1 验收）==========
// 运行：node server/test/migration.test.js
// 目的：验证全新（空）PostgreSQL 数据库能完整执行 001_init 迁移并幂等，
//       覆盖 P2-5 拆分后遗漏的跨模块引用（seedBrokers / BROKER_SEED / loadUsers 等）。
// 依赖本地/CI 的 PostgreSQL 且当前用户有 CREATEDB 权限；否则自动跳过（不影响通过）。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
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
  let expectedMigrationCount = 0;
  try {
    // 1) 连原库建一个临时空库
    origClient = new Client(pgConfig(origDb));
    await origClient.connect();
    tmpDb = 'portfolio_migtest_' + Date.now();
    await origClient.query('CREATE DATABASE "' + tmpDb + '"');
    await origClient.end();
    origClient = null;

    // 2) 让 db 模块连到临时库（必须在首次 require 前设定）
    process.env.PGDATABASE = tmpDb;
    db = require('../../server/db');
    expectedMigrationCount = require('../../server/db/migrations').MIGRATIONS.length;

    console.log('A. 首次 initSchema（空库）');
    await db.initSchema();
    check('首次迁移完成无异常', () => { assert.ok(true); });

    const t = await db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    const tables = t.rows.map(r => r.table_name).sort();
    check('生成全部核心表', () => {
      for (const need of ['accounts', 'brokers', 'users', 'positions', 'trades', 'schema_migrations', 'job_runs',
        'stock_watchlist', 'ipo_reports']) {
        assert.ok(tables.includes(need), '缺少表: ' + need + '（现有: ' + tables.join(',') + '）');
      }
    });

    const b = await db.pool.query('SELECT count(*)::int AS c FROM brokers');
    check('券商种子数据已写入（>0）', () => { assert.ok(b.rows[0].c > 0, 'brokers 种子为空'); });

    const m = await db.pool.query('SELECT count(*)::int AS c FROM schema_migrations');
    check('全部迁移记录已登记', () => { assert.strictEqual(m.rows[0].c, expectedMigrationCount); });

    const knowledgeConstraints = await db.pool.query(
      `SELECT conname FROM pg_constraint
       WHERE conname = ANY($1::text[])`,
      [['ck_articles_status', 'ck_articles_view_count', 'ck_cat_name_nonempty', 'ck_cat_no_self_parent']]
    );
    const knowledgeConstraintNames = new Set(knowledgeConstraints.rows.map(row => row.conname));
    check('知识分享约束均已创建', () => {
      for (const name of ['ck_articles_status', 'ck_articles_view_count', 'ck_cat_name_nonempty', 'ck_cat_no_self_parent']) {
        assert.ok(knowledgeConstraintNames.has(name), '缺少约束：' + name);
      }
    });

    const authorFk = await db.pool.query(
      `SELECT rc.delete_rule
       FROM information_schema.referential_constraints rc
       WHERE rc.constraint_name='articles_author_username_fkey'`
    );
    check('文章作者外键注销时置空', () => {
      assert.strictEqual(authorFk.rows[0] && authorFk.rows[0].delete_rule, 'SET NULL');
    });

    const commentArticleColumn = await db.pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='article_comments' AND column_name='article_id'`
    );
    check('评论文章关联不能为空', () => {
      assert.strictEqual(commentArticleColumn.rows[0] && commentArticleColumn.rows[0].is_nullable, 'NO');
    });

    const categoryOwnerColumn = await db.pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='article_categories' AND column_name='owner_username'`
    );
    check('分类已增加所有者字段', () => {
      assert.ok(categoryOwnerColumn.rows[0], '缺少 owner_username 字段');
    });

    const categoryFks = await db.pool.query(
      `SELECT rc.constraint_name, rc.delete_rule
       FROM information_schema.referential_constraints rc
       WHERE rc.constraint_name = ANY($1::text[])`,
      [['article_categories_parent_id_fkey', 'article_categories_owner_username_fkey']]
    );
    const categoryFkRules = new Map(categoryFks.rows.map(row => [row.constraint_name, row.delete_rule]));
    check('删除父分类或用户时均保留其他分类', () => {
      assert.strictEqual(categoryFkRules.get('article_categories_parent_id_fkey'), 'SET NULL');
      assert.strictEqual(categoryFkRules.get('article_categories_owner_username_fkey'), 'SET NULL');
    });

    const schemasResult = await db.pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)", [['ops','core','market','fundamental','event','analytics']]);
    check('股票分析分层数据库已创建', () => { assert.strictEqual(schemasResult.rows.length, 6); });

    const architectureTables = await db.pool.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema = ANY($1)", [['ops','core','market','fundamental','event','analytics']]);
    const architectureNames = new Set(architectureTables.rows.map(row => `${row.table_schema}.${row.table_name}`));
    check('分层数据库核心表已创建', () => {
      for (const name of ['core.instruments','market.daily_valuations','fundamental.financial_reports','fundamental.corporate_actions','event.company_events','analytics.metric_values','analytics.stock_overview_latest','ops.sync_cursors','fundamental.convertible_bond_profiles','fundamental.convertible_bond_issuance','event.instrument_events','analytics.convertible_bond_listing_performance','fundamental.convertible_bond_terms','fundamental.convertible_bond_ratings','analytics.convertible_bond_trigger_daily']) assert.ok(architectureNames.has(name), '缺少表 ' + name);
    });
    const legacyBondTableName = ['bond', 'history'].join('_');
    const legacyBondTable = await db.pool.query('SELECT to_regclass($1) AS name', [`public.${legacyBondTableName}`]);
    const bondViewDefinition = await db.pool.query("SELECT pg_get_viewdef('public.bond_unified'::regclass, true) AS definition");
    check('统一切换后旧表已移除且视图不依赖旧表', () => {
      assert.strictEqual(legacyBondTable.rows[0].name, null);
      assert.ok(!new RegExp(legacyBondTableName, 'i').test(bondViewDefinition.rows[0].definition));
    });
    check('股票分析旧表已删除', () => { for (const name of ['stock_analysis_stocks','stock_income_statements','stock_balance_sheets','stock_cashflow_statements','stock_financial_indicators','stock_dividends','stock_forecasts','stock_daily_valuations','stock_events','stock_analysis_snapshots','stock_data_sync_state']) assert.ok(!tables.includes(name), '旧表仍存在 '+name); });

    const cycleTables = await db.pool.query("SELECT table_schema,table_name FROM information_schema.tables WHERE (table_schema='market' AND table_name='convertible_bond_daily_metrics') OR (table_schema='analytics' AND table_name='convertible_bond_cycle_daily')");
    const cycleSet = new Set(cycleTables.rows.map(r => `${r.table_schema}.${r.table_name}`));
    check('可转债周期新表已创建（021）', () => {
      assert.ok(cycleSet.has('market.convertible_bond_daily_metrics'), '缺少表 market.convertible_bond_daily_metrics');
      assert.ok(cycleSet.has('analytics.convertible_bond_cycle_daily'), '缺少表 analytics.convertible_bond_cycle_daily');
    });
    const alertConstraint = await db.pool.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid=c.conrelid
         JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname='analytics'
          AND t.relname='convertible_bond_valuation_alerts'
          AND c.conname='uq_cbva_event_state'`
    );
    check('预警去重键允许跨交易日再次触发（024）', () => {
      assert.strictEqual(alertConstraint.rows.length, 1);
      assert.match(alertConstraint.rows[0].def, /trade_date/);
    });

    console.log('B. 二次 initSchema（幂等）');
    await db.initSchema();
    const m2 = await db.pool.query('SELECT count(*)::int AS c FROM schema_migrations');
    check(`二次迁移不重复登记（仍为${expectedMigrationCount}）`, () => {
      assert.strictEqual(m2.rows[0].c, expectedMigrationCount);
    });
  } catch (e) {
    if (!tmpDb) {
      // 连不上 PostgreSQL 或无建库权限：临时库从未建立，属于环境不具备，优雅跳过（本地不影响通过；CI 下由上层视为失败）
      console.log('  [SKIP] 无可用 PostgreSQL / 无 CREATEDB 权限，跳过空库迁移测试');
      results.push(['SKIP', 'SKIP-空库迁移']);
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
  console.log('\n===== 空库迁移回归汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + skip);
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  if (skip > 0) {
    if (process.env.CI === '1') { console.log('CI 模式下不允许跳过关键测试'); process.exit(1); }
    console.log('SKIPPED');   // 本地：跳过不视为失败
    process.exit(0);
  }
  console.log('ALL PASS');
})();
