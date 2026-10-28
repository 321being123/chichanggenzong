// 账户与账本数据仓储（批次3，从 routes/accounts 迁入的 SQL）。
// 合同：method(params, tx)；只做账户/账本/行情的标准读取，不承载净值与收益计算。
const { pool } = require('../db');

async function listAccountNames(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT account_name FROM accounts WHERE username=$1 ORDER BY created_at',
    [params.username],
  );
  return rows.map(row => row.account_name);
}

// 锚点日精确收盘价（缺任何一只有效价都由调用方判定为不完整）
async function readExactAnchorPrices(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT code, price::float8 AS price
       FROM daily_prices
      WHERE username=$1 AND account_name=$2 AND date=$3
        AND code=ANY($4::text[]) AND price > 0`,
    [params.username, params.accountName, params.anchorDate, params.codes],
  );
  return rows;
}

// 向前回溯“覆盖全部代码的最近一个完整收盘日”（不允许跨日混用价格）
async function readPreviousCompleteAnchorPrices(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `WITH candidate AS (
       SELECT date::text AS price_date
         FROM daily_prices
        WHERE username=$1 AND account_name=$2 AND date < $3
          AND code = ANY($4::text[]) AND price > 0
        GROUP BY date
       HAVING COUNT(DISTINCT code) = $5
        ORDER BY date DESC
        LIMIT 1
     )
     SELECT dp.code, dp.price::float8 AS price, c.price_date AS "priceDate"
       FROM candidate c
       JOIN daily_prices dp
         ON dp.username=$1 AND dp.account_name=$2
        AND dp.date=c.price_date AND dp.code=ANY($4::text[])
        AND dp.price > 0`,
    [params.username, params.accountName, params.anchorDate, params.codes, params.codes.length],
  );
  return rows;
}

async function readCashIncomeState(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT cash_income_policy,cash_income_state FROM accounts WHERE username=$1 AND account_name=$2',
    [params.username, params.accountName],
  );
  return rows[0] || null;
}

async function listCashFlows(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT id,date::text,amount::text,flow_type,status,origin,event_key,anchor_date::text,
            quality_status,evidence,revision,note,currency,original_amount::text,amount_cny::text,
            settled_at,source_ref
       FROM cash_flows
      WHERE username=$1 AND account_name=$2 AND flow_type<>'external_transfer'
      ORDER BY date,id`,
    [params.username, params.accountName],
  );
  return rows;
}

async function listCashIncomePending(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT p.* FROM account_cash_income_pending p
       JOIN accounts a ON a.id=p.account_id
      WHERE a.username=$1 AND a.account_name=$2
      ORDER BY first_seen_at,pending_key`,
    [params.username, params.accountName],
  );
  return rows;
}

// 券商与导入单位（用于前端按券商口径展示）
async function readAccountBroker(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT a.broker, b.import_unit FROM accounts a LEFT JOIN brokers b ON a.broker=b.code WHERE a.username=$1 AND a.account_name=$2',
    [params.username, params.accountName],
  );
  return rows[0] || null;
}

async function listDailyPricesAt(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT code, price::text AS price
       FROM daily_prices
      WHERE username = $1 AND account_name = $2 AND date = $3 AND code = ANY($4::text[])`,
    [params.username, params.accountName, params.date, params.codes],
  );
  return rows;
}

async function listAllDailyPrices(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT date, code, price::float8 AS price FROM daily_prices WHERE username=$1 AND account_name=$2',
    [params.username, params.accountName],
  );
  return rows;
}

async function readAccountVersion(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT COALESCE(version,0) as v FROM account_data WHERE username=$1 AND account_name=$2',
    [params.username, params.accountName],
  );
  return rows[0] ? rows[0].v : 0;
}

