const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { evaluateBondSafety } = require('./bondSafety');
const { fetchBondSafetySource, isConfigured } = require('./bondSafetyFetcher');

const JOB_NAME = 'bond_safety_refresh';

function stableIdentity(row, companyRow = false) {
  if (!row) return null;
  const value = companyRow
    ? (row.identity_key ?? row.stock_instrument_id ?? row.company_id ?? row.stock_code ?? row.stk_code ?? row.ts_code)
    : (row.identity_key ?? row.stock_instrument_id ?? row.company_id ?? row.stock_code ?? row.stk_code);
  return value === null || value === undefined || !String(value).trim() ? null : String(value).trim();
}

function assertStableIdentity(source) {
  const missingCompany = (source.companyRows || []).filter(row => !stableIdentity(row, true)).length;
  const missingBond = (source.bondRows || []).filter(row => !stableIdentity(row, false)).length;
  if (!missingCompany && !missingBond) return;
  const error = new Error(`安全性数据缺少正股代码或身份ID（公司 ${missingCompany} 条，债券 ${missingBond} 条），拒绝按名称匹配`);
  error.code = 'IDENTITY_REQUIRED';
  throw error;
}

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function filterInactiveBonds(snapshot) {
  const data = Array.isArray(snapshot && snapshot.data) ? snapshot.data : [];
  const codes = data.map(row => String(row.bond_code || '').trim()).filter(Boolean);
  if (!codes.length) return snapshot;
  const today = shanghaiDate();
  const { rows } = await pool.query(
    `SELECT bond_code FROM public.bond_unified
      WHERE (bond_code = ANY($1) OR bond_code LIKE ANY(ARRAY(SELECT unnest($1::text[]) || '.%')))
        AND status = 'listed'
        AND (delist_date IS NULL OR delist_date > $2::date)
        AND (maturity_date IS NULL OR maturity_date >= $2::date)
        AND (conv_end_date IS NULL OR conv_end_date >= $2::date)
        AND (conv_stop_date IS NULL OR conv_stop_date > $2::date)
        AND (cb_type IS NULL OR cb_type IN ('CB', ''))
        AND (issue_type IS NULL OR issue_type NOT IN ('定向', '私募'))`,
    [codes, today]
  );
  // 构建活跃码集合，兼容带后缀和不带后缀的匹配
  const active = new Set();
  for (const row of rows) {
    active.add(row.bond_code);
    // 也加入不带后缀的版本，方便匹配安全快照中的纯数字代码
    const bare = row.bond_code.includes('.') ? row.bond_code.split('.')[0] : row.bond_code;
    active.add(bare);
  }
  const inactive = codes.filter(c => !active.has(c));
  if (!inactive.length) return snapshot;
  const filtered = data.filter(row => active.has(String(row.bond_code || '').trim()));
  const diagnostics = Object.assign({}, snapshot.diagnostics || {});
  diagnostics.rating_counts = filtered.reduce((counts, row) => {
    const rating = row.safety || '未评级';
    counts[rating] = (counts[rating] || 0) + 1;
    return counts;
  }, {});
  diagnostics.filtered_inactive_count = inactive.length;
  return Object.assign({}, snapshot, { data: filtered, row_count: filtered.length, diagnostics });
}

async function getLatestSnapshot() {
  const { rows } = await pool.query(
    `SELECT id, refreshed_at, source_updated_at, row_count, data, diagnostics, refresh_reason,
            dominant_risk_level, total_bonds_count, publication_status, publication_reason, quality_gate
       FROM bond_safety_snapshots
      WHERE publication_status='published'
      ORDER BY id DESC LIMIT 1`
  );
  return rows[0] ? filterInactiveBonds(rows[0]) : null;
}

