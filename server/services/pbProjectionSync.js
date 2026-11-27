// PB 投影同步编排（2026-11-27）。
//
// 职责：把 6 类源表变动收敛为「整月重算」，不让任何调用方在应用层做 listed_days /
// exempt_days 的逐日加减。SQL 全部在 pbProjectionRepository，本文件 0 SQL。
//
// 触发面：
//   1) 日常估值入库        → syncValuations({ instrumentIds, dates })
//   2) 历史估值补录/修订/删除 → syncValuations / fullRebuild
//   3) market.trade_calendar → syncCalendarChange({ months })
//   4) market.stock_suspend_calendar → syncSuspendChange({ months })
//   5) core.instruments 主档/合并 → syncInstrumentChange({ instrumentIds })
//   6) ops.data_sources 变更 → detectDataSourceChange 标记 pending，fullRebuild 消费
//
// 读写隔离：所有写操作使用短事务；对账/回填按批提交并让出 I/O。
'use strict';

const { withTransaction } = require('../db/transaction');
const repository = require('../repositories/pbProjectionRepository');
const jobAlertMailer = require('./jobAlertMailer');
const { projectionReadEnabled } = require('../domain/pbProjectionConfig');

// 来源指纹按市场隔离：CN 的全量重建只更新 CN 水位，不能用 CN 指纹掩盖 HK 的来源变更。
const SOURCE_FINGERPRINT_SCOPE_PREFIX = 'pb_projection:source_fingerprint';
const RECONCILE_SCOPE = 'pb_projection:reconcile';
const RECONCILE_INTERVAL_DAYS = 7;
const PENDING_SCOPE_PREFIX = 'pb_projection:pending_full_rebuild:';
// 单次对账自动修复的安全上限：凌晨清理任务内逐月短事务，超过此数量只标记待全量重建。
const MAX_RECONCILE_REPAIR_MONTHS = 6;
const RECONCILE_REPAIR_SLEEP_MS = 60;

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

function marketScope(market) {
  return `pb_projection:${String(market || '').toUpperCase()}`;
}

function normalizeDates(dates) {
  return Array.from(new Set((dates || [])
    .map(value => String(value || '').slice(0, 10))
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))).sort();
}

function monthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function monthsEndingAt(endDate, count) {
  const date = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return [];
  const months = [];
  for (let index = 0; index < count; index += 1) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    months.push({ year, month });
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - 1);
  }
  return months.reverse();
}

function sourceFingerprintScope(market) {
  return `${SOURCE_FINGERPRINT_SCOPE_PREFIX}:${String(market || 'CN').toUpperCase()}`;
}

async function readSourceFingerprintState(market = 'CN', tx) {
  // 兼容旧签名 readSourceFingerprintState(tx)：未显式传市场时按 CN。
  if (market && typeof market === 'object') { tx = market; market = 'CN'; }
  const scopeKey = sourceFingerprintScope(market);
  const [current, cursor] = await Promise.all([
    repository.readDataSourceFingerprint(tx),
    repository.readLatestCursorValue({ scopeKey }, tx),
  ]);
  return {
    fingerprint: current.fingerprint,
    previous: cursor ? cursor.dataset_code : null,
    changed: !cursor || cursor.dataset_code !== current.fingerprint,
  };
}

async function rememberSourceFingerprint(market = 'CN', fingerprint, tx) {
  // 兼容旧签名 rememberSourceFingerprint(fingerprint, tx)：未显式传市场时按 CN。
  let targetMarket = market;
  let targetFingerprint = fingerprint;
  let targetTx = tx;
  if (typeof fingerprint !== 'string' && !['CN', 'HK'].includes(String(market || '').toUpperCase())) {
    targetTx = fingerprint;
    targetFingerprint = market;
    targetMarket = 'CN';
  }
  if (typeof targetFingerprint !== 'string' || !targetFingerprint) return;
  await repository.upsertCursorValue({
    scopeKey: sourceFingerprintScope(targetMarket), datasetCode: targetFingerprint,
  }, targetTx);
}

async function markPendingFullRebuild(market, reason, tx) {
  await repository.upsertCursorValue({
    scopeKey: `${PENDING_SCOPE_PREFIX}${String(market || '').toUpperCase()}`,
    datasetCode: String(reason || 'data_source_changed').slice(0, 200),
  }, tx);
}

