// 持仓统一估值价格合同回归（方案第 8 节 / 2026-11-15）
// 只做纯业务断言：用假 SQL 执行器提供已落库事实，不连接真实数据库、不外采行情。
// 覆盖：唯一价格解析、价格证据质量、缺失与冲突报告、历史模式边界、旧机制收口。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveEffectivePrices, selectHistoricalClosePrice, expectedCloseDateFor } = require('../services/effectivePrice');
const { isCnTradingDate, invalidateMarketStateCache } = require('../services/marketState');

const rootDir = path.join(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(rootDir, relative), 'utf8');

// 夹具日期：2026-09-24 是最近一个 A 股交易日，2026-09-27 为周末。
const CLOSE_DATE = '2026-09-24';
const EARLIER_DATE = '2026-09-23';
const WEEKEND = '2026-09-27';

function fakeQuery({ daily = [], cache = [], positions = [] } = {}) {
  return async (sql, params = []) => {
    if (/FROM daily_prices/.test(sql)) {
      const [, codes, upperDate] = params;
      const wanted = Array.isArray(codes) ? codes : [];
      return {
        rows: daily
          .filter(row => wanted.includes(row.code) && String(row.date) <= String(upperDate))
          .map(row => ({
            code: row.code, date: row.date, price: row.price,
            account_name: row.accountName || '账户甲',
            quality: row.quality || 'legacy_unverified',
            is_final: row.isFinal === undefined ? null : row.isFinal,
            source: row.source || null, quote_at: row.quoteAt || null, revision: row.revision || 1,
          })),
      };
    }
    if (/FROM market_quote_cache/.test(sql)) return { rows: cache };
    if (/FROM positions/.test(sql)) return { rows: positions };
    throw new Error('unexpected valuation query: ' + sql);
  };
}

function subjects(codes) {
  return codes.map(code => ({ code, subtype: '沪市' }));
}

