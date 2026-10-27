// 股票估值与财务口径的纯计算域（批次2b，从 stockAnalysis 逐字搬移）。
// 约束：无 SQL、无连接池、无 HTTP、无 req/res、无 DOM、无调度器。
// 输入是仓储已取好的标准事实；本文件不判断数据来自哪个 API。
const DAY = 86400000;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateText(value) {
  return String(value || '').replace(/-/g, '').slice(0, 8);
}

function isoDate(value) {
  const text = dateText(value);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : '';
}

function isoDateSafe(value) {
  if (value == null) return null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
}

// 与 services/market#tsDateStr 等价：UTC+8 后取日期，避免跨时区截日。
function tsDateStr(date) {
  const cn = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return '' + cn.getUTCFullYear() + p(cn.getUTCMonth() + 1) + p(cn.getUTCDate());
}

function yearsAgo(days) {
  return tsDateStr(new Date(Date.now() - days * DAY));
}

function selectLatestByPeriod(rows, today) {
  const map = new Map();
  rows.filter(row => row.end_date && dateText(row.f_ann_date || row.ann_date) <= today)
    .sort((a, b) => {
      const consolidated = (String(b.report_type) === '1' ? 1 : 0) - (String(a.report_type) === '1' ? 1 : 0);
      return consolidated || String(b.f_ann_date || b.ann_date || '').localeCompare(String(a.f_ann_date || a.ann_date || ''));
    }).forEach(row => { if (!map.has(row.end_date)) map.set(row.end_date, row); });
  return map;
}

function signedRatio(numerator, denominator) {
  const a = finite(numerator), b = finite(denominator);
  return a == null || b == null || b === 0 ? null : a / b;
}

function growthMetric(start, end, years) {
  const a = finite(start), b = finite(end);
  if (a == null || b == null || a === 0) return { value: null, method: a === 0 ? '起点为0，无法计算' : '数据不足' };
  if (a > 0 && b > 0) return { value: Math.pow(b / a, 1 / years) - 1, method: 'CAGR' };
  return { value: (b - a) / Math.abs(a), method: '带符号变化率，非CAGR' };
}

function threeYearAverageGrowth(start, end) {
  const a = finite(start), b = finite(end);
  if (a == null || b == null || a === 0) return { value: null, method: a === 0 ? '早期三年均值为0，无法计算' : '数据不足' };
  return { value: (b - a) / a, method: '（近期三年均值－十年前三年均值）÷十年前三年均值' };
}

function valuationComparator(mode) {
  if (mode !== 'pe') return (a, b) => a - b;
  return (a, b) => {
    const aNegative = a < 0, bNegative = b < 0;
    if (aNegative !== bNegative) return aNegative ? 1 : -1;
    return a - b;
  };
}

function valuationSamples(values, mode) {
  return values.map(finite).filter(v => v != null && (mode === 'pe' ? v !== 0 : v > 0)).sort(valuationComparator(mode));
}

function percentile(current, values, mode) {
  const valid = valuationSamples(values, mode);
  const c = finite(current);
  const currentValid = c != null && (mode === 'pe' ? c !== 0 : c > 0);
  if (!currentValid) return { value: null, samples: valid.length, reason: '当前值无效，不参与估值分位点计算' };
  if (!valid.length) return { value: null, samples: 0, reason: '没有有效样本' };
  if (valid.length === 1) return { value: 0, samples: 1, reason: '' };
  const compare = valuationComparator(mode);
  const rank = valid.filter(v => compare(v, c) < 0).length;
  return { value: Math.max(0, Math.min(1, rank / (valid.length - 1))), samples: valid.length, reason: '' };
}

function selectDividendPlans(rows) {
  const valid = (rows || []).filter(row => Math.max(finite(row.cash_div_tax) || 0, finite(row.cash_div) || 0) > 0);
  const stage = row => /实施/.test(String(row.div_proc || '')) ? 3 : /股东大会通过/.test(String(row.div_proc || '')) ? 2 : /预案/.test(String(row.div_proc || '')) ? 1 : 0;
  const map = new Map();
  valid.forEach(row => {
    const key = String(row.end_date || '');
    if (!key) return;
    const current = map.get(key);
    if (!current || stage(row) > stage(current) || (stage(row) === stage(current) && String(row.ann_date || '') > String(current.ann_date || ''))) map.set(key, row);
  });
  return [...map.values()];
}

