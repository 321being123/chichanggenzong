// 导入批次归属与幂等状态（F01 / F03）。
//
// F01：批次号是全局主键。B 账户用一个已属于 A 账户的 importBatchId 时，
//      旧实现按 (username, account_name) 查不到，插入被 ON CONFLICT DO NOTHING 静默跳过，
//      代码继续写 B 的净值，并在锚点分支按同一 ID 删掉 A 的快照。
// F03：回滚把批次改成 rolled_back，但幂等判定不读 status，同一份文件再用新批次号重导
//      会命中旧批次直接 200，一行净值都没写。
//
// 走真实入口：express + accountsRouter + 真实 PG（run-all 下是隔离测试库），不做 SQL 层模拟。
// 断言的边界都限定在本文件自建的 (用户, 账户) 内，不扫描全库。
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const { pool, loadAccountData, saveAccountData } = require('../db');
const accountsRouter = require('../routes/accounts');
const { todayCN } = require('../services/market');
const { attachTestSession } = require('./helpers/session-subject');

const U1 = 'nav_import_owner_test_a';
const U2 = 'nav_import_owner_test_b';
const ACC_A = '归属测试账户A';
const ACC_B = '归属测试账户B';
const TODAY = todayCN();

let server = null;
let serverB = null;
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

function accountIdOf(username, accountName) {
  return crypto.createHash('sha256').update(username + '\n' + accountName).digest('hex');
}

async function purge(username) {
  for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices',
    'nav_position_snapshots', 'nav_import_batches', 'account_data', 'accounts']) {
    await pool.query(`DELETE FROM ${t} WHERE username=$1`, [username]);
  }
  await pool.query('DELETE FROM users WHERE username=$1', [username]);
}

