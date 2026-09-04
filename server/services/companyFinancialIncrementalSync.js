// 公司级财务增量同步：唯一负责把 Tushare 财报写入标准财务层。
// 安全性和股票分析只读这里的已入库事实，不在请求链路内补数。
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
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

async function listTargetCompanies(client = pool) {
  return listCurrentBondUnderlyingTargets(client);
}

async function listCurrentBondUnderlyingTargets(client = pool) {
  const { rows } = await client.query(`
    WITH market_day AS (
      SELECT MAX(trade_date) AS trade_date FROM market.convertible_bond_daily_metrics
    )
    SELECT DISTINCT s.instrument_id,s.canonical_code AS ts_code,p.stock_instrument_id,ci.company_id
      FROM market_day md
      JOIN market.convertible_bond_daily_metrics dm ON dm.trade_date=md.trade_date
      JOIN core.instruments i ON i.instrument_id=dm.instrument_id AND i.asset_class='convertible_bond'
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
      JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id AND s.asset_class='stock'
      JOIN core.company_instruments ci ON ci.instrument_id=s.instrument_id
     WHERE i.status='listed'
       AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
       AND (i.delist_date IS NULL OR i.delist_date>md.trade_date)
       AND (p.maturity_date IS NULL OR p.maturity_date>=md.trade_date)
     ORDER BY s.canonical_code
  `);
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
  const result = await client.query(
    `SELECT company_id,report_kind,period_end::text AS period_end,announced_at::text AS announced_at,
            f_ann_date::text AS f_ann_date,report_type,is_current_version
       FROM fundamental.financial_reports
      WHERE company_id=ANY($1::bigint[]) AND is_current_version=true
      ORDER BY company_id,period_end DESC,announced_at DESC NULLS LAST`, [companyIds]
  );
  const map = new Map();
  for (const row of result.rows) {
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

async function readFinancialCursors(targets, client = pool) {
  const scopes = (targets || []).flatMap(target => REPORT_KINDS.map(kind => `company:${target.companyId}:${kind}`));
  if (!scopes.length) return new Map();
  const { rows } = await client.query(
    `SELECT scope_key,last_success_date,last_source_update,last_attempt_at,last_error,retry_count
       FROM ops.sync_cursors WHERE dataset_code='financial' AND scope_key=ANY($1::text[])`, [scopes]
  );
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
  const disclosureCodes = new Set((options.disclosureRows || []).map(row => String(row.ts_code || '').trim().toUpperCase()));
  return (targets || []).map(target => {
    const state = stateForTarget(target, states.get(String(target.companyId)) || [], options);
    const disclosed = disclosureCodes.has(String(target.tsCode).toUpperCase());
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
      const rows = await queryRows(apiName, requestParams(spec, target, options), spec.fields, query);
      results[kind] = rows;
      // fina_indicator 官方单次上限为100；按报告期切片后再取，避免把截断结果当成完整数据。
      if (kind === 'indicator' && rows.length >= 100 && !options.disableTruncationProbe) {
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
  const client = await pool.connect();
  const successful = [];
  const failed = [];
  let ingestionRunId = null;
  try {
    await client.query('BEGIN');
    const source = (await client.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1")).rows[0];
    if (!source) throw new Error('未找到 Tushare 数据源登记');
    ingestionRunId = (await client.query(
      `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,'stock_financial_reports',$2::jsonb,'running') RETURNING run_id`,
      [source.source_id, JSON.stringify({ company_id: target.companyId, ts_code: target.tsCode, kinds: target.needs || REPORT_KINDS })]
    )).rows[0].run_id;
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
      } else {
        const message = error ? `${error.code || 'FINANCIAL_SYNC_FAILED'}: ${error.message}` : '接口返回空数组，保留上一份有效数据';
        await markDatasetFailure(scope, 'financial', message, { client, companyId: target.companyId, instrumentId: target.instrumentId });
        failed.push({ kind, error: message });
      }
    }
    const status = failed.length ? (successful.length ? 'degraded' : 'failed') : 'succeeded';
    await client.query(
      `UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
      [ingestionRunId, status, successful.reduce((count, kind) => count + (reportResult.results[kind] || []).length, 0), failed.map(item => `${item.kind}:${item.error}`).join('；')]
    );
    await client.query('COMMIT');
    return { ok: failed.length === 0, successful, failed, ingestionRunId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function latestFinancialDataAsOf(client = pool) {
  const { rows } = await client.query(
    `SELECT MAX(COALESCE(f_ann_date,announced_at,period_end))::text AS data_as_of,
            COUNT(*) FILTER (WHERE report_type='1' AND is_current_version=true)::int AS row_count
       FROM fundamental.financial_reports`
  );
  return { dataAsOf: rows[0] && rows[0].data_as_of ? String(rows[0].data_as_of).slice(0, 10) : null, rowCount: Number(rows[0] && rows[0].row_count || 0) };
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
    const targets = await listTargetCompanies();
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
      return { ok: true, status: 'succeeded', changed: false, externalCallCount: 0, publishDatasets: false, dataAsOf: latest.dataAsOf,
        datasetDiagnostics: { stock_financial_reports: { partition_row_count: latest.rowCount, queue_count: 0 } }, reason };
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
    const result = { ok, status: complete ? 'succeeded' : ok ? 'partial' : 'degraded', changed: changed > 0, dataAsOf: latest.dataAsOf,
      publishDatasets: complete && changed > 0, externalCallCount: null, processed: batch.length, queued: queue.length, remaining,
      failures, reason, datasetDiagnostics: { stock_financial_reports: { partition_row_count: latest.rowCount, queue_count: queue.length, processed_count: batch.length, failed_count: failures.length } } };
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
    await pool.query(
      `INSERT INTO ops.sync_cursors(company_id,instrument_id,scope_key,dataset_code,last_attempt_at,last_error,retry_count)
       VALUES($1,$2,$3,'financial',now(),$4,1)
       ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_attempt_at=now(),last_error=EXCLUDED.last_error,retry_count=ops.sync_cursors.retry_count+1,updated_at=now()`,
      [target.companyId, target.instrumentId, `company:${target.companyId}:${kind}`, `${reason}: 等待财务增量任务处理`]
    );
  }
  return { queued: true, companyId: target.companyId, tsCode };
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
  enqueueCompanyFinancialSyncByCode, runCompanyFinancialBackfill,
};
