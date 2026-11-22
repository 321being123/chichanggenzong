const assert = require('assert');
const { pool } = require('../db/connection');
const { computeNavAttribution } = require('../services/navAttribution');

// #49 线上反馈回归：股票休市时，总资产卡片的“今日收益”必须能显示
// 已确认的汇率变化；明确退市的同账户固定价只有在“基准时点已有同一金额”的
// 旧记录佐证时才可补充基准，且不得把旧记录升格为确认收盘。
const realDate = global.Date;
const frozenNow = realDate.parse('2026-11-22T04:00:00.000Z');
global.Date = class FixedDate extends realDate {
  constructor(...args) { super(...(args.length ? args : [frozenNow])); }
  static now() { return frozenNow; }
};

const originalQuery = pool.query;
const PREV = '2026-11-20';
const OLD = '2026-10-29';

function hkCalendarRow(date) {
  const isOpen = date === PREV;
  return {
    trade_date: date,
    is_open: isOpen,
    source_code: 'hkex_official_schedule',
    raw_payload: {
      official_schedule: {
        is_open: isOpen,
        session_type: isOpen ? 'full_day' : 'closed',
        close_time: isOpen ? '16:10' : null,
        source: 'hkex_official_schedule',
      },
    },
  };
}

let dailyRows = [];

