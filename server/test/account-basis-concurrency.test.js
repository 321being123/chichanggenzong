// 持仓基准补齐的并发回归（2026-10-30 二次验收 P1）
//
// 缺陷：两个请求同时为同一账户补基准时，各写一条，同一证券最终两条快照。
// 成因不是「忘了加锁」，而是锁与查询在【同一条语句】里：
//   READ COMMITTED 下快照在语句开始时取得，后到的请求阻塞在 advisory lock 上，
//   拿到锁后仍然用等待前的快照，NOT EXISTS 看不见前一个事务刚提交的行。
//
// 本文件按真库并发验证修复：
//   ① 不建唯一索引，只用代码路径 —— 证明锁本身（独立语句取锁 + 同事务写入）就够；
//   ② 部分覆盖场景（港股缺汇率）并发后仍只写有价的，补汇率后再并发只补一条；
//   ③ 最后才建 migration 179 的偏唯一索引：能建成本身即证明前面没写出重复行，
//      并验证绕过锁的直接重复写入会被库拒绝（23505）。
//
// 连接池归属：业务模块在 require 时按 process.env 建池，必须先指到临时库再 require。
const assert = require('assert');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const DATE = '2026-10-30';
const CONCURRENCY = 6;
// 这条竞态受时序影响：连接池里的连接若不在位，第 2 个请求可能等第 1 个提交完才开始，
// 旧实现就偶发「看起来正常」。所以并发前先预热连接池，并重复多轮不同业务日。
const ROUNDS = 3;

function baseConfig() {
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || ''
  };
}

