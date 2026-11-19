// 206：槽位重试计数分账（2026-11-18 盘后数据就绪与告警收敛方案 P0-1）。
//
// 现役 attempt_count 在领取时 +1、在外部等待/续批释放时 -1，只能表示"当前重试周期内的净次数"：
// 既无法表示总领取（租约被回收后再领取会重复计数），也无法把"等待上游就绪"和"真实执行失败"
// 分开，于是 DATASET_LOCKED 这类零外采的锁等待会白占失败预算。
//
// 这里拆成两列：
//   claim_count：每次成功领取 +1，不随释放回退，供领取序号/审计（job_runs.attempt_no 的来源）；
//   fail_count ：仅真实执行失败 +1，等待释放与续批不扣减。
//
// 存量兼容边界（本轮验收要求）：
//   旧 attempt_count 混有"领取 +1"和"等待豁免 -1"，不能同时充当历史领取数与真实失败数。
//   因此**不把旧值复制到新列**，改用 retry_contract 显式标记：
//     legacy  —— 迁移瞬间未终结的存量槽，继续用 attempt_count 判定，不切入新合同、不重开；
//     counters —— 迁移之后新建的槽，按 claim_count/fail_count 判定。
//   人工重试（retryJobSlot）会把 legacy 槽显式切到 counters，作为"定向确认"，不做隐式回退。
async function migration206JobSlotRetryCounters(pool) {
  await pool.query(`
    ALTER TABLE ops.job_schedule_slots ADD COLUMN IF NOT EXISTS claim_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ops.job_schedule_slots ADD COLUMN IF NOT EXISTS fail_count  INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ops.job_schedule_slots ADD COLUMN IF NOT EXISTS retry_contract TEXT NOT NULL DEFAULT 'counters';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='job_schedule_slots_retry_contract_check'
      ) THEN
        ALTER TABLE ops.job_schedule_slots
          ADD CONSTRAINT job_schedule_slots_retry_contract_check
          CHECK (retry_contract IN ('counters','legacy'));
      END IF;
    END $$;

    -- 只标记迁移瞬间"未终结"的槽：已终结的槽不再参与领取资格判定，标记没有意义。
    -- 这里不写 claim_count/fail_count，避免用混合旧计数推导历史。
    UPDATE ops.job_schedule_slots
       SET retry_contract = 'legacy'
     WHERE status IN ('pending','running','failed','blocked','degraded','waiting_external');

    -- 等待状态扩展：waiting_readiness 承载发布/锁/依赖类等待，与既有 waiting_external
    -- （外部接口保护等待）分开，避免两类等待共用失败预算和恢复条件。
    ALTER TABLE ops.job_schedule_slots DROP CONSTRAINT IF EXISTS job_schedule_slots_status_check;
    ALTER TABLE ops.job_schedule_slots
      ADD CONSTRAINT job_schedule_slots_status_check
      CHECK (status IN ('pending','running','succeeded','degraded','failed','blocked','skipped','waiting_external','waiting_readiness'));
  `);
}

module.exports = { migration206JobSlotRetryCounters };
