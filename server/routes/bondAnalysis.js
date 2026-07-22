const express = require('express');
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { pool } = require('../db/connection');
const {
  normalizeBondCode, refreshConvertibleBondAnalysis, getConvertibleBondSnapshot,
} = require('../services/convertibleBondAnalysis');

const router = express.Router();
router.use(requireLogin);

function validBond(req, res, next) {
  const tsCode = normalizeBondCode(req.params.code);
  if (!tsCode) return res.status(400).json({ error: '请输入有效的可转债代码' });
  req.bondTsCode = tsCode;
  next();
}

router.get('/list/securities', asyncHandler(async (req, res) => {
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

router.get('/:code', validBond, asyncHandler(async (req, res) => {
  const snapshot = await getConvertibleBondSnapshot(req.bondTsCode);
  if (!snapshot) return res.status(404).json({ error: '尚未建档，请刷新该可转债' });
  res.json(snapshot);
}));

router.post('/:code/refresh', rateLimit({
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
