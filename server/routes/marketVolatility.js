const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const svc = require('../services/marketVolatility');
const { pool } = require('../db');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { calculateGraham } = require('../jobs/marketVolatilitySync');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function rateDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value == null ? '' : value).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
function rateValue(value) {
  const n = Number(String(value == null ? '' : value).trim().replace(/^=/, ''));
  if (!Number.isFinite(n)) return null;
  const pct = n <= 1 ? n * 100 : n;
  return pct > 0 && pct < 30 ? Number(pct.toFixed(6)) : null;
}
async function parseFederalFundsFile(file) {
  const extension = String(file.originalname || '').toLowerCase().split('.').pop(); let rows = [];
  if (extension === 'csv') rows = file.buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.split(','));
  else if (extension === 'xlsx') {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(file.buffer); const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    sheet.eachRow({ includeEmpty: false }, row => rows.push([row.getCell(1).value, row.getCell(2).value]));
  } else { const err = new Error('仅支持 CSV 或 XLSX 文件'); err.status = 400; throw err; }
  const deduped = new Map();
  for (const row of rows) { const day = rateDate(row[0]), rate = rateValue(row[1]); if (day && rate != null) deduped.set(day, rate); }
  return Array.from(deduped, ([tradeDate, yieldPct]) => ({ tradeDate, yieldPct }));
}
function expandFederalFundsDaily(records) {
  const source = records.slice().sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)), out = [], today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < source.length; i++) {
    const start = new Date(source[i].tradeDate + 'T00:00:00Z'), next = source[i + 1] && new Date(source[i + 1].tradeDate + 'T00:00:00Z');
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
    if (next) { const beforeNext = new Date(next); beforeNext.setUTCDate(beforeNext.getUTCDate() - 1); if (beforeNext < end) end.setTime(beforeNext.getTime()); }
    const todayDate = new Date(today + 'T00:00:00Z'); if (todayDate < end) end.setTime(todayDate.getTime());
    for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) out.push({ tradeDate: day.toISOString().slice(0, 10), yieldPct: source[i].yieldPct, sourceDate: source[i].tradeDate });
  }
  return out;
}

function query(req) {
  const market = String(req.query.market || 'CN'); const benchmark = String(req.query.benchmark || 'CSI300');
  if (!svc.validMarketBenchmark(market, benchmark)) { const e = new Error('市场或指数参数不合法'); e.status = 400; throw e; }
  return { market, benchmark };
}
async function assertAccount(username, account) {
  const { rows } = await pool.query('SELECT 1 FROM accounts WHERE username=$1 AND account_name=$2 LIMIT 1', [username, account]);
  if (!rows.length) { const e = new Error('账户不存在或无权访问'); e.status = 403; throw e; }
}
router.get('/overview', asyncHandler(async (req, res) => {
  const { market, benchmark } = query(req); const account = String(req.query.account || '');
  if (account.length > 100) return res.status(400).json({ error: '账户不合法' });
  if (account && req.session.user) await assertAccount(req.session.user, account);
  res.json(await svc.getOverview(req.session.user || null, req.session.user ? account : '', market, benchmark));
}));
router.get('/history', asyncHandler(async (req, res) => {
  const { market, benchmark } = query(req); const range = String(req.query.range || '5y');
  if (!['1y','3y','5y','10y','20y','all'].includes(range)) return res.status(400).json({ error: '时间范围不合法' });
  res.json({ market, benchmark, range, history: await svc.getHistory(market, benchmark, range) });
}));
router.put('/settings', requireLogin, asyncHandler(async (req, res) => {
  const body = req.body || {}; const market = String(body.market || ''); const benchmark = String(body.benchmark || '');
  if (!svc.validMarketBenchmark(market, benchmark)) return res.status(400).json({ error: '市场或指数参数不合法' });
  if (!body.accountName || String(body.accountName).length > 100) return res.status(400).json({ error: '账户不合法' });
  await assertAccount(req.session.user, String(body.accountName));
  try { res.json({ ok: true, setting: await svc.saveSetting(req.session.user, String(body.accountName), market, benchmark, body.lowerBoundaryPct, body.upperBoundaryPct, body.version) }); }
  catch (e) { res.status(e.conflict ? 409 : e.status || 500).json({ error: e.message }); }
}));
router.post('/federal-funds/import', requireAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择联邦基金利率文件' });
  const sourceRecords = await parseFederalFundsFile(req.file);
  if (!sourceRecords.length) return res.status(400).json({ error: '未识别到有效数据；需要日期和利率两列' });
  const records = expandFederalFundsDaily(sourceRecords);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of records) await client.query(`INSERT INTO market.sovereign_yield_daily(market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
      VALUES('US',10,$1,$2,'manual_fed_funds',$3,$4) ON CONFLICT(market_code,tenor_years,trade_date,source_code) DO UPDATE SET yield_pct=EXCLUDED.yield_pct,source_date=EXCLUDED.source_date,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [row.tradeDate, row.yieldPct, row.sourceDate, JSON.stringify({ source: req.file.originalname, sourceDate: row.sourceDate, rate: row.yieldPct })]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await calculateGraham();
  res.json({ ok: true, sourceRows: sourceRecords.length, imported: records.length, earliest: records[0].tradeDate, latest: records[records.length - 1].tradeDate });
}));
module.exports = router;
