const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const arbitrageService = require('../services/arbitrageService');
const { sanitizeJobError } = require('../services/jobErrorSanitizer');

const JOB_CODE = 'arbitrage_reparse';

async function runArbitrageReparse(caseId, reason = 'manual-retry') {
  // job_runs 以 job_code 关联计划实例；全局串行可避免多 Worker 同时解析不同事件时误关联运行记录。
  const lockKey = JOB_CODE;
  if (!(await tryClaimJob(lockKey))) return { skipped: true, reason: 'already_running' };
  let runId = null;
  try {
    runId = await startJobRun(JOB_CODE);
    const result = await arbitrageService.reparseCase(caseId);
    if (!result) {
      const error = `未找到套利事件 ${caseId}`;
      await finishJobRun(runId, false, error);
      return { ok: false, error, caseId };
    }
    if (result.status === 'failed') {
      const error = sanitizeJobError(result.message || '公告重新解析失败', 1000);
      await finishJobRun(runId, false, error);
      return { ok: false, error, caseId, result };
    }
    await finishJobRun(runId, true, result.message || `套利事件 ${caseId} 重新解析完成`);
    return { ok: true, caseId, reason, result };
  } catch (error) {
    const safeError = sanitizeJobError(error.message || error, 1000);
    await finishJobRun(runId, false, safeError);
    return { ok: false, error: safeError, caseId };
  } finally {
    await releaseJob(lockKey);
  }
}

module.exports = { runArbitrageReparse };
