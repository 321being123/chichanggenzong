// 可转债周期：事实写入与聚合服务（数据库层）
// 职责：批量保存每日原始事实、聚合入库、历史查询、同步游标、失败保留。
// 不调用 Tushare（调用方传入 cb_daily 行）。
const { pool } = require('../db');
const cycle = require('./convertibleBondCycle');
const { ensureInstrumentIdentity } = require('./securityIdentity');
const { getSyncCursor, getTushareSourceId, upsertCycleDaily } = require('../repositories/convertibleBondCycleServiceRepository.js');
const repository = require('../repositories/convertibleBondCycleServiceRepository.js');

const { toNumber, aggregateDaily, finalizeCycle, computePercentile, cycleLevel, LOOKBACK_DAYS, FORMULA_VERSION, UNIVERSE_VERSION, ANOMALY_REASONS } = cycle;

// 本地实现，避免与 convertibleBondAnalysis 形成循环依赖
function isoDate(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}
const CYCLE_SCOPE = 'convertible_bond_cycle';
const DATASET = 'cb_daily';
const PRIOR_LIMIT = LOOKBACK_DAYS - 1; // 窗口含当前日，历史取前 1259 个

// 批量解析 ts_code -> instrument_id（已有的直接取，缺失的批量建，避免逐条 SQL）
async function resolveInstruments(client, rows) {
  const codes = [...new Set((rows || []).map(r => String(r.ts_code).trim().toUpperCase()).filter(Boolean))];
  if (!codes.length) return new Map();
  const { rows: existing } = await repository.select_core_instruments([codes], client);
  const map = new Map(existing.map(r => [r.canonical_code, r.instrument_id]));
  const missing = codes.filter(c => !map.has(c));
  if (missing.length) {
    for (const code of missing) {
      const master = await ensureInstrumentIdentity({
        canonicalCode: code, name: code, assetClass: 'convertible_bond', market: 'CN',
        exchangeCode: code.endsWith('.SH') ? 'SSE' : 'SZSE', currencyCode: 'CNY', status: 'listed', companyName: null,
      }, client.query.bind(client));
      map.set(code, master.instrumentId);
    }
  }
  return map;
}

// 批量 UPSERT 周期原始事实 + 同步维护 market.daily_bars（同一份 cb_daily）
async function saveDailyFacts(client, tradeDate, sourceId, rows, instrumentMap) {
  const date = isoDate(tradeDate);
  if (!date) return;
  const prepared = [];
  for (const r of (rows || [])) {
    const code = String(r.ts_code).trim().toUpperCase();
    const id = instrumentMap.get(code);
    const close = toNumber(r.close);
    if (!id || close == null || close <= 0) continue; // 事实表 close>0 约束
    prepared.push({
      id, close,
      cbValue: toNumber(r.cb_value), cbOverRate: toNumber(r.cb_over_rate),
      bondValue: toNumber(r.bond_value), bondOverRate: toNumber(r.bond_over_rate),
      open: toNumber(r.open), high: toNumber(r.high), low: toNumber(r.low),
      vol: toNumber(r.vol), amount: toNumber(r.amount),
      raw: JSON.stringify(r),
    });
  }
  await repository.upsertDailyFacts({ date, sourceId, rows: prepared }, client);
}
// 取当前日之前、同公式版本+同样本池版本的有效综合估值（用于滚动分位），按时间倒序取前 PRIOR_LIMIT 个
async function fetchPriorComposites(client, formulaVersion, tradeDate, limit = PRIOR_LIMIT, universeVersion = UNIVERSE_VERSION) {
  const { rows } = await repository.select_analytics_convertible_bond_cycle_daily([formulaVersion, universeVersion, tradeDate, limit], client);
  return rows.map(r => r.composite_value);
}

// 原子写入当日周期聚合（质量不通过者由调用方决定不调用本函数）
/* upsertCycleDaily 已迁入 server/repositories/convertibleBondCycleServiceRepository.js */

// 游标只前进不后退（补历史空洞时不回拨），成功时清空失败记录
async function updateSyncCursor(client, tradeDate) {
  const d = isoDate(tradeDate);
  if (!d) return;
  await repository.insert_ops_sync_cursors([CYCLE_SCOPE, DATASET, d], client);
}

// 记录失败日期与原因（不改变 last_success_date，供下次续跑与排查）
async function recordCycleFailure(client, tradeDate, reason) {
  const d = isoDate(tradeDate) || '';
  await repository.insert_ops_sync_cursors_1([CYCLE_SCOPE, DATASET, `${d} ${reason}`.trim()], client);
}

