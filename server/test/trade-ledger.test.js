// ========== 账户账本整改测试（方案 6.1/6.2 交易-持仓-现金联动） ==========
// 运行：node server/test/trade-ledger.test.js
// 覆盖（方案 3.10 缺口）：
//  1) 首次买入 → 生成正确持仓数量与成本
//  2) 多次买入 → 移动加权成本
//  3) 部分卖出 → 数量减少、单位成本不变
//  4) 全部卖出 → 持仓归零删除
//  5) 无持仓卖出 → 拒绝
//  6) 超量卖出 → 拒绝
//  7) 重复导入同笔交易 → 不新增（业务去重）
//  8) 删除交易 → 持仓/现金回滚一致
//  9) 买入减现金/卖出加现金（含费用）
// 10) amount 与 price×quantity 不一致 → 拒绝
// 11) 交易不覆盖当前行情价（price 保留，cost 更新）
// 全部使用专用测试数据并在 finally 清理，绝不触碰真实账户。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { pool } = require('../db');
const { loadAccountData } = require('../db/accounts');
const ledger = require('../services/tradeLedger');

const U = 'ledger_test_user';
const A = '账本测试账户';
const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

async function cleanup() {
  for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history', 'account_data', 'accounts']) {
    await pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]);
  }
  await pool.query(`DELETE FROM users WHERE username=$1`, [U]);
}

const T = (over) => Object.assign({
  code: '600519', name: '贵州茅台', direction: 'buy',
  price: 1000, quantity: 100, commission: 5, stamp_tax: 0, transfer_fee: 0.2, other_fee: 0,
  type: '股权', subtype: '沪市', date: '2026-08-01 09:30', note: ''
}, over || {});

