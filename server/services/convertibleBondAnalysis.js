const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { tushareQuery, tsRows, tsDateStr } = require('./market');
const { fetchTencentQuotes } = require('./tencentQuote');
const { fetchCninfoEvents, fetchCninfoEventsByYear, fetchSseLatestReport, fetchSseEvents, fetchSzseEvents, fetchSzseLatestReport } = require('./stockAnalysis');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cycleService = require('./convertibleBondCycleService');
const { evaluateConvertibleBondFreshness, CONV_PRICE_EPS } = require('./analysisFreshness');
const { datasetScope, getDatasetCursors, isDatasetFresh, markDatasetSuccess, markDatasetFailure,
  recordQualityIssue, resolveQualityIssue } = require('./datasetCursors');

const BOND_PREFIX = /^(110|111|113|118|123|127|128)\d{3}$/;
const BOND_FIRSTDAY_SCRIPT = path.resolve(__dirname, '..', '..', 'ipo-report', 'backfill_bond_firstday.py');
const BOND_ISSUE_RESULT_SCRIPT = path.resolve(__dirname, '..', '..', 'ipo-report', 'backfill_bond_shd.py');
const PROFILE_FIELDS = [
  'ts_code','bond_full_name','bond_short_name','cb_type','stk_code','stk_short_name','maturity','par','issue_price',
  'issue_size','remain_size','value_date','maturity_date','rate_type','coupon_rate','add_rate','pay_per_year',
  'list_date','delist_date','exchange','conv_start_date','conv_end_date','conv_stop_date','first_conv_price','conv_price',
  'rate_clause','put_clause','maturity_call_price','call_clause','reset_clause','conv_clause','guarantor','guarantee_type',
  'issue_rating','newest_rating','rating_comp'
].join(',');
const DAILY_FIELDS = 'ts_code,trade_date,pre_close,open,high,low,close,change,pct_chg,vol,amount,bond_value,bond_over_rate,cb_value,cb_over_rate';
const ISSUE_FIELDS = 'ts_code,ann_date,res_ann_date,issue_size,issue_price,issue_type,shd_ration_record_date,shd_ration_ratio,onl_date,onl_size,onl_pch_num,offl_size,shd_ration_size';
const FORMULA_VERSION = '3';
const CN_OFFSET_MS = 8 * 3600 * 1000;
// 允许按 TTL 跳过上游的静态/低频数据组。行情与公告不在此列：
// 行情已有 7 天重叠增量，公告参与回售、下修等当期判定，跳过会改变分析结论。
const GATED_BOND_DATASETS = ['cb_basic', 'cb_rating', 'cb_price_chg', 'cb_rate', 'top10_cb_holders', 'bond_dividend'];

