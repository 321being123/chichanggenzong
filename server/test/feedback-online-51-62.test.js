// 线上反馈 #51-#62 专项回归测试（不依赖数据库，直接验证前端/领域/服务契约）。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  [PASS]', name);
}

console.log('=== 线上反馈 #51-#62 回归测试 ===');

check('#51 消息列表进入反馈详情后返回消息列表', () => {
  const nt = read('public', 'js', 'notifications.js');
  const fb = read('public', 'js', 'feedback.js');
  const fbp = read('public', 'js', 'presenters', 'feedback-presenter.js');
  assert.ok(nt.includes("targetUrl.searchParams.set('from', 'notifications')"), '通知跳转必须附带 from=notifications');
  assert.ok(fbp.includes("state.from = params.get('from') || null"), 'feedback-presenter 必须读取 from 来源');
  assert.ok(fb.includes("if (state.from === 'notifications')"), 'feedback 返回必须识别通知来源');
  assert.ok(fb.includes("backParams.set('main', 'notifications')"), 'feedback 返回必须跳回 main=notifications');
});

check('#52 感叹号三种颜色明显区分', () => {
  const css = read('public', 'css', 'bond-safety.css');
  const callColor = css.match(/\.bond-lifecycle-mark-call[^}]*color:\s*([^;]+)/);
  const exp6mColor = css.match(/\.bond-lifecycle-mark-expiry-6m[^}]*color:\s*([^;]+)/);
  const exp1yColor = css.match(/\.bond-lifecycle-mark-expiry-1y[^}]*color:\s*([^;]+)/);
  assert.ok(callColor && exp6mColor && exp1yColor, '三种感叹号样式必须存在');
  assert.notStrictEqual(callColor[1].trim(), exp6mColor[1].trim(), '强赎红与半年到期必须不同色');
  assert.notStrictEqual(exp6mColor[1].trim(), exp1yColor[1].trim(), '半年到期与一年到期必须不同色');
  assert.notStrictEqual(callColor[1].trim(), exp1yColor[1].trim(), '强赎红与一年到期必须不同色');
});

check('#53 导出 Excel 按钮统一轮廓风格与靠右对齐', () => {
  const coreTables = read('public', 'shared', 'core-tables.js');
  const html = read('public', 'index.html');
  assert.ok(!coreTables.includes('btn-success btn-sm" data-act="exportToExcel"'), '持仓导出按钮不得再使用绿色实心 btn-success');
  assert.ok(coreTables.includes('btn-outline btn-sm filter-bar-btn" data-act="exportToExcel"'), '持仓导出按钮必须使用统一轮廓风格');
  assert.ok(html.includes('id="bond-safety-export" data-act="exportBondSafety">导出 Excel<'), '可转债安全性导出按钮文案须统一为 导出 Excel');
  assert.ok(/id="bond-list-visible"><\/span>\s*<span class="bond-feature-spacer"><\/span>\s*<button class="btn btn-outline btn-sm" id="bond-list-refresh"/.test(html), '上市可转债刷新与导出按钮须靠右对齐');
});

check('#54 格雷厄姆低估季度组合与投资要义彻底隔离', () => {
  const ssp = read('public', 'js', 'presenters', 'stock-selection-presenter.js');
  assert.ok(ssp.includes("if (ssState.scheme === 'graham_net_net') return 'graham_net_net_v1';"), '格雷厄姆低估所有周期必须锁定 graham_net_net_v1');
  assert.ok(ssp.includes("run.strategyCode !== 'graham_net_net_v1'"), '投资要义模式必须过滤掉 graham_net_net_v1 批次');
});

check('#55/#56/#57 选股三级标题独立UI、规则浮框化、周期与目标组合合并且排除管理居右', () => {
  const html = read('public', 'index.html');
  const ss = read('public', 'js', 'stock-selection.js');
  assert.ok(html.indexOf('id="ss-scheme-tabs"') < html.indexOf('class="ss-hero'), '三级标题必须位于选股中心 hero 上方');
  assert.ok(html.includes('class="ss-scheme-segmented" id="ss-scheme-tabs"'), '三级标题必须采用与二级下划线导航区分的分段控件样式');
  assert.ok(!html.includes('id="ss-essentials-rule-list"'), '页面不再平铺投资要义规则列表');
  assert.ok(!html.includes('id="ss-graham-rule-list"'), '页面不再平铺格雷厄姆规则列表');
  assert.ok(html.includes('data-ss-scheme="essentials" data-ss-metric-help="投资要义选股规则"'), '投资要义标签须绑定浮框说明');
  assert.ok(html.includes('data-ss-scheme="graham_net_net" data-ss-metric-help="格雷厄姆低估选股规则"'), '格雷厄姆低估标签须绑定浮框说明');
  assert.ok(html.includes('id="ss-exclusion-toggle"'), '横栏右侧须有排除管理入口按钮');
  assert.ok(html.indexOf('id="ss-period-tabs"') < html.indexOf('id="ss-portfolio"')
    && html.indexOf('id="ss-portfolio"') < html.indexOf('id="ss-detail"'), '周期选项卡与目标组合必须合并在同一面板内');
  assert.ok(ss.includes('ssEssentialsRuleHelpText'), 'View 必须随 V1/V2 动态更新投资要义浮框规则');
});

