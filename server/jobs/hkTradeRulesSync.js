// ========== 港股每手股数同步 job ==========
// 对应 docs/仓位对比功能_开发文档.md 9.2 节：
//   - 每个交易日执行一次增量检查（Tushare hk_basic 一次全量，幂等 upsert）
//   - 原始记录、同步批次、游标、数据质量问题走 ops 层
//   - 失败不覆盖上一份有效数据（表本身只插入新规则，不删旧记录）
const { syncHkTradeRules } = require('../services/tradeLot');
const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const JOB = 'hk_trade_rules_sync';

let running = false;

// 每交易日 20:30（上海时间）执行一次；启动时先跑一轮补齐
async function runHkTradeRulesSync(reason = 'scheduled') {
  if (running) return { skipped: true };
  if (!(await tryClaimJob(JOB))) return { skipped: true, reason: 'already_running' };
  running = true;
  const runId = await startJobRun(JOB);
  try {
    const result = await syncHkTradeRules();
    await finishJobRun(runId, true, JSON.stringify(result || {}));
    console.log(`[trade-rules] ${reason} 港股每手股数同步完成:`, result);
    return { ok: true, result };
  } catch (error) {
    await finishJobRun(runId, false, error.message || String(error));
    console.error('[trade-rules] 港股每手股数同步失败:', error.message);
    throw error;
  } finally {
    running = false;
    await releaseJob(JOB);
  }
}

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function nextDailyDelay(hour, minute, now = new Date()) {
  const p = shanghaiParts(now);
  const current = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + offset));
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue; // 跳过周末
    const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, 0);
    if (target > current) return target - current;
  }
  return 24 * 60 * 60 * 1000;
}

function scheduleHkTradeRulesSync() {
  function scheduleNext() {
    const delay = nextDailyDelay(20, 30);
    const timer = setTimeout(async () => {
      try { await runHkTradeRulesSync('weekday-20:30'); }
      catch (error) { /* 已记录，等下个周期 */ }
      scheduleNext();
    }, delay);
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[trade-rules] 已调度：工作日 20:30（上海时间）港股每手股数同步');
}

module.exports = { runHkTradeRulesSync, scheduleHkTradeRulesSync, nextDailyDelay };
