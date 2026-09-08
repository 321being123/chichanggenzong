// 港股 IPO 研究回测与正式建议门禁。
// 只读历史事实和上市后日线；正式快照必须先通过全部 P0 门禁。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../db');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'ipo_hk_model_freeze_v1.json');
const MODEL_CONFIG_TEXT = fs.readFileSync(CONFIG_PATH, 'utf8');
const MODEL_CONFIG = JSON.parse(MODEL_CONFIG_TEXT);
const MODEL_CONFIG_HASH = crypto.createHash('sha256').update(MODEL_CONFIG_TEXT).digest('hex');

function monthStart(date) {
  return `${String(date).slice(0, 7)}-01`;
}

function shiftMonthStart(date, months) {
  const value = new Date(`${monthStart(date)}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + Number(months || 0));
  return value.toISOString().slice(0, 10);
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function visibleScore(row) {
  const fields = MODEL_CONFIG.visible_feature_fields || [];
  const present = fields.filter(field => row[field] !== null && row[field] !== undefined && row[field] !== '').length;
  if (!present) return null;
  let score = (present / fields.length) * 100;
  if (row.issue_price_low != null && row.issue_price_high != null && Number(row.issue_price_low) > 0) {
    const spread = Number(row.issue_price_high) / Number(row.issue_price_low);
    if (spread > 1.5) score -= 10;
  }
  if (row.public_offer_ratio != null && Number(row.public_offer_ratio) < 0.1) score -= 10;
  return Math.max(0, Math.min(100, Number(score.toFixed(4))));
}

const FORMAL_REQUIRED_FIELDS = ['issue_price_low', 'issue_price_high', 'lot_size_shares', 'offer_close_at'];

function hardVetoesForRow(row) {
  return FORMAL_REQUIRED_FIELDS
    .filter(field => row[field] === null || row[field] === undefined || row[field] === '')
    .map(field => `${field}_missing`);
}

function buildMetrics(rows) {
  const first = rows.map(row => row.firstDayReturn).filter(Number.isFinite);
  const fifth = rows.map(row => row.fiveDayReturn).filter(Number.isFinite);
  return {
    sampleCount: rows.length,
    firstDayCoverage: rows.length ? first.length / rows.length : 0,
    fiveDayCoverage: rows.length ? fifth.length / rows.length : 0,
    averageFirstDayReturn: first.length ? first.reduce((a, b) => a + b, 0) / first.length : null,
    averageFiveDayReturn: fifth.length ? fifth.reduce((a, b) => a + b, 0) / fifth.length : null,
    firstDayBreakEvenRate: first.length ? first.filter(value => value >= 0).length / first.length : null,
    fiveDayBreakEvenRate: fifth.length ? fifth.filter(value => value >= 0).length / fifth.length : null,
    conservativeFirstDayReturn: quantile(first, MODEL_CONFIG.walk_forward.conservative_return_quantile),
  };
}

function wilsonInterval(successes, total, z = 1.2815515655446004) {
  const n = Number(total || 0);
  const s = Number(successes || 0);
  if (!n) return { lower: null, upper: null };
  const p = s / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p) / n) + (z * z) / (4 * n * n));
  return { lower: Math.max(0, centre - spread), upper: Math.min(1, centre + spread) };
}

function posteriorRate(successes, total) {
  const n = Number(total || 0);
  const s = Number(successes || 0);
  return n ? (s + 0.5) / (n + 1) : null;
}

function hasNumericValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function expectedNetProfit(row) {
  const cost = MODEL_CONFIG.cost_assumptions || {};
  const price = Number(row.issuePriceFinal);
  const lot = Number(row.lotSizeShares);
  const returnRate = Number(row.firstDayReturn);
  const probability = Number(row.winProbability);
  if (!hasNumericValue(row.winProbability) || ![price, lot, returnRate].every(Number.isFinite) || price <= 0 || lot <= 0 || probability < 0 || probability > 1) return null;
  const principal = price * lot;
  const gross = probability * principal * (returnRate / 100);
  const applicationFee = row.applicationFeeHkd == null ? Number(cost.application_fee_hkd || 0) : Number(row.applicationFeeHkd);
  const brokerageFee = row.brokerageFeeHkd == null ? Number(cost.brokerage_fee_hkd || 0) : Number(row.brokerageFeeHkd);
  const financing = principal * Number(cost.financing_rate_annual || 0) * Number(cost.holding_days || 0) / 365;
  const sellCost = principal * Number(cost.sell_cost_rate || 0);
  const fxBuffer = Number(cost.fx_buffer_hkd || 0);
  return gross - applicationFee - brokerageFee - financing - sellCost - fxBuffer;
}

function auditFormalValidation(rows = [], windows = []) {
  const config = MODEL_CONFIG.formal_validation || {};
  const eligible = rows.filter(row => row.score != null && (!Array.isArray(row.hardVetoes) || row.hardVetoes.length === 0));
  const recommended = eligible.filter(row => Number(row.score) >= Number(MODEL_CONFIG.formal_gate.recommended_score_threshold));
  const checks = {
    implementation: true,
    probabilityCoverage: 0,
    concentrationCoverage: 0,
    posterior: null,
    netProfit: null,
    windowChecks: [],
  };
  const probabilityRows = recommended.filter(row => hasNumericValue(row.winProbability));
  checks.probabilityCoverage = recommended.length ? probabilityRows.length / recommended.length : 0;
  const profitable = probabilityRows.map(expectedNetProfit).filter(Number.isFinite);
  const profitableCount = profitable.filter(value => value > 0).length;
  const breakEvenRate = probabilityRows.length ? profitableCount / probabilityRows.length : null;
  const interval = wilsonInterval(profitableCount, probabilityRows.length);
  checks.posterior = {
    method: config.posterior_method || 'jeffreys_beta_plus_wilson_90',
    breakEvenPosteriorMean: posteriorRate(profitableCount, probabilityRows.length),
    breakEvenUpper90: interval.upper,
    sampleCount: probabilityRows.length,
  };
  const netInterval = wilsonInterval(profitableCount, probabilityRows.length);
  checks.netProfit = {
    profitableLower90: netInterval.lower,
    medianHkd: profitable.length ? quantile(profitable, 0.5) : null,
    sampleCount: profitable.length,
  };
  const groups = recommended.map(row => row.industry || row.sponsorGroup || row.boardKey).filter(Boolean);
  checks.concentrationCoverage = recommended.length ? groups.length / recommended.length : 0;
  const groupCounts = groups.reduce((result, group) => ({ ...result, [group]: (result[group] || 0) + 1 }), {});
  const maxGroupShare = recommended.length && groups.length
    ? Math.max(...Object.values(groupCounts).map(count => count / recommended.length)) : null;
  checks.concentration = {
    maxGroupShare,
    groups: Object.keys(groupCounts).length,
    threshold: hasNumericValue(config.max_group_concentration) ? Number(config.max_group_concentration) : null,
  };
  for (const window of windows) {
    const testRows = rows.filter(row => row.listingDate >= window.testStart && row.listingDate < window.testEnd
      && row.score != null && (!Array.isArray(row.hardVetoes) || row.hardVetoes.length === 0)
      && Number(row.score) >= Number(MODEL_CONFIG.formal_gate.recommended_score_threshold));
    const testWithProbability = testRows.filter(row => hasNumericValue(row.winProbability));
    const testNet = testWithProbability.map(expectedNetProfit).filter(Number.isFinite);
    checks.windowChecks.push({
      testStart: window.testStart, testEnd: window.testEnd, sampleCount: testRows.length,
      probabilityCoverage: testRows.length ? testWithProbability.length / testRows.length : 0,
      medianNetProfitHkd: testNet.length ? quantile(testNet, 0.5) : null,
    });
  }
  const reasons = [];
  if (config.requires_win_probability && checks.probabilityCoverage < 1) reasons.push('推荐档缺少一手中签概率，无法计算期望净收益');
  if (config.requires_concentration_group && checks.concentrationCoverage < 1) reasons.push('推荐档缺少行业或保荐人分组，无法验收集中度');
  if (config.requires_concentration_group && checks.concentration.maxGroupShare != null
      && checks.concentration.threshold != null
      && checks.concentration.maxGroupShare > checks.concentration.threshold) {
    reasons.push(`推荐档单一行业或保荐人集中度超过阈值 ${checks.concentration.threshold}`);
  }
  if (checks.posterior.breakEvenPosteriorMean == null || checks.posterior.breakEvenPosteriorMean > Number(config.break_even_posterior_mean_max)) reasons.push('推荐档破发后验均值未达阈值');
  if (checks.posterior.breakEvenUpper90 == null || checks.posterior.breakEvenUpper90 > Number(config.break_even_upper_90_max)) reasons.push('推荐档破发率单侧 90% 上限未达阈值');
  if (checks.netProfit.profitableLower90 == null || checks.netProfit.profitableLower90 < Number(config.net_profit_lower_90_min)) reasons.push('推荐档扣费净盈利率单侧 90% 下限未达阈值');
  if (checks.netProfit.medianHkd == null || checks.netProfit.medianHkd <= Number(config.net_profit_median_min_hkd)) reasons.push('推荐档每手扣费净收益中位数未达阈值');
  const implementationReady = checks.implementation === true;
  const performanceChecksPassed = implementationReady && reasons.length === 0;
  return {
    ready: performanceChecksPassed,
    implementationReady,
    performanceChecksPassed,
    version: config.implementation_version || 'hk-ipo-formal-audit-v1',
    checks,
    reason: reasons.length ? reasons.join('；') : '正式模型成本、后验区间和集中度验收通过',
  };
}

async function loadCandidates({ fromDate = '2025-08-04', toDate = null } = {}, executor = pool.query.bind(pool)) {
  const upper = toDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const result = await executor(`
    SELECT h.security_code,h.security_name,h.instrument_id,h.ipo_status,
           (CASE WHEN h.listing_at IS NOT NULL THEN h.listing_at::date
                 WHEN h.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN h.listing_date::date END)::text AS listing_date,
           h.offer_open_at,h.offer_close_at,h.issue_price_final,h.issue_price_low,h.issue_price_high,
           h.public_offer_ratio,h.international_offer_ratio,h.lot_size_shares,h.data_completeness,h.source_documents
           ,h.online_lottery_rate,h.industry,h.board_key,h.application_fee_hkd,h.brokerage_fee_hkd
      FROM public.ipo_history h
     WHERE h.market_code='HK'
       AND (h.listing_at::date BETWEEN $1::date AND $2::date
            OR (h.listing_at IS NULL AND h.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND h.listing_date::date BETWEEN $1::date AND $2::date))
       AND COALESCE(h.ipo_status,'active')='listed'
     ORDER BY listing_date,h.security_code`, [fromDate, upper]);
  return result.rows;
}

async function loadBars(candidates, toDate, executor = pool.query.bind(pool)) {
  const ids = candidates.map(row => row.instrument_id).filter(Boolean);
  if (!ids.length) return new Map();
  const result = await executor(`
    SELECT DISTINCT ON (instrument_id,trade_date) instrument_id,trade_date::text AS trade_date,close
      FROM market.daily_bars
     WHERE instrument_id=ANY($1::bigint[])
       AND trade_date <= $2::date
     ORDER BY instrument_id,trade_date,source_id DESC`, [ids, toDate]);
  const grouped = new Map();
  for (const row of result.rows) {
    if (!grouped.has(String(row.instrument_id))) grouped.set(String(row.instrument_id), []);
    grouped.get(String(row.instrument_id)).push({ tradeDate: String(row.trade_date).slice(0, 10), close: Number(row.close) });
  }
  return grouped;
}

async function loadHkexOpenDates(fromDate, toDate, executor = pool.query.bind(pool)) {
  const result = await executor(`
    SELECT trade_date::text AS trade_date
      FROM market.trade_calendar
     WHERE exchange='HKEX' AND is_open
       AND trade_date BETWEEN $1::date AND $2::date
     ORDER BY trade_date`, [fromDate, toDate]);
  return result.rows.map(row => String(row.trade_date).slice(0, 10));
}

function expectedOpenDates(listDate, openDates) {
  return (Array.isArray(openDates) ? openDates : [])
    .map(value => String(value).slice(0, 10))
    .filter(value => value >= String(listDate).slice(0, 10))
    .slice(0, 5);
}

function sponsorGroupFromDocuments(sourceDocuments) {
  for (const document of (Array.isArray(sourceDocuments) ? sourceDocuments : [])) {
    const value = document && document.parserEvidence && document.parserEvidence.sponsorGroup;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function buildBacktestRows(candidates, barsByInstrument, openDates = []) {
  return candidates.map(row => {
    const price = Number(row.issue_price_final);
    const bars = (barsByInstrument.get(String(row.instrument_id)) || []).filter(bar => bar.tradeDate >= String(row.listing_date).slice(0, 10));
    const expectedDates = expectedOpenDates(row.listing_date, openDates);
    const barsByDate = new Map(bars.map(bar => [bar.tradeDate, bar]));
    const firstBar = expectedDates.length ? barsByDate.get(expectedDates[0]) : bars[0];
    const fifthBar = expectedDates.length >= 5 ? barsByDate.get(expectedDates[4]) : bars[4];
    const score = visibleScore(row);
    return {
      securityCode: row.security_code,
      instrumentId: row.instrument_id,
      listingDate: String(row.listing_date).slice(0, 10),
      score,
      hardVetoes: hardVetoesForRow(row),
      expectedOpenDates: expectedDates,
      issuePriceFinal: Number.isFinite(price) ? price : null,
      lotSizeShares: Number.isFinite(Number(row.lot_size_shares)) ? Number(row.lot_size_shares) : null,
      applicationFeeHkd: row.application_fee_hkd == null ? null : Number(row.application_fee_hkd),
      brokerageFeeHkd: row.brokerage_fee_hkd == null ? null : Number(row.brokerage_fee_hkd),
      winProbability: row.online_lottery_rate == null ? null : Number(row.online_lottery_rate) / 100,
      industry: String(row.industry || '').trim() || null,
      sponsorGroup: sponsorGroupFromDocuments(row.source_documents),
      boardKey: String(row.board_key || '').trim() || null,
      firstDayReturn: Number.isFinite(price) && price > 0 && firstBar ? (firstBar.close / price - 1) * 100 : null,
      fiveDayReturn: Number.isFinite(price) && price > 0 && fifthBar ? (fifthBar.close / price - 1) * 100 : null,
      observedDays: bars.length,
    };
  });
}

function dailyCoverageFromBars(candidates, barsByInstrument, openDates = []) {
  const observed = candidates.map(candidate => {
    const listDate = String(candidate.listing_date || '').slice(0, 10);
    const bars = barsByInstrument.get(String(candidate.instrument_id)) || [];
    const expectedDates = expectedOpenDates(listDate, openDates);
    if (expectedDates.length) {
      const available = new Set(bars.map(bar => bar.tradeDate));
      return expectedDates.filter(date => available.has(date)).length;
    }
    return bars.filter(bar => !listDate || bar.tradeDate >= listDate).length;
  });
  return {
    candidates: observed.length,
    firstDayCoverage: observed.length ? observed.filter(days => days >= 1).length / observed.length : 0,
    fiveDayCoverage: observed.length ? observed.filter(days => days >= 5).length / observed.length : 0,
  };
}

async function persistModelConfigSnapshot(executor = pool.query.bind(pool)) {
  const source = await executor("SELECT source_id FROM ops.data_sources WHERE source_code='calculated' LIMIT 1");
  if (!source.rows[0]) throw new Error('系统计算数据源未登记，无法保存港股模型配置快照');
  const range = { modelVersion: MODEL_CONFIG.model_version, configSha256: MODEL_CONFIG_HASH, configPath: 'config/ipo_hk_model_freeze_v1.json' };
  const run = await executor(
    `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status,row_count)
     VALUES($1,'hk_ipo_model_config',$2::jsonb,'running',0) RETURNING run_id`,
    [source.rows[0].source_id, JSON.stringify(range)]
  );
  try {
    const payload = { ...MODEL_CONFIG, configSha256: MODEL_CONFIG_HASH, configPath: range.configPath };
    await executor(
      `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
       VALUES($1,$2,'hk_ipo_model_config',$3,now(),$4::jsonb,$5)
       ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now()`,
      [run.rows[0].run_id, source.rows[0].source_id, MODEL_CONFIG.model_version, JSON.stringify(payload), MODEL_CONFIG_HASH]
    );
    await executor(
      `UPDATE ops.ingestion_runs SET status='succeeded',row_count=1,finished_at=now() WHERE run_id=$1`,
      [run.rows[0].run_id]
    );
  } catch (error) {
    await executor(
      `UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`,
      [run.rows[0].run_id, String(error.message || error).slice(0, 2000)]
    ).catch(() => {});
    throw error;
  }
  return { runId: run.rows[0].run_id, modelVersion: MODEL_CONFIG.model_version, configSha256: MODEL_CONFIG_HASH };
}

function consecutiveWorkdayCount(stableDates, openDates) {
  const stable = new Set((stableDates || []).map(date => String(date).slice(0, 10)));
  let current = 0;
  let longest = 0;
  for (const date of [...new Set(openDates || [])].map(value => String(value).slice(0, 10)).sort()) {
    if (stable.has(date)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

async function loadProbeAudit(executor = pool.query.bind(pool)) {
  const result = await executor(`
    WITH run_stats AS (
      SELECT ir.run_id,ir.request_range->>'environment' AS environment,
             (ir.started_at AT TIME ZONE 'Asia/Shanghai')::date AS observed_date,
             COUNT(rr.raw_record_id)::int AS target_count,
             COUNT(*) FILTER (WHERE rr.payload->>'responseSha256' ~ '^[0-9a-fA-F]{64}$')::int AS valid_targets,
             COUNT(*) FILTER (WHERE rr.payload->>'parserStatus'='parsed')::int AS parsed_targets
        FROM ops.ingestion_runs ir
        LEFT JOIN ops.raw_records rr ON rr.run_id=ir.run_id AND rr.dataset_code='hkex_ipo_probe'
       WHERE ir.dataset_code='hkex_ipo_probe' AND ir.status='succeeded'
       GROUP BY ir.run_id,ir.request_range->>'environment',ir.started_at
    )
    SELECT environment,observed_date::text AS observed_date,target_count,valid_targets,parsed_targets,
           (target_count > 0 AND valid_targets=target_count) AS stable
      FROM run_stats
     ORDER BY observed_date`);
  const environments = {
    local: { environment: 'local', valid_targets: 0, parsed_targets: 0, stableDates: [] },
    server: { environment: 'server', valid_targets: 0, parsed_targets: 0, stableDates: [] },
  };
  for (const row of result.rows) {
    const environment = environments[String(row.environment || '')];
    if (!environment) continue;
    environment.valid_targets += Number(row.valid_targets || 0);
    environment.parsed_targets += Number(row.parsed_targets || 0);
    if (row.stable) environment.stableDates.push(String(row.observed_date).slice(0, 10));
  }
  const sharedStableDates = [...new Set(environments.local.stableDates)]
    .filter(date => environments.server.stableDates.includes(date))
    .sort();
  let openDates = [];
  if (sharedStableDates.length) {
    const calendar = await executor(`
      SELECT trade_date::text AS trade_date
        FROM market.trade_calendar
       WHERE exchange='HKEX' AND is_open
         AND trade_date BETWEEN $1::date AND $2::date
       ORDER BY trade_date`, [sharedStableDates[0], sharedStableDates[sharedStableDates.length - 1]]);
    openDates = calendar.rows.map(row => String(row.trade_date).slice(0, 10));
  }
  const local = {
    environment: 'local',
    valid_targets: environments.local.valid_targets,
    parsed_targets: environments.local.parsed_targets,
    stable_workdays: [...new Set(environments.local.stableDates)].filter(date => openDates.includes(date)).length,
  };
  const server = {
    environment: 'server',
    valid_targets: environments.server.valid_targets,
    parsed_targets: environments.server.parsed_targets,
    stable_workdays: [...new Set(environments.server.stableDates)].filter(date => openDates.includes(date)).length,
  };
  return {
    fixturePassed: local.valid_targets > 0 && server.valid_targets > 0
      && local.parsed_targets > 0 && server.parsed_targets > 0,
    stableWorkdays: consecutiveWorkdayCount(sharedStableDates, openDates),
    stableDates: sharedStableDates,
    environments: { local, server },
  };
}

function buildWalkForward(rows, fromDate, toDate) {
  const windows = [];
  // 方案要求完整自然月：起始日期所在的不完整月份不进入训练，测试窗口按季度滚动。
  let cursor = shiftMonthStart(monthStart(fromDate), MODEL_CONFIG.walk_forward.training_months + 1);
  const upperExclusive = shiftMonthStart(monthStart(toDate), 1);
  while (shiftMonthStart(cursor, MODEL_CONFIG.walk_forward.test_months) <= upperExclusive) {
    const trainStart = shiftMonthStart(cursor, -MODEL_CONFIG.walk_forward.training_months);
    const testEnd = shiftMonthStart(cursor, MODEL_CONFIG.walk_forward.test_months);
    const train = rows.filter(row => row.listingDate >= trainStart && row.listingDate < cursor && row.firstDayReturn != null);
    const test = rows.filter(row => row.listingDate >= cursor && row.listingDate < testEnd && row.firstDayReturn != null);
    windows.push({ trainStart, trainEnd: cursor, testStart: cursor, testEnd, train: buildMetrics(train), test: buildMetrics(test) });
    cursor = testEnd;
  }
  return windows;
}

function evaluateFormalGate({ candidates, rows, windows, dailyCoverage = {}, probe = {}, formalValidation = {} } = {}) {
  const eligible = rows.filter(row => row.firstDayReturn != null && row.fiveDayReturn != null && row.score != null
    && (!Array.isArray(row.hardVetoes) || row.hardVetoes.length === 0));
  const recommended = eligible.filter(row => Number(row.score) >= Number(MODEL_CONFIG.formal_gate.recommended_score_threshold));
  const vetoCounts = {};
  for (const row of rows) {
    for (const veto of (Array.isArray(row.hardVetoes) ? row.hardVetoes : [])) {
      vetoCounts[veto] = (vetoCounts[veto] || 0) + 1;
    }
  }
  const reasons = [];
  const gate = MODEL_CONFIG.formal_gate;
  if (gate.implementation_status !== 'formal_ready' || formalValidation.ready !== true
    || formalValidation.performanceChecksPassed !== true) reasons.push(`正式模型验证指标未完成：${formalValidation.reason || '未提供验收结果'}`);
  if (!probe.fixturePassed) reasons.push('固定夹具未通过');
  if (Number(probe.stableWorkdays || 0) < 5) reasons.push('双环境稳定工作日不足 5 个');
  if (Number(dailyCoverage.firstDayCoverage || 0) < gate.minimum_first_day_coverage) reasons.push('上市首日行情覆盖不足');
  if (Number(dailyCoverage.fiveDayCoverage || 0) < gate.minimum_five_day_coverage) reasons.push('上市后五个交易日行情覆盖不足');
  if (eligible.length < gate.minimum_eligible_samples) reasons.push(`可回测样本不足 ${gate.minimum_eligible_samples} 只`);
  if (recommended.length < gate.minimum_recommended_samples) reasons.push(`推荐档样本不足 ${gate.minimum_recommended_samples} 只`);
  const vetoSummary = Object.entries(vetoCounts).sort(([a], [b]) => a.localeCompare(b)).map(([field, count]) => `${field}=${count}`).join('、');
  if (vetoSummary) reasons.push(`正式硬否决字段缺失：${vetoSummary}`);
  if (windows.length < gate.minimum_walk_forward_windows) reasons.push('walk-forward 窗口不足');
  const testCount = windows.reduce((sum, window) => sum + Number(window.test.sampleCount || 0), 0);
  if (testCount < gate.minimum_test_samples) reasons.push(`测试样本不足 ${gate.minimum_test_samples} 只`);
  return { passed: reasons.length === 0, status: reasons.length ? 'blocked' : 'passed', reasons,
    eligibleCount: eligible.length, recommendedCount: recommended.length, testCount, vetoCounts };
}

async function runHkIpoBacktest({ fromDate = '2025-08-04', toDate, dailyCoverage = {}, probe = {}, executor = pool.query.bind(pool), persist = true } = {}) {
  const upper = toDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const candidates = await loadCandidates({ fromDate, toDate: upper }, executor);
  const [bars, openDates] = await Promise.all([
    loadBars(candidates, upper, executor),
    loadHkexOpenDates(fromDate, upper, executor),
  ]);
  const rows = buildBacktestRows(candidates, bars, openDates);
  const windows = buildWalkForward(rows, fromDate, upper);
  const metrics = buildMetrics(rows);
  // 门禁证据必须从数据库当前状态计算，不能信任调用方传入的覆盖率/探针数字。
  const auditedCoverage = dailyCoverageFromBars(candidates, bars, openDates);
  const auditedProbe = await loadProbeAudit(executor);
  const formalValidation = auditFormalValidation(rows, windows);
  const gate = evaluateFormalGate({ candidates, rows, windows, dailyCoverage: auditedCoverage, probe: auditedProbe, formalValidation });
  const payload = { modelConfig: MODEL_CONFIG, modelConfigHash: MODEL_CONFIG_HASH, candidates: candidates.length, rows, windows, metrics,
    dailyCoverage: auditedCoverage, probe: auditedProbe, formalValidation, gate, fromDate, toDate: upper };
  const inputHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (persist) {
    await persistModelConfigSnapshot(executor);
    await executor(`INSERT INTO analytics.hk_ipo_backtests
      (model_version,from_date,to_date,candidate_count,eligible_count,test_count,first_day_coverage,five_day_coverage,
       metrics,windows,gate_status,gate_reasons,input_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,now())`,
      [MODEL_CONFIG.model_version, fromDate, upper, candidates.length, gate.eligibleCount, gate.testCount,
        auditedCoverage.firstDayCoverage, auditedCoverage.fiveDayCoverage, JSON.stringify({ ...metrics, modelConfigHash: MODEL_CONFIG_HASH, dailyCoverage: auditedCoverage, probe: auditedProbe, gateDiagnostics: { vetoCounts: gate.vetoCounts, formalValidation } }), JSON.stringify(windows),
        gate.status, JSON.stringify(gate.reasons), inputHash]);
  }
  return { ...payload, inputHash };
}

async function getHkFormalGateStatus(executor = pool.query.bind(pool)) {
  const result = await executor(`SELECT gate_status,gate_reasons,metrics,model_version,created_at
    FROM analytics.hk_ipo_backtests ORDER BY created_at DESC LIMIT 1`);
  const row = result.rows[0];
  return row ? { passed: row.gate_status === 'passed', ...row } : { passed: false, gate_status: 'blocked', gate_reasons: ['尚未完成港股回测'] };
}

async function assertHkFormalGate(executor = pool.query.bind(pool)) {
  const gate = await getHkFormalGateStatus(executor);
  if (!gate.passed) throw new Error(`港股正式建议门禁未通过：${(gate.gate_reasons || []).join('、')}`);
  return gate;
}

// 唯一的正式建议快照写入口；任何 stage=formal 写入都必须先经过最新回测门禁。
async function upsertHkFormalRecommendationSnapshot({ instrumentId, asOfDate, modelVersion = MODEL_CONFIG.model_version,
  score = null, advice = '', riskFlags = [], inputCompleteness = {}, dataAsOf = null, rawPayload = {}, executor = pool.query.bind(pool) } = {}) {
  await assertHkFormalGate(executor);
  const result = await executor(`
    INSERT INTO analytics.ipo_recommendation_snapshots(
      instrument_id,market_code,stage,as_of_date,model_version,score,advice,risk_flags,input_completeness,
      data_as_of,published_at,is_stale,stale_reason,raw_payload,created_at,updated_at
    ) VALUES($1,'HK','formal',$2::date,$3,$4,$5,$6::jsonb,$7::jsonb,$8::date,now(),false,'',$9::jsonb,now(),now())
    ON CONFLICT(instrument_id,stage,as_of_date,model_version) DO UPDATE SET
      score=EXCLUDED.score,advice=EXCLUDED.advice,risk_flags=EXCLUDED.risk_flags,input_completeness=EXCLUDED.input_completeness,
      data_as_of=EXCLUDED.data_as_of,published_at=EXCLUDED.published_at,is_stale=false,stale_reason='',raw_payload=EXCLUDED.raw_payload,updated_at=now()
    RETURNING snapshot_id`,
    [instrumentId, asOfDate, modelVersion, score, advice, JSON.stringify(riskFlags), JSON.stringify(inputCompleteness), dataAsOf, JSON.stringify(rawPayload)]
  );
  return { gate: true, snapshotId: result.rows[0]?.snapshot_id || null };
}

module.exports = { MODEL_CONFIG, MODEL_CONFIG_HASH, visibleScore, quantile, buildMetrics, buildBacktestRows, dailyCoverageFromBars, consecutiveWorkdayCount, loadProbeAudit, persistModelConfigSnapshot, buildWalkForward, wilsonInterval, posteriorRate, expectedNetProfit, auditFormalValidation, evaluateFormalGate, runHkIpoBacktest, getHkFormalGateStatus, assertHkFormalGate, upsertHkFormalRecommendationSnapshot };
