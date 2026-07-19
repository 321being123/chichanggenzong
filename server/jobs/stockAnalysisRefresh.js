const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { listUserStocks, refreshStockAnalysis } = require('../services/stockAnalysis');
const { pool } = require('../db/connection');

const JOB = 'stock_analysis_refresh';

function nextShanghaiDelay(hour = 20, minute = 30, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
  const current = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  let target = Date.UTC(+p.year, +p.month - 1, +p.day, hour, minute, 0);
  if (target <= current) target += 24 * 3600 * 1000;
  return target - current;
}

async function trackedStocks() {
  const { rows: users } = await pool.query('SELECT username FROM users WHERE status=$1', ['active']);
  const map = new Map();
  for (const user of users) {
    const stocks = await listUserStocks(user.username);
    stocks.forEach(row => map.set(row.ts_code, row));
  }
  return [...map.values()];
}

async function runStockAnalysisRefresh(reason = 'scheduled') {
  if (!(await tryClaimJob(JOB))) return { skipped: true, reason: 'locked' };
  const runId = await startJobRun(JOB);
  let ok = 0, failed = 0;
  try {
    const stocks = await trackedStocks();
    for (const stock of stocks) {
      try { await refreshStockAnalysis(stock.ts_code, reason); ok++; }
      catch (error) { failed++; console.warn(`[stock-analysis] ${stock.ts_code} 更新失败:`, error.message); }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await finishJobRun(runId, failed === 0, `成功 ${ok}，失败 ${failed}`);
    return { ok, failed };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally {
    await releaseJob(JOB);
  }
}

function scheduleStockAnalysisRefresh() {
  function scheduleNext() {
    const timer = setTimeout(async () => {
      try { await runStockAnalysisRefresh('daily-20:30'); }
      catch (error) { console.error('[stock-analysis] 每日更新失败:', error.message); }
      scheduleNext();
    }, nextShanghaiDelay());
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[stock-analysis] 已调度：每日 20:30（上海时间）');
}

module.exports = { nextShanghaiDelay, trackedStocks, runStockAnalysisRefresh, scheduleStockAnalysisRefresh };
