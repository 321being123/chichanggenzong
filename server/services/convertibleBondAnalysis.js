// convertibleBondAnalysis.js —— R-10 拆分后主入口（2026-10-21）：函数体按域放在 ./convertibleBondAnalysis*.js，
// 本文件只做编排与再导出；module.exports 与拆分前完全一致，调用方零改动。
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const {coversDocument}=require('./convertibleBondAnalysisFallback');
const { tushareQuery, tsRows, tsDateStr } = require('./market');
const path = require('path');
const { evaluateConvertibleBondFreshness, CONV_PRICE_EPS } = require('./analysisFreshness');
const { datasetScope, getDatasetCursors, isDatasetFresh, markDatasetSuccess,
  recordQualityIssue, resolveQualityIssue } = require('./datasetCursors');
const { getLatestCallState } = require('./convertibleBondRedemptionService');
const { ANNOUNCEMENT_OVERLAP_DAYS, DAILY_FIELDS, FORMULA_VERSION, accruedPutPrice, addDays, addYears, annualizedRedemptionYield, annualizedVolatility, blackScholesConvertible, cashflowsToDate, couponRowsFromClause, creditDiscountRate, currentInterestYear, currentPutPeriod, derivedDividendYield, earliestPutDate, estimatePutTimeline, fallbackPe, finite, futureTradeCalendar, hasNetAssetFloorClause, instrumentStatus, isoDate, nextPutPeriod, normalizeBondCode, normalizePriceChange, normalizePriceChanges, parseCouponRates, parseMoney, parseTriggerRatio, parseWindow, presentValue, pricePairFromReason, putOpportunityState, remainingYears, resetWindowState, revisionDecision, simplifyClause, termsHash, triggerProgress, yieldToMaturity, yuanToHundredMillion } = require('./convertibleBondAnalysisCore.js');
const { announcementSourceKey, backfillMissingRatings, ensureStockUniverse, extractNoRevisionPeriods, extractPriceChangeDetails, incrementalStart, isFullReport, latestFinancial, latestFullReport, latestProspectus, loadCachedAnalysisHistory, loadCachedStockValuations, loadExtraData, loadNoRevisionCache, loadPriceChangeCache, loadProspectusCache, loadSafety, loadTrackedDelistedStocks, mergeDailyRows, pythonCandidates, reportPeriod, revisionEventDecision, savePriceChanges, saveProspectusDetails, saveRatingHistory, saveRatingOutlooks, saveReportFundHolding, saveRevisionEvents, sourceIds, syncTrackedStockLifecycle } = require('./convertibleBondAnalysisStore.js');
const { activeProfile, addTradingDays, announcementDateWindows, backfillBondFirstDayPerformance, backfillBondIssueResults, backfillBondListingLiquidity, backfillCycleGaps, backfillUnderlyingStockMarket, bondGapQueueHash, buildBondGapQueue, classifyBondObjectStatus, collectConvertibleBondAnnouncementMarket, fetchTargetedBondDaily, getRecentOpenDays, isTencentBondWindow, isUnderlyingStockListed, latestFullBondDaily, latestTradeDates, readBondGapQueue, relevantConvertibleBondAnnouncements, resolveConvertibleBondSymbolicLocks, saveAnnouncementHistories, syncConvertibleBondAnnouncementHistories, syncConvertibleBondUniverse, syncConvertibleBondUniverseWithBackfill, writeBondGapQueue } = require('./convertibleBondAnalysisSync.js');

