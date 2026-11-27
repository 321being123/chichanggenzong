// 2026-11-27 线上反馈 #108/#119/#120 的定向回归。
// #108：后台任务技术错误的中文展示与原始详情保留；
// #119：模拟股市建场选项的核验超时/缺数原因与可替代窗口；
// #120：下修监控转股溢价率单位及同类可转债模块口径审计。
// 仅覆盖可离线验证的格式化、纯函数和仓储编排；真实浏览器、真机与生产数据不在本文件范围。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function loadAdminHelpers() {
  const sandbox = {
    console, setTimeout, clearTimeout, window: {},
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    checkAuth: async () => false,
    escapeHtml: (value) => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  vm.runInNewContext(
    read('public/js/admin.js') + '\n;globalThis.__job = { translateJobText, jobDisplayText, renderJobResultHtml, jobErrorHtml, jobErrorTypeLabel, replaceTechnicalErrorText };',
    sandbox
  );
  return sandbox.__job;
}

function loadBondRevisionHelpers() {
  const sandbox = { escapeHtml: (value) => String(value == null ? '' : value), bondLifecycleMark: () => '' };
  vm.runInNewContext(
    read('public/js/bond-revision.js') + '\n;globalThis.__rev = { bondRevisionCell, bondRevisionPercentPoints, bondRevisionRatioPercent };',
    sandbox
  );
  return sandbox.__rev;
}

