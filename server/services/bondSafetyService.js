const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { evaluateBondSafety } = require('./bondSafety');
const { fetchBondSafetySource, isConfigured } = require('./bondSafetyFetcher');

const JOB_NAME = 'bond_safety_refresh';

async function getLatestSnapshot() {
  const { rows } = await pool.query(
    `SELECT id, refreshed_at, source_updated_at, row_count, data, diagnostics, refresh_reason
       FROM bond_safety_snapshots ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function saveSnapshot(result, sourceUpdatedAt, reason) {
  const { rows } = await pool.query(
    `INSERT INTO bond_safety_snapshots
       (source_updated_at, row_count, data, diagnostics, refresh_reason)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
     RETURNING id, refreshed_at, source_updated_at, row_count, data, diagnostics, refresh_reason`,
    [sourceUpdatedAt || null, result.data.length, JSON.stringify(result.data), JSON.stringify(result.diagnostics), reason]
  );
  // MVP 只保留最近 30 次成功快照；失败不会覆盖最后成功数据。
  await pool.query(
    `DELETE FROM bond_safety_snapshots WHERE id NOT IN
       (SELECT id FROM bond_safety_snapshots ORDER BY id DESC LIMIT 30)`
  );
  return rows[0];
}

async function refreshBondSafety(reason = 'manual') {
  const claimed = await tryClaimJob(JOB_NAME);
  if (!claimed) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun(JOB_NAME);
  try {
    const source = await fetchBondSafetySource();
    if (!source.companyRows.length || !source.bondRows.length) {
      throw new Error('数据源返回空数据，已保留上一份有效快照');
    }
    const result = evaluateBondSafety(source.companyRows, source.bondRows);
    const snapshot = await saveSnapshot(result, source.sourceUpdatedAt, reason);
    await finishJobRun(runId, true, `刷新 ${snapshot.row_count} 条；未匹配 ${result.diagnostics.unmatched_stock_count} 条`);
    return { skipped: false, snapshot };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally {
    await releaseJob(JOB_NAME);
  }
}

module.exports = { getLatestSnapshot, refreshBondSafety, isConfigured };
