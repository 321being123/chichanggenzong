// 条款/数值等纯工具与常量
// R-10 拆分自 ./convertibleBondAnalysis.js（2026-10-21）：本文件只放条款/数值等纯工具与常量；对外入口仍是 ./convertibleBondAnalysis.js。
const { tushareQuery, tsRows, tsDateStr } = require('./market');
const crypto = require('crypto');
const path = require('path');

const BOND_PREFIX = /^(110|111|113|118|123|127|128)\d{3}$/;

const BOND_FIRSTDAY_SCRIPT = path.resolve(__dirname, '..', '..', 'ipo-report', 'backfill_bond_firstday.py');

const BOND_ISSUE_RESULT_SCRIPT = path.resolve(__dirname, '..', '..', 'ipo-report', 'backfill_bond_shd.py');

const BOND_LIQUIDITY_SCRIPT = path.resolve(__dirname, '..', '..', 'ipo-report', 'sync_bond_listing_liquidity.py');

const PROFILE_FIELDS = [
  'ts_code','bond_full_name','bond_short_name','cb_type','stk_code','stk_short_name','maturity','par','issue_price',
  'issue_size','remain_size','value_date','maturity_date','rate_type','coupon_rate','add_rate','pay_per_year',
  'list_date','delist_date','exchange','conv_start_date','conv_end_date','conv_stop_date','first_conv_price','conv_price',
  'rate_clause','put_clause','maturity_call_price','call_clause','reset_clause','conv_clause','guarantor','guarantee_type',
  'issue_rating','newest_rating','rating_comp'
].join(',');

const DAILY_FIELDS = 'ts_code,trade_date,pre_close,open,high,low,close,change,pct_chg,vol,amount,bond_value,bond_over_rate,cb_value,cb_over_rate';

// 主采集一次拉回完整股票主档，既用于筛选转债正股，也用于建立股票标准层。
// 不增加接口次数，只扩展同一 stock_basic 请求的字段。
const STOCK_STATUS_FIELDS = 'ts_code,symbol,name,area,industry,market,exchange,list_date,list_status,delist_date';

const FORMULA_VERSION = '4';

const { CN_OFFSET_MS, isoDate } = require('../domain/convertibleBondAnalysisRules');

const ANNOUNCEMENT_OVERLAP_DAYS = 3;

// 允许按 TTL 跳过上游的静态/低频数据组。行情与公告不在此列：
// 行情已有 7 天重叠增量，公告参与回售、下修等当期判定，跳过会改变分析结论。
const GATED_BOND_DATASETS = ['cb_basic', 'cb_rating', 'cb_rate', 'top10_cb_holders', 'bond_dividend'];

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

function defaultBondTargetTradeDate() {
  const { expectedTradeDate } = require('../routes/bondCycle');
  return expectedTradeDate();
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

function parseWindow(text, type = '') {
  const clause = String(text || '').replace(/\s+/g, '');
  // 条款常见两种顺序：“连续30个交易日中至少15个”与“任意30个连续交易日中有15个”。
  // 只在“连续 N 个交易日”窗口内取数，避免把“到期后五个交易日内”等日期描述误当观察窗口。
  const number = '[一二两三四五六七八九十百\\d]+';
  // 同一条款会写成“至少有十五个”“有十五个”或“至少十五个”，三种写法含义相同。
  // 只在“连续 N 个交易日”窗口内取数，避免把“到期后五个交易日内”等日期描述误当观察窗口。
  const requirement = '(?:(?:至少)(?:有)?|有)?';
  const patterns = [
    new RegExp(`(?:任意)?(${number})个连续交易日(?:中|内)${requirement}(${number})个交易日`, 'g'),
    new RegExp(`连续(${number})个交易日(?:中|内)${requirement}(${number})个交易日`, 'g'),
  ];
  const candidates = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(clause))) {
      candidates.push({ observation_days: chineseNumber(match[1]), required_days: chineseNumber(match[2]), index: match.index });
    }
  }
  if (!candidates.length) return { observation_days: null, required_days: null };
  // 一个公告可能同时写向上和向下修正；下修条款优先选带“低于/下修”上下文的窗口。
  const selected = type === 'reset'
    ? candidates.find(item => /(向下修正|下修|低于)/.test(clause.slice(Math.max(0, item.index - 90), item.index + 130))) || candidates[0]
    : candidates[0];
  return { observation_days: selected.observation_days, required_days: selected.required_days };
}

