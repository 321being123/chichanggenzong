// 反馈 #46 服务端根因回归：历史资产与归因基准不能只按账户过滤已确认收盘价。
// 普通证券的 confirmed + final 正价是公开市场事实；共享候选必须按“市场+代码+实际应有
// 收盘日”精确读取。候选/过期/冲突/私有派生/异市场仍须保留缺失；同日 confirmed 冲突
// 不能落入停牌、换券或固定价兜底。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { computeNavHistoryTotals, computeNavAttribution, buildNavPerformance } =
  require('../services/navAttribution');
const { prefetchMarketFacts } = require('../services/marketState');
const NavMath = require('../../public/shared/nav-math');

const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const U = 'feedback46_shared';
const A = '账户甲';
const OTHER_USER = 'feedback46_other';
const OTHER_ACCOUNT = '账户乙';
const BOND = '113050';
const FIXED_NOW = '2026-11-22T10:00:00+08:00';
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
  static now() { return RealDate.parse(FIXED_NOW); }
};

function row(overrides = {}) {
  return {
    username: OTHER_USER, account_name: OTHER_ACCOUNT, date: '2026-11-20', code: BOND,
    market: 'CN', price: 101, quality: 'confirmed', is_final: true,
    source: 'history_backfill:tushare', evidence: {}, ...overrides,
  };
}

function makeQuery(sourceRows) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM market\.fx_rates/.test(sql)) return { rows: [] };
    if (/market\.trade_calendar/.test(sql)) {
      const dates = Array.isArray(params[0]) ? params[0] : [params[0]].filter(Boolean);
      return { rows: dates.map(value => {
        const date = String(value).slice(0, 10);
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        const isOpen = weekday >= 1 && weekday <= 5;
        return {
          trade_date: date, is_open: isOpen, source_code: 'test_fixture',
          raw_payload: { official_schedule: { is_open: isOpen, session_type: isOpen ? 'full_day' : 'closed',
            close_time: isOpen ? '16:10' : null, source: 'test_fixture' } },
        };
      }) };
    }
    if (/jsonb_to_recordset/.test(sql)) {
      const pairs = JSON.parse(params[2] || '[]');
      if (/JOIN LATERAL/.test(sql)) {
        const [username, accountName] = params;
        const rows = [];
        const confirmedOnly = /date < w\.date/.test(sql);
        for (const pair of pairs) {
          const prior = sourceRows.filter(r => r.username === username && r.account_name === accountName &&
            r.market === pair.market && r.code === pair.code && Number(r.price) > 0 &&
            (confirmedOnly ? r.date < pair.date && r.quality === 'confirmed' && r.is_final === true : r.date <= pair.date))
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
          if (prior) rows.push({ ...prior, wanted_market: pair.market, wanted_code: pair.code, wanted_date: pair.date });
        }
        return { rows };
      }
      const shared = /NOT \(dp\.username/.test(sql);
      const [username, accountName, , privateSources = []] = params;
      const rows = [];
      for (const pair of pairs) {
        for (const candidate of sourceRows) {
          if (candidate.market !== pair.market || candidate.code !== pair.code || candidate.date !== pair.date) continue;
          if (shared) {
            if (candidate.username === username && candidate.account_name === accountName) continue;
            if (!(candidate.quality === 'confirmed' && candidate.is_final === true && Number(candidate.price) > 0)) continue;
            if (privateSources.includes(String(candidate.source || ''))) continue;
          } else if (!(candidate.username === username && candidate.account_name === accountName)) continue;
          rows.push(candidate);
        }
      }
      return { rows };
    }
    if (/DISTINCT ON \(market, code\)/.test(sql)) {
      const [username, accountName, lower] = params;
      const candidates = sourceRows.filter(r => r.username === username && r.account_name === accountName &&
        r.date < lower && r.quality === 'confirmed' && r.is_final === true && Number(r.price) > 0);
      const latest = new Map();
      for (const candidate of candidates) {
        const key = `${candidate.market}|${candidate.code}`;
        if (!latest.has(key) || candidate.date > latest.get(key).date) latest.set(key, candidate);
      }
      return { rows: [...latest.values()] };
    }
    if (/date >= \$3 AND date <= \$4/.test(sql)) {
      const [username, accountName, lower, upper] = params;
      return { rows: sourceRows.filter(r => r.username === username && r.account_name === accountName &&
        r.date >= lower && r.date <= upper) };
    }
    throw new Error('unexpected query: ' + sql);
  };
  query.calls = calls;
  return query;
}

