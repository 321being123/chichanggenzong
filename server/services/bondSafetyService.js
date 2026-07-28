const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { evaluateBondSafety } = require('./bondSafety');
const { fetchBondSafetySource, isConfigured } = require('./bondSafetyFetcher');

const JOB_NAME = 'bond_safety_refresh';

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
    `SELECT i.canonical_code
       FROM core.instruments i
       LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
       LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      WHERE i.canonical_code=ANY($1)
        AND ((i.delist_date IS NOT NULL AND i.delist_date <= $2::date)
          OR (p.maturity_date IS NOT NULL AND p.maturity_date < $2::date)
          OR (p.conv_end_date IS NOT NULL AND p.conv_end_date < $2::date)
          OR (p.conv_stop_date IS NOT NULL AND p.conv_stop_date <= $2::date)
          OR (p.cb_type IS NOT NULL AND p.cb_type NOT IN ('CB',''))
          OR (s.status IS NOT NULL AND s.status <> 'listed')
          OR (s.delist_date IS NOT NULL AND s.delist_date <= $2::date))`,
    [codes, today]
  );
  const inactive = new Set(rows.map(row => row.canonical_code));
  if (!inactive.size) return snapshot;
  const filtered = data.filter(row => !inactive.has(String(row.bond_code || '').trim()));
  const diagnostics = Object.assign({}, snapshot.diagnostics || {});
  diagnostics.rating_counts = filtered.reduce((counts, row) => {
    const rating = row.safety || '未评级';
    counts[rating] = (counts[rating] || 0) + 1;
    return counts;
  }, {});
  diagnostics.filtered_inactive_count = inactive.size;
  return Object.assign({}, snapshot, { data: filtered, row_count: filtered.length, diagnostics });
}

async function getLatestSnapshot() {
  const { rows } = await pool.query(
    `SELECT id, refreshed_at, source_updated_at, row_count, data, diagnostics, refresh_reason
       FROM bond_safety_snapshots ORDER BY id DESC LIMIT 1`
  );
  return rows[0] ? filterInactiveBonds(rows[0]) : null;
}

async function saveSnapshot(result, sourceUpdatedAt, reason) {
  const { rows } = await pool.query(
    `INSERT INTO bond_safety_snapshots
       (source_updated_at, row_count, data, diagnostics, refresh_reason)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
     RETURNING id, refreshed_at, source_updated_at, row_count, data, diagnostics, refresh_reason`,
    [sourceUpdatedAt || null, result.data.length, JSON.stringify(result.data), JSON.stringify(result.diagnostics), reason]
  );
  // MVP 只保留最近 30 次成功快照；失败不会覆盖最后成功数据。
  await pool.query(
    `DELETE FROM bond_safety_snapshots WHERE id NOT IN
       (SELECT id FROM bond_safety_snapshots ORDER BY id DESC LIMIT 30)`
  );
  return rows[0];
}

async function refreshBondSafety(reason = 'manual') {
  const claimed = await tryClaimJob(JOB_NAME);
  if (!claimed) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun(JOB_NAME);
  try {
    const source = await fetchBondSafetySource();
    if (!source.companyRows.length || !source.bondRows.length) {
      throw new Error('数据源返回空数据，已保留上一份有效快照');
    }
    const result = evaluateBondSafety(source.companyRows, source.bondRows);
    const snapshot = await saveSnapshot(result, source.sourceUpdatedAt, reason);
    await finishJobRun(runId, true, `刷新 ${snapshot.row_count} 条；未匹配 ${result.diagnostics.unmatched_stock_count} 条`);
    return { skipped: false, snapshot };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally {
    await releaseJob(JOB_NAME);
  }
}

module.exports = { getLatestSnapshot, refreshBondSafety, isConfigured };
