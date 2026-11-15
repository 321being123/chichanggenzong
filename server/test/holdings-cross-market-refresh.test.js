const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const sharedStyle = fs.readFileSync(path.join(root, 'public/shared/style.css'), 'utf8');
const elements = new Map();
const localValues = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { textContent: '', classList: { add() {}, remove() {} } });
  return elements.get(id);
}

const context = {
  data: {
    cash: 1000,
    hkRate: 0.90,
    positions: [
      { code: '600000', name: 'A 股样例', type: '股权', subtype: '沪市', price: 10, quantity: 100 },
      { code: '00700', name: '港股样例', type: '股权', subtype: '港股', price: 20, quantity: 100 },
    ],
  },
  currentAccount: '普通账户',
  dataVersion: 1,
  priceChangeMap: {},
  window: {},
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  document: {
    querySelector: () => null,
    getElementById: element,
    addEventListener() {},
  },
  localStorage: { getItem: key => localValues.get(key) || null, setItem: (key, value) => localValues.set(key, value) },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'public/js/utils.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'public/js/api/client.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'public/js/api/holdings-quote-api.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'public/shared/core-quote.js'), 'utf8'), context);

assert.ok(indexHtml.includes('<button class="btn-refresh" data-act="doRefresh" title="刷新持仓实时价格并重新计算总资产">刷新行情</button>'),
  '现有账户工具栏应显示复用 doRefresh 的“刷新行情”按钮');
assert.ok(indexHtml.includes('shared/core-quote.js?v=__APP_VERSION__') && indexHtml.includes('shared/core-tables.js?v=__APP_VERSION__'),
  '修改后的共享行情与统计脚本必须使用当前版本缓存键');
assert(indexHtml.indexOf('js/api/client.js') < indexHtml.indexOf('js/api/holdings-quote-api.js') &&
  indexHtml.indexOf('js/api/holdings-quote-api.js') < indexHtml.indexOf('shared/core-quote.js'), '持仓行情客户端必须在共享行情之前加载');
assert.ok(sharedStyle.includes('.sub-nav .btn-refresh { background: #fff; color: #1a237e; border: 1px solid #c7cedb; }'),
  '桌面白色工具栏上的刷新按钮应使用可辨认的文字和边框');
assert.ok(sharedStyle.includes('.mobile-account-tools .btn-refresh { min-height: 44px; }'),
  '移动端刷新按钮触控高度不得低于 44px');

context.todayCN = () => '2026-09-25';
context.marketStateSnapshot = {
  businessDate: '2026-09-25',
  markets: {
    CN: { businessDate: '2026-09-25', status: 'closed', isTradingNow: false, isAfterMarketClose: false },
    HK: { businessDate: '2026-09-25', status: 'open', isTradingNow: true, isAfterMarketClose: false },
  },
};
context.refreshMarketStateSnapshot = async () => context.marketStateSnapshot;
context.renderAll = () => {
  const total = context.data.totalAsset != null ? Number(context.data.totalAsset) : context.calcSummary().total;
  element('stat-total').textContent = String(total);
  element('home-total-asset').textContent = String(total);
};
let navRecords = 0;
let loadDataCalls = 0;
let loadStarted;
const loadStartedPromise = new Promise(resolve => { loadStarted = resolve; });
let finishLoad;
const loadDone = new Promise(resolve => { finishLoad = resolve; });
// 统一估值：刷新后整批重读服务端结果；用 gate 模拟服务端返回时机，验证“重读前不改页面资产”。
// 与真实 loadData 一致：成功后会整体替换 data 对象（不是原地修改），
// 用于验证刷新链路不会因为“换了对象”被误判成过期响应。
context.loadData = async () => {
  loadDataCalls += 1;
  if (loadDataCalls === 1) { loadStarted(); await loadDone; }
  context.data = { ...context.data, totalAsset: 4002, valuation: { complete: true, missingCount: 0 } };
  return context.data;
};
context.recordNav = async () => { navRecords += 1; };
context.renderReturnsChart = () => {};
// 浏览器不再写收盘价：服务端收盘任务是唯一写入入口（2026-11-15 统一估值合同）

const requests = [];
const toastMessages = [];
let staleHkQuote = false;
context.showToast = message => toastMessages.push(String(message));
context.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (url.startsWith('/api/quotes?')) {
    return {
      ok: true,
      async json() {
        if (staleHkQuote) {
          return { '00700': { code: '00700', price: 21, name: 'A 股样例', change: 0.1, quote_time: '2026-09-24T15:00:00+08:00' } };
        }
        return {
          '600000': { code: '600000', price: 10, name: 'A 股样例', change: 0, quote_time: '2026-09-25T07:00:00+08:00' },
          '00700': { code: '00700', price: 22, name: '港股样例', change: 0.1, quote_time: '2026-09-25T15:00:00+08:00' },
        };
      },
    };
  }
  if (url === '/api/hkrate?realtime=1') return { ok: true, async json() { return { rate: 0.91 }; } };
  // 统一估值后浏览器不再提交持仓价；一旦出现该请求即视为契约破坏（落到底部抛错）。
  throw new Error(`unexpected request: ${url}`);
};

