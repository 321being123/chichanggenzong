const path = require('path');
const { execFile } = require('child_process');
const { pool } = require('../db/connection');
const { syncConvertibleBondUniverse, syncConvertibleBondUniverseWithBackfill } = require('../services/convertibleBondAnalysis');

// 每日估值+预警：在行情/周期同步完成后串行执行（方案 §顺序：行情→周期→估值→预警）
function runDailyValuation() {
  return new Promise((resolve) => {
    const root = path.join(__dirname, '..', '..');
    const script = path.join(root, 'server', 'scripts', 'convertibleBondValuation.py');
    const py = process.env.VALUATION_PYTHON || path.join(root, 'venv', 'Scripts', 'python.exe');
    execFile(py, [script, 'refresh'], { cwd: root, timeout: 15 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[bond-valuation] 每日估值失败:', String(stderr || err.message).trim().split('\n').slice(-3).join(' | '));
      } else {
        console.log('[bond-valuation] 每日估值完成:', String(stdout || '').trim().split('\n').slice(-1)[0] || 'ok');
      }
      resolve();
    });
  });
}

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
      let syncOk = true;
      try { await syncConvertibleBondUniverseWithBackfill('daily_incremental'); }
      catch (error) { syncOk = false; console.error('[bond-analysis] 每日增量同步失败:', error.message); }
      if (syncOk) await runDailyValuation(); // 行情/周期成功后才推估值+预警，避免用旧行情估值
      scheduleNext();
    }, nextShanghaiDelay());
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[bond-analysis] 已调度：每日 16:40（上海时间）');
}

module.exports = { nextShanghaiDelay, bootstrapConvertibleBonds, scheduleConvertibleBondRefresh };
