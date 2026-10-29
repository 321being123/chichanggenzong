// 套利换股结算回归：比例/取整口径、成本合并、账本事件结构、持仓版本提升
// 断言全部限定在测试自建数据内，不扫描全库真实持仓。
// 规则登记：STOCK-SWAP-SETTLE-067（governance/rule-traceability.json）
const assert = require('assert');
const { pool } = require('../db/connection');
const svc = require('../services/stockSwapSettlement');
const tradeLedger = require('../services/tradeLedger');

const U = 'stock_swap_settle_test';
const A = '换股结算回归';
const ID = 'stock_swap_settle_test_id';
const TABLES = ['positions', 'trades', 'nav_history', 'cash_flows', 'nav_position_snapshots', 'account_data', 'accounts'];

async function cleanup() {
  for (const t of TABLES) await pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]);
  await pool.query('DELETE FROM users WHERE username=$1', [U]);
}

function caseRow(overrides) {
  return Object.assign({
    case_id: 9001,
    event_status: 'proposed',
    source_instrument_id: 42,
    target_instrument_id: 179717,
    swap_ratio: '0.437600',
    target_swap_price: '16.050000',
    reference_swap_price: '36.680000',
    source_code: '601198.SH',
    source_name: '东兴证券',
    target_code: '601995.SH',
    target_name: '中金公司',
    evidence_document_id: 1,
    evidence_title: '关于公司换股吸收合并的A股换股实施公告',
    evidence_announced_at: '2026-10-16T00:00:00+08:00',
  }, overrides || {});
}

function holdingRow(overrides) {
  return Object.assign({
    username: U,
    account_name: A,
    account_id: ID,
    type: '股权',
    subtype: '沪市',
    quantity: '3200',
    cost_total: '43845.44',
  }, overrides || {});
}

