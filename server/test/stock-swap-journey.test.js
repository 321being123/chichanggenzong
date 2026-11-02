// N2：套利换股「真实案件筛选 → settleOne 结算单/账本/基准 → 幂等/并发/回滚」完整旅程
//
// 为什么单独建这个文件（2026-11-02，N2 缺口）：
//   - `stock-swap-settlement.test.js` 只测纯函数（buildPlan/buildLedgerEvents/resolveSwapCases）；
//   - `stock-swap-atomic.test.js` 只测结算失败分支，且案件是手写 caseRow，没走真实案件筛选 SQL；
//   - `nav-journey-regression.test.js` 自己在注释里写明「未覆盖 settleOne 的结算单写入、案件筛选与事务外壳」。
//   本文件补的正是这三块：真实库案件筛选、结算单落库与回读、事务失败不留部分结算。
//
// 边界：
//   - 案件筛选用真实 SQL（`findSettleableCases` 只读），断言只按本文件自建的 case_id 过滤，
//     不假设库里有几条真实案件，也绝不调用会扫全库的 `runStockSwapSettlement`；
//   - 结算执行只对自建案件调用 `settleOne`，不触碰其它账户/案件数据；
//   - 不断言全库条数、不扫描真实持仓，所有数据以 `swapjourney_*` 前缀隔离并在结束时清理。
// 规则登记：STOCK-SWAP-SETTLE-067（governance/rule-traceability.json）
'use strict';

const assert = require('assert');
const { pool } = require('../db/connection');
const svc = require('../services/stockSwapSettlement');
const repo = require('../repositories/stockSwapSettlementRepository');

const U = 'stock_swap_journey_test';
const U2 = 'stock_swap_journey_test_other';
const A = '换股旅程回归账户';
const A2 = '换股旅程边界账户';
const ID = 'swapjourney_acct_1';
const ID2 = 'swapjourney_acct_2';
const BUSINESS_TABLES = ['positions', 'trades', 'nav_history', 'cash_flows',
  'nav_position_snapshots', 'nav_import_batches', 'account_data', 'accounts'];

// 自建证券：699xxx 段为空闲段，用测试专用代码，清理时按这批代码删除。
const CODES = {
  source: '699001.SH', target: '699002.SH',
  listedSource: '699010.SH', listedTarget: '699011.SH',
  futureSource: '699020.SH', futureTarget: '699021.SH',
  conflictSource: '699030.SH', conflictTarget: '699031.SH',
  reverseSource: '699040.SH', reverseTarget: '699041.SH',
};
const CODES_ORDER = Object.values(CODES);
const TODAY = '2026-10-27';
const ANNOUNCED = '2026-10-16';

let sourceId = null;
const createdCaseIds = [];
const createdDocIds = [];

async function cleanup() {
  // 除固定两个用户外，本文件还会派生 `_replay`/`_rollback`/`_concurrent`/`_dry` 等子账户；
  // 中途失败时若不按前缀清干净，下一轮会撞 users 主键。这里统一按前缀收敛。
  const existing = await pool.query('SELECT username FROM users WHERE username LIKE $1', [U + '%']).catch(() => ({ rows: [] }));
  const targets = [...new Set([U, U2, ...existing.rows.map(r => r.username)])];
  for (const u of targets) {
    await pool.query('DELETE FROM event.stock_swap_settlements WHERE username=$1', [u]).catch(() => {});
    for (const t of BUSINESS_TABLES) await pool.query(`DELETE FROM ${t} WHERE username=$1`, [u]).catch(() => {});
    await pool.query('DELETE FROM users WHERE username=$1', [u]).catch(() => {});
  }
  if (createdCaseIds.length) {
    await pool.query('DELETE FROM event.arbitrage_case_documents WHERE case_id = ANY($1::bigint[])', [createdCaseIds]).catch(() => {});
    await pool.query('DELETE FROM event.arbitrage_cases WHERE case_id = ANY($1::bigint[])', [createdCaseIds]).catch(() => {});
  }
  if (createdDocIds.length) {
    await pool.query('DELETE FROM event.documents WHERE document_id = ANY($1::bigint[])', [createdDocIds]).catch(() => {});
  }
  await pool.query('DELETE FROM core.instruments WHERE canonical_code = ANY($1::text[])', [CODES_ORDER]).catch(() => {});
}

