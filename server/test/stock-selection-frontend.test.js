// 股票筛选：前端静态结构测试（不连数据库）。
// 覆盖 2026-11-05 三项页面口径：批次下拉只列已发布组合、证券名称可跳证券分析、PE 展示统一 TTM。
// 写法与既有 *-frontend.test.js 一致：读源码断言，不做 DOM 渲染。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const view = fs.readFileSync(path.join(root, 'public', 'js', 'stock-selection.js'), 'utf8');
const presenter = fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'stock-selection-presenter.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'stock-selection.css'), 'utf8');
const service = fs.readFileSync(path.join(root, 'server', 'services', 'stockSelectionService.js'), 'utf8');
const repository = fs.readFileSync(path.join(root, 'server', 'repositories', 'stockSelectionRepository.js'), 'utf8');
const portfolio = fs.readFileSync(path.join(root, 'server', 'domain', 'stockSelectionPortfolio.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'server', 'db', 'migrations', 'era14StockSelectionUx.js'), 'utf8');
const migrations = fs.readFileSync(path.join(root, 'server', 'db', 'migrations.js'), 'utf8');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { results.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

console.log('A. 公共来源下拉与个人结果分离');
check('页面请求批次时带 published=1，未发布预览不再进入下拉', () => {
  assert.ok(/listRuns\(\{ market: ssState\.market, published: '1'/.test(presenter), '批次请求必须带 published=1');
});
check('公共来源下拉不把个人结果混入，个人结果单独标识来源', () => {
  assert.ok(presenter.includes('published: \'1\''), '公共来源必须只请求已发布批次');
  assert.ok(view.includes('个人组合'), '个人结果必须有独立标签');
  assert.ok(view.includes('来源 #'), '个人结果必须显式标出公共来源');
});
check('空列表文案区分「暂无已发布组合」与港股缺数据', () => {
  assert.ok(view.includes('暂无已发布公共来源'), '空下拉文案应明确是公共来源为空');
  assert.ok(presenter.includes('当前市场暂无'), '空状态必须绑定当前市场和周期');
});

console.log('B. 证券名称跳转证券分析');
check('候选表与组合表的证券名称都渲染成跳转入口', () => {
  const hits = view.match(/data-ss-analysis="/g) || [];
  assert.ok(hits.length >= 2, '候选表与目标组合表都要有 data-ss-analysis');
});
check('点击名称走 openInAnalysis，点击行其它位置仍开本页详情', () => {
  assert.ok(view.includes('StockSelectionPresenter.openInAnalysis('), '名称点击必须调用 openInAnalysis');
  assert.ok(view.includes('StockSelectionPresenter.openStock('), '行点击仍保留本页详情');
  assert.ok(/var jump = event\.target\.closest\('\[data-ss-analysis\]'\);\s*\n\s*if \(jump && window\.StockSelectionPresenter\)/.test(view),
    '必须先判断名称入口再判断整行，否则点名称会被行点击吃掉');
  assert.ok(view.includes("if (event.target.closest('.ss-row-actions')) return;"), '操作菜单点击不得触发行详情');
});
check('openInAnalysis 切页后复用证券分析既有入口', () => {
  assert.ok(/async function ssOpenInAnalysis/.test(presenter), '缺少 openInAnalysis');
  assert.ok(presenter.includes("switchMain('stock-analysis')"), '必须先切到证券分析页');
  assert.ok(presenter.includes('securityAnalysisSubmit(raw'), '必须复用证券分析既有提交入口，不另建取数链路');
  assert.ok(/openInAnalysis: ssOpenInAnalysis/.test(presenter), '必须导出给 View 调用');
});
check('名称入口有链接样式，不依赖鼠标悬停才能识别', () => {
  assert.ok(/\.ss-stock-link\s*\{[^}]*cursor:\s*pointer/.test(css), '缺少 .ss-stock-link 样式');
});

console.log('C. PE 统一 TTM');
check('候选表表头与详情都标 PE（TTM）', () => {
  assert.ok(view.includes('PE（TTM）'), '表头必须写 PE（TTM）');
  assert.ok(view.includes('PE（TTM） '), '详情面板必须写 PE（TTM）');
  assert.ok(!view.includes('静态 PE'), '页面不应再出现静态 PE 字样');
});
check('页面规则说明同步为 PE（TTM）排名', () => {
  assert.ok(html.includes('PB 升序、PE（TTM）升序、股息率降序'), '规则说明必须与排名口径一致');
  assert.ok(!html.includes('静态 PE 升序'), '规则说明不得保留旧口径');
});
check('V2 R02 页面说明包含两条实际通过路径', () => {
  assert.ok(html.includes('PB 曾严格大于 1，或有效正 PB 的最高值 ÷ 最低值 ≥ 3'), 'R02 页面说明必须包含 v1/v2 或逻辑');
});

console.log('D. 交互优化跨层契约');
check('页面不再渲染资金设置和历史回测入口', () => {
  assert.ok(!html.includes('id="ss-settings"'), '页面不应保留资金设置区域');
  assert.ok(!html.includes('id="ss-backtests"'), '页面不应保留历史回测区域');
  assert.ok(html.includes('ss-source-panel'), '来源和周期选择应位于双表公共区域');
});
check('排除管理覆盖证券和行业且支持恢复', () => {
  assert.ok(view.includes('data-ss-action="exclude-instrument"'), '缺少排除证券操作');
  assert.ok(view.includes('data-ss-action="exclude-industry"'), '缺少排除行业操作');
  assert.ok(view.includes('data-ss-action="restore-instrument"'), '缺少恢复证券排除操作');
  assert.ok(view.includes('data-ss-action="restore-industry"'), '缺少恢复行业排除操作');
  assert.ok(view.includes('renderExclusions'), '缺少排除管理渲染');
});
check('个人派生显式携带来源、设置版本和稳定请求 ID', () => {
  assert.ok(presenter.includes('sourceRunId'), '个人派生必须带公共来源');
  assert.ok(presenter.includes('settingsRevision'), '个人派生必须带设置 revision');
  assert.ok(presenter.includes('clientRequestId'), '个人派生必须带稳定请求 ID');
  assert.ok(service.includes('expectedSettingsRevision'), '服务端必须核对期望设置 revision');
  assert.ok(service.includes('clientRequestId 是传输幂等标识'), '内容哈希与传输请求 ID 必须分离');
  assert.ok(presenter.includes('ssLoadSourceAndMaybePersonal'), '已有排除项进入或切换来源时必须自动派生个人结果');
  assert.ok(presenter.includes('if (!isCurrent()) return result;'), '个人测算迟到响应不得覆盖新页面上下文');
  assert.ok(view.includes('ss-retry-simulation'), '个人测算失败必须提供重试入口');
  assert.ok(presenter.includes('contextVersion'), '个人测算上下文不能与分页请求共用序号');
  assert.ok(presenter.includes('operationContext'), '保存后派生必须携带操作开始时的来源上下文');
  assert.ok(presenter.includes('detailVersion'), '详情请求必须有独立的最后选择守卫');
});
check('设置和结果读取失败保留可恢复状态', () => {
  assert.ok(presenter.includes('ssSettingsMutationQueue'), '排除操作必须串行化，避免并发覆盖设置');
  assert.ok(presenter.includes('ssSettingsEquivalent'), '保存异常必须重读并比较权威设置');
  assert.ok(presenter.includes('pendingSettingsOperation'), '保存结果不明必须保留操作意图');
  assert.ok(presenter.includes('resultRunId'), '结果读取失败必须保留已生成的 runId');
  assert.ok(view.includes('data-ss-action="retry-settings"'), '保存失败必须提供设置重试入口');
});
check('市场概览跟随当前周期读取正式来源', () => {
  assert.ok(presenter.includes('SS_PERIOD_API_TYPE'), 'Presenter 必须维护页面周期到服务周期的映射');
  assert.ok(presenter.includes('getMarkets({ periodType:'), '市场概览请求必须携带当前周期');
  assert.ok(service.includes('requestedPeriodType'), '服务层必须按请求周期选择正式来源');
  assert.ok(service.includes('activePeriodType'), '响应必须显式返回实际采用的周期');
  assert.ok(view.includes('今日已发布') && view.includes('本周已发布'), '页面状态文案必须跟随实际周期');
});
check('市场概览的日期与周状态标题和内容一致', () => {
  const rootNode = { innerHTML: '' };
  const context = { window: {}, document: { getElementById: () => rootNode, querySelectorAll: () => [] } };
  vm.createContext(context); vm.runInContext(view, context);
  const item = { market: 'CN', label: 'A股', gate: { status: 'not_required' }, pb: null, pe: null,
    referencePosition: null, activePeriodType: 'day', selectedPeriodStatus: { samePeriodPublished: true } };
  context.ssRenderMarkets({ market: 'CN', markets: [item] });
  assert.ok(rootNode.innerHTML.includes('今日状态') && rootNode.innerHTML.includes('今日已发布'));
  assert.ok(!rootNode.innerHTML.includes('本周状态'));
  item.activePeriodType = 'week'; context.ssRenderMarkets({ market: 'CN', markets: [item] });
  assert.ok(rootNode.innerHTML.includes('本周状态') && rootNode.innerHTML.includes('本周已发布'));
});
check('市场概览占满正文宽度，V2 状态标签本身提供说明', () => {
  assert.ok(/\.ss-cards\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css),
    '当前市场概览必须单列占满正文宽度');
  const rootNode = { innerHTML: '' };
  const context = { window: {}, document: { getElementById: () => rootNode, querySelectorAll: () => [] } };
  vm.createContext(context); vm.runInContext(view, context);
  const item = { market: 'CN', label: 'A股', gate: { status: 'not_required' }, pb: null, pe: null,
    referencePosition: null, activePeriodType: 'week', selectedPeriodStatus: { samePeriodPublished: true } };
  context.ssRenderMarkets({ market: 'CN', markets: [item], strategyCode: 'low_pb_v2' });
  assert.ok(/<button type="button" class="ss-gate ss-gate-not_required[^"]*" data-ss-metric-help="指数仅参考"/.test(rootNode.innerHTML),
    'V2 指数仅参考必须让状态标签本身成为说明按钮');
  assert.ok(rootNode.innerHTML.includes('aria-label="查看指数仅参考说明"'), '说明按钮必须有可访问名称');
  assert.ok(rootNode.innerHTML.includes('不影响个股筛选、排名与组合发布'), '说明必须覆盖筛选、排名和组合发布');
  assert.ok(rootNode.innerHTML.includes('不适用'), 'V2 无参考仓位必须显示不适用');
  assert.ok(!rootNode.innerHTML.includes('class="ss-metric-help"'), '不能再另放一个 ⓘ 说明按钮');

  item.gate = { status: 'eligible' };
  context.ssRenderMarkets({ market: 'CN', markets: [item], strategyCode: 'low_pb_v1' });
  assert.ok(rootNode.innerHTML.includes('<span class="ss-gate ss-gate-eligible">'), 'V1 准入标签保持 span 与原文案');
  assert.ok(rootNode.innerHTML.includes('本轮不配置'), 'V1 无参考仓位保持原有文案');
  assert.ok(!rootNode.innerHTML.includes('不适用'), 'V1 不得显示不适用的 V2 文案');
});
check('历史字符串行业排除在管理面板中可见且可恢复', () => {
  const rootNode = { innerHTML: '' };
  const context = { window: {}, document: { getElementById: () => rootNode } };
  vm.createContext(context); vm.runInContext(view, context);
  context.ssRenderExclusions({ market: 'HK', settings: { industryFilters: { HK: ['LEGACY'] }, excludedInstruments: [] } });
  assert.ok(rootNode.innerHTML.includes('LEGACY'));
  assert.ok(rootNode.innerHTML.includes('data-ss-industry-code="LEGACY"'));
  assert.ok(rootNode.innerHTML.includes('data-ss-action="restore-industry"'));
});
check('行业排除管理展示完整身份、待映射状态和来源受影响数量', () => {
  const rootNode = { innerHTML: '' };
  const context = { window: {}, document: { getElementById: () => rootNode } };
  vm.createContext(context); vm.runInContext(view, context);
  context.ssRenderExclusions({ market: 'CN', settings: { industryFilters: { CN: [
    { code: '123', name: '同名行业', system: 'A', version: '1' },
    { code: '123', name: '同名行业', system: 'B', version: '2' },
    { code: '124', name: '未知版本行业', system: null, version: null },
  ] }, excludedInstruments: [] }, portfolio: {
    sourceIndustryIdentityCounts: [
      { code: '123', name: '同名行业', system: 'A', version: '1', affectedCount: 7 },
      { code: '124', name: '未知版本行业', system: null, version: null, affectedCount: 5 },
    ],
  } });
  assert.ok(rootNode.innerHTML.includes('体系 A') && rootNode.innerHTML.includes('版本 1'));
  assert.ok(rootNode.innerHTML.includes('体系 B') && rootNode.innerHTML.includes('版本 2'));
  assert.ok(rootNode.innerHTML.includes('当前来源受影响 7 只'));
  assert.ok(rootNode.innerHTML.includes('待映射') && rootNode.innerHTML.includes('影响数未知'));
  assert.ok(rootNode.innerHTML.includes('已精确命中（身份含未知字段）') && rootNode.innerHTML.includes('当前来源受影响 5 只'));
});
check('指标说明支持焦点/悬停/点按且单实例关闭恢复焦点', () => {
  const dom = new JSDOM('<!doctype html><html><body><button id="help" data-ss-metric-help="PB" data-ss-help-text="说明">i</button><div id="outside">外部</div><input id="field"><div id="ss-candidates"></div></body></html>', { pretendToBeVisual: true });
  const context = { window: dom.window, document: dom.window.document };
  vm.createContext(context); vm.runInContext(view, context);
  const help = dom.window.document.getElementById('help'); help.getBoundingClientRect = () => ({ left: 10, top: 70, bottom: 90 });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 100 });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.classList.contains('ss-metric-tooltip') ? 120 : 20; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('ss-metric-tooltip') ? 40 : 20; } });
  context.ssInitView();
  help.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 1);
  assert.strictEqual(dom.window.document.querySelector('.ss-metric-tooltip').style.top, '24px', '浮层应在下方空间不足时翻转到按钮上方');
  help.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: dom.window.document.getElementById('outside') }));
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 0, '鼠标离开入口后应关闭悬浮说明');
  help.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
  const tip = dom.window.document.querySelector('.ss-metric-tooltip');
  help.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: tip }));
  tip.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: dom.window.document.getElementById('outside') }));
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 0, '从浮层离开到外部后应关闭说明');
  help.click(); help.click();
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 1, '重复点按不得叠加浮层');
  const esc = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(esc);
  assert.strictEqual(esc.defaultPrevented, true);
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 0);
  const noTipEsc = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(noTipEsc);
  assert.strictEqual(noTipEsc.defaultPrevented, false, '没有浮层时 Escape 不得拦截页面其它行为');
  help.click(); dom.window.document.getElementById('outside').click();
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 0);
  assert.strictEqual(dom.window.document.activeElement, help, '外部关闭后必须恢复说明按钮焦点');
  const field = dom.window.document.getElementById('field'); field.focus(); field.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(dom.window.document.activeElement.id, 'field', '点击外部输入框不得被焦点恢复抢回');
  help.click(); context.ssRenderCandidates({ candidates: [], candidateTotal: 0 });
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 0, '重渲染销毁入口时必须清理浮层');
  assert.ok(help.getAttribute('aria-describedby') === null);
  assert.ok(css.includes('.ss-metric-help { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px;'), '手机说明入口必须保留 44×44 触控区');
  assert.ok(css.includes('.ss-metric-tooltip-close { width: 44px; min-width: 44px; height: 44px;'), '手机浮层关闭按钮必须保留 44px 触控区');
});
check('候选操作重渲染后保留动作焦点（行内按钮）', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="ss-candidates"></div></body></html>', { pretendToBeVisual: true });
  const context = { window: dom.window, document: dom.window.document };
  vm.createContext(context); vm.runInContext(view, context);
  const item = { code: 'AAA', instrumentId: 1, filterStatus: 'PASS', industry: { code: 'I' }, exclusionReasons: [], personalExclusionReasons: [], currentPb: null, currentPe: null, dividendYield: null, equityCny: null };
  const state = { candidates: [item], candidateTotal: 1 };
  context.ssRenderCandidates(state);
  assert.strictEqual(dom.window.document.querySelectorAll('details.ss-row-actions').length, 0, '操作列不得再有折叠菜单');
  dom.window.document.querySelector('[data-ss-action="exclude-instrument"]').focus();
  item.personalExcluded = true; item.personalExclusionReasons = ['user_excluded_instrument'];
  context.ssRenderCandidates(state);
  assert.strictEqual(dom.window.document.activeElement.getAttribute('data-ss-action'), 'restore-instrument');
  context.ssCloseRowActionMenus();
  assert.strictEqual(dom.window.document.activeElement.getAttribute('data-ss-action'), 'restore-instrument', '没有展开菜单时不得抢走行内按钮焦点');
});
check('目标组合行移除后焦点回到组合摘要', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="ss-portfolio"></div><div id="ss-exclusions"></div></body></html>', { pretendToBeVisual: true });
  const context = { window: dom.window, document: dom.window.document };
  vm.createContext(context); vm.runInContext(view, context);
  const portfolio = { members: [{ code: 'AAA', name: '甲', instrumentId: 1, currentPb: null }], positionRatio: 0.5,
    selectedCount: 1, slots: 30, unfilledSlots: 29, equityWeightInMarketBudget: 0.5, cashWeightInMarketBudget: 0.5 };
  context.ssRenderPortfolio({ portfolio });
  dom.window.document.querySelector('[data-ss-action="exclude-instrument"]').focus();
  portfolio.members = [];
  portfolio.selectedCount = 0;
  portfolio.unfilledSlots = 30;
  context.ssRenderPortfolio({ portfolio });
  assert.strictEqual(dom.window.document.activeElement.className, 'ss-portfolio-summary');
  assert.strictEqual(dom.window.document.activeElement.getAttribute('tabindex'), '-1');
});
check('操作列改为行内直达按钮并保留容器与 data 属性', () => {
  assert.ok(!view.includes('<details class="ss-row-actions"'), '不得再渲染折叠菜单');
  assert.ok(view.includes('<div class="ss-row-actions">'), '行内按钮组必须保留 .ss-row-actions 容器');
  assert.ok(/class="ss-row-action[^"]*" data-ss-action="exclude-instrument"/.test(view), '股票排除必须是行内按钮');
  assert.ok(/class="ss-row-action[^"]*" data-ss-action="restore-industry"/.test(view), '行业恢复必须是行内按钮');
  assert.ok(view.includes('ss-row-action-on'), '已排除态必须高亮');
  assert.ok(css.includes('.ss-row-actions { display: inline-flex'), '行内按钮组必须横向排列');
  assert.ok(css.includes('.ss-row-action { min-height: 44px'), '移动端行内按钮触控高度必须 >= 44px');
});
check('目标组合移除冗余权重列并展示四项基本面指标', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="ss-portfolio"></div></body></html>', { pretendToBeVisual: true });
  const context = { window: dom.window, document: dom.window.document };
  vm.createContext(context); vm.runInContext(view, context);
  const member = { code: 'AAA', name: '甲', instrumentId: 1, slotNo: 1, currentPb: 1.2, currentPe: 12.3,
    dividendYield: 0.045, debtToAssetRatio: 0.62, latestProfitYoy: 0.154, latestProfitPeriodEnd: '2026-09-30' };
  const portfolio = { members: [member], positionRatio: 1, selectedCount: 1, slots: 30, unfilledSlots: 29,
    equityWeightInMarketBudget: 1, cashWeightInMarketBudget: 0, industryBreakdown: [], changes: null };
  context.ssRenderPortfolio({ portfolio });
  const head = dom.window.document.querySelector('thead').textContent;
  const body = dom.window.document.querySelector('tbody').textContent;
  assert.ok(!head.includes('占市场预算') && !head.includes('占股票目标'), '目标组合不得再展示冗余权重列');
  ['PE（TTM）', '股息率', '资产负债率', '最近财报利润同比'].forEach(label => {
    assert.ok(head.includes(label), '目标组合缺少列：' + label);
  });
  assert.ok(body.includes('12.30') && body.includes('4.50%') && body.includes('62.00%') && body.includes('+15.40%'),
    '四项指标格式必须与候选列表一致');
  assert.ok(body.includes('2026-09-30'), '利润同比应附最近报告期');
  member.currentPb = null; member.currentPe = null; member.dividendYield = null; member.debtToAssetRatio = null; member.latestProfitYoy = null;
  member.latestProfitPeriodEnd = null;
  context.ssRenderPortfolio({ portfolio });
  const missing = dom.window.document.querySelector('tbody').textContent;
  assert.strictEqual((missing.match(/--/g) || []).length >= 5, true, '缺失指标必须显示占位符而不是 0');
});
check('表头说明由标题文字本身承载，不再显示圆形 ⓘ', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="ss-candidates"></div><div id="ss-portfolio"></div></body></html>');
  const context = { window: dom.window, document: dom.window.document };
  vm.createContext(context); vm.runInContext(view, context);
  const item = { code: 'AAA', instrumentId: 1, filterStatus: 'PASS', industry: { code: 'I' }, exclusionReasons: [],
    personalExclusionReasons: [], currentPb: null, currentPe: null, dividendYield: null, equityCny: null };
  context.ssRenderCandidates({ candidates: [item], candidateTotal: 1 });
  const candidateHtml = dom.window.document.getElementById('ss-candidates').innerHTML;
  assert.ok(!candidateHtml.includes('ⓘ'), '候选表不得再显示圆形 ⓘ');
  assert.ok(!/<span[^>]*class="ss-metric-help"/.test(candidateHtml), '说明入口不得使用无法原生触发 Enter/Space 的 span');
  assert.ok(/<button type="button" class="ss-metric-help" data-ss-metric-help="PB"/.test(candidateHtml),
    'PB 表头标题本身必须是原生可聚焦说明按钮');
  const candidateLabels = [...dom.window.document.querySelectorAll('#ss-candidates thead .ss-metric-help')].map(node => node.textContent);
  assert.deepStrictEqual(candidateLabels, ['行业', 'PB', '正极值比', 'PE（TTM）', 'PB×PE', '股息率'],
    '候选表说明入口必须只覆盖指标标题，不带独立图标');
  const member = { code: 'AAA', name: '甲', instrumentId: 1, slotNo: 1, currentPb: null, currentPe: null, dividendYield: null,
    debtToAssetRatio: null, latestProfitYoy: null, industryName: '行业', issuerDuplicate: false };
  context.ssRenderPortfolio({ portfolio: { members: [member], positionRatio: 1, selectedCount: 1, slots: 30, unfilledSlots: 29,
    equityWeightInMarketBudget: 1, cashWeightInMarketBudget: 0, industryBreakdown: [], changes: null } });
  const portfolioHtml = dom.window.document.getElementById('ss-portfolio').innerHTML;
  assert.ok(!portfolioHtml.includes('ⓘ'), '目标组合表不得再显示圆形 ⓘ');
  const portfolioLabels = [...dom.window.document.querySelectorAll('#ss-portfolio thead .ss-metric-help')].map(node => node.textContent);
  assert.deepStrictEqual(portfolioLabels, ['席位', 'PB', 'PE（TTM）', '股息率', '资产负债率', '最近财报利润同比'],
    '目标组合说明入口必须只覆盖指标标题，不带独立图标');
  assert.ok(/\.ss-metric-help \{[^}]*text-decoration: underline dotted/.test(css), '标题说明应保留可辨认但非圆形的提示样式');
  assert.ok(!/\.ss-metric-help \{[^}]*border-radius: 50%/.test(css), '不得再绘制圆形 ⓘ');
  assert.ok(css.includes('.ss-metric-help { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px;'),
    '手机端 PB 等窄标题说明入口必须保留 44×44 触控区');

  // 真实渲染表头：聚焦打开、Escape 关闭并留焦，Enter/Space 可重新打开。
  const help = dom.window.document.querySelector('#ss-candidates thead [data-ss-metric-help="PB"]');
  assert.ok(help && help.tagName === 'BUTTON', '必须能取到真实渲染的 PB 标题按钮');
  context.ssInitView();
  help.focus();
  help.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 1, '聚焦标题应打开说明');
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 0, 'Escape 应关闭说明');
  assert.strictEqual(dom.window.document.activeElement, help, 'Escape 关闭后焦点应留在标题按钮');
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  help.dispatchEvent(enter);
  assert.strictEqual(enter.defaultPrevented, true);
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 1, 'Enter 应重新打开说明');
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const space = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  help.dispatchEvent(space);
  assert.strictEqual(space.defaultPrevented, true);
  assert.strictEqual(dom.window.document.querySelectorAll('.ss-metric-tooltip').length, 1, '空格应重新打开说明');
});

