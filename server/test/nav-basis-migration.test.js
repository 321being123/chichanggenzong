// migration 179（持仓基准唯一）自身的行为回归（2026-10-30）
//
// 为什么要单独测：这条迁移在生产是「空跑」——基准子集当下 0 组重复，清理分支不会执行，
// 只有建索引那一步真正生效。一旦清理 SQL 写错（删错行、删了导入批次行）或不可重跑，
// 表现会是「启动时报错」或「悄悄删了券商事实」，都不容易在上线后才发现。
//
// 验证点：
//   ① 同一账户同日同证券的重复基准只保留 snapshot_id 最小的一条，删除条数可核对；
//   ② 券商导入批次行（source<>'manual_reconciliation'）同日期多批次并存，一行不动；
//   ③ 迁移可重复执行（幂等），第二次不删行、不报错；
//   ④ 建成的索引确实存在且是部分唯一索引。
const assert = require('assert');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function baseConfig() {
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || ''
  };
}

const SCHEMA_SQL = `
CREATE TABLE nav_position_snapshots (
  snapshot_id text NOT NULL, username text NOT NULL, account_name text NOT NULL,
  snapshot_date date NOT NULL, instrument_code text NOT NULL,
  quantity numeric, price numeric, quote_currency text, fx_rate_to_cny numeric,
  market_value_cny numeric, source text
);
`;

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    failures.push(name + ' :: ' + (error && error.message));
    console.log('  ✗ ' + name + ' —— ' + (error && error.message));
  }
}

(async () => {
  const tmpDb = 'portfolio_test_mig179_' + Date.now();
  const admin = new Client(Object.assign(baseConfig(), { database: process.env.PGDATABASE || 'portfolio' }));
  let client = null;
  try {
    await admin.connect();
  } catch (error) {
    console.log('--- migration 179 行为回归 ---');
    console.log('[SKIP] 本地 PostgreSQL 不可用（' + error.message + '），本文件未验证。');
    process.exit(0);
  }

  try {
    await admin.query('CREATE DATABASE "' + tmpDb + '"');
    client = new Client(Object.assign(baseConfig(), { database: tmpDb }));
    await client.connect();
    await client.query(SCHEMA_SQL);

    // 迁移模块按 process.env 建池，必须先指到临时库再 require。
    if (process.env.DATABASE_URL) {
      const url = new URL(process.env.DATABASE_URL);
      url.pathname = '/' + tmpDb;
      process.env.DATABASE_URL = url.toString();
    } else {
      process.env.PGDATABASE = tmpDb;
    }
    const migrations = require('../db/migrations/era02PlatformOps');
    const pool = require('../db/connection').pool;

    await client.query(`
      INSERT INTO nav_position_snapshots
        (snapshot_id, username, account_name, snapshot_date, instrument_code, quantity, price,
         quote_currency, fx_rate_to_cny, market_value_cny, source)
      VALUES
        ('snap-c','u1','A','2026-10-30','601995',100,31,'CNY',1,3100,'manual_reconciliation'),
        ('snap-a','u1','A','2026-10-30','601995',100,30,'CNY',1,3000,'manual_reconciliation'),
        ('snap-b','u1','A','2026-10-30','601995',100,30,'CNY',1,3000,'manual_reconciliation'),
        ('batch-1','u1','A','2026-10-30','601995',100,30,'CNY',1,3000,'system_daily_price'),
        ('batch-2','u1','A','2026-10-30','601995',100,31,'CNY',1,3100,'system_daily_price')
    `);

    await test('重复基准只保留 snapshot_id 最小的一条，导入批次一行不动', async function () {
      await migrations.migration179NavBasisUniqueness();
      const basis = await client.query(
        `SELECT snapshot_id FROM nav_position_snapshots
          WHERE source='manual_reconciliation' ORDER BY snapshot_id`
      );
      assert.deepStrictEqual(basis.rows.map(row => row.snapshot_id), ['snap-a'],
        '同一账户同日同证券只保留一条，且是最小 snapshot_id');
      const imported = await client.query(
        `SELECT count(*)::int AS n FROM nav_position_snapshots WHERE source='system_daily_price'`
      );
      assert.strictEqual(imported.rows[0].n, 2, '券商导入的同日期多批次必须原样保留');
    });

    await test('迁移可重复执行：第二次不删行也不报错', async function () {
      const before = await client.query('SELECT count(*)::int AS n FROM nav_position_snapshots');
      await migrations.migration179NavBasisUniqueness();
      const after = await client.query('SELECT count(*)::int AS n FROM nav_position_snapshots');
      assert.strictEqual(after.rows[0].n, before.rows[0].n, '重跑不得删行');
    });

    await test('索引存在且是「仅基准」的部分唯一索引', async function () {
      const { rows } = await client.query(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename='nav_position_snapshots' AND indexname='uq_nav_position_basis_scope'`
      );
      assert.strictEqual(rows.length, 1, '索引必须建成');
      assert.ok(/UNIQUE/i.test(rows[0].indexdef), '必须是唯一索引');
      assert.ok(/manual_reconciliation/.test(rows[0].indexdef), '必须只约束基准行：' + rows[0].indexdef);
    });
  } finally {
    if (client) await client.end().catch(() => {});
    await require('../db/connection').pool.end().catch(() => {});
    await admin.query('DROP DATABASE IF EXISTS "' + tmpDb + '" WITH (FORCE)').catch(() => {});
    await admin.end().catch(() => {});
  }

  console.log('migration 179 行为回归：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) {
    failures.forEach(item => console.log('  失败：' + item));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