async function instruments() {
  const rows = [
    [CODES.source, '旅程被合并方', 'delisted', '2026-10-19'],
    [CODES.target, '旅程合并方', 'listed', null],
    [CODES.listedSource, '未退市被合并方', 'listed', null],
    [CODES.listedTarget, '未退市合并方', 'listed', null],
    [CODES.futureSource, '退市未生效方', 'delisted', '2026-12-31'],
    [CODES.futureTarget, '退市未生效合并方', 'listed', null],
    [CODES.conflictSource, '比例冲突被合并方', 'delisted', '2026-10-19'],
    [CODES.conflictTarget, '比例冲突合并方', 'listed', null],
    [CODES.reverseSource, '反向案在市方', 'listed', null],
    [CODES.reverseTarget, '反向案参考方', 'listed', null],
  ];
  const ids = {};
  for (const [code, name, status, delistDate] of rows) {
    const res = await pool.query(
      `INSERT INTO core.instruments(canonical_code, name, asset_class, market, exchange_code, status, delist_date)
       VALUES($1,$2,'stock','CN','SSE',$3,$4::date) RETURNING instrument_id`,
      [code, name, status, delistDate]
    );
    ids[code] = String(res.rows[0].instrument_id);
  }
  return ids;
}

async function insertCase(fields) {
  const res = await pool.query(
    `INSERT INTO event.arbitrage_cases
       (market, strategy_type, source_id, source_key, target_instrument_id, reference_instrument_id,
        swap_ratio, target_swap_price, reference_swap_price, event_status, review_status)
     VALUES('CN','a_share_swap',$1,$2,$3,$4,$5,$6,$7,'proposed','approved')
     RETURNING case_id`,
    [sourceId, fields.key, fields.target, fields.reference || null,
      fields.ratio, fields.targetPrice || null, fields.referencePrice || null]
  );
  createdCaseIds.push(String(res.rows[0].case_id));
  return String(res.rows[0].case_id);
}

async function insertAnnouncement(caseId, title, announcedAt) {
  const res = await pool.query(
    `INSERT INTO event.documents(document_type, title, announced_at, url, source_id)
     VALUES('announcement',$1,$2::date,$3,$4) RETURNING document_id`,
    [title, announcedAt, 'https://swapjourney.test/' + Math.random().toString(36).slice(2), sourceId]
  );
  const docId = String(res.rows[0].document_id);
  createdDocIds.push(docId);
  await pool.query(
    `INSERT INTO event.arbitrage_case_documents(case_id, document_id, relation_type, announced_at)
     VALUES($1,$2,'announcement',$3::date)`,
    [caseId, docId, announcedAt]
  );
  return docId;
}

