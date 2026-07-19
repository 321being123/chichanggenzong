// ========== 空数据库迁移回归测试（P0-1 验收）==========
// 运行：node server/test/migration.test.js
// 目的：验证全新（空）PostgreSQL 数据库能完整执行 001_init 迁移并幂等，
//       覆盖 P2-5 拆分后遗漏的跨模块引用（seedBrokers / BROKER_SEED / loadUsers 等）。
// 依赖本地/CI 的 PostgreSQL 且当前用户有 CREATEDB 权限；否则自动跳过（不影响通过）。
const assert = require('assert');
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

    console.log('A. 首次 initSchema（空库）');
    await db.initSchema();
    check('首次迁移完成无异常', () => { assert.ok(true); });

    const t = await db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    const tables = t.rows.map(r => r.table_name).sort();
    check('生成全部核心表', () => {
      for (const need of ['accounts', 'brokers', 'users', 'positions', 'trades', 'schema_migrations', 'job_runs',
        'stock_watchlist']) {
        assert.ok(tables.includes(need), '缺少表: ' + need + '（现有: ' + tables.join(',') + '）');
      }
    });

    const b = await db.pool.query('SELECT count(*)::int AS c FROM brokers');
    check('券商种子数据已写入（>0）', () => { assert.ok(b.rows[0].c > 0, 'brokers 种子为空'); });

    const m = await db.pool.query('SELECT count(*)::int AS c FROM schema_migrations');
    check('全部迁移记录已登记', () => { assert.strictEqual(m.rows[0].c, 9); });

    const schemasResult = await db.pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)", [['ops','core','market','fundamental','event','analytics']]);
    check('股票分析分层数据库已创建', () => { assert.strictEqual(schemasResult.rows.length, 6); });

    const architectureTables = await db.pool.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema = ANY($1)", [['ops','core','market','fundamental','event','analytics']]);
    const architectureNames = new Set(architectureTables.rows.map(row => `${row.table_schema}.${row.table_name}`));
    check('分层数据库核心表已创建', () => {
      for (const name of ['core.instruments','market.daily_valuations','fundamental.financial_reports','fundamental.corporate_actions','event.company_events','analytics.metric_values','analytics.stock_overview_latest','ops.sync_cursors']) assert.ok(architectureNames.has(name), '缺少表 ' + name);
    });
    check('股票分析旧表已删除', () => { for (const name of ['stock_analysis_stocks','stock_income_statements','stock_balance_sheets','stock_cashflow_statements','stock_financial_indicators','stock_dividends','stock_forecasts','stock_daily_valuations','stock_events','stock_analysis_snapshots','stock_data_sync_state']) assert.ok(!tables.includes(name), '旧表仍存在 '+name); });

    console.log('B. 二次 initSchema（幂等）');
    await db.initSchema();
    const m2 = await db.pool.query('SELECT count(*)::int AS c FROM schema_migrations');
    check('二次迁移不重复登记（仍为9）', () => { assert.strictEqual(m2.rows[0].c, 9); });
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
