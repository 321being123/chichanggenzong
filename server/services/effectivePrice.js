// 持仓统一估值价格解析（合同 8.2/8.3/8.4）
// 唯一职责：在“账户 + 证券身份 + 市场 + 估值时点 + 价格政策版本”作用域内，
// 为一批证券批量选出唯一的 effectivePrice，并给出币种、价格类型、日期、来源、质量与缺失原因。
// 持仓、总资产、收益、归因和快照都必须消费同一批结果，禁止各自重新选价。
const crypto = require('crypto');
const repository = require('../repositories/effectivePriceRepository');
const { getMarketState } = require('./marketState');
const classifyCode = require('../../public/js/code-classify');
const { canonicalizeSecurityCode } = require('./securityIdentity');
const { isDelistedBond } = require('../domain/delistedBond');

const POLICY_VERSION = 'effective-price-v2';
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

// 市场归一：日价存 HK/CN，行情缓存存 hk/sh/sz/bj；同一段代码在不同市场是不同证券，
// 港股 00001 补零后与 A 股 000001 同形，只有市场一起匹配才不会串价。
// 统一价格键：市场 + 规范代码。同一账户可能同时持有 6 位 A 股与补零同形的港股，
// 只按代码做键会丢一只（或把两只的价格混成一只），因此结果与持仓映射都必须带上市场。
function priceKey(market, code) {
  return `${normalizeMarket(market) || 'UNKNOWN'}|${String(code || '').trim()}`;
}

// 来源标签本身带市场（收盘任务写 market_close_task:港股 / 历史补录按品种写），
// 这是可核实的凭据，比单纯按代码形状推断可靠。
function marketFromSource(source) {
  const text = String(source || '');
  if (!text) return null;
  if (/港股|\bHK\b|'HK'|market_close_task:港股/.test(text)) return 'HK';
  if (/A股|沪市|深市|京市|\bCN\b/.test(text)) return 'CN';
  return null;
}

// 日价行属于哪个市场：优先来源标签（可核实），其次 market 列（需有回填依据），
// 最后才是代码形状（5 位→HK；6 位不以 00 开头→CN）。
// 6 位以 00 开头存在“A 股 000001 vs 港股 00001 补零”的同形歧义：
// 没有可核实凭据时返回 UNKNOWN —— 身份不明就是缺口，绝不猜成 A 股。
function dailyRowMarketOf(row) {
  const fromSource = marketFromSource(row && row.source);
  const fromColumn = normalizeMarket(row && row.market);
  const code = String(row && row.code || '');
  if (fromSource && fromColumn && fromSource !== fromColumn) return 'UNKNOWN';
  if (fromSource) return fromSource;
  const basis = String((row && row.evidence && row.evidence.market_basis) || '');
  if (fromColumn) {
    const ambiguous = code.length === 6 && code.startsWith('00');
    if (ambiguous && !basis) return 'UNKNOWN';
    return fromColumn;
  }
  if (code.length === 5) return 'HK';
  if (code.length === 6 && !code.startsWith('00')) return 'CN';
  return 'UNKNOWN';
}

// 持仓行没有 subtype 时（历史数据/兼容调用）按代码长度推断，避免把港股持仓当成 A 股。
function positionMarketOf(row) {
  return normalizeMarket(row && row.subtype) || (String(row && row.code || '').length === 5 ? 'HK' : 'CN');
}

function normalizeMarket(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'hk' || text === '港股') return 'HK';
  if (['sh', 'sz', 'bj', 'cn', '沪市', '深市', '北交所', 'a股'].includes(text)) return 'CN';
  return null;
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

