const { pool } = require('../db/connection');
const { tushareQuery, tsRows, tsDateStr } = require('./market');
const { fetchTencentQuotes } = require('./tencentQuote');

const FINANCIAL_TTL_DAYS = 30;
// 单批最多 15 家：每家公司并发请求 3 个财务接口，45 次请求低于主、备 Token 的每分钟预算，
// 并为本任务的行情请求及随后任务保留余量。批次之间跨分钟，避免缓存集中到期时形成请求洪峰。
const FINANCIAL_REFRESH_BATCH_SIZE = 15;
const CONVERTIBLE_PREFIX = /^(110|111|113|118|123|127|128)/;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function nextFinancialBatchDelay(now = Date.now()) {
  return (Math.floor(now / 60000) + 1) * 60000 + 1000 - now;
}

async function waitForNextFinancialBatch(remaining) {
  const delay = nextFinancialBatchDelay();
  console.log(`[可转债安全] 财务同步分批保护：本批完成，${remaining} 只待处理，${Math.ceil(delay / 1000)} 秒后继续`);
  await sleep(delay);
}
function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function preferredSecurityName(quote, fallback) {
  return String((quote && quote.name) || fallback || '').trim();
}

function isActiveBond(row, today, listedStocks) {
  return Boolean(row && row.list_date && row.list_date <= today &&
    (!row.delist_date || row.delist_date > today) &&
    (!row.maturity_date || row.maturity_date >= today) &&
    (!row.conv_end_date || row.conv_end_date >= today) &&
    (!row.conv_stop_date || row.conv_stop_date > today) &&
    CONVERTIBLE_PREFIX.test(row.ts_code) &&
    (!listedStocks || listedStocks.has(row.stk_code)));
}

function selectFinancialReport(indicators, balances, incomes, today) {
  // 兼容旧的三参数调用 selectFinancialReport(indicators, balances, today)。
  if (typeof incomes === 'string' && today === undefined) { today = incomes; incomes = []; }
  const indicatorByPeriod = new Map();
  (indicators || []).filter(row => row.end_date && (!row.ann_date || row.ann_date <= today))
    .sort((a, b) => String(b.ann_date || '').localeCompare(String(a.ann_date || '')))
    .forEach(row => { if (!indicatorByPeriod.has(row.end_date)) indicatorByPeriod.set(row.end_date, row); });
  const balanceByPeriod = new Map();
  (balances || []).filter(row => row.end_date && (!row.f_ann_date || row.f_ann_date <= today))
    .sort((a, b) => {
      const report = (String(a.report_type) === '1' ? -1 : 0) - (String(b.report_type) === '1' ? -1 : 0);
      return report || String(b.f_ann_date || '').localeCompare(String(a.f_ann_date || ''));
    })
    .forEach(row => { if (!balanceByPeriod.has(row.end_date)) balanceByPeriod.set(row.end_date, row); });
  const period = Array.from(indicatorByPeriod.keys()).filter(value => balanceByPeriod.has(value)).sort().reverse()[0];
  if (!period) return null;
  const fi = indicatorByPeriod.get(period), bs = balanceByPeriod.get(period);
  const income = (incomes || []).filter(row => row.end_date === period && (!row.f_ann_date || row.f_ann_date <= today))
    .sort((a, b) => String(b.f_ann_date || b.ann_date || '').localeCompare(String(a.f_ann_date || a.ann_date || '')))[0] || {};
  const directInterest = finite(income.fin_exp_int_exp) != null ? finite(income.fin_exp_int_exp) : finite(income.int_exp);
  const derivedInterest = finite(fi.ebit_to_interest) && finite(fi.ebit) != null
    ? finite(fi.ebit) / finite(fi.ebit_to_interest) : null;
  return {
    report_end_date: period,
    announced_at: [fi.ann_date, bs.f_ann_date].filter(Boolean).sort().reverse()[0] || null,
    interest_coverage: finite(fi.ebit_to_interest),
    interest_expense: directInterest != null ? directInterest : derivedInterest,
    ebit: finite(fi.ebit),
    cash: finite(bs.money_cap),
    trading_fin_assets: finite(bs.trad_asset),
      interest_bearing_debt: finite(fi.interestdebt),
      total_assets: finite(bs.total_assets),
      total_liability: finite(bs.total_liab),
    current_liability: finite(bs.total_cur_liab),
    shareholder_equity: finite(bs.total_hldr_eqy_exc_min_int),
  };
}

