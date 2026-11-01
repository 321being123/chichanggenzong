// 182：Worker 心跳携带完整提交身份（验收 S-001）。
//
// 部署后要回答"这个 Worker 进程加载的是哪个提交"。app_version 相同不代表提交相同，
// 旧 Worker 可能还在跑旧代码。心跳新增 commit_sha，由部署脚本与目标提交交叉核对。
async function migration182WorkerHeartbeatCommit(pool, client = pool) {
  await client.query(`
    ALTER TABLE ops.worker_heartbeats ADD COLUMN IF NOT EXISTS commit_sha TEXT;
  `);
}

module.exports = { migration182WorkerHeartbeatCommit };
