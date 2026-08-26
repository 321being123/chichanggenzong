const express = require('express');
const asyncHandler = require('../middleware/async');
const {
  getBondRedemptionOverview,
  getLatestCallState,
} = require('../services/convertibleBondRedemptionService');

const router = express.Router();

function validDate(value) {
  const text = String(value || '').trim();
  return !text || /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

router.get('/', asyncHandler(async (req, res) => {
  const date = validDate(req.query.date);
  if (date === null) return res.status(400).json({ error: '交易日格式应为 YYYY-MM-DD' });
  const result = await getBondRedemptionOverview({
    status: String(req.query.status || '').trim(),
    query: String(req.query.q || '').trim(),
    date,
    limit: req.query.limit,
  });
  res.json(result);
}));

router.get('/:instrumentId', asyncHandler(async (req, res) => {
  const instrumentId = Number(req.params.instrumentId);
  if (!Number.isInteger(instrumentId) || instrumentId <= 0) return res.status(400).json({ error: '无效的证券 ID' });
  const result = await getLatestCallState(instrumentId);
  if (!result) return res.status(404).json({ error: '暂无强赎状态数据' });
  res.json({ data: result });
}));

module.exports = router;
