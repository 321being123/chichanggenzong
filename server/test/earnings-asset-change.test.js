const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const NavMath = require('../../public/shared/nav-math');
const { computeNavHistoryTotals } = require('../services/navAttribution');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
assert(read('public/index.html').includes('shared/core-earnings.js?v=__APP_VERSION__'), '收益脚本必须跟随发版失效旧缓存');

(async () => {
  const fixture = {
    cashBase: 100, cashFlows: [], trades: [],
    positions: [{ code: '600000', quantity: 10, price: 12, subtype: '沪市' }],
    positionSnapshots: [{ snapshotDate: '2026-10-09', code: '600000', quantity: 10, source: 'manual_reconciliation' }],
    navHistory: [
      { date: '2026-10-09', totalAsset: 190, nav: 1, snapshotSource: 'imported' },
      { date: '2026-10-12', totalAsset: 201, nav: 1.1, snapshotSource: 'legacy' },
      { date: '2026-10-13', totalAsset: 220, nav: 1.2, snapshotSource: 'legacy' },
      { date: '2026-10-14', totalAsset: 220, nav: 1.2, snapshotSource: 'manual_carry_forward' }
    ]
  };
  let queries = 0;
  const totals = await computeNavHistoryTotals('u', 'a', fixture, async sql => {
    queries++;
    if (sql.includes('FROM market.fx_rates')) return { rows: [] };
    return { rows: [
      { date: '2026-10-12', code: '600000', price: 11 },
      { date: '2026-10-13', code: '600000', price: 12 }
    ] };
  });
  assert.strictEqual(queries, 2, '所有历史日期共用批量本地查询');
  assert.strictEqual(totals['2026-10-09'], 190, '券商导入不得重建覆盖');
  assert.strictEqual(totals['2026-10-12'], 210, '盘中快照201须按收盘价11及现金100重建为210');
  assert.strictEqual(totals['2026-10-13'], 220);
  assert.strictEqual(totals['2026-10-14'], null, '人工沿用值不能冒充已核验资产');
  const missing = await computeNavHistoryTotals('u', 'a', fixture, async () => ({ rows: [] }));
  assert.strictEqual(missing['2026-10-12'], null, '缺价格不能用当前报价或旧快照补值');
  const noAnchor = await computeNavHistoryTotals('u','a',{ ...fixture,positionSnapshots:[] },async sql=>({ rows: sql.includes('FROM daily_prices') ? [{date:'2026-10-12',code:'600000',price:11}] : [] }));
  assert.strictEqual(noAnchor['2026-10-12'],null,'历史缺持仓锚点不得用当前持仓冒充可重建事实');
  const hkData = { cashBase: 100, cashFlows: [],
    positionSnapshots: [{ snapshotDate: '2026-10-09', code: '00700', quantity: 10, source: 'manual_reconciliation' }],
    trades: [{ code: '00700', direction: 'open', quantity: 10, date: '2026-10-01' }],
    positions: [{ code: '00700', quantity: 10, subtype: '港股' }],
    navHistory: [{ date: '2026-10-12', totalAsset: 200, snapshotSource: 'legacy', hkRate: 0.8 }]
  };
  const hkQuery = async sql => ({ rows: sql.includes('FROM daily_prices')
    ? [{ date: '2026-10-12', code: '000700', price: 10 }] : [] });
  const hkTotals = await computeNavHistoryTotals('u', 'a', hkData, hkQuery);
  assert.strictEqual(hkTotals['2026-10-12'], 180, '港股历史数量缺市场时复用当前市场身份，兼容既有六位别名并计汇率');
  hkData.navHistory[0].hkRate = null;
  assert.strictEqual((await computeNavHistoryTotals('u', 'a', hkData, hkQuery))['2026-10-12'], null, '历史缺汇率不得采用当前汇率');

  let assertions = 0;
  for (const width of [320, 360, 390, 430, 760, 768, 900, 1024, 1440]) {
    const dom = new JSDOM('<div id="earnings-table"></div><div id="stats-container"></div>', { runScripts: 'outside-only' });
    const w = dom.window;
    w.innerWidth = width;
    w.NavMath = NavMath;
    w.investedAt = NavMath.investedAt;
    w.todayCN = () => '2026-10-16';
    w.fmt = v => String(v);
    w.fmtPct = v => String(v);
    w.escapeHtml = v => String(v);
    w.calcSummary = () => ({ total: 2026718.96, cash: 830656.78 });
    w.bindChangeTip = () => {};
    w.fetch = () => { throw new Error('渲染不允许取数'); };
    w.data = {
      cashBase: 1608300, cashFlows: [], positions: [],
      navHistory: [
        { date: '2026-10-09', nav: 2.997, totalAsset: 2011000, invested: 1608300, snapshotSource: 'imported' },
        { date: '2026-10-15', nav: 2.9788, totalAsset: 1998800, invested: 1608300 },
        { date: '2026-10-16', nav: 3.0204, totalAsset: 2026718.96, invested: 1608300 }
      ],
      navReturnTotals: { '2026-10-15': 2018008.34 },
      navAttribution: { complete: true, currentDate: '2026-10-16', previousDate: '2026-10-15',
        totalChange: 8710.62, previousTotalAsset: 2018008.34 }
    };
    w.eval(read('public/shared/core-earnings.js'));
    w.eval(read('public/shared/core-account.js'));
    w.eval(read('public/shared/core-tables.js'));
    // renderStats uses this binding and only formats the same server attribution.
    w.bindChangeTip = () => {};
    const before = JSON.stringify(w.data);
    const rows = w.buildRealReturnsSeries();
    const today = rows[rows.length - 1];
    assert.strictEqual((today.dayChange * 100).toFixed(2), '0.43');
    assert.strictEqual(today.dayChange, 8710.62 / 2018008.34);
    assert(Math.abs(today.weekChange - (2026718.96 / 2011000 - 1)) < 1e-12);
    w.renderStats();
    w.renderEarningsTable(rows);
    assert(w.document.getElementById('stat-change').textContent.includes('+0.43%'));
    assert(w.document.getElementById('earnings-table').textContent.includes('+0.43%'));
    assert(w.document.getElementById('earnings-table').textContent.includes('总资产(万元)'));
    assert.strictEqual(JSON.stringify(w.data), before, '渲染不得改写净值或历史事实');
    w.document.body.insertAdjacentHTML('beforeend','<div id="modal-nav-edit"><span id="nav-edit-title"></span><input id="nav-edit-date"><input id="nav-edit-nav"><input id="nav-edit-total"><input id="nav-edit-invested"></div>');
    w.data.performanceHistory = [{ date:'2026-10-16',nav:3.1,totalAsset:2026718.96 }];
    w.openNavEdit('2026-10-16');
    assert.strictEqual(w.document.getElementById('nav-edit-nav').value,'3.1','编辑预填必须与可见投影一致，不能重新露出旧NAV');
    w.data.performanceHistory[0].nav=null;w.openNavEdit('2026-10-16');
    assert.strictEqual(w.document.getElementById('nav-edit-nav').value,'','未知投影不能用原始旧NAV静默补位');
    delete w.data.performanceHistory;
    for (const change of [0, -8710.62]) {
      w.data.navAttribution.totalChange = change;
      assert.strictEqual(w.buildRealReturnsSeries().at(-1).dayChange, change / 2018008.34);
    }
    for (const bad of [{ complete: false }, { currentDate: '2026-10-15' }, { totalChange: null }, { previousTotalAsset: 0 }]) {
      const saved = w.data.navAttribution;
      w.data.navAttribution = { ...saved, ...bad };
      const row = w.buildRealReturnsSeries().at(-1);
      assert.strictEqual(row.dayChange, null);
      assert.strictEqual(row.weekChange, null);
      w.data.navAttribution = saved;
    }
    assertions++;
    dom.window.close();
  }
  // 历史周末保留真实现金/汇率变化；周涨跌不再混用净值。
  const context = { NavMath, investedAt: NavMath.investedAt, todayCN: () => '2026-10-19', data: {
    cashBase: 0, cashFlows: [], navHistory: [
      { date: '2026-10-16', nav: 1, totalAsset: 100, snapshotSource: 'imported' },
      { date: '2026-10-17', nav: 1, totalAsset: 101, snapshotSource: 'imported' }
    ]
  }};
  vm.createContext(context);
  vm.runInContext(read('public/shared/core-earnings.js'), context);
  assert.strictEqual(context.buildRealReturnsSeries()[1].dayChange, 0.01);
  console.log(`earnings asset change: backend baselines and ${assertions} viewport DOM scenarios passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
