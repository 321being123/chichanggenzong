// ========== 晚录入交易 → 历史净值精确回填（replay 引擎） ==========
// 设计：复刻前端 recordNav() 的链式净值公式 + investedAt()，
// 用 daily_prices（部署后已逐日攒齐的持仓收盘价）重放 trades 得到各日持仓与市值，
// 对「晚录入股票在交易日至录入日前」缺价的几天，用 Tushare 历史收盘回补 daily_prices。
// Tushare 拉不到的缺口日 → 跳过那天（保留原快照），不近似。
const { loadAccountData, saveDailyPrices, upsertNav, pool } = require('../db');
const accountsRepository = require('../repositories/accountsRepository');
const navAttributionRepository = require('../repositories/navAttributionRepository');
const { toTsCode, normDate } = require('../services/market');
const marketDatasets = require('../dataAccess/marketDatasets');
const classifyCode = require('../../public/js/code-classify');
const { isCnHoliday } = require('../config/holidays');
const { investedAt, chainNav, cashAt, isExternalTransfer } = require('../../public/shared/nav-math.js');
const { getCurrentFxRate } = require('../services/fxRate');
const {
  expectedCloseDateFor, detectConflictOnDate, pickBestByQuality, PRIVATE_SOURCES, codeVariants,
} = require('../services/effectivePrice');

// 东八区日期 YYYY-MM-DD
function cnDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(d));
}
// 交易日：周一至五 且 非法定节假日
function isTradingDay(d) {
  const day = (d || new Date()).getDay();
  if (day < 1 || day > 5) return false;
  return !isCnHoliday(cnDate(d || new Date()));
}

function historicalKindFor(code, position = {}) {
  const rawCode = String(code || '').trim().toUpperCase();
  const info = classifyCode(rawCode, position.name || '');
  const subtype = String(position.subtype || (info && info.subtype) || '');
  const type = String(position.type || (info && info.type) || '');
  if (subtype === '港股' || /^\d{5}$/.test(rawCode)) return 'hk_stock';
  // 统一代码分类优先于旧持仓中的“股权/沪市”标签，避免基金走股票日线。
  if (classifyCode.isFundEtfCode(rawCode)) return 'fund';
  if (subtype === '可转债' || type === '债权' || /债/.test(String(position.name || '')) || /^(11|12)\d{4}$/.test(rawCode)) return 'bond';
  if (subtype.indexOf('基金') >= 0 || subtype.indexOf('ETF') >= 0 || type === '基金') return 'fund';
  return 'stock';
}

// 港股日线补价：腾讯 web.ifzq 日 K（与 hkDailyCoverage 同源，无需积分）。
// 返回的每行是 [日期, 开, 收, 高, 低, 量]，收盘取第 3 位。
// 历史补录的收盘价来自各品种历史日线接口，取到的是该交易日已完成的终盘事实，
// 因此直接以“已确认收盘”准入写入；它不是浏览器自报价格，也不冒充当日盘中报价。
// 市场必须显式落到日价行上：港股与 A 股可能同形（00001 / 000001），缺市场会串价。
// 来源与复权口径要逐行保留（理杏仁 / 腾讯日K / Tushare），否则事后无法追溯；
// 口径不是“不复权”的行一律不写成已确认收盘价。
function historyBackfillRow({ code, price, market, provider, adjust }) {
  const providerName = String(provider || 'unknown');
  const adjustBasis = String(adjust || 'unknown');
  const qualified = adjustBasis === 'none';
  return {
    code, name: '', price, market,
    source: `history_backfill:${providerName}`,
    quality: qualified ? 'confirmed' : 'candidate',
    is_final: qualified ? true : null,
    evidence: {
      origin: 'daily_bar_history',
      provider: providerName,
      price_adjust: adjustBasis,
      // 市场依据：写入时由品种决定，属可核实凭据，取价层据此接受该行。
      market_basis: market === 'HK' ? 'history_provider_hk' : 'history_provider_cn',
      qualification: qualified ? 'unadjusted' : 'adjustment_unverified',
    },
  };
}