async function loadFinancialCache() {
  const { rows } = await pool.query('SELECT ts_code, stock_name, data, fetched_at FROM bond_safety_financial_cache');
  return new Map(rows.map(row => [row.ts_code, {
    stock_name: row.stock_name,
    data: row.data || {},
    fetched_at: new Date(row.fetched_at).getTime(),
  }]));
}

async function saveFinancialCache(tsCode, stockName, data) {
  await pool.query(
    `INSERT INTO bond_safety_financial_cache
       (ts_code, stock_name, report_end_date, announced_at, data)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (ts_code) DO UPDATE SET stock_name=EXCLUDED.stock_name,
       report_end_date=EXCLUDED.report_end_date, announced_at=EXCLUDED.announced_at,
       data=EXCLUDED.data, fetched_at=now()`,
    [tsCode, stockName || '', data.report_end_date, data.announced_at, JSON.stringify(data)]
  );
}

// 由已缓存的最近报告期推算“增量窗口起点”：只拉取该报告期往前约一年，
// 覆盖最新一期及其修订，避免缓存过期后重拉全部历史。首次无缓存则返回 null（全量）。
function financialWindowStart(cached) {
  const end = cached && cached.data && cached.data.report_end_date;
  const t = end ? String(end).replace(/-/g, '') : '';
  if (!/^\d{8}$/.test(t)) return null;
  const d = new Date(Date.UTC(Number(t.slice(0, 4)) - 1, Number(t.slice(4, 6)) - 1, Number(t.slice(6, 8))));
  return tsDateStr(d);
}

async function fetchOneFinancial(stock, today, startDate) {
  const dateParams = startDate ? { start_date: startDate } : {};
  const [fiData, bsData, incomeData] = await Promise.all([
    tushareQuery('fina_indicator', Object.assign({ ts_code: stock.stk_code }, dateParams), 'ts_code,ann_date,end_date,ebit,ebit_to_interest,interestdebt'),
      tushareQuery('balancesheet', Object.assign({ ts_code: stock.stk_code }, dateParams), 'ts_code,f_ann_date,end_date,report_type,money_cap,trad_asset,total_assets,total_cur_liab,total_liab,total_hldr_eqy_exc_min_int'),
    tushareQuery('income', Object.assign({ ts_code: stock.stk_code }, dateParams), 'ts_code,ann_date,f_ann_date,end_date,report_type,fin_exp_int_exp,int_exp'),
  ]);
  return selectFinancialReport(tsRows(fiData), tsRows(bsData), tsRows(incomeData), today);
}

function derivePb(totalMvWan, shareholderEquity) {
  const marketCap = finite(totalMvWan);
  const equity = finite(shareholderEquity);
  return marketCap != null && equity != null && equity !== 0 ? marketCap * 10000 / equity : null;
}

async function backfillMissingEquity(stocks, valuations, cache, today) {
  const pending = stocks.filter(stock => {
    const valuation = valuations.get(stock.stk_code) || {};
    const cached = cache.get(stock.stk_code);
    return finite(valuation.pb) == null && !(cached && finite(cached.data && cached.data.shareholder_equity) != null);
  });
  for (let offset = 0; offset < pending.length; offset += FINANCIAL_REFRESH_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + FINANCIAL_REFRESH_BATCH_SIZE);
    for (const stock of batch) {
      try {
        const data = await tushareQuery('balancesheet', { ts_code: stock.stk_code },
          'ts_code,f_ann_date,end_date,report_type,total_hldr_eqy_exc_min_int');
        const latest = tsRows(data)
          .filter(row => row.end_date && (!row.f_ann_date || row.f_ann_date <= today) && String(row.report_type) === '1')
          .sort((a, b) => String(b.f_ann_date || '').localeCompare(String(a.f_ann_date || '')))[0];
        if (!latest || finite(latest.total_hldr_eqy_exc_min_int) == null) continue;
        const previous = cache.get(stock.stk_code);
        const merged = Object.assign({}, previous ? previous.data : {}, {
          shareholder_equity: finite(latest.total_hldr_eqy_exc_min_int),
          report_end_date: (previous && previous.data.report_end_date) || latest.end_date,
          announced_at: (previous && previous.data.announced_at) || latest.f_ann_date,
        });
        await saveFinancialCache(stock.stk_code, stock.stk_short_name, merged);
        cache.set(stock.stk_code, { stock_name: stock.stk_short_name, data: merged, fetched_at: Date.now() });
      } catch (_) {}
    }
    const remaining = Math.max(pending.length - offset - batch.length, 0);
    if (remaining > 0) await waitForNextFinancialBatch(remaining);
  }
}