check('#58/#59 修复 --ok 缺失导致的利润柱黑色与 20% 分位线消失', () => {
  const style = read('public', 'shared', 'style.css');
  const saCss = read('public', 'css', 'stock-analysis.css');
  assert.ok(style.includes('--ok: var(--success);'), 'style.css 必须提供 --ok 兜底变量');
  assert.ok(saCss.includes('.stock-analysis-chart .profit{fill:var(--profit-color)}') && saCss.includes('--profit-color:#4ade80'), '利润柱状图必须使用嫩绿色 --profit-color');
  assert.ok(saCss.includes('.band20{stroke:var(--success)}'), '20% 分位线必须使用绿色 --success');
  assert.ok(saCss.includes('.stock-analysis-valuation-legend .b20{border-color:var(--success)}'), '20% 分位图例必须使用绿色 --success');
});

check('#60 股债分析刷新轮询与港股指标计算', () => {
  const api = read('public', 'js', 'api', 'stock-analysis-api.js');
  const sap = read('public', 'js', 'presenters', 'stock-analysis-presenter.js');
  assert.ok(api.includes('getRefreshStatus:'), 'stock-analysis-api 必须提供 getRefreshStatus');
  assert.ok(sap.includes('stockAnalysisPollSlot'), 'stock-analysis-presenter 必须轮询后台刷新进度并重渲染');

  const { buildHkAnalysis } = require('../services/hkSecurityAnalysis');
  const res = buildHkAnalysis({
    meta: { name: '中国海洋石油', industry: '油气生产商', list_date: '2001-02-28', currency: 'HKD' },
    valuations: [
      { trade_date: '2026-11-19', close: '21.5', pe_ttm: '6.2', pb: '1.02', total_mv: '102000000' },
      { trade_date: '2026-11-20', close: '21.7', pe_ttm: '6.3', pb: '1.04', total_mv: '103140000' },
    ],
    reportFacts: [
      { period_end: '2025-12-31', period_type: 'annual', currency: 'CNY', report_ids: [{ kind: 'income' }, { kind: 'balance' }], profit: 130000000000, equity: 700000000000, assets: 1000000000000, liabilities: 300000000000, currency_unverified: false },
      { period_end: '2024-12-31', period_type: 'annual', currency: 'CNY', report_ids: [{ kind: 'income' }, { kind: 'balance' }], profit: 120000000000, equity: 650000000000, assets: 950000000000, liabilities: 300000000000, currency_unverified: false },
      { period_end: '2023-12-31', period_type: 'annual', currency: 'CNY', report_ids: [{ kind: 'income' }, { kind: 'balance' }], profit: 110000000000, equity: 600000000000, assets: 900000000000, liabilities: 300000000000, currency_unverified: false },
    ],
    dividends: [],
    events: [],
  }, { tsCode: '00883.HK', isoToday: '2026-11-23', today: '20261123', fxToCny: { HKD: 0.92 } });

  assert.ok(res.valuation.roe > 0.18 && res.valuation.roe < 0.21, '港股 ROE 应按同币种计算得出');
  assert.ok(res.valuation.roa > 0.12 && res.valuation.roa < 0.15, '港股 ROA 应按同币种计算得出');
  assert.ok(res.valuation.pe_static > 0, '港股静态市盈率应经汇率折算后算出');
  assert.ok(res.valuation.pe_three_year_avg > 0, '港股三年平均市盈率应算出');
  assert.strictEqual(res.percentiles.history.length, 2, '港股分位图 history 必须输出');
  assert.strictEqual(res.stability.years.length, 3, '港股稳定性年度利润图必须输出');
});

check('#61 模拟股市隐藏代码列并用债券名称替代十年期国债', () => {
  const crJs = read('public', 'js', 'classroom.js');
  const crRules = read('server', 'domain', 'classroomRules.js');
  assert.ok(crJs.includes('<thead><tr><th>行业</th><th>代号</th><th>真实名称</th><th>PE</th><th>PB</th><th>当轮涨跌</th></tr></thead>'), '教师行情明细不得显示 代码 列');
  assert.ok(!crRules.includes("alias: '十年期国债'"), '代号不得暴露 十年期国债');
  assert.ok(crRules.includes("alias: '稳健债券'"), '应使用稳健债券名称替代');
});

check('#62 模拟股市预检允许教学分组包含不同 SW2021 细分行业', () => {
  const precheck = read('server', 'services', 'classroomPrecheckService.js');
  assert.ok(!precheck.includes('库内行业为「'), '预检不得因自定义教学分组名与 SW2021 叶子行业名不同而判红');
  assert.ok(!precheck.includes('内股票分属多个不同 SW2021 行业'), '预检不得因教学大类包含多个 SW2021 子行业而阻断');
});

console.log(`全部通过：${passed} 项`);