async function readPendingFullRebuild(market, tx) {
  return repository.readLatestCursorValue({
    scopeKey: `${PENDING_SCOPE_PREFIX}${String(market || '').toUpperCase()}`,
  }, tx);
}

/**
 * 日常/历史估值写入后的同步。`dates` 只需传本次实际写入的交易日；
 * 受影响月份按这些日期所在自然月整月重算。
 *
 * 重要：不得用 min(dates)~max(dates) 生成连续月份。稀疏补录（例如只补 2016-01 与
 * 2026-01 两个点）必须只重算这两个月，绝不把中间 10 年做成一次全市场大事务。
 * 每个月独立短事务提交，并在月间让出 I/O。
 */
async function syncValuations({ market, dates, instrumentIds = null, tx = null, checkSource = true, sleepMs = 40 } = {}) {
  const list = normalizeDates(dates);
  if (!list.length) return { ok: true, skipped: 'no_dates', market };
  const byMonth = new Map();
  for (const date of list) {
    const key = date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(date);
  }
  const affectedMonths = Array.from(byMonth.keys()).sort().map(key => {
    const [year, month] = key.split('-').map(Number);
    return { year, month };
  });
  const runSourceCheck = async client => {
    if (!checkSource) return false;
    const source = await readSourceFingerprintState(market, client);
    if (source.changed) await markPendingFullRebuild(market, 'data_source_changed', client);
    return source.changed;
  };

  // 调用方已持有事务时保持同一事务语义（由调用方决定提交边界），但仍按实际月份拆分重建范围。
  if (tx) {
    const sourceChanged = await runSourceCheck(tx);
    const result = { picked: 0, marketDates: 0, summaries: 0, months: affectedMonths.length };
    for (const item of affectedMonths) {
      const monthDates = byMonth.get(`${item.year}-${String(item.month).padStart(2, '0')}`);
      const fromDate = monthDates[0];
      const toDate = monthDates[monthDates.length - 1];
      const part = await repository.rebuildProjectionRange({
        market, fromDate, toDate, months: [item], instrumentIds,
      }, tx);
      result.picked += Number(part.picked || 0);
      result.marketDates += Number(part.marketDates || 0);
      result.summaries += Number(part.summaries || 0);
      await repository.writeSyncCursor({
        scopeKey: marketScope(market), datasetCode: 'pb_projection', lastSuccessDate: toDate,
      }, tx);
    }
    return { ok: true, market, fromDate: list[0], toDate: list[list.length - 1], ...result, sourceChanged };
  }

  const sourceChanged = await withTransaction(client => runSourceCheck(client));
  const result = { picked: 0, marketDates: 0, summaries: 0, months: affectedMonths.length };
  for (const [index, item] of affectedMonths.entries()) {
    const monthDates = byMonth.get(`${item.year}-${String(item.month).padStart(2, '0')}`);
    const fromDate = monthDates[0];
    const toDate = monthDates[monthDates.length - 1];
    const part = await withTransaction(async client => {
      const value = await repository.rebuildProjectionRange({
        market, fromDate, toDate, months: [item], instrumentIds,
      }, client);
      await repository.writeSyncCursor({
        scopeKey: marketScope(market), datasetCode: 'pb_projection', lastSuccessDate: toDate,
      }, client);
      return value;
    });
    result.picked += Number(part.picked || 0);
    result.marketDates += Number(part.marketDates || 0);
    result.summaries += Number(part.summaries || 0);
    if (sleepMs > 0 && index < affectedMonths.length - 1) await sleep(sleepMs);
  }
  return { ok: true, market, fromDate: list[0], toDate: list[list.length - 1], ...result, sourceChanged };
}

/**
 * 兼容入口：摄取链路只关心「尽力同步」，投影失败不能回滚已经落库的标准事实。
 * 失败必须留日志并进入下一次 reconcile，不允许静默当作成功。
 */
