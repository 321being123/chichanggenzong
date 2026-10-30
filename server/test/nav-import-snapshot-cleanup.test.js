// 导入不再累积孤儿快照批次（方案 A2，2026-10-30）
//
// 缺陷：`upsertImportedNav` 在 (username, account_name, date) 冲突时把 import_batch_id 改指向新批次，
// 而导入前只删「本次批次」的快照，上一批次整套行就无人引用地留下。生产实测 38 个批次只有 2 个仍被引用。
//
// A2 的取舍（必须一起验，缺一条就可能把回滚或净值锚点弄坏）：
//   ① 只清「本次导入之前就已经没人引用」的批次——本次刚取代的上一批次必须留，回滚要靠它；
//   ② 基准行（source='manual_reconciliation'）永不参与清理——编号是 basis-…，按引用一刀切会删掉锚点；
//   ③ 行数有界：同一份文件反复导入，最多比单批次多留一个批次，不会一直涨；
//   ④ 回滚后，回滚前的锚点仍能解析出来。
//
// 走真实入口：express + accountsRouter + 真实库（run-all 下是隔离测试库），不做 SQL 层模拟。
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const { pool, loadAccountData, saveAccountData } = require('../db');
const accountsRouter = require('../routes/accounts');
const { todayCN } = require('../services/market');
const navImportRepository = require('../repositories/navImportRepository');

const U = 'nav_snapshot_cleanup_test';
const A = '导入清理回归账户';
const TODAY = todayCN();
const BASIS_DATE = '2026-08-16';

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

async function reset() {
  for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices',
    'nav_position_snapshots', 'nav_import_batches', 'account_data', 'accounts']) {
    await pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]);
  }
  await pool.query('DELETE FROM users WHERE username=$1', [U]);
  await pool.query(
    `INSERT INTO users (username,password,accounts,role,status) VALUES ($1,'x',$2,'user','active')`,
    [U, JSON.stringify([A])]
  );
  const accountId = crypto.createHash('sha256').update(U + '\n' + A).digest('hex');
  await pool.query(
    `INSERT INTO accounts (id,username,account_name,cash_base,hk_rate,version,updated_at)
     VALUES ($1,$2,$3,0,0.85,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`, [accountId, U, A]
  );
  await saveAccountData(U, A, {
    positions: [
      { id: 'p1', code: '601995', name: '中金公司', price: 30, quantity: 100, cost: 28, type: '股权', subtype: 'A股', note: '' },
      { id: 'p2', code: '110001', name: '转债甲', price: 105.5, quantity: 10, cost: 100, type: '债券', subtype: '可转债', note: '' }
    ],
    trades: [], navHistory: [], cashFlows: [], cash: 0, cashBase: 0, hkRate: 0.85, feeSettings: {}
  }, 0, { positions: 0, trades: 0, navHistory: 0, cashFlows: 0 });
  return accountId;
}

function snapshotIds() {
  return pool.query('SELECT snapshot_id, count(*)::int AS n FROM nav_position_snapshots WHERE username=$1 GROUP BY 1 ORDER BY 1', [U])
    .then(r => r.rows);
}

function totalSnapshots() {
  return pool.query('SELECT count(*)::int AS n FROM nav_position_snapshots WHERE username=$1', [U]).then(r => r.rows[0].n);
}