function hasNetAssetFloorClause(text) {
  const clause = String(text || '').replace(/\s+/g, '');
  return /(?:不得低于|不应低于|应不低于|不低于)[^。；]{0,60}(?:每股)?净资产/.test(clause);
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
  if (type === 'reset' && /向上修正/.test(clause) && !/(向下修正|下修)/.test(clause)) {
    return { text: null, note: null, ratio: null, observation_days: null, required_days: null, comparison: null,
      parse_status: 'failed', parse_reason: 'upward_revision_clause' };
  }
  const ratio = parseTriggerRatio(clause);
  const window = parseWindow(clause, type);
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
  const netAsset = clause.match(/(?:不得低于|不应低于|应不低于|不低于)[^。；]{0,60}(?:每股)?净资产[^。；]*/);
  return { text: summary || clause, note: netAsset ? netAsset[0] : null, ratio, observation_days: observation,
    required_days: required, comparison, parse_status: ratio != null && observation > 0 && required > 0 && required <= observation ? 'complete' : 'partial' };
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

function couponRowsFromClause(text) {
  return parseCouponRates(text).map((coupon_rate, index) => ({
    interest_year: index + 1,
    coupon_rate,
  }));
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

const REVISION_ANNOUNCEMENT_KEYWORDS = ['转股价格', '转股价', '不下修', '不向下修正', '下修'];

const LIFECYCLE_ANNOUNCEMENT_KEYWORDS = ['可转债发行', '可转换公司债券发行', '可转债上市', '可转换公司债券上市'];

const CALL_ANNOUNCEMENT_KEYWORDS = ['强赎', '提前赎回', '不提前赎回', '赎回实施', '赎回结果', '到期兑付', '即将到期', '停止交易', '最后交易日'];

const UNIFIED_ANNOUNCEMENT_KEYWORDS = [...new Set([...REVISION_ANNOUNCEMENT_KEYWORDS, ...LIFECYCLE_ANNOUNCEMENT_KEYWORDS, ...CALL_ANNOUNCEMENT_KEYWORDS])];

function revisionDecision(title) {
  const text = String(title || '');
  if (/不向下修正|不下修|不修正.{0,12}转股价/.test(text)) return 'no_revision';
  if (/提议|建议|预计触发|可能触发|提示性|股东大会.*议案/.test(text)) return null;
  if (/向下修正.{0,30}转股价格|转股价格.{0,20}(?:向下修正结果|下修结果)/.test(text)) return 'revised';
  return /(?:可转换公司债券)?转股价格调整的公告|调整.{0,20}转股价格的公告/.test(text) ? 'adjusted' : null;
}

const BOND_GAP_QUEUE_SCHEMA_VERSION = 1;

module.exports = {
  BOND_PREFIX,
  BOND_FIRSTDAY_SCRIPT,
  BOND_ISSUE_RESULT_SCRIPT,
  BOND_LIQUIDITY_SCRIPT,
  PROFILE_FIELDS,
  DAILY_FIELDS,
  STOCK_STATUS_FIELDS,
  FORMULA_VERSION,
  CN_OFFSET_MS,
  ANNOUNCEMENT_OVERLAP_DAYS,
  GATED_BOND_DATASETS,
  termsHash,
  finite,
  pricePairFromReason,
  normalizePriceChange,
  normalizePriceChanges,
  yuanToHundredMillion,
  isoDate,
  normalizeBondCode,
  instrumentStatus,
  defaultBondTargetTradeDate,
  remainingYears,
  parseTriggerRatio,
  chineseNumber,
  parseWindow,
  hasNetAssetFloorClause,
  earliestPutDate,
  currentPutPeriod,
  nextPutPeriod,
  putOpportunityState,
  annualizedVolatility,
  simplifyClause,
  triggerProgress,
  resetWindowState,
  estimatePutTimeline,
  futureTradeCalendar,
  parseCouponRates,
  couponRowsFromClause,
  parseMoney,
  addYears,
  addDays,
  cashflowsToDate,
  creditDiscountRate,
  presentValue,
  currentInterestYear,
  derivedDividendYield,
  yieldToMaturity,
  annualizedRedemptionYield,
  accruedPutPrice,
  normalCdf,
  blackScholesConvertible,
  fallbackPe,
  REVISION_ANNOUNCEMENT_KEYWORDS,
  LIFECYCLE_ANNOUNCEMENT_KEYWORDS,
  CALL_ANNOUNCEMENT_KEYWORDS,
  UNIFIED_ANNOUNCEMENT_KEYWORDS,
  revisionDecision,
  BOND_GAP_QUEUE_SCHEMA_VERSION,
};
