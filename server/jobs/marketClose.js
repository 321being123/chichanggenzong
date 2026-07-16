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

// 东八区日期 YYYY-MM-DD（兼容任意 Date）
function fmtCN(d) {
  const x = new Date(d);
  const cn = new Date(x.getTime() + (x.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}

// 今天（东八区）
function cnDateStr() { return fmtCN(new Date()); }

// 是否为交易日：周一至周五 且 非法定节假日
function isTradingDay(d) {
  const day = (d || new Date()).getDay();
  if (day < 1 || day > 5) return false;
  return !isCnHoliday(fmtCN(d || new Date()));
}

// 距离指定时间的毫秒数
function msUntil(h, m) {
  var now = new Date();
  var target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
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

// 为单个账户记录某交易日收盘价（幂等：已记录则跳过）
// 返回 { recorded, failed, error }；error=true 表示有持仓却全部抓取失败
async function recordCloseOne(username, accountName, label, matchFn, dateStr) {
  const cnDate = dateStr || cnDateStr();
  const { rows: existing } = await pool.query(
    'SELECT 1 FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3 LIMIT 1',
    [username, accountName, cnDate]
  );
  if (existing.length > 0) return { recorded: 0, failed: 0 };

  const result = await loadAccountData(username, accountName);
  const positions = (result.positions || []).filter(p => matchFn(p.code));
  if (positions.length === 0) return { recorded: 0, failed: 0 };

  let recorded = 0, failed = 0;
  const prices = [];
  for (const pos of positions) {
    if (!pos.code) continue;
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
        const { rows } = await pool.query(
          'SELECT 1 FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3 LIMIT 1',
          [user.username, accountName, day]
        );
        if (rows.length > 0) continue;
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
        var delay = msUntil(mkt.h, mkt.m);
        var nextDay = new Date(Date.now() + delay + 60000);
        while (!isTradingDay(nextDay)) {
          nextDay.setDate(nextDay.getDate() + 1);
        }
        var now = new Date();
        nextDay.setHours(mkt.h, mkt.m, 0, 0);
        var nextDelay = nextDay - now;
        if (nextDelay <= 0) nextDelay = 5000;
        setTimeout(runAndReschedule, nextDelay);
      }
      var initialDelay = msUntil(mkt.h, mkt.m);
      setTimeout(runAndReschedule, initialDelay);
    })(MARKET_CLOSE_TIMES[i]);
  }
}

module.exports = { scheduleAllMarketCloses, backfillMissingCloses, isTradingDay, fmtCN };
