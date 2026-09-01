// 可转债下修动机：公告前时间滚动回测与历史评分回填。
// 默认只打印报告；--apply 才落库回测结果，--backfill-scores 才写入历史评分快照。
const { pool } = require('../db');
const { runMigrations } = require('../db/migrations');
const {
  MOTIVE_MODEL_VERSION,
  loadMotiveInput,
  buildMotiveScore,
  calculateBondRevisionMotive,
} = require('../services/convertibleBondRevisionMotiveService');

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
function option(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}
function validDate(value, name) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) {
    throw new Error(`${name} 必须是 YYYY-MM-DD`);
  }
  return text;
}

const sampleStart = validDate(option('--start', '2022-08-01'), '--start');
const sampleEnd = validDate(option('--end', '2025-12-31'), '--end');
const oosStart = validDate(option('--oos-start', `${Number(sampleEnd.slice(0, 4))}-01-01`), '--oos-start');
const APPLY = has('--apply');
const BACKFILL = has('--backfill-scores');
const ROUND_TRIP_COST = 0.003;

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function bucket(score) {
  return score >= 70 ? '70+' : score >= 50 ? '50-69' : '<50';
}

async function loadSamples() {
  const { rows } = await pool.query(`
    SELECT c.cycle_id,c.instrument_id,i.canonical_code AS ts_code,
           c.trigger_date::text AS signal_date,
           COALESCE(c.proposal_date,c.decision_date,c.cycle_end_date)::text AS outcome_date,
           CASE WHEN c.proposal_date IS NOT NULL THEN 'proposed' ELSE 'no_revision' END AS label
      FROM analytics.convertible_bond_revision_cycles c
      JOIN core.instruments i ON i.instrument_id=c.instrument_id
     WHERE c.cycle_start_date >= $1::date
       AND c.cycle_start_date <= $2::date
       AND c.trigger_date IS NOT NULL
       AND c.trigger_date >= $1::date
       AND c.trigger_date <= $2::date
       AND ((c.proposal_date IS NOT NULL AND c.proposal_date > c.trigger_date)
         OR (c.proposal_date IS NULL AND c.no_revision))
     ORDER BY c.trigger_date,c.cycle_id`, [sampleStart, sampleEnd]);
  return rows;
}

async function nextClose(instrumentId, date, direction) {
  const operator = direction === 'after' ? '>' : '>=';
  const { rows } = await pool.query(
    `SELECT trade_date::text AS trade_date,close
       FROM market.convertible_bond_daily_metrics
      WHERE instrument_id=$1 AND trade_date ${operator} $2::date AND close IS NOT NULL
      ORDER BY trade_date LIMIT 1`, [instrumentId, date]
  );
  return rows[0] || null;
}

async function scoreSamples(samples) {
  const scored = [];
  const failures = [];
  for (const sample of samples) {
    try {
      const input = await loadMotiveInput(sample.ts_code, sample.signal_date);
      if (!input) throw new Error('评分日没有可用主档');
      // 回测只读取评分日以前事实；临时打开分档仅用于验证阈值，绝不改变线上校准开关。
      const score = buildMotiveScore({ ...input, modelCalibrated: true });
      const entry = await nextClose(sample.instrument_id, sample.signal_date, 'after');
      const exit = sample.outcome_date ? await nextClose(sample.instrument_id, sample.outcome_date, 'on_or_after') : null;
      const entryClose = Number(entry && entry.close), exitClose = Number(exit && exit.close);
      const netReturn = Number.isFinite(entryClose) && entryClose > 0 && Number.isFinite(exitClose)
        ? exitClose / entryClose - 1 - ROUND_TRIP_COST : null;
      scored.push({
        ...sample,
        score: Number(score.motiveScore || 0),
        qualityStatus: input.qualityStatus,
        completenessRate: Number(input.qualityRate || 0),
        bucket: bucket(Number(score.motiveScore || 0)),
        entryDate: entry && entry.trade_date || null,
        outcomeTradeDate: exit && exit.trade_date || null,
        netReturn,
      });
    } catch (error) {
      failures.push({ cycleId: sample.cycle_id, tsCode: sample.ts_code, error: String(error.message || error).slice(0, 300) });
    }
  }
  return { scored, failures };
}

function summarize(rows) {
  const group = name => rows.filter(row => row.bucket === name);
  const buckets = {};
  for (const name of ['<50', '50-69', '70+']) {
    const values = group(name);
    buckets[name] = { count: values.length, proposals: values.filter(row => row.label === 'proposed').length,
      proposalRate: rate(values.filter(row => row.label === 'proposed').length, values.length) };
  }
  const issuers = new Set(rows.map(row => row.instrument_id));
  const years = new Set(rows.map(row => String(row.signal_date).slice(0, 4)));
  const highRows = rows.filter(row => row.bucket === '70+');
  const highReturns = highRows.map(row => row.netReturn).filter(value => Number.isFinite(value));
  const highIssuers = new Set(highRows.map(row => row.instrument_id));
  const highYears = new Set(highRows.map(row => String(row.signal_date).slice(0, 4)));
  const proposalCount = rows.filter(row => row.label === 'proposed').length;
  return {
    sampleCount: rows.length,
    completeCount: rows.filter(row => row.qualityStatus === 'complete').length,
    proposalCount,
    baselineProposalRate: rate(proposalCount, rows.length),
    highScoreCount: buckets['70+'].count,
    highScoreProposalRate: buckets['70+'].proposalRate,
    buckets,
    monotonic: buckets['<50'].proposalRate != null && buckets['50-69'].proposalRate != null && buckets['70+'].proposalRate != null
      && buckets['<50'].proposalRate <= buckets['50-69'].proposalRate
      && buckets['50-69'].proposalRate <= buckets['70+'].proposalRate,
    netReturnAfterCost: highReturns.length ? highReturns.reduce((sum, value) => sum + value, 0) / highReturns.length : null,
    returnSampleCount: highReturns.length,
    issuerCount: issuers.size,
    yearCount: years.size,
    highIssuerCount: highIssuers.size,
    highYearCount: highYears.size,
  };
}

