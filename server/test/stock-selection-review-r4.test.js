// 投资策略选股中心：四轮独立核查（R4-01—R4-05）回归反例。
// 对应《投资策略选股中心研发方案_20261102》第 22.2 节；真实领取链路与真实 SQL 段
// 只在显式设置 STOCK_SELECTION_R4_DB=1 时运行（需要本机 PostgreSQL），未设置时如实跳过。
'use strict';
const assert = require('assert');
const path = require('path');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    const detail = error && (error.stack || error.message || String(error));
    const summary = String(detail).split('\n').slice(0, 3).join(' | ');
    tests.push(['FAIL', name + ' :: ' + summary]);
    console.log('  [FAIL] ' + name + ' :: ' + summary);
  }
}

const RULES = require('../domain/stockSelectionRules');
function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
function dropCache(relativePath) {
  try { delete require.cache[require.resolve(relativePath)]; } catch (_) { /* 未加载过 */ }
}
async function main() {
  await runR401();
  await runR402();
  await runR405();
  await runDatabaseChecks();
  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

// ===================== R4-01：选股领取不得继承 A 股转债依赖 =====================
async function runR401() {
  await check('R4-01 选股槽领取按模式解析依赖，不再被转债链挡住', async () => {
    const patched = patchSlotsRepository();
    try {
      const { claimSlot } = require('../services/jobScheduleSlots');
      for (const market of ['CN', 'HK']) {
        const claimed = await claimSlot(9, 'test-worker', 'scheduled');
        assert.ok(claimed, `${market} 选股槽必须能领取（转债链缺失时也不例外）`);
      }
      assert.strictEqual(patched.depQueries, 0, '选股模式显式无依赖：领取时不得去查转债链状态');
      // core 模式仍必须被转债链阻断（依赖状态查询必然发生）。
      patched.reset();
      patched.setMode(null);
      const blocked = await claimSlot(9, 'test-worker', 'scheduled');
      assert.strictEqual(blocked, null, 'core 模式仍要被缺失的转债上游阻断');
      assert.strictEqual(patched.depQueries, 1, 'core 模式必须按原规则查询依赖状态');
    } finally { patched.restore(); }
  });

  await check('R4-01 blocked 槽的恢复分支同样按模式解析依赖', async () => {
    const patched = patchSlotsRepository();
    try {
      const { reconcileSlot } = require('../services/jobScheduleSlots');
      const released = await reconcileSlot(patched.slot({ status: 'blocked', mode: 'selection_quarterly' }));
      assert.ok(released, '选股 blocked 槽必须返回槽位');
      assert.strictEqual(patched.releaseWrites, 1, '显式无依赖的模式必须被释放回可领取状态');
      // core 模式仍按原规则等依赖，不会被释放。
      patched.reset();
      const coreSlot = await reconcileSlot(patched.slot({ status: 'blocked', mode: null }));
      assert.strictEqual(patched.releaseWrites, 0, 'core 模式的 blocked 槽不得被释放');
      assert.strictEqual(coreSlot.status, 'blocked');
    } finally { patched.restore(); }
  });
}

/**
 * 领取链路替身：只替换调度仓储，使"依赖状态"可控。
 * 转债上游不存在/失败时，旧实现（读全局 dependencyCodes）会拒绝领取。
 */
function patchSlotsRepository() {
  const repoPath = path.join(__dirname, '..', 'repositories', 'jobScheduleSlotsRepository.js');
  const repo = require(repoPath);
  const backup = {};
  const targets = [
    'select_ops_job_schedule_slots_1', 'update_ops_job_schedule_slots_6',
    'update_ops_job_schedule_slots_7', 'update_ops_job_schedule_slots_4', 'taskDependencyStates',
  ];
  targets.forEach(name => { backup[name] = repo[name]; });
  const state = { mode: 'selection_quarterly', status: 'pending', blockedWrites: [], releaseWrites: 0, depQueries: 0 };
  repo.select_ops_job_schedule_slots_1 = async () => ({
    rows: [{
      slot_id: 9, job_code: 'stock_analysis_refresh',
      request_payload: state.mode ? { mode: state.mode, market: 'CN' } : {},
      business_date: '2026-09-30', scheduled_for: '2026-10-01T00:30:00.000Z',
      attempt_count: 0, status: state.status,
    }],
  });
  repo.update_ops_job_schedule_slots_6 = async ([slotId, message]) => {
    state.blockedWrites.push({ slotId, message });
    return { rows: [] };
  };
  repo.update_ops_job_schedule_slots_7 = async () => ({ rows: [{ slot_id: 9, status: 'running', worker_id: 'test-worker' }] });
  repo.update_ops_job_schedule_slots_4 = async () => {
    state.releaseWrites += 1;
    return { rows: [{ slot_id: 9, status_released: 'pending', status: 'pending' }] };
  };
  // 依赖状态：转债上游缺失（空 Map）→ 旧实现必被阻断；按模式解析时根本不会查它。
  repo.taskDependencyStates = async () => { state.depQueries += 1; return new Map(); };
  const slotsModule = require('../services/jobScheduleSlots');
  return {
    setMode: mode => { state.mode = mode; },
    setStatus: status => { state.status = status; },
    slot(overrides = {}) {
      const mode = Object.prototype.hasOwnProperty.call(overrides, 'mode') ? overrides.mode : state.mode;
      return {
        slot_id: 9, job_code: 'stock_analysis_refresh',
        request_payload: mode ? { mode, market: 'CN' } : {},
        business_date: '2026-09-30', scheduled_for: '2026-10-01T00:30:00.000Z',
        attempt_count: 0, status: overrides.status || state.status,
      };
    },
    reset() { state.blockedWrites.length = 0; state.releaseWrites = 0; state.depQueries = 0; },
    get depQueries() { return state.depQueries; },
    get blockedWrites() { return state.blockedWrites; },
    get releaseWrites() { return state.releaseWrites; },
    restore() { targets.forEach(name => { repo[name] = backup[name]; }); },
  };
}

// ===================== R4-02：多批次公平轮转 =====================
async function runR402() {
  await check('R4-02 三只对象每批一只时，六轮内每只都获得机会', async () => {
    const store = gapQueueStore();
    const gaps = ['600001.SH', '600002.SH', '600003.SH'].map((code, index) => ({
      code, name: '样本' + index, companyId: 11 + index, domains: ['industry'], reasons: ['industry_unverified'],
    }));
    const sync = loadInputsSyncWithRealQueue(store, gaps);
    sync.__setIndustry(async tsCode => { throw new Error('controlled_failure:' + tsCode); });
    const sequence = [];
    for (let round = 0; round < 6; round++) {
      await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
      sequence.push(sync.__lastRequest());
    }
    assert.deepStrictEqual(sequence, ['600001.SH', '600002.SH', '600003.SH', '600001.SH', '600002.SH', '600003.SH'],
      '六轮必须覆盖三只，不能只在前两只之间来回');
    const last = store.rows.get('CN');
    assert.strictEqual(last.lastRun.remainingIndustry, 3, '剩余量仍如实为 3');
    assert.strictEqual(Object.keys(last.lastRun.attempts || {}).length, 3, '三只对象的尝试次数都要持久化');
  });

  await check('R4-02 返回成功但缺口仍在时同样轮转（不阻塞后继）', async () => {
    const store = gapQueueStore();
    const gaps = ['600001.SH', '600002.SH', '600003.SH'].map((code, index) => ({
      code, name: '样本' + index, companyId: 11 + index, domains: ['industry'], reasons: ['industry_unverified'],
    }));
    const sync = loadInputsSyncWithRealQueue(store, gaps);
    // 每次取数都"成功"但缺口不解除。
    sync.__setIndustry(async () => ({
      industry: '测试行业', industry_level: 1,
      industry_nodes: [{ level: 1, code: 'T1', name: '测试行业' }], industry_path: ['测试行业'], sourceCode: 'test',
    }));
    const sequence = [];
    for (let round = 0; round < 4; round++) {
      await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
      sequence.push(sync.__lastRequest());
    }
    assert.deepStrictEqual(sequence.slice(0, 3), ['600001.SH', '600002.SH', '600003.SH'], '无进展对象也不能挡住后继');
  });

  await check('R4-02 重启后（模块重载）仍按持久尝试次数轮转', async () => {
    const store = gapQueueStore();
    const gaps = ['600001.SH', '600002.SH', '600003.SH'].map((code, index) => ({
      code, name: '样本' + index, companyId: 11 + index, domains: ['industry'], reasons: ['industry_unverified'],
    }));
    let sync = loadInputsSyncWithRealQueue(store, gaps);
    sync.__setIndustry(async () => { throw new Error('controlled_failure'); });
    await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
    // 模拟进程重启：清缓存、重新加载同一份持久队列。
    sync = loadInputsSyncWithRealQueue(store, gaps);
    sync.__setIndustry(async () => { throw new Error('controlled_failure'); });
    await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
    assert.strictEqual(sync.__lastRequest(), '600002.SH', '重启后必须接着上次进度，而不是回到第一只');
  });
}

// ===================== R4-05：正常关闭季度不再重复入队 =====================
async function runR405() {
  await check('R4-05 正常关闭（market_closed）也算已完成，不再新建槽', async () => {
    const { enqueued } = await runEnqueueScenario([{ execution_status: 'succeeded', business_status: 'market_closed', published_at: null, selected_count: 0 }]);
    assert.strictEqual(enqueued.length, 0, '同一季度已完成，不能再建新槽');
  });

  await check('R4-05 数据不足的季度仍要重新排队（不能一起跳过）', async () => {
    const { enqueued } = await runEnqueueScenario([{ execution_status: 'succeeded', business_status: 'insufficient_data', published_at: null, selected_count: 0 }]);
    assert.strictEqual(enqueued.length, 2, 'CN/HK 都应重新排队');
  });

  await check('R4-05 已发布季度仍按原规则跳过', async () => {
    const { enqueued } = await runEnqueueScenario([{ execution_status: 'succeeded', business_status: 'eligible', published_at: '2026-10-01T00:00:00Z', selected_count: 30 }]);
    assert.strictEqual(enqueued.length, 0);
  });
}

/**
 * 自动排队场景：任务的去重已改为"仓储层终态存在性查询"（R5-03），
 * 所以这里按同一判据给出 `hasCompletedQuarter` 的返回值，并显式证明它不再读列表分页。
 */
async function runEnqueueScenario(rows) {
  const enqueued = [];
  const completedFn = require('../jobs/stockAnalysisRefresh').quarterRunCompleted;
  const completed = rows.some(completedFn);
  let listRunsCalls = 0;
  stub(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), {
    pendingQuarter: async () => ({ quarter: '2026Q3', quarterEnd: '2026-09-30' }),
    hasCompletedQuarter: async () => completed,
  });
  stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), {
    // 任何分页列表调用都算越界：去重不允许再依赖"最近 N 条"。
    listRuns: async () => { listRunsCalls += 1; return { rows, total: rows.length }; },
  });
  stub(path.join(__dirname, '..', 'services', 'jobScheduleSlots.js'), {
    enqueueManualJob: async (code, payload) => { enqueued.push({ code, payload }); return { slot_id: enqueued.length }; },
  });
  dropCache('../jobs/stockAnalysisRefresh');
  const refresh = require('../jobs/stockAnalysisRefresh');
  await refresh.enqueueDueSelectionQuarters(new Date('2026-10-05T02:00:00Z'));
  assert.strictEqual(listRunsCalls, 0, '自动去重不得再用列表分页判"是否已完成"');
  return { enqueued };
}

