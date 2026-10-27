const express = require('express');
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const bondAnalysisRepository = require('../repositories/bondAnalysisRepository');
const {
  normalizeBondCode, refreshConvertibleBondAnalysis, getConvertibleBondSnapshot,
  buildConvertibleBondAnalysisFromDatabase,
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
  const rows = await bondAnalysisRepository.listOwnedSecurities({ username: req.session.user });
  res.json({ data: rows.map(row => Object.assign(row, { type: normalizeBondCode(row.code) ? 'bond' : 'stock' })) });
}));

router.get('/search/securities', asyncHandler(async (req, res) => {
  const keyword = String(req.query.q || '').trim().slice(0, 30);
  if (!keyword) return res.json({ data: [] });
  const like = `%${keyword}%`;
  const prefix = `${keyword}%`;
  const rows = await bondAnalysisRepository.searchSecurities({ like, prefix });
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
  let snapshot = await getConvertibleBondSnapshot(req.bondTsCode);
  if(!snapshot||snapshot.needs_refresh) {
    try { snapshot=await buildConvertibleBondAnalysisFromDatabase(req.bondTsCode,null,{persist:false}); }
    catch(error) { if(!snapshot)return res.status(404).json({error:error.message}); }
  }
  if (!snapshot) return res.status(404).json({ error: '尚未建档，请刷新该可转债' });
  res.json(snapshot);
}));

router.post('/:code/refresh', requireLogin, rateLimit({
  prefix: 'bond-analysis-refresh', windowMs: 60 * 60 * 1000, max: 10,
  getKey: req => req.session.user, message: '刷新过于频繁，请稍后再试',
}), validBond, asyncHandler(async (req, res) => {
  try {
    // Manual refresh shares the announcement Runner; the Web process only calculates local facts.
    const slot = await require('../services/jobScheduleSlots').enqueueManualJob('convertible_bond_announcement_history_sync', {
      mode:'analysis_inputs_targeted',targetCodes:[req.bondTsCode],force:true,
    });
    const analysis = await refreshConvertibleBondAnalysis(req.bondTsCode, `manual:${req.session.user}`, {readOnly:true});
    res.json({ ok: true, analysis, queued:true,slotId:slot?.slot_id });
  } catch (error) {
    const snapshot = await getConvertibleBondSnapshot(req.bondTsCode);
    if (snapshot) return res.status(502).json({ error: error.message, stale: true, analysis: snapshot });
    res.status(502).json({ error: error.message });
  }
}));

module.exports = router;