function quantile(values, ratio, mode) {
  const valid = valuationSamples(values, mode);
  if (!valid.length) return null;
  const index = Math.max(0, Math.min(valid.length - 1, Math.floor((valid.length - 1) * ratio)));
  return valid[index];
}

function average(values) {
  const rows = values.map(finite).filter(v => v != null);
  return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : null;
}

function latestAnnualRows(map) {
  return [...map.values()].filter(row => String(row.end_date).endsWith('1231')).sort((a, b) => b.end_date.localeCompare(a.end_date));
}

function ttmValue(map, field) {
  const rows = [...map.values()].sort((a, b) => b.end_date.localeCompare(a.end_date));
  const latest = rows[0];
  if (!latest) return null;
  if (latest.end_date.endsWith('1231')) return finite(latest[field]);
  const year = Number(latest.end_date.slice(0, 4));
  const annual = map.get(`${year - 1}1231`), prior = map.get(`${year - 1}${latest.end_date.slice(4)}`);
  const values = [latest, annual, prior].map(row => row && finite(row[field]));
  return values.every(v => v != null) ? values[0] + values[1] - values[2] : null;
}

function financialAverage(rows, field, count) {
  return average(rows.slice(0, count).map(row => row[field]));
}

/**
 * 由标准事实构造股票分析结果。纯计算：不取数、不写库。
 * @param {object} data 仓储返回的分析输入（meta/income/balance/cashflow/indicators/dividends/forecasts/valuations/events）
 * @param {{today: string, rawQuote?: object|null}} options today 为 YYYYMMDD 业务日期；rawQuote 由编排层按需取数后传入
 */
