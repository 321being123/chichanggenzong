// 持仓统一估值价格解析（合同 8.2/8.3/8.4）
// 唯一职责：在“账户 + 证券身份 + 市场 + 估值时点 + 价格政策版本”作用域内，
// 为一批证券批量选出唯一的 effectivePrice，并给出币种、价格类型、日期、来源、质量与缺失原因。
// 持仓、总资产、收益、归因和快照都必须消费同一批结果，禁止各自重新选价。
const crypto = require('crypto');
const repository = require('../repositories/effectivePriceRepository');
const { getMarketState } = require('./marketState');
const classifyCode = require('../../public/js/code-classify');

const POLICY_VERSION = 'effective-price-v1';
const CANDIDATE_PER_CODE = 12;
const CLOSE_DATE_LOOKBACK_DAYS = 15;
const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

const QUALITY_RANK = {
  confirmed: 3,
  candidate: 2,
  legacy_unverified: 1,
  stale_reference: 0,
  unverified_reference: -1,
};

const businessDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: SHANGHAI_TIME_ZONE });

function dateKey(value) {
  if (!value) return null;
  if (value instanceof Date) return businessDateFormatter.format(value);
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function shanghaiClock(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(value ? new Date(value) : new Date());
  const map = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return `${map.hour}:${map.minute}`;
}

function shiftDate(date, days) {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function codeVariants(code, isHk) {
  const list = [String(code || '').trim()].filter(Boolean);
  // 历史导入可能把港股五位代码补成六位，只对已确认港股做兼容。
  if (isHk && /^\d{5}$/.test(list[0])) list.push(list[0].padStart(6, '0'));
  if (isHk && /^\d{6}$/.test(list[0]) && list[0].startsWith('0')) list.push(list[0].slice(-5));
  return list;
}

function marketOf(code, subtype, quoteCurrency) {
  const text = String(subtype || '');
  const currency = String(quoteCurrency || '').toUpperCase();
  if (text === '港股' || currency === 'HKD') return 'HK';
  if (text) return 'CN';
  const info = classifyCode(String(code || '')) || {};
  return info.isHK || info.subtype === '港股' ? 'HK' : 'CN';
}

// 最近一个“应有收盘价”的交易日：从 asOf 往前找该市场真实开市日。
// 市场日历缺失返回 null（未知），不用星期几猜开市。
async function expectedCloseDateFor(market, asOfDate, query, cache) {
  for (let offset = 0; offset <= CLOSE_DATE_LOOKBACK_DAYS; offset++) {
    const date = shiftDate(asOfDate, -offset);
    const key = `${market}|${date}`;
    let state = cache.get(key);
    if (state === undefined) {
      state = await getMarketState({ market, businessDate: date, time: '23:59', query });
      cache.set(key, state);
    }
    if (!state || state.status === 'unknown') return null;
    if (state.status === 'open') return date;
  }
  return null;
}

// 当前时点的市场状态（含 isTradingNow / isAfterMarketClose），用于判定取价类型。
// 历史时点不使用该状态：历史价格只取当时已落库的收盘事实。
async function liveMarketStateFor(market, asOfDate, nowAt, query, cache) {
  const key = `${market}|${asOfDate}|live`;
  if (cache.has(key)) return cache.get(key);
  const state = await getMarketState({ market, businessDate: asOfDate, time: shanghaiClock(nowAt), query });
  cache.set(key, state);
  return state;
}

function pickBestByQuality(rows) {
  if (!rows || !rows.length) return null;
  return rows.slice().sort((a, b) => {
    const rankDiff = (QUALITY_RANK[b.quality] ?? 0) - (QUALITY_RANK[a.quality] ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return Number(b.revision || 0) - Number(a.revision || 0);
  })[0];
}

/**
 * 解析一批证券在某个估值时点的唯一生效价格。
 *
 * @param {object} options
 * @param {string} options.username            账户归属主体（来自鉴权上下文，不接受客户端传入）
 * @param {string} options.accountName         账户名
 * @param {Array}  options.subjects            [{ code, market?, subtype?, quoteCurrency? }]
 * @param {string} options.asOf                估值业务日 YYYY-MM-DD
 * @param {'current'|'historical'} options.mode
 * @param {string} [options.at]                当前模式的估值截止时刻（默认取服务器当前时刻）
 * @param {Function} [options.query]           SQL 执行器（必须来自当前事务/连接）
 */
async function resolveEffectivePrices(options = {}) {
  const query = options.query;
  const username = options.username;
  const accountName = options.accountName;
  const mode = options.mode === 'historical' ? 'historical' : 'current';
  const asOf = dateKey(options.asOf) || dateKey(new Date());
  const subjects = dedupeSubjects(options.subjects);
  const nowAt = options.at ? new Date(options.at) : new Date();

  const empty = { asOf, mode, revision: null, prices: new Map(), missing: [], conflicts: [],
    status: { complete: false, partial: true, confirmed: 0, candidate: 0, unverified: 0,
      missingCount: 0, expectedCloseDates: {}, reasonCodes: [] } };
  if (!subjects.length) return empty;

  const stateCache = new Map();
  const marketByCode = new Map();
  const expectedByMarket = new Map();
  const isToday = asOf === dateKey(new Date());
  for (const subject of subjects) {
    const market = subject.market || marketOf(subject.code, subject.subtype, subject.quoteCurrency);
    marketByCode.set(subject.code, market);
    if (!expectedByMarket.has(market)) {
      expectedByMarket.set(market, await expectedCloseDateFor(market, asOf, query, stateCache));
      if (mode === 'current' && isToday) await liveMarketStateFor(market, asOf, nowAt, query, stateCache);
    }
  }

  const codes = subjects.map(subject => subject.code);
  const lookupCodes = new Set();
  for (const subject of subjects) {
    const market = marketByCode.get(subject.code);
    codeVariants(subject.code, market === 'HK').forEach(code => lookupCodes.add(code));
  }
  const lookupList = [...lookupCodes];

  // 仓储层接受外层事务连接；调用方传入的是 SQL 执行器，这里包一层保持同一事务快照。
  const clientLike = query ? { query } : undefined;
  const [dailyRes, cacheRes, positionRes] = await Promise.all([
    query
      ? repository.listRecentDailyPriceCandidates([username, lookupList, asOf, CANDIDATE_PER_CODE], clientLike)
      : { rows: [] },
    mode === 'current'
      ? repository.listQuoteCacheCandidates([lookupList, options.quoteSources || null], clientLike)
      : { rows: [] },
    mode === 'current' && accountName
      ? repository.listPositionPriceCache([username, accountName, lookupList], clientLike)
      : { rows: [] },
  ]);

  const dailyRows = dailyRes.rows || [];
  const cacheRows = cacheRes.rows || [];
  const positionRows = positionRes.rows || [];

  const prices = new Map();
  const missing = [];
  const conflicts = [];
  const reasonCodes = new Set();

  for (const subject of subjects) {
    const code = subject.code;
    const market = marketByCode.get(code);
    const isHk = market === 'HK';
    const expectedCloseDate = expectedByMarket.get(market) || null;
    const variants = codeVariants(code, isHk);
    const ownRows = dailyRows.filter(row => variants.includes(String(row.code)));
    const resolved = resolveOne({
      code, market, isHk, expectedCloseDate, mode, asOf, nowAt, isToday,
      ownRows, cacheRows, positionRows, stateCache, variants,
    });
    if (resolved.conflict) conflicts.push(resolved.conflict);
    if (resolved.price) {
      prices.set(code, resolved.price);
      (resolved.price.reasonCodes || []).forEach(reason => reasonCodes.add(reason));
    } else {
      missing.push(resolved.missing);
      reasonCodes.add(resolved.missing.reason);
    }
  }

  const counts = countQuality(prices);
  const missingCount = missing.length;
  const complete = missingCount === 0 && counts.unverified === 0 && counts.stale === 0;
  const partial = !complete;
  const revision = buildRevision({ username, accountName, mode, asOf, prices, policy: POLICY_VERSION });

  return {
    asOf,
    mode,
    revision,
    policyVersion: POLICY_VERSION,
    prices,
    missing,
    conflicts,
    status: {
      complete,
      partial,
      confirmed: counts.confirmed,
      candidate: counts.candidate,
      unverified: counts.unverified,
      stale: counts.stale,
      missingCount,
      expectedCloseDates: Object.fromEntries([...expectedByMarket.entries()].map(([market, date]) => [market, date])),
      reasonCodes: [...reasonCodes],
    },
  };
}

function dedupeSubjects(subjects) {
  const seen = new Map();
  for (const subject of (subjects || [])) {
    const code = String(subject && subject.code || '').trim();
    if (!code) continue;
    if (!seen.has(code)) seen.set(code, { ...subject, code });
  }
  return [...seen.values()];
}

function countQuality(prices) {
  const counts = { confirmed: 0, candidate: 0, unverified: 0, stale: 0 };
  for (const row of prices.values()) {
    if (row.quality === 'confirmed') counts.confirmed += 1;
    else if (row.quality === 'stale_reference' || row.priceKind === 'stale_close') counts.stale += 1;
    else if (row.quality === 'unverified_reference') counts.unverified += 1;
    else counts.candidate += 1;
  }
  return counts;
}

function buildRevision({ username, accountName, mode, asOf, prices, policy }) {
  const parts = [policy, mode, asOf, username || '', accountName || ''];
  for (const code of [...prices.keys()].sort()) {
    const row = prices.get(code);
    parts.push([code, row.price, row.tradeDate, row.quality, row.revision, row.sourceRef].join(':'));
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

// 单只证券的取价判定：按合同 8.3 的时段表给出价格类型，缺证据时明确缺失原因。
function resolveOne(context) {
  const { code, market, isHk, expectedCloseDate, mode, asOf, nowAt, isToday, ownRows, cacheRows, positionRows, stateCache, variants } = context;
  const currency = isHk ? 'HKD' : 'CNY';
  const empty = reason => ({ missing: { code, market, currency, expectedCloseDate, reason } });

  // 同一证券同一交易日出现不同账户价格时报告冲突：普通市场价格与账户刷新顺序无关，
  // 不能各自给出不同的完整估值。
  const conflict = detectConflict(code, variants, ownRows);
  const result = conflict ? { conflict } : {};

  const rowsForCode = ownRows
    .filter(row => variants.includes(String(row.code)))
    .map(row => ({ ...row, quality: String(row.quality || 'legacy_unverified') }));

  if (!rowsForCode.length && !cacheRows.length && !positionRows.length) {
    return { ...result, ...empty(mode === 'historical' ? 'historical_price_not_recorded' : 'price_not_recorded') };
  }

  let selected = null;
  let priceKind = null;
  let marketState = null;

  if (mode === 'current' && isToday) {
    marketState = stateCache.get(`${market}|${asOf}|live`) || null;
  }

  if (mode === 'current' && marketState && marketState.status === 'open' && marketState.isTradingNow) {
    // 交易中：只接受来源报价时刻落在当日、且报价时间不晚于估值截止的实时候选。
    const todayCache = cacheRows
      .filter(row => variants.includes(String(row.code)))
      .filter(row => row.price > 0)
      .filter(row => dateKey(row.quote_time) === asOf)
      .filter(row => !row.quote_time || new Date(row.quote_time).getTime() <= nowAt.getTime())
      .sort((a, b) => new Date(b.quote_time || b.fetched_at).getTime() - new Date(a.quote_time || a.fetched_at).getTime());
    if (todayCache.length) {
      const row = todayCache[0];
      selected = {
        price: Number(row.price), tradeDate: asOf, quoteAt: row.quote_time || row.fetched_at,
        sourceRef: `market_quote_cache:${row.source}`, quality: 'candidate', revision: 0,
        priceKind: 'realtime',
      };
      priceKind = 'realtime';
    }
  }

  if (!selected) {
    // 收盘/休市/历史：只认已落库日价；当日确认收盘优先，其次当日候选，再次最近有效收盘（标注过期）。
    const dayRows = rowsForCode.filter(row => dateKey(row.date) === expectedCloseDate);
    const exact = pickBestByQuality(dayRows);
    if (exact) {
      selected = {
        price: Number(exact.price), tradeDate: dateKey(exact.date),
        quoteAt: exact.quote_at || null, sourceRef: exact.source || 'daily_prices',
        quality: exact.quality === 'confirmed' ? 'confirmed' : (exact.quality === 'legacy_unverified' ? 'legacy_unverified' : 'candidate'),
        revision: Number(exact.revision || 1),
        priceKind: 'close',
      };
      priceKind = 'close';
    } else {
      const fallback = pickBestByQuality(rowsForCode);
      if (fallback && Number(fallback.price) > 0) {
        selected = {
          price: Number(fallback.price), tradeDate: dateKey(fallback.date),
          quoteAt: fallback.quote_at || null, sourceRef: fallback.source || 'daily_prices',
          quality: 'stale_reference', revision: Number(fallback.revision || 1),
          priceKind: 'stale_close',
        };
        priceKind = 'stale_close';
      }
    }
  }

  if (!selected && mode === 'current') {
    // 最后兜底：内部持仓兼容价。只在完全没有行情证据时使用，且明确标为未核实参考价，
    // 不参与“完整估值”，也不作为收盘事实。
    const cached = positionRows.find(row => variants.includes(String(row.code)) && row.price > 0);
    if (cached) {
      selected = {
        price: Number(cached.price), tradeDate: null, quoteAt: null,
        sourceRef: 'positions.price', quality: 'unverified_reference', revision: 0,
        priceKind: 'position_cache',
      };
      priceKind = 'position_cache';
    }
  }

  if (!selected) {
    if (marketState && marketState.status === 'unknown') return { ...result, ...empty('market_calendar_unknown') };
    if (expectedCloseDate == null) return { ...result, ...empty('expected_close_date_unknown') };
    if (mode === 'historical') return { ...result, ...empty('historical_price_not_recorded') };
    return { ...result, ...empty('no_qualified_price') };
  }

  const reasonCodes = [];
  if (selected.priceKind === 'stale_close') reasonCodes.push('price_date_before_expected_close');
  if (selected.quality === 'unverified_reference') reasonCodes.push('price_unverified_reference');
  if (selected.quality === 'legacy_unverified') reasonCodes.push('price_legacy_unverified');
  if (conflict) reasonCodes.push('cross_account_price_conflict');

  return {
    ...result,
    price: {
      code,
      price: selected.price,
      currency,
      priceKind,
      tradeDate: selected.tradeDate,
      quoteAt: selected.quoteAt,
      sourceRef: selected.sourceRef,
      quality: selected.quality,
      revision: selected.revision,
      expectedCloseDate,
      market,
      reasonCodes,
    },
  };
}

// 同一证券同一交易日跨账户价格不一致 → 报告冲突（不静默各用各的）。
function detectConflict(code, variants, rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!variants.includes(String(row.code))) continue;
    const date = dateKey(row.date);
    if (!date || !(Number(row.price) > 0)) continue;
    if (!byDate.has(date)) byDate.set(date, new Map());
    const bucket = byDate.get(date);
    const key = Number(row.price);
    if (!bucket.has(key)) bucket.set(key, new Set());
    if (row.account_name) bucket.get(key).add(String(row.account_name));
  }
  for (const date of [...byDate.keys()].sort().reverse()) {
    const bucket = byDate.get(date);
    if (bucket.size < 2) continue;
    return {
      code, date,
      prices: [...bucket.entries()].map(([price, accounts]) => ({ price, accounts: [...accounts] })),
    };
  }
  return null;
}

// 历史投影选价（纯函数）：目标日已有落库价就用它；否则在“当日市场确有交易”的历史候选里取最近一条。
// 市场状态必须由调用方用已落库日历给出，禁止在这里猜开市。
// 与当前模式共用同一支算法，避免历史重算与实时估值各写一套价格选择。
function selectHistoricalClosePrice({ exactPrice, candidates, targetDate, marketStatus, tradingStatusOf }) {
  if (marketStatus === 'open') {
    return exactPrice > 0 ? { price: exactPrice, date: targetDate, priceKind: 'close' } : null;
  }
  if (marketStatus !== 'closed') return null;
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (candidate.date >= targetDate || !(candidate.price > 0)) continue;
    if (tradingStatusOf(candidate.date) === 'open') {
      return { price: candidate.price, date: candidate.date, priceKind: 'close' };
    }
  }
  return null;
}

module.exports = {
  resolveEffectivePrices,
  selectHistoricalClosePrice,
  expectedCloseDateFor,
  marketOf,
  dateKey,
  shanghaiClock,
  POLICY_VERSION,
  QUALITY_RANK,
};
