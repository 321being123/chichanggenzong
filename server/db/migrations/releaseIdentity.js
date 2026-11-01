// 182：Worker 心跳携带完整提交身份（验收 S-001）。
//
// 部署后要回答"这个 Worker 进程加载的是哪个提交"。app_version 相同不代表提交相同，
// 旧 Worker 可能还在跑旧代码。心跳新增 commit_sha，由部署脚本与目标提交交叉核对。
async function migration182WorkerHeartbeatCommit(pool, client = pool) {
  await client.query(`
    ALTER TABLE ops.worker_heartbeats ADD COLUMN IF NOT EXISTS commit_sha TEXT;
  `);
}

// 183：实源合同验证留证（验收 T-002/S-004，复验 RV-04）。
//
// 为什么单独一张表：来源熔断表（ops.external_circuits）的 last_success_at 会被"普通 HTTP 200"刷新，
// 用它当合同异常的恢复证据，等于任何一次请求成功都能关掉"接口返回结构变了"的告警。
// 合同恢复要求"同接口、同合同重新验证成功"，所以把每次抽样按 `contract_ok` 布尔落库，
// 恢复判定只认该接口（同 source + api_name）晚于告警时间的 contract_ok=true 记录。
async function migration183SourceContractVerifications(pool, client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ops.source_contract_verifications (
      verification_id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      api_name TEXT NOT NULL,
      status TEXT NOT NULL,
      contract_ok BOOLEAN NOT NULL DEFAULT false,
      detail TEXT,
      sample JSONB NOT NULL DEFAULT '{}'::jsonb,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_source_contract_verifications_scope
      ON ops.source_contract_verifications (source, api_name, checked_at DESC);
  `);
}

module.exports = { migration182WorkerHeartbeatCommit, migration183SourceContractVerifications };
