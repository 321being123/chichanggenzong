// 真实前端函数 + 可控异步响应，覆盖标签/内容一致性，不启动浏览器或外部采集。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(require('path').join(__dirname, '../../public/js/ipo.js'), 'utf8');

function setup() {
  const dom = new JSDOM(`<div id="ipo-advice"></div><div id="ipo-calendar"></div><div id="ipo-history"></div>
    ${['stock', 'hk_stock', 'bond'].map(type => `<button data-ipo-hist="${type}" class="${type === 'stock' ? 'active' : ''}"></button>`).join('')}
    ${['CN', 'HK', 'ALL'].map(market => `<button data-ipo-market="${market}" class="${market === 'CN' ? 'active' : ''}"></button>`).join('')}`);
  const requests = [];
  const ctx = vm.createContext({ document: dom.window.document, window: dom.window,
    api: value => value, escapeHtml: value => String(value), console,
    fetch: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })) });
  vm.runInContext(source, ctx);
  ctx.ipoRenderHistory = (type, rows) => type + ':' + rows.map(row => row.security_code).join(',');
  ctx.ipoRenderCalendar = rows => rows.map(row => row.code).join(',');
  ctx.ipoRenderAdvice = () => 'advice';
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function reply(request, data, ok = true) {
    request.resolve({ ok, status: ok ? 200 : 500, json: async () => data });
    await flush();
  }
  return { ctx, requests, reply, flush, document: dom.window.document, close: () => dom.window.close() };
}

(async () => {
  let cases = 0;
  for (const oldType of ['stock', 'hk_stock', 'bond']) {
    for (const newType of ['stock', 'hk_stock', 'bond']) {
      const s = setup();
      s.ctx.ipoSwitchHist(oldType);
      s.ctx.ipoSwitchHist(newType);
      await s.reply(s.requests[1], { type: newType, rows: [{ security_code: 'new' }] });
      await s.reply(s.requests[0], { type: oldType, rows: [{ security_code: 'old' }] });
      assert.equal(s.document.getElementById('ipo-history').textContent, newType + ':new');
      assert.equal(s.document.querySelector('[data-ipo-hist].active').getAttribute('data-ipo-hist'), newType);
      cases++; s.close();
    }
  }
  for (const oldMarket of ['CN', 'HK', 'ALL']) {
    for (const newMarket of ['CN', 'HK', 'ALL']) {
      const s = setup();
      s.ctx.ipoSwitchMarket(oldMarket);
      s.ctx.ipoSwitchMarket(newMarket);
      await s.reply(s.requests[1], { calendar: [{ code: 'new' }] });
      s.requests[0].reject(new Error('old failure')); await s.flush();
      assert.equal(s.document.getElementById('ipo-calendar').textContent, 'new');
      cases++; s.close();
    }
  }
  for (const kind of ['history-error', 'history-http-error', 'history-wrong-type', 'pagination', 'calendar-response', 'init-race', 'report-error']) {
    const t = setup();
    if (kind.startsWith('history-')) {
      t.ctx.ipoSwitchHist('stock');
      t.ctx.ipoSwitchHist('hk_stock');
      await t.reply(t.requests[1], { type: kind === 'history-wrong-type' ? 'stock' : 'hk_stock', rows: [{ security_code: 'new' }] }, kind !== 'history-http-error');
      const current = t.document.getElementById('ipo-history').textContent;
      t.requests[0].reject(new Error('old failure')); await t.flush();
      assert.equal(t.document.getElementById('ipo-history').textContent, current);
      assert.ok(!current.startsWith('stock:new'));
    } else if (kind === 'pagination') {
      t.ctx.ipoLoadHistoryPage('hk_stock', 0);
      t.ctx.ipoLoadHistoryPage('hk_stock', 200);
      await t.reply(t.requests[1], { type: 'hk_stock', rows: [{ security_code: 'page2' }] });
      await t.reply(t.requests[0], { type: 'hk_stock', rows: [{ security_code: 'page1' }] });
      assert.equal(t.document.getElementById('ipo-history').textContent, 'hk_stock:page2');
    } else if (kind === 'calendar-response') {
      t.ctx.ipoSwitchMarket('CN'); t.ctx.ipoSwitchMarket('HK');
      await t.reply(t.requests[1], { calendar: [{ code: 'HK' }] });
      await t.reply(t.requests[0], { calendar: [{ code: 'CN' }] });
      assert.equal(t.document.getElementById('ipo-calendar').textContent, 'HK');
    } else {
      const loading = t.ctx.loadIpo();
      const report = t.requests.find(r => r.url === '/api/ipo/report');
      if (kind === 'report-error') {
        report.reject(new Error('report failure')); await t.flush();
        await t.reply(t.requests.find(r => r.url.includes('calendar')), { calendar: [{ code: 'CN' }] });
        await t.reply(t.requests.find(r => r.url.includes('history')), { type: 'stock', rows: [{ security_code: 'CN' }] });
        await loading;
        assert.equal(t.document.getElementById('ipo-calendar').textContent, 'CN');
        assert.equal(t.document.getElementById('ipo-history').textContent, 'stock:CN');
      } else {
        t.ctx.ipoSwitchHist('hk_stock'); t.ctx.ipoSwitchMarket('HK');
        await t.reply(t.requests.find(r => r.url.includes('history?type=hk_stock')), { type: 'hk_stock', rows: [{ security_code: 'HK' }] });
        await t.reply(t.requests.find(r => r.url.includes('market=HK')), { calendar: [{ code: 'HK' }] });
        await t.reply(report, {});
        await t.reply(t.requests.find(r => r.url.includes('market=CN')), { calendar: [{ code: 'CN' }] });
        await t.reply(t.requests.find(r => r.url.includes('history?type=stock')), { type: 'stock', rows: [{ security_code: 'CN' }] });
        await loading;
        assert.equal(t.document.getElementById('ipo-history').textContent, 'hk_stock:HK');
        assert.equal(t.document.getElementById('ipo-calendar').textContent, 'HK');
        assert.equal(t.requests.filter(r => r.url.includes('market=CN')).length, 1, '初始化复用CN日历响应');
      }
    }
    t.close(); cases++;
  }
  const s = setup();
  s.ctx.ipoSwitchHist('hk_stock');
  await s.reply(s.requests[0], { type: 'hk_stock', rows: [{ security_code: '00001.HK' }] });
  s.ctx.ipoSwitchMarket('HK');
  await s.reply(s.requests[1], { calendar: [{ code: '00001.HK' }] });
  const before = s.requests.length;
  const loading = s.ctx.loadIpo();
  await s.flush();
  const report = s.requests.find((r, i) => i >= before && r.url === '/api/ipo/report');
  await s.reply(report, {});
  await s.flush();
  for (const r of s.requests.slice(before).filter(r => r !== report)) {
    await s.reply(r, { type: 'hk_stock', rows: [{ security_code: '00001.HK' }], calendar: [{ code: '00001.HK' }] });
  }
  await loading;
  assert.ok(!s.requests.slice(before).some(r => r.url.includes('history?type=stock')), '重新进入不能固定加载A股');
  assert.equal(s.document.getElementById('ipo-history').textContent, 'hk_stock:00001.HK');
  assert.equal(s.document.getElementById('ipo-calendar').textContent, '00001.HK');
  assert.ok(s.requests.every(r => !/force|refresh/.test(r.url)), '切换只读本地接口');
  s.close(); cases++;
  console.log(`OK ipo-market-selection: ${cases} 个切换/重新进入场景通过`);
})().catch(error => { console.error(error); process.exitCode = 1; });
