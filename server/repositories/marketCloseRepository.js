const { pool } = require('../db/connection');

// 自 server/jobs/marketClose.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_daily_prices(params, client = pool) {
  return client.query(`SELECT code FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3`, params);
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

async function select_daily_prices_2(params, client = pool) {
  return client.query(`SELECT date::text AS date FROM daily_prices WHERE username=$1 AND account_name=$2 AND date BETWEEN $3 AND $4`, params);
}

module.exports = {
  select_daily_prices,
  select_positions,
  select_accounts,
  select_daily_prices_1,
  select_daily_prices_2,
};
