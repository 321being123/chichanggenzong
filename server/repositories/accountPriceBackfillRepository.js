// 账户导入/保存后补行情：找出「账户需要的日期里有持仓、却缺当日价格」的标的及最早缺口日（数据层）。
// 「需要的日期」= 该账户 nav_history 里已有的日期 ∪ 目标业务日。
// 并入目标业务日是因为新导入账户的 nav_history 还是空表，只按已有日期算会一只都选不出来，
// 当天导入的持仓就永远等不到当日价格（2026-10-30 复现，见 server/test/account-recovery-journey.test.js）。
const pool = require('../db/connection').pool;

async function selectPositionCodesMissingPrice(params, client = pool) {
  const [username, accountName, fromDate, limit, targetDate] = params;
  const { rows } = await client.query(
    `WITH need_dates AS (
       SELECT DISTINCT date::text AS d
         FROM nav_history
        WHERE username = $1 AND account_name = $2 AND date::text >= $3
       UNION
       SELECT $5::text
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
    [username, accountName, fromDate, limit, targetDate]
  );
  return { rows };
}

// 该账户是否已有持仓基准快照（净值续链需要「某日持有哪些股」这一事实）。
async function countPositionSnapshots(params, client = pool) {
  const [username, accountName] = params;
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM nav_position_snapshots WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  return (rows[0] && rows[0].n) || 0;
}

// 按当前持仓写一条持仓基准快照：价格优先用当日账户价格、缺失回退持仓价，港股按当日汇率折算。
// 用 gen_random_uuid 生成 snapshot_id，与 system_daily_price 快照同结构。
async function insertBasisSnapshotsFromPositions(params, client = pool) {
  const [username, accountName, date] = params;
  return client.query(
    `INSERT INTO nav_position_snapshots(snapshot_id, username, account_name, snapshot_date, instrument_code,
                                        quantity, price, quote_currency, fx_rate_to_cny, market_value_cny, source, account_id)
     SELECT gen_random_uuid()::text, p.username, p.account_name, $3::date, p.code, p.quantity,
            px.price,
            CASE WHEN coalesce(p.subtype,'') LIKE '%港股%' THEN 'HKD' ELSE 'CNY' END,
            CASE WHEN coalesce(p.subtype,'') LIKE '%港股%' THEN fx.rate ELSE 1 END,
            round((p.quantity * px.price * (CASE WHEN coalesce(p.subtype,'') LIKE '%港股%' THEN fx.rate ELSE 1 END))::numeric, 2),
            'manual_reconciliation', p.account_id
       FROM positions p
       CROSS JOIN LATERAL (
         SELECT (SELECT rate::float8 FROM market.fx_rates
                  WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $3::date
                  ORDER BY rate_date DESC, fetched_at DESC LIMIT 1) AS rate
       ) fx
       CROSS JOIN LATERAL (
         SELECT coalesce(
                  (SELECT d.price::float8 FROM daily_prices d
                    WHERE d.username=p.username AND d.account_name=p.account_name
                      AND d.code=p.code AND d.date=$3::text ORDER BY d.date DESC LIMIT 1),
                  p.price::float8) AS price
       ) px
      WHERE p.username=$1 AND p.account_name=$2 AND p.quantity > 0
        AND px.price > 0
        AND NOT (coalesce(p.subtype,'') LIKE '%港股%' AND fx.rate IS NULL)`,
    [username, accountName, date]
  );
}

// 该业务日仍没有基准快照的持仓代码：用于如实报告「哪些持仓没写成、为什么」，
// 不用它去补写别人的原始事实（写入口径不变，只让缺口可追踪）。
async function selectUncoveredPositionCodes(params, client = pool) {
  const [username, accountName, date] = params;
  const { rows } = await client.query(
    `SELECT p.code
       FROM positions p
      WHERE p.username=$1 AND p.account_name=$2 AND p.quantity > 0
        AND NOT EXISTS (
              SELECT 1 FROM nav_position_snapshots s
               WHERE s.username=p.username AND s.account_name=p.account_name
                 AND s.instrument_code=p.code AND s.snapshot_date=$3::date)
      ORDER BY p.code`,
    [username, accountName, date]
  );
  return rows.map(row => row.code);
}

module.exports = {
  selectPositionCodesMissingPrice,
  countPositionSnapshots,
  selectUncoveredPositionCodes,
  insertBasisSnapshotsFromPositions
};