(async () => {
  let server;
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.log('--- 导入快照清理回归 ---');
    console.log('[SKIP] 本地 PostgreSQL 不可用（' + error.message + '），本文件未验证。');
    process.exit(0);
  }

  try {
    const accountId = await reset();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: U, authVersion: 1 }; next(); });
    app.use('/api', accountsRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api';

    // 注意：完全相同的文件会被 `findImportBatch`（id=inputHash）按幂等返回，根本不建新批次。
    // 生产里产生多批次的是「同一份导出、数值有修正后再导一次」，所以这里让每次的总资产不同。
    async function importOnce(batchId, totalAsset) {
      const before = await loadAccountData(U, A);
      const res = await fetch(base + '/nav/import?version=' + before.version, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: A,
          records: [{ date: TODAY, nav: totalAsset, totalAsset, invested: 4000, cash: 2000 }],
          mode: 'merge',
          importBatchId: batchId
        })
      });
      const json = await res.json();
      assert.strictEqual(res.status, 200, '导入应成功：' + JSON.stringify(json));
      assert.strictEqual(json.idempotent, undefined, '内容不同，不能走幂等返回');
      return json;
    }

    // 一条人工基准行：它永远不会被 import_batch_id 引用，正是 2026-10-30 被误删的那类数据。
    await pool.query(
      `INSERT INTO nav_position_snapshots(snapshot_id, username, account_name, account_id, snapshot_date,
                                          instrument_code, quantity, price, quote_currency, fx_rate_to_cny, market_value_cny, source)
       VALUES ('basis-' || $1 || '-2026-08-16-601995', $1, $2, $3, $4, '601995', 50, 20, 'CNY', 1, 1000, 'manual_reconciliation')`,
      [U, A, accountId, BASIS_DATE]
    );

    const b1 = crypto.randomUUID();
    const b2 = crypto.randomUUID();
    const b3 = crypto.randomUUID();

    await test('第 1 次导入：只写本批次快照，基准行不受影响', async function () {
      await importOnce(b1, 5000);
      const ids = await snapshotIds();
      assert.deepStrictEqual(ids.map(r => r.snapshot_id), ['basis-' + U + '-2026-08-16-601995', b1].sort(),
        '只有基准行和本批次：' + JSON.stringify(ids));
      assert.strictEqual(await totalSnapshots(), 3, '2 只持仓 + 1 条基准');
    });

    await test('第 2 次导入：上一批次变成孤儿但必须保留（回滚要用），基准行仍在', async function () {
      await importOnce(b2, 5001);
      const ids = await snapshotIds();
      const map = new Map(ids.map(r => [r.snapshot_id, r.n]));
      assert.strictEqual(map.get(b1), 2, '刚被取代的批次必须保留，否则回滚后锚点消失');
      assert.strictEqual(map.get(b2), 2, '新批次已写入');
      assert.strictEqual(map.get('basis-' + U + '-2026-08-16-601995'), 1, '基准行永不被清理');
      assert.strictEqual(await totalSnapshots(), 5);
    });

    await test('第 3 次导入：清掉「之前就已孤儿」的 b1，行数不再增长', async function () {
      await importOnce(b3, 5002);
      const ids = await snapshotIds();
      const map = new Map(ids.map(r => [r.snapshot_id, r.n]));
      assert.strictEqual(map.has(b1), false, 'b1 在本次导入前已无人引用，必须清掉');
      assert.strictEqual(map.get(b2), 2, 'b2 是本次刚取代的批次，必须保留');
      assert.strictEqual(map.get(b3), 2, 'b3 已写入');
      assert.strictEqual(map.get('basis-' + U + '-2026-08-16-601995'), 1, '基准行仍在');
      assert.strictEqual(await totalSnapshots(), 5, '行数停在同一水平（单批次 + 上一批次 + 基准）');
    });

    await test('第 4 次导入：行数仍不增长（有界，不是无限累积）', async function () {
      const b4 = crypto.randomUUID();
      await importOnce(b4, 5003);
      assert.strictEqual(await totalSnapshots(), 5, '第 4 次导入后行数应与第 3 次相同');
      const ids = (await snapshotIds()).map(r => r.snapshot_id);
      assert.strictEqual(ids.includes(b2), false, 'b2 已在本次之前变孤儿，被清掉');
      assert.ok(ids.includes(b3) && ids.includes(b4), '最近两个批次都在');
    });

    await test('导入后回滚：回滚前的锚点仍能解析，净值链不受影响', async function () {
      // 回滚最后一个批次，nav 行会按 backup_payload 恢复到上一批次（b3）的引用。
      const before = await loadAccountData(U, A);
      const latest = await pool.query(
        `SELECT id FROM nav_import_batches WHERE username=$1 AND account_name=$2 ORDER BY imported_at DESC, id DESC LIMIT 1`, [U, A]
      );
      const batchId = latest.rows[0].id;
      const res = await fetch(base + '/nav/import/' + batchId + '/rollback?version=' + before.version, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: A })
      });
      assert.strictEqual(res.status, 200, '回滚应成功：' + JSON.stringify(await res.json().catch(() => ({}))));
      const data = await loadAccountData(U, A);
      const nav = (data.navHistory || []).find(n => String(n.date).slice(0, 10) === TODAY);
      assert.ok(nav, '回滚后仍应有该日净值行');
      assert.strictEqual(String(nav.importBatchId), b3, '回滚后应指回上一批次');
      const rows = await pool.query(
        'SELECT count(*)::int AS n FROM nav_position_snapshots WHERE username=$1 AND snapshot_id=$2', [U, b3]
      );
      assert.ok(rows.rows[0].n > 0, '回滚后锚点快照必须还在，否则净值算不出来');
    });

    await test('按编号删除会拒绝基准行，空数组不做全表删除', async function () {
      const basisId = 'basis-' + U + '-2026-08-16-601995';
      const removed = await navImportRepository.deletePositionSnapshotsByIds({ snapshotIds: [basisId] });
      assert.strictEqual(removed.rowCount, 0, '即使把基准行编号传进来也不许删');
      const still = await pool.query(
        'SELECT count(*)::int AS n FROM nav_position_snapshots WHERE username=$1 AND snapshot_id=$2', [U, basisId]
      );
      assert.strictEqual(still.rows[0].n, 1, '基准行必须还在');

      const empty = await navImportRepository.deletePositionSnapshotsByIds({ snapshotIds: [] });
      assert.strictEqual(empty.rowCount, 0, '空数组必须直接返回，不能退化成全表删除');
      assert.ok((await totalSnapshots()) > 0, '表不能被空操作清空');
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices',
        'nav_position_snapshots', 'nav_import_batches', 'account_data', 'accounts']) {
        await pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]);
      }
      await pool.query('DELETE FROM users WHERE username=$1', [U]);
    } catch (error) {
      console.log('清理测试数据失败（可忽略）：' + error.message);
    }
    await pool.end().catch(() => {});
  }

  console.log('导入快照清理回归：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) {
    failures.forEach(item => console.log('  失败：' + item));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
