// 独立验收四项缺口的回归（V-01 — V-04）。
//
// 本文件按验收报告第 9.2 节的反例逐条固化，防止"改回旧实现仍然通过"：
//   V-01 取消/截止被数据层吞成成功空数组，且部分失败只有 warn、无可查询证据；
//   V-02 积压队列先进先出、核心被历史压住，同一槽位重复入队；
//   V-03 父任务截止时间没有约束在途请求，截止后仍保存成功原始记录；
//   V-04 Redis 运行期断连仍放行，敏感入口不返回 503。
// 运行：node server/test/r2-acceptance-v01-v04.test.js（需要隔离测试库）
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PGDATABASE = process.env.PGTESTDATABASE || 'portfolio_test';
process.env.LIXINGER_TOKEN = process.env.LIXINGER_TOKEN || 'test-token-never-stored';

const assert = require('assert');

const official = require('../services/lixingerOfficial');
const tushare = require('../services/tushare');

// 保存真实实现：V-03 必须走"callEndpoint → Guard → requestOnce"的完整链路，不能用注入替身自证。
const realCallEndpoint = official.callEndpoint;
let officialHandler = async () => ({ rows: [] });
official.callEndpoint = (endpointKey, params, options) => officialHandler(endpointKey, params, options);
let tushareHandler = async () => ({ fields: [], items: [] });
tushare.tushareQuery = (...args) => tushareHandler(...args);

const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
const datasets = require('../dataAccess/marketDatasets');
const { createDispatchScheduler, EXECUTOR_CAPACITY, HISTORY_CAPACITY } = require('../services/jobOrchestrator');
const config = require('../config');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const quality = require('../services/valuationFetchQuality');
const { pool } = require('../db/connection');

const cases = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    cases.push(['PASS', name]);
    console.log('  [PASS] ' + name);
  }).catch(error => {
    cases.push(['FAIL', name + ' :: ' + (error && error.message)]);
    console.log('  [FAIL] ' + name + ' :: ' + (error && error.message));
  });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function sourceError(code, message) {
  return Object.assign(new Error(message || code), { code });
}
function valuationRows(params, count = 1) {
  const start = String(params.startDate || params.date || '2026');
  return Array.from({ length: count }, () => ({
    stockCode: String(params.stockCodes && params.stockCodes[0]),
    date: `${start.slice(0, 4)}-12-31`,
    pe_ttm: 20, pb: 5, dyr: 0.02, mc: 1e12, cmc: 9e11,
  }));
}