// 条款指纹：条款文本一变，指纹就变，用于判断旧快照是否还基于同一套条款
function termsHash(terms) {
  try {
    return crypto.createHash('md5').update(JSON.stringify(terms || {})).digest('hex');
  } catch (e) { return null; }
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pricePairFromReason(reason) {
  const match = String(reason || '').match(/由\s*(\d+(?:\.\d+)?)\s*元?\/股\s*调整为\s*(\d+(?:\.\d+)?)\s*元?\/股/);
  return match ? { price_before: Number(match[1]), price_after: Number(match[2]) } : null;
}

function normalizePriceChange(row) {
  const pair = pricePairFromReason(row && row.reason);
  const storedAfter = finite(row && (row.price_after == null ? row.convertprice_aft : row.price_after));
  if (pair && storedAfter != null && Math.abs(storedAfter - pair.price_after) > 0.0001) return row;
  return pair ? Object.assign({}, row, pair, {
    convertprice_bef: pair.price_before,
    convertprice_aft: pair.price_after,
  }) : row;
}

function normalizePriceChanges(rows) {
  const normalized = (rows || []).map(normalizePriceChange);
  return normalized.filter((row, index) => {
    const before = finite(row.price_before);
    const after = finite(row.price_after);
    if (before == null || after == null) return true;
    const currentDate = new Date(row.change_date).getTime();
    return !normalized.slice(0, index).some(previous => {
      const previousDate = new Date(previous.change_date).getTime();
      return finite(previous.price_before) === before
        && finite(previous.price_after) === after
        && Number.isFinite(currentDate)
        && Number.isFinite(previousDate)
        && Math.abs(currentDate - previousDate) <= 14 * 86400000;
    });
  });
}

function yuanToHundredMillion(value) {
  const number = finite(value);
  return number == null ? null : number / 100000000;
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const cn = new Date(value.getTime() + CN_OFFSET_MS);
    return `${cn.getUTCFullYear()}-${String(cn.getUTCMonth()+1).padStart(2,'0')}-${String(cn.getUTCDate()).padStart(2,'0')}`;
  }
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}` : null;
}

function normalizeBondCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  const digits = raw.replace(/\.(SH|SZ)$/i, '').replace(/\D/g, '');
  if (!BOND_PREFIX.test(digits)) return null;
  const exchange = /^(123|127|128)/.test(digits) ? 'SZ' : 'SH';
  return `${digits}.${exchange}`;
}

function instrumentStatus(delistDate, today = isoDate(new Date()), listDate = null, subscriptionDate = null) {
  const delist = isoDate(delistDate);
  const listed = isoDate(listDate);
  const subscribing = isoDate(subscriptionDate);
  if (delist && delist <= today) return 'delisted';
  if (listed && listed > today) return 'pending_listing';
  if (subscribing && subscribing === today) return 'subscribing';
  if (!listed) return subscribing ? 'announced' : 'listed';
  return 'listed';
}

function issueSize100m(value) {
  const number = finite(value);
  if (number == null) return null;
  return number >= 10000 ? number / 100000000 : number;
}

function remainingYears(maturityDate, now = new Date()) {
  const date = maturityDate ? new Date(`${isoDate(maturityDate)}T00:00:00+08:00`) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return Math.max(0, (date.getTime() - now.getTime()) / (365.25 * 86400000));
}

function parseTriggerRatio(text) {
  const clause = String(text || '').replace(/\s+/g, '');
  const matches = [
    clause.match(/转股价(?:格)?的(\d+(?:\.\d+)?)%/),
    clause.match(/(\d+(?:\.\d+)?)%[^。；]{0,16}转股价/),
  ];
  const value = matches.find(Boolean);
  return value ? Number(value[1]) / 100 : null;
}

function chineseNumber(value) {
  if (/^\d+$/.test(String(value))) return Number(value);
  const digits = { 一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
  const text = String(value || '');
  if (text === '十') return 10;
  if (text.includes('十')) { const parts=text.split('十'); return (digits[parts[0]] || 1) * 10 + (digits[parts[1]] || 0); }
  return digits[text] || null;
}

function parseWindow(text) {
  const clause = String(text || '');
  const days = [...clause.matchAll(/([一二两三四五六七八九十\d]+)个交易日/g)].map(match => chineseNumber(match[1])).filter(Boolean);
  return { observation_days: days[0] || null, required_days: days[1] || null };
}

function earliestPutDate(maturityDate, clause) {
  const dateText = isoDate(maturityDate);
  if (!dateText) return null;
  const match = String(clause || '').match(/最后([一二两三四五六七八九十\d]+)个计息年度/);
  if (!match) return null;
  const chinese = { 一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10 };
  const years = Number(match[1]) || chinese[match[1]];
  if (!years) return null;
  return `${Number(dateText.slice(0,4)) - years}${dateText.slice(4)}`;
}

function currentPutPeriod(maturityDate, clause, today = isoDate(tsDateStr(new Date()))) {
  const eligibleFrom = earliestPutDate(maturityDate, clause);
  const current = isoDate(today), maturity = isoDate(maturityDate);
  if (!eligibleFrom || !current || !maturity) return { active: false, eligible_from: eligibleFrom, period_start: null, period_end: null };
  let periodStart = eligibleFrom;
  while (true) {
    const next = isoDate(addYears(new Date(`${periodStart}T00:00:00+08:00`), 1));
    if (!next || next > current || next >= maturity) break;
    periodStart = next;
  }
  const nextPeriod = isoDate(addYears(new Date(`${periodStart}T00:00:00+08:00`), 1));
  const endDate = addDays(new Date(`${(nextPeriod && nextPeriod < maturity) ? nextPeriod : maturity}T00:00:00+08:00`), -1);
  return { active: current >= periodStart && current <= maturity, eligible_from: eligibleFrom,
    period_start: periodStart, period_end: isoDate(endDate) };
}

function nextPutPeriod(period, maturityDate) {
  const maturity = isoDate(maturityDate);
  if (!period || !period.period_start || !maturity) return null;
  const start = isoDate(addYears(new Date(`${period.period_start}T00:00:00+08:00`), 1));
  if (!start || start >= maturity) return null;
  const following = isoDate(addYears(new Date(`${start}T00:00:00+08:00`), 1));
  const boundary = following && following < maturity ? following : maturity;
  return { active: false, eligible_from: period.eligible_from, period_start: start,
    period_end: isoDate(addDays(new Date(`${boundary}T00:00:00+08:00`), -1)) };
}

function putOpportunityState(events, periodStart, periodEnd) {
  const start = isoDate(periodStart), end = isoDate(periodEnd);
  const relevant = (events || []).filter(event => {
    const date = isoDate(event.event_date), title = String(event.title || '');
    return date && (!start || date >= start) && (!end || date <= end) && /回售/.test(title) && !/募集说明书|评级/.test(title);
  }).sort((a,b) => String(b.event_date).localeCompare(String(a.event_date)));
  const result = relevant.find(event => /回售.{0,12}(?:结果|实施结果|申报结果)|(?:结果|实施结果|申报结果).{0,12}回售/.test(String(event.title || '')));
  return { used: Boolean(result), announced: relevant.length > 0, event: result || relevant[0] || null };
}

function annualizedVolatility(rows) {
  const closes = (rows || []).slice()
    .map(row => ({ row, date: isoDate(row.trade_date) }))
    .filter(item => item.date)
    .sort((a,b) => a.date.localeCompare(b.date))
    .map(item => item.row)
    .map(row => finite(row.close)).filter(value => value > 0).slice(-251);
  if (closes.length < 30) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) returns.push(Math.log(closes[i] / closes[i - 1]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(250);
}

function simplifyClause(type, text) {
  const clause = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clause) return { text: null, note: null, ratio: null, observation_days: null, required_days: null, comparison: null };
  const ratio = parseTriggerRatio(clause);
  const window = parseWindow(clause);
  const observation = window.observation_days || 30;
  const required = window.required_days || (type === 'put' ? observation : 15);
  const percent = ratio == null ? null : Number((ratio * 100).toFixed(2));
  const comparison = type === 'call' ? 'gte' : 'lt';
  let summary = null;
  if (percent != null) {
    if (type === 'call') summary = `任意连续${observation}个交易日中，至少${required}个交易日收盘价不低于转股价的${percent}%`;
    if (type === 'reset') summary = `任意连续${observation}个交易日中，至少${required}个交易日收盘价低于转股价的${percent}%`;
    if (type === 'put') summary = `最后计息年度的回售期内，连续${observation}个交易日收盘价低于转股价的${percent}%`;
  }
  const netAsset = clause.match(/(?:不得|不应)低于[^。；]{0,30}(?:每股)?净资产[^。；]*/);
  return { text: summary || clause, note: netAsset ? netAsset[0] : null, ratio, observation_days: observation,
    required_days: required, comparison };
}

function triggerProgress(rows, term, convertPrice, active = true, eligibleFrom = null) {
  if (!term || term.ratio == null || finite(convertPrice) == null) return { matched_days: null, required_days: term && term.required_days || null, observation_days: term && term.observation_days || null, active };
  const triggerPrice = finite(convertPrice) * term.ratio;
  const eligibleDate = isoDate(eligibleFrom);
  if (!active) return { trigger_price: triggerPrice, matched_days: 0, required_days: term.required_days,
    observation_days: term.observation_days, observed_days: 0, active: false, eligible_from: eligibleDate, met: false };
  const latest = (rows || []).filter(row => !eligibleDate || isoDate(row.trade_date) >= eligibleDate)
    .sort((a,b) => String(b.trade_date).localeCompare(String(a.trade_date))).slice(0, term.observation_days);
  const matched = latest.filter(row => {
    const close = finite(row.close);
    return close != null && (term.comparison === 'gte' ? close >= triggerPrice : close < triggerPrice);
  }).length;
  return { trigger_price: triggerPrice, matched_days: matched, required_days: term.required_days,
    observation_days: term.observation_days, observed_days: latest.length, active, eligible_from: eligibleDate,
    met: latest.length >= term.required_days && matched >= term.required_days };
}

function resetWindowState(rows, today = isoDate(tsDateStr(new Date()))) {
  const current = isoDate(today);
  const latest = (rows || []).filter(row => isoDate(row.announced_at) && isoDate(row.announced_at) <= current)
    .sort((a,b) => isoDate(b.announced_at).localeCompare(isoDate(a.announced_at)))[0];
  if (!latest) return { active: true, eligible_from: null, valid_until: null };
  const restart = isoDate(latest.next_eligible_date);
  return { active: !restart || current >= restart, eligible_from: restart, valid_until: isoDate(latest.valid_until),
    announced_at: isoDate(latest.announced_at) };
}

function estimatePutTimeline(rows, term, convertPrice, putStartDate, futureTradeDates, currentPrice, today = isoDate(tsDateStr(new Date()))) {
  const start = isoDate(putStartDate), current = isoDate(today), price = finite(currentPrice), conversion = finite(convertPrice);
  if (!start || !term || term.ratio == null || !(conversion > 0) || !(price > 0)) return null;
  const triggerPrice = conversion * term.ratio;
  const required = term.required_days || term.observation_days;

  // 当前价低于触发价：直接统计已满足天数 + 推算未来
  if (price < triggerPrice) {
    const history = (rows || []).filter(row => isoDate(row.trade_date) >= start && isoDate(row.trade_date) <= current)
      .sort((a,b) => isoDate(b.trade_date).localeCompare(isoDate(a.trade_date)));
    let trailing = 0;
    for (const row of history) {
      if (finite(row.close) < triggerPrice) trailing += 1;
      else break;
      if (trailing >= required) break;
    }
    const remaining = Math.max(0, required - trailing);
    const lastHistoryDate = history[0] ? isoDate(history[0].trade_date) : null;
    const calendar = [...new Set((futureTradeDates || []).map(isoDate).filter(Boolean))].sort();
    const future = calendar.filter(date => date >= start && date > (lastHistoryDate || current));
    const triggerDate = remaining === 0 ? lastHistoryDate : future[remaining - 1] || null;
    const paymentDates = triggerDate ? calendar.filter(date => date > triggerDate) : [];
    return { status: triggerDate ? 'estimated' : 'calendar_insufficient', trigger_date: triggerDate,
      payment_date: paymentDates[9] || null, remaining_days: remaining, trailing_days: trailing,
      method: trailing > 0 ? 'trailing_count' : 'assumed_continuous', assumption: '假设正股收盘价持续低于回售触发价' };
  }

  // 当前价高于触发价：用波动率估算股价首次触及触发价的时间
  const annualVol = annualizedVolatility(rows);
  if (!annualVol) return { status: 'current_price_not_below_trigger', trigger_date: null, payment_date: null, remaining_days: null, method: 'vol_unavailable' };
  const dailyVol = annualVol / Math.sqrt(250);
  const logDist = -Math.log(triggerPrice / price); // 正数，价格偏离触发价的对数距离
  const z = logDist / dailyVol;
  const estCrossDays = Math.round((z * z) / 2); // 随机游走首次触及下界的期望交易日数
  const totalTradingDays = Math.min(estCrossDays + required, futureTradeDates.length);
  const calendar = [...new Set((futureTradeDates || []).map(isoDate).filter(Boolean))].sort();
  const future = calendar.filter(date => date >= start && date > current);
  const triggerDate = totalTradingDays > 0 && totalTradingDays <= future.length ? future[totalTradingDays - 1] : null;
  const paymentDates = triggerDate ? calendar.filter(date => date > triggerDate) : [];
  return { status: triggerDate ? 'volatility_estimated' : 'estimation_failed', trigger_date: triggerDate,
    payment_date: paymentDates[9] || null, remaining_days: totalTradingDays, trailing_days: 0,
    method: 'volatility', annual_vol: annualVol, assumption: `基于年化波动率 ${(annualVol*100).toFixed(0)}% 估算首次触及时间，仅供参考` };
}

function futureTradeCalendar(rows, today = isoDate(tsDateStr(new Date())), horizonDays = 800) {
  const official = (rows || []).map(row => ({ date: isoDate(row.cal_date), open: String(row.is_open) === '1' })).filter(row => row.date).sort((a,b) => a.date.localeCompare(b.date));
  const dates = new Set(official.filter(row => row.open).map(row => row.date));
  const lastOfficial = official.length ? official[official.length - 1].date : isoDate(today);
  let cursor = new Date(`${lastOfficial}T00:00:00+08:00`);
  const end = addDays(new Date(`${isoDate(today)}T00:00:00+08:00`), horizonDays);
  while (cursor < end) {
    cursor = addDays(cursor, 1);
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.add(isoDate(cursor));
  }
  return [...dates].sort();
}

function parseCouponRates(text) {
  const values = [...String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*[%％]/g)]
    .map(match => Number(match[1])).filter(Number.isFinite);
  return values;
}

function parseMoney(text, fallback = null) {
  const raw = String(text || '').trim();
  const match = raw.match(/(\d+(?:\.\d+)?)\s*元/);
  if (!match && /^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return match ? Number(match[1]) : fallback;
}

function addYears(date, years) {
  const cn = new Date(date.getTime() + CN_OFFSET_MS);
  cn.setUTCFullYear(cn.getUTCFullYear() + years);
  return new Date(cn.getTime() - CN_OFFSET_MS);
}

function addDays(date, days) {
  const cn = new Date(date.getTime() + CN_OFFSET_MS);
  cn.setUTCDate(cn.getUTCDate() + days);
  return new Date(cn.getTime() - CN_OFFSET_MS);
}

function cashflowsToDate(profile, coupons, targetDate, afterTax, finalValue, asOfDate = null) {
  const asOfText = asOfDate ? isoDate(asOfDate) : null;
  const today = asOfText ? new Date(`${asOfText}T00:00:00+08:00`) : new Date();
  const target = targetDate ? new Date(`${isoDate(targetDate)}T00:00:00+08:00`) : null;
  const valueDate = profile.value_date ? new Date(`${isoDate(profile.value_date)}T00:00:00+08:00`) : null;
  if (!target || !valueDate || Number.isNaN(target.getTime()) || Number.isNaN(valueDate.getTime()) || target <= today) return [];
  const storedRates = (coupons || []).map(row => finite(row.coupon_rate));
  const rates = storedRates.length ? storedRates : parseCouponRates(profile.rate_clause);
  const flows = [];
  for (let year = 1; year <= 12; year += 1) {
    const payDate = addYears(valueDate, year);
    if (payDate > target) break;
    const rate = rates[year - 1] == null ? finite(profile.coupon_rate) : rates[year - 1];
    const isFinal = Math.abs(payDate.getTime() - target.getTime()) < 40 * 86400000 || addYears(valueDate, year + 1) > target;
    let amount = isFinal ? finalValue : (rate || 0);
    if (afterTax) amount = isFinal ? 100 + Math.max(0, amount - 100) * 0.8 : amount * 0.8;
    if (payDate > today) flows.push({ years: (Math.min(payDate.getTime(), target.getTime()) - today.getTime()) / (365.25 * 86400000), amount });
    if (isFinal) break;
  }
  if (!flows.length || flows[flows.length - 1].years < (target.getTime() - today.getTime()) / (365.25 * 86400000) - 0.05) {
    let amount = finalValue;
    if (afterTax) amount = 100 + Math.max(0, amount - 100) * 0.8;
    flows.push({ years: (target.getTime() - today.getTime()) / (365.25 * 86400000), amount });
  }
  return flows;
}

function creditDiscountRate(rating) {
  const rates = { AAA:0.028, 'AA+':0.032, AA:0.036, 'AA-':0.042, 'A+':0.05, A:0.06, 'A-':0.075 };
  return rates[String(rating || '').toUpperCase()] || 0.06;
}

function presentValue(cashflows, discountRate) {
  if (!(discountRate > -1) || !(cashflows || []).length) return null;
  return cashflows.reduce((sum, flow) => sum + (finite(flow.amount) || 0) / Math.pow(1 + discountRate, finite(flow.years) || 0), 0);
}

function currentInterestYear(valueDate, maturityDate, today = isoDate(tsDateStr(new Date()))) {
  const start = isoDate(valueDate), maturity = isoDate(maturityDate), current = isoDate(today);
  if (!start || !maturity || !current || current < start || current > maturity) return null;
  let year = Number(current.slice(0, 4)) - Number(start.slice(0, 4)) + 1;
  if (current.slice(4) < start.slice(4)) year -= 1;
  return Math.max(1, year);
}

function derivedDividendYield(rows, stockPrice, today = isoDate(tsDateStr(new Date()))) {
  const price = finite(stockPrice), current = isoDate(today);
  if (!(price > 0)) return null;
  const startDate = addYears(new Date(`${current}T00:00:00+08:00`), -1);
  const start = isoDate(startDate);
  const paid = (rows || []).filter(row => isoDate(row.ex_date) && isoDate(row.ex_date) >= start && isoDate(row.ex_date) <= current);
  if (paid.length) return paid.reduce((sum,row) => sum + (finite(row.cash_div_tax) || 0), 0) / price;
  return (rows || []).some(row => finite(row.cash_div_tax) === 0) ? 0 : null;
}

function yieldToMaturity(price, cashflows) {
  if (!(finite(price) > 0) || !cashflows || !cashflows.length) return null;
  const npv = rate => cashflows.reduce((sum, flow) => sum + flow.amount / Math.pow(1 + rate, flow.years), 0) - price;
  // 高溢价、临近到期的债券可能对应低于 -99% 的年化收益率；收益率理论下限为 -100%。
  let low = -1 + 1e-12, high = 5;
  if (npv(low) * npv(high) > 0) return null;
  for (let i = 0; i < 100; i += 1) { const mid = (low + high) / 2; if (npv(mid) > 0) low = mid; else high = mid; }
  return (low + high) / 2;
}

function annualizedRedemptionYield(price, redemptionPrice, years, interestTaxRate = 0) {
  const market = finite(price), redemption = finite(redemptionPrice), duration = finite(years);
  if (!(market > 0) || !(redemption > 0) || !(duration > 0)) return null;
  const netRedemption = Math.min(100, redemption)
    + Math.max(0, redemption - 100) * (1 - interestTaxRate);
  return Math.pow(netRedemption / market, 1 / duration) - 1;
}

function accruedPutPrice(profile, coupons, targetDate) {
  const target = isoDate(targetDate), valueDate = isoDate(profile && profile.value_date);
  if (!target || !valueDate) return null;
  const explicit = String(profile.put_clause || '').match(/(?:回售价格|回售给公司)[^。；]{0,20}?(?:为|按)(?:人民币)?(\d+(?:\.\d+)?)元/);
  if (explicit) return Number(explicit[1]);
  const interestYear = currentInterestYear(valueDate, profile.maturity_date, target);
  if (!interestYear) return null;
  const coupon = (coupons || []).find(row => Number(row.interest_year) === interestYear);
  const parsedRates = parseCouponRates(profile.rate_clause);
  const rate = finite(coupon && coupon.coupon_rate) == null
    ? (finite(profile.coupon_rate) == null ? finite(parsedRates[interestYear - 1]) : finite(profile.coupon_rate))
    : finite(coupon.coupon_rate);
  if (rate == null) return null;
  const periodStart = addYears(new Date(`${valueDate}T00:00:00+08:00`), interestYear - 1);
  const elapsedDays = Math.max(0, Math.floor(
    (new Date(`${target}T00:00:00+08:00`).getTime() - periodStart.getTime()) / 86400000
  ));
  return 100 + rate * elapsedDays / 365;
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1, x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-x*x);
  return 0.5 * (1 + sign * erf);
}

function blackScholesConvertible(stockPrice, convertPrice, years, volatility, riskFreeRate, dividendYield) {
  if (![stockPrice,convertPrice,years,volatility].every(value => finite(value) > 0)) return null;
  const s=finite(stockPrice),k=finite(convertPrice),t=finite(years),sigma=finite(volatility),r=finite(riskFreeRate)||0,q=finite(dividendYield)||0;
  const d1=(Math.log(s/k)+(r-q+sigma*sigma/2)*t)/(sigma*Math.sqrt(t)),d2=d1-sigma*Math.sqrt(t);
  const call=s*Math.exp(-q*t)*normalCdf(d1)-k*Math.exp(-r*t)*normalCdf(d2);
  return Math.max(0, call * 100 / k);
}

function fallbackPe(valuation, marketCap, incomeRows) {
  const direct = finite(valuation.pe_ttm) != null ? finite(valuation.pe_ttm) : finite(valuation.pe);
  if (direct != null) return direct;
  const annual = (incomeRows || []).filter(row => /1231$/.test(String(row.end_date || '')) && finite(row.n_income_attr_p) != null)
    .sort((a,b) => String(b.end_date).localeCompare(String(a.end_date)) || String(b.f_ann_date || b.ann_date || '').localeCompare(String(a.f_ann_date || a.ann_date || '')))[0];
  return annual && marketCap != null && finite(annual.n_income_attr_p) !== 0 ? marketCap / finite(annual.n_income_attr_p) : null;
}

async function sourceIds(client = pool) {
  const { rows } = await client.query(`SELECT source_id,source_code FROM ops.data_sources WHERE source_code IN ('tushare','tencent','cninfo','calculated')`);
  return Object.fromEntries(rows.map(row => [row.source_code, row.source_id]));
}

async function ensureInstrument(client, tsCode, name, assetClass, listDate, delistDate, subscriptionDate = null) {
  const market = tsCode.endsWith('.SH') ? 'SSE' : 'SZSE';
  const { rows } = await client.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,list_date,delist_date,status)
     VALUES($1,$2,$3,'CN',$4,$5,$6,$7)
     ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name,asset_class=EXCLUDED.asset_class,
       exchange_code=EXCLUDED.exchange_code,list_date=COALESCE(EXCLUDED.list_date,core.instruments.list_date),
       delist_date=COALESCE(EXCLUDED.delist_date,core.instruments.delist_date),
       status=CASE WHEN $8::date IS NOT NULL AND EXCLUDED.status IN ('announced','subscribing') THEN EXCLUDED.status
                   WHEN EXCLUDED.list_date IS NULL AND EXCLUDED.delist_date IS NULL
                   THEN core.instruments.status ELSE EXCLUDED.status END,updated_at=now()
     RETURNING instrument_id`,
    [tsCode, name || tsCode, assetClass, market, isoDate(listDate), isoDate(delistDate),
      assetClass === 'convertible_bond'
        ? (listDate || delistDate || subscriptionDate
          ? instrumentStatus(delistDate, isoDate(new Date()), listDate, subscriptionDate)
          : 'announced')
        : 'listed',
      isoDate(subscriptionDate)]
  );
  return rows[0].instrument_id;
}

async function saveTerms(client, instrumentId, profile, tushareSource) {
  const entries = [
    ['put', profile.put_clause], ['call', profile.call_clause], ['reset', profile.reset_clause],
    ['maturity_call', profile.maturity_call_price]
  ];
  await client.query("DELETE FROM fundamental.convertible_bond_terms WHERE instrument_id=$1 AND term_type='conversion'", [instrumentId]);
  for (const [type, clause] of entries) {
    if (!clause) continue;
    const window = parseWindow(clause);
    await client.query(
      `INSERT INTO fundamental.convertible_bond_terms
       (instrument_id,term_type,effective_from,clause_text,trigger_ratio,observation_days,required_days,source_id,source_key,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT(instrument_id,term_type,effective_from,source_key) DO UPDATE SET clause_text=EXCLUDED.clause_text,
         trigger_ratio=EXCLUDED.trigger_ratio,observation_days=EXCLUDED.observation_days,required_days=EXCLUDED.required_days,
         raw_payload=EXCLUDED.raw_payload`,
      [instrumentId, type, isoDate(profile.list_date) || '0001-01-01', String(clause), parseTriggerRatio(clause),
        window.observation_days, window.required_days, tushareSource, `cb_basic:${profile.ts_code}:${type}`, JSON.stringify({ clause })]
    );
  }
}

