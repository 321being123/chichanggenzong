// B1-1 定点复核一致性：同一冻结输入下，按代码收窄的规则重算必须与全市场审计逐字段一致。
//
// 这是"续批只对本批对象重算、不跑全市场"的正确性前提：
// 若定点路径的规则结论与全市场路径不同，续批就会误删或误留缺口。
'use strict';
const assert = require('assert');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

const repo = require('../repositories/stockSelectionRepository');
const service = require('../services/stockSelectionService');

function patch(object, overrides) {
  const backup = {};
  Object.keys(overrides).forEach(key => { backup[key] = object[key]; object[key] = overrides[key]; });
  return () => Object.entries(backup).forEach(([key, value]) => { object[key] = value; });
}

function universeRow({ instrumentId, companyId, code, pb = '1.20', peTtm = '8.50', dividendYield = '0.0300' }) {
  return {
    instrument_id: instrumentId,
    code,
    name: code,
    market: 'CN',
    currency_code: 'CNY',
    exchange_code: 'SSE',
    list_date: '2015-01-05',
    delist_date: null,
    risk_warning: null,
    company_id: companyId,
    pb,
    equity_currency: 'CNY',
    pe_static: '10.00',
    pe_ttm: peTtm,
    dividend_yield_ttm: dividendYield,
    total_market_cap: '10000000000',
    valuation_currency: 'CNY',
    valuation_date: '2026-11-26',
    price: '10.00',
    price_date: '2026-11-26',
    suspend_type: null,
  };
}

async function run() {
  const fullRows = [
    universeRow({ instrumentId: 901, companyId: 91, code: '600901.SH' }),
    universeRow({ instrumentId: 902, companyId: 92, code: '600902.SH', pb: '2.40', peTtm: '30.00' }),
  ];
  const calls = { loadUniverse: [], loadPbWindow: [], insertArtifact: 0 };
  const restore = patch(repo, {
    async loadMarketValuation() {
      return { pb: 1.1, pe: 12, benchmarkCode: '000300.SH', valuationMethod: 'index_pb', tradeDate: '2026-11-26' };
    },
    async loadUniverseRoster() {
      return fullRows.map(row => ({
        instrument_id: row.instrument_id, code: row.code, name: row.name,
        list_date: row.list_date, delist_date: row.delist_date, exchange_code: row.exchange_code,
        has_any_data: true, has_recent_bars: true,
      }));
    },
    async loadUniverse(args) {
      calls.loadUniverse.push({ codes: args.codes || null });
      if (!args.codes || !args.codes.length) return fullRows;
      const wanted = new Set(args.codes.map(code => String(code).toUpperCase()));
      return fullRows.filter(row => wanted.has(row.code));
    },
    async findUniverseArtifact() { return null; },
    async insertUniverseArtifact() { calls.insertArtifact += 1; },
    async loadPbWindow(args) {
      calls.loadPbWindow.push({ instrumentIds: args.instrumentIds || null });
      return { byInstrument: new Map(), marketDays: 240, calendarDays: 240 };
    },
    async loadEquityFacts() { return new Map(); },
    async loadAnnualProfits() { return new Map(); },
    async loadDividendWindow() { return new Map(); },
    async loadAnnualDividends() { return new Map(); },
    async loadIndustries() { return new Map(); },
    async loadTtmInputs() { return new Map(); },
    async loadFxRatesForPairs() { return new Map(); },
    async loadPbMissingDaysForCodes() { return new Map(); },
  });
  try {
    const full = await service.computeSelection({ market: 'CN', asOfDate: '2026-11-26', positionRatio: 1 });
    eq(full.evaluated.length, 2, '全市场计算必须覆盖两只证券');
    const restricted = await service.computeSelection({
      market: 'CN', asOfDate: '2026-11-26', positionRatio: 1,
      restrictCodes: ['600901.SH'], writeUniverseArtifact: false, allowUniverseDrift: true,
    });
    eq(restricted.evaluated.length, 1, '定点复核必须只重算本批证券');
    eq(calls.loadUniverse[calls.loadUniverse.length - 1].codes.join(','), '600901.SH',
      '定点复核必须把代码下推到股票池查询，不扫全市场');
    ok(calls.loadPbWindow[calls.loadPbWindow.length - 1].instrumentIds
      && calls.loadPbWindow[calls.loadPbWindow.length - 1].instrumentIds.length === 1,
    '定点复核必须把 PB 窗口收窄到本批 instrument_id');
    eq(calls.loadPbWindow[0].instrumentIds, null, '全市场计算不得收窄 PB 窗口');

    const fullRow = full.evaluated.find(item => item.code === '600901.SH');
    const restrictedRow = restricted.evaluated[0];
    eq(JSON.stringify(restrictedRow), JSON.stringify(fullRow),
      '同一冻结输入下，定点复核的规则结论必须与全市场审计逐字段一致');
    eq(JSON.stringify(restricted.anomalyById[901]), JSON.stringify(full.anomalyById[901]),
      '年度异常结论同样必须一致');
    eq(restrictedRow.filterStatus, fullRow.filterStatus, '过滤结论必须一致');
    eq(JSON.stringify(restrictedRow.rules), JSON.stringify(fullRow.rules), '四条规则状态与原因码必须一致');
    ok(restricted.coverage.universeCount === 1 && full.coverage.universeCount === 2,
      '两次计算的分母各自如实记录（定点复核不能被当成全市场覆盖证据）');
  } finally { restore(); }

  console.log(`OK stock-selection-targeted-reaudit: ${checks} 项定点复核与全市场审计一致性通过`);
}

run().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
