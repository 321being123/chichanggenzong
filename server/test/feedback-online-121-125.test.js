// 线上反馈 #121–#125 定向回归（本地开发交接，不含浏览器/真机/生产验收）。
// #121 智能导入数量步进与滚轮保护；#122 智能导入页复用资金/税费入口；
// #123 持仓元数据 SQL 占位符与债券基金识别；#124 今日/本月/本年/区间盈亏；#125 总资产显隐。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const index = read('public/index.html');
const coreTrade = read('public/shared/core-trade.js');
const coreTables = read('public/shared/core-tables.js');
const coreReturns = read('public/shared/core-returns.js');

function section(html, startToken, endToken) {
  const start = html.indexOf(startToken);
  const end = html.indexOf(endToken, start);
  assert.ok(start >= 0 && end > start, '找不到区块：' + startToken);
  return html.slice(start, end);
}

(async () => {
  // ---------- #121 智能导入数量输入 ----------
  const qtyCell = coreTrade.slice(coreTrade.indexOf('id="s-qty-'), coreTrade.indexOf('id="s-qty-') + 800);
  assert.ok(/min="1"/.test(qtyCell), '数量输入必须声明最小值为 1');
  assert.ok(/step="1"/.test(qtyCell), '数量输入步进必须为 1，降低灵敏度');
  assert.ok(qtyCell.includes('stepSmartQty') && qtyCell.includes('qty-step-btn'), '数量必须有可点击的加减步进按钮');
  assert.ok(/function stepSmartQty\(/.test(coreTrade), '步进必须复用同一函数');
  assert.ok(/guardQuantityWheel/.test(coreTrade) && /e\.preventDefault\(\)/.test(coreTrade), '聚焦数量输入时滚轮必须被阻止');

  const stepStart = coreTrade.indexOf('function stepSmartQty(');
  const stepEnd = coreTrade.indexOf('// #121：聚焦数量输入框', stepStart);
  const stepCalls = [];
  const stepCtx = {
    document: { getElementById: (id) => (id === 's-qty-r1' ? stepInput : null) },
    revalidateSmartRow: (id) => stepCalls.push(id)
  };
  const stepInput = { value: '1', focus() {} };
  vm.createContext(stepCtx);
  vm.runInContext(coreTrade.slice(stepStart, stepEnd), stepCtx);
  stepCtx.stepSmartQty('r1', -1);
  assert.strictEqual(stepInput.value, '1', '数量最小值必须保持为 1');
  stepCtx.stepSmartQty('r1', 1);
  assert.strictEqual(stepInput.value, '2', '点击 + 必须只增加 1');
  assert.deepStrictEqual(stepCalls, ['r1', 'r1'], '每次点击都必须重校验当前行');

  let wheelHandler = null;
  const guardCtx = {
    document: {
      activeElement: null,
      addEventListener: (type, handler) => { if (type === 'wheel') wheelHandler = handler; }
    }
  };
  vm.createContext(guardCtx);
  const guardStart = coreTrade.indexOf('(function guardQuantityWheel()');
  const guardEnd = coreTrade.indexOf('})();', guardStart) + 5;
  vm.runInContext(coreTrade.slice(guardStart, guardEnd), guardCtx);
  let prevented = 0;
  const qtyInput = { tagName: 'INPUT', type: 'number', id: 's-qty-r1' };
  guardCtx.document.activeElement = qtyInput;
  wheelHandler({ target: qtyInput, preventDefault: () => { prevented += 1; } });
  assert.strictEqual(prevented, 1, '聚焦数量框滚轮必须阻止默认行为');
  guardCtx.document.activeElement = { tagName: 'BODY' };
  wheelHandler({ target: qtyInput, preventDefault: () => { prevented += 1; } });
  assert.strictEqual(prevented, 1, '未聚焦时不应拦截页面滚动');
  wheelHandler({ target: { tagName: 'INPUT', type: 'text', id: 'other' }, preventDefault: () => { prevented += 1; } });
  assert.strictEqual(prevented, 1, '非数量数字框不受影响');

  // ---------- #122 智能导入页复用资金/税费入口 ----------
  const smart = section(index, 'id="trade-smart-section"', '<!-- 版本记录页 -->');
  assert.ok(smart.includes('data-act="showCashFlowModal"'), '智能导入页必须提供资金转入转出入口');
  assert.ok(smart.includes('data-act="openFeeSettings"'), '智能导入页必须提供税费设置入口');
  assert.strictEqual((coreReturns.match(/function showCashFlowModal\s*\(/g) || []).length, 1, '资金流弹窗只能保留一份实现');
  assert.strictEqual((coreTrade.match(/function openFeeSettings\s*\(/g) || []).length, 1, '税费设置只能保留一份实现');

  // ---------- #123 持仓元数据 SQL 与债券基金识别 ----------
  const accountsRepository = require('../repositories/accountsRepository');
  let captured = null;
  await accountsRepository.updatePositionFields({
    username: 'u', accountName: 'a', posId: 'p',
    patch: { name: '样本', type: '债权', subtype: '债券基金', note: 'n' }
  }, {
    query: async (sql, args) => { captured = { sql, args }; return { rowCount: 1 }; }
  });
  assert.ok(captured, '元数据更新必须生成 SQL');
  assert.ok(/name=\$4/.test(captured.sql), '第一个编辑列必须绑定 $4 而不是数字常量');
  assert.ok(/note=\$7/.test(captured.sql), '第四个编辑列必须绑定 $7');
  const placeholders = captured.sql.match(/\$\d+/g) || [];
  assert.strictEqual(new Set(placeholders).size, captured.args.length, '占位符数量必须与参数数组长度一致');
  assert.ok(!/=\s*\d/.test(captured.sql.replace(/\$\d+/g, '')), 'SQL 中不得残留把列值写成数字常量的占位');

  const classifyCode = require('../../public/js/code-classify');
  const bondFund = classifyCode('511380', '可转债ETF博时');
  assert.strictEqual(bondFund.type, '债权', '可转债 ETF 必须识别为债权资产');
  assert.strictEqual(bondFund.subtype, '债券基金', '可转债 ETF 子类型必须为债券基金');
  assert.strictEqual(bondFund.market, 'sh');
  assert.strictEqual(classifyCode('511010', '国债ETF').type, '债权');
  assert.strictEqual(classifyCode('160719', '嘉实原油LOF').type, '股权', '非债券基金不得被误判');
  assert.strictEqual(classifyCode('600519', '贵州茅台').subtype, '沪市', '普通股票分类不得改变');
  const { historicalKindFor } = require('../jobs/replayNav');
  assert.strictEqual(historicalKindFor('511380', { name: '可转债ETF博时', type: '债权', subtype: '债券基金' }), 'fund',
    '债券基金仍必须走基金日线，不能因资产类别为债权而走债券日线');

  // ---------- #124/#125 持仓盈亏概览与总资产显隐 ----------
  const dom = new JSDOM(
    '<div id="stats-container"></div><div id="pnl-overview"></div>',
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const w = dom.window;
  const rows = [
    { date: '2025-12-31', totalAsset: 100000 },
    { date: '2026-01-31', totalAsset: 105000 },
    { date: '2026-02-28', totalAsset: 108000 },
    { date: '2026-06-30', totalAsset: 115000 },
    { date: '2026-10-31', totalAsset: 120000 },
    { date: '2026-11-27', totalAsset: 121000 }
  ];
  w.data = {
    positions: [], cash: 0, cashType: '现金',
    performanceHistory: rows,
    navHistory: rows,
    cashFlows: [{ date: '2026-03-01', amount: 1000, flow_type: 'transfer_in' }],
    navAttribution: {}
  };
  w.todayCN = () => '2026-11-27';
  w.fmt = (n) => '¥' + Math.abs(Number(n) || 0).toFixed(2);
  w.fmtPct = (n) => (Number(n || 0) * 100).toFixed(2) + '%';
  w.calcSummary = () => ({ total: 121000, equityVal: 0, debtVal: 121000, cash: 0, equityPct: 0, debtPct: 1, cashPct: 0 });
  w.escapeHtml = (s) => String(s == null ? '' : s);
  w.getPerformanceNavHistory = () => rows;
  w.NavMath = { isExternalTransfer: (cf) => Number(cf.amount) !== 0 };
  w.showToast = () => {};
  w.eval(coreTables);

  const todayPnl = w.computeTodayPnl();
  assert.strictEqual(todayPnl.amount, null, '没有完整今日归因时必须显示缺失，不得编造今日盈亏');
  w.data.navAttribution = { complete: true, currentDate: '2026-11-27', previousDate: '2026-10-31', previousTotalAsset: 120000, totalChange: 1000 };
  assert.strictEqual(w.computeTodayPnl().amount, 1000, '今日盈亏必须复用服务端完整归因');
  // 渲染路径不绑定涨跌浮框，避免测试依赖归因浮层的全部展示分支。
  w.data.navAttribution = {};

  const month = w.computePnlBetween('2026-11-01', '2026-11-27');
  assert.strictEqual(month.amount, 1000, '本月盈亏必须按净值记录与外部资金流水计算');
  const year = w.computePnlBetween('2026-01-01', '2026-11-27');
  assert.strictEqual(year.amount, 20000, '本年盈亏必须扣除区间净入金');
  const custom = w.computePnlBetween('2026-01-01', '2026-06-30');
  assert.strictEqual(custom.amount, 14000, '可选区间盈亏必须支持任意起止日期');
  assert.strictEqual(custom.pct, 14000 / 101000, '区间收益率必须按期初资产加净入金计算');

  w.renderStats();
  assert.ok(w.document.getElementById('pnl-month').textContent.includes('+¥1000.00'), '本月盈亏必须渲染金额');
  assert.ok(w.document.getElementById('pnl-year').textContent.includes('+¥20000.00'), '本年盈亏必须渲染金额');
  assert.ok(w.document.getElementById('pnl-custom').textContent.includes('¥1000.00'), '默认可选区间按本月展示');
  const toggle = w.document.getElementById('stats-privacy-toggle');
  assert.ok(toggle, '总资产卡片必须提供显隐按钮');
  assert.strictEqual(toggle.getAttribute('aria-pressed'), 'false');
  w.localStorage.setItem('portfolio.statsHidden', '1');
  w.renderStats();
  assert.strictEqual(w.document.getElementById('stat-total').textContent, '****', '隐私模式必须遮罩总资产');
  assert.strictEqual(w.document.getElementById('stat-equity').textContent, '****', '隐私模式必须遮罩股权资产');
  assert.strictEqual(w.document.getElementById('stat-debt').textContent, '****', '隐私模式必须遮罩债权资产');
  assert.strictEqual(w.document.getElementById('stat-cash').textContent, '****', '隐私模式必须遮罩现金余额');
  assert.strictEqual(w.document.getElementById('pnl-month').textContent, '****', '隐私模式必须遮罩盈亏金额');
  assert.strictEqual(w.document.getElementById('stats-privacy-toggle').getAttribute('aria-pressed'), 'true');
  w.toggleStatsPrivacy();
  assert.strictEqual(w.document.getElementById('stat-total').textContent, '¥121000.00', '再次点击必须恢复金额');
  assert.strictEqual(w.localStorage.getItem('portfolio.statsHidden'), '0', '显隐偏好必须持久化到 localStorage');

  w.close();
  console.log('线上反馈 #121–#125 定向回归通过：数量步进/滚轮、智能导入入口、SQL 占位符、债券基金识别、盈亏概览、总资产显隐');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
