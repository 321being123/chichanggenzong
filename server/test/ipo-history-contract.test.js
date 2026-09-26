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
  if (mode === 'hk-calendar' && text.includes("data_completeness->>'status'='retryable'")) {
    return { rows: [{ code: '06727.HK', name: '待补资料公司', offer_close_date: '2026-09-22', missing_fields: ['listingAt'] }] };
  }
  if (mode === 'hk-calendar' && text.includes("WHERE h.market_code='HK'")) {
    lastStockSql = text;
    return { rows: [
      { date: '2026-09-20', event_type: 'apply', code: '09995.HK', name: '测试港股',
        offer_open_at: '2026-09-19T01:00:00.000Z', offer_close_at: '2026-09-21T04:00:00.000Z',
        listing_at: null, listing_date: null, offer_phase: 'open' },
      { date: '2026-09-21', event_type: 'listing', code: '09995.HK', name: '测试港股',
        offer_open_at: '2026-09-19T01:00:00.000Z', offer_close_at: '2026-09-21T04:00:00.000Z',
        listing_at: '2026-09-21T01:00:00.000Z', listing_date: '2026-09-21', offer_phase: 'open' },
      { date: '2026-09-22', event_type: 'listing', code: '06727.HK', name: '预计上市公司',
        offer_open_at: '2026-09-10T01:00:00.000Z', offer_close_at: '2026-09-12T04:00:00.000Z',
        listing_at: null, listing_date: '2026-09-22', offer_phase: 'closed', is_estimated: true },
    ] };
  }
  if (mode === 'hk-report' && text.includes('h.security_code=$1')) {
    lastStockSql = text;
    return { rows: [{ security_code: '09995.HK', security_name: 'Test HK IPO', security_name_cn: '测试港股',
      ipo_status: 'active', market_type: '主板', offer_phase: 'open', offer_open_date: '2026-09-19',
      offer_close_date: '2026-09-21', pricing_date: null, allotment_date: null, listing_date: null,
      issue_price_low: 10, issue_price_high: 12, issue_price_final: null, lot_size_shares: 100,
      lot_amount_hkd: 1200, application_fee_hkd: 30, brokerage_fee_hkd: 12,
      oversubscribe_multiple: null, greenshoe_details: {}, facts_published_at: null,
      current_subscription_signal: null, current_margin_signal: null,
      subscription_live_multiple: null, subscription_live_source: null,
      livermore_grey_market_change_pct: null, futu_grey_market_change_pct: null }] };
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

    mode = 'hk-calendar';
    response = await fetch(`${base}/api/ipo/calendar?market=HK&days=3`);
    assert.strictEqual(response.status, 200);
    payload = await response.json();
    assert.strictEqual(payload.calendar.find(day => day.date === '2026-09-20').apply_stocks[0].code, '09995.HK');
    assert.strictEqual(payload.calendar.find(day => day.date === '2026-09-21').list_stocks[0].offer_phase, 'open');
    assert.strictEqual(payload.calendar.find(day => day.date === '2026-09-22').list_stocks[0].is_estimated, true,
      '预计上市日必须在日历 API 标成预计');
    assert.strictEqual(payload.pending_hk_stocks[0].code, '06727.HK', '无日期的已截止缺口应进入待补列表');
    assert.match(lastStockSql, /timezone\('Asia\/Shanghai', now\(\)\)/, 'HK 日历未使用上海时区边界');
    assert.match(lastStockSql, /offer_close_at >= now\(\)/, 'HK 日历未排除已截止招股窗口');
    assert.match(lastStockSql, /offer_phase IN \('upcoming','open'\)/, 'HK 日历未限制招股状态');

    mode = 'hk-report';
    response = await fetch(`${base}/api/ipo/report/code?code=09995.HK`);
    assert.strictEqual(response.status, 200);
    await response.json();
    assert.match(lastStockSql, /timezone\('Asia\/Shanghai',offer_open_at\)/, 'HK 详情接口未使用上海时区格式化日期');
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
