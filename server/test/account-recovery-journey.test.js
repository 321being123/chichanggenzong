// S4 数据恢复试点：导入 → 行情 → 持仓基准 → 净值 旅程的可复现样本（2026-10-30 首次，同日复查后重写）
//
// 覆盖两类问题：
//   ① 持仓基准「首次只写一部分就再也不补」——被缺价/缺汇率过滤掉的证券此前永久缺失；
//   ② 补价「超过批次上限的部分被静默丢弃」——没有剩余记录、没有下次执行时间，重启也捡不回来。
// 全部在隔离临时库执行，结束后删库；不访问外部行情（采集器由测试注入）。
//
// 连接池归属：业务模块按 process.env 在 require 时建池，所以必须先指到临时库再 require，
// 否则会对准开发库建表/查询（2026-10-30 踩过）。
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

async function addPosition(client, code, quantity, price, subtype = 'A股') {
  await insert(client, 'positions',
    ['username', 'account_name', 'code', 'quantity', 'price', 'subtype', 'account_id'],
    ['u1', 'A', code, quantity, price, subtype, 'acc1']);
}

async function reset(client) {
  await client.query('TRUNCATE positions, nav_history, daily_prices, nav_position_snapshots, market.fx_rates');
}

async function snapshotCodes(client) {
  const { rows } = await client.query(
    'SELECT instrument_code FROM nav_position_snapshots ORDER BY instrument_code'
  );
  return rows.map(row => row.instrument_code);
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
    // 统一入口只把 [SKIP] 认作跳过；此前这里打印纯文本 SKIP，可能被计成通过。
    console.log('[SKIP] 本地 PostgreSQL 不可用（' + error.message + '），本文件未验证。');
    process.exit(0);
  }

  try {
    await admin.query('CREATE DATABASE "' + tmpDb + '"');
    client = new Client(Object.assign(baseConfig(), { database: tmpDb }));
    await client.connect();
    await client.query(SCHEMA_SQL);

    // 业务模块必须在库名指向临时库之后再加载，避免连接池落到开发库。
    if (process.env.DATABASE_URL) {
      const url = new URL(process.env.DATABASE_URL);
      url.pathname = '/' + tmpDb;
      process.env.DATABASE_URL = url.toString();
    } else {
      process.env.PGDATABASE = tmpDb;
    }
    const repository = require('../repositories/accountPriceBackfillRepository');
    const basisService = require('../services/accountPositionBasis');
    const backfillService = require('../services/accountPriceBackfill');
    const job = require('../jobs/accountPriceBackfill');

    await test('场景1：导入后 nav_history 为空，仍能选出当天待补证券', async function () {
      await reset(client);
      await addPosition(client, '601995', 100, 30);
      // need_dates 把目标业务日并入，新导入账户当天就能补（此前空表导致一只都选不出来）。
      const { rows } = await repository.selectPositionCodesMissingPrice(
        ['u1', 'A', '2026-09-30', 80, '2026-10-30'], client
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].code, '601995');
      assert.strictEqual(rows[0].first_missing, '2026-10-30');
    });

    await test('场景2：nav_history 有历史日期时按最早缺口日回溯', async function () {
      await reset(client);
      await addPosition(client, '601995', 100, 30);
      await insert(client, 'nav_history', ['username', 'account_name', 'date'], ['u1', 'A', '2026-10-20']);
      const { rows } = await repository.selectPositionCodesMissingPrice(
        ['u1', 'A', '2026-09-30', 80, '2026-10-30'], client
      );
      assert.strictEqual(rows[0].first_missing, '2026-10-20', '按最早缺口日拉起，而不是只补当天');
    });

    // 规则 ACCOUNT-BASIS-BACKFILL-001：按业务日核缺口补齐，已有快照不覆盖不改写，补后重读用实际状态出结论。
    await test('场景3：首次只写一部分后，补回行情再调用能补齐（复查 P1 ①）', async function () {
      await reset(client);
      await addPosition(client, '601995', 100, 30);
      await addPosition(client, '110001', 200, 0, '可转债');

      const first = await basisService.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
      assert.strictEqual(first.created, 1, '缺价格的证券被过滤，只写有价格的那一只');
      assert.strictEqual(first.covered, false);
      assert.deepStrictEqual(first.skipped, ['110001']);
      assert.strictEqual(first.reasons.no_price, 1, '要报出没写成的具体原因');
      assert.deepStrictEqual(await snapshotCodes(client), ['601995']);

      // 行情补回来（等价于补价任务成功写入当日价）
      await insert(client, 'daily_prices', ['username', 'account_name', 'date', 'code', 'price'],
        ['u1', 'A', '2026-10-30', '110001', 105]);
      const second = await basisService.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
      assert.strictEqual(second.created, 1, '补齐此前被跳过的证券——这正是复查发现的缺口');
      assert.strictEqual(second.covered, true);
      assert.deepStrictEqual(second.skipped, []);
      assert.deepStrictEqual(await snapshotCodes(client), ['110001', '601995']);

      // 幂等：再跑一次不重复写
      const third = await basisService.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
      assert.strictEqual(third.created, 0, '重复调用必须幂等');
      assert.strictEqual(third.covered, true);
      const total = await client.query('SELECT count(*)::int AS n FROM nav_position_snapshots');
      assert.strictEqual(total.rows[0].n, 2, '不得重复插入');
    });

    await test('场景4：港股缺汇率时报出原因，补汇率后能补齐', async function () {
      await reset(client);
      await addPosition(client, '00700', 100, 400, '港股');
      const first = await basisService.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
      assert.strictEqual(first.created, 0, '没有汇率就不写，避免算出错误的人民币市值');
      assert.strictEqual(first.reasons.missing_fx, 1, '原因要指向缺汇率，而不是笼统的"没写成"');

      await insert(client, 'market.fx_rates',
        ['base_currency', 'quote_currency', 'rate', 'rate_date', 'fetched_at'],
        ['HKD', 'CNY', 0.868, '2026-10-30', '2026-10-30T10:00:00Z']);
      const second = await basisService.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
      assert.strictEqual(second.created, 1);
      assert.strictEqual(second.covered, true);
      const stored = await client.query(
        'SELECT quote_currency, market_value_cny FROM nav_position_snapshots WHERE instrument_code=$1', ['00700']
      );
      assert.strictEqual(stored.rows[0].quote_currency, 'HKD');
      assert.strictEqual(Number(stored.rows[0].market_value_cny), 34720, '100 × 400 × 0.868 = 34720');
    });

    await test('场景5：已有快照保持原事实，不被当前持仓覆盖', async function () {
      await reset(client);
      await addPosition(client, '601995', 100, 30);
      await addPosition(client, '110001', 200, 50, '可转债');
      // 预置一行来自导入的原始事实
      await insert(client, 'nav_position_snapshots',
        ['snapshot_id', 'username', 'account_name', 'snapshot_date', 'instrument_code',
          'quantity', 'price', 'quote_currency', 'fx_rate_to_cny', 'market_value_cny', 'source', 'account_id'],
        ['orig-1', 'u1', 'A', '2026-10-30', '601995', 50, 999, 'CNY', 1, 49950, 'import', 'acc1']);

      const result = await basisService.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
      assert.strictEqual(result.created, 1, '只补缺失的那一只');
      const original = await client.query(
        'SELECT quantity, price, source FROM nav_position_snapshots WHERE snapshot_id=$1', ['orig-1']
      );
      assert.strictEqual(Number(original.rows[0].quantity), 50, '历史数量不得被当前持仓改写');
      assert.strictEqual(Number(original.rows[0].price), 999, '历史价格不得被改写');
      assert.strictEqual(original.rows[0].source, 'import', '来源必须保留');
    });

    // 规则 ACCOUNT-PRICE-CONTINUATION-002：超单批上限的剩余必须持久化并可续跑，缺口清空前不得宣告完成。
    await test('场景6：超过批次上限的剩余（81→80）被记录并可续跑到清空（复查 P1 ②）', async function () {
      await reset(client);
      // 81 只持仓：旧实现处理 80 只就收工，第 81 只既没记录也没下次时间。
      await client.query(
        `INSERT INTO positions(username, account_name, code, quantity, price, subtype, account_id)
         SELECT 'u1', 'A', '6' || lpad(i::text, 5, '0'), 100, 10, 'A股', 'acc1'
           FROM generate_series(1, 81) i`
      );
      // 采集器注入：写入当日价并回报成功，不访问外部行情。
      const collector = async function (username, accountName, code, start, end) {
        await client.query(
          'INSERT INTO daily_prices(username, account_name, date, code, price) VALUES ($1,$2,$3,$4,$5)',
          [username, accountName, end, code, 11]
        );
        return true;
      };

      const firstBatch = await job.runAccountPriceBackfill('manual', {
        username: 'u1', accountName: 'A', targetDate: '2026-10-30', backfill: collector,
      });
      assert.strictEqual(firstBatch.status, 'partial');
      assert.strictEqual(firstBatch.continuationRequired, true, '剩余未清空前不得宣告完成');
      assert.strictEqual(firstBatch.batch.checked, 80, '单批上限生效');
      assert.strictEqual(firstBatch.batch.filled, 80);
      assert.strictEqual(firstBatch.remaining, 1, '剩余必须由数据库实际状态算出');
      assert.deepStrictEqual(firstBatch.pendingStages, ['priceBackfill']);
      assert.strictEqual(firstBatch.nextAttemptInMinutes, 1, '必须给出下次执行时间');
      assert.strictEqual(firstBatch.initialRemaining, 81, '记下首批总量，便于判断进度');

      // 续跑第二批：Runner 会把上一批的 result_summary 字段回传成 context。
      const secondBatch = await job.runAccountPriceBackfill('scheduled', {
        username: 'u1', accountName: 'A', targetDate: '2026-10-30', backfill: collector,
        continuationCount: firstBatch.continuationCount,
        initialRemaining: firstBatch.initialRemaining,
        lastRemaining: firstBatch.lastRemaining,
        noProgressCount: 0,
      });
      assert.strictEqual(secondBatch.remaining, 0);
      assert.strictEqual(secondBatch.status, 'complete', '缺口清空后才算完成');
      assert.strictEqual(secondBatch.continuationRequired, undefined);
      const missing = await repository.countPositionCodesMissingPrice(['u1', 'A', '2026-09-30', '2026-10-30'], client);
      assert.strictEqual(missing, 0, '81 只全部补齐');
    });

    await test('场景7：连续无进展时停止续跑，转人工处理', async function () {
      await reset(client);
      await client.query(
        `INSERT INTO positions(username, account_name, code, quantity, price, subtype, account_id)
         SELECT 'u1', 'A', '7' || lpad(i::text, 5, '0'), 100, 10, 'A股', 'acc1'
           FROM generate_series(1, 5) i`
      );
      const failing = async function () { return false; };
      // 第一批：基准快照写成功（算进展），行情全失败 → 允许继续续跑。
      const first = await job.runAccountPriceBackfill('manual', {
        username: 'u1', accountName: 'A', targetDate: '2026-10-30', backfill: failing,
      });
      assert.strictEqual(first.basis.created, 5, '基准补齐成功，本批有进展');
      assert.strictEqual(first.noProgressCount, 0, '有进展时不累计无进展次数');
      assert.strictEqual(first.remaining, 5, '行情全失败，剩余仍是 5 只');
      assert.strictEqual(first.continuationBlocked, undefined);

      // 第二批：基准已无缺口、行情仍全失败 → 第一次无进展。
      const second = await job.runAccountPriceBackfill('scheduled', {
        username: 'u1', accountName: 'A', targetDate: '2026-10-30', backfill: failing,
        noProgressCount: first.noProgressCount,
        initialRemaining: first.initialRemaining,
      });
      assert.strictEqual(second.basis.created, 0, '基准已补齐');
      assert.strictEqual(second.noProgressCount, 1);

      // 第三批：连续第二次无进展 → 停止续跑，转人工。
      const third = await job.runAccountPriceBackfill('scheduled', {
        username: 'u1', accountName: 'A', targetDate: '2026-10-30', backfill: failing,
        noProgressCount: second.noProgressCount,
        initialRemaining: first.initialRemaining,
      });
      assert.strictEqual(third.noProgressCount, 2);
      assert.strictEqual(third.continuationBlocked, true, '连续两批无进展必须停下');
      assert.ok(String(third.continuationStopReason).includes('暂停'), '停止原因要可读');
    });

    await test('场景8：缺少账户标识时任务如实失败，不静默成功', async function () {
      const result = await job.runAccountPriceBackfill('manual', {});
      assert.strictEqual(result.ok, false);
      assert.ok(String(result.error).includes('账户标识'));
    });

    await test('场景9：补价返回值带出真实剩余数（不再是 undefined）', async function () {
      await reset(client);
      await addPosition(client, '601995', 100, 30);
      await addPosition(client, '110001', 200, 30, '可转债');
      const result = await backfillService.backfillMissingTodayPrices('u1', 'A', {
        today: '2026-10-30',
        limit: 1,
        backfill: async function () { return false; },
      });
      assert.strictEqual(result.checked, 1, '单批上限生效');
      assert.strictEqual(result.remaining, 2, '两只都还没补上，剩余必须是真实值');
    });
  } catch (error) {
    fail += 1;
    failures.push('执行异常：' + (error && error.message));
    console.log('  ✗ 执行异常 —— ' + (error && error.message));
  } finally {
    try { if (client) await client.end(); } catch (error) { /* 忽略关闭异常 */ }
    try {
      // 业务连接池也指向临时库，先关掉再删库
      try { await require('../db/connection').pool.end(); } catch (error) { /* 未建池则忽略 */ }
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
