// ===================== 证券交易单位（每手股数）服务 =====================
// 对应 docs/仓位对比功能_开发文档.md 8.3 / 9 节：
//   1) A 股按市场规则返回交易单位（主板/创业板 100 整数倍；科创板 688/689 最低 200 股、超出 1 股递增）
//   2) 港股从 market.instrument_trade_rules 读取每手股数（含来源/更新时间/缓存标记）
//   3) 缓存缺失时允许一次受限批量补取（Tushare hk_basic），补取成功先落库再计算
//   4) 查询不到每手股数时不默认按 100 股处理
const { pool } = require('../db/connection');
const { tushareQuery, tsRows, todayCN } = require('./market');

// ========== A 股交易单位（市场规则，不落库） ==========

function isStarBoard(code) {
  const c = String(code || '').replace(/\D/g, '');
  // 科创板：沪市 688 / 689 开头
  return c.length === 6 && /^(688|689)/.test(c);
}

// 返回 A 股交易单位规则：
//   minLot: 最小买入股数（一手）
//   increment: 超过最低数量后的递增步长（主板 100 股整手；科创板超 200 后 1 股递增）
//   board: main / star
function getATradeRule(code) {
  if (isStarBoard(code)) return { market: 'A', board: 'star', minLot: 200, increment: 1 };
  return { market: 'A', board: 'main', minLot: 100, increment: 100 };
}

// 判断 A 股是否为主板/创业板/科创板（非 A 股返回 null）
function isACode(code) {
  const c = String(code || '').replace(/\D/g, '');
  return c.length === 6 ? true : false;
}

// ========== 港股每手股数读取（market.instrument_trade_rules） ==========

// 按计算日期读取某只港股当时有效的每手股数；找不到返回 null（禁止兜底 100）
// 返回：{ buy_lot_size_shares, source, source_updated_at, valid_from, raw_record_id, cached }
async function getHkLotRule(instrumentId, asOfDate) {
  if (!instrumentId) return null;
  const date = asOfDate || todayCN();
  const { rows } = await pool.query(
    `SELECT r.buy_lot_size_shares, r.valid_from, r.source_updated_at, r.raw_record_id,
            s.source_code, s.priority
       FROM market.instrument_trade_rules r
       JOIN ops.data_sources s ON s.source_id = r.source_id
      WHERE r.instrument_id = $1
        AND r.valid_from <= $2
        AND (r.valid_to IS NULL OR r.valid_to >= $2)
      ORDER BY s.priority ASC, r.valid_from DESC
      LIMIT 1`,
    [instrumentId, date]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    buy_lot_size_shares: row.buy_lot_size_shares,
    source: row.source_code,
    source_updated_at: row.source_updated_at,
    valid_from: row.valid_from,
    raw_record_id: row.raw_record_id,
    cached: true,
  };
}

// 批量读取多只港股的每手股数（一次性 SQL，避免 N+1）
// 输入 Map<code, instrumentId>，返回 Map<code, lotRule>；无规则的 code 不进入结果
async function getHkLotRulesByInstrumentIds(instrumentIds, asOfDate) {
  const map = new Map();
  const ids = [...new Set(Array.from(instrumentIds.values()).filter(Boolean))];
  if (!ids.length) return map;
  const date = asOfDate || todayCN();
  const { rows } = await pool.query(
    `SELECT r.instrument_id, r.buy_lot_size_shares, r.valid_from, r.source_updated_at, r.raw_record_id,
            s.source_code, s.priority
       FROM market.instrument_trade_rules r
       JOIN ops.data_sources s ON s.source_id = r.source_id
      WHERE r.instrument_id = ANY($1::bigint[])
        AND r.valid_from <= $2
        AND (r.valid_to IS NULL OR r.valid_to >= $2)`,
    [ids, date]
  );
  // 每只证券取 priority 最低（权威最高）、valid_from 最新的那条
  const best = new Map();
  for (const row of rows) {
    const prev = best.get(row.instrument_id);
    if (!prev || row.priority < prev.priority || (row.priority === prev.priority && row.valid_from > prev.valid_from)) {
      best.set(row.instrument_id, row);
    }
  }
  for (const [code, id] of instrumentIds) {
    const row = best.get(id);
    if (row) {
      map.set(code, {
        buy_lot_size_shares: row.buy_lot_size_shares,
        source: row.source_code,
        source_updated_at: row.source_updated_at,
        valid_from: row.valid_from,
        raw_record_id: row.raw_record_id,
        cached: true,
      });
    }
  }
  return map;
}

