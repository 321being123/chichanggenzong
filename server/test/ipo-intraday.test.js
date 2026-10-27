const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { firstDayPerformance, attachFirstDayPerformance } = require('../services/ipoIntraday');
const now = new Date('2026-10-09T10:00:00+08:00');
const stock = { instrument_id: 1, security_code: '301001', listing_date: '2026-10-09', issue_price: 10, ld_close_change: null };
const quote = { symbol: 'sz301001', price: 12, quote_time: '2026-10-09T09:59:59+08:00' };
let cases = 0;
function check(fn) { fn(); cases++; }

(async () => {
  check(() => assert.deepStrictEqual([firstDayPerformance(stock, quote, now).first_day_return,
    firstDayPerformance(stock, quote, now).first_day_profit], [20, 1000]));
  for (const [price, gain, profit] of [[10,0,0],[8,-20,-1000]]) {
    check(() => { const p = firstDayPerformance(stock, { ...quote, price }, now);
      assert.equal(p.first_day_return, gain); assert.equal(p.first_day_profit, profit); });
  }
  for (const q of [null, { ...quote, price: 0 }, { ...quote, price: 'NaN' },
    { ...quote, quote_time: '2026-10-08T15:00:00+08:00' },
    { ...quote, quote_time: '2026-10-09T10:01:00+08:00' },
    { ...quote, quote_time: '2026-10-09T09:29:59+08:00' }]) {
    check(() => assert.equal(firstDayPerformance(stock, q, now).first_day_return, null));
  }
  for (const row of [{ ...stock, issue_price: null }, { ...stock, listing_date_is_estimated: true },
    { ...stock, ipo_status: 'postponed' }, { ...stock, listing_date: '2026-10-10' }]) {
    check(() => assert.equal(firstDayPerformance(row, quote, now).first_day_return, null));
  }
  check(() => assert.equal(firstDayPerformance(stock, { ...quote, quote_time: '2026-10-09T09:50:00+08:00' }, now).first_day_quote_stale, true));
  check(() => { const result = firstDayPerformance({ ...stock, ld_close_change: 30 }, quote, now);
    assert.equal(result.first_day_basis, 'close'); assert.equal(result.first_day_profit, 1500); });
  const hk = { ...stock, security_code: '00001.HK', market_code: 'HK', issue_price: 99,
    issue_price_final: 10, lot_size_shares: 200, actual_return: null, lot_profit: null };
  check(() => assert.equal(firstDayPerformance(hk, quote, now).first_day_profit, 400));
  check(() => assert.equal(firstDayPerformance({ ...hk, issue_price_final: null }, quote, now).first_day_return, null));
  check(() => assert.equal(firstDayPerformance({ ...hk, lot_size_shares: null }, quote, now).first_day_profit, null));
  check(() => assert.equal(firstDayPerformance(stock, { ...quote, quote_time: '2026-10-09T01:59:59Z' }, now).first_day_return, 20));
  let calls = 0, saved = [quote], options;
  const deps = { now, resolve: async () => quote.symbol, query: async () => ({ rows: saved }),
    fetchQuotes: async (codes, opts) => { calls++; options = opts; assert.deepStrictEqual(codes, ['301001']); return new Map(); } };
  await attachFirstDayPerformance([stock], 'CN', deps);
  check(() => assert.equal(calls, 0, '默认接口只读缓存'));
  const result = await attachFirstDayPerformance([stock, { ...stock, security_code: '600001', listing_date: '2026-10-08' }], 'CN', { ...deps, refresh: true });
  check(() => { assert.equal(calls, 1); assert.equal(options.businessDate, '2026-10-09'); assert.equal(options.force, false); assert.equal(result[1].first_day_return, null); });
  await attachFirstDayPerformance([stock], 'CN', { ...deps, refresh: true, force: true });
  check(() => assert.equal(options.force, true));
  await attachFirstDayPerformance([{ ...stock, listing_date: '2026-10-08' }], 'CN', { ...deps, refresh: true });
  check(() => assert.equal(calls, 2, '历史对象不联网'));
  saved = [];
  const unpersisted = await attachFirstDayPerformance([stock], 'CN', { ...deps, refresh: true,
    fetchQuotes: async () => new Map([['301001', quote]]) });
  check(() => assert.equal(unpersisted[0].first_day_return, null, '未落库报价不冒充已发布数据'));
  saved = [quote];
  const failed = await attachFirstDayPerformance([stock], 'CN', { ...deps, refresh: true, fetchQuotes: async () => { throw new Error('Guard'); } });
  check(() => { assert.equal(failed[0].first_day_return, 20); assert.equal(failed[0].first_day_refresh_failed, true); });
  let release, concurrentCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const concurrent = { ...deps, refresh: true, fetchQuotes: async () => { concurrentCalls++; await pending; return new Map(); } };
  const requests = [attachFirstDayPerformance([stock], 'CN', concurrent), attachFirstDayPerformance([stock], 'CN', concurrent)];
  await new Promise(resolve => setImmediate(resolve)); release(); await Promise.all(requests);
  check(() => assert.equal(concurrentCalls, 1, '并发打开复用同一采集'));

  const dom = new JSDOM('<div id="ipo-history"></div><button id="ipo-refresh-history"></button><button data-ipo-hist="stock"></button>');
  const urls = [];
  const ctx = vm.createContext({ window: dom.window, document: dom.window.document, console,
    api: value => value, escapeHtml: value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;'),
    setTimeout, clearTimeout, AbortController,
    fetch: async url => { urls.push(url); return { ok: true, status: 200, json: async () => ({ type: 'stock', total: 1, rows: [{ ...stock,
      ...firstDayPerformance(stock, quote, now) }] }) }; } });
  // 批次4：页面取数经统一客户端发送，测试必须加载同一份底座，fetch 桩才能拦截到真实请求；
  // 这样断言校验的仍是页面拼出的 URL，不是桩的替代实现。
  vm.runInContext(fs.readFileSync(require('path').join(__dirname, '../../public/js/api/client.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(require('path').join(__dirname, '../../public/js/ipo.js'), 'utf8'), ctx);
  await ctx.ipoLoadHistory('stock');
  check(() => assert.match(urls[0], /refresh_quotes=1$/));
  check(() => { const text = dom.window.document.getElementById('ipo-history').textContent;
    assert.match(text, /20/); assert.match(text, /1000\.00/); assert.match(text, /盘中/); assert.match(text, /09:59:59/); });
  await ctx.ipoLoadHistoryPage('stock', 200);
  check(() => assert.ok(!urls[1].includes('refresh_quotes'), '分页不重新采集'));
  await ctx.ipoRefreshHistory();
  check(() => { assert.match(urls[2], /offset=200&refresh_quotes=force$/); assert.equal(ctx.ipoHistoryOffset, 200); });
  check(() => assert.equal(dom.window.document.getElementById('ipo-refresh-history').disabled, false));
  dom.window.close();
  console.log(`OK ipo-intraday: ${cases} scenarios passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
