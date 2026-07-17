const { getLatestSnapshot, refreshBondSafety, isConfigured } = require('../services/bondSafetyService');

function nextShanghaiDelay(hour = 6, minute = 30, now = new Date()) {
  const shanghai = new Date(now.getTime() + 8 * 3600 * 1000);
  let target = Date.UTC(
    shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate(),
    hour - 8, minute, 0, 0
  );
  if (target <= now.getTime()) target += 24 * 3600 * 1000;
  return target - now.getTime();
}

async function runBondSafetyRefresh(reason = 'scheduled') {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' };
  try {
    return await refreshBondSafety(reason);
  } catch (error) {
    console.error('[bond-safety] 定时刷新失败，保留上一份有效数据:', error.message);
    return { skipped: true, reason: 'failed' };
  }
}

function scheduleBondSafetyRefresh() {
  async function runAndReschedule() {
    await runBondSafetyRefresh('scheduled');
    const timer = setTimeout(runAndReschedule, nextShanghaiDelay());
    if (timer.unref) timer.unref();
  }
  const initial = setTimeout(runAndReschedule, nextShanghaiDelay());
  if (initial.unref) initial.unref();

  // 首次部署且尚无快照时立即补一次；已有数据时不在每次重启时打上游 API。
  getLatestSnapshot()
    .then(snapshot => { if (!snapshot) return runBondSafetyRefresh('bootstrap'); })
    .catch(error => console.warn('[bond-safety] 启动检查失败:', error.message));
}

module.exports = { nextShanghaiDelay, runBondSafetyRefresh, scheduleBondSafetyRefresh };
