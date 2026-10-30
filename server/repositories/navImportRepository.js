const { pool } = require('../db/connection');

// 历史净值导入/回滚与账户设置的数据读写。
// 业务判定（幂等、乐观锁、锚点选择、缺口校验）留在路由层，这里只执行语句。

// 账户设置列白名单：只允许这些字段进入动态 SET，不接受外部列名。
const ACCOUNT_SETTINGS_COLUMNS = ['cash_base', 'hk_rate', 'fee_settings', 'cash_type', 'cash_subtype'];

async function updateAccountSettings({ username, accountName, patch = {} }, client = pool) {
  const sets = [];
  const values = [username, accountName];
  for (const column of ACCOUNT_SETTINGS_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(patch, column)) continue;
    values.push(patch[column]);
    sets.push(`${column}=$${values.length}`);
  }
  if (!sets.length) return 0;
  const result = await client.query(
    `UPDATE accounts SET ${sets.join(', ')}, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS'), version=COALESCE(version,0)+1 WHERE username=$1 AND account_name=$2`,
    values,
  );
  return result.rowCount || 0;
}

// 港币兑人民币：写入当天全局汇率
async function upsertHkdCnyRate({ rate }, client = pool) {
  return client.query(
    `INSERT INTO market.fx_rates(base_currency,quote_currency,rate_date,source_id,rate,fetched_at)
           VALUES ('HKD','CNY',(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,7,$1,now())
           ON CONFLICT (base_currency,quote_currency,rate_date)
           DO UPDATE SET source_id=7, rate=EXCLUDED.rate, fetched_at=EXCLUDED.fetched_at`,
    [rate],
  );
}

// 旧账户表的汇率回填（全表同一汇率）
async function syncLegacyAccountHkRate({ rate }, client = pool) {
  return client.query(
    "UPDATE accounts SET hk_rate=$1, hk_rate_updated_at=now(), updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')",
    [rate],
  );
}

// 提升 account_data 总版本（并发乐观锁基准），返回新版本号
async function bumpAccountDataVersion({ username, accountName }, client = pool) {
  return client.query(
    `INSERT INTO account_data (username, account_name, data, version) VALUES ($1,$2,'{}',0)
         ON CONFLICT (username, account_name) DO UPDATE SET version=account_data.version+1 RETURNING version`,
    [username, accountName],
  );
}

// 净值相关变更后同时提升 nav_version 与总版本；initialNavVersion 按调用场景取 0 或 1
async function bumpNavVersion({ username, accountName, initialNavVersion = 0 }, client = pool) {
  return client.query(
    `INSERT INTO account_data (username, account_name, data, version, nav_version)
       VALUES ($1,$2,'{}',0,$3)
       ON CONFLICT (username, account_name) DO UPDATE SET version=account_data.version+1, nav_version=account_data.nav_version+1`,
    [username, accountName, initialNavVersion],
  );
}

// 单日净值删除前锁定该行，读回锁定状态与来源优先级
async function lockNavRow({ username, accountName, date }, client = pool) {
  return client.query(
    `SELECT is_locked AS "isLocked", source_priority AS "sourcePriority"
           FROM nav_history WHERE username=$1 AND account_name=$2 AND date=$3 FOR UPDATE`,
    [username, accountName, date],
  );
}

async function deleteNavByDate({ username, accountName, date }, client = pool) {
  return client.query(
    'DELETE FROM nav_history WHERE username=$1 AND account_name=$2 AND date=$3',
    [username, accountName, date],
  );
}

async function deleteAllNav({ username, accountName }, client = pool) {
  return client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
}

// 幂等判定：按批次号或内容指纹查已存在批次并加锁
async function findImportBatch({ username, accountName, batchId, inputHash }, client = pool) {
  return client.query(
    `SELECT id, input_hash AS "inputHash", row_count AS "rowCount"
         FROM nav_import_batches WHERE username=$1 AND account_name=$2
           AND (id=$3 OR input_hash=$4)
         ORDER BY CASE WHEN id=$3 THEN 0 ELSE 1 END, imported_at DESC
         LIMIT 1 FOR UPDATE`,
    [username, accountName, batchId, inputHash],
  );
}