async function safeSyncValuations(options = {}) {
  // 单测里大量服务被整体 mock；默认不在 test 环境触发真实连接，避免无关用例被数据库拖住。
  // 等价/集成测试需要真实同步时显式设置 PB_PROJECTION_SYNC_IN_TESTS=1 或直接调 syncValuations。
  if (process.env.NODE_ENV === 'test' && String(process.env.PB_PROJECTION_SYNC_IN_TESTS || '') !== '1') {
    return { ok: true, skipped: 'test_env', market: options.market };
  }
  try {
    return await syncValuations(options);
  } catch (error) {
    console.warn('[pbProjection] 估值同步失败，保留待对账重算：', error.message);
    return { ok: false, error: error.message, market: options.market };
  }
}

/** 交易日历变更：listed_days 依赖开市日，必须整月重算受影响月份。 */
async function syncCalendarChange({ market, months, tx = null } = {}) {
  const list = repository.uniqueMonthList(months);
  if (!list.length) return { ok: true, skipped: 'no_months', market };
  return withTransaction(async client => {
    let rows = 0;
    for (const item of list) {
      rows += await repository.rebuildMonthlySummaryMonth({
        market, year: item.year, month: item.month,
      }, client);
    }
    const last = list[list.length - 1];
    await repository.writeSyncCursor({
      scopeKey: marketScope(market), datasetCode: 'pb_projection',
      lastSuccessDate: monthRange(last.year, last.month).end,
    }, client);
    return { ok: true, market, months: list.length, rows };
  }, { tx });
}

/** 停牌日历变更：exempt_days 依赖停牌与当日 PB 的差集，同样整月重算。 */
async function syncSuspendChange({ market, months, tx = null } = {}) {
  return syncCalendarChange({ market, months, tx });
}

function testSkipSafeSync(kind, options) {
  if (process.env.NODE_ENV === 'test' && String(process.env.PB_PROJECTION_SYNC_IN_TESTS || '') !== '1') {
    return { ok: true, skipped: 'test_env', kind, market: options.market };
  }
  return null;
}

async function safeSyncCalendarChange(options = {}) {
  const skip = testSkipSafeSync('calendar', options);
  if (skip) return skip;
  try {
    return await syncCalendarChange(options);
  } catch (error) {
    console.warn('[pbProjection] 交易日历变更同步失败，保留待对账重算：', error.message);
    return { ok: false, error: error.message, market: options.market };
  }
}

async function safeSyncSuspendChange(options = {}) {
  const skip = testSkipSafeSync('suspend', options);
  if (skip) return skip;
  try {
    return await syncSuspendChange(options);
  } catch (error) {
    console.warn('[pbProjection] 停牌日历变更同步失败，保留待对账重算：', error.message);
    return { ok: false, error: error.message, market: options.market };
  }
}

async function safeSyncInstrumentChange(options = {}) {
  const skip = testSkipSafeSync('instrument', options);
  if (skip) return skip;
  try {
    return await syncInstrumentChange(options);
  } catch (error) {
    console.warn('[pbProjection] 证券主档变更同步失败，保留待对账重算：', error.message);
    return { ok: false, error: error.message, market: options.market };
  }
}

/**
 * 证券主档变更（list_date 纠错、市场/资产类别修正、证券合并）。
 * picked 与 market_pb_trade_dates 不受 list_date 影响，只重算受影响证券的月汇总。
 */
async function syncInstrumentChange({ market, instrumentIds, tx = null } = {}) {
  const ids = Array.isArray(instrumentIds) ? instrumentIds : [];
  if (!ids.length) return { ok: true, skipped: 'no_instruments', market };
  return withTransaction(async client => {
    const bounds = await repository.getInstrumentValuationBounds({ market, instrumentIds: ids }, client);
    const start = bounds.min_list_date && bounds.min_list_date < bounds.min_date ? bounds.min_list_date : bounds.min_date;
    if (!start || !bounds.max_date) return { ok: true, skipped: 'no_data', market };
    // 合并会把估值行搬到存续证券名下，必须重算 picked 与市场估值日；
    // 只改 list_date 时重算 picked 结果不变，代价可控。
    await repository.rebuildPickedRange({
      market, fromDate: bounds.min_date, toDate: bounds.max_date, instrumentIds: ids,
    }, client);
    await repository.rebuildMarketTradeDates({
      market, fromDate: bounds.min_date, toDate: bounds.max_date,
    }, client);
    const months = repository.monthsBetween(start, bounds.max_date);
    let rows = 0;
    for (const item of months) {
      rows += await repository.rebuildMonthlySummaryMonth({
        market, year: item.year, month: item.month, instrumentIds: ids,
      }, client);
    }
    const last = months[months.length - 1];
    await repository.writeSyncCursor({
      scopeKey: marketScope(market), datasetCode: 'pb_projection',
      lastSuccessDate: monthRange(last.year, last.month).end,
    }, client);
    return { ok: true, market, instruments: ids.length, months: months.length, rows };
  }, { tx });
}

