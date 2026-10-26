// 176：补齐账户级表的不可变 account_id，收敛"用账户名做业务键"的过渡设计。
//
// 背景（2026-10-26 线上告警）：迁移 047 已确立"所有账户子表持有指向 accounts.id 的不可变
// account_id，账户重命名不再影响子表关联"的架构。但 047 只覆盖了当时的 6 张表，之后新增的
// nav_position_snapshots / nav_import_batches / index_baseline_settled / 两张 analytics 设置表
// 和 account_data 都没有 account_id，只能靠账户名关联；改名功能又用一份手写表清单，漏掉这些表，
// 导致导入持仓锚点按新名查不到，净值投影链从改名前一日断开并触发后台告警。
//
// 本迁移只做纯增量：补列、按现有 account_name 回填、加 NOT VALID 外键（与 047 一致，存量孤立行不阻断）。
// 不改写任何业务数据，不删除任何行，可作为后续"按 account_id 收敛查询"的基础。
const ACCOUNT_ID_TABLES = [
  'public.account_data',
  'public.index_baseline_settled',
  'public.nav_import_batches',
  'public.nav_position_snapshots',
  'analytics.graham_strategy_settings',
  'analytics.market_cycle_strategy_settings',
];

async function migration176AccountIdCompletion(pool) {
  for (const table of ACCOUNT_ID_TABLES) {
    const schema = table.split('.')[0];
    const name = table.split('.')[1];
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema='${schema}' AND table_name='${name}' AND column_name='account_id'
        ) THEN
          ALTER TABLE ${table} ADD COLUMN account_id TEXT;
        END IF;
      END $$;
    `);
    // 回填：按当前账户名匹配 accounts.id。名字与账户表不一致的孤立行保持 NULL，
    // 由后续数据修复处理，不在此猜测归属。
    await pool.query(
      `UPDATE ${table} b SET account_id = a.id
         FROM accounts a
        WHERE b.username = a.username
          AND b.account_name = a.account_name
          AND b.account_id IS NULL`
    );
    // NOT VALID：不校验存量行，但约束后续写入，避免新行再次脱离不可变主键。
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_${name}_account_id'
        ) THEN
          ALTER TABLE ${table}
            ADD CONSTRAINT fk_${name}_account_id
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
        END IF;
      END $$;
    `);
  }
}

module.exports = { migration176AccountIdCompletion, ACCOUNT_ID_TABLES };
