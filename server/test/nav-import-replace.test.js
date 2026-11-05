// N2：收益导入 `mode='replace'` 全量替换 + 回滚真实旅程（2026-11-02 补缺口）
//
// 缺口来源：`nav-import-snapshot-cleanup.test.js` 只覆盖 `mode='merge'`；`replace` 分支
// （先 `deleteAllNav` 再逐行 upsert）此前没有任何真实入口证据。这条分支的风险很具体：
//   ① 它是唯一会**删除** nav_history 已存在行的导入路径，误删就没有原始事实；
//   ② 它同时决定「锚点要不要重建」（`preserveExistingAnchor=false`），锚点算错会污染净值归因；
//   ③ 回滚必须能从 `backup_payload` 把被删的行连同**旧 import_batch_id** 一起还原，
//      否则回滚后行还在、批次引用没了，下一次清理就会把它们当孤儿删掉。
//
// 本文件走真实入口：express + accountsRouter + 真实库（run-all 下是隔离测试库），
// 不做 SQL 层模拟，也不改动 shared 库里的任何真实账户。
'use strict';

const assert = require('assert');
const { testSession } = require('./helpers/session-subject');
const crypto = require('crypto');
const express = require('express');
const { pool, loadAccountData, saveAccountData } = require('../db');
const accountsRouter = require('../routes/accounts');
const { todayCN } = require('../services/market');

const U = 'nav_import_replace_test';
const A = '替换导入回归账户';
const TODAY = todayCN();
// 用正午锚点做日期减法，避免 UTC 截日把「昨天」算成今天。
const YESTERDAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
  .format(new Date(Date.parse(TODAY + 'T12:00:00+08:00') - 86400000));

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
    "INSERT INTO users (username,password,accounts,role,status) VALUES ($1,'x',$2,'user','active')",
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
    ],
    trades: [], navHistory: [], cashFlows: [], cash: 0, cashBase: 0, hkRate: 0.85, feeSettings: {},
  }, 0, { positions: 0, trades: 0, navHistory: 0, cashFlows: 0 });
  return accountId;
}

function navRows() {
  return pool.query(
    'SELECT date, total_asset, import_batch_id FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date', [U, A]
  ).then(r => r.rows.map(x => ({
    date: String(x.date).slice(0, 10),
    totalAsset: Number(x.total_asset),
    batchId: x.import_batch_id,
  })));
}

// 快照批次编号存在 snapshot_id 里（insertPositionSnapshot 第一个参数就是 importBatchId）；
// 基准行是 `basis-…` 编号，不是批次，必须排除。
function snapshotBatches() {
  return pool.query(
    `SELECT DISTINCT snapshot_id FROM nav_position_snapshots
      WHERE username=$1 AND source <> 'manual_reconciliation' AND snapshot_id NOT LIKE 'basis-%'
      ORDER BY 1`, [U]
  ).then(r => r.rows.map(x => x.snapshot_id));
}

function basisSnapshotCount() {
  return pool.query(
    "SELECT count(*)::int AS n FROM nav_position_snapshots WHERE username=$1 AND snapshot_date=$2 AND source='manual_reconciliation'",
    [U, '2026-08-16']
  ).then(r => r.rows[0].n);
}