async function refreshFinancials(stocks, today) {
  const cache = await loadFinancialCache();
  const ttl = Math.max(1, Number(process.env.BOND_SAFETY_FINANCIAL_TTL_DAYS) || FINANCIAL_TTL_DAYS) * 86400000;
  const pending = stocks.filter(stock => {
    const cached = cache.get(stock.stk_code);
    return !cached || !cached.data || finite(cached.data.interest_coverage) == null ||
      finite(cached.data.total_assets) == null || Date.now() - cached.fetched_at >= ttl;
  });
  // 每家公司同时占用 3 个带数据库锁的 Tushare 请求；连接池默认 10，最多 3 家并发，
  // 为请求完成时的熔断状态更新保留至少 1 个连接，避免生产配置为 6 时连接池互等。
  const concurrency = Math.max(1, Math.min(3, Number(process.env.BOND_SAFETY_TUSHARE_CONCURRENCY) || 3));
  let windowCount = 0, fullCount = 0;
  for (let offset = 0; offset < pending.length; offset += FINANCIAL_REFRESH_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + FINANCIAL_REFRESH_BATCH_SIZE);
    let cursor = 0;
    async function worker() {
      while (cursor < batch.length) {
        const stock = batch[cursor++];
        const cached = cache.get(stock.stk_code);
        const startDate = financialWindowStart(cached);
        if (startDate) windowCount++; else fullCount++;
        try {
          const data = await fetchOneFinancial(stock, today, startDate);
          if (data) {
            await saveFinancialCache(stock.stk_code, stock.stk_short_name, data);
            cache.set(stock.stk_code, { stock_name: stock.stk_short_name, data, fetched_at: Date.now() });
          }
        } catch (_) {}
        await sleep(Math.max(50, Number(process.env.BOND_SAFETY_TUSHARE_DELAY_MS) || 200));
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
    const remaining = Math.max(pending.length - offset - batch.length, 0);
    if (remaining > 0) await waitForNextFinancialBatch(remaining);
  }
  console.log(`[可转债安全] 财务同步：${pending.length} 只待更新，其中增量窗口 ${windowCount} 只、首次全量 ${fullCount} 只`);
  return cache;
}

async function latestOpenDates(today) {
  const start = new Date(); start.setDate(start.getDate() - 20);
  const data = await tushareQuery('trade_cal', { exchange: 'SSE', start_date: tsDateStr(start), end_date: today, is_open: '1' }, 'cal_date,is_open');
  return tsRows(data).filter(row => String(row.is_open) === '1').map(row => row.cal_date).sort().reverse();
}

async function latestMarketRows(apiName, dates, fields) {
  for (const tradeDate of dates.slice(0, 5)) {
    const data = await tushareQuery(apiName, { trade_date: tradeDate }, fields);
    const rows = tsRows(data);
    if (rows.length) return { tradeDate, rows };
  }
  return { tradeDate: null, rows: [] };
}

function normalizeIndustry(value) {
  const text = String(value || '');
  if (text.includes('银行')) return '银行';
  if (/证券|保险|多元金融/.test(text)) return '非银金融';
  return text;
}

async function fetchTushareBondSafetySource() {
  const today = tsDateStr(new Date());
  const [basicData, stockData, dates] = await Promise.all([
    tushareQuery('cb_basic', {}, 'ts_code,bond_short_name,stk_code,stk_short_name,list_date,delist_date,maturity_date,conv_end_date,conv_stop_date,conv_price'),
    tushareQuery('stock_basic', { exchange: '', list_status: 'L' }, 'ts_code,name,industry'),
    latestOpenDates(today),
  ]);
  const stockRows = tsRows(stockData);
  const listedStocks = new Set(stockRows.map(row => row.ts_code));
  const basics = tsRows(basicData).filter(row => isActiveBond(row, today, listedStocks));
  if (!basics.length || !dates.length) throw new Error('Tushare 未返回在市可转债或交易日数据');

  const [bondDaily, stockDaily, stockPrices, tencent] = await Promise.all([
    latestMarketRows('cb_daily', dates, 'ts_code,trade_date,close,pct_chg'),
    latestMarketRows('daily_basic', dates, 'ts_code,trade_date,pe_ttm,pe,pb,dv_ttm,total_mv'),
    latestMarketRows('daily', dates, 'ts_code,trade_date,close,pct_chg'),
    fetchTencentQuotes(basics.flatMap(row => [row.ts_code, row.stk_code])),
  ]);
  if (!bondDaily.rows.length || !stockDaily.rows.length || !stockPrices.rows.length) throw new Error('Tushare 最新交易日行情为空，保留上一份快照');

  const bondQuotes = new Map(bondDaily.rows.map(row => [row.ts_code, row]));
  const tradableBasics = basics.filter(row => {
    const daily = bondQuotes.get(row.ts_code);
    const live = tencent.get(String(row.ts_code).split('.')[0]);
    return finite(daily && daily.close) > 0 || finite(live && live.price) > 0;
  });
  if (!tradableBasics.length) throw new Error('未找到具有有效市场价格的在市可转债');

  const uniqueStocks = Array.from(new Map(tradableBasics.map(row => [row.stk_code, row])).values());
  const valuations = new Map(stockDaily.rows.map(row => [row.ts_code, row]));
  const financials = await refreshFinancials(uniqueStocks, today);
  await backfillMissingEquity(uniqueStocks, valuations, financials, today);
  const industries = new Map(stockRows.map(row => [row.ts_code, normalizeIndustry(row.industry)]));
  const stockCloses = new Map(stockPrices.rows.map(row => [row.ts_code, row]));

  const companyRows = uniqueStocks.map(stock => {
    const cached = financials.get(stock.stk_code);
    const value = valuations.get(stock.stk_code) || {};
    const liveStock = tencent.get(String(stock.stk_code).split('.')[0]);
    return Object.assign({
      company: preferredSecurityName(liveStock, stock.stk_short_name),
      industry: industries.get(stock.stk_code) || '',
      has_cb: 1,
      financial_available: Boolean(cached && cached.data),
      market_cap: finite(value.total_mv) == null ? null : finite(value.total_mv) * 10000,
    }, cached ? cached.data : {});
  });

  const bondRows = tradableBasics.map(bond => {
    const daily = bondQuotes.get(bond.ts_code) || {};
    const valuation = valuations.get(bond.stk_code) || {};
    const liveBond = tencent.get(String(bond.ts_code).split('.')[0]);
    const liveStock = tencent.get(String(bond.stk_code).split('.')[0]);
    const dailyStock = stockCloses.get(bond.stk_code) || {};
    const close = finite(daily.close), conversionPrice = finite(bond.conv_price);
    const synchronizedBondPrice = liveBond && liveStock ? finite(liveBond.price) : close;
    const synchronizedStockPrice = liveBond && liveStock ? finite(liveStock.price) : finite(dailyStock.close);
    const conversionValue = synchronizedStockPrice != null && conversionPrice > 0
      ? synchronizedStockPrice / conversionPrice * 100 : null;
    const premium = synchronizedBondPrice != null && conversionValue > 0
      ? (synchronizedBondPrice / conversionValue - 1) * 100 : null;
    const peTtm = finite(valuation.pe_ttm), peStatic = finite(valuation.pe);
    const cachedFinancial = financials.get(bond.stk_code);
    const pb = finite(valuation.pb);
    const calculatedPb = derivePb(valuation.total_mv,
      cachedFinancial && cachedFinancial.data && cachedFinancial.data.shareholder_equity);
    return {
      bond_code: String(bond.ts_code),
      bond_name: preferredSecurityName(liveBond, bond.bond_short_name),
      stock_name: preferredSecurityName(liveStock, bond.stk_short_name),
      pe_ttm: peTtm != null ? peTtm : (peStatic != null ? peStatic : '亏损'),
      pb: pb != null ? pb : calculatedPb,
      dividend_yield: finite(valuation.dv_ttm) == null ? 0 : finite(valuation.dv_ttm),
      bond_price: liveBond ? liveBond.price : close,
      change_pct: liveBond ? liveBond.change : finite(daily.pct_chg),
      double_low: synchronizedBondPrice != null && premium != null ? synchronizedBondPrice + premium : null,
      convert_premium: premium,
      convert_price: conversionPrice,
      convert_value: conversionValue,
    };
  });

  return {
    companyRows,
    bondRows,
    sourceUpdatedAt: `${bondDaily.tradeDate.slice(0,4)}-${bondDaily.tradeDate.slice(4,6)}-${bondDaily.tradeDate.slice(6,8)}T15:00:00+08:00`,
  };
}

module.exports = {
  finite,
  derivePb,
  isActiveBond,
  preferredSecurityName,
  selectFinancialReport,
  FINANCIAL_REFRESH_BATCH_SIZE,
  nextFinancialBatchDelay,
  fetchTushareBondSafetySource,
};
