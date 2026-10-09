const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { syncHkexAllotmentFacts, syncHkexProspectusFacts, recomputeHkIpoCompleteness, readHkIpoCompleteness } = require('../services/hkexIpo');
const { loadCandidates } = require('../services/hkDailyCoverage');

const targetCodes = ['06802.HK', '03228.HK', '03757.HK', '06731.HK', '09607.HK', '06700.HK', '02523.HK'];

function executorForCandidateQuery(captured) {
  return async (sql, params = []) => {
    if (sql.includes("source_code='hkex_announcements'")) return { rows: [{ source_id: 1 }] };
    if (sql.includes('FROM public.ipo_history')) {
      captured.sql = sql;
      captured.params = params;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO ops.ingestion_runs')) return { rows: [{ run_id: 7 }] };
    return { rows: [], rowCount: 0 };
  };
}

function assertContinuousParameters(sql, params) {
  const indexes = [...new Set([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
  assert.deepStrictEqual(indexes, Array.from({ length: params.length }, (_, index) => index + 1));
}

(async () => {
  const allotment = {};
  await syncHkexAllotmentFacts({ targetCodes, executor: executorForCandidateQuery(allotment) });
  assertContinuousParameters(allotment.sql, allotment.params);
  assert.match(allotment.sql, /security_code=ANY\(\$4::text\[\]\)/);
  assert.doesNotMatch(allotment.sql, /listing_at::date BETWEEN/);
  assert.deepStrictEqual(allotment.params[3], targetCodes);
  const unmatched = await syncHkexAllotmentFacts({ targetCodes: ['01256.HK'], searchImpl: async () => [],
    executor: async (sql) => {
      if (sql.includes("source_code='hkex_announcements'")) return { rows: [{ source_id: 1 }] };
      if (sql.includes('FROM public.ipo_history')) return { rows: [{ security_code: '01256.HK', source_documents: [], data_completeness: {} }] };
      if (sql.includes('INSERT INTO ops.ingestion_runs')) return { rows: [{ run_id: 8 }] };
      return { rows: [], rowCount: 0 };
    } });
  assert.strictEqual(unmatched.ok, false, '候选未匹配官方配发公告不能宣告成功');
  assert.strictEqual(unmatched.status, 'failed');
  assert.strictEqual(unmatched.failures[0].code, '01256');
  assert.strictEqual(unmatched.failures[0].stage, 'discovery');
  const futureAllotment = await syncHkexAllotmentFacts({ targetCodes: ['02636.HK'], toDate: '2026-10-09', searchImpl: async () => [],
    executor: async (sql) => {
      if (sql.includes("source_code='hkex_announcements'")) return { rows: [{ source_id: 1 }] };
      if (sql.includes('FROM public.ipo_history')) return { rows: [{ security_code: '02636.HK', source_documents: [],
        data_completeness: { prospectus: { expectedEvents: { allotmentDate: { date: '2026-10-14' } } } } }] };
      if (sql.includes('INSERT INTO ops.ingestion_runs')) return { rows: [{ run_id: 9 }] };
      return { rows: [] };
    } });
  assert.strictEqual(futureAllotment.ok, true, '有明确未来官方配发日期的未匹配候选不误报故障');
  assert.deepStrictEqual(futureAllotment.pendingNotDue, [{ code: '02636', expectedDate: '2026-10-14' }]);

  const prospectus = {};
  await syncHkexProspectusFacts({ targetCodes, executor: executorForCandidateQuery(prospectus) });
  assertContinuousParameters(prospectus.sql, prospectus.params);
  assert.match(prospectus.sql, /security_code=ANY\(\$2::text\[\]\)/);
  assert.doesNotMatch(prospectus.sql, /timezone\('Asia\/Shanghai',listing_at\)::date BETWEEN/);
  assert.doesNotMatch(prospectus.sql, /AND \(data_completeness#>>'\{prospectus,next_retry_at\}' IS NULL/);
  assert.deepStrictEqual(prospectus.params[1], targetCodes);

  const completenessCalls = [];
  const completeness = await recomputeHkIpoCompleteness(async (sql, params = []) => {
    completenessCalls.push({ sql, params });
    if (sql.includes('SELECT security_code')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  }, targetCodes);
  assert.match(completenessCalls[0].sql, /security_code=ANY\(\$1::text\[\]\)/);
  assert.deepStrictEqual(completenessCalls[0].params[0], targetCodes);
  assert.strictEqual(completeness.rows, 0);
  assert.strictEqual(completeness.qualityStatus, 'stale', '空查询不能作为质量恢复证据');
  const emptyAudit = await readHkIpoCompleteness(async () => ({ rows: [] }), '2026-10-09', { mode: 'preopen' });
  assert.strictEqual(emptyAudit.qualityStatus, 'stale');
  let storedCompleteness;
  await recomputeHkIpoCompleteness(async (sql, params) => {
    if (sql.includes('SELECT security_code')) return { rows: [{ security_code: '01256.HK',
      offer_open_at: '2020-01-01T09:00:00+08:00', offer_close_at: '2020-01-03T12:00:00+08:00',
      pricing_at: '2020-01-04T00:00:00+08:00', allotment_at: '2020-01-05T00:00:00+08:00',
      issue_price_low: 1, issue_price_high: 2, issue_price_final: 1.5, lot_size_shares: 100,
      data_completeness: { prospectus: { expectedEvents: { listingDate: { date: '2020-01-06' } } } },
    }] };
    storedCompleteness = JSON.parse(params[1]);
    return { rows: [] };
  }, ['01256.HK'], '2020-01-06', { mode: 'preopen' });
  assert.strictEqual(storedCompleteness.status, 'pending_not_due', '历史目标日不得改用运行当天');
  assert.strictEqual(storedCompleteness.target_date, '2020-01-06');
  assert.strictEqual(storedCompleteness.evaluation_mode, 'preopen');

  let dailyQuery;
  await loadCandidates({
    query: async (sql, params) => { dailyQuery = { sql, params }; return { rows: [] }; },
  }, '2025-08-04', '2026-09-27', 20, targetCodes);
  assertContinuousParameters(dailyQuery.sql, dailyQuery.params);
  assert.match(dailyQuery.sql, /i\.canonical_code=ANY\(\$2::text\[\]\)/);
  assert.match(dailyQuery.sql, /b\.trade_date <= \$1::date/);
  assert.doesNotMatch(dailyQuery.sql, /i\.list_date::date BETWEEN/);
  assert.match(dailyQuery.sql, /LIMIT \$3/);
  assert.deepStrictEqual(dailyQuery.params[1], targetCodes);
  assert.strictEqual(dailyQuery.params[2], 20);

  const runnerSource = fs.readFileSync(path.join(__dirname, '../jobs/hkIpoSync.js'), 'utf8');
  const orchestratorSource = fs.readFileSync(path.join(__dirname, '../services/jobOrchestrator.js'), 'utf8');
  assert.match(runnerSource, /mode === 'enrichment' && targetCodes\.length > 0/);
  assert.match(runnerSource, /!targeted && context\.syncNonPublic/);
  assert.match(runnerSource, /context\.syncListingStatus !== false/);
  assert.match(runnerSource, /targeted \? \{ targetCodes \} : \{\}/);
  assert.match(runnerSource, /if \(targeted\) \{ nameOptions\.batchSize = null; nameOptions\.targetCodes = targetCodes; \}/);
  assert.match(runnerSource, /const candidates = targetCodes\.length \? \{ rows: \[\], rowCount: 0 \}/);
  assert.doesNotMatch(runnerSource, /!targeted && context\.syncListingStatus/);
  assert.match(orchestratorSource, /claimed\.job_code === 'hk_ipo_enrichment'[\s\S]*?targetCodes: claimed\.request_payload\.targetCodes/);
  const runnerCalls = [];
  const context = vm.createContext({ module: { exports: {} }, process, console, Date,
    require: name => {
      if (name === '../db/connection') return { pool: { query: async sql => ({ rows: sql.includes('SELECT security_code FROM') ? [{ security_code: '01256.HK' }] : [] }) } };
      if (name === '../services/hkexIpo') return {
        recomputeHkIpoCompleteness: async (...args) => { runnerCalls.push(args.slice(1)); return { ok: true, rows: 1, complete: 1, pending: 0, missing: 0, qualityStatus: 'passed' }; },
        readHkIpoCompleteness: async (...args) => { runnerCalls.push(args.slice(1)); return { ok: true, rows: 191, complete: 189, pending: 1, missing: 1, qualityStatus: 'stale' }; },
      };
      if (name === '../../public/shared/core-date.js') return require(name);
      return {};
    },
  });
  vm.runInContext(runnerSource, context);
  const failedQuality = await context.module.exports.runHkIpoSync('enrichment', 'test', {
    targetDate: '2020-01-06', targetCodes: ['01256.HK'], syncHistoricalReports: false, syncNonPublic: false,
    syncListingStatus: false, syncProspectus: false, syncAllotment: false, syncDaily: false,
  });
  assert.strictEqual(failedQuality.ok, false, '全市场质量失败不能用定向任务成功代替');
  assert.deepStrictEqual(Array.from(failedQuality.failedDatasets), ['hk_ipo_facts']);
  assert.strictEqual(runnerCalls[0][1], '2020-01-06');
  assert.strictEqual(runnerCalls[0][2].mode, 'enrichment');
  assert.strictEqual(runnerCalls[1][0], '2020-01-06');
  assert.strictEqual(runnerCalls[1][1].mode, 'enrichment');

console.log('hk-ipo-targeted-enrichment: 7 个目标代码仅进入官方发行状态公告、资料、日线和完整度查询');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
