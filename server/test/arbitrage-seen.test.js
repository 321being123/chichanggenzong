const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pool } = require('../db');
const { MIGRATIONS } = require('../db/migrations');
require('../services/tencentQuote').fetchTencentQuotes = async () => new Map();
const service = require('../services/arbitrageService');

async function main() {
  await require('../db').runMigrations();
  const prefix = 'test_arb_seen_' + Date.now();
  const users = [prefix + '_a', prefix + '_b'];
  const ids = [];
  try {
    await pool.query('INSERT INTO users(username,password) SELECT unnest($1::text[]), $2', [users, 'test-only']);
    const source = await pool.query('SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1');
    for (const [index, strategy] of ['a_cash_offer', 'a_cash_offer', 'hk_privatisation'].entries()) {
      const created = await pool.query(`INSERT INTO event.arbitrage_cases
        (market,strategy_type,source_id,source_key,offer_price,event_status,review_status,announced_at)
        VALUES($1,$2,$3,$4,10,'in_progress','approved',now()+interval '1 day') RETURNING case_id`,
      [strategy === 'hk_privatisation' ? 'HK' : 'CN', strategy, source.rows[0].source_id, prefix + index]);
      ids.push(created.rows[0].case_id);
    }
    let list = await service.getArbitrageList('a_stock', 1, 2000, users[0]);
    const initialUnread = await service.getArbitrageUnreadCount(users[0]);
    assert(initialUnread >= 3);
    assert.strictEqual((await service.getArbitrageList('a_stock', 1, 1, users[0])).unreadCount, initialUnread, '总数覆盖其他策略和其他分页');
    assert.strictEqual(await service.getArbitrageUnreadCount(), 0, '游客不显示个人未看数');
    assert(list.rows.find(r => r.case_id === ids[0]).is_new);
    assert(list.canMarkSeen);
    assert.strictEqual((await service.getArbitrageDetail(ids[0], users[0])).is_new, true, '打开详情不会自动已看');
    assert((await service.getArbitrageList('hk_privatisation', 1, 2000, users[0])).rows.find(r => r.case_id === ids[2]).is_new);
    await Promise.all(ids.slice(0, 2).map(id => service.markArbitrageSeen(users[0], id)));
    list = await service.getArbitrageList('a_stock', 1, 2000, users[0]);
    ids.slice(0, 2).forEach(id => assert.strictEqual(list.rows.find(r => r.case_id === id).is_new, false, '并发标记不能丢失'));
    assert.strictEqual(await service.getArbitrageUnreadCount(users[0]), initialUnread - 2);
    assert.strictEqual((await service.getArbitrageDetail(ids[0], users[1])).is_new, true, '不同用户互不影响');
    assert.strictEqual((await service.getArbitrageDetail(ids[0])).is_new, null, '游客没有个人阅读状态');
    assert.strictEqual(await service.markArbitrageSeen(users[0], ids[0]), true, '重复标记幂等');
    await MIGRATIONS.find(m => m.version === '163_arbitrage_seen_cases').up();
    assert.strictEqual((await service.getArbitrageDetail(ids[0], users[0])).is_new, false, '重复迁移不覆盖记录');
    await pool.query("UPDATE event.arbitrage_cases SET review_status='pending' WHERE case_id=$1", [ids[2]]);
    assert.strictEqual(await service.markArbitrageSeen(users[0], ids[2]), false, '未公开机会不能标记');
    await pool.query("UPDATE event.arbitrage_cases SET review_status='approved' WHERE case_id=$1", [ids[2]]);
    assert.strictEqual((await service.getArbitrageDetail(ids[2], users[0])).is_new, true, '后审核公开的机会仍为新');
    await testApi(users, ids);
    const publicLists = await Promise.all(['a_stock', 'hk_privatisation', 'hk_rights'].map(type => service.getArbitrageList(type, 1, 2000, users[0])));
    for (const list of publicLists) {
      for (const row of list.rows) await service.markArbitrageSeen(users[0], row.case_id);
    }
    assert.strictEqual(await service.getArbitrageUnreadCount(users[0]), 0, '全部公开机会已看后计数归零');
    await testFrontend();
    console.log('套利阅读状态：真实落库、账号隔离、并发幂等、新旧排序及失败保留通过');
  } finally {
    await pool.query('DELETE FROM event.arbitrage_cases WHERE source_key LIKE $1', [prefix + '%']);
    await pool.query('DELETE FROM users WHERE username=ANY($1::text[])', [users]);
    await pool.end();
  }
}