async function saveProfile(client, profile, sources, subscriptionDate = null) {
  const bondId = await ensureInstrument(client, profile.ts_code, profile.bond_short_name, 'convertible_bond', profile.list_date, profile.delist_date, subscriptionDate);
  const stockId = profile.stk_code ? await ensureInstrument(client, profile.stk_code, profile.stk_short_name, 'stock', null, null) : null;
  await client.query(
    `INSERT INTO fundamental.convertible_bond_profiles
     (instrument_id,stock_instrument_id,bond_full_name,bond_short_name,cb_type,par_value,issue_price,issue_size,remain_size,
      value_date,maturity_date,conv_start_date,conv_end_date,conv_stop_date,first_conv_price,current_conv_price,coupon_rate,
      add_rate,pay_per_year,rate_type,rate_clause,maturity_call_price,guarantor,guarantee_type,issue_rating,newest_rating,
      rating_company,source_id,raw_payload,source_updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,now())
     ON CONFLICT(instrument_id) DO UPDATE SET stock_instrument_id=EXCLUDED.stock_instrument_id,bond_full_name=EXCLUDED.bond_full_name,
      bond_short_name=EXCLUDED.bond_short_name,cb_type=EXCLUDED.cb_type,par_value=EXCLUDED.par_value,issue_price=EXCLUDED.issue_price,
      issue_size=EXCLUDED.issue_size,remain_size=EXCLUDED.remain_size,value_date=EXCLUDED.value_date,maturity_date=EXCLUDED.maturity_date,
      conv_start_date=EXCLUDED.conv_start_date,conv_end_date=EXCLUDED.conv_end_date,conv_stop_date=EXCLUDED.conv_stop_date,
      first_conv_price=EXCLUDED.first_conv_price,current_conv_price=EXCLUDED.current_conv_price,coupon_rate=EXCLUDED.coupon_rate,
      add_rate=EXCLUDED.add_rate,pay_per_year=EXCLUDED.pay_per_year,rate_type=EXCLUDED.rate_type,rate_clause=EXCLUDED.rate_clause,
      maturity_call_price=EXCLUDED.maturity_call_price,guarantor=EXCLUDED.guarantor,guarantee_type=EXCLUDED.guarantee_type,
      issue_rating=EXCLUDED.issue_rating,newest_rating=EXCLUDED.newest_rating,rating_company=EXCLUDED.rating_company,
      raw_payload=EXCLUDED.raw_payload || jsonb_build_object(
        'prospectus_source_url',COALESCE(fundamental.convertible_bond_profiles.raw_payload->>'prospectus_source_url',''),
        'prospectus_source_title',COALESCE(fundamental.convertible_bond_profiles.raw_payload->>'prospectus_source_title',''),
        'prospectus_parser_version',COALESCE(fundamental.convertible_bond_profiles.raw_payload->>'prospectus_parser_version','')
      ),source_updated_at=now(),updated_at=now()`,
    [bondId, stockId, profile.bond_full_name || '', profile.bond_short_name || '', profile.cb_type || 'CB', finite(profile.par),
      finite(profile.issue_price), finite(profile.issue_size), finite(profile.remain_size), isoDate(profile.value_date), isoDate(profile.maturity_date),
      isoDate(profile.conv_start_date), isoDate(profile.conv_end_date), isoDate(profile.conv_stop_date), finite(profile.first_conv_price),
      finite(profile.conv_price), finite(profile.coupon_rate), finite(profile.add_rate), finite(profile.pay_per_year), profile.rate_type || '',
      profile.rate_clause || '', profile.maturity_call_price || '', profile.guarantor || '', profile.guarantee_type || '',
      profile.issue_rating || '', profile.newest_rating || '', profile.rating_comp || '', sources.tushare, JSON.stringify(profile)]
  );
  await saveTerms(client, bondId, profile, sources.tushare);
  return { bondId, stockId };
}

async function saveIssueFacts(client, issue, instrumentId, sourceId, runId = null, listingDate = null) {
  if (!issue || !instrumentId) return;
  const payload = JSON.stringify(issue);
  if (runId) {
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    await client.query(
      `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
       VALUES($1,$2,'cb_issue',$3,$4::jsonb,$5)
       ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,
      [runId, sourceId, `tushare:cb_issue:${issue.ts_code || instrumentId}`, payload, hash]
    );
  }
  await client.query(
    `INSERT INTO fundamental.convertible_bond_issuance
       (instrument_id,issue_type,issue_price_yuan,issue_size_100m_yuan,
        shareholder_allotment_ratio_yuan_per_share,online_size_100m_yuan,
        offline_size_100m_yuan,online_purchase_accounts_10k,shareholder_allotment_quantity,
        source_id,source_updated_at,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11::jsonb)
     ON CONFLICT(instrument_id) DO UPDATE SET
       issue_type=COALESCE(EXCLUDED.issue_type,fundamental.convertible_bond_issuance.issue_type),
       issue_price_yuan=COALESCE(EXCLUDED.issue_price_yuan,fundamental.convertible_bond_issuance.issue_price_yuan),
       issue_size_100m_yuan=COALESCE(EXCLUDED.issue_size_100m_yuan,fundamental.convertible_bond_issuance.issue_size_100m_yuan),
       shareholder_allotment_ratio_yuan_per_share=COALESCE(EXCLUDED.shareholder_allotment_ratio_yuan_per_share,fundamental.convertible_bond_issuance.shareholder_allotment_ratio_yuan_per_share),
       online_size_100m_yuan=COALESCE(EXCLUDED.online_size_100m_yuan,fundamental.convertible_bond_issuance.online_size_100m_yuan),
       offline_size_100m_yuan=COALESCE(EXCLUDED.offline_size_100m_yuan,fundamental.convertible_bond_issuance.offline_size_100m_yuan),
       online_purchase_accounts_10k=COALESCE(EXCLUDED.online_purchase_accounts_10k,fundamental.convertible_bond_issuance.online_purchase_accounts_10k),
       shareholder_allotment_quantity=COALESCE(EXCLUDED.shareholder_allotment_quantity,fundamental.convertible_bond_issuance.shareholder_allotment_quantity),
       source_updated_at=EXCLUDED.source_updated_at,raw_payload=EXCLUDED.raw_payload,updated_at=now()`,
    [instrumentId, issue.issue_type || null, finite(issue.issue_price), issueSize100m(issue.issue_size),
      finite(issue.shd_ration_ratio), finite(issue.onl_size) == null ? null : finite(issue.onl_size) / 1000000,
      finite(issue.offl_size) == null ? null : finite(issue.offl_size) / 1000000,
      finite(issue.onl_pch_num) == null ? null : finite(issue.onl_pch_num) / 10000,
      finite(issue.shd_ration_size), sourceId, payload]
  );
  const events = [
    ['issue_announcement', issue.ann_date],
    ['shareholder_record', issue.shd_ration_record_date],
    ['online_subscription', issue.onl_date],
    ['result_announcement', issue.res_ann_date],
    ['listing', listingDate],
  ];
  for (const [eventType, value] of events) {
    const eventDate = isoDate(value);
    if (!eventDate) continue;
    await client.query(
      `INSERT INTO event.instrument_events(instrument_id,event_type,event_date,source_id,source_key,details,source_updated_at)
       VALUES($1,$2,$3::date,$4,$5,$6::jsonb,now())
       ON CONFLICT(instrument_id,event_type,event_date) DO UPDATE SET
         source_id=EXCLUDED.source_id,source_key=EXCLUDED.source_key,
         details=EXCLUDED.details,source_updated_at=now(),updated_at=now()`,
      [instrumentId, eventType, eventDate, sourceId,
        `tushare:cb_issue:${issue.ts_code || instrumentId}:${eventType}:${eventDate}`, payload]
    );
  }
}

async function saveDailyBar(client, instrumentId, row, sourceId) {
  if (!row || !row.trade_date || finite(row.close) == null) return;
  await client.query(
    `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
       close=EXCLUDED.close,volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`,
    [instrumentId, isoDate(row.trade_date), sourceId, finite(row.open), finite(row.high), finite(row.low), finite(row.close), finite(row.vol), finite(row.amount)]
  );
}

async function saveRatingHistory(client, instrumentId, rows, sourceId) {
  for (const row of rows || []) {
    if (!row.rating_date) continue;
    await client.query(
      `INSERT INTO fundamental.convertible_bond_ratings
       (instrument_id,rating_date,announced_at,rating_company,rating_method,rating_type,rating,rating_outlook,source_id,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT(instrument_id,rating_date,rating_company) DO UPDATE SET announced_at=EXCLUDED.announced_at,
         rating=EXCLUDED.rating,
         rating_outlook=COALESCE(NULLIF(EXCLUDED.rating_outlook,''),fundamental.convertible_bond_ratings.rating_outlook),
         raw_payload=fundamental.convertible_bond_ratings.raw_payload || EXCLUDED.raw_payload`,
      [instrumentId, isoDate(row.rating_date), isoDate(row.ann_date), row.rating_com_name || '', row.rating_way || '',
        row.rating_type || '', row.rating || '', row.rating_outlook || '', sourceId, JSON.stringify(row)]
    );
  }
}

// 评级历史自动补齐：找出评级表里还没有记录的可转债，逐只从 Tushare cb_rating 拉全量历史写入。
// 每日同步的一环（cb_rating 无法批量拉取，只能逐只传 ts_code）；幂等 upsert，失败只跳过该只不影响主同步。
async function backfillMissingRatings(reason = 'scheduled') {
  const { rows: missing } = await pool.query(`
    SELECT i.instrument_id, i.canonical_code
      FROM core.instruments i
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
      LEFT JOIN (SELECT DISTINCT instrument_id FROM fundamental.convertible_bond_ratings) r
             ON r.instrument_id = i.instrument_id
     WHERE p.cb_type IN ('CB', '')
       AND r.instrument_id IS NULL
     ORDER BY i.canonical_code`);
  if (!missing.length) return { skipped: true, reason: 'no_missing' };
  const sources = await sourceIds();
  const client = await pool.connect();
  let filled = 0;
  let failed = 0;
  try {
    await client.query('BEGIN');
    for (const bond of missing) {
      try {
        const data = await tushareQuery('cb_rating', { ts_code: bond.canonical_code },
          'ts_code,ann_date,rating_date,rating_com_name,rating_way,rating_type,rating,rating_outlook');
        const rows = tsRows(data);
        if (!rows.length) { failed += 1; continue; }
        await saveRatingHistory(client, bond.instrument_id, rows, sources.tushare);
        filled += 1;
      } catch (error) {
        failed += 1;
        if (reason !== 'scheduled') console.warn(`[ratings] ${bond.canonical_code} 拉取失败: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 150)); // 限流缓冲
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  console.log(`[ratings] 评级补齐完成：新增 ${filled} 只，无数据/失败 ${failed} 只（reason=${reason}）`);
  return { ok: true, filled, failed };
}

async function savePriceChanges(client, instrumentId, rows, sourceId) {
  for (const original of rows || []) {
    const row = normalizePriceChange(original);
    if (!row.change_date) continue;
    await client.query(
      `INSERT INTO fundamental.convertible_bond_price_changes
       (instrument_id,publish_date,change_date,initial_price,price_before,price_after,reason,source_id,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT(instrument_id,change_date) DO UPDATE SET publish_date=EXCLUDED.publish_date,price_before=EXCLUDED.price_before,
         price_after=EXCLUDED.price_after,reason=COALESCE(EXCLUDED.reason,fundamental.convertible_bond_price_changes.reason),
         raw_payload=fundamental.convertible_bond_price_changes.raw_payload || EXCLUDED.raw_payload`,
      [instrumentId, isoDate(row.publish_date) || '0001-01-01', isoDate(row.change_date), finite(row.convert_price_initial),
        finite(row.convertprice_bef), finite(row.convertprice_aft), row.reason || null, sourceId, JSON.stringify(row)]
    );
  }
}

async function saveCouponSchedule(client, instrumentId, rows, sourceId) {
  const sorted = (rows || []).slice().sort((a,b) => String(a.rate_start_date).localeCompare(String(b.rate_start_date)));
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index];
    const rate = finite(row.coupon_rate);
    await client.query(
      `INSERT INTO fundamental.convertible_bond_coupon_schedule
       (instrument_id,interest_year,coupon_rate,pay_date,pre_tax_interest,after_tax_interest,source_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(instrument_id,interest_year) DO UPDATE SET coupon_rate=EXCLUDED.coupon_rate,pay_date=EXCLUDED.pay_date,
         pre_tax_interest=EXCLUDED.pre_tax_interest,after_tax_interest=EXCLUDED.after_tax_interest,updated_at=now()`,
      [instrumentId, index + 1, rate, isoDate(row.rate_end_date), rate, rate == null ? null : rate * 0.8, sourceId]
    );
  }
}

async function saveFundHolding(client, instrumentId, rows, sourceId) {
  if (!rows || !rows.length) return;
  const latestDate = rows.map(row => String(row.end_date || '')).sort().reverse()[0];
  const latest = rows.filter(row => String(row.end_date) === latestDate);
  const funds = latest.filter(row => /基金|养老金|年金|社保|资产管理计划|集合资产管理/.test(String(row.holder_name || '')));
  if (!latestDate || !funds.length) return;
  const quantity = funds.reduce((sum,row) => sum + (finite(row.hold_amount) || 0), 0);
  const ratio = funds.reduce((sum,row) => sum + (finite(row.hold_ratio) || 0), 0) / 100;
  await client.query(
    `INSERT INTO fundamental.convertible_bond_fund_holdings
     (instrument_id,report_date,fund_count,holding_quantity,holding_market_value,remain_size_ratio,source_id,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT(instrument_id,report_date) DO UPDATE SET fund_count=EXCLUDED.fund_count,holding_quantity=EXCLUDED.holding_quantity,
       holding_market_value=EXCLUDED.holding_market_value,remain_size_ratio=EXCLUDED.remain_size_ratio,raw_payload=EXCLUDED.raw_payload` ,
    [instrumentId, isoDate(latestDate), funds.length, quantity, quantity * 100, ratio, sourceId, JSON.stringify(funds)]
  );
}

function reportPeriod(title) {
  const match = String(title || '').match(/(20\d{2})\s*年\s*(半年度|年度)报告/);
  if (!match) return null;
  return `${match[1]}-${match[2] === '半年度' ? '06-30' : '12-31'}`;
}

function latestFullReport(events) {
  return (events || [])
    .filter(event => reportPeriod(event.title) && event.url && !/摘要|英文|更正|取消/.test(String(event.title || '')))
    .sort((a, b) => reportPeriod(b.title).localeCompare(reportPeriod(a.title)))[0] || null;
}

function pythonCandidates() {
  const root = path.resolve(__dirname, '..', '..');
  const venv = process.platform === 'win32'
    ? path.join(root, 'venv', 'Scripts', 'python.exe')
    : path.join(root, 'venv', 'bin', 'python');
  return [process.env.IPO_PYTHON_PATH, fs.existsSync(venv) ? venv : null,
    process.platform === 'win32' ? 'py' : 'python3', 'python'].filter(Boolean);
}

function runHoldingExtractor(executable, url) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondFundHoldings.py');
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', script, url] : [script, url];
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || `基金持仓提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('基金持仓提取结果格式错误')); }
    });
  });
}

async function extractReportFundHolding(events) {
  const report = latestFullReport(events);
  if (!report) return null;
  let lastError;
  for (const executable of pythonCandidates()) {
    try {
      const result = await runHoldingExtractor(executable, report.url);
      if (!result || !result.fund_count) return null;
      return Object.assign(result, { report_date: reportPeriod(report.title), report_title: report.title, source_url: report.url });
    } catch (error) { lastError = error; }
  }
  if (lastError) console.warn('[convertible-bond] 最近报告基金持仓提取失败:', lastError.message);
  return null;
}

function runPriceHistoryExtractor(executable, url, initialPrice, bondName) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondPriceHistory.py');
  const scriptArgs = [script, url];
  if (finite(initialPrice) != null) scriptArgs.push('--initial-price', String(finite(initialPrice)));
  if (bondName) scriptArgs.push('--bond-name', String(bondName));
  const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', ...scriptArgs] : scriptArgs;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || `定期报告转股价历史提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('定期报告转股价历史格式错误')); }
    });
  });
}