async function listNavHistory({ username, accountName }, client = pool) {
  return client.query(
    `SELECT date, nav, total_asset AS "totalAsset", invested, snapshot_at, hk_rate AS "hkRate",
              cash_cny AS "cashCny", market_value_cny AS "marketValueCny", system_market_value_at_snapshot AS "systemMarketValueAtSnapshot",
              snapshot_source AS "snapshotSource", source_priority AS "sourcePriority", import_batch_id AS "importBatchId",
              calc_status AS "calcStatus", diagnostics, is_locked AS "isLocked", input_hash AS "inputHash"
         FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date`, [username, accountName],
  );
}

async function listPositionsForImport({ username, accountName }, client = pool) {
  return client.query(
    `SELECT code, name, price::float8 AS price, quantity::float8 AS quantity, subtype, type
         FROM positions WHERE username=$1 AND account_name=$2`, [username, accountName],
  );
}

async function listTradesForImport({ username, accountName }, client = pool) {
  return client.query(
    `SELECT code, name, direction, quantity::float8 AS quantity, trade_date, date, executed_at, created_at, subtype, type,
              quote_currency, amount_cny::float8 AS amount_cny
         FROM trades WHERE username=$1 AND account_name=$2`, [username, accountName],
  );
}

async function readAccountHkRate({ username, accountName }, client = pool) {
  return client.query(
    `SELECT hk_rate::float8 AS hk_rate FROM accounts WHERE username=$1 AND account_name=$2`, [username, accountName],
  );
}

// 锚点日之前（含）的汇率序列，按日期升序去重
async function listFxRatesUntil({ date }, client = pool) {
  return client.query(
    `SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate FROM market.fx_rates
        WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
        ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`, [date],
  );
}

async function insertImportBatch(params, client = pool) {
  return client.query(
    `INSERT INTO nav_import_batches (id, username, account_name, range_start, range_end, row_count, input_hash, status, backup_payload, diagnostics)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'committed',$8::jsonb,$9::jsonb)
       ON CONFLICT (id) DO NOTHING`, params,
  );
}

async function upsertImportedNav(params, client = pool) {
  return client.query(
    `INSERT INTO nav_history
          (username, account_name, account_id, date, nav, total_asset, invested, snapshot_at, hk_rate,
           cash_cny, market_value_cny, system_market_value_at_snapshot, broker_fx_rate,
           snapshot_source, source_priority, import_batch_id, calc_status, diagnostics, is_locked, input_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'imported',100,$14,$15,$16,true,$17)
         ON CONFLICT (username, account_name, date) DO UPDATE SET
           nav=EXCLUDED.nav, total_asset=EXCLUDED.total_asset, invested=EXCLUDED.invested, snapshot_at=EXCLUDED.snapshot_at,
           hk_rate=EXCLUDED.hk_rate, cash_cny=EXCLUDED.cash_cny, market_value_cny=EXCLUDED.market_value_cny,
           system_market_value_at_snapshot=EXCLUDED.system_market_value_at_snapshot, broker_fx_rate=EXCLUDED.broker_fx_rate,
           snapshot_source='imported', source_priority=100, import_batch_id=EXCLUDED.import_batch_id,
           calc_status=EXCLUDED.calc_status, diagnostics=EXCLUDED.diagnostics, is_locked=true, input_hash=EXCLUDED.input_hash`,
    params,
  );
}

// 前一完整收盘日的价格固化到导入日（可被之后真实收盘价覆盖）
async function upsertAnchorDailyPrice(params, client = pool) {
  return client.query(
    `INSERT INTO daily_prices (username, account_name, account_id, date, code, name, price)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (username, account_name, date, code) DO UPDATE SET
                 name=EXCLUDED.name, price=EXCLUDED.price`, params,
  );
}

async function deletePositionSnapshotsByBatch({ snapshotId }, client = pool) {
  return client.query('DELETE FROM nav_position_snapshots WHERE snapshot_id=$1', [snapshotId]);
}

