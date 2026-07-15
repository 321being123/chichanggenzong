// ========== 打新日历 Node 接口回归测试（e2e，挂真实 router + 本地 PG）==========
// 运行：node server/test/ipo-api.test.js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const express = require('express');
const assert = require('assert');

const ipoRouter = require('../routes/ipo');

let server, base;
const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

async function main() {
  const app = express();
  app.use(express.json());
  // 桩 session（requireLogin 只校验 req.session.user）
  app.use((req, res, next) => { req.session = { user: 'test' }; next(); });
  app.use('/api/ipo', ipoRouter);
  await new Promise(r => { server = app.listen(0, r); });
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;

  // 1. 最新报告
  console.log('== 1. GET /api/ipo/report ==');
  let r = await fetch(base + '/api/ipo/report');
  check('HTTP 200', () => assert.strictEqual(r.status, 200));
  let j = await r.json();
  check('返回 report_date 字段', () => assert.ok('report_date' in j));
  check('返回 summary/md/html', () => assert.ok('summary' in j && 'md' in j && 'html' in j));
  if (j.report_date) {
    check('summary 为对象', () => assert.strictEqual(typeof j.summary, 'object'));
    check('summary 含 apply_stocks 数组', () => assert.ok(Array.isArray(j.summary.apply_stocks)));
  } else {
    console.log('  (本地无报告行，跳过 summary 结构校验)');
  }

  // 2. 历史日期列表
  console.log('== 2. GET /api/ipo/reports ==');
  r = await fetch(base + '/api/ipo/reports');
  check('HTTP 200', () => assert.strictEqual(r.status, 200));
  j = await r.json();
  check('返回数组', () => assert.ok(Array.isArray(j)));
  if (Array.isArray(j) && j.length) {
    const item = j[0];
    check('项含 report_date/date_display/weekday',
      () => assert.ok('report_date' in item && 'date_display' in item && 'weekday' in item));
    const nan = j.filter(x => (x.date_display || '').includes('nan'));
    check('date_display 无 nan', () => assert.strictEqual(nan.length, 0, 'nan项=' + nan.length));
  }

  // 3. 已上市新股
  console.log('== 3. GET /api/ipo/history?type=stock ==');
  r = await fetch(base + '/api/ipo/history?type=stock&limit=20');
  check('HTTP 200', () => assert.strictEqual(r.status, 200));
  j = await r.json();
  check('type=stock', () => assert.strictEqual(j.type, 'stock'));
  check('rows 为数组', () => assert.ok(Array.isArray(j.rows)));
  if (Array.isArray(j.rows) && j.rows.length) {
    const row = j.rows[0];
    for (const k of ['security_code', 'security_name', 'listing_date', 'ld_close_change']) {
      check('stock 行含 ' + k, () => assert.ok(k in row));
    }
    const nan = j.rows.filter(x => (x.listing_date || '').includes('nan'));
    check('listing_date 无 nan', () => assert.strictEqual(nan.length, 0));
  }

  // 4. 已上市新债
  console.log('== 4. GET /api/ipo/history?type=bond ==');
  r = await fetch(base + '/api/ipo/history?type=bond&limit=20');
  check('HTTP 200', () => assert.strictEqual(r.status, 200));
  j = await r.json();
  check('type=bond', () => assert.strictEqual(j.type, 'bond'));
  check('rows 为数组', () => assert.ok(Array.isArray(j.rows)));
  if (Array.isArray(j.rows) && j.rows.length) {
    const row = j.rows[0];
    for (const k of ['security_code', 'security_name', 'listing_date', 'first_day_return']) {
      check('bond 行含 ' + k, () => assert.ok(k in row));
    }
    const nan = j.rows.filter(x => (x.listing_date || '').includes('nan'));
    check('listing_date 无 nan', () => assert.strictEqual(nan.length, 0));
  }

  server.close();

  const fails = results.filter(x => x[0] === 'FAIL');
  console.log('\n===== Node 接口测试结果 =====');
  console.log('PASS=%d  FAIL=%d', results.length - fails.length, fails.length);
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
