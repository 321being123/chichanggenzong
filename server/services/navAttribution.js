const layerRepository = require('../repositories/navAttributionRepository');
const NavMath = require('../../public/shared/nav-math');
// 净值涨跌归因的唯一后端实现。
// 前端只展示结果，不再自行拼接价格、汇率和账本公式。
const { pool } = require('../db/connection');
const { isDelistedBond } = require('../domain/delistedBond');
const businessDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });

// 日价行的市场：缺 market（迁移前旧行/测试夹具）时按代码长度推断（5 位港股、6 位 A 股），
// 与迁移回填规则一致，且是“失败关闭”——不匹配就是缺价，不会拿另一只证券的价格顶上。
// 迁移已明确判定身份不明的行（UNKNOWN）不得再按长度猜：六位代码也可能是补零后的港股代码，
// 猜成 A 股会把另一只证券的价格算进历史资产；返回 UNKNOWN 使其永不等于任何持仓市场，价格保留为缺口。
function priceRowMarket(row) {
  const text = String((row && row.market) || '').toUpperCase();
  if (text === 'HK' || text === 'CN') return text;
  if (text) return 'UNKNOWN';
  return String((row && row.code) || '').length === 5 ? 'HK' : 'CN';
}

// 港股 5/6 位是同一只证券的别名：分组、冲突与选价统一归一到 5 位键。
// 仅对 HK 生效，A 股 000001 与港股 00001 仍按市场隔离，绝不合并。
function priceCodeKey(code, market) {
  const text = String(code || '').trim();
  if (market === 'HK' && /^0\d{5}$/.test(text)) return text.slice(1);
  return text;
}

function dateKey(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return businessDateFormatter.format(value);
  }
  return String(value).slice(0, 10);
}

function timestamp(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function eventTimestamp(row) {
  return NavMath.eventTime(row, dateKey(row.trade_date || row.date));
}

function eventInInterval(row, eventDate, startDate, endDate, startAt, endAt) {
  if (eventDate < startDate || eventDate > endDate) return false;
  if (eventDate > startDate && eventDate < endDate) return true;
  const eventAt = eventTimestamp(row);
  if (eventAt != null && startAt != null && endAt != null) {
    return eventAt > startAt && eventAt <= endAt;
  }
  return eventDate > startDate && eventDate <= endDate;
}

function eventAtOrBefore(row, eventDate, snapshotDate, snapshotAt) {
  if (eventDate < snapshotDate) return true;
  if (eventDate > snapshotDate) return false;
  const eventAt = eventTimestamp(row);
  const cutoffAt = timestamp(snapshotAt);
  return eventAt == null || cutoffAt == null || eventAt <= cutoffAt;
}

function cashAtSnapshot(data, snapshotDate, snapshotAt) {
  return NavMath.cashAt(data, snapshotDate, snapshotAt);
}
function isAuthoritativeSnapshot(nav) {
  return nav.snapshotSource === 'imported' || nav.diagnostics?.manualNavOverride === true;
}

function latestImportedPositionAnchor(data, date) {
  const imports = (data.navHistory || []).filter((n) => n.snapshotSource === 'imported' && n.isLocked !== false &&
    dateKey(n.date) <= date)
    .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)) ||
      (timestamp(a.snapshot_at) || 0) - (timestamp(b.snapshot_at) || 0));
  const imported = imports.length ? imports[imports.length - 1] : null;
  const systemNav = (data.navHistory || []).filter(n => dateKey(n.date) <= date &&
    n.diagnostics?.homepageBasis?.version === 'homepage-v1' && Array.isArray(n.diagnostics.homepageBasis.positions))
    .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date))).at(-1);
  const systemSnapshots = systemNav ? systemNav.diagnostics.homepageBasis.positions.map(p => ({ ...p,
    snapshotDate: dateKey(systemNav.date), snapshotId: 'nav:' + dateKey(systemNav.date), source: 'system_nav',
    quoteCurrency: p.subtype === '港股' ? 'HKD' : 'CNY' })) : [];
  const snapshots = (data.positionSnapshots || []).concat(systemSnapshots).filter((s) => dateKey(s.snapshotDate || s.date) <= date);
  if (!snapshots.length) return null;

  // 人工校准快照是对旧导入锚点的明确修订；同一账户存在更晚的校准快照时，
  // 必须优先使用它，否则旧批次会遮蔽修复后的基准数量。
  const importedDate = imported ? dateKey(imported.date) : '';
  const manualDates = snapshots
    .filter((s) => ['manual_reconciliation', 'system_nav'].includes(String(s.source || '')))
    .map((s) => dateKey(s.snapshotDate || s.date))
    .filter((d) => d > importedDate);
  const latestManualDate = manualDates.length ? manualDates.reduce((max, d) => d > max ? d : max, '') : '';
  let rows = latestManualDate
    ? snapshots.filter((s) => ['manual_reconciliation', 'system_nav'].includes(String(s.source || '')) &&
        dateKey(s.snapshotDate || s.date) === latestManualDate)
    : (imported && imported.importBatchId
      ? snapshots.filter((s) => String(s.snapshotId) === String(imported.importBatchId))
      : []);
  if (!rows.length) {
    const latestDate = imported ? dateKey(imported.date) : snapshots.reduce((max, s) => {
      const d = dateKey(s.snapshotDate || s.date);
      return d > max ? d : max;
    }, '');
    rows = snapshots.filter((s) => dateKey(s.snapshotDate || s.date) === latestDate);
  }
  if (!rows.length) return null;
  const anchorDate = rows.reduce((max, s) => {
    const d = dateKey(s.snapshotDate || s.date);
    return d > max ? d : max;
  }, '');
  return { anchorDate, rows };
}

// 证券身份：市场 + 代码。同一段代码在不同市场是两只证券（A 股 000001 / 港股 00001 补零），
// 归因的持仓数量、交易与快照都必须按身份合并，只按代码会把两只证券合成一只。
function instrumentMarket(code, subtype, currency) {
  const text = String(subtype || '');
  if (text === '港股' || String(currency || '').toUpperCase() === 'HKD') return 'HK';
  if (text) return 'CN';
  const codeText = String(code || '');
  if (codeText.length === 5) return 'HK';
  if (codeText.length === 6 && !codeText.startsWith('00')) return 'CN';
  return 'UNKNOWN';
}

function identityOf(code, subtype, currency) {
  return `${instrumentMarket(code, subtype, currency)}|${String(code || '')}`;
}