async function seedAccount(username, accountId, accountName) {
  await pool.query(
    "INSERT INTO users(username,password,accounts,status,auth_version) VALUES($1,'x',$2,'active',1)",
    [username, JSON.stringify([accountName])]
  );
  await pool.query('INSERT INTO accounts(id,username,account_name,cash_base,hk_rate) VALUES($1,$2,$3,50000,1)',
    [accountId, username, accountName]);
  await pool.query(
    "INSERT INTO account_data(username,account_name,data,version,pos_version,trade_version) VALUES($1,$2,'{}',0,0,0)",
    [username, accountName]
  );
  await pool.query(
    "INSERT INTO positions(id,username,account_name,account_id,code,name,price,quantity,cost,type,subtype) VALUES($1,$2,$3,$4,$5,'旅程被合并方',0,3200,13.7017,'股权','沪市')",
    ['swapjourney_pos_' + accountId, username, accountName, accountId, '699001']
  );
  await pool.query(
    "INSERT INTO positions(id,username,account_name,account_id,code,name,price,quantity,cost,type,subtype) VALUES($1,$2,$3,$4,$5,'旅程合并方',32.5,1000,25,'股权','沪市')",
    ['swapjourney_pos2_' + accountId, username, accountName, accountId, '699002']
  );
  // 首页资产基准（换股后必须同步，否则净值归因对不上持仓）
  await pool.query(
    `INSERT INTO nav_history(username, account_name, date, nav, total_asset, invested, diagnostics)
     VALUES($1,$2,'2026-10-16',1,150000,150000,$3::jsonb)`,
    [username, accountName, JSON.stringify({
      homepageBasis: {
        version: 'homepage-v1',
        positions: [
          { code: '699001', quantity: 3200, price: 13.7017, subtype: '沪市' },
          { code: '699002', quantity: 1000, price: 32.5, subtype: '沪市' },
        ],
      },
    })]
  );
}

async function holdingOf(username, accountName, code) {
  const row = await pool.query(
    'SELECT COALESCE(SUM(quantity),0) AS quantity, COALESCE(SUM(quantity*cost),0) AS cost_total FROM positions WHERE username=$1 AND account_name=$2 AND code=$3',
    [username, accountName, code]
  );
  return { quantity: Number(row.rows[0].quantity), cost_total: Number(row.rows[0].cost_total) };
}

async function tradeCount(username) {
  const row = await pool.query('SELECT count(*)::int AS n FROM trades WHERE username=$1', [username]);
  return row.rows[0].n;
}

