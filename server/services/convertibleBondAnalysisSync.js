const layerSql = require('../repositories/convertibleBondAnalysisSyncRepository');
// 转债宇宙同步、回补与公告处理
// R-10 拆分自 ./convertibleBondAnalysis.js（2026-10-21）：本文件只放转债宇宙同步、回补与公告处理；对外入口仍是 ./convertibleBondAnalysis.js。
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { tushareQuery, tsRows, tsDateStr } = require('./market');
const { TushareRequestError } = require('./tushare');
const { fetchTencentQuotes, describeTencentCode } = require('./tencentQuote');
const repository = require('../repositories/convertibleBondAnalysisSyncRepository.js');
const { fetchCninfoEvents, fetchCninfoEventsByYear, fetchSseLatestReport, fetchSseEvents, fetchSzseEvents, fetchSzseLatestReport,
  fetchSseEventsBatch, fetchSzseEventsBatch, fetchCninfoEventsBatch, fetchTushareAnnouncementBatch } = require('./stockAnalysis');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cycleService = require('./convertibleBondCycleService');
const { evaluateConvertibleBondFreshness, CONV_PRICE_EPS } = require('./analysisFreshness');
const { datasetScope, getDatasetCursors, isDatasetFresh, markDatasetSuccess,
  recordQualityIssue, resolveQualityIssue } = require('./datasetCursors');
const { publishDatasetPartition } = require('./datasetPartitions');
const {
  mergeDateRanges,
  findSuspensionCoverageGaps,
  publishSuspensionCoverage,
  markSuspensionCoverageStale,
  syncSuspensionIntervals,
} = require('./convertibleBondSuspensionSync');
const { resolveCanonicalCode, ensureInstrumentIdentity } = require('./securityIdentity');
const { childProcessEnv, mergeExternalCallStatsFromStderr } = require('./externalCallGuard');
const { sendAlert } = require('./jobAlertMailer');
const { isActiveBond, isPendingListingBond, filterPublicBonds } = require('./bondSafetyTushare');
const { ANNOUNCEMENT_OVERLAP_DAYS, BOND_FIRSTDAY_SCRIPT, BOND_GAP_QUEUE_SCHEMA_VERSION, BOND_ISSUE_RESULT_SCRIPT, BOND_LIQUIDITY_SCRIPT, CN_OFFSET_MS, DAILY_FIELDS, FORMULA_VERSION, PROFILE_FIELDS, STOCK_STATUS_FIELDS, UNIFIED_ANNOUNCEMENT_KEYWORDS, addDays, defaultBondTargetTradeDate, finite, isoDate, normalizeBondCode, revisionDecision } = require('./convertibleBondAnalysisCore.js');
const { announcementSourceId, announcementSourceKey, backfillMissingRatings, ensureStockUniverse, extractNoRevisionPeriods, extractPriceChangeDetails, loadNoRevisionCache, loadPriceChangeCache, loadRevisionEventCache, loadTrackedDelistedStocks, pythonCandidates, saveDailyBar, saveFullStockMarketPartition, saveProfile, saveRevisionEvents, sourceIds } = require('./convertibleBondAnalysisStore.js');
const txControl = require('../repositories/transactionControl');

function announcementMatchesBond(event, profile) {
  const title = String(event.title || ''), name = String(profile.bond_short_name || '');
  const numbered = name.match(/^(.*)转\d+$/);
  if (numbered && title.includes(`${numbered[1]}转债`) && !title.includes(name)) return false;
  return (name && title.includes(name)) || title.includes(String(profile.ts_code || '').slice(0,6)) || /可转换公司债券|可转债|转债/.test(title);
}

function announcementDateWindows(startDate, endDate) {
  const end = isoDate(endDate);
  const start = isoDate(startDate) || end;
  if (!start || !end || start > end) return [];
  const windows = [];
  let cursor = new Date(`${start}T00:00:00+08:00`);
  while (isoDate(cursor) <= end) {
    const yearEnd = `${isoDate(cursor).slice(0, 4)}-12-31`;
    const windowEnd = yearEnd < end ? yearEnd : end;
    windows.push({ start: isoDate(cursor), end: windowEnd });
    cursor = addDays(new Date(`${windowEnd}T00:00:00+08:00`), 1);
  }
  return windows;
}

function uniqueAnnouncementEvents(events) {
  return [...new Map((events || []).map(event => [announcementSourceKey(event), event])).values()];
}

function revisionAnnouncementEvents(events) {
  return uniqueAnnouncementEvents(events).filter(event => /转股价格|转股价|下修|不向下修正|不下修/.test(String(event.title || '').replace(/\s+/g, '')));
}

function relevantConvertibleBondAnnouncements(events) {
  return uniqueAnnouncementEvents(events).filter(event => {
    const title = String(event.title || '').replace(/\s+/g, '');
    return /(?:可转债|可转换公司债券|转股价|下修|赎回|强赎|停止交易|到期兑付)/.test(title);
  });
}

function matchesUnassignedAnnouncement(event, profile) {
  const title = String(event && event.title || ''), name = String(profile && profile.bond_short_name || '');
  const numbered = name.match(/^(.*)转\d+$/);
  if (numbered && title.includes(`${numbered[1]}转债`) && !title.includes(name)) return false;
  return (name && title.includes(name))
    || title.includes(String(profile && profile.ts_code || '').slice(0, 6))
    || title.includes(String(profile && profile.stock_code || '').slice(0, 6));
}

