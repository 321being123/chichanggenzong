require('dotenv').config();

const { runJobByCode } = require('./jobRunners');
const { getJobDefinition, externalCallLimitForMode } = require('./jobDefinitions');
const { sanitizeJobError } = require('./jobErrorSanitizer');
const { getExternalCallStats, setExternalCallCount, setSlotExternalCallBudget } = require('./externalCallGuard');
const { publishJobDatasets } = require('./datasetPartitionRegistry');
const { expectedDataDate } = require('./jobScheduleSlots');

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
    // 任务契约中的 maxExternalCallsPerRun 必须在运行时生效；0 表示禁止外部请求，null 表示不设本任务级上限。
    const definition = getJobDefinition(message.jobCode);
    const mode = String(message.context && message.context.mode || 'core');
    // 每次续批从 0 统计本次请求；槽位累计量单独传入，避免跨批把单次上限误当总量。
    setExternalCallCount(message.context && message.context.attemptExternalCallCount || 0);
    setSlotExternalCallBudget(
      message.context && message.context.slotExternalCallsTotal,
      message.context && message.context.slotExternalCallsLimit
    );
    const externalCallLimit = externalCallLimitForMode(definition, mode);
    if (externalCallLimit === null) {
      delete process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE;
      delete process.env.JOB_EXTERNAL_CALL_LIMIT;
    } else {
      process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE = '1';
      process.env.JOB_EXTERNAL_CALL_LIMIT = String(externalCallLimit);
    }
    process.env.JOB_SLOT_EXTERNAL_CALL_USED = String(Number(message.context && message.context.slotExternalCallsTotal || 0));
    process.env.JOB_SLOT_EXTERNAL_CALL_LIMIT = String(Number(message.context && message.context.slotExternalCallsLimit || 0));
    const result = await runJobByCode(message.jobCode, message.reason, message.businessDate, message.context || {});
    const declaredPartition = result && (result.partitionKey || result.partition_key);
    const partitionDate = String(declaredPartition || expectedDataDate(message.jobCode, message.businessDate) || message.businessDate || '').slice(0, 10);
    // partition_key 表示业务分区，data_as_of 由结果水位单独保存；未来覆盖日不得替代业务日。
    const datasetPublications = await publishJobDatasets(message.jobCode, partitionDate, result);
    const stats = getExternalCallStats();
    const normalized = result && typeof result === 'object'
      ? { ...result, datasets: result.datasets || datasetPublications,
        attemptExternalCalls: Number(result.attemptExternalCalls ?? result.externalCalls ?? stats.total),
        externalCalls: Number(result.attemptExternalCalls ?? result.externalCalls ?? stats.total), externalSources: result.externalSources || stats.sources }
      : { ok: true, result, datasets: datasetPublications, attemptExternalCalls: stats.total, externalCalls: stats.total, externalSources: stats.sources };
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
      credentialProfile: error && error.credentialProfile,
      budgetWindow: error && error.budgetWindow,
      recoverAt: error && error.recoverAt,
      dataDiagnostics: error && error.dataDiagnostics,
      externalCallCount: Number(errorExternalCalls ?? stats.total),
      externalSources: error && error.externalSources || stats.sources,
    });
  }
});
