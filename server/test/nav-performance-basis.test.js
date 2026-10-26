const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildNavPerformance } = require('../services/navAttribution');
const NavMath = require('../../public/shared/nav-math');
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-16T09:30:00+08:00'])); }
  static now() { return RealDate.parse('2026-10-16T09:30:00+08:00'); }
};
(async () => {
 try {
  const data = { positions: [{ code: '600000', quantity: 10, subtype: '沪市' }], cashFlows: [],
    totalAsset: 2026718.9634,
    navHistory: [
      { date: '2026-10-14', nav: 2.96, totalAsset: 2000000, snapshotSource: 'imported' },
      { date: '2026-10-15', nav: 2.978794, totalAsset: 1998788.49, snapshotSource: 'legacy' },
      { date: '2026-10-16', nav: 3.020419, totalAsset: 2026718.96, snapshotSource: 'legacy' }
    ], navAttribution: { complete: true, currentDate: '2026-10-16', previousDate: '2026-10-15',
      previousTotalAsset: 2018008.345147, totalChange: 8710.618253 }
  };
  const totals = { '2026-10-14': 2000000, '2026-10-15': 2018008.345147, '2026-10-16': 2026718.96 };
  const before = JSON.stringify(data);
  const rows = await buildNavPerformance(data, totals);
  assert.strictEqual(JSON.stringify(data), before, '只读投影不得改变保存事实');
  assert.strictEqual(rows[0].nav, 2.96, '导入净值锚点保持原值');
  assert.strictEqual((rows[2].dayChange * 100).toFixed(2), '0.43');
  assert(Math.abs(rows[2].nav / rows[1].nav - 1 - rows[2].dayChange) < 1e-10, '无出入金时，净值日比率必须与首页同源');
  assert.notStrictEqual(rows[2].nav, data.navHistory[2].nav, '不能继续沿用已污染的保存净值');
  assert.strictEqual(rows[2].basis.previousTotalAsset, data.navAttribution.previousTotalAsset);
  const context = { data: { ...data, performanceHistory: rows, navReturnTotals: totals },
    NavMath, investedAt: NavMath.investedAt, todayCN: () => '2026-10-16' };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../public/shared/core-earnings.js'), 'utf8'), context);
  const display = context.buildRealReturnsSeries();
  assert.strictEqual(display.at(-1).nav, rows[2].nav);
  assert(Math.abs(display.at(-1).yearReturn - (rows[2].nav / rows[0].nav - 1)) < 1e-12, '年度收益须使用同一投影净值');
  const gapData = { ...data, navHistory: [data.navHistory[0], data.navHistory[2]], navAttribution: { complete: false, reason: 'missing_intermediate_snapshot' } };
  const gap = await buildNavPerformance(gapData, totals);
  assert.strictEqual(gap[1].nav, null, '缺中间交易日不得从旧净值续链');
  assert.strictEqual(gap[1].dayChange, null);
  assert.strictEqual(gap[1].basisStatus, 'missing_intermediate_snapshot');
  const stale = await buildNavPerformance({ ...data, navHistory: [data.navHistory[0]], navAttribution: { complete: false, reason: 'missing_intermediate_snapshot' } },totals);
  assert.strictEqual(stale.at(-1).date,'2026-10-16');
  assert.strictEqual(stale.at(-1).isLive,true);
  assert.strictEqual(stale.at(-1).totalAsset,data.totalAsset,'没有当天保存快照时当前资产仍必须与首页一致');
  assert.strictEqual(stale.at(-1).nav,null,'实时资产点不能伪造缺失NAV');
  const missing = await buildNavPerformance(data, { ...totals, '2026-10-15': null });
  // 首页有完整当日基准时允许复用该确切基准；不采用原始1998788.49补位。
  assert.strictEqual(missing[1].totalAsset, data.navAttribution.previousTotalAsset);
  const noLive = await buildNavPerformance({ ...data, navAttribution: null }, { ...totals, '2026-10-15': null });
  assert.strictEqual(noLive[1].nav, null);
  assert.strictEqual(noLive[2].nav, null, '缺基准后不得隐式恢复旧NAV');
  const weeklyData = { positions: [], cashFlows: [], navHistory: [
    { date: '2026-08-02', nav: 2, totalAsset: 200, snapshotSource: 'imported' },
    { date: '2026-08-03', nav: 9, totalAsset: 900, snapshotSource: 'legacy' },
    { date: '2026-08-04', nav: 2, totalAsset: 200, snapshotSource: 'manual_carry_forward' },
    { date: '2026-08-09', nav: 2.1, totalAsset: 210, snapshotSource: 'imported' },
    { date: '2026-08-15', nav: 9, totalAsset: 900, snapshotSource: 'legacy' },
    { date: '2026-08-16', nav: 2.2, totalAsset: 220, snapshotSource: 'imported' },
    { date: '2026-08-17', nav: 9, totalAsset: 900, snapshotSource: 'legacy' },
    { date: '2026-08-18', nav: 9, totalAsset: 900, snapshotSource: 'legacy' }
  ] };
  const weeklyBefore = JSON.stringify(weeklyData);
  const weeklyTotals = { '2026-08-02': 200, '2026-08-09': 210, '2026-08-16': 220,
    '2026-08-17': 230, '2026-08-18': null };
  const weekly = await buildNavPerformance(weeklyData, weeklyTotals);
  assert.deepStrictEqual(weekly.map(n => n.date), ['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-17', '2026-08-18'],
    '导入之前只按真实历史频率展示，导入之后保留日记录及真实缺口');
  assert.deepStrictEqual(weekly.slice(0, 3).map(n => n.totalAsset), [200, 210, 220]);
  assert.deepStrictEqual(weekly.slice(0, 3).map(n => n.nav), [2, 2.1, 2.2]);
  assert(Math.abs(weekly[3].nav - 2.3) < 1e-12, '导入边界后仍按统一资产基准续算');
  assert.strictEqual(weekly[4].nav, null, '导入之后的缺口不能被过滤掩盖');
  assert.strictEqual(JSON.stringify(weeklyData), weeklyBefore, '展示筛选不得删除原记录');
  const weeklyContext = { ...context, data: { ...weeklyData, performanceHistory: weekly, navReturnTotals: weeklyTotals } };
  vm.createContext(weeklyContext);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../public/shared/core-earnings.js'), 'utf8'), weeklyContext);
  assert.deepStrictEqual(Array.from(weeklyContext.buildRealReturnsSeries().slice(0, 3), r => r.totalMarketValue), [200, 210, 220],
    '资产图与收益表使用相同的周记录');
  const withFlow = await buildNavPerformance({ ...data, cashFlows: [{ date: '2026-10-16', amount: 1000 }] }, totals);
  assert(Math.abs(withFlow[2].nav - withFlow[1].nav * data.totalAsset / (2018008.345147 + 1000)) < 1e-12);
  const afterSnapshot = await buildNavPerformance({ ...data,
    navHistory: data.navHistory.map(n => ({ ...n, snapshot_at: n.date + (n.date === '2026-10-16' ? 'T08:30:00+08:00' : 'T15:00:00+08:00') })),
    cashFlows: [{ date: '2026-10-16', amount: 1000, created_at: '2026-10-16T09:00:00+08:00' }]
  }, totals);
  assert.strictEqual(afterSnapshot[2].basis.externalTransfer,1000,'实时资产包含旧快照后新入金时，净值也必须剔除该笔入金');
  const { pool } = require('../db/connection');
  const marketState = require('../services/marketState');
  const originalQuery = pool.query;
  try {
    pool.query = async sql => {
      assert(sql.includes('market.trade_calendar'),'跨市场门禁只读本地日历');
      return { rows: [{ trade_date: '2026-09-25', is_open: true, source_code: 'hkex_official_schedule',
        raw_payload: { official_schedule: { is_open: true, session_type: 'full_day', close_time: '16:10' } } }] };
    };
    marketState.invalidateMarketStateCache();
    const hk = { positions: [{ code: '00700', subtype: '港股', quantity: 10 }], cashFlows: [],
      positionSnapshots: [{ snapshotDate: '2026-09-24', code: '00700', quantity: 10, quoteCurrency: 'HKD', source: 'manual_reconciliation' }],
      navHistory: [{ date: '2026-09-24', nav: 1, totalAsset: 100, snapshotSource: 'imported' },
        { date: '2026-09-28', nav: 1.1, totalAsset: 110, snapshotSource: 'legacy' }] };
    const hkRows = await buildNavPerformance(hk, { '2026-09-24': 100, '2026-09-28': 110 });
    assert.strictEqual(hkRows[1].nav,null,'A股休市但港股开市的缺快照同样阻止续链');
    pool.query = async () => ({ rows: [] });marketState.invalidateMarketStateCache();
    assert.strictEqual((await buildNavPerformance(hk, { '2026-09-24': 100, '2026-09-28': 110 }))[1].nav,null,'港股日历未知不得猜测已连续');
  } finally { pool.query=originalQuery;marketState.invalidateMarketStateCache(); }
  const auto = fs.readFileSync(path.resolve(__dirname, '../../public/shared/core-returns.js'), 'utf8');
  assert(fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8').includes('shared/core-returns.js?v=__APP_VERSION__'), '净值脚本必须随应用版本失效旧缓存');
  const body = auto.slice(auto.indexOf('async function recordNav()'), auto.indexOf('function renderReturnsStats()'));
  assert(body.includes("calculationMode: 'system'") && !body.includes('chainNav('), '浏览器自动记录只提交意图，不再自算NAV');
  context.data.positions=[{code:'600000',quantity:10,price:12}];context.data.cash=1;
  const localPositions=context.data.positions;
  context.currentAccount='a';context.dataVersion=0;context.syncDataVersions=()=>{};context.api=url=>url;
  context.fetch=async()=>({ok:true,json:async()=>({data:{navHistory:data.navHistory,performanceHistory:rows,navReturnTotals:totals,
    cash:110,totalAsset:230,authoritativeTotalAsset:230,authoritativeCash:110,positions:[{code:'ignored-server-copy'}]}})});
  vm.runInContext(auto,context);await context.recordNav();
  assert.strictEqual(context.data.cash,110,'自动保存后现金必须同步服务端确认值');
  assert.strictEqual(context.data.authoritativeTotalAsset,230,'自动保存后首页资产标量必须与投影同源');
  assert.strictEqual(context.data.positions,localPositions,'不得用响应副本覆盖刚刷新的持仓行情');
  for (const file of ['navSnapshot.js', 'replayNav.js']) {
    const source = fs.readFileSync(path.resolve(__dirname, '../jobs', file), 'utf8');
    assert(source.includes("calculationMode: 'system'") && source.includes('NAV_BASIS_INCOMPLETE'), '后台自动记录同一写入口且基准失败不报成功');
  }
  console.log('nav performance basis: canonical chain, display, cash flow and gap invariants passed');
 } finally { global.Date = RealDate; }
})().catch(error => { console.error(error); process.exitCode = 1; });
