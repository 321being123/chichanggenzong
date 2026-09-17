// ========== 港币→人民币汇率：盘中实时、收盘最终值 ==========
// 盘中使用 Yahoo Finance 的 HKDCNY=X 快照，数据库按 5 分钟去重；收盘任务强制再抓一次。
// open.er-api.com 仍作为收盘实时源失败时的每日汇率兜底。
const https = require('https');
const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { cnDate, validRate, upsertFxRate, syncLegacyAccountRates, getCurrentFxRate, getCurrentFxRateSnapshot } = require('../services/fxRate');
const { isCnHoliday } = require('../config/holidays');
const { withExternalCallGuard, openExternalCircuit, ExternalCallGuardError } = require('../services/externalCallGuard');

const FRESH_RATE_MS = 24 * 60 * 60 * 1000;
const REALTIME_RATE_MAX_AGE_MS = 5 * 60 * 1000;
const REALTIME_API_NAME = 'exchange_rate_realtime';

function structuredRateError(error, fallbackCode = 'EXCHANGE_RATE_FETCH_FAILED', fallbackType = 'network', apiName = 'exchange_rate') {
  if (error && error.code) return error;
  const wrapped = new ExternalCallGuardError(
    fallbackCode,
    error && error.message ? error.message : String(error || '港币汇率抓取失败'),
    'exchange-rate',
    'HKD:CNY',
    { apiName, credentialProfile: 'anonymous', tokenFingerprint: 'none' }
  );
  wrapped.errorType = fallbackType;
  wrapped.retryable = true;
  return wrapped;
}

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
    }), { apiName: 'exchange_rate', credentialProfile: 'anonymous', tokenFingerprint: 'none' });
    let json;
    try { json = JSON.parse(text); }
    catch (error) { throw structuredRateError(error, 'INVALID_RESPONSE', 'parse'); }
    if (json && json.result === 'success' && json.rates && json.rates.CNY) {
      const rate = parseFloat(json.rates.CNY);
      if (!isNaN(rate) && rate > 0) return rate;
    }
    throw structuredRateError(new Error('汇率接口响应缺少有效 CNY 汇率'), 'INVALID_RESPONSE', 'parse');
  } catch (e) {
    // 本系统自己的 BUDGET_WAIT 只表示“暂时不该发起请求”，不能升级成来源熔断。
    // 只有真实上游限流/额度错误才写入熔断，并完整保留恢复时间和接口范围。
    if (e && e.errorType === 'rate_limit' && e.code !== 'BUDGET_WAIT') {
      await openExternalCircuit(e.source || 'exchange-rate', e.message, e.source || 'exchange-rate', {
        errorCode: e.code,
        errorType: e.errorType,
        recoverAt: e.recoverAt,
        apiName: e.apiName || 'exchange_rate',
        credentialProfile: e.credentialProfile || 'anonymous',
        tokenFingerprint: e.tokenFingerprint || 'none',
      }).catch(() => {});
    }
    throw structuredRateError(e);
  }
}

// 抓取盘中港币→人民币汇率。该接口返回最近的 1 分钟报价，数据库和 Guard 共同限制为 5 分钟一次。
async function fetchRealtimeHkRate() {
  try {
    const text = await withExternalCallGuard('exchange-rate', 'HKD:CNY', process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
      https.get('https://query1.finance.yahoo.com/v8/finance/chart/HKDCNY=X?interval=1m&range=1d', {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }, (resp) => {
        let data = ''; resp.on('data', c => data += c);
        resp.on('end', () => {
          if (resp.statusCode === 429) {
            const error = new Error('实时汇率接口 HTTP 429');
            error.code = 'RATE_LIMIT'; error.errorType = 'rate_limit'; error.source = 'exchange-rate'; error.apiName = REALTIME_API_NAME;
            return reject(error);
          }
          if (resp.statusCode >= 400) {
            const error = new Error(`实时汇率接口 HTTP ${resp.statusCode}`);
            error.code = resp.statusCode >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_4XX';
            error.errorType = 'network'; error.source = 'exchange-rate'; error.apiName = REALTIME_API_NAME;
            return reject(error);
          }
          resolve(data);
        });
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('realtime timeout')); });
    }), { apiName: REALTIME_API_NAME, credentialProfile: 'anonymous', tokenFingerprint: 'none' });
    let json;
    try { json = JSON.parse(text); }
    catch (error) { throw structuredRateError(error, 'INVALID_RESPONSE', 'parse', REALTIME_API_NAME); }
    const result = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
    const metaRate = result && result.meta ? Number(result.meta.regularMarketPrice) : NaN;
    const closes = result && result.indicators && result.indicators.quote && result.indicators.quote[0]
      ? result.indicators.quote[0].close : [];
    const lastClose = Array.isArray(closes) ? Number(closes.filter(v => v != null).slice(-1)[0]) : NaN;
    const rate = validRate(metaRate) || validRate(lastClose);
    if (rate) return rate;
    throw structuredRateError(new Error('实时汇率接口响应缺少有效 HKD/CNY 汇率'), 'INVALID_RESPONSE', 'parse', REALTIME_API_NAME);
  } catch (e) {
    if (e && e.errorType === 'rate_limit' && e.code !== 'BUDGET_WAIT') {
      await openExternalCircuit(e.source || 'exchange-rate', e.message, e.source || 'exchange-rate', {
        errorCode: e.code,
        errorType: e.errorType,
        recoverAt: e.recoverAt,
        apiName: e.apiName || REALTIME_API_NAME,
        credentialProfile: e.credentialProfile || 'anonymous',
        tokenFingerprint: e.tokenFingerprint || 'none',
      }).catch(() => {});
    }
    throw structuredRateError(e, 'EXCHANGE_RATE_REALTIME_FETCH_FAILED', 'network', REALTIME_API_NAME);
  }
}

