// ========== 港币→人民币汇率：每日自动更新 accounts.hk_rate ==========
// 背景：前端 refreshAllPrices 每次打开网页才调 /api/hkrate 抓取并写回 hk_rate，
//   若长期不开网页，港股持仓估值会沿用旧汇率（偏差有限但会过期）。本任务每日自动抓取最新汇率写回。
// 抓取源与 /api/hkrate 路由一致（qt.gtimg.cn），fetchHkRate 为单点真相，两者共用。
const https = require('https');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');

// 抓取港币→人民币汇率（成功返回 number，失败返回 null）
async function fetchHkRate() {
  try {
    const text = await new Promise((resolve, reject) => {
      https.get('https://qt.gtimg.cn/q=szhkdcny', { timeout: 6000 }, (resp) => {
        let data = ''; resp.on('data', c => data += c);
        resp.on('end', () => resolve(data));
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    });
    const match = text.match(/"(.*)"/);
    if (match) {
      const parts = match[1].split('~');
      const rate = parseFloat(parts[3]);
      if (!isNaN(rate) && rate > 0) return rate;
    }
  } catch (e) {}
  return null;
}

// 抓取最新汇率并更新所有账户（全量覆盖，幂等；抓取失败则不更新）
async function ensureHkRate() {
  const rate = await fetchHkRate();
  if (!rate) return { ok: false, rate: null };
  try {
    const r = await pool.query(
      "UPDATE accounts SET hk_rate=$1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')",
      [rate]
    );
    return { ok: true, rate: rate, count: r.rowCount };
  } catch (e) {
    return { ok: false, rate: rate, error: e.message };
  }
}

// 带幂等锁与执行记录的每日汇率任务
async function runHkRateJob() {
  if (!(await tryClaimJob('hk_rate'))) return;
  const runId = await startJobRun('hk_rate');
  try {
    const r = await ensureHkRate();
    await finishJobRun(runId, !!r.ok, r.ok ? ('汇率 ' + r.rate) : (r.error || '抓取失败'));
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
  } finally {
    await releaseJob('hk_rate');
  }
}

module.exports = { fetchHkRate, ensureHkRate, runHkRateJob };
