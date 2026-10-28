const { pool } = require('../db/connection');

// 自 server/services/convertibleBondSuspensionSync.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function tushareSourceId() {
  const { rows } = await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1");
  return rows[0] && rows[0].source_id;
}

module.exports = {
  tushareSourceId,
};