// Detailed analysis uses the same calculation for manual refresh and the existing daily chain.
// This path reads standard facts only; missing source facts belong to the announcement/input Runner.
async function buildConvertibleBondAnalysisFromDatabase(tsCode, requestedDate, options = {}) {
  const { rows } = await pool.query(
    `SELECT p.*,i.canonical_code,s.canonical_code AS stock_code,s.name AS stock_name,
            i.delist_date::text AS instrument_delist_date
       FROM fundamental.convertible_bond_profiles p
       JOIN core.instruments i USING(instrument_id)
       LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      WHERE i.canonical_code=$1`, [tsCode]);
  const row = rows[0];
  if (!row || !row.stock_code) throw new Error('缺少可转债或正股标准档案');
  const { rows: dates } = await pool.query(
    `SELECT MAX(trade_date)::text AS date FROM market.convertible_bond_daily_metrics WHERE instrument_id=$1`,
    [row.instrument_id]);
  const targetDate = isoDate(requestedDate) || dates[0]?.date;
  if (!targetDate || dates[0]?.date !== targetDate) throw new Error('目标交易日缺少可转债行情，保留上一份分析');
  const start = isoDate(addDays(new Date(`${targetDate}T00:00:00+08:00`), -500));
  const cached = await loadCachedAnalysisHistory(tsCode, start);
  const stockCode = row.stock_code;
  const [valuations, financialRows, calendar, prospectusCache, priceChangeCache, noRevisionCache] = await Promise.all([
    loadCachedStockValuations(stockCode, start),
    pool.query(`SELECT r.report_kind,r.period_end::text,r.raw_payload FROM fundamental.financial_reports r
      JOIN core.company_instruments ci ON ci.company_id=r.company_id
      WHERE ci.instrument_id=$1 AND r.announced_at<=$2::date AND r.period_end<=$2::date
      ORDER BY r.period_end DESC,r.announced_at DESC`, [row.stock_instrument_id,targetDate]),
    pool.query(`SELECT trade_date::text AS cal_date,CASE WHEN is_open THEN '1' ELSE '0' END AS is_open FROM market.trade_calendar
      WHERE exchange='SSE' AND trade_date>=$1::date ORDER BY trade_date`, [targetDate]),
    loadProspectusCache(tsCode),loadPriceChangeCache(tsCode),loadNoRevisionCache(tsCode),
  ]);
  const profile = { ...(row.raw_payload || {}), ts_code:tsCode,stk_code:stockCode,
    stk_short_name:row.stock_name,bond_short_name:row.bond_short_name,
    conv_price:row.current_conv_price,remain_size:row.remain_size,issue_size:row.issue_size,rating_comp:row.rating_company,
    fundraising_purpose:row.fundraising_purpose,prospectus_source_url:prospectusCache.source_url,
    delist_date:row.instrument_delist_date,source_updated_at:row.source_updated_at,updated_at:row.updated_at };
  for (const key of ['value_date','maturity_date','conv_start_date','conv_end_date','rate_clause','coupon_rate',
    'maturity_call_price','issue_rating','newest_rating','guarantor','guarantee_type']) {
    if (row[key] != null) profile[key] = key.endsWith('_date') ? isoDate(row[key]) : row[key];
  }
  const bondDaily = cached.bondDaily.filter(bar => isoDate(bar.trade_date)<=targetDate);
  const stockDaily = cached.stockDaily.filter(bar => isoDate(bar.trade_date)<=targetDate);
  if (!stockDaily.length) throw new Error('缺少正股标准行情，保留上一份分析');
  const marketEvidence=await require('../jobs/stockAnalysisRefresh').verifiedStockDataDate(stockCode,isoDate(stockDaily[0].trade_date),targetDate);
  if(marketEvidence.dataAsOf!==targetDate)throw new Error('目标日正股行情缺失且无完整停牌证据');
  const reports = kind => financialRows.rows.filter(r=>r.report_kind===kind).map(r=>({...r.raw_payload,end_date:r.period_end}));
  const balances = reports('balance');
  const putPeriod = currentPutPeriod(profile.maturity_date,profile.put_clause,targetDate);
  const { rows: putEvents } = await pool.query(`SELECT e.event_date::text,e.title,e.details FROM event.company_events e
    JOIN core.company_instruments ci ON ci.company_id=e.company_id
    WHERE ci.instrument_id=$1 AND e.event_date<=$2::date AND e.title LIKE '%回售%'`, [row.stock_instrument_id,targetDate]);
  const putOpportunity = putOpportunityState(putEvents.map(e=>({...e.details,title:e.title,event_date:e.event_date})),putPeriod.period_start,putPeriod.period_end);
  return assembleConvertibleBondAnalysis({ tsCode,stockCode,profile,ids:{bondId:row.instrument_id,stockId:row.stock_instrument_id},
    bondDaily,stockDaily,valuations:valuations.filter(v=>isoDate(v.trade_date)<=targetDate),balances,
    incomeRows:reports('income'),dividendRows:[],liveQuotes:new Map(),putPeriod,putOpportunity,
    futureCalendarData:calendar.rows,prospectusCache,priceChangeDetails:priceChangeCache,
    priceChangeCache,reportPriceHistory:null,targetDate,persist:options.persist!==false });
}

async function refreshConvertibleBondAnalysis(value, reason = 'manual', options = {}) {
  const tsCode = normalizeBondCode(value);
  if (!tsCode) throw new Error('请输入有效的可转债代码');
  return buildConvertibleBondAnalysisFromDatabase(tsCode, options.targetDate);
}

