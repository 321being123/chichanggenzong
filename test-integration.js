// ========== P2-3/4/5 集成测试（需真实 PostgreSQL；CI 用临时 PG 服务运行）==========
// 运行：node test-integration.js   （依赖 PG* 环境变量，默认连本地 postgres/portfolio）
// 该测试使用独立测试账户 p2test_user，结束后清理，不污染真实数据。
const assert = require('assert');
const db = require('./server/db');

const U = 'p2test_user';
const A = '测试账户';
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } }

(async () => {
  // 运行前无条件清理 p2test_user 全部数据，保证可重复运行（不依赖上次 cleanup 是否跑完）
  for (const t of ['accounts', 'account_data', 'positions', 'trades', 'nav_history', 'cash_flows', 'users']) {
    try { await db.pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]); } catch (e) {}
  }
  console.log('[initSchema] 建表 + numeric 转换 + accounts/job_runs 表');
  await db.initSchema();

  console.log('[P2-3] 账户元数据表 + 列表同步');
  await db.registerUser(U, 'x', [A]);
  await db.syncUserAccounts(U, [A]);
  const meta = await db.getAccountMeta(U, A);
  ok('新建账户有结构化元数据行', meta && typeof meta.cashBase === 'number');

  console.log('[P2-4] 金额 numeric 往返（仍为 JS number，精度保留）');
  const sample = {
    positions: [{ id: 'p1', code: '000001', name: '平安银行', price: 12.3456, quantity: 100.5, cost: 9.1234, type: 'A股', subtype: '沪深', note: 't' }],
    trades: [{ id: 't1', date: '2026-07-10', code: '000001', name: '平安银行', direction: 'buy', price: 12.3456, quantity: 100.5, amount: 1234.56, type: 'A股', subtype: '沪深', note: 't' }],
    navHistory: [{ date: '2026-07-10', nav: 1.234567, totalAsset: 12345.67, invested: 10000.5 }],
    cashFlows: [{ id: 'c1', date: '2026-07-10', amount: 500.25, note: 't' }],
    cashBase: 1000.50, hkRate: 0.8888, totalAsset: 12345.67, fundRecord: []
  };
  // 当前账本契约：成交金额统一按 price×quantity 规范化；汇率优先使用
  // market.fx_rates 中最新有效值，只有无全局汇率时才回退到请求体。
  const expectedTradeAmount = Number((sample.trades[0].price * sample.trades[0].quantity).toFixed(4));
  const { rows: fxRows } = await db.pool.query(
    `SELECT rate::float8 AS rate FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY'
        AND rate_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
      ORDER BY rate_date DESC, fetched_at DESC LIMIT 1`
  );
  const expectedHkRate = fxRows[0] && Number.isFinite(Number(fxRows[0].rate))
    ? Number(fxRows[0].rate) : sample.hkRate;
  const expectedCash = sample.cashBase + sample.cashFlows[0].amount - expectedTradeAmount;
  await db.saveAccountData(U, A, sample, null);
  const loaded = await db.loadAccountData(U, A);
  ok('position.price 读回为 number', typeof loaded.positions[0].price === 'number');
  ok('position.price 精度保留 (12.3456)', loaded.positions[0].price === 12.3456);
  ok('position.quantity 精度保留 (100.5)', loaded.positions[0].quantity === 100.5);
  ok(`trade.amount 按 price×quantity 规范化 (${expectedTradeAmount})`, loaded.trades[0].amount === expectedTradeAmount);
  ok('nav 精度保留 (1.234567)', Math.abs(loaded.navHistory[0].nav - 1.234567) < 1e-9);
  ok('cashBase 从结构化 accounts 表读回 (1000.5)', loaded.cashBase === 1000.5);
  ok(`hkRate 从结构化 accounts 表读回 (${expectedHkRate})`, Math.abs(loaded.hkRate - expectedHkRate) < 1e-9);
  ok(`现金自动重算 = cashBase + 现金流 - 规范化交易额 = ${expectedCash}`,
    Math.abs(loaded.cash - expectedCash) < 1e-6);

  console.log('[P2-2 已含] 乐观锁版本号仍生效');
  const v1 = await db.saveAccountData(U, A, sample, loaded.version);
  ok('带正确版本号保存后 version 自增', v1 && v1.version === loaded.version + 1);
  let conflict = false;
  try { await db.saveAccountData(U, A, sample, loaded.version); } catch (e) { if (e.conflict) conflict = true; }
  ok('用过期的版本号保存被拦截 (conflict)', conflict);

  console.log('[P2-3] 列表同步：删除账户后清理 accounts 与业务数据，避免孤儿数据');
  await db.syncUserAccounts(U, []);
  const { rows: after } = await db.pool.query('SELECT 1 FROM accounts WHERE username=$1', [U]);
  ok('列表清空后 accounts 表无该用户行', after.length === 0);
  const { rows: ad } = await db.pool.query('SELECT 1 FROM account_data WHERE username=$1', [U]);
  ok('account_data 随账户同步清理（防止孤儿数据）', ad.length === 0);
  await db.syncUserAccounts(U, [A]); // 恢复账户元数据，便于继续测试与统一清理

  console.log('[P2-5] 任务幂等锁（跨实例单跑）+ 执行记录');
  ok('首次 claim 成功', (await db.tryClaimJob('p2_test_job')) === true);
  ok('锁持有期间二次 claim 失败（同一任务单跑）', (await db.tryClaimJob('p2_test_job')) === false);
  await db.releaseJob('p2_test_job');
  ok('释放后再次 claim 成功', (await db.tryClaimJob('p2_test_job')) === true);
  const runId = await db.startJobRun('p2_test_job');
  ok('startJobRun 返回 id', typeof runId === 'number');
  await db.finishJobRun(runId, true, 'ok');
  const { rows: jr } = await db.pool.query('SELECT status FROM job_runs WHERE id=$1', [runId]);
  ok('job_runs 记录状态为 done', jr[0] && jr[0].status === 'done');
  await db.releaseJob('p2_test_job');

  console.log('\n[cleanup] 删除测试数据');
  await db.pool.query('DELETE FROM accounts WHERE username=$1', [U]);
  await db.pool.query('DELETE FROM account_data WHERE username=$1', [U]);
  await db.pool.query('DELETE FROM positions WHERE username=$1', [U]);
  await db.pool.query('DELETE FROM trades WHERE username=$1', [U]);
  await db.pool.query('DELETE FROM nav_history WHERE username=$1', [U]);
  await db.pool.query('DELETE FROM cash_flows WHERE username=$1', [U]);
  await db.pool.query('DELETE FROM users WHERE username=$1', [U]);
  await db.pool.query('DELETE FROM job_runs WHERE job=$1', ['p2_test_job']);
  await db.pool.end();

  console.log(`\n========== 集成测试完成：通过 ${pass} / 失败 ${fail} ==========`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('集成测试异常:', e && e.message); process.exit(1); });