async function collectAnnouncementSource(fetcher, windows, keywords, { maxAttempts = 2 } = {}) {
  const events = [], failures = [];
  for (const window of windows) {
    for (const keyword of keywords) {
      let completed = false;
      let lastFailure = '';
      // 交易所偶发短页、重复页或网关超时时只重试一次；仍不完整就保留游标，避免静默漏公告。
      const attempts = Math.max(2, Math.min(Number(maxAttempts) || 2, 6));
      for (let attempt = 1; attempt <= attempts && !completed; attempt += 1) {
        let retryDelayMs = 250;
        try {
          const result = await fetcher(window.start, window.end, keyword);
          events.push(...(result && result.events || []));
          if (!result || result.complete !== false) {
            completed = true;
          } else {
            lastFailure = '分页未完整';
          }
        } catch (error) {
          lastFailure = String(error && error.message || error).slice(0, 180);
          if (error && error.code === 'BUDGET_WAIT' && error.budgetWindow === 'concurrency') {
            const recoverDelay = error.recoverAt ? new Date(error.recoverAt).getTime() - Date.now() : 0;
            retryDelayMs = Math.max(1000, Math.min(10000, recoverDelay + 250), attempt * 2000);
          }
          // 熔断/权限类错误不会因立即重试恢复，直接交给备源和游标重试处理。
          if (error && ['CIRCUIT_OPEN', 'AUTH_ERROR', 'PERMISSION_DENIED'].includes(error.code)) break;
        }
        if (!completed && attempt < attempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
      if (!completed) {
        failures.push(`${window.start}~${window.end}/${keyword || 'all'}:${lastFailure || '批量源未返回完整结果'}（已重试${attempts - 1}次）`);
      }
    }
  }
  return { events: uniqueAnnouncementEvents(events), failures };
}

async function collectConvertibleBondAnnouncementMarket(market, startDate, endDate,
  { allowFallback = true, guardRetryAttempts = 2 } = {}) {
  const windows = announcementDateWindows(startDate, endDate);
  const primaryFetcher = market === 'SH' ? fetchSseEventsBatch : fetchSzseEventsBatch;
  const keywords = market === 'SZ' ? [''] : UNIFIED_ANNOUNCEMENT_KEYWORDS;
  const primary = await collectAnnouncementSource(primaryFetcher, windows, keywords, { maxAttempts: guardRetryAttempts });
  if (!primary.failures.length) return { events: relevantConvertibleBondAnnouncements(primary.events), failed: false, messages: [] };

  // 交易所主源失败或分页不完整时，保留已取得的结果并自动切换巨潮；
  // 只有巨潮也失败/分页不完整，才把本轮标记为失败并保留游标重试。
  const exchangeEvents = relevantConvertibleBondAnnouncements(primary.events);
  if (!allowFallback) {
    return {
      events: exchangeEvents,
      failed: true,
      messages: primary.failures.map(message => `交易所主源:${message}`).slice(0, 6),
    };
  }
  const cninfo = await collectAnnouncementSource(
    (windowStart, windowEnd, keyword) => fetchCninfoEventsBatch(windowStart, windowEnd, market, keyword),
    windows,
    keywords
  );
  const officialEvents = relevantConvertibleBondAnnouncements([...exchangeEvents, ...cninfo.events]);
  if (!cninfo.failures.length) return { events: officialEvents, failed: false, messages: [] };

  // anns_d 需要单独权限，默认关闭；仅在管理员显式开启时作为独立的最后备源。
  if (/^(1|true|yes)$/i.test(String(process.env.ANNOUNCEMENT_TUSHARE_FALLBACK || ''))) {
    const tushare = await collectAnnouncementSource(fetchTushareAnnouncementBatch, windows, ['']);
    const all = relevantConvertibleBondAnnouncements([...officialEvents, ...tushare.events]);
    if (!tushare.failures.length) return { events: all, failed: false, messages: [] };
    return { events: all, failed: true, messages: [...primary.failures.map(message => `交易所主源:${message}`),
      ...cninfo.failures.map(message => `CNINFO备源:${message}`), ...tushare.failures.map(message => `Tushare备源:${message}`)].slice(0, 6) };
  }
  return { events: officialEvents, failed: true, messages: [...primary.failures.map(message => `交易所主源:${message}`),
    ...cninfo.failures.map(message => `CNINFO备源:${message}`)].slice(0, 6) };
}

function eventsForAnnouncementProfile(events, profile, startDate) {
  const start = isoDate(startDate);
  return (events || []).filter(event => {
    const eventDate = isoDate(event.event_date);
    if (!eventDate || (start && eventDate < start)) return false;
    if (event.stock_code && profile.stock_code) return event.stock_code === profile.stock_code;
    return matchesUnassignedAnnouncement(event, profile);
  });
}

async function saveAnnouncementHistories(client, instrumentId, events, profile, sourceId, noRevisionPeriods = [], priceChangeDetails = [], sources = null) {
  const matched = [...new Map((events || []).map(event => [announcementSourceKey(event), event])).values()]
    .filter(event => announcementMatchesBond(event, profile));
  const periodMap = new Map(noRevisionPeriods.map(row => [isoDate(row.announced_at), row]));
  const priceMap = new Map(priceChangeDetails.map(row => [row.source_url, row]));
  await repository.delete_fundamental_convertible_bond_price_changes([instrumentId, sourceId], client);
  for (const event of matched) {
    const title = String(event.title || ''), announced = isoDate(event.event_date);
    if (!announced) continue;
    const eventSourceId = announcementSourceId(event, sources, sourceId);
    const decision = revisionDecision(title);
    const period = periodMap.get(announced) || {};
    if (decision === 'no_revision' || period.lock_declared) {
      await repository.insert_fundamental_convertible_bond_no_revision_history([instrumentId, announced, isoDate(period.valid_until), isoDate(period.next_eligible_date), title, eventSourceId,
          JSON.stringify(Object.assign({}, event, {
            lock_start_date: period.lock_start_date || null,
            lock_declared: Boolean(period.lock_declared),
            no_revision_evidence: Boolean(period.no_revision_evidence),
            parser_version: period.parser_version || null,
            symbolic_lock: Boolean(period.symbolic_lock),
            symbolic_reference_type: period.symbolic_reference_type || null,
            symbolic_report_period: period.symbolic_report_period || null,
            symbolic_check_from: period.symbolic_check_from || null,
            symbolic_resolution_status: period.symbolic_resolution_status || (period.symbolic_reference_type ? 'pending' : null),
          }))], client);
    }
    if (decision === 'revised' || decision === 'adjusted') {
      const detail = priceMap.get(event.url) || {};
      if (finite(detail.price_before) == null && finite(detail.price_after) == null) continue;
      const changeDate = isoDate(detail.change_date) || announced;
      await repository.insert_fundamental_convertible_bond_price_changes([instrumentId, announced, changeDate, finite(detail.price_before), finite(detail.price_after), title, eventSourceId,
          JSON.stringify(Object.assign({}, event, {
            revision_floor_price: finite(detail.revision_floor_price),
            price_change_parser_version: detail.parser_version || '3',
          }))], client);
    }
  }
}

async function saveTriggerProgress(client, instrumentId, tradeDate, progresses) {
  for (const [type, progress] of Object.entries(progresses)) {
    await repository.insert_analytics_convertible_bond_trigger_daily([instrumentId, isoDate(tradeDate), type, progress.trigger_price, progress.close_price, progress.matched_days,
        progress.required_days, progress.observation_days, progress.active === false ? 'not_active' : (progress.met ? 'met' : 'tracking'),
        FORMULA_VERSION, JSON.stringify(progress)], client);
  }
}

async function latestTradeDates(endTradeDate = defaultBondTargetTradeDate()) {
  const normalizedEnd = isoDate(endTradeDate) || defaultBondTargetTradeDate();
  const end = normalizedEnd.replace(/-/g, '');
  const start = addDays(new Date(`${normalizedEnd}T00:00:00+08:00`), -20);
  const data = await tushareQuery('trade_cal', { exchange: 'SSE', start_date: tsDateStr(start), end_date: end, is_open: '1' }, 'cal_date,is_open');
  return tsRows(data).filter(row => String(row.is_open) === '1').map(row => row.cal_date).sort().reverse();
}

async function latestFullBondDaily(dates, options = {}) {
  const query = options.query || tushareQuery;
  const activeCodes = options.activeCodes instanceof Set ? options.activeCodes : null;
  const expectedBondCount = Number(options.expectedBondCount || 0);
  const minimumPriced = expectedBondCount > 0 ? Math.min(expectedBondCount, Math.max(100, Math.ceil(expectedBondCount * 0.8))) : 1;
  const diagnostics = [];
  const targetOnly = options.targetOnly === true || options.targetTradeDate != null;
  for (const tradeDate of dates.slice(0, targetOnly ? 1 : 5)) {
    let data;
    try {
      // 空数据是“这一天尚未发布”，不是 Token 或权限错误；允许继续回看前一交易日。
      data = await query('cb_daily', { trade_date: tradeDate }, DAILY_FIELDS, { allowEmpty: true });
    } catch (error) {
      if (error && (error.code === 'EMPTY_DATA' || error.errorType === 'empty_data')) {
        diagnostics.push({ tradeDate, status: 'empty', rawRows: 0, pricedRows: 0, completeRows: 0 });
        continue;
      }
      throw error;
    }
    const rows = tsRows(data);
    if (!rows.length) {
      diagnostics.push({ tradeDate, status: 'empty', rawRows: 0, pricedRows: 0, completeRows: 0 });
      continue;
    }
    const candidateRows = activeCodes ? rows.filter(row => activeCodes.has(row.ts_code)) : rows;
    // Tushare 可能先发布收盘价，稍后才补齐转股价值/纯债价值。
    // 估值链路依赖这两个字段，未达到 80% 完整度的日期不能当作“最新完整行情”入库，继续回看上一交易日。
    const priced = candidateRows.filter(row => finite(row.close) > 0);
    const complete = priced.filter(row => finite(row.cb_value) > 0 && finite(row.bond_value) > 0);
    const coverage = expectedBondCount > 0 ? priced.length / expectedBondCount : null;
    const derivedCoverage = priced.length ? complete.length / priced.length : 0;
    const diagnostic = {
      tradeDate,
      status: targetOnly
        ? (priced.length ? 'partial' : 'incomplete')
        : (priced.length >= minimumPriced && derivedCoverage >= 0.8 ? 'usable' : 'incomplete'),
      rawRows: rows.length,
      pricedRows: priced.length,
      completeRows: complete.length,
      coverage: coverage == null ? null : Number(coverage.toFixed(4)),
      derivedCoverage: Number(derivedCoverage.toFixed(4)),
    };
    diagnostics.push(diagnostic);
    if (diagnostic.status === 'usable' || (targetOnly && diagnostic.status === 'partial')) {
      return { tradeDate, rows, diagnostics, coverage: diagnostic };
    }
  }
  return { tradeDate: null, rows: [], diagnostics, reason: diagnostics.some(item => item.status === 'incomplete') ? 'incomplete_data' : 'no_data' };
}

function bondGapQueueHash(codes) {
  return crypto.createHash('sha256').update([...new Set(codes || [])].sort().join('|')).digest('hex');
}

function addCalendarDays(value, days) {
  const date = new Date(`${isoDate(value)}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + Number(days || 0));
  return isoDate(date);
}

function addTradingDays(value, days) {
  const text = isoDate(value);
  const date = text ? new Date(`${text}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  let remaining = Math.max(0, Number(days) || 0);
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

function classifyBondObjectStatus({ row, lifecycleActive = true, sourceAvailable = true } = {}) {
  if (!lifecycleActive) return 'not_applicable';
  if (row && finite(row.close) > 0) return 'priced';
  if (!sourceAvailable) return 'source_unavailable';
  // 只有目标日 cb_daily 自身带出的债券成交量/金额均为 0，才认定为债券级无成交证据；
  // 正股 suspend_d 不参与该判定。
  if (row && isoDate(row.trade_date) && finite(row.vol) === 0 && finite(row.amount) === 0) return 'verified_no_trade';
  return 'retryable_missing';
}

function buildBondGapQueue({ targetTradeDate, expectedCodes, missingCodes, previous = {} } = {}) {
  const now = new Date().toISOString();
  const expectedSet = new Set(expectedCodes || []);
  const previousItems = previous && previous.items && typeof previous.items === 'object' ? previous.items : {};
  const items = {};
  for (const code of missingCodes || []) {
    if (!expectedSet.has(code)) continue;
    const old = previousItems[code] || {};
    const attempted = Array.isArray(old.attempted_trade_days) ? old.attempted_trade_days.slice() : [];
    if (!attempted.includes(isoDate(targetTradeDate))) attempted.push(isoDate(targetTradeDate));
    const attempts = attempted.length;
    items[code] = {
      first_missing_trade_date: old.first_missing_trade_date || isoDate(targetTradeDate),
      attempted_trade_days: attempted.slice(-20),
      last_attempt_at: now,
      next_retry_at: attempts >= 3 ? `${addTradingDays(targetTradeDate, 5)}T09:00:00+08:00` : now,
      last_reason: old.last_reason || 'target_day_price_missing',
      sources: Array.from(new Set([...(Array.isArray(old.sources) ? old.sources : []), 'tushare_cb_daily'])),
      status: 'retryable_missing',
    };
  }
  return {
    schema_version: BOND_GAP_QUEUE_SCHEMA_VERSION,
    dataset_code: 'bond_daily', scope_key: 'CN', target_trade_date: isoDate(targetTradeDate),
    expected_set_hash: bondGapQueueHash(expectedCodes), updated_at: now, items,
  };
}

async function readBondGapQueue(executor = pool.query.bind(pool)) {
  const { rows } = await layerSql.readBondGapQueueQuery1(executor);
  const payload = rows[0] && rows[0].cursor_payload;
  return payload && payload.bond_daily_gap_queue && typeof payload.bond_daily_gap_queue === 'object'
    ? payload.bond_daily_gap_queue : null;
}

async function writeBondGapQueue(executor, queue) {
  await layerSql.writeBondGapQueueQuery1(executor, [JSON.stringify(queue)]);
}

function isTencentBondWindow(targetTradeDate, now = new Date(), recordedNextTradeDate = null) {
  const target = isoDate(targetTradeDate);
  if (!target || !(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const local = new Date(now.getTime() + CN_OFFSET_MS);
  const today = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  const targetStart = new Date(`${target}T15:00:00+08:00`).getTime();
  if (now.getTime() < targetStart) return false;
  let nextDate = isoDate(recordedNextTradeDate);
  if (!nextDate) {
    const next = new Date(`${target}T00:00:00Z`);
    do { next.setUTCDate(next.getUTCDate() + 1); } while ([0, 6].includes(next.getUTCDay()));
    nextDate = next.toISOString().slice(0, 10);
  }
  return today === target ? hour >= 15 : today === nextDate && hour < 9.25;
}

async function recordedNextBondTradeDate(targetTradeDate) {
  const { rows } = await repository.select_market_trade_calendar([isoDate(targetTradeDate)]);
  return rows[0] && rows[0].trade_date ? isoDate(rows[0].trade_date) : null;
}

async function fetchTargetedBondDaily(codes, targetTradeDate) {
  const rows = [];
  const values = [...new Set(codes || [])];
  for (let start = 0; start < values.length; start += 200) {
    const data = await tushareQuery('cb_daily', {
      ts_code: values.slice(start, start + 200).join(','), trade_date: String(targetTradeDate).replace(/-/g, ''),
    }, DAILY_FIELDS, { allowEmpty: true });
    rows.push(...tsRows(data));
  }
  return rows;
}

async function updateBondFallbackRuntime(usedFallback, targetTradeDate) {
  const source = await repository.select_ops_data_sources();
  if (!source.rows[0]) return null;
  const result = await repository.insert_ops_source_endpoint_runtime([source.rows[0].source_id, Boolean(usedFallback)]);
  const state = result.rows[0] || null;
  if (usedFallback && state && Number(state.consecutive_fallback_count) >= 3) {
    await sendAlert({
      alertKey: 'source_fallback_degraded:tushare:cb_daily', alertType: 'source_fallback_degraded', severity: 'warning',
      scopeType: 'source_endpoint', scopeKey: 'tushare:cb_daily', jobCode: 'convertible_bond_universe_refresh',
      subject: 'Tushare cb_daily 连续退化',
      summary: `目标日 ${targetTradeDate} 连续 ${state.consecutive_fallback_count} 轮需要腾讯行情补缺，主源完整性需检查。`,
    });
  }
  return state;
}

function activeProfile(row, today) {
  return isActiveBond(row, today);
}

function isUnderlyingStockListed(row, listedStockCodes) {
  const stockCode = String(row && row.stk_code || '').trim().toUpperCase();
  return Boolean(stockCode && listedStockCodes && listedStockCodes.has(stockCode));
}

function runBondFirstDayBackfill(executable) {
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py'
      ? ['-3', BOND_FIRSTDAY_SCRIPT]
      : [BOND_FIRSTDAY_SCRIPT];
    const child = spawn(executable, args, {
      cwd: path.resolve(__dirname, '..', '..'),
      env: childProcessEnv({ PYTHONUTF8: '1' }),
      windowsHide: true,
    });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 25 * 60 * 1000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      mergeExternalCallStatsFromStderr(error);
      if (code !== 0) return reject(new Error(error || output || `新债上市表现补全失败（${code}）`));
      const line = output.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
      try { resolve(JSON.parse(line)); }
      catch (_) { reject(new Error(`新债上市表现补全结果格式错误: ${line.slice(0, 300)}`)); }
    });
  });
}

function runBondIssueResultBackfill(executable) {
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py'
      ? ['-3', BOND_ISSUE_RESULT_SCRIPT]
      : [BOND_ISSUE_RESULT_SCRIPT];
    const configuredLimit = Number(process.env.IPO_BOND_ISSUE_RESULT_LIMIT);
    const childArgs = [...args];
    // 默认处理全部待补对象；仅在人工调试时允许显式传入上限。
    if (Number.isInteger(configuredLimit) && configuredLimit > 0) childArgs.push('--limit', String(configuredLimit));
    const child = spawn(executable, childArgs, {
      cwd: path.resolve(__dirname, '..', '..'),
      env: childProcessEnv({ PYTHONUTF8: '1' }),
      windowsHide: true,
    });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 25 * 60 * 1000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      mergeExternalCallStatsFromStderr(error);
      if (code !== 0) return reject(new Error(error || output || `新债发行结果补全失败（${code}）`));
      const line = output.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      const match = line.match(/update=(\d+)\s+skip=(\d+)\s+fail=(\d+)/);
      if (!match) return reject(new Error(`新债发行结果补全结果格式错误: ${line.slice(0, 300)}`));
      resolve({ updated: Number(match[1]), skipped: Number(match[2]), failed: Number(match[3]),
        limit: Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : null });
    });
  });
}

