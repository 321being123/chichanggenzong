const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { tushareQuery, tsRows, tsDateStr } = require('./market');
const { fetchTencentQuotes } = require('./tencentQuote');
const { fetchCninfoEvents, fetchCninfoEventsByYear, fetchSseLatestReport, fetchSseEvents, fetchSzseEvents, fetchSzseLatestReport } = require('./stockAnalysis');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BOND_PREFIX = /^(110|111|113|118|123|127|128)\d{3}$/;
const PROFILE_FIELDS = [
  'ts_code','bond_full_name','bond_short_name','cb_type','stk_code','stk_short_name','maturity','par','issue_price',
  'issue_size','remain_size','value_date','maturity_date','rate_type','coupon_rate','add_rate','pay_per_year',
  'list_date','delist_date','exchange','conv_start_date','conv_end_date','conv_stop_date','first_conv_price','conv_price',
  'rate_clause','put_clause','maturity_call_price','call_clause','reset_clause','conv_clause','guarantor','guarantee_type',
  'issue_rating','newest_rating','rating_comp'
].join(',');
const DAILY_FIELDS = 'ts_code,trade_date,pre_close,open,high,low,close,change,pct_chg,vol,amount,bond_value,bond_over_rate,cb_value,cb_over_rate';
const FORMULA_VERSION = '2';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function yuanToHundredMillion(value) {
  const number = finite(value);
  return number == null ? null : number / 100000000;
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  }
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}` : null;
}

function normalizeBondCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  const digits = raw.replace(/\.(SH|SZ)$/i, '').replace(/\D/g, '');
  if (!BOND_PREFIX.test(digits)) return null;
  const exchange = /^(110|111|113)/.test(digits) ? 'SH' : 'SZ';
  return `${digits}.${exchange}`;
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
  const endDate = new Date(`${(nextPeriod && nextPeriod < maturity) ? nextPeriod : maturity}T00:00:00+08:00`);
  endDate.setDate(endDate.getDate() - 1);
  return { active: current >= periodStart && current <= maturity, eligible_from: eligibleFrom,
    period_start: periodStart, period_end: isoDate(endDate) };
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
  const closes = (rows || []).slice().sort((a,b) => String(a.trade_date).localeCompare(String(b.trade_date)))
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
  if (price >= triggerPrice) return { status: 'current_price_not_below_trigger', trigger_date: null, payment_date: null, remaining_days: null };
  const required = term.required_days || term.observation_days;
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
    assumption: '假设正股收盘价持续低于回售触发价，触发后第10个交易日到账；未公布的休市安排按工作日估算' };
}

function futureTradeCalendar(rows, today = isoDate(tsDateStr(new Date())), horizonDays = 800) {
  const official = (rows || []).map(row => ({ date: isoDate(row.cal_date), open: String(row.is_open) === '1' })).filter(row => row.date).sort((a,b) => a.date.localeCompare(b.date));
  const dates = new Set(official.filter(row => row.open).map(row => row.date));
  const lastOfficial = official.length ? official[official.length - 1].date : isoDate(today);
  const cursor = new Date(`${lastOfficial}T00:00:00+08:00`);
  const end = new Date(`${isoDate(today)}T00:00:00+08:00`); end.setDate(end.getDate() + horizonDays);
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) dates.add(isoDate(cursor));
  }
  return [...dates].sort();
}

function parseCouponRates(text) {
  const values = [...String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*[%％]/g)]
    .map(match => Number(match[1])).filter(Number.isFinite);
  return values;
}

function parseMoney(text, fallback = null) {
  const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*元/);
  return match ? Number(match[1]) : fallback;
}

function addYears(date, years) {
  const copy = new Date(date.getTime()); copy.setFullYear(copy.getFullYear() + years); return copy;
}

function cashflowsToDate(profile, coupons, targetDate, afterTax, finalValue) {
  const today = new Date();
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
  const startDate = new Date(`${current}T00:00:00+08:00`); startDate.setFullYear(startDate.getFullYear() - 1);
  const start = isoDate(startDate);
  const paid = (rows || []).filter(row => isoDate(row.ex_date) && isoDate(row.ex_date) >= start && isoDate(row.ex_date) <= current);
  if (paid.length) return paid.reduce((sum,row) => sum + (finite(row.cash_div_tax) || 0), 0) / price;
  return (rows || []).some(row => finite(row.cash_div_tax) === 0) ? 0 : null;
}

function yieldToMaturity(price, cashflows) {
  if (!(finite(price) > 0) || !cashflows || !cashflows.length) return null;
  const npv = rate => cashflows.reduce((sum, flow) => sum + flow.amount / Math.pow(1 + rate, flow.years), 0) - price;
  let low = -0.99, high = 5;
  if (npv(low) * npv(high) > 0) return null;
  for (let i = 0; i < 100; i += 1) { const mid = (low + high) / 2; if (npv(mid) > 0) low = mid; else high = mid; }
  return (low + high) / 2;
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

async function ensureInstrument(client, tsCode, name, assetClass, listDate, delistDate) {
  const market = tsCode.endsWith('.SH') ? 'SSE' : 'SZSE';
  const { rows } = await client.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,list_date,delist_date,status)
     VALUES($1,$2,$3,'CN',$4,$5,$6,$7)
     ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name,asset_class=EXCLUDED.asset_class,
       exchange_code=EXCLUDED.exchange_code,list_date=COALESCE(EXCLUDED.list_date,core.instruments.list_date),
       delist_date=COALESCE(EXCLUDED.delist_date,core.instruments.delist_date),status=EXCLUDED.status,updated_at=now()
     RETURNING instrument_id`,
    [tsCode, name || tsCode, assetClass, market, isoDate(listDate), isoDate(delistDate), delistDate ? 'delisted' : 'listed']
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