(async () => {
  try {
    // #46 整合后，归因基准改走 navAttributionRepository 的 jsonb_to_recordset 批量查询；
    // 本夹具仍用精简的 dailyRows 行，这里把它们映射到新查询，保持 #49 各场景语义不变。
    const marketOf = code => String(code).startsWith('007') ? 'HK' : 'CN';
    const decorated = () => dailyRows.map(row => ({
      username: 'fixture-user', account_name: 'fixture-account',
      market: row.market || marketOf(row.code), code: row.code, date: row.date,
      price: row.price, quality: row.quality, is_final: row.is_final === true,
      source: row.source || null, evidence: row.evidence || null,
    }));
    pool.query = async (sql, params = []) => {
      if (sql.includes("FROM market.trade_calendar") && sql.includes("exchange='HKEX'")) {
        const dates = Array.isArray(params[0]) ? params[0] : [params[0]];
        return { rows: dates.map(value => hkCalendarRow(String(value).slice(0, 10))) };
      }
      if (sql.includes('FROM market.fx_rates')) return { rows: [] };
      if (sql.includes('jsonb_to_recordset')) {
        const pairs = JSON.parse(params[2] || '[]');
        const rows = decorated();
        if (/JOIN LATERAL/.test(sql)) {
          // 旧参考行：每个目标截点当天或之前最近一条正价（confirmed 分支额外要求 final）。
          const confirmedOnly = /date < w\.date/.test(sql);
          const out = [];
          for (const pair of pairs) {
            const prior = rows.filter(r => r.market === pair.market && r.code === pair.code && Number(r.price) > 0 &&
              (confirmedOnly ? r.date < pair.date && r.quality === 'confirmed' && r.is_final === true : r.date <= pair.date))
              .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
            if (prior) out.push({ ...prior, wanted_market: pair.market, wanted_code: pair.code, wanted_date: pair.date });
          }
          return { rows: out };
        }
        if (/NOT \(dp\.username/.test(sql)) return { rows: [] }; // 共享确认价：本夹具无其它账户
        // listOwnPricesAt：本账户在明确目标日期的精确行。
        const out = [];
        for (const pair of pairs) {
          for (const r of rows) {
            if (r.market === pair.market && r.code === pair.code && r.date === pair.date) out.push(r);
          }
        }
        return { rows: out };
      }
      if (sql.includes('FROM daily_prices')) return { rows: decorated() };
      throw new Error(`unexpected #49 query: ${sql}`);
    };

    const baseNav = (total) => [
      { date: '2026-11-19', totalAsset: total, hkRate: 1, snapshotSource: 'legacy', snapshot_at: '2026-11-19T08:00:00.000Z' },
      { date: PREV, totalAsset: total, hkRate: 1, snapshotSource: 'legacy', snapshot_at: '2026-11-20T08:00:00.000Z' },
    ];
    const delistedData = (extra = {}) => ({
      hkRate: 1,
      cashBase: 0,
      cashFlows: [],
      trades: [{ trade_date: '2026-07-01', code: '404002', direction: 'open', quantity: 1000, price: 2.362 }],
      positions: [{ code: '404002', name: '搜特退债', price: 2.362, quantity: 1000, type: '股权', subtype: '京市' }],
      valuation: {
        complete: true,
        prices: {
          'CN|404002': { price: 2.362, priceKind: 'manual_delisted', quality: 'manual_delisted', tradeDate: null, sourceRef: 'positions.price' },
        },
      },
      navHistory: baseNav(2362),
      ...extra,
    });

    // 1) 生产样本形态：旧日价 quality=legacy_unverified，金额与当前固定价完全相同。
    dailyRows = [
      { code: '404002', date: OLD, price: 2.362, quality: 'legacy_unverified', is_final: false },
      { code: '600001', date: OLD, price: 8.0, quality: 'legacy_unverified', is_final: false },
      { code: '600000', date: PREV, price: 10, quality: 'confirmed', is_final: true },
      { code: '00700', date: PREV, price: 20, quality: 'confirmed', is_final: true },
    ];
    const equalLegacy = await computeNavAttribution('fixture-user', 'fixture-account', delistedData(), 2362);
    assert.strictEqual(equalLegacy.complete, true, '等额旧 legacy 佐证时退市固定价必须让休市日归因完整');
    assert.deepStrictEqual(equalLegacy.missingCodes, [], '退市固定价不应再被列为缺价');
    assert.deepStrictEqual(equalLegacy.unqualifiedBasisCodes, [], '等额旧 legacy 不得让合法固定价基准不合格');
    assert.strictEqual(Math.round(equalLegacy.previousTotalAsset), 2362, '期初总资产重建必须使用同一固定价');
    assert.strictEqual(Math.round(equalLegacy.priceImpact), 0, '固定价与自身比较不应产生价格影响');
    assert.strictEqual(Math.round(equalLegacy.totalChange), 0, '无汇率/现金流变化时今日涨跌应为 0');
    assert.deepStrictEqual(equalLegacy.manualPriceCodes, ['404002'], '必须记录使用退市固定价的标的');
    const equalEvidence = equalLegacy.priceEvidence.find(row => row.code === '404002');
    assert.strictEqual(equalEvidence.basisPrice, 2.362, '基准价必须使用当前统一估值固定价');
    assert.strictEqual(equalEvidence.basisPriceKind, 'manual_delisted');
    assert.strictEqual(equalEvidence.basisPriceDate, null, '固定价没有可冒充的交易日');
    assert.strictEqual(equalEvidence.basisQuality, 'manual_delisted', '旧记录不得冒充确认收盘或 legacy 基准');
    assert.deepStrictEqual(equalEvidence.basisCorroboration, {
      date: OLD, quality: 'legacy_unverified', price: 2.362, relation: 'equal_amount_history',
    }, '旧记录只能作为等额历史佐证，并保留其真实日期与质量');
    assert.strictEqual(equalEvidence.currentPriceKind, 'manual_delisted');
    assert.strictEqual(equalEvidence.quality, 'manual_delisted');
    assert.ok(Math.abs(equalLegacy.snapshotDrift) < 0.01, '同一固定价下归因必须闭合');

    // 2) 异价旧记录：不能因为当前持仓是退市债就把旧价改写成固定价。
    dailyRows = dailyRows.map(row => row.code === '404002' ? { ...row, price: 2.0 } : row);
    const differentLegacy = await computeNavAttribution('fixture-user', 'fixture-account', delistedData(), 2362);
    assert.strictEqual(differentLegacy.complete, false, '异价旧记录不得被退市固定价放行');
    assert.deepStrictEqual(differentLegacy.unqualifiedBasisCodes, ['404002'], '异价旧记录仍按原基准日期资格标不合格');
    const differentEvidence = differentLegacy.priceEvidence.find(row => row.code === '404002');
    assert.strictEqual(differentEvidence.basisPrice, 2.0, '异价旧记录仍是其自身价格，不能被固定价覆盖');
    assert.strictEqual(differentEvidence.basisQuality, 'legacy_unverified');
    assert.ok(!differentEvidence.basisCorroboration, '异价旧记录不能作为等额佐证');

    // 3) 原本合格的精确确认价优先：即使与当前固定价不同，也不能改口径。
    dailyRows = dailyRows.map(row => row.code === '404002' ? { ...row, date: PREV, price: 2.0, quality: 'confirmed', is_final: true } : row);
    const exactConfirmed = await computeNavAttribution('fixture-user', 'fixture-account', delistedData({ navHistory: baseNav(2000) }), 2362);
    assert.strictEqual(exactConfirmed.complete, true, '精确确认基准本身合格，归因应完整');
    const exactEvidence = exactConfirmed.priceEvidence.find(row => row.code === '404002');
    assert.strictEqual(exactEvidence.basisPrice, 2.0, '必须优先保留精确确认的基准价');
    assert.strictEqual(exactEvidence.basisQuality, 'confirmed');
    assert.strictEqual(exactEvidence.basisPriceDate, PREV);
    assert.ok(!exactEvidence.basisCorroboration, '精确确认价不需要旧记录佐证');
    assert.strictEqual(Math.round(exactConfirmed.priceImpact), 362, '确认基准与当前固定价的差额仍如实计入');

    // 4) 缺当前统一估值证据：不得仅凭当前持仓补充基准。
    dailyRows = dailyRows.map(row => row.code === '404002' ? { ...row, date: OLD, price: 2.362, quality: 'legacy_unverified', is_final: false } : row);
    const missingEvidence = await computeNavAttribution('fixture-user', 'fixture-account', delistedData({ valuation: undefined }), 2362);
    assert.strictEqual(missingEvidence.complete, false, '缺当前估值证据时不得放行退市固定价基准');
    assert.deepStrictEqual(missingEvidence.unqualifiedBasisCodes, ['404002'], '缺证据仍保留原基准不合格');
    const missingEvidenceRow = missingEvidence.priceEvidence.find(row => row.code === '404002');
    assert.strictEqual(missingEvidenceRow.basisPrice, 2.362);
    assert.strictEqual(missingEvidenceRow.basisQuality, 'legacy_unverified');
    assert.ok(!missingEvidenceRow.basisCorroboration);

    // 4b) 导入私有锚点保持既有门禁：即使旧值与固定价相等，也不改基准口径。
    const importedAnchor = await computeNavAttribution('fixture-user', 'fixture-account', delistedData({
      navHistory: [
        { date: '2026-11-19', totalAsset: 2362, hkRate: 1, snapshotSource: 'legacy', snapshot_at: '2026-11-19T08:00:00.000Z' },
        { date: PREV, totalAsset: 2362, hkRate: 1, snapshotSource: 'imported', snapshot_at: '2026-11-20T08:00:00.000Z' },
      ],
    }), 2362);
    const importedEvidence = importedAnchor.priceEvidence.find(row => row.code === '404002');
    assert.ok(!importedEvidence.basisCorroboration, '导入私有锚点不得被退市固定价补充基准');
    assert.strictEqual(importedEvidence.basisQuality, 'legacy_unverified', '导入锚点路径仍保留原基准证据');
    assert.strictEqual(importedAnchor.complete, false, '导入锚点原门禁保持不合格');

    // 5) 普通证券不得套用退市固定价：旧日价仍须因日期不符保持基准不合格。
    const ordinaryData = {
      hkRate: 1,
      cashBase: 0,
      cashFlows: [],
      trades: [{ trade_date: '2026-07-01', code: '600001', direction: 'open', quantity: 100, price: 9 }],
      positions: [{ code: '600001', name: '普通股票', price: 9, quantity: 100, type: '股权', subtype: '沪市' }],
      navHistory: baseNav(900),
    };
    const ordinary = await computeNavAttribution('fixture-user', 'fixture-account', ordinaryData, 900);
    assert.strictEqual(ordinary.complete, false, '普通证券的旧日价不能被退市固定价规则救活');
    assert.deepStrictEqual(ordinary.unqualifiedBasisCodes, ['600001'], '普通证券仍按原基准日期资格标不合格');
    assert.strictEqual(ordinary.priceEvidence[0].basisPrice, 8, '普通证券仍使用其自身日价，不串到退市固定价');

    // 6) 休市纯 FX 与等额旧 legacy 退市债组合：价格影响为 0，汇率影响完整计入。
    const combinedData = {
      hkRate: 0.91,
      cashBase: 1000,
      cashFlows: [],
      trades: [{ trade_date: '2026-07-01', code: '404002', direction: 'open', quantity: 1000, price: 2.362 }],
      positions: [
        { code: '404002', name: '搜特退债', price: 2.362, quantity: 1000, type: '股权', subtype: '京市' },
        { code: '600000', name: 'A 股样例', subtype: '沪市', price: 10, quantity: 100 },
        { code: '00700', name: '港股样例', subtype: '港股', price: 20, quantity: 100 },
      ],
      valuation: {
        complete: true,
        prices: {
          'CN|404002': { price: 2.362, priceKind: 'manual_delisted', quality: 'manual_delisted', tradeDate: null, sourceRef: 'positions.price' },
          'CN|600000': { price: 10, priceKind: 'close', quality: 'confirmed', tradeDate: PREV, sourceRef: 'daily_prices' },
          'HK|00700': { price: 20, priceKind: 'close', quality: 'confirmed', tradeDate: PREV, sourceRef: 'daily_prices' },
        },
      },
      navHistory: [
        { date: '2026-11-19', totalAsset: 6162, hkRate: 0.90, snapshotSource: 'legacy', snapshot_at: '2026-11-19T08:00:00.000Z' },
        { date: PREV, totalAsset: 6162, hkRate: 0.90, snapshotSource: 'legacy', snapshot_at: '2026-11-20T08:00:00.000Z' },
      ],
    };
    const combined = await computeNavAttribution('fixture-user', 'fixture-account', combinedData, 6182);
    assert.strictEqual(combined.complete, true, '退市固定价与休市纯汇率变化组合必须完整');
    assert.strictEqual(Math.round(combined.priceImpact), 0, '休市证券与固定价不得产生价格影响');
    assert.strictEqual(Math.round(combined.fxImpact), 20, '20 港元 × 100 股 × 0.01 的汇率变化必须计入');
    assert.strictEqual(Math.round(combined.totalChange), 20, '休市日今日涨跌应等于已确认汇率影响');
    assert.ok(combined.manualPriceCodes.includes('404002'), '组合夹具仍须记录退市固定价');
    assert.ok(Math.abs(combined.snapshotDrift) < 0.01, '固定价与纯汇率组合归因必须闭合');

    console.log('nav delisted fixed basis and closed-day FX tests passed');
  } finally {
    global.Date = realDate;
    pool.query = originalQuery;
  }
})().catch((error) => { console.error(error); process.exit(1); });