/**
 * 按月分批全量重建（首次回填与选源规则变更共用）。
 * 每月独立短事务 + 游标持久化 + 批次间 sleep，断开可续跑，避免长事务拖 WAL。
 */
async function fullRebuild({ market, fromDate, toDate, sleepMs = 120, onProgress = null } = {}) {
  const months = repository.monthsBetween(fromDate, toDate);
  if (!months.length) return { ok: true, skipped: 'no_months', market };
  const bounds = await repository.getMarketValuationBounds({ market });
  // 只有覆盖该市场全部估值日期，才能证明选源指纹变化后的历史投影已整体重建。
  const fullRange = Boolean(bounds.min_date && bounds.max_date
    && fromDate <= bounds.min_date && toDate >= bounds.max_date);
  let rebuilt = 0;
  let lastMonth = null;
  for (const item of months) {
    const range = monthRange(item.year, item.month);
    const result = await withTransaction(async client => {
      const value = await repository.rebuildProjectionRange({
        market, fromDate: range.start, toDate: range.end, months: [item],
      }, client);
      await repository.writeSyncCursor({
        scopeKey: marketScope(market), datasetCode: 'pb_projection',
        lastSuccessDate: range.end,
      }, client);
      return value;
    });
    rebuilt += 1;
    lastMonth = item;
    if (typeof onProgress === 'function') onProgress({ market, month: item, rebuilt, total: months.length, result });
    if (sleepMs > 0 && rebuilt < months.length) await sleep(sleepMs);
  }
  if (fullRange) {
    const source = await readSourceFingerprintState(market);
    if (source.fingerprint) await rememberSourceFingerprint(market, source.fingerprint);
    await repository.deleteCursorScope({
      scopeKey: `${PENDING_SCOPE_PREFIX}${String(market || '').toUpperCase()}`,
    });
  }
  return { ok: true, market, months: months.length, lastMonth, fullRange };
}

/** 消费 6 类触发面留下的待全量重建标记；没有标记时为空操作。 */
async function runPendingFullRebuilds({ markets = ['CN', 'HK'], sleepMs = 120 } = {}) {
  const results = [];
  for (const market of markets) {
    const pending = await readPendingFullRebuild(market);
    if (!pending) continue;
    const bounds = await repository.getMarketValuationBounds({ market });
    if (!bounds.min_date || !bounds.max_date) continue;
    const result = await fullRebuild({
      market, fromDate: bounds.min_date, toDate: bounds.max_date, sleepMs,
    });
    results.push({ market, reason: pending.dataset_code, ...result });
  }
  return results;
}

const NUMERIC_FIELDS = new Set([
  'listed_days', 'exempt_days', 'covered_days', 'observed_days', 'non_positive_days', 'invalid_days',
  'max_pb', 'max_positive_pb', 'min_positive_pb', 'series_rows',
]);
const DATE_FIELDS = new Set(['min_pb_date', 'max_pb_date', 'effective_start']);
const SUMMARY_FIELDS = [
  'listed_days', 'exempt_days', 'covered_days', 'observed_days', 'non_positive_days', 'invalid_days',
  'max_pb', 'max_positive_pb', 'min_positive_pb', 'min_pb_date', 'max_pb_date', 'effective_start',
  'series_digest', 'series_rows',
];

function normalizeField(field, value) {
  if (value === undefined || value === null || value === '') return null;
  if (DATE_FIELDS.has(field)) return String(value).slice(0, 10);
  if (field === 'series_digest') return String(BigInt(String(value)));
  if (NUMERIC_FIELDS.has(field)) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(10) : String(value);
  }
  return String(value);
}

function compareRecords(raw, projected) {
  const diffs = [];
  for (const field of SUMMARY_FIELDS) {
    const left = normalizeField(field, raw ? raw[field] : null);
    const right = normalizeField(field, projected ? projected[field] : null);
    if (left !== right) diffs.push({ field, raw: left, projected: right });
  }
  return diffs;
}