function quantityAsOf(data, date, snapshotAt) {
  const map = new Map();
  const trades = (data.trades || []).slice().sort((a, b) => {
    const ad = String(a.trade_date || a.date || '').slice(0, 10);
    const bd = String(b.trade_date || b.date || '').slice(0, 10);
    return ad.localeCompare(bd) || String(a.executed_at || a.date || '').localeCompare(String(b.executed_at || b.date || ''));
  });
  // 交易/快照没写 subtype 时，只有该代码在已知持仓里唯一时才能借用其身份；
  // 否则保持 UNKNOWN（身份不明），不猜成 A 股。
  const resolveIdentity = (code, subtype, currency) => {
    const direct = identityOf(code, subtype, currency);
    if (!direct.startsWith('UNKNOWN|')) return direct;
    const matches = [...map.keys()].filter(key => key.endsWith(`|${code}`));
    return matches.length === 1 ? matches[0] : direct;
  };
  // 券商导入快照是该时点的持仓事实；历史交易可能包含旧导入重复行，
  // 因此只能从快照之后重放交易，不能把快照之前的账本再次累加。
  const importedAnchor = latestImportedPositionAnchor(data, date);
  if (importedAnchor) {
    for (const s of importedAnchor.rows) {
      const code = String(s.code || s.instrumentCode || '');
      if (!code) continue;
      const currency = String(s.quoteCurrency || '').toUpperCase();
      const key = identityOf(code, currency === 'HKD' ? '港股' : '', currency);
      map.set(key, { code, market: instrumentMarket(code, currency === 'HKD' ? '港股' : '', currency),
        quantity: Number(s.quantity) || 0, subtype: currency === 'HKD' ? '港股' : '' });
    }
  }
  if (trades.length) {
    for (const t of trades) {
      const td = String(t.trade_date || t.date || '').slice(0, 10);
      if (importedAnchor && td <= importedAnchor.anchorDate) continue;
      if (!eventAtOrBefore(t, td, date, snapshotAt)) continue;
      const code = String(t.code || '');
      if (!code) continue;
      const key = resolveIdentity(code, t.subtype, t.quote_currency);
      const row = map.get(key) || { code, market: key.split('|')[0], quantity: 0, subtype: t.subtype || '' };
      if (t.direction === 'sell') row.quantity -= Number(t.quantity) || 0;
      else if (t.direction === 'adjust') row.quantity = Math.max(0, Number(t.quantity) || 0);
      else row.quantity += Number(t.quantity) || 0;
      row.subtype = t.subtype || row.subtype;
      map.set(key, row);
    }
  }
  // 没有完整交易历史的持仓，按当前持仓补入；但基准日之后已经发生过交易的代码
  // 不能这样补入，否则会把“基准日后的新买入”错误地算成基准日已有持仓。
  for (const p of (data.positions || [])) {
    const code = String(p.code || '');
    if (!code) continue;
    const key = identityOf(code, p.subtype, p.quoteCurrency || p.quote_currency);
    if (map.has(key)) continue;
    const hasFutureTrade = trades.some((t) => String(t.code || '') === code &&
      String(t.trade_date || t.date || '').slice(0, 10) > date);
    if (!hasFutureTrade) {
      map.set(key, { code, market: instrumentMarket(code, p.subtype, p.quoteCurrency || p.quote_currency),
        quantity: Number(p.quantity) || 0, subtype: p.subtype || '' });
    }
  }
  // 导入快照是历史锚点；若锚点之后到基准日没有交易，而当前持仓已被校正，
  // 以当前持仓现状为准，避免旧快照数量把合法的子账户拆分重复误判为重复交易。
  if (importedAnchor) {
    // 同一证券可能因分批持仓/导入拆分而有多行，必须先合并数量，
    // 不能逐行覆盖基准数量（否则最后一行会丢掉前面批次）。
    const currentByIdentity = aggregateCurrentPositions(data.positions);
    for (const [key, p] of currentByIdentity) {
      if (!key) continue;
      const changedAfter = trades.some((t) => String(t.trade_date || t.date || '').slice(0, 10) > date &&
        String(t.code || '') === p.code &&
        (identityOf(t.code, t.subtype, t.quote_currency).startsWith('UNKNOWN|') || identityOf(t.code, t.subtype, t.quote_currency) === key));
      if (changedAfter) continue;
      const currentQuantity = Number(p.quantity) || 0;
      const row = map.get(key);
      if (!row || Math.abs((Number(row.quantity) || 0) - currentQuantity) > 0.0001) {
        map.set(key, { code: p.code, market: p.market, quantity: currentQuantity,
          subtype: p.subtype || (row && row.subtype) || '' });
      }
    }
  }
  // 当前持仓表是现状权威：若某证券当前已不存在，且基准日之后没有交易，
  // 交易历史中的残余数量不能被继续当成基准日持仓（典型是券商数量单位修正后留下的 1 股尾差）。
  const currentIdentities = new Set([...aggregateCurrentPositions(data.positions).keys()]);
  for (const key of [...map.keys()]) {
    if (currentIdentities.has(key)) continue;
    const row = map.get(key);
    const changedAfter = trades.some((t) => String(t.trade_date || t.date || '').slice(0, 10) > date &&
      String(t.code || '') === (row && row.code) &&
      (identityOf(t.code, t.subtype, t.quote_currency).startsWith('UNKNOWN|') || identityOf(t.code, t.subtype, t.quote_currency) === key));
    if (!changedAfter) map.delete(key);
  }
  return map;
}

function aggregateCurrentPositions(positions) {
  const map = new Map();
  for (const p of (positions || [])) {
    const code = String(p.code || '');
    if (!code) continue;
    const market = instrumentMarket(code, p.subtype, p.quoteCurrency || p.quote_currency);
    const key = `${market}|${code}`;
    const current = map.get(key);
    if (!current) {
      map.set(key, { ...p, code, market, quantity: Number(p.quantity) || 0 });
      continue;
    }
    current.quantity += Number(p.quantity) || 0;
    if (!current.price && Number(p.price) > 0) current.price = Number(p.price);
    if (!current.subtype && p.subtype) current.subtype = p.subtype;
    if (!current.name && p.name) current.name = p.name;
  }
  return map;
}

function tradePriceAtEnd(data, code, startDate, endDate, startAt, endAt) {
  const rows = (data.trades || []).filter((t) => String(t.code || '') === code &&
    t.direction === 'sell' && eventInInterval(t, dateKey(t.trade_date || t.date), startDate, endDate, startAt, endAt) &&
    Number(t.price) > 0).sort((a, b) => (eventTimestamp(a) || 0) - (eventTimestamp(b) || 0));
  return rows.length ? Number(rows[rows.length - 1].price) : null;
}

function priceAt(priceMap, date, code, isHk) {
  const variants = [code];
  // 历史导入可能把港股五位代码补成六位；只对已确认港股做兼容，避免误合并 A 股代码。
  if (isHk && /^\d{5}$/.test(code)) variants.push(code.padStart(6, '0'));
  for (const variant of variants) {
    const value = priceMap.get(date + '|' + variant);
    if (value != null) return value;
  }
  return null;
}

// 退市债券可能已没有外部行情，但持仓里保留了用户填写的最后退市价。
// 仅对明确标记为退市债的证券启用该固定价，避免把普通证券的旧价格误当成归因依据。
// 识别规则与统一估值共用 delistedBond，不在这里复制一份代码/名称判定。
function manualDelistedPrice(data, code, currentPosition) {
  const candidates = [];
  if (isDelistedBond(currentPosition, code)) candidates.push(currentPosition && currentPosition.price);
  for (const snapshot of (data.positionSnapshots || [])) {
    if (String(snapshot.code || snapshot.instrumentCode || '') !== String(code)) continue;
    if (isDelistedBond(snapshot, code)) candidates.push(snapshot.price);
  }
  // 已清仓的退市债没有当前持仓时，最后一笔成交价仍可作为同一固定价兜底。
  for (const trade of (data.trades || []).slice().reverse()) {
    if (String(trade.code || '') !== String(code)) continue;
    if (isDelistedBond(trade, code)) candidates.push(trade.price);
  }
  const price = candidates.find(value => Number.isFinite(Number(value)) && Number(value) > 0);
  return price == null ? null : Number(price);
}

// 与首页期初资产共用：导入值保持券商事实，系统快照按本地收盘价、历史数量及现金重建。
function snapshotTotal(data, nav, quantities, priceFor, rate) {
  if (isAuthoritativeSnapshot(nav)) {
    return nav.totalAsset != null && Number.isFinite(Number(nav.totalAsset)) ? Number(nav.totalAsset) : null;
  }
  const cash = cashAtSnapshot(data, dateKey(nav.date), nav.snapshot_at);
  if (cash.incomplete) return null;
  let total = cash.value;
  for (const row of quantities.values()) {
    const quantity = Number(row.quantity) || 0;
    if (quantity < 0) return null;
    if (!quantity) continue;
    // 市场取自持仓身份本身：同形代码（A 股 000001 / 港股 00001）不能互相顶替。
    const isHk = row.market === 'HK' || row.subtype === '港股';
    const price = priceFor(row.code, isHk);
    if (!(price > 0) || (isHk && !(rate > 0))) return null;
    total += quantity * price * (isHk ? rate : 1);
  }
  return Number.isFinite(total) ? total : null;
}

