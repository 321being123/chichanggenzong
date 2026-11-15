const { pool } = require('../db/connection');

// 自 server/jobs/marketClose.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
// 收盘幂等的判定依据必须是“已确认的终盘价”，不能只看当天有没有任意一条记录：
// 盘中候选或遗留未核验价存在时，收盘任务仍需重新取价并升级。
async function select_daily_prices(params, client = pool) {
  return client.query(
    `SELECT code, quality, is_final FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3`,
    params
  );
}

async function select_positions(params, client = pool) {
  return client.query(`SELECT code FROM positions WHERE code IS NOT NULL AND code <> ''`);
}

async function select_accounts(params, client = pool) {
  return client.query(`SELECT username, account_name FROM accounts ORDER BY username, created_at`);
}

async function select_daily_prices_1(params, client = pool) {
  return client.query(`SELECT MIN(date)::text AS first_date FROM daily_prices WHERE username=$1 AND account_name=$2`, params);
}

// 补漏的“已覆盖”必须精确到证券：只返回日期会漏掉“当天部分证券缺价”的情况，
// 因此这里返回「日期 + 代码」，由上层按账户持仓逐只核对缺口。
async function select_daily_prices_2(params, client = pool) {
  return client.query(
    `SELECT DISTINCT date::text AS date, code FROM daily_prices
      WHERE username=$1 AND account_name=$2 AND date BETWEEN $3 AND $4
        AND quality = 'confirmed' AND is_final = true`,
    params
  );
}

// 账户当前持有的证券（补漏要按账户、市场、证券、交易日逐只核对）。
async function select_position_scope(params, client = pool) {
  return client.query(
    `SELECT code, subtype FROM positions
      WHERE username=$1 AND account_name=$2 AND quantity::float8 > 0`,
    params
  );
}

module.exports = {
  select_daily_prices,
  select_position_scope,
  select_positions,
  select_accounts,
  select_daily_prices_1,
  select_daily_prices_2,
};