function recordKey(row) {
  return `${row.instrument_id}:${row.cal_year}-${String(row.cal_month).padStart(2, '0')}`;
}

function pickedKey(row) {
  return `${row.instrument_id}:${row.trade_date}`;
}

function marketDateKey(row) {
  return String(row.trade_date).slice(0, 10);
}

/**
 * 逐月短事务修复：每修 1 个月提交 1 次，并在月间 sleep 让出 I/O。
 * 禁止把全部脏月份塞进同一个大事务——凌晨清理任务不能长期占用连接与 WAL。
 */
async function repairDirtyMonths({ market, monthKeys, sleepMs = RECONCILE_REPAIR_SLEEP_MS } = {}) {
  const keys = Array.from(new Set(monthKeys || [])).sort();
  for (const [index, key] of keys.entries()) {
    const [year, month] = key.split('-').map(Number);
    const range = monthRange(year, month);
    await withTransaction(async client => {
      await repository.rebuildProjectionRange({
        market, fromDate: range.start, toDate: range.end, months: [{ year, month }],
      }, client);
    });
    if (sleepMs > 0 && index < keys.length - 1) await sleep(sleepMs);
  }
  return keys.length;
}

/**
 * 每周抽样对账：按市场抽 20 只跨 10 年 + 最新完整月全量，逐字段比对原始口径。
 * diff > 0 时记录告警并标脏重算；通过水位写入 ops.sync_cursors。
 * 非生产环境默认跳过；可由 options.force 或 PB_PROJECTION_RECONCILE_ENABLED=1 显式执行。
 * instrumentIds/latestMonth/monthList 仅用于隔离库确定性回归（把抽样、最新月与月份范围
 * 收窄到夹具），生产周任务不传这些参数，仍按市场全量抽样。
 */
