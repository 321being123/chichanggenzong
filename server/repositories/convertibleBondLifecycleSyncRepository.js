

// 自 server/services/convertibleBondLifecycleSync.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function sourceIds(client) {
  const { rows } = await client.query("SELECT source_id,source_code FROM ops.data_sources WHERE source_code IN ('tushare','cninfo','sse','szse')");
  return Object.fromEntries(rows.map(row => [row.source_code, row.source_id]));
}

module.exports = {
  sourceIds,
};