async function extractReportPriceHistory(events, initialPrice, bondName, cachedReportUrl, cachedParserVersion) {
  const report = latestFullReport(events);
  if (!report || (report.url === cachedReportUrl && cachedParserVersion === '9')) return null;
  let lastError;
  for (const executable of pythonCandidates()) {
    try {
      const result = await runPriceHistoryExtractor(executable, report.url, initialPrice, bondName);
      if (!result || (!(result.price_changes || []).length && !result.rating_outlook)) return null;
      return Object.assign(result, { report_title: report.title });
    } catch (error) { lastError = error; }
  }
  if (lastError) console.warn('[convertible-bond] 定期报告转股价历史提取失败:', lastError.message);
  return null;
}

function runRatingExtractor(executable, event) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondRating.py');
  const scriptArgs = [script, event.url, '--announcement-date', isoDate(event.event_date)];
  const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', ...scriptArgs] : scriptArgs;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || `评级报告提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('评级报告提取结果格式错误')); }
    });
  });
}

async function extractRatingOutlooks(events, cachedUrls) {
  const reports = (events || []).filter(event => /评级报告|评级调整/.test(String(event.title || '')) && event.url && !cachedUrls.has(event.url));
  const results = [];
  for (const event of reports) {
    for (const executable of pythonCandidates()) {
      try {
        const result = await runRatingExtractor(executable, event);
        if (result && result.rating_outlook) results.push(result);
        break;
      } catch (_) { /* 尝试下一个本机 Python */ }
    }
  }
  return results;
}

async function saveRatingOutlooks(client, instrumentId, rows) {
  for (const row of rows || []) {
    await client.query(
      `UPDATE fundamental.convertible_bond_ratings SET rating_outlook=$3,
         raw_payload=raw_payload || jsonb_build_object('outlook_source_url',$4::text)
       WHERE instrument_id=$1 AND rating_date=(
         SELECT rating_date FROM fundamental.convertible_bond_ratings
          WHERE instrument_id=$1 AND ABS(rating_date-$2::date)<=15
            AND ($5::text IS NULL OR rating=$5 OR COALESCE(rating,'')='')
          ORDER BY ABS(rating_date-$2::date) LIMIT 1)`,
      [instrumentId, isoDate(row.rating_date), row.rating_outlook, row.source_url, row.rating || null]
    );
  }
  await client.query(
    `WITH matches AS (
       SELECT target.ctid AS row_id,
         source.rating_date AS source_date,source.rating_outlook,source.raw_payload
       FROM fundamental.convertible_bond_ratings target
       CROSS JOIN LATERAL (
         SELECT candidate.rating_date,candidate.rating_outlook,candidate.raw_payload
           FROM fundamental.convertible_bond_ratings candidate
          WHERE candidate.instrument_id=target.instrument_id AND candidate.rating=target.rating
            AND COALESCE(candidate.rating_outlook,'')<>''
          ORDER BY ABS(candidate.rating_date-target.rating_date) LIMIT 1
       ) source
       WHERE target.instrument_id=$1 AND COALESCE(target.rating_outlook,'')=''
     )
     UPDATE fundamental.convertible_bond_ratings target SET
       rating_outlook=matches.rating_outlook,
       raw_payload=target.raw_payload || jsonb_build_object(
         'outlook_source_url',matches.raw_payload->>'outlook_source_url',
         'outlook_inferred_from_date',matches.source_date::text)
     FROM matches WHERE target.ctid=matches.row_id`,
    [instrumentId]
  );
}

async function saveReportFundHolding(client, instrumentId, holding, sourceId) {
  if (!holding || !holding.report_date || !holding.fund_count) return;
  await client.query(
    `INSERT INTO fundamental.convertible_bond_fund_holdings
     (instrument_id,report_date,fund_count,holding_quantity,holding_market_value,remain_size_ratio,source_id,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT(instrument_id,report_date) DO UPDATE SET fund_count=EXCLUDED.fund_count,holding_quantity=EXCLUDED.holding_quantity,
       holding_market_value=EXCLUDED.holding_market_value,remain_size_ratio=EXCLUDED.remain_size_ratio,source_id=EXCLUDED.source_id,
       raw_payload=EXCLUDED.raw_payload`,
    [instrumentId, holding.report_date, holding.fund_count, holding.holding_quantity, holding.holding_market_value,
      holding.remain_size_ratio, sourceId, JSON.stringify(holding)]
  );
}

function latestProspectus(events) {
  return (events || [])
    .filter(event => /可转换公司债券募集说明书$/.test(String(event.title || '')) && event.url && !/摘要/.test(event.title))
    .sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)))[0] || null;
}

function runProspectusExtractor(executable, url) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondProspectus.py');
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', script, url] : [script, url];
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || `募集说明书提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('募集说明书提取结果格式错误')); }
    });
  });
}

async function extractProspectusDetails(events) {
  const prospectus = latestProspectus(events);
  if (!prospectus) return null;
  let lastError;
  for (const executable of pythonCandidates()) {
    try {
      const result = await runProspectusExtractor(executable, prospectus.url);
      return Object.assign(result || {}, { source_url: prospectus.url, source_title: prospectus.title });
    } catch (error) { lastError = error; }
  }
  if (lastError) console.warn('[convertible-bond] 募集说明书提取失败:', lastError.message);
  return null;
}

function runNoRevisionExtractor(executable, events) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondNoRevision.py');
  return new Promise((resolve, reject) => {
    const urls = events.map(event => event.url);
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', script, ...urls] : [script, ...urls];
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || `不下修公告提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('不下修公告提取结果格式错误')); }
    });
  });
}

async function extractNoRevisionPeriods(events, cachedRows) {
  const cached = new Map((cachedRows || []).map(row => [isoDate(row.announced_at), row]));
  const candidates = (events || []).filter(event => revisionDecision(event.title) === 'no_revision' && event.url &&
    (cached.get(isoDate(event.event_date)) || {}).parser_version !== '3').slice(0, 10);
  if (candidates.length) {
    let extracted = null;
    let lastError = null;
    for (const executable of pythonCandidates()) {
      try { extracted = await runNoRevisionExtractor(executable, candidates); break; } catch (error) { lastError = error; }
    }
    if (!extracted) throw lastError || new Error('不下修公告提取失败');
    for (const item of extracted || []) {
      const event = candidates.find(candidate => candidate.url === item.source_url);
      if (item.lock_declared && !item.next_eligible_date) {
        throw new Error(`不下修期限解析失败：${event ? event.title : item.source_url}`);
      }
      if (event) cached.set(isoDate(event.event_date), Object.assign(item, { announced_at: isoDate(event.event_date) }));
    }
  }
  return [...cached.values()].sort((a,b) => String(b.announced_at).localeCompare(String(a.announced_at)));
}

