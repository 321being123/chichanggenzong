const express = require('express');
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { pool } = require('../db/connection');
const {
  normalizeBondCode, refreshConvertibleBondAnalysis, getConvertibleBondSnapshot,
} = require('../services/convertibleBondAnalysis');
const { getBondList } = require('../services/convertibleBondListService');

const router = express.Router();

function validBond(req, res, next) {
  const tsCode = normalizeBondCode(req.params.code);
  if (!tsCode) return res.status(400).json({ error: '请输入有效的可转债代码' });
  req.bondTsCode = tsCode;
  next();
}

router.get('/list/securities', requireLogin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT code,MAX(name) AS name,BOOL_OR(held) AS held,BOOL_OR(watchlisted) AS watchlisted FROM (
       SELECT p.code,MAX(p.name) AS name,true AS held,false AS watchlisted FROM positions p
        WHERE p.username=$1 AND p.code ~ '^[0-9]{6}$' GROUP BY p.code
       UNION ALL
       SELECT substring(w.ts_code,1,6),MAX(w.name),false,true FROM stock_watchlist w
        WHERE w.username=$1 GROUP BY substring(w.ts_code,1,6)
     ) s GROUP BY code ORDER BY held DESC,name,code`, [req.session.user]
  );
  res.json({ data: rows.map(row => Object.assign(row, { type: normalizeBondCode(row.code) ? 'bond' : 'stock' })) });
}));

router.get('/search/securities', asyncHandler(async (req, res) => {
  const keyword = String(req.query.q || '').trim().slice(0, 30);
  if (!keyword) return res.json({ data: [] });
  const like = `%${keyword}%`;
  const prefix = `${keyword}%`;
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT substring(m.ts_code,1,6) AS code,m.ts_code,m.name,'stock'::text AS type,''::text AS stock_name
         FROM market_instruments m
        WHERE m.source='tushare'
          AND m.ts_code ~ '^(60|68|00|30|43|83|87|92)[0-9]{4}\\.(SH|SZ|BJ)$'
          AND (m.name ILIKE $1 OR m.ts_code ILIKE $1 OR substring(m.ts_code,1,6) ILIKE $1)
       UNION ALL
       SELECT substring(b.canonical_code,1,6),b.canonical_code,p.bond_short_name,'bond',COALESCE(s.name,'')
         FROM fundamental.convertible_bond_profiles p
         JOIN core.instruments b ON b.instrument_id=p.instrument_id
         LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
        WHERE b.status <> 'delisted'
          AND (b.delist_date IS NULL OR b.delist_date > CURRENT_DATE)
          AND (p.maturity_date IS NULL OR p.maturity_date >= CURRENT_DATE)
          AND (p.conv_end_date IS NULL OR p.conv_end_date >= CURRENT_DATE)
          AND (p.conv_stop_date IS NULL OR p.conv_stop_date > CURRENT_DATE)
          AND (p.bond_short_name ILIKE $1 OR b.canonical_code ILIKE $1
               OR substring(b.canonical_code,1,6) ILIKE $1 OR COALESCE(s.name,'') ILIKE $1)
     )
     SELECT code,ts_code,name,type,stock_name
       FROM candidates
      ORDER BY CASE WHEN name ILIKE $2 THEN 0 WHEN code ILIKE $2 THEN 1 ELSE 2 END,
               CASE type WHEN 'stock' THEN 0 ELSE 1 END,name,code
      LIMIT 12`,
    [like, prefix]
  );
  res.json({ data: rows });
}));

// 上市可转债列表：默认读取本地快照，行情刷新通过统一服务端缓存完成。
router.get('/bonds', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 50);
  const requestedDate = String(req.query.date || '').trim();
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return res.status(400).json({ error: '交易日格式应为 YYYY-MM-DD' });
  }
  const tradeDate = requestedDate || null;
  const refreshQuotes = !requestedDate && ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
  const result = await getBondList({ tradeDate, query, limit: req.query.limit, refreshQuotes });
  res.json(result);
}));

router.get('/:code', validBond, asyncHandler(async (req, res) => {
  const snapshot = await getConvertibleBondSnapshot(req.bondTsCode);
  if (!snapshot) return res.status(404).json({ error: '尚未建档，请刷新该可转债' });
  res.json(snapshot);
}));

router.post('/:code/refresh', requireLogin, rateLimit({
  prefix: 'bond-analysis-refresh', windowMs: 60 * 60 * 1000, max: 10,
  getKey: req => req.session.user, message: '刷新过于频繁，请稍后再试',
}), validBond, asyncHandler(async (req, res) => {
  try {
    const analysis = await refreshConvertibleBondAnalysis(req.bondTsCode, `manual:${req.session.user}`);
    res.json({ ok: true, analysis });
  } catch (error) {
    const snapshot = await getConvertibleBondSnapshot(req.bondTsCode);
    if (snapshot) return res.status(502).json({ error: error.message, stale: true, analysis: snapshot });
    res.status(502).json({ error: error.message });
  }
}));

module.exports = router;
