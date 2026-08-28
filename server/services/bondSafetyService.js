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
            dominant_risk_level, total_bonds_count
       FROM bond_safety_snapshots ORDER BY id DESC LIMIT 1`
  );
  return rows[0] ? filterInactiveBonds(rows[0]) : null;
}

async function saveSnapshot(result, sourceUpdatedAt, reason) {
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
       (source_updated_at, row_count, data, diagnostics, refresh_reason, dominant_risk_level, total_bonds_count)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
     RETURNING id, refreshed_at, source_updated_at, row_count, data, diagnostics, refresh_reason, dominant_risk_level, total_bonds_count`,
    [sourceUpdatedAt || null, data.length, JSON.stringify(data), JSON.stringify(result.diagnostics), reason, dominantLevel, totalBonds]
  );
  // MVP 只保留最近 30 次成功快照；失败不会覆盖最后成功数据。
  await pool.query(
    `DELETE FROM bond_safety_snapshots WHERE id NOT IN
       (SELECT id FROM bond_safety_snapshots ORDER BY id DESC LIMIT 30)`
  );
  return rows[0];
}

async function refreshBondSafety(reason = 'manual', options = {}) {
  const claimed = await tryClaimJob(JOB_NAME);
  if (!claimed) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun(JOB_NAME);
  try {
    const source = await fetchBondSafetySource(process.env, options.targetTradeDate || null);
    if (!source.companyRows.length || !source.bondRows.length) {
      throw new Error('数据源返回空数据，已保留上一份有效快照');
    }
    const result = evaluateBondSafety(source.companyRows, source.bondRows, source.sourceUpdatedAt);
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