(async () => {
  console.log('V-01 取消/截止必须上抛，部分失败必须有可查询证据');

  await check('取消与父截止不能被数据层吞成空数组', async () => {
    for (const code of ['CANCELLED', 'DEADLINE_EXCEEDED']) {
      officialHandler = async () => { throw sourceError(code, '模拟'); };
      await assert.rejects(
        datasets.readStockValuationSeriesBatch({ codes: ['600519.SH'], startDate: '2020-01-01', endDate: '2026-10-30' }),
        error => error && error.code === code,
        `${code} 必须原样上抛，不能返回 []`,
      );
      await assert.rejects(
        datasets.readStockValuationHistory({ tsCode: '600519.SH', startDate: '2026-10-01', endDate: '2026-10-30' }),
        error => error && error.code === code,
        `${code} 时历史读取同样不得改用备源继续`,
      );
    }
  });

  await check('快照读取同样区分"取消/截止"与"可回退故障"', async () => {
    tushareHandler = async () => ({ fields: ['ts_code', 'trade_date'], items: [['600519.SH', '20261030']] });
    officialHandler = async () => { throw sourceError('DEADLINE_EXCEEDED', '模拟'); };
    await assert.rejects(
      datasets.readStockValuationRows({ tradeDate: '2026-10-30' }),
      error => error && error.code === 'DEADLINE_EXCEEDED',
      '快照也不得把截止当成"官方没有数据"然后全量回退备源',
    );
    // 可回退故障仍然走备源，语义不能一刀切。
    officialHandler = async () => { throw sourceError('UPSTREAM_5XX', '模拟'); };
    const rows = await datasets.readStockValuationRows({ tradeDate: '2026-10-30' });
    assert.strictEqual(rows.length, 1, '可重试的上游故障应回退备源');
    assert.strictEqual(rows[0].source_code, 'tushare');
  });

  // 复验 RV-01：缺口身份必须带「证券 + 区间」，恢复只能由被完整覆盖的单元触发。
  // 旧断言「长期失败 + 补一个月就 resolved」本身就是错误预期，已删除。
  const cleanupValuationGaps = () => pool.query(
    "DELETE FROM ops.data_quality_issues WHERE dataset_code='stock_valuation' AND issue_type='partial_fetch'",
  );
  const openGapUnits = async () => (await quality.listOpenGaps())
    .map(item => item.details && item.details.unit).filter(Boolean);
  // 只清快照单元：不能让快照用例把前面留下的序列单元一起删掉（那会让后续用例空转）。
  const cleanupSnapshotGaps = () => pool.query(
    "DELETE FROM ops.data_quality_issues WHERE dataset_code='stock_valuation' AND issue_type='partial_fetch' AND details->>'scope'='snapshot'",
  );

  // 只对估值接口生效：年报接口返回空（静态市盈率不参与本用例），避免替身把整段打回备源。
  const valuationStub = failWhen => async (endpointKey, params) => {
    if (!String(endpointKey || '').includes('fundamental')) return { rows: [] };
    if (failWhen(params)) throw sourceError('UPSTREAM_5XX', '某段失败');
    return { rows: valuationRows(params) };
  };

  await check('部分失败按失败单元留证（证券 + 区间），不是一条粗粒度的读取记录', async () => {
    await cleanupValuationGaps();
    const code = '600519.SH';
    officialHandler = valuationStub(params => String(params.startDate) !== '2026-01-01');
    tushareHandler = async () => ({ fields: ['ts_code', 'trade_date'], items: [[code, '20261030']] });
    await datasets.readStockValuationHistory({ tsCode: code, startDate: '1990-01-01', endDate: '2026-10-30' });

    const units = (await openGapUnits()).filter(unit => unit.tsCode === code);
    assert.ok(units.length >= 1, '部分失败必须留下可查询的 open 缺口');
    assert.ok(units.every(unit => unit.from && unit.to), '缺口单元必须带区间，才能查出续跑范围');
    const row = (await quality.listOpenGaps()).find(item => item.details && item.details.unit && item.details.unit.tsCode === code);
    assert.strictEqual(row.status, 'open');
    assert.ok(row.details.failures.length >= 1, '缺口证据里要有该单元的诊断');
    assert.ok(!units.some(unit => unit.from === '2026-01-01'), '成功的段不应记为缺口');
  });

  await check('只补一个月不能关闭长期失败记录', async () => {
    const code = '600519.SH';
    const before = (await openGapUnits()).filter(unit => unit.tsCode === code);
    officialHandler = valuationStub(() => false);
    await datasets.readStockValuationHistory({ tsCode: code, startDate: '2026-10-01', endDate: '2026-10-30' });
    const after = (await openGapUnits()).filter(unit => unit.tsCode === code);
    assert.strictEqual(after.length, before.length, '短区间成功不得关闭原失败单元');
    assert.ok(after.length > 0, '原缺口必须仍是 open');
  });

  await check('换一只证券成功也不能关闭别人的缺口', async () => {
    const code = '600519.SH';
    const other = '000001.SZ';
    const before = (await openGapUnits()).filter(unit => unit.tsCode === code);
    officialHandler = valuationStub(() => false);
    tushareHandler = async () => ({ fields: ['ts_code', 'trade_date'], items: [[other, '20261030']] });
    await datasets.readStockValuationHistory({ tsCode: other, startDate: '2020-01-01', endDate: '2026-10-30' });
    const after = (await openGapUnits()).filter(unit => unit.tsCode === code);
    assert.strictEqual(after.length, before.length, '另一只证券成功不能把这只证券的缺口标成已恢复');
    assert.ok(after.length > 0);
  });

  // 快照是另一类单元（交易日 + 代码集合）：别的代码成功不能关掉这一批的缺口。
  await check('快照缺口按「交易日 + 代码集合」身份记录与恢复', async () => {
    await cleanupSnapshotGaps();
    // 宇宙来自备源清单；官方只对 600519 那一批失败。
    tushareHandler = async () => ({ fields: ['ts_code', 'trade_date'], items: [['600519.SH', '20261030'], ['000001.SZ', '20261030']] });
    officialHandler = async (endpointKey, params) => {
      if (!String(endpointKey || '').includes('fundamental')) return { rows: [] };
      const codes = (params.stockCodes || []).map(String);
      if (codes.includes('600519')) throw sourceError('UPSTREAM_5XX', '该批失败');
      return { rows: params.date ? [{ stockCode: codes[0], date: params.date, pe_ttm: 10, pb: 1, dyr: 0.01, mc: 1e11, cmc: 9e10 }] : [] };
    };
    await datasets.readStockValuationRows({ tradeDate: '2026-10-30' });
    const snapUnits = (await openGapUnits()).filter(unit => unit.kind === 'snapshot');
    assert.ok(snapUnits.length >= 1, '快照部分失败要留下快照单元');
    assert.ok(snapUnits.some(unit => (unit.codes || []).includes('600519.SH')), '单元身份要用站内代码，否则恢复判定永远匹配不上');

    // 只让另一只证券成功：600519 的缺口必须仍然 open。
    officialHandler = async (endpointKey, params) => {
      if (!String(endpointKey || '').includes('fundamental')) return { rows: [] };
      return { rows: [] }; // 成功空批（合法），但不覆盖 600519 那一批
    };
    tushareHandler = async () => ({ fields: ['ts_code', 'trade_date'], items: [['000001.SZ', '20261030']] });
    await datasets.readStockValuationRows({ tradeDate: '2026-10-30' });
    assert.ok((await openGapUnits()).some(unit => (unit.codes || []).includes('600519.SH')), '别的代码成功不能关闭该批缺口');

    // 同一交易日、同一批代码都成功后才关闭。
    tushareHandler = async () => ({ fields: ['ts_code', 'trade_date'], items: [['600519.SH', '20261030'], ['000001.SZ', '20261030']] });
    officialHandler = async (endpointKey, params) => {
      if (!String(endpointKey || '').includes('fundamental')) return { rows: [] };
      const codes = (params.stockCodes || []).map(String);
      return { rows: [{ stockCode: codes[0], date: params.date, pe_ttm: 20, pb: 2, dyr: 0.02, mc: 1e12, cmc: 9e11 }] };
    };
    await datasets.readStockValuationRows({ tradeDate: '2026-10-30' });
    assert.strictEqual((await openGapUnits()).filter(unit => unit.kind === 'snapshot').length, 0, '同批次都成功后快照缺口必须关闭');
    await cleanupSnapshotGaps();
  });

  await check('真正补齐后（同一证券覆盖原区间）才关闭缺口', async () => {
    const code = '600519.SH';
    officialHandler = valuationStub(() => false);
    tushareHandler = async () => ({ fields: ['ts_code', 'trade_date'], items: [[code, '20261030']] });
    await datasets.readStockValuationHistory({ tsCode: code, startDate: '1990-01-01', endDate: '2026-10-30' });
    const left = (await openGapUnits()).filter(unit => unit.tsCode === code);
    assert.strictEqual(left.length, 0, '原区间补齐后该证券的缺口必须全部关闭');
    const resolved = (await pool.query(
      `SELECT count(*)::int n FROM ops.data_quality_issues
        WHERE dataset_code='stock_valuation' AND issue_type='partial_fetch' AND status='resolved'
          AND details->'unit'->>'tsCode'=$1`,
      [code],
    )).rows[0].n;
    assert.ok(resolved >= 1, '关闭要留恢复证据（resolved 行带 resolvedBy）');
    await cleanupValuationGaps();
  });

  console.log('V-02 积压队列必须按最新优先级选择并去重');

  await check('历史先排队也不能把后来的核心任务压在后面', async () => {
    const runs = new Map();
    const started = [];
    const scheduler = createDispatchScheduler({
      capacity: 2, historyCapacity: 1,
      launch: item => {
        started.push(item.slot_id);
        const d = deferred();
        runs.set(item.slot_id, d);
        return d.promise;
      },
    });
    scheduler.enqueue({ slot_id: 1, job_code: 'history_a' }, 'history');
    scheduler.enqueue({ slot_id: 2, job_code: 'normal_a' }, 'normal');
    scheduler.pump();
    await wait(10);
    assert.deepStrictEqual(started.slice().sort(), [1, 2], '历史与普通各占一个槽（普通优先）');

    scheduler.enqueue({ slot_id: 3, job_code: 'history_b' }, 'history');
    scheduler.pump();
    scheduler.enqueue({ slot_id: 4, job_code: 'core_c' }, 'core');
    scheduler.pump();
    await wait(10);
    assert.strictEqual(scheduler.pendingCount(), 2, '两个候选都在排队');

    runs.get(1).resolve();
    await wait(20);
    assert.ok(started.includes(4), '空出的槽必须先给核心任务，而不是先入队的历史任务');
    assert.ok(!started.includes(3), '历史配额还被 normal 之外的规则占着时不能抢跑');
    runs.get(2).resolve(); runs.get(4).resolve();
    await wait(20);
    runs.get(3) && runs.get(3).resolve();
    await wait(20);
  });

  await check('同一槽位重复入队只保留一条（每个 tick 都会重新扫到同一批候选）', async () => {
    const scheduler = createDispatchScheduler({
      capacity: 1, historyCapacity: 1,
      launch: () => deferred().promise, // 一直不结束，保持容量占满
    });
    for (let i = 0; i < 20; i += 1) {
      const outcome = scheduler.enqueue({ slot_id: 99, job_code: 'job_x' }, 'normal');
      if (i === 0) assert.strictEqual(outcome.duplicate, false);
      else assert.strictEqual(outcome.duplicate, true, '重复入队要能识别出来');
    }
    assert.strictEqual(scheduler.pendingCount(), 1, '重复入队不能让队列无限膨胀');
    scheduler.pump();
    await wait(10);
    assert.strictEqual(scheduler.pendingCount(), 0);
  });

  await check('持续有核心任务时历史也不会被永久饿死（等待超阈值提升一次）', async () => {
    let clock = 1000;
    const runs = new Map();
    const started = [];
    const scheduler = createDispatchScheduler({
      capacity: 1, historyCapacity: 1, historyStarvationMs: 100,
      now: () => clock,
      launch: item => {
        started.push(item.slot_id);
        const d = deferred();
        runs.set(item.slot_id, d);
        return d.promise;
      },
    });
    scheduler.enqueue({ slot_id: 1, job_code: 'core_a' }, 'core');
    scheduler.pump();
    await wait(5);
    scheduler.enqueue({ slot_id: 2, job_code: 'history_h' }, 'history');
    clock += 150; // 历史已经等了超过阈值
    scheduler.enqueue({ slot_id: 3, job_code: 'core_b' }, 'core');
    scheduler.pump();
    assert.deepStrictEqual(started, [1], '容量被核心占满时先不启动');
    runs.get(1).resolve();
    await wait(20);
    assert.deepStrictEqual(started, [1, 2], '历史等待超过阈值后必须优先获得一次执行机会');
    runs.get(2).resolve();
    await wait(20);
    assert.deepStrictEqual(started, [1, 2, 3]);
    runs.get(3).resolve();
    await wait(10);
  });

  await check('容量为 1 时历史类退化为串行执行而不是永不执行', async () => {
    assert.ok(HISTORY_CAPACITY >= 1, `容量 ${EXECUTOR_CAPACITY} 时历史配额必须至少为 1，实际 ${HISTORY_CAPACITY}`);
    const runs = new Map();
    const started = [];
    const scheduler = createDispatchScheduler({
      capacity: 1, historyCapacity: 1,
      launch: item => {
        started.push(item.slot_id);
        const d = deferred();
        runs.set(item.slot_id, d);
        return d.promise;
      },
    });
    scheduler.enqueue({ slot_id: 1, job_code: 'history_only' }, 'history');
    scheduler.pump();
    await wait(10);
    assert.deepStrictEqual(started, [1], '容量 1 时历史任务也要能跑起来');
    runs.get(1).resolve();
    await wait(10);
  });

  console.log('V-03 父任务截止必须约束在途请求');

  await check('父截止只剩 40ms 时，请求必须按 40ms 计时而不是被放大到 1 秒', async () => {
    const rawBefore = (await pool.query(
      `SELECT count(*)::int n FROM ops.raw_records WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code='lixinger_official')`,
    )).rows[0].n;
    const startedAt = Date.now();
    await assert.rejects(
      realCallEndpoint('cn/company', { stockCodes: ['600519'] }, {
        fetch: async (url, options) => ({
          ok: true, status: 200,
          text: () => new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(JSON.stringify({ code: 1, data: [{ stockCode: '600519' }] })), 180);
            options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
          }),
        }),
        sleep: async () => {},
        deadlineAt: Date.now() + 40,
        timeoutMs: 5000,
      }),
      error => ['NETWORK_TIMEOUT', 'DEADLINE_EXCEEDED'].includes(error && error.code),
      '父截止到期必须中止，不能被放大到策略时限',
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 150, `必须在父截止附近返回，实际 ${elapsed}ms`);
    const rawAfter = (await pool.query(
      `SELECT count(*)::int n FROM ops.raw_records WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code='lixinger_official')`,
    )).rows[0].n;
    assert.strictEqual(rawAfter, rawBefore, '截止失败的请求不得留下成功原始记录');
  });

  await check('请求在读体期间越过父截止：结果不得落库', async () => {
    const rawBefore = (await pool.query(
      `SELECT count(*)::int n FROM ops.raw_records WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code='lixinger_official')`,
    )).rows[0].n;
    await assert.rejects(
      realCallEndpoint('cn/company', { stockCodes: ['600519'] }, {
        // 响应头立刻返回、读体 160ms 才完成且不理会 abort，模拟"开始未到期、读体中到期"。
        fetch: async () => ({
          ok: true, status: 200,
          text: () => new Promise(resolve => setTimeout(
            () => resolve(JSON.stringify({ code: 1, data: [{ stockCode: '600519' }] })), 160)),
        }),
        sleep: async () => {},
        deadlineAt: Date.now() + 60,
        timeoutMs: 5000,
      }),
      error => error && error.code === 'DEADLINE_EXCEEDED',
      '读体结束时父截止已过，必须按截止失败返回',
    );
    const rawAfter = (await pool.query(
      `SELECT count(*)::int n FROM ops.raw_records WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code='lixinger_official')`,
    )).rows[0].n;
    assert.strictEqual(rawAfter, rawBefore, '截止后才返回的响应不得保存为成功原始记录');
  });

  console.log('V-04 Redis 运行期断连必须立刻 503');

  await check('启动成功但连接未就绪（isReady=false）时敏感入口返回 503', async () => {
    const saved = { nodeEnv: process.env.NODE_ENV, required: process.env.REDIS_REQUIRED };
    process.env.NODE_ENV = 'production';
    process.env.REDIS_REQUIRED = '1';
    let status = 200;
    let passed = false;
    const res = { status(code) { status = code; return this; }, json() { return this; } };

    config.redis.ready = true;
    config.redis.client = { isReady: false, isOpen: true };
    auth.requireSessionStore({}, res, () => { passed = true; });
    assert.strictEqual(passed, false, '断连期间不能放行');
    assert.strictEqual(status, 503, '断连必须立刻 503，而不是让请求排队等重连');

    status = 200; passed = false;
    config.redis.client = { isReady: true, isOpen: false };
    auth.requireSessionStore({}, res, () => { passed = true; });
    assert.strictEqual(passed, false, '连接已关闭同样不放行');

    status = 200; passed = false;
    config.redis.client = { isReady: true, isOpen: true };
    auth.requireSessionStore({}, res, () => { passed = true; });
    assert.strictEqual(passed, true, '真正就绪时必须放行');

    config.redis.ready = false; config.redis.client = null;
    process.env.NODE_ENV = saved.nodeEnv;
    process.env.REDIS_REQUIRED = saved.required || '';
  });

  await check('限流在连接未就绪时不再向 Redis 发命令', async () => {
    let evalCalls = 0;
    config.redis.ready = true;
    config.redis.client = { isReady: false, isOpen: true, eval: async () => { evalCalls += 1; return 1; } };
    const middleware = rateLimit({ prefix: 'v04-probe', windowMs: 60000, max: 1, getKey: () => 'k' });
    const run = async () => {
      let status = 200;
      const res = { status(code) { status = code; return this; }, json() { return this; } };
      await middleware({ ip: '1.1.1.1' }, res, () => {});
      return status;
    };
    assert.strictEqual(await run(), 200, '可选环境应降级到本进程内存计数');
    assert.strictEqual(await run(), 429, '降级后的内存计数同样生效');
    assert.strictEqual(evalCalls, 0, '连接未就绪时不得把命令排进 Redis 离线队列');
    config.redis.ready = false; config.redis.client = null;
  });

  const failed = cases.filter(item => item[0] === 'FAIL');
  console.log(`\n==== 验收反例结果: ${cases.length - failed.length}/${cases.length} 通过 ====`);
  await pool.end().catch(() => {});
  if (failed.length) {
    failed.forEach(item => console.log('  - ' + item[1]));
    process.exit(1);
  }
  console.log('全部通过 ✅');
})().catch(async error => {
  console.error('r2-acceptance-v01-v04.test.js 失败:', (error && error.stack) || error);
  await pool.end().catch(() => {});
  process.exit(1);
});