async function backfillBondFirstDayPerformance(reason = 'scheduled') {
  if (!fs.existsSync(BOND_FIRSTDAY_SCRIPT)) return { ok: false, skipped: true, reason: 'script_missing' };
  const errors = [];
  for (const executable of pythonCandidates()) {
    try {
      const result = await runBondFirstDayBackfill(executable);
      return { ...result, reason };
    } catch (error) {
      errors.push(`${executable}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | ') || '未找到可用的 Python 解释器');
}

async function backfillBondIssueResults(reason = 'scheduled') {
  if (!fs.existsSync(BOND_ISSUE_RESULT_SCRIPT)) return { ok: false, skipped: true, reason: 'script_missing' };
  const errors = [];
  for (const executable of pythonCandidates()) {
    try {
      const result = await runBondIssueResultBackfill(executable);
      return { ...result, reason };
    } catch (error) {
      errors.push(`${executable}: ${error.message}`);
      if (!['ENOENT','EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error(errors.join(' | ') || '未找到可用的 Python 解释器');
}

function runBondLiquidityBackfill(executable) {
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py'
      ? ['-3', BOND_LIQUIDITY_SCRIPT]
      : [BOND_LIQUIDITY_SCRIPT];
    const days = String(process.env.IPO_BOND_LIQUIDITY_DAYS || '60');
    const configuredLimit = Number(process.env.IPO_BOND_LIQUIDITY_LIMIT);
    const childArgs = [...args, '--days', days];
    // 默认处理全部近 60 天缺口；显式上限只作为人工调试/安全止损参数。
    if (Number.isInteger(configuredLimit) && configuredLimit > 0) childArgs.push('--limit', String(configuredLimit));
    const child = spawn(executable, childArgs, {
      cwd: path.resolve(__dirname, '..', '..'),
      env: childProcessEnv({ PYTHONUTF8: '1' }),
      windowsHide: true,
    });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 25 * 60 * 1000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      mergeExternalCallStatsFromStderr(error);
      if (code !== 0) return reject(new Error(error || output || `新债流通规模补全失败（${code}）`));
      const line = output.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
      try {
        const result = JSON.parse(line);
        resolve({ ...result, limit: Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : null });
      }
      catch (_) { reject(new Error(`新债流通规模补全结果格式错误: ${line.slice(0, 300)}`)); }
    });
  });
}

async function backfillBondListingLiquidity(reason = 'scheduled') {
  if (!fs.existsSync(BOND_LIQUIDITY_SCRIPT)) return { ok: false, skipped: true, reason: 'script_missing' };
  const errors = [];
  for (const executable of pythonCandidates()) {
    try {
      const result = await runBondLiquidityBackfill(executable);
      return { ...result, reason };
    } catch (error) {
      errors.push(`${executable}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | ') || '未找到可用的 Python 解释器');
}

async function findBondListingLiquidityGaps(listingDate) {
  const targetDate = isoDate(listingDate);
  if (!targetDate) throw new Error('缺少下一交易日，无法核验新债流通规模覆盖');
  const { rows } = await repository.select_event_instrument_events([targetDate]);
  return {
    targetDate,
    candidateCodes: rows.map(row => row.code),
    missingCodes: rows.filter(row => row.missing).map(row => row.code),
  };
}

// 转股价发生变动时只登记数据问题，后续由历史公告解析链路补齐详情。
async function handleConvPriceChanges(changes) {
  for (const change of changes) {
    await recordQualityIssue({
      instrumentId: change.instrument_id,
      datasetCode: 'cb_basic',
      fieldCode: 'conv_price',
      issueType: 'snapshot_input_mismatch',
      details: { ts_code: change.ts_code, before: change.before, after: change.after, detected_by: 'daily_universe_sync' },
    });
    console.log(`[主同步] ${change.ts_code} 转股价已变化，等待历史公告解析链路补齐详情`);
    await new Promise(resolve => setTimeout(resolve, 150)); // 限流缓冲
  }
}

async function syncConvertibleBondUniverse(reason = 'scheduled', options = {}) {
  const claimed = await tryClaimJob('convertible_bond_universe_refresh');
  if (!claimed) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun('convertible_bond_universe_refresh');
  try {
    const targetTradeDate = isoDate(options.targetTradeDate) || defaultBondTargetTradeDate();
    const [basicData, stockStatusData, dates] = await Promise.all([
      tushareQuery('cb_basic', {}, PROFILE_FIELDS),
      tushareQuery('stock_basic', { list_status: 'L' }, STOCK_STATUS_FIELDS),
      latestTradeDates(targetTradeDate),
    ]);
    const allBasicRows = tsRows(basicData);
    const stockStatusRows = tsRows(stockStatusData);
    const trackedDelistedRows = await loadTrackedDelistedStocks(stockStatusRows);
    const listedStockCodes = new Set(stockStatusRows
      .map(row => String(row.ts_code || '').trim().toUpperCase())
      .filter(Boolean));
    // 计划业务日是事实判定日；补跑不能用机器当前日期把目标日的证券集合漂移到今天。
    const lifecycleCandidates = allBasicRows.filter(row => activeProfile(row, targetTradeDate)
      && isUnderlyingStockListed(row, listedStockCodes));
    const basics = await filterPublicBonds(lifecycleCandidates);
    if (!basics.length) throw new Error('Tushare 可转债基础数据为空，保留上一份数据');
    const profiles = basics;
    const activeCodes = new Set(basics.map(row => row.ts_code));
    const profileStockCodes = new Map();
    for (const profile of profiles) {
      if (profile.stk_code) profileStockCodes.set(profile.ts_code, await resolveCanonicalCode(profile.stk_code, 'stock').catch(() => profile.stk_code));
    }
    const daily = await latestFullBondDaily(dates, {
      activeCodes,
      expectedBondCount: basics.length,
      targetTradeDate,
      targetOnly: true,
    });
    // 目标日固定为最近已完成交易日；部分返回先保存可信价格，缺失对象进入持久化队列。
    const queueBefore = await readBondGapQueue();
    // 队列跨目标日延续，才能识别同一代码连续多个交易日缺失；当前目标日只决定本轮数据写入。
    const previousQueue = queueBefore && typeof queueBefore === 'object' ? queueBefore : null;
    const rawTargetRows = new Map(daily.rows.filter(row => activeCodes.has(row.ts_code)).map(row => [row.ts_code, row]));
    const targetRows = new Map([...rawTargetRows].filter(([, row]) => finite(row.close) > 0));
    const initialPricedCount = targetRows.size;
    const missingBeforeRetry = profiles.filter(profile => classifyBondObjectStatus({ row: rawTargetRows.get(profile.ts_code) }) === 'retryable_missing')
      .map(profile => profile.ts_code);
    const dueMissing = missingBeforeRetry.filter(code => {
      const item = previousQueue && previousQueue.items && previousQueue.items[code];
      return !item || !item.next_retry_at || new Date(item.next_retry_at).getTime() <= Date.now();
    });
    if (dueMissing.length) {
      const targetedRows = await fetchTargetedBondDaily(dueMissing, targetTradeDate);
      for (const row of targetedRows) {
        if (!activeCodes.has(row.ts_code)) continue;
        rawTargetRows.set(row.ts_code, row);
        if (finite(row.close) > 0) targetRows.set(row.ts_code, row);
      }
    }
    const missingBeforeTencent = profiles.filter(profile => classifyBondObjectStatus({ row: rawTargetRows.get(profile.ts_code) }) === 'retryable_missing')
      .map(profile => profile.ts_code);
    let tencentFallbackCount = 0;
    const recordedNextTradeDate = missingBeforeTencent.length
      ? await recordedNextBondTradeDate(targetTradeDate).catch(() => null) : null;
    if (missingBeforeTencent.length && isTencentBondWindow(targetTradeDate, new Date(), recordedNextTradeDate)) {
      const quotes = await fetchTencentQuotes(missingBeforeTencent, { businessDate: targetTradeDate });
      for (const profile of profiles) {
        if (!missingBeforeTencent.includes(profile.ts_code)) continue;
        const quote = quotes.get(profile.ts_code) || quotes.get(profile.ts_code.slice(0, 6));
        if (!quote || finite(quote.price) == null) continue;
        const quoteRow = {
          ts_code: profile.ts_code, trade_date: targetTradeDate.replace(/-/g, ''), close: quote.price,
          pre_close: null, open: quote.price, high: quote.price, low: quote.price,
          source: 'tencent', quote_time: quote.quote_time || null,
        };
        rawTargetRows.set(profile.ts_code, quoteRow);
        targetRows.set(profile.ts_code, quoteRow);
        tencentFallbackCount += 1;
      }
    }
    const bondStatusByCode = new Map(profiles.map(profile => [profile.ts_code,
      classifyBondObjectStatus({ row: rawTargetRows.get(profile.ts_code) })]));
    const bondStatusCounts = [...bondStatusByCode.values()].reduce((counts, status) => {
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});
    const recoveredCount = Math.max(0, targetRows.size - initialPricedCount);
    const unresolvedCodes = profiles.filter(profile => bondStatusByCode.get(profile.ts_code) === 'retryable_missing')
      .map(profile => profile.ts_code);
    if (!targetRows.size && ![...bondStatusByCode.values()].includes('verified_no_trade')) {
      const error = new TushareRequestError('EMPTY_DATA', `可转债目标日 ${targetTradeDate} 无可信价格`, { errorType: 'empty_data', apiName: 'cb_daily' });
      error.dataDiagnostics = { targetTradeDate, reason: daily.reason, candidates: daily.diagnostics };
      throw error;
    }
    daily.tradeDate = targetTradeDate;
    daily.rows = [...targetRows.values()];
    daily.coverage = { ...(daily.coverage || {}), targetTradeDate, unresolvedCount: unresolvedCodes.length, tencentFallbackCount,
      objectStatusCounts: bondStatusCounts };
    const [stockDailyData, stockValuationData, stockAdjustmentData] = await Promise.all([
      tushareQuery('daily', { trade_date: targetTradeDate.replace(/-/g, '') }, 'ts_code,trade_date,open,high,low,close,vol,amount'),
      tushareQuery('daily_basic', { trade_date: targetTradeDate.replace(/-/g, '') }, 'ts_code,trade_date,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv', { failoverOnEmpty: true }),
      tushareQuery('adj_factor', { trade_date: targetTradeDate.replace(/-/g, '') }, 'ts_code,trade_date,adj_factor', { allowEmpty: true }),
    ]);
    const stockDailyRows = tsRows(stockDailyData);
    const stockValuationRows = tsRows(stockValuationData);
    const stockAdjustmentRows = tsRows(stockAdjustmentData);
    const profileByCode = new Map(profiles.map(row => [row.ts_code, row]));
    const stockCloseByCode = new Map(stockDailyRows.map(row => [row.ts_code, finite(row.close)]));
    // Tushare cb_daily 偶发只返回价格、不返回转股价值/溢价率；用同日正股收盘价和转股价补齐，
    // 保证周期指标和后续估值链路不会因上游可推导字段缺失而整体阻断。
    const activeDailyRows = daily.rows
      .filter(row => activeCodes.has(row.ts_code))
      .map(row => {
        const profile = profileByCode.get(row.ts_code);
        const stockClose = profile ? stockCloseByCode.get(profileStockCodes.get(profile.ts_code) || profile.stk_code) : null;
        const conversionPrice = profile ? finite(profile.conv_price) : null;
        const close = finite(row.close);
        const conversionValue = finite(row.cb_value) != null
          ? finite(row.cb_value)
          : stockClose != null && conversionPrice != null && conversionPrice > 0
            ? stockClose / conversionPrice * 100 : null;
        const premium = finite(row.cb_over_rate) != null
          ? finite(row.cb_over_rate)
          : conversionValue != null && conversionValue > 0 && close != null
            ? (close / conversionValue - 1) * 100 : null;
        return conversionValue == null && premium == null
          ? row : { ...row, cb_value: conversionValue, cb_over_rate: premium };
      });
    const dailyMap = new Map(activeDailyRows.map(row => [row.ts_code, row]));
    const valuationMissingCodes = profiles.filter(profile => bondStatusByCode.get(profile.ts_code) === 'priced').filter(profile => {
      const row = dailyMap.get(profile.ts_code);
      return !row || finite(row.cb_value) == null || finite(row.bond_value) == null;
    }).map(profile => profile.ts_code);
    const gapQueue = buildBondGapQueue({
      targetTradeDate, expectedCodes: profiles.map(profile => profile.ts_code),
      missingCodes: unresolvedCodes, previous: previousQueue || {},
    });
    for (const code of unresolvedCodes) {
      const row = dailyMap.get(code);
      if (row && row.source === 'tencent' && gapQueue.items[code]) {
        gapQueue.items[code].sources = Array.from(new Set([...(gapQueue.items[code].sources || []), 'tencent_recent_window']));
        gapQueue.items[code].last_reason = 'tencent_recent_window_unverified_target_close';
      }
    }
    const longMissingCodes = Object.entries(gapQueue.items)
      .filter(([, item]) => Array.isArray(item.attempted_trade_days) && item.attempted_trade_days.length >= 3)
      .map(([code]) => code);
    if (longMissingCodes.length) {
      await sendAlert({
        alertKey: `bond_daily_gap:${targetTradeDate}`, alertType: 'data_quality', severity: 'warning',
        scopeType: 'dataset', scopeKey: `bond_daily:CN:${targetTradeDate}`, jobCode: 'convertible_bond_universe_refresh',
        subject: `可转债目标日缺价持续未补齐：${targetTradeDate}`,
        summary: `目标日仍有 ${longMissingCodes.length} 只可转债连续至少 3 个交易日缺少债券级价格终态，已改为每 5 个交易日重试。`,
      });
    }
    const client = await pool.connect();
    let saved = 0;
    let tushareSourceId = null;
    const convPriceChanges = [];
    try {
      await txControl.begin(client);
      const sources = await sourceIds(client);
      tushareSourceId = sources.tushare;

      // 保存前先记下现有转股价，用来识别本轮发生转股价变动的转债
      const prevConvPrice = new Map();
      const prevRows = await repository.select_fundamental_convertible_bond_profiles(client);
      for (const row of prevRows.rows) prevConvPrice.set(row.ts_code, finite(row.current_conv_price));

      const stockInstrumentMap = await ensureStockUniverse(client, stockStatusRows, sources.tushare);
      await ensureStockUniverse(client, trackedDelistedRows, sources.tushare);
      for (const profile of profiles) {
        const ids = await saveProfile(client, profile, sources);
        const stockCode = profileStockCodes.get(profile.ts_code) || profile.stk_code;
        if (stockCode && ids.stockId) stockInstrumentMap.set(stockCode, ids.stockId);
        const quote = dailyMap.get(profile.ts_code);
        if (quote) await saveDailyBar(client, ids.bondId, quote, quote.source === 'tencent' ? (sources.tencent || sources.tushare) : sources.tushare);
        const before = prevConvPrice.get(profile.ts_code);
        const after = finite(profile.conv_price);
        if (before != null && after != null && Math.abs(before - after) > CONV_PRICE_EPS) {
          convPriceChanges.push({ ts_code: profile.ts_code, instrument_id: ids.bondId, before, after });
        }
        saved += 1;
      }
      await saveFullStockMarketPartition(client, stockInstrumentMap, stockDailyRows, stockValuationRows, sources.tushare, stockAdjustmentRows);
      // 待上市新债主档补全：isActiveBond 只收已上市债，导致新债在上市前一直是
      // 「有占位档、无正股/无转股价」的状态，日报（上市前一交易日生成）只能降级为
      // 「数据不足无法精确预估」。这里只补主档字段，不写行情、不进行情缺口队列。
      const pendingListingProfiles = await filterPublicBonds(allBasicRows.filter(row =>
        isPendingListingBond(row, targetTradeDate) && isUnderlyingStockListed(row, listedStockCodes)));
      const pendingListingSaved = [];
      for (const profile of pendingListingProfiles) {
        const ids = await saveProfile(client, profile, sources);
        if (profile.stk_code && ids.stockId) stockInstrumentMap.set(profile.stk_code, ids.stockId);
        pendingListingSaved.push(profile.ts_code);
      }
      if (pendingListingSaved.length) {
        console.log(`[主同步] 待上市新债主档已补全 ${pendingListingSaved.length} 只：${pendingListingSaved.join(',')}`);
      }
      await repository.insert_ops_sync_cursors([unresolvedCodes.length ? null : isoDate(daily.tradeDate)], client);
      await writeBondGapQueue(client.query.bind(client), gapQueue);
      await txControl.commit(client);
      console.log(`[主同步] 可转债全量同步已提交（${saved} 只，行情日期 ${daily.tradeDate}）`);
    } catch (error) { await txControl.rollback(client); throw error; }
    finally { client.release(); }
    if (tencentFallbackCount > 0 || unresolvedCodes.length === 0) {
      await updateBondFallbackRuntime(tencentFallbackCount > 0, targetTradeDate).catch(error => {
        console.warn('[主同步] 腾讯兜底运行态记录失败：', error.message);
      });
    }
    // 转股价变动的转债：记数据问题，后续由历史公告解析链路补齐（旧快照由新鲜度判定自动标记为需刷新）
    if (convPriceChanges.length) {
      console.log(`[主同步] 检测到 ${convPriceChanges.length} 只转债转股价变动：${convPriceChanges.map(c => c.ts_code).join(',')}`);
      await handleConvPriceChanges(convPriceChanges);
    }
    // 正股停牌日是强赎/下修计算的共同输入：由行情主采集链路集中拉取一次，
    // 估值与分析任务只读 market.stock_suspend_calendar，不得在派生任务内重复调用 suspend_d。
    let suspensionResult = { ok: true, skipped: true, reason: 'not_requested' };
    try {
      const { syncConvertibleBondSuspensions } = require('./convertibleBondSuspensionSync');
      suspensionResult = await syncConvertibleBondSuspensions({ startDate: daily.tradeDate, endDate: daily.tradeDate });
      if (suspensionResult.ok) console.log(`[主同步] 正股停牌日已入库（${suspensionResult.count} 条，行情日期 ${daily.tradeDate}）`);
    } catch (suspensionError) {
      suspensionResult = {
        ok: false,
        status: 'failed',
        queryStatus: 'failed',
        error: suspensionError.message,
        errorCode: suspensionError.code || 'SUSPENSION_SYNC_FAILED',
        errorType: suspensionError.errorType || 'data_quality',
      };
      console.warn('[主同步] 正股停牌日同步失败，保留上一份停牌日缓存：', suspensionError.message);
    }
    let partitionPublicationError = null;
    try {
      await Promise.all([
        publishDatasetPartition('bond_master', 'CN', { dataAsOf: daily.tradeDate, partitionKey: daily.tradeDate, rowCount: profiles.length, sourceId: tushareSourceId, diagnostics: { targetTradeDate } }),
        publishDatasetPartition('bond_daily', 'CN', {
          dataAsOf: targetTradeDate, partitionKey: targetTradeDate, rowCount: activeDailyRows.length,
          status: unresolvedCodes.length ? 'partial_published' : 'published', sourceId: tushareSourceId,
          diagnostics: {
            targetTradeDate, unresolved_count: unresolvedCodes.length,
            expected_count: profiles.length, raw_count: rawTargetRows.size, priced_count: bondStatusCounts.priced || 0,
            recovered_count: recoveredCount, verified_no_trade_count: bondStatusCounts.verified_no_trade || 0,
            missing_codes: unresolvedCodes.slice(0, 50),
            object_status_counts: bondStatusCounts,
            price_quality: unresolvedCodes.length ? 'partial' : 'passed',
            valuation_quality: valuationMissingCodes.length ? 'partial' : 'passed',
          },
        }),
        publishDatasetPartition('stock_daily', 'CN', { dataAsOf: daily.tradeDate, rowCount: stockDailyRows.length, sourceId: tushareSourceId, diagnostics: { targetTradeDate } }),
        publishDatasetPartition('stock_valuation', 'CN', { dataAsOf: daily.tradeDate, rowCount: stockValuationRows.length, sourceId: tushareSourceId, diagnostics: { targetTradeDate } }),
        publishDatasetPartition('stock_adj_factor', 'CN', { dataAsOf: daily.tradeDate, rowCount: stockAdjustmentRows.length, sourceId: tushareSourceId, diagnostics: { targetTradeDate } }),
      ]);
    } catch (partitionError) {
      partitionPublicationError = partitionError;
      console.warn('[主同步] 数据集分区水位写入失败（不覆盖已入库事实）：', partitionError.message);
    }
    // suspend_d 的空结果是“已核验无停牌”，只有接口失败才登记 unknown/stale；失败时不覆盖已有行数。
    try {
      if (suspensionResult.ok) {
        await publishDatasetPartition('stock_suspend_calendar', 'CN', {
          dataAsOf: daily.tradeDate,
          partitionKey: daily.tradeDate,
          rowCount: suspensionResult.count || 0,
          sourceId: tushareSourceId,
          diagnostics: {
            api_name: 'suspend_d',
            query_status: 'success',
            coverage_status: suspensionResult.count ? 'suspensions_found' : 'verified_no_suspension',
          },
        });
      } else {
        await markSuspensionCoverageStale({ startDate: daily.tradeDate, endDate: daily.tradeDate, sourceId: tushareSourceId, error: suspensionResult.error });
      }
    } catch (suspensionPartitionError) {
      partitionPublicationError = partitionPublicationError || suspensionPartitionError;
      console.warn('[主同步] 停牌数据集分区水位写入失败：', suspensionPartitionError.message);
    }
    // 评级历史自动补齐（独立事务，失败不影响主同步；缺评级的转债逐只从 Tushare 拉取）
    try { await backfillMissingRatings(reason); }
    catch (ratingErr) { console.warn('[ratings] 评级补齐失败（不影响主同步）:', ratingErr.message); }
    let listingPerformance = { ok: true, skipped: true, reason: 'no_pending_candidates' };
    try {
      listingPerformance = await backfillBondFirstDayPerformance(reason);
      console.log(`[上市表现] 本批尝试${listingPerformance.attempted || 0}，更新${listingPerformance.updated || 0}，剩余${listingPerformance.remaining || 0}`);
    } catch (performanceErr) {
      listingPerformance = { ok: false, error: performanceErr.message };
      console.warn('[上市表现] 自动补全失败（不影响主同步）:', performanceErr.message);
    }
    let issueResults = { ok: true, skipped: true, reason: 'no_pending_candidates' };
    try {
      issueResults = await backfillBondIssueResults(reason);
      console.log(`[发行结果] 本批尝试${(issueResults.updated || 0) + (issueResults.skipped || 0)}，更新${issueResults.updated || 0}，失败${issueResults.failed || 0}`);
    } catch (issueErr) {
      issueResults = { ok: false, error: issueErr.message };
      console.warn('[发行结果] 自动补全失败（不影响主同步）:', issueErr.message);
    }
    // 可转债周期：主同步提交后，用独立事务计算（周期失败只影响周期数据，不影响主同步）
    const cycleClient = await pool.connect();
    try {
      await txControl.begin(cycleClient);
      const cyc = await cycleService.processCycleDay(daily.tradeDate, activeDailyRows, { sourceId: tushareSourceId, client: cycleClient });
      await txControl.commit(cycleClient);
      if (cyc.stored) console.log(`[cycle] 当日周期指标已发布（${daily.tradeDate}）`);
      else console.warn(`[cycle] 当日未发布周期指标（${daily.tradeDate}，原因：${cyc.reason}）`);
    } catch (cycErr) {
      await txControl.rollback(cycleClient).catch(() => {});
      console.warn('[cycle] 当日周期计算失败（不影响主同步）：', cycErr.message);
    } finally { cycleClient.release(); }
    const failedDatasets = [];
    if (unresolvedCodes.length) failedDatasets.push('bond_daily');
    if (!suspensionResult.ok) failedDatasets.push('stock_suspend_calendar');
    if (partitionPublicationError) failedDatasets.push('dataset_publication');
    const complete = failedDatasets.length === 0;
    const result = {
      ok: complete,
      status: complete ? 'succeeded' : 'partial',
      skipped: false,
      count: saved,
      trade_date: isoDate(daily.tradeDate),
      dataAsOf: isoDate(daily.tradeDate),
      target_trade_date: targetTradeDate,
      coverage: daily.coverage,
      dataDiagnostics: {
        targetTradeDate, candidates: daily.diagnostics, unresolved_count: unresolvedCodes.length,
        unresolved_codes: unresolvedCodes.slice(0, 50),
        object_status_counts: bondStatusCounts,
        expected_count: profiles.length, raw_count: rawTargetRows.size, priced_count: bondStatusCounts.priced || 0,
        recovered_count: recoveredCount, verified_no_trade_count: bondStatusCounts.verified_no_trade || 0,
        price_quality: unresolvedCodes.length ? 'partial' : 'passed',
        valuation_quality: valuationMissingCodes.length ? 'partial' : 'passed',
        gap_queue: { key: 'bond_daily_gap_queue', expected_set_hash: gapQueue.expected_set_hash, remaining_count: Object.keys(gapQueue.items).length },
      },
      listing_performance: listingPerformance,
      issue_results: issueResults,
      suspension: suspensionResult,
      failedDatasets,
      missingDates: suspensionResult.ok ? (suspensionResult.missingDates || []) : [isoDate(daily.tradeDate)],
      publishDatasets: false,
      datasetDiagnostics: {
        bond_master: { partition_row_count: profiles.length, dataAsOf: isoDate(daily.tradeDate) },
        bond_daily: {
          partition_row_count: activeDailyRows.length, dataAsOf: targetTradeDate,
          status: unresolvedCodes.length ? 'partial_published' : 'published', unresolved_count: unresolvedCodes.length,
          object_status_counts: bondStatusCounts,
          expected_count: profiles.length, raw_count: rawTargetRows.size, priced_count: bondStatusCounts.priced || 0,
          recovered_count: recoveredCount, verified_no_trade_count: bondStatusCounts.verified_no_trade || 0,
          price_quality: unresolvedCodes.length ? 'partial' : 'passed',
          valuation_quality: valuationMissingCodes.length ? 'partial' : 'passed',
        },
        stock_daily: { partition_row_count: stockDailyRows.length, dataAsOf: isoDate(daily.tradeDate) },
        stock_valuation: { partition_row_count: stockValuationRows.length, dataAsOf: isoDate(daily.tradeDate) },
        stock_adj_factor: { partition_row_count: stockAdjustmentRows.length, dataAsOf: isoDate(daily.tradeDate) },
        stock_suspend_calendar: {
          partition_row_count: suspensionResult.count || 0,
          dataAsOf: isoDate(daily.tradeDate),
          coverage_status: suspensionResult.ok
            ? (suspensionResult.count ? 'suspensions_found' : 'verified_no_suspension') : 'unknown',
          query_status: suspensionResult.ok ? 'success' : 'failed',
        },
      },
    };
    await finishJobRun(runId, complete, `${reason}：同步 ${saved} 只，行情日期 ${daily.tradeDate}，${complete ? '停牌与分区均已完成' : `未完成数据集：${failedDatasets.join(',')}`}`);
    return result;
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally { await releaseJob('convertible_bond_universe_refresh'); }
}

// 扫描最近窗口内的开市日（按时间正序），并将交易日历落库供强赎、周期等模块复用。
async function getRecentOpenDays(days = 90, endDate = null) {
  const endValue = endDate ? new Date(`${String(endDate).slice(0, 10)}T00:00:00+08:00`) : new Date();
  const end = tsDateStr(endValue);
  const start = tsDateStr(addDays(endValue, -days));
  const data = await tushareQuery('trade_cal', { exchange: 'SSE', start_date: start, end_date: end }, 'cal_date,is_open');
  const rows = tsRows(data).filter(row => row.cal_date).map(row => ({
    exchange: 'SSE', trade_date: isoDate(row.cal_date), is_open: String(row.is_open) === '1', raw_payload: row,
  })).filter(row => row.trade_date);
  if (rows.length) {
    await repository.insert_market_trade_calendar([JSON.stringify(rows)]);
  }
  return rows.filter(row => row.is_open).map(row => row.trade_date).sort();
}

// 自动补齐历史空缺：主同步之后调用，扫描游标之前（含游标当天）窗口内「事实表缺失/坏数据」的交易日，逐日重算周期指标。
// 无空缺时几乎零开销（一次 SQL 扫描）。windowDays 控制扫描范围：每日任务用默认 90 天足够，手动脚本可传更大值补全量历史。
async function backfillCycleGaps({ windowDays = 90, targetTradeDate = null } = {}) {
  const sourceId = await cycleService.getTushareSourceId();
  if (sourceId == null) { console.warn('[cycle-backfill] 未取得 tushare 数据源，跳过空缺补齐'); return; }
  const openDays = await getRecentOpenDays(windowDays, targetTradeDate);
  if (!openDays.length) return;
  // 主同步只覆盖最新完整分区，因此游标之后、最新日之前的中间交易日也必须扫描。
  const gaps = await cycleService.findGapDays(openDays);
  if (!gaps.length) return;
  console.log(`[cycle-backfill] 检测到 ${gaps.length} 个空缺日：${gaps.slice(0, 10).join(',')}${gaps.length > 10 ? '...' : ''}，开始补齐`);
  let gapFilled = 0;
  const client = await pool.connect();
  try {
    const instrumentRows = await repository.select_core_instruments(client);
    const instrumentMap = new Map(instrumentRows.rows.map(row => [row.canonical_code, row.instrument_id]));
    for (const day of gaps) {
      try {
        const data = await tushareQuery('cb_daily', { trade_date: day }, DAILY_FIELDS, { allowEmpty: true });
        const rows = tsRows(data);
        if (!rows.length) continue;
        // 行情事实与周期结果分开提交：周期字段不完整时仍保留完整的日行情分区。
        await txControl.begin(client);
        for (const quote of rows) {
          const bondId = instrumentMap.get(quote.ts_code);
          if (bondId) await saveDailyBar(client, bondId, quote, sourceId);
        }
        await txControl.commit(client);

        await txControl.begin(client);
        const res = await cycleService.processCycleDay(day, rows, { sourceId, client });
        if (res.failed) { await txControl.rollback(client); console.warn(`[cycle-backfill] ${day} 数据异常，停止补齐：${res.reason}`); break; }
        await txControl.commit(client);
        if (res.stored) gapFilled++;
      } catch (e) {
        await txControl.rollback(client).catch(() => {});
        console.warn(`[cycle-backfill] ${day} 补齐失败，停止：${e.message}`);
        break;
      }
    }
  } finally { client.release(); }
  if (gapFilled > 0) {
    console.log(`[cycle-backfill] 已补 ${gapFilled} 个空缺日，按时间顺序重算滚动分位...`);
    const n = await cycleService.recomputePercentiles();
    console.log(`[cycle-backfill] 分位重算完成（${n} 天）`);
  }
}

// 每日主同步 + 自动补齐遗漏的交易日：某天任务失败或部署晚于点，下次运行时主同步更新最新日，backfill 顺手把漏的那天补上，不留永久缺口。
// backfillOpts 透传给 backfillCycleGaps（如手动脚本传 { windowDays: 4000 } 补全量历史）。
async function repairConvertibleBondSuspensionCoverage(targetTradeDate, windowDays = 90) {
  const openDays = await getRecentOpenDays(Math.max(Number(windowDays) || 90, 90), targetTradeDate);
  if (!openDays.length) return { ok: true, status: 'no_open_days', missingDates: [], ranges: [] };
  const sources = await sourceIds();
  if (!sources.tushare) {
    return { ok: false, status: 'source_missing', error: 'Tushare 数据源未登记', errorCode: 'DATASET_INCOMPLETE', missingDates: openDays };
  }
  const gaps = await findSuspensionCoverageGaps({
    startDate: openDays[0],
    endDate: openDays[openDays.length - 1],
    stockSourceId: sources.tushare,
    suspensionSourceId: sources.tushare,
  });
  const missingDates = gaps.map(row => row.tradeDate);
  const ranges = mergeDateRanges(missingDates, openDays);
  const result = await syncSuspensionIntervals(ranges);
  return { ...result, missingDates, ranges, gapDiagnostics: gaps };
}

async function markStockDailyBackfillStale(targetTradeDate, error) {
  const tradeDate = isoDate(targetTradeDate);
  if (!tradeDate) return;
  const detail = JSON.stringify({
    source: 'convertible_bond_stock_market_backfill',
    query_status: 'failed',
    error: String(error || '正股历史行情补漏失败').slice(0, 500),
  });
  await repository.update_ops_dataset_partitions([tradeDate, '正股历史行情补漏失败，强赎计算输入未确认完整', detail]);
}

async function syncConvertibleBondUniverseWithBackfill(reason = 'scheduled', backfillOpts = {}) {
  const targetDate=isoDate(backfillOpts.targetTradeDate)||defaultBondTargetTradeDate();
  const repoOnly=backfillOpts.mode==='repo_daily' || (backfillOpts.failedDatasets?.length && backfillOpts.failedDatasets.every(d=>d==='repo_daily_rates'));
  if(repoOnly) return require('./repoDailyRates').syncRepoDailyRates({targetDate});
  const result=await syncConvertibleBondUniverseMarketWithBackfill(reason,backfillOpts);
  // 子阶段续跑只执行已经失败的市场阶段，不为未尝试数据集制造失败。
  if(backfillOpts.failedDatasets?.length || backfillOpts.pendingStages?.length) return {...result,mode:'market_repair',publishDatasetCodes:['bond_master','bond_daily','stock_daily','stock_valuation','stock_adj_factor','stock_suspend_calendar'],stageComplete:result.ok===true&&!result.continuationRequired};
  const repo=await require('./repoDailyRates').syncRepoDailyRates({targetDate}).catch(e=>({ok:false,error:e.message,failedDatasets:['repo_daily_rates']}));
  return {...result,mode:backfillOpts.mode==='shared_eod'?'shared_eod':'core',stageComplete:result.ok===true&&repo.ok&&!result.continuationRequired,repoDailyRates:repo,ok:result.ok!==false&&repo.ok,status:result.ok!==false&&repo.ok&&!result.continuationRequired?'succeeded':'partial',
    failedDatasets:[...new Set([...(result.failedDatasets||[]),...(repo.failedDatasets||[])])],
    datasetDiagnostics:{...result.datasetDiagnostics,repo_daily_rates:{publish:false,quality_status:repo.ok?'passed':'failed'}},
    ...(repo.ok?{}:{error:repo.error||'回购每日利率未完整发布',errorCode:'DATASET_INCOMPLETE',errorType:'data_quality'})};
}

async function syncConvertibleBondUniverseMarketWithBackfill(reason = 'scheduled', backfillOpts = {}) {
  const targetTradeDate = isoDate(backfillOpts.targetTradeDate) || defaultBondTargetTradeDate();
  const failedDatasets = [...new Set((backfillOpts.failedDatasets || []).map(String).filter(Boolean))];
  const pendingStages = new Set((backfillOpts.pendingStages || []).map(String));
  // 停牌数据集失败时只续跑停牌区间，不再重拉整套可转债、股票行情和估值。
  if (failedDatasets.length && failedDatasets.every(code => code === 'stock_suspend_calendar')) {
    const suspension = await repairConvertibleBondSuspensionCoverage(targetTradeDate, backfillOpts.windowDays);
    return {
      ok: suspension.ok,
      status: suspension.ok ? 'succeeded' : 'partial',
      dataAsOf: targetTradeDate,
      trade_date: targetTradeDate,
      failedDatasets: suspension.ok ? [] : ['stock_suspend_calendar'],
      missingDates: suspension.missingDates || [],
      suspension,
      publishDatasets: false,
      datasetDiagnostics: { stock_suspend_calendar: { publish: false, coverage_status: suspension.ok ? 'repaired' : 'unknown' } },
      ...(suspension.ok ? {} : {
        error: suspension.error || '停牌数据集未完成',
        errorCode: suspension.errorCode || 'DATASET_INCOMPLETE',
        errorType: 'data_quality',
      }),
    };
  }
  // 正股行情补漏是独立阶段；续批只处理该阶段，避免重复拉取已完成的主链和周期数据。
  if (pendingStages.has('stockMarketBackfill') || (failedDatasets.length && failedDatasets.every(code => code === 'stock_daily'))) {
    const stockOnly = await backfillUnderlyingStockMarket({
      windowDays: Math.max(Number(backfillOpts.windowDays) || 90, 90),
      targetTradeDate,
      continuationCount: backfillOpts.continuationCount,
    });
    if (stockOnly.continuationRequired) {
      const continuationCount = Number(backfillOpts.continuationCount || 0) + 1;
      const initialRemaining = Number(backfillOpts.initialRemaining || stockOnly.initialRemaining || stockOnly.remaining || 0);
      const lastRemaining = Number(stockOnly.remaining || 0);
      const previousRemaining = Number(backfillOpts.lastRemaining ?? initialRemaining);
      const noProgressCount = backfillOpts.lastRemaining == null ? 0
        : lastRemaining >= previousRemaining ? Number(backfillOpts.noProgressCount || 0) + 1 : 0;
      const continuationMaxBatches = Number(backfillOpts.continuationMaxBatches || stockOnly.continuationMaxBatches || Math.ceil(initialRemaining / Math.max(Number(stockOnly.batchSize || 80), 1)) + 1);
      const continuationStartedAt = backfillOpts.continuationStartedAt || stockOnly.continuationStartedAt || new Date().toISOString();
      const continuationMaxAgeHours = Math.max(Number(backfillOpts.continuationMaxAgeHours || 24), 1);
      const continuationAgeExceeded = Number.isFinite(Date.parse(continuationStartedAt))
        && Date.now() - Date.parse(continuationStartedAt) >= continuationMaxAgeHours * 60 * 60 * 1000;
      stockOnly.continuationCount = continuationCount;
      stockOnly.initialRemaining = initialRemaining;
      stockOnly.lastRemaining = lastRemaining;
      stockOnly.noProgressCount = noProgressCount;
      stockOnly.continuationMaxBatches = continuationMaxBatches;
      stockOnly.continuationStartedAt = continuationStartedAt;
      stockOnly.continuationMaxAgeHours = continuationMaxAgeHours;
      stockOnly.pendingStages = ['stockMarketBackfill'];
      stockOnly.nextAttemptInMinutes = 1;
      if (noProgressCount >= 2 || (Number(backfillOpts.slotExternalCallsLimit || 0) > 0
        && Number(backfillOpts.slotExternalCallsTotal || 0) >= Number(backfillOpts.slotExternalCallsLimit))
        || continuationCount >= continuationMaxBatches || continuationAgeExceeded) {
        stockOnly.continuationBlocked = true;
        stockOnly.continuationStopReason = noProgressCount >= 2 ? '连续两批剩余量未下降，已停止自动续批'
          : continuationAgeExceeded ? `续跑已超过${continuationMaxAgeHours}小时，已停止自动续批`
            : '已达到续批停止线，已停止自动续批';
      }
    }
    return {
      ok: stockOnly.ok !== false && !stockOnly.continuationRequired,
      status: stockOnly.continuationRequired ? 'partial' : stockOnly.ok === false ? 'degraded' : 'succeeded',
      dataAsOf: targetTradeDate,
      trade_date: targetTradeDate,
      failedDatasets: stockOnly.continuationRequired || stockOnly.ok === false ? ['stock_daily'] : [],
      publishDatasets: false,
      ...stockOnly,
    };
  }
  const result = await syncConvertibleBondUniverse(reason, { targetTradeDate });
  const suspensionCoverage = await repairConvertibleBondSuspensionCoverage(targetTradeDate, backfillOpts.windowDays);
  if (!suspensionCoverage.ok) {
    result.ok = false;
    result.status = 'partial';
    result.error = suspensionCoverage.error || '停牌数据集未完成';
    result.errorCode = suspensionCoverage.errorCode || 'DATASET_INCOMPLETE';
    result.errorType = 'data_quality';
    result.failedDatasets = [...new Set([...(result.failedDatasets || []), 'stock_suspend_calendar'])];
    result.missingDates = suspensionCoverage.missingDates || [];
  } else {
    result.failedDatasets = (result.failedDatasets || []).filter(code => code !== 'stock_suspend_calendar');
    result.missingDates = [];
    if (!result.failedDatasets.length) {
      result.ok = true;
      result.status = 'succeeded';
    }
  }
  result.suspensionCoverage = suspensionCoverage;
  await backfillCycleGaps({ ...backfillOpts, targetTradeDate });
  // 正股行情是强赎计算的直接输入；主同步成功后顺带补齐最近窗口内的缺口，避免只更新转债而遗漏正股。
  let stockMarketBackfill;
  try {
    stockMarketBackfill = await backfillUnderlyingStockMarket({
      windowDays: Math.max(Number(backfillOpts.windowDays) || 90, 90),
      targetTradeDate,
      continuationCount: backfillOpts.continuationCount,
    });
  } catch (stockError) {
    await markStockDailyBackfillStale(targetTradeDate, stockError.message).catch(markError =>
      console.warn('[股债分析缓存] 标记 stock_daily 分区失败：', markError.message));
    result.ok = false;
    result.status = 'partial';
    result.error = `正股历史行情补漏失败：${stockError.message}`;
    result.errorCode = stockError.code || 'DATASET_INCOMPLETE';
    result.errorType = 'data_quality';
    result.failedDatasets = [...new Set([...(result.failedDatasets || []), 'stock_daily'])];
    result.missingDates = [...new Set([...(result.missingDates || []), targetTradeDate])];
    result.stock_market_backfill = { ok: false, status: 'failed', error: stockError.message };
    return result;
  }
  if (stockMarketBackfill && stockMarketBackfill.ok === false && !stockMarketBackfill.continuationRequired) {
    await markStockDailyBackfillStale(targetTradeDate, stockMarketBackfill.error).catch(markError =>
      console.warn('[股债分析缓存] 标记 stock_daily 分区失败：', markError.message));
    result.ok = false;
    result.status = 'partial';
    result.error = stockMarketBackfill.error || '正股历史行情补漏未完成';
    result.errorCode = stockMarketBackfill.errorCode || 'DATASET_INCOMPLETE';
    result.errorType = 'data_quality';
    result.failedDatasets = [...new Set([...(result.failedDatasets || []), 'stock_daily'])];
    result.missingDates = [...new Set([...(result.missingDates || []), targetTradeDate])];
  }
  result.stock_market_backfill = stockMarketBackfill;
  if (stockMarketBackfill && stockMarketBackfill.continuationRequired) {
    result.ok = true;
    result.status = 'partial';
    result.continuationRequired = true;
    result.continuationCount = Number(backfillOpts.continuationCount || 0) + 1;
    result.initialRemaining = Number(backfillOpts.initialRemaining || stockMarketBackfill.initialRemaining || stockMarketBackfill.remaining || 0);
    result.lastRemaining = Number(stockMarketBackfill.remaining || 0);
    const previousRemaining = backfillOpts.lastRemaining == null
      ? Number(stockMarketBackfill.initialRemaining || result.initialRemaining) : Number(backfillOpts.lastRemaining);
    result.noProgressCount = backfillOpts.lastRemaining == null
      ? 0 : result.lastRemaining >= previousRemaining ? Number(backfillOpts.noProgressCount || 0) + 1 : 0;
    result.continuationMaxBatches = Number(backfillOpts.continuationMaxBatches || stockMarketBackfill.continuationMaxBatches || Math.ceil(result.initialRemaining / Math.max(Number(stockMarketBackfill.batchSize || 80), 1)) + 1);
    result.continuationStartedAt = backfillOpts.continuationStartedAt || stockMarketBackfill.continuationStartedAt || new Date().toISOString();
    result.continuationMaxAgeHours = Math.max(Number(backfillOpts.continuationMaxAgeHours || 24), 1);
    const continuationAgeExceeded = Number.isFinite(Date.parse(result.continuationStartedAt))
      && Date.now() - Date.parse(result.continuationStartedAt) >= result.continuationMaxAgeHours * 60 * 60 * 1000;
    result.pendingStages = ['stockMarketBackfill'];
    result.failedDatasets = [...new Set([...(result.failedDatasets || []), 'stock_daily'])];
    result.nextAttemptInMinutes = 1;
    const definitionLimit = Number(backfillOpts.slotExternalCallsLimit || 0);
    const slotTotal = Number(backfillOpts.slotExternalCallsTotal || 0) + Number(result.attemptExternalCalls || result.externalCalls || 0);
    if (result.noProgressCount >= 2 || (definitionLimit > 0 && slotTotal >= definitionLimit)
      || result.continuationCount >= Math.max(1, result.continuationMaxBatches) || continuationAgeExceeded) {
      result.continuationBlocked = true;
      result.continuationStopReason = result.noProgressCount >= 2 ? '连续两批剩余量未下降，已停止自动续批'
        : definitionLimit > 0 && slotTotal >= definitionLimit ? '已达到计划实例累计外部请求上限，已停止自动续批'
          : continuationAgeExceeded ? `续跑已超过${result.continuationMaxAgeHours}小时，已停止自动续批`
            : '已达到续批最大批数，已停止自动续批';
    }
  }
  return result;
}

// 公告事实入库链：只负责抓取并解析“不下修/转股价格调整”公告，分析接口不再直接访问公告源。
async function syncConvertibleBondAnnouncementHistories({ tsCodes = [], fromDate = null, toDate = null, limit = null, cachedOnly = false, retryFailed = false, mode = 'core' } = {}) {
  const end = isoDate(toDate) || tsDateStr(new Date());
  // 显式批次上限：仅归一化为正整数，未传时表示不限批（续跑语义由 continuationRequired 表达）。
  const configuredLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const normalizedCodes = (Array.isArray(tsCodes) ? tsCodes : [tsCodes]).map(normalizeBondCode).filter(Boolean);
  const globalSync = !normalizedCodes.length && !fromDate && !cachedOnly;
  const cursorResult = globalSync ? await repository.select_ops_sync_cursors() : { rows: [] };
  const cursorDate = cursorResult.rows[0] && isoDate(cursorResult.rows[0].last_success_date);
  const scanStart = fromDate ? isoDate(fromDate) : (cursorDate
    ? isoDate(addDays(new Date(`${cursorDate}T00:00:00+08:00`), -ANNOUNCEMENT_OVERLAP_DAYS)) : null);
  const { rows: profiles } = await repository.selectAnnouncementHistoryTargets({
    end, codes: normalizedCodes, cachedOnly, limit: configuredLimit,
  });
  const results = [];
  const sourceFailures = [];
  let changedCount = 0;
  const batchMode = globalSync && !cachedOnly;
  const batchResults = {};
  if (batchMode) {
    const batchStart = scanStart || profiles.map(profile => isoDate(profile.list_date) || isoDate(profile.value_date)).filter(Boolean).sort()[0] || end;
    const markets = [...new Set(profiles.map(profile => String(profile.stock_code || '').endsWith('.SH') ? 'SH' : String(profile.stock_code || '').endsWith('.SZ') ? 'SZ' : ''))].filter(Boolean);
    const collected = await Promise.all(markets.map(async market => [market, await collectConvertibleBondAnnouncementMarket(market, batchStart, end)]));
    for (const [market, value] of collected) batchResults[market] = value;
  }
  const recordedBatchFailures = new Set();
  for (const profile of profiles) {
    const start = scanStart || isoDate(profile.list_date) || isoDate(profile.value_date) || end;
    const stockCode = String(profile.stock_code || '');
    const market = stockCode.endsWith('.SH') ? 'SH' : stockCode.endsWith('.SZ') ? 'SZ' : '';
    // cachedOnly 只重跑库内官方 PDF，不重新请求公告列表，专门用于补齐旧解析器积压。
    let settled;
    if (batchMode) {
      const batch = batchResults[market] || { events: [], failed: true, messages: ['未找到对应市场批量公告结果'] };
      if (batch.failed && !recordedBatchFailures.has(market)) {
        sourceFailures.push({ ts_code: `${market || 'unknown'}:batch`, messages: batch.messages });
        recordedBatchFailures.add(market);
      }
      settled = [{ status: 'fulfilled', value: revisionAnnouncementEvents(eventsForAnnouncementProfile(batch.events, profile, start)),
        reason: batch.failed ? new Error(batch.messages.join('|') || '公告批量来源失败') : null }];
    } else if (cachedOnly) {
      settled = [];
    } else {
      const primary = market === 'SH'
        ? () => fetchSseEvents(stockCode, start, end, '转股价格')
        : market === 'SZ'
          ? () => fetchSzseEvents(stockCode, start, end, '转股价格')
          : () => Promise.reject(Object.assign(new Error(`可转债正股缺少交易所市场映射：${stockCode}`), {
            code: 'MISSING_EXCHANGE', errorType: 'data_quality', source: 'exchange',
          }));
      settled = await Promise.allSettled([primary()]);
    }
    const primaryEvents = settled[0] && settled[0].status === 'fulfilled' ? (settled[0].value || []) : [];
    const rejected = settled.filter(item => item.status === 'rejected');
    const freshAnnouncements = [...new Map(settled.flatMap(item => item.status === 'fulfilled' ? item.value : [])
      .map(event => [announcementSourceKey(event), event])).values()];
    const noRevisionCache = await loadNoRevisionCache(profile.ts_code);
    const priceChangeCache = await loadPriceChangeCache(profile.ts_code);
    const revisionEventCache = cachedOnly && normalizedCodes.length
      ? await loadRevisionEventCache(profile.ts_code) : [];
    // 来源临时失败时，仍可用库内已有的官方 PDF 重新跑新版解析器。
    // 只回放该债最新一条仍待解析的公告，避免每次启动重复下载同一债券的历史 PDF。
    const latestNoRevision = noRevisionCache[0];
    const maturityDate = isoDate(profile.maturity_date);
    const legacyMaturityCandidate = latestNoRevision
      && String(latestNoRevision.parser_version || '') === '7'
      && latestNoRevision.valid_until
      && maturityDate
      && (isoDate(latestNoRevision.valid_until) === maturityDate
        || isoDate(latestNoRevision.next_eligible_date) === maturityDate)
      && latestNoRevision.reparse_status !== 'maturity_checked';
    const parserNeedsReparse = latestNoRevision
      && String(latestNoRevision.parser_version || '') !== '7'
      && (latestNoRevision.next_eligible_date == null || !latestNoRevision.lock_declared);
    const currentParserNeedsReparse = latestNoRevision
      && String(latestNoRevision.parser_version || '') === '7'
      && latestNoRevision.next_eligible_date == null
      && !latestNoRevision.lock_declared
      && !latestNoRevision.no_revision_evidence;
    const cachedRow = latestNoRevision && latestNoRevision.source_url
      && (parserNeedsReparse || currentParserNeedsReparse || legacyMaturityCandidate)
      && (retryFailed || latestNoRevision.reparse_status !== 'failed')
      ? latestNoRevision : null;
    const cachedAnnouncements = cachedRow ? [{
      source: String(cachedRow.source_url).includes('szse.cn') ? 'szse' : (String(cachedRow.source_url).includes('sse.com.cn') ? 'sse' : 'cninfo'),
      source_number: cachedRow.source_url, event_date: isoDate(cachedRow.announced_at), title: cachedRow.summary || '',
      url: cachedRow.source_url, category: '转股价格', is_official: true, raw: { cached_reparse: true },
    }] : [];
    const cachedRevisionAnnouncements = revisionEventCache.map(row => ({
      source: String(row.source_url).includes('szse.cn') ? 'szse' : (String(row.source_url).includes('sse.com.cn') ? 'sse' : 'cninfo'),
      source_number: row.source_number || row.source_url, event_date: isoDate(row.announced_at), title: row.title || '',
      url: row.source_url, category: '转股价格', is_official: true, raw: { cached_reparse: true, revision_event_cache: true },
    }));
    const announcements = [...new Map([...freshAnnouncements, ...cachedAnnouncements, ...cachedRevisionAnnouncements]
      .map(event => [announcementSourceKey(event), event])).values()];
    if (rejected.length && !announcements.length) {
      sourceFailures.push({ ts_code: profile.ts_code, messages: rejected.map(item => String(item.reason && item.reason.message || item.reason || 'unknown')).slice(0, 3) });
    }
    const noRevisionPeriods = await extractNoRevisionPeriods(announcements, noRevisionCache, { allowFailed: retryFailed || !cachedOnly });
    const priceChangeDetails = await extractPriceChangeDetails(announcements, priceChangeCache);
    const cachedReparseChanged = Boolean(cachedRow && noRevisionPeriods.some(row => isoDate(row.announced_at) === isoDate(cachedRow.announced_at)
      && row.reparse_status !== 'failed' && row.parser_version === '7'));
    if (announcements.length) {
      const client = await pool.connect();
      try {
        await txControl.begin(client);
        const sources = await sourceIds(client);
        await saveAnnouncementHistories(client, profile.instrument_id, announcements, profile,
          sources.cninfo || sources.calculated, noRevisionPeriods, priceChangeDetails, sources);
        await saveRevisionEvents(client, profile.instrument_id, announcements, priceChangeDetails,
          sources.cninfo || sources.calculated, sources);
        for (const failure of noRevisionPeriods.filter(row => row.reparse_status === 'failed')) {
          await repository.update_fundamental_convertible_bond_no_revision_history([profile.instrument_id, isoDate(failure.announced_at), failure.reparse_reason || 'parser_output_incomplete'], client);
        }
        if (legacyMaturityCandidate && cachedRow && cachedRow.source_url) {
          await repository.update_fundamental_convertible_bond_no_revision_history_1([profile.instrument_id, isoDate(cachedRow.announced_at)], client);
        }
        await txControl.commit(client);
      } catch (error) {
        await txControl.rollback(client);
        if (globalSync) {
          await repository.insert_ops_sync_cursors_1([String(error.message || error).slice(0, 1000)]);
        }
        throw error;
      } finally { client.release(); }
    }
    if (freshAnnouncements.length || priceChangeDetails.length || cachedReparseChanged) changedCount++;
    results.push({ ts_code: profile.ts_code, discovered: freshAnnouncements.length,
      no_revision: noRevisionPeriods.length, price_changes: priceChangeDetails.length });
  }
  if (sourceFailures.length) {
    const message = `公告源同步失败：${sourceFailures.slice(0, 10).map(item => `${item.ts_code}:${item.messages.join('|')}`).join('; ')}`.slice(0, 1000);
    if (globalSync) {
      await repository.insert_ops_sync_cursors_2([message]);
    }
    throw new Error(message);
  }
  let lifecycle = null;
  let redemption = null;
  let listingLiquidity = null;
  if (globalSync) {
    const officialEvents = uniqueAnnouncementEvents(Object.values(batchResults).flatMap(value => value && value.events || []));
    lifecycle = await require('./convertibleBondLifecycleSync').syncConvertibleBondLifecycleFacts({
      toDate: end,
      officialEvents,
      includeTushare: mode === 'calendar',
    });
    // 17:30 日历槽已经负责上市生命周期；在同一槽内增量抓取上市公告书，
    // 避免日报生成阶段再访问巨潮，也不新增并行定时任务。
    if (mode === 'calendar') {
      const targetListingDate = await nextOpenTradeDate(end);
      let backfillError = null;
      try {
        listingLiquidity = await backfillBondListingLiquidity('calendar_sync');
        console.log(`[上市流通规模] 候选${listingLiquidity.candidates || 0}，保存${listingLiquidity.saved || 0}，失败${listingLiquidity.failed || 0}`);
      } catch (liquidityError) {
        backfillError = liquidityError.message;
        listingLiquidity = { ok: false, error: liquidityError.message, status: 'failed' };
        console.warn('[上市流通规模] 自动补全失败：', liquidityError.message);
      }
      let coverage = null;
      let coverageError = null;
      try {
        coverage = await findBondListingLiquidityGaps(targetListingDate);
      } catch (liquidityError) {
        coverageError = liquidityError.message;
      }
      const missingCodes = coverage ? coverage.missingCodes : ['检查失败'];
      const targetCoverageReady = Boolean(coverage && coverage.missingCodes.length === 0);
      const executionReady = !backfillError && !coverageError && !listingLiquidity.skipped && listingLiquidity.limit == null;
      listingLiquidity = {
        ...listingLiquidity,
        targetListingDate: coverage && coverage.targetDate || targetListingDate || null,
        targetCandidateCodes: coverage && coverage.candidateCodes || [],
        missingCodes,
        historicalFailed: Number(listingLiquidity.failed || 0),
        coverageError,
        errorCode: coverageError ? 'LIQUIDITY_COVERAGE_CHECK_FAILED' : missingCodes.length ? 'DATASET_INCOMPLETE' : null,
        ok: executionReady && targetCoverageReady,
        status: !executionReady ? 'failed' : !targetCoverageReady ? 'partial' : Number(listingLiquidity.failed || 0) ? 'degraded' : 'succeeded',
      };
      if (!listingLiquidity.ok) {
        console.warn(`[上市流通规模] 目标日 ${listingLiquidity.targetListingDate || '未知'} 仍缺少：${missingCodes.join('、') || '未知'}`);
      }
    }
    redemption = await require('./convertibleBondRedemptionSync').syncConvertibleBondCallAnnouncements({
      fromDate: scanStart || end,
      toDate: end,
      officialEvents,
    });
  } else if (cachedOnly) {
    redemption = await require('./convertibleBondRedemptionSync').syncConvertibleBondCallAnnouncements({
      fromDate: scanStart || '2000-01-01',
      toDate: end,
      cachedOnly: true,
      retryFailed,
      limit: configuredLimit,
    });
  }
  if (globalSync && !configuredLimit) {
    await repository.insert_ops_sync_cursors_3([end]);
  }
  const limited = configuredLimit !== null;
  const liquidityIncomplete = mode === 'calendar' && listingLiquidity && listingLiquidity.ok === false;
  const publishDatasetCodes = ['bond_announcement_facts','bond_issuance_events','bond_redemption_events',
    ...(mode==='calendar'?['bond_listing_liquidity']:[])];
  return {
    ok: !limited && !liquidityIncomplete,
    stageComplete:!limited&&!liquidityIncomplete&&(!redemption||redemption.ok!==false),
    status: limited ? 'partial' : liquidityIncomplete ? 'partial' : 'succeeded',
    limit: configuredLimit, continuationRequired: limited,
    publishDatasetCodes,
    failedDatasets: liquidityIncomplete ? ['bond_listing_liquidity'] : [],
    error: liquidityIncomplete
      ? `目标上市日 ${listingLiquidity.targetListingDate || '未知'} 的流通规模事实尚未入库：${(listingLiquidity.missingCodes || []).join('、') || '检查失败'}`
      : null,
    errorCode: liquidityIncomplete ? (listingLiquidity.errorCode || 'DATASET_INCOMPLETE') : null,
    errorType: liquidityIncomplete ? 'data_quality' : null,
    missingCodes: listingLiquidity && listingLiquidity.missingCodes || [],
    missingDates: listingLiquidity && listingLiquidity.targetListingDate ? [listingLiquidity.targetListingDate] : [],
    mode, dataAsOf: end, fromDate: scanStart || null, toDate: end, count: results.length, changed_count: changedCount,
    cursorDate: cursorDate || null, lifecycle, listingLiquidity, redemption,
    datasetDiagnostics: {
      bond_issuance_events: {
        query_status: 'success',
        quality_status: 'passed',
        issue_count: Number(lifecycle && lifecycle.issueCount || 0),
        official_count: Number(lifecycle && lifecycle.officialCount || 0),
      },
      ...(mode === 'calendar' ? { bond_listing_liquidity: {
        quality_status: listingLiquidity && listingLiquidity.ok !== false ? 'passed' : 'stale',
        query_status: listingLiquidity && listingLiquidity.coverageError ? 'failed' : (listingLiquidity ? 'success' : 'not_run'),
        coverage_status: listingLiquidity && listingLiquidity.missingCodes && listingLiquidity.missingCodes.length ? 'incomplete' : 'verified_no_change',
        status: listingLiquidity && listingLiquidity.status || (listingLiquidity && listingLiquidity.ok !== false ? 'succeeded' : 'stale'),
        saved: Number(listingLiquidity && listingLiquidity.saved || 0),
        failed: Number(listingLiquidity && listingLiquidity.failed || 0),
        target_listing_date: listingLiquidity && listingLiquidity.targetListingDate || null,
        target_candidate_count: Number(listingLiquidity && listingLiquidity.targetCandidateCodes && listingLiquidity.targetCandidateCodes.length || 0),
        missing_codes: listingLiquidity && listingLiquidity.missingCodes || [],
      } } : {}),
      bond_announcement_facts: { query_status: 'success', quality_status: 'passed', changed_count: changedCount },
      bond_redemption_events: {
        query_status: redemption ? 'success' : 'not_run',
        quality_status: redemption && redemption.diagnostics && redemption.diagnostics.quality_status || 'failed',
        discovered: Number(redemption && redemption.discovered || 0),
        call_candidates: Number(redemption && redemption.call_candidates || 0),
        matched: Number(redemption && redemption.matched || 0),
        documents_ready: Number(redemption && redemption.documents_ready || 0),
        parse_complete: Number(redemption && redemption.parse_complete || 0),
        parse_partial: Number(redemption && redemption.parse_partial || 0),
        unmatched: Number(redemption && redemption.unmatched || 0),
        download_failed: Number(redemption && redemption.download_failed || 0),
        extract_failed: Number(redemption && redemption.extract_failed || 0),
        pending_old_parser: Number(redemption && redemption.pending_old_parser || 0),
        projection_advanced: Boolean(redemption && redemption.diagnostics && redemption.diagnostics.projection_advanced),
      },
    },
    results,
  };
}

function symbolicReportPattern(period) {
  const match = String(period || '').match(/^(20\d{2})-Q3$/);
  return match ? new RegExp(`${match[1]}年(?:第?三季度|三季度)报告`) : null;
}

async function nextOpenTradeDate(date) {
  const { rows } = await repository.select_market_trade_calendar_1([isoDate(date)]);
  return rows[0] && isoDate(rows[0].trade_date);
}

// 无固定日期的不下修锁定：先按季度报告披露窗口保持锁定，临近窗口后每日扫描交易所公告，
// 找到审议该季度报告的董事会公告后，再把锁定期改成真实会议日和下一交易日。
async function resolveConvertibleBondSymbolicLocks({ force = false } = {}) {
  const jobName = 'convertible_bond_symbolic_lock_resolver';
  if (!(await tryClaimJob(jobName))) return { skipped: true, reason: 'already_running' };
  const failures = [];
  let scanned = 0, resolved = 0, skipped = 0;
  try {
    const today = isoDate(new Date());
    const { rows } = await repository.select_fundamental_convertible_bond_no_revision_history();
    for (const row of rows) {
      const raw = row.raw_payload || {};
      const checkFrom = isoDate(raw.symbolic_check_from);
      if (!force && checkFrom && today < checkFrom) { skipped++; continue; }
      scanned++;
      try {
        const pattern = symbolicReportPattern(raw.symbolic_report_period);
        if (!pattern) continue;
        const stockCode = String(row.stock_code || '');
        const fetcher = stockCode.endsWith('.SH') ? fetchSseEvents : stockCode.endsWith('.SZ') ? fetchSzseEvents : null;
        if (!fetcher) continue;
        const events = await fetcher(stockCode, checkFrom || row.announced_at, today, '');
        const reports = events.filter(event => pattern.test(String(event.title || '').replace(/\s+/g, ''))
          && isoDate(event.event_date) && isoDate(event.event_date) >= (checkFrom || row.announced_at));
        if (!reports.length) continue;
        const reportDate = reports.map(event => isoDate(event.event_date)).sort()[0];
        const boardEvents = events.filter(event => /董事会/.test(String(event.title || '').replace(/\s+/g, ''))
          && isoDate(event.event_date) >= reportDate
          && isoDate(event.event_date) <= isoDate(addDays(new Date(`${reportDate}T00:00:00+08:00`), 31)));
        if (!boardEvents.length) continue;
        const boardEvent = boardEvents.sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)))[0];
        const meetingDate = isoDate(boardEvent.event_date);
        const nextEligible = await nextOpenTradeDate(meetingDate);
        if (!nextEligible) continue;
        await repository.update_fundamental_convertible_bond_no_revision_history_2([row.history_id, meetingDate, nextEligible, reportDate, boardEvent.url || '', boardEvent.title || '']);
        resolved++;
      } catch (error) {
        failures.push({ ts_code: row.stock_code, message: String(error && error.message || error).slice(0, 300) });
      }
    }
    return { ok: true, scanned, resolved, skipped, failures };
  } finally {
    await releaseJob(jobName);
  }
}

async function backfillUnderlyingStockMarket({ windowDays = 500, targetTradeDate = null, continuationCount = 0 } = {}) {
  const jobName = 'convertible_bond_stock_market_backfill';
  if (!(await tryClaimJob(jobName))) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun(jobName);
  let filledDays = 0;
  let savedBars = 0;
  let savedValuations = 0;
  let emptyDays = 0;
  let repairedBars = 0;
  try {
    const { rows } = await repository.select_fundamental_convertible_bond_profiles_1([isoDate(targetTradeDate) || tsDateStr(new Date())]);
    const instrumentMap = new Map(rows.map(row => [row.canonical_code, row.instrument_id]));
    const openDays = await getRecentOpenDays(windowDays, targetTradeDate);
    const source = await sourceIds();
    for (const tradeDate of openDays) {
      const coverage = await repository.select_market_stock_suspend_calendar([[...instrumentMap.values()], isoDate(tradeDate), source.tushare]);
      const expectedCount = Number(coverage.rows[0].expected || 0);
      if (!expectedCount || (coverage.rows[0].bars >= expectedCount * 0.9 && coverage.rows[0].valuations >= expectedCount * 0.9)) continue;
      // 补历史时严格串行调用并限速，避免 daily + daily_basic 并发形成请求洪峰；
      // 日期参数统一使用 Tushare 的 YYYYMMDD。
      const dailyData = await tushareQuery('daily', { trade_date: tradeDate.replace(/-/g, '') }, 'ts_code,trade_date,open,high,low,close,vol,amount', { allowEmpty: true });
      await new Promise(resolve => setTimeout(resolve, 1200));
      const valuationData = await tushareQuery('daily_basic', { trade_date: tradeDate.replace(/-/g, '') }, 'ts_code,trade_date,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv', { allowEmpty: true });
      await new Promise(resolve => setTimeout(resolve, 1200));
      const client = await pool.connect();
      try {
        await txControl.begin(client);
        const saved = await saveFullStockMarketPartition(client, instrumentMap, tsRows(dailyData), tsRows(valuationData), source.tushare);
        await txControl.commit(client);
        savedBars += saved.bars;
        savedValuations += saved.valuations;
        if (saved.bars || saved.valuations) filledDays += 1;
        else emptyDays += 1;
      } catch (error) {
        await txControl.rollback(client);
        throw error;
      } finally {
        client.release();
      }
      if (filledDays % 20 === 0) console.log(`[股债分析缓存] 已补齐 ${filledDays} 个交易日`);
    }
    // 批量按交易日接口可能因上游行数限制遗漏少量证券；再按正股代码补一次最近30个开市日，
    // 只处理确实存在缺口的证券，避免“整体覆盖率90%”掩盖单券缺失。
    const recentDays = openDays.slice(-30);
    if (recentDays.length) {
      // 缺口判定（停牌日排除 + 行情行数与应开市日数比较）在数据层完成
      const missingStockParams = [[...instrumentMap.values()], recentDays.map(isoDate), source.tushare];
      const { rows: missingStocks } = await repository.selectMissingStockBars(missingStockParams);
      const repairLimit = Math.max(Number(process.env.CONVERTIBLE_BOND_STOCK_REPAIR_LIMIT) || 80, 1);
      const repairTargets = missingStocks.slice(0, repairLimit);
      for (const stock of repairTargets) {
        const daily = await tushareQuery('daily', {
          ts_code: stock.canonical_code,
          start_date: recentDays[0].replace(/-/g, ''),
          end_date: recentDays[recentDays.length - 1].replace(/-/g, ''),
        }, 'ts_code,trade_date,open,high,low,close,vol,amount', { allowEmpty: true });
        const client = await pool.connect();
        try {
          await txControl.begin(client);
          const saved = await saveFullStockMarketPartition(client, instrumentMap, tsRows(daily), [], source.tushare);
          await txControl.commit(client);
          repairedBars += saved.bars;
        } catch (error) {
          await txControl.rollback(client);
          throw error;
        } finally { client.release(); }
      }
      const { rows: remainingStocks } = await repository.selectMissingStockBars(missingStockParams);
      if (remainingStocks.length) {
        const detail = `最近30个交易日仍有 ${remainingStocks.length} 只正股行情缺口，本批已处理 ${repairTargets.length} 只`;
        await finishJobRun(runId, true, detail);
        return {
          skipped: false, ok: false, status: 'partial', continuationRequired: true,
          continuationCount: Number(continuationCount || 0) + 1,
          initialRemaining: Number(missingStocks.length || 0), lastRemaining: Number(remainingStocks.length || 0),
          batchSize: repairLimit,
          continuationMaxBatches: Math.ceil(Number(missingStocks.length || 0) / repairLimit) + 1,
          targetTradeDate: isoDate(targetTradeDate), filled_days: filledDays, saved_bars: savedBars,
          saved_valuations: savedValuations, repaired_bars: repairedBars, empty_days: emptyDays,
          stock_count: instrumentMap.size, remaining: remainingStocks.length,
          failedDatasets: ['stock_daily'], pendingStages: ['stockMarketBackfill'],
          datasetDiagnostics: { stock_daily: { query_status: 'partial', remaining_count: remainingStocks.length } },
        };
      }
      if (repairedBars) console.log(`[股债分析缓存] 按正股代码补齐 ${repairedBars} 行最近行情`);
    }
    await finishJobRun(runId, true, `补齐 ${filledDays} 个交易日（行情 ${savedBars} 行、估值 ${savedValuations} 行、按代码补 ${repairedBars} 行，空日 ${emptyDays}），覆盖 ${instrumentMap.size} 只正股`);
    return { skipped: false, filled_days: filledDays, saved_bars: savedBars, saved_valuations: savedValuations, repaired_bars: repairedBars, empty_days: emptyDays, stock_count: instrumentMap.size };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally {
    await releaseJob(jobName);
  }
}

module.exports = {
  announcementMatchesBond,
  announcementDateWindows,
  uniqueAnnouncementEvents,
  revisionAnnouncementEvents,
  relevantConvertibleBondAnnouncements,
  matchesUnassignedAnnouncement,
  collectAnnouncementSource,
  collectConvertibleBondAnnouncementMarket,
  eventsForAnnouncementProfile,
  saveAnnouncementHistories,
  saveTriggerProgress,
  latestTradeDates,
  latestFullBondDaily,
  bondGapQueueHash,
  addCalendarDays,
  addTradingDays,
  classifyBondObjectStatus,
  buildBondGapQueue,
  readBondGapQueue,
  writeBondGapQueue,
  isTencentBondWindow,
  recordedNextBondTradeDate,
  fetchTargetedBondDaily,
  updateBondFallbackRuntime,
  activeProfile,
  isUnderlyingStockListed,
  runBondFirstDayBackfill,
  runBondIssueResultBackfill,
  backfillBondFirstDayPerformance,
  backfillBondIssueResults,
  runBondLiquidityBackfill,
  backfillBondListingLiquidity,
  findBondListingLiquidityGaps,
  handleConvPriceChanges,
  syncConvertibleBondUniverse,
  getRecentOpenDays,
  backfillCycleGaps,
  repairConvertibleBondSuspensionCoverage,
  markStockDailyBackfillStale,
  syncConvertibleBondUniverseWithBackfill,
  syncConvertibleBondUniverseMarketWithBackfill,
  syncConvertibleBondAnnouncementHistories,
  symbolicReportPattern,
  nextOpenTradeDate,
  resolveConvertibleBondSymbolicLocks,
  backfillUnderlyingStockMarket,
};