check('关键指标和组合字段均有说明入口，个人结果成功后关闭行操作菜单', () => {
  assert.ok(view.includes("ssHelp('PB×PE'"), 'PB×PE 必须有说明入口');
  assert.ok(view.includes("ssHelp('股息率'"), '股息率必须有说明入口');
  assert.ok(view.includes("ssHelp('席位'"), '席位必须有说明入口');
  assert.ok(view.includes("ssHelp('资产负债率'"), '资产负债率必须有说明入口');
  assert.ok(view.includes("ssHelp('最近财报利润同比'"), '最近财报利润同比必须有说明入口');
  assert.ok(view.includes('直接 PB 阈值通过'), 'PB×PE 说明必须覆盖直接 PB 阈值通过路径');
  assert.ok(presenter.includes('ssCloseRowActionMenus'), '个人结果成功后必须关闭行操作菜单');
});
check('后续个人派生沿用当前个人资金参数', () => {
  assert.ok(/run.runKind === 'personal'/.test(presenter), '必须识别当前展示的个人结果');
  assert.ok(presenter.includes('portfolio.budgetRatio'), '必须优先沿用当前个人组合预算');
  assert.ok(presenter.includes('portfolio.positionRatio'), '必须优先沿用当前个人组合仓位');
});
check('组合更新中展示目标设置版本并标明旧结果尚未更新', () => {
  const dom = new JSDOM('<body><div id="ss-run-header"></div></body>');
  const context = { window: dom.window, document: dom.window.document };
  vm.createContext(context); vm.runInContext(view, context);
  const state = { run: { runId: 41, runKind: 'personal', sourceRunId: 1, settingsRevision: 1 }, pendingSimulation: { settingsRevision: 2 } };
  context.ssRenderRunHeader(state);
  const status = dom.window.document.querySelector('[role="status"]');
  assert.ok(status && status.textContent.includes('设置版本 2') && status.textContent.includes('尚未更新'));
  state.pendingSimulation = null;
  context.ssRenderRunHeader(state);
  assert.strictEqual(dom.window.document.querySelector('[role="status"]'), null);
});
check('未入选原因在候选及详情中区分基础规则与个人结果', () => {
  const dom = new JSDOM('<body><div id="ss-candidates"></div><div id="ss-detail"></div></body>');
  const context = { window: dom.window, document: dom.window.document };
  vm.createContext(context); vm.runInContext(view, context);
  const item = { code: 'A', filterStatus: 'PASS', exclusionReasons: [], currentPb: 1, currentPe: 10, dividendYield: 0,
    equityCny: null, personalStatus: 'not_selected', personalNonSelectionReasons: ['industry_limit'] };
  context.ssRenderCandidates({ candidates: [item], candidateTotal: 1 });
  assert.ok(dom.window.document.querySelector('tbody').textContent.includes('四项通过'));
  assert.ok(dom.window.document.querySelector('tbody').textContent.includes('个人未入选：行业上限'));
  item.personalNonSelectionReasons = ['slots_full'];
  context.ssRenderDetail({ detail: { runId: 41, candidate: item } });
  assert.ok(dom.window.document.getElementById('ss-detail').textContent.includes('个人未入选：席位已满'));
  item.personalExcluded = true;
  item.personalNonSelectionReasons = ['user_excluded_industry'];
  assert.ok(context.ssPersonalCandidateLabel(item).includes('个人排除行业'));
});
check('设置省略资金字段时保留旧值，显式空值才清空', () => {
  assert.ok(service.includes("has('budgetRatioA') ? body.budgetRatioA : priorRatio('budgetRatioA')"), 'A 股预算省略时必须保留');
  assert.ok(service.includes("has('positionRatioHk') ? body.positionRatioHk : priorRatio('positionRatioHk')"), '港股仓位省略时必须保留');
  assert.ok(service.includes("body.totalCapital === null || body.totalCapital === '' ? null"), '显式空值必须可清空总资金');
});
check('行业排除使用体系、版本和代码的完整身份，并有请求绑定迁移', () => {
  assert.ok(portfolio.includes('industryIdentityKey'), '领域层缺少行业完整身份键');
  assert.ok(service.includes('excludedIndustryKeys'), '服务层未传递行业完整身份');
  assert.ok(migration.includes('stock_selection_request_bindings'), '缺少请求绑定表');
  assert.ok(repository.includes('findStockSelectionRequestBinding'), '缺少请求绑定查询');
  assert.ok(repository.includes('ON CONFLICT DO NOTHING'), '请求绑定必须原子去重');
  assert.ok(migrations.includes("193_stock_selection_ux_request_bindings"), '迁移未注册');
});

const pass = results.filter(item => item[0] === 'PASS').length;
const fail = results.length - pass;
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
