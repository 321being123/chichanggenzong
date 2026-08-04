// ACCESS-01 后端访问矩阵接口测试（运行态，不依赖浏览器）
// 验证：游客访问公开研究数据快照不被拦截；游客访问私有账户/用户列表/刷新/写接口被 401 拦截。
// 私有接口拦截由 requireLogin/requireAdmin 在到达处理函数前短路返回 401，因此无需数据库即可判定。
// 公开接口需查库返回 200，缺库时该部分标 SKIP（不计入失败）。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const express = require('express');
const { pool } = require('../db');
const accountsRouter = require('../routes/accounts');
const adminRouter = require('../routes/admin');
const stockAnalysisRouter = require('../routes/stockAnalysis');
const bondSafetyRouter = require('../routes/bondSafety');
const bondValuationRouter = require('../routes/bondValuation');
const marketVolatilityRouter = require('../routes/marketVolatility');
const knowledgeRouter = require('../routes/knowledge');
const ipoRouter = require('../routes/ipo');

const U = 'access_matrix_test';
const results = [];
async function check(name, fn) {
  try { await fn(); results.push('PASS'); console.log('  [PASS] ' + name); }
  catch (e) { results.push('FAIL'); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

(async () => {
  let hasDb = true;
  try { await pool.query('SELECT 1'); } catch (e) { hasDb = false; }

  const app = express();
  app.use(express.json());
  // 模拟游客：提供空 session 对象（生产由 express-session 保证存在），但不含 user
  app.use(function (req, res, next) { if (!req.session) req.session = {}; next(); });
  // 注意：不写入 req.session.user —— 模拟游客（无登录态）
  app.use('/api', accountsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/stock-analysis', stockAnalysisRouter);
  app.use('/api/bond-safety', bondSafetyRouter);
  app.use('/api/bond-valuation', bondValuationRouter);
  app.use('/api/market-volatility', marketVolatilityRouter);
  app.use('/api/knowledge', knowledgeRouter);
  app.use('/api/ipo', ipoRouter);

  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/api';

  // ===== 1) 游客访问私有接口必须被拦截（401） =====
  await check('游客 GET /accounts → 401', async () => {
    const r = await fetch(base + '/accounts');
    assert.strictEqual(r.status, 401, '未登录访问账户列表应 401，实际 ' + r.status);
  });
  await check('游客 GET /stock-analysis/stocks（用户私有列表）→ 401', async () => {
    const r = await fetch(base + '/stock-analysis/stocks');
    assert.strictEqual(r.status, 401, '未登录访问本人股票列表应 401，实际 ' + r.status);
  });
  await check('游客 GET /stock-analysis/watchlist → 401', async () => {
    const r = await fetch(base + '/stock-analysis/watchlist');
    assert.strictEqual(r.status, 401, '未登录访问自选股应 401，实际 ' + r.status);
  });
  await check('游客 GET /admin/users → 401', async () => {
    const r = await fetch(base + '/admin/users');
    assert.strictEqual(r.status, 401, '未登录访问后台用户管理应 401，实际 ' + r.status);
  });
  await check('游客 GET /knowledge/can-write → 401', async () => {
    const r = await fetch(base + '/knowledge/can-write');
    assert.strictEqual(r.status, 401, '未登录查询写作权限应 401，实际 ' + r.status);
  });
  await check('游客 POST /stock-analysis/600519/refresh（刷新）→ 401', async () => {
    const r = await fetch(base + '/stock-analysis/600519/refresh', { method: 'POST' });
    assert.strictEqual(r.status, 401, '未登录刷新个股应 401，实际 ' + r.status);
  });
  await check('游客 POST /bond-safety/refresh（刷新）→ 401', async () => {
    const r = await fetch(base + '/bond-safety/refresh', { method: 'POST' });
    assert.strictEqual(r.status, 401, '未登录刷新转债安全性应 401，实际 ' + r.status);
  });

  // ===== 2) 游客访问公开研究快照不应被拦截（非 401） =====
  if (!hasDb) {
    console.log('  [SKIP] 公开快照 GET 需数据库，当前不可用，跳过');
    console.log('ACCESS-MATRIX-SKIP');
  } else {
    await check('游客 GET /bond-safety/bonds（公开快照）非 401', async () => {
      const r = await fetch(base + '/bond-safety/bonds');
      assert.notStrictEqual(r.status, 401, '公开转债快照不应要求登录，实际 ' + r.status);
    });
    await check('游客 GET /bond-valuation/bonds（公开估值）非 401', async () => {
      const r = await fetch(base + '/bond-valuation/bonds');
      assert.notStrictEqual(r.status, 401, '公开转债估值不应要求登录，实际 ' + r.status);
    });
    await check('游客 GET /market-volatility/overview（公开周期）非 401', async () => {
      const r = await fetch(base + '/market-volatility/overview');
      assert.notStrictEqual(r.status, 401, '公开市场周期不应要求登录，实际 ' + r.status);
    });
    await check('游客 GET /ipo/calendar（公开打新）非 401', async () => {
      const r = await fetch(base + '/ipo/calendar');
      assert.notStrictEqual(r.status, 401, '公开打新日历不应要求登录，实际 ' + r.status);
    });
    await check('游客 GET /knowledge/articles（公开笔记）非 401', async () => {
      const r = await fetch(base + '/knowledge/articles');
      assert.notStrictEqual(r.status, 401, '公开投资笔记不应要求登录，实际 ' + r.status);
    });
    await check('游客 GET /stock-analysis/600519（公开个券快照）非 401', async () => {
      const r = await fetch(base + '/stock-analysis/600519');
      assert.notStrictEqual(r.status, 401, '公开个券快照不应要求登录，实际 ' + r.status);
    });
  }

  server.close();
  const failed = results.filter(r => r === 'FAIL').length;
  console.log('access-matrix: ' + results.length + ' 项检查，失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
