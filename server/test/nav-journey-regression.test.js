// 交易 / 换股 → 净值 完整旅程回归（2026-10-30 补验收证据）
//
// 为什么单独建这个文件：之前只覆盖了「导入 → 行情 → 持仓基准」，交易与换股如何进入净值没有可执行证据。
// 这里按真实时序逐日推进：当天交易 → 当天收盘价 → 当天持仓基准 → 当天净值，
// 每一步都断言可手算的数值，最后核对净值链式结果。
//
// 数据来源与边界：
//   - 交易走真实入口 `tradeLedger.applyTrade`（持仓、成本、现金、费用全部真库落库）；
//   - 换股走真实的 `stockSwapSettlement.buildPlan` + `buildLedgerEvents` 生成计划与账本事件，
//     再用真实 `applyTrade` 应用（与 settleOne 内部同一条路径）；
//     **未覆盖** settleOne 的结算单写入、案件筛选与事务外壳，不冒充完整结算流程；
//   - 净值走真实入口 `navSnapshot.recordNavSnapshots`（含首页基准重算与链式净值）；
//   - 持仓基准走 `accountPositionBasis.ensurePositionBasis`（净值续链必需的锚点）。
//
// 规则 NAV-JOURNEY-CHAIN-003：交易与换股经账本落库后，净值按当时持仓基准锚点续链；
// 卖出费用必须从现金扣除，缺锚点的日期不得用当前持仓倒推。
// 日期用过去的三天（不是"今天"）：净值写入按快照时刻过滤未来交易，
// 用当天 23:59 的账本事件在盘中会正确地被排除，构造样本时容易误判成缺陷。
const assert = require('assert');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const USER = 'journey_test_' + Date.now();
const ACCOUNT = 'A';
const D1 = '2026-10-26';   // 期初建仓
const D2 = '2026-10-27';   // 部分卖出
const D3 = '2026-10-28';   // 换股

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

function approx(actual, expected, tolerance, message) {
  const value = Number(actual);
  if (!Number.isFinite(value) || Math.abs(value - expected) > tolerance) {
    throw new Error(`${message}：期望 ${expected} ± ${tolerance}，实际 ${actual}`);
  }
}

