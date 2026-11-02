// N5：同口径维护指标的固定样本对账 + 真实库只读冒烟
//
// 方案 10.5 的要求是「先做固定离线样本的统计对账，包含同槽重试、跨月、重复缺口、
// 补齐后又失败、正常等待/权限、缺日志和缺账单；所有排除必须可解释」。
// 本文件覆盖其中与现有数据源相关的部分，并对没有数据源的口径显式断言「进 unknown 而不是 0」。
//
// 边界：真实库只做 SELECT 冒烟（证明 SQL 在当前 schema 上可执行），不插入任何统计样本，
// 因此本文件不需要清理业务表，也不会影响其它用例。
'use strict';

const assert = require('assert');
const metrics = require('../scripts/maintenanceMetrics');

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    failures.push(name + ' :: ' + (error && error.message));
    console.log('  ✗ ' + name + ' —— ' + (error && error.message));
  }
}

(async () => {
  try {
    // ==================== 一、月份边界：上海自然月、左闭右开 ====================
    await test('自然月区间是左闭右开的绝对时间，不依赖服务器本地时区', function () {
      const nov = metrics.monthRange('2026-11');
      assert.strictEqual(nov.fromDate, '2026-11-01');
      assert.strictEqual(nov.toDateExclusive, '2026-12-01');
      assert.strictEqual(nov.fromTs, '2026-11-01T00:00:00+08:00');
      assert.strictEqual(nov.toTsExclusive, '2026-12-01T00:00:00+08:00');
      assert.strictEqual(nov.timezone, 'Asia/Shanghai');
    });

    await test('跨年月份不加错年份', function () {
      const dec = metrics.monthRange('2026-12');
      assert.strictEqual(dec.toDateExclusive, '2027-01-01');
      const jan = metrics.monthRange('2027-01');
      assert.strictEqual(jan.fromDate, '2027-01-01');
    });

    await test('上海 10-31 23:59:59 属于 10 月，11-01 00:00 属于 11 月', function () {
      const oct = metrics.monthRange('2026-10');
      const nov = metrics.monthRange('2026-11');
      const lastMomentOfOct = Date.parse('2026-10-31T23:59:59+08:00');
      const firstMomentOfNov = Date.parse('2026-11-01T00:00:00+08:00');
      assert.ok(lastMomentOfOct >= Date.parse(oct.fromTs) && lastMomentOfOct < Date.parse(oct.toTsExclusive),
        '10-31 23:59:59+08 必须落在 10 月区间内');
      assert.ok(firstMomentOfNov >= Date.parse(nov.fromTs), '11-01 00:00+08 必须落在 11 月区间内');
      // 同一瞬间用 UTC 表示时是 10-31T15:59Z：若按 UTC 截日会错算成 10 月，这里显式守住。
      assert.strictEqual(new Date(lastMomentOfOct).toISOString(), '2026-10-31T15:59:59.000Z');
    });

    await test('非法月份被拒绝（不许静默猜成当月）', function () {
      assert.throws(() => metrics.monthRange('2026-13'), /YYYY-MM/);
      assert.throws(() => metrics.monthRange('202611'), /YYYY-MM/);
      assert.throws(() => metrics.monthRange(''), /YYYY-MM/);
    });

    // ==================== 二、只读护栏 ====================
    await test('只读护栏拒绝写语句', function () {
      assert.ok(metrics.assertReadOnly('SELECT 1'));
      assert.ok(metrics.assertReadOnly('  with x as (select 1) select * from x'));
      assert.throws(() => metrics.assertReadOnly('DELETE FROM nav_history'), /只允许只读/);
      assert.throws(() => metrics.assertReadOnly('UPDATE accounts SET cash_base=0'), /只允许只读/);
      assert.throws(() => metrics.assertReadOnly('INSERT INTO job_runs VALUES (1)'), /只允许只读/);
      assert.throws(() => metrics.assertReadOnly('DROP TABLE job_runs'), /只允许只读/);
    });

    await test('预演模式不连库，只回口径与 SQL', async function () {
      const plan = await metrics.collect('2026-11', { run: false });
      assert.strictEqual(plan.preview, true);
      assert.strictEqual(plan.plan.queries.length, 4);
      for (const q of plan.plan.queries) {
        assert.ok(/^(SELECT|WITH)\b/i.test(q.sql.trim()), '预演里也不能出现写语句');
      }
    });

    // ==================== 三、固定样本对账 ====================
    const range = metrics.monthRange('2026-11');

    await test('同槽重试：执行次数与真实工作量必须分开统计', function () {
      const result = metrics.summarize({
        range,
        jobRows: [
          { status: 'done', trigger_type: 'scheduled', slot_id: 11, attempt_no: 1 },
          { status: 'failed', trigger_type: 'auto_retry', slot_id: 11, attempt_no: 2 },
          { status: 'done', trigger_type: 'manual_retry', slot_id: 11, attempt_no: 3 },
          { status: 'done', trigger_type: 'scheduled', slot_id: 12, attempt_no: 1 },
        ],
      });
      assert.strictEqual(result.jobRuns.total, 4, '执行次数含重试');
      assert.strictEqual(result.jobRuns.uniqueSlots, 2, '工作量按唯一槽位算');
      assert.strictEqual(result.jobRuns.retries, 2, 'attempt_no>1 记重试');
      assert.strictEqual(result.jobRuns.byGroup.success, 3);
      assert.strictEqual(result.jobRuns.byGroup.failed, 1);
      assert.strictEqual(result.jobRuns.byTrigger.auto_retry, 1);
      assert.ok(result.jobRuns.note.includes('重试'), '口径说明必须随结果返回');
    });

    await test('暂停/未运行不算失败，也不能算成功', function () {
      const result = metrics.summarize({
        range,
        jobRows: [
          { status: 'paused', trigger_type: 'scheduled', slot_id: 1, attempt_no: 1 },
          { status: 'skipped', trigger_type: 'scheduled', slot_id: 2, attempt_no: 1 },
          { status: 'not_run', trigger_type: 'scheduled', slot_id: 3, attempt_no: 1 },
        ],
      });
      assert.strictEqual(result.jobRuns.byGroup.paused, 3);
      assert.strictEqual(result.jobRuns.byGroup.failed, 0, '未运行不是故障');
      assert.strictEqual(result.jobRuns.byGroup.success, 0, '未运行也不是成功');
    });

    await test('采集状态词归一到同一口径（succeeded/success/completed 都是成功）', function () {
      const result = metrics.summarize({
        range,
        ingestionRows: [
          { status: 'succeeded', row_count: 10, dataset_code: 'a' },
          { status: 'success', row_count: 5, dataset_code: 'a' },
          { status: 'completed', row_count: 7, dataset_code: 'b' },
          { status: 'failed', row_count: 0, dataset_code: 'b' },
          { status: 'degraded', row_count: 3, dataset_code: 'c' },
          { status: 'running', row_count: 0, dataset_code: 'c' },
        ],
      });
      assert.strictEqual(result.ingestion.total, 6);
      assert.strictEqual(result.ingestion.byGroup.success, 3, '三种成功词必须都算成功');
      assert.strictEqual(result.ingestion.byGroup.failed, 2, 'degraded 是部分失败，必须计入失败侧');
      assert.strictEqual(result.ingestion.byGroup.running, 1);
      assert.strictEqual(result.ingestion.rows, 25, '行数按成功/失败一起累加实际写入行数');
      assert.deepStrictEqual(Object.keys(result.ingestion.byStatus).sort(),
        ['completed', 'degraded', 'failed', 'running', 'succeeded', 'success'],
        '原始状态词必须留档，不能用归一值掩盖');
    });

    await test('未知状态进 other，不被悄悄算进成功或失败', function () {
      const result = metrics.summarize({
        range,
        jobRows: [{ status: 'weird_state', trigger_type: 'scheduled', slot_id: 1, attempt_no: 1 }],
        ingestionRows: [{ status: 'mystery', row_count: 1, dataset_code: 'x' }],
        partitionRows: [{ status: 'mystery', dataset_code: 'x', is_stale: false }],
      });
      assert.strictEqual(result.jobRuns.byGroup.other, 1);
      assert.strictEqual(result.ingestion.byGroup.other, 1);
      assert.strictEqual(result.partitions.byGroup.other, 1);
      assert.strictEqual(result.jobRuns.byGroup.success, 0);
    });

    await test('分区质量与数据集覆盖：stale 标记和数据集数分别统计', function () {
      const result = metrics.summarize({
        range,
        partitionRows: [
          { dataset_code: 'market.daily_valuations', status: 'published', is_stale: false },
          { dataset_code: 'market.daily_valuations', status: 'published', is_stale: true },
          { dataset_code: 'market.csi_all_valuation', status: 'rejected', is_stale: false },
          { dataset_code: 'market.csi_all_valuation', status: 'stale', is_stale: true },
        ],
      });
      assert.strictEqual(result.partitions.total, 4);
      assert.strictEqual(result.partitions.byGroup.published, 2);
      assert.strictEqual(result.partitions.byGroup.rejected, 1);
      assert.strictEqual(result.partitions.byGroup.stale, 1);
      assert.strictEqual(result.partitions.staleFlagged, 2, 'is_stale 与 status 是两个维度，都要留');
      assert.strictEqual(result.partitions.datasets, 2, '数据集按去重计');
    });

    await test('无恢复时间的 open 熔断必须标成「需人工恢复」', function () {
      const result = metrics.summarize({
        range,
        circuitRows: [
          { source: 'tushare', api_name: 'daily', state: 'open', recover_at: new Date('2026-11-02T10:00:00Z'), consecutive_rate_limit_count: 2 },
          { source: 'lixinger_official', api_name: 'fundamental', state: 'open', recover_at: null, consecutive_rate_limit_count: 0 },
        ],
      });
      assert.strictEqual(result.circuits.openCount, 2);
      assert.strictEqual(result.circuits.needsManualRecovery, 1, '没有 recover_at 的 open 熔断不会自愈');
      const manual = result.circuits.items.find(i => i.needsManualRecovery);
      assert.strictEqual(manual.source, 'lixinger_official');
      assert.strictEqual(manual.recoverAt, null);
    });

    await test('取不到的口径进 unknown，不许用 0 冒充', function () {
      const result = metrics.summarize({ range });
      const codes = result.unknown.map(u => u.code);
      for (const required of ['cost', 'disk_usage', 'fillable_gap', 'duplicate_crawl', 'delivery_cycle']) {
        assert.ok(codes.includes(required), '缺少 unknown 项：' + required);
      }
      for (const item of result.unknown) {
        assert.ok(item.source && item.reason, '每个 unknown 必须写清所需来源与原因：' + item.code);
      }
      assert.strictEqual(result.circuits.openCount, 0);
      assert.ok(!('cost' in result), '费用不能以 0 出现在指标里');
    });

    // ==================== 四、真实库只读冒烟 ====================
    await test('真实库只读冒烟：四条 SQL 在现行 schema 上可执行', async function () {
      let result;
      try {
        result = await metrics.collect('2026-10', { run: true });
      } catch (error) {
        // 连不上库不能记通过，但也不能让整个文件变成"静默跳过"。
        throw new Error('本地数据库不可用或 SQL 不可执行：' + error.message);
      }
      assert.strictEqual(result.preview, false);
      assert.ok(result.range.from === '2026-10-01' && result.range.toExclusive === '2026-11-01');
      for (const key of ['jobRuns', 'partitions', 'ingestion', 'circuits']) {
        assert.ok(result[key], '缺少指标组：' + key);
      }
      assert.ok(Number.isFinite(result.jobRuns.total));
      assert.ok(Number.isFinite(result.partitions.total));
      assert.ok(Number.isFinite(result.ingestion.total));
      // 只读证明：跑完后数据不能被改动——再查一次同样口径，条数必须一致。
      const again = await metrics.collect('2026-10', { run: true });
      assert.strictEqual(again.jobRuns.total, result.jobRuns.total, '统计不得改动任务记录');
      assert.strictEqual(again.partitions.total, result.partitions.total);
      assert.strictEqual(again.ingestion.total, result.ingestion.total);
      console.log('    实测 2026-10：任务 ' + result.jobRuns.total + ' 次 / 唯一槽位 ' + result.jobRuns.uniqueSlots
        + ' · 分区 ' + result.partitions.total + ' · 采集 ' + result.ingestion.total + ' 次 · 开断 ' + result.circuits.openCount);
    });

  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }

  console.log('维护指标同口径回归：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) {
    failures.forEach(item => console.log('  失败：' + item));
    process.exitCode = 1;
  }
  // 连接由 collect 内部按需创建，这里统一收尾，避免进程挂住。
  try { require('../db/connection').pool.end(); } catch (_) { /* 未建立连接时忽略 */ }
})().catch(error => { console.error(error); process.exitCode = 1; });
