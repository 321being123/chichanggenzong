const { pool } = require('../db/connection');

// 自 server/services/bondSafetyService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function getLatestSnapshot(options = {}) {
  const { rows } = await pool.query(
    `SELECT id, refreshed_at, source_updated_at,
            to_char(source_updated_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS source_trade_date,
            row_count, data, diagnostics, refresh_reason,
            dominant_risk_level, total_bonds_count, publication_status, publication_reason, quality_gate
       FROM bond_safety_snapshots
      WHERE publication_status='published'
      ORDER BY id DESC LIMIT 1`
  );
  if (!rows[0]) return null;
  const snapshot = await filterInactiveBonds(rows[0]);
  if (options.includeChangePct === false) return snapshot;
  const data = Array.isArray(snapshot.data) ? snapshot.data : [];
  const missingCodes = [...new Set(data
    .filter(row => row.change_pct == null || row.change_pct === '')
    .map(row => String(row.bond_code || '').trim().toUpperCase().split('.')[0])
    .filter(Boolean))];
  if (!snapshot.source_trade_date || !missingCodes.length) return snapshot;
  const { rows: quotes } = await pool.query(`
    SELECT split_part(i.canonical_code, '.', 1) AS bond_code,
           dm.raw_payload->>'pct_chg' AS change_pct
      FROM market.convertible_bond_daily_metrics dm
      JOIN core.instruments i ON i.instrument_id=dm.instrument_id
     WHERE dm.trade_date=$1::date
       AND split_part(i.canonical_code, '.', 1)=ANY($2::text[])
  `, [snapshot.source_trade_date, missingCodes]);
  const changeByCode = new Map(quotes.map(row => {
    const value = row.change_pct == null || String(row.change_pct).trim() === '' ? NaN : Number(row.change_pct);
    return [String(row.bond_code || '').trim().toUpperCase(), Number.isFinite(value) ? value : null];
  }));
  return {
    ...snapshot,
    data: data.map(row => {
      if (row.change_pct != null && row.change_pct !== '') return row;
      const change = changeByCode.get(String(row.bond_code || '').trim().toUpperCase().split('.')[0]);
      return change == null ? row : { ...row, change_pct: change };
    }),
  };
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

// 在市可转债代码（按统一视图状态、退市日、到期日与转股期过滤）
async function listActiveBondCodes(codes, asOfDate, client = pool) {
  const { rows } = await client.query(
    `SELECT bond_code FROM public.bond_unified
      WHERE (bond_code = ANY($1) OR bond_code LIKE ANY(ARRAY(SELECT unnest($1::text[]) || '.%')))
        AND status = 'listed'
        AND (delist_date IS NULL OR delist_date > $2::date)
        AND (maturity_date IS NULL OR maturity_date >= $2::date)
        AND (conv_end_date IS NULL OR conv_end_date >= $2::date)
        AND (conv_stop_date IS NULL OR conv_stop_date > $2::date)
        AND (cb_type IS NULL OR cb_type IN ('CB', ''))
        AND (issue_type IS NULL OR issue_type NOT IN ('定向', '私募'))`,
    [codes, asOfDate],
  );
  return rows.map((row) => String(row.bond_code || '').trim());
}

module.exports = {
  getLatestSnapshot,
  listActiveBondCodes,
  getPreviousPublishedSnapshot,
  saveSnapshot,
};
