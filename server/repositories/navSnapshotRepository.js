const { pool } = require('../db/connection');

// 自 server/jobs/navSnapshot.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_accounts(params, client = pool) {
  return client.query(`SELECT cash_base::float8 AS cash_base FROM accounts WHERE username=$1 AND account_name=$2`, params);
}

async function select_daily_prices(params, client = pool) {
  return client.query(`SELECT date, code, price::float8 AS price FROM daily_prices WHERE username=$1 AND account_name=$2`, params);
}

async function select_market_fx_rates(params, client = pool) {
  return client.query(`SELECT rate_date::text AS rate_date, rate::float8 AS rate FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1`, params);
}

async function select_accounts_1(params, client = pool) {
  return client.query(`SELECT username, account_name FROM accounts ORDER BY username, created_at`);
}

async function select_nav_history(params, client = pool) {
  return client.query(`SELECT date::text AS date FROM nav_history WHERE username=$1 AND account_name=$2 AND date=$3::text`, params);
}

module.exports = {
  select_accounts,
  select_daily_prices,
  select_market_fx_rates,
  select_accounts_1,
  select_nav_history,
};