async function assembleConvertibleBondAnalysis({ tsCode, stockCode, profile, ids, bondDaily, stockDaily, valuations, balances, incomeRows, dividendRows, liveQuotes, putPeriod, putOpportunity, futureCalendarData, prospectusCache, priceChangeDetails, priceChangeCache, reportPriceHistory, targetDate,persist=true }) {
  const latestBond = bondDaily[0], latestStock = stockDaily[0], valuation = valuations[0] || {};
  const end = tsDateStr(new Date(`${targetDate}T00:00:00+08:00`));
  const code = tsCode.slice(0,6), stockShortCode = stockCode.slice(0,6);
  const latestCallState = await getLatestCallState(ids.bondId);
  const unifiedCallState = latestCallState && isoDate(latestCallState.trade_date) === targetDate ? latestCallState : null;
  const liveBond = liveQuotes.get(code), liveStock = liveQuotes.get(stockShortCode);
  // 同口径校验：转债与正股实时行情必须同属一个交易日，否则整组退回同一交易日收盘数据
  const quoteDay = (quote) => (quote && quote.quote_time ? String(quote.quote_time).slice(0, 10) : null);
  const bondQuoteDay = quoteDay(liveBond), stockQuoteDay = quoteDay(liveStock);
  const todayStr = isoDate(new Date());
  const bothLivePriced = Boolean(liveBond && liveStock && finite(liveBond.price) > 0 && finite(liveStock.price) > 0);
  const quotePairMismatched = bothLivePriced && Boolean(bondQuoteDay && stockQuoteDay && bondQuoteDay !== stockQuoteDay);
  // 仅当债券与正股实时报价都来自今天（最新交易日）才视为实时同步；
  // 两者同为历史缓存日期（如周末/休市未更新）时一律退回收盘，避免过期缓存被误标为腾讯实时行情
  const bothFreshToday = bothLivePriced && bondQuoteDay === todayStr && stockQuoteDay === todayStr;
  const synchronizedLive = bothFreshToday && !quotePairMismatched;
  if (quotePairMismatched) {
    await recordQualityIssue({
      instrumentId: ids.bondId, datasetCode: 'live_quote', fieldCode: 'quote_time', issueType: 'quote_pair_unsynchronized',
      details: { bond_quote_date: bondQuoteDay, stock_quote_date: stockQuoteDay, fallback: 'tushare_close' },
    });
  } else if (bothLivePriced) {
    await resolveQualityIssue({ instrumentId: ids.bondId, datasetCode: 'live_quote', fieldCode: 'quote_time', issueType: 'quote_pair_unsynchronized' });
  }
  const bondPrice = synchronizedLive ? finite(liveBond.price) : finite(latestBond.close);
  const stockPrice = synchronizedLive ? finite(liveStock.price) : finite(latestStock && latestStock.close);
  const convPrice = finite(profile.conv_price);
  const convValue = stockPrice != null && convPrice > 0 ? stockPrice / convPrice * 100 : finite(latestBond.cb_value);
  const convPremium = bondPrice != null && convValue > 0 ? (bondPrice / convValue - 1) : (finite(latestBond.cb_over_rate) == null ? null : finite(latestBond.cb_over_rate) / 100);
  const remainSizeYuan = finite(profile.remain_size), marketCap = finite(valuation.total_mv) == null ? null : finite(valuation.total_mv) * 10000;
  const safety = await loadSafety(code);
  const cachedFinancial = await latestFinancial(stockCode);
  const financial = isoDate(cachedFinancial.ann_date)&&isoDate(cachedFinancial.ann_date)<=targetDate ? cachedFinancial : {};
  const extras = await loadExtraData(ids.bondId,targetDate);
  if (!extras.coupons.length) extras.coupons = couponRowsFromClause(profile.rate_clause).map((r,index)=>({
    interest_year:index+1,coupon_rate:r.coupon_rate,pay_date:profile.value_date ? isoDate(addYears(new Date(`${isoDate(profile.value_date)}T00:00:00+08:00`),index+1)) : null,
    pre_tax_interest:r.coupon_rate,after_tax_interest:r.coupon_rate*0.8,source:'rate_clause',
  }));
  const termDetails = { call: simplifyClause('call', profile.call_clause), reset: simplifyClause('reset', profile.reset_clause), put: simplifyClause('put', profile.put_clause) };
  const targetPutPeriod = putOpportunity.used ? (nextPutPeriod(putPeriod, profile.maturity_date) || putPeriod) : putPeriod;
  const putStartDate = targetPutPeriod.period_start || targetPutPeriod.eligible_from;
  const putActive = targetPutPeriod.active && !putOpportunity.used;
  const {rows:revisionRows}=await pool.query(`SELECT trigger_price,matched_days,trigger_required_days,required_days,calculated_status,
    business_status,data_status,no_revision_valid_until::text,next_eligible_date::text
    FROM analytics.convertible_bond_revision_latest WHERE instrument_id=$1 AND trade_date=$2::date AND formula_version='reset-v2'`,[ids.bondId,targetDate]);
  const revisionState=revisionRows[0];
  const resetWindow = revisionState ? {active:!revisionState.next_eligible_date||revisionState.next_eligible_date<=targetDate,
    eligible_from:revisionState.next_eligible_date,valid_until:revisionState.no_revision_valid_until} : {active:null,eligible_from:null,valid_until:null};
  const triggerState = {
    call: unifiedCallState || {},
    reset: revisionState ? {trigger_price:finite(revisionState.trigger_price),matched_days:revisionState.matched_days,
      required_days:revisionState.trigger_required_days||revisionState.required_days,met:revisionState.calculated_status==='met'} : {
        trigger_price:termDetails.reset.ratio==null?null:convPrice*termDetails.reset.ratio,matched_days:null,required_days:termDetails.reset.required_days,met:false},
    put: triggerProgress(stockDaily, termDetails.put, convPrice, putActive, putStartDate),
  };
  // Detailed analysis cannot fabricate future open dates beyond the local exchange calendar.
  const futureTradeDates = [...new Set(futureCalendarData.filter(r=>String(r.is_open)==='1')
    .map(r=>isoDate(r.cal_date)).filter(Boolean))].sort();
  let putTimeline = estimatePutTimeline(stockDaily, termDetails.put, convPrice, putStartDate, futureTradeDates, stockPrice,targetDate);
  if (putTimeline?.trigger_date && putTimeline.trigger_date>isoDate(profile.maturity_date)) putTimeline = {
    ...putTimeline,status:'not_before_maturity',trigger_date:null,payment_date:null,remaining_days:null,
  };
  const maturityFinal = parseMoney(profile.maturity_call_price, 100 + (finite(profile.coupon_rate) || 0));
  const discountRate = creditDiscountRate(profile.newest_rating || profile.issue_rating);
  const interestYear = currentInterestYear(profile.value_date, profile.maturity_date, end);
  const marketPureBond = finite(latestBond.bond_value);
  const pureBond = marketPureBond != null ? marketPureBond
    : presentValue(cashflowsToDate(profile, extras.coupons, profile.maturity_date, false, maturityFinal, targetDate), discountRate);
  const optionValue = bondPrice != null && pureBond != null ? bondPrice - pureBond : null;
  const maturityPreTax = yieldToMaturity(bondPrice, cashflowsToDate(profile, extras.coupons, profile.maturity_date, false, maturityFinal, targetDate));
  const maturityAfterTax = yieldToMaturity(bondPrice, cashflowsToDate(profile, extras.coupons, profile.maturity_date, true, maturityFinal, targetDate));
  const estimatedPutDate = putTimeline && putTimeline.trigger_date;
  const estimatedPutPaymentDate = putTimeline && putTimeline.payment_date;
  const estimatedPutYears = remainingYears(estimatedPutDate, new Date(`${targetDate}T00:00:00+08:00`));
  const putYieldYears = remainingYears(estimatedPutPaymentDate, new Date(`${targetDate}T00:00:00+08:00`));
  const putFinal = accruedPutPrice(profile, extras.coupons, estimatedPutDate);
  const putPreTax = annualizedRedemptionYield(bondPrice, putFinal, putYieldYears);
  const putAfterTax = annualizedRedemptionYield(bondPrice, putFinal, putYieldYears, 0.2);
  const volatility = annualizedVolatility(stockDaily), riskFreeRate = finite(process.env.CB_RISK_FREE_RATE) == null ? 0.015 : finite(process.env.CB_RISK_FREE_RATE);
  const stockDividendYield = finite(valuation.dv_ttm) == null ? derivedDividendYield(dividendRows, stockPrice, end) : finite(valuation.dv_ttm) / 100;
  const dividendYield = stockDividendYield == null ? 0 : stockDividendYield;
  const latestBalance = balances[0] || {};
  const financialAssets = finite(latestBalance.total_assets) || finite(financial.total_assets);
  const financialLiabilities = finite(latestBalance.total_liab) == null ? finite(financial.total_liability) : finite(latestBalance.total_liab);
  const theoreticalOption = blackScholesConvertible(stockPrice, convPrice, remainingYears(profile.maturity_date, new Date(`${targetDate}T00:00:00+08:00`)), volatility, riskFreeRate, dividendYield);
  const theoreticalValue = pureBond != null && theoreticalOption != null ? pureBond + theoreticalOption : null;
  const calculatedPe = fallbackPe(valuation, marketCap, incomeRows);
  const fundHolding = extras.fund_holding ? Object.assign({}, extras.fund_holding, {
    holding_ratio: remainSizeYuan > 0 && finite(extras.fund_holding.holding_quantity) != null
      ? finite(extras.fund_holding.holding_quantity) * 1000000 / remainSizeYuan : null,
  }) : null;
  const analysis = {
    type: 'convertible_bond', ts_code: tsCode, code, name: profile.bond_short_name, stock_code: stockCode,
    stock_name: profile.stk_short_name, as_of: isoDate(latestBond.trade_date), refreshed_at: new Date().toISOString(),
    delist_date: isoDate(profile.delist_date),
    is_delisted: Boolean(profile.delist_date && isoDate(profile.delist_date) <= isoDate(new Date())),
    quote: { bond_price: bondPrice, bond_change_pct: synchronizedLive ? finite(liveBond.change) : finite(latestBond.pct_chg),
      stock_price: stockPrice, stock_change_pct: synchronizedLive ? finite(liveStock.change) : null,
      quote_time: synchronizedLive ? liveBond.quote_time : `${isoDate(latestBond.trade_date)}T15:00:00+08:00`,
      source: synchronizedLive ? 'tencent' : 'tushare_close', synchronized: !quotePairMismatched },
    basic: {
      convert_price: convPrice, convert_value: convValue, convert_premium: convPremium,
      call_trigger_price: unifiedCallState && unifiedCallState.trigger_price,
      call_status: unifiedCallState && unifiedCallState.business_status,
      call_data_status: unifiedCallState && unifiedCallState.data_status,
      call_trade_date: unifiedCallState && isoDate(unifiedCallState.trade_date),
      call_trigger_day_count: unifiedCallState && unifiedCallState.matched_days,
      call_remaining_days: unifiedCallState && unifiedCallState.remaining_days,
      call_announcement: unifiedCallState && unifiedCallState.announcement_title,
      reset_trigger_price: triggerState.reset.trigger_price,
      reset_net_asset_floor_applicable: await getResetNetAssetFloor(ids.bondId, targetDate),
      reset_status:revisionState?.business_status||null,reset_data_status:revisionState?.data_status||'pending',
      put_trigger_price: triggerState.put.trigger_price,
      call_day_count: unifiedCallState && unifiedCallState.matched_days, reset_day_count: triggerState.reset.matched_days,
      put_day_count: triggerState.put.matched_days,
      call_required_days: unifiedCallState && unifiedCallState.required_days, reset_required_days: triggerState.reset.required_days,
      put_required_days: triggerState.put.required_days, call_met: unifiedCallState && unifiedCallState.calculated_status === 'met', reset_met: triggerState.reset.met,
      put_met: triggerState.put.met, put_active: putActive, put_observed_days: triggerState.put.observed_days,
      put_opportunity_used: putOpportunity.used,
      put_opportunity_announcement: putOpportunity.event ? putOpportunity.event.title : null,
      put_period_end_date: putPeriod.period_end,
      reset_active: resetWindow.active, reset_restart_date: resetWindow.eligible_from, reset_valid_until: resetWindow.valid_until,
      maturity_date: isoDate(profile.maturity_date), remaining_years: remainingYears(profile.maturity_date, new Date(`${targetDate}T00:00:00+08:00`)), issue_size: yuanToHundredMillion(profile.issue_size),
      remain_size: yuanToHundredMillion(remainSizeYuan), bond_to_market_cap: remainSizeYuan != null && marketCap > 0 ? remainSizeYuan / marketCap : null,
      conv_start_date: isoDate(profile.conv_start_date), conv_end_date: isoDate(profile.conv_end_date),
      estimated_put_trigger_date: estimatedPutDate,
      estimated_put_remaining_years: estimatedPutYears,
      expected_put_trigger_date: putTimeline && putTimeline.trigger_date, expected_put_payment_date: putTimeline && putTimeline.payment_date,
      expected_put_remaining_days: putTimeline && putTimeline.remaining_days, expected_put_assumption: putTimeline && putTimeline.assumption,
      expected_put_status: putOpportunity.used && !nextPutPeriod(putPeriod, profile.maturity_date)
        ? 'opportunity_used' : (putTimeline && putTimeline.status),
      put_redemption_price: putFinal,
      put_yield_pre_tax: putPreTax, put_yield_after_tax: putAfterTax,
      fundraising_purpose: profile.fundraising_purpose || null, fundraising_source_url: profile.prospectus_source_url || null,
      fund_holding: fundHolding,
    },
    terms: { reset: termDetails.reset, call: termDetails.call, put: termDetails.put,
      maturity_call_price: profile.maturity_call_price || null },
    history: { price_changes: extras.price_changes, no_revision: extras.no_revision_history },
    safety: safety ? { rating: safety.safety, interest_coverage: safety.indicator_interest,
      cash_coverage: safety.indicator_liquidity, liability_to_market_cap: safety.indicator_leverage,
      source_updated_at: safety.source_updated_at } : null,
    bond: { pure_bond_value: pureBond, bond_floor_premium: finite(latestBond.bond_over_rate) == null
        ? (bondPrice != null && pureBond > 0 ? bondPrice / pureBond - 1 : null) : finite(latestBond.bond_over_rate) / 100,
      pure_bond_method: marketPureBond != null ? 'Tushare纯债价值' : `现金流折现（${(discountRate * 100).toFixed(1)}%）`,
      coupon_rate: finite(profile.coupon_rate), rate_clause: profile.rate_clause || null, maturity_yield_pre_tax: maturityPreTax,
      maturity_yield_after_tax: maturityAfterTax, guarantor: profile.guarantor || null, guarantee_type: profile.guarantee_type || null,
      coupons: extras.coupons.map(row => Object.assign({}, row, { is_current: Number(row.interest_year) === interestYear })),
      coupon_source_url: profile.prospectus_source_url || null },
    option: { option_value: optionValue, theoretical_option_value: theoreticalOption, theoretical_value: theoreticalValue,
      theoretical_deviation: bondPrice != null && theoreticalValue > 0 ? bondPrice / theoreticalValue - 1 : null,
      model: 'Black-Scholes', risk_free_rate: riskFreeRate, volatility, dividend_yield: dividendYield,
      method_note: '期权价值=转债市价－纯债价值；理论价值=纯债价值＋Black-Scholes转股期权价值' },
    stock: { pe: calculatedPe, pe_source: finite(valuation.pe_ttm) != null ? 'PE-TTM' : (finite(valuation.pe) != null ? '静态PE' : '最近年报归母净利润反算'), pb: finite(valuation.pb),
      annualized_volatility: volatility, asset_liability_ratio: financialAssets > 0 && financialLiabilities != null
        ? financialLiabilities / financialAssets : null,
      total_market_cap: marketCap, dividend_yield: stockDividendYield,
      report_end_date: latestBalance.end_date || financial.report_end_date || null },
    rating_history: extras.ratings,
    credit: { issue_rating: profile.issue_rating || null, newest_rating: profile.newest_rating || null,
      rating_company: profile.rating_comp || null },
    liquidity: { volume: finite(latestBond.vol), amount: finite(latestBond.amount), double_low: bondPrice != null && convPremium != null ? bondPrice + convPremium * 100 : null },
    data_status: {
      cb_price_chg: priceChangeDetails.length || (reportPriceHistory && reportPriceHistory.price_changes.length) || priceChangeCache.some(row => row.parser_version === '3')
        ? 'announcement_parsed' : 'unavailable',
      coupon_schedule: extras.coupons.some(r=>r.source==='rate_clause')?'parsed_from_clause':extras.coupons.length?'ok':'pending_source_document',
      fund_holding: extras.fund_holding ? 'ok' : profile.analysis_inputs?.not_due ? 'not_due' : 'pending_official_report',
      no_revision_history: extras.no_revision_history.length ? 'ok' : 'no_matching_announcement',
      theoretical_value: theoreticalValue == null ? 'calculation_inputs_incomplete' : 'calculated',
      put_yield: putStartDate ? (putPreTax == null ? 'not_yet_calculable' : 'calculated') : 'put_period_not_found'
    }
  };
  const latestPriceChange = extras.price_changes && extras.price_changes[0];
  const latestNoRevision = extras.no_revision_history && extras.no_revision_history[0];
  const latestRating = extras.ratings && extras.ratings[0];
  const missing = [];
  if (!analysis.basic.fundraising_purpose) missing.push('fundraising_purpose');
  if (!fundHolding&&!profile.analysis_inputs?.not_due) missing.push('fund_holding');
  if (!extras.coupons.length) missing.push('coupon_schedule');
  if (!extras.ratings.length) missing.push('rating_history');
  if (!safety) missing.push('safety');
  if (!unifiedCallState) missing.push('call_state');
  if(!revisionState)missing.push('reset_state');
  if(analysis.stock.asset_liability_ratio==null)missing.push('financial_reports');
  if(analysis.stock.pb==null||marketCap==null)missing.push('stock_valuation');
  for (const kind of ['call','reset','put']) if (termDetails[kind].parse_status !== 'complete') missing.push(`${kind}_clause`);
  const ratingRequirement=profile.analysis_inputs?.rating_requirement;
  if(ratingRequirement?.version==='latest-complete-history-present-v1'&&!ratingRequirement.latest_complete)missing.push('rating');
  const pendingDocuments=Object.entries(profile.analysis_inputs?.documents||{}).filter(([key,state])=>
    !['complete','not_applicable'].includes(state.status)&&!coversDocument(profile.analysis_inputs?.api_fallbacks?.[key.split(':')[0]],key.split(':')[0],key.slice(key.indexOf(':')+1),profile.analysis_inputs?.targetDate,
      profile.analysis_inputs?.required_report_period,tsCode)&&(!key.startsWith('rating:')||
      ratingRequirement?.version!=='latest-complete-history-present-v1'||(ratingRequirement.required_document_urls||[]).includes(key.slice(7)))).map(([key,state])=>({
    key,status:state.status,reason:state.error?String(state.error).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0].slice(0,250):null,
  }));
  if(pendingDocuments.length)missing.push('historical_documents');
  analysis.completeness = {status:missing.length?'partial':'complete',missing,
    inputs:profile.analysis_inputs?{status:profile.analysis_inputs.status,parser_version:profile.analysis_inputs.parserVersion,
      covered_through:profile.analysis_inputs.coveredThrough,target_date:profile.analysis_inputs.targetDate,missing:profile.analysis_inputs.missing,not_due:profile.analysis_inputs.not_due,
      api_fallbacks:profile.analysis_inputs.api_fallbacks||{}}:null,
    pending_documents:pendingDocuments};
  const watermark = {
    analysis_type: 'convertible_bond',
    profile: { updated_at: isoDate(profile.source_updated_at || profile.updated_at), current_conv_price: finite(profile.conv_price) },
    conversion_price_event: {
      change_date: latestPriceChange ? isoDate(latestPriceChange.change_date) : null,
      publish_date: latestPriceChange ? isoDate(latestPriceChange.publish_date) : null,
      price_after: latestPriceChange ? finite(latestPriceChange.price_after) : null,
      no_revision_announced_at: latestNoRevision ? isoDate(latestNoRevision.announced_at) : null,
    },
    bond_daily: { trade_date: isoDate(latestBond.trade_date) },
    stock_daily: { trade_date: isoDate(latestStock.trade_date) },
    quote: { source: analysis.quote.source, quote_time: analysis.quote.quote_time,
      synchronized: analysis.quote.synchronized !== false },
    rating: { newest_rating: profile.newest_rating || null,
      rating_date: latestRating ? isoDate(latestRating.rating_date) : null },
    financial: { report_end_date: isoDate(latestBalance.end_date || financial.report_end_date) },
    terms_hash: await buildStandardTermsHash(pool, ids.bondId, analysis.as_of),
    formula_bundle_version: FORMULA_VERSION,
    analysis_inputs_hash:termsHash(profile.analysis_inputs||null),
  };
  if(!persist)return analysis;
  await pool.query(
    `INSERT INTO analytics.analysis_snapshots(instrument_id,as_of_date,snapshot_type,formula_bundle_version,payload,source_watermark)
     VALUES($1,$2,'convertible_bond_analysis',$3,$4::jsonb,$5::jsonb)
     ON CONFLICT(instrument_id,as_of_date,snapshot_type,formula_bundle_version) DO UPDATE SET payload=EXCLUDED.payload,
       source_watermark=EXCLUDED.source_watermark,created_at=now()`,
    [ids.bondId, analysis.as_of, FORMULA_VERSION, JSON.stringify(analysis), JSON.stringify(watermark)]
  );
  // 快照刷新成功，该债券历史遗留的转股价错配问题已随之解决，自动恢复闭环
  await resolveQualityIssue({ instrumentId: ids.bondId, datasetCode: 'cb_basic', fieldCode: 'conv_price', issueType: 'snapshot_input_mismatch' });
  return analysis;
}

