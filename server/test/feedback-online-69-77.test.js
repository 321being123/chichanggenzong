// 线上反馈 #69-#77 回归与行为反例测试（2026-11-24）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildAnalysis } = require('../domain/stockValuation');
const { buildHkAnalysis } = require('../services/hkSecurityAnalysis');
const { runHkSingleStockRefresh } = require('../services/hkSingleStockRefresh');
const { resolveEffectivePrices, priceKey } = require('../services/effectivePrice');

const ROOT = path.resolve(__dirname, '../..');
const read = (...segs) => fs.readFileSync(path.join(ROOT, ...segs), 'utf8');

async function main() {
  console.log('=== 线上反馈 #69-#77 回归与行为反例测试 ===');

  // #69 选股中心间距与空状态不占高
  {
    const ssCss = read('public', 'css', 'stock-selection.css');
    assert.ok(ssCss.includes('.ss-scheme-bar { display: flex; align-items: center; margin-bottom: 18px; }'), '方案切换栏下边距应与其他区块一致(18px)');
    assert.ok(ssCss.includes('.ss-status:empty { display: none; }'), '空状态提示栏不应占位');
    console.log('  [PASS] #69 选股中心间距与空状态不占高');
  }

  // #70 十年盈利图颜色规范（含脱离图表容器移入 body 的 tooltip）
  {
    const saCss = read('public', 'css', 'stock-analysis.css');
    const saChart = read('public', 'js', 'stock-analysis-chart.js');
    assert.ok(saCss.includes('--profit-color:rgb(108, 178, 108)'), '利润绿色应为 rgb(108, 178, 108)');
    assert.ok(saCss.includes('--dividend-color:rgb(251, 105, 103)'), '分红红色应为 rgb(251, 105, 103)');
    assert.ok(saCss.includes('.stock-analysis-chart-tooltip .profit-swatch{background:rgb(108, 178, 108)}'), 'tooltip 利润色块不得依赖容器 CSS 变量继承');
    assert.ok(saCss.includes('.stock-analysis-chart-tooltip .dividend-swatch{background:rgb(251, 105, 103)}'), 'tooltip 分红色块不得依赖容器 CSS 变量继承');
    assert.ok(saChart.includes('dividend-swatch'), '图例与 tooltip 应使用 dividend-swatch');
    console.log('  [PASS] #70 十年盈利图及 tooltip 色块颜色规范');
  }

  // #71 港股刷新反例：上游采集全部失败时不得按旧库覆盖把目标日标为 succeeded 或推进游标
  {
    const marked = [];
    const res = await runHkSingleStockRefresh({
      tsCode: '00363.HK',
      targetDate: '2026-11-24',
      deps: {
        cursors: {
          getDatasetCursors: async () => new Map(),
          markDatasetSuccess: async (scope, domain, payload) => { marked.push({ scope, domain, payload }); },
        },
        readHkCoverage: async () => ({
          master: true, bars: 100, barsDate: '2026-11-10',
          valuations: 100, valuationDate: '2026-11-10',
          adjustments: 0, reports: 10, dividends: 5, snapshots: 1,
        }),
        inputs: {
          collectHkMarketData: async () => { throw new Error('upstream market error'); },
          collectOne: async () => { throw new Error('upstream facts error'); },
        },
        hkSecurityAnalysis: {
          refreshHkAnalysis: async () => ({ display: { analysis_version: 'v-old' } }),
        },
      },
    });
    assert.strictEqual(res.ok, false, '上游采集失败时 ok 应为 false');
    assert.strictEqual(res.status, 'failed', '上游采集失败时 status 应为 failed');
    assert.strictEqual(res.stageComplete, false, '上游采集失败时 stageComplete 应为 false');
    assert.ok(!marked.some(m => ['bars', 'valuation', 'reports', 'dividends'].includes(m.domain)), '采集失败域不得推进目标日成功游标');

    // 部分成功反例：只写了 bars（valuations=0）且只取到 dividends（financials=false），估值停在 11-10
    const partialMarked = [];
    const partialRes = await runHkSingleStockRefresh({
      tsCode: '00363.HK',
      targetDate: '2026-11-24',
      deps: {
        cursors: {
          getDatasetCursors: async () => new Map(),
          markDatasetSuccess: async (scope, domain, payload) => { partialMarked.push({ scope, domain, payload }); },
        },
        readHkCoverage: async () => ({
          master: true, bars: 120, barsDate: '2026-11-24',
          valuations: 100, valuationDate: '2026-11-10',
          adjustments: 0, reports: 10, dividends: 5, snapshots: 1,
        }),
        inputs: {
          collectHkMarketData: async () => ({ ok: true, code: '00363.HK', bars: 10, valuations: 0, partial: false }),
          collectOne: async () => ({ ok: true, code: '00363.HK', financials: false, dividends: true }),
        },
        hkSecurityAnalysis: {
          refreshHkAnalysis: async () => ({ display: { analysis_version: 'v-old' } }),
        },
      },
    });
    assert.notStrictEqual(partialRes.status, 'succeeded', '部分成功时不得返回 succeeded');
    assert.strictEqual(partialRes.stageComplete, false, '部分成功时 stageComplete 应为 false');
    assert.ok(!partialMarked.some(m => m.domain === 'valuation' || m.domain === 'reports'), '未更新成功的 valuation 与 reports 不得推进游标');

    // 旧日期数据反例：上游返回 ok 且写回行数 > 0，但库内最新估值日仍停在 11-10
    const staleMarked = [];
    const staleRes = await runHkSingleStockRefresh({
      tsCode: '00363.HK',
      targetDate: '2026-11-24',
      deps: {
        cursors: {
          getDatasetCursors: async () => new Map(),
          markDatasetSuccess: async (scope, domain, payload) => { staleMarked.push({ scope, domain, payload }); },
        },
        readHkCoverage: async () => ({
          master: true, bars: 120, barsDate: '2026-11-24',
          valuations: 100, valuationDate: '2026-11-10',
          adjustments: 0, reports: 10, dividends: 5, snapshots: 1,
        }),
        inputs: {
          collectHkMarketData: async () => ({ ok: true, code: '00363.HK', bars: 10, valuations: 5, partial: false }),
          collectOne: async () => ({ ok: true, code: '00363.HK', financials: true, dividends: true }),
        },
        hkSecurityAnalysis: {
          refreshHkAnalysis: async () => ({ display: { analysis_version: 'v-old' } }),
        },
      },
    });
    assert.notStrictEqual(staleRes.status, 'succeeded', '库内估值日仍为旧日期时不得返回 succeeded');
    assert.strictEqual(staleRes.stageComplete, false, '库内估值日仍为旧日期时 stageComplete 应为 false');
    assert.ok(!staleMarked.some(m => m.domain === 'valuation'), '估值日期滞后时不得推进 valuation 游标');

    // 周一收盘后只有周五行情（3天内）+ 已有周一成功游标：必须按交易日历复核并拒绝返回 succeeded
    const monMarked = [];
    const monRes = await runHkSingleStockRefresh({
      tsCode: '00363.HK',
      targetDate: '2026-11-23',
      time: '16:30',
      deps: {
        getMarketState: async ({ businessDate }) => businessDate === '2026-11-23'
          ? { status: 'open', isAfterMarketClose: true }
          : { status: 'open', isAfterMarketClose: true },
        cursors: {
          getDatasetCursors: async () => new Map([
            ['bars', { last_success_date: '2026-11-23', last_error: null }],
            ['valuation', { last_success_date: '2026-11-23', last_error: null }],
            ['reports', { last_success_date: '2026-11-23', last_error: null }],
            ['dividends', { last_success_date: '2026-11-23', last_error: null }],
          ]),
          markDatasetSuccess: async (scope, domain, payload) => { monMarked.push({ scope, domain, payload }); },
        },
        readHkCoverage: async () => ({
          master: true, bars: 120, barsDate: '2026-11-20',
          valuations: 100, valuationDate: '2026-11-20',
          adjustments: 0, reports: 10, dividends: 5, snapshots: 1,
        }),
        inputs: {
          collectHkMarketData: async () => ({ ok: true, code: '00363.HK', bars: 10, valuations: 5, partial: false }),
          collectOne: async () => ({ ok: true, code: '00363.HK', financials: true, dividends: true }),
        },
        hkSecurityAnalysis: {
          refreshHkAnalysis: async () => ({ display: { analysis_version: 'v-old' } }),
        },
      },
    });
    assert.ok(monRes.attempts.some(a => a.domain === 'hk_market'), '已有周一游标但库内只有周五行情时不得跳过行情采集');
    assert.notStrictEqual(monRes.status, 'succeeded', '周一收盘后只有周五行情不得返回 succeeded');
    assert.strictEqual(monRes.stageComplete, false, '周一收盘后只有周五行情时 stageComplete 应为 false');
    assert.ok(!monMarked.some(m => m.domain === 'bars' || m.domain === 'valuation'), '只有周五行情时不得推进周一行情游标');
    console.log('  [PASS] #71 港股刷新按交易日历与收盘状态核对应有行情日并复核已有游标');
  }

  // #71 / #72 港股估值：非自然年一季报(0630)正确×4、商誉缺失不按0算、不混算分红率、ROE/ROA百分数
  {
    const q1NonCalendar = buildHkAnalysis({
      meta: { ts_code: '00999.HK', name: '非自然年测试', currency: 'HKD' },
      valuations: [{ trade_date: '2026-11-23', close: 10, pe_ttm: 6, pb: 1, total_mv: 1000000, dv_ttm: 3 }],
      reportFacts: [
        { period_end: '2026-06-30', period_type: 'q1', statement_scope: 'consolidated', currency: 'HKD',
          report_ids: [{ kind: 'income', report_id: 10 }], profit: 1e9, revenue: null, eps: null, equity: null, assets: null, liabilities: null, currency_unverified: false },
        { period_end: '2026-03-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD',
          report_ids: [{ kind: 'income', report_id: 1 }, { kind: 'balance', report_id: 2 }],
          profit: 2e9, revenue: null, eps: null, equity: 5e10, assets: 1e11, liabilities: 4e10, goodwill: null, currency_unverified: false },
      ],
      dividends: [],
      events: [],
    }, { tsCode: '00999.HK', isoToday: '2026-11-24', today: '20261124' });
    assert.strictEqual(q1NonCalendar.valuation.pe_forecast, 2.5, '06-30 结束的一季报应按 ×4 年化得 2.5 倍而非半年报 5 倍');
    assert.strictEqual(q1NonCalendar.valuation.pb_ex_goodwill, null, '商誉缺失(null)时不得按 0 计算扣商誉 PB');
    assert.strictEqual(q1NonCalendar.valuation.payout_ratio, null, '缺少同期间合并分红总额时不得混用近12月股息率与年报利润');
    assert.ok(Math.abs(q1NonCalendar.valuation.roe - 4) < 0.01, '港股 ROE 应为百分数 4');
    assert.ok(Math.abs(q1NonCalendar.valuation.roa - 2) < 0.01, '港股 ROA 应为百分数 2');

    const withGoodwill = buildHkAnalysis({
      meta: { ts_code: '00363.HK', name: '上海实业控股', currency: 'HKD' },
      valuations: [{ trade_date: '2026-11-23', close: 13.22, pe_ttm: 7.06, pb: 0.28, total_mv: 1437293.7, dv_ttm: 4.69 }],
      reportFacts: [
        { period_end: '2025-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'HKD',
          report_ids: [{ kind: 'income', report_id: 1 }, { kind: 'balance', report_id: 2 }],
          profit: 2e9, revenue: null, eps: null, equity: 5e10, assets: 1e11, liabilities: 4e10, goodwill: 5e9, currency_unverified: false },
      ],
      dividends: [],
      events: [],
    }, { tsCode: '00363.HK', isoToday: '2026-11-24', today: '20261124' });
    assert.ok(withGoodwill.valuation.pb_ex_goodwill > 0, '明确提供商誉(含0)时应计算扣商誉 PB');
    console.log('  [PASS] #71/#72 港股一季报0630年化、商誉缺失保护、分红率与ROE/ROA');
  }

  // #72 A 股无有效业绩预告时按最新季报/中报年化计算动态市盈率
  {
    const aAnalysis = buildAnalysis({
      meta: { ts_code: '601857.SH', name: '中国石油', industry: '石油', list_date: '20071105', data: {} },
      income: [
        { end_date: '20260930', ann_date: '20261030', f_ann_date: '20261030', n_income_attr_p: 1.2e11, fin_exp_int_exp: 0, ebit: 1.5e11 },
        { end_date: '20251231', ann_date: '20260330', f_ann_date: '20260330', n_income_attr_p: 1.5e11, fin_exp_int_exp: 0, ebit: 1.8e11 },
      ],
      balance: [{ end_date: '20260930', total_hldr_eqy_exc_min_int: 1.5e12, total_assets: 2.8e12, total_liab: 1.1e12, goodwill: 0, money_cap: 3e11, trad_asset: 0 }],
      cashflow: [],
      indicators: [],
      dividends: [],
      forecasts: [],
      valuations: [{ trade_date: '20261123', close: 12.53, adj_factor: 1, pe_ttm: 12.28, pb: 1.4, dv_ttm: 4.07, total_mv: 2.29e8, circ_mv: 2.0e8, total_share: 1.83e7 }],
      events: [],
    }, { today: '20261124' });
    assert.ok(aAnalysis.valuation.pe_forecast > 0 && aAnalysis.valuation.pe_forecast_basis === 'annualized_report');
    const saJs = read('public', 'js', 'stock-analysis.js');
    assert.ok(saJs.includes('最新报告期年化'), '前端动态市盈率副标题应区分最新报告期年化');
    console.log('  [PASS] #72 A 股无预告按最新季报年化计算动态市盈率');
  }

  // #73-#76 模拟股市弹框、历史榜单矩阵、场次切换竞态与服务端分页
  {
    const crJs = read('public', 'js', 'classroom.js');
    new vm.Script(crJs, { filename: 'public/js/classroom.js' });
    const crApi = read('public', 'js', 'api', 'classroom-api.js');
    const crService = read('server', 'services', 'classroomService.js');
    const crRepo = read('server', 'repositories', 'classroomRepository.js');
    const crRoute = read('server', 'routes', 'classroom.js');
    assert.strictEqual((crJs.match(/window\.confirm\(/g) || []).length, 1, '除 confirmDialog 兜底外不应再直接调用原生 window.confirm');
    assert.ok(crJs.includes('window.projectConfirm'), 'classroom.js 应使用全站统一弹框 projectConfirm');
    assert.ok(crJs.includes('teacherDetailSeq') && crJs.includes('reqSeq !== state.teacherDetailSeq'), '切换场次加载详情应有请求序号竞态校验');
    assert.ok(crJs.includes('renderTeacherClassroomList();') && crJs.indexOf('state.teacherClassroomId = Number(c.classroom_id)') < crJs.indexOf('renderTeacherClassroomList();'), '切换场次时应立即刷新列表高亮样式');
    const clickIdx = crJs.indexOf('state.teacherClassroomId = Number(c.classroom_id)');
    assert.ok(crJs.indexOf("$('teacher-active-panel').hidden = true;", clickIdx) > clickIdx, '切换场次时应立即隐藏旧场次详情面板防止误操作');
    assert.ok(crJs.includes('删除场次') && crJs.includes('TEACHER_PAGE_SIZE = 10') && crJs.includes('loadTeacherConsole(state.teacherPage + 1)'), '教师场次列表应含删除场次按钮及服务端翻页');
    assert.ok(crApi.includes('page=') && crRepo.includes('LIMIT $1 OFFSET $2') && crRoute.includes('req.query.page'), '服务端 admin/list 应支持真实分页而非硬编码 LIMIT 100');
    assert.ok(crJs.includes('formatRoundColumnLabel') && crJs.includes('roundHistoryLeaderboards') && crService.includes('roundHistoryLeaderboards'), '前后端应支持历史轮次榜单矩阵');
    console.log('  [PASS] #73-#76 模拟股市弹框、竞态保护、服务端分页与历史榜单矩阵');
  }

  // #77 持仓选价行为反例：同为 confirmed 取最新日；新日期只有 candidate 时不得覆盖旧 confirmed
  {
    function makeQuery(dailyRows) {
      return async (sql) => {
        if (/FROM\s+market\.trading_calendar/i.test(sql) || /trading_calendar/i.test(sql)) {
          return { rows: [
            { trade_date: '2026-11-23', status: 'open' },
            { trade_date: '2026-11-19', status: 'open' },
            { trade_date: '2026-11-18', status: 'open' },
          ] };
        }
        if (/FROM\s+daily_prices/i.test(sql)) return { rows: dailyRows };
        return { rows: [] };
      };
    }
    const confirmedLatest = await resolveEffectivePrices({
      username: 'u', accountName: 'a', asOf: '2026-11-24', mode: 'current', at: '2026-11-24T12:14:00+08:00',
      subjects: [{ code: '510900', subtype: '沪市' }],
      query: makeQuery([
        { username: 'u', account_name: 'a', code: '510900', market: 'CN', date: '2026-11-18', price: 0.959, quality: 'confirmed', is_final: true, revision: 3, source: 'history_backfill:tushare' },
        { username: 'u', account_name: 'a', code: '510900', market: 'CN', date: '2026-11-23', price: 0.924, quality: 'confirmed', is_final: true, revision: 1, source: 'market_close_task:LOF/ETF' },
      ]),
    });
    assert.strictEqual(confirmedLatest.prices.get(priceKey('CN', '510900')).tradeDate, '2026-11-23', '同为 confirmed 时应取最新交易日 11-23');

    const candidateNotOverride = await resolveEffectivePrices({
      username: 'u', accountName: 'a', asOf: '2026-11-24', mode: 'current', at: '2026-11-24T12:14:00+08:00',
      subjects: [{ code: '510900', subtype: '沪市' }],
      query: makeQuery([
        { username: 'u', account_name: 'a', code: '510900', market: 'CN', date: '2026-11-19', price: 0.941, quality: 'confirmed', is_final: true, revision: 1, source: 'market_close_task:LOF/ETF' },
        { username: 'u', account_name: 'a', code: '510900', market: 'CN', date: '2026-11-23', price: 0.924, quality: 'candidate', is_final: false, revision: 2, source: 'quote' },
      ]),
    });
    assert.strictEqual(candidateNotOverride.prices.get(priceKey('CN', '510900')).tradeDate, '2026-11-19', '新日期仅有 candidate 时不得覆盖 11-19 confirmed 价');
    console.log('  [PASS] #77 持仓选价质量优先且不回退旧高 revision');
  }

  console.log('=== 全部通过 ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
