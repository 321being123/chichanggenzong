// 任务恢复的中立证据层：调度器和告警层共用，避免只凭单一 data_as_of 把槽位误判为已完成。
const { pool } = require('../db/connection');
const { getJobDefinition } = require('./jobDefinitions');

async function verifySlotRecoveryEvidence(slot, query = (sql, params) => pool.query(sql, params), options = {}) {
  if (!slot || !slot.job_code || !['succeeded', 'degraded'].includes(options.candidateStatus || slot.status)) {
    return { recovered: false, reason: 'slot_not_successful', evidence: slot || null };
  }
  if (options.alertType && options.alertType !== 'dependency_blocked'
    && ['data_quality', 'dependency_blocked'].includes(String(options.alertType))) {
    return { recovered: false, reason: 'data_bound_alert_requires_dataset_evidence', evidence: slot };
  }
  const definition = getJobDefinition(slot.job_code);
  const { rows: runRows } = await query(
    `SELECT id,slot_id,status,result_json,attempt_no,trigger_type
       FROM job_runs WHERE slot_id=$1 ORDER BY id DESC LIMIT 1`, [slot.slot_id]
  );
  const run = runRows[0] || null;
  if (!run || run.status !== 'done' || (run.slot_id != null && String(run.slot_id) !== String(slot.slot_id))) {
    return { recovered: false, reason: 'successful_run_evidence_missing', evidence: { slot, run } };
  }
  const runResult = run.result_json && typeof run.result_json === 'object' ? run.result_json : {};
  if (runResult.ok === false || runResult.status === 'failed' || runResult.error) {
    return { recovered: false, reason: 'successful_run_result_failed', evidence: { slot, run } };
  }
  const summary = { ...(slot.result_summary && typeof slot.result_summary === 'object' ? slot.result_summary : {}), ...runResult };
  const failedDatasets = Array.isArray(summary.failedDatasets) ? summary.failedDatasets.filter(Boolean) : [];
  const pendingStages = Array.isArray(summary.pendingStages) ? summary.pendingStages.filter(Boolean) : [];
  if (summary.continuationRequired === true || pendingStages.length || failedDatasets.length) {
    return { recovered: false, reason: 'run_stages_incomplete', evidence: { slot, run, failedDatasets, pendingStages, continuationRequired: summary.continuationRequired === true } };
  }
  const datasets = definition.producesDatasets || [];
  const { expectedDataDate } = require('./jobScheduleSlots');
  const businessDate = slot.business_date instanceof Date
    ? slot.business_date.toISOString().slice(0, 10) : String(slot.business_date || '').slice(0, 10);
  const partitionKey = expectedDataDate(slot.job_code, businessDate) || businessDate;
  let datasetEvidence = [];
  if (definition.strictDatasetPublication && datasets.length && partitionKey) {
    const { rows } = await query(
      `SELECT dataset_code,status,is_stale,diagnostics
         FROM ops.dataset_partitions
        WHERE dataset_code=ANY($1::text[]) AND partition_key=$2::date`, [datasets, partitionKey]
    );
    const byCode = new Map(rows.map(row => [row.dataset_code, row]));
    datasetEvidence = datasets.map(code => byCode.get(code) || { dataset_code: code, status: 'missing' });
    const allPublished = datasetEvidence.every(row => {
      const diagnostics = row.diagnostics && typeof row.diagnostics === 'object' ? row.diagnostics : {};
      const qualityOk = !diagnostics.quality_status || diagnostics.quality_status === 'passed';
      const queryOk = !diagnostics.query_status || ['success', 'passed', 'verified'].includes(diagnostics.query_status);
      return row.status === 'published' && !row.is_stale && qualityOk && queryOk;
    });
    if (!allPublished) return { recovered: false, reason: 'strict_dataset_evidence_missing', evidence: { slot, datasets: datasetEvidence } };
  }
  if (definition.requiresDataWatermark !== false) {
    const actual = String(slot.data_as_of || summary.dataAsOf || summary.data_as_of || summary.trade_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(actual) || !/^\d{4}-\d{2}-\d{2}$/.test(partitionKey) || actual < partitionKey) {
      return { recovered: false, reason: 'watermark_evidence_missing', evidence: { slot, run, expectedDataAsOf: partitionKey, actualDataAsOf: actual || null } };
    }
  }
  const expectedMode = String(slot.request_payload && slot.request_payload.mode || 'core');
  if (summary.mode && String(summary.mode) !== expectedMode) {
    return { recovered: false, reason: 'run_mode_mismatch', evidence: { slot, run, expectedMode, actualMode: summary.mode } };
  }
  return { recovered: true, evidence: { mode: 'slot_success_and_dataset_evidence', slot, run, datasets: datasetEvidence, partitionKey } };
}

module.exports = { verifySlotRecoveryEvidence };
