// ========== 港币→人民币汇率：每日自动更新 accounts.hk_rate ==========
// 背景：前端 refreshAllPrices 每次打开网页才调 /api/hkrate 抓取并写回 hk_rate，
//   若长期不开网页，港股持仓估值会沿用旧汇率（偏差有限但会过期）。本任务每日自动抓取最新汇率写回。
// 抓取源与 /api/hkrate 路由一致（open.er-api.com），fetchHkRate 为单点真相，两者共用。
const https = require('https');
const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { cnDate, upsertFxRate, syncLegacyAccountRates, getCurrentFxRate } = require('../services/fxRate');
const { withExternalCallGuard, openExternalCircuit } = require('../services/externalCallGuard');

// 抓取港币→人民币汇率（成功返回 number，失败返回 null）
// 数据源 open.er-api.com：免费、无需 key，返回 rates.CNY = 1 HKD 兑多少人民币（约 0.865）
async function fetchHkRate() {
  try {
      const text = await withExternalCallGuard('exchange-rate', 'HKD:CNY', process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
      https.get('https://open.er-api.com/v6/latest/HKD', { timeout: 8000 }, (resp) => {
        let data = ''; resp.on('data', c => data += c);
        resp.on('end', () => {
          if (resp.statusCode === 429) {
            const error = new Error('汇率接口 HTTP 429');
            error.code = 'RATE_LIMIT'; error.errorType = 'rate_limit'; error.source = 'exchange-rate';
            return reject(error);
          }
          if (resp.statusCode >= 500) {
            const error = new Error(`汇率接口 HTTP ${resp.statusCode}`);
            error.code = 'UPSTREAM_5XX'; error.errorType = 'network'; error.source = 'exchange-rate';
            return reject(error);
          }
          resolve(data);
        });
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    }));
    const json = JSON.parse(text);
    if (json && json.result === 'success' && json.rates && json.rates.CNY) {
      const rate = parseFloat(json.rates.CNY);
      if (!isNaN(rate) && rate > 0) return rate;
    }
  } catch (e) {
    // 本系统自己的 BUDGET_WAIT 只表示“暂时不该发起请求”，不能升级成来源熔断。
    // 只有真实上游限流/额度错误才写入熔断，并完整保留恢复时间和接口范围。
    if (e && e.errorType === 'rate_limit' && e.code !== 'BUDGET_WAIT') {
      await openExternalCircuit(e.source || 'exchange-rate', e.message, e.source || 'exchange-rate', {
        errorCode: e.code,
        errorType: e.errorType,
        recoverAt: e.recoverAt,
        apiName: e.apiName || '*',
        credentialProfile: e.credentialProfile || 'anonymous',
        tokenFingerprint: e.tokenFingerprint || 'none',
      }).catch(() => {});
    }
    if (e && e.code) throw e;
  }
  return null;
}

// 抓取最新汇率并更新所有账户（全量覆盖，幂等；抓取失败则不更新）
// hk_rate_updated_at 记录真实汇率更新时间（迁移 039），不随持仓保存/公开状态修改而更新
async function ensureHkRate() {
  const rate = await fetchHkRate();
  if (!rate) return { ok: false, rate: null };
  try {
    await upsertFxRate(rate, { rateDate: cnDate(new Date()), sourceId: 7 });
    const count = await syncLegacyAccountRates(rate);
    return { ok: true, rate: rate, count: count };
  } catch (e) {
    return { ok: false, rate: rate, error: e.message };
  }
}

// 带幂等锁与执行记录的每日汇率任务
async function runHkRateJob() {
  if (!(await tryClaimJob('hk_rate'))) return { ok: false, skipped: true };
  const runId = await startJobRun('hk_rate');
  let result = { ok: false, rate: null };
  try {
    const r = await ensureHkRate();
    result = r;
    await finishJobRun(runId, !!r.ok, r.ok ? ('汇率 ' + r.rate) : (r.error || '抓取失败'));
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
    result = { ok: false, rate: null, error: e.message || String(e), errorCode: e.code, errorType: e.errorType || e.type, source: e.source };
  } finally {
    await releaseJob('hk_rate');
  }
  return result;
}

module.exports = { fetchHkRate, ensureHkRate, runHkRateJob, getCurrentFxRate };
