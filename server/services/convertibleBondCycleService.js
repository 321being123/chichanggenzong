// 可转债周期：事实写入与聚合服务（数据库层）
// 职责：批量保存每日原始事实、聚合入库、历史查询、同步游标、失败保留。
// 不调用 Tushare（调用方传入 cb_daily 行）。
const { pool } = require('../db');
const cycle = require('./convertibleBondCycle');
const { ensureInstrumentIdentity } = require('./securityIdentity');

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
  const { rows: existing } = await client.query(
    'SELECT instrument_id, canonical_code FROM core.instruments WHERE canonical_code = ANY($1)', [codes]
  );
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
  const mParams = [], mVals = [];
  const bParams = [], bVals = [];
  for (const r of (rows || [])) {
    const code = String(r.ts_code).trim().toUpperCase();
    const id = instrumentMap.get(code);
    const close = toNumber(r.close);
    if (!id || close == null || close <= 0) continue; // 事实表 close>0 约束
    let n = mParams.length;
    mParams.push(id, date, sourceId, close, toNumber(r.cb_value), toNumber(r.cb_over_rate), toNumber(r.bond_value), toNumber(r.bond_over_rate), JSON.stringify(r));
    mVals.push(`($${n + 1},$${n + 2},$${n + 3},$${n + 4},$${n + 5},$${n + 6},$${n + 7},$${n + 8},$${n + 9})`);
    let m = bParams.length;
    bParams.push(id, date, sourceId, toNumber(r.open), toNumber(r.high), toNumber(r.low), close, toNumber(r.vol), toNumber(r.amount));
    bVals.push(`($${m + 1},$${m + 2},$${m + 3},$${m + 4},$${m + 5},$${m + 6},$${m + 7},$${m + 8},$${m + 9})`);
  }
  if (mVals.length) {
    await client.query(
      `INSERT INTO market.convertible_bond_daily_metrics
        (instrument_id,trade_date,source_id,close,conversion_value,conversion_premium_pct,bond_value,bond_premium_pct,raw_payload)
       VALUES ${mVals.join(',')}
       ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET
        close=EXCLUDED.close,conversion_value=EXCLUDED.conversion_value,conversion_premium_pct=EXCLUDED.conversion_premium_pct,
        bond_value=EXCLUDED.bond_value,bond_premium_pct=EXCLUDED.bond_premium_pct,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
      mParams
    );
  }
  if (bVals.length) {
    await client.query(
      `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
       VALUES ${bVals.join(',')}
       ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET
        open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`,
      bParams
    );
  }
}

// 取当前日之前、同公式版本+同样本池版本的有效综合估值（用于滚动分位），按时间倒序取前 PRIOR_LIMIT 个
async function fetchPriorComposites(client, formulaVersion, tradeDate, limit = PRIOR_LIMIT, universeVersion = UNIVERSE_VERSION) {
  const { rows } = await client.query(
    `SELECT composite_value FROM analytics.convertible_bond_cycle_daily
     WHERE formula_version=$1 AND universe_version=$2 AND trade_date < $3 AND composite_value IS NOT NULL
     ORDER BY trade_date DESC LIMIT $4`,
    [formulaVersion, universeVersion, tradeDate, limit]
  );
  return rows.map(r => r.composite_value);
}

// 原子写入当日周期聚合（质量不通过者由调用方决定不调用本函数）
async function upsertCycleDaily(client, row) {
  await client.query(
    `INSERT INTO analytics.convertible_bond_cycle_daily
      (trade_date,formula_version,universe_version,bond_count,premium_count,coverage_ratio,median_price,median_conversion_value,
       median_conversion_premium_pct,premium_weight,composite_value,rolling_percentile,cycle_level,source_id,diagnostics,calculated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
     ON CONFLICT(trade_date,formula_version,universe_version) DO UPDATE SET
      bond_count=EXCLUDED.bond_count,premium_count=EXCLUDED.premium_count,coverage_ratio=EXCLUDED.coverage_ratio,
      median_price=EXCLUDED.median_price,median_conversion_value=EXCLUDED.median_conversion_value,
      median_conversion_premium_pct=EXCLUDED.median_conversion_premium_pct,premium_weight=EXCLUDED.premium_weight,
      composite_value=EXCLUDED.composite_value,rolling_percentile=EXCLUDED.rolling_percentile,cycle_level=EXCLUDED.cycle_level,
      source_id=EXCLUDED.source_id,diagnostics=EXCLUDED.diagnostics,calculated_at=now()`,
    [row.trade_date, row.formula_version, row.universe_version, row.bond_count, row.premium_count, row.coverage_ratio,
     row.median_price, row.median_conversion_value, row.median_conversion_premium_pct, row.premium_weight, row.composite_value,
     row.rolling_percentile, row.cycle_level, row.source_id, JSON.stringify(row.diagnostics || {})]
  );
}

// 游标只前进不后退（补历史空洞时不回拨），成功时清空失败记录
async function updateSyncCursor(client, tradeDate) {
  const d = isoDate(tradeDate);
  if (!d) return;
  await client.query(
    `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
     VALUES($1,$2,$3,now(),now(),'',0,now())
     ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
      last_success_date=GREATEST(sync_cursors.last_success_date,EXCLUDED.last_success_date),
      last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`,
    [CYCLE_SCOPE, DATASET, d]
  );
}

// 记录失败日期与原因（不改变 last_success_date，供下次续跑与排查）
async function recordCycleFailure(client, tradeDate, reason) {
  const d = isoDate(tradeDate) || '';
  await client.query(
    `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
     VALUES($1,$2,NULL,now(),now(),$3,1,now())
     ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
      last_attempt_at=now(),last_error=EXCLUDED.last_error,retry_count=sync_cursors.retry_count+1,updated_at=now()`,
    [CYCLE_SCOPE, DATASET, `${d} ${reason}`.trim()]
  );
}

async function getSyncCursor() {
  const { rows } = await pool.query(
    "SELECT to_char(last_success_date,'YYYYMMDD') AS d FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code=$2", [CYCLE_SCOPE, DATASET]
  );
  return rows[0] ? rows[0].d : null;
}

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
  const { rows } = await client.query(
    `SELECT trade_date, composite_value FROM analytics.convertible_bond_cycle_daily
     WHERE formula_version=$1 AND universe_version=$2 ORDER BY trade_date ASC`,
    [formulaVersion, universeVersion]
  );
  const window = [];
  let updated = 0;
  for (const r of rows) {
    const prior = window.slice(-PRIOR_LIMIT);
    const q = computePercentile(r.composite_value, prior);
    await client.query(
      `UPDATE analytics.convertible_bond_cycle_daily SET rolling_percentile=$1, cycle_level=$2, calculated_at=now()
       WHERE trade_date=$3 AND formula_version=$4 AND universe_version=$5`,
      [q, cycleLevel(q), r.trade_date, formulaVersion, universeVersion]
    );
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
  const { rows } = await client.query(
    `SELECT to_char(d.day,'YYYYMMDD') AS day FROM unnest($1::date[]) AS d(day)
     LEFT JOIN (
       SELECT trade_date, count(*) AS c, count(conversion_premium_pct) AS p
       FROM market.convertible_bond_daily_metrics GROUP BY trade_date
     ) f ON f.trade_date = d.day
     WHERE f.trade_date IS NULL OR (f.c >= 100 AND f.p = 0)
     ORDER BY d.day`,
    [days]
  );
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
  const { rows } = await pool.query(
    `SELECT trade_date,formula_version,universe_version,bond_count,premium_count,coverage_ratio,
            median_price,median_conversion_value,median_conversion_premium_pct,premium_weight,
            composite_value,rolling_percentile,cycle_level,source_id,diagnostics,calculated_at
     FROM analytics.convertible_bond_cycle_daily WHERE formula_version=$1 AND universe_version=$2
     ORDER BY trade_date DESC LIMIT 1`,
    [formulaVersion, universeVersion]
  );
  return rows[0] || null;
}

async function getCycleHistory(formulaVersion = FORMULA_VERSION, range = '5y', universeVersion = UNIVERSE_VERSION) {
  const cutoff = rangeCutoff(range);
  const sql = `SELECT trade_date,cycle_level,rolling_percentile,composite_value,median_price,
                      median_conversion_premium_pct,median_conversion_value,premium_weight,bond_count,coverage_ratio
               FROM analytics.convertible_bond_cycle_daily WHERE formula_version=$1 AND universe_version=$2
               ${cutoff ? 'AND trade_date >= $3' : ''} ORDER BY trade_date ASC`;
  const params = cutoff ? [formulaVersion, universeVersion, cutoff] : [formulaVersion, universeVersion];
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getTushareSourceId(client = pool) {
  const { rows } = await client.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1");
  return rows[0] ? rows[0].source_id : null;
}

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