function runPriceChangeExtractor(executable, events) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondPriceChange.py');
  return new Promise((resolve, reject) => {
    const urls = events.map(event => event.url);
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', script, ...urls] : [script, ...urls];
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || `转股价格公告提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('转股价格公告提取结果格式错误')); }
    });
  });
}

async function extractPriceChangeDetails(events, cachedRows) {
  const cachedUrls = new Set((cachedRows || []).filter(row => finite(row.price_after) != null && row.source_url && row.parser_version === '3').map(row => row.source_url));
  const candidates = (events || []).filter(event => ['revised','adjusted'].includes(revisionDecision(event.title)) &&
    event.url && !cachedUrls.has(event.url)).slice(0, 10);
  if (!candidates.length) return [];
  for (const executable of pythonCandidates()) {
    try {
      const extracted = await runPriceChangeExtractor(executable, candidates);
      return (extracted || []).map(item => Object.assign(item, { event: candidates.find(candidate => candidate.url === item.source_url) }));
    } catch (_) { /* try next interpreter */ }
  }
  return [];
}

async function saveProspectusDetails(client, instrumentId, profile, details, sourceId) {
  if (!details) return;
  if (details.fundraising_purpose) {
    await client.query(
      `UPDATE fundamental.convertible_bond_profiles SET fundraising_purpose=$2,
       raw_payload=raw_payload || jsonb_build_object('prospectus_source_url',$3::text,'prospectus_source_title',$4::text,'prospectus_parser_version','4'),updated_at=now()
       WHERE instrument_id=$1`,
      [instrumentId, details.fundraising_purpose, details.source_url || '', details.source_title || '']
    );
  }
  for (const row of details.coupon_rates || []) {
    const interestYear = Number(row.interest_year), rate = finite(row.coupon_rate);
    if (!interestYear || rate == null) continue;
    const valueDate = isoDate(profile.value_date);
    const payDate = valueDate ? addYears(new Date(`${valueDate}T00:00:00+08:00`), interestYear) : null;
    const payDateText = payDate ? isoDate(payDate) : null;
    await client.query(
      `INSERT INTO fundamental.convertible_bond_coupon_schedule
       (instrument_id,interest_year,coupon_rate,pay_date,pre_tax_interest,after_tax_interest,source_id)
       VALUES($1,$2,$3::numeric,$4,$3::numeric,$5,$6)
       ON CONFLICT(instrument_id,interest_year) DO UPDATE SET coupon_rate=EXCLUDED.coupon_rate,pay_date=EXCLUDED.pay_date,
         pre_tax_interest=EXCLUDED.pre_tax_interest,after_tax_interest=EXCLUDED.after_tax_interest,source_id=EXCLUDED.source_id,updated_at=now()`,
      [instrumentId, interestYear, rate, payDateText, rate * 0.8, sourceId]
    );
  }
}

function announcementMatchesBond(event, profile) {
  const title = String(event.title || ''), name = String(profile.bond_short_name || '');
  const numbered = name.match(/^(.*)转\d+$/);
  if (numbered && title.includes(`${numbered[1]}转债`) && !title.includes(name)) return false;
  return (name && title.includes(name)) || title.includes(String(profile.ts_code || '').slice(0,6)) || /可转换公司债券|可转债|转债/.test(title);
}

function revisionDecision(title) {
  const text = String(title || '');
  if (/不向下修正|不下修|不修正.{0,12}转股价/.test(text)) return 'no_revision';
  if (/提议|建议|预计触发|可能触发|提示性|股东大会.*议案/.test(text)) return null;
  if (/向下修正.{0,30}转股价格|转股价格.{0,20}(?:向下修正结果|下修结果)/.test(text)) return 'revised';
  return /(?:可转换公司债券)?转股价格调整的公告|调整.{0,20}转股价格的公告/.test(text) ? 'adjusted' : null;
}

async function saveAnnouncementHistories(client, instrumentId, events, profile, sourceId, noRevisionPeriods = [], priceChangeDetails = []) {
  const matched = (events || []).filter(event => announcementMatchesBond(event, profile));
  const periodMap = new Map(noRevisionPeriods.map(row => [isoDate(row.announced_at), row]));
  const priceMap = new Map(priceChangeDetails.map(row => [row.source_url, row]));
  await client.query(
    `DELETE FROM fundamental.convertible_bond_price_changes
     WHERE instrument_id=$1 AND source_id=$2 AND reason ~ '(提议|预计触发|可能触发|提示性)'`,
    [instrumentId, sourceId]
  );
  for (const event of matched) {
    const title = String(event.title || ''), announced = isoDate(event.event_date);
    if (!announced) continue;
    const decision = revisionDecision(title);
    if (decision === 'no_revision') {
      const period = periodMap.get(announced) || {};
      await client.query(
        `INSERT INTO fundamental.convertible_bond_no_revision_history(instrument_id,announced_at,valid_until,next_eligible_date,summary,source_id,raw_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(instrument_id,announced_at) DO UPDATE SET valid_until=EXCLUDED.valid_until,
           next_eligible_date=EXCLUDED.next_eligible_date,summary=EXCLUDED.summary,raw_payload=EXCLUDED.raw_payload`,
        [instrumentId, announced, isoDate(period.valid_until), isoDate(period.next_eligible_date), title, sourceId,
          JSON.stringify(Object.assign({}, event, {
            lock_start_date: period.lock_start_date || null,
            lock_declared: Boolean(period.lock_declared),
            parser_version: period.parser_version || null,
          }))]
      );
    } else if (decision === 'revised' || decision === 'adjusted') {
      const detail = priceMap.get(event.url) || {};
      if (finite(detail.price_before) == null && finite(detail.price_after) == null) continue;
      const changeDate = isoDate(detail.change_date) || announced;
      await client.query(
        `INSERT INTO fundamental.convertible_bond_price_changes(instrument_id,publish_date,change_date,price_before,price_after,reason,source_id,raw_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(instrument_id,change_date) DO UPDATE SET publish_date=EXCLUDED.publish_date,
           price_before=COALESCE(EXCLUDED.price_before,fundamental.convertible_bond_price_changes.price_before),
           price_after=COALESCE(EXCLUDED.price_after,fundamental.convertible_bond_price_changes.price_after),reason=EXCLUDED.reason,raw_payload=EXCLUDED.raw_payload`,
        [instrumentId, announced, changeDate, finite(detail.price_before), finite(detail.price_after), title, sourceId,
          JSON.stringify(Object.assign({}, event, {
            revision_floor_price: finite(detail.revision_floor_price),
            price_change_parser_version: detail.parser_version || '3',
          }))]
      );
    }
  }
}

async function saveTriggerProgress(client, instrumentId, tradeDate, progresses) {
  for (const [type, progress] of Object.entries(progresses)) {
    await client.query(
      `INSERT INTO analytics.convertible_bond_trigger_daily
       (instrument_id,trade_date,trigger_type,trigger_price,close_price,matched_days,required_days,observation_days,status,formula_version,diagnostics)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT(instrument_id,trade_date,trigger_type,formula_version) DO UPDATE SET trigger_price=EXCLUDED.trigger_price,
         close_price=EXCLUDED.close_price,matched_days=EXCLUDED.matched_days,required_days=EXCLUDED.required_days,
         observation_days=EXCLUDED.observation_days,status=EXCLUDED.status,diagnostics=EXCLUDED.diagnostics,calculated_at=now()`,
      [instrumentId, isoDate(tradeDate), type, progress.trigger_price, progress.close_price, progress.matched_days,
        progress.required_days, progress.observation_days, progress.active === false ? 'not_active' : (progress.met ? 'met' : 'tracking'),
        FORMULA_VERSION, JSON.stringify(progress)]
    );
  }
}

async function latestTradeDates() {
  const end = tsDateStr(new Date());
  const start = addDays(new Date(), -20);
  const data = await tushareQuery('trade_cal', { exchange: 'SSE', start_date: tsDateStr(start), end_date: end, is_open: '1' }, 'cal_date,is_open');
  return tsRows(data).filter(row => String(row.is_open) === '1').map(row => row.cal_date).sort().reverse();
}

async function latestFullBondDaily(dates) {
  for (const tradeDate of dates.slice(0, 5)) {
    const data = await tushareQuery('cb_daily', { trade_date: tradeDate }, DAILY_FIELDS);
    const rows = tsRows(data);
    if (rows.length) return { tradeDate, rows };
  }
  return { tradeDate: null, rows: [] };
}

function activeProfile(row, today) {
  const listed = String(row && row.list_date || '').replace(/-/g, '');
  const delisted = String(row && row.delist_date || '').replace(/-/g, '');
  const maturity = String(row && row.maturity_date || '').replace(/-/g, '');
  const convertEnd = String(row && row.conv_end_date || '').replace(/-/g, '');
  const convertStop = String(row && row.conv_stop_date || '').replace(/-/g, '');
  return row && row.ts_code && BOND_PREFIX.test(String(row.ts_code).slice(0,6)) &&
    (!delisted || delisted > today) &&
    (!maturity || maturity >= today) && (!convertEnd || convertEnd >= today) &&
    (!convertStop || convertStop > today);
}

function runBondFirstDayBackfill(executable) {
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py'
      ? ['-3', BOND_FIRSTDAY_SCRIPT]
      : [BOND_FIRSTDAY_SCRIPT];
    const child = spawn(executable, args, {
      cwd: path.resolve(__dirname, '..', '..'),
      env: Object.assign({}, process.env, { PYTHONUTF8: '1' }),
      windowsHide: true,
    });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 25 * 60 * 1000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || output || `新债上市表现补全失败（${code}）`));
      const line = output.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
      try { resolve(JSON.parse(line)); }
      catch (_) { reject(new Error(`新债上市表现补全结果格式错误: ${line.slice(0, 300)}`)); }
    });
  });
}

function runBondIssueResultBackfill(executable) {
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py'
      ? ['-3', BOND_ISSUE_RESULT_SCRIPT]
      : [BOND_ISSUE_RESULT_SCRIPT];
    const limit = String(process.env.IPO_BOND_ISSUE_RESULT_LIMIT || '20');
    const child = spawn(executable, [...args, '--limit', limit], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: Object.assign({}, process.env, { PYTHONUTF8: '1' }),
      windowsHide: true,
    });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 25 * 60 * 1000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || output || `新债发行结果补全失败（${code}）`));
      const line = output.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      const match = line.match(/update=(\d+)\s+skip=(\d+)\s+fail=(\d+)/);
      if (!match) return reject(new Error(`新债发行结果补全结果格式错误: ${line.slice(0, 300)}`));
      resolve({ updated: Number(match[1]), skipped: Number(match[2]), failed: Number(match[3]), limit: Number(limit) });
    });
  });
}

async function backfillBondFirstDayPerformance(reason = 'scheduled') {
  if (!fs.existsSync(BOND_FIRSTDAY_SCRIPT)) return { ok: false, skipped: true, reason: 'script_missing' };
  const errors = [];
  for (const executable of pythonCandidates()) {
    try {
      const result = await runBondFirstDayBackfill(executable);
      return { ...result, reason };
    } catch (error) {
      errors.push(`${executable}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | ') || '未找到可用的 Python 解释器');
}

async function backfillBondIssueResults(reason = 'scheduled') {
  if (!fs.existsSync(BOND_ISSUE_RESULT_SCRIPT)) return { ok: false, skipped: true, reason: 'script_missing' };
  const errors = [];
  for (const executable of pythonCandidates()) {
    try {
      const result = await runBondIssueResultBackfill(executable);
      return { ...result, reason };
    } catch (error) {
      errors.push(`${executable}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | ') || '未找到可用的 Python 解释器');
}

function recentIssueCandidate(row, today = isoDate(new Date())) {
  const dates = [row && row.ann_date, row && row.res_ann_date, row && row.onl_date]
    .map(isoDate).filter(Boolean).sort();
  if (!dates.length) return false;
  const start = new Date(`${today}T00:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() - 365);
  const startDate = isoDate(start);
  return dates[dates.length - 1] >= startDate;
}

function convertibleBondIssueSyncWindow(lastSuccessDate, today = isoDate(new Date())) {
  const endDate = isoDate(today);
  const cursorDate = isoDate(lastSuccessDate);
  if (!cursorDate) return { incremental: false, startDate: null, endDate };
  return {
    incremental: true,
    startDate: isoDate(addDays(new Date(`${cursorDate}T00:00:00+08:00`), -60)),
    endDate,
  };
}

function shouldAdvanceConvertibleBondIssueCursor(issueRows, incremental) {
  return !incremental || (Array.isArray(issueRows) && issueRows.length > 0);
}

// 转股价发生变动时的定点处理：登记数据问题 + 只对这几只补取转股价公告
async function handleConvPriceChanges(changes, sourceId) {
  for (const change of changes) {
    await recordQualityIssue({
      instrumentId: change.instrument_id,
      datasetCode: 'cb_basic',
      fieldCode: 'conv_price',
      issueType: 'snapshot_input_mismatch',
      details: { ts_code: change.ts_code, before: change.before, after: change.after, detected_by: 'daily_universe_sync' },
    });
    try {
      const rows = tsRows(await tushareQuery('cb_price_chg', { ts_code: change.ts_code },
        'ts_code,bond_short_name,publish_date,change_date,convert_price_initial,convertprice_bef,convertprice_aft'));
      if (rows.length) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await savePriceChanges(client, change.instrument_id, rows, sourceId);
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
        finally { client.release(); }
      }
    } catch (e) {
      console.warn(`[主同步] ${change.ts_code} 转股价公告补取失败：${e.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 150)); // 限流缓冲
  }
}

async function syncConvertibleBondUniverse(reason = 'scheduled') {
  const claimed = await tryClaimJob('convertible_bond_universe_refresh');
  if (!claimed) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun('convertible_bond_universe_refresh');
  try {
    const issueCursorMap = await getDatasetCursors('convertible_bond_universe', ['cb_issue']);
    const issueWindow = convertibleBondIssueSyncWindow(issueCursorMap.get('cb_issue')?.last_success_date);
    const issueParams = issueWindow.incremental
      ? { start_date: issueWindow.startDate.replace(/-/g, ''), end_date: issueWindow.endDate.replace(/-/g, '') }
      : {};
    const [basicData, issueData, dates] = await Promise.all([
      tushareQuery('cb_basic', {}, PROFILE_FIELDS),
      tushareQuery('cb_issue', issueParams, ISSUE_FIELDS),
      latestTradeDates(),
    ]);
    const allBasicRows = tsRows(basicData);
    const today = tsDateStr(new Date());
    const basics = allBasicRows.filter(row => activeProfile(row, today));
    if (!basics.length) throw new Error('Tushare 可转债基础数据为空，保留上一份数据');
    const issueRows = tsRows(issueData);
    if (!issueRows.length && !issueWindow.incremental) throw new Error('Tushare 可转债发行数据为空，保留上一份数据');
    const profileMap = new Map(basics.map(row => [row.ts_code, row]));
    const allBasicCodes = new Set(allBasicRows.map(row => row.ts_code));
    for (const issue of issueRows) {
      if (!profileMap.has(issue.ts_code) && !allBasicCodes.has(issue.ts_code) && recentIssueCandidate(issue, today)) {
        profileMap.set(issue.ts_code, {
          ts_code: issue.ts_code,
          bond_short_name: issue.onl_name || issue.ts_code,
          bond_full_name: issue.onl_name || issue.ts_code,
          cb_type: 'CB',
        });
      }
    }
    const profiles = [...profileMap.values()];
    const daily = await latestFullBondDaily(dates);
    if (!daily.rows.length) throw new Error('Tushare 可转债行情为空，保留上一份数据');
    const [stockDailyData, stockValuationData] = await Promise.all([
      tushareQuery('daily', { trade_date: daily.tradeDate }, 'ts_code,trade_date,open,high,low,close,vol,amount'),
      tushareQuery('daily_basic', { trade_date: daily.tradeDate }, 'ts_code,trade_date,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv'),
    ]);
    const activeCodes = new Set(basics.map(row => row.ts_code));
    const activeDailyRows = daily.rows.filter(row => activeCodes.has(row.ts_code));
    const dailyMap = new Map(activeDailyRows.map(row => [row.ts_code, row]));
    const stockDailyRows = tsRows(stockDailyData);
    const stockValuationRows = tsRows(stockValuationData);
    const client = await pool.connect();
    let saved = 0;
    let tushareSourceId = null;
    const convPriceChanges = [];
    try {
      await client.query('BEGIN');
      const sources = await sourceIds(client);
      tushareSourceId = sources.tushare;
      const issueMap = new Map(issueRows.map(row => [row.ts_code, row]));
      const ingestion = await client.query(
        `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
         VALUES($1,'cb_issue',$2::jsonb,'running') RETURNING run_id`,
        [sources.tushare, JSON.stringify(issueWindow)]
      );
      const ingestionRunId = ingestion.rows[0].run_id;

      // 保存前先记下现有转股价，用来识别本轮发生转股价变动的转债
      const prevConvPrice = new Map();
      const prevRows = await client.query(
        `SELECT i.canonical_code AS ts_code, p.current_conv_price
           FROM fundamental.convertible_bond_profiles p
           JOIN core.instruments i ON i.instrument_id = p.instrument_id`);
      for (const row of prevRows.rows) prevConvPrice.set(row.ts_code, finite(row.current_conv_price));

      const stockInstrumentMap = new Map();
      for (const profile of profiles) {
        const ids = await saveProfile(client, profile, sources, issueMap.get(profile.ts_code)?.onl_date);
        await saveIssueFacts(client, issueMap.get(profile.ts_code), ids.bondId, sources.tushare, ingestionRunId, profile.list_date);
        if (profile.stk_code && ids.stockId) stockInstrumentMap.set(profile.stk_code, ids.stockId);
        const quote = dailyMap.get(profile.ts_code);
        if (quote) await saveDailyBar(client, ids.bondId, quote, sources.tushare);
        const before = prevConvPrice.get(profile.ts_code);
        const after = finite(profile.conv_price);
        if (before != null && after != null && Math.abs(before - after) > CONV_PRICE_EPS) {
          convPriceChanges.push({ ts_code: profile.ts_code, instrument_id: ids.bondId, before, after });
        }
        saved += 1;
      }
      await saveFullStockMarketPartition(client, stockInstrumentMap, stockDailyRows, stockValuationRows, sources.tushare);
      await client.query(
        `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count)
         VALUES('convertible_bond_universe','cb_basic_cb_daily',$1,now(),now(),'',0)
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,
           last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`,
        [isoDate(daily.tradeDate)]
      );
      if (shouldAdvanceConvertibleBondIssueCursor(issueRows, issueWindow.incremental)) {
        await client.query(
          `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count)
           VALUES('convertible_bond_universe','cb_issue',$1,now(),now(),'',0)
           ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,
             last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`,
          [issueWindow.endDate]
        );
      }
      await client.query(
        `UPDATE ops.ingestion_runs SET status='success',row_count=$2,finished_at=now() WHERE run_id=$1`,
        [ingestionRunId, issueMap.size]
      );
      await client.query('COMMIT');
      console.log(`[主同步] 可转债全量同步已提交（${saved} 只，行情日期 ${daily.tradeDate}）`);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    // 转股价变动的转债：记数据问题 + 定点补取转股价公告（旧快照由新鲜度判定自动标记为需刷新）
    if (convPriceChanges.length) {
      console.log(`[主同步] 检测到 ${convPriceChanges.length} 只转债转股价变动：${convPriceChanges.map(c => c.ts_code).join(',')}`);
      await handleConvPriceChanges(convPriceChanges, tushareSourceId);
    }
    // 评级历史自动补齐（独立事务，失败不影响主同步；缺评级的转债逐只从 Tushare 拉取）
    try { await backfillMissingRatings(reason); }
    catch (ratingErr) { console.warn('[ratings] 评级补齐失败（不影响主同步）:', ratingErr.message); }
    let listingPerformance = { ok: true, skipped: true, reason: 'no_pending_candidates' };
    try {
      listingPerformance = await backfillBondFirstDayPerformance(reason);
      console.log(`[上市表现] 本批尝试${listingPerformance.attempted || 0}，更新${listingPerformance.updated || 0}，剩余${listingPerformance.remaining || 0}`);
    } catch (performanceErr) {
      listingPerformance = { ok: false, error: performanceErr.message };
      console.warn('[上市表现] 自动补全失败（不影响主同步）:', performanceErr.message);
    }
    let issueResults = { ok: true, skipped: true, reason: 'no_pending_candidates' };
    try {
      issueResults = await backfillBondIssueResults(reason);
      console.log(`[发行结果] 本批尝试${(issueResults.updated || 0) + (issueResults.skipped || 0)}，更新${issueResults.updated || 0}，失败${issueResults.failed || 0}`);
    } catch (issueErr) {
      issueResults = { ok: false, error: issueErr.message };
      console.warn('[发行结果] 自动补全失败（不影响主同步）:', issueErr.message);
    }
    // 可转债周期：主同步提交后，用独立事务计算（周期失败只影响周期数据，不影响主同步）
    const cycleClient = await pool.connect();
    try {
      await cycleClient.query('BEGIN');
      const cyc = await cycleService.processCycleDay(daily.tradeDate, activeDailyRows, { sourceId: tushareSourceId, client: cycleClient });
      await cycleClient.query('COMMIT');
      if (cyc.stored) console.log(`[cycle] 当日周期指标已发布（${daily.tradeDate}）`);
      else console.warn(`[cycle] 当日未发布周期指标（${daily.tradeDate}，原因：${cyc.reason}）`);
    } catch (cycErr) {
      await cycleClient.query('ROLLBACK').catch(() => {});
      console.warn('[cycle] 当日周期计算失败（不影响主同步）：', cycErr.message);
    } finally { cycleClient.release(); }
    await finishJobRun(runId, true, `${reason}：同步 ${saved} 只，行情日期 ${daily.tradeDate}，上市表现 ${listingPerformance.updated || 0} 只`);
    return { skipped: false, count: saved, trade_date: isoDate(daily.tradeDate), listing_performance: listingPerformance, issue_results: issueResults };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally { await releaseJob('convertible_bond_universe_refresh'); }
}

// 扫描最近窗口内的开市日（按时间正序），用于检测空缺
async function getRecentOpenDays(days = 90) {
  const end = tsDateStr(new Date());
  const start = tsDateStr(addDays(new Date(), -days));
  const data = await tushareQuery('trade_cal', { exchange: 'SSE', start_date: start, end_date: end, is_open: '1' }, 'cal_date,is_open');
  return tsRows(data).filter(row => String(row.is_open) === '1').map(row => row.cal_date).sort();
}

// 自动补齐历史空缺：主同步之后调用，扫描游标之前（含游标当天）窗口内「事实表缺失/坏数据」的交易日，逐日重算周期指标。
// 无空缺时几乎零开销（一次 SQL 扫描）。windowDays 控制扫描范围：每日任务用默认 90 天足够，手动脚本可传更大值补全量历史。
async function backfillCycleGaps({ windowDays = 90 } = {}) {
  const sourceId = await cycleService.getTushareSourceId();
  if (sourceId == null) { console.warn('[cycle-backfill] 未取得 tushare 数据源，跳过空缺补齐'); return; }
  const openDays = await getRecentOpenDays(windowDays);
  if (!openDays.length) return;
  // 主同步只覆盖最新完整分区，因此游标之后、最新日之前的中间交易日也必须扫描。
  const gaps = await cycleService.findGapDays(openDays);
  if (!gaps.length) return;
  console.log(`[cycle-backfill] 检测到 ${gaps.length} 个空缺日：${gaps.slice(0, 10).join(',')}${gaps.length > 10 ? '...' : ''}，开始补齐`);
  let gapFilled = 0;
  const client = await pool.connect();
  try {
    const instrumentRows = await client.query(
      `SELECT i.canonical_code, i.instrument_id
         FROM core.instruments i
         JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id`
    );
    const instrumentMap = new Map(instrumentRows.rows.map(row => [row.canonical_code, row.instrument_id]));
    for (const day of gaps) {
      try {
        const data = await tushareQuery('cb_daily', { trade_date: day }, DAILY_FIELDS);
        const rows = tsRows(data);
        if (!rows.length) continue;
        // 行情事实与周期结果分开提交：周期字段不完整时仍保留完整的日行情分区。
        await client.query('BEGIN');
        for (const quote of rows) {
          const bondId = instrumentMap.get(quote.ts_code);
          if (bondId) await saveDailyBar(client, bondId, quote, sourceId);
        }
        await client.query('COMMIT');

        await client.query('BEGIN');
        const res = await cycleService.processCycleDay(day, rows, { sourceId, client });
        if (res.failed) { await client.query('ROLLBACK'); console.warn(`[cycle-backfill] ${day} 数据异常，停止补齐：${res.reason}`); break; }
        await client.query('COMMIT');
        if (res.stored) gapFilled++;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.warn(`[cycle-backfill] ${day} 补齐失败，停止：${e.message}`);
        break;
      }
    }
  } finally { client.release(); }
  if (gapFilled > 0) {
    console.log(`[cycle-backfill] 已补 ${gapFilled} 个空缺日，按时间顺序重算滚动分位...`);
    const n = await cycleService.recomputePercentiles();
    console.log(`[cycle-backfill] 分位重算完成（${n} 天）`);
  }
}

// 每日主同步 + 自动补齐遗漏的交易日：某天任务失败或部署晚于点，下次运行时主同步更新最新日，backfill 顺手把漏的那天补上，不留永久缺口。
// backfillOpts 透传给 backfillCycleGaps（如手动脚本传 { windowDays: 4000 } 补全量历史）。
async function syncConvertibleBondUniverseWithBackfill(reason = 'scheduled', backfillOpts = {}) {
  const result = await syncConvertibleBondUniverse(reason);
  await backfillCycleGaps(backfillOpts);
  return result;
}

async function loadSafety(code) {
  const { rows } = await pool.query('SELECT data,source_updated_at FROM bond_safety_snapshots ORDER BY id DESC LIMIT 1');
  const snapshot = rows[0];
  if (!snapshot || !Array.isArray(snapshot.data)) return null;
  // 快照里 bond_code 可能带后缀（113049.SH）也可能不带（113049），传入的 code 也两种都有
  const codeStr = String(code || '');
  const codeBare = codeStr.split('.')[0];
  const candidates = codeStr === codeBare ? [codeStr] : [codeStr, codeBare];
  const item = snapshot.data.find(row => {
    const rowCode = String(row.bond_code || '');
    const rowBare = rowCode.split('.')[0];
    return candidates.includes(rowCode) || candidates.includes(rowBare);
  });
  return item ? Object.assign({ source_updated_at: snapshot.source_updated_at }, item) : null;
}

async function loadExtraData(instrumentId) {
  const [ratings, changes, noRevision, coupons, holdings] = await Promise.all([
    pool.query('SELECT rating_date,announced_at,rating_company,rating,rating_outlook FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1 ORDER BY rating_date DESC', [instrumentId]),
    pool.query("SELECT publish_date,change_date,initial_price,price_before,price_after,reason,COALESCE(raw_payload->>'url',raw_payload->>'source_url') AS source_url,(raw_payload->>'revision_floor_price')::numeric AS revision_floor_price FROM fundamental.convertible_bond_price_changes WHERE instrument_id=$1 ORDER BY change_date DESC", [instrumentId]),
    pool.query("SELECT announced_at,valid_until,next_eligible_date,summary,raw_payload->>'url' AS source_url FROM fundamental.convertible_bond_no_revision_history WHERE instrument_id=$1 ORDER BY announced_at DESC", [instrumentId]),
    pool.query('SELECT interest_year,coupon_rate,pay_date,pre_tax_interest,after_tax_interest FROM fundamental.convertible_bond_coupon_schedule WHERE instrument_id=$1 ORDER BY interest_year', [instrumentId]),
    pool.query('SELECT report_date,fund_count,holding_quantity,holding_market_value,remain_size_ratio FROM fundamental.convertible_bond_fund_holdings WHERE instrument_id=$1 ORDER BY report_date DESC LIMIT 1', [instrumentId]),
  ]);
  return { ratings: ratings.rows, price_changes: normalizePriceChanges(changes.rows), no_revision_history: noRevision.rows, coupons: coupons.rows, fund_holding: holdings.rows[0] || null };
}

async function latestFinancial(stockTsCode) {
  const { rows } = await pool.query('SELECT data FROM bond_safety_financial_cache WHERE ts_code=$1', [stockTsCode]);
  return rows[0] && rows[0].data || {};
}

async function loadProspectusCache(tsCode) {
  const { rows } = await pool.query(
    `SELECT p.fundraising_purpose,p.raw_payload->>'prospectus_source_url' AS source_url,
       p.raw_payload->>'prospectus_source_title' AS source_title,
       p.raw_payload->>'prospectus_parser_version' AS parser_version,
       p.raw_payload->>'price_history_report_url' AS price_history_report_url,
       p.raw_payload->>'price_history_parser_version' AS price_history_parser_version,
       (SELECT COUNT(*)::int FROM fundamental.convertible_bond_coupon_schedule c WHERE c.instrument_id=p.instrument_id) AS coupon_count
     FROM fundamental.convertible_bond_profiles p JOIN core.instruments i ON i.instrument_id=p.instrument_id
     WHERE i.canonical_code=$1`, [tsCode]
  );
  return rows[0] || { fundraising_purpose: '', coupon_count: 0 };
}

async function loadNoRevisionCache(tsCode) {
  const { rows } = await pool.query(
    `SELECT h.announced_at,h.valid_until,h.next_eligible_date,h.summary,
       h.raw_payload->>'parser_version' AS parser_version
     FROM fundamental.convertible_bond_no_revision_history h JOIN core.instruments i ON i.instrument_id=h.instrument_id
     WHERE i.canonical_code=$1 ORDER BY h.announced_at DESC`, [tsCode]
  );
  return rows;
}

async function loadPriceChangeCache(tsCode) {
  const { rows } = await pool.query(
    `SELECT h.change_date,h.price_before,h.price_after,COALESCE(h.raw_payload->>'url',h.raw_payload->>'source_url') AS source_url,
       h.raw_payload->>'price_change_parser_version' AS parser_version
     FROM fundamental.convertible_bond_price_changes h JOIN core.instruments i ON i.instrument_id=h.instrument_id
     WHERE i.canonical_code=$1 ORDER BY h.change_date DESC`, [tsCode]
  );
  return rows;
}

async function loadRatingSourceCache(tsCode) {
  const { rows } = await pool.query(
    `SELECT r.raw_payload->>'outlook_source_url' AS source_url,r.rating_outlook
       FROM fundamental.convertible_bond_ratings r JOIN core.instruments i ON i.instrument_id=r.instrument_id
      WHERE i.canonical_code=$1`, [tsCode]
  );
  return { urls: new Set(rows.map(row => row.source_url).filter(Boolean)), missing: !rows.length || rows.some(row => !String(row.rating_outlook || '').trim()) };
}

async function saveStockValuation(client, stockId, row, sourceId) {
  if (!row || !row.trade_date) return;
  if ([row.pe, row.pe_ttm, row.pb, row.dv_ttm, row.total_mv, row.circ_mv].every(value => finite(value) == null)) return;
  await client.query(
    `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET pe_static=EXCLUDED.pe_static,pe_ttm=EXCLUDED.pe_ttm,
       pb=EXCLUDED.pb,dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,total_market_cap=EXCLUDED.total_market_cap,
       circulating_market_cap=EXCLUDED.circulating_market_cap,ingested_at=now()`,
    [stockId, isoDate(row.trade_date), sourceId, finite(row.pe), finite(row.pe_ttm), finite(row.pb), finite(row.dv_ttm),
      finite(row.total_mv) == null ? null : finite(row.total_mv) * 10000,
      finite(row.circ_mv) == null ? null : finite(row.circ_mv) * 10000]
  );
}

async function saveFullStockMarketPartition(client, instrumentMap, dailyRows, valuationRows, sourceId) {
  const bars = (dailyRows || []).map(row => {
    const instrumentId = instrumentMap.get(row.ts_code);
    return instrumentId ? {
      instrument_id: instrumentId, trade_date: isoDate(row.trade_date),
      open: finite(row.open), high: finite(row.high), low: finite(row.low), close: finite(row.close),
      volume: finite(row.vol), amount: finite(row.amount),
    } : null;
  }).filter(row => row && row.trade_date);
  if (bars.length) {
    await client.query(
      `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
       SELECT x.instrument_id,x.trade_date,$2,x.open,x.high,x.low,x.close,x.volume,x.amount
       FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,open numeric,high numeric,low numeric,close numeric,volume numeric,amount numeric)
       ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
         close=EXCLUDED.close,volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`,
      [JSON.stringify(bars), sourceId]
    );
  }
  const valuations = (valuationRows || []).map(row => {
    const instrumentId = instrumentMap.get(row.ts_code);
    return instrumentId ? {
      instrument_id: instrumentId, trade_date: isoDate(row.trade_date),
      pe_static: finite(row.pe), pe_ttm: finite(row.pe_ttm), pb: finite(row.pb),
      dividend_yield_ttm: finite(row.dv_ttm),
      total_market_cap: finite(row.total_mv) == null ? null : finite(row.total_mv) * 10000,
      circulating_market_cap: finite(row.circ_mv) == null ? null : finite(row.circ_mv) * 10000,
    } : null;
  }).filter(row => row && row.trade_date && [
    row.pe_static, row.pe_ttm, row.pb, row.dividend_yield_ttm, row.total_market_cap, row.circulating_market_cap,
  ].some(value => value != null));
  if (valuations.length) {
    await client.query(
      `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap)
       SELECT x.instrument_id,x.trade_date,$2,x.pe_static,x.pe_ttm,x.pb,x.dividend_yield_ttm,x.total_market_cap,x.circulating_market_cap
       FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,pe_static numeric,pe_ttm numeric,pb numeric,dividend_yield_ttm numeric,total_market_cap numeric,circulating_market_cap numeric)
       ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET pe_static=EXCLUDED.pe_static,pe_ttm=EXCLUDED.pe_ttm,
         pb=EXCLUDED.pb,dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,total_market_cap=EXCLUDED.total_market_cap,
         circulating_market_cap=EXCLUDED.circulating_market_cap,ingested_at=now()`,
      [JSON.stringify(valuations), sourceId]
    );
  }
  return { bars: bars.length, valuations: valuations.length };
}

async function backfillUnderlyingStockMarket({ windowDays = 500 } = {}) {
  const jobName = 'convertible_bond_stock_market_backfill';
  if (!(await tryClaimJob(jobName))) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun(jobName);
  let filledDays = 0;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT s.canonical_code,s.instrument_id
       FROM fundamental.convertible_bond_profiles p
       JOIN core.instruments b ON b.instrument_id=p.instrument_id
       JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
       WHERE b.status <> 'delisted' AND (p.maturity_date IS NULL OR p.maturity_date >= CURRENT_DATE)`
    );
    const instrumentMap = new Map(rows.map(row => [row.canonical_code, row.instrument_id]));
    const openDays = await getRecentOpenDays(windowDays);
    const source = await sourceIds();
    for (const tradeDate of openDays) {
      const coverage = await pool.query(
        `SELECT
           COUNT(DISTINCT b.instrument_id)::int AS bars,
           COUNT(DISTINCT v.instrument_id)::int AS valuations
         FROM (SELECT unnest($1::bigint[]) AS instrument_id) i
         LEFT JOIN market.daily_bars b ON b.instrument_id=i.instrument_id AND b.trade_date=$2::date AND b.source_id=$3
         LEFT JOIN market.daily_valuations v ON v.instrument_id=i.instrument_id AND v.trade_date=$2::date AND v.source_id=$3`,
        [[...instrumentMap.values()], isoDate(tradeDate), source.tushare]
      );
      if (coverage.rows[0].bars >= instrumentMap.size * 0.9 && coverage.rows[0].valuations >= instrumentMap.size * 0.9) continue;
      const [dailyData, valuationData] = await Promise.all([
        tushareQuery('daily', { trade_date: tradeDate }, 'ts_code,trade_date,open,high,low,close,vol,amount'),
        tushareQuery('daily_basic', { trade_date: tradeDate }, 'ts_code,trade_date,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv'),
      ]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await saveFullStockMarketPartition(client, instrumentMap, tsRows(dailyData), tsRows(valuationData), source.tushare);
        await client.query('COMMIT');
        filledDays += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      if (filledDays % 20 === 0) console.log(`[股债分析缓存] 已补齐 ${filledDays} 个交易日`);
    }
    await finishJobRun(runId, true, `补齐 ${filledDays} 个交易日，覆盖 ${instrumentMap.size} 只正股`);
    return { skipped: false, filled_days: filledDays, stock_count: instrumentMap.size };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally {
    await releaseJob(jobName);
  }
}

function mergeDailyRows(cachedRows, freshRows) {
  const merged = new Map();
  for (const row of cachedRows || []) {
    const date = isoDate(row.trade_date);
    if (date) merged.set(date, Object.assign({}, row, { trade_date: date }));
  }
  for (const row of freshRows || []) {
    const date = isoDate(row.trade_date);
    if (date) merged.set(date, Object.assign({}, row, { trade_date: date }));
  }
  return [...merged.values()].sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)));
}