function shanghaiClockNumber(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(value);
  const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return Number(p.hour) * 100 + Number(p.minute);
}

function isHkTradingTime(value = new Date()) {
  const date = cnDate(value);
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6 || isCnHoliday(date)) return false;
  const clock = shanghaiClockNumber(value);
  return (clock >= 930 && clock < 1200) || (clock >= 1300 && clock < 1600);
}

async function persistHkRate(rate) {
  try {
    await upsertFxRate(rate, { rateDate: cnDate(new Date()), sourceId: 7 });
    const saved = await getCurrentFxRateSnapshot();
    const count = await syncLegacyAccountRates(rate);
    return { ok: true, rate, rateDate: saved && saved.rateDate, fetchedAt: saved && saved.fetchedAt, count };
  } catch (e) { throw structuredRateError(e, 'EXCHANGE_RATE_STORE_FAILED', 'database'); }
}

// 抓取最新汇率并更新所有账户（全量覆盖，幂等；抓取失败则不更新）
// hk_rate_updated_at 记录真实汇率更新时间（迁移 039），不随持仓保存/公开状态修改而更新
async function ensureHkRate({ force = false } = {}) {
  const snapshot = await getCurrentFxRateSnapshot();
  const fetchedAt = snapshot && snapshot.fetchedAt ? new Date(snapshot.fetchedAt).getTime() : NaN;
  const age = Date.now() - fetchedAt;
  if (!force && snapshot && Number.isFinite(fetchedAt) && age >= 0 && age < FRESH_RATE_MS) {
    return { ok: true, status: 'fresh', reason: 'fresh', rate: snapshot.rate, rateDate: snapshot.rateDate, fetchedAt: snapshot.fetchedAt, externalCalls: 0 };
  }
  const rate = await fetchHkRate();
  return persistHkRate(rate);
}

// 盘中/收盘实时路径：同一自然日内 5 分钟内直接复用已落库快照，避免每个页面请求都打外部接口。
async function ensureRealtimeHkRate({ force = false } = {}) {
  const snapshot = await getCurrentFxRateSnapshot();
  const fetchedAt = snapshot && snapshot.fetchedAt ? new Date(snapshot.fetchedAt).getTime() : NaN;
  const age = Date.now() - fetchedAt;
  const today = cnDate(new Date());
  if (!force && snapshot && snapshot.rateDate === today && Number.isFinite(fetchedAt) && age >= 0 && age < REALTIME_RATE_MAX_AGE_MS) {
    return { ok: true, status: 'fresh', reason: 'realtime_cache', rate: snapshot.rate, rateDate: snapshot.rateDate, fetchedAt: snapshot.fetchedAt, externalCalls: 0 };
  }
  const rate = await fetchRealtimeHkRate();
  const saved = await persistHkRate(rate);
  return { ...saved, status: 'realtime', externalCalls: 1 };
}

// 带幂等锁与执行记录的汇率任务；只有收盘调用才强制取当天最终值。
async function runHkRateJob({ final = false } = {}) {
  if (!(await tryClaimJob('hk_rate'))) return { ok: false, skipped: true };
  const runId = await startJobRun('hk_rate');
  let result = { ok: false, rate: null };
  try {
    let r;
    if (final) {
      try {
        // 收盘任务不走 24 小时新鲜度短路，必须再取一次当天最终汇率。
        r = await ensureRealtimeHkRate({ force: true });
      } catch (realtimeError) {
        // 实时源临时不可用时保留原有每日源兜底，不能因为新源故障清空当天汇率。
        r = await ensureHkRate({ force: true });
        r.fallback = 'daily_exchange_rate';
        r.realtimeError = realtimeError && realtimeError.message;
      }
    } else {
      // Web/Worker 启动补漏只沿用 24 小时门禁，不在交易时段额外触发收盘抓取。
      r = await ensureHkRate();
    }
    result = r;
    await finishJobRun(runId, !!r.ok, r.ok ? ('汇率 ' + r.rate) : (r.error || '抓取失败'));
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
    result = {
      ok: false, rate: null, error: e.message || String(e), errorCode: e.code,
      errorType: e.errorType || e.type, source: e.source, apiName: e.apiName,
      recoverAt: e.recoverAt, tokenFingerprint: e.tokenFingerprint,
      credentialProfile: e.credentialProfile, budgetWindow: e.budgetWindow,
    };
  } finally {
    await releaseJob('hk_rate');
  }
  return result;
}

module.exports = {
  fetchHkRate,
  fetchRealtimeHkRate,
  ensureHkRate,
  ensureRealtimeHkRate,
  isHkTradingTime,
  runHkRateJob,
  getCurrentFxRate,
};