async function readNavBackupInfo(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT nav_history_backup_at AS at,
            jsonb_array_length(COALESCE(nav_history_backup, '[]'::jsonb)) AS rows
       FROM account_data WHERE username=$1 AND account_name=$2`,
    [params.username, params.accountName],
  );
  return rows[0] || null;
}

// 净值导入预览所需的持仓、成交与汇率（只读）
async function listPositionsForNavPreview(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT code, price::float8 AS price, quantity::float8 AS quantity, subtype FROM positions WHERE username=$1 AND account_name=$2',
    [params.username, params.accountName],
  );
  return rows;
}

async function listTradesForNavPreview(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT code, name, direction, quantity::float8 AS quantity, trade_date, date, executed_at,
            created_at, subtype, type, quote_currency, amount_cny::float8 AS amount_cny
       FROM trades WHERE username=$1 AND account_name=$2`,
    [params.username, params.accountName],
  );
  return rows;
}

// HKD→CNY 汇率序列（按日期升序，同日取最新抓取）
async function listHkdCnyRatesUntil(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate
       FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
      ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`,
    [params.date],
  );
  return rows;
}

// 账户主键（净值批次写入时需要带 account_id）
// HKD→CNY 全量汇率行（不做同日优选，调用方自行按日期归并）
async function listHkdCnyRateRows(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT rate_date, rate::float8 AS rate FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1`,
    [params.date],
  );
  return rows;
}

// 单个证券在本账户的历史收盘价（缺价回补后重载）
async function listDailyPricesByCode(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT date, price::float8 AS price FROM daily_prices WHERE username=$1 AND account_name=$2 AND code=$3',
    [params.username, params.accountName, params.code],
  );
  return rows;
}

// 标记该账户净值不再需要重算
async function clearNavDirtyFrom(params, tx) {
  const runner = tx || pool;
  await runner.query('UPDATE account_data SET nav_dirty_from=NULL WHERE username=$1 AND account_name=$2',
    [params.username, params.accountName]);
}

async function readAccountId(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT id FROM accounts WHERE username=$1 AND account_name=$2',
    [params.username, params.accountName],
  );
  return rows[0] || null;
}

// 持仓单价更新（批量保存行情时逐条写）
async function updatePositionPrice(params, tx) {
  const runner = tx || pool;
  return runner.query(
    'UPDATE positions SET price=$1 WHERE username=$2 AND account_name=$3 AND code=$4',
    [params.price, params.username, params.accountName, params.code],
  );
}

// 提升持仓版本与总版本，返回新版本号
async function bumpPositionVersion(params, tx) {
  const runner = tx || pool;
  return runner.query(
    `INSERT INTO account_data (username, account_name, data, version, pos_version) VALUES ($1,$2,'{}',0,0) ON CONFLICT (username, account_name) DO UPDATE SET pos_version=account_data.pos_version+1, version=account_data.version+1 RETURNING version`,
    [params.username, params.accountName],
  );
}

// 持仓字段更新：列名按白名单拼装，不接受外部输入
const POSITION_EDITABLE_COLUMNS = new Set(['name', 'type', 'subtype', 'note']);
async function updatePositionFields(params, tx) {
  const runner = tx || pool;
  const patch = params.patch || {};
  const cols = Object.keys(patch).filter((k) => POSITION_EDITABLE_COLUMNS.has(k));
  if (!cols.length) return { rowCount: 0 };
  const sets = cols.map((c, i) => `${c}=${i + 4}`);
  const args = [params.username, params.accountName, params.posId, ...cols.map((c) => patch[c])];
  return runner.query(
    `UPDATE positions SET ${sets.join(', ')} WHERE username=$1 AND account_name=$2 AND id=$3`,
    args,
  );
}

module.exports = {
  bumpPositionVersion,
  clearNavDirtyFrom,
  listAccountNames,
  listAllDailyPrices,
  listCashFlows,
  listCashIncomePending,
  listDailyPricesAt,
  listDailyPricesByCode,
  listHkdCnyRateRows,
  listHkdCnyRatesUntil,
  listPositionsForNavPreview,
  listTradesForNavPreview,
  readAccountBroker,
  readAccountId,
  readAccountVersion,
  readCashIncomeState,
  readExactAnchorPrices,
  readNavBackupInfo,
  readPreviousCompleteAnchorPrices,
  updatePositionFields,
  updatePositionPrice,
};