(async () => {
  try {
    assert.strictEqual(context.calcSummary().total, 3800, '普通账户初始总资产应为 3800 元');
    const refresh = context.refreshAllPrices();
    await loadStartedPromise;
    assert.ok(requests.some(request => request.url === '/api/hkrate?realtime=1'), 'A 股休市、港股开市时应请求实时港币汇率');
    // 重读服务端之前：页面必须保留上一批正式结果，不能用临时网络报价改写持仓或重算总资产。
    assert.strictEqual(context.data.positions.find(position => position.code === '00700').price, 20,
      '刷新期间不得把临时网络报价写入持仓价');
    assert.strictEqual(context.data.totalAsset, undefined, '刷新期间不得把前端自算结果写成正式总资产');
    assert.ok(!requests.some(request => request.url.startsWith('/api/positions/prices')),
      '浏览器不得再提交持仓价格（统一估值由服务端计算）');

    finishLoad();
    await refresh;
    assert.strictEqual(loadDataCalls, 1, '刷新完成后必须整批重读服务端统一估值');
    assert.strictEqual(Number(element('stat-total').textContent), 4002, '重读后总资产显示服务端统一估值金额');
    assert.strictEqual(Number(element('home-total-asset').textContent), 4002, '首页总资产与持仓页一致');
    assert.strictEqual(navRecords, 1, '服务端估值到齐后才记录当日净值');

    let autoRefreshCalls = 0;
    context.doRefresh = async () => { autoRefreshCalls++; return { ok: true }; };
    const autoResult = await context.doAutoRefresh();
    assert.strictEqual(autoRefreshCalls, 1, '持有港股且港股开市时自动刷新应进入既有刷新链路');
    assert.notStrictEqual(autoResult.reason, 'market_closed', 'A 股休市不能阻断港股自动刷新');

    context.marketStateSnapshot = {
      businessDate: '2026-09-25',
      markets: {
        CN: { businessDate: '2026-09-25', status: 'open', isTradingNow: true, isAfterMarketClose: false },
        HK: { businessDate: '2026-09-25', status: 'unknown', isTradingNow: false, isAfterMarketClose: false },
      },
    };
    let selectedMarkets = null;
    context.doRefresh = async markets => { selectedMarkets = markets; return { ok: true }; };
    await context.doAutoRefresh();
    assert.strictEqual(Array.from(selectedMarkets || []).join(','), 'CN', '港股日历未知不得阻断已确认开市的 A 股自动刷新');

    context.marketStateSnapshot = {
      businessDate: '2026-09-25',
      markets: {
        CN: { businessDate: '2026-09-25', status: 'open', isTradingNow: false, isAfterMarketClose: true },
        HK: { businessDate: '2026-09-25', status: 'unknown', isTradingNow: false, isAfterMarketClose: false },
      },
    };
    await context.doAutoRefresh();
    assert.strictEqual(Array.from(selectedMarkets || []).join(','), 'CN', '港股日历未知时仍应完成 A 股自己的收盘刷新');
    context.marketStateSnapshot.markets.HK = {
      businessDate: '2026-09-25', status: 'open', isTradingNow: false, isAfterMarketClose: true,
    };
    await context.doAutoRefresh();
    assert.strictEqual(Array.from(selectedMarkets || []).join(','), 'HK', 'A 股已收盘刷新后，港股日历恢复确认时仍应独立完成港股收盘刷新');

    const requestStart = requests.length;
    const loadStart = loadDataCalls;
    await context.refreshAllPrices(['CN']);
    const cnRequests = requests.slice(requestStart);
    const cnQuoteRequest = cnRequests.find(request => request.url.startsWith('/api/quotes?'));
    assert.ok(cnQuoteRequest && decodeURIComponent(cnQuoteRequest.url).includes('codes=600000'), '指定市场刷新必须只请求该市场证券');
    assert.ok(!cnRequests.some(request => request.url.startsWith('/api/positions/prices')), '指定市场刷新也不再提交持仓价格');
    assert.strictEqual(loadDataCalls, loadStart + 1, '指定市场刷新后仍整批重读服务端统一估值');

    context.marketStateSnapshot = {
      businessDate: '2026-09-25',
      markets: {
        CN: { businessDate: '2026-09-25', status: 'closed', isTradingNow: false, isAfterMarketClose: false },
        HK: { businessDate: '2026-09-25', status: 'open', isTradingNow: true, isAfterMarketClose: false },
      },
    };
    staleHkQuote = true;
    const toastStart = toastMessages.length;
    await context.refreshAllPrices(['HK']);
    const staleToast = toastMessages.slice(toastStart).join(' ');
    assert.strictEqual(context.data.positions.find(position => position.code === '00700').price, 20, '开市日收到前一日港股报价时不得写入持仓价');
    assert.ok(staleToast.includes('00700') && staleToast.includes('未取得当日行情'), '开市日的过期报价必须显示为失败代码');
    assert.ok(!staleToast.includes('全部成功'), '过期报价不得提示全部成功');

    context.marketStateSnapshot.markets.HK={businessDate:'2026-09-25',status:'closed',isTradingNow:false,isAfterMarketClose:false};
    const rendered=[];context.renderPositionsTable=id=>rendered.push(id);
    let summaryRenders=0;context.renderStats=()=>summaryRenders++;
    const beforeClosedRequests=requests.length;
    const closedResult=await context.doAutoRefresh();
    assert.strictEqual(closedResult.reason,'market_closed');
    assert.deepStrictEqual(rendered,['positions-table','topn-table'],'休市状态到齐后必须重绘明细和首页持仓');
    assert.strictEqual(summaryRenders,1,'休市状态到齐后必须重绘总资产卡片');
    assert.strictEqual(requests.length,beforeClosedRequests,'休市展示更新不得新增行情请求');
    // 收盘后自动刷新：doRefresh 成功会整体替换 data 对象，仍必须记上“今日已刷新”，
    // 否则定时器每次都会再刷新一次（合成反例：连续两次调用都真正刷新）。
    {
      context.marketStateSnapshot = {
        businessDate: '2026-09-25',
        markets: {
          CN: { businessDate: '2026-09-25', status: 'open', isTradingNow: false, isAfterMarketClose: true },
          HK: { businessDate: '2026-09-25', status: 'closed', isTradingNow: false, isAfterMarketClose: false },
        },
      };
      // 清掉前面用例可能留下的“今日已刷新”标记，确保本用例从零开始。
      ['CN', 'HK'].forEach(market => localValues.delete('_autoQuoteRefresh_普通账户_' + market));
      if (context.data && context.data._autoQuoteRefreshDates) context.data._autoQuoteRefreshDates = {};
      let realRefreshCalls = 0;
      // 模拟真实 doRefresh：成功后用服务端结果整体替换 data 对象。
      context.doRefresh = async () => {
        realRefreshCalls += 1;
        context.data = { ...context.data, totalAsset: 4002, valuation: { complete: true, missingCount: 0 } };
        return { ok: true };
      };
      const first = await context.doAutoRefresh();
      assert.strictEqual(first.ok, true, '收盘后第一次自动刷新应成功：' + JSON.stringify(first));
      assert.strictEqual(realRefreshCalls, 1, '收盘后应实际刷新一次');
      assert.strictEqual(context.data._autoQuoteRefreshDates && context.data._autoQuoteRefreshDates.CN, '2026-09-25',
        '重读替换 data 后仍必须记录今日已刷新');
      const second = await context.doAutoRefresh();
      assert.strictEqual(realRefreshCalls, 1, '当天已刷新过不得再次触发刷新');
      assert.strictEqual(second.reason, 'market_closed', '已完成后应安静返回，不重复采集');
    }
    console.log('holdings cross-market refresh regression tests passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
