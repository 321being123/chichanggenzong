// 账户保存/导入后补当日行情：只查「今天有持仓但没有当日价格」的代码（归属于数据层）。
const pool = require('../db/connection').pool;

async function selectPositionCodesMissingPrice(params, client = pool) {
  const { rows } = await client.query(
    `SELECT p.code, p.name
       FROM positions p
      WHERE p.username = $1 AND p.account_name = $2 AND p.quantity > 0
        AND NOT EXISTS (
              SELECT 1 FROM daily_prices d
               WHERE d.username = p.username AND d.account_name = p.account_name
                 AND d.code = p.code AND d.date::text = $3)
      ORDER BY p.code
      LIMIT $4`,
    params
  );
  return { rows };
}

module.exports = { selectPositionCodesMissingPrice };
