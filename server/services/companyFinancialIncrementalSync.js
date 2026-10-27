// 公司级财务增量同步：唯一负责把 Tushare 财报写入标准财务层。
// 安全性和股票分析只读这里的已入库事实，不在请求链路内补数。
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { withTransaction } = require('../db/transaction');
const financialRepository = require('../repositories/companyFinancialRepository');
const { createIngestionRun } = require('../repositories/stockProjectionRepository');
const { tushareQuery, tsRows, toTsCode, tsDateStr } = require('./market');
const { statementApiFields } = require('./stockStatements');
const { syncReportRows } = require('./financialDataArchitecture');
const { markDatasetFailure, markDatasetSuccess } = require('./datasetCursors');
const { getExternalCallStats } = require('./externalCallGuard');

const JOB_NAME = 'company_financial_incremental_sync';
const REPORT_KINDS = ['income', 'balance', 'cashflow', 'indicator'];
const REPORT_SPECS = Object.freeze({
  income: { api: 'income', vipApi: 'income_vip', fields: statementApiFields('income'), dateMode: 'announcement' },
  balance: { api: 'balancesheet', vipApi: 'balancesheet_vip', fields: statementApiFields('balance'), dateMode: 'announcement' },
  cashflow: { api: 'cashflow', vipApi: 'cashflow_vip', fields: statementApiFields('cashflow'), dateMode: 'announcement' },
  indicator: { api: 'fina_indicator', vipApi: 'fina_indicator_vip', fields: 'ts_code,ann_date,end_date,report_type,comp_type,update_flag,roe,roa,ebit,ebit_to_interest,interestdebt,profit_dedt,dt_netprofit_yoy', dateMode: 'period' },
});

