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
vm.runInContext(fs.readFileSync(path.join(root, 'public/shared/core-quote.js'), 'utf8'), context);

assert.ok(indexHtml.includes('<button class="btn-refresh" onclick="doRefresh()" title="刷新持仓实时价格并重新计算总资产">刷新行情</button>'),
  '现有账户工具栏应显示复用 doRefresh 的“刷新行情”按钮');
assert.ok(indexHtml.includes('shared/core-quote.js?v=0.8.1.87') && indexHtml.includes('shared/core-tables.js?v=0.8.1.89'),
  '修改后的共享统计脚本必须使用当前版本缓存键，未修改的共享行情脚本保留原缓存键');
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
  const total = context.calcSummary().total;
  element('stat-total').textContent = String(total);
  element('home-total-asset').textContent = String(total);
};
context.recordNav = async () => {};
context.renderReturnsChart = () => {};
context.saveDailyPricesToDB = async () => {};

let startedPatch;
const patchStarted = new Promise(resolve => { startedPatch = resolve; });
let finishPatch;
const patchGate = new Promise(resolve => { finishPatch = resolve; });
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
  if (url.startsWith('/api/positions/prices?')) {
    startedPatch();
    await patchGate;
    return { ok: true, async json() { return { version: 2 }; } };
  }
  throw new Error(`unexpected request: ${url}`);
};

(async () => {
  try {
    assert.strictEqual(context.calcSummary().total, 3800, '普通账户初始总资产应为 3800 元');
    const refresh = context.refreshAllPrices();
    await patchStarted;
    assert.ok(requests.some(request => request.url === '/api/hkrate?realtime=1'), 'A 股休市、港股开市时应请求实时港币汇率');
    assert.strictEqual(context.calcSummary().total, 4002, '港股价格和汇率更新后本次计算应为 4002 元');
    assert.strictEqual(Number(element('stat-total').textContent), 4002, '持仓页总资产应在 PATCH 完成前显示 4002 元');
    assert.strictEqual(Number(element('home-total-asset').textContent), 4002, '首页总资产应在 PATCH 完成前显示 4002 元');

    finishPatch();
    await refresh;

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
    await context.refreshAllPrices(['CN']);
    const cnRequests = requests.slice(requestStart);
    const cnQuoteRequest = cnRequests.find(request => request.url.startsWith('/api/quotes?'));
    assert.ok(cnQuoteRequest && decodeURIComponent(cnQuoteRequest.url).includes('codes=600000'), '指定市场刷新必须只请求该市场证券');
    const cnPatch = cnRequests.find(request => request.url.startsWith('/api/positions/prices?'));
    assert.deepStrictEqual(JSON.parse(cnPatch.options.body).prices.map(price => price.code), ['600000'], '指定市场刷新必须只保存该市场证券价格');

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
    assert.strictEqual(context.data.positions.find(position => position.code === '00700').price, 22, '开市日收到前一日港股报价时不得覆盖已有价格');
    assert.ok(staleToast.includes('00700') && staleToast.includes('未取得当日行情'), '开市日的过期报价必须显示为失败代码');
    assert.ok(!staleToast.includes('全部成功'), '过期报价不得提示全部成功');

    console.log('holdings cross-market refresh regression tests passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
