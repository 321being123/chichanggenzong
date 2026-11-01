// 执行器队头阻塞与候选公平（审查 R2-006）。规则：TASK-EXECUTOR-TIER-004。
//
// 两部分：
//   1) 有界容量 + 补位调度的行为（受控屏障，不连数据库）；
//   2) 候选按执行分类在 LIMIT 之前排序/过滤（静态钉住仓储 SQL 与编排层接线）。
// 运行：node server/test/job-executor-backlog.test.js
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PGDATABASE = process.env.PGTESTDATABASE || 'portfolio_test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createDispatchScheduler, executionTier, slotTier, EXECUTOR_CAPACITY, HISTORY_CAPACITY } = require('../services/jobOrchestrator');

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

function slot(id, jobCode, payload) {
  return { slot_id: id, job_code: jobCode, request_payload: payload || null };
}

(async () => {
  console.log('A. 分类判定');

  await check('任务定义与请求模式共同决定执行分类', async () => {
    assert.strictEqual(executionTier({ importance: 'high' }), 0, '高重要度 = 核心');
    assert.strictEqual(executionTier({}), 1, '未知定义按普通处理，不冒充核心也不打进冷宫');
    assert.strictEqual(executionTier({ mode: 'enrichment' }), 2, '补全模式 = 历史/低优先级');
    assert.strictEqual(executionTier({ importance: 'high', mode: 'backfill' }), 2, '显式回填模式优先按历史处理');
    // 同一任务两种模式：槽位请求里的 mode 覆盖定义。
    assert.strictEqual(slotTier({ job_code: 'ipo_history_sync', request_payload: { mode: 'enrichment' } }), 2);
    assert.strictEqual(slotTier({ job_code: 'ipo_calendar_refresh', request_payload: { mode: 'core' } }), 0);
  });

  console.log('B. 有界执行与补位');

  await check('历史任务在跑时，核心任务必须能立刻开始', async () => {
    const historyRun = deferred();
    const coreRun = deferred();
    const started = [];
    const scheduler = createDispatchScheduler({
      capacity: 2,
      historyCapacity: 1,
      launch: item => {
        started.push(item.job_code);
        return item.job_code === 'history_job' ? historyRun.promise : coreRun.promise;
      },
    });
    scheduler.enqueue(slot(1, 'history_job'), 'history');
    scheduler.pump();
    await wait(10);
    scheduler.enqueue(slot(2, 'core_job'), 'core');
    scheduler.pump();
    await wait(10);
    assert.deepStrictEqual(started, ['history_job', 'core_job'], '历史任务未结束前，核心任务也必须已经开跑');
    assert.strictEqual(scheduler.running(), 2);
    historyRun.resolve(); coreRun.resolve();
    await wait(20);
    assert.strictEqual(scheduler.running(), 0);
  });

  await check('历史容量占满时新历史任务排队，核心结束也不会挤进去', async () => {
    const runs = new Map();
    const started = [];
    const scheduler = createDispatchScheduler({
      capacity: 2,
      historyCapacity: 1,
      launch: item => {
        started.push(item.job_code + '#' + item.slot_id);
        const d = deferred();
        runs.set(item.slot_id, d);
        return d.promise;
      },
    });
    scheduler.enqueue(slot(1, 'history_a'), 'history');
    scheduler.enqueue(slot(2, 'core_a'), 'core');
    scheduler.enqueue(slot(3, 'history_b'), 'history');
    scheduler.pump();
    await wait(10);
    // 2026-11-01 验收 V-02：派发顺序按分类优先（核心先于历史），与入队顺序无关。
    assert.deepStrictEqual(started.slice().sort(), ['core_a#2', 'history_a#1'], '历史类最多占 historyCapacity 个槽');
    assert.strictEqual(scheduler.pendingCount(), 1, '第二个历史任务应排队');
    runs.get(2).resolve();
    await wait(20);
    assert.strictEqual(started.length, 2, '核心结束时历史配额仍被占满，不能抢跑');
    runs.get(1).resolve();
    await wait(20);
    assert.ok(started.includes('history_b#3'), '历史槽释放后必须补位');
    runs.get(3).resolve();
    await wait(20);
  });

  await check('同一 job_code 在本进程内串行，其他任务不受影响', async () => {
    const runs = new Map();
    const started = [];
    const scheduler = createDispatchScheduler({
      capacity: 3,
      historyCapacity: 1,
      launch: item => {
        started.push(item.slot_id);
        const d = deferred();
        runs.set(item.slot_id, d);
        return d.promise;
      },
    });
    scheduler.enqueue(slot(1, 'same_job'), 'normal');
    scheduler.enqueue(slot(2, 'same_job'), 'normal');
    scheduler.enqueue(slot(3, 'other_job'), 'normal');
    scheduler.pump();
    await wait(10);
    assert.deepStrictEqual(started.slice().sort(), [1, 3], '同一个任务不能并行两个槽');
    assert.strictEqual(scheduler.pendingCount(), 1);
    runs.get(1).resolve();
    await wait(20);
    assert.deepStrictEqual(started.slice().sort(), [1, 2, 3], '前一个结束后补位');
    runs.get(2).resolve(); runs.get(3).resolve();
    await wait(20);
  });

  await check('容量满时排队，任一任务结束立刻补位（不等整轮结束）', async () => {
    const runs = new Map();
    const started = [];
    const scheduler = createDispatchScheduler({
      capacity: 2,
      historyCapacity: 1,
      launch: item => {
        started.push(item.slot_id);
        const d = deferred();
        runs.set(item.slot_id, d);
        return d.promise;
      },
    });
    for (let i = 1; i <= 4; i += 1) scheduler.enqueue(slot(i, 'job_' + i), 'normal');
    scheduler.pump();
    await wait(10);
    assert.strictEqual(started.length, 2);
    assert.strictEqual(scheduler.pendingCount(), 2);
    runs.get(1).resolve();
    await wait(20);
    assert.strictEqual(started.length, 3, '有任务结束时必须立刻补位');
    runs.get(2).resolve();
    await wait(20);
    assert.strictEqual(started.length, 4, '第二个空出的槽同样要立刻补位');
    runs.get(3).resolve(); runs.get(4).resolve();
    await wait(20);
    assert.strictEqual(scheduler.running(), 0);
  });

  await check('派发失败也要释放容量，避免计数泄漏', async () => {
    const started = [];
    const scheduler = createDispatchScheduler({
      capacity: EXECUTOR_CAPACITY,
      historyCapacity: HISTORY_CAPACITY,
      launch: item => {
        started.push(item.slot_id);
        if (item.slot_id === 1) return Promise.reject(new Error('claim 失败'));
        return Promise.resolve();
      },
    });
    scheduler.enqueue(slot(1, 'job_x'), 'normal');
    scheduler.enqueue(slot(2, 'job_y'), 'normal');
    scheduler.pump();
    await wait(30);
    assert.deepStrictEqual(started, [1, 2], '前一个抛错不能让后续任务永远排队');
    assert.strictEqual(scheduler.running(), 0);
  });

  console.log('C. 候选公平性（LIMIT 之前分类）');

  const repoSource = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'jobScheduleSlotsRepository.js'), 'utf8');
  const orchestratorSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobOrchestrator.js'), 'utf8');
  const slotsSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobScheduleSlots.js'), 'utf8');

  await check('候选 SQL 按分类排序并支持分类过滤（不是取前 20 条再排序）', async () => {
    assert.match(repoSource, /policy\(job_code text,max_attempts integer,tier integer\)/, '候选策略要带分类');
    assert.match(repoSource, /policy\.tier = ANY\(\$3\)/, '必须能在 SQL 里按分类过滤');
    assert.match(repoSource, /ORDER BY policy\.tier ASC, scheduled_for ASC/, '排序必须在 LIMIT 之前生效');
  });

  await check('编排层分别取核心/普通与历史候选', async () => {
    assert.match(orchestratorSource, /tiers: \[TIER_CORE, TIER_NORMAL\]/, '核心/普通候选单独取');
    assert.match(orchestratorSource, /tiers: \[TIER_HISTORY\]/, '历史候选单独取，保留固定名额');
    assert.match(slotsSource, /options\.tiers/, 'listDueSlots 必须把这个过滤传给仓储');
  });

  await check('扫描与长任务生命周期解耦：不再因整轮执行返回 busy', async () => {
    assert.ok(!/executor_busy/.test(orchestratorSource), '整轮 executing 的 busy 逻辑必须去掉');
    assert.match(orchestratorSource, /executor_dispatching/, '只挡派发重入');
    assert.match(orchestratorSource, /scheduler\.pump\(\)/, '派发后由调度器补位，不在这里逐个 await');
  });

  await check('停机先停止新领取，再排空运行集合', async () => {
    assert.match(orchestratorSource, /clearPending\(\)/, '停机必须清空未派发候选');
  });

  const failed = cases.filter(item => item[0] === 'FAIL');
  console.log(`\n==== 执行器调度结果: ${cases.length - failed.length}/${cases.length} 通过 ====`);
  if (failed.length) {
    failed.forEach(item => console.log('  - ' + item[1]));
    process.exit(1);
  }
  console.log('全部通过 ✅');
  process.exit(0);
})().catch(error => {
  console.error('job-executor-backlog.test.js 失败:', (error && error.stack) || error);
  process.exit(1);
});