// ===================== 真库段（R4-01 / R4-03 / R4-04） =====================
async function runDatabaseChecks() {
  if (String(process.env.STOCK_SELECTION_R4_DB || '') !== '1') {
    console.log('  [SKIP] R4 真库反例（未设置 STOCK_SELECTION_R4_DB=1）');
    return;
  }
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
  const { pool } = require('../db/connection');
  const migrations = require('../db/migrations');

  await check('R4-01 真库：选股槽在转债链缺失时可领取，core 仍被阻断', async () => {
    await migrations.runMigrations();
    // 前面的进程内用例把调度服务与仓储放进了替身缓存，真库段必须重新加载真实模块。
    delete require.cache[require.resolve('../repositories/jobScheduleSlotsRepository')];
    delete require.cache[require.resolve('../services/jobScheduleSlots')];
    const slots = require('../services/jobScheduleSlots');
    const slotIds = [];
    try {
      // scheduled_for 兼作 next_attempt_at：取已过去的时间，避免应用时钟略快于库时钟导致"还没到点"；
      // 同时每槽错开 1 秒——建槽按 (job_code, scheduled_for) 去重，同秒会合并成一条。
      const dueAt = offset => new Date(Date.now() - 60 * 1000 - offset * 1000);
      for (const [index, market] of ['CN', 'HK'].entries()) {
        const created = await slots.ensureSlot('stock_analysis_refresh', dueAt(index), '2026-09-30', 'manual',
          { mode: 'selection_quarterly', market, quarter: '2026Q3' });
        assert.ok(created && created.slot_id, '必须建出选股槽');
        slotIds.push(created.slot_id);
      }
      // core 对照：用一个转债任务必然没有成功记录的旧业务日，确保上游缺失。
      const coreSlot = await slots.ensureSlot('stock_analysis_refresh', dueAt(9), '1990-01-01', 'manual', {});
      assert.ok(coreSlot && coreSlot.slot_id, '必须建出 core 对照槽');
      slotIds.push(coreSlot.slot_id);

      const due = await slots.listDueSlots(100);
      const dueIds = new Set(due.map(item => Number(item.slot_id)));
      for (const slotId of slotIds.slice(0, 2)) {
        assert.ok(dueIds.has(Number(slotId)), `选股槽 ${slotId} 应被列为待执行`);
        const claimed = await slots.claimSlot(slotId, 'r4-test-worker');
        assert.ok(claimed, `选股槽 ${slotId} 必须能领取（转债链缺失时也不例外）`);
      }
      const claimedCore = await slots.claimSlot(coreSlot.slot_id, 'r4-test-worker');
      assert.strictEqual(claimedCore, null, 'core 模式仍要被缺失的转债上游阻断');
    } finally {
      if (slotIds.length) {
        await pool.query(`DELETE FROM ops.job_schedule_slots WHERE slot_id = ANY($1::bigint[])`, [slotIds]).catch(() => {});
      }
    }
  });

  await check('R4-03 真库：3/6/12 月财年与变更财年都按实际年报期末识别', async () => {
    const repoPath = '../repositories/stockSelectionRepository';
    delete require.cache[require.resolve(repoPath)];
    const repo = require(repoPath);
    const cases = [
      { code: '609903.SH', label: '12月财年', ends: year => `${year}-12-31` },
      { code: '609904.SH', label: '3月财年', ends: year => `${year}-03-31` },
      { code: '609905.SH', label: '6月财年', ends: year => `${year}-06-30` },
      // 变更财年：2015—2019 用 12 月，2020 起改 3 月结束。
      { code: '609906.SH', label: '变更财年', ends: year => (year <= 2019 ? `${year}-12-31` : `${year}-03-31`) },
    ];
    const created = [];
    try {
      const source = await pool.query(`SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1`);
      const sourceId = source.rows[0] ? source.rows[0].source_id : null;
      for (const item of cases) {
        const company = await pool.query(
          `INSERT INTO core.companies (legal_name, short_name, country_code, company_type) VALUES ($1,$2,'CN','listed') RETURNING company_id`,
          [`R4财年测试${item.label}${Date.now().toString(36)}`, 'R4']);
        const companyId = company.rows[0].company_id;
        const instrument = await pool.query(
          `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, status)
           VALUES ($1,$2,'stock','CN','SSE','CNY','2010-01-01','listed') RETURNING instrument_id`, [item.code, 'R4测试']);
        const instrumentId = instrument.rows[0].instrument_id;
        created.push({ companyId, instrumentId });
        await pool.query(
          `INSERT INTO core.company_instruments (company_id, instrument_id, relation_type, valid_from) VALUES ($1,$2,'issued_by','2010-01-01')`,
          [companyId, instrumentId]);
        for (let year = 2015; year <= 2025; year++) {
          const periodEnd = item.ends(year);
          const report = await pool.query(
            `INSERT INTO fundamental.financial_reports
               (company_id, report_kind, period_end, period_type, statement_scope, announced_at, source_id, source_version, update_flag, is_current_version, report_type)
             VALUES ($1,'income',$2::date,'annual','consolidated',$3::date,$4,'v1','',true,'1') RETURNING report_id`,
            [companyId, periodEnd, `${Number(periodEnd.slice(0, 4)) + 1}-06-30`, sourceId]);
          await pool.query(
            `INSERT INTO fundamental.financial_facts (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
             VALUES ($1,'income','net_profit_parent',1e9,'CNY','CNY','n_income_attr_p',false)`, [report.rows[0].report_id]);
          await pool.query(
            `INSERT INTO fundamental.corporate_actions (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status, cash_per_share_pre_tax, total_cash_amount, currency_code, source_id, source_key)
             VALUES ($1,'dividend',$2::date,$3::date,$4::date,'实施',0.5,1e8,'CNY',$5,$6)`,
            [instrumentId, periodEnd, `${Number(periodEnd.slice(0, 4)) + 1}-07-15`, `${Number(periodEnd.slice(0, 4)) + 1}-08-15`, sourceId, `R4-DIV-${item.code}-${year}`]);
        }
      }
      const rows = await repo.loadAnnualDividends({ companyIds: created.map(item => item.companyId), asOfDate: '2026-12-31' });
      created.forEach((item, index) => {
        const list = rows.get(String(item.companyId)) || [];
        assert.ok(list.length >= 10, `${cases[index].label} 应读到全部财年`);
        list.forEach(row => assert.strictEqual(row.dividendKnown, true,
          `${cases[index].label} 的 ${row.year} 年必须判为已知（basis=${row.dividendBasis}）`));
      });
    } finally {
      for (const item of created) {
        await pool.query(`DELETE FROM fundamental.financial_facts WHERE report_id IN (SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1)`, [item.companyId]).catch(() => {});
        await pool.query(`DELETE FROM fundamental.financial_reports WHERE company_id=$1`, [item.companyId]).catch(() => {});
        await pool.query(`DELETE FROM fundamental.corporate_actions WHERE instrument_id=$1`, [item.instrumentId]).catch(() => {});
        await pool.query(`DELETE FROM core.company_instruments WHERE instrument_id=$1`, [item.instrumentId]).catch(() => {});
        await pool.query(`DELETE FROM core.instruments WHERE instrument_id=$1`, [item.instrumentId]).catch(() => {});
        await pool.query(`DELETE FROM core.companies WHERE company_id=$1`, [item.companyId]).catch(() => {});
      }
    }
  });

  await check('R4-04 真库：明确零分红算已知，预案与金额 NULL 仍未知', async () => {
    const repoPath = '../repositories/stockSelectionRepository';
    delete require.cache[require.resolve(repoPath)];
    const repo = require(repoPath);
    const servicePath = '../services/stockSelectionService';
    delete require.cache[require.resolve(servicePath)];
    const service = require(servicePath);
    let companyId = null; let instrumentId = null;
    try {
      const source = await pool.query(`SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1`);
      const sourceId = source.rows[0] ? source.rows[0].source_id : null;
      const company = await pool.query(
        `INSERT INTO core.companies (legal_name, short_name, country_code, company_type) VALUES ($1,$2,'CN','listed') RETURNING company_id`,
        ['R4零分红公司' + Date.now().toString(36), 'R4Z']);
      companyId = company.rows[0].company_id;
      const instrument = await pool.query(
        `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, status)
         VALUES ('609907.SH','R4零分红','stock','CN','SSE','CNY','2010-01-01','listed') RETURNING instrument_id`);
      instrumentId = instrument.rows[0].instrument_id;
      await pool.query(`INSERT INTO core.company_instruments (company_id, instrument_id, relation_type, valid_from) VALUES ($1,$2,'issued_by','2010-01-01')`, [companyId, instrumentId]);
      for (let year = 2015; year <= 2025; year++) {
        const report = await pool.query(
          `INSERT INTO fundamental.financial_reports
             (company_id, report_kind, period_end, period_type, statement_scope, announced_at, source_id, source_version, update_flag, is_current_version, report_type)
           VALUES ($1,'income',$2::date,'annual','consolidated',$3::date,$4,'v1','',true,'1') RETURNING report_id`,
          [companyId, `${year}-12-31`, `${year + 1}-03-31`, sourceId]);
        await pool.query(
          `INSERT INTO fundamental.financial_facts (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
           VALUES ($1,'income','net_profit_parent',1e9,'CNY','CNY','n_income_attr_p',false)`, [report.rows[0].report_id]);
        if (year === 2018) continue;
        await pool.query(
          `INSERT INTO fundamental.corporate_actions (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status, cash_per_share_pre_tax, total_cash_amount, currency_code, source_id, source_key)
           VALUES ($1,'dividend',$2::date,$3::date,$4::date,'实施',0.5,1e8,'CNY',$5,$6)`,
          [instrumentId, `${year}-12-31`, `${year + 1}-05-01`, `${year + 1}-06-15`, sourceId, `R4Z-DIV-${year}`]);
      }
      // 2018：官方明确"无股息"→ 实施、每股 0、总额 0、无除息日。
      await pool.query(
        `INSERT INTO fundamental.corporate_actions (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status, cash_per_share_pre_tax, total_cash_amount, currency_code, source_id, source_key)
         VALUES ($1,'dividend','2018-12-31','2019-05-01',NULL,'实施',0,0,'CNY',$2,'R4Z-ZERO')`, [instrumentId, sourceId]);
      const asOfDate = '2026-09-30';
      const zero = await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate });
      const zeroRow = (zero.get(String(companyId)) || []).find(row => row.year === 2018);
      assert.ok(zeroRow, '零分红年份必须返回');
      assert.strictEqual(zeroRow.dividendKnown, true, '明确零分红是可核验的年度证据');
      assert.strictEqual(zeroRow.dividend, 0);
      assert.strictEqual(zeroRow.dividendBasis, 'verified_zero_dividend');
      const years = service.buildAnnualYears(
        Array.from({ length: 11 }, (_, index) => ({ year: 2015 + index, profit: 1e9 })), zero.get(String(companyId)));
      assert.strictEqual(RULES.evaluateAnnualAnomaly({ latestYear: 2025, years }).status, RULES.STATUS.PASS,
        '明确零分红必须能参与比较，而不是判未知');

      // 对照：同一行去掉"每股 0"的明确性（金额 NULL）→ 必须回到未知。
      await pool.query(`UPDATE fundamental.corporate_actions SET cash_per_share_pre_tax = NULL, total_cash_amount = NULL WHERE source_key='R4Z-ZERO'`);
      const unknown = await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate });
      const unknownRow = (unknown.get(String(companyId)) || []).find(row => row.year === 2018);
      assert.strictEqual(unknownRow.dividendKnown, false, '金额未知不得当零分红');
      assert.strictEqual(unknownRow.dividend, null);
      // 对照：只有预案（未实施）同样未知。
      await pool.query(`UPDATE fundamental.corporate_actions SET status='预案', cash_per_share_pre_tax=0.5, total_cash_amount=1e8, announced_at='2019-05-01' WHERE source_key='R4Z-ZERO'`);
      const plan = await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate });
      const planRow = (plan.get(String(companyId)) || []).find(row => row.year === 2018);
      assert.strictEqual(planRow.dividendKnown, false);
      assert.strictEqual(planRow.dividendBasis, 'plan_only');
    } finally {
      if (companyId) {
        await pool.query(`DELETE FROM fundamental.financial_facts WHERE report_id IN (SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1)`, [companyId]).catch(() => {});
        await pool.query(`DELETE FROM fundamental.financial_reports WHERE company_id=$1`, [companyId]).catch(() => {});
      }
      if (instrumentId) {
        await pool.query(`DELETE FROM fundamental.corporate_actions WHERE instrument_id=$1`, [instrumentId]).catch(() => {});
        await pool.query(`DELETE FROM core.company_instruments WHERE instrument_id=$1`, [instrumentId]).catch(() => {});
        await pool.query(`DELETE FROM core.instruments WHERE instrument_id=$1`, [instrumentId]).catch(() => {});
      }
      if (companyId) await pool.query(`DELETE FROM core.companies WHERE company_id=$1`, [companyId]).catch(() => {});
      await pool.end().catch(() => {});
    }
  });
}