async function saveProfile(client, profile, sources) {
  const bondId = await ensureInstrument(client, profile.ts_code, profile.bond_short_name, 'convertible_bond', profile.list_date, profile.delist_date);
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

async function savePriceChanges(client, instrumentId, rows, sourceId) {
  for (const row of rows || []) {
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

function runPriceHistoryExtractor(executable, url, initialPrice) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondPriceHistory.py');
  const scriptArgs = [script, url];
  if (finite(initialPrice) != null) scriptArgs.push('--initial-price', String(finite(initialPrice)));
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

async function extractReportPriceHistory(events, initialPrice, cachedReportUrl, cachedParserVersion) {
  const report = latestFullReport(events);
  if (!report || (report.url === cachedReportUrl && cachedParserVersion === '6')) return null;
  let lastError;
  for (const executable of pythonCandidates()) {
    try {
      const result = await runPriceHistoryExtractor(executable, report.url, initialPrice);
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
  const cachedUrls = new Set((cachedRows || []).filter(row => finite(row.price_after) != null && row.source_url && row.parser_version === '2').map(row => row.source_url));
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
    const payDateText = payDate ? `${payDate.getFullYear()}-${String(payDate.getMonth()+1).padStart(2,'0')}-${String(payDate.getDate()).padStart(2,'0')}` : null;
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
            price_change_parser_version: detail.parser_version || '2',
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
  const start = new Date(); start.setDate(start.getDate() - 20);
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
  return row && row.ts_code && BOND_PREFIX.test(String(row.ts_code).slice(0,6)) &&
    (!listed || listed <= today) && (!delisted || delisted > today) &&
    (!maturity || maturity >= today) && (!convertEnd || convertEnd >= today);
}

async function syncConvertibleBondUniverse(reason = 'scheduled') {
  const claimed = await tryClaimJob('convertible_bond_universe_refresh');
  if (!claimed) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun('convertible_bond_universe_refresh');
  try {
    const [basicData, dates] = await Promise.all([tushareQuery('cb_basic', {}, PROFILE_FIELDS), latestTradeDates()]);
    const basics = tsRows(basicData).filter(row => activeProfile(row, tsDateStr(new Date())));
    if (!basics.length) throw new Error('Tushare 可转债基础数据为空，保留上一份数据');
    const daily = await latestFullBondDaily(dates);
    if (!daily.rows.length) throw new Error('Tushare 可转债行情为空，保留上一份数据');
    const dailyMap = new Map(daily.rows.map(row => [row.ts_code, row]));
    const client = await pool.connect();
    let saved = 0;
    try {
      await client.query('BEGIN');
      const sources = await sourceIds(client);
      for (const profile of basics) {
        const ids = await saveProfile(client, profile, sources);
        const quote = dailyMap.get(profile.ts_code);
        if (quote) await saveDailyBar(client, ids.bondId, quote, sources.tushare);
        saved += 1;
      }
      await client.query(
        `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count)
         VALUES('convertible_bond_universe','cb_basic_cb_daily',$1,now(),now(),'',0)
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,
           last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`,
        [isoDate(daily.tradeDate)]
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await finishJobRun(runId, true, `${reason}：同步 ${saved} 只，行情日期 ${daily.tradeDate}`);
    return { skipped: false, count: saved, trade_date: isoDate(daily.tradeDate) };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally { await releaseJob('convertible_bond_universe_refresh'); }
}

async function loadSafety(code) {
  const { rows } = await pool.query('SELECT data,source_updated_at FROM bond_safety_snapshots ORDER BY id DESC LIMIT 1');
  const snapshot = rows[0];
  const item = snapshot && Array.isArray(snapshot.data) ? snapshot.data.find(row => String(row.bond_code) === code) : null;
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
  return { ratings: ratings.rows, price_changes: changes.rows, no_revision_history: noRevision.rows, coupons: coupons.rows, fund_holding: holdings.rows[0] || null };
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

async function refreshConvertibleBondAnalysis(value, reason = 'manual') {
  const tsCode = normalizeBondCode(value);
  if (!tsCode) throw new Error('请输入有效的可转债代码');
  const end = tsDateStr(new Date());
  const startDate = new Date(); startDate.setDate(startDate.getDate() - 500);
  const start = tsDateStr(startDate);
  const couponPromise = process.env.TUSHARE_ENABLE_5000_ENDPOINTS === '1'
    ? tushareQuery('cb_rate', { ts_code: tsCode }, 'ts_code,rate_freq,rate_start_date,rate_end_date,coupon_rate')
    : Promise.resolve(null);
  const holderPromise = process.env.TUSHARE_ENABLE_5000_ENDPOINTS === '1'
    ? tushareQuery('top10_cb_holders', { ts_code: tsCode }, 'ts_code,end_date,holder_rank,holder_name,hold_amount,hold_ratio')
    : Promise.resolve(null);
  const [profileData, bondDailyData, ratingData, priceChangeData, couponData, holderData] = await Promise.all([
    tushareQuery('cb_basic', { ts_code: tsCode }, PROFILE_FIELDS),
    tushareQuery('cb_daily', { ts_code: tsCode, start_date: start, end_date: end }, DAILY_FIELDS),
    tushareQuery('cb_rating', { ts_code: tsCode }, 'ts_code,ann_date,rating_date,rating_com_name,rating_way,rating_type,rating,rating_outlook'),
    tushareQuery('cb_price_chg', { ts_code: tsCode }, 'ts_code,bond_short_name,publish_date,change_date,convert_price_initial,convertprice_bef,convertprice_aft'),
    couponPromise,
    holderPromise,
  ]);
  const profile = tsRows(profileData)[0];
  if (!profile) throw new Error('未找到该可转债，或Tushare数据源暂不可用');
  const bondDaily = tsRows(bondDailyData).sort((a,b) => String(b.trade_date).localeCompare(String(a.trade_date)));
  if (!bondDaily.length) throw new Error('该可转债暂无行情数据');
  const stockCode = profile.stk_code;
  const announcementStart = String(profile.list_date || '').replace(/-/g,'') || start;
  const prospectusStartDate = new Date(`${isoDate(profile.list_date) || isoDate(profile.value_date) || isoDate(start)}T00:00:00+08:00`);
  prospectusStartDate.setFullYear(prospectusStartDate.getFullYear() - 1);
  const prospectusStart = tsDateStr(prospectusStartDate);
  const futureCalendarEnd = new Date(); futureCalendarEnd.setDate(futureCalendarEnd.getDate() + 400);
  const prospectusCache = await loadProspectusCache(tsCode);
  const noRevisionCache = await loadNoRevisionCache(tsCode);
  const priceChangeCache = await loadPriceChangeCache(tsCode);
  const needsPriceDetails = priceChangeCache.some(row => row.parser_version !== '2');
  const ratingSourceCache = await loadRatingSourceCache(tsCode);
  const needsProspectus = !prospectusCache.fundraising_purpose || Number(prospectusCache.coupon_count) === 0 || prospectusCache.parser_version !== '4';
  const [stockDailyData, valuationData, incomeData, balanceData, dividendData, liveQuotes, announcements, futureCalendarData] = await Promise.all([
    tushareQuery('daily', { ts_code: stockCode, start_date: start, end_date: end }, 'ts_code,trade_date,open,high,low,close,vol,amount'),
    tushareQuery('daily_basic', { ts_code: stockCode, start_date: start, end_date: end }, 'ts_code,trade_date,close,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv'),
    tushareQuery('income', { ts_code: stockCode, start_date: announcementStart, end_date: end }, 'ts_code,ann_date,f_ann_date,end_date,report_type,n_income_attr_p'),
    tushareQuery('balancesheet', { ts_code: stockCode, start_date: announcementStart, end_date: end },
      'ts_code,ann_date,f_ann_date,end_date,report_type,total_assets,total_liab'),
    tushareQuery('dividend', { ts_code: stockCode }, 'ts_code,end_date,ann_date,div_proc,cash_div_tax,ex_date,pay_date'),
    fetchTencentQuotes([tsCode, stockCode]),
    Promise.all([
      needsPriceDetails ? fetchCninfoEventsByYear(stockCode, announcementStart, end, '转股价格').catch(() => [])
        : fetchCninfoEvents(stockCode, announcementStart, end, '转股价格').catch(() => []),
      fetchSzseEvents(stockCode, announcementStart, end, '转股价格').catch(() => []),
      fetchCninfoEvents(stockCode, announcementStart, end, '回售').catch(() => []),
      fetchSseEvents(stockCode, announcementStart, end, '回售').catch(() => []),
      fetchSzseEvents(stockCode, announcementStart, end, '回售').catch(() => []),
      fetchCninfoEvents(stockCode, announcementStart, end, '年度报告').catch(() => []),
      ratingSourceCache.missing ? fetchCninfoEventsByYear(stockCode, prospectusStart, end, '评级').catch(() => []) : Promise.resolve([]),
      fetchSseEvents(stockCode, prospectusStart, end, '评级').catch(() => []),
      fetchSseLatestReport(stockCode).then(report => report ? [report] : []).catch(() => []),
      fetchSzseLatestReport(stockCode, start, end).then(report => report ? [report] : []).catch(() => []),
      needsProspectus ? fetchCninfoEvents(stockCode, prospectusStart, end, '募集说明书').catch(() => []) : Promise.resolve([]),
    ]).then(groups => groups.flat()),
    tushareQuery('trade_cal', { exchange: 'SSE', start_date: end, end_date: tsDateStr(futureCalendarEnd) }, 'cal_date,is_open').catch(() => null),
  ]);
  const reportHolding = holderData ? null : await extractReportFundHolding(announcements);
  const reportPriceHistory = await extractReportPriceHistory(announcements, profile.first_conv_price,
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
  const stockDaily = tsRows(stockDailyData).sort((a,b) => String(b.trade_date).localeCompare(String(a.trade_date)));
  const valuations = tsRows(valuationData).sort((a,b) => String(b.trade_date).localeCompare(String(a.trade_date)));
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
    for (const row of bondDaily) await saveDailyBar(client, ids.bondId, row, sources.tushare);
    for (const row of stockDaily) await saveDailyBar(client, ids.stockId, row, sources.tushare);
    if (valuations[0]) await saveStockValuation(client, ids.stockId, valuations[0], sources.tushare);
    await saveRatingHistory(client, ids.bondId, tsRows(ratingData), sources.tushare);
    await saveRatingOutlooks(client, ids.bondId, ratingOutlooks);
    await savePriceChanges(client, ids.bondId, tsRows(priceChangeData), sources.tushare);
    if (couponData) await saveCouponSchedule(client, ids.bondId, tsRows(couponData), sources.tushare);
    if (holderData) await saveFundHolding(client, ids.bondId, tsRows(holderData), sources.tushare);
    if (reportHolding) await saveReportFundHolding(client, ids.bondId, reportHolding, sources.cninfo || sources.calculated);
    if (prospectusDetails) await saveProspectusDetails(client, ids.bondId, profile, prospectusDetails, sources.cninfo || sources.calculated);
    if (reportPriceHistory) {
      if (reportPriceHistory.price_changes.length) {
        const reportDates = reportPriceHistory.price_changes.map(row => isoDate(row.change_date)).filter(Boolean).sort();
        const firstReportChange = reportPriceHistory.price_changes.find(row => isoDate(row.change_date) === reportDates[0]);
        await client.query(
          `DELETE FROM fundamental.convertible_bond_price_changes WHERE instrument_id=$1 AND
            ((change_date BETWEEN $2 AND $3) OR price_before IS NULL OR price_after IS NULL OR
             (change_date<$2 AND price_before=$4 AND price_after=$5))
            AND COALESCE(raw_payload->>'price_change_parser_version','')<>'2'`,
          [ids.bondId, reportDates[0], reportDates[reportDates.length - 1],
            finite(firstReportChange.convertprice_bef), finite(firstReportChange.convertprice_aft)]
        );
        await savePriceChanges(client, ids.bondId, reportPriceHistory.price_changes, sources.cninfo || sources.calculated);
      }
      await client.query(
        `UPDATE fundamental.convertible_bond_profiles SET raw_payload=raw_payload || jsonb_build_object(
          'price_history_report_url',$2::text,'price_history_parser_version','6') WHERE instrument_id=$1`,
        [ids.bondId, reportPriceHistory.source_url]
      );
    }
    await saveAnnouncementHistories(client, ids.bondId, announcements, profile, sources.cninfo || sources.calculated,
      noRevisionPeriods, priceChangeDetails);
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

  const code = tsCode.slice(0,6), stockShortCode = stockCode.slice(0,6);
  const liveBond = liveQuotes.get(code), liveStock = liveQuotes.get(stockShortCode);
  const synchronizedLive = Boolean(liveBond && liveStock && finite(liveBond.price) > 0 && finite(liveStock.price) > 0);
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
  const putStartDate = putPeriod.period_start || putPeriod.eligible_from;
  const putActive = putPeriod.active && !putOpportunity.used;
  const resetWindow = resetWindowState(extras.no_revision_history);
  const triggerState = {
    call: triggerProgress(stockDaily, termDetails.call, convPrice),
    reset: triggerProgress(stockDaily, termDetails.reset, convPrice, resetWindow.active, resetWindow.eligible_from),
    put: triggerProgress(stockDaily, termDetails.put, convPrice, putActive, putStartDate),
  };
  const futureTradeDates = futureTradeCalendar(tsRows(futureCalendarData));
  const putTimeline = putOpportunity.used
    ? { status: 'opportunity_used', trigger_date: null, payment_date: null, remaining_days: null }
    : estimatePutTimeline(stockDaily, termDetails.put, convPrice, putStartDate, futureTradeDates, stockPrice);
  const maturityFinal = parseMoney(profile.maturity_call_price, 100 + (finite(profile.coupon_rate) || 0));
  const discountRate = creditDiscountRate(profile.newest_rating || profile.issue_rating);
  const interestYear = currentInterestYear(profile.value_date, profile.maturity_date, end);
  const marketPureBond = finite(latestBond.bond_value);
  const pureBond = marketPureBond != null ? marketPureBond
    : presentValue(cashflowsToDate(profile, extras.coupons, profile.maturity_date, false, maturityFinal), discountRate);
  const optionValue = bondPrice != null && pureBond != null ? bondPrice - pureBond : null;
  const maturityPreTax = yieldToMaturity(bondPrice, cashflowsToDate(profile, extras.coupons, profile.maturity_date, false, maturityFinal));
  const maturityAfterTax = yieldToMaturity(bondPrice, cashflowsToDate(profile, extras.coupons, profile.maturity_date, true, maturityFinal));
  const putFinal = parseMoney(profile.put_clause, 100 + (finite(profile.coupon_rate) || 0));
  const putPreTax = putStartDate ? yieldToMaturity(bondPrice, cashflowsToDate(profile, extras.coupons, putStartDate, false, putFinal)) : null;
  const putAfterTax = putStartDate ? yieldToMaturity(bondPrice, cashflowsToDate(profile, extras.coupons, putStartDate, true, putFinal)) : null;
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
    quote: { bond_price: bondPrice, bond_change_pct: synchronizedLive ? finite(liveBond.change) : finite(latestBond.pct_chg),
      stock_price: stockPrice, stock_change_pct: synchronizedLive ? finite(liveStock.change) : null,
      quote_time: synchronizedLive ? liveBond.quote_time : `${isoDate(latestBond.trade_date)}T15:00:00+08:00`,
      source: synchronizedLive ? 'tencent' : 'tushare_close', synchronized: true },
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
      earliest_put_trigger_date: putStartDate, earliest_put_remaining_years: remainingYears(putStartDate),
      expected_put_trigger_date: putTimeline && putTimeline.trigger_date, expected_put_payment_date: putTimeline && putTimeline.payment_date,
      expected_put_remaining_days: putTimeline && putTimeline.remaining_days, expected_put_assumption: putTimeline && putTimeline.assumption,
      expected_put_status: putTimeline && putTimeline.status,
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
  await pool.query(
    `INSERT INTO analytics.analysis_snapshots(instrument_id,as_of_date,snapshot_type,formula_bundle_version,payload,source_watermark)
     VALUES($1,$2,'convertible_bond_analysis',$3,$4::jsonb,$5::jsonb)
     ON CONFLICT(instrument_id,as_of_date,snapshot_type,formula_bundle_version) DO UPDATE SET payload=EXCLUDED.payload,
       source_watermark=EXCLUDED.source_watermark,created_at=now()`,
    [ids.bondId, analysis.as_of, FORMULA_VERSION, JSON.stringify(analysis), JSON.stringify({ reason, quote: analysis.quote.source })]
  );
  return analysis;
}

async function getConvertibleBondSnapshot(value) {
  const tsCode = normalizeBondCode(value);
  if (!tsCode) return null;
  const { rows } = await pool.query(
    `SELECT s.payload,s.created_at FROM core.instruments i JOIN analytics.analysis_snapshots s ON s.instrument_id=i.instrument_id
     WHERE i.canonical_code=$1 AND s.snapshot_type='convertible_bond_analysis'
     ORDER BY s.as_of_date DESC,s.created_at DESC LIMIT 1`, [tsCode]
  );
  return rows[0] ? Object.assign({}, rows[0].payload, { cached_at: rows[0].created_at }) : null;
}

module.exports = {
  finite, yuanToHundredMillion, isoDate, normalizeBondCode, remainingYears, parseTriggerRatio, parseWindow, earliestPutDate, currentPutPeriod, putOpportunityState,
  annualizedVolatility, simplifyClause, triggerProgress, resetWindowState, estimatePutTimeline, parseCouponRates, yieldToMaturity,
  blackScholesConvertible, fallbackPe, currentInterestYear, presentValue, derivedDividendYield, revisionDecision,
  syncConvertibleBondUniverse, refreshConvertibleBondAnalysis, getConvertibleBondSnapshot,
};
