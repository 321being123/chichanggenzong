// 换股账本记账日必须是「实际执行日」而不是「公告日」：
// 若按公告日记账，晚于实施日建仓的账户（当日导入）重放时会先换股后建仓导致校验失败，
// 且会把公告日到执行日之间的历史持仓改写掉，那几天的净值整日算不出来。
const assert = require('assert');
const svc = require('../services/stockSwapSettlement');

const BASE_PLAN = {
  case_id: 208, username: 'u1', account_name: 'A',
  settlement_date: '2026-10-27', ledger_date: '2026-10-29',
  source_code: '601198', source_name: '东兴证券', source_quantity: 3100, source_cost_unit: 13.6,
  target_code: '601995', target_name: '中金公司', target_quantity: 1356, existing_target_quantity: 0,
  cost_total_before: 42196.27, cost_unit_after: 31.1182, ratio_applied: 0.437568,
  source_type: '股权', source_subtype: '沪市', target_type: '股权', target_subtype: '沪市',
};

const events = svc.buildLedgerEvents(BASE_PLAN);
assert.strictEqual(events.length, 2, '应生成两条账本事件（来源清零 + 合并方建仓）');
for (const e of events) {
  assert.strictEqual(e.date, '2026-10-29', '账本事件日期必须用实际执行日');
  assert.strictEqual(e.direction, 'adjust', '换股用 adjust，不产生现金流');
}
assert.strictEqual(events[0].code, '601198');
assert.strictEqual(events[0].quantity, 0, '被合并方清零');
assert.strictEqual(events[1].code, '601995');
assert.strictEqual(events[1].quantity, 1356, '合并方数量=换得股数+原有持仓');

// 未提供 ledger_date 时回退到 settlement_date（保持旧行为，避免历史调用点崩溃）
const fallback = svc.buildLedgerEvents({ ...BASE_PLAN, ledger_date: undefined });
assert.strictEqual(fallback[0].date, '2026-10-27', '缺 ledger_date 时回退为结算日');

console.log('换股账本记账日回归通过');