function dataWithNav(overrides = {}) {
  return {
    cashBase: 0, cashFlows: [], trades: [],
    positions: [{ code: BOND, quantity: 10, subtype: '沪市', price: 120 }],
    positionSnapshots: [{ snapshotId: 'import-1', snapshotDate: '2026-11-18', code: BOND, quantity: 10, quoteCurrency: 'CNY' }],
    navHistory: [
      { date: '2026-11-19', nav: 1, totalAsset: 1000, snapshotSource: 'imported', isLocked: true,
        importBatchId: 'import-1', snapshot_at: '2026-11-19T15:00:00+08:00' },
      { date: '2026-11-20', snapshotSource: 'system', snapshot_at: '2026-11-20T15:00:00+08:00' },
    ],
    ...overrides,
  };
}

function frontendReturns(data, performance, totals) {
  const context = { data: { ...data, performanceHistory: performance, navReturnTotals: totals },
    NavMath, investedAt: NavMath.investedAt, todayCN: () => '2026-11-22' };
  vm.createContext(context);
  vm.runInContext(read('public/shared/core-earnings.js'), context);
  return context.buildRealReturnsSeries();
}

(async () => {
  try {
    // 1. 只存在共享 confirmed 收盘价：历史资产与归因基准必须恢复。
    {
      const query = makeQuery([row()]);
      const totals = await computeNavHistoryTotals(U, A, dataWithNav(), query);
      assert.strictEqual(totals['2026-11-20'], 1010, '共享 confirmed 收盘价必须参与历史总资产重建');
      const dailyQueries = query.calls.filter(c => /daily_prices/.test(c.sql));
      assert.strictEqual(dailyQueries.length, 3, '本账户范围、下界前确认价、共享精确候选各一次批量读取');
      assert(dailyQueries.every(c => !/date::date/.test(c.sql)), '日期比较必须使用可索引的 ISO 文本范围');

      const attribution = await computeNavAttribution(U, A, dataWithNav(), 1010, query);
      assert.strictEqual(attribution.complete, true, '共享收盘补齐后归因必须完整');
      assert.deepStrictEqual(attribution.missingCodes, []);
      const evidence = attribution.priceEvidence.find(item => item.code === BOND);
      assert.strictEqual(evidence.basisPrice, 101);
      assert.strictEqual(evidence.basisQualified, true);
      assert.strictEqual(evidence.basisPriceDate, '2026-11-20');
    }

    // 2. 已清仓证券：代码/目标日集合必须来自历史持仓/交易，不能只看当前持仓。
    {
      const cleared = {
        cashBase: 0, cashFlows: [], positions: [],
        positionSnapshots: [{ snapshotId: 'import-2', snapshotDate: '2026-11-18', code: BOND, quantity: 10, quoteCurrency: 'CNY' }],
        trades: [{ code: BOND, direction: 'sell', quantity: 10, trade_date: '2026-11-20', amount_cny: 1000, quote_currency: 'CNY' }],
        navHistory: [
          { date: '2026-11-19', snapshotSource: 'system', snapshot_at: '2026-11-19T15:00:00+08:00' },
          { date: '2026-11-20', snapshotSource: 'system', snapshot_at: '2026-11-20T15:00:00+08:00' },
        ],
      };
      const totals = await computeNavHistoryTotals(U, A, cleared, makeQuery([row({ date: '2026-11-19', price: 100 })]));
      assert.strictEqual(totals['2026-11-19'], 1000, '已清仓证券的历史持仓也必须能取到共享收盘价');
    }

    // 3. 同日低质量本地行与共享 confirmed 共存：按质量择优，不影响结果。
    {
      const own = row({ username: U, account_name: A, price: 50, quality: 'legacy_unverified', is_final: false, source: null });
      const totals = await computeNavHistoryTotals(U, A, dataWithNav(), makeQuery([own, row()]));
      assert.strictEqual(totals['2026-11-20'], 1010, '低质量本地行不得遮蔽共享 confirmed 价');
      const attribution = await computeNavAttribution(U, A, dataWithNav(), 1010, makeQuery([own, row()]));
      assert.strictEqual(attribution.complete, true);
      assert.strictEqual(attribution.priceEvidence.find(item => item.code === BOND).basisPrice, 101);
    }

    // 4. 基准/历史只认实际应有收盘日：不在目标日的共享价不得顶替，也不能把历史终点当完整。
    {
      const staleTotals = await computeNavHistoryTotals(U, A, dataWithNav(),
        makeQuery([row({ date: '2026-11-19' })]));
      assert.strictEqual(staleTotals['2026-11-20'], null, '共享价日期不符时仍须保留缺失');
      const staleAttribution = await computeNavAttribution(U, A, dataWithNav(), 1010,
        makeQuery([row({ date: '2026-11-19' })]));
      assert.strictEqual(staleAttribution.complete, false, '过期共享基准不得当成完整归因');
    }

    // 4b. 更新但日期不合的本地候选不得遮蔽准确共享价或历史终点。
    {
      const localNewer = row({ username: U, account_name: A, date: '2026-11-21', price: 50,
        quality: 'legacy_unverified', is_final: false, source: null });
      const weekendNav = dataWithNav({
        navHistory: [
          { date: '2026-11-19', nav: 1, totalAsset: 1000, snapshotSource: 'imported', isLocked: true,
            importBatchId: 'import-1', snapshot_at: '2026-11-19T15:00:00+08:00' },
          { date: '2026-11-22', snapshotSource: 'system', snapshot_at: '2026-11-22T15:00:00+08:00' },
        ],
      });
      const totals = await computeNavHistoryTotals(U, A, weekendNav, makeQuery([localNewer, row()]));
      assert.strictEqual(totals['2026-11-22'], 1010, '更新但日期不合的本地候选不得遮蔽 11-20 共享确认价');

      const attribution = await computeNavAttribution(U, A, dataWithNav(), 1010,
        makeQuery([localNewer, row()]));
      assert.strictEqual(attribution.complete, true, '本地 11-21 候选不得遮蔽 11-20 共享基准');
      assert.strictEqual(attribution.priceEvidence.find(item => item.code === BOND).basisPrice, 101);
    }

    // 5. 同市场同代码同日 confirmed 跨账户冲突：保留缺失，不能落入固定价/停牌兜底。
    {
      const conflicted = [row({ price: 101 }), row({ username: 'feedback46_third', account_name: '账户丙', price: 102 })];
      const delisted = dataWithNav({
        positions: [{ code: '404002', name: '搜特退债', quantity: 10, subtype: '沪市', price: 90 }],
        positionSnapshots: [{ snapshotId: 'import-1', snapshotDate: '2026-11-18', code: '404002', quantity: 10, quoteCurrency: 'CNY' }],
      });
      const conflictRows = conflicted.map(item => ({ ...item, code: '404002' }));
      const conflictTotals = await computeNavHistoryTotals(U, A, delisted, makeQuery(conflictRows));
      assert.strictEqual(conflictTotals['2026-11-20'], null, '冲突日必须保持缺失，不能使用固定价兜底');
      const conflictAttribution = await computeNavAttribution(U, A, delisted, 1010, makeQuery(conflictRows));
      assert.strictEqual(conflictAttribution.complete, false, '基准价冲突时归因不得完整');
    }

    // 6. 账户私有派生价与异市场价：不得跨账户/跨市场共享。
    {
      const privateTotals = await computeNavHistoryTotals(U, A, dataWithNav(),
        makeQuery([row({ source: 'nav_import_anchor' })]));
      assert.strictEqual(privateTotals['2026-11-20'], null, '其它账户的私有派生价不得共享');
      const crossMarket = await computeNavHistoryTotals(U, A, dataWithNav(),
        makeQuery([row({ market: 'HK' })]));
      assert.strictEqual(crossMarket['2026-11-20'], null, '同代码不同市场的价格不得串用');
    }

    // 7. 港股 5/6 位等价：共享行存 6 位时 5 位持仓仍可取到；同形 A 股行不得混入。
    {
      const hkData = {
        cashBase: 0, cashFlows: [], trades: [],
        positions: [{ code: '00700', quantity: 10, subtype: '港股', price: 500 }],
        positionSnapshots: [{ snapshotId: 'import-hk', snapshotDate: '2026-11-18', code: '00700', quantity: 10, quoteCurrency: 'HKD' }],
        navHistory: [
          { date: '2026-11-19', nav: 1, totalAsset: 3000, snapshotSource: 'imported', isLocked: true,
            importBatchId: 'import-hk', snapshot_at: '2026-11-19T16:00:00+08:00' },
          { date: '2026-11-20', snapshotSource: 'system', hkRate: 0.9, snapshot_at: '2026-11-20T16:00:00+08:00' },
        ],
      };
      const hkRows = [
        row({ username: OTHER_USER, account_name: OTHER_ACCOUNT, code: '000700', market: 'HK', price: 400 }),
        row({ username: OTHER_USER, account_name: OTHER_ACCOUNT, code: '000700', market: 'CN', price: 1 }),
      ];
      const hkTotals = await computeNavHistoryTotals(U, A, hkData, makeQuery(hkRows));
      assert.strictEqual(hkTotals['2026-11-20'], 3600, '港股 5/6 位等价必须取到共享价，且不得混入同形 A 股');

      // 别名一方低质量候选不能挡住另一方的可信同日收盘。
      const aliasLow = row({ username: U, account_name: A, code: '00001', market: 'HK',
        price: 50, quality: 'candidate', is_final: false, source: null });
      const aliasConfirmed = row({ username: OTHER_USER, account_name: OTHER_ACCOUNT, code: '000001',
        market: 'HK', price: 20, quality: 'confirmed', is_final: true });
      const aliasData = {
        cashBase: 0, cashFlows: [], trades: [],
        positions: [{ code: '00001', quantity: 10, subtype: '港股', price: 20 }],
        positionSnapshots: [{ snapshotId: 'import-hk2', snapshotDate: '2026-11-18', code: '00001', quantity: 10, quoteCurrency: 'HKD' }],
        navHistory: [
          { date: '2026-11-19', nav: 1, totalAsset: 200, snapshotSource: 'imported', isLocked: true,
            importBatchId: 'import-hk2', snapshot_at: '2026-11-19T16:00:00+08:00' },
          { date: '2026-11-20', snapshotSource: 'system', hkRate: 1, snapshot_at: '2026-11-20T16:00:00+08:00' },
        ],
      };
      const aliasTotals = await computeNavHistoryTotals(U, A, aliasData, makeQuery([aliasLow, aliasConfirmed]));
      assert.strictEqual(aliasTotals['2026-11-20'], 200, '港股别名低质量候选不得遮蔽另一别名的 confirmed 收盘');
      const aliasConflict = [
        row({ username: OTHER_USER, account_name: OTHER_ACCOUNT, code: '00001', market: 'HK', price: 20 }),
        row({ username: 'feedback46_third', account_name: '账户丙', code: '000001', market: 'HK', price: 22 }),
      ];
      const conflictTotals = await computeNavHistoryTotals(U, A, aliasData, makeQuery(aliasConflict));
      assert.strictEqual(conflictTotals['2026-11-20'], null, '港股别名同日 confirmed 不同价必须保留缺失');
    }

    // 8. 11-22 实时行：totalAsset + navAttribution 就绪后必须续出净值，六项指标全部恢复。
    {
      const query = makeQuery([row()]);
      const data = dataWithNav({
        totalAsset: 1100,
        navAttribution: { complete: true, currentDate: '2026-11-22', previousDate: '2026-11-20',
          previousTotalAsset: 1010, totalChange: 90 },
      });
      const totals = await computeNavHistoryTotals(U, A, data, query);
      const performance = await buildNavPerformance(data, totals);
      const live = performance.at(-1);
      assert.strictEqual(live.date, '2026-11-22', '必须追加 11-22 实时行');
      assert.strictEqual(live.nav, 1.1, '11-20 基准恢复后 11-22 实时净值必须续链');
      const display = frontendReturns(data, performance, totals);
      const derived = display.at(-1);
      assert.strictEqual(derived.date, '2026-11-22');
      for (const key of ['nav', 'totalReturn', 'annualizedReturn', 'yearReturn',
        'currentDrawdown', 'maxDrawdown']) {
        assert.notStrictEqual(derived[key], null, `11-22 实时行六项指标不得缺失：${key}`);
      }
    }

    // 8b. 券商导入日私有固化价：prevDate 休市时仍保留导入日 nav_import_anchor 作为
    // 数值参考，但不得把实际上一交易日 confirmed 价改称完整基准。
    {
      const anchorData = {
        cashBase: 0, cashFlows: [], trades: [], hkRate: 1,
        positions: [{ code: '00700', quantity: 10, subtype: '港股', price: 100 }],
        positionSnapshots: [{ snapshotId: 'import-anchor', snapshotDate: '2026-11-21', code: '00700', quantity: 10, quoteCurrency: 'HKD' }],
        navHistory: [
          { date: '2026-11-21', totalAsset: 1000, snapshotSource: 'imported', isLocked: true, hkRate: 1,
            importBatchId: 'import-anchor', snapshot_at: '2026-11-21T16:00:00+08:00' },
          { date: '2026-11-22', totalAsset: 1000, snapshotSource: 'legacy', hkRate: 1,
            snapshot_at: '2026-11-22T16:00:00+08:00' },
        ],
      };
      const rows = [
        row({ username: U, account_name: A, date: '2026-11-21', code: '00700', market: 'HK',
          price: 100, quality: 'anchor_carry_forward', is_final: false, source: 'nav_import_anchor' }),
        row({ username: U, account_name: A, date: '2026-11-20', code: '00700', market: 'HK',
          price: 100, quality: 'confirmed', is_final: true, source: 'market_close_task:港股' }),
      ];
      const query = makeQuery(rows);
      await prefetchMarketFacts('HK', ['2026-11-20', '2026-11-21', '2026-11-22'], query);
      const attribution = await computeNavAttribution(U, A, anchorData, 1000, query);
      assert.strictEqual(attribution.complete, false, '导入日私有固化价不能冒充完整收盘基准');
      assert.ok(attribution.reasonCodes.includes('basis_price_not_confirmed'));
      const evidence = attribution.priceEvidence.find(item => item.code === '00700');
      assert.strictEqual(evidence.basisPriceDate, '2026-11-21', '必须保留导入日私有锚点证据日');
      assert.strictEqual(evidence.basisExpectedDate, '2026-11-20');
      assert.strictEqual(evidence.basisQualified, false);
      assert.strictEqual(Math.round(attribution.priceImpact), 0, '数值归因仍使用导入日固化价并保持闭合');
    }

    // 9. 仓储结构：共享候选按精确目标日批量 JOIN，不再全历史读取或 date::date 转换。
    const repository = read('server/repositories/navAttributionRepository.js');
    assert(!repository.includes('date::date'), '仓储不得用 date::date 转换破坏日期索引');
    assert(repository.includes('jsonb_to_recordset') && repository.includes('JOIN daily_prices'),
      '共享候选/基准必须按明确目标日批量读取');
    assert(repository.includes('NOT (dp.username=$1 AND dp.account_name=$2)'),
      '共享候选必须排除本账户，避免与本地行重复');
    for (const match of repository.matchAll(/SELECT([\s\S]*?)FROM/g)) {
      assert(!/username|account_name/.test(match[1]), '价格读取不应返回无用的账号列');
    }
    const service = read('server/services/navAttribution.js');
    assert(service.includes('selectDailyPrice'), '历史与归因必须共用同一单日选价函数');

    console.log('nav shared history price: bounded shared close, exact expected date, conflict/private/market guards and live six metrics passed');
  } finally {
    global.Date = RealDate;
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