(async () => {
  try {
    await cleanup();

    // ---------- 1. 公告比例向下取整（用户 2026-10-27 裁决：按少一股，尾数不猜） ----------
    const cases = [
      { ratio: '0.437600', qty: '3200', expect: 1400, raw: 1400.32 },  // 1400.32
      { ratio: '0.437600', qty: '3100', expect: 1356, raw: 1356.56 },  // 1356.56 不进位
      { ratio: '0.521000', qty: '3400', expect: 1771, raw: 1771.40 },  // 1771.40
      { ratio: '0.521000', qty: '2300', expect: 1198, raw: 1198.30 },  // 1198.30
    ];
    for (const item of cases) {
      const plan = svc.buildPlan(
        caseRow({ swap_ratio: item.ratio }),
        holdingRow({ quantity: item.qty }),
        { quantity: 0, costTotal: 0, type: '', subtype: '' }
      );
      assert.strictEqual(plan.target_quantity, item.expect,
        `${item.qty}×${item.ratio}=${item.raw} 应向下取整为 ${item.expect}`);
      assert.ok(plan.target_quantity <= item.raw, '换股股数不得大于理论值');
    }

    // ---------- 2. 恰好整数时不得因浮点误差少一股 ----------
    const exact = svc.buildPlan(
      caseRow({ swap_ratio: '0.500000' }),
      holdingRow({ quantity: '1000' }),
      { quantity: 0, costTotal: 0 }
    );
    assert.strictEqual(exact.target_quantity, 500);

    // ---------- 3. 成本总额不变，按换得股数摊薄 ----------
    const plan = svc.buildPlan(caseRow(), holdingRow(), { quantity: 0, costTotal: 0 });
    assert.strictEqual(plan.source_quantity, 3200);
    assert.strictEqual(plan.target_quantity, 1400);
    assert.strictEqual(plan.cost_unit_after, 31.3182); // 43845.44 / 1400
    // 成本价按 4 位小数落库，总额允许千分之几分位截断误差，不允许出现数量级偏差
    assert.ok(Math.abs(plan.cost_unit_after * plan.target_quantity - 43845.44) < 0.5, '成本总额应基本不变');

    // ---------- 4. 账户已有合并方持仓：数量相加、成本加权，不得覆盖原持仓 ----------
    const merged = svc.buildPlan(
      caseRow(),
      holdingRow({ quantity: '3200', cost_total: '43845.44' }),
      { quantity: 1000, costTotal: 25000, type: '股权', subtype: '沪市' }
    );
    assert.strictEqual(merged.target_quantity, 1400, '换得股数只算换股部分');
    assert.strictEqual(merged.existing_target_quantity, 1000);
    const mergedFinal = merged.target_quantity + merged.existing_target_quantity;
    assert.strictEqual(mergedFinal, 2400);
    assert.strictEqual(merged.cost_unit_after, Math.round(((43845.44 + 25000) / 2400) * 10000) / 10000);

    // ---------- 5. 不足 1 股：只清零被合并方，不建仓 ----------
    const tiny = svc.buildPlan(caseRow(), holdingRow({ quantity: '2' }), { quantity: 0, costTotal: 0 });
    assert.strictEqual(tiny.target_quantity, 0);
    const tinyEvents = svc.buildLedgerEvents(tiny);
    assert.strictEqual(tinyEvents.length, 1, '换得 0 股时只能有清零事件');
    assert.strictEqual(tinyEvents[0].code, '601198');
    assert.strictEqual(tinyEvents[0].quantity, 0);

    // ---------- 6. 账本事件：先清零被合并方，再建合并方；成本取摊薄后单价 ----------
    const events = svc.buildLedgerEvents(plan);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].code, '601198');
    assert.strictEqual(events[0].quantity, 0);
    assert.strictEqual(events[1].code, '601995');
    assert.strictEqual(events[1].quantity, 1400);
    assert.strictEqual(events[1].price, 31.3182);
    assert.strictEqual(events[0].direction, 'adjust');
    assert.strictEqual(events[1].direction, 'adjust');
    assert.ok(events[1].note.includes('43845.44'), '备注应保留换股成本总额证据');

    // ---------- 7. 业务日按上海自然日，不得直接截 ISO 字符串 ----------
    // 2026-10-15T16:30:00Z = 上海 2026-10-16 00:30
    assert.strictEqual(svc.shanghaiDateText('2026-10-15T16:30:00Z'), '2026-10-16');
    assert.strictEqual(svc.shanghaiDateText('2026-10-16T00:00:00+08:00'), '2026-10-16');
    assert.strictEqual(svc.shanghaiDateText(null), null);

    // ---------- 8. 只认实施/登记类公告标题，不从终止上市或风险公告推断 ----------
    const patterns = svc.IMPLEMENTATION_TITLE_PATTERNS;
    const hit = title => patterns.some(p => String(title).includes(p));
    assert.ok(hit('中国国际金融股份有限公司关于公司换股吸收合并东兴证券股份有限公司、信达证券股份有限公司的A股换股实施公告'));
    assert.ok(hit('换股吸收合并东兴证券股份有限公司、信达证券股份有限公司之实施情况暨新增股份上市公告书'));
    assert.ok(!hit('东兴证券股份有限公司关于股票终止上市的公告'), '终止上市不等于换股实施完成');
    assert.ok(!hit('关于换股吸收合并事项的进展公告'), '一般进展公告不得触发结算');
    assert.ok(!hit('关于本次交易的风险提示公告'));

    // ---------- 8.5 生产形态：实施案缺合并方按同一被合并方补齐；反向案/未退市/比例冲突/重复案必须拦 ----------
    const today = '2026-10-27';
    const implRow = o => Object.assign({
      case_id: 900, event_status: 'proposed',
      target_instrument_id: 18, reference_instrument_id: null,
      swap_ratio: '0.521000', target_swap_price: '19.110000', reference_swap_price: null,
      source_code: '601059.SH', source_name: '信达证券',
      source_status: 'delisted', source_delist_date: '2026-10-19',
      evidence_document_id: 489075, evidence_title: 'A股换股实施公告',
      evidence_announced_at: '2026-10-16T00:00:00+08:00',
    }, o || {});
    const pairRow = o => Object.assign({
      case_id: 209, target_instrument_id: 18, reference_instrument_id: 159257,
      swap_ratio: '0.520992',
      reference_code: '601995.SH', reference_name: '中金公司',
      reference_status: 'listed', reference_delist_date: null,
    }, o || {});

    // 8.5.1 实施案 reference 为空 → 用同一被合并方的已知合并方补齐
    const resolvedOne = svc.resolveSwapCases([implRow()], [pairRow()], today);
    assert.strictEqual(resolvedOne.length, 1);
    assert.strictEqual(resolvedOne[0].case_id, 900, '结算依据必须指向挂实施公告的案件');
    assert.strictEqual(String(resolvedOne[0].target_instrument_id), '159257');
    assert.strictEqual(resolvedOne[0].target_code, '601995.SH');
    assert.strictEqual(resolvedOne[0].resolved_reference_case_id, 209);

    // 8.5.2 反向案（把还在市的合并方当被合并方）必须排除
    const reverse = svc.resolveSwapCases(
      [implRow({
        case_id: 296, target_instrument_id: 159257, source_code: '601995.SH', source_name: '中金公司',
        source_status: 'listed', source_delist_date: null, swap_ratio: '0.437600',
      })],
      [pairRow({
        case_id: 296, target_instrument_id: 159257, reference_instrument_id: 18,
        reference_code: '601059.SH', reference_name: '信达证券',
      })],
      today
    );
    assert.strictEqual(reverse.length, 0, '合并方未退市不得被当作被合并方结算');

    // 8.5.3 被合并方退市尚未生效 → 暂不结算
    assert.strictEqual(svc.resolveSwapCases([implRow({ source_delist_date: '2026-11-30' })], [pairRow()], today).length, 0);

    // 8.5.4 实施案与已知合并方案换股比例冲突 → 不执行也不猜
    assert.strictEqual(svc.resolveSwapCases([implRow({ swap_ratio: '0.600000' })], [pairRow()], today).length, 0);

    // 8.5.5 同一「被合并方→合并方」多条案件 → 只保留实施公告最早的一条
    const dupResolved = svc.resolveSwapCases(
      [implRow({ case_id: 900 }),
       implRow({ case_id: 901, evidence_document_id: 495046, evidence_announced_at: '2026-10-27T00:00:00+08:00' })],
      [pairRow()], today
    );
    assert.strictEqual(dupResolved.length, 1, '同一换股对只允许结算一次');
    assert.strictEqual(dupResolved[0].case_id, 900);

    // 8.5.6 完全找不到合并方 → 跳过，不用别的案件凑
    assert.strictEqual(svc.resolveSwapCases([implRow()], [], today).length, 0);

    // ---------- 9. adjust/open 必须同时提升持仓版本（否则旧页面保存会覆盖账本写入） ----------
    await pool.query("INSERT INTO users(username,password,accounts,status,auth_version) VALUES($1,'x',$2,'active',1)",
      [U, JSON.stringify([A])]);
    await pool.query('INSERT INTO accounts(id,username,account_name,cash_base,hk_rate) VALUES($1,$2,$3,0,1)', [ID, U, A]);
    await pool.query("INSERT INTO account_data(username,account_name,data,version,pos_version,trade_version) VALUES($1,$2,'{}',0,0,0)", [U, A]);
    await pool.query(`INSERT INTO positions(id,username,account_name,account_id,code,name,price,quantity,cost,type,subtype)
      VALUES('sw_pos_1',$1,$2,$3,'601198','东兴证券',0,3200,13.7017,'股权','沪市')`, [U, A, ID]);

    const before = (await pool.query(
      'SELECT pos_version, trade_version FROM account_data WHERE username=$1 AND account_name=$2', [U, A]
    )).rows[0];

    await tradeLedger.applyTrade(U, A, {
      code: '601198', name: '东兴证券', direction: 'adjust', price: 13.7017, quantity: 0,
      date: '2026-10-16', type: '股权', subtype: '沪市', note: '换股结算回归',
    }, null, null);

    const after = (await pool.query(
      'SELECT pos_version, trade_version FROM account_data WHERE username=$1 AND account_name=$2', [U, A]
    )).rows[0];
    assert.ok(Number(after.trade_version) > Number(before.trade_version), 'adjust 必须提升 trade_version');
    assert.ok(Number(after.pos_version) > Number(before.pos_version),
      'adjust 改写了 positions，必须同时提升 pos_version，否则旧页面全量保存会覆盖');

    const gone = await pool.query(
      "SELECT count(*)::int AS n FROM positions WHERE username=$1 AND account_name=$2 AND code='601198'", [U, A]
    );
    assert.strictEqual(gone.rows[0].n, 0, 'adjust 到 0 应清仓');

    // ---------- 10. 买入交易同样提升版本（回归：不得因改动影响真实成交路径） ----------
    const beforeBuy = (await pool.query(
      'SELECT pos_version, trade_version FROM account_data WHERE username=$1 AND account_name=$2', [U, A]
    )).rows[0];
    await tradeLedger.applyTrade(U, A, {
      code: '601995', name: '中金公司', direction: 'buy', price: 32.5, quantity: 100,
      date: '2026-10-20', type: '股权', subtype: '沪市', note: '回归买入',
    }, null, null);
    const afterBuy = (await pool.query(
      'SELECT pos_version, trade_version FROM account_data WHERE username=$1 AND account_name=$2', [U, A]
    )).rows[0];
    assert.ok(Number(afterBuy.trade_version) > Number(beforeBuy.trade_version), 'buy 必须提升 trade_version');
    assert.strictEqual(Number(afterBuy.pos_version), Number(beforeBuy.pos_version), 'buy 不直接改写持仓版本语义，保持原规则');

    await cleanup();
    console.log('stock-swap-settlement: 全部通过');
  } catch (e) {
    console.error('stock-swap-settlement 失败:', e.message);
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原始错误 */ }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