(async () => {
  let pool;
  try {
    ({ pool } = require('../db'));
  } catch (error) {
    console.log('--- 交易/换股→净值旅程 ---');
    console.log('[SKIP] 无法建立数据库连接（' + (error && error.message) + '），本文件未验证。');
    process.exit(0);
  }

  try {
    // 测试库必须是完整迁移后的结构；空库/缺表时如实跳过，不用最小表冒充。
    const required = ['users', 'accounts', 'positions', 'trades', 'nav_history', 'nav_position_snapshots', 'daily_prices'];
    const { rows: tableRows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      [required]
    );
    const missing = required.filter(name => !tableRows.some(row => row.table_name === name));
    if (missing.length) {
      console.log('--- 交易/换股→净值旅程 ---');
      console.log('[SKIP] 测试库缺少表 ' + missing.join(',') + '，本文件未验证。');
      await pool.end();
      process.exit(0);
    }

    const ledger = require('../services/tradeLedger');
    const swap = require('../services/stockSwapSettlement');
    const basis = require('../services/accountPositionBasis');
    const navJob = require('../jobs/navSnapshot');
    const { loadAccountData } = require('../db');

    // 只清理本文件前缀的账户数据；上次异常中断（或早期探路脚本）留下的样本也一并收掉，避免测试库累积。
    const cleanupUser = async name => {
      for (const table of ['trades', 'nav_position_snapshots', 'nav_history', 'positions', 'daily_prices', 'cash_flows']) {
        await pool.query(`DELETE FROM ${table} WHERE username=$1`, [name]);
      }
      await pool.query('DELETE FROM accounts WHERE username=$1', [name]);
      await pool.query('DELETE FROM users WHERE username=$1', [name]);
    };
    const stale = await pool.query(`SELECT username FROM users WHERE username LIKE 'journey\\_%'`);
    for (const row of stale.rows) await cleanupUser(row.username);

    // ---------- 准备账户：期初本金 10 万 ----------
    await pool.query(`INSERT INTO users(username, password) VALUES($1,'test') ON CONFLICT (username) DO NOTHING`, [USER]);
    await pool.query(
      `INSERT INTO accounts(id, username, account_name, cash_base, hk_rate, version, updated_at)
       VALUES($1,$2,$3,100000,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
       ON CONFLICT (username, account_name) DO NOTHING`, [USER + '-acc', USER, ACCOUNT]);
    const price = (date, code, value) => pool.query(
      'INSERT INTO daily_prices(username, account_name, date, code, price) VALUES($1,$2,$3,$4,$5)',
      [USER, ACCOUNT, date, code, value]);
    const holding = async code => (await pool.query(
      'SELECT quantity::float8 AS q, cost::float8 AS c FROM positions WHERE username=$1 AND account_name=$2 AND code=$3',
      [USER, ACCOUNT, code])).rows[0] || null;
    const navOf = async date => (await pool.query(
      // nav_history.date 是 TEXT 列，不能拿 $3::date 去比（会报「操作符不存在: text = date」）。
      'SELECT nav::float8 AS nav, total_asset::float8 AS ta, calc_status FROM nav_history WHERE username=$1 AND account_name=$2 AND date=$3::text',
      [USER, ACCOUNT, date])).rows[0] || null;

    // ---------- 第 1 天：期初建仓 1000 股 @10 ----------
    await test('第1天：期初建仓后持仓与成本正确', async function () {
      const result = await ledger.applyTrade(USER, ACCOUNT, {
        code: '601995', name: '国泰君安', direction: 'open', price: 10, quantity: 1000,
        date: D1 + ' 09:30:00', commission: 0, stamp_tax: 0, transfer_fee: 0, other_fee: 0,
      });
      assert.strictEqual(result.ok, true);
      const pos = await holding('601995');
      assert.strictEqual(Number(pos.q), 1000, '建仓数量');
      assert.strictEqual(Number(pos.c), 10, '建仓单位成本');
    });

    await test('第1天：收盘建基准后净值首日等于现金+市值，收益率为 1', async function () {
      await price(D1, '601995', 11.00);
      const b = await basis.ensurePositionBasis(USER, ACCOUNT, { date: D1 });
      assert.strictEqual(b.covered, true, '当天基准必须写完，否则净值无法续链');
      assert.strictEqual(b.created, 1);
      const n = await navJob.recordNavSnapshots(USER, ACCOUNT, null, D1);
      assert.strictEqual(n.ok, true, '首日净值应写入：' + JSON.stringify(n.diagnostics || n.error));
      const nav = await navOf(D1);
      assert.ok(nav, '必须写入净值行');
      approx(nav.ta, 111000, 0.01, '首日总资产 = 10万现金 + 1000×11');
      assert.strictEqual(Number(nav.nav), 1, '首日累计净值应为 1');
    });

    // ---------- 第 2 天：卖出 400 股 @12 ----------
    await test('第2天：卖出后持仓减少、交易台账记录完整', async function () {
      const result = await ledger.applyTrade(USER, ACCOUNT, {
        code: '601995', name: '国泰君安', direction: 'sell', price: 12, quantity: 400,
        date: D2 + ' 10:00:00', commission: 5, stamp_tax: 4.8, transfer_fee: 0.048, other_fee: 0,
      });
      assert.strictEqual(result.ok, true);
      // 现金必须按「成交额 − 三项费用」入账：4800 − 5 − 4.8 − 0.048 = 4790.152
      approx(result.cash, 104790.152, 0.001, '卖出后现金');
      const pos = await holding('601995');
      assert.strictEqual(Number(pos.q), 600, '卖出后剩余 600 股');
      assert.strictEqual(Number(pos.c), 10, '卖出不改变剩余持仓的单位成本');
      const trades = await pool.query(
        'SELECT direction, quantity::float8 AS q, amount::float8 AS amt, commission::float8 AS cm, stamp_tax::float8 AS st, transfer_fee::float8 AS tf FROM trades WHERE username=$1 AND account_name=$2 ORDER BY trade_date',
        [USER, ACCOUNT]);
      assert.strictEqual(trades.rows.length, 2, '两笔交易都要落库');
      const sell = trades.rows[1];
      assert.strictEqual(sell.direction, 'sell');
      approx(sell.amt, 4800, 0.01, '成交金额 = 价格×数量');
      approx(sell.cm + sell.st + sell.tf, 9.848, 0.001, '三项费用合计');
    });

    await test('第2天：净值把卖出后的现金与剩余市值一起算进去', async function () {
      await price(D2, '601995', 12.00);
      const b = await basis.ensurePositionBasis(USER, ACCOUNT, { date: D2 });
      assert.strictEqual(b.covered, true);
      const n = await navJob.recordNavSnapshots(USER, ACCOUNT, null, D2);
      assert.strictEqual(n.ok, true, '第二日净值应写入：' + JSON.stringify(n.diagnostics || n.error));
      const nav = await navOf(D2);
      // 现金 104790.152 + 600×12 = 111990.152；若费用没扣会多出 9.848，这里正是用来卡住那种错。
      approx(nav.ta, 111990.152, 0.01, '第二日总资产');
      // 链式净值 = 上期净值 × 本期总资产 / 上期总资产 = 111990.152 / 111000
      approx(nav.nav, 111990.152 / 111000, 1e-6, '第二日累计净值');
    });

    // ---------- 第 3 天：换股 601995 → 002091，1:0.5 ----------
    let swapPlan = null;
    await test('第3天：换股计划按比例取整、成本平移', async function () {
      const source = await pool.query(
        `SELECT quantity::float8 AS quantity, (quantity*cost)::float8 AS cost_total, type, subtype
           FROM positions WHERE username=$1 AND account_name=$2 AND code='601995'`, [USER, ACCOUNT]);
      swapPlan = swap.buildPlan(
        { case_id: 9001, swap_ratio: 0.5,
          source_code: '601995.SH', target_code: '002091.SZ',
          source_name: '国泰君安', target_name: '江苏国泰',
          source_instrument_id: null, target_instrument_id: null,
          evidence_announced_at: D3 + ' 00:00:00' },
        { ...source.rows[0], username: USER, account_name: ACCOUNT, account_id: null },
        { quantity: 0, costTotal: 0, type: '', subtype: '' });
      assert.ok(swapPlan, '有持仓且有比例时必须生成计划');
      assert.strictEqual(swapPlan.source_quantity, 600);
      assert.strictEqual(swapPlan.target_quantity, 300, '600 × 0.5 向下取整 = 300');
      approx(swapPlan.cost_unit_after, 20, 0.0001, '成本总额 6000 平移后每股 20');
      assert.strictEqual(swapPlan.settlement_date, D3, '结算日取证据公告的上海业务日');
    });

    await test('第3天：换股账本事件把源持仓清零、目标持仓建起来', async function () {
      const events = swap.buildLedgerEvents({ ...swapPlan, ledger_date: D3 });
      assert.strictEqual(events.length, 2, '源清零 + 目标建立两条事件');
      for (const event of events) {
        const result = await ledger.applyTrade(USER, ACCOUNT, { ...event, date: D3 + ' 15:30:00' });
        assert.strictEqual(result.ok, true, '账本事件应用失败：' + JSON.stringify(result));
      }
      const sourceAfter = await holding('601995');
      // adjust 到 0 表示清仓：持仓行可能被直接删除，两种形态都等于「不再持有」。
      assert.ok(sourceAfter === null || Number(sourceAfter.q) === 0,
        '源持仓必须清零（adjust 绝对设置），实际 ' + JSON.stringify(sourceAfter));
      const targetAfter = await holding('002091');
      assert.strictEqual(Number(targetAfter.q), 300, '目标持仓 300 股');
      approx(targetAfter.c, 20, 0.0001, '目标单位成本 = 平移后的 20 元');
    });

    await test('第3天：换股不产生现金流', async function () {
      const pos = await pool.query(
        'SELECT count(*)::int AS n FROM cash_flows WHERE username=$1 AND account_name=$2', [USER, ACCOUNT]);
      assert.strictEqual(pos.rows[0].n, 0, '换股只在账本里平移，不产生现金流记录');
    });

    await test('第3天：净值认到换股后的持仓，总额等于现金+新市值', async function () {
      await price(D3, '002091', 22.00);
      const b = await basis.ensurePositionBasis(USER, ACCOUNT, { date: D3 });
      assert.strictEqual(b.covered, true, '换股当天基准必须能写：' + JSON.stringify(b.reasons || b.skipped));
      const loaded = await loadAccountData(USER, ACCOUNT);
      assert.strictEqual((loaded.positionSnapshots || []).length, 3, '三天各一条基准，缺锚点净值会拒算');
      const n = await navJob.recordNavSnapshots(USER, ACCOUNT, null, D3);
      assert.strictEqual(n.ok, true, '第三日净值应写入：' + JSON.stringify(n.diagnostics || n.error));
      const nav = await navOf(D3);
      // 现金不变 104790.152 + 300×22 = 6600 → 111390.152
      approx(nav.ta, 111390.152, 0.01, '第三日总资产（换股后按新股市值计算）');
      approx(nav.nav, (111990.152 / 111000) * (111390.152 / 111990.152), 1e-6, '第三日累计净值');
    });

    await test('三天净值形成连续链条，日期与顺序完整', async function () {
      const rows = await pool.query(
        'SELECT date::text AS d, nav::float8 AS nav FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date',
        [USER, ACCOUNT]);
      assert.deepStrictEqual(rows.rows.map(r => r.d), [D1, D2, D3], '三天各一条，无缺日无重复');
      assert.strictEqual(Number(rows.rows[0].nav), 1);
      assert.ok(Number(rows.rows[1].nav) > Number(rows.rows[0].nav), '卖出价格高于成本，净值应上升');
      assert.ok(Number(rows.rows[2].nav) < Number(rows.rows[1].nav), '换股后新股市值低于原市值，净值应下降');
    });
  } catch (error) {
    fail += 1;
    failures.push('执行异常：' + (error && error.message));
    console.log('  ✗ 执行异常 —— ' + (error && error.message));
  } finally {
    // 只清理本文件建的测试账户，不动库里的其它数据。
    try {
      for (const table of ['trades', 'nav_position_snapshots', 'nav_history', 'positions', 'daily_prices', 'cash_flows']) {
        await pool.query(`DELETE FROM ${table} WHERE username=$1`, [USER]);
      }
      await pool.query('DELETE FROM accounts WHERE username=$1', [USER]);
      await pool.query('DELETE FROM users WHERE username=$1', [USER]);
    } catch (error) {
      console.log('清理测试账户失败（需人工确认）：' + (error && error.message));
    }
    try { await pool.end(); } catch (error) { /* 忽略 */ }
  }
  console.log('\n--- 汇总 ---');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) failures.forEach(item => console.log(' - ' + item));
  process.exit(fail ? 1 : 0);
})();
