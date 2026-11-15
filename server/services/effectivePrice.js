// 持仓统一估值价格解析（合同 8.2/8.3/8.4）
// 唯一职责：在“账户 + 证券身份 + 市场 + 估值时点 + 价格政策版本”作用域内，
// 为一批证券批量选出唯一的 effectivePrice，并给出币种、价格类型、日期、来源、质量与缺失原因。
// 持仓、总资产、收益、归因和快照都必须消费同一批结果，禁止各自重新选价。
const crypto = require('crypto');
const repository = require('../repositories/effectivePriceRepository');
const { getMarketState } = require('./marketState');
const classifyCode = require('../../public/js/code-classify');

const POLICY_VERSION = 'effective-price-v1';
// 最近多少个交易日参与选价/冲突核对（同一证券同一交易日的跨账户/跨用户记录都会读到）。
const RECENT_DATE_WINDOW = 6;
const CLOSE_DATE_LOOKBACK_DAYS = 15;
// 账户私有派生价来源：这类行不是市场事实，只回给其所属账户，不参与跨用户选价与冲突核对。
const PRIVATE_SOURCES = ['nav_import_anchor'];
const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

const QUALITY_RANK = {
  confirmed: 3,
  candidate: 2,
  legacy_unverified: 1,
  derived_reference: 1,
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

const MARKET_OPEN_CLOCK = '09:30';

// 交易时段阶段：盘前、连续竞价中、盘中休息（午休/港股午后未开）、已收盘、非交易日、未知。
// 盘前当日还没有收盘价，最近“应有收盘日”是上一交易日；午休仍属当日，只是最新行情停在上午。
function sessionPhase(live, nowClock) {
  if (!live || live.status === 'unknown') return 'unknown';
  if (live.status === 'closed') return 'closed_day';
  if (live.isAfterMarketClose === true) return 'after_close';
  if (live.isTradingNow === true) return 'in_session';
  return nowClock && nowClock < MARKET_OPEN_CLOCK ? 'pre_open' : 'break';
}

// 最近一个“应有收盘价”的交易日：从 asOf 往前找该市场真实开市日。
// phase 决定起点：盘前与非交易日从上一日开始找，盘中/休息/收盘后从当日开始找。
// 市场日历缺失返回 null（未知），不用星期几猜开市。
async function expectedCloseDateFor(market, asOfDate, query, cache, phase) {
  const startOffset = phase === 'pre_open' || phase === 'closed_day' ? 1 : 0;
  for (let offset = startOffset; offset <= CLOSE_DATE_LOOKBACK_DAYS; offset++) {
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
    status: { complete: true, partial: false, confirmed: 0, candidate: 0, unverified: 0,
      stale: 0, legacy: 0, untrusted: 0, conflictCount: 0, missingCount: 0,
      expectedCloseDates: {}, reasonCodes: [] } };
  // 纯现金账户（没有任何需要报价的正数量证券）并不缺价，不能因此判成估值不完整。
  // 空集合的完整性由“没有需要定价的持仓”本身证明，而不是靠有没有价格记录。
  if (!subjects.length) return empty;

  const stateCache = new Map();
  const marketByCode = new Map();
  const expectedByMarket = new Map();
  const phaseByMarket = new Map();
  const isToday = asOf === dateKey(new Date());
  const nowClock = shanghaiClock(nowAt);
  for (const subject of subjects) {
    const market = subject.market || marketOf(subject.code, subject.subtype, subject.quoteCurrency);
    marketByCode.set(subject.code, market);
    if (!expectedByMarket.has(market)) {
      const live = mode === 'current' && isToday
        ? await liveMarketStateFor(market, asOf, nowAt, query, stateCache)
        : null;
      const phase = live ? sessionPhase(live, nowClock) : 'historical';
      phaseByMarket.set(market, phase);
      expectedByMarket.set(market, await expectedCloseDateFor(market, asOf, query, stateCache, phase));
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
      ? repository.listRecentDailyPriceCandidates(
          [username, lookupList, asOf, PRIVATE_SOURCES, RECENT_DATE_WINDOW], clientLike)
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
    const rowsForCode = dailyRows.filter(row => variants.includes(String(row.code)));
    // 普通证券的收盘价是公开市场事实：跨账户、跨用户都读同一批行，不再按用户各选一份。
    const sharedRows = rowsForCode.filter(row => !PRIVATE_SOURCES.includes(String(row.source || '')));
    // 账户私有派生价（导入锚点固化价等）只允许本账户兜底使用，不冒充市场收盘价。
    const ownPrivateRows = rowsForCode.filter(row => PRIVATE_SOURCES.includes(String(row.source || ''))
      && String(row.username || '') === String(username || '')
      && String(row.account_name || '') === String(accountName || ''));
    const resolved = resolveOne({
      code, market, isHk, expectedCloseDate, mode, asOf, nowAt, isToday,
      sharedRows, ownPrivateRows, cacheRows, positionRows, stateCache, variants,
      phase: phaseByMarket.get(market) || 'historical',
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

  // 完整性按“价格资格”判定，而不是按“有没有拿到一个数字”判定：
  // 只有已确认收盘价，或当日正在交易时段的实时候选，才算可信；
  // 遗留未核验价、收盘后仍未确认终盘的候选、过期价、兼容持仓价都不构成完整估值。
  const counts = countQuality(prices);
  const untrusted = [];
  for (const [code, row] of prices.entries()) {
    if (!isTrustworthyPrice(row, stateCache, mode, isToday, asOf)) untrusted.push(code);
  }
  const missingCount = missing.length;
  const conflictCount = conflicts.length;
  const complete = missingCount === 0 && untrusted.length === 0 && conflictCount === 0;
  const partial = !complete;
  if (untrusted.length) reasonCodes.add('price_not_confirmed');
  if (conflictCount) reasonCodes.add('cross_account_price_conflict');
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
      legacy: counts.legacy,
      untrusted: untrusted.length,
      untrustedCodes: untrusted,
      conflictCount,
      missingCount,
      expectedCloseDates: Object.fromEntries([...expectedByMarket.entries()].map(([market, date]) => [market, date])),
      reasonCodes: [...reasonCodes],
    },
  };
}

// 价格资格：已确认收盘一律可信；当日交易时段内的实时候选属于“当前价”，可参与当前估值；
// 其余（收盘后仍未确认终盘的候选、遗留未核验、过期、兼容持仓价）都不可信。
function isTrustworthyPrice(row, stateCache, mode, isToday, asOf) {
  if (row.quality === 'confirmed') return true;
  if (row.quality !== 'candidate') return false;
  if (mode !== 'current' || !isToday) return false;
  const live = stateCache.get(`${row.market}|${asOf}|live`);
  if (!live || live.status !== 'open') return false;
  // 盘中与盘中休息都允许用当日最新行情作为“当前价”，盘中休息时它就是上午最后成交。
  return live.isTradingNow === true || (row.priceKind === 'intraday_last' && live.isAfterMarketClose !== true);
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
  const counts = { confirmed: 0, candidate: 0, unverified: 0, stale: 0, legacy: 0 };
  for (const row of prices.values()) {
    if (row.quality === 'confirmed') counts.confirmed += 1;
    else if (row.quality === 'legacy_unverified' || row.quality === 'derived_reference') counts.legacy += 1;
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
  const { code, market, isHk, expectedCloseDate, mode, asOf, nowAt, isToday,
    sharedRows, ownPrivateRows, cacheRows, positionRows, stateCache, variants, phase } = context;
  const currency = isHk ? 'HKD' : 'CNY';
  const empty = reason => ({ missing: { code, market, currency, expectedCloseDate, reason }, conflict: null });

  const shared = sharedRows.filter(row => variants.includes(String(row.code))).map(normalizeDailyRow);
  const derived = ownPrivateRows.filter(row => variants.includes(String(row.code))).map(normalizeDailyRow);

  if (!shared.length && !derived.length && !cacheRows.length && !positionRows.length) {
    return empty(mode === 'historical' ? 'historical_price_not_recorded' : 'price_not_recorded');
  }

  let selected = null;
  let priceKind = null;
  let fromDaily = false;
  let marketState = null;

  if (mode === 'current' && isToday) {
    marketState = stateCache.get(`${market}|${asOf}|live`) || null;
  }

  // 盘中与盘中休息（午休/午后未开）都用当日最新有效报价：休息时最新报价就是上午最后成交价，
  // 不能因为此刻不在连续竞价就退回上一交易日的收盘价。
  const intraday = phase === 'in_session' || phase === 'break';
  if (mode === 'current' && marketState && marketState.status === 'open' && intraday) {
    // 只接受来源报价时刻落在当日、且报价时间不晚于估值截止的实时候选。
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
        priceKind: phase === 'break' ? 'intraday_last' : 'realtime',
      };
      priceKind = selected.priceKind;
    }
  }

  if (!selected) {
    // 收盘/休市/历史：只认已落库的共享市场日价；当日确认收盘优先，其次最近有效收盘（标注过期）。
    const dayRows = shared.filter(row => dateKey(row.date) === expectedCloseDate);
    const exact = pickBestByQuality(dayRows);
    if (exact) {
      selected = {
        price: Number(exact.price), tradeDate: dateKey(exact.date),
        quoteAt: exact.quote_at || null, sourceRef: exact.source || 'daily_prices',
        quality: exact.quality, revision: Number(exact.revision || 1),
        priceKind: 'close', accounts: accountsOf(exact),
      };
      priceKind = 'close';
    } else {
      const fallback = pickBestByQuality(shared);
      if (fallback && Number(fallback.price) > 0) {
        selected = {
          price: Number(fallback.price), tradeDate: dateKey(fallback.date),
          quoteAt: fallback.quote_at || null, sourceRef: fallback.source || 'daily_prices',
          quality: 'stale_reference', revision: Number(fallback.revision || 1),
          priceKind: 'stale_close', accounts: accountsOf(fallback),
        };
        priceKind = 'stale_close';
      }
    }
    fromDaily = Boolean(selected);
  }

  if (!selected) {
    // 账户私有派生价（导入锚点固化价等）：仅本账户可用，且明确标为派生参考价，不构成完整估值。
    const anchor = pickBestByQuality(derived);
    if (anchor && Number(anchor.price) > 0) {
      selected = {
        price: Number(anchor.price), tradeDate: dateKey(anchor.date),
        quoteAt: anchor.quote_at || null, sourceRef: anchor.source || 'nav_import_anchor',
        quality: 'derived_reference', revision: Number(anchor.revision || 1),
        priceKind: 'derived_close',
      };
      priceKind = 'derived_close';
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
    if (marketState && marketState.status === 'unknown') return empty('market_calendar_unknown');
    if (expectedCloseDate == null) return empty('expected_close_date_unknown');
    if (mode === 'historical') return empty('historical_price_not_recorded');
    return empty('no_qualified_price');
  }

  // 冲突只针对“本次选中的那个交易日”：更早日期历史价不一致属于历史审计，
  // 不应当把当前已经一致的估值标成不完整。
  const conflict = fromDaily && selected.tradeDate
    ? detectConflictOnDate(code, shared, selected.tradeDate, selected.quality)
    : null;

  const reasonCodes = [];
  if (selected.priceKind === 'stale_close') reasonCodes.push('price_date_before_expected_close');
  if (selected.priceKind === 'derived_close') reasonCodes.push('price_derived_from_import_anchor');
  if (selected.quality === 'unverified_reference') reasonCodes.push('price_unverified_reference');
  if (selected.quality === 'legacy_unverified') reasonCodes.push('price_legacy_unverified');
  if (conflict) reasonCodes.push('cross_account_price_conflict');

  return {
    conflict,
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

function normalizeDailyRow(row) {
  const quality = String(row.quality || 'legacy_unverified');
  return {
    ...row,
    quality: quality === 'anchor_carry_forward' ? 'derived_reference' : quality,
  };
}

function accountsOf(row) {
  const owner = [row.username, row.account_name].filter(Boolean).join('/');
  return owner ? [owner] : [];
}

// 指定交易日上的价格冲突：同一证券同一交易日，不同账户给出不同价格即算未解决。
// 只与选中价格同一资格档次的行比较（已确认与已确认比较），避免候选价把确认价拖成冲突。
function detectConflictOnDate(code, rows, date, quality) {
  const tier = quality === 'confirmed' ? 'confirmed' : 'unconfirmed';
  const byPrice = new Map();
  for (const row of rows) {
    if (dateKey(row.date) !== date) continue;
    if (!(Number(row.price) > 0)) continue;
    const rowTier = row.quality === 'confirmed' ? 'confirmed' : 'unconfirmed';
    if (rowTier !== tier) continue;
    const price = Number(row.price);
    if (!byPrice.has(price)) byPrice.set(price, new Set());
    accountsOf(row).forEach(owner => byPrice.get(price).add(owner));
  }
  if (byPrice.size < 2) return null;
  return {
    code,
    date,
    prices: [...byPrice.entries()].map(([price, accounts]) => ({ price, accounts: [...accounts] })),
  };
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
  sessionPhase,
  expectedCloseDateFor,
  marketOf,
  dateKey,
  shanghaiClock,
  POLICY_VERSION,
  QUALITY_RANK,
};