// 统一入口：给定证券代码返回交易单位规则（A 股市场规则 / 港股查表）
// code 支持 6 位 A 股、5 位港股（如 00700）
// 返回：
//   { market:'A', board, minLot, increment }（A 股）
//   { market:'HK', buy_lot_size_shares, source, source_updated_at, valid_from, cached }（港股有规则）
//   null（港股无规则——调用方应停止测算并提示"未取得每手股数"）
async function getTradeUnit(code, instrumentId, asOfDate) {
  const c = String(code || '').trim().toUpperCase();
  const plain = c.replace(/\D/g, '');
  if (plain.length === 6) return getATradeRule(c); // A 股
  if (plain.length === 5) return await getHkLotRule(instrumentId, asOfDate); // 港股
  return null; // 其他市场暂不支持
}

// ========== 港股每手股数同步（Tushare hk_basic → 标准化表） ==========

// 调 Tushare hk_basic（一次返回全部在交易港股），返回行数组
async function fetchHkBasic() {
  const data = await tushareQuery('hk_basic', { list_status: 'L' }, 'ts_code,name,market,list_date,trade_unit,curr_type');
  return tsRows(data);
}

// 幂等落库：ops.ingestion_runs + ops.raw_records + core.instruments（缺失则补主档）
// + core.instrument_identifiers + market.instrument_trade_rules + ops.sync_cursors
// 返回 { upserted, missingLot, failed }
async function syncHkTradeRules() {
  const rows = await fetchHkBasic();
  const today = todayCN();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: srcRows } = await client.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare'`);
    const tushareSourceId = srcRows[0] ? srcRows[0].source_id : null;
    if (!tushareSourceId) throw new Error('tushare 数据源未注册');

    const run = (await client.query(
      `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,'hk_basic',$2::jsonb,'running') RETURNING run_id`,
      [tushareSourceId, JSON.stringify({ list_status: 'L', trade_date: today })]
    )).rows[0];

    let upserted = 0, missingLot = 0, failed = 0;

    for (const row of rows) {
      const tsCode = String(row.ts_code || '').trim();
      if (!/^\d{5}\.HK$/.test(tsCode)) { failed++; continue; }
      const lot = Number(row.trade_unit);
      if (!Number.isFinite(lot) || lot <= 0) { missingLot++; continue; }
      const name = row.name || tsCode;
      const listDate = /^\d{8}$/.test(String(row.list_date || '')) ? `${String(row.list_date).slice(0,4)}-${String(row.list_date).slice(4,6)}-${String(row.list_date).slice(6,8)}` : null;

      // 1) core.instruments 主档（缺失则补，兼容性：不覆盖已有 raw_data）
      const inst = (await client.query(
        `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status,raw_data)
         VALUES($1,$2,'equity','HK','HKEX','HKD',$3,'listed',$4::jsonb)
         ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name,market=EXCLUDED.market,exchange_code=EXCLUDED.exchange_code,currency_code=EXCLUDED.currency_code,list_date=COALESCE(core.instruments.list_date,EXCLUDED.list_date),status=EXCLUDED.status,updated_at=now()
         RETURNING instrument_id`,
        [tsCode, name, listDate, JSON.stringify({ trade_unit: lot })]
      )).rows[0];

      // 2) core.instrument_identifiers（ts_code）
      await client.query(
        `INSERT INTO core.instrument_identifiers(instrument_id,source_id,identifier_type,identifier_value,valid_from)
         VALUES($1,$2,'ts_code',$3,$4) ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING`,
        [inst.instrument_id, tushareSourceId, tsCode, listDate]
      );

      // 3) ops.raw_records（原始响应，payload_hash 去重）
      const raw = (await client.query(
        `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
         VALUES($1,$2,'hk_basic',$3,now(),$4::jsonb,$5) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING
         RETURNING raw_record_id`,
        [run.run_id, tushareSourceId, tsCode, JSON.stringify(row), require('crypto').createHash('md5').update(JSON.stringify(row)).digest('hex')]
      )).rows[0];

      // 4) market.instrument_trade_rules（文档 9.3：无变化不新增；变化时按生效日处理）
      if (await upsertTradeRule(client, inst.instrument_id, tushareSourceId, today, lot, raw ? raw.raw_record_id : null)) {
        upserted++;
      }
    }

    // 5) sync_cursors
    await client.query(
      `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_attempt_at,last_error)
       VALUES('hk_basic','hk_basic',$1,now(),'') ON CONFLICT(scope_key,dataset_code)
       DO UPDATE SET last_success_date=$1,last_attempt_at=now(),last_error='',updated_at=now()`,
      [today]
    );

    await client.query(`UPDATE ops.ingestion_runs SET status='success',row_count=$2,finished_at=now() WHERE run_id=$1`, [run.run_id, rows.length]);
    await client.query('COMMIT');
    // 同步落库后回填持仓 instrument_id（港股主档刚写入 core.instruments，持仓即可匹配）
    await backfillPositionInstrumentIds();
    return { total: rows.length, upserted, missingLot, failed };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 单条交易单位规则写入（文档 9.3）：无变化不新增；变化时按生效日处理。
