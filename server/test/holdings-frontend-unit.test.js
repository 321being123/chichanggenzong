// 持仓前端单测合并文件（合并原 holdings-fx / returns-initial-render / scope-isolation / quote-api）。
(async () => {

  // --- holdings-fx.test.js ---
  await (async () => {
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const quote = fs.readFileSync(path.join(root, 'public', 'shared', 'core-quote.js'), 'utf8');
const tables = fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const { JSDOM } = require('jsdom');
const document = new JSDOM(index).window.document;

assert.ok(quote.includes('fetchUnifiedHKRate') && quote.includes('unifiedHkRatePromise'), '持仓页必须只抓取一次统一汇率');
assert.ok(index.includes('await fetchUnifiedHKRate()'), '切换账户时必须套用统一汇率快照');
assert.ok(tables.includes('data.navAttribution') && tables.includes('fxImpact'), '涨跌归因必须使用后端统一汇率结果');
assert.ok(!tables.includes('历史快照校准差额'), '持仓管理不得继续展示历史快照校准差额');
assert.ok(tables.includes('position-list-table') && tables.includes('positionListBuildFloatingHead'), '持仓明细必须使用统一表格和吸顶表头');
const tableScript = document.querySelector('script[src^="shared/core-tables.js?v="]');
assert.ok(tableScript && new URL(tableScript.src, 'http://localhost').searchParams.get('v') && tableScript.getAttribute('src') !== 'shared/core-tables.js?v=20260818e', '持仓表格必须使用更新后的缓存版本');

console.log('holdings FX tests passed');

  })();

  // --- holdings-returns-initial-render.test.js ---
  await (async () => {
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const source = file => fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8');
assert(source('index.html').includes('shared/core-account.js?v=__APP_VERSION__'), '账户渲染脚本必须跟随应用版本，避免旧缓存继续漏绘');
let checks = 0;
for (const width of [320, 360, 390, 430, 760, 768, 900, 1024, 1440]) {
  const dom = new JSDOM('<div id="returns-section"></div><canvas id="chart-earnings-returns"></canvas>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.innerWidth = width;
  w.NavMath = { isExternalTransfer: () => true };
  w.fmt = n => '¥' + n.toFixed(2);
  w.appChartTooltip = opts => opts;
  let requests = 0;
  w.fetch = () => { requests++; throw new Error('绘图不得取数'); };
  w.HTMLCanvasElement.prototype.getContext = function () { return { canvas: this }; };
  w.Chart = function (ctx, config) {
    this.canvas = ctx.canvas;
    this.data = config.data;
    this.destroy = () => { this.destroyed = true; };
  };
  // 读取脚本实际的词法图表缓存，不使用同名 window 属性替代真实状态。
  w.eval(source('shared/core-earnings.js'));
  w.eval(source('shared/core-returns.js') + '\nwindow.chartMap = chartMap; returnMode = "all";');
  w.eval(source('shared/core-account.js') + '\nearnReturnMode = "all";');
  for (const name of ['renderHomeHoldings', 'renderStats', 'renderCharts', 'renderPositionsTable', 'renderTrades']) w[name] = () => {};
  // 保留收益页实际共用的绘图入口，省略本用例无关的表格与资产图。
  w.renderEarnings = () => w.renderEarningsReturnsChart();
  const account = multiplier => ({
    navHistory: [{ date: '2026-10-08', nav: 1, totalAsset: 100 }, { date: '2026-10-09', nav: multiplier + 0.5, totalAsset: 100 * multiplier }],
    performanceHistory: [{ date: '2026-10-08', nav: 1, totalAsset: 100 }, { date: '2026-10-09', nav: multiplier, totalAsset: 100 * multiplier }],
    indexHistory: [{ date: '2026-10-08', '沪深300': 4000 }, { date: '2026-10-09', '沪深300': 4040 }],
    cashFlows: []
  });
  // 完整数据到齐后首次进入持仓：只走真实全量渲染，不点击周期。
  w.data = account(1.1);
  w.renderAll();
  assert(w.chartMap['chart-returns'], '首次进入必须创建收益走势图'); checks++;
  assert.deepStrictEqual(Array.from(w.chartMap['chart-returns'].data.datasets[0].data), [1, 1.1]); checks++;
  assert.equal(w.chartMap['chart-returns'].data.datasets[1].label, '沪深300'); checks++;
  // 切换账户：销毁旧图并显示新账户数据，两处收益图一致。
  const previous = w.chartMap['chart-returns'];
  w.data = account(1.2);
  w.renderAll();
  assert(previous.destroyed); checks++;
  assert.equal(w.chartMap['chart-returns'].data.datasets[0].data[1], 1.2); checks++;
  assert.equal(w.chartMap['chart-earnings-returns'].data.datasets[0].data[1], 1.2); checks++;
  // 摘要/空账户后完整数据到达：清理旧曲线，恢复完整数据后直接绘图。
  w.data = { navHistory: [], cashFlows: [] };
  w.renderAll();
  assert.equal(w.chartMap['chart-returns'], null); checks++;
  w.data = account(1.3);
  w.renderAll();
  assert.equal(w.chartMap['chart-returns'].data.datasets[0].data[1], 1.3); checks++;
  w.renderAll();
  assert.equal(w.chartMap['chart-returns'].data.datasets[0].data[1], 1.3); checks++;
  assert.equal(requests, 0, '首次绘图、账户切换和重入不得额外取数'); checks++;
  w.close();
}
console.log(`holdings returns initial render: ${checks} DOM/Chart contract checks passed across nine widths; no browser/layout claims`);

  })();

  // --- holdings-scope-isolation.test.js ---
  await (async () => {
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const code=fs.readFileSync('public/shared/core-quote.js','utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
function setup(){const c={window:{},console,Set,Map,Promise,Date,Intl,setTimeout:()=>0,currentAccount:'A',username:'u',accountIdentity:'i',dataVersion:1,data:{positions:[{code:'600000',price:10,quantity:1,subtype:'沪市'}],hkRate:1},priceChangeMap:{},marketStateSnapshot:{markets:{CN:{businessDate:'2026-10-29',status:'open'}}},todayCN:()=> '2026-10-29',marketForPosition:()=> 'CN',getSystemPositionValue:()=>0,recognizeCode:()=>null,quoteDateCN:()=> '2026-10-29',refreshMarketStateSnapshot:async()=>{},applyAuthoritativeMarketDelta:()=>{},calcSummary:()=>({total:10}),renderAll:()=>{},renderReturnsChart:()=>{},recordNav:async()=>{},loadData:async()=>{},showToast:()=>{},localStorage:{getItem:()=>null,setItem:()=>{}},document:{getElementById:()=>({classList:{add(){},remove(){}}})},generation:0};c.captureSmartImportScope=()=>({g:c.generation});c.isSmartImportScopeCurrent=s=>s.g===c.generation;c.window.holdingsQuoteApi={quotes:async()=>({ok:true,payload:{'600000':{price:20,quote_time:'2026-10-29T10:00:00+08:00'}}}),hkRate:async()=>({ok:true,payload:{rate:1}}),savePrices:async()=>({ok:true,payload:{version:2}})};vm.createContext(c);vm.runInContext(code,c);c.showToast=()=>{};return c;}
return (async () =>{
 let c=setup(),gate=deferred(),calls=0,quoteStarted=deferred();c.window.holdingsQuoteApi.quotes=async()=>{calls++;quoteStarted.resolve();return gate.promise};let p=c.refreshAllPrices();await quoteStarted.promise;c.currentAccount='B';c.generation++;c.data={positions:[{code:'600000',price:50}],hkRate:1};gate.resolve({ok:true,payload:{'600000':{price:20}}});await p;assert.equal(c.data.positions[0].price,50);assert.equal(calls,1);
 c=setup();gate=deferred();let started=deferred();let nav=0;c.loadData=async()=>{started.resolve();return gate.promise};c.recordNav=async()=>{nav++};p=c.refreshAllPrices();await started.promise;c.currentAccount='B';c.generation++;c.data={positions:[]};gate.resolve();await p;assert.equal(nav,0,'旧行情响应不得触发新账户净值重读后的记录');
 c=setup();assert.equal(typeof c.saveDailyPricesToDB,'undefined','浏览器不得再持有收盘价写入入口（服务端收盘任务为唯一写入）');assert.equal(typeof c.refreshAllPrices,'function','行情刷新入口仍然保留');
 c=setup();gate=deferred();quoteStarted=deferred();c.window.holdingsQuoteApi.quotes=()=>{quoteStarted.resolve();return gate.promise};p=c.refreshAllPrices();await quoteStarted.promise;c.currentAccount='B';c.generation++;c.currentAccount='A';c.generation++;gate.resolve({ok:true,payload:{}});const result=await p;assert(result.stale,'A→B→A 必须丢弃旧请求');
 console.log('行情跨账户旧响应隔离及收盘价写入收口通过');
})();
  })();

  // --- holdings-quote-api.test.js ---
  await (async () => {
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const calls = [];
let fail = false;
let conflict = false;
const response = { ok: true, status: 200, payload: {} };
const ui = { window: { siteApi: { request: async (url, options) => {
  calls.push({ url, options });
  return fail ? { ok: false, status: 0, payload: {}, error: '网络故障' }
    : conflict ? { ok: false, status: 409, payload: { error: '版本冲突' } } : response;
} } } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/api/holdings-quote-api.js'), 'utf8'), ui);
const api = ui.window.holdingsQuoteApi;

return (async () => {
  assert.strictEqual(await api.quote('600000.SH'), response);
  await api.hkRate(true);
  await api.quotes(['600000', '00700']);
  await api.savePrices('账户甲', 3, [{ code: '600000', price: 10 }]);
  await api.saveDailyPrices('账户甲', '2026-10-28', [{ code: '600000', price: 10 }]);
  await api.addPosition('账户甲', 3, { id: 'fixed-event', code: '600000' });
  await api.addPositions('账户甲', 3, [{ id: 'fixed-batch-event' }]);
  await api.updatePositionMetadata('p1', 3, { account: '账户甲', name: '样本' });
  assert.deepStrictEqual(calls.map(x => x.url), [
    '/api/quote/600000.SH', '/api/hkrate?realtime=1', '/api/quotes?codes=600000%2C00700',
    '/api/positions/prices?version=3', '/api/daily-prices/%E8%B4%A6%E6%88%B7%E7%94%B2',
    '/api/accounts/%E8%B4%A6%E6%88%B7%E7%94%B2/ledger/position-events?version=3',
    '/api/accounts/%E8%B4%A6%E6%88%B7%E7%94%B2/ledger/position-events/batch?version=3',
    '/api/positions/p1/meta?version=3',
  ]);
  assert(calls.every(x => x.options.timeoutMs === 0), '沿用原请求的不设客户端超时口径');
  assert.deepStrictEqual(calls.slice(3).map(x => x.options.method), ['PATCH', 'POST', 'POST', 'POST', 'PATCH']);
  assert.strictEqual(JSON.parse(calls[5].options.body).event.id, 'fixed-event', '保留原交易幂等键');
  assert.strictEqual(JSON.parse(calls[6].options.body).events[0].id, 'fixed-batch-event');
  assert.strictEqual(JSON.parse(calls[7].options.body).account, '账户甲');
  conflict = true;
  const stale = await api.savePrices('账户甲', 3, []);
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.payload.error, '版本冲突');
  conflict = false;
  fail = true;
  await assert.rejects(api.quote('600000'), /网络故障/);
  console.log('持仓行情客户端：7 类请求、版本、正文和网络失败通过');
})();
  })();
})().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
