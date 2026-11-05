// 188：导入批次的幂等约束按"仍然有效"区分（F03）。
//
// 背景：`nav_import_batches` 的内容唯一索引此前覆盖所有状态，而幂等判定只按 input_hash 命中，
// 不读 status。回滚会把批次改成 rolled_back，于是同一份文件用新批次号重导时：
//   ① 幂等判定命中旧批次 → 200 直接返回，一行净值都没写；
//   ② 即使绕过 ①，新批次插入也会撞旧唯一索引。
// 修法是把唯一性收窄到"仍然有效的提交记录"（status <> 'rolled_back'），
// 已回滚批次保留作审计历史，不再占住内容指纹。
//
// 存量安全：旧索引对所有状态都唯一，因此 (username, account_name, input_hash) 至多一行，
// 新建部分索引必然不会因重复而失败，无需删除任何历史行。
async function migration188NavImportActiveContent(pool) {
  await pool.query('DROP INDEX IF EXISTS uq_nav_import_content');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_nav_import_active_content
      ON nav_import_batches(username, account_name, input_hash)
   WHERE status <> 'rolled_back'
  `);
  // 批次号是全局主键：按 ID 反查归属要在任何写业务数据之前完成，补一条覆盖索引。
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_nav_import_batches_id_owner
      ON nav_import_batches(id, username, account_name)
  `);
  // 快照删除必须带账户范围（F01）：补一条 (snapshot_id, username, account_name) 的删除索引。
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_nav_position_snapshots_owner
      ON nav_position_snapshots(snapshot_id, username, account_name)
  `);
}

module.exports = { migration188NavImportActiveContent };