// 历史资产与归因共用的单日选价：同日 confirmed 冲突整日不可用；否则按
// effectivePrice 的质量排序择优，并保留该行是否具备 confirmed/final 资格。
// 只返回一条业务结果，避免两处各写一套“同日质量/冲突”算法。
function selectDailyPrice(rows, code, market) {
  const date = rows.length ? dateKey(rows[0].date) : null;
  if (!date) return { row: null, conflict: null };
  const { detectConflictOnDate, pickBestByQuality } = require('./effectivePrice');
  const conflict = detectConflictOnDate(code, market, rows, date, 'confirmed');
  if (conflict) return { row: null, conflict };
  const positive = rows.filter(row => Number(row.price) > 0);
  const qualified = positive.filter(row =>
    String(row.quality || 'legacy_unverified') === 'confirmed' || row.is_final === true);
  const chosen = pickBestByQuality(qualified) || pickBestByQuality(positive);
  if (!chosen) return { row: null, conflict: null };
  return {
    row: {
      date, code: String(chosen.code), market: priceRowMarket(chosen),
      price: Number(chosen.price),
      quality: String(chosen.quality || 'legacy_unverified'),
      isFinal: chosen.is_final === true,
      source: chosen.source || null, evidence: chosen.evidence || {},
      qualified: qualified.includes(chosen),
    },
    conflict: null,
  };
}

async function computeNavHistoryTotals(username, accountName, data, query = pool.query.bind(pool)) {
  const navs = (data.navHistory || []).slice().sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
  if (!navs.length) return {};
  const { expectedCloseDateFor, resolveSuspendedReferencesBatch, loadSwapReferenceCandidates,
    resolveSwapReference, PRIVATE_SOURCES, codeVariants } = require('./effectivePrice');
  const currentPositions = aggregateCurrentPositions(data.positions);
  const maxNavDate = dateKey(navs[navs.length - 1].date);
  const totals = {};
  const suspensionEvidence = {};
  const swapEvidence = {};
  Object.defineProperty(totals, 'suspensionEvidence', { value: suspensionEvidence, enumerable: false });
  Object.defineProperty(totals, 'swapEvidence', { value: swapEvidence, enumerable: false });
  const marketStateCache = new Map();
  const basePending = [];
  // 共享候选只按“市场 + 代码 + 该市场应有收盘日”精确读取，不拉取其它日期的共享历史。
  const expectedPairs = new Map();
  for (const nav of navs) {
    const date = dateKey(nav.date);
    if (nav.snapshotSource === 'manual_carry_forward' && !isAuthoritativeSnapshot(nav)) {
      totals[date] = null;
      continue;
    }
    if (isAuthoritativeSnapshot(nav)) {
      totals[date] = nav.totalAsset != null && Number.isFinite(Number(nav.totalAsset))
        ? Number(nav.totalAsset) : null;
      continue;
    }
    // 历史重建必须具有当时的持仓锚点；当前持仓回退只用于首页实时估值，不能证明旧持仓。
    if (!latestImportedPositionAnchor(data, date)) {
      totals[date] = null;
      continue;
    }
    const rate = Number(nav.hkRate) > 0 ? Number(nav.hkRate) : null;
    const quantities = quantityAsOf(data, date, nav.snapshot_at);
    // 按当日实际持有的市场逐个算出最近应有收盘日。
    const expectedByMarket = new Map();
    for (const [identity, row] of quantities) {
      if (!(Number(row.quantity) > 0)) continue;
      const isHk = row.market === 'HK' || row.subtype === '港股' || currentPositions.get(identity)?.subtype === '港股';
      const market = isHk ? 'HK' : 'CN';
      const code = String(row.code || identity.split('|').slice(1).join('|'));
      if (!expectedByMarket.has(market)) {
        expectedByMarket.set(market,
          await expectedCloseDateFor(market, date, query, marketStateCache, 'historical'));
      }
      const expected = expectedByMarket.get(market);
      if (!expected) continue;
      for (const variant of codeVariants(code, isHk)) {
        expectedPairs.set(`${market}|${variant}|${expected}`, { market, code: variant, date: expected });
      }
    }
    basePending.push({ date, nav, quantities, rate, expectedByMarket });
  }
  const { rows: fxRows } = await layerRepository.listHistoryFxRates(query, [maxNavDate]);
  const fx = new Map(fxRows.map(r => [dateKey(r.rate_date), Number(r.rate)]));
  for (const item of basePending) {
    if (item.rate == null) item.rate = fx.get(item.date);
  }
  if (!basePending.length) return totals;

  const pairs = [...expectedPairs.values()];
  // 休市快照可能依赖更早的收盘，查询下界从实际需要的日期计算。
  const lowerBound = pairs.reduce((earliest, pair) => pair.date < earliest ? pair.date : earliest,
    basePending[0].date);
  const [ownResult, priorResult, sharedResult] = await Promise.all([
    layerRepository.listOwnPricesInRange(query, [username, accountName, lowerBound, maxNavDate]),
    layerRepository.listOwnConfirmedBefore(query, [username, accountName, lowerBound]),
    pairs.length
      ? layerRepository.listSharedConfirmedAt(query, [username, accountName, JSON.stringify(pairs), PRIVATE_SOURCES])
      : { rows: [] },
  ]);
  // 先按「市场|代码 → 日期」归组，再用共享的单日选价函数择优/判冲突；
  // 不再在游标里重复实现同日质量偏好。
  const grouped = new Map();
  for (const row of [...priorResult.rows, ...ownResult.rows, ...sharedResult.rows]) {
    const market = priceRowMarket(row);
    const key = `${market}|${priceCodeKey(row.code, market)}`;
    const priceDate = dateKey(row.date);
    if (!grouped.has(key)) grouped.set(key, new Map());
    const byDate = grouped.get(key);
    if (!byDate.has(priceDate)) byDate.set(priceDate, []);
    byDate.get(priceDate).push(row);
  }
  const selectedRows = [];
  const conflictKeys = new Set();
  for (const [key, byDate] of grouped) {
    const [market, code] = key.split('|');
    for (const [priceDate, priceRows] of byDate) {
      const picked = selectDailyPrice(priceRows, code, market);
      if (picked.conflict) {
        conflictKeys.add(`${key}|${priceDate}`);
        selectedRows.push({ key, date: priceDate, code, market, price: null,
          quality: 'conflict', isFinal: false, qualified: false, conflict: true });
      } else if (picked.row) {
        selectedRows.push({ key, ...picked.row, conflict: false });
      }
    }
  }
  selectedRows.sort((a, b) => a.date.localeCompare(b.date) ||
    String(a.code).localeCompare(String(b.code)) || a.market.localeCompare(b.market));
  const selectedByKeyDate = new Map();
  for (const row of selectedRows) selectedByKeyDate.set(`${row.key}|${row.date}`, row);
  // 历史价格同样按资格推进：只有已确认收盘（或明确终盘）才允许用于历史资产重建，
  // 候选价与遗留未核验价只保留缺口，不参与计算。
  const confirmedPrices = new Map();
  const exactAt = (market, code, expected) => {
    if (!expected) return null;
    return selectedByKeyDate.get(`${market}|${priceCodeKey(code, market)}|${expected}`) || null;
  };
  const conflictAt = (code, market, expected) => Boolean(expected) &&
    conflictKeys.has(`${market}|${priceCodeKey(code, market)}|${expected}`);
  const swapCandidates = (data.trades || []).some(t => t.direction === 'adjust')
    ? await loadSwapReferenceCandidates(username, accountName, query) : [];
  const suspensionRequests = [];
  const pendingTotals = [];
  let cursor = 0;
  for (const item of basePending) {
    const { date, nav, quantities, rate, expectedByMarket } = item;
    while (cursor < selectedRows.length && selectedRows[cursor].date <= date) {
      const row = selectedRows[cursor];
      if (row.qualified && row.quality === 'confirmed' && row.isFinal) {
        confirmedPrices.set(row.key, row);
      }
      cursor++;
    }
    const requestedPrices = new Map();
    const swapPrices = new Map();
    for (const row of quantities.values()) {
      if (!(Number(row.quantity) > 0) || row.market !== 'CN') continue;
      const key = `CN|${row.code}`;
      const expected = expectedByMarket.get('CN');
      const exact = exactAt('CN', row.code, expected);
      if (!expected || (exact && exact.qualified)) continue;
      // 同一应有收盘日已有 confirmed 冲突时，当日保持缺失；不能落入停牌/换券/
      // 固定价路径把冲突掩盖成另一个有效价格。
      if (conflictAt(row.code, 'CN', expected)) continue;
      const swap = resolveSwapReference({code:row.code,market:'CN',quantity:row.quantity,
        valuationDate:date,expectedCloseDate:expected,candidates:swapCandidates});
      if (swap) { swapPrices.set(key,swap); continue; }
      requestedPrices.set(key, suspensionRequests.length);
      suspensionRequests.push({ code: row.code, market: 'CN', candidate: confirmedPrices.get(key), targetDate: expected });
    }
    pendingTotals.push({ date, nav, quantities, rate, expectedByMarket, requestedPrices, swapPrices });
  }
  const references = await resolveSuspendedReferencesBatch(suspensionRequests, query);
  for (const { date, nav, quantities, rate, expectedByMarket, requestedPrices, swapPrices } of pendingTotals) {
    const suspensionPrices = new Map([...requestedPrices].map(([key, index]) => [key, references.get(index)]).filter(([, value]) => value));
    if (suspensionPrices.size) suspensionEvidence[date] = [...suspensionPrices.entries()].map(([key, value]) => ({
      code: key.slice(3), market: 'CN', ...value,
    }));
    if (swapPrices.size) swapEvidence[date]=[...swapPrices.values()];
    totals[date] = snapshotTotal(data, nav, quantities, (code, isHk) => {
      const market = isHk ? 'HK' : 'CN';
      const expected = expectedByMarket.get(market);
      // 同一应有收盘日存在 confirmed 冲突时，必须保持缺失，即使本账户还有旧价、
      // 停牌参考、换券参考或固定价也不能把冲突当日补成完整。
      if (conflictAt(code, market, expected)) return null;
      const row = exactAt(market, code, expected);
      // 价格必须正是该市场当日的应有收盘价：日期不符（含缺当日价）即为缺口。
      if (row && row.qualified && row.price > 0) return row.price;
      const suspended = suspensionPrices.get(`${market}|${code}`);
      if (suspended) return suspended.price;
      const swap = swapPrices.get(`${market}|${code}`);
      if (swap) return swap.price;
      // 未确认价格不能冒充历史收盘价；仅明确人工退市估值可作为其他兜底。
      return manualDelistedPrice(data, code, currentPositions.get(code));
    }, rate);
  }
  return totals;
}