function normalizeDate(value) {
  if (value instanceof Date) return tsDateStr(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

function apiDate(value) {
  const date = normalizeDate(value);
  return date ? date.replace(/-/g, '') : null;
}

function previousDate(value, days) {
  const date = new Date(`${normalizeDate(value)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - Number(days || 0));
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function currentReportPeriods(asOfDate = tsDateStr(new Date())) {
  const today = normalizeDate(asOfDate) || tsDateStr(new Date());
  const year = Number(today.slice(0, 4));
  const periods = [year, year - 1]
    .flatMap(value => ['1231', '0930', '0630', '0331'].map(suffix => `${value}${suffix}`))
    .filter(period => period <= today.replace(/-/g, ''))
    .sort().reverse();
  return periods.slice(0, 2);
}

function isDisclosureSeason(asOfDate = tsDateStr(new Date())) {
  const date = normalizeDate(asOfDate);
  if (!date) return false;
  return [1, 4, 5, 8, 9, 10, 11].includes(Number(date.slice(5, 7)));
}

function uniqueTarget(targets) {
  const map = new Map();
  for (const target of targets || []) {
    if (!target || !target.companyId || !target.tsCode) continue;
    const key = String(target.companyId);
    const previous = map.get(key);
    if (!previous) map.set(key, { ...target, reasons: [...new Set(target.reasons || [])] });
    else previous.reasons = [...new Set([...(previous.reasons || []), ...(target.reasons || [])])];
  }
  return [...map.values()];
}

async function listTargetCompanies(client = pool, targetTradeDate = null) {
  if (!targetTradeDate) return listCurrentBondUnderlyingTargets(client);
  return listCurrentBondUnderlyingTargets(client, targetTradeDate);
}

async function listCurrentBondUnderlyingTargets(client = pool, targetTradeDate = null) {
  const rows = await financialRepository.listBondUnderlyingRows({ targetTradeDate }, client);
  return uniqueTarget(rows.map(row => ({
    companyId: row.company_id,
    instrumentId: row.stock_instrument_id || row.instrument_id,
    tsCode: row.ts_code,
    reasons: ['convertible_bond'],
  })));
}

async function readCompanyStates(targets, client = pool) {
  const companyIds = [...new Set((targets || []).map(target => target.companyId).filter(Boolean))];
  if (!companyIds.length) return new Map();
  const rows = await financialRepository.listCompanyReportRows({ companyIds }, client);
  const map = new Map();
  for (const row of rows) {
    const key = String(row.company_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function stateForTarget(target, rows, options = {}) {
  const latestByKind = new Map();
  const completePeriods = new Set();
  for (const row of rows || []) {
    if (String(row.report_type || '') !== '1') continue;
    if (!latestByKind.has(row.report_kind)) latestByKind.set(row.report_kind, row);
    const period = normalizeDate(row.period_end);
    if (period) {
      const kinds = rows.filter(item => String(item.report_type || '') === '1' && normalizeDate(item.period_end) === period).map(item => item.report_kind);
      if (REPORT_KINDS.every(kind => kinds.includes(kind))) completePeriods.add(period);
    }
  }
  const missingKinds = REPORT_KINDS.filter(kind => !latestByKind.has(kind));
  const requestedPeriods = (options.reportPeriods || []).map(apiDate).filter(Boolean);
  const missingPeriods = requestedPeriods.filter(period => !completePeriods.has(normalizeDate(period)));
  return { missingKinds, missingPeriods, completePeriods: [...completePeriods], latestByKind };
}

async function readFinancialCursors(targets, client = pool, datasetCode = 'financial') {
  const scopes = (targets || []).flatMap(target => REPORT_KINDS.map(kind => `company:${target.companyId}:${kind}`));
  if (!scopes.length) return new Map();
  const rows = await financialRepository.listFinancialCursors({ scopes, datasetCode }, client);
  return new Map(rows.map(row => [row.scope_key, row]));
}

function retryDue(cursor, now = Date.now()) {
  if (!cursor || !cursor.last_error) return false;
  const attempted = new Date(cursor.last_attempt_at || 0).getTime();
  if (!Number.isFinite(attempted)) return true;
  const delay = Math.min(24 * 60 * 60 * 1000, Math.max(15 * 60 * 1000, Number(cursor.retry_count || 1) * 30 * 60 * 1000));
  return now - attempted >= delay;
}

async function buildSyncQueue(targets, options = {}, client = pool) {
  const states = await readCompanyStates(targets, client);
  const cursors = await readFinancialCursors(targets, client);
  const asOfDate = apiDate(options.asOfDate || tsDateStr(new Date()));
  const disclosedPeriods = new Set((options.disclosureRows || []).filter(row => {
    const dueDate = apiDate(row.actual_date || row.pre_date);
    return dueDate && dueDate <= asOfDate;
  }).map(row => `${String(row.ts_code || '').trim().toUpperCase()}:${apiDate(row.end_date)}`));
  return (targets || []).map(target => {
    const state = stateForTarget(target, states.get(String(target.companyId)) || [], options);
    const disclosed = state.missingPeriods.some(period => disclosedPeriods.has(`${String(target.tsCode).toUpperCase()}:${period}`));
    const candidateKinds = new Set();
    if (state.missingKinds.length) state.missingKinds.forEach(kind => candidateKinds.add(kind));
    if (state.missingPeriods.length && (disclosed || options.includeHistoricalGaps === true)) {
      REPORT_KINDS.forEach(kind => candidateKinds.add(kind));
    }
    REPORT_KINDS.filter(kind => retryDue(cursors.get(`company:${target.companyId}:${kind}`)))
      .forEach(kind => candidateKinds.add(kind));
    if (options.force) REPORT_KINDS.forEach(kind => candidateKinds.add(kind));
    const needs = [...candidateKinds].filter(kind => {
      if (options.force) return true;
      const cursor = cursors.get(`company:${target.companyId}:${kind}`);
      return !cursor || !cursor.last_error || retryDue(cursor);
    });
    return needs.length ? { ...target, needs, state } : null;
  }).filter(Boolean);
}

async function queryRows(apiName, params, fields, query = tushareQuery) {
  const payload = await query(apiName, params, fields, { allowEmpty: true });
  return tsRows(payload).map(row => {
    // Tushare 标准和 VIP 财务指标接口均不返回 report_type；按接口的合并指标口径补齐标准层 type=1。
    if (['fina_indicator', 'fina_indicator_vip'].includes(apiName)
      && !Object.prototype.hasOwnProperty.call(row, 'report_type')) return { ...row, report_type: '1' };
    return row;
  }).filter(row => String(row.report_type || '') === '1');
}

function shouldAbortFinancialBatch(error) {
  return ['JOB_BUDGET_EXCEEDED', 'BUDGET_WAIT', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN',
    'AUTH_ERROR', 'PERMISSION_DENIED', 'POLICY_DISABLED', 'POLICY_NOT_CONFIGURED']
    .includes(String(error && error.code || '').toUpperCase());
}

async function fetchDisclosureCandidates(targets, options = {}) {
  const query = options.query || tushareQuery;
  const today = apiDate(options.asOfDate || tsDateStr(new Date()));
  const periods = (options.reportPeriods || currentReportPeriods(options.asOfDate)).map(apiDate).filter(Boolean);
  const rows = [];
  for (const period of periods.slice(0, 2)) {
    const payload = await query('disclosure_date', { end_date: period }, 'ts_code,end_date,pre_date,ann_date,actual_date,modify_date', { allowEmpty: true });
    rows.push(...tsRows(payload).filter(row => !today || !row.ann_date || apiDate(row.ann_date) <= today));
  }
  const targetCodes = new Set((targets || []).map(target => String(target.tsCode).toUpperCase()));
  return rows.filter(row => targetCodes.has(String(row.ts_code || '').toUpperCase()));
}

function requestParams(spec, target, options = {}) {
  const today = apiDate(options.asOfDate || tsDateStr(new Date()));
  if (options.startDate) return { ts_code: target.tsCode, start_date: apiDate(options.startDate), end_date: today,
    ...(spec.dateMode === 'announcement' ? { report_type: '1' } : {}) };
  if (spec.dateMode === 'period') {
    const periods = (options.reportPeriods || currentReportPeriods(options.asOfDate)).map(apiDate).filter(Boolean).sort();
    return { ts_code: target.tsCode, start_date: periods[0] || previousDate(today, 365), end_date: periods[periods.length - 1] || today };
  }
  const cursorDate = options.cursor && options.cursor.last_source_update;
  return { ts_code: target.tsCode, start_date: cursorDate ? previousDate(cursorDate, 30) : previousDate(today, 730), end_date: today, report_type: '1' };
}

async function fetchCompanyReports(target, options = {}) {
  const query = options.query || tushareQuery;
  const preferVip = options.preferVip === true || String(process.env.FINANCIAL_PREFER_VIP || '') === '1';
  const results = {};
  const errors = {};
  for (const kind of (target.needs || REPORT_KINDS)) {
    const spec = REPORT_SPECS[kind];
    if (!spec) continue;
    const apiName = preferVip ? spec.vipApi : spec.api;
    try {
      const params = requestParams(spec, target, options);
      let rows;
      if (options.historyFull) {
        rows = [];
        for (const [start, end] of require('./stockAnalysis').ranges(params.start_date, params.end_date, 5)) {
          const batch = await queryRows(apiName, { ...params, start_date: start, end_date: end }, spec.fields, query);
          if (batch.length >= 100) {
            // 较大响应再缩小窗口，不能把供应商截断的数据当成完整历史。
            for (const [yearStart, yearEnd] of require('./stockAnalysis').ranges(start, end, 1)) {
              const yearRows = await queryRows(apiName, { ...params, start_date: yearStart, end_date: yearEnd }, spec.fields, query);
              if (yearRows.length >= 100) throw new Error(`${apiName} 单年度响应仍可能被截断，保留历史待补状态`);
              rows.push(...yearRows);
            }
          } else rows.push(...batch);
        }
      } else rows = await queryRows(apiName, params, spec.fields, query);
      results[kind] = rows;
      // fina_indicator 官方单次上限为100；按报告期切片后再取，避免把截断结果当成完整数据。
      if (!options.historyFull && kind === 'indicator' && rows.length >= 100 && !options.disableTruncationProbe) {
        const periods = (options.reportPeriods || currentReportPeriods(options.asOfDate)).map(apiDate).filter(Boolean);
        const split = [];
        for (const period of periods) {
          split.push(...await queryRows(apiName, { ts_code: target.tsCode, start_date: period, end_date: period }, spec.fields, query));
        }
        results[kind] = [...new Map(split.map(row => [`${row.end_date}:${row.ann_date || ''}:${row.update_flag || ''}`, row])).values()];
      }
    } catch (error) {
      if (shouldAbortFinancialBatch(error)) throw error;
      errors[kind] = error;
      results[kind] = [];
    }
  }
  return { results, errors };
}

async function persistCompanyReports(target, reportResult, options = {}) {
  const successful = [];
  const failed = [];
  let ingestionRunId = null;
  return withTransaction(async client => {
    const source = await financialRepository.readTushareSource({}, client);
    if (!source) throw new Error('未找到 Tushare 数据源登记');
    ingestionRunId = await createIngestionRun({ sourceId: source.source_id, datasetCode: 'stock_financial_reports',
      requestRange: { company_id: target.companyId, ts_code: target.tsCode, kinds: target.needs || REPORT_KINDS } }, client);
    for (const kind of (target.needs || REPORT_KINDS)) {
      const rows = reportResult.results[kind] || [];
      const error = reportResult.errors[kind];
      const scope = `company:${target.companyId}:${kind}`;
      if (rows.length) {
        await syncReportRows(client, rows, kind, target.companyId, source.source_id, { runId: ingestionRunId, reportTypeOnly: '1' });
        const latestPeriod = rows.map(row => row.end_date).sort().pop();
        const latestAnnouncement = rows.map(row => row.f_ann_date || row.ann_date).filter(Boolean).sort().pop();
        await markDatasetSuccess(scope, 'financial', { client, companyId: target.companyId, instrumentId: target.instrumentId,
          lastSuccessDate: normalizeDate(latestPeriod), lastSourceUpdate: normalizeDate(latestAnnouncement) });
        successful.push(kind);
        if (options.historyStart) await financialRepository.writeFinancialHistoryCursor({
          companyId: target.companyId, instrumentId: target.instrumentId, scope,
          historyStart: normalizeDate(options.historyStart) }, client);
      } else {
        const message = error ? `${error.code || 'FINANCIAL_SYNC_FAILED'}: ${error.message}` : '接口返回空数组，保留上一份有效数据';
        await markDatasetFailure(scope, 'financial', message, { client, companyId: target.companyId, instrumentId: target.instrumentId });
        failed.push({ kind, error: message });
      }
    }
    const status = failed.length ? (successful.length ? 'degraded' : 'failed') : 'succeeded';
    await financialRepository.finishFinancialIngestion({ runId: ingestionRunId, status,
      rowCount: successful.reduce((count, kind) => count + (reportResult.results[kind] || []).length, 0),
      errorMessage: failed.map(item => `${item.kind}:${item.error}`).join('；') }, client);
    return { ok: failed.length === 0, successful, failed, ingestionRunId };
  });
}

async function latestFinancialDataAsOf(client = pool) {
  const row = await financialRepository.readLatestFinancialData({}, client);
  return { dataAsOf: row && row.data_as_of ? String(row.data_as_of).slice(0, 10) : null, rowCount: Number(row && row.row_count || 0) };
}

function selectCompanyBatch(queue, requestedLimit, options = {}) {
  const limit = Math.max(1, Number(requestedLimit || 20));
  const configuredCallLimit = process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE === '1'
    ? Number(process.env.JOB_EXTERNAL_CALL_LIMIT) : null;
  if (!Number.isFinite(configuredCallLimit)) return (queue || []).slice(0, limit);
  const usedCalls = Number(options.usedCalls ?? getExternalCallStats().total ?? 0);
  let availableCalls = Math.max(0, configuredCallLimit - usedCalls - 2);
  const batch = [];
  for (const target of (queue || []).slice(0, limit)) {
    const expectedCalls = Math.max(1, (target.needs || REPORT_KINDS).length);
    if (expectedCalls > availableCalls) break;
    batch.push(target);
    availableCalls -= expectedCalls;
  }
  return batch;
}

async function runCompanyFinancialIncrementalSync(reason = 'scheduled', options = {}) {
  if (!(await tryClaimJob(JOB_NAME))) return { ok: false, skipped: true, reason: 'already_running' };
  const runId = await startJobRun(JOB_NAME);
  try {
    if (options.mode === 'stock_analysis') {
      const result = await syncRequestedStockAnalysis(options);
      await finishJobRun(runId, true, `指定股票分析完成：${result.tsCode}`);
      return result;
    }
    const targets = await listTargetCompanies(pool, options.targetTradeDate || options.asOfDate || null);
    const reportPeriods = options.reportPeriods || currentReportPeriods(options.asOfDate);
    const localQueue = await buildSyncQueue(targets, { ...options, reportPeriods, disclosureRows: [] });
    // 披露季按活跃报告期刷新披露计划；非披露季只处理本地缺口、失败重试和新增公司。
    // 这样既保留 disclosure_date 这个正式队列输入，又避免非披露期扫描全量公司。
    const shouldProbeDisclosure = !options.skipDisclosure
      && (options.checkDisclosure === true || localQueue.length > 0 || isDisclosureSeason(options.asOfDate));
    const disclosureRows = shouldProbeDisclosure ? await fetchDisclosureCandidates(targets, { ...options, reportPeriods }).catch(error => {
      console.warn('[financial-sync] disclosure_date 获取失败，继续处理本地缺口：', error.message);
      return [];
    }) : [];
    const queue = disclosureRows.length ? await buildSyncQueue(targets, { ...options, reportPeriods, disclosureRows }) : localQueue;
    if (!queue.length) {
      const latest = await latestFinancialDataAsOf();
      await finishJobRun(runId, true, '无新增财报、缺口或重试对象，未调用财务接口');
      return { ok: true, status: 'succeeded', changed: false, targetDate: options.targetTradeDate || options.targetDate || options.asOfDate || null, externalCallCount: 0, publishDatasets: false, dataAsOf: latest.dataAsOf,
        datasetDiagnostics: { stock_financial_reports: {
          partition_row_count: latest.rowCount, valid_report_rows: latest.rowCount, target_count: targets.length,
          queue_count: 0, changed_rows: 0, query_status: 'success', coverage_status: 'verified_no_change',
        } }, reason };
    }
    const limit = Math.max(1, Number(options.companyLimit || process.env.FINANCIAL_SYNC_COMPANY_BATCH_SIZE || 20));
    const batch = selectCompanyBatch(queue, limit);
    const failures = [];
    let changed = 0;
    for (const target of batch) {
      const cursors = await readFinancialCursors([target]);
      const reportResult = await fetchCompanyReports(target, { ...options, reportPeriods, cursor: cursors.get(`company:${target.companyId}:${target.needs[0]}`) });
      try {
        const persisted = await persistCompanyReports(target, reportResult, options);
        if (!persisted.ok) failures.push({ companyId: target.companyId, tsCode: target.tsCode, failed: persisted.failed });
        else changed += 1;
      } catch (error) {
        failures.push({ companyId: target.companyId, tsCode: target.tsCode, error: error.message });
      }
    }
    const remaining = Math.max(queue.length - batch.length, 0);
    const latest = await latestFinancialDataAsOf();
    const complete = failures.length === 0 && remaining === 0;
    const ok = failures.length === 0;
    const continuationRequired = ok && remaining > 0;
    const continuationCount = Number(options.continuationCount || 0) + (continuationRequired ? 1 : 0);
    const initialRemaining = Number(options.initialRemaining || queue.length);
    const lastRemaining = remaining;
    const previousRemaining = Number(options.lastRemaining ?? initialRemaining);
    const noProgressCount = continuationRequired && lastRemaining >= previousRemaining
      ? Number(options.noProgressCount || 0) + 1 : 0;
    const continuationMaxBatches = Number(options.continuationMaxBatches || Math.ceil(initialRemaining / Math.max(batch.length, 1)) + 1);
    const continuationStartedAt = continuationRequired
      ? options.continuationStartedAt || new Date().toISOString() : options.continuationStartedAt || null;
    const continuationAgeExceeded = continuationStartedAt
      && Date.now() - new Date(continuationStartedAt).getTime() >= 24 * 60 * 60 * 1000;
    const result = { ok, status: complete ? 'succeeded' : ok ? 'partial' : 'degraded', changed: changed > 0, targetDate: options.targetTradeDate || options.targetDate || options.asOfDate || null, dataAsOf: latest.dataAsOf,
      publishDatasets: complete && changed > 0, externalCallCount: null, processed: batch.length, queued: queue.length, remaining,
      failures, reason, continuationRequired, continuationCount, initialRemaining, lastRemaining, noProgressCount,
      continuationMaxBatches, pendingStages: continuationRequired ? ['financialReports'] : [],
      nextAttemptInMinutes: continuationRequired ? 1 : null,
      continuationStartedAt,
      ...(continuationRequired && (noProgressCount >= 2 || continuationAgeExceeded) ? { continuationBlocked: true, continuationStopReason: continuationAgeExceeded ? '续批超过 24 小时，已停止自动续批' : '连续两批剩余公司数量未下降，已停止自动续批' } : {}),
      datasetDiagnostics: { stock_financial_reports: { partition_row_count: latest.rowCount, queue_count: queue.length, processed_count: batch.length, failed_count: failures.length } } };
    const detail = complete ? `处理 ${batch.length} 家公司，新增或更新 ${changed} 家`
      : failures.length ? `财务增量未完整完成：失败 ${failures.length} 家，剩余 ${remaining} 家`
        : `本批处理 ${batch.length} 家公司，剩余 ${remaining} 家等待后续增量批次`;
    await finishJobRun(runId, ok, detail);
    if (!ok) result.error = detail;
    return result;
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally {
    await releaseJob(JOB_NAME);
  }
}

async function enqueueCompanyFinancialSyncByCode(rawCode, reason = 'request') {
  const tsCode = toTsCode(String(rawCode || '').trim());
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(tsCode)) return { queued: false, reason: 'invalid_code' };
  const target = (await listCurrentBondUnderlyingTargets()).find(item => item.tsCode === tsCode);
  if (!target) return { queued: false, reason: 'not_current_listed_bond_underlying' };
  for (const kind of REPORT_KINDS) {
    await financialRepository.markFinancialSyncPending({ companyId: target.companyId, instrumentId: target.instrumentId,
      scope: `company:${target.companyId}:${kind}`, message: `${reason}: 等待财务增量任务处理` });
  }
  return { queued: true, companyId: target.companyId, tsCode };
}

// 用户明确刷新单股时复用财务 Runner；日常可转债正股目标集合保持原范围。
async function enqueueStockAnalysisSync(rawCode) {
  const { normalizeStockCode, isOrdinaryAStock } = require('./stockAnalysis');
  const tsCode = normalizeStockCode(rawCode);
  if (!tsCode || !isOrdinaryAStock(tsCode)) throw new Error('仅支持A股普通股票');
  const slot = await require('./jobScheduleSlots').enqueueManualJob(JOB_NAME,
    { mode: 'stock_analysis', targetCodes: [tsCode], freshnessGate: false });
  if (!slot) throw new Error('未能登记股票刷新任务，请稍后重试');
  return { queued: true, tsCode, slotId: slot.slot_id };
}

async function syncRequestedStockAnalysis(options) {
  const { normalizeStockCode, isOrdinaryAStock, refreshStockAnalysis, refreshEvents, refreshDividends } = require('./stockAnalysis');
  const codes = options.targetCodes;
  if (!Array.isArray(codes) || codes.length !== 1) throw new Error('单股刷新必须指定一只股票');
  const tsCode = normalizeStockCode(codes[0]);
  if (!tsCode || !isOrdinaryAStock(tsCode)) throw new Error('仅支持A股普通股票');
  const rows = await financialRepository.findStockTargetRows({ tsCode });
  if (rows.length !== 1) throw new Error('股票基础档案缺失或公司关系不唯一，暂不能刷新');
  const row = rows[0];
  const target = { tsCode, instrumentId: row.instrument_id, companyId: row.company_id, needs: REPORT_KINDS };
  const cursors = await readFinancialCursors([target]);
  const historyCursors = await readFinancialCursors([target], pool, 'financial_history');
  const today = apiDate(options.asOfDate || tsDateStr(new Date()));
  for (const kind of REPORT_KINDS) {
    const scope = `company:${target.companyId}:${kind}`;
    const cursor = cursors.get(scope);
    const historyStart = apiDate(historyCursors.get(scope)?.last_success_date);
    const historyFull = !historyStart || historyStart > apiDate(row.list_date);
    // 当日成功采集复用数据库；失败及缺口只补本种报表，不重拉成功项。
    if (!historyFull && cursor && !cursor.last_error && apiDate(cursor.last_attempt_at) === today) continue;
    const startDate = historyFull ? apiDate(row.list_date) : kind === 'indicator' && cursor && cursor.last_success_date
      ? previousDate(cursor.last_success_date, 365)
      : cursor && cursor.last_source_update ? previousDate(cursor.last_source_update, 30) : apiDate(row.list_date);
    if (!startDate) throw new Error('股票缺少上市日期，无法确定首次财报范围');
    const reportPeriods = [];
    for (let year = Number(startDate.slice(0, 4)); year <= Number(today.slice(0, 4)); year++) {
      for (const suffix of ['0331', '0630', '0930', '1231']) {
        const period = `${year}${suffix}`;
        if (period >= startDate && period <= today) reportPeriods.push(period);
      }
    }
    const current = { ...target, needs: [kind] };
    const reportResult = await fetchCompanyReports(current, { ...options, startDate, reportPeriods, historyFull });
    const persisted = await persistCompanyReports(current, reportResult, { ...options, historyStart: historyFull ? startDate : null });
    if (!persisted.ok) throw new Error(persisted.failed.map(item => `${item.kind}: ${item.error}`).join('；'));
  }
  await refreshDividends(tsCode, today);
  await refreshEvents(tsCode, today);
  await refreshStockAnalysis(tsCode, 'manual-financial-sync', { readOnly: true });
  return { ok: true, status: 'succeeded', stageComplete: true, mode: 'stock_analysis', tsCode,
    codes: [tsCode], targetFields: [], publishDatasets: false, publishDatasetCodes: [] };
}

async function runCompanyFinancialBackfill(options = {}) {
  const allTargets = await listTargetCompanies();
  const targets = options.targetScope === 'bond_underlyings'
    ? await listCurrentBondUnderlyingTargets()
    : allTargets;
  const reportPeriods = options.reportPeriods || currentReportPeriods(options.asOfDate);
  const pendingTargets = options.resume === false
    ? targets
    : await buildSyncQueue(targets, { reportPeriods, force: false, includeHistoricalGaps: true });
  const limit = Math.max(1, Number(options.companyLimit || targets.length));
  const offset = Math.max(0, Number(options.offset || 0));
  const results = [];
  for (const target of pendingTargets.slice(offset, offset + limit)) {
    const reportResult = await fetchCompanyReports({ ...target, needs: REPORT_KINDS }, { ...options, reportPeriods, force: true });
    results.push({ target, persisted: await persistCompanyReports({ ...target, needs: REPORT_KINDS }, reportResult, options) });
  }
  return { ok: results.every(item => item.persisted.ok), total: pendingTargets.length, targetTotal: targets.length, offset, processed: results.length, results };
}

module.exports = {
  JOB_NAME, REPORT_KINDS, REPORT_SPECS, normalizeDate, currentReportPeriods, isDisclosureSeason, uniqueTarget,
  listTargetCompanies, listCurrentBondUnderlyingTargets, readCompanyStates, stateForTarget, buildSyncQueue, fetchDisclosureCandidates,
  fetchCompanyReports, persistCompanyReports, latestFinancialDataAsOf, selectCompanyBatch, shouldAbortFinancialBatch, runCompanyFinancialIncrementalSync,
  enqueueCompanyFinancialSyncByCode, enqueueStockAnalysisSync, syncRequestedStockAnalysis, runCompanyFinancialBackfill,
};