async function reconcilePbProjectionSample({ markets = ['CN', 'HK'], sampleSize = 20, years = 10, force = false, enabled = null, instrumentIds = null, latestMonth = null, monthList = null } = {}) {
  // 调用方可显式传 enabled（storageRetention 按运行环境决定）；直接调用时仍保留
  // force 或 PB_PROJECTION_RECONCILE_ENABLED=1 的显式入口，避免在开发/测试环境误扫全库。
  const active = Boolean(force) || enabled === true
    || (enabled === null && String(process.env.PB_PROJECTION_RECONCILE_ENABLED || '') === '1');
  if (!active) {
    return { ok: true, skipped: true, reason: 'reconcile_disabled', at: todayShanghai() };
  }
  const scopedIds = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite))) : null;
  const cursor = await repository.readSyncCursor({ scopeKey: RECONCILE_SCOPE, datasetCode: 'pb_projection' });
  if (!force && cursor && cursor.last_success_date) {
    const last = new Date(`${cursor.last_success_date}T00:00:00Z`).getTime();
    if (Number.isFinite(last) && Date.now() - last < RECONCILE_INTERVAL_DAYS * 86400000) {
      return { ok: true, skipped: true, reason: 'reconcile_not_due', lastSuccess: cursor.last_success_date };
    }
  }

  const report = { ok: true, at: todayShanghai(), markets: {}, diffCount: 0, repairedMonths: 0 };
  for (const market of markets) {
    // 未完成首次回填时绝不自动触发全库 120 个月重建：凌晨对账只负责发现漂移，
    // 不能把"投影还没回填"误判成"整库都脏"。
    const initialized = await repository.projectionInitialized({ market, instrumentIds: scopedIds });
    if (!initialized.summaryRows || !initialized.hasCursor) {
      report.markets[market] = {
        checked: 0, diffCount: 0, skipped: 'projection_not_initialized',
        summaryRows: initialized.summaryRows, hasCursor: initialized.hasCursor,
      };
      continue;
    }
    const sampleIds = scopedIds || await repository.sampleInstrumentIds({ market, limit: sampleSize, years });
    if (!sampleIds.length) {
      report.markets[market] = { checked: 0, diffCount: 0, skipped: 'no_sample' };
      continue;
    }
    const latest = latestMonth || await repository.latestCompleteMonth({ market });
    if (!latest) {
      report.markets[market] = { checked: 0, diffCount: 0, skipped: 'no_complete_month' };
      continue;
    }
    const latestEnd = monthRange(latest.year, latest.month).end;
    const months = Array.isArray(monthList) && monthList.length
      ? monthList
      : monthsEndingAt(latestEnd, Math.max(Number(years) || 10, 1) * 12);
    const [rawRows, projectedRows] = await Promise.all([
      repository.loadRawMonthlyAggregates({ market, months, instrumentIds: sampleIds }),
      repository.loadProjectedMonthlyRows({ market, months, instrumentIds: sampleIds }),
    ]);
    const rawMap = new Map(rawRows.map(row => [recordKey(row), row]));
    const projectedMap = new Map(projectedRows.map(row => [recordKey(row), row]));
    const keys = new Set([...rawMap.keys(), ...projectedMap.keys()]);
    const diffs = [];
    const dirty = new Set();
    for (const key of keys) {
      const item = compareRecords(rawMap.get(key), projectedMap.get(key));
      if (item.length) {
        diffs.push({ key, diffs: item });
        const [, ym] = key.split(':');
        dirty.add(ym);
      }
    }

    // 最新完整月全市场：不只抽样 20 只，确保该月所有证券的 15 项汇总都能被发现漂移。
    // 这是周度对账最重的一段（约 5,700 行/市场），但只针对一个月，成本可控。
    const [rawLatest, projectedLatest] = await Promise.all([
      repository.loadRawMonthlyAggregates({ market, months: [{ year: latest.year, month: latest.month }], instrumentIds: scopedIds ? sampleIds : null }),
      repository.loadProjectedMonthlyRows({ market, months: [{ year: latest.year, month: latest.month }], instrumentIds: scopedIds ? sampleIds : null }),
    ]);
    const rawLatestMap = new Map(rawLatest.map(row => [recordKey(row), row]));
    const projectedLatestMap = new Map(projectedLatest.map(row => [recordKey(row), row]));
    for (const key of new Set([...rawLatestMap.keys(), ...projectedLatestMap.keys()])) {
      const item = compareRecords(rawLatestMap.get(key), projectedLatestMap.get(key));
      if (item.length) {
        diffs.push({ key: `latest:${key}`, diffs: item });
        dirty.add(`${latest.year}-${String(latest.month).padStart(2, '0')}`);
      }
    }

    // 明细选源与市场估值日也做窗口级抽样（最新完整月），防止 summary 正确但底层选源漂移。
    const range = monthRange(latest.year, latest.month);
    const [rawPicked, projectedPicked, rawDates, projectedDates] = await Promise.all([
      repository.loadRawPickedRange({ market, fromDate: range.start, toDate: range.end, instrumentIds: sampleIds }),
      repository.loadProjectedPickedRange({ market, fromDate: range.start, toDate: range.end, instrumentIds: sampleIds }),
      scopedIds ? [] : repository.loadRawMarketDates({ market, fromDate: range.start, toDate: range.end }),
      scopedIds ? [] : repository.loadProjectedMarketDates({ market, fromDate: range.start, toDate: range.end }),
    ]);
    const rawPickedMap = new Map(rawPicked.map(row => [pickedKey(row), row]));
    const projectedPickedMap = new Map(projectedPicked.map(row => [pickedKey(row), row]));
    for (const key of new Set([...rawPickedMap.keys(), ...projectedPickedMap.keys()])) {
      const left = rawPickedMap.get(key);
      const right = projectedPickedMap.get(key);
      const same = left && right
        && String(left.pb) === String(right.pb)
        && Number(left.source_id) === Number(right.source_id);
      if (!same) {
        diffs.push({ key: `picked:${key}`, diffs: [{ field: 'picked', raw: left || null, projected: right || null }] });
        dirty.add(`${latest.year}-${String(latest.month).padStart(2, '0')}`);
      }
    }
    const rawDateMap = new Map(rawDates.map(row => [marketDateKey(row), row]));
    const projectedDateMap = new Map(projectedDates.map(row => [marketDateKey(row), row]));
    for (const key of new Set([...rawDateMap.keys(), ...projectedDateMap.keys()])) {
      const left = rawDateMap.get(key);
      const right = projectedDateMap.get(key);
      if (!left || !right || Number(left.instrument_count) !== Number(right.instrument_count)) {
        diffs.push({ key: `market_date:${key}`, diffs: [{ field: 'market_date', raw: left || null, projected: right || null }] });
        dirty.add(`${latest.year}-${String(latest.month).padStart(2, '0')}`);
      }
    }

    if (dirty.size) {
      report.diffCount += diffs.length;
      const dirtyMonths = Array.from(dirty).sort();
      const pendingFullRebuild = dirtyMonths.length > MAX_RECONCILE_REPAIR_MONTHS;
      let repaired = 0;
      if (pendingFullRebuild) {
        // 超过安全上限时不在凌晨清理任务里连续修几十个月，只标记待全量重建并告警。
        await markPendingFullRebuild(market, 'reconcile_dirty_months_exceeded');
      } else {
        repaired = await repairDirtyMonths({ market, monthKeys: dirtyMonths });
        report.repairedMonths += repaired;
      }
      try {
        await jobAlertMailer.sendAlert({
          alertKey: `pb_projection_reconcile:${market}`,
          alertType: 'data_quality',
          severity: 'warning',
          jobCode: 'storage_retention',
          subject: `PB 投影抽样对账发现 ${diffs.length} 项差异（${market}）`,
          summary: `市场 ${market} 抽样 ${sampleIds.length} 只、${months.length} 个月；差异 ${diffs.length} 项，`
            + (pendingFullRebuild
              ? `脏月 ${dirtyMonths.length} 个超过单次自动修复上限 ${MAX_RECONCILE_REPAIR_MONTHS}，已标记 pending_full_rebuild，等待全量重建。`
              : `已逐月标脏重算 ${repaired} 个月。`)
            + `前 10 项：${JSON.stringify(diffs.slice(0, 10))}`,
        });
      } catch (error) {
        console.warn('[pbProjection] 对账告警记录失败：', error.message);
      }
      report.markets[market] = {
        checked: keys.size,
        latestChecked: rawLatestMap.size,
        pickedChecked: rawPicked.length,
        diffCount: diffs.length,
        repairedMonths: repaired,
        dirtyMonths: dirtyMonths.length,
        pendingFullRebuild,
        samples: diffs.slice(0, 20),
      };
      continue;
    }
    report.markets[market] = {
      checked: keys.size,
      latestChecked: rawLatestMap.size,
      pickedChecked: rawPicked.length,
      diffCount: diffs.length,
      repairedMonths: 0,
      samples: diffs.slice(0, 20),
    };
  }
  // 有市场尚未回填时不推进对账水位：回填完成后应能立即重新对账，
  // 不能被一次"跳过"再压 7 天。
  const uninitialized = Object.values(report.markets)
    .some(item => item && item.skipped === 'projection_not_initialized');
  if (uninitialized) {
    report.lastSuccessCursorSkipped = true;
    report.reason = 'projection_not_initialized';
    if (markets.every(market => report.markets[market] && report.markets[market].skipped === 'projection_not_initialized')) {
      report.skipped = 'projection_not_initialized';
    }
    return report;
  }
  await repository.writeSyncCursor({
    scopeKey: RECONCILE_SCOPE, datasetCode: 'pb_projection',
    lastSuccessDate: report.at,
  });
  return report;
}

module.exports = {
  projectionReadEnabled,
  todayShanghai,
  monthRange,
  monthsEndingAt,
  syncValuations,
  safeSyncValuations,
  syncCalendarChange,
  safeSyncCalendarChange,
  syncSuspendChange,
  safeSyncSuspendChange,
  syncInstrumentChange,
  safeSyncInstrumentChange,
  fullRebuild,
  runPendingFullRebuilds,
  reconcilePbProjectionSample,
  readSourceFingerprintState,
  rememberSourceFingerprint,
  sourceFingerprintScope,
  markPendingFullRebuild,
  SOURCE_FINGERPRINT_SCOPE: SOURCE_FINGERPRINT_SCOPE_PREFIX,
  SOURCE_FINGERPRINT_SCOPE_PREFIX,
  RECONCILE_SCOPE,
  MAX_RECONCILE_REPAIR_MONTHS,
  PENDING_SCOPE_PREFIX,
};
