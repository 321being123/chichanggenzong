// 账户导入/保存后补行情：找出「账户需要的日期里有持仓、却缺当日价格」的标的及最早缺口日（数据层）。
// 「需要的日期」= 该账户 nav_history 里已有的日期（净值计算必须用到这些日期的收盘价），
// 这样导入自带历史净值的账户也能一次性补齐前几天，而不是只补今天。
const pool = require('../db/connection').pool;

async function selectPositionCodesMissingPrice(params, client = pool) {
  const [username, accountName, fromDate, limit] = params;
  const { rows } = await client.query(
    `WITH need_dates AS (
       SELECT DISTINCT date::text AS d
         FROM nav_history
        WHERE username = $1 AND account_name = $2 AND date::text >= $3
     )
     SELECT p.code, min(nd.d) AS first_missing
       FROM positions p
       CROSS JOIN need_dates nd
      WHERE p.username = $1 AND p.account_name = $2 AND p.quantity > 0
        AND NOT EXISTS (
              SELECT 1 FROM daily_prices dp
               WHERE dp.username = p.username AND dp.account_name = p.account_name
                 AND dp.code = p.code AND dp.date::text = nd.d)
      GROUP BY p.code
      ORDER BY p.code
      LIMIT $4`,
    [username, accountName, fromDate, limit]
  );
  return { rows };
}

module.exports = { selectPositionCodesMissingPrice };