function incrementalStart(rows, fallback) {
  const latest = rows && rows[0] && isoDate(rows[0].trade_date);
  if (!latest) return fallback;
  return tsDateStr(addDays(new Date(`${latest}T00:00:00+08:00`), -7));
}

async function loadCachedStockBars(stockCode, startDate) {
  if (!stockCode) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (b.trade_date) b.trade_date,b.open,b.high,b.low,b.close,b.volume AS vol,b.amount
       FROM market.daily_bars b
       JOIN core.instruments i ON i.instrument_id=b.instrument_id
       JOIN ops.data_sources ds ON ds.source_id=b.source_id
      WHERE i.canonical_code=$1 AND b.trade_date >= $2::date AND ds.source_code='tushare'
      ORDER BY b.trade_date DESC,b.ingested_at DESC`,
    [stockCode, startDate]
  );
  return rows;
}

async function loadCachedStockValuations(stockCode, startDate) {
  if (!stockCode) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (v.trade_date) v.trade_date,v.pe_static AS pe,v.pe_ttm,v.pb,
            v.dividend_yield_ttm AS dv_ttm,v.total_market_cap / 10000 AS total_mv,
            v.circulating_market_cap / 10000 AS circ_mv
       FROM market.daily_valuations v
       JOIN core.instruments i ON i.instrument_id=v.instrument_id
       JOIN ops.data_sources ds ON ds.source_id=v.source_id
      WHERE i.canonical_code=$1 AND v.trade_date >= $2::date AND ds.source_code='tushare'
      ORDER BY v.trade_date DESC,v.ingested_at DESC`,
    [stockCode, startDate]
  );
  return rows;
}