// 从「标准条款表」convertible_bond_terms 重算条款指纹。
// 必须按有效期（effective_from / effective_to）选择「截至 asOf 当日生效」的条款，
// 而不是取最后写入的一行——可转债条款可能在存续期内修订，历史快照应锁定当时生效的条款。
// asOf 不传时取今天：①写入水位用快照自身 as_of；②回填历史快照用各快照自身的 as_of_date；
// ③失效判定（getConvertibleBondSnapshot）刻意不传 asOf，按今天重算后与水位比较，
//   使「快照生成后新增有效条款」能被检出并令旧快照失效。
// 同一来源用于写入水位与失效判定，保证读/写一致；标准表条款修订（新增 term_type 行）时指纹随之变化，旧快照会被判失效。
async function buildStandardTermsHash(pool, instrumentId, asOf) {
  if (!instrumentId) return null;
  const asOfDate = isoDate(asOf) || isoDate(new Date());
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (term_type) term_type, clause_text
     FROM fundamental.convertible_bond_terms
     WHERE instrument_id = $1
       AND effective_from <= $2::date
       AND (effective_to IS NULL OR effective_to > $2::date)
     ORDER BY term_type, effective_from DESC`,
    [instrumentId, asOfDate]
  );
  const textByType = {};
  rows.forEach(r => { textByType[r.term_type] = r.clause_text; });
  return termsHash({
    reset: simplifyClause('reset', textByType.reset),
    call: simplifyClause('call', textByType.call),
    put: simplifyClause('put', textByType.put),
    maturity_call_price: textByType.maturity_call ? finite(textByType.maturity_call) : null,
  });
}

async function getResetNetAssetFloor(instrumentId, asOf) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN net_asset_floor_applicable THEN true
                 WHEN parse_status='complete' THEN false ELSE NULL END AS applicable
       FROM fundamental.convertible_bond_terms
      WHERE instrument_id=$1 AND term_type='reset' AND effective_from<=$2::date
        AND (effective_to IS NULL OR effective_to>$2::date)
      ORDER BY effective_from DESC LIMIT 1`, [instrumentId, asOf]);
  return rows[0]?.applicable ?? null;
}