// 跨日期回退最近收盘价时必须先限定最高质量等级（confirmed 优先于 candidate），再按交易日降序与 revision 择优。
function pickLatestBestByQuality(rows) {
  if (!rows || !rows.length) return null;
  return rows.slice().sort((a, b) => {
    const rankDiff = (QUALITY_RANK[b.quality] ?? 0) - (QUALITY_RANK[a.quality] ?? 0);
    if (rankDiff !== 0) return rankDiff;
    const dateDiff = String(dateKey(b.date) || '').localeCompare(String(dateKey(a.date) || ''));
    if (dateDiff !== 0) return dateDiff;
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
    status: { complete: true, partial: false, confirmed: 0, candidate: 0, manualDelisted: 0, unverified: 0,
      stale: 0, legacy: 0, untrusted: 0, conflictCount: 0, missingCount: 0,
      expectedCloseDates: {}, reasonCodes: [] } };
  // 纯现金账户（没有任何需要报价的正数量证券）并不缺价，不能因此判成估值不完整。
  // 空集合的完整性由“没有需要定价的持仓”本身证明，而不是靠有没有价格记录。
  if (!subjects.length) return empty;

  const stateCache = new Map();
  const expectedByMarket = new Map();
  const phaseByMarket = new Map();
  const isToday = asOf === dateKey(new Date());
  const nowClock = shanghaiClock(nowAt);
  for (const subject of subjects) {
    const market = subject.market || marketOf(subject.code, subject.subtype, subject.quoteCurrency);
    subject.market = market;
    if (!expectedByMarket.has(market)) {
      const live = mode === 'current' && isToday
        ? await liveMarketStateFor(market, asOf, nowAt, query, stateCache)
        : null;
      const phase = live ? sessionPhase(live, nowClock) : 'historical';
      phaseByMarket.set(market, phase);
      expectedByMarket.set(market, await expectedCloseDateFor(market, asOf, query, stateCache, phase));
    }
  }

  const lookupCodes = new Set();
  for (const subject of subjects) {
    codeVariants(subject.code, subject.market === 'HK').forEach(code => lookupCodes.add(code));
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
    // 市场必须取自主体本身（同形代码可能一只 CN 一只 HK），不能再按代码回查。
    const market = subject.market;
    const isHk = market === 'HK';
    const expectedCloseDate = expectedByMarket.get(market) || null;
    const variants = codeVariants(code, isHk);
    // 市场 + 代码变体共同匹配：只按代码会把 A 股 000001 当成港股 00001 的候选。
    const rowsForCode = dailyRows.filter(row =>
      variants.includes(String(row.code)) && dailyRowMarketOf(row) === market);
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
      prices.set(priceKey(market, code), resolved.price);
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
  for (const [key, row] of prices.entries()) {
    if (!isTrustworthyPrice(row, stateCache, mode, isToday, asOf)) untrusted.push(key);
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
      manualDelisted: counts.manualDelisted,
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
  // 退市债固定价只在当前估值生效：它来自本账户保留的最后退市价，不是市场收盘价，
  // 但对该账户的当前资产是有效依据；历史重建仍只认当时落库的已确认收盘事实。
  if (row.quality === 'manual_delisted') return mode === 'current';
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
    // 键必须带市场：6 位 A 股与补零同形港股是两只证券，不能合成一只。
    const market = subject.market || marketOf(code, subject.subtype, subject.quoteCurrency);
    const key = priceKey(market, code);
    if (!seen.has(key)) seen.set(key, { ...subject, code, market });
  }
  return [...seen.values()];
}

function countQuality(prices) {
  const counts = { confirmed: 0, candidate: 0, manualDelisted: 0, unverified: 0, stale: 0, legacy: 0 };
  for (const row of prices.values()) {
    if (row.quality === 'confirmed') counts.confirmed += 1;
    else if (row.quality === 'manual_delisted') counts.manualDelisted += 1;
    else if (row.quality === 'legacy_unverified' || row.quality === 'derived_reference') counts.legacy += 1;
    else if (row.quality === 'stale_reference' || row.priceKind === 'stale_close') counts.stale += 1;
    else if (row.quality === 'unverified_reference') counts.unverified += 1;
    else counts.candidate += 1;
  }
  return counts;
}

function buildRevision({ username, accountName, mode, asOf, prices, policy }) {
  const parts = [policy, mode, asOf, username || '', accountName || ''];
  // 键本身就是「市场|代码」，直接参与摘要，避免同形代码互相覆盖版本。
  for (const key of [...prices.keys()].sort()) {
    const row = prices.get(key);
    parts.push([key, row.price, row.tradeDate, row.quality, row.revision, row.sourceRef].join(':'));
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

  const marketCacheRows = cacheRows.filter(row =>
    variants.includes(String(row.code)) && normalizeMarket(row.market) === market);
  const marketPositionRows = positionRows.filter(row =>
    variants.includes(String(row.code)) && positionMarketOf(row) === market);
  // 明确退市债已没有后续行情：账户里保留的最后退市价是当前估值的唯一有效依据。
  // 只认本账户、本市场且为正价的持仓行，识别规则与净值归因/快照共用 delistedBond。
  // 历史模式不从当前持仓倒推价格，缺价仍按历史缺口处理。
  const fixedDelisted = mode === 'current' && market === 'CN'
    ? marketPositionRows.find(row => Number(row.quantity) > 0 && Number.isFinite(Number(row.price))
      && Number(row.price) > 0 && isDelistedBond(row, code))
    : null;
  if (!shared.length && !derived.length && !marketCacheRows.length && !marketPositionRows.length) {
    return empty(mode === 'historical' ? 'historical_price_not_recorded' : 'price_not_recorded');
  }

  let selected = null;
  let priceKind = null;
  let fromDaily = false;
  let marketState = null;

  // 退市固定价优先于遗留/过期日价：后者不能冒充当前收盘价，也不能把旧交易日套到最近应有收盘日。
  // 该价格不是市场收盘事实，不回写 daily_prices，只在当前模式作为本账户的有效估值。
  if (fixedDelisted) {
    selected = {
      price: Number(fixedDelisted.price), tradeDate: null, quoteAt: null,
      sourceRef: 'positions.price', quality: 'manual_delisted', revision: 0,
      priceKind: 'manual_delisted',
    };
    priceKind = 'manual_delisted';
  }

  if (mode === 'current' && isToday) {
    marketState = stateCache.get(`${market}|${asOf}|live`) || null;
  }

  // 盘中与盘中休息（午休/午后未开）都用当日最新有效报价：休息时最新报价就是上午最后成交价，
  // 不能因为此刻不在连续竞价就退回上一交易日的收盘价。
  const intraday = phase === 'in_session' || phase === 'break';
  if (!selected && mode === 'current' && marketState && marketState.status === 'open' && intraday) {
    // 只接受来源报价时刻落在当日、且报价时间不晚于估值截止的实时候选。
    const todayCache = cacheRows
      .filter(row => variants.includes(String(row.code)) && normalizeMarket(row.market) === market)
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
        priceKind: 'close',
      };
      priceKind = 'close';
    } else {
      const fallback = pickLatestBestByQuality(shared);
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
    fromDaily = Boolean(selected);
  }

  if (!selected) {
    // 账户私有派生价（导入锚点固化价等）：仅本账户可用，且明确标为派生参考价，不构成完整估值。
    const anchor = pickLatestBestByQuality(derived);
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
    const cached = positionRows.find(row =>
      variants.includes(String(row.code)) && row.price > 0 && positionMarketOf(row) === market);
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
    ? detectConflictOnDate(code, market, shared, selected.tradeDate, selected.quality)
    : null;

  const reasonCodes = [];
  if (selected.priceKind === 'stale_close') reasonCodes.push('price_date_before_expected_close');
  if (selected.priceKind === 'derived_close') reasonCodes.push('price_derived_from_import_anchor');
  if (selected.quality === 'manual_delisted') reasonCodes.push('price_manual_delisted');
  if (selected.quality === 'unverified_reference') reasonCodes.push('price_unverified_reference');
  if (selected.quality === 'legacy_unverified') reasonCodes.push('price_legacy_unverified');
  if (conflict) reasonCodes.push('cross_account_price_conflict');

  // 退市固定价没有可核实的交易日，也没有“应有收盘日”：两者都留空，不能借用普通证券的日期。
  const resolvedExpectedCloseDate = selected.quality === 'manual_delisted' ? null : expectedCloseDate;

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
      expectedCloseDate: resolvedExpectedCloseDate,
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

// 指定交易日上的价格冲突：同一证券同一交易日，不同账户给出不同价格即算未解决。
// 只与选中价格同一资格档次的行比较（已确认与已确认比较），避免候选价把确认价拖成冲突。
// 冲突结果只描述市场事实本身（有哪些价格），**不带出任何账户或用户标识**：
// 账户接口不能因为核对公开行情而泄露别人的持仓关联信息。
function detectConflictOnDate(code, market, rows, date, quality) {
  const tier = quality === 'confirmed' ? 'confirmed' : 'unconfirmed';
  const prices = new Set();
  for (const row of rows) {
    if (dateKey(row.date) !== date) continue;
    if (!(Number(row.price) > 0)) continue;
    const rowTier = row.quality === 'confirmed' ? 'confirmed' : 'unconfirmed';
    if (rowTier !== tier) continue;
    prices.add(Number(row.price));
  }
  if (prices.size < 2) return null;
  return { code, market, date, priceCount: prices.size, prices: [...prices].sort((a, b) => a - b) };
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

// 停牌参考估值：只使用已核验的不复权终盘成交价，且该价之后的每个开市日均有停牌证据。
// 真实成交日与估值日分开返回；退市日、日历/分区不完整、来源冲突均不兜底。
function suspensionRequest({ code, market, candidate, targetDate }) {
  const actualDate = dateKey(candidate && candidate.date);
  const target = dateKey(targetDate);
  const evidence = candidate && candidate.evidence || {};
  const isUnadjusted = evidence.price_adjust === 'none' || evidence.terminalEvidence === 'unadjusted_bar_match';
  if (market !== 'CN' || !/^\d{6}$/.test(String(code || '')) || !actualDate || !target || actualDate >= target ||
      !(Number(candidate && candidate.price) > 0) || candidate.quality !== 'confirmed' ||
      candidate.isFinal !== true || !candidate.source || PRIVATE_SOURCES.includes(candidate.source) || !isUnadjusted) return null;
  const canonical = canonicalizeSecurityCode(code, 'stock');
  if (!canonical) return null;
  return { canonical, actual_date: actualDate, target_date: target, code: String(code),
    price: Number(candidate.price), source: candidate.source };
}
function suspensionResult(request, row) {
  if (!row || Number(row.calendar_days) <= 0 || Number(row.known_days) !== Number(row.calendar_days) ||
      Number(row.open_days) <= 0 || Number(row.verified_days) !== Number(row.open_days) || row.no_price_conflict !== true) return null;
  return { code: request.code, price: request.price, priceKind: 'suspension_reference', tradeDate: request.actual_date,
    asOfDate: request.target_date, sourceRef: request.source, instrumentId: row.instrument_id,
    suspensionThrough: request.target_date, suspensionOpenDays: Number(row.open_days) };
}
async function resolveSuspendedReference({ code, market, candidate, targetDate, query, cache }) {
  const request = suspensionRequest({ code, market, candidate, targetDate });
  if (!request) return null;
  const { canonical, actual_date: actualDate, target_date: target } = request;
  const key = `${canonical}|${actualDate}|${target}|${Number(candidate.price)}`;
  if (cache && cache.has(key)) return cache.get(key);
  const load = async () => {
    try {
      const result = await repository.inspectSuspensionInterval(
        [canonical, actualDate, target, Number(candidate.price), String(code), PRIVATE_SOURCES],
        query ? { query } : undefined);
      return suspensionResult(request, result.rows[0]);
    } catch (_) {
      return null;
    }
  };
  const pending = load();
  if (cache) cache.set(key, pending);
  return pending;
}

async function resolveSuspendedReferencesBatch(inputs, query) {
  const requests = [];
  inputs.forEach((input, id) => {
    const request = suspensionRequest(input);
    if (request) requests.push({ ...request, id });
  });
  const results = new Map();
  if (!requests.length) return results;
  const requestsById = new Map(requests.map(request => [request.id, request]));
  try {
    const { rows } = await repository.inspectSuspensionIntervals(requests, PRIVATE_SOURCES, query ? { query } : undefined);
    for (const row of rows) {
      const request = requestsById.get(row.id);
      const reference = request && suspensionResult(request, row);
      if (reference) results.set(row.id, reference);
    }
  } catch (_) { /* 查询失败不得把停牌证据视为完整 */ }
  return results;
}

async function loadSwapReferenceCandidates(username, accountName, query) {
  try {
    const { rows } = await repository.listSwapReferenceCandidates(username, accountName, query ? { query } : undefined);
    return rows;
  } catch (_) { return []; }
}
function resolveSwapReference({ code, market, quantity, valuationDate, expectedCloseDate, candidates }) {
  if (market !== 'CN' || !(Number(quantity)>0) || !expectedCloseDate || !valuationDate) return null;
  const matches=(candidates||[]).filter(row => row.source_code===String(code) &&
    Number(row.source_quantity)===Number(quantity) && row.price_date===expectedCloseDate &&
    row.delist_date<=valuationDate && valuationDate<row.execution_date && Number(row.target_quantity)>0 && Number(row.target_price)>0);
  if (matches.length!==1) return null;
  const row=matches[0];
  return {code:String(code),price:Number(row.target_price)*Number(row.target_quantity)/Number(row.source_quantity),
    priceKind:'swap_reference',estimated:true,targetCode:row.target_code,targetQuantity:Number(row.target_quantity),
    targetPrice:Number(row.target_price),tradeDate:row.price_date,asOfDate:valuationDate,
    settlementDate:row.settlement_date,executionDate:row.execution_date,evidenceDate:row.evidence_date,
    documentId:row.evidence_document_id,settlementId:row.settlement_id,sourceRef:row.price_source};
}

module.exports = {
  resolveEffectivePrices,
  priceKey,
  marketFromSource,
  dailyRowMarketOf,
  normalizeMarket,
  selectHistoricalClosePrice,
  resolveSuspendedReference,
  resolveSuspendedReferencesBatch,
  loadSwapReferenceCandidates,
  resolveSwapReference,
  sessionPhase,
  expectedCloseDateFor,
  marketOf,
  dateKey,
  shanghaiClock,
  POLICY_VERSION,
  QUALITY_RANK,
  PRIVATE_SOURCES,
  codeVariants,
  pickBestByQuality,
  detectConflictOnDate,
};
