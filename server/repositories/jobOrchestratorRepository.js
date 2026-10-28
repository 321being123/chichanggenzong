const { pool } = require('../db/connection');

// 自 server/services/jobOrchestrator.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function readRunStatus(runId) {
  if (!runId) return null;
  const { rows } = await pool.query('SELECT id, status, detail FROM job_runs WHERE id=$1', [runId]);
  return rows[0] || null;
}

module.exports = {
  readRunStatus,
};