async function loadCachedAnalysisHistory(tsCode, startDate) {
  const { rows: profileRows } = await pool.query(
    `SELECT p.raw_payload,s.canonical_code AS stock_code
       FROM fundamental.convertible_bond_profiles p
       JOIN core.instruments i ON i.instrument_id=p.instrument_id
       LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      WHERE i.canonical_code=$1`,
    [tsCode]
  );
  const stockCode = profileRows[0] && profileRows[0].stock_code;
  const [{ rows: metricRows }, stockDaily] = await Promise.all([
    pool.query(
      `SELECT m.trade_date,m.close,m.conversion_value,m.conversion_premium_pct,m.bond_value,
              m.bond_premium_pct,m.raw_payload
         FROM market.convertible_bond_daily_metrics m
         JOIN core.instruments i ON i.instrument_id=m.instrument_id
        WHERE i.canonical_code=$1 AND m.trade_date >= $2::date
        ORDER BY m.trade_date DESC`,
      [tsCode, startDate]
    ),
    loadCachedStockBars(stockCode, startDate),
  ]);
  const bondDaily = metricRows.map(row => Object.assign({}, row.raw_payload || {}, {
    trade_date: isoDate(row.trade_date),
    close: finite(row.close),
    cb_value: finite(row.conversion_value),
    cb_over_rate: finite(row.conversion_premium_pct),
    bond_value: finite(row.bond_value),
    bond_over_rate: finite(row.bond_premium_pct),
  }));
  return {
    profile: profileRows[0] && profileRows[0].raw_payload,
    stockCode,
    bondDaily,
    stockDaily,
  };
}

// P1 整改：本地水位查询，刷新时不再从上市日起重复拉取全部历史
// 财务报表最新报告期（fundamental.financial_reports），无则返回 null（首次全量回退上市日）
async function latestStockFinancialEnd(stockTsCode) {
  if (!stockTsCode) return null;
  const { rows } = await pool.query(
    `SELECT max(fr.period_end) AS report_end_date
       FROM fundamental.financial_reports fr
       JOIN core.company_instruments ci ON ci.company_id = fr.company_id
       JOIN core.instruments i ON i.instrument_id = ci.instrument_id
      WHERE i.canonical_code = $1`, [stockTsCode]
  );
  return rows[0] && rows[0].report_end_date || null;
}

// 公告相关已持久化资料的最新日期（下修提示/转股价变动/评级），作为公告搜索水位
async function latestAnnouncementBaseline(tsCode) {
  if (!tsCode) return null;
  const { rows } = await pool.query(
    `SELECT max(d) AS event_date FROM (
       SELECT max(announced_at) AS d FROM fundamental.convertible_bond_no_revision_history h
         JOIN core.instruments i ON i.instrument_id = h.instrument_id WHERE i.canonical_code = $1
       UNION ALL
       SELECT max(change_date) FROM fundamental.convertible_bond_price_changes c
         JOIN core.instruments i ON i.instrument_id = c.instrument_id WHERE i.canonical_code = $1
       UNION ALL
       SELECT max(rating_date) FROM fundamental.convertible_bond_ratings r
         JOIN core.instruments i ON i.instrument_id = r.instrument_id WHERE i.canonical_code = $1
     ) t`, [tsCode]
  );
  return rows[0] && rows[0].event_date || null;
}

async function latestRatingDate(tsCode) {
  const { rows } = await pool.query(
    `SELECT max(rating_date) AS rating_date FROM fundamental.convertible_bond_ratings r
       JOIN core.instruments i ON i.instrument_id = r.instrument_id WHERE i.canonical_code = $1`, [tsCode]
  );
  return rows[0] && rows[0].rating_date || null;
}

async function latestPriceChangeDate(tsCode) {
  const { rows } = await pool.query(
    `SELECT max(change_date) AS change_date FROM fundamental.convertible_bond_price_changes c
       JOIN core.instruments i ON i.instrument_id = c.instrument_id WHERE i.canonical_code = $1`, [tsCode]
  );
  return rows[0] && rows[0].change_date || null;
}

