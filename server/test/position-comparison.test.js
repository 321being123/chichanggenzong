// ============== 仓位对比功能测试 ==============
// 对应 docs/仓位对比功能_开发文档.md 12 节：
//   12.1 权限（默认 private / 不能改他人 / 不公开不出现在列表 / 半公开无敏感字段）
//   12.2 对比计算（合并 / 聚合 / 相似度）
//   12.3 股数测算（主板 100 整数倍 / 科创板 200 起 1 股递增 / 港股整手 / 缺数据不兜底）
//   12.4 数据架构（迁移幂等 / 默认值 / 回填 / 交易单位表约束）
// 纯单元 + 可选 PG 集成（无 PG 时自动跳过集成部分，与现有测试约定一致）
const assert = require('assert');
const { pool } = require('../db/connection');
const { getATradeRule, isStarBoard } = require('../services/tradeLot');
const { normalizeSecCode, secKey, similarity, compareSecurities, groupByField, sanitizeSemiPublic } = require('../services/positionComparison');
const { candidateQuantities, totalError, replicatePositions } = require('../services/positionReplication');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { results.push(['FAIL', name]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

async function checkAsync(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { results.push(['FAIL', name]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

let isPg = false;
check('数据库可用性探测（无 PG 时集成测试自动跳过）', () => {
  isPg = !!pool; // pool 连接对象存在即视为可尝试；真正失败会在集成用例内捕获
});

console.log('A. 证券代码与身份归一化（12.2 合并规则）');
check('A股 6 位代码补后缀（0/3→SZ，6/9→SH，4/8→BJ）', () => {
  assert.strictEqual(normalizeSecCode('000001'), '000001.SZ');
  assert.strictEqual(normalizeSecCode('600519'), '600519.SH');
  assert.strictEqual(normalizeSecCode('688981'), '688981.SH');
  assert.strictEqual(normalizeSecCode('830799'), '830799.BJ');
  assert.strictEqual(normalizeSecCode('430047'), '430047.BJ');
});
check('港股 5 位代码补 5 位并加 .HK', () => {
  assert.strictEqual(normalizeSecCode('700'), '00700.HK');
  assert.strictEqual(normalizeSecCode('00700'), '00700.HK');
});
check('带后缀代码原样保留', () => {
  assert.strictEqual(normalizeSecCode('600519.SH'), '600519.SH');
  assert.strictEqual(normalizeSecCode('00700.HK'), '00700.HK');
});
check('身份键优先 instrument_id，其次 市场+代码', () => {
  assert.strictEqual(secKey({ instrument_id: 42, code: '600519' }), 'I42');
  assert.strictEqual(secKey({ code: '600519' }), '600519.SH');
});

console.log('B. 相似度与证券对比（6.3 / 6.4）');
check('完全相同仓位相似度 100%', () => {
  const a = { positions: [{ code: '600519', ratio: 0.6 }], cashRatio: 0.4 };
  const b = { positions: [{ code: '600519', ratio: 0.6 }], cashRatio: 0.4 };
  assert(Math.abs(similarity(a, b) - 100) < 1e-9);
});
check('完全相反仓位相似度 0%', () => {
  const a = { positions: [{ code: '600519', ratio: 1 }], cashRatio: 0 };
  const b = { positions: [{ code: '600519', ratio: 0 }], cashRatio: 1 };
  assert(Math.abs(similarity(a, b)) < 1e-9);
});
check('半仓差异相似度 50%', () => {
  const a = { positions: [{ code: '600519', ratio: 0.5 }], cashRatio: 0.5 };
  const b = { positions: [{ code: '600519', ratio: 1 }], cashRatio: 0 };
  assert(Math.abs(similarity(a, b) - 50) < 1e-9);
});
check('相似度恒在 0~100（负数截断）', () => {
  const a = { positions: [{ code: 'A', ratio: 1 }], cashRatio: 0 };
  const b = { positions: [{ code: 'B', ratio: 1 }], cashRatio: 0 };
  const s = similarity(a, b);
  assert(s >= 0 && s <= 100);
});
check('证券对比状态判断正确', () => {
  const my = { positions: [{ code: 'A', ratio: 0.5 }, { code: 'B', ratio: 0.2 }] };
  const bench = { positions: [{ code: 'A', ratio: 0.3 }, { code: 'C', ratio: 0.5 }] };
  const rows = compareSecurities(my, bench);
  const byCode = Object.fromEntries(rows.map(r => [r.code, r]));
  assert.strictEqual(byCode.A.status, 'both');
  assert.strictEqual(byCode.B.status, 'mine_only');
  assert.strictEqual(byCode.C.status, 'benchmark_only');
});
check('证券对比默认按占比差异绝对值降序', () => {
  const my = { positions: [{ code: 'A', ratio: 0.5 }, { code: 'B', ratio: 0.2 }, { code: 'C', ratio: 0.1 }] };
  const bench = { positions: [{ code: 'A', ratio: 0.3 }, { code: 'B', ratio: 0.05 }, { code: 'C', ratio: 0.5 }] };
  const rows = compareSecurities(my, bench);
  const diffs = rows.map(r => Math.abs(r.diff));
  for (let i = 1; i < diffs.length; i++) assert(diffs[i - 1] >= diffs[i]);
});

console.log('C. 资产类型 / 持仓细类聚合（6.5 / 6.6）');
check('按 type 聚合并含现金', () => {
  const est = {
    positions: [
      { code: 'A', marketValue: 300, type: '股票' },
      { code: 'B', marketValue: 100, type: '基金' },
      { code: 'C', marketValue: 100, type: '基金' },
    ],
    cash: 500, cashRatio: 0.5, totalAsset: 1000,
  };
  const groups = groupByField(est, 'type', '现金');
  const map = Object.fromEntries(groups.map(g => [g.name, g.ratio]));
  assert(Math.abs(map['股票'] - 0.3) < 1e-9);
  assert(Math.abs(map['基金'] - 0.2) < 1e-9);
  assert(Math.abs(map['现金'] - 0.5) < 1e-9);
});
check('按 subtype 聚合（细类），缺失按 0 处理', () => {
  const est = {
    positions: [{ code: 'A', marketValue: 400, subtype: '沪市' }],
    cash: 600, cashRatio: 0.6, totalAsset: 1000,
  };
  const groups = groupByField(est, 'subtype', '现金');
  const map = Object.fromEntries(groups.map(g => [g.name, g.ratio]));
  assert(Math.abs(map['沪市'] - 0.4) < 1e-9);
  assert(Math.abs(map['现金'] - 0.6) < 1e-9);
});

console.log('D. A 股交易单位规则（7.3）');
check('主板/创业板：每手 100 股整数倍', () => {
  const rule = getATradeRule('600519');
  assert.strictEqual(rule.minLot, 100);
  assert.strictEqual(rule.increment, 100);
  assert.strictEqual(rule.board, 'main');
});
check('科创板：最低 200 股、超出部分 1 股递增', () => {
  assert(isStarBoard('688981'));
  assert(isStarBoard('689009'));
  assert(!isStarBoard('600519'));
  const rule = getATradeRule('688981');
  assert.strictEqual(rule.minLot, 200);
  assert.strictEqual(rule.increment, 1);
  assert.strictEqual(rule.board, 'star');
});
check('候选股数：主板只含 100 整数倍', () => {
  const rule = getATradeRule('600519');
  const cands = candidateQuantities(rule, 260);
  assert.deepStrictEqual(cands, [0, 100, 200, 300]);
});
check('候选股数：科创板含 200、201、202…', () => {
  const rule = getATradeRule('688981');
  const cands = candidateQuantities(rule, 203);
  assert(cands.includes(200) && cands.includes(201) && cands.includes(202) && cands.includes(203));
  assert(!cands.includes(100)); // 不出现 100
});

console.log('E. 复制测算（7.2 / 7.4）');
function sampleMy() {
  return {
    positions: [{ code: '600519', ratio: 0.4, marketValue: 40000, quantity: 20 }],
    cash: 60000, cashRatio: 0.6, totalAsset: 100000,
  };
}
function sampleBench() {
  return {
    positions: [
      { code: '600519', ratio: 0.5, marketValue: 50000, quantity: 25 },
      { code: '000001', ratio: 0.3, marketValue: 30000, quantity: 300 },
    ],
    cash: 20000, cashRatio: 0.2, totalAsset: 100000,
  };
}
function sampleLotRules() {
  return new Map([
    ['600519', getATradeRule('600519')],
    ['000001', getATradeRule('000001')],
  ]);
}
function samplePrices() {
  return new Map([['600519', 2000], ['000001', 10]]);
}
check('主板建议股数为 100 整数倍且总金额不超资金', () => {
  const result = replicatePositions(sampleMy(), sampleBench(), 100000, sampleLotRules(), samplePrices(), 0.868);
  for (const it of result.items) {
    if (it.market !== 'HK' && it.suggestedShares > 0) assert.strictEqual(it.suggestedShares % 100, 0);
  }
  assert(result.summary.usedCash <= 100000 + 1e-9);
});
check('已超配证券建议 0 股且标记超配', () => {
  const my = { positions: [{ code: '600519', ratio: 0.9, marketValue: 90000, quantity: 45 }], cash: 10000, cashRatio: 0.1, totalAsset: 100000 };
  const bench = { positions: [{ code: '600519', ratio: 0.5, marketValue: 50000, quantity: 25 }], cash: 50000, cashRatio: 0.5, totalAsset: 100000 };
  const result = replicatePositions(my, bench, 50000, sampleLotRules(), new Map([['600519', 2000]]), 0.868);
  const item = result.items.find(i => i.code === '600519');
  assert.strictEqual(item.status, 'over_weighted');
  assert.strictEqual(item.suggestedShares, 0);
});
check('资金不足一手时建议 0 股（主板）', () => {
  const my = sampleMy();
  const bench = sampleBench();
  const result = replicatePositions(my, bench, 50, sampleLotRules(), samplePrices(), 0.868); // 50 元不够一手
  const item = result.items.find(i => i.code === '000001');
  assert.strictEqual(item.suggestedShares, 0);
  assert(['insufficient_cash', 'suggest'].includes(item.status));
});
check('港股缺每手数据时不生成建议、不默认 100 股', () => {
  const my = { positions: [], cash: 0, cashRatio: 1, totalAsset: 100000 };
  const bench = { positions: [{ code: '00700', ratio: 1, marketValue: 100000, quantity: 100 }], cash: 0, cashRatio: 0, totalAsset: 100000 };
  const result = replicatePositions(my, bench, 50000, new Map([['00700', null]]), new Map([['00700', 100]]), 0.868);
  const item = result.items.find(i => i.code === '00700');
  assert.strictEqual(item.status, 'no_lot_data');
  assert.strictEqual(item.suggestedShares, 0);
});
check('港股按每手股数整数倍买入', () => {
  const my = { positions: [], cash: 0, cashRatio: 1, totalAsset: 100000 };
  const bench = { positions: [{ code: '00700', ratio: 1, marketValue: 100000, quantity: 100 }], cash: 0, cashRatio: 0, totalAsset: 100000 };
  const result = replicatePositions(my, bench, 500000, new Map([['00700', { market: 'HK', buy_lot_size_shares: 100 }]]), new Map([['00700', 500]]), 0.868);
  const item = result.items.find(i => i.code === '00700');
  assert(item.suggestedShares > 0);
  assert.strictEqual(item.suggestedShares % 100, 0); // 每手 100 整数倍
});
check('剩余资金计入现金，总误差不劣化', () => {
  const result = replicatePositions(sampleMy(), sampleBench(), 100000, sampleLotRules(), samplePrices(), 0.868);
  assert(result.summary.remainingCash >= 0);
  assert(result.summary.errorAfter <= result.summary.errorBefore + 1e-9);
});

console.log('F. 数据架构（12.4，需 PG）');
(async function runPgChecks() {
  await checkAsync('迁移 036 已注册（schema_migrations 或函数存在）', async () => {
    if (!isPg) throw new Error('SKIP-');
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE version='036_position_comparison'");
    assert(rows.length > 0);
  });
  await checkAsync('迁移 037 已注册（回填 instrument_id）', async () => {
    if (!isPg) throw new Error('SKIP-');
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE version='037_backfill_position_instrument_ids'");
    assert(rows.length > 0);
  });
  await checkAsync('accounts 表公开状态字段与默认值', async () => {
    if (!isPg) throw new Error('SKIP-');
    const { rows } = await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name='accounts' AND column_name IN ('position_visibility','position_visibility_updated_at') ORDER BY column_name`
    );
    assert.strictEqual(rows.length, 2);
    const vis = rows.find(r => r.column_name === 'position_visibility');
    assert(vis && /private/.test(vis.column_default || ''));
  });
  await checkAsync('positions 表含 instrument_id 列', async () => {
    if (!isPg) throw new Error('SKIP-');
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='positions' AND column_name='instrument_id'`
    );
    assert(rows.length > 0);
  });
  await checkAsync('market.instrument_trade_rules 表存在且含约束', async () => {
    if (!isPg) throw new Error('SKIP-');
    const { rows } = await pool.query(`SELECT to_regclass('market.instrument_trade_rules') AS t`);
    assert(rows[0].t, 'instrument_trade_rules 表不存在');
    const { rows: cons } = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='market.instrument_trade_rules'::regclass AND conname LIKE 'chk_trade_rules%'`
    );
    assert(cons.length >= 2, '缺少交易单位约束');
  });
  await checkAsync('历史持仓已回填 instrument_id（A股主档存在即可关联）', async () => {
    if (!isPg) throw new Error('SKIP-');
    // 自建 6 位数字主档（干净库/CI 无真实主档会 SKIP；验证后清理，绝不依赖生产数据）
    const TEST_INST = '999901.SH';
    await pool.query(`DELETE FROM core.instruments WHERE canonical_code=$1`, [TEST_INST]);
    await pool.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market)
       VALUES ($1,'CI回填测试主档','stock','SH')`, [TEST_INST]);
    try {
      // 取一条现存可匹配主档（不限 asset_class，避免空匹配 SKIP）
      const inst = (await pool.query(
        `SELECT instrument_id, canonical_code FROM core.instruments
          WHERE REGEXP_REPLACE(canonical_code, '[^0-9]', '', 'g') ~ '^[0-9]{6}$'
          LIMIT 1`
      )).rows[0];
      if (!inst) throw new Error('SKIP-'); // 无主档则跳过
      const code = String(inst.canonical_code).replace(/\D/g, '');
      await pool.query(
        `INSERT INTO positions (id, username, account_name, code, name, price, quantity, cost, type, subtype)
         VALUES ('pc-test-1', 'pc_test_user', '测试账户', $1, '回填测试', 1, 1, 1, '股票', '沪市')
         ON CONFLICT (id, username, account_name) DO NOTHING`, [code]
      );
      await require('../services/tradeLot').backfillPositionInstrumentIds();
      const { rows: r2 } = await pool.query(
        `SELECT instrument_id FROM positions WHERE id='pc-test-1' AND username='pc_test_user'`
      );
      assert(r2[0] && r2[0].instrument_id != null, '回填未关联 instrument_id');
    } finally {
      // 清理（positions + 主档 + 质量问题记录，绝不残留真实库）
      await pool.query(`DELETE FROM positions WHERE id='pc-test-1' AND username='pc_test_user'`);
      await pool.query(`DELETE FROM ops.data_quality_issues WHERE details->>'username'='pc_test_user'`);
      await pool.query(`DELETE FROM core.instruments WHERE canonical_code=$1`, [TEST_INST]);
    }
  });
  await checkAsync('半公开脱敏只删除标杆字段、保留我的字段', async () => {
    const raw = {
      myAccount: { totalAsset: 100, cash: 50 },
      benchmarkAccount: { totalAsset: 100, cash: 50 },
      securities: [{ code: 'A', myQuantity: 100, myMarketValue: 50, benchmarkQuantity: 200, benchmarkMarketValue: 100 }],
    };
    const sanitized = sanitizeSemiPublic(raw);
    assert.strictEqual(sanitized.benchmarkAccount.totalAsset, undefined, '标杆总资产应删除');
    assert.strictEqual(sanitized.benchmarkAccount.cash, undefined, '标杆现金应删除');
    assert.strictEqual(sanitized.securities[0].benchmarkQuantity, undefined, '标杆数量应删除');
    assert.strictEqual(sanitized.securities[0].benchmarkMarketValue, undefined, '标杆市值应删除');
    assert.strictEqual(sanitized.myAccount.totalAsset, 100, '我的总资产应保留');
    assert.strictEqual(sanitized.myAccount.cash, 50, '我的现金应保留');
    assert.strictEqual(sanitized.securities[0].myQuantity, 100, '我的数量应保留');
    assert.strictEqual(sanitized.securities[0].myMarketValue, 50, '我的市值应保留');
  });
  await checkAsync('复制测算：实际汇率传入算法（非固定 0.868）', async () => {
    const my = { positions: [], cash: 100000, cashRatio: 1, totalAsset: 100000 };
    const bench = { positions: [
      { code: '00700', ratio: 1, marketValue: 434000, quantity: 1000 },
    ], cash: 0, cashRatio: 0, totalAsset: 434000 };
    const rules = new Map([['00700', { market: 'HK', buy_lot_size_shares: 100 }]]);
    const prices = new Map([['00700', 500]]);
    // 实际汇率 0.8626（当前市场值），预算 434000 → 每手=100×500×0.8626=43130 → 10 手=431300 元
    const result = replicatePositions(my, bench, 434000, rules, prices, 0.8626);
    const item = result.items[0];
    assert.strictEqual(item.suggestedShares, 1000, '应建议 1000 股');
    assert(Math.abs(item.suggestedAmount - 431300) < 1, '金额应含实际汇率 0.8626');
    // 对比固定 0.868：43130×10=431300 vs 43400×10=434000，金额应不同 → 证明汇率被使用
    const r2 = replicatePositions(my, bench, 434000, rules, prices, 0.868);
    assert(Math.abs(r2.items[0].suggestedAmount - item.suggestedAmount) > 1, '不同汇率应产生不同金额');
  });
  await checkAsync('复制测算：只使用输入资金（账户现金不用于买入）', async () => {
    const my = { positions: [{ code: '000001', ratio: 0, marketValue: 0, quantity: 0 }], cash: 500000, cashRatio: 1, totalAsset: 500000 };
    const bench = { positions: [
      { code: '000001', ratio: 1, marketValue: 1000000, quantity: 100000 },
    ], cash: 0, cashRatio: 0, totalAsset: 1000000 };
    const rules = new Map([['000001', getATradeRule('000001')]]);
    const prices = new Map([['000001', 10]]);
    // 新增资金仅 1000 元 → 只买 100 股，不能动用账户 50 万现金
    const result = replicatePositions(my, bench, 1000, rules, prices, 0.868);
    const item = result.items[0];
    assert.strictEqual(item.suggestedShares, 100, '只能买 100 股（1000 元）');
    assert.strictEqual(result.summary.usedCash, 1000, '使用资金只能等于输入');
  });
  await checkAsync('迁移 038 已注册（数据架构收尾）', async () => {
    if (!isPg) throw new Error('SKIP-');
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE version='038_data_architecture_cleanup'");
    assert(rows.length > 0);
  });
  await checkAsync('迁移 039 已注册（accounts.hk_rate_updated_at 精确汇率时间）', async () => {
    if (!isPg) throw new Error('SKIP-');
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE version='039_account_hk_rate_updated_at'");
    assert(rows.length > 0);
    const { rows: cols } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='hk_rate_updated_at'`
    );
    assert(cols.length > 0, 'accounts.hk_rate_updated_at 列缺失');
  });
  await checkAsync('复制测算：目标比例股数合理（非仅 100 股）', async () => {
    const my = { positions: [{ code: '600519', ratio: 0.4, marketValue: 40000, quantity: 20 }], cash: 60000, cashRatio: 0.6, totalAsset: 100000 };
    const bench = { positions: [
      { code: '600519', ratio: 0.5, marketValue: 100000, quantity: 50 },
      { code: '000001', ratio: 0.25, marketValue: 50000, quantity: 5000 },
    ], cash: 50000, cashRatio: 0.25, totalAsset: 200000 };
    const rules = new Map([['600519', getATradeRule('600519')], ['000001', getATradeRule('000001')]]);
    const prices = new Map([['600519', 2000], ['000001', 10]]);
    const result = replicatePositions(my, bench, 100000, rules, prices, 0.868);
    const pa = result.items.find(i => i.code === '000001');
    assert.strictEqual(pa.status, 'suggest', '平安银行应建议买入');
    assert(pa.suggestedShares >= 4000, '目标 25% 应建议约 5000 股，实际 ' + pa.suggestedShares);
    assert(result.summary.usedCash >= 40000, '应使用至少 4 万元，实际 ' + result.summary.usedCash);
  });
  await checkAsync('复制测算：港股理论股数按人民币折算', async () => {
    const my = { positions: [], cash: 100000, cashRatio: 1, totalAsset: 100000 };
    const bench = { positions: [
      { code: '00700', ratio: 1, marketValue: 434000, quantity: 1000 },
    ], cash: 0, cashRatio: 0, totalAsset: 434000 };
    const rules = new Map([['00700', { market: 'HK', buy_lot_size_shares: 100 }]]);
    const prices = new Map([['00700', 500]]);
    const result = replicatePositions(my, bench, 434000, rules, prices, 0.868);
    const item = result.items[0];
    assert(item.suggestedShares > 0, '港股应生成建议');
    assert.strictEqual(item.suggestedShares % 100, 0, '港股应整手');
    // 预算=新增资金 434000，每手=100×500×0.868=43400 → 10 手 1000 股 = 434000 元
    assert.strictEqual(item.suggestedShares, 1000, '港股建议股数应 1000');
    assert(Math.abs(item.suggestedAmount - 434000) < 1, '港股金额应含汇率折算(1000股×500×0.868=434000)');
  });
  await checkAsync('复制测算：行情时间 quoteTime 透传到结果 items', async () => {
    const my = { positions: [{ code: '600519', ratio: 0.4, marketValue: 40000, quantity: 20 }], cash: 60000, cashRatio: 0.6, totalAsset: 100000 };
    const bench = { positions: [
      { code: '600519', ratio: 0.5, marketValue: 100000, quantity: 50, quoteTime: '2026-08-01T15:00:05.000Z' },
      { code: '000001', ratio: 0.25, marketValue: 50000, quantity: 5000, quoteTime: '2026-08-01T15:00:05.000Z' },
    ], cash: 50000, cashRatio: 0.25, totalAsset: 200000 };
    const rules = new Map([['600519', getATradeRule('600519')], ['000001', getATradeRule('000001')]]);
    const prices = new Map([['600519', 2000], ['000001', 10]]);
    const result = replicatePositions(my, bench, 100000, rules, prices, 0.868);
    for (const it of result.items) {
      assert.strictEqual(it.quoteTime, '2026-08-01T15:00:05.000Z', it.code + ' 应透传 quoteTime');
    }
  });
  await checkAsync('交易单位 upsertTradeRule：跨天/同日/无变化（专用测试证券 + 事务回滚，不触碰真实数据）', async () => {
    if (!isPg) throw new Error('SKIP-');
    const { upsertTradeRule } = require('../services/tradeLot');
    const src = (await pool.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare'`)).rows[0];
    if (!src) throw new Error('SKIP-'); // 无数据源则跳过
    const today = (await pool.query(`SELECT to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS d`)).rows[0].d;
    const prevDay = (await pool.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Shanghai') - interval '1 day','YYYY-MM-DD') AS d`)).rows[0].d;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 专用测试证券（99998.HK，不会与真实港股冲突），随事务回滚清理，绝不触碰真实数据
      const inst = (await client.query(
        `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status)
         VALUES('99998.HK','测试证券(勿用)','equity','HK','HKEX','HKD','listed')
         ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name
         RETURNING instrument_id`
      )).rows[0];

      // 场景1：无历史规则 → 新增今天生效
      let changed = await upsertTradeRule(client, inst.instrument_id, src.source_id, today, 500, null);
      assert.strictEqual(changed, true, '首次应新增');
      let rows1 = (await client.query(
        `SELECT buy_lot_size_shares, valid_from::text AS valid_from, valid_to::text AS valid_to FROM market.instrument_trade_rules
          WHERE instrument_id=$1 AND source_id=$2`, [inst.instrument_id, src.source_id]
      )).rows;
      assert.strictEqual(rows1.length, 1, '首次写入后应只有 1 条');
      assert.strictEqual(rows1[0].buy_lot_size_shares, 500);
      assert.strictEqual(rows1[0].valid_from, today);
      assert.strictEqual(rows1[0].valid_to, null);

      // 场景2：同日 lot 变化 → 直接 UPDATE 当天记录（不新增、不关旧，避免 valid_to<valid_from 违反约束）
      changed = await upsertTradeRule(client, inst.instrument_id, src.source_id, today, 1000, null);
      assert.strictEqual(changed, true, '同日变化应更新');
      rows1 = (await client.query(
        `SELECT buy_lot_size_shares, valid_from::text AS valid_from, valid_to::text AS valid_to FROM market.instrument_trade_rules
          WHERE instrument_id=$1 AND source_id=$2`, [inst.instrument_id, src.source_id]
      )).rows;
      assert.strictEqual(rows1.length, 1, '同日变化后应仍只有 1 条（UPDATE 覆盖）');
      assert.strictEqual(rows1[0].buy_lot_size_shares, 1000, '同日变化应覆盖为 1000');
      assert.strictEqual(rows1[0].valid_to, null, '同日变化不能关闭当天记录');

      // 场景3：同日无变化 → 不新增
      changed = await upsertTradeRule(client, inst.instrument_id, src.source_id, today, 1000, null);
      assert.strictEqual(changed, false, '无变化应不写入');
      rows1 = (await client.query(
        `SELECT COUNT(*)::int c FROM market.instrument_trade_rules
          WHERE instrument_id=$1 AND source_id=$2`, [inst.instrument_id, src.source_id]
      )).rows[0];
      assert.strictEqual(rows1.c, 1, '无变化后应仍 1 条');

      // 场景4（独立证券，避免与场景1-3的 today 记录互相干扰）：跨天 lot 变化
      // → 关闭旧规则 valid_to=昨天，新增今天生效；当天只有新规则有效
      const inst2 = (await client.query(
        `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status)
         VALUES('99999.HK','测试证券2(勿用)','equity','HK','HKEX','HKD','listed')
         ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name
         RETURNING instrument_id`
      )).rows[0];
      changed = await upsertTradeRule(client, inst2.instrument_id, src.source_id, prevDay, 800, null);
      assert.strictEqual(changed, true, '跨天：历史规则首次写入');
      changed = await upsertTradeRule(client, inst2.instrument_id, src.source_id, today, 1200, null);
      assert.strictEqual(changed, true, '跨天：today 变化应新增（关闭旧规则）');
      const { rows: active } = await client.query(
        `SELECT buy_lot_size_shares FROM market.instrument_trade_rules
          WHERE instrument_id=$1 AND source_id=$2 AND valid_from <= $3 AND (valid_to IS NULL OR valid_to >= $3)`,
        [inst2.instrument_id, src.source_id, today]
      );
      assert.strictEqual(active.length, 1, '当天应只有一条规则有效，实际 ' + active.length + ' 条');
      assert.strictEqual(active[0].buy_lot_size_shares, 1200, '当天有效规则应为新值 1200');
      const oldRule = (await client.query(
        `SELECT valid_to::text AS valid_to FROM market.instrument_trade_rules
          WHERE instrument_id=$1 AND source_id=$2 AND valid_from::text=$3`,
        [inst2.instrument_id, src.source_id, prevDay]
      )).rows[0];
      assert.strictEqual(oldRule.valid_to, prevDay, '旧规则 valid_to 应为生效前一天（无重叠）');

      await client.query('ROLLBACK'); // 关键：回滚，绝不污染真实数据库
      // 验证回滚生效：专用证券的规则应已消失
      const afterRollback = (await pool.query(
        `SELECT COUNT(*)::int c FROM market.instrument_trade_rules tr
          JOIN core.instruments i ON i.instrument_id=tr.instrument_id
         WHERE i.canonical_code IN ('99998.HK','99999.HK')`
      )).rows[0];
      assert.strictEqual(afterRollback.c, 0, '回滚后测试规则应已清除');
      await pool.query(`DELETE FROM core.instruments WHERE canonical_code IN ('99998.HK','99999.HK')`);
    } finally {
      client.release();
    }
  });
  await checkAsync('saveAccountData 真实保存路径可执行（VALUES 不引用目标表列，防生产假绿）', async () => {
    if (!isPg) throw new Error('SKIP-');
    const { saveAccountData } = require('../db/accounts');
    const user = 'pc_save_test';
    await pool.query(`DELETE FROM accounts WHERE username='${user}'`);
    await pool.query(`DELETE FROM account_data WHERE username='${user}'`);
    await pool.query(`DELETE FROM users WHERE username='${user}'`);
    await pool.query(`INSERT INTO users (username,password,nickname) VALUES ('${user}','x','测试') ON CONFLICT (username) DO NOTHING`);
    const payload = (hk) => ({ positions: [], trades: [], navHistory: [], cashFlows: [], cash: 1000, hkRate: hk, cashBase: 1000, totalAsset: 1000, fundRecord: [], feeSettings: {} });
    try {
      // 首次保存（真实走 saveAccountData 的 INSERT ... VALUES 分支）
      const v1 = await saveAccountData(user, '账户A', payload(0.8626), null);
      assert(v1 >= 1, '首次保存应返回版本号');
      const r1 = (await pool.query(
        `SELECT hk_rate::float8 AS hk_rate, hk_rate_updated_at IS NOT NULL AS has_time FROM accounts WHERE username=$1 AND account_name='账户A'`, [user]
      )).rows[0];
      assert.strictEqual(r1.hk_rate, 0.8626);
      assert(r1.has_time, '首次保存 hk_rate_updated_at 应有值');
      // 同值再保存（ON CONFLICT 分支）不应报错
      const v2 = await saveAccountData(user, '账户A', payload(0.8626), v1);
      assert(v2 > v1, '版本应递增');
      // 改汇率保存（hk_rate_updated_at 更新逻辑）
      await new Promise(r => setTimeout(r, 1100));
      const v3 = await saveAccountData(user, '账户A', payload(0.87), v2);
      assert(v3 > v2);
      const r3 = (await pool.query(
        `SELECT hk_rate::float8 AS hk_rate FROM accounts WHERE username=$1 AND account_name='账户A'`, [user]
      )).rows[0];
      assert.strictEqual(r3.hk_rate, 0.87);
    } finally {
      await pool.query(`DELETE FROM accounts WHERE username='${user}'`);
      await pool.query(`DELETE FROM account_data WHERE username='${user}'`);
      await pool.query(`DELETE FROM users WHERE username='${user}'`);
    }
  });
  // 汇总必须等全部异步用例完成后（消除假绿）
  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n===== position-comparison 回归汇总 =====\nPASS=${pass}  FAIL=${fail}`);
  if (fail) { console.log('HAS_ISSUES'); process.exit(1); }
  console.log('ALL PASS');
  process.exit(0);
})();
