require('dotenv').config();

const { runJobByCode } = require('./jobRunners');
const { sanitizeJobError } = require('./jobErrorSanitizer');
const { getExternalCallStats } = require('./externalCallGuard');

function send(message) {
  if (typeof process.send === 'function') process.send(message, () => process.exit(message.ok ? 0 : 1));
  else process.exit(message.ok ? 0 : 1);
}

process.on('message', async message => {
  try {
    if (process.env.NODE_ENV === 'test' && message && message.jobCode === '__test_tushare_api_propagation') {
      const error = new Error('模拟 rt_min 业务限流');
      error.code = 'RATE_LIMIT';
      error.errorType = 'rate_limit';
      error.source = 'tushare';
      error.dataset = 'rt_min:test';
      error.apiName = 'rt_min';
      error.tokenFingerprint = 'test-fingerprint';
      error.recoverAt = '2026-08-20T00:00:01.000Z';
      throw error;
    }
    if (message.businessDate) process.env.JOB_BUSINESS_DATE = String(message.businessDate).slice(0, 10);
    const result = await runJobByCode(message.jobCode, message.reason, message.businessDate, message.context || {});
    const stats = getExternalCallStats();
    const normalized = result && typeof result === 'object'
      ? { ...result, externalCalls: Number(result.externalCalls || stats.total), externalSources: result.externalSources || stats.sources }
      : { ok: true, result, externalCalls: stats.total, externalSources: stats.sources };
    send({ ok: true, result: normalized });
  } catch (error) {
    const stats = getExternalCallStats();
    send({
      ok: false,
      error: sanitizeJobError(error && error.message || error),
      errorCode: error && error.code,
      errorType: error && error.errorType,
      retryable: error && error.retryable,
      source: error && error.source,
      dataset: error && error.dataset,
      apiName: error && error.apiName,
      tokenFingerprint: error && error.tokenFingerprint,
      recoverAt: error && error.recoverAt,
      dataDiagnostics: error && error.dataDiagnostics,
      externalCallCount: Number(error && error.externalCalls || stats.total),
      externalSources: stats.sources,
    });
  }
});
