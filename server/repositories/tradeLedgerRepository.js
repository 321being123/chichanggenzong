const { pool } = require('../db/connection');



// 自 server/services/tradeLedger.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function heldQuantity(client, username, accountName, code) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS qty FROM positions
      WHERE username=$1 AND account_name=$2 AND code=$3`,
    [username, accountName, code]
  );
  return Number(rows[0] ? rows[0].qty : 0);
}

async function select_trades(params, client = pool) {
  return client.query(`SELECT id, direction, price, quantity, amount, commission, stamp_tax, transfer_fee, other_fee, trade_date, executed_at, date, created_at
       FROM trades WHERE username=$1 AND account_name=$2 AND code=$3
      ORDER BY COALESCE(trade_date, left(date,10)) ASC, COALESCE(executed_at, date, created_at) ASC, created_at ASC, id ASC`, params);
}

async function select_account_data(params, client = pool) {
  return client.query(`SELECT COALESCE(version,0) AS v FROM account_data WHERE username=$1 AND account_name=$2 FOR UPDATE`, params);
}

async function select_trades_1(params, client = pool) {
  return client.query(`SELECT id FROM trades WHERE id=$1 AND username=$2 AND account_name=$3`, params);
}

async function select_accounts(params, client = pool) {
  return client.query(`SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE`, params);
}

async function insert_accounts(params, client = pool) {
  return client.query(`INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at)
         VALUES ($1,$2,$3,0,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (username, account_name) DO NOTHING`, params);
}

async function select_trades_2(params, client = pool) {
  return client.query(`SELECT direction, quantity FROM trades WHERE username=$1 AND account_name=$2 AND id=$3`, params);
}

async function select_trades_3(params, client = pool) {
  return client.query(`SELECT id FROM trades WHERE username=$1 AND account_name=$2 AND import_batch_id=$3
           AND code=$4 AND trade_date=$5 AND direction=$6 AND price=$7 AND quantity=$8 LIMIT 1`, params);
}

async function select_market_fx_rates(params, client = pool) {
  return client.query(`SELECT rate::float8 AS rate FROM market.fx_rates
          WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
          ORDER BY rate_date DESC, fetched_at DESC LIMIT 1`, params);
}

async function insert_trades(params, client = pool) {
  return client.query(`INSERT INTO trades (id, username, account_name, account_id, date, created_at, trade_date, executed_at, import_batch_id,
                           code, name, direction, price, quantity, amount,
                           quote_currency, fx_rate_to_cny, amount_cny, currency_status,
                           commission, stamp_tax, transfer_fee, other_fee, type, subtype, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT (id, username, account_name) DO UPDATE SET
         date=EXCLUDED.date, created_at=EXCLUDED.created_at, trade_date=EXCLUDED.trade_date,
         executed_at=EXCLUDED.executed_at, import_batch_id=EXCLUDED.import_batch_id,
         code=EXCLUDED.code, name=EXCLUDED.name, direction=EXCLUDED.direction,
         price=EXCLUDED.price, quantity=EXCLUDED.quantity, amount=EXCLUDED.amount,
         quote_currency=EXCLUDED.quote_currency, fx_rate_to_cny=EXCLUDED.fx_rate_to_cny,
         amount_cny=EXCLUDED.amount_cny, currency_status=EXCLUDED.currency_status,
         commission=EXCLUDED.commission, stamp_tax=EXCLUDED.stamp_tax, transfer_fee=EXCLUDED.transfer_fee,
         other_fee=EXCLUDED.other_fee, type=EXCLUDED.type, subtype=EXCLUDED.subtype, note=EXCLUDED.note`, params);
}

async function select_positions(params, client = pool) {
  return client.query(`SELECT id FROM positions WHERE username=$1 AND account_name=$2 AND code=$3 LIMIT 1`, params);
}

async function update_positions(params, client = pool) {
  return client.query(`UPDATE positions SET quantity=$4, cost=$5,
             name=CASE WHEN $6<>'' THEN $6 ELSE name END,
             type=CASE WHEN $7<>'' THEN $7 ELSE type END,
             subtype=CASE WHEN $8<>'' THEN $8 ELSE subtype END,
             note=CASE WHEN $9<>'' THEN $9 ELSE note END
           WHERE username=$1 AND account_name=$2 AND code=$3`, params);
}

async function delete_positions(params, client = pool) {
  return client.query(`DELETE FROM positions WHERE username=$1 AND account_name=$2 AND code=$3`, params);
}

async function delete_positions_1(params, client = pool) {
  return client.query(`DELETE FROM positions WHERE username=$1 AND account_name=$2 AND code=$3
           AND id <> (SELECT id FROM positions WHERE username=$1 AND account_name=$2 AND code=$3 LIMIT 1)`, params);
}

async function insert_positions(params, client = pool) {
  return client.query(`INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'')`, params);
}

async function update_accounts(params, client = pool) {
  return client.query(`UPDATE accounts SET version=COALESCE(version,0)+1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE username=$1 AND account_name=$2`, params);
}

async function update_positions_1(params, client = pool) {
  return client.query(`UPDATE positions SET price=$1
           WHERE username=$2 AND account_name=$3 AND code=$4 AND quantity > 0`, params);
}

async function insert_account_data(params, client = pool) {
  return client.query(`INSERT INTO account_data (username, account_name, data, version, pos_version)
         VALUES ($1,$2,'{}',0,0)
         ON CONFLICT (username, account_name) DO UPDATE SET
           pos_version=COALESCE(account_data.pos_version,0)+1,
           version=COALESCE(account_data.version,0)+1`, params);
}

async function delete_trades(params, client = pool) {
  return client.query(`DELETE FROM trades WHERE username=$1 AND account_name=$2 AND id=$3 RETURNING code, date, trade_date`, params);
}

async function update_positions_2(params, client = pool) {
  return client.query(`UPDATE positions SET quantity=$4, cost=$5 WHERE username=$1 AND account_name=$2 AND code=$3`, params);
}

async function delete_cash_flows(params, client = pool) {
  return client.query(`DELETE FROM cash_flows WHERE username=$1 AND account_name=$2 AND id=$3 AND origin='manual' RETURNING id, date::text`, params);
}

async function select_cash_flows(params, client = pool) {
  return client.query(`SELECT id,origin FROM cash_flows WHERE id=$1 AND username=$2 AND account_name=$3`, params);
}

async function insert_cash_flows(params, client = pool) {
  return client.query(`INSERT INTO cash_flows (id, username, account_name, account_id, date, created_at, amount, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id, username, account_name) DO NOTHING`, params);
}

// 账本写入后提升账户数据版本并标记净值需重算；列名按数据集白名单选择，不接受外部输入
const DIRTY_COLUMNS = {
  position: 'pos_version',
  cashflow: 'cashflow_version',
  nav: 'nav_version',
};

async function markAccountDataDirty(params, client = pool) {
  const col = DIRTY_COLUMNS[params.dataset] || 'trade_version';
  const anchorDate = params.fromDate || params.today;
  // account_data 行可能不存在（账本首笔写入前）→ INSERT 兜底建行再提升
  await client.query(
    `INSERT INTO account_data (username, account_name, data, version, ${col}, nav_cash_cutoff, nav_dirty_from)
     VALUES ($1,$2,'{}',0,0,$3::text,$4::date)
     ON CONFLICT (username, account_name) DO NOTHING`,
    [params.username, params.accountName, anchorDate, anchorDate],
  );
  await client.query(
    `UPDATE account_data
        SET nav_cash_cutoff=$3::text,
            nav_dirty_from=CASE WHEN nav_dirty_from IS NULL OR nav_dirty_from > $4::date THEN $4::date ELSE nav_dirty_from END,
            version=COALESCE(version,0)+1,
            ${col}=COALESCE(${col},0)+1
      WHERE username=$1 AND account_name=$2`,
    [params.username, params.accountName, anchorDate, anchorDate],
  );
}

module.exports = {
  markAccountDataDirty,
  heldQuantity,
  select_trades,
  select_account_data,
  select_trades_1,
  select_accounts,
  insert_accounts,
  select_trades_2,
  select_trades_3,
  select_market_fx_rates,
  insert_trades,
  select_positions,
  update_positions,
  delete_positions,
  delete_positions_1,
  insert_positions,
  update_accounts,
  update_positions_1,
  insert_account_data,
  delete_trades,
  update_positions_2,
  delete_cash_flows,
  select_cash_flows,
  insert_cash_flows,
};