// 历史回补行准入：定点补价必须同时满足业务日范围与 qualifiedOnly；
// provider 若忽略请求区间返回额外日期，也不得写入库存。
function selectBackfillRows(byDate, options = {}) {
  const picked = [];
  for (const date of Object.keys(byDate || {})) {
    if (options.businessDate && date !== options.businessDate) continue;
    const rows = options.qualifiedOnly
      ? byDate[date].filter(row => row.quality === 'confirmed' && row.is_final === true)
      : byDate[date];
    if (!rows.length) continue;
    if (options.qualifiedOnly) {
      const prices = new Set(rows.map(row => Number(row.price)));
      if (prices.size !== 1) continue;
      picked.push([date, [rows[0]]]);
    } else {
      picked.push([date, rows]);
    }
  }
  return picked;
}

async function backfillHkDailyPrices(username, accountName, code, start, end, options = {}) {
  // 港股日线属于「行情数据集」：只向数据层要序列，主备来源由数据层决定。
  // 代码规范化与收盘核验同源（数据访问层唯一实现），六位补零的港股持仓不会被当成另一只证券。
  const { readStockDailySeries, normalizeHkSecurityCode } = require('../dataAccess/marketDatasets');
  const bare = normalizeHkSecurityCode(code);
  const rows = await readStockDailySeries({ tsCode: `${bare}.HK`, market: 'hk', startDate: start, endDate: end });
  if (!rows.length) return false;
  const byDate = {};
  for (const row of rows) {
    const date = normDate(row.trade_date);
    const close = Number(row.close);
    if (!date || !(close > 0)) continue;
    (byDate[date] = byDate[date] || []).push(historyBackfillRow({
      code, price: close, market: 'HK', provider: row.source_code, adjust: row.price_adjust,
    }));
  }
  let any = false;
  for (const [date, rowsForDate] of selectBackfillRows(byDate, options)) {
    try {
      await saveDailyPrices(username, accountName, date, rowsForDate, { market: 'HK' });
      any = true;
    } catch (e) { /* 单日失败不阻断其余日期 */ }
  }
  return any;
}

// 用对应证券类型的 Tushare 历史接口拉取 [start, end] 收盘，按日期 upsert 进 daily_prices。
// 成功返回 true（至少写回一条）；失败/无数据返回 false。
async function backfillDailyPrices(username, accountName, code, start, end, position = {}, options = {}) {
  const tsCode = toTsCode(code);
  const kind = historicalKindFor(code, position);
  // 港股日线不走 Tushare（hk_daily 需高积分），改走腾讯 web.ifzq 日 K；
  // 数据源的选择留在数据层，业务层只说「补某只标的某区间的收盘价」。
  if (kind === 'hk_stock') return backfillHkDailyPrices(username, accountName, code, start, end, options);
  let rows = [];
  try {
    rows = await marketDatasets.readHistoricalCloseSeries({ tsCode, kind, startDate: start, endDate: end });
  } catch (e) { return false; }
  if (!rows.length) return false;
  // 按日期分组（saveDailyPrices 按单日期批量写）
  const byDate = {};
  for (const r of rows) {
    const d = normDate(r.trade_date);
    const c = parseFloat(r.close);
    if (!d || isNaN(c) || c <= 0) continue;
    (byDate[d] = byDate[d] || []).push(historyBackfillRow({
      code, price: c, market: 'CN', provider: r.source_code, adjust: r.price_adjust,
    }));
  }
  let any = false;
  for (const [date, rowsForDate] of selectBackfillRows(byDate, options)) {
    try {
      await saveDailyPrices(username, accountName, date, rowsForDate, { market: 'CN' });
      any = true;
    } catch (e) {}
  }
  return any;
}

// 单日精确选价：只承认同一「市场 + 代码 + 日期」的 confirmed + final 正价。
// 同日 confirmed 冲突整日不可用；已有 confirmed 但非 final 时保持待补，不能让候选价冒充终盘。
function pickExactClose(rows, code, market, date) {
  const list = (rows || []).filter(row =>
    String(row.date || '').slice(0, 10) === date && Number(row.price) > 0);
  if (!list.length) return { row: null, conflict: null, hasConfirmed: false };
  const conflict = detectConflictOnDate(code, market, list, date, 'confirmed');
  if (conflict) return { row: null, conflict, hasConfirmed: true };
  const confirmed = list.filter(row => String(row.quality || '') === 'confirmed');
  const finalRows = confirmed.filter(row => row.is_final === true || row.isFinal === true);
  if (finalRows.length) return { row: pickBestByQuality(finalRows), conflict: null, hasConfirmed: true };
  return { row: null, conflict: null, hasConfirmed: confirmed.length > 0 };
}

