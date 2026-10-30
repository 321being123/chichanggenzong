// S4 数据恢复试点：导入 → 行情 → 持仓基准 → 净值 旅程的可复现样本（2026-10-30）
// 目的：把月报 6.2 的三个「代码可见风险」从源码观察变成可执行证据，不触碰生产库、不访问外部行情。
// 每个场景都在隔离临时库执行，结束后删库。
const assert = require('assert');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const repository = require('../repositories/accountPriceBackfillRepository');
const basisService = require('../services/accountPositionBasis');
const backfillService = require('../services/accountPriceBackfill');

function baseConfig() {
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || ''
  };
}

// 只建本次旅程用到的列，字段名与真实迁移对齐（nav_history.date / daily_prices.date 在库里是 TEXT）；
// 不复制全量迁移，也不改任何生产结构。
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

async function insert(client, table, columns, values) {
  const placeholders = values.map((_, index) => '$' + (index + 1)).join(', ');
  await client.query(
    `INSERT INTO ${table}(${columns.join(', ')}) VALUES (${placeholders})`,
    values
  );
}

async function reset(client) {
  await client.query('TRUNCATE positions, nav_history, daily_prices, nav_position_snapshots, market.fx_rates');
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
  const tmpDb = 'portfolio_test_s4_' + Date.now();
  const admin = new Client(Object.assign(baseConfig(), { database: process.env.PGDATABASE || 'portfolio' }));
  let client = null;
  try {
    await admin.connect();
  } catch (error) {
    console.log('--- S4 数据恢复旅程 ---');
    console.log('SKIP：本地 PostgreSQL 不可用（' + error.message + '），本文件未验证。');
    process.exit(0);
  }

  try {
    await admin.query('CREATE DATABASE "' + tmpDb + '"');
    client = new Client(Object.assign(baseConfig(), { database: tmpDb }));
    await client.connect();
    await client.query(SCHEMA_SQL);

    await test('场景1：导入后 nav_history 为空，仍能选出当天待补证券（2026-10-30 修复）', async function () {
      await reset(client);
      await insert(client, 'positions',
        ['username', 'account_name', 'code', 'quantity', 'price', 'subtype', 'account_id'],
        ['u1', 'A', '601995', 100, 30, 'A股', 'acc1']);
      // 修复前 need_dates 只取 nav_history，空表导致一只都选不出来、当日行情永远补不到；
      // 现在把目标业务日并入，新导入账户当天就能补。
      const { rows } = await repository.selectPositionCodesMissingPrice(
        ['u1', 'A', '2026-09-30', 80, '2026-10-30'], client
      );
      assert.strictEqual(rows.length, 1, '新导入账户必须能选出当天待补证券');
      assert.strictEqual(rows[0].code, '601995');
      assert.strictEqual(rows[0].first_missing, '2026-10-30');
    });

    await test('场景2：nav_history 有历史日期时按最早缺口日回溯', async function () {
      await reset(client);
      await insert(client, 'positions',
        ['username', 'account_name', 'code', 'quantity', 'price', 'subtype', 'account_id'],
        ['u1', 'A', '601995', 100, 30, 'A股', 'acc1']);
      await insert(client, 'nav_history', ['username', 'account_name', 'date'], ['u1', 'A', '2026-10-20']);
      const { rows } = await repository.selectPositionCodesMissingPrice(
        ['u1', 'A', '2026-09-30', 80, '2026-10-30'], client
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].first_missing, '2026-10-20', '按最早缺口日拉起，而不是只补当天');
    });

    await test('场景3：部分持仓无有效价格时只写有价格的证券，缺口在返回里不可见', async function () {
      await reset(client);
      await insert(client, 'positions',
        ['username', 'account_name', 'code', 'quantity', 'price', 'subtype', 'account_id'],
        ['u1', 'A', '601995', 100, 30, 'A股', 'acc1']);
      await insert(client, 'positions',
        ['username', 'account_name', 'code', 'quantity', 'price', 'subtype', 'account_id'],
        ['u1', 'A', '110001', 200, 0, '可转债', 'acc1']);

      const write = await repository.insertBasisSnapshotsFromPositions(['u1', 'A', '2026-10-30'], client);
      assert.strictEqual(write.rowCount, 1, '缺价格的持仓被 SQL 过滤，只写有价格的那一只');
      const stored = await client.query('SELECT instrument_code FROM nav_position_snapshots ORDER BY instrument_code');
      assert.deepStrictEqual(stored.rows.map(row => row.instrument_code), ['601995']);

      const count = await repository.countPositionSnapshots(['u1', 'A'], client);
      assert.strictEqual(count, 1, '库里已有一行');

      const uncovered = await repository.selectUncoveredPositionCodes(['u1', 'A', '2026-10-30'], client);
      assert.deepStrictEqual(uncovered, ['110001'], '被跳过的证券可以查出来，用于如实上报缺口');

      // 服务层把缺口带回给调用方（修复前只返回 created，看不出少了谁）
      const originCount = repository.countPositionSnapshots;
      const originInsert = repository.insertBasisSnapshotsFromPositions;
      const originUncovered = repository.selectUncoveredPositionCodes;
      repository.countPositionSnapshots = async () => 0;
      repository.insertBasisSnapshotsFromPositions = async () => ({ rowCount: 1 });
      repository.selectUncoveredPositionCodes = async () => uncovered;
      try {
        const report = await basisService.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
        assert.strictEqual(report.reason, 'partial_coverage');
        assert.deepStrictEqual(report.skipped, ['110001']);
      } finally {
        repository.countPositionSnapshots = originCount;
        repository.insertBasisSnapshotsFromPositions = originInsert;
        repository.selectUncoveredPositionCodes = originUncovered;
      }

      // 已有快照时仍然不重复写（保留原有保护语义）
      repository.countPositionSnapshots = async () => count;
      repository.insertBasisSnapshotsFromPositions = async () => { throw new Error('不应再次写入'); };
      try {
        const again = await basisService.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
        assert.strictEqual(again.reason, 'already_has_snapshots',
          '只要库里有一行快照就判定「已有基准」，被跳过的证券永远不会补');
        assert.strictEqual(again.created, 0);
        assert.strictEqual(again.skipped, undefined, '返回里没有「哪些持仓没写成」');
      } finally {
        repository.countPositionSnapshots = originCount;
        repository.insertBasisSnapshotsFromPositions = originInsert;
      }
    });

    await test('场景4：港股缺汇率时整条被过滤，且不报出是哪个证券', async function () {
      await reset(client);
      await insert(client, 'positions',
        ['username', 'account_name', 'code', 'quantity', 'price', 'subtype', 'account_id'],
        ['u1', 'A', '00700', 100, 400, '港股', 'acc1']);
      const write = await repository.insertBasisSnapshotsFromPositions(['u1', 'A', '2026-10-30'], client);
      assert.strictEqual(write.rowCount, 0, '无汇率时该证券被 NOT(...) 条件过滤');
      const stored = await client.query('SELECT count(*)::int AS n FROM nav_position_snapshots');
      assert.strictEqual(stored.rows[0].n, 0, '不加汇率就写进去会得出错误的人民币市值，所以宁可不写');
    });

    await test('场景5：超过上限只处理前 N 只，剩余缺口没有持久化记录', async function () {
      await reset(client);
      for (let index = 0; index < 5; index += 1) {
        await insert(client, 'positions',
          ['username', 'account_name', 'code', 'quantity', 'price', 'subtype', 'account_id'],
          ['u1', 'A', String(600000 + index), 100, 10, 'A股', 'acc1']);
      }
      await insert(client, 'nav_history', ['username', 'account_name', 'date'], ['u1', 'A', '2026-10-30']);

      const capped = await repository.selectPositionCodesMissingPrice(['u1', 'A', '2026-09-30', 2, '2026-10-30'], client);
      assert.strictEqual(capped.rows.length, 2, '上限截断生效');
      const all = await repository.selectPositionCodesMissingPrice(['u1', 'A', '2026-09-30', 80, '2026-10-30'], client);
      assert.strictEqual(all.rows.length, 5, '实际有 5 只待补，本次只处理 2 只，剩 3 只没有落任何待办记录');

      const result = await backfillService.backfillMissingTodayPrices('u1', 'A', {
        today: '2026-10-30',
        limit: 2,
        backfill: async function () { return false; }
      });
      assert.strictEqual(result.remaining, undefined, '返回值没有「还剩多少没处理」');
      assert.strictEqual(result.skippedReason, undefined, '也没有截断原因');
    });
  } catch (error) {
    fail += 1;
    failures.push('执行异常：' + (error && error.message));
    console.log('  ✗ 执行异常 —— ' + (error && error.message));
  } finally {
    try { if (client) await client.end(); } catch (error) { /* 忽略关闭异常 */ }
    try {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [tmpDb]);
      await admin.query('DROP DATABASE IF EXISTS "' + tmpDb + '"');
    } catch (error) {
      console.log('清理临时库失败（需人工确认）：' + error.message);
    }
    await admin.end().catch(function () {});
  }

  console.log('\n--- 汇总 ---');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) failures.forEach(function (item) { console.log(' - ' + item); });
  process.exit(fail ? 1 : 0);
})();
