const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'public', 'login.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const coreTradeScript = fs.readFileSync(path.join(root, 'public', 'shared', 'core-trade.js'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'js', 'stock-analysis.js'), 'utf8');
// 批次4：股票分析已拆为 View（渲染）与 Presenter（状态/请求序号/取数编排），断言按职责分别校验。
const stockPresenter = fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'stock-analysis-presenter.js'), 'utf8');
const chartScript = fs.readFileSync(path.join(root, 'public', 'js', 'stock-analysis-chart.js'), 'utf8');
const valuationChartScript = fs.readFileSync(path.join(root, 'public', 'js', 'stock-analysis-valuation-chart.js'), 'utf8');
const bondScript = fs.readFileSync(path.join(root, 'public', 'js', 'bond-analysis.js'), 'utf8');
// 批次4：可转债侧取数/请求序号已拆入 Presenter（presenters/bond-analysis-presenter.js），断言跟随代码按职责覆盖 View＋Presenter。
const bondPresenter = fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'bond-analysis-presenter.js'), 'utf8');
const statementsScript = fs.readFileSync(path.join(root, 'public', 'js', 'stock-analysis-statements.js'), 'utf8');
const businessTableScript = fs.readFileSync(path.join(root, 'public', 'shared', 'business-table.js'), 'utf8');
const vm = require('vm');
const { JSDOM } = require('jsdom');
// 批次4：三表已拆为 View（渲染）与 Presenter（缓存/请求序号/取数），断言按职责分别校验。
const statementsPresenter = fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'stock-analysis-statements-presenter.js'), 'utf8');
const dateRangeScript = fs.readFileSync(path.join(root, 'public', 'shared', 'date-range-control.js'), 'utf8');
const analysisCss = fs.readFileSync(path.join(root, 'public', 'css', 'stock-analysis.css'), 'utf8');
const sharedCss = fs.readFileSync(path.join(root, 'public', 'shared', 'style.css'), 'utf8');
const utilsScript = fs.readFileSync(path.join(root, 'public', 'js', 'utils.js'), 'utf8');
const appVersion = require(path.join(root, 'package.json')).appVersion;
const { renderAppVersion } = require('../middleware/versionedStaticPages');
const renderedHtml = renderAppVersion(html, appVersion);
const holdingsCharts = [
  fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'public', 'shared', 'core-account.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'public', 'shared', 'core-returns.js'), 'utf8'),
].join('\n');

