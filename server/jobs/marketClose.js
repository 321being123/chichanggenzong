// ========== 自动记录每日收盘价（按市场收盘时刻精准触发 + 休市识别 + 缺失补漏） ==========
const { pool, loadAccountData, saveDailyPrices, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { fetchQuoteByCode } = require('../services/market');
const { isCnHoliday } = require('../config/holidays');
const { runNavSnapshotJob } = require('./navSnapshot');
const { runIndexRecentJob } = require('./indexBaseline');
const { runHkRateJob } = require('./hkRate');

// 各市场收盘时间：{ hour, minute, 适用的代码前缀匹配规则 }
const MARKET_CLOSE_TIMES = [
  { h: 15, m: 10, label: 'A股',     match: code => /^(00|30|60|68|[48])/.test(code) },
  { h: 16, m: 10, label: '港股',    match: code => code.length === 5 },
  { h: 15, m: 10, label: '可转债',   match: code => /^(11|12)/.test(code) },
  { h: 15, m: 10, label: 'LOF/ETF', match: code => /^(15|16|50|51)/.test(code) && code.length === 6 },
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
  const day = cnWeekday(d || new Date());
  if (day < 1 || day > 5) return false;
  return !isCnHoliday(fmtCN(d || new Date()));
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

// 带重试的行情抓取：Tushare 偶发 null / 港股腾讯抖动 → 重试 2 次，间隔 1s
async function fetchWithRetry(code, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const q = await fetchQuoteByCode(code);
      if (q && q.price) return q;
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
    .filter(p => p && p.code && matchFn(p.code) && !existingCodes.has(p.code))
    .map(p => p.code);
}

// 为单个账户记录某交易日某市场收盘价。
// 幂等到「代码」级别：只抓取当日该市场持仓中【尚未记录】的代码，
// 因此 A 股先写入后，可转债/ETF 不会被整体跳过；部分缺失也能补齐。
// 返回 { recorded, failed, error }；error=true 表示有持仓却全部抓取失败
async function recordCloseOne(username, accountName, label, matchFn, dateStr) {
  const cnDate = dateStr || cnDateStr();

  const result = await loadAccountData(username, accountName);
  const positions = (result.positions || []);
  if (positions.length === 0) return { recorded: 0, failed: 0 };

  // 已有价格代码集合（按代码去重，而非「账户当天任意一条」）
  const { rows: existingRows } = await pool.query(
    'SELECT code FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3',
    [username, accountName, cnDate]
  );
  const existingCodes = new Set(existingRows.map(r => r.code));

  // 仅抓取缺失代码（按代码去重，避免同一代码因多条持仓记录而重复抓取）
  const missingCodes = pickMissingCodes(positions, existingCodes, matchFn);
  if (missingCodes.length === 0) return { recorded: 0, failed: 0 };
  const seen = new Set();
  const missing = positions.filter(p => {
    if (missingCodes.includes(p.code) && !seen.has(p.code)) { seen.add(p.code); return true; }
    return false;
  });

  let recorded = 0, failed = 0;
  const prices = [];
  for (const pos of missing) {
    const q = await fetchWithRetry(pos.code, 2);
    if (q && q.price) {
      prices.push({ code: pos.code, name: pos.name || q.name || '', price: q.price });
      recorded++;
    } else {
      failed++;
    }
  }
  if (prices.length > 0) await saveDailyPrices(username, accountName, cnDate, prices);
  const error = recorded === 0 && failed > 0;
  return { recorded, failed, error };
}

// 为所有账户记录某市场某交易日收盘价（聚合判断「全部失败」才抛出，供任务留痕）
async function recordMarketClose(label, matchFn, dateStr) {
  const cnDate = dateStr || cnDateStr();
  const { rows: users } = await pool.query('SELECT username, accounts FROM users');
  let anyRecorded = false, anyError = false;
  for (const user of users) {
    const accounts = typeof user.accounts === 'string' ? JSON.parse(user.accounts) : (user.accounts || []);
    for (const accountName of accounts) {
      const r = await recordCloseOne(user.username, accountName, label, matchFn, cnDate)
        .catch(e => { anyError = true; return { recorded: 0, failed: 1, error: true }; });
      if (r && r.recorded > 0) anyRecorded = true;
      if (r && r.error) anyError = true;
    }
  }
  if (!anyRecorded && anyError) throw new Error('收盘记录全部失败 (' + label + ' ' + cnDate + ')');
}

// 缺失补漏：回看最近若干交易日，某账户某交易日 daily_prices 为 0 行则重抓落库（幂等）
async function backfillMissingCloses() {
  const days = [];
  const now = new Date();
  for (let i = 1; i <= 12 && days.length < 6; i++) {
    const dd = new Date(now.getTime() - i * 86400000);
    if (isTradingDay(dd)) days.push(fmtCN(dd));
  }
  if (days.length === 0) return;
  const { rows: users } = await pool.query('SELECT username, accounts FROM users');
  for (const user of users) {
    const accounts = typeof user.accounts === 'string' ? JSON.parse(user.accounts) : (user.accounts || []);
    for (const accountName of accounts) {
      for (const day of days) {
        // 不再用「当天任意一条记录」判断是否跳过：recordCloseOne 内部按代码幂等，
        // 只补齐缺失代码，已完整的市场不会重复抓取，缺失的市场会被补上。
        for (const mkt of MARKET_CLOSE_TIMES) {
          await recordCloseOne(user.username, accountName, mkt.label, mkt.match, day)
            .catch(e => console.warn('[backfill] ' + day + ' ' + accountName + ' 失败:', e.message));
        }
      }
    }
  }
}

// 带幂等锁与执行记录的收盘任务（跨实例单跑，失败留痕供告警）
async function runMarketCloseJob(label, matchFn) {
  if (!(await tryClaimJob('market_close:' + label))) return; // 其他实例已在跑，跳过
  const runId = await startJobRun('market_close:' + label);
  try {
    await recordMarketClose(label, matchFn);
    await finishJobRun(runId, true, '');
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
    console.error('[market_close:' + label + '] 失败:', e.message || e);
  } finally {
    await releaseJob('market_close:' + label);
  }
}

// 为所有市场分别调度收盘任务（含休市识别 + 每日缺失补漏）
function scheduleAllMarketCloses() {
  let lastBackfill = '';
  for (let i = 0; i < MARKET_CLOSE_TIMES.length; i++) {
    (function (mkt) {
      function runAndReschedule() {
        if (isTradingDay()) {
          // 每日仅补一次「前一交易日」的漏（不论哪个市场先触发）
          const today = cnDateStr();
          if (today !== lastBackfill) {
            lastBackfill = today;
            backfillMissingCloses().catch(e => console.error('[worker] 补漏失败:', e.message));
          }
          // 港股 16:10 是最晚收盘：待其收盘价落库后，依次生成当日净值/总资产快照、指数点位、港币汇率
          runMarketCloseJob(mkt.label, mkt.match)
            .then(() => {
              if (mkt.label !== '港股') return;
              return runNavSnapshotJob()
                .then(() => runIndexRecentJob())
                .then(() => runHkRateJob());
            })
            .catch(() => {});
        }
        var nextDelay = nextRunDelay(mkt.h, mkt.m);
        setTimeout(runAndReschedule, nextDelay);
      }
      var initialDelay = msUntil(mkt.h, mkt.m);
      setTimeout(runAndReschedule, initialDelay);
    })(MARKET_CLOSE_TIMES[i]);
  }
}

module.exports = { scheduleAllMarketCloses, backfillMissingCloses, isTradingDay, fmtCN, pickMissingCodes, cnWeekday, msUntil, nextRunDelay };
