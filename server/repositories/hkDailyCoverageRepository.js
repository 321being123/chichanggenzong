const { pool } = require('../db/connection');

// 自 server/services/hkDailyCoverage.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function loadCandidates(client, fromDate, toDate, limit = null, targetCodes = []) {
  const scopedCodes = [...new Set((Array.isArray(targetCodes) ? targetCodes : []).map(code => String(code || '').trim().toUpperCase()).filter(code => /^\d{5}\.HK$/.test(code)))];
  const targeted = scopedCodes.length > 0;
  const candidateLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const coverageDateParam = targeted ? 1 : 2;
  const targetFilter = targeted ? ' AND i.canonical_code=ANY($2::text[])' : '';
  const dateFilter = targeted ? '' : ' AND i.list_date::date BETWEEN $1::date AND $2::date';
  const params = targeted ? [toDate, scopedCodes] : [fromDate, toDate];
  const limitClause = candidateLimit ? ` LIMIT $${params.length + 1}` : '';
  if (candidateLimit) params.push(candidateLimit);
  const { rows } = await client.query(
    `SELECT i.instrument_id,i.canonical_code,i.list_date::text AS list_date,i.status
       FROM core.instruments i
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT b.trade_date)::int AS observed_days
           FROM market.daily_bars b
          WHERE b.instrument_id=i.instrument_id
            AND b.trade_date >= i.list_date
            AND b.trade_date <= $${coverageDateParam}::date
       ) coverage ON true
      WHERE i.asset_class='stock' AND i.market='HK'
        AND i.list_date IS NOT NULL AND i.list_date::date <= $${coverageDateParam}::date
        AND i.canonical_code ~ '^\\d{5}\\.HK$'
        ${dateFilter}
        AND COALESCE(coverage.observed_days,0) < 5
        ${targetFilter}
      ORDER BY i.list_date,i.canonical_code
      ${limitClause}`, params
  );
  return rows;
}

async function sourceIdFor(executor = pool, sourceCode = 'tushare') {
  const { rows } = await executor.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1 LIMIT 1', [sourceCode]);
  if (!rows[0]) throw new Error(`${sourceCode} 数据源未注册`);
  return rows[0].source_id;
}

module.exports = {
  loadCandidates,
  sourceIdFor,
};
