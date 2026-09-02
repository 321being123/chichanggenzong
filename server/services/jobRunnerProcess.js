require('dotenv').config();

const { runJobByCode } = require('./jobRunners');
const { getJobDefinition, externalCallLimitForMode } = require('./jobDefinitions');
const { sanitizeJobError } = require('./jobErrorSanitizer');
const { getExternalCallStats, setExternalCallCount } = require('./externalCallGuard');
const { publishJobDatasets } = require('./datasetPartitionRegistry');

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
    // 任务契约中的 maxExternalCallsPerRun 必须在运行时生效；0 表示该任务禁止任何外部请求。
    const definition = getJobDefinition(message.jobCode);
    const mode = String(message.context && message.context.mode || 'core');
    setExternalCallCount(message.context && message.context.externalCallCount);
    process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE = '1';
    process.env.JOB_EXTERNAL_CALL_LIMIT = String(externalCallLimitForMode(definition, mode));
    const result = await runJobByCode(message.jobCode, message.reason, message.businessDate, message.context || {});
    // 非核心任务统一登记最新数据分区；登记失败只记录，不影响已成功的业务任务。
    const datasetPublications = await publishJobDatasets(message.jobCode, message.businessDate, result);
    const stats = getExternalCallStats();
    const normalized = result && typeof result === 'object'
      ? { ...result, datasets: result.datasets || datasetPublications, externalCalls: Number(result.externalCalls || stats.total), externalSources: result.externalSources || stats.sources }
      : { ok: true, result, datasets: datasetPublications, externalCalls: stats.total, externalSources: stats.sources };
    send({ ok: true, result: normalized });
  } catch (error) {
    const stats = getExternalCallStats();
    const errorExternalCalls = error && (error.externalCalls ?? error.externalCallCount);
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
      externalCallCount: Number(errorExternalCalls ?? stats.total),
      externalSources: error && error.externalSources || stats.sources,
    });
  }
});
