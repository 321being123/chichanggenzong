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
      externalCallCount: Number(error && error.externalCalls || stats.total),
      externalSources: stats.sources,
    });
  }
});