// 供 syncHkTradeRules 与测试共用（测试用事务包裹验证真实生产逻辑，不触碰真实数据）。
// 返回 true 表示发生了写入/更新（计数用），false 表示无变化。
// 规则：
//   - 当前有效规则（valid_to IS NULL）不存在 → 新增今天生效记录；
//   - 存在且 lot 相同 → 无变化，不新增；
//   - 存在且 lot 不同：
//       · 若当前有效规则今天生效（valid_from 东八区日期 = today）→ 直接 UPDATE 当天记录
//         （不能关闭旧规则，否则 valid_to=昨天 < valid_from=今天 违反 chk_trade_rules_validity）；
//       · 否则（历史某天生效）→ 关闭旧规则 valid_to=今天前一天，再新增今天生效记录。
// ⚠️ valid_from 是 timestamptz，与 today（东八区 YYYY-MM-DD 字符串）比较必须先转东八区日期，
//    否则（如服务器 UTC 时区）同一天写入的记录 valid_from='YYYY-MM-DDT16:00:00Z' 会被误判为历史，
//    走"关闭旧规则"分支 → valid_to=昨天 < valid_from=今天 → 违反约束导致同步失败。
async function upsertTradeRule(client, instrumentId, sourceId, today, lot, rawRecordId) {
  const cur = (await client.query(
    `SELECT buy_lot_size_shares,
            to_char(valid_from AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS valid_from_cn
       FROM market.instrument_trade_rules
      WHERE instrument_id=$1 AND source_id=$2 AND valid_to IS NULL
      ORDER BY valid_from DESC LIMIT 1`,
    [instrumentId, sourceId]
  )).rows[0];
  if (cur && cur.buy_lot_size_shares === lot) return false; // 无变化
  if (!cur) {
    await client.query(
      `INSERT INTO market.instrument_trade_rules(instrument_id,source_id,valid_from,buy_lot_size_shares,source_updated_at,raw_record_id)
       VALUES($1,$2,$3::date,$4,now(),$5)`,
      [instrumentId, sourceId, today, lot, rawRecordId || null]
    );
    return true;
  }
  if (cur.valid_from_cn === today) {
    // 同一天内首次同步后每手股数再次变化：直接 UPDATE 当天记录（覆盖数值），
    // 不能关闭旧规则（否则 valid_to=昨天 < valid_from=今天 违反约束）
    await client.query(
      `UPDATE market.instrument_trade_rules
          SET buy_lot_size_shares=$3, source_updated_at=now(), raw_record_id=$4
        WHERE instrument_id=$1 AND source_id=$2 AND valid_to IS NULL
          AND to_char(valid_from AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')=$5`,
      [instrumentId, sourceId, lot, rawRecordId || null, today]
    );
    return true;
  }
  // 历史某天生效的规则变更：关闭旧规则（valid_to = 新规则生效日前一天，
  // 避免"新规则生效当天"两条规则同时满足 valid_from<=day<=valid_to）
  const prevDay = new Date(today + 'T00:00:00');
  prevDay.setDate(prevDay.getDate() - 1);
  const validTo = `${prevDay.getFullYear()}-${String(prevDay.getMonth() + 1).padStart(2, '0')}-${String(prevDay.getDate()).padStart(2, '0')}`;
  await client.query(
    `UPDATE market.instrument_trade_rules SET valid_to=$3::date
      WHERE instrument_id=$1 AND source_id=$2 AND valid_to IS NULL`,
    [instrumentId, sourceId, validTo]
  );
  await client.query(
    `INSERT INTO market.instrument_trade_rules(instrument_id,source_id,valid_from,buy_lot_size_shares,source_updated_at,raw_record_id)
     VALUES($1,$2,$3::date,$4,now(),$5)`,
    [instrumentId, sourceId, today, lot, rawRecordId || null]
  );
  return true;
}