async function getPreviousPublishedSnapshot() {
  const { rows } = await pool.query(
    `SELECT id, row_count, data, diagnostics, total_bonds_count
       FROM bond_safety_snapshots
      WHERE publication_status='published'
      ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || null;
}

function bondSnapshotKey(row) {
  return String(row && (row.bond_code || row.stock_instrument_id || row.company_id || row.stock_code || '')).trim();
}

function ratedCount(rows) {
  return (rows || []).filter(row => String(row && row.safety || '未评级') !== '未评级').length;
}

function publicationQualityGate(result, previous = null) {
  const data = Array.isArray(result && result.data) ? result.data : [];
  const diagnostics = result && result.diagnostics || {};
  const previousData = previous && Array.isArray(previous.data) ? previous.data : [];
  const expectedBonds = Math.max(
    Number(diagnostics.expected_bond_count) || 0,
    Number(previous && (previous.total_bonds_count || previous.row_count)) || 0,
    Number(diagnostics.bond_rows) || data.length
  );
  const currentRated = ratedCount(data);
  const previousRated = ratedCount(previousData);
  const currentUnrated = data.length - currentRated;
  const previousUnrated = previousData.length - previousRated;
  const completeCompanies = Number(diagnostics.financial_complete_companies || 0);
  const eligibleCompanies = Number(diagnostics.eligible_companies || 0);
  const financialCoverage = eligibleCompanies ? completeCompanies / eligibleCompanies : 0;
  const ratingCoverage = data.length ? currentRated / data.length : 0;
  const commonPrevious = new Map(previousData.map(row => [bondSnapshotKey(row), row]).filter(([key]) => key));
  const commonCurrent = data.filter(row => commonPrevious.has(bondSnapshotKey(row)));
  const commonPreviousRated = commonCurrent.filter(row => String(commonPrevious.get(bondSnapshotKey(row)).safety || '未评级') !== '未评级').length;
  const commonCurrentRated = ratedCount(commonCurrent);
  const commonCoverageDrop = commonPreviousRated ? 1 - (commonCurrentRated / commonPreviousRated) : 0;
  const failures = [];
  if (expectedBonds > 0 && data.length < Math.ceil(expectedBonds * 0.95)) failures.push('可转债记录数低于预期完整度95%');
  if (!eligibleCompanies || financialCoverage < 0.95) failures.push('财务完整公司覆盖率低于95%');
  if (!data.length || ratingCoverage < 0.95) failures.push('有评级可转债覆盖率低于95%');
  if (previousData.length && currentUnrated > previousUnrated + Math.max(5, Math.ceil(previousData.length * 0.05))) failures.push('未评级数量异常增加');
  if (commonPreviousRated && commonCoverageDrop > 0.02) failures.push('共有转债有评级覆盖率下降超过2%');
  const periods = [...new Set((diagnostics.financial_report_periods || []).filter(Boolean).map(value => String(value).slice(0, 10)))];
  if (periods.length > 1) failures.push('三类财务报表报告期不一致');
  return {
    ok: failures.length === 0,
    failures,
    expected_bond_count: expectedBonds,
    record_count: data.length,
    financial_complete_companies: completeCompanies,
    eligible_companies: eligibleCompanies,
    financial_coverage: Number(financialCoverage.toFixed(4)),
    rated_count: currentRated,
    rating_coverage: Number(ratingCoverage.toFixed(4)),
    previous_rated_count: previousRated,
    common_bond_count: commonCurrent.length,
    common_previous_rated: commonPreviousRated,
    common_current_rated: commonCurrentRated,
    common_rating_coverage_drop: Number(commonCoverageDrop.toFixed(4)),
    previous_unrated_count: previousUnrated,
    current_unrated_count: currentUnrated,
    financial_report_periods: periods,
  };
}

async function saveSnapshot(result, sourceUpdatedAt, reason, publicationStatus = 'published', qualityGate = {}) {
  // 从 data 数组中提取汇总统计
  const data = result.data;
  const totalBonds = data.length;
  const levelCounts = {};
  data.forEach(row => {
    const level = row.safety || '未评级';
    levelCounts[level] = (levelCounts[level] || 0) + 1;
  });
  let dominantLevel = '未评级';
  let maxCnt = 0;
  for (const [level, cnt] of Object.entries(levelCounts)) {
    if (cnt > maxCnt) { maxCnt = cnt; dominantLevel = level; }
  }

  const { rows } = await pool.query(
    `INSERT INTO bond_safety_snapshots
       (source_updated_at, row_count, data, diagnostics, refresh_reason, dominant_risk_level, total_bonds_count,
        publication_status, publication_reason, quality_gate)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING id, refreshed_at, source_updated_at, row_count, data, diagnostics, refresh_reason, dominant_risk_level,
               total_bonds_count, publication_status, publication_reason, quality_gate`,
    [sourceUpdatedAt || null, data.length, JSON.stringify(data), JSON.stringify(result.diagnostics), reason, dominantLevel, totalBonds,
      publicationStatus, publicationStatus === 'published' ? '' : (qualityGate.failures || []).join('；'), JSON.stringify(qualityGate)]
  );
  // 只按 published 快照保留最近 30 份；拒绝记录不能挤掉可回退的有效数据。
  await pool.query(
    `DELETE FROM bond_safety_snapshots WHERE id NOT IN
       (SELECT id FROM bond_safety_snapshots WHERE publication_status='published' ORDER BY id DESC LIMIT 30)
       AND publication_status='published'`
  );
  return rows[0];
}

async function refreshBondSafety(reason = 'manual', options = {}) {
  const claimed = await tryClaimJob(JOB_NAME);
  if (!claimed) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun(JOB_NAME);
  try {
    const source = await fetchBondSafetySource(process.env, options.targetTradeDate || null, { readOnly: options.readOnly !== false });
    if (!source.companyRows.length || !source.bondRows.length) {
      throw new Error('数据源返回空数据，已保留上一份有效快照');
    }
    assertStableIdentity(source);
    const result = evaluateBondSafety(source.companyRows, source.bondRows, source.sourceUpdatedAt);
    const previous = await getPreviousPublishedSnapshot();
    const companyPeriods = [...new Set((source.companyRows || []).map(row => row.financial_report_end_date).filter(Boolean))];
    result.diagnostics = Object.assign({}, result.diagnostics, {
      expected_bond_count: source.expectedBondCount || source.bondRows.length,
      financial_complete_companies: (source.companyRows || []).filter(row => row.financial_available === true).length,
      financial_report_periods: companyPeriods,
    });
    const qualityGate = publicationQualityGate(result, previous);
    result.diagnostics.publication_quality_gate = qualityGate;
    if (!qualityGate.ok) {
      await saveSnapshot(result, source.sourceUpdatedAt, reason, 'rejected', qualityGate);
      const error = new Error(`安全性快照质量门禁失败：${qualityGate.failures.join('；')}`);
      error.code = 'DATA_QUALITY_GATE_FAILED';
      error.errorType = 'data_quality';
      error.dataDiagnostics = { qualityGate, result: result.diagnostics };
      throw error;
    }
    const snapshot = await saveSnapshot(result, source.sourceUpdatedAt, reason, 'published', qualityGate);
    const dataAsOf = source.dataAsOf || (source.sourceUpdatedAt ? String(source.sourceUpdatedAt).slice(0, 10) : null);
    await finishJobRun(runId, true, `刷新 ${snapshot.row_count} 条；未匹配 ${result.diagnostics.unmatched_stock_count} 条`);
    return { ok: true, skipped: false, snapshot, dataAsOf, publishDatasets: true,
      datasetDiagnostics: { bond_safety_snapshot: { partition_row_count: snapshot.row_count, quality_gate: qualityGate } }, qualityGate };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally {
    await releaseJob(JOB_NAME);
  }
}

module.exports = { getLatestSnapshot, refreshBondSafety, isConfigured, stableIdentity, assertStableIdentity, publicationQualityGate };