function buildReport(rows, failures) {
  const oosRows = rows.filter(row => row.signal_date >= oosStart);
  const all = summarize(rows);
  const oos = summarize(oosRows);
  const blockers = [];
  if (!rows.length) blockers.push('NO_SAMPLES');
  if (all.completeCount / Math.max(all.sampleCount, 1) < 0.95) blockers.push('DATA_COMPLETENESS_BELOW_95PCT');
  if (oos.sampleCount < 70) blockers.push('OOS_SAMPLE_BELOW_70');
  if (oos.highScoreCount === 0 || oos.highScoreProposalRate == null || oos.highScoreProposalRate < 0.35) blockers.push('HIGH_SCORE_PROPOSAL_RATE_BELOW_35PCT');
  if (oos.highScoreProposalRate == null || oos.baselineProposalRate == null || oos.highScoreProposalRate < oos.baselineProposalRate * 2) blockers.push('HIGH_SCORE_NOT_2X_BASELINE');
  if (!oos.monotonic) blockers.push('BUCKET_RATE_NOT_MONOTONIC');
  if (oos.netReturnAfterCost == null || oos.netReturnAfterCost <= 0) blockers.push('NET_RETURN_AFTER_COST_NOT_POSITIVE');
  if (oos.highScoreCount > 0 && (oos.highIssuerCount < 3 || oos.highYearCount < 2)) blockers.push('INSUFFICIENT_HIGH_SCORE_DIVERSITY');
  if (failures.length) blockers.push('SCORING_FAILURES');
  return {
    modelVersion: MOTIVE_MODEL_VERSION,
    sampleStart, sampleEnd, oosStart,
    pass: blockers.length === 0,
    blockers,
    all,
    oos,
    failures: failures.slice(0, 50),
    calculatedAt: new Date().toISOString(),
  };
}

async function persistReport(report) {
  await pool.query(`
    INSERT INTO analytics.convertible_bond_revision_motive_backtests
      (model_version,sample_start_date,sample_end_date,oos_start_date,sample_count,complete_count,proposal_count,
       baseline_proposal_rate,high_score_count,high_score_proposal_rate,monotonic,net_return_after_cost,
       issuer_count,oos_sample_count,pass,blockers,metrics,calculated_at)
    VALUES($1,$2::date,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18)
    ON CONFLICT(model_version,sample_start_date,sample_end_date) DO UPDATE SET
      oos_start_date=EXCLUDED.oos_start_date,sample_count=EXCLUDED.sample_count,complete_count=EXCLUDED.complete_count,
      proposal_count=EXCLUDED.proposal_count,baseline_proposal_rate=EXCLUDED.baseline_proposal_rate,
      high_score_count=EXCLUDED.high_score_count,high_score_proposal_rate=EXCLUDED.high_score_proposal_rate,
      monotonic=EXCLUDED.monotonic,net_return_after_cost=EXCLUDED.net_return_after_cost,issuer_count=EXCLUDED.issuer_count,
      oos_sample_count=EXCLUDED.oos_sample_count,pass=EXCLUDED.pass,blockers=EXCLUDED.blockers,metrics=EXCLUDED.metrics,calculated_at=EXCLUDED.calculated_at`,
    [report.modelVersion, report.sampleStart, report.sampleEnd, report.oosStart, report.all.sampleCount, report.all.completeCount,
      report.all.proposalCount, report.all.baselineProposalRate, report.all.highScoreCount, report.all.highScoreProposalRate,
      report.all.monotonic, report.all.netReturnAfterCost, report.all.issuerCount, report.oos.sampleCount, report.pass,
      JSON.stringify(report.blockers), JSON.stringify(report), report.calculatedAt]
  );
}

async function backfillScores(rows) {
  const failures = [];
  for (const row of rows) {
    try {
      await calculateBondRevisionMotive(row.ts_code, row.signal_date, pool, { persistCycles: false });
    } catch (error) {
      failures.push({ cycleId: row.cycle_id, tsCode: row.ts_code, error: String(error.message || error).slice(0, 300) });
    }
  }
  return failures;
}

(async () => {
  try {
    if (sampleStart > sampleEnd) throw new Error('--start 不能晚于 --end');
    if (APPLY || BACKFILL) await runMigrations();
    const samples = await loadSamples();
    const { scored, failures } = await scoreSamples(samples);
    const report = buildReport(scored, failures);
    if (BACKFILL) {
      const backfillFailures = await backfillScores(scored);
      report.backfill = { requested: scored.length, failures: backfillFailures.slice(0, 50), failureCount: backfillFailures.length };
      if (backfillFailures.length) report.blockers.push('HISTORICAL_SCORE_BACKFILL_FAILURES');
      report.pass = report.blockers.length === 0;
    }
    if (APPLY) await persistReport(report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 2;
  } catch (error) {
    console.error('[motive-backtest] 失败：' + String(error.message || error));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