function buildAnalysis(data, options = {}) {
  const today = options.today;
  const rawQuote = options.rawQuote || null;
  if (!data.meta || !data.income.length) throw new Error('股票尚未完成财务建档');
  const incomeMap = selectLatestByPeriod(data.income, today);
  const balanceMap = selectLatestByPeriod(data.balance, today);
  const indicatorMap = selectLatestByPeriod(data.indicators, today);
  const cashMap = selectLatestByPeriod(data.cashflow, today);
  const annualIncome = latestAnnualRows(incomeMap), annualCash = latestAnnualRows(cashMap);
  const annualBalance = latestAnnualRows(balanceMap);
  const latestIncome = [...incomeMap.values()].sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
  const latestBalance = balanceMap.get(latestIncome && latestIncome.end_date) || [...balanceMap.values()].sort((a, b) => b.end_date.localeCompare(a.end_date))[0] || {};
  const latestIndicator = indicatorMap.get(latestBalance.end_date) || [...indicatorMap.values()].sort((a, b) => b.end_date.localeCompare(a.end_date))[0] || {};
  const latestValuation = data.valuations[data.valuations.length - 1] || {};
  // 腾讯旧缓存（上游失败保留）不能当实时行情：只有报价时间是当天，才算有效实时报价
  const liveQuote = rawQuote && isoDateSafe(rawQuote.quote_time) === isoDate(today) ? rawQuote : null;
  const quote = liveQuote;
  const currentPrice = finite(liveQuote && liveQuote.price) || finite(latestValuation.close);
  const totalShare = finite(latestValuation.total_share);
  const marketCap = currentPrice != null && totalShare != null ? currentPrice * totalShare * 10000 : finite(latestValuation.total_mv) == null ? null : finite(latestValuation.total_mv) * 10000;
  const floatShare = finite(latestValuation.float_share), freeShare = finite(latestValuation.free_share);
  const circulatingMarketCap = currentPrice != null && floatShare != null ? currentPrice * floatShare * 10000 : finite(latestValuation.circ_mv) == null ? null : finite(latestValuation.circ_mv) * 10000;
  const freeFloatMarketCap = currentPrice != null && freeShare != null ? currentPrice * freeShare * 10000 : null;
  const ttmProfit = ttmValue(incomeMap, 'n_income_attr_p');
  const staticProfit = annualIncome[0] && finite(annualIncome[0].n_income_attr_p);
  const avg3Profit = average(annualIncome.slice(0, 3).map(row => row.n_income_attr_p));
  const forecast = data.forecasts.filter(row => dateText(row.ann_date) <= today).sort((a, b) => String(b.ann_date).localeCompare(String(a.ann_date)))[0];
  let forecastProfit = forecast ? average([forecast.net_profit_min, forecast.net_profit_max]) : null;
  if (forecastProfit == null && forecast && finite(forecast.last_parent_net) != null) {
    const pct = average([forecast.p_change_min, forecast.p_change_max]);
    if (pct != null) forecastProfit = finite(forecast.last_parent_net) * (1 + pct / 100);
  }
  // Tushare forecast 的利润金额单位为万元；三张财报金额单位为元，计算前统一为元。
  if (forecastProfit != null) forecastProfit *= 10000;
  const equity = finite(latestBalance.total_hldr_eqy_exc_min_int), goodwill = finite(latestBalance.goodwill) || 0;
  const officialRoa = finite(indicatorMap.get(annualIncome[0]?.end_date)?.roa);
  const averageAnnualAssets = average([annualBalance[0]?.total_assets, annualBalance[1]?.total_assets]);
  const calculatedRoa = officialRoa == null && staticProfit != null && averageAnnualAssets ? staticProfit / averageAnnualAssets * 100 : officialRoa;
  const chartValuations = data.valuations.filter(row => row.trade_date >= yearsAgo(10958));
  const positiveValuations = chartValuations.filter(row => row.trade_date >= yearsAgo(3653));
  const latestFactor = finite(latestValuation.adj_factor);
  const qfqPrices = positiveValuations.map(row => {
    const close = finite(row.close), factor = finite(row.adj_factor);
    return close != null && factor != null && latestFactor ? close * factor / latestFactor : close;
  });
  const chartQfqPrices = chartValuations.map(row => { const close = finite(row.close), factor = finite(row.adj_factor); return close != null && factor != null && latestFactor ? close * factor / latestFactor : close; });
  const valuationHistory = chartValuations.map((row, index) => ({ date: isoDate(row.trade_date), price: finite(chartQfqPrices[index]), pe: finite(row.pe_ttm), pb: finite(row.pb) })).filter((row, index) => index % 5 === 0 || index === chartValuations.length - 1);
  const percentileBands = { price: [.2, .5, .8].map(x => quantile(qfqPrices, x)), pe: [.2, .5, .8].map(x => quantile(positiveValuations.map(row => row.pe_ttm), x, 'pe')), pb: [.2, .5, .8].map(x => quantile(positiveValuations.map(row => row.pb), x)) };
  const earliestValuation = data.valuations.find(row => finite(row.close) != null && finite(row.adj_factor) != null);
  const earliestAdjustedPrice = earliestValuation && latestFactor ? finite(earliestValuation.close) * finite(earliestValuation.adj_factor) / latestFactor : null;
  const listedDays = earliestValuation ? Math.max(1, (Date.now() - new Date(`${isoDate(earliestValuation.trade_date)}T00:00:00+08:00`).getTime()) / DAY) : null;
  const annualizedSinceListing = earliestAdjustedPrice > 0 && currentPrice > 0 && listedDays > 0 ? Math.pow(currentPrice / earliestAdjustedPrice, 365.25 / listedDays) - 1 : null;
  const peTtm = signedRatio(marketCap, ttmProfit), peStatic = signedRatio(marketCap, staticProfit), peAvg3 = signedRatio(marketCap, avg3Profit);
  const pb = signedRatio(marketCap, equity), pbExGoodwill = signedRatio(marketCap, equity == null ? null : equity - goodwill);
  const displayDividends = selectDividendPlans(data.dividends);
  function sharesAt(date) {
    const target = dateText(date);
    for (let i = data.valuations.length - 1; i >= 0; i--) if (data.valuations[i].trade_date <= target && finite(data.valuations[i].total_share) != null) return finite(data.valuations[i].total_share);
    return null;
  }
  const dividendItem = row => ({ row, cashPerShare: finite(row.cash_div_tax) != null ? finite(row.cash_div_tax) : finite(row.cash_div), amount: (() => { const shares = sharesAt(row.ex_date || row.pay_date || row.ann_date) || finite(row.base_share); const cash = finite(row.cash_div_tax) != null ? finite(row.cash_div_tax) : finite(row.cash_div); return shares == null || cash == null ? null : cash * shares * 10000; })() });
  const actualDividendRows = displayDividends.filter(row => /实施/.test(String(row.div_proc || ''))).map(dividendItem);
  const dividendRows = displayDividends.map(dividendItem);
  const oneYearAgo = yearsAgo(365);
  const dividend12m = actualDividendRows.filter(item => dateText(item.row.ex_date || item.row.pay_date) >= oneYearAgo).reduce((sum, item) => sum + (item.amount || 0), 0);
  const latestAnnualYear = annualIncome[0] ? annualIncome[0].end_date.slice(0, 4) : '';
  const annualDividend = dividendRows.filter(item => String(item.row.end_date || '').startsWith(latestAnnualYear)).reduce((sum, item) => sum + (item.amount || 0), 0);
  const cumulativeDividend = actualDividendRows.reduce((sum, item) => sum + (item.amount || 0), 0);
  const cumulativeProfit = annualIncome.reduce((sum, row) => sum + (finite(row.n_income_attr_p) || 0), 0);
  const cumulativePayoutRatio = signedRatio(cumulativeDividend, cumulativeProfit);
  const ttmEarningsYield = signedRatio(ttmProfit, marketCap);
  const averageDividendYield = cumulativePayoutRatio == null || ttmEarningsYield == null ? null : cumulativePayoutRatio * ttmEarningsYield;
  const dividendByYear = new Map();
  dividendRows.forEach(item => {
    const year = String(item.row.end_date || '').slice(0, 4);
    if (year && item.amount != null) dividendByYear.set(year, (dividendByYear.get(year) || 0) + item.amount);
  });
  const years = annualIncome.map(row => {
    const year = row.end_date.slice(0, 4), profit = finite(row.n_income_attr_p);
    const dividend = dividendByYear.has(year) ? dividendByYear.get(year) : 0;
    const dividend_details = dividendRows.filter(item => String(item.row.end_date || '').slice(0, 4) === year).map(item => ({
      ann_date: dateText(item.row.ann_date || item.row.imp_ann_date), ex_date: dateText(item.row.ex_date), pay_date: dateText(item.row.pay_date),
      cash_div: item.cashPerShare, amount: item.amount, div_proc: item.row.div_proc || '',
    })).sort((a, b) => String(a.ex_date || a.pay_date || a.ann_date).localeCompare(String(b.ex_date || b.pay_date || b.ann_date)));
    return { year, report_ann_date: dateText(row.f_ann_date || row.ann_date), profit, dividend, dividend_details, payout_ratio: signedRatio(dividend, profit) };
  });
  const dividendYears = new Set(displayDividends.filter(row => (finite(row.cash_div_tax) || finite(row.cash_div) || 0) > 0).map(row => String(row.end_date || '').slice(0, 4)));
  const stabilityYears = years.slice(0, 10);
  const noProfitYears = stabilityYears.filter(row => row.profit == null || row.profit <= 0).map(row => row.year);
  const noDividendYears = stabilityYears.filter(row => !dividendYears.has(row.year)).map(row => row.year);
  const reasonYear = noProfitYears.length === 1 ? noProfitYears[0] : (noDividendYears.length === 1 ? noDividendYears[0] : '');
  const reasonEvent = reasonYear ? data.events.find(row => row.is_official &&
    (String(row.title || '').includes(`${reasonYear}年`) || String(row.title || '').includes('年度报告') || String(row.title || '').includes('利润分配'))) : null;
  const growths = {};
  [3, 5, 10].forEach(n => {
    const end = annualIncome[0], start = annualIncome[n];
    growths[n] = {
      parent: growthMetric(start && start.n_income_attr_p, end && end.n_income_attr_p, n),
      deducted: growthMetric(start && indicatorMap.get(start.end_date)?.profit_dedt, end && indicatorMap.get(end.end_date)?.profit_dedt, n),
    };
  });
  const lateAvg = average(annualIncome.slice(0, 3).map(row => row.n_income_attr_p));
  const earlyAvg = average(annualIncome.slice(10, 13).map(row => row.n_income_attr_p));
  const interim = latestIncome && !latestIncome.end_date.endsWith('1231') ? latestIncome : null;
  const priorInterim = interim ? incomeMap.get(`${Number(interim.end_date.slice(0, 4)) - 1}${interim.end_date.slice(4)}`) : null;
  const latestCash = annualCash[0] || {};
  const freeCash = row => {
    const operating = finite(row.n_cashflow_act), capex = finite(row.c_pay_acq_const_fiolta);
    return operating == null || capex == null ? null : operating - capex;
  };
  const interestDebt = finite(latestIndicator.interestdebt) != null ? finite(latestIndicator.interestdebt) :
    ['st_borr', 'lt_borr', 'bond_payable', 'non_cur_liab_due_1y'].reduce((sum, key) => sum + (finite(latestBalance[key]) || 0), 0);
  const interestExpense = finite(latestIncome.fin_exp_int_exp) != null ? finite(latestIncome.fin_exp_int_exp) : finite(latestIncome.int_exp);
  const interestCoverage = finite(latestIndicator.ebit_to_interest) != null ? finite(latestIndicator.ebit_to_interest) : signedRatio(finite(latestIncome.ebit), interestExpense);
  const financialIndustry = /银行|保险|证券|多元金融/.test(String(data.meta.industry || ''));
  return {
    ts_code: data.meta.ts_code, name: data.meta.name, industry: data.meta.industry, list_date: data.meta.list_date,
    industry_info: { name: data.meta.industry, system: data.meta.data?.industry_system || 'Tushare基础行业', level: data.meta.data?.industry_level || '未标注级别', path: data.meta.data?.industry_path || [] },
    actual_controller: data.meta.data?.actual_controller || { name: '', type: '', source: '' },
    latest_report: { end_date: latestIncome?.end_date || '', ann_date: dateText(latestIncome?.f_ann_date || latestIncome?.ann_date), type: latestIncome?.end_date?.endsWith('1231') ? '年报' : (latestIncome?.end_date?.endsWith('0630') ? '半年报' : '季报') },
    performance_forecast: forecast ? { ann_date: dateText(forecast.ann_date), end_date: dateText(forecast.end_date), type: forecast.type || '', profit_min: finite(forecast.net_profit_min) == null ? null : finite(forecast.net_profit_min) * 10000, profit_max: finite(forecast.net_profit_max) == null ? null : finite(forecast.net_profit_max) * 10000, change_min: finite(forecast.p_change_min), change_max: finite(forecast.p_change_max), summary: forecast.summary || '' } : null,
    as_of: isoDate(today), latest_market_trade_date: isoDate(latestValuation && latestValuation.trade_date) || null, quote: { price: currentPrice, currency: 'CNY', currency_name: '人民币', unit: '元', quote_time: quote && quote.quote_time, source: quote ? 'tencent' : 'tushare_close' },
    valuation: {
      market_cap: marketCap, a_share_market_cap: marketCap, circulating_market_cap: circulatingMarketCap, free_float_market_cap: freeFloatMarketCap,
      annualized_return_since_listing: annualizedSinceListing, return_start_date: earliestValuation?.trade_date || '',
      pe_ttm: peTtm, pe_static: peStatic, pe_forecast: signedRatio(marketCap, forecastProfit), pe_three_year_avg: peAvg3,
      pb, pb_ex_goodwill: pbExGoodwill, dividend_yield: signedRatio(dividend12m, marketCap), payout_ratio: signedRatio(annualDividend, staticProfit),
      cumulative_payout_ratio: cumulativePayoutRatio, average_dividend_yield: averageDividendYield,
      cumulative_dividend: cumulativeDividend, cumulative_profit: cumulativeProfit,
      roe: finite(indicatorMap.get(annualIncome[0]?.end_date)?.roe), roa: calculatedRoa,
      roa_source: officialRoa == null && calculatedRoa != null ? '归母净利润 ÷ 平均总资产（补算）' : 'Tushare财务指标',
    },
    stability: { years, dividend_history: dividendRows.map(item => {
      const year = String(item.row.end_date || '').slice(0, 4);
      const profitRow = annualIncome.find(row => row.end_date.slice(0, 4) === year);
      const profit = profitRow ? finite(profitRow.n_income_attr_p) : null;
      const yearDividend = dividendByYear.get(year) || 0;
      return { year, end_date: dateText(item.row.end_date), ann_date: dateText(item.row.ann_date || item.row.imp_ann_date), record_date: dateText(item.row.record_date),
        ex_date: dateText(item.row.ex_date), div_proc: item.row.div_proc, stk_bo_rate: finite(item.row.stk_bo_rate),
        stk_co_rate: finite(item.row.stk_co_rate), stk_div: finite(item.row.stk_div), cash_div: item.cashPerShare,
        amount: item.amount, profit, payout_ratio: signedRatio(item.amount, profit), annual_payout_ratio: signedRatio(yearDividend, profit) };
    }).sort((a, b) => String(b.ann_date || b.ex_date).localeCompare(String(a.ann_date || a.ex_date))), profitable_each_year: noProfitYears.length === 0, no_profit_years: noProfitYears,
      dividend_each_year: noDividendYears.length === 0, no_dividend_years: noDividendYears,
      reason: reasonYear ? '待人工核实，请查看对应年度公告' : '', reason_url: reasonEvent ? reasonEvent.url : '' },
    percentiles: {
      price: percentile(currentPrice, qfqPrices), pe: percentile(peTtm, positiveValuations.map(row => row.pe_ttm), 'pe'), pb: percentile(pb, positiveValuations.map(row => row.pb)),
      history: valuationHistory, bands: percentileBands, current: { price: currentPrice, pe: peTtm, pb },
      note: '分位点曲线从所选起始日开始累计计算，每个日期只使用该日及之前的有效样本。当前分位＝（当前排名－1）÷（有效样本数－1），最低为0%，最高为100%。股价使用前复权价格；PE正数从小到大排在前，负数按-100、-80……-5的顺序排在后。',
    },
    growth: { ten_year_average: Object.assign(threeYearAverageGrowth(earlyAvg, lateAvg), { early_average: earlyAvg, late_average: lateAvg }), periods: growths,
      latest_interim_yoy: interim && priorInterim ? { end_date: interim.end_date,
        parent: signedRatio(finite(interim.n_income_attr_p) - finite(priorInterim.n_income_attr_p), Math.abs(finite(priorInterim.n_income_attr_p))),
        deducted: signedRatio(finite(indicatorMap.get(interim.end_date)?.profit_dedt) - finite(indicatorMap.get(priorInterim.end_date)?.profit_dedt), Math.abs(finite(indicatorMap.get(priorInterim.end_date)?.profit_dedt)))} : null },
    safety: { net_cash: (finite(latestBalance.money_cap) || 0) + (finite(latestBalance.trad_asset) || 0) - interestDebt,
      interest_coverage: interestCoverage, market_cap_to_liability: signedRatio(marketCap, finite(latestBalance.total_liab)),
      report_end_date: latestBalance.end_date, industry_note: financialIndustry ? '金融企业负债结构与普通企业不可直接比较' : '' },
    cashflow: { latest_year: { end_date: latestCash.end_date, operating: finite(latestCash.n_cashflow_act), free: freeCash(latestCash) },
      average_3y: { operating: financialAverage(annualCash, 'n_cashflow_act', 3), free: average(annualCash.slice(0, 3).map(freeCash)) },
      average_5y: { operating: financialAverage(annualCash, 'n_cashflow_act', 5), free: average(annualCash.slice(0, 5).map(freeCash)) } },
    events: data.events.map(row => Object.assign({}, row, { event_date: isoDate(row.event_date) })),
    data_quality: { income_rows: data.income.length, balance_rows: data.balance.length, cashflow_rows: data.cashflow.length,
      valuation_rows: data.valuations.length, research_notice: '金融数据仅供研究，交易决策前请独立核验。' },
  };
}

module.exports = {
  DAY,
  average,
  buildAnalysis,
  dateText,
  financialAverage,
  finite,
  growthMetric,
  isoDate,
  isoDateSafe,
  latestAnnualRows,
  percentile,
  quantile,
  selectDividendPlans,
  selectLatestByPeriod,
  signedRatio,
  threeYearAverageGrowth,
  tsDateStr,
  ttmValue,
  valuationComparator,
  valuationSamples,
  yearsAgo,
};
