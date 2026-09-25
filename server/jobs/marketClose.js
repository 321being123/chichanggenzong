// ========== 自动记录每日收盘价（按市场收盘时刻精准触发 + 休市识别 + 缺失补漏） ==========
const { pool, loadAccountData, saveDailyPrices, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { fetchQuoteByCode } = require('../services/market');
const { getMarketState, isCnTradingDate, prefetchMarketFacts, shanghaiDateTime, parseClock } = require('../services/marketState');
const { runNavSnapshotJob } = require('./navSnapshot');
const { runIndexRecentJob } = require('./indexBaseline');
const { runHkRateJob } = require('./hkRate');
const { backfillDailyPrices } = require('./replayNav');
const { getExternalCallStats } = require('../services/externalCallGuard');
const classifyCode = require('../../public/js/code-classify');
const sharedQuotePromises = new Map();
const legacyFinalTasks = new Map();

// 各市场收盘时间：{ hour, minute, 适用的代码前缀匹配规则 }
const MARKET_CLOSE_TIMES = [
  { h: 15, m: 10, label: 'A股', market: 'CN', match: (code, position) => position && position.subtype !== '港股' && String(code).length >= 6 && /^(00|30|60|68|[48])/.test(code) && !/(债|转债)/.test(String(position.name || '')) },
  { h: 16, m: 30, label: '港股', market: 'HK', match: (code, position) => position && (position.subtype === '港股' || String(position.quoteCurrency || '').toUpperCase() === 'HKD') || code.length === 5 },
  { h: 15, m: 10, label: '可转债', market: 'CN', match: code => /^(11|12)/.test(code) },
  { h: 15, m: 10, label: 'LOF/ETF', market: 'CN', match: code => classifyCode.isFundEtfCode(code) },
  { h: 15, m: 10, label: '非标准证券', market: 'CN', match: (code, position) => isUncoveredPosition(code, position) },
];

// 固定东八区偏移（毫秒）：显式使用 Asia/Shanghai，不依赖容器本地时区，避免 UTC 容器下任务错时
const CN_OFFSET_MS = 8 * 3600 * 1000;

// 东八区日期 YYYY-MM-DD（任意输入 Date 都按北京时间解释，不受容器时区影响）
function fmtCN(d) {
  const x = new Date(d);
  const cn = new Date(x.getTime() + CN_OFFSET_MS);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}

// 今天（东八区）
function cnDateStr() { return fmtCN(new Date()); }

// 北京时间的星期几（0=周日），不依赖容器本地时区
function cnWeekday(d) {
  const ds = fmtCN(d || new Date());
  return new Date(ds + 'T00:00:00Z').getUTCDay();
}

// 是否为交易日：周一至周五 且 非法定节假日（按北京时间判断）
function isTradingDay(d) {
  return isCnTradingDate(fmtCN(d || new Date()));
}

async function isMarketTradingDate(market, date) {
  if (market === 'HK') {
    return (await getMarketState({ market: 'HK', businessDate: date, time: '00:00' })).status === 'open';
  }
  return isCnTradingDate(date);
}

// 距离「北京时间 h:m」还有多少毫秒（显式东八区，不依赖容器时区）
function msUntil(h, m, nowInput) {
  const now = nowInput ? new Date(nowInput) : new Date();
  const cnNow = new Date(now.getTime() + CN_OFFSET_MS);
  const target = new Date(cnNow);
  target.setUTCHours(h, m, 0, 0); // cnNow 的内部 UTC 字段即北京时间，用 UTC 访问器设时分
  if (target <= cnNow) target.setUTCDate(target.getUTCDate() + 1);
  const targetEpoch = target.getTime() - CN_OFFSET_MS; // 转回真实 epoch
  return targetEpoch - now.getTime();
}

// 计算到「下一个交易日北京时间 h:m」的毫秒数（显式东八区，不依赖容器本地时区）
// 复用 msUntil 得到下一个北京时间 h:m 的落点，再按北京时间日期跳过非交易日。
function nextRunDelay(h, m) {
  let epoch = Date.now() + msUntil(h, m) + 60000; // +1 分钟缓冲，避开当前执行点
  let guard = 0;
  while (!isTradingDay(new Date(epoch)) && guard < 14) {
    epoch += 86400000; // 顺延一天（毫秒，跨时区安全）
    guard++;
  }
  return Math.max(epoch - Date.now(), 5000);
}

function quoteForCode(quoteMap, code) {
  if (!quoteMap) return null;
  const value = String(code || '').trim();
  return quoteMap.get(value) || quoteMap.get(value.replace(/\.(SH|SZ|BJ|HK)$/i, '')) || null;
}

function isUsableQuote(quote, expectedDate) {
  return Boolean(quote && quote.price > 0 && (!expectedDate || (quote.quote_time && fmtCN(quote.quote_time) === expectedDate)));
}

function mergeQuoteMaps(target, source) {
  if (!target || !source) return target;
  source.forEach((quote, key) => target.set(key, quote));
  return target;
}

// 带重试的行情抓取。共享批量结果缺失时由 recordCloseOne 统一批量补取；
// 这里读取 Map 只属于本地校验，不能把本地重复检查计入外部请求数。
async function fetchWithRetry(code, tries, requestBudget, expectedDate, quoteMap = null) {
  for (let i = 0; i < tries; i++) {
    if (!quoteMap) {
      if (requestBudget && requestBudget.used >= requestBudget.limit) {
        const error = new Error(`收盘行情请求预算已用尽（${requestBudget.limit}）`);
        error.code = 'QUOTA_EXHAUSTED';
        error.errorType = 'rate_limit';
        throw error;
      }
      if (requestBudget) requestBudget.used += 1;
    }
    try {
      const q = quoteMap ? quoteForCode(quoteMap, code) : await fetchQuoteByCode(code);
      if (isUsableQuote(q, expectedDate)) return q;
    } catch (e) {}
    if (i < tries - 1) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// 纯函数：从持仓中挑出「属于该市场(matchFn)且当日尚无价格」的代码。
// 这是 P0-3 修复的核心：以「代码」而非「账户当天任意一条记录」判断缺失，
// 保证 A 股已写入时，可转债/ETF 仍会被抓取，部分缺失也能补齐。
function pickMissingCodes(positions, existingCodes, matchFn) {
  return (positions || [])
    .filter(p => p && p.code && matchFn(p.code, p) && !existingCodes.has(p.code))
    .map(p => p.code);
}

// 为单个账户记录某交易日某市场收盘价。
// 幂等到「代码」级别：只抓取当日该市场持仓中【尚未记录】的代码，
// 因此 A 股先写入后，可转债/ETF 不会被整体跳过；部分缺失也能补齐。
// 返回 { recorded, failed, error }；error=true 表示有持仓却全部抓取失败
async function recordCloseOne(username, accountName, label, matchFn, dateStr, requestBudget, context = {}) {
  const cnDate = dateStr || cnDateStr();

  const result = await loadAccountData(username, accountName);
  const positions = (result.positions || []);
  if (positions.length === 0) return { recorded: 0, failed: 0, skipped: 0 };

  // 已有价格代码集合（按代码去重，而非「账户当天任意一条」）
  const { rows: existingRows } = await pool.query(
    'SELECT code FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3',
    [username, accountName, cnDate]
  );
  const existingCodes = new Set(existingRows.map(r => r.code));

  // 仅抓取缺失代码（按代码去重，避免同一代码因多条持仓记录而重复抓取）
  const missingCodes = pickMissingCodes(positions, existingCodes, matchFn);
  if (missingCodes.length === 0) return { recorded: 0, failed: 0, skipped: 0 };
  const seen = new Set();
  const missing = positions.filter(p => {
    if (missingCodes.includes(p.code) && !seen.has(p.code)) { seen.add(p.code); return true; }
    return false;
  });

  let recorded = 0, failed = 0, skipped = 0;
  const prices = [];
  // 退市/人工估值等非标准证券没有可靠的市场收盘价：保留未归因状态，
  // 记录跳过数量供任务审计，但不把“无行情”伪装成成功价格或反复触发接口失败。
  if (label === '非标准证券') {
    skipped = missing.length;
    return { recorded, failed, skipped, error: false };
  }
  // 历史补漏必须走对应证券类型的历史接口，不能把当前实时价写入过去日期。
  if (cnDate !== cnDateStr()) {
    for (const pos of missing) {
      const ok = await backfillDailyPrices(username, accountName, pos.code, cnDate, cnDate, pos);
      if (ok) recorded++;
      else failed++;
    }
    return { recorded, failed, skipped, error: recorded === 0 && failed > 0 };
  }
  if (context.quoteMap && context.refreshMissingQuotes) {
    await context.refreshMissingQuotes(missing.map(pos => pos.code));
  }
  for (const pos of missing) {
    const q = await fetchWithRetry(pos.code, 2, requestBudget, cnDate, context.quoteMap || null);
    if (q && q.price) {
      prices.push({ code: pos.code, name: pos.name || q.name || '', price: q.price });
      recorded++;
    } else {
      failed++;
    }
  }
  if (prices.length > 0) await saveDailyPrices(username, accountName, cnDate, prices);
  const error = recorded === 0 && failed > 0;
  return { recorded, failed, skipped, error };
}

// 同一交易日四个市场收盘任务共用一次腾讯批量行情结果；后续市场只读本进程缓存。
async function getSharedQuoteMap(cnDate) {
  const key = String(cnDate || cnDateStr());
  if (sharedQuotePromises.has(key)) return sharedQuotePromises.get(key);
  const promise = (async () => {
    const { rows } = await pool.query("SELECT code FROM positions WHERE code IS NOT NULL AND code <> ''");
    const codes = [...new Set(rows.map(row => String(row.code || '').trim()).filter(code =>
      /^(00|30|43|48|50|51|60|68|83|87|92|11|12|15|16|[0-9]{5})/.test(code)
    ))];
    return require('../services/tencentQuote').fetchTencentQuotes(codes, { businessDate: key });
  })().catch(error => { sharedQuotePromises.delete(key); throw error; });
  sharedQuotePromises.set(key, promise);
  return promise;
}

// 为所有账户记录某市场某交易日收盘价；任一证券失败都进入统一有限重试，避免部分账户缺数却显示成功。
async function recordMarketClose(label, matchFn, dateStr, context = {}) {
  const cnDate = dateStr || cnDateStr();
  const market = MARKET_CLOSE_TIMES.find(item => item.label === label);
  if (!market || !(await isMarketTradingDate(market.market, cnDate))) {
    return { recorded: 0, failed: 0, skipped: 0, verifiedNoChange: true, reason: 'market_closed_or_unknown' };
  }
  const totalLimit = Math.max(Number(process.env.MARKET_CLOSE_REQUEST_BUDGET) || 2000, 1);
  const previousCalls = Math.max(Number(context.externalCallCount) || 0, 0);
  const requestBudget = { used: 0, limit: Math.max(totalLimit - previousCalls, 0) };
  const quoteMap = cnDate === cnDateStr() ? (context.quoteMap || await getSharedQuoteMap(cnDate)) : null;
  const refreshAttempted = new Set();
  const refreshMissingQuotes = quoteMap ? async codes => {
    const candidates = [...new Set((codes || []).map(code => String(code || '').trim()).filter(Boolean))]
      .filter(code => !refreshAttempted.has(code) && !isUsableQuote(quoteForCode(quoteMap, code), cnDate));
    candidates.forEach(code => refreshAttempted.add(code));
    if (!candidates.length) return;
    const { fetchTencentQuotes } = require('../services/tencentQuote');
    const refreshed = await fetchTencentQuotes(candidates, { businessDate: cnDate, force: true });
    mergeQuoteMaps(quoteMap, refreshed);
  } : null;
  const { rows: accounts } = await pool.query('SELECT username, account_name FROM accounts ORDER BY username, created_at');
  let recorded = 0, failed = 0, skipped = 0;
  for (const account of accounts) {
    const r = await recordCloseOne(account.username, account.account_name, label, matchFn, cnDate, requestBudget, { quoteMap, refreshMissingQuotes })
      .catch(error => {
        if (error && ['RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN', 'DATASET_LOCKED'].includes(error.code)) {
          error.externalCalls = getExternalCallStats().total;
          throw error;
        }
        return { recorded: 0, failed: 1, error: true };
      });
    recorded += Number(r && r.recorded || 0);
    failed += Number(r && r.failed || 0);
    skipped += Number(r && r.skipped || 0);
  }
  if (failed > 0) {
    // 失败必须按统一执行器重试：if (failed > 0) throw new Error(...)
    const error = new Error(`收盘记录存在缺失 (${label} ${cnDate})：成功 ${recorded}，失败 ${failed}`);
    error.externalCalls = getExternalCallStats().total;
    throw error;
  }
  return { recorded, failed, skipped, verifiedNoChange: recorded === 0 && skipped === 0, externalCalls: getExternalCallStats().total };
}

async function recentMarketDays(count) {
  const days = [];
  const now = new Date();
  const dates = [];
  for (let i = 1; i <= 21; i++) dates.push(fmtCN(new Date(now.getTime() - i * 86400000)));
  await prefetchMarketFacts('HK', dates);
  for (let i = 1; i <= 21 && days.length < count; i++) {
    const dd = new Date(now.getTime() - i * 86400000);
    const date = fmtCN(dd);
    const [cnOpen, hkOpen] = await Promise.all([
      Promise.resolve(isCnTradingDate(date)),
      isMarketTradingDate('HK', date),
    ]);
    if (cnOpen || hkOpen) days.push(date);
  }
  return days;
}

function isUncoveredPosition(code, position) {
  return Number(position && position.quantity) > 0 &&
    !MARKET_CLOSE_TIMES.filter(mkt => mkt.label !== '非标准证券').some(mkt => mkt.match(code, position));
}

// 手动补漏先查询账户已有收盘价的日期范围，再找出其中遗漏的交易日。
// 不把 daily_prices 首日之前的历史当成“遗漏”，避免在功能启用前的旧数据被误判为待补。
async function findMissingCloseDates(username, accountName) {
  const range = await pool.query(
    'SELECT MIN(date)::text AS first_date FROM daily_prices WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const firstDate = range.rows[0] && range.rows[0].first_date;
  const lastDate = (await recentMarketDays(1))[0];
  if (!firstDate || !lastDate || firstDate > lastDate) return [];

  const existing = await pool.query(
    'SELECT date::text AS date FROM daily_prices WHERE username=$1 AND account_name=$2 AND date BETWEEN $3 AND $4',
    [username, accountName, firstDate, lastDate]
  );
  const existingDates = new Set(existing.rows.map(row => row.date));
  const missingDates = [];
  const cursor = new Date(firstDate + 'T12:00:00Z');
  const end = new Date(lastDate + 'T12:00:00Z');
  const rangeDates = [];
  for (let date = firstDate; date <= lastDate; date = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)) rangeDates.push(date);
  await prefetchMarketFacts('HK', rangeDates);
  while (cursor <= end) {
    const date = fmtCN(cursor);
    const hkOpen = await isMarketTradingDate('HK', date);
    if ((isCnTradingDate(date) || hkOpen) && !existingDates.has(date)) missingDates.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return missingDates;
}

// 缺失补漏：自动任务只回看近期；手动任务查询每个账户已落库区间的全部缺失交易日。
async function backfillMissingCloses(options) {
  const scanAllMissingDates = !!(options && options.scanAllMissingDates);
  const recentDays = scanAllMissingDates ? null : await recentMarketDays(6);
  const { rows: accounts } = await pool.query('SELECT username, account_name FROM accounts ORDER BY username, created_at');
  let accountCount = 0, missingDates = 0, recorded = 0, failed = 0, skipped = 0;
  for (const account of accounts) {
    const accountName = account.account_name;
    const days = scanAllMissingDates
      ? await findMissingCloseDates(account.username, accountName)
      : recentDays;
    if (!days.length) continue;
    accountCount++;
    missingDates += days.length;
    for (const day of days) {
      // 不再用「当天任意一条记录」判断是否跳过：recordCloseOne 内部按代码幂等，
      // 只补齐缺失代码，已完整的市场不会重复抓取，缺失的市场会被补上。
      for (const mkt of MARKET_CLOSE_TIMES) {
        if (!(await isMarketTradingDate(mkt.market, day))) continue;
        const result = await recordCloseOne(account.username, accountName, mkt.label, mkt.match, day)
          .catch(e => { console.warn('[backfill] ' + day + ' ' + accountName + ' 失败:', e.message); return null; });
        if (result) {
          recorded += result.recorded || 0;
          failed += result.failed || 0;
          skipped += result.skipped || 0;
        }
      }
    }
  }
  return { accounts: accountCount, missingDates, recorded, failed, skipped };
}

// 带幂等锁与执行记录的收盘任务（跨实例单跑，失败留痕供告警）
async function runMarketCloseJob(label, matchFn, dateStr, context = {}) {
  if (!(await tryClaimJob('market_close:' + label))) return { skipped: true, reason: 'already_running' }; // 其他实例已在跑，跳过
  const runId = await startJobRun('market_close:' + label);
  try {
    const result = await recordMarketClose(label, matchFn, dateStr, context);
    await finishJobRun(runId, true, `写入 ${result.recorded}，跳过 ${result.skipped || 0}，失败 0`);
    return { ok: true, label, ...result };
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
    console.error('[market_close:' + label + '] 失败:', e.message || e);
    return {
      ok: false,
      error: e.message || String(e),
      errorCode: e.code,
      errorType: e.errorType || e.type,
      source: e.source,
      externalCalls: Number(e.externalCalls || context.externalCallCount || 0),
    };
  } finally {
    await releaseJob('market_close:' + label);
  }
}

async function runMarketCloseByLabel(label, dateStr, context = {}) {
  const market = MARKET_CLOSE_TIMES.find(item => item.label === label);
  if (!market) return { ok: false, unsupported: true, error: `未找到收盘市场规则：${label}` };
  return runMarketCloseJob(market.label, market.match, dateStr, context);
}

function marketTimeEpoch(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const minute = parseClock(time);
  return Date.UTC(year, month - 1, day, Math.floor(minute / 60) - 8, minute % 60, 0, 0);
}

async function waitUntilBusinessTime(date, time) {
  const delay = marketTimeEpoch(date, time) - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
}

async function runLegacyFinalTaskOnce(date, taskName, task) {
  const key = `${date}|${taskName}`;
  if (legacyFinalTasks.has(key)) return legacyFinalTasks.get(key);
  const promise = Promise.resolve().then(task).then(result => {
    if (!result || result.ok !== false) return result;
    legacyFinalTasks.delete(key);
    return result;
  }).catch(error => {
    legacyFinalTasks.delete(key);
    throw error;
  });
  legacyFinalTasks.set(key, promise);
  for (const existingKey of legacyFinalTasks.keys()) {
    if (existingKey.slice(0, 10) < fmtCN(new Date(Date.now() - 7 * 86400000))) legacyFinalTasks.delete(existingKey);
  }
  return promise;
}

function shouldRunLegacyNavAfterHkClose(cnStatus, hkCloseQuoteTime) {
  const closeMinute = parseClock(hkCloseQuoteTime);
  const halfDay = closeMinute != null && closeMinute <= 15 * 60 + 10;
  return cnStatus === 'closed' || (cnStatus === 'open' && !halfDay);
}

async function runLegacyPostCloseCycle(marketRule, date, result) {
  if (!result || result.ok !== true) return;
  const [cn, hk] = await Promise.all([
    getMarketState({ market: 'CN', businessDate: date, time: '00:00' }),
    getMarketState({ market: 'HK', businessDate: date, time: '00:00' }),
  ]);
  if (marketRule.market === 'HK') {
    const fx = await runLegacyFinalTaskOnce(date, 'hk-rate', () => runHkRateJob({ final: true, targetDate: date }));
    if (fx && fx.ok && shouldRunLegacyNavAfterHkClose(cn.status, hk.closeQuoteTime)) {
      await runLegacyFinalTaskOnce(date, 'nav-snapshot', () => runNavSnapshotJob({ targetDate: date }));
      await runLegacyFinalTaskOnce(date, 'index-recent', () => runIndexRecentJob());
    }
    return;
  }
  const hkHalfDayAlreadyClosed = hk.status === 'open' && hk.closeQuoteTime && parseClock(hk.closeQuoteTime) <= 15 * 60 + 10;
  if (hk.status === 'closed' || hkHalfDayAlreadyClosed) {
    await waitUntilBusinessTime(date, hk.status === 'closed' ? '16:15' : '15:20');
    const fx = await runLegacyFinalTaskOnce(date, 'hk-rate', () => runHkRateJob({ final: true, targetDate: date }));
    if (!fx || !fx.ok) return;
    if (hk.status === 'closed') await waitUntilBusinessTime(date, '16:20');
    await runLegacyFinalTaskOnce(date, 'nav-snapshot', () => runNavSnapshotJob({ targetDate: date }));
    await runLegacyFinalTaskOnce(date, 'index-recent', () => runIndexRecentJob());
  }
}

async function nextMarketCloseDelay(marketRule, nowInput = new Date()) {
  const now = new Date(nowInput);
  const dates = [];
  for (let offset = 0; offset <= 31; offset++) dates.push(fmtCN(new Date(now.getTime() + offset * 86400000)));
  if (marketRule.market === 'HK') await prefetchMarketFacts('HK', dates);
  for (const date of dates) {
    const state = await getMarketState({ market: marketRule.market, businessDate: date, time: '00:00' });
    if (state.status !== 'open') continue;
    const closeQuoteTime = marketRule.market === 'HK' ? state.closeQuoteTime : null;
    const time = closeQuoteTime || `${String(marketRule.h).padStart(2, '0')}:${String(marketRule.m).padStart(2, '0')}`;
    const target = marketTimeEpoch(date, time);
    if (target > now.getTime()) return Math.max(target - now.getTime(), 5000);
  }
  return 12 * 60 * 60 * 1000;
}

// 旧调度兼容入口仍使用同一市场状态服务，港股收盘采集在实际收市后20分钟运行。
function scheduleAllMarketCloses() {
  let lastBackfill = '';
  for (const marketRule of MARKET_CLOSE_TIMES) {
    const scheduleNext = async () => {
      const delay = await nextMarketCloseDelay(marketRule).catch(() => 12 * 60 * 60 * 1000);
      setTimeout(async () => {
        try {
          const today = cnDateStr();
          if (await isMarketTradingDate(marketRule.market, today)) {
            if (today !== lastBackfill) {
              lastBackfill = today;
              backfillMissingCloses().catch(error => console.error('[worker] 补漏失败:', error.message));
            }
            const result = await runMarketCloseJob(marketRule.label, marketRule.match, today);
            await runLegacyPostCloseCycle(marketRule, today, result);
          }
        } catch (error) {
          console.error(`[worker] ${marketRule.label} 收盘任务失败:`, error.message || error);
        }
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }
}

module.exports = { scheduleAllMarketCloses, runMarketCloseByLabel, backfillMissingCloses, findMissingCloseDates, isTradingDay, isMarketTradingDate, nextMarketCloseDelay, fmtCN, pickMissingCodes, isUncoveredPosition, cnWeekday, msUntil, nextRunDelay, quoteForCode, isUsableQuote, mergeQuoteMaps, shouldRunLegacyNavAfterHkClose, runLegacyPostCloseCycle };
