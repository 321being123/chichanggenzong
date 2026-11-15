// 统一估值完整性守卫回归（2026-11-15 第二轮验收反例）
// 覆盖：不完整估值不得续出正式净值、盘前/午休取价、历史投影拒绝候选价、已确认收盘价的写入保护。
const assert = require('assert');
const { buildNavPerformance, computeNavHistoryTotals } = require('../services/navAttribution');
const { sessionPhase, expectedCloseDateFor } = require('../services/effectivePrice');
const { isCnTradingDate, invalidateMarketStateCache } = require('../services/marketState');

// 固定时钟：本文件只断言纯函数与账户级投影，不依赖真实当前时刻。
const realDate = global.Date;

function dateKey(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
}
function shiftDate(date, days) {
  const base = new Date(date + 'T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
const TODAY = dateKey(new realDate());
const YESTERDAY = shiftDate(TODAY, -1);

async function main() {
  // 1. 当前估值不完整时，当日不得续出正式净值。
  {
    const data = {
      totalAsset: 500,
      valuation: { complete: false, missingCount: 1, reasonCodes: ['price_not_confirmed'] },
      positions: [{ code: '600000', price: 10, quantity: 100, subtype: '沪市' }],
      cashFlows: [],
      navHistory: [
        { date: YESTERDAY, nav: 1, totalAsset: 1500, snapshotSource: 'imported', isLocked: true, snapshot_at: YESTERDAY + 'T08:00:00.000Z' },
      ],
    };
    data.navHistory.push({ date: TODAY, nav: null, totalAsset: null, snapshotSource: 'live', snapshot_at: new realDate().toISOString() });
    const rows = await buildNavPerformance(data, { [YESTERDAY]: 1500 }, { requireLive: false });
    const todayRow = rows.find(row => row.date === TODAY);
    assert.ok(todayRow, '必须产出当日行');
    assert.strictEqual(todayRow.nav, null, '估值不完整时不得产出净值');
    assert.strictEqual(todayRow.basisStatus, 'valuation_incomplete', '必须明确标注估值不完整，而不是 complete');
    assert.strictEqual(todayRow.dayChange, null, '估值不完整时不得给出当日涨跌');
  }

  // 2. 估值完整时仍应正常续链（避免上面把正常路径也堵死）。
  {
    const data = {
      totalAsset: 1600,
      valuation: { complete: true, missingCount: 0 },
      positions: [{ code: '600000', price: 10, quantity: 100, subtype: '沪市' }],
      cashFlows: [],
      navHistory: [
        { date: YESTERDAY, nav: 1, totalAsset: 1500, snapshotSource: 'imported', isLocked: true, snapshot_at: YESTERDAY + 'T08:00:00.000Z' },
      ],
    };
    data.navHistory.push({ date: TODAY, nav: null, totalAsset: null, snapshotSource: 'live', snapshot_at: new realDate().toISOString() });
    const rows = await buildNavPerformance(data, { [YESTERDAY]: 1500 }, { requireLive: false });
    const todayRow = rows.find(row => row.date === TODAY);
    assert.ok(todayRow && todayRow.nav > 0, '估值完整时必须能续出净值：' + JSON.stringify(todayRow));
    assert.strictEqual(todayRow.basisStatus, 'complete');
  }

  // 3. 盘中时段判定：盘前 / 午休 / 收盘后 / 非交易日。
  {
    assert.strictEqual(sessionPhase({ status: 'open', isTradingNow: false, isAfterMarketClose: false }, '09:00'), 'pre_open');
    assert.strictEqual(sessionPhase({ status: 'open', isTradingNow: true, isAfterMarketClose: false }, '10:00'), 'in_session');
    assert.strictEqual(sessionPhase({ status: 'open', isTradingNow: false, isAfterMarketClose: false }, '12:00'), 'break');
    assert.strictEqual(sessionPhase({ status: 'open', isTradingNow: false, isAfterMarketClose: true }, '15:30'), 'after_close');
    assert.strictEqual(sessionPhase({ status: 'closed', isTradingNow: false, isAfterMarketClose: false }, '12:00'), 'closed_day');
    assert.strictEqual(sessionPhase({ status: 'unknown' }, '12:00'), 'unknown');
  }

  // 4. 盘前取“上一交易日”的收盘价，盘中才取当日。
  {
    invalidateMarketStateCache();
    const friday = '2026-11-13';
    const thursday = '2026-11-12';
    assert.ok(isCnTradingDate(friday) && isCnTradingDate(thursday), '夹具日期必须是 A 股交易日');
    assert.strictEqual(await expectedCloseDateFor('CN', friday, null, new Map(), 'pre_open'), thursday,
      '盘前应回退到上一交易日，不能要求当日收盘价');
    assert.strictEqual(await expectedCloseDateFor('CN', friday, null, new Map(), 'in_session'), friday,
      '盘中/收盘后应取当日');
    assert.strictEqual(await expectedCloseDateFor('CN', friday, null, new Map(), 'break'), friday,
      '午休仍属当日');
  }

  // 5. 历史资产投影拒绝候选价与遗留未核实价（保留缺口，不用未确认价格重建）。
  {
    const makeQuery = quality => async (sql, params = []) => {
      if (sql.includes('FROM daily_prices')) {
        return { rows: [{ date: '2026-09-23', code: '600000', price: 10, quality, is_final: quality === 'confirmed' }] };
      }
      if (sql.includes('FROM market.fx_rates')) return { rows: [] };
      throw new Error('unexpected history query: ' + sql);
    };
    const data = {
      positions: [{ code: '600000', price: 10, quantity: 100, subtype: '沪市' }],
      cashFlows: [],
      navHistory: [{ date: '2026-09-23', totalAsset: 1000, hkRate: 1, snapshotSource: 'legacy', snapshot_at: '2026-09-23T08:00:00.000Z' }],
      positionSnapshots: [{ snapshotId: 'imp-1', snapshotDate: '2026-09-23', code: '600000', quantity: 100, quoteCurrency: 'CNY', source: 'manual_reconciliation' }],
    };
    const confirmed = await computeNavHistoryTotals('u', 'a', data, makeQuery('confirmed'));
    assert.strictEqual(Math.round(confirmed['2026-09-23']), 1000, '已确认收盘价应能重建历史资产');
    const candidate = await computeNavHistoryTotals('u', 'a', data, makeQuery('candidate'));
    assert.strictEqual(candidate['2026-09-23'], null, '候选价不得用于历史资产重建');
    const legacy = await computeNavHistoryTotals('u', 'a', data, makeQuery('legacy_unverified'));
    assert.strictEqual(legacy['2026-09-23'], null, '遗留未核实价不得用于历史资产重建');
  }

  // 6. 历史交易日缺当日收盘价时，不得用前一交易日的确认价顶上（否则会算出假完整的历史资产）。
  {
    const wednesday = '2026-09-23';
    const thursday = '2026-09-24';
    assert.ok(isCnTradingDate(wednesday) && isCnTradingDate(thursday), '夹具日期必须是连续两个 A 股交易日');
    const query = async (sql) => {
      if (sql.includes('FROM daily_prices')) {
        // 只有周三的确认价，周四缺价。
        return { rows: [{ date: wednesday, code: '600000', price: 10, quality: 'confirmed', is_final: true }] };
      }
      if (sql.includes('FROM market.fx_rates')) return { rows: [] };
      throw new Error('unexpected history query: ' + sql);
    };
    const data = {
      positions: [{ code: '600000', price: 10, quantity: 100, subtype: '沪市' }],
      cashFlows: [],
      navHistory: [
        { date: wednesday, totalAsset: 1000, hkRate: 1, snapshotSource: 'legacy', snapshot_at: wednesday + 'T08:00:00.000Z' },
        { date: thursday, totalAsset: null, hkRate: 1, snapshotSource: 'legacy', snapshot_at: thursday + 'T08:00:00.000Z' },
      ],
      positionSnapshots: [{ snapshotId: 'imp-1', snapshotDate: wednesday, code: '600000', quantity: 100, quoteCurrency: 'CNY', source: 'manual_reconciliation' }],
    };
    const totals = await computeNavHistoryTotals('u', 'a', data, query);
    assert.strictEqual(Math.round(totals[wednesday]), 1000, '周三有当日确认价时应能重建');
    assert.strictEqual(totals[thursday], null, '周四缺当日收盘价时必须保留缺口，不能沿用周三价格');
  }

  console.log('统一估值完整性守卫回归通过');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => { global.Date = realDate; });
