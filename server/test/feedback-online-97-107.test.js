// 2026-11-25 线上反馈 #97/#98/#99/#100/#101–#107 的定向回归。
// 仅覆盖本批次改动的静态契约与可离线验证的 DOM/纯函数行为；
// 真实浏览器、真机与生产数据不在本文件范围。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name + ' —— ' + (err && err.message ? err.message : err));
  }
}

(async () => {
  console.log('--- 线上反馈 #97/#98/#99/#100/#101–#107 ---');

  // ---------------- #97 创建场次“加载可用窗口”超时 ----------------
  await test('#97 创建场次接口使用长任务超时，不再被默认 30s 误判为请求超时', () => {
    const api = read('public/js/api/classroom-api.js');
    const optionsBlock = api.slice(api.indexOf('adminCreationOptions'), api.indexOf('adminSample'));
    assert.ok(/timeoutMs:\s*120000/.test(optionsBlock), 'creation-options 必须使用 120s 长任务超时');
    const precheckBlock = api.slice(api.indexOf('adminPrecheck'), api.indexOf('adminList'));
    assert.ok(/timeoutMs:\s*120000/.test(precheckBlock), '预检接口同样属于长任务');
  });

  await test('#97 可用窗口逐窗口复用基础事实，并在凑够 4 个合格行业后提前停止', () => {
    const service = read('server/services/classroomPrecheckService.js');
    assert.ok(service.includes('fetchCreationWindowBase'), '必须一次性取得共享数据版本/转债校准样本');
    assert.ok(service.includes('sharedBase,'), '逐窗口核验必须传入共享基础事实');
    assert.ok(service.includes('stopAfterQualifiedIndustries: 4'), '可用窗口只需证明 ≥4 个合格一级行业');
    assert.ok(service.includes('skipIndustriesWhenWindowBlocked: true'), '公共门禁已失败的窗口不得再核验个股');
    assert.ok(service.includes('qualifiedTarget > 0 && countEnabledIndustries() >= qualifiedTarget'), '凑够合格行业后必须提前跳出');
    const repo = read('server/repositories/classroomRepository.js');
    assert.ok(repo.includes('async function fetchCreationWindowBase'), '仓储必须提供共享基础事实入口');
  });

  await test('#97 多个候选窗口只计算一次数据版本与转债校准样本', async () => {
    const repo = require('../repositories/classroomRepository');
    const service = require('../services/classroomPrecheckService');
    const originals = {};
    const patch = (name, fn) => {
      originals[name] = repo[name];
      repo[name] = fn;
    };
    const years = [];
    for (let year = 2005; year <= 2025; year++) {
      years.push({ year, cnt: 250, first_date: `${year}-01-04`, last_date: `${year}-12-31` });
    }
    let baseCalls = 0;
    let windowSnapshotCalls = 0;
    patch('fetchAvailableSseYears', async () => years);
    patch('withReadOnlySnapshot', async (fn) => fn({}));
    patch('fetchCreationWindowBase', async () => {
      baseCalls++;
      return { dataVersion: 'facts-test', cbStats: { cnt: 0 }, cbBuckets: [] };
    });
    patch('fetchCnOpenTradeDates', async () => { windowSnapshotCalls++; return []; });
    patch('fetchCnCalendarSummaryByYear', async () => []);
    patch('fetchBondWealthIndexSeries', async () => []);
    try {
      const out = await service.getCreationOptions({ now: new Date('2026-11-24T10:00:00+08:00') });
      assert.ok(windowSnapshotCalls > 1, '本用例必须覆盖多个候选窗口');
      assert.strictEqual(baseCalls, 1, '数据版本与转债校准样本必须只计算一次，不得逐窗口重复全表扫描');
      assert.deepStrictEqual(out.availableWindows, [], '日历/国债/转债门禁不通过时不得声明可用窗口');
    } finally {
      Object.keys(originals).forEach((name) => { repo[name] = originals[name]; });
    }
  });

  // ---------------- #98 进入下一轮后页面跳回顶部 ----------------
  await test('#98 教师端刷新保留滚动位置，且刷新时不隐藏面板导致高度塌陷', () => {
    const js = read('public/js/classroom.js');
    assert.ok(js.includes('function captureScrollPosition'), '必须提供滚动位置捕获');
    assert.ok(js.includes('function restoreScrollPosition'), '必须提供滚动位置恢复');
    assert.ok(js.includes('const hadContent = Boolean(state.teacherData)'), '刷新前必须判断是否已有面板内容');
    assert.ok(js.includes('if (!hadContent) {'), '只有首次打开/切换场次才清空并隐藏面板');
    assert.ok(/loadTeacherDetail\(\{ preserveScroll: true \}\)/.test(js), '轮次切换/锁单/开盘/实时刷新必须保留滚动位置');
    assert.ok(js.includes('finally {') && js.includes('restoreScrollPosition(scrollPos);'), '异常路径也要恢复滚动');
  });

  await test('#98 进入下一轮、锁单、开盘后滚动位置不变（jsdom 行为回归）', async () => {
    const html = read('public/classroom.html');
    const dom = new JSDOM(html, { url: 'http://127.0.0.1/classroom.html?view=teacher', runScripts: 'outside-only' });
    const { window } = dom;
    const ctx = dom.getInternalVMContext();
    window.requestAnimationFrame = (cb) => { cb(); return 1; };
    let scroll = { x: 0, y: 0 };
    Object.defineProperty(window, 'scrollX', { get: () => scroll.x, configurable: true });
    Object.defineProperty(window, 'scrollY', { get: () => scroll.y, configurable: true });
    window.scrollTo = (x, y) => { scroll = { x: Number(x) || 0, y: Number(y) || 0 }; };
    window.confirm = () => true;

    let roundStatus = 'revealed';
    let roundNo = 2;
    const statePayload = () => ({
      classroom: { classroomId: 7, title: '测试场次', classroomCode: 'ABC123', totalRounds: 15, stateVersion: 10, status: 'active', blindMode: false, identityRevealed: true },
      joinUrl: 'http://x/classroom.html?code=ABC123',
      qrDataUrl: '',
      round: {
        roundNo, calendarYear: 2013, status: roundStatus, stateVersion: 1,
        marketHeaderTitle: '市场总体', showIndexLevel: false, marketPeDisplay: '18.0 倍', marketPbDisplay: '2.0 倍',
        assets: [{ industryName: '能源', alias: '股票A', stockName: '真实A', peDisplay: '10.0', pbDisplay: '1.2', returnRate: 1.5 }],
      },
      counts: { totalMembers: 1, eligibleCount: 1, submittedCount: 1, unsubmittedCount: 0 },
      participants: [{ memberId: 1, displayNickname: '测试号', isNicknameMasked: false, classroomNickname: '测试号', submitStatus: 'submitted', eligibleThisRound: true }],
      settlements: [],
      roundHistoryLeaderboards: [],
      settledRounds: [1],
    });

    window.classroomApi = {
      getMe: async () => ({ username: 'admin', role: 'admin', accountIdentity: 'admin' }),
      adminList: async () => ({ items: [{ classroom_id: 7, title: '测试场次', classroom_code: 'ABC123', current_round: 2, status: 'active', member_count: 1 }], total: 1, page: 1, totalPages: 1 }),
      adminGetState: async () => statePayload(),
      adminOpenRound: async () => { roundNo += 1; roundStatus = 'configuring'; return {}; },
      adminLockRound: async () => { roundStatus = 'locked'; return {}; },
      openEventStream: () => ({ readyState: 1, addEventListener() {}, close() {} }),
    };
    vm.runInContext(read('public/js/presenters/classroom-presenter.js'), ctx);
    vm.runInContext(read('public/js/classroom.js'), ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const panel = window.document.getElementById('teacher-active-panel');
    const nav = window.document.getElementById('cr-main-tabs');
    const teacherTab = [...nav.querySelectorAll('button')].find((btn) => btn.textContent.includes('教师控制台'));
    assert.ok(teacherTab, '教师控制台标签必须存在');
    teacherTab.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listBtn = [...window.document.querySelectorAll('#teacher-classroom-list button')]
      .find((btn) => btn.textContent.includes('测试场次'));
    assert.ok(listBtn, '场次列表按钮必须存在');
    listBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(panel.hidden, false, '打开场次后教师面板必须显示');

    // 进入下一轮：从 revealed 点击“进入第 3 轮”
    scroll.y = 640;
    const nextBtn = [...panel.querySelectorAll('button')].find((btn) => btn.textContent.includes('进入第 3 轮'));
    assert.ok(nextBtn, '已揭晓轮次必须提供“进入下一轮”按钮');
    let hiddenDuringRefresh = false;
    const observer = new window.MutationObserver(() => {
      if (panel.hidden) hiddenDuringRefresh = true;
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    nextBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    observer.disconnect();
    assert.strictEqual(hiddenDuringRefresh, false, '轮次切换刷新期间不得隐藏面板（会清空页面高度导致跳顶）');
    assert.strictEqual(window.scrollY, 640, '进入下一轮后滚动位置必须保持');

    // 锁单刷新同样保持位置
    scroll.y = 512;
    const lockBtn = [...panel.querySelectorAll('button')].find((btn) => btn.textContent === '锁单');
    assert.ok(lockBtn, '配置中必须提供锁单按钮');
    lockBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.strictEqual(window.scrollY, 512, '锁单/重绘后滚动位置必须保持');
    dom.window.close();
  });

  // ---------------- #99 提交后教师端人数不同步 + 金额弹窗按钮排版 ----------------
  await test('#99 学生提交后服务端广播 state_change，并在教师状态中计入已提交', () => {
    const service = read('server/services/classroomService.js');
    assert.ok(service.includes('reason: \'submission\''), '提交广播必须带 submission 原因');
    assert.ok(service.includes('sseHub.broadcastStateChange(classroomId, committed.broadcastState)'), '事务提交后必须广播');
    const hub = read('server/services/classroomSseHub.js');
    assert.ok(hub.includes("reason: String(payload.reason || 'state')"), 'SSE 帧必须保留 reason');
    const js = read('public/js/classroom.js');
    assert.ok(js.includes('function connectTeacherSse'), '教师端必须订阅同场次 SSE');
    assert.ok(js.includes('scheduleTeacherDetailRefresh'), '收到事件后必须重新加载教师状态');
    assert.ok(js.includes('function startTeacherFallbackPolling'), 'SSE 不可用时必须有兜底轮询');
  });

  await test('#99 金额弹窗“确定/取消”右对齐且等分铺满整行（>=44px）', () => {
    const html = read('public/classroom.html');
    assert.ok(/class="classroom-btn-group sheet-actions"[\s\S]*sheet-confirm-btn[\s\S]*sheet-cancel-btn/.test(html), '弹窗操作区必须使用 sheet-actions');
    const css = read('public/css/classroom.css');
    const rule = css.match(/\.sheet-actions\s*\{[^}]*\}/);
    assert.ok(rule, '缺少 .sheet-actions 样式');
    assert.ok(/justify-content:\s*flex-end/.test(rule[0]), '操作区必须右对齐');
    assert.ok(/width:\s*100%/.test(rule[0]), '操作区必须铺满整行');
    const btnRule = css.match(/\.sheet-actions \.cr-btn\s*\{[^}]*\}/);
    assert.ok(btnRule && /flex:\s*1 1 0/.test(btnRule[0]), '两个按钮必须等分平铺');
    assert.ok(/min-height:\s*44px/.test(btnRule[0]), '移动端触控高度不得低于 44px');
  });

  // ---------------- #101 后台业务执行结果大白话 ----------------
  await test('#101 选股结果渲染为中文分项，原始 JSON 折叠在 details 中', () => {
    const adminSrc = read('public/js/admin.js');
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      window: {},
      document: {
        getElementById: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
      },
      checkAuth: async () => false,
      escapeHtml: (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    };
    vm.runInNewContext(
      adminSrc + '\n;globalThis.__jobTest = { formatJobDetail, renderJobResultHtml, translateJobText };',
      sandbox
    );
    const api = sandbox.__jobTest;
    const summary = {
      mode: 'selection_daily',
      market: 'HK',
      runId: 517,
      reason: 'selection_not_ready',
      status: 'partial',
      qualityStatus: 'partial',
      businessStatus: 'insufficient_data',
      pendingCount: 3,
      pendingStages: ['selection_period_computation'],
      qualityReasons: ['pending_objects_in_ranking_pool'],
      waitReason: 'selection_not_ready',
      continuationRequired: true,
      nextCheckAt: '2026-11-25T14:00:00Z',
      datasetDiagnostics: { selection_daily_hk: { partition_row_count: 30, quality_status: 'partial', query_status: 'success', coverage_status: 'preview_only' } },
    };
    const text = api.formatJobDetail(summary, 4000);
    assert.ok(text.includes('任务模式：日度选股'), 'mode 必须翻译为日度选股');
    assert.ok(text.includes('市场：港股'), 'market 必须翻译为港股');
    assert.ok(text.includes('执行编号：517'), '执行编号必须保留可核对数字');
    assert.ok(text.includes('执行原因：选股数据尚未就绪'), 'selection_not_ready 必须翻译');
    assert.ok(text.includes('状态：部分完成'), 'partial 状态必须翻译');
    assert.ok(text.includes('数据质量：部分可用'), '质量状态必须使用业务语言');
    assert.ok(text.includes('业务状态：数据不足'), '业务状态必须使用业务语言');
    assert.ok(text.includes('待完成步骤：报告期选股计算'), '阶段码必须翻译');
    assert.ok(text.includes('影响质量的原因：排名池中仍有待补对象'), '质量原因码必须翻译');
    assert.ok(!text.includes('任务信息'), '不得再出现满屏「任务信息」占位标签');
    assert.ok(!/selection_not_ready|pending_objects_in_ranking_pool|selection_period_computation/.test(text), '不得直接暴露英文内部码');

    const html = api.renderJobResultHtml(summary);
    assert.ok(html.includes('<ul class="job-result-list">'), '业务结果必须分项列表展示');
    assert.ok(html.includes('<details class="job-result-raw">'), '原始技术详情必须折叠');
    assert.ok(html.includes('查看原始技术详情'), '折叠标题必须可读');
    assert.ok(html.includes('&quot;mode&quot;') || html.includes('"mode"'), '原始 JSON 必须可在 details 中查看');
    assert.ok(!html.includes('任务信息'), '分项列表不得出现「任务信息」');
    assert.ok(!/selection_not_ready/.test(html.replace(/<pre>[\s\S]*?<\/pre>/g, '')), '折叠区之外不得暴露内部码');
  });

  await test('#101 其他常见任务结果同样使用中文分项（收盘/净值/IPO/可转债）', () => {
    const adminSrc = read('public/js/admin.js');
    const sandbox = {
      console, setTimeout, clearTimeout, window: {},
      document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
      checkAuth: async () => false,
      escapeHtml: (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    };
    vm.runInNewContext(adminSrc + '\n;globalThis.__jobTest = { formatJobDetail };', sandbox);
    const samples = [
      { reason: 'scheduled', market: 'CN', status: 'succeeded', inserted: 12, refreshed: 3, missing_records: 0 },
      { targetDate: '2026-11-24', accounts: 2, recorded: 2, incomplete: false, reason: 'no_missing' },
      { window_start: '2026-11-24', window_end: '2026-11-24', pending: 0, failed: 0, attempted: 5, updated: 5 },
      { caseId: 'INC-1', parse_pending: 2, parse_exhausted: 0, status: 'partial' },
    ];
    for (const sample of samples) {
      const text = sandbox.__jobTest.formatJobDetail(sample, 1000);
      assert.ok(text && !text.includes('任务信息'), '常见任务结果不得出现「任务信息」：' + JSON.stringify(sample));
      assert.ok(!/pending_objects|selection_/.test(text), '不得暴露内部原因码');
    }
  });

  // ---------------- #100 港股分析外币展示与汇率折算 ----------------
  await test('#100 HKD 市值 + CNY/USD 财报按已落库汇率折算；缺汇率才留空并写明币种', () => {
    const hk = require('../services/hkSecurityAnalysis');
    const valuations = [{ trade_date: '20251101', close: 10, adj_factor: 1, pe_ttm: 9, pb: 1.1, total_mv: 10000, dv_ttm: 0, total_share: 1000 }];
    const cnyFacts = [{
      period_end: '2025-12-31', period_type: 'annual', statement_scope: 'consolidated', currency: 'CNY', source_version: 'v1',
      report_ids: [{ kind: 'income', report_id: 1 }, { kind: 'balance', report_id: 2 }],
      profit: 10000000, equity: 50000000, goodwill: 0, currency_unverified: false,
    }];
    const build = (facts, fxToCny) => hk.buildHkAnalysis({
      meta: { name: '中国中药', list_date: '19930407', currency: 'HKD' },
      valuations, dividends: [], events: [], reportFacts: facts, fxToCny,
    }, { tsCode: '00570.HK', today: '20251101' });

    const cny = build(cnyFacts, { HKD: 0.92, USD: 7.1 });
    assert.ok(Math.abs(cny.valuation.pe_static - 9.2) < 1e-9, 'CNY 利润必须按 HKD→CNY 折算后再除 HKD 市值');
    assert.strictEqual(cny.display.currency, 'HKD');
    assert.strictEqual(cny.display.report_currency, 'CNY');
    assert.ok(cny.display.currency_note.includes('财报币种：人民币 (CNY)'), '页面顶部必须能读到交易/财报币种说明');
    assert.strictEqual(cny.stability.years[0].profit_currency, 'HKD', '十年盈利图必须与分红同币种');

    const usd = build([{ ...cnyFacts[0], currency: 'USD', profit: 1000000 }], { HKD: 0.92, USD: 7.1 });
    assert.ok(usd.valuation.pe_static > 0, 'USD 财报必须走 USD→CNY 与 HKD→CNY 交叉折算');

    const missing = build(cnyFacts, {});
    assert.strictEqual(missing.valuation.pe_static, null, '真缺汇率时不得把 HKD 市值直接除以 CNY 利润');
    assert.strictEqual(missing.display.field_status.pe_static.reason, 'fx_rate_missing');

    const hkd = build([{ ...cnyFacts[0], currency: 'HKD' }], {});
    assert.ok(hkd.valuation.pe_static > 0, '同币种 HKD 不依赖汇率');

    const src = read('server/services/hkSecurityAnalysis.js');
    assert.ok(src.includes("readLatestRatePairUpTo({ baseCurrency: 'HKD', quoteCurrency: 'CNY'"), '汇率读取必须匹配仓储对象签名');
    assert.ok(!/readLatestRatePairUpTo\('HKD'/.test(src), '三位置参数会静默返回空，不得再出现');
    const chart = read('public/js/stock-analysis-chart.js');
    assert.ok(!chart.includes("+'亿元'") && chart.includes('stockAnalysisMoney(n,chartCurrency)'), '图表金额必须按交易币种展示');
  });

  // ---------------- #102 报告期类型 unknown 的入库与读端归一化 ----------------
  await test('#102 官方报告类型别名与同公司财年锚点可识别 unknown 中报，且冲突时不猜', () => {
    const period = require('../domain/financialReportPeriod');
    assert.strictEqual(period.normalizeFinancialPeriodType('semi-annual'), 'semiannual');
    assert.strictEqual(period.normalizeFinancialPeriodType('中报'), 'semiannual');
    assert.strictEqual(period.normalizeFinancialPeriodType('三季报'), 'q3');
    assert.strictEqual(period.normalizeFinancialPeriodType('年度报告'), 'annual');
    assert.strictEqual(period.normalizeFinancialPeriodType('unknown'), null);

    const anchors = period.fiscalYearEndAnchors([
      { periodEnd: '2025-12-31', periodType: 'annual' },
      { periodEnd: '2024-12-31', periodType: 'annual' },
    ]);
    assert.strictEqual(period.inferFinancialPeriodType('2026-06-30', anchors), 'semiannual');
    assert.strictEqual(period.inferFinancialPeriodType('2026-09-30', anchors), 'q3');
    assert.strictEqual(period.inferFinancialPeriodType('2026-03-31', anchors), 'q1');
    assert.strictEqual(period.inferFinancialPeriodType('2026-05-31', anchors), null, '非标准报告期不得猜测');
    const conflicting = [{ month: 12, day: 31 }, { month: 6, day: 30 }];
    assert.strictEqual(period.inferFinancialPeriodType('2026-06-30', conflicting), null, '多个财年锚点结论冲突时保持未知');

    const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
    assert.strictEqual(adapter.periodTypeOfReportType('semi-annual'), 'semiannual', '入库映射必须复用统一归一化');
    const adapterSrc = read('server/dataAccess/adapters/lixingerDatasetAdapter.js');
    assert.ok(adapterSrc.includes('inferFinancialPeriodType') && adapterSrc.includes('fiscalYearEndAnchors'),
      '入库侧必须用同批 annual 财年锚点识别 reportType 缺失的中报');
  });

  await test('#102 选股读端把 unknown 中报识别为半年报并计算同比，不回落旧年报', async () => {
    const repo = require('../repositories/stockSelectionRepository');
    const { pool } = require('../db/connection');
    const original = pool.query;
    const balanceRows = [{ company_id: '1', report_id: 11, period_end: '2026-06-30', total_assets: '100', total_liabilities: '40', assets_currency: 'HKD', liabilities_currency: 'HKD', currency_unverified: false }];
    const incomeRows = [
      { company_id: '1', report_id: 21, period_end: '2026-06-30', period_type: 'unknown', report_period_label: null, net_profit: '50', currency_code: 'HKD', currency_unverified: false },
      { company_id: '1', report_id: 22, period_end: '2025-12-31', period_type: 'annual', report_period_label: 'annual_report', net_profit: '100', currency_code: 'HKD', currency_unverified: false },
      { company_id: '1', report_id: 23, period_end: '2025-06-30', period_type: 'unknown', report_period_label: null, net_profit: '40', currency_code: 'HKD', currency_unverified: false },
      { company_id: '2', report_id: 24, period_end: '2026-06-30', period_type: 'unknown', report_period_label: null, net_profit: '10', currency_code: 'HKD', currency_unverified: false },
    ];
    let incomeSql = '';
    pool.query = async (sql) => {
      if (/total_assets/.test(sql)) return { rows: balanceRows };
      if (/net_profit_parent/.test(sql)) { incomeSql = sql; return { rows: incomeRows }; }
      return { rows: [] };
    };
    try {
      const map = await repo.loadMemberFundamentals({ companyIds: [1, 2], asOfDate: '2026-09-30', market: 'HK' });
      assert.ok(incomeSql.includes("r.period_type = 'unknown'"), '读端必须把 unknown 记录纳入再用标签/财年锚点识别');
      assert.strictEqual(map.get('1').latestProfitPeriodEnd, '2026-06-30', '02314 同类场景必须展示最新中报报告期');
      assert.ok(Math.abs(map.get('1').latestProfitYoy - 0.25) < 1e-12, '上年同期按同一有效报告期匹配');
      assert.strictEqual((map.get('2') || {}).latestProfitPeriodEnd || null, null, '没有可靠财年锚点时不得把 unknown 猜成半年报');
    } finally {
      pool.query = original;
    }
  });

  // ---------------- #103 可转债评级 sti 后缀归一化 ----------------
  await test('#103 AAAsti/AA+sti/AA-sti/AAsti/A+sti/A-sti/BBB+sti 统一归一化并用于折现率', () => {
    const { normalizeBondRating } = require('../domain/bondRating');
    const expected = { AAAsti: 'AAA', 'AA+sti': 'AA+', 'AA-sti': 'AA-', AAsti: 'AA', 'A+sti': 'A+', 'A-sti': 'A-', 'BBB+sti': 'BBB+' };
    Object.entries(expected).forEach(([raw, normalized]) => {
      assert.strictEqual(normalizeBondRating(raw), normalized, raw + ' 必须归一化为 ' + normalized);
    });
    assert.strictEqual(normalizeBondRating(' aa+ STI '), 'AA+', '必须大小写不敏感并去掉空白');
    assert.strictEqual(normalizeBondRating('无评级'), '无评级', '未知值不得被猜测改写成标准等级');

    const dropdown = new Set(['AAAsti', 'AA+sti', 'AA-sti', 'AAsti', 'A+sti', 'A-sti', 'BBB+sti'].map(normalizeBondRating));
    assert.deepStrictEqual([...dropdown].sort(), ['A+', 'A-', 'AA', 'AA+', 'AA-', 'AAA', 'BBB+'], '全部评级下拉不得再出现 *sti');
    assert.strictEqual(require('../services/convertibleBondAnalysis').creditDiscountRate('AAsti'), 0.036);
    assert.strictEqual(require('../services/convertibleBondAnalysis').creditDiscountRate('AA+sti'), 0.032);

    const listService = read('server/services/convertibleBondListService.js');
    assert.ok(listService.includes('normalizeBondRating(row.newest_rating || row.issue_rating)'), '列表读端必须归一化评级');
    const store = read('server/services/convertibleBondAnalysisStore.js');
    assert.ok(store.includes('const issueRating = normalizeBondRating(profile.issue_rating)'), '写入侧必须归一化 issue_rating');
    assert.ok(store.includes('normalizeBondRating(row.rating)'), '评级历史写入必须归一化');
    const py = read('ipo-report/bond_data_layer.py');
    assert.ok(py.includes('def normalize_credit_rating'), 'Python 入库链路必须提供同一归一化函数');
  });

  // ---------------- #104 三表报告期、重复科目 ----------------
  await test('#104 季报口径包含 Q1/半年报/Q3/年报；分组标题不与科目同名', () => {
    const pres = require('../domain/statementPresentation');
    const rule = (rep) => ({
      group_path: '营业总收入', row_role: 'subtotal', parent_code: null,
      evidence_status: 'unverified', rep_group: rep, rule_version: '2026-11-23',
    });
    const metrics = [
      { code: 'ps.toi', statement: 'income', name: '营业总收入', context_rules: [{ rule: rule('营业总收入') }, { rule: rule(null) }] },
      { code: 'ps.oi', statement: 'income', name: '营业收入', context_rules: [{ rule: rule(null) }] },
    ];
    const fields = [
      { code: 'ps.toi', label: '营业总收入', section: '营业总收入', values: [{ value: 10, status: 'available' }] },
      { code: 'ps.oi', label: '营业收入', section: '营业总收入', values: [{ value: 9, status: 'available' }] },
    ];
    const model = pres.buildStatementPresentation(fields, { metrics, statement: 'income' });
    assert.deepStrictEqual(model.rows.map((row) => row.kind + ':' + (row.label || row.code)), [
      'field:ps.toi', 'field:ps.oi',
    ], '#104: 第一个科目已叫「营业总收入」时不得再补一条同名分组标题');
    assert.strictEqual(model.rows[0].is_group_rep, true, '同名科目应承担分组代表行');

    const service = read('server/services/stockStatementService.js');
    assert.ok(service.includes("['q1', 'semiannual', 'q3', 'annual']"), '#104: 季报必须覆盖全部四类季度粒度报告');
    const view = read('public/js/stock-analysis-statements.js');
    assert.ok(!/value: 'all', label: '全部'/.test(view), '#104: 下拉不得再提供「全部」');
    assert.ok(/value: 'quarter'/.test(view) && view.includes("? currentPeriod : 'quarter'"), '#104: 默认报告期必须是季报');
    const presenter = read('public/js/presenters/stock-analysis-statements-presenter.js');
    assert.ok(presenter.includes("periodType:'quarter'"), '#104: Presenter 状态默认季报');
  });

  // ---------------- #105 / #106 / #107 三表视觉与格式化 ----------------
  await test('#105 整行分组标题横跨整行且禁止折行', () => {
    const view = read('public/js/stock-analysis-statements.js');
    assert.ok(/class="statement-section-cell statement-section-title"[^>]*>/.test(view) || view.includes("statement-section-cell statement-section-title"), '#105: 分组标题必须使用独占整行的样式');
    assert.ok(view.includes("colspan=\"' + columnCount + '\""), '#105: 分组标题必须 colspan 整行');
    const css = read('public/css/stock-analysis.css');
    assert.ok(/\.statement-section-title\{[^}]*white-space:nowrap/.test(css), '#105: 分组标题必须 nowrap');
  });

  await test('#106 左侧科目名称列与表头首列左对齐', () => {
    const css = read('public/css/stock-analysis.css');
    assert.ok(css.includes('.stock-analysis-statements-table tbody th{text-align:left}'), '#106: 科目名称列必须左对齐');
    assert.ok(/\.stock-analysis-statements-table \.statement-col-corner\{[^}]*text-align:left/.test(css), '#106: 表头首列必须左对齐');
  });

  await test('#107 占比变动使用百分号而非英文 pct', () => {
    const view = read('public/js/stock-analysis-statements.js');
    assert.ok(!/['"]\s*pct['"]/.test(view), '#107: 不得再拼接英文 pct');
    assert.ok(view.includes("Math.abs(num).toFixed(2) + '%'"), '#107: 百分点差值必须以 % 结尾');
    assert.ok(view.includes('占比较上期变动（百分点）'), '#107: 提示文案必须说明百分点口径');
  });

  // ================= 首轮验收 F-01 ~ F-08 反例回归 =================

  await test('F-01 公共门禁失败的 7 个窗口在冷启动路径下不得发起任何候选股票查询', async () => {
    const repo = require('../repositories/classroomRepository');
    const service = require('../services/classroomPrecheckService');
    const originals = {};
    const patch = (name, fn) => { originals[name] = repo[name]; repo[name] = fn; };
    const years = [];
    for (let year = 2005; year <= 2025; year++) {
      years.push({ year, cnt: 250, first_date: `${year}-01-04`, last_date: `${year}-12-31` });
    }
    let baseCalls = 0;
    let candidateCalls = 0;
    let industryTreeCalls = 0;
    patch('fetchAvailableSseYears', async () => years);
    patch('withReadOnlySnapshot', async (fn) => fn({}));
    patch('fetchCreationWindowBase', async () => {
      baseCalls++;
      return { dataVersion: 'facts-f01', cbStats: { cnt: 0 }, cbBuckets: [] };
    });
    patch('fetchCnOpenTradeDates', async (startDate, endDate) => {
      const startYear = Number(String(startDate).slice(0, 4));
      const endYear = Number(String(endDate).slice(0, 4));
      const dates = [];
      for (let y = startYear; y <= endYear; y++) dates.push(`${y}-01-04`, `${y}-06-30`, `${y}-12-31`);
      return dates;
    });
    patch('fetchCnCalendarSummaryByYear', async () => []);
    patch('fetchBondWealthIndexSeries', async () => []);
    patch('fetchSw2021IndustryTree', async () => { industryTreeCalls++; return []; });
    patch('fetchCnStockCandidatesForWindow', async () => { candidateCalls++; return []; });
    try {
      const out = await service.getCreationOptions({ now: new Date('2026-11-24T10:00:00+08:00') });
      assert.strictEqual(baseCalls, 1, '共享基础事实仍应只取一次');
      assert.strictEqual(out.availableWindows.length, 0, '公共门禁失败的窗口不得声明可用');
      assert.ok(out.windowDiagnostics.length >= 7, '必须覆盖 7 个具备首尾交易日的候选窗口');
      assert.strictEqual(candidateCalls, 0, '日历/国债/转债门禁失败后不得再发起候选股票查询');
      assert.strictEqual(industryTreeCalls, 0, '公共门禁失败后也不得读取 SW2021 行业树');
    } finally {
      Object.keys(originals).forEach((name) => { repo[name] = originals[name]; });
    }
  });

  await test('F-02 旧场次迟到响应不得覆盖新场次，也不得恢复旧滚动位置', async () => {
    const dom = new JSDOM(read('public/classroom.html'), { url: 'http://127.0.0.1/classroom.html?view=teacher', runScripts: 'outside-only' });
    const { window } = dom;
    const ctx = dom.getInternalVMContext();
    window.requestAnimationFrame = (cb) => { cb(); return 1; };
    let scroll = { x: 0, y: 0 };
    Object.defineProperty(window, 'scrollX', { get: () => scroll.x, configurable: true });
    Object.defineProperty(window, 'scrollY', { get: () => scroll.y, configurable: true });
    window.scrollTo = (x, y) => { scroll = { x: Number(x) || 0, y: Number(y) || 0 }; };
    window.confirm = () => true;

    const payload = (id, submitted) => ({
      classroom: { classroomId: id, title: id === 7 ? '旧场次' : '新场次', classroomCode: 'C' + id, totalRounds: 15, stateVersion: 10, status: 'active', blindMode: false, identityRevealed: true },
      joinUrl: 'http://x/classroom.html?code=C' + id,
      qrDataUrl: '',
      round: {
        roundNo: 2, calendarYear: 2013, status: 'configuring', stateVersion: 1,
        marketHeaderTitle: '市场总体', showIndexLevel: false, marketPeDisplay: '18.0 倍', marketPbDisplay: '2.0 倍', assets: [],
      },
      counts: { totalMembers: 1, eligibleCount: 1, submittedCount: submitted, unsubmittedCount: Math.max(0, 1 - submitted) },
      participants: [{ memberId: 1, displayNickname: '测试号', isNicknameMasked: false, classroomNickname: '测试号', submitStatus: submitted ? 'submitted' : 'pending', eligibleThisRound: true }],
      settlements: [], roundHistoryLeaderboards: [], settledRounds: [],
    });
    const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
    const pending = [];
    window.classroomApi = {
      getMe: async () => ({ username: 'admin', role: 'admin', accountIdentity: 'admin' }),
      adminList: async () => ({ items: [
        { classroom_id: 7, title: '旧场次', classroom_code: 'C7', current_round: 2, status: 'active', member_count: 1 },
        { classroom_id: 8, title: '新场次', classroom_code: 'C8', current_round: 1, status: 'active', member_count: 1 },
      ], total: 2, page: 1, totalPages: 1 }),
      adminGetState: async (id) => {
        const n = Number(id);
        if (n === 7 && pending.length) return pending.shift().promise;
        return payload(n, 0);
      },
      adminOpenRound: async () => ({}),
      adminLockRound: async () => ({}),
      openEventStream: () => ({ readyState: 1, addEventListener() {}, close() {} }),
    };
    vm.runInContext(read('public/js/presenters/classroom-presenter.js'), ctx);
    vm.runInContext(read('public/js/classroom.js'), ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const panel = window.document.getElementById('teacher-active-panel');
    const teacherTab = [...window.document.getElementById('cr-main-tabs').querySelectorAll('button')].find((btn) => btn.textContent.includes('教师控制台'));
    teacherTab.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const listButton = (title) => [...window.document.querySelectorAll('#teacher-classroom-list button')].find((btn) => btn.textContent.includes(title));
    listButton('旧场次').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(panel.textContent.includes('旧场次'), '初始必须加载旧场次');

    // 旧场次在 500px 发起刷新，随后切到新场次并滚到 200px。
    scroll.y = 500;
    const oldReq = deferred();
    pending.push(oldReq);
    [...panel.querySelectorAll('button')].find((btn) => btn.textContent === '锁单').click();
    await new Promise((resolve) => setTimeout(resolve, 15));
    scroll.y = 200;
    listButton('新场次').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(panel.textContent.includes('新场次'), '切换后必须显示新场次');
    oldReq.resolve(payload(7, 5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(panel.textContent.includes('新场次'), '旧场次迟到响应不得覆盖新场次');
    assert.ok(!panel.textContent.includes('旧场次'), '旧场次内容不得回写');
    assert.strictEqual(window.scrollY, 200, '旧请求不得恢复旧场次的 500px 滚动位置');

    // 同场次并发请求：只有最新请求可渲染并恢复滚动位置。
    listButton('旧场次').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    scroll.y = 500;
    const reqA = deferred();
    pending.push(reqA);
    [...panel.querySelectorAll('button')].find((btn) => btn.textContent === '锁单').click();
    await new Promise((resolve) => setTimeout(resolve, 15));
    scroll.y = 200;
    const reqB = deferred();
    pending.push(reqB);
    [...panel.querySelectorAll('button')].find((btn) => btn.textContent === '锁单').click();
    await new Promise((resolve) => setTimeout(resolve, 15));
    reqB.resolve(payload(7, 2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(panel.textContent.includes('已提交 2 人'), '最新请求必须渲染');
    assert.strictEqual(window.scrollY, 200, '最新请求恢复自己的 200px 位置');
    reqA.resolve(payload(7, 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(panel.textContent.includes('已提交 2 人'), '较早请求迟到不得覆盖最新渲染');
    assert.ok(!panel.textContent.includes('已提交 1 人'), '过期请求的人数不得回写');
    assert.strictEqual(window.scrollY, 200, '过期请求不得恢复自己的旧滚动位置');
    dom.window.close();
  });

  await test('F-03 SSE 重连、回到前台与补读失败后都必须补齐教师端提交人数', async () => {
    const dom = new JSDOM(read('public/classroom.html'), { url: 'http://127.0.0.1/classroom.html?view=teacher', runScripts: 'outside-only' });
    const { window } = dom;
    const ctx = dom.getInternalVMContext();
    window.requestAnimationFrame = (cb) => { cb(); return 1; };
    let scroll = { x: 0, y: 0 };
    Object.defineProperty(window, 'scrollX', { get: () => scroll.x, configurable: true });
    Object.defineProperty(window, 'scrollY', { get: () => scroll.y, configurable: true });
    window.scrollTo = (x, y) => { scroll = { x: Number(x) || 0, y: Number(y) || 0 }; };
    window.confirm = () => true;
    let hidden = false;
    Object.defineProperty(window.document, 'hidden', { get: () => hidden, configurable: true });
    Object.defineProperty(window.navigator, 'onLine', { get: () => true, configurable: true });

    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    const longTimers = new Map();
    let timerId = 5000;
    window.setTimeout = (fn, ms) => {
      if (Number(ms) >= 8000) { const id = timerId++; longTimers.set(id, fn); return id; }
      return realSetTimeout(fn, ms);
    };
    window.clearTimeout = (id) => {
      if (longTimers.has(id)) { longTimers.delete(id); return; }
      realClearTimeout(id);
    };

    let submittedCount = 0;
    let getStateCalls = 0;
    let failNext = 0;
    const payload = () => ({
      classroom: { classroomId: 7, title: '测试场次', classroomCode: 'ABC123', totalRounds: 15, stateVersion: 10, status: 'active', blindMode: false, identityRevealed: true },
      joinUrl: 'http://x/classroom.html?code=ABC123',
      qrDataUrl: '',
      round: { roundNo: 2, calendarYear: 2013, status: 'configuring', stateVersion: 1, marketHeaderTitle: '市场总体', showIndexLevel: false, marketPeDisplay: '18.0 倍', marketPbDisplay: '2.0 倍', assets: [] },
      counts: { totalMembers: 1, eligibleCount: 1, submittedCount, unsubmittedCount: Math.max(0, 1 - submittedCount) },
      participants: [{ memberId: 1, displayNickname: '测试号', isNicknameMasked: false, classroomNickname: '测试号', submitStatus: submittedCount ? 'submitted' : 'pending', eligibleThisRound: true }],
      settlements: [], roundHistoryLeaderboards: [], settledRounds: [],
    });
    let fakeEs = null;
    window.classroomApi = {
      getMe: async () => ({ username: 'admin', role: 'admin', accountIdentity: 'admin' }),
      adminList: async () => ({ items: [{ classroom_id: 7, title: '测试场次', classroom_code: 'ABC123', current_round: 2, status: 'active', member_count: 1 }], total: 1, page: 1, totalPages: 1 }),
      adminGetState: async () => {
        getStateCalls++;
        if (failNext > 0) { failNext--; throw new Error('network'); }
        return payload();
      },
      adminOpenRound: async () => ({}),
      adminLockRound: async () => ({}),
      openEventStream: () => {
        const handlers = {};
        fakeEs = {
          readyState: 1,
          addEventListener(name, fn) { (handlers[name] || (handlers[name] = [])).push(fn); },
          emit(name, ev) { (handlers[name] || []).slice().forEach((fn) => fn(ev || {})); },
          close() { this.readyState = 2; },
          onerror: null,
        };
        return fakeEs;
      },
    };
    vm.runInContext(read('public/js/presenters/classroom-presenter.js'), ctx);
    vm.runInContext(read('public/js/classroom.js'), ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const panel = window.document.getElementById('teacher-active-panel');
    [...window.document.getElementById('cr-main-tabs').querySelectorAll('button')].find((btn) => btn.textContent.includes('教师控制台')).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    [...window.document.querySelectorAll('#teacher-classroom-list button')].find((btn) => btn.textContent.includes('测试场次')).click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(panel.textContent.includes('已提交 0 人'), '初始人数为 0');
    assert.ok(fakeEs, '教师端必须建立 SSE');

    // 首次建连不重复补读；断线期间发生提交，重连时必须立即补读。
    fakeEs.emit('connected');
    const beforeReconnect = getStateCalls;
    fakeEs.onerror();
    submittedCount = 1;
    fakeEs.emit('connected');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(getStateCalls > beforeReconnect, 'SSE 重连后必须立即补读状态');
    assert.ok(panel.textContent.includes('已提交 1 人'), '断线期间提交的人数必须在重连后补齐');

    // 回到前台也要立即补读。
    hidden = true;
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const beforeVisible = getStateCalls;
    submittedCount = 2;
    hidden = false;
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(getStateCalls > beforeVisible, '回到前台必须补读教师状态');
    assert.ok(panel.textContent.includes('已提交 2 人'), '回到前台后人数必须更新');

    // 补读失败：必须继续排兜底轮询，下一次轮询成功后恢复。
    longTimers.clear();
    failNext = 1;
    submittedCount = 3;
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(longTimers.size >= 1, '补读失败后必须安排兜底轮询继续恢复');
    const retry = [...longTimers.values()][0];
    longTimers.clear();
    retry();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(panel.textContent.includes('已提交 3 人'), '兜底轮询成功后必须补齐人数');

    // 离开教师页必须关闭 SSE 并清理兜底轮询定时器。
    fakeEs.onerror();
    assert.ok(longTimers.size >= 1, '离开前应存在兜底轮询定时器');
    [...window.document.getElementById('cr-main-tabs').querySelectorAll('button')].find((btn) => btn.textContent.includes('课堂列表')).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(fakeEs.readyState, 2, '切换页面必须关闭教师端 SSE');
    assert.strictEqual(longTimers.size, 0, '切换页面必须清理兜底轮询定时器');
    dom.window.close();
  });

  await test('F-04 港股十年盈利图全缺/部分缺/真实零/已换汇四种场景', () => {
    const tooltipCalls = [];
    function render(years, history) {
      const element = {
        innerHTML: '',
        __tooltip: { innerHTML: '', style: {} },
        __show: null,
        querySelector(sel) {
          if (sel === '.stock-analysis-chart') return {};
          if (sel === '.stock-analysis-chart-tooltip') return this.__tooltip;
          return null;
        },
        querySelectorAll(sel) {
          return sel === '.year-hit' ? [{ getAttribute: () => '0' }] : [];
        },
      };
      const sandbox = {
        document: {
          getElementById: (id) => (id === 'stock-analysis-stability' ? element : null),
          querySelector: () => null,
          body: { appendChild() {} },
        },
        CoreDate: { todayInZone: () => '2026-11-25', subtractYears: () => '2016-11-25' },
        DateRangeControl: { render: () => '', bind() {} },
        ChartInteraction: { bind(hit, tip, show) { element.__show = show; } },
        BusinessTable: { attach() {} },
        escapeHtml: (v) => String(v),
        stockAnalysisNumber: (v) => String(v),
        stockAnalysisPercent: (v) => (v == null ? '--' : String(v)),
        stockAnalysisMoney: (v, c) => String(v) + ' ' + c,
        Math, Number, String, Array, Intl,
        stockAnalysisState: { data: { display: { currency: 'HKD' } } },
      };
      sandbox.window = sandbox;
      const context = vm.createContext(sandbox);
      vm.runInContext(read('public/js/stock-analysis-chart.js'), context);
      sandbox.stockAnalysisRenderStability(
        { years, dividend_history: history || [] },
        { start: '2015-01-01', end: '2026-12-31', activeYears: 10 }
      );
      return {
        html: element.innerHTML,
        tooltip() { if (element.__show) element.__show(); tooltipCalls.push(element.__tooltip.innerHTML); return element.__tooltip.innerHTML; },
      };
    }

    // 全缺：不得出现 0 HKD，不得画柱。
    const missing = render([{ year: '2025', profit: null, dividend: undefined, payout_ratio: null }], []);
    assert.ok(!/\b0 HKD/.test(missing.html), '未知利润/分红不得显示 0 HKD');
    assert.ok(!/<rect class="profit"/.test(missing.html), '未知利润不得画柱');
    assert.ok(!/<rect class="dividend"/.test(missing.html), '未知分红不得画柱');
    assert.ok(/--/.test(missing.html), '缺失值必须显示 --');
    const missingTip = missing.tooltip();
    assert.ok(!/\b0 HKD/.test(missingTip) && /--/.test(missingTip), '缺失值 tooltip 必须为 --，不能为 0 HKD');

    // 部分缺：有利润无分红。
    const partial = render([{ year: '2025', profit: 120, dividend: null, payout_ratio: null }], []);
    assert.ok(/120 HKD/.test(partial.html), '有值利润正常显示');
    assert.ok(!/\b0 HKD/.test(partial.html), '缺失分红不得显示 0 HKD');
    assert.ok(/<rect class="profit"/.test(partial.html), '有值利润必须画柱');
    assert.ok(!/<rect class="dividend"/.test(partial.html), '缺失分红不得画柱');
    const partialTip = partial.tooltip();
    assert.ok(/120 HKD/.test(partialTip) && !/\b0 HKD/.test(partialTip) && /--/.test(partialTip), '部分缺失 tooltip 必须保留有值项并显示 --');

    // 真实零：正常显示 0 HKD 并画柱。
    const zero = render(
      [{ year: '2025', profit: 0, dividend: 0, payout_ratio: 0 }],
      [{ year: '2025', ann_date: '2025-12-31', amount: 0, div_proc: '实施' }]
    );
    assert.ok(/0 HKD/.test(zero.html), '真实零必须显示 0 HKD');
    assert.ok(/<rect class="profit"/.test(zero.html) && /<rect class="dividend"/.test(zero.html), '真实零仍应画柱');
    assert.ok(/0 HKD/.test(zero.tooltip()), '真实零 tooltip 必须为 0 HKD');

    // 已换汇：HKD 单位显示且不出现亿元。
    const converted = render(
      [{ year: '2025', profit: 120, dividend: 30, payout_ratio: 0.25 }],
      [{ year: '2025', ann_date: '2025-12-31', amount: 30, div_proc: '实施' }]
    );
    assert.ok(/120 HKD/.test(converted.html) && /30 HKD/.test(converted.html), '已换汇数据必须按 HKD 显示');
    assert.ok(!/亿元/.test(converted.html), '港股图表不得出现亿元');
    assert.ok(/120 HKD/.test(converted.tooltip()) && /30 HKD/.test(converted.tooltip()), 'tooltip 同样按 HKD 显示');
  });

  await test('F-05 任务码整体精确匹配，repoDailyRates/analysis_inputs 及未登记子值不污染主列表', () => {
    const adminSrc = read('public/js/admin.js');
    const sandbox = {
      console, setTimeout, clearTimeout, window: {},
      document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
      checkAuth: async () => false,
      escapeHtml: (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    };
    vm.runInNewContext(adminSrc + '\n;globalThis.__jobTest = { formatJobDetail, renderJobResultHtml, translateJobText };', sandbox);
    const api = sandbox.__jobTest;
    const direct = api.translateJobText('stock_selection_daily_hk');
    assert.strictEqual(direct, '港股日度选股', '完整任务码必须整体翻译');
    assert.ok(!/stock_|selection_daily|stock_日度选股_hk/.test(direct), '不得把中间子串替换成 stock_日度选股_hk');

    const summary = {
      mode: 'selection_daily', market: 'HK',
      publishDatasetCodes: ['stock_selection_daily_hk', 'stock_selection_weekly_cn'],
      datasetCode: 'stock_selection_daily_hk',
      repoDailyRates: 123,
      analysis_inputs: 3,
      datasetDiagnostics: {
        stock_selection_daily_hk: { partition_row_count: 30, quality_status: 'partial', query_status: 'success', unknown_internal_field: 'foo_bar' },
      },
      unknownContainer: { mystery_field: 'secret_code' },
    };
    const detail = api.formatJobDetail(summary, 4000);
    assert.ok(detail.includes('港股日度选股'), '数据集代码必须翻译');
    assert.ok(detail.includes('A股周度选股'), '周度数据集代码必须翻译');
    assert.ok(detail.includes('逆回购日利率：123'), 'repoDailyRates 必须有中文名');
    assert.ok(detail.includes('可转债资料输入：3'), 'analysis_inputs 必须有中文名');
    assert.ok(!/stock_selection_|repoDailyRates|analysis_inputs|selection_daily_hk|stock_日度选股_hk/.test(detail), '主展示不得出现裸露内部码或半中半英');
    assert.ok(!/foo_bar|secret_code|unknown_internal_field|mystery_field/.test(detail), '未登记子字段不得进入主展示');

    const html = api.renderJobResultHtml(summary);
    const main = html.replace(/<details[\s\S]*$/, '');
    assert.ok(main.includes('港股日度选股') && main.includes('逆回购日利率'), '主列表必须展示中文结果');
    assert.ok(!/stock_selection_|stock_日度选股_hk|repoDailyRates|analysis_inputs|foo_bar|secret_code/.test(main), '主列表不得裸露内部码或未登记子值');

    // 相邻反例：repoDailyRates 子对象里的状态/原因码（non_trading_day 等）必须翻译，
    // 主列表不得裸露英文内部码（F-05 独立探针回归）。
    const reasonCases = {
      non_trading_day: '非交易日跳过',
      verified_no_change: '已核验无新增变化',
      circuit_open: '数据源接口临时熔断',
      rate_limited: '触发上游限流，等待恢复',
    };
    Object.keys(reasonCases).forEach((code) => {
      const withReason = { repoDailyRates: { status: 'skipped', reason: code, written: 0 } };
      const text = api.formatJobDetail(withReason, 2000);
      const rawMain = api.renderJobResultHtml(withReason).replace(/<details[\s\S]*$/, '');
      assert.ok(!new RegExp('\\b' + code + '\\b').test(text), 'formatJobDetail 原因码不得裸露：' + code);
      assert.ok(!new RegExp('\\b' + code + '\\b').test(rawMain), '主列表原因码不得裸露：' + code);
      assert.ok(text.includes(reasonCases[code]) || rawMain.includes(reasonCases[code]), '原因码必须翻译为中文：' + code);
    });
    assert.ok(!/non_trading_day|verified_no_change|circuit_open|rate_limited/.test(api.translateJobText(
      'repoDailyRates reason=non_trading_day, verified_no_change, circuit_open, rate_limited'
    )), '自由文本中的内部原因码也必须整体翻译');

    // 选股/收盘/净值/转债/IPO 五类实际结构的主列表都不得出现内部码。
    const samples = [
      { mode: 'selection_daily', market: 'CN', publishDatasetCodes: ['stock_selection_daily_cn'], datasetDiagnostics: { selection_daily_cn: { partition_row_count: 30, coverage_status: 'released' } } },
      { reason: 'scheduled', market: 'CN', status: 'succeeded', inserted: 12, refreshed: 3 },
      { targetDate: '2026-11-24', accounts: 2, recorded: 2, incomplete: false },
      { caseId: 'INC-1', parse_pending: 2, parse_exhausted: 0 },
      { window_start: '2026-11-24', window_end: '2026-11-24', pending: 0, failed: 0 },
    ];
    samples.forEach((sample) => {
      const text = api.formatJobDetail(sample, 1000);
      assert.ok(text && !/stock_selection_|selection_daily|repoDailyRates|analysis_inputs/.test(text), '五类结果主展示不得裸露内部码：' + JSON.stringify(sample));
    });
  });

  await test('F-07 利润表/现金流量表单季值 Q4/Q3/Q2/Q1=40/30/20/10，资产负债表无单季行', () => {
    const statementsScript = read('public/js/stock-analysis-statements.js');
    const periods = [
      { end_date: '2025-12-31', period_type: 'annual', report_type_label: 'annual_report', scope: 'consolidated', currency: 'CNY' },
      { end_date: '2025-09-30', period_type: 'q3', report_type_label: 'third_quarterly_report', scope: 'consolidated', currency: 'CNY' },
      { end_date: '2025-06-30', period_type: 'semiannual', report_type_label: 'semi_annual_report', scope: 'consolidated', currency: 'CNY' },
      { end_date: '2025-03-31', period_type: 'q1', report_type_label: 'first_quarterly_report', scope: 'consolidated', currency: 'CNY' },
    ];
    const values = [
      { value: 40, status: 'available', single_value: 40 },
      { value: 30, status: 'available', single_value: 30 },
      { value: 30, status: 'available', single_value: 20 },
      { value: 10, status: 'available', single_value: 10 },
    ];
    function render(type) {
      const dom = new JSDOM('<select id="stock-analysis-statement-period"></select><div id="stock-analysis-statements-title"></div><div id="stock-analysis-statements-meta"></div><div id="stock-analysis-statements-message"></div><div id="stock-analysis-statements-wrap"></div>');
      const view = {
        document: dom.window.document, window: dom.window,
        escapeHtml: (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
        stockAnalysisNumber: (v) => String(v), stockAnalysisPercent: (v) => String(v),
        stockAnalysisStatementFilters: () => ({ periodType: 'quarter', scope: 'consolidated' }),
        BusinessTable: { attach() {} },
      };
      vm.runInNewContext(statementsScript, view);
      view.stockAnalysisRenderStatements({
        name: type === 'balance' ? '资产负债表' : type === 'cashflow' ? '现金流量表' : '利润表',
        type, compare: 'none', unit_label: '原值', periods,
        fields: [{ code: type === 'cashflow' ? 'cfs.ncffoa' : 'ps.oi', label: '营业收入', measure_type: 'currency', section: '营业收入', values }],
      });
      return dom;
    }
    const income = render('income');
    assert.deepStrictEqual(
      [...income.window.document.querySelectorAll('tr.statement-subperiod-row td.statement-subperiod-val')].map((td) => td.textContent),
      ['40', '30', '20', '10'],
      '利润表单季行必须准确显示 Q4/Q3/Q2/Q1 单季值，不得出现 —/30/30/10'
    );
    const cashflow = render('cashflow');
    assert.deepStrictEqual(
      [...cashflow.window.document.querySelectorAll('tr.statement-subperiod-row td.statement-subperiod-val')].map((td) => td.textContent),
      ['40', '30', '20', '10'],
      '现金流量表单季行必须与利润表同口径'
    );
    const balance = render('balance');
    assert.strictEqual(balance.window.document.querySelector('.statement-subperiod-row'), null, '资产负债表不得出现单季行');
  });

  await test('F-07 非相邻同名分组标题必须去重（营业总收入 → 营业收入 → 分组 → 营业总成本）', () => {
    const pres = require('../domain/statementPresentation');
    const rule = (groupPath, repGroup) => ({
      group_path: groupPath, row_role: 'line', parent_code: null,
      evidence_status: 'unverified', rep_group: repGroup, rule_version: '2026-11-25',
    });
    const metrics = [
      { code: 'ps.toi', name: '营业总收入', context_rules: [{ rule: rule('营业总收入', '营业总收入') }] },
      { code: 'ps.oi', name: '营业收入', context_rules: [{ rule: rule('营业总收入 › 营业收入', '营业总收入 › 营业收入') }] },
      { code: 'ps.toc', name: '营业总成本', context_rules: [{ rule: rule('营业总收入 › 营业总收入', null) }] },
    ];
    const fields = [
      { code: 'ps.toi', label: '营业总收入', values: [{ value: 100 }] },
      { code: 'ps.oi', label: '营业收入', values: [{ value: 90 }] },
      { code: 'ps.toc', label: '营业总成本', values: [{ value: 80 }] },
    ];
    const model = pres.buildStatementPresentation(fields, { metrics, statement: 'income' });
    const fieldByCode = new Map(fields.map((f) => [f.code, f]));
    const labelOf = (row) => (row.kind === 'field' ? fieldByCode.get(row.code).label : row.label);
    assert.strictEqual(model.rows.filter((row) => labelOf(row) === '营业总收入').length, 1, '同一张表只能出现一次「营业总收入」');
    assert.strictEqual(model.rows.filter((row) => row.kind === 'section').length, 0, '与已渲染科目同名的分组标题必须移除');
    assert.deepStrictEqual(model.rows.map((row) => row.kind + ':' + labelOf(row)), [
      'field:营业总收入', 'field:营业收入', 'field:营业总成本',
    ]);
  });

  await test('F-08 表头首格在单/双固定列及悬浮表头下最终生效 text-align:left，第二列保持居中', () => {
    const css = read('public/css/stock-analysis.css') + '\n' + read('public/shared/style.css');
    const tableCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(/thead tr:first-child th:first-child:not\(\.statement-col-corner\)/.test(read('public/css/stock-analysis.css')),
      '表头第一格居中规则必须排除角落单元格');
    assert.ok(/thead th\.statement-col-corner\{[^}]*text-align:left/.test(read('public/css/stock-analysis.css').replace(/\s+/g, ' ')) ||
      /thead th\.statement-col-corner[^{]*\{[^}]*text-align:left/.test(read('public/css/stock-analysis.css')),
      '表头首格必须有更高优先级且明确左对齐');

    function specificity(selector) {
      let text = selector;
      let ids = 0;
      let classes = 0;
      let elements = 0;
      text = text.replace(/:not\(([^)]*)\)/g, (all, inner) => {
        const sub = specificity(inner);
        ids += sub[0]; classes += sub[1]; elements += sub[2];
        return ' ';
      });
      ids += (text.match(/#[\w-]+/g) || []).length;
      classes += (text.match(/\.[\w-]+/g) || []).length;
      classes += (text.match(/\[[^\]]+\]/g) || []).length;
      classes += (text.match(/:{1}[\w-]+(?:\([^)]*\))?/g) || []).length;
      const cleaned = text.replace(/#[\w-]+/g, ' ').replace(/\.[\w-]+/g, ' ')
        .replace(/\[[^\]]+\]/g, ' ').replace(/::?[\w-]+(?:\([^)]*\))?/g, ' ');
      elements += (cleaned.match(/(^|[\s>+~,(])([a-zA-Z][\w-]*)/g) || []).length;
      return [ids, classes, elements];
    }
    function winner(element, property) {
      const rules = [];
      const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
      let match;
      while ((match = ruleRe.exec(tableCss))) {
        const selectors = match[1].split(',').map((s) => s.trim()).filter(Boolean);
        const body = match[2];
        const propMatch = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)').exec(body);
        if (!propMatch) continue;
        selectors.forEach((sel) => {
          if (sel.startsWith('@')) return;
          let hit = false;
          try { hit = element.matches(sel); } catch (e) { hit = false; }
          if (hit) rules.push({ sel, value: propMatch[1].trim(), spec: specificity(sel), order: rules.length });
        });
      }
      const rank = (r) => r.spec[0] * 1e6 + r.spec[1] * 1e3 + r.spec[2];
      rules.sort((a, b) => (rank(a) - rank(b)) || (a.order - b.order));
      return rules.length ? rules[rules.length - 1].value : null;
    }

    function mount(extraClass, floating) {
      const markup = '<table class="biz-table biz-table--matrix stock-analysis-statements-table ' + extraClass + '">'
        + '<thead><tr><th class="statement-col-corner">默认单位：亿元</th><th>2025</th></tr></thead>'
        + '<tbody><tr><th class="statement-col-name">营业收入</th><th class="statement-col-basis">当期</th></tr></tbody></table>';
      const html = floating ? '<div class="biz-table-floating-head">' + markup + '</div>' : markup;
      const dom = new JSDOM(html);
      const corner = dom.window.document.querySelector('th.statement-col-corner');
      const basis = dom.window.document.querySelector('th.statement-col-basis');
      return { dom, corner, basis };
    }
    const single = mount('', false);
    assert.strictEqual(winner(single.corner, 'text-align'), 'left', '单固定列的表头首格必须最终为 left');
    const dual = mount('has-dual-cols', false);
    assert.strictEqual(winner(dual.corner, 'text-align'), 'left', '双固定列的表头首格必须最终为 left');
    const floating = mount('has-dual-cols', true);
    assert.strictEqual(winner(floating.corner, 'text-align'), 'left', '悬浮/吸顶表头首格必须最终为 left');
    assert.strictEqual(winner(dual.basis, 'text-align'), 'center', '第二列「当期/单季」必须保持居中');
    single.dom.window.close(); dual.dom.window.close(); floating.dom.window.close();
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