async function getConvertibleBondSnapshot(value) {
  const tsCode = normalizeBondCode(value);
  if (!tsCode) return null;
  const { rows } = await pool.query(
    `SELECT s.payload,s.created_at,s.formula_bundle_version,s.source_watermark,
            p.current_conv_price,p.source_updated_at,p.updated_at AS profile_updated_at,
            p.stock_instrument_id,p.newest_rating AS profile_rating,p.raw_payload->'analysis_inputs' AS analysis_inputs,
            i.instrument_id,i.status,i.delist_date
     FROM core.instruments i JOIN analytics.analysis_snapshots s ON s.instrument_id=i.instrument_id
     LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
     WHERE i.canonical_code=$1 AND s.snapshot_type='convertible_bond_analysis'
     ORDER BY s.as_of_date DESC,s.created_at DESC LIMIT 1`, [tsCode]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  const payload = r.payload || {};
  const delistDate = isoDate(r.delist_date) || isoDate(payload.delist_date);
  const snapshotAsOf = isoDate(payload.as_of);
  const latest = await pool.query(
    `SELECT (SELECT max(trade_date) FROM market.daily_bars WHERE instrument_id=$1) AS bond_date,
            (SELECT max(change_date) FROM fundamental.convertible_bond_price_changes WHERE instrument_id=$1) AS conv_change_date,
            (SELECT max(trade_date) FROM market.daily_bars WHERE instrument_id=$2) AS stock_date,
            (SELECT max(period_end) FROM fundamental.financial_reports fr
               JOIN core.company_instruments ci ON ci.company_id=fr.company_id
               WHERE ci.instrument_id=$2) AS report_end_date`,
    [r.instrument_id, r.stock_instrument_id]
  );
  const latestBondTradeDate = latest.rows[0] && latest.rows[0].bond_date;
  const latestConvPriceChangeDate = latest.rows[0] && latest.rows[0].conv_change_date;
  const latestStockTradeDate = latest.rows[0] && latest.rows[0].stock_date;
  const currentFinancialEnd = latest.rows[0] && latest.rows[0].report_end_date;
  const latestCallState = await getLatestCallState(r.instrument_id);
  const today = isoDate(new Date());
  const callLastTradeDate = latestCallState && isoDate(latestCallState.last_trade_date);
  const callLastConversionDate = latestCallState && isoDate(latestCallState.last_conversion_date);
  const callLifecycleDate = callLastTradeDate || callLastConversionDate;
  const callDelisted = Boolean(latestCallState
    && ['implementation', 'completion'].includes(latestCallState.official_status)
    && callLifecycleDate && callLifecycleDate <= today);
  const effectiveDelistDate = callDelisted && callLifecycleDate
    && (!delistDate || callLifecycleDate < delistDate) ? callLifecycleDate : delistDate;
  // 失效检查必须按「当前分析日期」重算条款指纹，再与快照水位（写入时按快照日期锁定）比较；
  // 若快照生成后条款被修订（新增/调整有效条款），两者不一致即触发 terms_changed，使旧快照自动失效。
  // 注意：不可传 snapshotAsOf，否则永远查到快照当时条款，修订后旧快照永远不会被判失效。
  const currentTermsHash = await buildStandardTermsHash(pool, r.instrument_id);
  const freshness = evaluateConvertibleBondFreshness({
    snapshotConvPrice: payload.basic && payload.basic.convert_price,
    snapshotAsOf,
    snapshotCreatedAt: r.created_at,
    profileConvPrice: r.current_conv_price,
    profileUpdatedAt: r.source_updated_at || r.profile_updated_at,
    latestBondTradeDate,
    latestConvPriceChangeDate,
    latestStockTradeDate,
    currentFinancialEnd,
    currentRating: r.profile_rating,
    currentTermsHash,
    watermark: r.source_watermark,
  });
  const basic = Object.assign({}, payload.basic || {});
  basic.reset_net_asset_floor_applicable = await getResetNetAssetFloor(r.instrument_id, today);
  if (latestCallState) {
    Object.assign(basic, {
      call_trigger_price: latestCallState.trigger_price,
      call_status: latestCallState.business_status,
      call_data_status: latestCallState.data_status,
      call_trade_date: isoDate(latestCallState.trade_date),
      call_trigger_day_count: latestCallState.matched_days,
      call_day_count: latestCallState.matched_days,
      call_required_days: latestCallState.required_days,
      call_remaining_days: latestCallState.remaining_days,
      call_met: latestCallState.calculated_status === 'met',
      call_announcement: latestCallState.announcement_title || null,
    });
  }
  return Object.assign({}, payload, {
    basic,
    cached_at: r.created_at,
    delist_date: effectiveDelistDate,
    is_delisted: r.status === 'delisted' || callDelisted || Boolean(delistDate && delistDate <= today),
    needs_refresh: r.formula_bundle_version !== FORMULA_VERSION || freshness.needs_refresh
      || r.source_watermark?.analysis_inputs_hash!==termsHash(r.analysis_inputs||null),
    formula_version: r.formula_bundle_version,
    freshness,
  });
}

module.exports = {
  finite, yuanToHundredMillion, isoDate, normalizeBondCode, instrumentStatus, remainingYears, pricePairFromReason, normalizePriceChange, normalizePriceChanges, parseTriggerRatio, parseWindow, earliestPutDate, currentPutPeriod, nextPutPeriod, putOpportunityState,
  annualizedVolatility, simplifyClause, hasNetAssetFloorClause, triggerProgress, resetWindowState, estimatePutTimeline, parseCouponRates, couponRowsFromClause, parseMoney, yieldToMaturity,
  cashflowsToDate, creditDiscountRate, futureTradeCalendar, annualizedRedemptionYield, accruedPutPrice,
  blackScholesConvertible, fallbackPe, currentInterestYear, presentValue, derivedDividendYield, revisionDecision, revisionEventDecision,
  mergeDailyRows, incrementalStart, ANNOUNCEMENT_OVERLAP_DAYS, announcementSourceKey,
  relevantConvertibleBondAnnouncements, collectConvertibleBondAnnouncementMarket,announcementDateWindows,
  syncConvertibleBondUniverse, syncConvertibleBondAnnouncementHistories, resolveConvertibleBondSymbolicLocks, latestTradeDates, latestFullBondDaily, activeProfile, isUnderlyingStockListed, refreshConvertibleBondAnalysis, getConvertibleBondSnapshot, buildStandardTermsHash,
  bondGapQueueHash, buildBondGapQueue, readBondGapQueue, writeBondGapQueue, isTencentBondWindow, fetchTargetedBondDaily,
  classifyBondObjectStatus, addTradingDays,
  loadSafety, latestFinancial,
  buildConvertibleBondAnalysisFromDatabase,
  analysisInputTools: { sourceIds,saveProspectusDetails,saveReportFundHolding,saveRatingHistory,saveRatingOutlooks,reportPeriod,
    savePriceChanges,saveAnnouncementHistories,saveRevisionEvents,pythonCandidates,latestProspectus,latestFullReport,isFullReport,
    extractNoRevisionPeriods,extractPriceChangeDetails,loadNoRevisionCache,loadPriceChangeCache },
  DAILY_FIELDS, loadTrackedDelistedStocks, syncTrackedStockLifecycle, ensureStockUniverse,
  syncConvertibleBondUniverseWithBackfill, backfillCycleGaps, backfillUnderlyingStockMarket, getRecentOpenDays,
  backfillMissingRatings, backfillBondFirstDayPerformance, backfillBondIssueResults, backfillBondListingLiquidity,
};
