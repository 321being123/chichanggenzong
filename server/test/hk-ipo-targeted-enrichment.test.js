const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { syncHkexAllotmentFacts, syncHkexProspectusFacts, recomputeHkIpoCompleteness } = require('../services/hkexIpo');
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

(async () => {
  const allotment = {};
  await syncHkexAllotmentFacts({ targetCodes, executor: executorForCandidateQuery(allotment) });
  assert.match(allotment.sql, /security_code=ANY\(\$6::text\[\]\)/);
  assert.doesNotMatch(allotment.sql, /listing_at::date BETWEEN/);
  assert.deepStrictEqual(allotment.params[5], targetCodes);

  const prospectus = {};
  await syncHkexProspectusFacts({ targetCodes, executor: executorForCandidateQuery(prospectus) });
  assert.match(prospectus.sql, /security_code=ANY\(\$4::text\[\]\)/);
  assert.doesNotMatch(prospectus.sql, /timezone\('Asia\/Shanghai',listing_at\)::date BETWEEN/);
  assert.doesNotMatch(prospectus.sql, /AND \(data_completeness#>>'\{prospectus,next_retry_at\}' IS NULL/);
  assert.deepStrictEqual(prospectus.params[3], targetCodes);

  const completenessCalls = [];
  const completeness = await recomputeHkIpoCompleteness(async (sql, params = []) => {
    completenessCalls.push({ sql, params });
    if (sql.includes('SELECT security_code')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  }, targetCodes);
  assert.match(completenessCalls[0].sql, /security_code=ANY\(\$1::text\[\]\)/);
  assert.deepStrictEqual(completenessCalls[0].params[0], targetCodes);
  assert.strictEqual(completeness.rows, 0);

  let dailyQuery;
  await loadCandidates({
    query: async (sql, params) => { dailyQuery = { sql, params }; return { rows: [] }; },
  }, '2025-08-04', '2026-09-27', 20, targetCodes);
  assert.match(dailyQuery.sql, /i\.canonical_code=ANY\(\$3::text\[\]\)/);
  assert.doesNotMatch(dailyQuery.sql, /i\.list_date::date BETWEEN/);
  assert.match(dailyQuery.sql, /LIMIT \$4/);
  assert.deepStrictEqual(dailyQuery.params[2], targetCodes);
  assert.strictEqual(dailyQuery.params[3], 20);

  const runnerSource = fs.readFileSync(path.join(__dirname, '../jobs/hkIpoSync.js'), 'utf8');
  const orchestratorSource = fs.readFileSync(path.join(__dirname, '../services/jobOrchestrator.js'), 'utf8');
  assert.match(runnerSource, /mode === 'enrichment' && targetCodes\.length > 0/);
  assert.match(runnerSource, /!targeted && context\.syncNonPublic/);
  assert.match(runnerSource, /!targeted && context\.syncCancelled/);
  assert.match(orchestratorSource, /claimed\.job_code === 'hk_ipo_enrichment'[\s\S]*?targetCodes: claimed\.request_payload\.targetCodes/);

  console.log('hk-ipo-targeted-enrichment: 7 个目标代码仅进入对应官方资料、日线和完整度查询');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