(async () => {
  try {
    await cleanup();

    const ds = await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='sse' LIMIT 1");
    assert.ok(ds.rows.length, '测试库缺少 sse 数据源，无法构造案件（属环境缺失，不是通过）');
    sourceId = ds.rows[0].source_id;

    const ins = await instruments();

    // ==================== 一、真实案件筛选（走 stockSwapSettlementRepository 的真实 SQL） ====================
    // 组1：正常实施案（reference 为空，按同一被合并方的已知合并方补齐）
    const caseOk = await insertCase({
      key: 'swapjourney_ok_impl', target: ins[CODES.source], ratio: '0.437600', targetPrice: '16.05',
    });
    await insertAnnouncement(caseOk, '关于公司换股吸收合并的A股换股实施结果公告', ANNOUNCED);
    await insertCase({
      key: 'swapjourney_ok_pair', target: ins[CODES.source], reference: ins[CODES.target], ratio: '0.437600',
    });

    // 组2：被合并方仍在市 → 不得结算
    const caseListed = await insertCase({
      key: 'swapjourney_listed_impl', target: ins[CODES.listedSource], ratio: '0.500000',
    });
    await insertAnnouncement(caseListed, 'A股换股实施结果公告', ANNOUNCED);
    await insertCase({
      key: 'swapjourney_listed_pair', target: ins[CODES.listedSource], reference: ins[CODES.listedTarget], ratio: '0.500000',
    });

    // 组3：已退市但退市日尚未生效 → 暂不结算
    const caseFuture = await insertCase({
      key: 'swapjourney_future_impl', target: ins[CODES.futureSource], ratio: '0.500000',
    });
    await insertAnnouncement(caseFuture, 'A股换股实施结果公告', ANNOUNCED);
    await insertCase({
      key: 'swapjourney_future_pair', target: ins[CODES.futureSource], reference: ins[CODES.futureTarget], ratio: '0.500000',
    });

    // 组4：实施案与已知合并方换股比例冲突 → 不执行也不猜
    const caseConflict = await insertCase({
      key: 'swapjourney_conflict_impl', target: ins[CODES.conflictSource], ratio: '0.600000',
    });
    await insertAnnouncement(caseConflict, 'A股换股实施结果公告', ANNOUNCED);
    await insertCase({
      key: 'swapjourney_conflict_pair', target: ins[CODES.conflictSource], reference: ins[CODES.conflictTarget], ratio: '0.500000',
    });

    // 组5：反向案（把仍在市的合并方当被合并方）→ 排除
    const caseReverse = await insertCase({
      key: 'swapjourney_reverse_impl', target: ins[CODES.reverseSource], ratio: '0.400000',
    });
    await insertAnnouncement(caseReverse, 'A股换股实施结果公告', ANNOUNCED);
    await insertCase({
      key: 'swapjourney_reverse_pair', target: ins[CODES.reverseSource], reference: ins[CODES.reverseTarget], ratio: '0.400000',
    });

    const settleable = await svc.findSettleableCases({ targetDate: TODAY });
    const mine = settleable.filter(c => createdCaseIds.includes(String(c.case_id)));
    const mineCaseIds = mine.map(c => String(c.case_id));

    assert.ok(mineCaseIds.includes(caseOk), '正常实施案（reference 为空、被合并方已退市）必须被真实 SQL 选出');
    const okCase = mine.find(c => String(c.case_id) === caseOk);
    assert.strictEqual(String(okCase.target_instrument_id), ins[CODES.target],
      'reference 为空的实施案必须按同一被合并方补齐到真实合并方');
    assert.strictEqual(String(okCase.source_instrument_id), ins[CODES.source],
      '结算对象必须是被合并方自己');
    assert.strictEqual(okCase.evidence_title.includes('换股实施结果'), true, '证据必须指向实施结果公告');
    assert.ok(!mineCaseIds.includes(caseListed), '被合并方仍在市不得进入结算候选');
    assert.ok(!mineCaseIds.includes(caseFuture), '退市日未生效不得进入结算候选');
    assert.ok(!mineCaseIds.includes(caseConflict), '换股比例冲突不得进入结算候选');
    assert.ok(!mineCaseIds.includes(caseReverse), '反向案（合并方在市）不得进入结算候选');
    console.log('  ✓ 真实案件筛选：正常案入选，未退市/退市未生效/比例冲突/反向案全部排除');

    // ==================== 二、settleOne 完整执行（结算单 + 账本 + 首页基准） ====================
    await seedAccount(U, ID, A);
    await seedAccount(U2, ID2, A2);

    const caseRow = {
      case_id: Number(caseOk),
      target_instrument_id: ins[CODES.source],
      source_instrument_id: ins[CODES.source],
      target_code: CODES.target,
      source_code: CODES.source,
      source_name: '旅程被合并方',
      target_name: '旅程合并方',
      swap_ratio: '0.437600',
      evidence_announced_at: ANNOUNCED + 'T00:00:00+08:00',
      evidence_document_id: 1,
    };

    // 3200 × 0.4376 = 1400.32 → 向下取整 1400；已有 1000 股 → 合并 2400 股
    // 成本 (43845.44 + 25000) / 2400 = 28.6856
    const plan = svc.buildPlan(caseRow, {
      username: U, account_name: A, account_id: ID, type: '股权', subtype: '沪市',
      quantity: '3200', cost_total: '43845.44',
    }, { quantity: 1000, costTotal: 25000, type: '股权', subtype: '沪市' });
    assert.strictEqual(plan.target_quantity, 1400);
    assert.strictEqual(plan.cost_unit_after, 28.6856);

    const applied = await svc.settleOne(caseRow, plan, {});
    assert.strictEqual(applied.status, 'applied', '首次执行必须成功：' + JSON.stringify(applied));
    assert.strictEqual(applied.reason, 'applied');
    assert.ok(applied.settlement_id, '必须写入结算单');
    assert.strictEqual(applied.trade_ids.length, 2, '换股必须写两条账本事件（清零 + 建仓）');

    // 业务日是 PG DATE：必须按 ::text 读，禁止用 toISOString() 截日（北京 2026-10-16 会变成 10-15）。
    const st = await pool.query(
      'SELECT *, settlement_date::text AS settlement_date_text FROM event.stock_swap_settlements WHERE settlement_id=$1',
      [applied.settlement_id]
    );
    assert.strictEqual(st.rows.length, 1);
    assert.strictEqual(st.rows[0].status, 'applied', '结算单必须标记 applied');
    assert.strictEqual(Number(st.rows[0].source_quantity), 3200);
    assert.strictEqual(Number(st.rows[0].target_quantity), 1400);
    assert.strictEqual(Number(st.rows[0].existing_target_quantity), 1000);
    assert.strictEqual(Number(st.rows[0].cost_unit_after), 28.6856);
    assert.strictEqual(st.rows[0].settlement_date_text, ANNOUNCED,
      '结算单业务日取证据公告的上海自然日');
    assert.ok(Array.isArray(st.rows[0].applied_trade_ids) && st.rows[0].applied_trade_ids.length === 2,
      '结算单必须留存实际账本事件编号');
    assert.ok(st.rows[0].applied_at, 'applied 必须写时间戳');

    assert.deepStrictEqual(await holdingOf(U, A, '699001'), { quantity: 0, cost_total: 0 }, '被合并方必须清零');
    const targetAfter = await holdingOf(U, A, '699002');
    assert.strictEqual(targetAfter.quantity, 2400, '合并方 = 换得 1400 + 原持有 1000');
    assert.ok(Math.abs(targetAfter.cost_total - 68845.44) < 0.5, '成本总额必须守恒（43845.44+25000）');
    assert.strictEqual(await tradeCount(U), 2, '必须只写两条账本事件');

    // 现金口径：accounts.cash_base 是锚点，账本按交易净额派生（recomputeCash 回写）。
    // 换股是份额转换，不得产生任何现金流入/流出。
    const cashRow = await pool.query('SELECT cash_base FROM accounts WHERE id=$1', [ID]);
    assert.strictEqual(Number(cashRow.rows[0].cash_base), 50000, '换股是份额转换，不得动用现金');

    // 首页基准同步：被合并方条目移除、合并方数量并入
    const navRow = await pool.query(
      "SELECT diagnostics->'homepageBasis' AS basis FROM nav_history WHERE username=$1 AND account_name=$2 AND date='2026-10-16'",
      [U, A]
    );
    const basisPositions = navRow.rows[0].basis.positions;
    assert.ok(!basisPositions.some(p => p.code === '699001'), '基准里必须移除被合并方');
    const basisTarget = basisPositions.find(p => p.code === '699002');
    assert.strictEqual(Number(basisTarget.quantity), 2400, '基准里合并方数量必须同步为 2400');
    assert.strictEqual(applied.basis_sync.updated, true, '基准同步结果必须可查');

    // 账户边界：另一个用户持有同样证券，不得被这次结算波及
    assert.deepStrictEqual(await holdingOf(U2, A2, '699001'), { quantity: 3200, cost_total: 43845.44 * 1 },
      '不同账户不得被同一案件结算');
    assert.strictEqual(await tradeCount(U2), 0);
    console.log('  ✓ settleOne 完整执行：结算单 applied + 两条账本 + 基准同步 + 现金不动 + 账户边界');

    // ==================== 三、幂等：同一案件重复执行 ====================
    const again = await svc.settleOne(caseRow, plan, {});
    assert.strictEqual(again.status, 'skipped', '已被清零后再执行必须 skipped，不能重复换股');
    assert.strictEqual(again.reason, 'source_no_longer_held');
    assert.strictEqual(await tradeCount(U), 2, '重试不得追加账本事件');
    const stCount = await pool.query(
      'SELECT count(*)::int AS n FROM event.stock_swap_settlements WHERE case_id=$1 AND username=$2 AND account_name=$3',
      [Number(caseOk), U, A]
    );
    assert.strictEqual(stCount.rows[0].n, 1, '重复执行不得产生第二条结算单');
    console.log('  ✓ 幂等：重复执行 skipped，账本与结算单都不增加');

    // ==================== 四、已 applied 的结算单：持仓仍在时不得二次写入 ====================
    // 构造「结算单已 applied 但持仓没清」的异常态（例如人工回滚了持仓），验证以结算单为准。
    const U3 = U + '_replay';
    const ID3 = ID + '_replay';
    await seedAccount(U3, ID3, A);
    const plan3 = svc.buildPlan(caseRow, {
      username: U3, account_name: A, account_id: ID3, type: '股权', subtype: '沪市',
      quantity: '3200', cost_total: '43845.44',
    }, { quantity: 1000, costTotal: 25000, type: '股权', subtype: '沪市' });
    const first3 = await svc.settleOne(caseRow, plan3, {});
    assert.strictEqual(first3.status, 'applied',
      '前置：持仓未动时应首次执行成功，实际=' + JSON.stringify(first3));
    // 人为把持仓恢复到换股前，模拟「持仓被回滚、结算单仍 applied」。
    // 注意账本 adjust 到 0 是删除行，所以这里必须 upsert 而不是 UPDATE（UPDATE 影响 0 行）。
    await pool.query(
      `INSERT INTO positions(id,username,account_name,account_id,code,name,price,quantity,cost,type,subtype)
       VALUES($1,$2,$3,$4,'699001','旅程被合并方',0,3200,13.7017,'股权','沪市')
       ON CONFLICT (id, username, account_name) DO UPDATE SET quantity=3200, cost=13.7017`,
      ['swapjourney_pos_' + ID3, U3, A, ID3]
    );
    await pool.query(
      `INSERT INTO positions(id,username,account_name,account_id,code,name,price,quantity,cost,type,subtype)
       VALUES($1,$2,$3,$4,'699002','旅程合并方',32.5,1000,25,'股权','沪市')
       ON CONFLICT (id, username, account_name) DO UPDATE SET quantity=1000, cost=25`,
      ['swapjourney_pos2_' + ID3, U3, A, ID3]
    );
    assert.strictEqual((await holdingOf(U3, A, '699001')).quantity, 3200, '前置：持仓必须已恢复');
    const beforeReplayTrades = await tradeCount(U3);
    const replay = await svc.settleOne(caseRow, plan3, {});
    assert.strictEqual(replay.status, 'applied');
    assert.strictEqual(replay.reason, 'already_applied', '结算单已 applied 时必须返回 already_applied');
    assert.strictEqual(await tradeCount(U3), beforeReplayTrades, '已 applied 不得追加账本');
    console.log('  ✓ 已 applied：结算单为准则，不再重复写账本（already_applied）');

    // ==================== 五、事务失败不留部分结算 ====================
    const U4 = U + '_rollback';
    const ID4 = ID + '_rollback';
    await seedAccount(U4, ID4, A);
    const plan4 = svc.buildPlan(caseRow, {
      username: U4, account_name: A, account_id: ID4, type: '股权', subtype: '沪市',
      quantity: '3200', cost_total: '43845.44',
    }, { quantity: 1000, costTotal: 25000, type: '股权', subtype: '沪市' });

    const originalUpdate = repo.updateSettlementStatus;
    repo.updateSettlementStatus = async () => { throw new Error('注入失败：结算单状态写入中断'); };
    let failed;
    try {
      failed = await svc.settleOne(caseRow, plan4, {});
    } finally {
      repo.updateSettlementStatus = originalUpdate;
    }
    assert.strictEqual(failed.status, 'failed', '事务内失败必须如实记失败');
    assert.strictEqual(failed.reason, 'ledger_error');
    assert.ok(String(failed.error).includes('注入失败'), '失败原因必须可定位');
    assert.deepStrictEqual(await holdingOf(U4, A, '699001'), { quantity: 3200, cost_total: 43845.44 },
      '事务回滚后被合并方持仓必须原样保留');
    assert.deepStrictEqual(await holdingOf(U4, A, '699002'), { quantity: 1000, cost_total: 25000 },
      '事务回滚后合并方持仓必须原样保留');
    assert.strictEqual(await tradeCount(U4), 0, '失败不得留下任何账本事件（不允许部分结算）');
    const orphanSettlement = await pool.query(
      'SELECT count(*)::int AS n FROM event.stock_swap_settlements WHERE username=$1', [U4]
    );
    assert.strictEqual(orphanSettlement.rows[0].n, 0,
      '失败后不得留下 pending 结算单（否则会卡住后续真实执行）');
    console.log('  ✓ 事务回滚：失败不留持仓改动、不留账本、不留 pending 结算单');

    // ==================== 六、同案件并发执行：只结算一次 ====================
    const U5 = U + '_concurrent';
    const ID5 = ID + '_concurrent';
    await seedAccount(U5, ID5, A);
    const plan5a = svc.buildPlan(caseRow, {
      username: U5, account_name: A, account_id: ID5, type: '股权', subtype: '沪市',
      quantity: '3200', cost_total: '43845.44',
    }, { quantity: 1000, costTotal: 25000, type: '股权', subtype: '沪市' });
    const plan5b = JSON.parse(JSON.stringify(plan5a));
    const [r5a, r5b] = await Promise.all([
      svc.settleOne(caseRow, plan5a, {}),
      svc.settleOne(caseRow, plan5b, {}).catch(e => ({ status: 'failed', error: e && e.message })),
    ]);
    const statuses = [r5a.status, r5b.status].sort();
    assert.ok(statuses.includes('applied'), '并发中必须有一方真正执行成功：' + JSON.stringify(statuses));
    assert.ok(!statuses.every(s => s === 'applied'), '并发双方都报 applied 说明重复结算未被拦住');
    assert.strictEqual(await tradeCount(U5), 2, '并发不得写出两套账本事件');
    const st5 = await pool.query(
      'SELECT count(*)::int AS n FROM event.stock_swap_settlements WHERE case_id=$1 AND username=$2',
      [Number(caseOk), U5]
    );
    assert.strictEqual(st5.rows[0].n, 1, '并发不得产生重复结算单');
    const h5 = await holdingOf(U5, A, '699002');
    assert.strictEqual(h5.quantity, 2400, '并发后合并方数量必须正好一次换股的结果');
    console.log('  ✓ 并发：同案件只结算一次，账本与结算单都不重复（' + statuses.join('/') + '）');

    // ==================== 七、预览模式不写任何东西 ====================
    const U6 = U + '_dry';
    const ID6 = ID + '_dry';
    await seedAccount(U6, ID6, A);
    const plan6 = svc.buildPlan(caseRow, {
      username: U6, account_name: A, account_id: ID6, type: '股权', subtype: '沪市',
      quantity: '3200', cost_total: '43845.44',
    }, { quantity: 1000, costTotal: 25000, type: '股权', subtype: '沪市' });
    const preview = await svc.settleOne(caseRow, plan6, { dryRun: true });
    assert.strictEqual(preview.status, 'preview');
    assert.strictEqual(preview.reason, 'dry_run');
    assert.strictEqual(await tradeCount(U6), 0, '预览不得写账本');
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM event.stock_swap_settlements WHERE username=$1', [U6])).rows[0].n,
      0, '预览不得写结算单');
    assert.strictEqual((await holdingOf(U6, A, '699001')).quantity, 3200, '预览不得改持仓');
    assert.strictEqual((await holdingOf(U6, A, '699002')).quantity, 1000, '预览不得改合并方持仓');
    console.log('  ✓ 预览：dryRun 不写账本、不写结算单、不改持仓');

    await cleanup();
    console.log('stock-swap-journey: 全部通过');
  } catch (e) {
    console.error('stock-swap-journey 失败:', e && e.stack ? e.stack : e);
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原始错误 */ }
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