(async () => {
  let server;
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.log('--- 收益导入 replace 回归 ---');
    console.log('[SKIP] 本地 PostgreSQL 不可用（' + error.message + '），本文件未验证。');
    process.exit(0);
  }

  try {
    console.log('[阶段] 准备账户数据…');
    const accountId = await reset();
    console.log('[阶段] 启动测试服务…');
    const app = express();
    app.use(express.json());
    app.use(async (req, res, next) => { req.session = await testSession(U); next(); });
    app.use('/api', accountsRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api';

    async function importNav(batchId, records, mode) {
      const before = await loadAccountData(U, A);
      const res = await fetch(base + '/nav/import?version=' + before.version, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: A, records, mode, importBatchId: batchId }),
      });
      const json = await res.json();
      assert.strictEqual(res.status, 200, '导入应成功：' + JSON.stringify(json));
      return json;
    }

    async function rollback(batchId) {
      const before = await loadAccountData(U, A);
      const res = await fetch(base + '/nav/import/' + batchId + '/rollback?version=' + before.version, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: A }),
      });
      const json = await res.json();
      assert.strictEqual(res.status, 200, '回滚应成功：' + JSON.stringify(json));
      return json;
    }

    // 一条人工基准行：replace 的 deleteAllNav 只删 nav_history，不得碰快照基准。
    await pool.query(
      `INSERT INTO nav_position_snapshots(snapshot_id, username, account_name, account_id, snapshot_date,
                                          instrument_code, quantity, price, quote_currency, fx_rate_to_cny, market_value_cny, source)
       VALUES ('basis-' || $1 || '-2026-08-16-601995', $1, $2, $3, '2026-08-16', '601995', 50, 20, 'CNY', 1, 1000, 'manual_reconciliation')`,
      [U, A, accountId]
    );

    const b1 = crypto.randomUUID();
    const b2 = crypto.randomUUID();

    await test('第 1 步：merge 导入两天（昨天 + 今天），两行都指向 b1', async function () {
      await importNav(b1, [
        { date: YESTERDAY, nav: 1.0, totalAsset: 5000, invested: 4000, cash: 2000 },
        { date: TODAY, nav: 1.1, totalAsset: 5500, invested: 4000, cash: 2000 },
      ], 'merge');
      const rows = await navRows();
      assert.deepStrictEqual(rows.map(r => r.date), [YESTERDAY, TODAY]);
      assert.deepStrictEqual(rows.map(r => r.batchId), [b1, b1], 'merge 写入的行必须记在 b1 名下');
      assert.deepStrictEqual(rows.map(r => r.totalAsset), [5000, 5500]);
      assert.strictEqual(await basisSnapshotCount(), 1, '人工基准行不应被导入影响');
    });

    await test('第 2 步：replace 只导入今天 → 昨天的行被删除，今天被改为新值', async function () {
      await importNav(b2, [
        { date: TODAY, nav: 1.2, totalAsset: 6000, invested: 4000, cash: 2500 },
      ], 'replace');
      const rows = await navRows();
      assert.deepStrictEqual(rows.map(r => r.date), [TODAY], 'replace 必须清掉本账户之前所有 nav 行');
      assert.strictEqual(rows[0].totalAsset, 6000, 'replace 必须写入本次的券商数值');
      assert.strictEqual(rows[0].batchId, b2, 'replace 后的行必须记在 b2 名下');
      assert.strictEqual(await basisSnapshotCount(), 1, 'replace 不得删除人工基准快照');
    });

    await test('第 3 步：replace 后 b1 的快照仍保留（回滚要用），b2 也已落快照', async function () {
      const batches = await snapshotBatches();
      assert.ok(batches.includes(b1), '被 replace 取代的 b1 快照必须保留，否则回滚无从恢复锚点');
      assert.ok(batches.includes(b2), '本次 replace 的锚点快照必须落下');
    });

    await test('第 4 步：回滚 b2 → 两行原样恢复，且今天那行重新指回 b1', async function () {
      await rollback(b2);
      const rows = await navRows();
      assert.deepStrictEqual(rows.map(r => r.date), [YESTERDAY, TODAY], '回滚必须恢复被 replace 删掉的历史行');
      assert.deepStrictEqual(rows.map(r => r.totalAsset), [5000, 5500], '回滚必须恢复原来的数值，而不是本次 replace 的数值');
      assert.deepStrictEqual(rows.map(r => r.batchId), [b1, b1],
        '恢复的行必须连同旧 import_batch_id 一起还原（否则下次清理会把它们当孤儿批次删掉）');
      assert.strictEqual(await basisSnapshotCount(), 1, '回滚不得影响人工基准行');
    });

    await test('第 5 步：回滚 b2 后，b2 的快照被清掉、b1 的仍可解析', async function () {
      const batches = await snapshotBatches();
      assert.ok(!batches.includes(b2), '回滚必须清掉本批次自己的快照');
      assert.ok(batches.includes(b1), 'b1 快照必须保留，nav 行仍引用它');
    });

    await test('第 6 步：重复回滚同一批次走幂等，不重复写行', async function () {
      const again = await rollback(b2);
      assert.strictEqual(again.idempotent, true, '已回滚批次必须走幂等返回，不能重复执行');
      const rows = await navRows();
      assert.strictEqual(rows.length, 2, '幂等回滚不得改变行数');
    });

    await test('第 7 步：连续 replace 同一份数据两次不会累积 nav 行', async function () {
      const b3 = crypto.randomUUID();
      const b4 = crypto.randomUUID();
      await importNav(b3, [{ date: TODAY, nav: 1.3, totalAsset: 6100, invested: 4000, cash: 2500 }], 'replace');
      await importNav(b4, [{ date: TODAY, nav: 1.4, totalAsset: 6200, invested: 4000, cash: 2500 }], 'replace');
      const rows = await navRows();
      assert.strictEqual(rows.length, 1, 'replace 是替换语义，反复导入不得让 nav 行累积');
      assert.strictEqual(rows[0].totalAsset, 6200, '最终保留的必须是最后一次导入的值');
      assert.strictEqual(rows[0].batchId, b4);
      // 快照侧：只应剩下「仍被引用/上一批留作回滚」的批次，不能每导一次就永久多一套。
      const batches = await snapshotBatches();
      assert.ok(batches.length <= 3,
        '同一天反复 replace 后快照批次数必须有界（实际 ' + batches.length + ' 批：' + batches.join(',') + '）');
    });

    await test('第 8 步：非法 replace（现金大于总资产）被拒绝，且不删除已有 nav 行', async function () {
      const before = await navRows();
      const res = await fetch(base + '/nav/import?version=' + (await loadAccountData(U, A)).version, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: A, mode: 'replace', importBatchId: crypto.randomUUID(),
          records: [{ date: TODAY, nav: 1.5, totalAsset: 1000, invested: 4000, cash: 5000 }],
        }),
      });
      assert.ok(res.status >= 400, '现金大于总资产必须被拒绝');
      assert.deepStrictEqual(await navRows(), before,
        '校验失败必须发生在删除之前——不能先清空再报错');
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

  console.log('收益导入 replace 回归：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) {
    failures.forEach(item => console.log('  失败：' + item));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
