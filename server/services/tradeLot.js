// ===================== 证券交易单位（每手股数）服务 =====================
// 对应 docs/仓位对比功能_开发文档.md 8.3 / 9 节：
//   1) A 股按市场规则返回交易单位（主板/创业板 100 整数倍；科创板 688/689 最低 200 股、超出 1 股递增）
//   2) 港股从 market.instrument_trade_rules 读取每手股数（含来源/更新时间/缓存标记）
//   3) 缓存缺失时允许一次受限批量补取（Tushare hk_basic），补取成功先落库再计算
//   4) 查询不到每手股数时不默认按 100 股处理
const { pool } = require('../db/connection');
const { ensureInstrumentIdentity } = require('./securityIdentity');
const { tushareQuery, tsRows, todayCN } = require('./market');
const txControl = require('../repositories/transactionControl');
const { backfillPositionInstrumentIds, upsertTradeRule } = require('../repositories/tradeLotRepository.js');
const repository = require('../repositories/tradeLotRepository.js');

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
  const { rows } = await repository.select_market_instrument_trade_rules([instrumentId, date]);
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
  const { rows } = await repository.select_market_instrument_trade_rules_1([ids, date]);
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
    await txControl.begin(client);
    const { rows: srcRows } = await repository.select_ops_data_sources(client);
    const tushareSourceId = srcRows[0] ? srcRows[0].source_id : null;
    if (!tushareSourceId) throw new Error('tushare 数据源未注册');

    const run = (await repository.insert_ops_ingestion_runs([tushareSourceId, JSON.stringify({ list_status: 'L', trade_date: today })], client)).rows[0];

    let upserted = 0, missingLot = 0, failed = 0;

    for (const row of rows) {
      const tsCode = String(row.ts_code || '').trim();
      if (!/^\d{5}\.HK$/.test(tsCode)) { failed++; continue; }
      const lot = Number(row.trade_unit);
      if (!Number.isFinite(lot) || lot <= 0) { missingLot++; continue; }
      const name = row.name || tsCode;
      const listDate = /^\d{8}$/.test(String(row.list_date || '')) ? `${String(row.list_date).slice(0,4)}-${String(row.list_date).slice(4,6)}-${String(row.list_date).slice(6,8)}` : null;

      // 1) core.instruments 主档（缺失则补，兼容性：不覆盖已有 raw_data）
      const master = await ensureInstrumentIdentity({ canonicalCode: tsCode, name, assetClass: 'stock', market: 'HK', exchangeCode: 'HKEX', currencyCode: 'HKD', listDate: listDate, status: 'listed', rawData: { trade_unit: lot }, companyName: name }, client.query.bind(client));
      const inst = { instrument_id: master.instrumentId };

      // 2) core.instrument_identifiers（ts_code）
      await repository.insert_core_instrument_identifiers([inst.instrument_id, tushareSourceId, tsCode, listDate], client);

      // 3) ops.raw_records（原始响应，payload_hash 去重）
      const raw = (await repository.insert_ops_raw_records([run.run_id, tushareSourceId, tsCode, JSON.stringify(row), require('crypto').createHash('md5').update(JSON.stringify(row)).digest('hex')], client)).rows[0];

      // 4) market.instrument_trade_rules（文档 9.3：无变化不新增；变化时按生效日处理）
      if (await upsertTradeRule(client, inst.instrument_id, tushareSourceId, today, lot, raw ? raw.raw_record_id : null)) {
        upserted++;
      }
    }

    // 5) sync_cursors
    await repository.insert_ops_sync_cursors([today], client);

    await repository.update_ops_ingestion_runs([run.run_id, rows.length], client);
    await txControl.commit(client);
    // 同步落库后回填持仓 instrument_id（港股主档刚写入 core.instruments，持仓即可匹配）
    await backfillPositionInstrumentIds();
    return { total: rows.length, upserted, missingLot, failed };
  } catch (error) {
    await txControl.rollback(client);
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
/* upsertTradeRule 已迁入 server/repositories/tradeLotRepository.js */

// 回填历史持仓的 instrument_id（与迁移 037 同规则，幂等；供同步后/启动时调用）
// 匹配：canonical_code 精确 → 去符号纯代码唯一匹配；未匹配写入质量问题（不删除持仓）
/* backfillPositionInstrumentIds 已迁入 server/repositories/tradeLotRepository.js */

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