async function intervalHasGap(data, previous, current) {
  const { getMarketState, isCnTradingDate } = require('./marketState');
  const span = new Date(dateKey(current.date) + 'T00:00:00Z') - new Date(dateKey(previous.date) + 'T00:00:00Z');
  if (span <= 86400000) return false;
  // 无当时持仓依据就无法判定间隔日属于哪个市场，不能用今天的市场组合回查多年日历。
  if (!latestImportedPositionAnchor(data, dateKey(previous.date)) ||
      !latestImportedPositionAnchor(data, dateKey(current.date))) return true;
  const markets = new Set();
  for (const nav of [previous, current]) {
    for (const row of quantityAsOf(data, dateKey(nav.date), nav.snapshot_at).values()) {
      if (Number(row.quantity) > 0) markets.add(row.subtype === '港股' ? 'HK' : 'CN');
    }
  }
  const cursor = new Date(dateKey(previous.date) + 'T00:00:00Z');
  while (true) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const date = dateKey(cursor);
    if (date >= dateKey(current.date)) break;
    if (markets.has('CN') && isCnTradingDate(date)) return true;
    if (markets.has('HK')) {
      const state = await getMarketState({ market: 'HK', businessDate: date, time: '23:59' });
      if (state.status !== 'closed') return true;
    }
  }
  return false;
}

// 首页资产基准→同一净值续链。只读投影与自动写入均调用此入口；原导入事实不改写。
async function buildNavPerformance(data, totals, options = {}) {
  const today = dateKey(new Date());
  const history = (data.navHistory || []).filter(n => dateKey(n.date) <= today);
  const importedThrough = history.filter(n => n.snapshotSource === 'imported')
    .reduce((latest, n) => dateKey(n.date) > latest ? dateKey(n.date) : latest, '');
  // 导入覆盖的历史按原记录频率展示；旧系统日记录留作审计，不插入周记录之间制造断点。
  const navs = history.filter(n => !importedThrough || dateKey(n.date) >= importedThrough || isAuthoritativeSnapshot(n))
    .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
  const live = data.navAttribution;
  // totalAsset 为空表示“估值不完整、没有完整总资产”，不能被当成 0 参与续链。
  if (navs.length && dateKey(navs.at(-1).date) < today &&
      data.totalAsset != null && Number.isFinite(Number(data.totalAsset))) {
    navs.push({ date: today, nav: null, totalAsset: data.totalAsset, snapshotSource: 'live',
      snapshot_at: new Date().toISOString(), isLive: true });
  }
  const bases = { ...totals };
  if (live?.complete && live.currentDate === today && live.previousTotalAsset > 0) {
    bases[live.previousDate] = Number(live.previousTotalAsset);
  }
  // 当前估值不完整时，当日总资产只是“可用部分金额”，不能据此续出正式净值。
  const valuationIncomplete = Boolean(data.valuation && data.valuation.complete === false);
  const rows = [];
  for (const n of navs) {
    const date = dateKey(n.date);
    const imported = isAuthoritativeSnapshot(n);
    const previous = rows.at(-1);
    const currentTotal = date === today && n.snapshotSource !== 'imported'
      ? (data.totalAsset == null ? null : Number(data.totalAsset))
      : bases[date];
    let nav = null, reason = null, dayChange = null, basis = null;
    const gap = previous ? await intervalHasGap(data, previous, n) : false;
    const base = previous ? bases[previous.date] : null;
    if (imported) nav = n.nav > 0 ? Number(n.nav) : null;
    else if (!previous && n.diagnostics?.homepageBasis?.initial === true && currentTotal > 0) {
      nav = 1;
      basis = { version: 'homepage-v1', initial: true, totalAsset: currentTotal };
    } else if (previous?.nav > 0 && base > 0 && currentTotal != null && Number.isFinite(currentTotal) && !gap) {
      const transfers = (data.cashFlows || []).filter(f => NavMath.isExternalTransfer(f) &&
        eventInInterval(f, dateKey(f.date), previous.date, date, timestamp(previous.snapshot_at),
          date === today ? Date.now() : timestamp(n.snapshot_at)))
        .reduce((sum, f) => sum + Number(f.amount || 0), 0);
      if (base + transfers > 0) {
        nav = NavMath.chainNav(previous.nav, base, currentTotal, transfers);
        basis = { version: 'homepage-v1', previousDate: previous.date, previousTotalAsset: base,
          previousNav: previous.nav, externalTransfer: transfers, totalAsset: currentTotal };
      }
    }
    if (previous && base > 0 && currentTotal != null && !gap) dayChange = (currentTotal - base) / base;
    // 不完整估值一律阻断当日续链：保留缺口原因，不产出看似完整的净值。
    if (date === today && !imported && valuationIncomplete) {
      nav = null;
      dayChange = null;
      basis = null;
      reason = 'valuation_incomplete';
    }
    if (date === today && options.requireLive !== false && !(valuationIncomplete && !imported)) {
      dayChange = live?.complete && live.currentDate === today && live.previousTotalAsset > 0 && live.totalChange != null
        ? Number(live.totalChange) / Number(live.previousTotalAsset) : null;
      if (nav == null || dayChange == null) reason = live?.reason || 'missing_nav_basis';
    }
    if (basis && totals.suspensionEvidence) {
      const current = totals.suspensionEvidence[date] || [];
      const prior = previous ? (totals.suspensionEvidence[previous.date] || []) : [];
      if (current.length || prior.length) basis.suspensionReferencePrices = { current, previous: prior };
    }
    if (basis && totals.swapEvidence) {
      const current=totals.swapEvidence[date]||[];
      const prior=previous?(totals.swapEvidence[previous.date]||[]):[];
      if(current.length||prior.length) basis.swapReferencePrices={current,previous:prior};
    }
    if (nav == null) reason = reason || (gap ? 'missing_intermediate_snapshot' : 'missing_nav_basis');
    bases[date] = currentTotal == null || !Number.isFinite(currentTotal) ? null : currentTotal;
    rows.push({ ...n, date, totalAsset: bases[date], nav, dayChange, basis, basisStatus: reason || 'complete',
      recordedNav: n.nav, recordedTotalAsset: n.totalAsset });
  }
  return rows;
}