// 该账户下「已经没有任何导航历史引用」的导入批次编号（2026-10-30，方案 A2）。
//
// 为什么需要它：`upsertImportedNav` 在 (username, account_name, date) 冲突时把 import_batch_id
// 改指向新批次，而导入前只按本次批次删快照，上一批次整套行就留下没人引用。
// 为什么按「谁在引用」判定而不是按 source：基准行（source='manual_reconciliation'）的
// snapshot_id 是 `basis-…`，天生不会被 import_batch_id 引用，按引用一刀切会把净值锚点删掉
// （2026-10-30 生产事故，已按备份还原）。
// 为什么只删「调用之前就已孤儿」的：本次导入刚取代的上一批次必须留着——回滚是按
// backup_payload 恢复 nav 行（含旧 import_batch_id），那时还要用这套锚点。
async function selectUnreferencedSnapshotBatches({ username, accountName }, client = pool) {
  const { rows } = await client.query(
    `SELECT DISTINCT s.snapshot_id
       FROM nav_position_snapshots s
      WHERE s.username=$1 AND s.account_name=$2
        AND s.source <> 'manual_reconciliation'
        AND NOT EXISTS (
              SELECT 1 FROM nav_history h
               WHERE h.username=s.username AND h.account_name=s.account_name
                 AND h.import_batch_id = s.snapshot_id)
      ORDER BY 1`,
    [username, accountName]
  );
  return rows.map(row => String(row.snapshot_id));
}

// 按批次编号删除快照行；空数组直接返回，不做全表删除。
// 这里再挡一次 source：即使调用方把基准行的编号传进来（或将来有人改了取名单的逻辑），
// 也不会把净值锚点删掉。
async function deletePositionSnapshotsByIds({ snapshotIds }, client = pool) {
  const ids = Array.isArray(snapshotIds) ? snapshotIds.filter(Boolean).map(String) : [];
  if (!ids.length) return { rowCount: 0 };
  return client.query(
    `DELETE FROM nav_position_snapshots
      WHERE snapshot_id = ANY($1::text[])
        AND source <> 'manual_reconciliation'`,
    [ids]
  );
}

async function deletePositionSnapshotsByAccountBatch({ username, accountName, batchId }, client = pool) {
  return client.query('DELETE FROM nav_position_snapshots WHERE username=$1 AND account_name=$2 AND snapshot_id=$3', [username, accountName, batchId]);
}

async function insertPositionSnapshot(params, client = pool) {
  return client.query(
    `INSERT INTO nav_position_snapshots
               (snapshot_id, username, account_name, snapshot_date, instrument_code, quantity, price,
                quote_currency, fx_rate_to_cny, market_value_cny, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, params,
  );
}

// 导入成功后清理导入区间内的系统/手工快照，返回删除行数
async function deleteLegacyNavRows({ username, accountName }, client = pool) {
  return client.query(
    `DELETE FROM nav_history
         WHERE username=$1 AND account_name=$2
           AND COALESCE(snapshot_source, '') <> 'imported'
           AND date < (
             SELECT MAX(date) FROM nav_history
              WHERE username=$1 AND account_name=$2 AND snapshot_source='imported'
           )`,
    [username, accountName],
  );
}

async function lockImportBatch({ batchId, username, accountName }, client = pool) {
  return client.query(
    `SELECT id, status, backup_payload FROM nav_import_batches
          WHERE id=$1 AND username=$2 AND account_name=$3 FOR UPDATE`,
    [batchId, username, accountName],
  );
}

async function restoreNavRow(params, client = pool) {
  return client.query(
    `INSERT INTO nav_history
          (username, account_name, account_id, date, nav, total_asset, invested, snapshot_at, hk_rate,
           cash_cny, market_value_cny, system_market_value_at_snapshot, broker_fx_rate,
           snapshot_source, source_priority, import_batch_id, calc_status, diagnostics, is_locked, input_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, params,
  );
}

async function markImportBatchRolledBack({ batchId }, client = pool) {
  return client.query(`UPDATE nav_import_batches SET status='rolled_back' WHERE id=$1`, [batchId]);
}

module.exports = {
  bumpAccountDataVersion,
  bumpNavVersion,
  deleteAllNav,
  deleteLegacyNavRows,
  deleteNavByDate,
  deletePositionSnapshotsByAccountBatch,
  deletePositionSnapshotsByBatch,
  selectUnreferencedSnapshotBatches,
  deletePositionSnapshotsByIds,
  findImportBatch,
  insertImportBatch,
  insertPositionSnapshot,
  listFxRatesUntil,
  listNavHistory,
  listPositionsForImport,
  listTradesForImport,
  lockImportBatch,
  lockNavRow,
  markImportBatchRolledBack,
  readAccountHkRate,
  restoreNavRow,
  syncLegacyAccountHkRate,
  updateAccountSettings,
  upsertAnchorDailyPrice,
  upsertHkdCnyRate,
  upsertImportedNav,
};
