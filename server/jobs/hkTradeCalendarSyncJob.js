const { syncHkTradeCalendar } = require('./hkTradeCalendarSync');
const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');

const JOB = 'hk_trade_calendar_sync';
let running = false;

async function runHkTradeCalendarSync(reason = 'scheduled', context = {}) {
  if (running) return { skipped: true, reason: 'already_running' };
  if (!(await tryClaimJob(JOB))) return { skipped: true, reason: 'already_running' };
  running = true;
  const runId = await startJobRun(JOB);
  try {
    const result = await syncHkTradeCalendar(context);
    await finishJobRun(runId, Boolean(result && result.ok), JSON.stringify(result || {}));
    console.log(`[hk-trade-calendar] ${reason} 港交所交易日历同步完成:`, result);
    return result;
  } catch (error) {
    await finishJobRun(runId, false, error.message || String(error));
    throw error;
  } finally {
    running = false;
    await releaseJob(JOB);
  }
}

module.exports = { runHkTradeCalendarSync };