// 共享确认价的 evidence 只保留可核验公开资格字段，不整包复制其它账户的内部证据。
function sharedCloseEvidence(evidence) {
  const source = evidence || {};
  const out = {};
  for (const key of ['origin', 'provider', 'price_adjust', 'market_basis', 'qualification', 'terminalEvidence']) {
    if (typeof source[key] === 'string') out[key] = source[key];
  }
  out.shared_close_reuse = { basis: 'same_market_code_expected_close' };
  return out;
}

// 交易录入后的定点收盘价补齐（与净值重算、账本事务解耦）。
// - 只处理历史日期；当天及未来尊重现有收盘任务，绝不写盘中候选/成交价为正式终盘。
// - 同时读取本账户与其它账户同一「市场+代码+应有收盘日」的 confirmed/final 公开价；
//   同日 confirmed 冲突（包括本账户已 confirmed 与另一账户不同价）整日不可用。
// - 只有两边都确认无冲突时才复制共享价；真缺才按单证券单日取价。
// - 失败或证据不足返回 pending，由调用方在保存交易成功的前提下明确提示，不抛错。
async function ensureTradeClosePrice(username, accountName, trade = {}, options = {}) {
  const tradeDate = String(trade.tradeDate || trade.date || '').slice(0, 10);
  const rawCode = String(trade.code || '').trim();
  if (!username || !accountName || !rawCode) return { status: 'skipped', reason: 'missing_scope' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return { status: 'skipped', reason: 'invalid_trade_date', tradeDate };
  const today = options.today || cnDate(options.now || new Date());
  if (tradeDate >= today) {
    return { status: 'skipped', reason: 'today_close_flow', code: rawCode, tradeDate };
  }
  try {
    const market = historicalKindFor(rawCode, trade) === 'hk_stock' ? 'HK' : 'CN';
    const expected = options.expectedCloseDate
      ? await options.expectedCloseDate(market, tradeDate)
      : await expectedCloseDateFor(market, tradeDate, options.query || pool.query.bind(pool), new Map(), 'historical');
    const base = { code: rawCode, market, tradeDate, closeDate: expected || null };
    if (!expected) return { ...base, status: 'pending', reason: 'expected_close_date_unknown' };
    const variants = codeVariants(rawCode, market === 'HK');
    const query = options.query || pool.query.bind(pool);
    const pairs = variants.map(code => ({ market, code, date: expected }));
    const readOwn = options.readOwn || (async () => {
      const result = await navAttributionRepository.listOwnPricesAt(
        query, [username, accountName, JSON.stringify(pairs)]
      );
      return result.rows || [];
    });
    const readShared = options.readShared || (async () => {
      const result = await navAttributionRepository.listSharedConfirmedAt(
        query, [username, accountName, JSON.stringify(pairs), PRIVATE_SOURCES]
      );
      return result.rows || [];
    });
    const [rawOwnRows, sharedRows] = await Promise.all([
      readOwn({ username, accountName, date: expected, market, codes: variants }),
      readShared({ username, accountName, date: expected, market, codes: variants }),
    ]);
    // 本账户私有派生价（导入锚点等）不是公开收盘事实，不参与 confirmed 选价或冲突核对。
    const ownRows = rawOwnRows.filter(row => !PRIVATE_SOURCES.includes(String(row.source || '')));
    // 冲突必须同时看本账户与共享行：本账户先有 confirmed 不能跳过另一账户的不同价。
    const combined = pickExactClose([...ownRows, ...sharedRows], rawCode, market, expected);
    if (combined.conflict) return { ...base, status: 'pending', reason: 'shared_close_conflict' };
    const own = pickExactClose(ownRows, rawCode, market, expected);
    if (own.row) return { ...base, status: 'already', source: own.row.source || null };
    if (own.hasConfirmed) return { ...base, status: 'pending', reason: 'local_close_not_final' };
    const shared = pickExactClose(sharedRows, rawCode, market, expected);
    if (shared.row) {
      const savePrice = options.savePrice || ((row) => saveDailyPrices(username, accountName, expected, [row], { market }));
      const saved = await savePrice({
        code: rawCode,
        name: '',
        price: Number(shared.row.price),
        source: shared.row.source || 'shared_confirmed_close',
        quality: 'confirmed',
        is_final: true,
        market,
        evidence: sharedCloseEvidence(shared.row.evidence),
      });
      const written = Array.isArray(saved) ? saved.some(item => item && item.written) : saved !== false;
      if (written) return { ...base, status: 'reused', source: shared.row.source || null };
      const afterRows = (await readOwn({ username, accountName, date: expected, market, codes: variants }))
        .filter(row => !PRIVATE_SOURCES.includes(String(row.source || '')));
      const after = pickExactClose(afterRows, rawCode, market, expected);
      if (after.row) return { ...base, status: 'already', source: after.row.source || null };
      return { ...base, status: 'pending', reason: 'shared_close_write_rejected' };
    }

    const backfill = options.backfill || backfillDailyPrices;
    let fetched = false;
    try {
      fetched = await backfill(username, accountName, rawCode, expected, expected, trade, {
        qualifiedOnly: true,
        businessDate: expected,
      });
    } catch (e) {
      fetched = false;
    }
    const fetchedRows = (await readOwn({ username, accountName, date: expected, market, codes: variants }))
      .filter(row => !PRIVATE_SOURCES.includes(String(row.source || '')));
    const afterFetch = pickExactClose(fetchedRows, rawCode, market, expected);
    if (afterFetch.conflict) return { ...base, status: 'pending', reason: 'local_close_conflict' };
    if (afterFetch.row) return { ...base, status: 'fetched', source: afterFetch.row.source || null };
    return { ...base, status: 'pending', reason: fetched ? 'history_close_not_qualified' : 'history_close_unavailable' };
  } catch (error) {
    return { status: 'pending', reason: 'close_price_check_failed', code: rawCode, tradeDate };
  }
}

// 净值重算前的现金收益结算：只对已知 409 版本竞争做有限重试。
// 授权失败原样抛出；其它失败返回待重算，由调用方保留快照和 nav_dirty_from。
async function settleCashIncomeForRecompute(settle, username, accountName, options = {}) {
  const maxAttempts = Number(options.attempts) > 0 ? Number(options.attempts) : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const state = await settle(username, accountName);
      return {
        status: (state && state.status) || 'calculated',
        changed: state && state.changed,
        navUpdated: state && state.navUpdated,
        attempts: attempt,
      };
    } catch (error) {
      const httpStatus = Number(error && error.status) || 500;
      if (httpStatus === 401 || httpStatus === 403) throw error;
      if (httpStatus !== 409) {
        return { status: 'failed', reason: 'settlement_failed', httpStatus, attempts: attempt };
      }
      if (attempt >= maxAttempts) {
        return { status: 'failed', reason: 'version_conflict', httpStatus: 409, attempts: attempt };
      }
    }
  }
  return { status: 'failed', reason: 'version_conflict', httpStatus: 409, attempts: maxAttempts };
}