const stockTab = html.indexOf('data-main="stock-analysis"');
const ipoTab = html.indexOf('data-main="ipo"');
assert.ok(stockTab >= 0, '缺少股票分析一级导航');
assert.ok(ipoTab >= 0, '缺少打新日历一级导航');
assert.ok(stockTab !== ipoTab, '股票分析与打新日历在导航中应位于不同位置');
assert.ok(html.includes('id="main-stock-analysis"'), '缺少股票分析一级页面');
assert.ok(html.includes('js/stock-analysis.js'), '缺少股票分析脚本引用');
assert.ok(html.includes('js/stock-analysis-statements.js'), '缺少三表脚本引用');
assert.ok(html.indexOf('id="stock-analysis-summary"') < html.indexOf('id="stock-analysis-view-analysis"'), '三表切换必须位于股票名称下方');
assert.ok(html.indexOf('data-statement-view="balance"') < html.indexOf('股票基本信息'), '财务报表切换必须位于股票基本信息上方');
for (const type of ['balance','income','cashflow']) assert.ok(html.includes(`data-statement-view="${type}"`), `缺少${type}顶部标签`);
assert.ok(statementsPresenter.includes('stockAnalysisApi.getStatements') && statementsScript.includes('同比'), '三表页面未接入年度原值和同比数据');
assert.ok(statementsScript.includes('statement-section-'), '财务报表缺少分区展示');
assert.ok(statementsScript.includes('statement-level-') && statementsScript.includes('statement-branch'), '财务科目缺少父子层级展示');
assert.ok(statementsScript.includes('comparisonEnabled = data.compare !== \'none\''), '不比较模式必须收起空比较列');
assert.ok(analysisCss.includes('height:30px') && analysisCss.includes('statement-level-2') && analysisCss.includes('statement-unit'), '三表矩阵缺少紧凑行高、深层级与同行单位样式');
assert.ok(analysisCss.includes('.statement-status-help') && analysisCss.includes('min-width:44px') && analysisCss.includes('min-height:44px'), '缺失字段必须有可触达的状态说明入口');
assert.ok(analysisCss.includes('.biz-table-floating-head .stock-analysis-statements-table thead') && analysisCss.includes('height:auto'), '浮动表头必须解除共享表头的固定行高');
assert.ok(businessTableScript.includes('floating.className = table.className + \' biz-table-floating-table\''), '浮动表头必须保留业务矩阵样式');
assert.ok(businessTableScript.includes('aria-hidden\', \'true\''), '浮动表头副本必须对读屏隐藏');
assert.ok(businessTableScript.includes('cells.filter(function (item) { return item.span === 1; })'), '浮动表头宽度必须优先采用真实叶列宽度');
assert.ok(statementsPresenter.includes('stockAnalysisState.selected !== code'), '409 重读未在写入共享快照前确认证券仍为当前证券');
{
  const dom = new JSDOM('<div id="stock-analysis-statements-title"></div><div id="stock-analysis-statements-meta"></div><div id="stock-analysis-statements-message"></div><div id="stock-analysis-statements-wrap"></div>');
  const view = { document: dom.window.document, window: dom.window,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    stockAnalysisNumber: value => String(value), stockAnalysisPercent: value => String(value) };
  vm.runInNewContext(statementsScript, view);
  view.stockAnalysisRenderStatements({ name: '资产负债表', type: 'balance', compare: 'yoy',
    periods: [{ end_date: '2025-06-30' }], fields: [{ label: '资产', section: '资产', values: [
      { value: 1, status: 'available', change: null, comparison_status: 'not_applicable', comparison_reason: 'comparison_method_unverified' }
    ] }] });
  const cell = dom.window.document.querySelector('td[aria-label]');
  assert.ok(cell, '不可比较值要有可访问原因');
  assert.strictEqual(cell.getAttribute('aria-label'), '该项目的比较口径尚未核实');
  assert.strictEqual(cell.textContent, '—');
  const statusHelp = dom.window.document.querySelector('details.statement-status-help');
  assert.ok(statusHelp, '不可比较字段要有触摸可打开的状态说明');
  assert.match(statusHelp.textContent, /比较口径尚未核实/);
  view.stockAnalysisRenderStatements({ name: '资产负债表', type: 'balance', compare: 'yoy',
    periods: [{ end_date: '2025-12-31' }, { end_date: '2024-12-31' }], fields: [{ label: '资产', section: '资产', values: [
      { value: null, status: 'source_unavailable', reason: 'source_currency_unverified', comparison_status: 'not_applicable', comparison_reason: 'comparison_method_unverified' },
      { value: null, status: 'collection_incomplete', reason: 'collection_incomplete', comparison_status: 'not_applicable', comparison_reason: 'comparison_method_unverified' }
    ] }] });
  const multiPeriodHelp = dom.window.document.querySelector('details.statement-status-help').textContent;
  assert.match(multiPeriodHelp, /2025-12-31 原值：/);
  assert.match(multiPeriodHelp, /2024-12-31 原值：/);
  assert.match(multiPeriodHelp, /2025-12-31、2024-12-31 同比：/);
  view.stockAnalysisRenderStatements({ name: '资产负债表', type: 'balance', compare: 'none',
    periods: [{ end_date: '2025-12-31', scope: 'consolidated' }, { end_date: '2025-12-31', scope: 'parent' }],
    fields: [{ label: '资产', section: '资产', values: [
      { value: null, status: 'source_unavailable', reason: 'source_currency_unverified' },
      { value: null, status: 'collection_incomplete', reason: 'collection_incomplete' }
    ] }] });
  const sameDateHelp = dom.window.document.querySelector('details.statement-status-help').textContent;
  assert.match(sameDateHelp, /2025-12-31 合并口径 原值：/);
  assert.match(sameDateHelp, /2025-12-31 母公司口径 原值：/);
  dom.window.close();
}
{
  const dom = new JSDOM('<div id="stock-analysis-statements-title"></div><div id="stock-analysis-statements-meta"></div><div id="stock-analysis-statements-message"></div><div id="stock-analysis-statements-wrap"></div>');
  const view = { document: dom.window.document, window: dom.window,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    stockAnalysisNumber: value => String(value), stockAnalysisPercent: value => String(value),
    BusinessTable: { attach() {} } };
  vm.runInNewContext(statementsScript, view);
  view.stockAnalysisRenderStatements({ name: '利润表', type: 'income', compare: 'none', unit_label: 'CNY·亿元', periods: [
    { end_date: '2025-12-31', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }
  ], fields: [
    { code: 'ps.toi', label: '营业收入', section: '营业收入', level: 0, is_parent: true, values: [{ value: 10, status: 'available' }] },
    { code: 'ps.oc', label: '营业成本', section: '成本及费用', level: 1, parent: 'ps.toc', unit: 'CNY·亿元', values: [{ value: 5, status: 'available' }] }
  ] });
  const table = dom.window.document.querySelector('table');
  assert.strictEqual(table.querySelectorAll('thead tr:first-child th').length, 2, '不比较模式每期只能保留一个分组列');
  assert.strictEqual(table.querySelectorAll('thead tr:nth-child(2) th').length, 1, '不比较模式不能渲染空比较列');
  assert.ok(table.querySelector('tr.statement-section-total[data-statement-level="0"]'), '同名有值分组应合并为带值总计行');
  assert.ok(table.querySelector('tr[data-parent-code="ps.toc"] .statement-unit'), '层级字段应保留父项标识和同行单位');
  dom.window.close();
}
{
  const dom = new JSDOM('<div id="stock-analysis-statements-title"></div><div id="stock-analysis-statements-meta"></div><div id="stock-analysis-statements-message"></div><div id="stock-analysis-statements-wrap"></div>');
  const view = { document: dom.window.document, window: dom.window,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    stockAnalysisNumber: value => Number(value).toFixed(2),
    stockAnalysisPercent: value => (Number(value) * 100).toFixed(2) + '%',
    BusinessTable: { attach() {} } };
  vm.runInNewContext(statementsScript, view);
  view.stockAnalysisRenderStatements({
    name: '资产负债表', type: 'balance', compare: 'yoy', unit_label: 'CNY·亿元',
    periods: [{ end_date: '2025-12-31', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }],
    fields: [
      { code: 'bs.ta', label: '资产总计', unit: 'CNY·亿元', values: [{ value: 0, status: 'available', change: 0, comparison_status: 'available' }] },
      { code: 'bs.tca', label: '流动资产合计', unit: 'CNY·亿元', values: [{ value: 10, status: 'available', change: 0.125, comparison_status: 'available' }] },
      { code: 'bs.nraar', label: '应收票据及应收账款', unit: 'CNY·亿元', values: [{ value: 5, status: 'available', change: -0.05, comparison_status: 'available' }] },
      { code: 'bs.nr', label: '其中：应收票据', unit: 'CNY·亿元', values: [{ value: 2, status: 'available', change: null, comparison_status: 'not_applicable', comparison_reason: 'comparison_method_unverified' }] },
      { code: 'bs.lwi', label: '有息负债', unit: 'CNY·亿元', values: [{ value: 3, status: 'available', change: null, comparison_status: 'not_applicable', comparison_reason: 'comparison_method_unverified' }] },
    ],
    presentation: {
      version: '2026-11-23.1',
      rows: [
        { kind: 'field', code: 'bs.ta', row_role: 'total', group_id: 'group:资产', parent_code: null, depth: 0, is_group_rep: true },
        { kind: 'field', code: 'bs.tca', row_role: 'subtotal', group_id: 'group:资产 › 流动资产', parent_code: null, depth: 1, is_group_rep: true },
        { kind: 'field', code: 'bs.nraar', row_role: 'subtotal', group_id: 'group:资产 › 流动资产', parent_code: null, depth: 2, is_group_rep: false },
        { kind: 'field', code: 'bs.nr', row_role: 'detail', group_id: 'group:资产 › 流动资产', parent_code: 'bs.nraar', depth: 3, is_group_rep: false },
        { kind: 'section', row_role: 'section', group_id: 'group:负债', label: '负债', depth: 0 },
        { kind: 'field', code: 'bs.lwi', row_role: 'supplement', group_id: 'group:负债', parent_code: null, depth: 1, is_group_rep: false },
      ],
    },
  });
  const doc = dom.window.document;
  assert.ok(doc.querySelector('tr[data-statement-code="bs.ta"][data-statement-level="0"].statement-role-total.statement-section-total'), '0 值代表行应合并为 0 层 total');
  assert.ok(doc.querySelector('tr[data-statement-code="bs.tca"][data-statement-level="1"].statement-role-subtotal'), '1 层 subtotal 应正确渲染');
  assert.ok(doc.querySelector('tr[data-statement-code="bs.nraar"][data-statement-level="2"].statement-role-subtotal'), '2 层组合项应渲染为 subtotal');
  assert.ok(doc.querySelector('tr[data-statement-code="bs.nr"][data-statement-level="3"][data-parent-code="bs.nraar"].statement-role-detail .statement-branch'), '3 层明细应带父项连接符');
  assert.ok(doc.querySelector('tr.statement-section th.statement-section-cell'), '独立分组标题应放在首个真实单元格以支持固定首列');
  assert.strictEqual(doc.querySelectorAll('tr.statement-section td.statement-section-filler').length, 2, '分组行其余叶列应补齐');
  assert.ok(doc.querySelector('tr[data-statement-code="bs.lwi"].statement-role-supplement'), '补充指标应保留 supplement 角色');
  assert.strictEqual(doc.querySelector('tr[data-statement-code="bs.ta"] td.statement-change.flat').textContent, '0.00%', '舍入为零的变化应使用中性 flat 样式');
  assert.strictEqual(doc.querySelector('tr[data-statement-code="bs.tca"] td.statement-change.up').textContent, '+12.50%', '正变化应带 + 号与 up 样式');
  assert.strictEqual(doc.querySelector('tr[data-statement-code="bs.nraar"] td.statement-change.down').textContent, '-5.00%', '负变化应带 - 号与 down 样式');

  // 未知版本、漏列字段、重复科目时必须回退旧 fields，不能静默隐藏科目
  view.stockAnalysisRenderStatements({
    name: '资产负债表', type: 'balance', compare: 'none', unit_label: 'CNY·亿元',
    periods: [{ end_date: '2025-12-31', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }],
    fields: [
      { code: 'bs.ta', label: '资产总计', section: '资产总计', level: 0, values: [{ value: 10, status: 'available' }] },
      { code: 'bs.tl', label: '负债合计', section: '负债合计', level: 0, values: [{ value: 4, status: 'available' }] },
    ],
    presentation: {
      version: '9999-01-01',
      rows: [
        { kind: 'field', code: 'bs.ta', row_role: 'total', depth: 0 },
        { kind: 'field', code: 'bs.tl', row_role: 'total', depth: 0 },
      ],
    },
  });
  assert.ok(doc.querySelector('tr[data-statement-code="bs.ta"]') && doc.querySelector('tr[data-statement-code="bs.tl"]'), '未知 presentation 版本必须回退完整 fields');

  view.stockAnalysisRenderStatements({
    name: '资产负债表', type: 'balance', compare: 'none', unit_label: 'CNY·亿元',
    periods: [{ end_date: '2025-12-31', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }],
    fields: [
      { code: 'bs.ta', label: '资产总计', section: '资产总计', level: 0, values: [{ value: 10, status: 'available' }] },
      { code: 'bs.tl', label: '负债合计', section: '负债合计', level: 0, values: [{ value: 4, status: 'available' }] },
    ],
    presentation: {
      version: '2026-11-23.1',
      rows: [
        { kind: 'field', code: 'bs.ta', row_role: 'total', depth: 0 },
      ],
    },
  });
  assert.ok(doc.querySelector('tr[data-statement-code="bs.tl"]'), '漏列字段的 presentation 必须回退完整 fields，不能静默隐藏');

  // 有原值且选择“不比较”时，降级关系状态仍须在行内说明中向用户解释
  view.stockAnalysisRenderStatements({
    name: '利润表', type: 'income', compare: 'none', unit_label: 'HKD·亿元',
    periods: [{ end_date: '2026-12-31', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'HKD' }],
    fields: [
      { code: 'ps.fe', label: '财务费用', unit: 'HKD·亿元', values: [{ value: 10, status: 'available' }] },
      { code: 'ps.iiife', label: '其中：利息收入', unit: 'HKD·亿元', values: [{ value: 3, status: 'available' }] },
    ],
    presentation: {
      version: '2026-11-23.1',
      rows: [
        { kind: 'section', row_role: 'section', group_id: 'group:营业成本及费用', label: '营业成本及费用', depth: 0 },
        { kind: 'field', code: 'ps.fe', row_role: 'line', group_id: 'group:营业成本及费用', parent_code: null, depth: 1, relation_status: 'group_only' },
        { kind: 'field', code: 'ps.iiife', row_role: 'line', group_id: 'group:营业成本及费用', parent_code: null, depth: 1, relation_status: 'format_version_unverified' },
      ],
    },
  });
  const relHelp = doc.querySelector('tr[data-statement-code="ps.iiife"] details.statement-status-help');
  assert.ok(relHelp, '有原值且不比较时，降级关系必须有行内状态说明');
  assert.match(relHelp.textContent, /列报版本尚未核实/);
  dom.window.close();
}
(async () => {
  // Presenter 命中缓存前必须核对当前详情的 statement_analysis_versions，版本失配时重读而不是渲染旧缓存
  const rendered = [];
  const apiCalls = [];
  const presenterCtx = {
    stockAnalysisState: { selected: '600519.SH', selectToken: 1, data: { display: { statement_analysis_versions: { balance: 'v2' } } } },
    stockAnalysisShowStatementsLoading() {},
    stockAnalysisShowStatementsError(err) { throw err; },
    stockAnalysisRenderStatements(payload) { rendered.push(payload); },
    stockAnalysisApi: {
      async getStatements(code, type, version) {
        apiCalls.push({ code, type, version });
        return { ok: true, status: 200, payload: { analysis_version: 'v2', fields: [{ code: 'bs.ta' }] } };
      },
    },
  };
  vm.runInNewContext(statementsPresenter, presenterCtx);
  presenterCtx.stockStatementState.cache['600519.SH:balance:all:yoy:consolidated:10'] = { analysis_version: 'v1', fields: [{ code: 'bs.old' }] };
  await presenterCtx.stockAnalysisLoadStatements('balance');
  assert.strictEqual(apiCalls.length, 1, '详情版本已更新为 v2 时不得直接命中 v1 缓存');
  assert.strictEqual(apiCalls[0].version, 'v2');
  assert.strictEqual(rendered[0].analysis_version, 'v2', '必须渲染重新读取的 v2 数据');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
{
  const dom = new JSDOM('<div id="stock-analysis-statements-title"></div><div id="stock-analysis-statements-meta"></div><div id="stock-analysis-statements-message"></div><div id="stock-analysis-statements-wrap"></div>');
  const view = { document: dom.window.document, window: dom.window,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    stockAnalysisNumber: value => String(value), stockAnalysisPercent: value => String(value),
    BusinessTable: { attach() {} } };
  vm.runInNewContext(statementsScript, view);
  view.stockAnalysisRenderStatements({ name: '资产负债表', type: 'balance', compare: 'none', unit_label: '原值', periods: [
    { end_date: '2025-12-31', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' },
    { end_date: '2025-12-31', scope: 'parent', fs_table_type: 'non_financial', currency: 'CNY' }
  ], fields: [{ label: '资产', section: '资产', values: [
    { value: 1, status: 'available', change: null }, { value: 2, status: 'available', change: null }
  ] }] });
  const headers = [...dom.window.document.querySelectorAll('thead th')].map(cell => cell.textContent).join(' ');
  assert.ok(headers.includes('合并口径') && headers.includes('母公司口径'), '全部口径报告列必须显示各自报表口径');
  dom.window.close();
}
{
  const dom = new JSDOM('<select id="stock-analysis-statement-period"></select><div id="stock-analysis-statements-title"></div><div id="stock-analysis-statements-meta"></div><div id="stock-analysis-statements-message"></div><div id="stock-analysis-statements-wrap"></div>');
  const view = { document: dom.window.document, window: dom.window,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    stockAnalysisNumber: value => String(value), stockAnalysisPercent: value => String(value),
    stockAnalysisStatementFilters: () => ({ periodType: 'all', scope: 'consolidated' }),
    BusinessTable: { attach() {} } };
  vm.runInNewContext(statementsScript, view);
  view.stockAnalysisRenderStatements({
    name: '资产负债表', type: 'balance', compare: 'yoy', unit_label: '原值',
    available_filters: { period_types: ['annual', 'semiannual', 'q1', 'q3'], scopes: ['consolidated'] },
    periods: [
      { end_date: '2026-09-30', report_type_label: 'third_quarterly_report', scope: 'consolidated', currency: 'CNY' },
    ],
    fields: [{ label: '资产总计', section: '资产', values: [
      { value: 5021, status: 'available', change: null, comparison_status: 'insufficient_history', comparison_reason: 'comparable_period_missing' },
    ] }],
  });
  const periodOptions = [...dom.window.document.querySelectorAll('#stock-analysis-statement-period option')].map(o => o.textContent);
  assert.deepStrictEqual(periodOptions, ['全部', '年报', '半年报', '季报'], '无未知期时报告期下拉只保留全部/年报/半年报/季报');
  const headerText = dom.window.document.querySelector('thead th.statement-period').textContent;
  assert.ok(headerText.includes('三季报') && !headerText.includes('third_quarterly_report'), '列头应将英文报告期映射为中文');
  assert.ok(!headerText.includes('报表类型待确认'), '不应在每列拼接刺眼的报表类型待确认');
  assert.strictEqual(dom.window.document.querySelector('details.statement-status-help'), null, '仅缺少历史比较期时不在类目标题后渲染感叹号');
  // A-06: 来源正常未披露不触发行内感叹号；采集不完整说明必须使用中文报告期；当前选中 unknown 且新数据无 unknown 时必须移除并回退 all
  view.stockAnalysisStatementFilters = () => ({ periodType: 'unknown', scope: 'consolidated' });
  view.stockAnalysisRenderStatements({
    name: '资产负债表', type: 'balance', compare: 'none', unit_label: '原值',
    available_filters: { period_types: ['annual', 'semiannual', 'q3'], scopes: ['consolidated'] },
    periods: [
      { end_date: '2026-09-30', report_type_label: 'third_quarterly_report', scope: 'consolidated', currency: 'CNY' },
    ],
    fields: [
      { label: '应收票据', section: '资产', values: [{ value: null, status: 'source_not_disclosed', reason: 'source_not_disclosed' }] },
      { label: '商誉', section: '资产', values: [{ value: null, status: 'collection_incomplete', reason: 'source_batch_incomplete' }] },
    ],
  });
  assert.deepStrictEqual(
    [...dom.window.document.querySelectorAll('#stock-analysis-statement-period option')].map(o => o.value),
    ['all', 'annual', 'semiannual', 'quarter'],
    '新数据不含未知期时即使原选中 unknown 也应移除该选项'
  );
  assert.strictEqual(dom.window.document.getElementById('stock-analysis-statement-period').value, 'all');
  const helpNodes = dom.window.document.querySelectorAll('details.statement-status-help');
  assert.strictEqual(helpNodes.length, 1, '仅采集不完整行保留感叹号，来源正常未披露不触发感叹号');
  assert.ok(helpNodes[0].textContent.includes('三季报') && !helpNodes[0].textContent.includes('third_quarterly_report'), '行内说明不得出现英文报告期');
  dom.window.close();
}
{
  const dom = new JSDOM('<select id="stock-analysis-statement-scope"></select>');
  const view = { document: dom.window.document, window: dom.window,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    stockAnalysisStatementFilters: () => ({ scope: 'consolidated' }) };
  vm.runInNewContext(statementsScript, view);
  view.stockAnalysisRenderStatementFilters({ available_filters: { scopes: ['parent'] } });
  const scope = dom.window.document.getElementById('stock-analysis-statement-scope');
  assert.strictEqual(scope.value, 'consolidated', '缺少合并数据时仍保持默认范围并显示空状态');
  assert.ok(scope.options[1].disabled && /合并口径/.test(scope.options[1].textContent));
  assert.strictEqual(scope.options[2].value, 'parent', '母公司范围仍应可选');
  dom.window.close();
}
assert.ok(html.includes('css/stock-analysis.css'), '缺少股票分析样式引用');
assert.ok(script.includes('PE为负通常代表公司亏损') === false, '分位点固定说明应由后端统一返回');
// 批次2c：站内 HTTP 已收进 API 客户端；断言指向实际落点，并新增“View 不得直接 fetch”
const apiClient = fs.readFileSync(path.join(root, 'public', 'js', 'api', 'stock-analysis-api.js'), 'utf8');
assert.ok(apiClient.includes('/statements?type=') && !/\bfetch\s*\(/.test(statementsScript + statementsPresenter), '三表请求必须经股票分析客户端');
assert.ok(apiClient.includes('/api/stock-analysis/'), 'API 客户端未接入股票分析接口');
assert.ok(/stockAnalysisApi\./.test(stockPresenter), 'Presenter 未通过 API 客户端取数');
assert.ok(!/await fetch\(/.test(script + stockPresenter), 'View 与 Presenter 均不得直接 fetch');
assert.ok(html.includes('js/api/stock-analysis-api.js'), '页面未加载股票分析 API 客户端');
assert.ok(html.indexOf('js/stock-analysis.js') < html.indexOf('js/presenters/stock-analysis-presenter.js')
  && html.includes('js/presenters/stock-analysis-presenter.js'), '页面未按序加载股票分析 Presenter');
assert.ok(/if \(payload\.needs_refresh\)[\s\S]*?showToast\('数据待更新：'/.test(stockPresenter)
  && !/if \(payload\.needs_refresh\)[\s\S]*?return stockAnalysisRefresh\(\)/.test(stockPresenter),
  '股票分析页面打开只能提示过期，不能自动触发外部刷新');
assert.ok(/if \(snapshotResult\.status === 404\)[\s\S]*?暂无分析快照[\s\S]*?刷新数据/.test(stockPresenter)
  && !/if \(snapshotResult\.status === 404\)[\s\S]*?return stockAnalysisRefresh\(\)/.test(stockPresenter),
  '股票分析页面首次打开无快照时不能自动建档');
assert.ok(/if \(!refresh && analysis\.needs_refresh\)[\s\S]*?showToast\('数据待更新，请点击“刷新数据”进行更新。'\)/.test(bondPresenter)
  && !/if \(!refresh && analysis\.needs_refresh\)[\s\S]*?return bondAnalysisLoad\(true/.test(bondPresenter),
  '可转债分析页面打开只能提示过期，不能自动触发外部刷新');
// 批次4：取数改走统一客户端后，响应变量名由 response 变为 res；判定语义不变（404 只提示不自动建档）。
assert.ok(/res\.status===404&&!refresh[\s\S]*?暂无分析快照[\s\S]*?刷新数据/.test(bondPresenter)
  && !/res\.status===404&&!refresh[\s\S]*?return bondAnalysisLoad\(true/.test(bondPresenter),
  '可转债分析页面首次打开无快照时不能自动建档');
assert.ok(html.includes('js/stock-analysis-chart.js'), '缺少盈利分红图表脚本引用');
assert.ok(chartScript.includes('dividend_history'), '缺少历史分红记录渲染');
assert.ok(html.includes('shared/date-range-control.js'), '缺少公共时间范围组件引用');
assert.ok(dateRangeScript.includes('is-active'), '公共时间范围组件缺少选中状态');
assert.ok(dateRangeScript.includes('CoreDate.subtractYears') && !dateRangeScript.includes('setFullYear'), '日期区间必须按业务日期计算年份范围');
assert.ok(valuationChartScript.includes('CoreDate.subtractYears(end,state.activeYears||10)'), '估值图表必须按纯业务日期计算开始日');
assert.ok(chartScript.includes("CoreDate.todayInZone('Asia/Shanghai')") && chartScript.includes('CoreDate.subtractYears(endDefault,10)'), '稳定性图表必须以上海业务日作为默认区间结束日');
assert.ok(utilsScript.includes("CoreDate.todayInZone('Asia/Shanghai')"), '页面 todayCN 必须委托共享日期工具');
assert.ok(coreTradeScript.includes("CoreDate.dateTimeInZone(new Date(), 'Asia/Shanghai')"), '交易时间必须由共享工具明确转换到上海时区');
assert.ok(html.indexOf('shared/core-date.js') < html.indexOf('js/utils.js') &&
  html.indexOf('shared/core-date.js') < html.indexOf('shared/core-trade.js') &&
  html.indexOf('shared/core-date.js') < html.indexOf('shared/date-range-control.js'), '共享日期工具必须先于前端消费者加载');
for (const asset of ['shared/core-date.js', 'js/utils.js', 'shared/core-trade.js', 'shared/date-range-control.js', 'js/stock-analysis-chart.js', 'js/stock-analysis-valuation-chart.js']) {
  assert.ok(html.includes(`${asset}?v=__APP_VERSION__`), `${asset} 必须使用服务端自动填充的应用版本`);
  assert.ok(renderedHtml.includes(`${asset}?v=${appVersion}`), `${asset} 响应版本必须与应用版本一致`);
}
for (const [name, page] of [['登录页', loginHtml], ['管理页', adminHtml]]) {
  const renderedPage = renderAppVersion(page, appVersion);
  assert.ok(page.indexOf('shared/core-date.js') < page.indexOf('js/utils.js'), `${name}必须先加载共享日期工具`);
  assert.ok(page.includes('shared/core-date.js?v=__APP_VERSION__'), `${name}共享日期工具必须使用自动版本`);
  assert.ok(page.includes('js/utils.js?v=__APP_VERSION__'), `${name}通用工具必须使用自动版本`);
  assert.ok(renderedPage.includes(`shared/core-date.js?v=${appVersion}`), `${name}共享日期工具响应版本必须与应用版本一致`);
  assert.ok(renderedPage.includes(`js/utils.js?v=${appVersion}`), `${name}通用工具响应版本必须与应用版本一致`);
}
assert.ok(chartScript.includes('未分红'), '历史分红列表未补齐未分红年度');
assert.ok(chartScript.includes('historyMap') && chartScript.includes('股东大会通过'), '历史分红缺少同方案生命周期去重');
assert.ok(html.includes('js/stock-analysis-valuation-chart.js'), '缺少股价估值分位图表脚本引用');
assert.ok(valuationChartScript.includes("data-mode=\"price\""), '分位图缺少股价切换');
assert.ok(valuationChartScript.includes("data-mode=\"pe\""), '分位图缺少PE切换');
assert.ok(valuationChartScript.includes("data-mode=\"pb\""), '分位图缺少PB切换');
assert.ok(valuationChartScript.includes('band80'), '分位图缺少历史分位线');
assert.ok(valuationChartScript.includes('evolvingBands') && valuationChartScript.includes("'<path class=\"'+b.c"), '历史分位必须按时间累计绘制为曲线');
assert.ok(valuationChartScript.includes('DateRangeControl.render'), '分位图缺少公共时间范围控件');
assert.ok(valuationChartScript.includes('presets:[30,20,10,5,3,1]'), '分位图缺少年份快捷选项');
assert.ok(valuationChartScript.includes('valuation-outlier'), '分位图缺少异常极值标识');
assert.ok(valuationChartScript.includes('valuation-negative'), '分位图缺少负值标识');
assert.ok(valuationChartScript.includes('mainPath=rows.map') && valuationChartScript.includes('markerRuns(function(v){return v>max}') && !valuationChartScript.includes("'<circle class=\"'+(v<=0"), '正常曲线必须连续，极值颜色只能标在坐标边界');
assert.ok(valuationChartScript.includes('min=Math.min.apply(null,normals),max=Math.max.apply(null,normals)') && !valuationChartScript.includes('normals.concat(bandValues)'), '异常值和历史分位高值不能拉伸纵坐标');
assert.ok(valuationChartScript.includes("markerRuns(function(v){return v>max},'valuation-outlier-line',T)") && valuationChartScript.includes("v>max?'异常高值，超出纵坐标范围'"), '只有超出纵坐标最高值的数据才能标为异常高值');
for (const title of ['公司与证券资料','估值水平','收益、盈利与分红','市值结构','报告与业绩预期']) assert.ok(script.includes(title), '股票基本信息缺少分类：'+title);
assert.ok(script.includes('历史累计分红') && script.includes('历史累计盈利'), '累计分红率缺少分子分母说明');
assert.ok(script.includes('平均股息率') && script.includes('最近12个月归母净利润'), '缺少平均股息率及公式说明');
assert.ok(script.includes('(late-early)/early') && script.includes('近期三年均值－十年前三年均值'), '十年三年均值增长必须按两组三年均值的总增长率计算');
assert.ok(script.includes('analysisHelp(label, stockAnalysisLabelHelp(label))'), '股票分析指标缺少算法说明入口');
assert.ok(bondScript.includes('analysisHelp(row[0],bondAnalysisLabelHelp(row[0]))'), '可转债分析指标缺少算法说明入口');
assert.ok(html.includes('id="stock-analysis-suggestions"') && html.includes('aria-autocomplete="list"'), '股债分析缺少名称联想下拉框');
assert.ok((bondScript + bondPresenter).includes('/api/bond-analysis/search/securities?q=') && bondScript.includes('securityAnalysisChooseSuggestion'), '股债分析名称联想未接入证券搜索接口');
assert.ok(/addEventListener\('input',function\(\)\s*\{[\s\S]*?securityAnalysisClearListSelection\(ctx\)/.test(bondScript), '手动输入证券后未清空旧持仓选项');
assert.ok(bondPresenter.includes('securityAnalysisState.searchSeq++;') && bondPresenter.includes('securityAnalysisSubmit(code, ctx);'), '从持仓选择证券时未取消旧搜索并按新代码分析');
assert.ok(analysisCss.includes('.security-analysis-suggestions{') && analysisCss.includes('.security-analysis-suggestion.active'), '证券联想下拉缺少样式或键盘选中状态');
assert.ok(analysisCss.includes('.analysis-help{') && analysisCss.includes('border-bottom:1px dashed') && analysisCss.includes('.analysis-help-tooltip{'), '算法说明缺少虚线下划线或悬浮弹框样式');
assert.ok(html.includes('data-help="分位点从所选起始日累计计算') && html.includes('data-help="实际期权价值＝转债市价－纯债价值'), '股债分析模块标题缺少算法说明');
assert.ok(sharedCss.includes('.app-tooltip.app-tooltip'), '缺少全站统一浮动提示主题');
assert.ok(script.includes('analysis-help-tooltip app-tooltip') && chartScript.includes('stock-analysis-chart-tooltip app-tooltip') &&
  valuationChartScript.includes('stock-analysis-valuation-tip app-tooltip'), '股债分析提示未使用统一主题');
assert.ok(utilsScript.includes('function appChartTooltip(') && holdingsCharts.split('appChartTooltip(').length - 1 >= 4,
  '持仓管理图表提示未使用统一主题');

console.log('stock-analysis frontend tests passed');