async function computeNavAttribution(username, accountName, data, currentTotal, query = pool.query.bind(pool)) {
  const navs = (data.navHistory || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (navs.length < 2) return { complete: false, reason: 'not_enough_snapshots' };
  const last = navs[navs.length - 1];
  const historicalPrevious = navs[navs.length - 2];
  const storedLastDate = dateKey(last.date);
  const { isCnTradingDate, getMarketState, prefetchMarketFacts } = require('./marketState');
  const todayDate = dateKey(new Date());
  const currentByCode = aggregateCurrentPositions(data.positions);
  const lastPositionDate = dateKey(last.date);
  const lastQty = quantityAsOf(data, lastPositionDate, last.snapshot_at);
  const historicalPrevDate = dateKey(historicalPrevious.date);
  const historicalPrevQty = quantityAsOf(data, historicalPrevDate, historicalPrevious.snapshot_at);
  const holdingsForState = new Set([...lastQty.keys(), ...historicalPrevQty.keys(), ...currentByCode.keys()]);
  const marketForCode = (code) => {
    const position = currentByCode.get(code) || {};
    const prior = lastQty.get(code) || historicalPrevQty.get(code) || {};
    return position.subtype === '港股' || prior.subtype === '港股' ? 'HK' : 'CN';
  };
  const markets = new Set([...holdingsForState].map(marketForCode));
  const todayMarketStates = {};
  for (const market of markets) {
    todayMarketStates[market] = market === 'HK'
      ? await getMarketState({ market, businessDate: todayDate, time: '23:59' })
      : { status: isCnTradingDate(todayDate) ? 'open' : 'closed' };
  }
  const hasOpenHoldingMarketToday = Object.values(todayMarketStates).some(state => state.status === 'open');
  const hasClosedHoldingMarketsToday = markets.size > 0 && Object.values(todayMarketStates).every(state => state.status === 'closed');
  // 页面有当前系统总资产时，最后一条已保存快照就是当前计算的基准。
  // 这样周二会按“周一快照 → 周二当前行情”计算，不会重复把周日/更早区间算进来。
  const liveEnd = currentTotal != null && storedLastDate <= todayDate &&
    (hasOpenHoldingMarketToday || hasClosedHoldingMarketsToday || storedLastDate === todayDate);
  const previous = liveEnd && storedLastDate < todayDate ? last : historicalPrevious;
  const prevDate = dateKey(previous.date);
  const currentDate = liveEnd ? todayDate : storedLastDate;
  if (liveEnd && currentDate === todayDate && prevDate < currentDate) {
    const betweenDates = [];
    for (let cursor = new Date(`${prevDate}T00:00:00Z`); ; ) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const date = cursor.toISOString().slice(0, 10);
      if (date >= currentDate) break;
      betweenDates.push(date);
    }
    if (markets.has('HK') && betweenDates.length) await prefetchMarketFacts('HK', betweenDates);
    const snapshotDates = new Set(navs.map(nav => dateKey(nav.date)));
    for (const date of betweenDates) {
      if (snapshotDates.has(date)) continue;
      for (const market of markets) {
        const state = market === 'HK'
          ? await getMarketState({ market, businessDate: date, time: '23:59' })
          : { status: isCnTradingDate(date) ? 'open' : 'closed' };
        if (state.status === 'unknown') {
          return {
            complete: false, reason: 'intermediate_market_calendar_unknown', missingCodes: [],
            missingMarketDate: date, missingMarket: market, previousDate: prevDate, currentDate,
          };
        }
        if (state.status === 'open') {
          return {
            complete: false, reason: 'missing_intermediate_snapshot', missingCodes: [],
            missingMarketDate: date, missingMarket: market, previousDate: prevDate, currentDate,
          };
        }
      }
    }
  }
  const prevQty = quantityAsOf(data, prevDate, previous.snapshot_at);
  // 身份键是「市场|代码」；价格只按明确的目标日期读取，市场/代码在本地按身份匹配。
  const relevantIdentities = [...new Set([...prevQty.keys(), ...currentByCode.keys()])];
  const { expectedCloseDateFor, resolveSuspendedReference, PRIVATE_SOURCES, codeVariants } = require('./effectivePrice');
  // 基准时点各市场的「最近应有收盘日」：用已落库交易日历回看，不按星期几猜。
  const basisStateCache = new Map();
  const basisSuspensionCache = new Map();
  const prevExpectedByMarket = new Map();
  const currentExpectedByMarket = new Map();
  const basisMarkets = new Set(relevantIdentities.map(identity => identity.split('|')[0])
    .filter(market => market === 'CN' || market === 'HK'));
  for (const market of basisMarkets) {
    prevExpectedByMarket.set(market,
      await expectedCloseDateFor(market, prevDate, query, basisStateCache, 'historical').catch(() => null));
    currentExpectedByMarket.set(market,
      await expectedCloseDateFor(market, currentDate, query, basisStateCache, 'historical').catch(() => null));
  }
  const expectedBasisDateFor = market => prevExpectedByMarket.get(market) || null;
  const expectedCurrentDateFor = market => currentExpectedByMarket.get(market) || null;
  const basisPairs = new Map();
  const priorPairs = new Map();
  const localRefPairs = new Map();
  for (const identity of relevantIdentities) {
    const [market, code] = identity.split('|');
    if (market !== 'CN' && market !== 'HK') continue;
    const prevExpected = expectedBasisDateFor(market);
    const currentExpected = expectedCurrentDateFor(market);
    for (const variant of codeVariants(code, market === 'HK')) {
      if (prevExpected) {
        basisPairs.set(`${market}|${variant}|${prevExpected}`, { market, code: variant, date: prevExpected });
        if (market === 'CN') priorPairs.set(`${market}|${variant}|${prevExpected}`, { market, code: variant, date: prevExpected });
      }
      if (currentExpected) {
        basisPairs.set(`${market}|${variant}|${currentExpected}`, { market, code: variant, date: currentExpected });
        if (market === 'CN') priorPairs.set(`${market}|${variant}|${currentExpected}`, { market, code: variant, date: currentExpected });
      }
      localRefPairs.set(`${market}|${variant}|${prevDate}`, { market, code: variant, date: prevDate });
      localRefPairs.set(`${market}|${variant}|${currentDate}`, { market, code: variant, date: currentDate });
    }
  }
  // 券商导入日的私有固化价是“仅用于数值归因”的派生证据：即使 prevDate 是休市日、
  // 应有收盘日是前一交易日，也保留该账户在导入日的 nav_import_anchor，并继续标
  // basisQualified=false / basis_price_not_confirmed；不能用实际上一交易日价改为完整。
  const importedAnchorDate = previous.snapshotSource === 'imported' ? dateKey(previous.date) : null;
  const ownPairs = new Map(basisPairs);
  if (importedAnchorDate) {
    for (const identity of relevantIdentities) {
      const [market, code] = identity.split('|');
      if (market !== 'CN' && market !== 'HK') continue;
      for (const variant of codeVariants(code, market === 'HK')) {
        ownPairs.set(`${market}|${variant}|${importedAnchorDate}`, { market, code: variant, date: importedAnchorDate });
      }
    }
  }
  const pairs = [...basisPairs.values()];
  const ownPairList = [...ownPairs.values()];
  const priorList = [...priorPairs.values()];
  const localRefList = [...localRefPairs.values()];
  const [ownPricesResult, sharedPricesResult, priorResult, localRefResult] = await Promise.all([
    ownPairList.length
      ? layerRepository.listOwnPricesAt(query, [username, accountName, JSON.stringify(ownPairList)])
      : { rows: [] },
    pairs.length
      ? layerRepository.listSharedConfirmedAt(query, [username, accountName, JSON.stringify(pairs), PRIVATE_SOURCES])
      : { rows: [] },
    priorList.length
      ? layerRepository.listOwnConfirmedBeforePairs(query, [username, accountName, JSON.stringify(priorList)])
      : { rows: [] },
    localRefList.length
      ? layerRepository.listOwnLatestBeforePairs(query, [username, accountName, JSON.stringify(localRefList)])
      : { rows: [] },
  ]);
  const anchorByKey = new Map();
  if (importedAnchorDate) {
    for (const row of ownPricesResult.rows) {
      if (dateKey(row.date) !== importedAnchorDate) continue;
      if (!PRIVATE_SOURCES.includes(String(row.source || ''))) continue;
      const market = priceRowMarket(row);
      anchorByKey.set(`${market}|${priceCodeKey(row.code, market)}`, row);
    }
  }
  const basisRowsByKeyDate = new Map();
  for (const row of [...ownPricesResult.rows, ...sharedPricesResult.rows]) {
    const market = priceRowMarket(row);
    const key = `${market}|${priceCodeKey(row.code, market)}|${dateKey(row.date)}`;
    if (!basisRowsByKeyDate.has(key)) basisRowsByKeyDate.set(key, []);
    basisRowsByKeyDate.get(key).push(row);
  }
  const selectBasis = (code, market, expected) => {
    if (!expected) return null;
    const rows = basisRowsByKeyDate.get(`${market}|${priceCodeKey(code, market)}|${expected}`);
    if (!rows || !rows.length) return null;
    const picked = selectDailyPrice(rows, priceCodeKey(code, market), market);
    return picked.conflict ? { row: null, conflict: picked.conflict } : picked;
  };
  const conflictRow = (date, market) => ({ date, price: null, market, quality: 'conflict',
    isFinal: false, conflict: true });
  const localRefByKeyDate = new Map();
  for (const row of localRefResult.rows) {
    const market = priceRowMarket(row);
    localRefByKeyDate.set(`${market}|${priceCodeKey(row.code, market)}|${row.wanted_date}`, row);
  }
  const previousPriceByCode = new Map();
  const currentPriceByCode = new Map();
  for (const identity of relevantIdentities) {
    const [market, code] = identity.split('|');
    if (market !== 'CN' && market !== 'HK') continue;
    const key = `${market}|${priceCodeKey(code, market)}`;
    const anchor = anchorByKey.get(key);
    if (anchor && Number(anchor.price) > 0) {
      previousPriceByCode.set(key, {
        date: dateKey(anchor.date), price: Number(anchor.price), market,
        quality: String(anchor.quality || 'legacy_unverified'), isFinal: false,
        qualified: false, source: anchor.source || 'nav_import_anchor',
      });
    } else {
      const prevPicked = selectBasis(code, market, expectedBasisDateFor(market));
      const prevLocal = localRefByKeyDate.get(`${market}|${priceCodeKey(code, market)}|${prevDate}`);
      if (prevPicked) previousPriceByCode.set(key,
        prevPicked.row || conflictRow(expectedBasisDateFor(market), market));
      else if (prevLocal) previousPriceByCode.set(key, {
        date: dateKey(prevLocal.date), price: Number(prevLocal.price), market,
        quality: String(prevLocal.quality || 'legacy_unverified'), isFinal: prevLocal.is_final === true,
        qualified: false, source: prevLocal.source || null,
      });
    }
    const currentPicked = selectBasis(code, market, expectedCurrentDateFor(market));
    const currentLocal = localRefByKeyDate.get(`${market}|${priceCodeKey(code, market)}|${currentDate}`);
    if (currentPicked) currentPriceByCode.set(key,
      currentPicked.row || conflictRow(expectedCurrentDateFor(market), market));
    else if (currentLocal) currentPriceByCode.set(key, {
      date: dateKey(currentLocal.date), price: Number(currentLocal.price), market,
      quality: String(currentLocal.quality || 'legacy_unverified'), isFinal: currentLocal.is_final === true,
      qualified: false, source: currentLocal.source || null,
    });
  }
  const priorConfirmed = new Map();
  for (const row of priorResult.rows) {
    priorConfirmed.set(`${row.wanted_market}|${row.wanted_code}|${row.wanted_date}`, row);
  }
  const { rows: fxRows } = await layerRepository.listBasisFxRates(query, [currentDate]);
  const fxByDate = new Map(fxRows.map(r => [dateKey(r.rate_date), Number(r.rate)]));
  // 已保存快照中的汇率是历史事实，行情表只能作为缺失时的明确回退，不能静默使用当前汇率。
  const rateAt = (date, nav) => Number(nav && nav.hkRate) > 0 ? Number(nav.hkRate) :
    (Number(fxByDate.get(date)) > 0 ? Number(fxByDate.get(date)) : null);
  const prevRate = rateAt(prevDate, previous);
  const lastRate = liveEnd && Number(data.hkRate) > 0 ? Number(data.hkRate) : rateAt(currentDate, last);
  const prevAt = timestamp(previous.snapshot_at);
  const lastAt = liveEnd ? Date.now() : timestamp(last.snapshot_at);
  const priceImpact = { value: 0 };
  const fxImpact = { value: 0 };
  const quantityImpact = { value: 0 };
  const previousMarketValue = { value: 0, complete: true };
  // 当前时点的统一估值证据（与总资产同一批 effectivePrice）。
  // 休市不再另设“估值校准”：当前资产与归因必须指向同一批价格。
  const currentValuation = data.valuation && data.valuation.prices ? data.valuation.prices : null;
  const priceEvidence = [];
  const missing = [];
  const manualPriceCodes = [];
  // 基准价不可信的证券：数值照算，但不允许把结果当成完整收益基准（避免未确认价格冒充收盘价）。
  const unqualifiedBasisCodes = [];
  // 逐个「证券身份」核对：CN|600000 与 HK|00001 是两只证券，不能按代码合并。
  const identities = relevantIdentities;
  // 已被当前估值选中的退市固定价：期初总资产重建也必须消费同一价格，不能只改 complete。
  // expectedBasisDateFor / basisStateCache / resolveSuspendedReference 由 #46 的共享基准读取段（上方）提供。
  const fixedBasisPrices = new Map();
  function marketPrice(priceMap, code, isHk) {
    const market = isHk ? 'HK' : 'CN';
    return priceMap.get(`${market}|${priceCodeKey(code, market)}`) || null;
  }
  for (const identity of identities) {
    const p = currentByCode.get(identity);
    const q = prevQty.get(identity) || { quantity: 0, subtype: (p || {}).subtype || '', market: (p || {}).market };
    const qty = Number(q.quantity) || 0;
    const market = (p && p.market) || q.market || identity.split('|')[0];
    const code = (p && p.code) || q.code || identity.split('|').slice(1).join('|');
    const isHk = market === 'HK' || q.subtype === '港股' || (p && p.subtype === '港股');
    // 当前持仓明确为 CN 退市债，且当前批次统一估值也认定该价格时才允许补充基准。
    const liveDelistedHolding = Boolean(liveEnd && !isHk && market === 'CN' && p && isDelistedBond(p, code));
    let storedPrevRow = marketPrice(previousPriceByCode, code, isHk);
    let storedCurrentRow = marketPrice(currentPriceByCode, code, isHk);
    const expectedBasisDate = expectedBasisDateFor(isHk ? 'HK' : 'CN');
    // 同一应有收盘日的 confirmed 冲突必须整只保留缺失，不能落进停牌、换券或固定价兜底。
    if ((storedPrevRow && storedPrevRow.conflict) || (storedCurrentRow && storedCurrentRow.conflict)) {
      missing.push(code);
      previousMarketValue.complete = false;
      continue;
    }
    let suspensionReference = null;
    const exactBasis = storedPrevRow && expectedBasisDate && storedPrevRow.date === expectedBasisDate &&
      (storedPrevRow.quality === 'confirmed' || storedPrevRow.isFinal === true);
    if (qty > 0 && market === 'CN' && expectedBasisDate && !exactBasis) {
      try {
        const prior = priorConfirmed.get(`CN|${code}|${expectedBasisDate}`);
        if (prior) suspensionReference = await resolveSuspendedReference({ code, market: 'CN', targetDate: expectedBasisDate,
          candidate: { date: dateKey(prior.date), price: Number(prior.price), quality: prior.quality,
            isFinal: prior.is_final === true, source: prior.source, evidence: prior.evidence },
          query, cache: basisSuspensionCache });
        if (suspensionReference) {
          storedPrevRow = { date: suspensionReference.tradeDate, price: suspensionReference.price,
            market: 'CN', quality: 'confirmed', isFinal: true };
          previousPriceByCode.set(`CN|${code}`, storedPrevRow);
        }
      } catch (_) { /* 缺证据或查询失败仍按基准不完整处理 */ }
    }
    // 接受停牌基准时，历史终点也必须有本日收盘价或同样完整的停牌证据。
    // 否则不能把不可信的旧价与停牌参考价组合成“完整归因”。
    let currentSuspensionReference = null;
    if (suspensionReference && !liveEnd) {
      const expectedCurrent = expectedCurrentDateFor('CN');
      const exactCurrent = storedCurrentRow && expectedCurrent && storedCurrentRow.date === expectedCurrent &&
        (storedCurrentRow.quality === 'confirmed' || storedCurrentRow.isFinal === true);
      if (!exactCurrent && expectedCurrent) {
        try {
          const prior = priorConfirmed.get(`CN|${code}|${expectedCurrent}`);
          if (prior) currentSuspensionReference = await resolveSuspendedReference({ code, market: 'CN', targetDate: expectedCurrent,
            candidate: { date: dateKey(prior.date), price: Number(prior.price), quality: prior.quality,
              isFinal: prior.is_final === true, source: prior.source, evidence: prior.evidence },
            query, cache: basisSuspensionCache });
        } catch (_) { /* 证据缺失保持不完整 */ }
      }
      if (currentSuspensionReference) storedCurrentRow = { date: currentSuspensionReference.tradeDate,
        price: currentSuspensionReference.price, quality: 'confirmed', isFinal: true };
      else if (!exactCurrent) {
        missing.push(code);
        previousMarketValue.complete = false;
        continue;
      }
    }
    const storedPrevPrice = storedPrevRow && storedPrevRow.price;
    const tradePrice = tradePriceAtEnd(data, code, prevDate, currentDate, prevAt, lastAt);
    const currentMarketState = currentDate === todayDate ? todayMarketStates[isHk ? 'HK' : 'CN'] : null;
    const marketOpenOnCurrentDate = currentMarketState ? currentMarketState.status === 'open' : true;
    // 统一估值结果按「市场|代码」为键，同形代码（A 股 000001 / 港股 00001）不会互相取到。
    const evidenceRow = liveEnd && currentValuation
      ? (currentValuation[`${isHk ? 'HK' : 'CN'}|${code}`] || null)
      : null;
    // 只有当前批次统一估值明确给出 manual_delisted 正值，才允许用它补充历史基准。
    // 不能拿当前聚合持仓价替代 effectivePrice 的实际选择，也不能在没有估值证据时覆盖上期价格。
    const currentValuationFixed = liveEnd && evidenceRow && evidenceRow.priceKind === 'manual_delisted' &&
      Number(evidenceRow.price) > 0 ? Number(evidenceRow.price) : null;
    const legacyFixedPrice = manualDelistedPrice(data, code, p);
    const basisDateOk = Boolean(storedPrevRow && expectedBasisDate && storedPrevRow.date === expectedBasisDate);
    // 原本合格的精确确认价或有效停牌基准优先，不因退市固定价而改口径。
    const originalBasisQualified = storedPrevPrice > 0 &&
      (storedPrevRow.quality === 'confirmed' || storedPrevRow.isFinal === true) &&
      (basisDateOk || Boolean(suspensionReference));
    let useFixedBasis = false;
    let fixedBasisPrice = null;
    let basisCorroboration = null;
    if (liveDelistedHolding && currentValuationFixed != null && previous.snapshotSource !== 'imported') {
      if (!(storedPrevPrice > 0)) {
        useFixedBasis = true;
        fixedBasisPrice = currentValuationFixed;
      } else if (!originalBasisQualified && Math.abs(Number(storedPrevPrice) - currentValuationFixed) < 1e-6) {
        // 旧记录只用于证明“基准时点已有同一金额”，绝不升格为确认收盘；
        // 只有落库值等于当前固定价时才放行，异价旧记录仍保持原缺口。
        useFixedBasis = true;
        fixedBasisPrice = currentValuationFixed;
        basisCorroboration = {
          date: storedPrevRow.date,
          quality: storedPrevRow.quality || 'legacy_unverified',
          price: Number(storedPrevPrice),
          relation: 'equal_amount_history',
        };
      }
    }
    // 原不带旧日价的历史路径保持：没有可用基准价时仍按既有退市固定价兜底。
    if (!useFixedBasis && previous.snapshotSource !== 'imported' && !(storedPrevPrice > 0) &&
        (currentValuationFixed != null || legacyFixedPrice != null)) {
      useFixedBasis = true;
      fixedBasisPrice = currentValuationFixed != null ? currentValuationFixed : legacyFixedPrice;
    }
    const prevPrice = useFixedBasis
      ? fixedBasisPrice
      : (storedPrevPrice > 0 ? storedPrevPrice : legacyFixedPrice);
    const lastPrice = useFixedBasis
      ? fixedBasisPrice
      : (evidenceRow && Number(evidenceRow.price) > 0
        ? Number(evidenceRow.price)
        : (liveEnd && marketOpenOnCurrentDate && p
          ? Number(p.price) : (storedCurrentRow && storedCurrentRow.price)));
    const endPrice = lastPrice > 0 ? lastPrice : (tradePrice > 0 ? tradePrice : legacyFixedPrice);
    const currentQty = p ? Number(p.quantity) || 0 : 0;
    if (currentValuationFixed != null ||
        (legacyFixedPrice != null && (useFixedBasis || storedPrevPrice == null || !(storedPrevPrice > 0) || !(lastPrice > 0)))) {
      manualPriceCodes.push(code);
    }
    if (useFixedBasis) fixedBasisPrices.set(`${isHk ? 'HK' : 'CN'}|${code}`, fixedBasisPrice);
    if ((qty > 0 && (!(prevPrice > 0) || !(endPrice > 0))) || (currentQty > 0 && !(endPrice > 0)) ||
      ((qty > 0 || currentQty > 0) && isHk && !(prevRate > 0 && lastRate > 0))) {
      missing.push(code);
      previousMarketValue.complete = false;
      continue;
    }
    // 身份不明（既无 subtype 也无法由代码形状判定）时不允许继续合并计算，
    // 否则同形代码会被当成一只证券算出“完整”但错误的涨跌。
    if (market === 'UNKNOWN') {
      missing.push(code);
      previousMarketValue.complete = false;
      continue;
    }
    const baseFx = isHk ? prevRate : 1;
    const endFx = isHk ? lastRate : 1;
    if (qty > 0) {
      previousMarketValue.value += prevPrice * qty * baseFx;
      priceImpact.value += (endPrice - prevPrice) * qty * baseFx;
      if (isHk) fxImpact.value += endPrice * qty * (lastRate - prevRate);
    }
    // 数量变化归入交易/数量影响：新买入不要求基准日价格，清仓也不要求当前行情。
    quantityImpact.value += (currentQty - qty) * endPrice * endFx;
    // 基准价资格：必须是该市场在基准时点「最近应有收盘日」的已确认收盘价，
    // 或明确的人工估值（退市债固定价）。只要日期对不上（例如周五缺价却拿周四价格），
    // 数值可以照算，但归因必须标成不完整，不能给出看似完整的“今日涨跌”。
    const basisFromDaily = !useFixedBasis && storedPrevPrice > 0;
    const basisQualified = useFixedBasis
      ? true
      : (basisFromDaily ? originalBasisQualified : legacyFixedPrice != null);
    if (qty > 0 && !basisQualified) unqualifiedBasisCodes.push(code);
    priceEvidence.push({
      code,
      market: isHk ? 'HK' : 'CN',
      basisPrice: prevPrice > 0 ? prevPrice : null,
      basisPriceDate: useFixedBasis ? null : (storedPrevRow ? storedPrevRow.date : null),
      basisExpectedDate: expectedBasisDate || null,
      basisQuality: useFixedBasis ? 'manual_delisted' : (basisFromDaily ? storedPrevRow.quality : (legacyFixedPrice != null ? 'manual_delisted' : null)),
      basisQualified,
      ...(useFixedBasis
        ? { basisPriceKind: 'manual_delisted', ...(basisCorroboration ? { basisCorroboration } : {}) }
        : (suspensionReference ? { basisPriceKind: 'suspension_reference', basisSuspensionEvidence: suspensionReference } : {})),
      currentPrice: endPrice > 0 ? endPrice : null,
      currentPriceKind: useFixedBasis ? 'manual_delisted'
        : (evidenceRow ? evidenceRow.priceKind : (currentSuspensionReference ? 'suspension_reference' : (storedCurrentRow ? 'close' : null))),
      currentPriceDate: useFixedBasis ? null : (evidenceRow ? evidenceRow.tradeDate : (storedCurrentRow ? storedCurrentRow.date : null)),
      ...(currentSuspensionReference ? { currentSuspensionEvidence: currentSuspensionReference } : {}),
      quality: useFixedBasis ? 'manual_delisted' : (evidenceRow ? evidenceRow.quality : (storedCurrentRow ? 'legacy_unverified' : null)),
      sourceRef: useFixedBasis ? 'positions.price' : (evidenceRow ? evidenceRow.sourceRef : null),
    });
  }
  const ledgerChange = { value: 0 };
  let cashIncomeImpact = 0;
  let currencyIncomplete = false;
  for (const f of (data.cashFlows || [])) {
    const d = dateKey(f.date);
    if (NavMath.isEffectiveFlow(f) && eventInInterval(f, d, prevDate, currentDate, prevAt, lastAt)) {
      const amount = Number(f.amount) || 0;
      if (NavMath.isExternalTransfer(f)) ledgerChange.value += amount;
      else cashIncomeImpact += amount;
    }
  }
  for (const t of (data.trades || [])) {
    const d = dateKey(t.trade_date || t.date);
    if (!eventInInterval(t, d, prevDate, currentDate, prevAt, lastAt) || t.direction === 'open' || t.direction === 'adjust') continue;
    const fee = (Number(t.commission) || 0) + (Number(t.stamp_tax) || 0) + (Number(t.transfer_fee) || 0) + (Number(t.other_fee) || 0);
    const rawAmountCny = t.amountCny != null && t.amountCny !== '' ? t.amountCny :
      (t.amount_cny != null && t.amount_cny !== '' ? t.amount_cny : null);
    const amountCny = rawAmountCny != null && Number.isFinite(Number(rawAmountCny)) ? Number(rawAmountCny) : null;
    if (amountCny == null && String(t.quote_currency || '').toUpperCase() === 'HKD') {
      currencyIncomplete = true;
      continue;
    }
    const settled = amountCny == null ? (Number(t.amount) || 0) : amountCny;
    ledgerChange.value += t.direction === 'buy' ? -settled - fee : settled - fee;
  }
  const lastTotal = liveEnd ? Number(currentTotal) : Number(last.totalAsset) || 0;
  // legacy/system 快照的 totalAsset 可能记录于实时价，之后 daily_prices 又被正式收盘价覆盖。
  // 用同一基准日的持仓收盘价、数量和现金重建期初总资产，避免把行情源切换误算成涨跌。
  let previousTotal = Number(previous.totalAsset) || 0;
  if (!isAuthoritativeSnapshot(previous) && previousMarketValue.complete) {
    const rebuilt = snapshotTotal(data, previous, prevQty, (code, isHk) => {
      const fixed = fixedBasisPrices.get(`${isHk ? 'HK' : 'CN'}|${code}`);
      if (fixed > 0) return fixed;
      const row = marketPrice(previousPriceByCode, code, isHk);
      return row?.price > 0 ? row.price : manualDelistedPrice(data, code, currentByCode.get(code));
    }, prevRate);
    if (rebuilt != null) previousTotal = rebuilt;
  }
  const totalChange = lastTotal - previousTotal;
  // 仅在“券商导入日 → 首个系统计算日”展示一次口径切换差异。
  // 正数表示系统导入时点持仓估值高于券商持仓总值，负数反之；后续不再保留此差额。
  const importBasisAdjustment = previous.snapshotSource === 'imported' && (liveEnd || last.snapshotSource !== 'imported') && currentDate > prevDate &&
    Number.isFinite(Number(previous.systemMarketValueAtSnapshot)) && Number.isFinite(Number(previous.marketValueCny))
    ? Number(previous.systemMarketValueAtSnapshot) - Number(previous.marketValueCny)
    : null;
  const tradeImpact = ledgerChange.value + quantityImpact.value;
  const valuationIncomplete = liveEnd && data.valuation && data.valuation.complete === false;
  const basisIncomplete = unqualifiedBasisCodes.length > 0;
  const complete = missing.length === 0 && !currencyIncomplete && !valuationIncomplete && !basisIncomplete;
  const drift = complete ? totalChange - priceImpact.value - fxImpact.value - tradeImpact - cashIncomeImpact -
    (importBasisAdjustment || 0) : null;
  const reasonCodes = [];
  if (currencyIncomplete) reasonCodes.push('missing_trade_currency_settlement');
  if (missing.length) reasonCodes.push('missing_exact_price_or_fx');
  if (valuationIncomplete) reasonCodes.push('current_valuation_incomplete');
  if (basisIncomplete) reasonCodes.push('basis_price_not_confirmed');
  return {
    complete,
    reason: complete ? null : (reasonCodes[0] || 'incomplete'),
    reasonCodes,
    missingCodes: [...new Set(missing)],
    unqualifiedBasisCodes: [...new Set(unqualifiedBasisCodes)],
    manualPriceCodes: [...new Set(manualPriceCodes)],
    previousDate: prevDate,
    currentDate,
    previousTotalAsset: previousTotal,
    totalChange,
    priceImpact: priceImpact.value,
    fxImpact: fxImpact.value,
    ledgerChange: ledgerChange.value,
    quantityImpact: quantityImpact.value,
    tradeImpact,
    cashIncomeImpact,
    importBasisAdjustment,
    snapshotDrift: drift,
    priceEvidence,
    currentValuationRevision: liveEnd && data.valuation ? data.valuation.revision : null,
    authorityMode: data.authoritativeTotalAsset != null,
  };
}

module.exports = { computeNavAttribution, computeNavHistoryTotals, buildNavPerformance, dateKey, priceRowMarket, manualDelistedPrice };