// 主入口：从 fromDate 起重算该账户历史净值（幂等 upsert）
async function recomputeNav(username, accountName, fromDate, options = {}) {
  if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return { ok: false, error: 'fromDate 格式应为 YYYY-MM-DD' };
  }
  const settle = options.settleCashIncome || require('../services/cashIncome').settleCashIncome;
  const cashSettlement = await settleCashIncomeForRecompute(settle, username, accountName);
  // 现金收益结算未完成或明确 partial 时，现有现金账本可能已过期：
  // 立即返回待重算，保留现有历史快照与 nav_dirty_from，绝不继续写净值或清除待办。
  if (cashSettlement.status === 'failed' || cashSettlement.status === 'partial') {
    const reason = cashSettlement.status === 'partial'
      ? 'cash_settlement_partial'
      : (cashSettlement.reason === 'version_conflict' ? 'cash_settlement_conflict' : 'cash_settlement_failed');
    console.warn('[replayNav] 现金收益结算未完成，净值保持待重算:', cashSettlement.reason || cashSettlement.status);
    return {
      ok: false,
      status: 'pending',
      reason,
      days: 0,
      missingDates: [],
      cashSettlement,
      warnings: [reason],
    };
  }
  const load = options.loadAccountData || loadAccountData;
  const data = await load(username, accountName);
  const navs = (data.navHistory || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  if (navs.length === 0) {
    return { ok: true, status: 'no_nav', days: 0, note: 'no_nav', cashSettlement };
  }
  const cashBase = Number(data.cashBase) || 0;
  const trades = (data.trades || []).slice().sort(function (a, b) {
    // 方案 3.6 修复：按交易日(trade_date)+成交时间(executed_at)排序，避免带时间 date 与纯日期比较错位
    const ad = a.trade_date || (a.date || '').slice(0, 10);
    const bd = b.trade_date || (b.date || '').slice(0, 10);
    const at = a.executed_at || a.date || a.created_at || '';
    const bt = b.executed_at || b.date || b.created_at || '';
    return (ad + at).localeCompare(bd + bt);
  });
  const cfs = (data.cashFlows || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });

  // 交易日字段（trade_date 优先，兼容旧数据回退 date 前 10 位）
  const tradeDay = function (t) { return t.trade_date || (t.date || '').slice(0, 10); };
  const unresolvedHkdDays = trades
    .filter(function (t) {
      const rawAmountCny = t.amountCny != null && t.amountCny !== '' ? t.amountCny :
        (t.amount_cny != null && t.amount_cny !== '' ? t.amount_cny : null);
      return String(t.quote_currency || '').toUpperCase() === 'HKD' && rawAmountCny == null;
    })
    .map(tradeDay);

  // daily_prices → map "code|date" → price
  const dpRows = await accountsRepository.listAllDailyPrices({ username, accountName });
  const dpMap = new Map();
  dpRows.forEach(function (r) { dpMap.set(r.code + '|' + r.date, r.price); });
  const backfilled = new Set(); // 本run已回填过的代码，避免重复拉 Tushare

  // 复刻 investedAt(date)（与前端 core-earnings.js:116 一致）—— 已收口到 public/shared/nav-math.js

  // 持仓-as-of 某日：重放 tradeDay<=d 的事件（纯日期比较，修复当日带时间交易漏算）
  // 方向语义：buy/open 累加数量；sell 减数量；adjust 数量=调整后目标数量（绝对设置，P0-2）
  function heldQty(date) {
    const m = new Map();
    trades.forEach(function (t) {
      if (tradeDay(t) > date) return;
      const cur = m.get(t.code) || { qty: 0, subtype: t.subtype };
      if (t.direction === 'sell') {
        cur.qty -= (t.quantity || 0);
      } else if (t.direction === 'adjust') {
        cur.qty = Math.max(0, (t.quantity || 0)); // 目标数量绝对设置
      } else {
        cur.qty += (t.quantity || 0); // buy / open 累加
      }
      cur.subtype = t.subtype || cur.subtype;
      m.set(t.code, cur);
    });
    return m;
  }
  // 现金-as-of 某日：cashBase + 现金流(<=d) + 交易净额(tradeDay<=d)
  // open（期初建仓）/ adjust（持仓调整）不产生现金变动（P0-2）
  function cashAsOf(date) {
    const result = cashAt(data, date);
    if (result.incomplete) throw new Error('历史现金事实不完整：' + date);
    return result.value;
  }

  // 锚点：fromDate 之前最近的一条 nav 记录（续链基准）
  let idx0 = navs.findIndex(function (n) { return n.date >= fromDate; });
  if (idx0 < 0) idx0 = navs.length; // fromDate 晚于所有 nav → 无需回填
  let prev = null;
  if (idx0 > 0) {
    const p = navs[idx0 - 1];
    prev = { date: p.date, nav: p.nav, totalAsset: (p.totalAsset != null ? p.totalAsset : 0) };
  }

  const today = cnDate(new Date());
  const fxRows = await accountsRepository.listHkdCnyRateRows({ date: today });
  const fxByDate = new Map(fxRows.map(r => [cnDate(r.rate_date), Number(r.rate)]));
  const currentFxRate = fxByDate.get(today) || await getCurrentFxRate();
  const missingDates = [];
  async function saveCanonical(rec) {
    try { await upsertNav(username, accountName, { ...rec, calculationMode: 'system' }); return true; }
    catch (error) {
      if (error.code !== 'NAV_BASIS_INCOMPLETE') throw error;
      missingDates.push(rec.date);
      return false;
    }
  }
  let affected = 0;

  for (let i = idx0; i < navs.length; i++) {
    const d = navs[i].date;

    const held = heldQty(d);
    const hkRate = fxByDate.get(d) || (d === today ? currentFxRate : null);
    // 未解决港股结算金额会使现金重建不可信；对应日期保留原快照，不允许自动覆盖。
    let missing = unresolvedHkdDays.some(function (td) { return td <= d; });
    const mvList = [];
    for (const [code, info] of held) {
      if (info.qty === 0) continue;
      let price = dpMap.get(code + '|' + d);
      if (price == null) {
        // 缺价 → 按既有默认范围尝试历史回补（本run每代码一次）；回补后从库重载该代码价格
        if (!backfilled.has(code)) {
          backfilled.add(code);
          const ok = await backfillDailyPrices(username, accountName, code, fromDate, today);
          if (ok) {
            const rows = await accountsRepository.listDailyPricesByCode({ username, accountName, code });
            rows.forEach(function (r) { dpMap.set(code + '|' + r.date, r.price); });
          }
        }
        price = dpMap.get(code + '|' + d);
        if (price == null) { missing = true; continue; }
      }
      if (info.subtype === '港股' && !(hkRate > 0)) { missing = true; continue; }
      const mv = price * info.qty * (info.subtype === '港股' ? hkRate : 1);
      mvList.push(mv);
    }
    if (missing) {
      missingDates.push(d);
      // 该日无法精确计算 → 保留原快照，prev 用原值续链
      const orig = navs[i];
      prev = { date: d, nav: orig.nav, totalAsset: (orig.totalAsset != null ? orig.totalAsset : (prev ? prev.totalAsset : 0)) };
      continue;
    }

    const totalAsset = cashAsOf(d) + mvList.reduce(function (s, v) { return s + v; }, 0);
    const invested = investedAt(navs, cfs, cashBase, d);

    if (i === 0 && idx0 === 0 && !prev) {
      // 整体首条：nav 固定 1.0（与 recordNav 一致）
      if (!await saveCanonical({ date: d, nav: 1.0, totalAsset: totalAsset, invested: invested, hkRate: hkRate })) continue;
      prev = { date: d, nav: 1.0, totalAsset: totalAsset };
      affected++;
      continue;
    }
    if (!prev) { prev = { date: d, nav: navs[i].nav, totalAsset: totalAsset }; continue; }

    // periodCashFlow：prev.date(不含) → d(含) 的累计净现金流
    let pcf = 0;
    cfs.forEach(function (f) { if (isExternalTransfer(f) && f.date > prev.date && f.date <= d) pcf += (f.amount || 0); });
    const baseAsset = prev.totalAsset + pcf;
    if (baseAsset <= 0) {
      missingDates.push(d);
      const orig = navs[i];
      prev = { date: d, nav: orig.nav, totalAsset: (orig.totalAsset != null ? orig.totalAsset : prev.totalAsset) };
      continue;
    }
    const nav = chainNav(prev.nav, prev.totalAsset, totalAsset, pcf);
    if (!await saveCanonical({ date: d, nav: nav, totalAsset: totalAsset, invested: invested, hkRate: hkRate })) continue;
    prev = { date: d, nav: nav, totalAsset: totalAsset };
    affected++;
  }

  if (affected > 0 && missingDates.length === 0) {
    await accountsRepository.clearNavDirtyFrom({ username, accountName });
  }
  const warnings = [];
  return {
    ok: missingDates.length === 0,
    status: missingDates.length ? 'partial' : 'succeeded',
    days: affected,
    missingDates: [...new Set(missingDates)],
    cashSettlement,
    warnings,
  };
}

module.exports = {
  recomputeNav,
  ensureTradeClosePrice,
  settleCashIncomeForRecompute,
  selectBackfillRows,
  backfillDailyPrices,
  historicalKindFor,
  historyBackfillRow,
  isTradingDay,
  cnDate,
};
