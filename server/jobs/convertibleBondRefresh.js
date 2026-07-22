const { pool } = require('../db/connection');
const { syncConvertibleBondUniverse } = require('../services/convertibleBondAnalysis');

function nextShanghaiDelay(hour = 16, minute = 40, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
  const current = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  let target = Date.UTC(+p.year, +p.month - 1, +p.day, hour, minute, 0);
  if (target <= current) target += 24 * 3600 * 1000;
  return target - current;
}

async function bootstrapConvertibleBonds() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM fundamental.convertible_bond_profiles');
  if (rows[0].count > 0) return { skipped: true, reason: 'already_initialized' };
  return syncConvertibleBondUniverse('first_full_sync');
}

function scheduleConvertibleBondRefresh() {
  bootstrapConvertibleBonds().catch(error => console.error('[bond-analysis] 首次全量同步失败:', error.message));
  function scheduleNext() {
    const timer = setTimeout(async () => {
      try { await syncConvertibleBondUniverse('daily_incremental'); }
      catch (error) { console.error('[bond-analysis] 每日增量同步失败:', error.message); }
      scheduleNext();
    }, nextShanghaiDelay());
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[bond-analysis] 已调度：每日 16:40（上海时间）');
}

module.exports = { nextShanghaiDelay, bootstrapConvertibleBonds, scheduleConvertibleBondRefresh };
