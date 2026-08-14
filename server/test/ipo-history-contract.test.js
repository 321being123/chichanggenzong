// 打新历史/日历行为回归：使用数据库桩验证接口语义，不依赖本地 PostgreSQL。
const assert = require('assert');
const express = require('express');
const db = require('../db');

const originalQuery = db.pool.query.bind(db.pool);
let mode = 'history';
let lastStockSql = '';
db.pool.query = async sql => {
  const text = String(sql);
  if (text.includes('FROM users WHERE username=$1')) {
    return { rows: [{ username: 'test', status: 'active', auth_version: undefined, permissions: {} }] };
  }
  if (text.includes('FROM ipo_history h')) {
    lastStockSql = text;
    if (mode === 'history') {
      return { rows: [
        { security_code: '688826', security_name: '测试已申购', ipo_date: '2026-08-07', listing_date: null,
          history_stage: 'subscribed', field_status: { listing_date: 'pending' }, data_as_of: '2026-08-14' },
        { security_code: '688999', security_name: '测试未来', ipo_date: '2026-08-20', listing_date: null,
          history_stage: 'subscribed', field_status: { listing_date: 'pending' }, data_as_of: '2026-08-14' },
      ] };
    }
    return { rows: [
      { date: '2026-08-15', event_type: 'apply', code: '688826', name: '测试已申购' },
      { date: '2026-08-16', event_type: 'listing', code: '688826', name: '测试已申购' },
    ] };
  }
  if (text.includes('FROM public.bond_unified b')) {
    return { rows: [{ security_code: '123456', security_name: '测试转债', history_stage: 'subscribed',
      field_status: { onl_size: 'pending', first_day_return: 'pending' }, data_as_of: '2026-08-14' }] };
  }
  if (text.includes('FROM event.instrument_events')) return { rows: [] };
  throw new Error(`未预期的 SQL：${text.slice(0, 120)}`);
};

const router = require('../routes/ipo');
const app = express();
app.use((req, res, next) => { req.session = { user: 'test' }; next(); });
app.use('/api/ipo', router);

const server = app.listen(0, async () => {
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    let response = await fetch(`${base}/api/ipo/history?type=stock&limit=50`);
    assert.strictEqual(response.status, 200);
    let payload = await response.json();
    assert.ok(payload.rows.some(row => row.security_code === '688826'), '已申购新股未进入历史');
    assert.ok(payload.rows.some(row => row.history_stage === 'subscribed'), '历史阶段字段缺失');
    assert.ok(payload.rows.every(row => row.field_status), '字段状态缺失');
    assert.match(lastStockSql, /h\.ipo_date <= to_char\(\(timezone\('Asia\/Shanghai', now\(\)\)\)::date/, '历史查询未按申购日准入');

    mode = 'bond';
    response = await fetch(`${base}/api/ipo/history?type=bond&limit=50`);
    assert.strictEqual(response.status, 200);
    payload = await response.json();
    assert.strictEqual(payload.rows[0].history_stage, 'subscribed');
    assert.strictEqual(payload.rows[0].field_status.first_day_return, 'pending');
    assert.strictEqual(payload.rows[0].data_as_of, '2026-08-14');

    mode = 'calendar';
    response = await fetch(`${base}/api/ipo/calendar?days=30`);
    assert.strictEqual(response.status, 200);
    payload = await response.json();
    assert.strictEqual(payload.calendar.find(day => day.date === '2026-08-15').apply_stocks[0].code, '688826');
    assert.strictEqual(payload.calendar.find(day => day.date === '2026-08-16').list_stocks[0].code, '688826');
    console.log('OK ipo-history-contract: 历史阶段、字段状态和事实日历行为通过');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
    db.pool.query = originalQuery;
  }
});

server.on('error', error => {
  db.pool.query = originalQuery;
  console.error(error);
  process.exitCode = 1;
});