async function testApi(users, ids) {
  const app = require('express')();
  app.use(require('express').json());
  let user = null;
  const version = await pool.query('SELECT auth_version FROM users WHERE username=$1', [users[1]]);
  app.use((req, res, next) => { req.session = user ? { user, authVersion: version.rows[0].auth_version } : {}; next(); });
  app.use('/api/arbitrage', require('../routes/arbitrage'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/arbitrage';
  try {
    assert.strictEqual((await fetch(url + '/' + ids[0] + '/seen', { method: 'POST' })).status, 401);
    user = users[1];
    const countResponse = await fetch(url + '/unread-count');
    assert.strictEqual(countResponse.status, 200, '计数路由不能被详情路由截获');
    assert.strictEqual(countResponse.headers.get('cache-control'), 'private, no-store');
    const initialUnread = (await countResponse.json()).unreadCount;
    assert.strictEqual((await fetch(url + '/1abc/seen', { method: 'POST' })).status, 400);
    const result = await fetch(url + '/' + ids[0] + '/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: users[0] }) });
    assert.strictEqual(result.status, 200);
    assert.strictEqual((await result.json()).unreadCount, initialUnread - 1);
    assert.strictEqual((await service.getArbitrageDetail(ids[0], users[1])).is_new, false);
    assert.strictEqual((await service.getArbitrageDetail(ids[2], users[0])).is_new, true);
    const list = await fetch(url + '?type=a_stock');
    assert.strictEqual(list.headers.get('cache-control'), 'private, no-store');
    user = null;
    assert.strictEqual((await (await fetch(url + '/unread-count')).json()).unreadCount, 0);
    const guest = await (await fetch(url + '?type=a_stock')).json();
    assert.strictEqual(guest.canMarkSeen, false);
    assert(guest.rows.every(row => row.is_new === null));
  } finally { await new Promise(resolve => server.close(resolve)); }
}

async function testFrontend() {
  const script = fs.readFileSync(path.join(__dirname, '../../public/js/arbitrage.js'), 'utf8');
  const dom = new JSDOM('<button class="main-tab" data-main="arbitrage">套利机会<span id="arb-unread-count" hidden></span></button><div id="arb-table"></div><div id="arb-status"></div><div id="arb-detail"></div>', { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.eval(script);
  const badge = w.document.getElementById('arb-unread-count');
  w.renderArbUnreadCount(12);
  assert.strictEqual(badge.textContent, '12');
  assert.strictEqual(badge.hidden, false);
  assert.strictEqual(badge.style.width, badge.style.height, '多位数字仍保持圆形');
  w.username = 'test-reader';
  let finishCount;
  w.fetch = () => new Promise(resolve => { finishCount = resolve; });
  const pendingCount = w.loadArbUnreadCount();
  w.renderArbUnreadCount(0);
  finishCount({ ok: true, json: async () => ({ unreadCount: 12 }) });
  await pendingCount;
  assert.strictEqual(badge.hidden, true, '延迟计数不能恢复已经清除的红点');
  for (const type of ['a_stock', 'hk_privatisation', 'hk_rights']) {
    w.arbState.type = type;
    w.arbState.data = { canMarkSeen: true, rows: [{ case_id: 1, name: '老机会', is_new: false }, { case_id: 2, name: '新机会', is_new: true }] };
    w.renderArbTable(w.arbState.data);
    const d = w.document;
    assert(d.querySelector('tbody tr:first-child').textContent.includes('新机会'));
    assert.strictEqual(d.querySelectorAll('[data-arb-seen]').length, 1);
    const rows = d.querySelectorAll('tbody tr');
    rows.forEach(row => assert.strictEqual(row.cells.length, d.querySelectorAll('th').length));
    w.fetch = async () => ({ ok: false, json: async () => ({ error: '保存失败' }) });
    await w.markArbSeen(2);
    assert.strictEqual(w.arbState.data.rows[1].is_new, true);
    assert.strictEqual(d.querySelector('[data-arb-seen]').disabled, false);
    w.fetch = async () => ({ ok: true, json: async () => ({ ok: true, unreadCount: 0 }) });
    await w.markArbSeen(2);
    assert.strictEqual(d.querySelector('[data-arb-seen]'), null);
    assert.strictEqual(w.arbState.data.rows[1].is_new, false);
    assert.strictEqual(badge.hidden, true, '看完后红点消失');
  }
  dom.window.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
