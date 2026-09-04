const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin, requireCapability } = require('../middleware/auth');
const svc = require('../services/marketVolatility');
const cycleMetrics = require('../services/marketCycleMetrics');
const { pool, auditEvent } = require('../db');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { calculateGraham } = require('../jobs/marketVolatilitySync');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const { applyPublicCache } = require('../middleware/publicCache');

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
  const metric = String(req.query.metric || 'graham');
  if (metric !== 'graham' && !cycleMetrics.validMetric(metric)) { const e = new Error('股市周期指标参数不合法'); e.status = 400; throw e; }
  if (metric === 'm2_market_cap') return { metric, market: 'CN', benchmark: 'ASHARE' };
  const market = String(req.query.market || 'CN'); const benchmark = String(req.query.benchmark || 'CSI300');
  if (!svc.validMarketBenchmark(market, benchmark)) { const e = new Error('市场或指数参数不合法'); e.status = 400; throw e; }
  return { metric, market, benchmark };
}
async function assertAccount(username, account) {
  const { rows } = await pool.query('SELECT 1 FROM accounts WHERE username=$1 AND account_name=$2 LIMIT 1', [username, account]);
  if (!rows.length) { const e = new Error('账户不存在或无权访问'); e.status = 403; throw e; }
}
async function homeCycleConfig() {
  const { rows } = await pool.query(`SELECT metric_code AS metric,market_code AS market,benchmark_code AS benchmark,
    reference_username,reference_account FROM analytics.market_cycle_home_setting
    WHERE setting_key='market_cycle_home' LIMIT 1`);
  return rows[0] || {
    metric: 'pe', market: 'CN', benchmark: 'CSI300',
    reference_username: process.env.HOME_PE_REFERENCE_USER || 'daicunzai',
    reference_account: process.env.HOME_PE_REFERENCE_ACCOUNT || '华泰账户',
  };
}
function publicHomeConfig(config) {
  return { metric: config.metric, market: config.market, benchmark: config.benchmark };
}
router.get('/overview', asyncHandler(async (req, res) => {
  const { metric, market, benchmark } = query(req); const account = String(req.query.account || '');
  if (account.length > 100) return res.status(400).json({ error: '账户不合法' });
  if (account && req.session.user) await assertAccount(req.session.user, account);
  if (metric === 'graham') return res.json(await svc.getOverview(req.session.user || null, req.session.user ? account : '', market, benchmark));
  res.json(await cycleMetrics.getOverview(req.session.user || null, req.session.user ? account : '', metric, market, benchmark));
}));
router.get('/history', asyncHandler(async (req, res) => {
  const { metric, market, benchmark } = query(req); const range = String(req.query.range || '5y');
  if (!['1y','3y','5y','10y','20y','all'].includes(range)) return res.status(400).json({ error: '时间范围不合法' });
  if (metric === 'graham') return res.json({ market, benchmark, range, history: await svc.getHistory(market, benchmark, range) });
  res.json({ metric, market, benchmark, range, history: await cycleMetrics.getHistory(metric, market, benchmark, range) });
}));
router.get('/home-cycle/config', asyncHandler(async (req, res) => {
  res.json(publicHomeConfig(await homeCycleConfig()));
}));
router.get('/home-cycle', asyncHandler(async (req, res) => {
  const range = String(req.query.range || '20y');
  if (!['1y','3y','5y','10y','20y','all'].includes(range)) return res.status(400).json({ error: '时间范围不合法' });
  const config = await homeCycleConfig();
  const isGraham = config.metric === 'graham';
  // 配置版本 + 参考账户最新数据版本用于条件请求；未变化时不再传输历史图表。
  let cacheVersion = [config.metric, config.market, config.benchmark, config.reference_username, config.reference_account, range].join('|');
  try {
    const metricTable = config.metric === 'graham'
      ? `analytics.graham_index_daily WHERE market_code=$1 AND benchmark_code=$2`
      : config.metric === 'm2_market_cap'
        ? `analytics.m2_market_cap_daily WHERE TRUE`
        : `market.index_valuation_history WHERE index_code=$1 AND valuation_method='market_cap_weighted'`;
    const calculatedColumn = config.metric === 'pe' || config.metric === 'pb' ? 'ingested_at' : 'calculated_at';
    const params = config.metric === 'm2_market_cap' ? [] : [config.metric === 'graham' ? config.market : config.benchmark,
      ...(config.metric === 'graham' ? [config.benchmark] : [])];
    const { rows } = await pool.query(
      `SELECT COALESCE(MAX(trade_date)::text, '1900-01-01') AS latest_date,
              COALESCE(MAX(${calculatedColumn})::text, '') AS latest_calculated
         FROM ${metricTable}`,
      params
    );
    if (rows[0]) cacheVersion += '|' + rows[0].latest_date + '|' + rows[0].latest_calculated;
  } catch (e) {}
  if (applyPublicCache(req, res, cacheVersion)) return;
  const sourceRows = isGraham
    ? await svc.loadRows(config.market, config.benchmark)
    : await cycleMetrics.loadRows(config.metric, config.market, config.benchmark);
  const overview = isGraham
    ? await svc.getOverview(config.reference_username, config.reference_account, config.market, config.benchmark, sourceRows)
    : await cycleMetrics.getOverview(config.reference_username, config.reference_account, config.metric, config.market, config.benchmark, sourceRows);
  const history = isGraham
    ? await svc.getHistory(config.market, config.benchmark, range, sourceRows)
    : await cycleMetrics.getHistory(config.metric, config.market, config.benchmark, range, sourceRows);
  const { actualPosition, deviation, hasUsPosition, ...publicOverview } = overview || {};
  res.json({ ...publicHomeConfig(config), overview: publicOverview, history });
}));
router.put('/home-cycle/config', requireCapability('ops_manage'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const metric = String(body.metric || '');
  const account = String(body.accountName || '');
  let market = String(body.market || '');
  let benchmark = String(body.benchmark || '');
  if (metric !== 'graham' && !cycleMetrics.validMetric(metric)) return res.status(400).json({ error: '股市周期指标参数不合法' });
  if (metric === 'm2_market_cap') { market = 'CN'; benchmark = 'ASHARE'; }
  else if (!svc.validMarketBenchmark(market, benchmark)) return res.status(400).json({ error: '市场或指数参数不合法' });
  await assertAccount(req.session.user, account);
  const saved = metric === 'graham'
    ? await pool.query(`SELECT 1 FROM analytics.graham_strategy_settings
        WHERE username=$1 AND account_name=$2 AND market_code=$3 AND benchmark_code=$4 AND is_current LIMIT 1`,
      [req.session.user, account, market, benchmark])
    : await pool.query(`SELECT 1 FROM analytics.market_cycle_strategy_settings
        WHERE username=$1 AND account_name=$2 AND metric_code=$3 AND market_code=$4 AND benchmark_code=$5 AND is_current LIMIT 1`,
      [req.session.user, account, metric, market, benchmark]);
  if (!saved.rows.length) return res.status(400).json({ error: '请先保存当前页面的仓位边界，再设为首页' });
  await pool.query(`INSERT INTO analytics.market_cycle_home_setting
    (setting_key,metric_code,market_code,benchmark_code,reference_username,reference_account,updated_by,updated_at)
    VALUES('market_cycle_home',$1,$2,$3,$4,$5,$4,now())
    ON CONFLICT(setting_key) DO UPDATE SET metric_code=EXCLUDED.metric_code,market_code=EXCLUDED.market_code,
      benchmark_code=EXCLUDED.benchmark_code,reference_username=EXCLUDED.reference_username,
      reference_account=EXCLUDED.reference_account,updated_by=EXCLUDED.updated_by,updated_at=now()`,
  [metric, market, benchmark, req.session.user, account]);
  await auditEvent({ actor: req.session.user, action: 'market_cycle_home', target: metric, result: 'success', requestId: req.id, detail: market + '/' + benchmark + '/' + account });
  res.json({ ok: true, ...publicHomeConfig({ metric, market, benchmark }) });
}));
router.put('/settings', requireLogin, asyncHandler(async (req, res) => {
  const body = req.body || {}; const metric = String(body.metric || 'graham');
  const market = metric === 'm2_market_cap' ? 'CN' : String(body.market || '');
  const benchmark = metric === 'm2_market_cap' ? 'ASHARE' : String(body.benchmark || '');
  if (metric !== 'graham' && !cycleMetrics.validMetric(metric)) return res.status(400).json({ error: '股市周期指标参数不合法' });
  if (metric !== 'm2_market_cap' && !svc.validMarketBenchmark(market, benchmark)) return res.status(400).json({ error: '市场或指数参数不合法' });
  if (!body.accountName || String(body.accountName).length > 100) return res.status(400).json({ error: '账户不合法' });
  await assertAccount(req.session.user, String(body.accountName));
  try {
    const setting = metric === 'graham'
      ? await svc.saveSetting(req.session.user, String(body.accountName), market, benchmark, body.lowerBoundaryPct, body.upperBoundaryPct, body.version)
      : await cycleMetrics.saveSetting(req.session.user, String(body.accountName), metric, market, benchmark, body.lowerBoundaryPct, body.upperBoundaryPct, body.version);
    res.json({ ok: true, setting });
  }
  catch (e) { res.status(e.conflict ? 409 : e.status || 500).json({ error: e.message }); }
}));
router.post('/federal-funds/import', requireCapability('ops_manage'), upload.single('file'), asyncHandler(async (req, res) => {
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
  try {
    await calculateGraham();
    await auditEvent({ actor: req.session.user, action: 'market_rate_import', target: 'US_10Y', result: 'success', requestId: req.id, metadata: { sourceRows: sourceRecords.length, imported: records.length } });
  } catch (e) {
    await auditEvent({ actor: req.session.user, action: 'market_rate_import', target: 'US_10Y', result: 'failure', requestId: req.id, detail: e.message || '利率导入后重算失败' });
  }
  res.json({ ok: true, sourceRows: sourceRecords.length, imported: records.length, earliest: records[0].tradeDate, latest: records[records.length - 1].tradeDate });
}));
module.exports = router;
