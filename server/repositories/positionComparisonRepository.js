// 仓位对比数据仓储（批次3，从 routes/positionComparison 迁入的 SQL）。
// 合同：method(params, tx)；只做 accounts/account_data 的标准读写，不判断权限与公开状态语义。
const { pool } = require('../db');

async function setVisibility(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `UPDATE accounts SET position_visibility=$1, position_visibility_updated_at=now(), updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE username=$2 AND account_name=$3 RETURNING id`,
    [params.visibility, params.username, params.accountName],
  );
  return rows;
}

async function readVisibility(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT position_visibility FROM accounts WHERE username=$1 AND account_name=$2',
    [params.username, params.accountName],
  );
  return rows[0] || null;
}

// 标杆账户行（含持仓更新时间），供公开校验与页面展示
async function readAccountById(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT a.id, a.account_name, a.username, a.position_visibility,
            a.position_visibility_updated_at, a.updated_at,
            ad.updated_at AS data_updated_at
       FROM accounts a
       LEFT JOIN account_data ad ON ad.username=a.username AND ad.account_name=a.account_name
      WHERE a.id=$1`,
    [params.accountId],
  );
  return rows[0] || null;
}

// 本人的账户行（含持仓更新时间）
async function readMyAccount(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT a.account_name, a.updated_at,
            ad.updated_at AS data_updated_at
       FROM accounts a
       LEFT JOIN account_data ad ON ad.username=a.username AND ad.account_name=a.account_name
      WHERE a.username=$1 AND a.account_name=$2`,
    [params.username, params.accountName],
  );
  return rows[0] || null;
}

module.exports = { readAccountById, readMyAccount, readVisibility, setVisibility };
