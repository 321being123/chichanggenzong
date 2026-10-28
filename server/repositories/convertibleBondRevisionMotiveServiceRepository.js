const crypto = require('crypto');

// 自 server/services/convertibleBondRevisionMotiveService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const CYCLE_VERSION = 'cycle-v1';

async function saveRevisionCycles(client, instrumentId, cycles, termId) {
  await client.query('DELETE FROM analytics.convertible_bond_revision_cycles WHERE instrument_id=$1 AND cycle_version=$2', [instrumentId, CYCLE_VERSION]);
  for (const row of cycles || []) {
    await client.query(
      `INSERT INTO analytics.convertible_bond_revision_cycles
       (instrument_id,cycle_no,cycle_start_date,first_match_date,trigger_date,proposal_date,decision_date,cycle_end_date,implementation_date,outcome,short_label,proposal_type,no_revision,lock_until,term_id,cycle_version,evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
       ON CONFLICT(instrument_id,cycle_no,cycle_version) DO UPDATE SET cycle_start_date=EXCLUDED.cycle_start_date,
         first_match_date=EXCLUDED.first_match_date,trigger_date=EXCLUDED.trigger_date,proposal_date=EXCLUDED.proposal_date,decision_date=EXCLUDED.decision_date,
         cycle_end_date=EXCLUDED.cycle_end_date,implementation_date=EXCLUDED.implementation_date,outcome=EXCLUDED.outcome,short_label=EXCLUDED.short_label,
         proposal_type=EXCLUDED.proposal_type,no_revision=EXCLUDED.no_revision,lock_until=EXCLUDED.lock_until,term_id=EXCLUDED.term_id,evidence=EXCLUDED.evidence,calculated_at=now()` ,
      [instrumentId, row.cycle_no, row.cycle_start_date, row.first_match_date, row.trigger_date, row.proposal_date, row.decision_date, row.cycle_end_date,
        row.implementation_date, row.outcome, row.short_label, row.proposal_type, row.no_revision, row.lock_until, termId, CYCLE_VERSION, JSON.stringify(row.evidence)]
    );
  }
  return cycles.length;
}

async function saveSyncCursor(client, { instrumentId = null, companyId = null, scopeKey, datasetCode, successDate = null, error = '' }) {
  await client.query(
    `INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_attempt_at,last_error,retry_count,updated_at)
     VALUES($1,$2,$3,$4,$5::date,now(),$6,CASE WHEN $6='' THEN 0 ELSE 1 END,now())
     ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
       instrument_id=COALESCE(EXCLUDED.instrument_id,ops.sync_cursors.instrument_id),
       company_id=COALESCE(EXCLUDED.company_id,ops.sync_cursors.company_id),
       last_success_date=CASE WHEN EXCLUDED.last_success_date IS NULL THEN ops.sync_cursors.last_success_date
                              ELSE GREATEST(COALESCE(ops.sync_cursors.last_success_date,'1900-01-01'::date),EXCLUDED.last_success_date) END,
       last_attempt_at=now(),last_error=EXCLUDED.last_error,
       retry_count=CASE WHEN EXCLUDED.last_error='' THEN 0 ELSE ops.sync_cursors.retry_count+1 END,updated_at=now()`,
    [instrumentId, companyId, scopeKey, datasetCode, successDate, error]
  );
}

async function saveSyncRawPayload(client, sourceId, datasetCode, sourceKey, businessDate, rows) {
  if (!sourceId || !Array.isArray(rows) || !rows.length) return null;
  const payload = JSON.stringify({ business_date: businessDate, rows });
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const { rows: saved } = await client.query(
    `INSERT INTO ops.raw_records(source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
     VALUES($1,$2,$3,$4::date,$5::jsonb,$6)
     ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING
     RETURNING raw_record_id`,
    [sourceId, datasetCode, sourceKey, businessDate, payload, payloadHash]
  );
  return saved[0] && saved[0].raw_record_id || null;
}

module.exports = {
  saveRevisionCycles,
  saveSyncCursor,
  saveSyncRawPayload,
};
