const { pool } = require('../db/connection');

// 自 server/services/positionComparison.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function listBenchmarks(currentUsername) {
  const { rows } = await pool.query(
    `SELECT a.id AS account_id, a.account_name, a.username, a.position_visibility,
            COALESCE(u.nickname, a.username) AS nickname,
            a.updated_at,
            ad.updated_at AS data_updated_at
       FROM accounts a
       LEFT JOIN users u ON u.username = a.username
       LEFT JOIN account_data ad ON ad.username=a.username AND ad.account_name=a.account_name
      WHERE a.position_visibility <> 'private'
        AND a.username <> $1
      ORDER BY a.updated_at DESC NULLS LAST`,
    [currentUsername]
  );
  const result = [];
  for (const row of rows) {
    // 证券只数（半公开也可展示只数，但不能展示持仓数量）
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(DISTINCT COALESCE(instrument_id::text, code))::int AS cnt
         FROM positions WHERE username=$1 AND account_name=$2 AND quantity > 0`,
      [row.username, row.account_name]
    );
    result.push({
      accountId: row.account_id,
      displayName: `${row.nickname || row.username} · ${row.account_name}`,
      visibility: row.position_visibility,
      // 持仓更新时间：真实持仓保存时间优先（account_data.updated_at），不用公开状态修改时间
      positionUpdatedAt: row.data_updated_at || row.updated_at || null,
      securityCount: cnt[0] ? cnt[0].cnt : 0,
    });
  }
  return result;
}

async function loadEffectivePositions(username, accountName) {
  const { rows } = await pool.query(
    `SELECT id, code, name, price::float8 AS price, quantity::float8 AS quantity,
            cost::float8 AS cost, type, subtype, note, instrument_id
       FROM positions WHERE username=$1 AND account_name=$2 AND quantity > 0`,
    [username, accountName]
  );
  return rows;
}

// 账户现金基准与港币汇率（同日取最新，缺失回退账户缓存列）
async function readAccountCashBase(params, client = pool) {
  const { rows } = await client.query(
    `SELECT cash_base::float8 AS cash_base,
            COALESCE((SELECT rate::float8 FROM market.fx_rates
                       WHERE base_currency='HKD' AND quote_currency='CNY'
                         AND rate_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
                       ORDER BY rate_date DESC, fetched_at DESC LIMIT 1), hk_rate::float8) AS hk_rate,
            hk_rate_updated_at FROM accounts WHERE username=$1 AND account_name=$2`,
    [params.username, params.accountName],
  );
  return rows[0] || null;
}

module.exports = {
  listBenchmarks,
  loadEffectivePositions,
  readAccountCashBase,
};
