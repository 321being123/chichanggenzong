// 账户导入/保存后补行情：找出「账户需要的日期里有持仓、却缺当日价格」的标的及最早缺口日（数据层）。
// 「需要的日期」= 该账户 nav_history 里已有的日期 ∪ 目标业务日。
// 并入目标业务日是因为新导入账户的 nav_history 还是空表，只按已有日期算会一只都选不出来，
// 当天导入的持仓就永远等不到当日价格（2026-10-30 复现，见 server/test/account-recovery-journey.test.js）。
const pool = require('../db/connection').pool;
const { withTransaction } = require('../db/transaction');

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

// 与 selectPositionCodesMissingPrice 同口径的缺口总数：用于判断「还剩多少没补」，
// 不做截断，也不返回明细（可能上千只，只为计数）。
async function countPositionCodesMissingPrice(params, client = pool) {
  const [username, accountName, fromDate, targetDate] = params;
  const { rows } = await client.query(
    `WITH need_dates AS (
       SELECT DISTINCT date::text AS d
         FROM nav_history
        WHERE username = $1 AND account_name = $2 AND date::text >= $3
       UNION
       SELECT $4::text
     )
     SELECT count(DISTINCT p.code)::int AS n
       FROM positions p
       CROSS JOIN need_dates nd
      WHERE p.username = $1 AND p.account_name = $2 AND p.quantity > 0
        AND NOT EXISTS (
              SELECT 1 FROM daily_prices dp
               WHERE dp.username = p.username AND dp.account_name = p.account_name
                 AND dp.code = p.code AND dp.date::text = nd.d)`,
    [username, accountName, fromDate, targetDate]
  );
  return (rows[0] && rows[0].n) || 0;
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

// 账户级写锁：把同一账户的「读缺口 → 写入基准」串行化。
//
// 必须在【独立语句】里先拿锁，再执行写入，且两条语句在同一个显式事务/同一连接上：
//   - 放在同一条 INSERT 的 CTE 里无效。READ COMMITTED 下快照在【语句开始】时取得，
//     后到的请求即使阻塞在锁上，拿到锁后仍然用「等待之前」的快照，看不见前一个事务刚提交的行，
//     NOT EXISTS 判定照旧成立，于是同一证券写两条（2026-10-30 隔离库复现）。
//   - 拆成两条语句后，拿锁（第 1 条）结束、INSERT（第 2 条）开始时才取新快照，
//     此时前一个事务已提交，缺口判定能看到对方的行。
//   - 锁是 xact 级：随所在事务提交/回滚自动释放，不需要手工解锁，也不会泄漏。
// 表上的唯一索引（migration 179，仅 source='manual_reconciliation'）是防线二；
// 正确性不依赖它，它只在逻辑再被改坏时把「静默重复」变成「直接报错」。
async function withAccountBasisLock(params, fn, options = {}) {
  const [username, accountName] = params;
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'account_position_basis:' + String(username) + '|' + String(accountName),
    ]);
    return fn(client);
  }, options);
}

// 补齐某业务日的持仓基准快照：只写该日【尚无快照】的证券，已有快照保持原事实不动。
//
// 2026-10-30 复现的缺陷：旧实现只在「账户一条快照都没有」时整批写一次，首次因缺价被过滤掉
// 的证券此后永远补不上（再调用直接返回 already_has_snapshots）。改为按业务日逐证券核缺口后，
// 价格/汇率恢复后再次调用即可补齐，且不覆盖任何已存在的行。
//
// 调用约束：必须传入 withAccountBasisLock 给出的 client（同一事务内），否则并发下会重复写。
// 这里不再默认落到连接池——池上的两条语句会走不同连接，锁等于没用（这正是本次缺陷的成因）。
async function insertBasisSnapshotsFromPositions(params, client) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('insertBasisSnapshotsFromPositions 必须在 withAccountBasisLock 事务内调用，不允许直接用连接池');
  }
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
        AND NOT (coalesce(p.subtype,'') LIKE '%港股%' AND fx.rate IS NULL)
        AND NOT EXISTS (
              SELECT 1 FROM nav_position_snapshots s
               WHERE s.username=p.username AND s.account_name=p.account_name
                 AND s.instrument_code=p.code AND s.snapshot_date=$3::date)`,
    [username, accountName, date]
  );
}

// 该业务日仍没有基准快照的持仓，附上「为什么没写成」的原因：
// missing_fx = 港股缺当日或之前的汇率；no_price = 既无当日行情也无持仓价；
// other = 持仓本身不满足条件（如数量非正，理论上不会出现在这里）。
// 只读诊断，不据此改写任何历史事实。
async function selectUncoveredPositionDetails(params, client = pool) {
  const [username, accountName, date] = params;
  const { rows } = await client.query(
    `SELECT p.code,
            CASE
              WHEN coalesce(p.subtype,'') LIKE '%港股%'
               AND (SELECT rate FROM market.fx_rates
                     WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $3::date
                     ORDER BY rate_date DESC, fetched_at DESC LIMIT 1) IS NULL THEN 'missing_fx'
              WHEN coalesce(
                     (SELECT d.price::float8 FROM daily_prices d
                       WHERE d.username=p.username AND d.account_name=p.account_name
                         AND d.code=p.code AND d.date=$3::text ORDER BY d.date DESC LIMIT 1),
                     p.price::float8, 0) <= 0 THEN 'no_price'
              ELSE 'other'
            END AS reason
       FROM positions p
      WHERE p.username=$1 AND p.account_name=$2 AND p.quantity > 0
        AND NOT EXISTS (
              SELECT 1 FROM nav_position_snapshots s
               WHERE s.username=p.username AND s.account_name=p.account_name
                 AND s.instrument_code=p.code AND s.snapshot_date=$3::date)
      ORDER BY p.code`,
    [username, accountName, date]
  );
  return rows;
}

// 兼容旧调用：只要代码清单。
async function selectUncoveredPositionCodes(params, client = pool) {
  const rows = await selectUncoveredPositionDetails(params, client);
  return rows.map(row => row.code);
}

module.exports = {
  selectPositionCodesMissingPrice,
  countPositionCodesMissingPrice,
  countPositionSnapshots,
  selectUncoveredPositionDetails,
  selectUncoveredPositionCodes,
  withAccountBasisLock,
  insertBasisSnapshotsFromPositions
};