// 回填历史持仓的 instrument_id（与迁移 037 同规则，幂等；供同步后/启动时调用）
// 匹配：canonical_code 精确 → 去符号纯代码唯一匹配；未匹配写入质量问题（不删除持仓）
async function backfillPositionInstrumentIds() {
  await pool.query(`
    UPDATE positions p
       SET instrument_id = i.instrument_id
      FROM core.instruments i
     WHERE p.instrument_id IS NULL
       AND i.canonical_code = p.code
  `);
  await pool.query(`
    UPDATE positions p
       SET instrument_id = m.instrument_id
      FROM (
        SELECT p.username, p.account_name, p.id, min(i.instrument_id) AS instrument_id
          FROM positions p
          JOIN core.instruments i
            ON REGEXP_REPLACE(i.canonical_code, '[^0-9]', '', 'g') = REGEXP_REPLACE(p.code, '[^0-9]', '', 'g')
         WHERE p.instrument_id IS NULL
         GROUP BY p.username, p.account_name, p.id
        HAVING count(DISTINCT i.instrument_id) = 1
      ) m
     WHERE p.username = m.username AND p.account_name = m.account_name AND p.id = m.id
  `);
  // 映射成功：关闭已 open 的未匹配质量记录（status → resolved）
  await pool.query(`
    UPDATE ops.data_quality_issues q
       SET status='resolved', resolved_at=now(), details=jsonb_set(details,'{resolved_by}','"backfill"')
      FROM positions p
     WHERE q.dataset_code='positions' AND q.field_code='instrument_id' AND q.issue_type='unmatched_position'
       AND q.status='open'
       AND p.instrument_id IS NOT NULL
       AND q.details->>'username'=p.username AND q.details->>'account_name'=p.account_name AND q.details->>'code'=p.code
  `);
  // 未匹配：先查重再插入（instrument_id 为 NULL 时 UNIQUE 约束不生效，须手动去重防累积）
  await pool.query(`
    INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,details)
    SELECT NULL,'positions','instrument_id','unmatched_position','warning',
           jsonb_build_object('username',p.username,'account_name',p.account_name,'code',p.code)
      FROM positions p
     WHERE p.instrument_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM core.instruments i
          WHERE REGEXP_REPLACE(i.canonical_code, '[^0-9]', '', 'g') = REGEXP_REPLACE(p.code, '[^0-9]', '', 'g')
       )
       AND NOT EXISTS (
         SELECT 1 FROM ops.data_quality_issues q
          WHERE q.dataset_code='positions' AND q.field_code='instrument_id'
            AND q.issue_type='unmatched_position' AND q.status='open'
            AND q.details->>'username'=p.username
            AND q.details->>'account_name'=p.account_name
            AND q.details->>'code'=p.code
       )
  `);
  return { ok: true };
}

module.exports = {
  isStarBoard,
  getATradeRule,
  getHkLotRule,
  getHkLotRulesByInstrumentIds,
  getTradeUnit,
  fetchHkBasic,
  syncHkTradeRules,
  upsertTradeRule,
  backfillPositionInstrumentIds,
};