/* getSyncCursor 已迁入 server/repositories/convertibleBondCycleServiceRepository.js */

// 处理单个交易日：过滤→聚合→（质量通过）写事实+滚动分位+聚合入库+更新游标
// 返回 { stored, failed, reason, metrics?, aggregate? }
// - failed=true（空数据/数据异常，如溢价率字段全缺、上游截断）：不写事实、不推进游标，需重试；
// - stored=false 且 failed=false（市场性低质量，如样本不足）：只存事实、推进游标、不发布指标；
// - stored=true：事实+聚合+游标全部落库。
async function processCycleDay(tradeDate, rows, { sourceId, client = pool } = {}) {
  if (!rows || !rows.length) return { stored: false, failed: true, reason: 'empty_rows' };
  const td = isoDate(tradeDate);
  if (!td) return { stored: false, failed: true, reason: 'invalid_trade_date' };
  const { metrics, quality } = aggregateDaily({ rows, tradeDate: td, sourceId });
  if (!quality.ok && ANOMALY_REASONS.includes(quality.reason)) {
    // 数据异常（价格有数据但溢价率全缺 / 上游行数达上限疑似截断）：当日不得标记成功
    return { stored: false, failed: true, reason: quality.reason, metrics };
  }
  const instrumentMap = await resolveInstruments(client, rows);
  await saveDailyFacts(client, td, sourceId, rows, instrumentMap);
  if (!quality.ok) {
    await updateSyncCursor(client, td);
    return { stored: false, failed: false, reason: quality.reason, metrics };
  }
  const prior = await fetchPriorComposites(client, FORMULA_VERSION, td);
  const full = finalizeCycle({ metrics }, prior);
  await upsertCycleDaily(client, full);
  await updateSyncCursor(client, td);
  return { stored: true, failed: false, aggregate: full };
}

// 按时间顺序重算全部滚动分位与周期档位（补空洞或历史修复后调用；同版本内计算）
async function recomputePercentiles({ client = pool, formulaVersion = FORMULA_VERSION, universeVersion = UNIVERSE_VERSION } = {}) {
  const { rows } = await repository.select_analytics_convertible_bond_cycle_daily_1([formulaVersion, universeVersion], client);
  const window = [];
  let updated = 0;
  for (const r of rows) {
    const prior = window.slice(-PRIOR_LIMIT);
    const q = computePercentile(r.composite_value, prior);
    await repository.update_analytics_convertible_bond_cycle_daily([q, cycleLevel(q), r.trade_date, formulaVersion, universeVersion], client);
    updated++;
    const v = toNumber(r.composite_value);
    if (v !== null) window.push(v);
  }
  return updated;
}

// 缺失日期扫描：在给定开市日中找出「空洞」——事实表无该日数据，
// 或该日样本数达标（>=100）但溢价率全为空（历史坏数据）。openDays 为 'YYYYMMDD' 数组。
async function findGapDays(openDays, { client = pool } = {}) {
  const days = (openDays || []).map(isoDate).filter(Boolean);
  if (!days.length) return [];
  const { rows } = await repository.select_unnest([days], client);
  return rows.map(r => r.day);
}

// ===== 只读查询（页面与接口使用，不访问 Tushare）=====

function rangeCutoff(range) {
  if (range === '1y') return shiftYears(1);
  if (range === '3y') return shiftYears(3);
  if (range === '5y') return shiftYears(5);
  return null; // all
}
function shiftYears(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

async function getLatestCycle(formulaVersion = FORMULA_VERSION, universeVersion = UNIVERSE_VERSION) {
  const { rows } = await repository.select_analytics_convertible_bond_cycle_daily_2([formulaVersion, universeVersion]);
  return rows[0] || null;
}

async function getCycleHistory(formulaVersion = FORMULA_VERSION, range = '5y', universeVersion = UNIVERSE_VERSION) {
  const cutoff = rangeCutoff(range);
  return repository.listCycleHistory(formulaVersion, universeVersion, cutoff);
}

/* getTushareSourceId 已迁入 server/repositories/convertibleBondCycleServiceRepository.js */

module.exports = {
  CYCLE_SCOPE,
  DATASET,
  resolveInstruments,
  saveDailyFacts,
  fetchPriorComposites,
  upsertCycleDaily,
  updateSyncCursor,
  recordCycleFailure,
  getSyncCursor,
  processCycleDay,
  recomputePercentiles,
  findGapDays,
  getLatestCycle,
  getCycleHistory,
  getTushareSourceId,
  rangeCutoff,
};