function buildTradeDates(startYear, endYear) {
  const dates = [];
  for (let year = startYear; year <= endYear; year++) {
    const cursor = new Date(Date.UTC(year, 0, 1));
    while (cursor.getUTCFullYear() === year) {
      const dow = cursor.getUTCDay();
      const mmdd = cursor.toISOString().slice(5, 10);
      if (dow !== 0 && dow !== 6 && mmdd >= '01-04' && mmdd <= '12-31') {
        dates.push(cursor.toISOString().slice(0, 10));
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return dates;
}

function seedClassroomRepo(overrides = {}) {
  const repo = require('../repositories/classroomRepository');
  const originals = {};
  const patch = (name, fn) => { originals[name] = repo[name]; repo[name] = fn; };
  const tradeDates = buildTradeDates(2010, 2025);
  const industries = Array.from({ length: 10 }, (_, index) => ({
    industry_node_id: index + 1, parent_id: null, industry_code: 'SW' + (index + 1),
    industry_name: '测试行业' + (index + 1), level: 1,
  }));
  const candidates = [];
  const memberships = [];
  for (let industry = 1; industry <= 10; industry++) {
    for (let stock = 1; stock <= 3; stock++) {
      const instrumentId = industry * 100 + stock;
      candidates.push({
        instrument_id: instrumentId, canonical_code: `60${String(industry).padStart(2, '0')}${String(stock).padStart(2, '0')}.SH`,
        name: `测试股${industry}_${stock}`, list_date: '2010-01-01', delist_date: null,
        industry_node_id: industry,
      });
      memberships.push({ instrument_id: instrumentId, industry_node_id: industry });
    }
  }
  const bondWealth = [];
  for (let year = 2010; year <= 2025; year++) {
    bondWealth.push({ index_code: 'CBA00601', trade_date: `${year}-01-04`, close: '100' });
    bondWealth.push({ index_code: 'CBA00601', trade_date: `${year}-12-31`, close: '105' });
  }
  const buckets = [];
  for (const tenor of ['short', 'mid', 'long']) {
    for (const moneyness of ['otm', 'atm', 'itm']) {
      buckets.push({ tenor_bucket: tenor, moneyness_bucket: moneyness, premium_cnt: 5, bond_premium_cnt: 5, median_premium_pct: 20, median_bond_premium_pct: 10 });
    }
  }
  patch('withReadOnlySnapshot', async (fn) => fn({}));
  patch('fetchCnOpenTradeDates', async () => tradeDates);
  patch('fetchCnCalendarSummaryByYear', async () => []);
  patch('fetchBondWealthIndexSeries', async () => bondWealth);
  patch('fetchCbCalibrationSampleStats', async () => ({ cnt: 100 }));
  patch('fetchCbCalibrationBuckets', async () => buckets);
  patch('fetchFactsDataVersion', async () => overrides.dataVersion || 'facts-119-default');
  patch('fetchSw2021IndustryTree', async () => industries);
  patch('fetchCnStockCandidatesForWindow', async () => candidates);
  patch('fetchSw2021MembershipsByInstrumentIds', async () => memberships);
  patch('fetchDailyBarsWithAdj', async () => overrides.bars || []);
  patch('fetchDailyValuations', async () => overrides.valuations || []);
  patch('fetchSuspensions', async () => overrides.suspensions || []);
  return {
    candidates,
    restore() { Object.keys(originals).forEach((name) => { repo[name] = originals[name]; }); },
  };
}

(async () => {
  console.log('--- 线上反馈 #108/#119/#120 ---');

  // ---------------- #108 后台任务技术错误中文换算 ----------------
  await test('#108 常见后台技术错误翻译为中文，原始英文保留在折叠详情', () => {
    const api = loadAdminHelpers();
    const cases = [
      ['job child process exited null without result', '后台任务子进程异常退出'],
      ['job child process exited 1 without result', '退出码 1'],
      ['spawn /opt/portfolio/job.js ENOENT', '找不到可执行文件'],
      ['connect ETIMEDOUT', '连接上游服务超时'],
      ['read ECONNRESET', '网络连接被中断'],
      ['timeout of 30000ms exceeded', '请求超时'],
      ['Cannot find module \'xlsx\'', '缺少运行依赖'],
      ['ENOSPC: no space left on device', '磁盘空间不足'],
      ['duplicate key value violates unique constraint "idx"', '写入重复数据'],
      ['deadlock detected', '数据库死锁'],
      ['relation "ops.job_runs" does not exist', '数据库表不存在'],
      ['Request failed with status code 502', '上游接口返回错误'],
    ];
    for (const [raw, expected] of cases) {
      const translated = api.translateJobText(raw);
      assert.ok(translated.includes(expected), `未翻译为中文：${raw} -> ${translated}`);
      assert.ok(!/child process exited|ETIMEDOUT|ECONNRESET|ENOSPC|deadlock|Request failed/.test(translated),
        `主展示仍含英文技术错误：${raw} -> ${translated}`);
    }
    assert.strictEqual(api.jobErrorTypeLabel('TypeError'), '数据类型异常');
    assert.strictEqual(api.jobErrorTypeLabel('JobTimeout'), '执行超时');
    assert.strictEqual(api.jobErrorTypeLabel('UnknownDriver'), '程序异常');
  });

  await test('#108 业务执行结果/最近错误主展示为中文，原始详情可展开查看', () => {
    const api = loadAdminHelpers();
    const raw = 'job child process exited null without result';
    const html = api.renderJobResultHtml({ error: raw });
    const main = html.replace(/<details[\s\S]*$/, '');
    assert.ok(main.includes('后台任务子进程异常退出'), '业务执行结果主列表必须为中文');
    assert.ok(!main.includes('child process exited'), '主列表不得裸露英文技术错误');
    assert.ok(/<details[\s\S]*查看原始技术详情[\s\S]*child process exited null without result/.test(html),
      '原始英文必须保留在折叠详情中');

    const lastError = api.jobErrorHtml(raw, 1000);
    assert.ok(lastError.includes('后台任务子进程异常退出'), '最近错误必须为中文');
    assert.ok(/<details[\s\S]*查看原始技术详情[\s\S]*child process exited null without result/.test(lastError),
      '最近错误必须保留原始技术详情');

    const src = read('public/js/admin.js');
    assert.ok(/jobErrorHtml\(d\.last_error/.test(src), '最近错误必须走统一错误格式化器');
    assert.ok(/jobErrorTypeLabel\(run\.error_type\)/.test(src), '执行尝试的错误类型必须翻译');
    assert.ok(/jobErrorHtml\(alert\.last_send_error/.test(src), '告警错误必须走统一错误格式化器');
  });

  // ---------------- #120 下修监控转股溢价率单位 ----------------
  await test('#120 转股溢价率按百分数直接显示，不再多乘 100', () => {
    const api = loadBondRevisionHelpers();
    assert.strictEqual(api.bondRevisionCell({ conversion_premium_pct: 40.82 }, 'conversion_premium_pct'), '40.82%');
    assert.strictEqual(api.bondRevisionCell({ conversion_premium_pct: 59.45 }, 'conversion_premium_pct'), '59.45%');
    assert.strictEqual(api.bondRevisionCell({ conversion_premium_pct: 675 }, 'conversion_premium_pct'), '675.00%');
    assert.strictEqual(api.bondRevisionCell({ conversion_premium_pct: null }, 'conversion_premium_pct'), '—');
    // 比值字段仍按小数换算百分比，不能因本次修复一起改成直接显示。
    assert.strictEqual(api.bondRevisionCell({ distance_to_trigger_pct: 0.2 }, 'distance_to_trigger_pct'), '20.00%');
    assert.strictEqual(api.bondRevisionCell({ trigger_ratio: 0.85 }, 'trigger_ratio'), '85.00%');
  });

  await test('#120 同类可转债模块单位口径一致（列表/安全性/估值/个债分析）', () => {
    // 上市可转债列表 API 的 conversion_premium 是小数，页面应乘 100。
    const listSandbox = {
      window: { BondListContract: { COLUMNS: [] } }, escapeHtml: (v) => String(v == null ? '' : v),
      bondLifecycleMark: () => '', bondListState: {},
    };
    vm.runInNewContext(read('public/js/bond-list.js') + '\n;globalThis.__list = { bondListPercent };', listSandbox);
    assert.strictEqual(listSandbox.__list.bondListPercent(0.4082), '40.82%');

    // 安全性 API 的 convert_premium 已经是百分数，页面不得再乘 100。
    const safetySandbox = {
      window: {}, document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      escapeHtml: (v) => String(v == null ? '' : v), bondLifecycleMark: () => '', bondSafetyState: {},
    };
    vm.runInNewContext(read('public/js/bond-safety.js') + '\n;globalThis.__safety = { bondSafetyPercent };', safetySandbox);
    assert.strictEqual(safetySandbox.__safety.bondSafetyPercent(40.82, false), '40.82%');

    // 估值 API 的 conversion_premium_pct 存百分数，pctv 只加百分号；个债分析 API 是小数并乘 100。
    const valuation = read('public/js/bond-valuation.js');
    const utils = read('public/js/utils.js');
    assert.ok(/\{ k: 'conversion_premium_pct', t: '转股溢价率', p: 1 \}/.test(valuation), '估值表必须使用百分数格式器');
    assert.ok(/function pctv\(v, d\) \{[\s\S]*?num\(Number\(v\), d == null \? 2 : d\) \+ '%'/.test(utils), 'pctv 不得再次乘 100');
    assert.ok(/bondAnalysisPercent\(row\.conversion_premium\)/.test(read('public/js/bond-analysis.js')), '个债分析仍按小数换算');
  });

  // ---------------- #119 模拟股市候选不足 ----------------
  await test('#119 核验失败时返回可读原因、已核验进度与行业明细分项', async () => {
    const seed = seedClassroomRepo({ dataVersion: 'facts-119-missing-' + Date.now() });
    const service = require('../services/classroomPrecheckService');
    try {
      const out = await service.verifyIndustryPool({
        startYear: 2011,
        totalRounds: 15,
        timeoutMs: 5000,
        now: new Date('2026-11-24T10:00:00+08:00'),
      });
      assert.strictEqual(out.windowStatus.pass, false);
      assert.strictEqual(out.industries.length, 10);
      assert.strictEqual(out.industries[0].qualifiedCount, 0);
      assert.strictEqual(out.industries[0].rejectedCount, 3);
      assert.ok(out.industries[0].rejectionSummary.length > 0, '行业分项必须给出未通过原因');
      assert.strictEqual(out.verification.candidateCount, 30);
      assert.strictEqual(out.verification.verifiedCount, 30);
      assert.strictEqual(out.verification.rejectedCount, 30);
      assert.strictEqual(out.verification.timedOut, false);
      assert.ok(out.verification.rejectionSummary.some((item) => item.reason.includes('行情')), '应汇总为缺行情/估值等可读类别');
      assert.ok(out.windowStatus.blockers.some((line) => line.includes('当前仅有 0 个合格一级行业')));
    } finally {
      seed.restore();
    }
  });

  await test('#119 核验超时不能被伪装成已完成 0 只，必须提示继续核验', async () => {
    const seed = seedClassroomRepo({ dataVersion: 'facts-119-timeout-' + Date.now() });
    const service = require('../services/classroomPrecheckService');
    try {
      const out = await service.verifyIndustryPool({
        startYear: 2011,
        totalRounds: 15,
        timeoutMs: 0,
        now: new Date('2026-11-24T10:00:00+08:00'),
      });
      assert.strictEqual(out.timedOut, true);
      assert.strictEqual(out.verification.timedOut, true);
      assert.strictEqual(out.verification.verifiedCount, 0);
      assert.ok(out.windowStatus.blockers.some((line) => line.includes('未在本次时限内完成')), '超时必须明确提示核验未完成');
      assert.ok(!out.windowStatus.blockers.some((line) => line.includes('没有可核验的候选股票')), '超时不得误报没有候选');
    } finally {
      seed.restore();
    }
  });

  await test('#119 建场提示说明进度/原因/可替代窗口，并给当前窗口更长核验时间', () => {
    const src = read('public/js/classroom.js');
    const start = src.indexOf('  function creationIndustryDetails');
    const end = src.indexOf('  async function loadTeacherCreationOptions');
    assert.ok(start > 0 && end > start, '建场提示函数必须可独立回归');
    const sandbox = { console };
    vm.runInNewContext(src.slice(start, end) + '\n;globalThis.__ui = { creationInsufficientText };', sandbox);
    const text = sandbox.__ui.creationInsufficientText({
      selectedStartYear: 2011,
      windowStatus: { blockers: ['当前仅有 0 个合格一级行业（需至少 4 个且每行业至少 3 只合格股）'] },
      industries: [{ industryName: '传媒', qualifiedCount: 0, verifiedCount: 10, coarseCount: 30 }],
      verification: {
        timedOut: true, verifiedCount: 80, candidateCount: 300,
        rejectionSummary: [{ reason: '缺少期初估值/市值快照', count: 70 }],
      },
      availableWindows: [{ startYear: 2015, endYear: 2029 }],
    }, 0);
    assert.ok(text.includes('已核验 80/300'), '必须说明超时时的核验进度');
    assert.ok(text.includes('缺少期初估值/市值快照（70 只）'), '必须说明主要缺数原因');
    assert.ok(text.includes('2015–2029'), '必须提示已有可用窗口');
    assert.ok(text.includes('传媒（合格 0 / 已核验 10 / 候选 30）'), '行业明细必须给出通过/核验/候选数');
    const route = read('server/routes/classroom.js');
    assert.ok(/currentWindowTimeoutMs:\s*60000/.test(route), '当前选中窗口必须使用长任务核验时间');
    assert.ok(/currentWindowTimeoutMs/.test(read('server/services/classroomPrecheckService.js')), '服务层必须接收当前窗口独立超时');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