async function refreshConvertibleBondAnalysis(value, reason = 'manual', options = {}) {
  const tsCode = normalizeBondCode(value);
  if (!tsCode) throw new Error('请输入有效的可转债代码');
  const end = tsDateStr(new Date());
  const startDate = addDays(new Date(), -500);
  const start = tsDateStr(startDate);
  const cachedHistory = await loadCachedAnalysisHistory(tsCode, isoDate(startDate));
  const bondStart = incrementalStart(cachedHistory.bondDaily, start);
  // 按数据组门控：TTL 内且上次成功的低频数据组不再重复请求上游，options.force 可强制全拉
  const bondScope = datasetScope('convertible_bond', tsCode);
  const cursors = await getDatasetCursors(bondScope, GATED_BOND_DATASETS);
  const forceAll = options.force === true;
  const skippedDatasets = [];
  const gate = (code, run, fallback) => {
    if (isDatasetFresh(cursors.get(code), code, { force: forceAll })) {
      skippedDatasets.push(code);
      return Promise.resolve(fallback);
    }
    return run();
  };
  const enable5000 = process.env.TUSHARE_ENABLE_5000_ENDPOINTS === '1';
  const couponPromise = enable5000
    ? gate('cb_rate', () => tushareQuery('cb_rate', { ts_code: tsCode }, 'ts_code,rate_freq,rate_start_date,rate_end_date,coupon_rate'), null)
    : Promise.resolve(null);
  const holderPromise = enable5000
    ? gate('top10_cb_holders', () => tushareQuery('top10_cb_holders', { ts_code: tsCode }, 'ts_code,end_date,holder_rank,holder_name,hold_amount,hold_ratio'), null)
    : Promise.resolve(null);
  // 主档只在数据库已有完整 raw_payload 时才允许跳过，避免主档缺失导致分析中断
  const canReuseProfile = Boolean(cachedHistory.profile && cachedHistory.profile.stk_code);
  const fetchProfile = () => tushareQuery('cb_basic', { ts_code: tsCode }, PROFILE_FIELDS);
  const [profileData, bondDailyData, ratingData, priceChangeData, couponData, holderData] = await Promise.all([
    canReuseProfile ? gate('cb_basic', fetchProfile, null) : fetchProfile(),
    tushareQuery('cb_daily', { ts_code: tsCode, start_date: bondStart, end_date: end }, DAILY_FIELDS),
    // cb_rating / cb_price_chg 官方只支持 ts_code，不支持日期过滤：拉该只全量后在内存里只保留本地水位往前 30 天重叠窗口，
    // 由 saveRatingHistory / savePriceChanges 按唯一键幂等 upsert，只写新增/修订行（避免传不支持的 start_date 报错）。
    gate('cb_rating', async () => {
      const rows = tsRows(await tushareQuery('cb_rating', { ts_code: tsCode }, 'ts_code,ann_date,rating_date,rating_com_name,rating_way,rating_type,rating,rating_outlook'));
      if (forceAll) return rows;
      const wm = await latestRatingDate(tsCode);
      if (!wm) return rows;
      const floor = tsDateStr(addDays(new Date(`${isoDate(wm)}T00:00:00+08:00`), -30));
      return rows.filter(r => (r.rating_date || '').replace(/-/g, '') >= floor);
    }, null),
    gate('cb_price_chg', async () => {
      const rows = tsRows(await tushareQuery('cb_price_chg', { ts_code: tsCode }, 'ts_code,bond_short_name,publish_date,change_date,convert_price_initial,convertprice_bef,convertprice_aft'));
      if (forceAll) return rows;
      const wm = await latestPriceChangeDate(tsCode);
      if (!wm) return rows;
      const floor = tsDateStr(addDays(new Date(`${isoDate(wm)}T00:00:00+08:00`), -30));
      return rows.filter(r => (r.change_date || '').replace(/-/g, '') >= floor);
    }, null),
    couponPromise,
    holderPromise,
  ]);
  const profile = tsRows(profileData)[0] || cachedHistory.profile;
  if (!profile) throw new Error('未找到该可转债，或Tushare数据源暂不可用');
  const freshBondDaily = tsRows(bondDailyData);
  const bondDaily = mergeDailyRows(cachedHistory.bondDaily, freshBondDaily);
  if (!bondDaily.length) throw new Error('该可转债暂无行情数据');
  const stockCode = profile.stk_code;
  const cachedStockDaily = cachedHistory.stockCode === stockCode
    ? cachedHistory.stockDaily
    : await loadCachedStockBars(stockCode, isoDate(startDate));
  const cachedValuations = await loadCachedStockValuations(stockCode, isoDate(startDate));
  const stockStart = incrementalStart(cachedStockDaily, start);
  const valuationStart = incrementalStart(cachedValuations, start);
  const announcementStart = String(profile.list_date || '').replace(/-/g,'') || start;
  // P1 整改：财务报表与公告增量——日常刷新只补本地最新水位往前的重叠窗口；force 全量补历史时回退上市日
  const financialWaterMark = forceAll ? null : await latestStockFinancialEnd(stockCode);
  const financialWindowStart = financialWaterMark
    ? tsDateStr(addDays(new Date(`${isoDate(financialWaterMark)}T00:00:00+08:00`), -120))
    : announcementStart;
  const announcementWaterMark = forceAll ? null : await latestAnnouncementBaseline(tsCode);
  const announcementWindowStart = announcementWaterMark
    ? tsDateStr(addDays(new Date(`${isoDate(announcementWaterMark)}T00:00:00+08:00`), -30))
    : announcementStart;
  const prospectusStartDate = addYears(new Date(`${isoDate(profile.list_date) || isoDate(profile.value_date) || isoDate(start)}T00:00:00+08:00`), -1);
  const prospectusStart = tsDateStr(prospectusStartDate);
  const futureCalendarEnd = addDays(new Date(), 400);
  const prospectusCache = await loadProspectusCache(tsCode);
  const noRevisionCache = await loadNoRevisionCache(tsCode);
  const priceChangeCache = await loadPriceChangeCache(tsCode);
  const needsPriceDetails = priceChangeCache.some(row => row.parser_version !== '3');
  const ratingSourceCache = await loadRatingSourceCache(tsCode);
  const needsProspectus = !prospectusCache.fundraising_purpose || Number(prospectusCache.coupon_count) === 0 || prospectusCache.parser_version !== '4';
  // 分红明细只在估值接口缺少股息率时才参与计算，已有股息率时可按 TTL 跳过全量拉取
  const dividendFields = 'ts_code,end_date,ann_date,div_proc,cash_div_tax,ex_date,pay_date';
  const fetchDividend = () => tushareQuery('dividend', { ts_code: stockCode }, dividendFields);
  const hasCachedDividendYield = finite(cachedValuations[0] && cachedValuations[0].dv_ttm) != null;
  const [stockDailyData, valuationData, incomeData, balanceData, dividendData, liveQuotes, announcements, futureCalendarData] = await Promise.all([
    tushareQuery('daily', { ts_code: stockCode, start_date: stockStart, end_date: end }, 'ts_code,trade_date,open,high,low,close,vol,amount'),
    tushareQuery('daily_basic', { ts_code: stockCode, start_date: valuationStart, end_date: end }, 'ts_code,trade_date,close,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv'),
    tushareQuery('income', { ts_code: stockCode, start_date: financialWindowStart, end_date: end }, 'ts_code,ann_date,f_ann_date,end_date,report_type,n_income_attr_p'),
    tushareQuery('balancesheet', { ts_code: stockCode, start_date: financialWindowStart, end_date: end },
      'ts_code,ann_date,f_ann_date,end_date,report_type,total_assets,total_liab'),
    hasCachedDividendYield ? gate('bond_dividend', fetchDividend, null) : fetchDividend(),
    fetchTencentQuotes([tsCode, stockCode]),
    Promise.all([
      needsPriceDetails ? fetchCninfoEventsByYear(stockCode, announcementWindowStart, end, '转股价格').catch(() => [])
        : fetchCninfoEvents(stockCode, announcementWindowStart, end, '转股价格').catch(() => []),
      fetchSzseEvents(stockCode, announcementWindowStart, end, '转股价格').catch(() => []),
      fetchCninfoEvents(stockCode, announcementWindowStart, end, '回售').catch(() => []),
      fetchSseEvents(stockCode, announcementWindowStart, end, '回售').catch(() => []),
      fetchSzseEvents(stockCode, announcementWindowStart, end, '回售').catch(() => []),
      fetchCninfoEvents(stockCode, announcementWindowStart, end, '年度报告').catch(() => []),
      ratingSourceCache.missing ? fetchCninfoEventsByYear(stockCode, announcementWindowStart, end, '评级').catch(() => []) : Promise.resolve([]),
      fetchSseEvents(stockCode, announcementWindowStart, end, '评级').catch(() => []),
      fetchSseLatestReport(stockCode).then(report => report ? [report] : []).catch(() => []),
      fetchSzseLatestReport(stockCode, start, end).then(report => report ? [report] : []).catch(() => []),
      needsProspectus ? fetchCninfoEvents(stockCode, prospectusStart, end, '募集说明书').catch(() => []) : Promise.resolve([]),
    ]).then(groups => groups.flat()),
    tushareQuery('trade_cal', { exchange: 'SSE', start_date: end, end_date: tsDateStr(futureCalendarEnd) }, 'cal_date,is_open').catch(() => null),
  ]);
  const reportHolding = holderData ? null : await extractReportFundHolding(announcements);
  const reportPriceHistory = await extractReportPriceHistory(announcements, profile.first_conv_price, profile.bond_short_name,
    prospectusCache.price_history_report_url, prospectusCache.price_history_parser_version);
  const ratingOutlooks = await extractRatingOutlooks(announcements, ratingSourceCache.urls);
  const prospectusEvents = prospectusCache.source_url ? announcements.concat([{
    title: prospectusCache.source_title || '可转换公司债券募集说明书', url: prospectusCache.source_url,
    event_date: profile.list_date || profile.value_date,
  }]) : announcements;
  const prospectusDetails = needsProspectus ? await extractProspectusDetails(prospectusEvents) : null;
  const noRevisionPeriods = await extractNoRevisionPeriods(announcements, noRevisionCache);
  const priceChangeDetails = await extractPriceChangeDetails(announcements, priceChangeCache);
  const currentResetWindow = resetWindowState(noRevisionPeriods);
  const putPeriod = currentPutPeriod(profile.maturity_date, profile.put_clause, end);
  const putOpportunity = putOpportunityState(announcements, putPeriod.period_start, putPeriod.period_end);
  profile.fundraising_purpose = prospectusDetails && prospectusDetails.fundraising_purpose || prospectusCache.fundraising_purpose || '';
  profile.prospectus_source_url = prospectusDetails && prospectusDetails.source_url || prospectusCache.source_url || '';
  const freshStockDaily = tsRows(stockDailyData);
  const stockDaily = mergeDailyRows(cachedStockDaily, freshStockDaily);
  const freshValuations = tsRows(valuationData);
  const valuations = mergeDailyRows(cachedValuations, freshValuations);
  const balances = tsRows(balanceData).filter(row => !row.report_type || String(row.report_type) === '1')
    .sort((a,b) => String(b.end_date).localeCompare(String(a.end_date)));
  const dividendRows = tsRows(dividendData);
  const latestBond = bondDaily[0], latestStock = stockDaily[0], valuation = valuations[0] || {};
  const client = await pool.connect();
  let ids;
  let sources;
  try {
    await client.query('BEGIN');
    sources = await sourceIds(client);
    ids = await saveProfile(client, profile, sources);
    for (const row of freshBondDaily) await saveDailyBar(client, ids.bondId, row, sources.tushare);
    for (const row of freshStockDaily) await saveDailyBar(client, ids.stockId, row, sources.tushare);
    for (const row of freshValuations) await saveStockValuation(client, ids.stockId, row, sources.tushare);
    await saveRatingHistory(client, ids.bondId, tsRows(ratingData), sources.tushare);
    await saveRatingOutlooks(client, ids.bondId, ratingOutlooks);
    await savePriceChanges(client, ids.bondId, tsRows(priceChangeData), sources.tushare);
    if (couponData) await saveCouponSchedule(client, ids.bondId, tsRows(couponData), sources.tushare);
    if (holderData) await saveFundHolding(client, ids.bondId, tsRows(holderData), sources.tushare);
    if (reportHolding) await saveReportFundHolding(client, ids.bondId, reportHolding, sources.cninfo || sources.calculated);
    if (prospectusDetails) await saveProspectusDetails(client, ids.bondId, profile, prospectusDetails, sources.cninfo || sources.calculated);
    await saveAnnouncementHistories(client, ids.bondId, announcements, profile, sources.cninfo || sources.calculated,
      noRevisionPeriods, priceChangeDetails);
    if (reportPriceHistory) {
      if (reportPriceHistory.price_changes.length) {
        const reportDates = reportPriceHistory.price_changes.map(row => isoDate(row.change_date)).filter(Boolean).sort();
        const firstReportChange = reportPriceHistory.price_changes.find(row => isoDate(row.change_date) === reportDates[0]);
        await client.query(
          `DELETE FROM fundamental.convertible_bond_price_changes
            WHERE instrument_id=$1 AND raw_payload->>'source_url'=$2`,
          [ids.bondId, reportPriceHistory.source_url]
        );
        await client.query(
          `DELETE FROM fundamental.convertible_bond_price_changes WHERE instrument_id=$1 AND
            ((change_date BETWEEN $2 AND $3) OR price_before IS NULL OR price_after IS NULL OR
             (change_date<$2 AND price_before=$4 AND price_after=$5))
            AND COALESCE(raw_payload->>'price_change_parser_version','')<>'3'`,
          [ids.bondId, reportDates[0], reportDates[reportDates.length - 1],
            finite(firstReportChange.convertprice_bef), finite(firstReportChange.convertprice_aft)]
        );
        await savePriceChanges(client, ids.bondId, reportPriceHistory.price_changes, sources.cninfo || sources.calculated);
      }
      await client.query(
        `UPDATE fundamental.convertible_bond_profiles SET raw_payload=raw_payload || jsonb_build_object(
          'price_history_report_url',$2::text,'price_history_parser_version','9') WHERE instrument_id=$1`,
        [ids.bondId, reportPriceHistory.source_url]
      );
    }
    const simplifiedTerms = { call: simplifyClause('call', profile.call_clause), reset: simplifyClause('reset', profile.reset_clause), put: simplifyClause('put', profile.put_clause) };
    const putActive = putPeriod.active && !putOpportunity.used;
    const progresses = {
      call: triggerProgress(stockDaily, simplifiedTerms.call, profile.conv_price),
      reset: triggerProgress(stockDaily, simplifiedTerms.reset, profile.conv_price, currentResetWindow.active, currentResetWindow.eligible_from),
      put: triggerProgress(stockDaily, simplifiedTerms.put, profile.conv_price, putActive, putPeriod.period_start),
    };
    for (const progress of Object.values(progresses)) progress.close_price = finite(stockDaily[0] && stockDaily[0].close);
    await saveTriggerProgress(client, ids.bondId, latestBond.trade_date, progresses);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }

  // 事务提交后推进本次真正拉取成功的数据组水位；被 TTL 跳过的组保持原水位
  const fetchedDatasets = [];
  if (profileData) fetchedDatasets.push('cb_basic');
  if (ratingData) fetchedDatasets.push('cb_rating');
  if (priceChangeData) fetchedDatasets.push('cb_price_chg');
  if (couponData) fetchedDatasets.push('cb_rate');
  if (holderData) fetchedDatasets.push('top10_cb_holders');
  if (dividendData) fetchedDatasets.push('bond_dividend');
  for (const dataset of fetchedDatasets) {
    await markDatasetSuccess(bondScope, dataset, { instrumentId: ids.bondId, lastSuccessDate: isoDate(new Date()) });
  }

  const code = tsCode.slice(0,6), stockShortCode = stockCode.slice(0,6);
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
  const financial = await latestFinancial(stockCode);
  const extras = await loadExtraData(ids.bondId);
  const termDetails = { call: simplifyClause('call', profile.call_clause), reset: simplifyClause('reset', profile.reset_clause), put: simplifyClause('put', profile.put_clause) };
  const targetPutPeriod = putOpportunity.used ? (nextPutPeriod(putPeriod, profile.maturity_date) || putPeriod) : putPeriod;
  const putStartDate = targetPutPeriod.period_start || targetPutPeriod.eligible_from;
  const putActive = targetPutPeriod.active && !putOpportunity.used;
  const resetWindow = resetWindowState(extras.no_revision_history);
  const triggerState = {
    call: triggerProgress(stockDaily, termDetails.call, convPrice),
    reset: triggerProgress(stockDaily, termDetails.reset, convPrice, resetWindow.active, resetWindow.eligible_from),
    put: triggerProgress(stockDaily, termDetails.put, convPrice, putActive, putStartDate),
  };
  const futureTradeDates = futureTradeCalendar(tsRows(futureCalendarData));
  const putTimeline = estimatePutTimeline(stockDaily, termDetails.put, convPrice, putStartDate, futureTradeDates, stockPrice);
  const maturityFinal = parseMoney(profile.maturity_call_price, 100 + (finite(profile.coupon_rate) || 0));
  const discountRate = creditDiscountRate(profile.newest_rating || profile.issue_rating);
  const interestYear = currentInterestYear(profile.value_date, profile.maturity_date, end);
  const marketPureBond = finite(latestBond.bond_value);
  const pureBond = marketPureBond != null ? marketPureBond
    : presentValue(cashflowsToDate(profile, extras.coupons, profile.maturity_date, false, maturityFinal), discountRate);
  const optionValue = bondPrice != null && pureBond != null ? bondPrice - pureBond : null;
  const maturityPreTax = yieldToMaturity(bondPrice, cashflowsToDate(profile, extras.coupons, profile.maturity_date, false, maturityFinal));
  const maturityAfterTax = yieldToMaturity(bondPrice, cashflowsToDate(profile, extras.coupons, profile.maturity_date, true, maturityFinal));
  const estimatedPutDate = putTimeline && putTimeline.trigger_date;
  const estimatedPutPaymentDate = putTimeline && putTimeline.payment_date;
  const estimatedPutYears = remainingYears(estimatedPutDate);
  const putYieldYears = remainingYears(estimatedPutPaymentDate);
  const putFinal = accruedPutPrice(profile, extras.coupons, estimatedPutDate);
  const putPreTax = annualizedRedemptionYield(bondPrice, putFinal, putYieldYears);
  const putAfterTax = annualizedRedemptionYield(bondPrice, putFinal, putYieldYears, 0.2);
  const volatility = annualizedVolatility(stockDaily), riskFreeRate = finite(process.env.CB_RISK_FREE_RATE) == null ? 0.015 : finite(process.env.CB_RISK_FREE_RATE);
  const stockDividendYield = finite(valuation.dv_ttm) == null ? derivedDividendYield(dividendRows, stockPrice, end) : finite(valuation.dv_ttm) / 100;
  const dividendYield = stockDividendYield == null ? 0 : stockDividendYield;
  const latestBalance = balances[0] || {};
  const financialAssets = finite(latestBalance.total_assets) || finite(financial.total_assets);
  const financialLiabilities = finite(latestBalance.total_liab) == null ? finite(financial.total_liability) : finite(latestBalance.total_liab);
  const theoreticalOption = blackScholesConvertible(stockPrice, convPrice, remainingYears(profile.maturity_date), volatility, riskFreeRate, dividendYield);
  const theoreticalValue = pureBond != null && theoreticalOption != null ? pureBond + theoreticalOption : null;
  const calculatedPe = fallbackPe(valuation, marketCap, tsRows(incomeData));
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
      call_trigger_price: triggerState.call.trigger_price, reset_trigger_price: triggerState.reset.trigger_price,
      put_trigger_price: triggerState.put.trigger_price,
      call_day_count: triggerState.call.matched_days, reset_day_count: triggerState.reset.matched_days,
      put_day_count: triggerState.put.matched_days,
      call_required_days: triggerState.call.required_days, reset_required_days: triggerState.reset.required_days,
      put_required_days: triggerState.put.required_days, call_met: triggerState.call.met, reset_met: triggerState.reset.met,
      put_met: triggerState.put.met, put_active: putActive, put_observed_days: triggerState.put.observed_days,
      put_opportunity_used: putOpportunity.used,
      put_opportunity_announcement: putOpportunity.event ? putOpportunity.event.title : null,
      put_period_end_date: putPeriod.period_end,
      reset_active: resetWindow.active, reset_restart_date: resetWindow.eligible_from, reset_valid_until: resetWindow.valid_until,
      maturity_date: isoDate(profile.maturity_date), remaining_years: remainingYears(profile.maturity_date), issue_size: yuanToHundredMillion(profile.issue_size),
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
      cb_price_chg: priceChangeData ? 'ok' : 'permission_or_unavailable',
      coupon_schedule: extras.coupons.length ? 'ok' : (parseCouponRates(profile.rate_clause).length ? 'parsed_from_clause' : 'requires_5000_points'),
      fund_holding: extras.fund_holding ? 'ok' : 'requires_5000_points_or_report_parse',
      no_revision_history: extras.no_revision_history.length ? 'ok' : 'no_matching_announcement',
      theoretical_value: theoreticalValue == null ? 'calculation_inputs_incomplete' : 'calculated',
      put_yield: putStartDate ? (putPreTax == null ? 'not_yet_calculable' : 'calculated') : 'put_period_not_found'
    }
  };
  const latestPriceChange = extras.price_changes && extras.price_changes[0];
  const latestNoRevision = extras.no_revision_history && extras.no_revision_history[0];
  const latestRating = extras.ratings && extras.ratings[0];
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
  };
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

async function getConvertibleBondSnapshot(value) {
  const tsCode = normalizeBondCode(value);
  if (!tsCode) return null;
  const { rows } = await pool.query(
    `SELECT s.payload,s.created_at,s.formula_bundle_version,s.source_watermark,
            p.current_conv_price,p.source_updated_at,p.updated_at AS profile_updated_at,
            p.stock_instrument_id,p.newest_rating AS profile_rating,
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
  return Object.assign({}, payload, {
    cached_at: r.created_at,
    delist_date: delistDate,
    is_delisted: r.status === 'delisted' || Boolean(delistDate && delistDate <= isoDate(new Date())),
    needs_refresh: r.formula_bundle_version !== FORMULA_VERSION || freshness.needs_refresh,
    formula_version: r.formula_bundle_version,
    freshness,
  });
}

module.exports = {
  finite, yuanToHundredMillion, isoDate, normalizeBondCode, instrumentStatus, remainingYears, pricePairFromReason, normalizePriceChange, normalizePriceChanges, parseTriggerRatio, parseWindow, earliestPutDate, currentPutPeriod, nextPutPeriod, putOpportunityState,
  annualizedVolatility, simplifyClause, triggerProgress, resetWindowState, estimatePutTimeline, parseCouponRates, parseMoney, yieldToMaturity,
  cashflowsToDate, creditDiscountRate, futureTradeCalendar, annualizedRedemptionYield, accruedPutPrice,
  blackScholesConvertible, fallbackPe, currentInterestYear, presentValue, derivedDividendYield, revisionDecision,
  mergeDailyRows, incrementalStart,
  syncConvertibleBondUniverse, convertibleBondIssueSyncWindow, shouldAdvanceConvertibleBondIssueCursor, refreshConvertibleBondAnalysis, getConvertibleBondSnapshot, buildStandardTermsHash,
  loadSafety, latestFinancial,
  DAILY_FIELDS,
  syncConvertibleBondUniverseWithBackfill, backfillCycleGaps, backfillUnderlyingStockMarket, getRecentOpenDays,
  backfillMissingRatings, backfillBondFirstDayPerformance, backfillBondIssueResults,
};