// ===================== 夹具 =====================
/** 与真实 sync_cursors 一致：同一 market 只有一条记录，写入即整体替换。 */
function gapQueueStore() {
  const rows = new Map();
  return {
    rows,
    async saveInputGapQueue({ market, payload }) { rows.set(market, JSON.parse(JSON.stringify(payload))); return 1; },
    async readInputGapQueue({ market }) {
      const payload = rows.get(market);
      return payload ? { cursor_payload: JSON.parse(JSON.stringify(payload)), last_attempt_at: new Date() } : null;
    },
  };
}

/** 真实 inputsSync + 真实写队列的审计替身（复现 R4-02 的持久化语义）。 */
function loadInputsSyncWithRealQueue(store, gaps) {
  let industryBehavior = async () => { throw new Error('not_configured'); };
  stub(path.join(__dirname, '..', 'services', 'stockSelectionService'), {
    auditInputs: async ({ market }) => {
      const payload = {
        market, asOfDate: '2026-09-30', generatedAt: 'x', universeCount: gaps.length, gapCount: gaps.length,
        domainCounts: {}, coverage: { universeCount: gaps.length }, quality: {}, gaps, truncated: false,
      };
      await store.saveInputGapQueue({ market, payload });
      return Object.assign({ queueId: 1 }, payload);
    },
  });
  stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository'), {
    saveInputGapQueue: store.saveInputGapQueue,
    readInputGapQueue: store.readInputGapQueue,
    findInstrumentMeta: async () => null,
  });
  const marketDatasets = require('../dataAccess/marketDatasets');
  const requests = [];
  marketDatasets.readIndustryClassification = async ({ tsCode }) => {
    requests.push(tsCode);
    return industryBehavior(tsCode);
  };
  marketDatasets.readFinancialReportRows = async () => null;
  marketDatasets.readDividendRows = async () => null;
  require('../repositories/industryRepository').upsertIndustryPath = async () => {};
  dropCache('../services/stockSelectionInputsSync');
  const sync = require('../services/stockSelectionInputsSync');
  sync.__setIndustry = fn => { industryBehavior = fn; };
  sync.__lastRequest = () => requests[requests.length - 1];
  return sync;
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
