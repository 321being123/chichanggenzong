// 线上反馈 #63-#68 专项回归测试（领域计算与前端/接口契约）。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildAnalysis } = require('../domain/stockValuation');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

console.log('=== 线上反馈 #63-#68 回归测试 ===');

// #64 模拟股市场次关闭与删除契约
{
  const routes = read('server', 'routes', 'classroom.js');
  const api = read('public', 'js', 'api', 'classroom-api.js');
  const ui = read('public', 'js', 'classroom.js');
  assert.ok(routes.includes("router.post('/admin/:id/close'"), '后端应提供关闭场次接口');
  assert.ok(routes.includes("router.delete('/admin/:id'"), '后端应提供删除场次接口');
  assert.ok(api.includes('adminClose:') && api.includes('adminDelete:'), '前端 API 应暴露 adminClose 与 adminDelete');
  assert.ok(ui.includes('关闭场次') && ui.includes('api.adminDelete(c.classroom_id)'), '教师端场次列表应提供关闭场次与删除交互');
  console.log('  [PASS] #64 模拟股市场次关闭与删除前后端契约');
}

// #65 最新估值行缺 close/adj_factor 时回退最后有效价/因子；过期年报预告不计算动态市盈率；readCoverageFlags 查日线表
{
  const baseData = {
    meta: { ts_code: '601857.SH', name: '中国石油', industry: '石油石化', list_date: '20071105', data: {} },
    income: [
      { end_date: '20251231', ann_date: '20260328', f_ann_date: '20260328', n_income_attr_p: 160000000000, report_type: '1' },
    ],
    balance: [
      { end_date: '20251231', ann_date: '20260328', f_ann_date: '20260328', total_hldr_eqy_exc_min_int: 1500000000000, total_assets: 2800000000000, goodwill: 0, report_type: '1' },
    ],
    cashflow: [],
    indicators: [],
    dividends: [],
    forecasts: [
      { ann_date: '20230120', end_date: '20221231', type: '预增', net_profit_min: 14500000, net_profit_max: 15500000 },
    ],
    valuations: [
      { trade_date: '20201120', close: 4.15, adj_factor: 1.5, pe_ttm: 12, pb: 0.7, total_share: 18302000, total_mv: 75953300 },
      { trade_date: '20261030', close: 8.5, adj_factor: 1.89, pe_ttm: 13, pb: 1.4, total_share: 18302000, total_mv: 155567000 },
      { trade_date: '20261120', close: null, adj_factor: null, pe_ttm: 12.95, pb: 1.48, total_share: 18302000, total_mv: 155567000 },
    ],
    events: [],
  };
  const analysis = buildAnalysis(baseData, { today: '20261123' });
  assert.ok(Number.isFinite(analysis.valuation.annualized_return_since_listing), '最新估值行缺 close/adj_factor 时仍应算出上市至今年化收益率');
  assert.strictEqual(analysis.valuation.pe_forecast, null, '2022 年报的过期预告不应作为 2026 年动态市盈率');
  const saRepo = read('server', 'repositories', 'stockAnalysisRepository.js');
  assert.ok(saRepo.includes('FROM market.daily_bars b JOIN market.adjustment_factors a'), 'readCoverageFlags 必须核对 market.daily_bars 与 adjustment_factors');
  console.log('  [PASS] #65 个股分析有效价回退、过期预告过滤与日线覆盖判断');
}

// #66 净利润柱状图绿色换成嫩绿
{
  const saCss = read('public', 'css', 'stock-analysis.css');
  const saChart = read('public', 'js', 'stock-analysis-chart.js');
  assert.ok(saCss.includes('--profit-color:#4ade80') && saCss.includes('.profit-swatch{background:#4ade80}'), 'stock-analysis.css 应定义嫩绿色变量与色块类');
  assert.ok(saChart.includes('<i class="profit-swatch"></i>归母净利润'), '图例应使用嫩绿 profit-swatch');
  assert.ok(saChart.includes('<i class="tip-color profit-swatch"'), 'tooltip 应使用嫩绿 profit-swatch');
  console.log('  [PASS] #66 归母净利润柱状图与图例/浮层改用嫩绿色');
}

// #67 & #68 选股中心红框区域移入「投资要义」tab 浮框；周期 Tab 左对齐且「每日动态」最左
{
  const idxHtml = read('public', 'index.html');
  assert.ok(idxHtml.includes('<div class="ss-hero bond-feature-hero" hidden>'), '.ss-hero 应隐藏');
  assert.ok(idxHtml.includes('<div id="ss-market-cards" class="ss-cards bond-feature-stats" hidden>'), '#ss-market-cards 应隐藏');
  const posDaily = idxHtml.indexOf('data-ss-period="daily"');
  const posWeekly = idxHtml.indexOf('data-ss-period="weekly"');
  const posQuarter = idxHtml.indexOf('data-ss-period="quarter"');
  assert.ok(posDaily > 0 && posDaily < posWeekly && posWeekly < posQuarter, '周期顺序应为 每日动态 -> 每周正式 -> 历史季度');

  const ssCss = read('public', 'css', 'stock-selection.css');
  assert.ok(ssCss.includes('margin: 0 auto 0 0; padding: 0;'), 'ss-period-tabs 必须消除左侧居中留白');
  assert.ok(ssCss.includes('.ss-period-tabs .bond-sub-tab:first-child { padding-left: 0; }'), '首个周期 Tab 应紧贴左边缘对齐');

  const ssJs = read('public', 'js', 'stock-selection.js');
  assert.ok(ssJs.includes('function ssBuildEssentialsHelpText(state)'), 'stock-selection.js 应组装包含市场概览的浮框说明');
  console.log('  [PASS] #67/#68 选股中心概览移入浮框及周期 Tab 左对齐/顺序');
}

console.log('feedback-online-63-68.test.js: ALL PASSED');
