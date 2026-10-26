// 账户级业务表的唯一来源。
//
// 2026-10-26 线上事故：账户改名只覆盖 7 张表，漏了 nav_position_snapshots / nav_import_batches，
// 导致导入持仓锚点按新名查不到，净值投影链从改名前一日断开，nav_snapshot 连续失败并触发后台告警。
// 根因不是"清单写漏一次"，而是"手写清单"这种形态本身：每加一张新表就多一次遗漏机会。
//
// 现在的做法：
//   1) 运行期用 listAccountScopedTables() 从 information_schema 动态发现所有带 account_name 的表，
//      新增表无需人工登记即自动覆盖，不存在"忘了加进清单"的可能；
//   2) ACCOUNT_SCOPED_TABLES 保留为架构基线与测试断言依据（必须已具备不可变 account_id 的账户数据表）；
//   3) 改名后逐表校验旧账户名残留，非 0 直接回滚（见 accounts.renameAccountData）。
const ACCOUNT_SCOPED_TABLES = [
  'positions',
  'trades',
  'nav_history',
  'cash_flows',
  'daily_prices',
  'index_history',
  'account_data',
  'index_baseline_settled',
  'nav_position_snapshots',
  'nav_import_batches',
  'analytics.graham_strategy_settings',
  'analytics.market_cycle_strategy_settings',
];

// 账户元数据表：改名是重命名、删除是删行，结构与其他业务表不同，由调用方单独处理。
const ACCOUNT_METADATA_TABLE = 'accounts';

// 归档备份表（*_backup_YYYYMMDD）是历史快照，不参与运行时账户改名/删除。
const ARCHIVED_BACKUP_TABLE = String.raw`_backup_[0-9]{8}$`;

// 动态发现所有账户级业务表（带 account_name 列的基础表）。
// 只认业务 schema，排除 accounts 元数据表与归档备份表；表名来自 information_schema，不接受外部输入。
// 同时返回该表是否已有不可变 account_id：迁移 176 之前或本地关闭运行时迁移的环境会缺列，
// 调用方据此降级为按账户名定位，避免"代码已上线、迁移未跑"的窗口期直接把改名功能打挂。
async function listAccountScopedTables(executor) {
  const runner = typeof executor === 'function' ? executor : executor.query.bind(executor);
  const { rows } = await runner(
    `SELECT c.table_schema || '.' || c.table_name AS qualified,
            EXISTS (
              SELECT 1 FROM information_schema.columns a
               WHERE a.table_schema = c.table_schema
                 AND a.table_name = c.table_name
                 AND a.column_name = 'account_id'
            ) AS has_account_id
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema
        AND t.table_name = c.table_name
        AND t.table_type = 'BASE TABLE'
      WHERE c.column_name = 'account_name'
        AND c.table_schema IN ('public', 'analytics')
        AND c.table_name !~ $1
        AND NOT (c.table_schema = 'public' AND c.table_name = $2)
      ORDER BY 1`,
    [ARCHIVED_BACKUP_TABLE, ACCOUNT_METADATA_TABLE]
  );
  return rows.map(row => ({ table: row.qualified, hasAccountId: row.has_account_id === true }));
}

// 校验旧账户名在所有账户级表里是否还有残留（改名后的运行期自检）。
// 返回残留清单；空数组代表这张账户名的数据已整体搬迁干净。
async function findAccountNameLeftovers(executor, username, accountName) {
  const runner = typeof executor === 'function' ? executor : executor.query.bind(executor);
  const tables = await listAccountScopedTables(runner);
  const leftovers = [];
  for (const { table } of tables) {
    const { rows } = await runner(
      `SELECT count(*)::int AS c FROM ${table} WHERE username = $1 AND account_name = $2`,
      [username, accountName]
    );
    const count = Number(rows[0] && rows[0].c) || 0;
    if (count > 0) leftovers.push({ table, count });
  }
  return leftovers;
}

module.exports = {
  ACCOUNT_SCOPED_TABLES,
  ACCOUNT_METADATA_TABLE,
  ARCHIVED_BACKUP_TABLE,
  listAccountScopedTables,
  findAccountNameLeftovers,
};