// 字段名与真实迁移对齐（nav_history.date / daily_prices.date 是 TEXT）。
// 故意【不含】migration 179 的偏唯一索引：先把「只靠代码并发安全」这件事单独验证出来。
const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS market;
CREATE TABLE positions (
  id text, username text, account_name text, code text, quantity double precision,
  price double precision, subtype text, account_id text
);
CREATE TABLE nav_history (
  username text, account_name text, date text
);
CREATE TABLE daily_prices (
  username text, account_name text, date text, code text, price double precision
);
CREATE TABLE nav_position_snapshots (
  snapshot_id text, username text, account_name text, snapshot_date date,
  instrument_code text, quantity numeric, price numeric, quote_currency text,
  fx_rate_to_cny numeric, market_value_cny numeric, source text, account_id text
);
CREATE TABLE market.fx_rates (
  base_currency text, quote_currency text, rate numeric, rate_date date, fetched_at timestamptz
);
`;

async function addPosition(client, code, quantity, price, subtype = 'A股') {
  await client.query(
    'INSERT INTO positions(username, account_name, code, quantity, price, subtype, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    ['u1', 'A', code, quantity, price, subtype, 'acc1']
  );
}

async function reset(client) {
  await client.query('TRUNCATE positions, nav_history, daily_prices, nav_position_snapshots, market.fx_rates');
}

async function rowsPerInstrument(client) {
  const { rows } = await client.query(
    `SELECT instrument_code AS code, count(*)::int AS n
       FROM nav_position_snapshots GROUP BY instrument_code ORDER BY instrument_code`
  );
  return rows;
}

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
  const tmpDb = 'portfolio_test_basis_lock_' + Date.now();
  const admin = new Client(Object.assign(baseConfig(), { database: process.env.PGDATABASE || 'portfolio' }));
  let client = null;
  try {
    await admin.connect();
  } catch (error) {
    console.log('--- 持仓基准并发回归 ---');
    console.log('[SKIP] 本地 PostgreSQL 不可用（' + error.message + '），本文件未验证。');
    process.exit(0);
  }

  try {
    await admin.query('CREATE DATABASE "' + tmpDb + '"');
    client = new Client(Object.assign(baseConfig(), { database: tmpDb }));
    await client.connect();
    await client.query(SCHEMA_SQL);

    if (process.env.DATABASE_URL) {
      const url = new URL(process.env.DATABASE_URL);
      url.pathname = '/' + tmpDb;
      process.env.DATABASE_URL = url.toString();
    } else {
      process.env.PGDATABASE = tmpDb;
    }
    const repository = require('../repositories/accountPriceBackfillRepository');
    const basisService = require('../services/accountPositionBasis');

    await test('并发 6 次补同一账户同一业务日：每只证券只有一条基准快照（连跑三轮）', async function () {
      // 连接预热：先占满并发所需的连接再同时发起，避免「等连接」被误当成串行。
      async function warmup() {
        await Promise.all(Array.from({ length: CONCURRENCY }, () =>
          repository.countPositionSnapshots(['u1', 'A'])));
      }

      for (let round = 0; round < ROUNDS; round += 1) {
        await reset(client);
        await addPosition(client, '601995', 100, 30);
        await addPosition(client, '600000', 200, 8);
        await addPosition(client, '110001', 10, 105.5, '可转债');
        const businessDate = '2026-10-' + String(20 + round).padStart(2, '0');

        await warmup();
        const reports = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
          basisService.ensurePositionBasis('u1', 'A', { date: businessDate })));

        const counts = await rowsPerInstrument(client);
        assert.deepStrictEqual(
          counts.map(row => row.code + ':' + row.n),
          ['110001:1', '600000:1', '601995:1'],
          '第 ' + (round + 1) + ' 轮并发后每只证券必须只有一条，实际 ' + JSON.stringify(counts)
        );
        const created = reports.reduce((sum, item) => sum + item.created, 0);
        assert.strictEqual(created, 3,
          '第 ' + (round + 1) + ' 轮：写入总量应等于真实行数，不能把「写了但被挡」算成写入');
        assert.strictEqual(reports.filter(item => item.created > 0).length, 1,
          '同一个业务日的缺口只允许一个请求真正写入');
        reports.forEach(item => assert.strictEqual(item.covered, true, '并发结束后每个请求都应读到已覆盖'));
      }
    });

    await test('并发下部分覆盖（港股缺汇率）只写有价的，补汇率后再并发只补一条', async function () {
      await reset(client);
      await addPosition(client, '601995', 100, 30);
      await addPosition(client, '00700', 100, 380, '港股');

      const first = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
        basisService.ensurePositionBasis('u1', 'A', { date: DATE })));
      let counts = await rowsPerInstrument(client);
      assert.deepStrictEqual(counts.map(row => row.code + ':' + row.n), ['601995:1'],
        '缺汇率的港股不该写，也不该因为并发多写 A 股：' + JSON.stringify(counts));
      first.forEach(item => {
        assert.strictEqual(item.covered, false);
        assert.deepStrictEqual(item.skipped, ['00700']);
        assert.deepStrictEqual(item.reasons, { missing_fx: 1 }, '缺汇率要如实报原因');
      });

      await client.query(
        `INSERT INTO market.fx_rates(base_currency, quote_currency, rate, rate_date, fetched_at)
         VALUES ('HKD','CNY',0.9,'2026-10-29', now())`
      );
      const second = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
        basisService.ensurePositionBasis('u1', 'A', { date: DATE })));
      counts = await rowsPerInstrument(client);
      assert.deepStrictEqual(counts.map(row => row.code + ':' + row.n), ['00700:1', '601995:1'],
        '补回汇率后港股只能补一条，A 股不能被重写：' + JSON.stringify(counts));
      assert.strictEqual(second.reduce((sum, item) => sum + item.created, 0), 1,
        '第二次只有港股这一条是新增');
      second.forEach(item => assert.strictEqual(item.covered, true));
    });

    await test('锁在同事务内：连跑两轮不产生任何多余行（幂等）', async function () {
      await reset(client);
      await addPosition(client, '601995', 100, 30);
      await basisService.ensurePositionBasis('u1', 'A', { date: DATE });
      const again = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
        basisService.ensurePositionBasis('u1', 'A', { date: DATE })));
      const counts = await rowsPerInstrument(client);
      assert.deepStrictEqual(counts.map(row => row.code + ':' + row.n), ['601995:1']);
      again.forEach(item => {
        assert.strictEqual(item.created, 0, '已有基准时不得重复写');
        assert.strictEqual(item.existing, 1, '已有量要如实报告');
      });
    });

    await test('写入不接受裸连接池：绕过锁的调用直接报错', async function () {
      await assert.rejects(
        () => repository.insertBasisSnapshotsFromPositions(['u1', 'A', DATE]),
        /withAccountBasisLock/,
        '没有锁的写入必须写不进去，而不是静默重复'
      );
    });

    await test('migration 179 的偏唯一索引能建立在现有数据上，并挡住绕过锁的重复写入', async function () {
      // 前面几轮若写出过重复行，这里会直接失败——这就是「代码侧真的没重复」的反证。
      await client.query(
        `CREATE UNIQUE INDEX uq_nav_position_basis_scope
           ON nav_position_snapshots(username, account_name, snapshot_date, instrument_code)
          WHERE source = 'manual_reconciliation'`
      );
      const before = await client.query(
        `SELECT count(*)::int AS n FROM nav_position_snapshots WHERE source='manual_reconciliation'`
      );
      await assert.rejects(async () => {
        await client.query(
          `INSERT INTO nav_position_snapshots(snapshot_id, username, account_name, snapshot_date, instrument_code,
                                              quantity, price, quote_currency, fx_rate_to_cny, market_value_cny, source)
           VALUES ('dup-probe','u1','A',$1,'601995',100,30,'CNY',1,3000,'manual_reconciliation')`,
          [DATE]
        );
      }, error => error && error.code === '23505', '库级唯一索引必须拒绝同一账户同日同证券的第二条基准');
      const after = await client.query(
        `SELECT count(*)::int AS n FROM nav_position_snapshots WHERE source='manual_reconciliation'`
      );
      assert.strictEqual(after.rows[0].n, before.rows[0].n, '被拒绝的写入不能留下半条数据');
    });

    await test('偏唯一索引不限制券商导入批次（同日期多批次仍可并存）', async function () {
      await client.query(
        `INSERT INTO nav_position_snapshots(snapshot_id, username, account_name, snapshot_date, instrument_code,
                                            quantity, price, quote_currency, fx_rate_to_cny, market_value_cny, source)
         VALUES ('batch-a','u1','A',$1,'601995',100,30,'CNY',1,3000,'system_daily_price'),
                ('batch-b','u1','A',$1,'601995',100,31,'CNY',1,3100,'system_daily_price')`,
        [DATE]
      );
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM nav_position_snapshots
          WHERE source='system_daily_price' AND instrument_code='601995'`
      );
      assert.strictEqual(rows[0].n, 2, '导入批次按 snapshot_id 区分，不能被基准的唯一约束误伤');
    });
  } finally {
    if (client) await client.end().catch(() => {});
    // 必须先关业务连接池再删库：直接 DROP ... WITH (FORCE) 会把池里的连接踢断，
    // pg 的 Pool 会抛未处理的 'error' 事件把进程带崩（2026-10-30 实测）。
    await require('../db/connection').pool.end().catch(() => {});
    await admin.query('DROP DATABASE IF EXISTS "' + tmpDb + '" WITH (FORCE)').catch(() => {});
    await admin.end().catch(() => {});
  }

  console.log('持仓基准并发回归：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) {
    failures.forEach(item => console.log('  失败：' + item));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