async function seedUser(username, accountName) {
  await purge(username);
  await pool.query(
    `INSERT INTO users (username,password,accounts,role,status) VALUES ($1,'x',$2,'user','active')`,
    [username, JSON.stringify([accountName])]
  );
  await pool.query(
    `INSERT INTO accounts (id,username,account_name,cash_base,hk_rate,version,updated_at)
     VALUES ($1,$2,$3,0,0.85,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,
    [accountIdOf(username, accountName), username, accountName]
  );
  await saveAccountData(username, accountName, { positions: [], trades: [], cashFlows: [], navHistory: [] });
}

async function route(username) {
  const app = express();
  app.use(express.json());
  app.use(await attachTestSession(username));
  app.use('/api', accountsRouter);
  return new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ s, base: 'http://127.0.0.1:' + s.address().port + '/api' }));
  });
}

async function post(base, path, body) {
  const before = await loadAccountData(body.__user, body.account);
  const payload = Object.assign({}, body);
  delete payload.__user;
  const res = await fetch(base + path + '?version=' + before.version, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json(), versionUsed: before.version };
}

async function navRows(username, accountName) {
  const { rows } = await pool.query(
    `SELECT date::text AS date, nav::float8 AS nav, import_batch_id AS "importBatchId", snapshot_source AS "snapshotSource"
       FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date`, [username, accountName]);
  return rows;
}

async function snapshotRows(username, accountName) {
  const { rows } = await pool.query(
    `SELECT snapshot_id, instrument_code FROM nav_position_snapshots WHERE username=$1 AND account_name=$2 ORDER BY snapshot_id, instrument_code`,
    [username, accountName]);
  return rows;
}

async function main() {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.log('--- 导入批次归属回归 ---');
    console.log('[SKIP] 本地 PostgreSQL 不可用（' + error.message + '），本文件未验证。');
    process.exit(0);
  }

  try {
    // 迁移必须跑到最新：F04 的 users.subject_id 与 F03 的批次唯一索引都在这一轮新增。
    await require('../db/migrations').runMigrations();
    await seedUser(U1, ACC_A);
    await seedUser(U2, ACC_B);
    const started = await route(U1);
    server = started.s;
    const { base } = started;
    // 跨账户用例必须是"B 用自己的合法会话"，否则会被 assertOwnership 先挡成 403，
    // 验证不到批次归属这一层。
    const startedB = await route(U2);
    serverB = startedB.s;
    const baseB = startedB.base;

    const record = (navValue) => ({
      date: TODAY, nav: navValue, totalAsset: navValue * 1000, invested: 1000, cash: 200,
    });

    // 先让 A 账户有一次真实导入，留下 A 的净值与快照
    const batchA = 'batch-owner-A-001';
    const firstA = await post(base, '/nav/import', { __user: U1, account: ACC_A, records: [record(1.5)], mode: 'merge', importBatchId: batchA });
    assert.strictEqual(firstA.status, 200, 'A 首次导入应成功：' + JSON.stringify(firstA.json));
    const aNavBefore = await navRows(U1, ACC_A);
    const aSnapBefore = await snapshotRows(U1, ACC_A);

    await test('F01 他人批次号：拒绝且零业务写入，A 的净值/快照/版本都不变', async () => {
      const beforeVersion = (await loadAccountData(U2, ACC_B)).version;
      const clash = await post(baseB, '/nav/import', {
        __user: U2, account: ACC_B, records: [record(9.9)], mode: 'merge', importBatchId: batchA,
      });
      assert.strictEqual(clash.status, 409, '跨账户批次号必须拒绝：' + JSON.stringify(clash.json));
      assert.deepStrictEqual(await navRows(U2, ACC_B), [], 'B 不能写入任何净值');
      assert.deepStrictEqual(await snapshotRows(U2, ACC_B), [], 'B 不能写入任何快照');
      assert.strictEqual((await loadAccountData(U2, ACC_B)).version, beforeVersion, 'B 的版本不能被推进');
      assert.deepStrictEqual(await navRows(U1, ACC_A), aNavBefore, 'A 的净值必须完全不变');
      assert.deepStrictEqual(await snapshotRows(U1, ACC_A), aSnapBefore, 'A 的快照必须完全不变（不能被按 ID 裸删）');
    });

    await test('F01 同账户同请求重试仍只产生一次结果（幂等）', async () => {
      const retry = await post(base, '/nav/import', { __user: U1, account: ACC_A, records: [record(1.5)], mode: 'merge', importBatchId: batchA });
      assert.strictEqual(retry.status, 200, JSON.stringify(retry.json));
      assert.strictEqual(retry.json.idempotent, true, '同批次同内容必须走幂等');
      assert.strictEqual((await navRows(U1, ACC_A)).length, aNavBefore.length, '不得新增净值行');
    });

    await test('F03 回滚后同内容重导：新批次必须真正写入，不能再报幂等成功', async () => {
      const rollback = await post(base, `/nav/import/${batchA}/rollback`, { __user: U1, account: ACC_A });
      assert.strictEqual(rollback.status, 200, JSON.stringify(rollback.json));
      assert.deepStrictEqual(await navRows(U1, ACC_A), [], '回滚后库内不应残留该批次净值');

      const reimport = await post(base, '/nav/import', {
        __user: U1, account: ACC_A, records: [record(1.5)], mode: 'merge', importBatchId: 'batch-owner-A-002',
      });
      assert.strictEqual(reimport.status, 200, '回滚后重导必须成功：' + JSON.stringify(reimport.json));
      assert.notStrictEqual(reimport.json.idempotent, true, '已回滚批次不能被当成幂等命中');
      const rows = await navRows(U1, ACC_A);
      assert.strictEqual(rows.length, 1, '必须真的写入 1 行净值，实际 ' + rows.length);
      assert.strictEqual(rows[0].importBatchId, 'batch-owner-A-002', '净值必须指向新批次');
    });

    await test('F03 已回滚的批次号不能复活：复用同一批次号必须拒绝', async () => {
      const reuse = await post(base, '/nav/import', {
        __user: U1, account: ACC_A, records: [record(1.5)], mode: 'merge', importBatchId: batchA,
      });
      assert.strictEqual(reuse.status, 409, '已回滚批次号必须拒绝复用：' + JSON.stringify(reuse.json));
      assert.strictEqual((await navRows(U1, ACC_A)).length, 1, '拒绝时不能产生额外写入');
    });

    await test('F03 重复回滚保持幂等，不回滚第二次', async () => {
      const again = await post(base, `/nav/import/batch-owner-A-002/rollback`, { __user: U1, account: ACC_A });
      assert.strictEqual(again.status, 200, JSON.stringify(again.json));
      const twice = await post(base, `/nav/import/batch-owner-A-002/rollback`, { __user: U1, account: ACC_A });
      assert.strictEqual(twice.status, 200, JSON.stringify(twice.json));
      assert.strictEqual(twice.json.idempotent, true, '第二次回滚必须是幂等返回');
      assert.deepStrictEqual(await navRows(U1, ACC_A), [], '回滚后不应有净值');
    });
  } finally {
    for (const s of [server, serverB]) {
      if (s) await new Promise(resolve => s.close(resolve));
    }
    for (const user of [U1, U2]) await purge(user).catch(() => {});
  }

  console.log('导入批次归属与幂等状态：' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail);
  if (fail) {
    failures.forEach(item => console.log('  失败：' + item));
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