async function run() {
  assert.ok(isCnTradingDate(CLOSE_DATE), `夹具日期 ${CLOSE_DATE} 必须是 A 股交易日`);
  invalidateMarketStateCache();

  // 1. 周末同批价格：已确认收盘价优先于兼容持仓价，当前估值必须完整。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']),
      query: fakeQuery({
        daily: [{ code: '600000', date: CLOSE_DATE, price: 10, quality: 'confirmed', isFinal: true, source: 'market_close_task:A股' }],
        positions: [{ code: '600000', price: 12, quantity: 100 }],
      }),
    });
    const row = resolved.prices.get('600000');
    assert.strictEqual(row.price, 10, '同一时点只能使用已确认收盘价，不能被兼容持仓价覆盖');
    assert.strictEqual(row.quality, 'confirmed');
    assert.strictEqual(row.priceKind, 'close');
    assert.strictEqual(row.tradeDate, CLOSE_DATE);
    assert.strictEqual(row.expectedCloseDate, CLOSE_DATE);
    assert.strictEqual(resolved.status.complete, true, '全部证券有已确认收盘价时状态必须为完整');
    assert.strictEqual(resolved.missing.length, 0);
    assert.ok(/^[0-9a-f]{16}$/.test(resolved.revision), '响应必须携带确定性输入摘要版本');
  }

  // 2. 只有兼容持仓价（无任何行情证据）→ 标记未核实参考价，整体不得声称完整。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']),
      query: fakeQuery({ positions: [{ code: '600000', price: 12, quantity: 100 }] }),
    });
    const row = resolved.prices.get('600000');
    assert.strictEqual(row.quality, 'unverified_reference');
    assert.strictEqual(row.priceKind, 'position_cache');
    assert.strictEqual(resolved.status.complete, false, '缺少行情证据时不能把旧持仓价当成完整资产');
    assert.strictEqual(resolved.status.partial, true);
    assert.ok(row.reasonCodes.includes('price_unverified_reference'));
  }

  // 3. 最近应有交易日缺价（只有更早的收盘价）→ 必须标注过期，不得跳过缺失日再标完整。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']),
      query: fakeQuery({
        daily: [{ code: '600000', date: EARLIER_DATE, price: 9, quality: 'confirmed', isFinal: true }],
      }),
    });
    const row = resolved.prices.get('600000');
    assert.strictEqual(row.priceKind, 'stale_close');
    assert.strictEqual(row.quality, 'stale_reference');
    assert.strictEqual(row.tradeDate, EARLIER_DATE);
    assert.ok(row.reasonCodes.includes('price_date_before_expected_close'), '日期落后于最近应有收盘日必须显式说明');
    assert.strictEqual(resolved.status.complete, false);
  }

  // 4. 同日既有候选（盘中/待确认）又有已确认收盘 → 取已确认，质量不降级。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']),
      query: fakeQuery({
        daily: [
          { code: '600000', date: CLOSE_DATE, price: 10.2, quality: 'candidate', revision: 3 },
          { code: '600000', date: CLOSE_DATE, price: 10, quality: 'confirmed', isFinal: true, revision: 1, accountName: '账户乙' },
        ],
      }),
    });
    const row = resolved.prices.get('600000');
    assert.strictEqual(row.price, 10, '已确认收盘价必须优先于候选');
    assert.strictEqual(row.quality, 'confirmed');
  }

  // 5. 同一证券同一交易日跨账户价格冲突 → 必须报告，不允许各自给出不同的完整估值。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']),
      query: fakeQuery({
        daily: [
          { code: '600000', date: CLOSE_DATE, price: 10, quality: 'confirmed', isFinal: true, accountName: '账户甲' },
          { code: '600000', date: CLOSE_DATE, price: 11, quality: 'confirmed', isFinal: true, accountName: '账户乙' },
        ],
      }),
    });
    assert.strictEqual(resolved.conflicts.length, 1, '跨账户同日价格不一致必须报告冲突');
    assert.strictEqual(resolved.conflicts[0].prices.length, 2);
    assert.ok(resolved.prices.get('600000').reasonCodes.includes('cross_account_price_conflict'));
  }

  // 6. 历史模式：只取目标日及之前的价格，不使用更晚的收盘价。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: CLOSE_DATE, mode: 'historical',
      subjects: subjects(['600000']),
      query: fakeQuery({
        daily: [
          { code: '600000', date: EARLIER_DATE, price: 9, quality: 'confirmed', isFinal: true },
          { code: '600000', date: CLOSE_DATE, price: 10, quality: 'confirmed', isFinal: true },
        ],
      }),
    });
    assert.strictEqual(resolved.prices.get('600000').price, 10, '历史目标日应取当日收盘价');
    assert.strictEqual(resolved.prices.get('600000').tradeDate, CLOSE_DATE);
  }

  // 7. 历史模式缺价 → 明确缺失原因，不回退到实时或持仓缓存。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: EARLIER_DATE, mode: 'historical',
      subjects: subjects(['600000']),
      query: fakeQuery({ positions: [{ code: '600000', price: 12, quantity: 100 }] }),
    });
    assert.strictEqual(resolved.prices.size, 0);
    assert.strictEqual(resolved.missing.length, 1);
    assert.strictEqual(resolved.missing[0].reason, 'historical_price_not_recorded');
    assert.strictEqual(resolved.status.complete, false);
  }

  // 8. 历史投影选价纯函数：交易中只认当日；休市取更早且有交易日的收盘。
  {
    const candidates = [
      { date: EARLIER_DATE, price: 9 },
      { date: CLOSE_DATE, price: 10 },
    ];
    assert.deepStrictEqual(
      selectHistoricalClosePrice({ exactPrice: 10, candidates, targetDate: CLOSE_DATE, marketStatus: 'open', tradingStatusOf: () => 'open' }),
      { price: 10, date: CLOSE_DATE, priceKind: 'close' }
    );
    assert.strictEqual(
      selectHistoricalClosePrice({ exactPrice: null, candidates, targetDate: CLOSE_DATE, marketStatus: 'open', tradingStatusOf: () => 'open' }),
      null, '交易日缺当日价时不得回退更早日期'
    );
    const closed = selectHistoricalClosePrice({
      exactPrice: null, candidates, targetDate: WEEKEND, marketStatus: 'closed',
      tradingStatusOf: date => (date === CLOSE_DATE || date === EARLIER_DATE ? 'open' : 'closed'),
    });
    assert.deepStrictEqual(closed, { price: 10, date: CLOSE_DATE, priceKind: 'close' });
    assert.strictEqual(
      selectHistoricalClosePrice({ exactPrice: null, candidates, targetDate: CLOSE_DATE, marketStatus: 'unknown', tradingStatusOf: () => 'open' }),
      null, '日历未知时不得猜价格'
    );
  }

  // 9. 最近应有收盘日：周末回退到最近交易日，日历缺失返回 unknown 而不是猜。
  {
    const closeDate = await expectedCloseDateFor('CN', WEEKEND, null, new Map());
    assert.strictEqual(closeDate, CLOSE_DATE);
  }

  // 10. 旧机制收口：浏览器不再写收盘价、页面不再有休市校准、归因不再产出校准项。
  {
    const quote = read('public/shared/core-quote.js');
    assert.ok(!quote.includes('holdingsQuoteApi.saveDailyPrices'), '浏览器不得再调用收盘价写入接口');
    assert.ok(quote.includes('await loadData(currentAccount)'), '刷新成功后必须整批重读服务端统一估值结果');
    const tables = read('public/shared/core-tables.js');
    assert.ok(!tables.includes('休市行情校准'), '页面不得再展示休市行情校准');
    assert.ok(tables.includes('当前估值不完整'), '价格证据不足时页面必须显式提示');
    const attribution = read('server/services/navAttribution.js');
    assert.ok(!attribution.includes('valuationAdjustment'), '归因不得再产出估值校准项');
    assert.ok(!attribution.includes('closedPriceCorrections'), '归因不得再产出逐证券校准列表');
    const route = read('server/routes/accounts.js');
    assert.ok(route.includes('DAILY_PRICE_WRITE_RETIRED'), '旧收盘写接口必须明确返回 409 与升级提示');
    const migration = read('server/db/migrations/era15ValuationPriceEvidence.js');
    ['source', 'quote_at', 'is_final', 'quality'].forEach(field => {
      assert.ok(migration.includes(field), `日价证据字段缺失：${field}`);
    });
  }

  console.log('持仓统一估值价格合同回归通过');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
