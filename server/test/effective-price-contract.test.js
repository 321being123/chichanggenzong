// 持仓统一估值价格合同回归（方案第 8 节 / 2026-11-15）
// 只做纯业务断言：用假 SQL 执行器提供已落库事实，不连接真实数据库、不外采行情。
// 覆盖：唯一价格解析、价格证据质量、缺失与冲突报告、历史模式边界、旧机制收口。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveEffectivePrices, selectHistoricalClosePrice, expectedCloseDateFor, priceKey } = require('../services/effectivePrice');
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
            market: row.market || (String(row.code).length === 5 ? 'HK' : 'CN'),
            username: row.username || 'fixture-user',
            account_name: row.accountName || '账户甲',
            quality: row.quality || 'legacy_unverified',
            is_final: row.isFinal === undefined ? null : row.isFinal,
            source: row.source || null, quote_at: row.quoteAt || null, revision: row.revision || 1,
            evidence: row.evidence || {},
          })),
      };
    }
    if (/market\.trade_calendar/.test(sql)) {
      // 港股日历夹具：工作日开市、周末休市（本文件只用到 2026-09 的短窗口）。
      const dates = Array.isArray(params[0]) ? params[0] : [params[0]].filter(Boolean);
      return { rows: dates.map(value => {
        const date = String(value).slice(0, 10);
        // 与本文件 A 股夹具保持一致：同一批日期里 A 股开市的日子才视为港股开市。
        const isOpen = isCnTradingDate(date);
        return { trade_date: date, is_open: isOpen, source_code: 'test_fixture',
          raw_payload: { official_schedule: { is_open: isOpen, session_type: 'full_day', close_time: '16:10', source: 'test_fixture' } } };
      }) };
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
    const row = resolved.prices.get(priceKey('CN', '600000'));
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
    const row = resolved.prices.get(priceKey('CN', '600000'));
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
    const row = resolved.prices.get(priceKey('CN', '600000'));
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
    const row = resolved.prices.get(priceKey('CN', '600000'));
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
    assert.ok(resolved.prices.get(priceKey('CN', '600000')).reasonCodes.includes('cross_account_price_conflict'));
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
    assert.strictEqual(resolved.prices.get(priceKey('CN', '600000')).price, 10, '历史目标日应取当日收盘价');
    assert.strictEqual(resolved.prices.get(priceKey('CN', '600000')).tradeDate, CLOSE_DATE);
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

  // 11. 遗留未核验日价（存量老数据）不得被当成完整估值。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']),
      query: fakeQuery({
        daily: [{ code: '600000', date: CLOSE_DATE, price: 10, quality: 'legacy_unverified' }],
      }),
    });
    assert.strictEqual(resolved.prices.get(priceKey('CN', '600000')).quality, 'legacy_unverified');
    assert.strictEqual(resolved.status.complete, false, '未核验的遗留日价不能构成完整估值');
    assert.strictEqual(resolved.status.legacy, 1);
    assert.ok(resolved.status.reasonCodes.includes('price_not_confirmed'));
    assert.ok(resolved.status.untrustedCodes.includes(priceKey('CN', '600000')));
  }

  // 12. 未解决的跨账户同日价冲突必须阻断完整性（不能两边各自“完整”）。
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
    assert.strictEqual(resolved.conflicts.length, 1);
    assert.strictEqual(resolved.status.complete, false, '同日价冲突未解决时不得判为完整');
    assert.strictEqual(resolved.status.conflictCount, 1);
    assert.ok(resolved.status.reasonCodes.includes('cross_account_price_conflict'));
  }

  // 13. 纯现金账户（没有任何需要定价的持仓）不因“没有价格”被判估值不完整。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '现金账户', asOf: WEEKEND, mode: 'current',
      subjects: [], query: fakeQuery({}),
    });
    assert.strictEqual(resolved.prices.size, 0);
    assert.strictEqual(resolved.missing.length, 0);
    assert.strictEqual(resolved.status.complete, true, '纯现金账户没有缺价，不能判成估值不完整');
    assert.strictEqual(resolved.status.partial, false);
  }

  // 14. 同一证券同一交易日是公开市场事实：两位用户读到同一份收盘价，并且价差必须报告冲突。
  {
    const sharedDaily = [
      { code: '600000', date: CLOSE_DATE, price: 10, quality: 'confirmed', isFinal: true, source: 'market_close_task:A股', username: 'user-a', accountName: '账户甲' },
      { code: '600000', date: CLOSE_DATE, price: 10, quality: 'confirmed', isFinal: true, source: 'market_close_task:A股', username: 'user-b', accountName: '账户乙' },
    ];
    const first = await resolveEffectivePrices({
      username: 'user-a', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']), query: fakeQuery({ daily: sharedDaily }),
    });
    const second = await resolveEffectivePrices({
      username: 'user-b', accountName: '账户乙', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']), query: fakeQuery({ daily: sharedDaily }),
    });
    assert.strictEqual(first.prices.get(priceKey('CN', '600000')).price, second.prices.get(priceKey('CN', '600000')).price,
      '同一证券同一交易日的收盘价必须收敛到同一份市场事实');
    assert.strictEqual(first.status.complete, true);
    assert.strictEqual(second.status.complete, true);
    assert.strictEqual(first.conflicts.length, 0, '价格一致时不得报告冲突');

    const diverged = await resolveEffectivePrices({
      username: 'user-b', accountName: '账户乙', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']),
      query: fakeQuery({ daily: [sharedDaily[0], { ...sharedDaily[1], price: 12 }] }),
    });
    assert.strictEqual(diverged.conflicts.length, 1, '跨用户同日价不一致必须报告冲突');
    assert.strictEqual(diverged.status.complete, false, '跨用户同日价不一致不得判为完整');
    assert.ok(diverged.status.reasonCodes.includes('cross_account_price_conflict'));
  }

  // 15. 旧日期的历史冲突不得阻断当前已经一致的估值（冲突只看选中交易日）。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']),
      query: fakeQuery({ daily: [
        { code: '600000', date: CLOSE_DATE, price: 10, quality: 'confirmed', isFinal: true, accountName: '账户甲' },
        { code: '600000', date: CLOSE_DATE, price: 10, quality: 'confirmed', isFinal: true, accountName: '账户乙' },
        { code: '600000', date: EARLIER_DATE, price: 9, quality: 'confirmed', isFinal: true, accountName: '账户甲' },
        { code: '600000', date: EARLIER_DATE, price: 9.5, quality: 'confirmed', isFinal: true, accountName: '账户乙' },
      ] }),
    });
    assert.strictEqual(resolved.conflicts.length, 0, '历史日期的价差不属于当前估值冲突');
    assert.strictEqual(resolved.status.complete, true, '当前交易日价格一致时必须判为完整');
  }

  // 16. 导入锚点固化价属于账户私有派生价：不能被别的账户当成市场收盘价。
  {
    const anchorRow = { code: '600000', date: CLOSE_DATE, price: 11, quality: 'anchor_carry_forward', source: 'nav_import_anchor', username: 'user-a', accountName: '账户甲' };
    const own = await resolveEffectivePrices({
      username: 'user-a', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']), query: fakeQuery({ daily: [anchorRow] }),
    });
    assert.strictEqual(own.prices.get(priceKey('CN', '600000')).quality, 'derived_reference');
    assert.strictEqual(own.status.complete, false, '派生价不构成完整估值');
    assert.ok(own.status.reasonCodes.includes('price_derived_from_import_anchor'));

    const other = await resolveEffectivePrices({
      username: 'user-b', accountName: '账户乙', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']), query: fakeQuery({ daily: [anchorRow] }),
    });
    assert.strictEqual(other.prices.size, 0, '别的账户不得读到本账户的派生价');
    assert.strictEqual(other.missing.length, 1);
  }

  // 17. 港股 00001 与 A 股 000001 同形但不同证券：不得串价。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: [{ code: '00001', subtype: '港股' }],
      query: fakeQuery({ daily: [
        { code: '000001', date: CLOSE_DATE, price: 12, quality: 'confirmed', isFinal: true, market: 'CN' },
      ] }),
    });
    assert.strictEqual(resolved.prices.size, 0, '港股 00001 不得使用 A 股 000001 的价格');
    assert.strictEqual(resolved.missing.length, 1);
    assert.strictEqual(resolved.status.complete, false, '跨市场串价必须表现为缺价，而不是完整');

    const hkOnly = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: [{ code: '00001', subtype: '港股' }],
      query: fakeQuery({ daily: [
        { code: '00001', date: CLOSE_DATE, price: 55, quality: 'confirmed', isFinal: true, market: 'HK' },
        { code: '000001', date: CLOSE_DATE, price: 12, quality: 'confirmed', isFinal: true, market: 'CN' },
      ] }),
    });
    assert.strictEqual(hkOnly.prices.get(priceKey('HK', '00001')).price, 55, '港股必须取港股自己的收盘价');
    assert.strictEqual(hkOnly.status.complete, true);
  }

  // 18. 冲突结果不得泄露其他用户/账户标识。
  {
    const resolved = await resolveEffectivePrices({
      username: 'user-a', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: subjects(['600000']),
      query: fakeQuery({ daily: [
        { code: '600000', date: CLOSE_DATE, price: 10, quality: 'confirmed', isFinal: true, username: 'user-a', accountName: '账户甲' },
        { code: '600000', date: CLOSE_DATE, price: 12, quality: 'confirmed', isFinal: true, username: 'user-b', accountName: '别人账户' },
      ] }),
    });
    assert.strictEqual(resolved.conflicts.length, 1);
    const payload = JSON.stringify(resolved.conflicts);
    assert.ok(!payload.includes('user-b'), '冲突不得包含其他用户的用户名：' + payload);
    assert.ok(!payload.includes('别人账户'), '冲突不得包含其他用户的账户名：' + payload);
    assert.deepStrictEqual(resolved.conflicts[0].prices, [10, 12], '冲突只描述市场上有哪些价格');
    assert.strictEqual(resolved.status.complete, false);
  }

  // 19. 同一账户同时持有 6 位 A 股与补零同形港股：两只各自取价，不能合成一只。
  {
    const resolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: [
        { code: '000001', subtype: '深市' },
        { code: '000001', subtype: '港股' },
      ],
      query: fakeQuery({ daily: [
        // 迁移回填会为同形 A 股代码写入 market_basis（行情缓存/持仓核实），这里保持一致。
        { code: '000001', market: 'CN', date: CLOSE_DATE, price: 12, quality: 'confirmed', isFinal: true,
          evidence: { market_basis: 'quote_cache' } },
        { code: '00001', market: 'HK', date: CLOSE_DATE, price: 55, quality: 'confirmed', isFinal: true },
      ] }),
    });
    assert.strictEqual(resolved.prices.size, 2, '同形代码必须各自取价，不能只返回一只：' + JSON.stringify([...resolved.prices.keys()]));
    assert.strictEqual(resolved.prices.get(priceKey('CN', '000001')).price, 12, 'A 股用 A 股价格');
    assert.strictEqual(resolved.prices.get(priceKey('HK', '000001')).price, 55, '港股用港股价格');
    assert.strictEqual(resolved.status.complete, true);
    assert.strictEqual(resolved.missing.length, 0);
  }

  // 20. 来源标签与 market 列冲突：来源（可核实）优先，且不能被别的市场拿去用。
  {
    const conflicted = { code: '000002', market: 'CN', date: CLOSE_DATE, price: 30, quality: 'confirmed',
      isFinal: true, source: 'market_close_task:港股' };
    const cn = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: [{ code: '000002', subtype: '深市' }],
      query: fakeQuery({ daily: [conflicted] }),
    });
    assert.strictEqual(cn.prices.size, 0, '来源标明港股的行不得被 A 股持仓选中');
    assert.strictEqual(cn.status.complete, false);

    // 证据互相矛盾（来源说港股、market 列说 A 股）时按“身份不明”处理：两边都不用，保留缺口。
    const hkConflict = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: [{ code: '00002', subtype: '港股' }],
      query: fakeQuery({ daily: [{ ...conflicted, code: '00002' }] }),
    });
    assert.strictEqual(hkConflict.prices.size, 0, '证据冲突的行不得被任何市场使用');

    // 来源明确、market 列未填：以来源为准归港股。
    const hkFromSource = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: [{ code: '00002', subtype: '港股' }],
      query: fakeQuery({ daily: [{ ...conflicted, code: '00002', market: null }] }),
    });
    assert.strictEqual(hkFromSource.prices.get(priceKey('HK', '00002')).price, 30, '来源标明港股的行应归港股');
  }

  // 21. 6 位 00 开头且无任何可核实依据：身份不明 → 缺口，绝不猜成 A 股。
  {
    const unresolved = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: [{ code: '000003', subtype: '深市' }],
      query: fakeQuery({ daily: [
        { code: '000003', market: 'CN', date: CLOSE_DATE, price: 8, quality: 'confirmed', isFinal: true },
      ] }),
    });
    assert.strictEqual(unresolved.prices.size, 0, '无依据的同形代码必须按身份不明处理');
    assert.strictEqual(unresolved.status.complete, false);

    const verified = await resolveEffectivePrices({
      username: 'fixture-user', accountName: '账户甲', asOf: WEEKEND, mode: 'current',
      subjects: [{ code: '000003', subtype: '深市' }],
      query: fakeQuery({ daily: [
        { code: '000003', market: 'CN', date: CLOSE_DATE, price: 8, quality: 'confirmed', isFinal: true,
          evidence: { market_basis: 'quote_cache' } },
      ] }),
    });
    assert.strictEqual(verified.prices.get(priceKey('CN', '000003')).price, 8, '有核实依据的 A 股行可以正常使用');
  }

  // 10. 旧机制收口：浏览器不再写收盘价、页面不再有休市校准、归因不再产出校准项。
  {
    const quote = read('public/shared/core-quote.js');
    assert.ok(!quote.includes('holdingsQuoteApi.saveDailyPrices'), '浏览器不得再调用收盘价写入接口');
    assert.ok(quote.includes('await loadData(currentAccount)'), '刷新成功后必须整批重读服务端统一估值结果');
    const tables = read('public/shared/core-tables.js');
    assert.ok(!tables.includes('休市行情校准'), '页面不得再展示休市行情校准');
    assert.ok(tables.includes("return '估值不完整") && tables.includes('valuationIncompleteText(valuationStatus)'),
      '价格证据不足时页面必须用统一原因说明显式提示');
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