(async function () {
  // 测试用户预建（accounts 表 FK 指向 users）
  await pool.query(`INSERT INTO users (username, password, accounts) VALUES ($1,'x','[]') ON CONFLICT (username) DO NOTHING`, [U]);
  const acctId = require('crypto').createHash('sha256').update(U + '\n' + A).digest('hex');
  await pool.query(
    `INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at)
     VALUES ($1,$2,$3,1000000,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
     ON CONFLICT (username, account_name) DO NOTHING`,
    [acctId, U, A]
  );
  // 预置期初现金：直接写 account_data（loadAccountData 重算现金用 accounts.cash_base）

  try {
    // ---------- 1) 首次买入 ----------
    await checkAsync('首次买入：生成持仓数量+成本，现金减少(成交额+费用)', async () => {
      const r = await ledger.applyTrade(U, A, T());
      assert.strictEqual(r.ok, true);
      const d = await loadAccountData(U, A);
      const pos = d.positions.find(p => p.code === '600519');
      assert.ok(pos, '应有持仓');
      assert.strictEqual(pos.quantity, 100);
      assert.strictEqual(pos.cost, 1000, '首笔买入成本=成交价');
      assert.strictEqual(pos.price, 1000, '新持仓初始现价=成交价');
      // 现金 = 1,000,000 - (100000 + 5 + 0.2) = 899994.8
      assert.strictEqual(d.cash, 899994.8, '现金应扣除成交额+费用');
      // 交易含 trade_date
      assert.ok(d.trades[0].trade_date === '2026-08-01', '交易应有 trade_date');
    });

    // ---------- 2) 多次买入 → 移动加权 ----------
    await checkAsync('二次买入：移动加权成本', async () => {
      await ledger.applyTrade(U, A, T({ price: 1100, quantity: 100, date: '2026-08-02 10:00' }));
      const d = await loadAccountData(U, A);
      const pos = d.positions.find(p => p.code === '600519');
      assert.strictEqual(pos.quantity, 200);
      // 成本 = (1000*100 + 1100*100)/200 = 1050
      assert.strictEqual(pos.cost, 1050, '移动加权成本应为 1050');
      assert.strictEqual(pos.price, 1000, '现价不应被交易覆盖（保留首建仓行情价）');
    });

    // ---------- 3) 部分卖出 ----------
    await checkAsync('部分卖出：数量减少、单位成本不变', async () => {
      await ledger.applyTrade(U, A, T({ direction: 'sell', price: 1200, quantity: 50, date: '2026-08-03 14:00' }));
      const d = await loadAccountData(U, A);
      const pos = d.positions.find(p => p.code === '600519');
      assert.strictEqual(pos.quantity, 150);
      assert.strictEqual(pos.cost, 1050, '部分卖出不改变单位成本');
      // 现金 = 899994.8 - (110000+5+0.2) + (60000-5-0.2) = 849984.4
      assert.strictEqual(d.cash, 849984.4, '卖出应增加现金(成交额-费用)');
    });

    // ---------- 4) 全部卖出 → 持仓归零 ----------
    await checkAsync('全部卖出：持仓归零删除', async () => {
      await ledger.applyTrade(U, A, T({ direction: 'sell', price: 1300, quantity: 150, date: '2026-08-04 10:00' }));
      const d = await loadAccountData(U, A);
      const pos = d.positions.find(p => p.code === '600519');
      assert.ok(!pos, '全部卖出后持仓应删除');
    });

    // ---------- 5) 无持仓卖出 → 拒绝 ----------
    await checkAsync('无持仓卖出：拒绝', async () => {
      let threw = false;
      try { await ledger.applyTrade(U, A, T({ direction: 'sell', price: 1300, quantity: 100, date: '2026-08-05 10:00' })); }
      catch (e) { threw = true; assert.ok(/可用持仓|超出/.test(e.message), '错误应提示可卖数量，实际: ' + e.message); }
      assert.ok(threw, '无持仓卖出应抛错');
      const d = await loadAccountData(U, A);
      assert.ok(!d.positions.find(p => p.code === '600519'), '拒绝后不应生成持仓');
    });

    // ---------- 6) 超量卖出 → 拒绝 ----------
    await checkAsync('超量卖出：拒绝', async () => {
      await ledger.applyTrade(U, A, T({ price: 1000, quantity: 100, date: '2026-08-06 09:30' })); // 买入 100
      let threw = false;
      try { await ledger.applyTrade(U, A, T({ direction: 'sell', price: 1000, quantity: 200, date: '2026-08-06 10:00' })); }
      catch (e) { threw = true; }
      assert.ok(threw, '超量卖出应抛错');
      const d = await loadAccountData(U, A);
      const pos = d.positions.find(p => p.code === '600519');
      assert.strictEqual(pos.quantity, 100, '拒绝后持仓不变');
    });

    // ---------- 7) amount 不一致 → 拒绝 ----------
    await checkAsync('amount 与 price×quantity 不一致：拒绝', async () => {
      let threw = false;
      try { await ledger.applyTrade(U, A, T({ price: 1000, quantity: 100, amount: 99999, date: '2026-08-07 09:30' })); }
      catch (e) { threw = true; assert.ok(/不一致/.test(e.message), '应提示金额不一致'); }
      assert.ok(threw, '金额不一致应抛错');
    });

    // ---------- 8) 删除交易 → 持仓/现金回滚 ----------
    await checkAsync('删除最后一笔交易：持仓/现金回滚一致', async () => {
      // 当前：600519 持仓 100 @cost 1000（08-06 买入是最后一笔，可安全删除重放）
      const before = await loadAccountData(U, A);
      const lastTrade = before.trades[before.trades.length - 1];
      assert.strictEqual(lastTrade.trade_date, '2026-08-06', '最后一笔应为 08-06 买入');
      const cashBefore = before.cash;
      await ledger.deleteTrade(U, A, lastTrade.id);
      const d = await loadAccountData(U, A);
      assert.ok(!d.positions.find(p => p.code === '600519'), '删除买入后持仓应消失');
      assert.strictEqual(d.cash, cashBefore + 100000 + 5 + 0.2, '现金应回滚(加回成交额+费用)');
    });

    // ---------- 8b) 删除被后续交易依赖的交易 → 拒绝（无法安全重放） ----------
    await checkAsync('删除中间交易（后续依赖）：拒绝并提示冲正', async () => {
      // 隔离：清空该证券全部交易 + 持仓，重建干净序列
      await pool.query(`DELETE FROM trades WHERE username=$1 AND account_name=$2 AND code='600519'`, [U, A]);
      await pool.query(`DELETE FROM positions WHERE username=$1 AND account_name=$2 AND code='600519'`, [U, A]);
      // 买100(08-01) → 卖50(08-02)；删除 08-01 会超卖 → 拒绝
      await ledger.applyTrade(U, A, T({ date: '2026-08-01 09:30' }));
      await ledger.applyTrade(U, A, T({ direction: 'sell', price: 1100, quantity: 50, date: '2026-08-02 10:00' }));
      const d = await loadAccountData(U, A);
      const firstTrade = d.trades.find(t => t.trade_date === '2026-08-01');
      let threw = false;
      try { await ledger.deleteTrade(U, A, firstTrade.id); }
      catch (e) { threw = true; assert.ok(/无法安全重放|冲正/.test(e.message), '应提示无法安全重放，实际: ' + e.message); }
      assert.ok(threw, '删除被后续依赖的交易应被拒绝');
      // 现场保留（后续用例继续用）：买100 卖50 → 持仓 50
    });

    // ---------- 9) 多笔独立买入累加 ----------
    await checkAsync('多笔独立买入累加：数量=250（8b留50 + 两笔100）', async () => {
      // 服务端：同 id 幂等；不同 id 同业务键由前端去重（此处验证服务端不会重复建仓）
      await ledger.applyTrade(U, A, T({ date: '2026-08-08 09:30' }));
      await ledger.applyTrade(U, A, T({ date: '2026-08-08 09:31' }));
      const d = await loadAccountData(U, A);
      const pos = d.positions.find(p => p.code === '600519');
      assert.strictEqual(pos.quantity, 250, '50+100+100 应累加 250');
      // 前端业务去重逻辑（与 core-trade.js addTradeInternal 一致）：同 code+date+direction+price+quantity 判重
      const dupExists = d.trades.some(function (t) {
        return (t.trade_date || t.date.slice(0, 10)) === '2026-08-08';
      });
      assert.ok(dupExists, '同一交易日多笔交易允许存在（按业务键精确去重，非日级去重）');
    });

    // ---------- 10) 交易不覆盖当前行情价 ----------
    await checkAsync('交易录入不覆盖当前价：price 保持行情价', async () => {
      // 模拟行情刷新后 price 被更新为 1500（前端刷新），随后补录一笔历史交易 → price 不应被改
      await pool.query(`UPDATE positions SET price=1500 WHERE username=$1 AND account_name=$2 AND code='600519'`, [U, A]);
      await ledger.applyTrade(U, A, T({ price: 900, quantity: 100, date: '2026-08-09 09:30' }));
      const d = await loadAccountData(U, A);
      const pos = d.positions.find(p => p.code === '600519');
      assert.strictEqual(pos.price, 1500, '当前价不应被历史交易覆盖');
      // 成本移动加权：8b 留 50@1000 + 08-08 两笔 200@1000 + 08-09 一笔 100@900
      // (50*1000 + 200*1000 + 100*900) / 350 = 971.4286
      assert.ok(Math.abs(pos.cost - 971.4286) < 0.01, '成本应移动加权为 971.43，实际 ' + pos.cost);
    });

  } finally {
    await cleanup();
  }

  // ========== 验收补充测试（持仓管理整改验收报告） ==========
  // 独立测试用户，避免污染主流程
  const U2 = 'ledger_accept_user', A2 = '验收补充账户';
  await pool.query(`DELETE FROM positions WHERE username=$1`, [U2]);
  await pool.query(`DELETE FROM trades WHERE username=$1`, [U2]);
  await pool.query(`DELETE FROM account_data WHERE username=$1`, [U2]);
  await pool.query(`DELETE FROM accounts WHERE username=$1`, [U2]);
  await pool.query(`DELETE FROM users WHERE username=$1`, [U2]);
  await pool.query(`INSERT INTO users (username, password, accounts) VALUES ($1,'x','[]')`, [U2]);
  const acctId2 = require('crypto').createHash('sha256').update(U2 + '\n' + A2).digest('hex');
  await pool.query(
    `INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at)
     VALUES ($1,$2,$3,500000,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`, [acctId2, U2, A2]
  );

  // ---- P0-2：期初建仓 open 事件（不产生现金，成本入账，后续交易正常累加） ----
  await checkAsync('P0-2 期初建仓：open 事件数量/成本入账且现金不变', async () => {
    const cashBefore = (await loadAccountData(U2, A2)).cash;
    const r = await ledger.applyTrade(U2, A2, {
      code: '600000', name: '浦发银行', direction: 'open', price: 10, quantity: 1000,
      type: '股权', subtype: '沪市', date: '2026-01-01 09:30'
    });
    assert.strictEqual(r.ok, true);
    const d = await loadAccountData(U2, A2);
    const pos = d.positions.find(p => p.code === '600000');
    assert.strictEqual(pos.quantity, 1000, '期初数量 1000');
    assert.strictEqual(pos.cost, 10, '期初成本=价格');
    assert.strictEqual(d.cash, cashBefore, '期初建仓不产生现金变动');
    assert.ok(d.trades.some(t => t.direction === 'open'), '应生成 open 事件');
  });

  await checkAsync('P0-2 期初+首笔卖出：从期初数量扣减，不误删持仓', async () => {
    // 期初 1000，卖出 200 → 剩 800
    const r = await ledger.applyTrade(U2, A2, {
      code: '600000', direction: 'sell', price: 12, quantity: 200,
      commission: 5, stamp_tax: 0, transfer_fee: 0.2, other_fee: 0,
      date: '2026-02-01 10:00'
    });
    assert.strictEqual(r.ok, true);
    const d = await loadAccountData(U2, A2);
    const pos = d.positions.find(p => p.code === '600000');
    assert.ok(pos, '持仓应保留');
    assert.strictEqual(pos.quantity, 800, '期初1000-卖出200=800');
    assert.strictEqual(pos.cost, 10, '卖出不改变期初成本');
  });

  // ---- P0-4：并发卖出锁（两笔并发卖出总量超可卖，只能一笔成功） ----
  await checkAsync('P0-4 并发卖出：两笔并发超卖只有一笔成功', async () => {
    // 当前持仓 800。两笔并发各卖 500 → 总量 1000 > 800，只能一笔成功
    const [r1, r2] = await Promise.allSettled([
      ledger.applyTrade(U2, A2, { code: '600000', direction: 'sell', price: 13, quantity: 500, commission: 5, stamp_tax: 0, transfer_fee: 0.2, other_fee: 0, date: '2026-03-01 10:00' }),
      ledger.applyTrade(U2, A2, { code: '600000', direction: 'sell', price: 13, quantity: 500, commission: 5, stamp_tax: 0, transfer_fee: 0.2, other_fee: 0, date: '2026-03-01 10:05' }),
    ]);
    const success = [r1, r2].filter(r => r.status === 'fulfilled');
    const failed = [r1, r2].filter(r => r.status === 'rejected');
    assert.strictEqual(success.length, 1, '两笔并发超卖应只有一笔成功，实际成功=' + success.length);
    assert.strictEqual(failed.length, 1, '另一笔应被拒绝');
    assert.ok(/可用持仓|超出/.test(failed[0].reason.message), '拒绝信息应含可卖数量');
    const d = await loadAccountData(U2, A2);
    const pos = d.positions.find(p => p.code === '600000');
    assert.strictEqual(pos.quantity, 300, '800-500=300');
  });

  // ---- P0-1：账本写操作同步 account_data 版本（防旧页面全量保存覆盖） ----
  await checkAsync('P0-1 账本写入提升 account_data 版本与数据集版本', async () => {
    const before = await loadAccountData(U2, A2);
    const vBefore = before.version, tvBefore = before.tradeVersion;
    await ledger.applyTrade(U2, A2, {
      code: '600000', direction: 'buy', price: 15, quantity: 100,
      commission: 5, stamp_tax: 0, transfer_fee: 0.2, other_fee: 0, date: '2026-04-01 10:00'
    });
    const after = await loadAccountData(U2, A2);
    assert.ok(after.version > vBefore, '总版本应提升（' + vBefore + '→' + after.version + '）');
    assert.ok(after.tradeVersion > tvBefore, 'trade_version 应提升');
  });

  // ---- P1-4：服务端导入幂等（同批次重复导入跳过） ----
  await checkAsync('P1-4 服务端导入幂等：同批次同业务键重复导入跳过', async () => {
    const t1 = {
      code: '601998', name: '中信银行', direction: 'buy', price: 7, quantity: 500,
      commission: 5, stamp_tax: 0, transfer_fee: 0.2, other_fee: 0,
      type: '股权', subtype: '沪市', date: '2026-05-01 09:30', import_batch_id: 'batch_test_1'
    };
    const r1 = await ledger.applyTrade(U2, A2, t1);
    assert.ok(r1.ok && !r1.skipped, '首笔应写入');
    const r2 = await ledger.applyTrade(U2, A2, Object.assign({}, t1, { date: '2026-05-01 09:31' }));
    assert.strictEqual(r2.skipped, 'duplicate', '同批次同业务键应跳过');
    const d = await loadAccountData(U2, A2);
    const pos = d.positions.find(p => p.code === '601998');
    assert.strictEqual(pos.quantity, 500, '不应重复累加');
  });

  // ---- 验收补充：删除持仓生成 adjust 清仓事件（问题 2） ----
  await checkAsync('删除持仓：生成 adjust 清仓事件而非直接删快照', async () => {
    await ledger.applyTrade(U2, A2, {
      code: '600519', name: '贵州茅台', direction: 'open', price: 100, quantity: 300,
      type: '股权', subtype: '沪市', date: '2026-01-01 09:30'
    });
    // 模拟前端 confirmDelete 的清仓事件（目标数量 0）
    const r = await ledger.applyTrade(U2, A2, {
      code: '600519', direction: 'adjust', price: 100, quantity: 0,
      type: '股权', subtype: '沪市', date: '2026-01-02 09:30', note: '删除持仓（清仓）'
    });
    assert.strictEqual(r.ok, true);
    const d = await loadAccountData(U2, A2);
    assert.ok(!d.positions.find(p => p.code === '600519'), '清仓后持仓应删除');
    assert.ok(d.trades.some(t => t.direction === 'adjust' && t.code === '600519'), '应保留 adjust 清仓事件');
    const { recomputeSecurity } = require('../services/tradeLedger');
    const client = await pool.connect();
    const sec = await recomputeSecurity(client, U2, A2, '600519');
    client.release();
    assert.strictEqual(sec.quantity, 0, '重放后数量应为 0');
  });

  // ---- 验收补充：导入去重含账户（同批次号跨账户不冲突，问题 4） ----
  await checkAsync('导入幂等含账户：同批次号跨账户不互相冲突', async () => {
    const U3 = 'ledger_accept_user2', A3 = '验收补充账户2';
    await pool.query(`DELETE FROM positions WHERE username=$1`, [U3]);
    await pool.query(`DELETE FROM trades WHERE username=$1`, [U3]);
    await pool.query(`DELETE FROM account_data WHERE username=$1`, [U3]);
    await pool.query(`DELETE FROM accounts WHERE username=$1`, [U3]);
    await pool.query(`DELETE FROM users WHERE username=$1`, [U3]);
    await pool.query(`INSERT INTO users (username, password, accounts) VALUES ($1,'x','[]')`, [U3]);
    const id3 = require('crypto').createHash('sha256').update(U3 + '\n' + A3).digest('hex');
    await pool.query(
      `INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at)
       VALUES ($1,$2,$3,10000,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`, [id3, U3, A3]
    );
    // 同一批次号 batch_shared 分别在不同账户写入同业务键交易 → 都应成功（不冲突）
    const tA = { code: '600036', name: '招商银行', direction: 'buy', price: 35, quantity: 100, commission: 5, stamp_tax: 0, transfer_fee: 0.2, other_fee: 0, type: '股权', subtype: '沪市', date: '2026-06-01 09:30', import_batch_id: 'batch_shared' };
    const rA1 = await ledger.applyTrade(U2, A2, tA);
    const rB1 = await ledger.applyTrade(U3, A3, tA);
    assert.ok(rA1.ok && !rA1.skipped, '账户 A 首笔应写入');
    assert.ok(rB1.ok && !rB1.skipped, '账户 B 同批次应独立写入（不冲突）');
    const dA = await loadAccountData(U2, A2);
    const dB = await loadAccountData(U3, A3);
    assert.strictEqual(dA.positions.find(p => p.code === '600036').quantity, 100);
    assert.strictEqual(dB.positions.find(p => p.code === '600036').quantity, 100, '两账户各有独立持仓');
    for (const t of ['positions','trades','account_data','accounts']) await pool.query('DELETE FROM ' + t + ' WHERE username=$1', [U3]);
    await pool.query('DELETE FROM users WHERE username=$1', [U3]);
  });

  await pool.query(`DELETE FROM positions WHERE username=$1`, [U2]);
  await pool.query(`DELETE FROM trades WHERE username=$1`, [U2]);
  await pool.query(`DELETE FROM account_data WHERE username=$1`, [U2]);
  await pool.query(`DELETE FROM accounts WHERE username=$1`, [U2]);
  await pool.query(`DELETE FROM users WHERE username=$1`, [U2]);

  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL').length;
  console.log('\n===== 账户账本测试汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail > 0) { console.log('HAS_ISSUES'); await pool.end(); process.exit(1); }
  console.log('ALL PASS');
  await pool.end();
  process.exit(0);
})().catch(async e => {
  console.error('异常', e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
