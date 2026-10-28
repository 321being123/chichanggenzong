const { pool } = require('../db/connection');

// 同步游标事实读取：按范围键批量取最近成功日与遗留错误，供启动补偿判定。

async function findCursorsByScopeKeys(scopeKeys, client = pool) {
  const { rows } = await client.query(`
      SELECT scope_key, last_success_date, last_error
      FROM ops.sync_cursors
      WHERE scope_key = ANY($1::text[])
    `, [scopeKeys]);
  return rows;
}

module.exports = { findCursorsByScopeKeys };
