#!/usr/bin/env node
// N5：同口径维护指标只读统计入口（2026-11-02）
//
// 定位：把《运行与成本容量基线》第 5 节的口径变成可重复执行的只读统计，
// 供月度复盘用同一把尺子比较。它不采集、不写库、不发通知、不连接生产。
//
// 硬约束（方案 10.5）：
//   - 只读：所有 SQL 必须 SELECT（运行时断言，出现其它语句直接抛错）；
//   - 默认预演：不加 --run 只打印口径与 SQL，不连数据库；
//   - 上海自然月左闭右开：`--month=2026-11` → [2026-11-01, 2026-12-01)，时区 Asia/Shanghai；
//   - 输出只有聚合计数，不含凭据、账号明细、持仓或原始记录；
//   - 取不到的口径进 `unknown` 并写清所需来源，禁止用 0 或空值填平。
//
// 用法：
//   node server/scripts/maintenanceMetrics.js --month=2026-11            # 预演：打印口径与 SQL
//   node server/scripts/maintenanceMetrics.js --month=2026-11 --run      # 执行只读统计，输出 JSON
'use strict';

const path = require('path');

// 状态词归一：真实库里同一含义存在多个拼写（2026-11-02 实测 ops.ingestion_runs 有
// succeeded/success/completed 三种成功词），统计必须显式映射，不能只匹配一种。
const INGESTION_STATUS_GROUPS = {
  success: ['succeeded', 'success', 'completed'],
  failed: ['failed', 'degraded'],
  running: ['running'],
};

const JOB_STATUS_GROUPS = {
  success: ['done', 'success', 'succeeded', 'completed'],
  failed: ['failed', 'error'],
  running: ['running', 'started'],
  paused: ['paused', 'skipped', 'not_run'],
};

const PARTITION_STATUS_GROUPS = {
  published: ['published'],
  rejected: ['rejected', 'failed'],
  stale: ['stale'],
  pending: ['pending'],
};

// 需要 shell / 人工具备来源、本脚本不自行采集的口径。
const EXTERNAL_METRICS = [
  { code: 'disk_usage', name: '根分区使用率与可用空间', source: '服务器 `df -h /`', reason: '脚本只连数据库，不做主机探测' },
  { code: 'db_size', name: '数据库逻辑大小', source: '`pg_database_size()`', reason: '可只读取得，但属于容量专项采样范围，避免每轮统计顺带压生产库' },
  { code: 'pdf_cache', name: '应用数据目录与 PDF 缓存体积', source: '服务器 `du -sh`', reason: '文件系统指标，不在 SQL 范围' },
  { code: 'backup_groups', name: '备份目录体积与组数', source: '服务器 `du -sh` + 时间戳前缀去重', reason: '同上' },
  { code: 'service_memory', name: '两个 systemd 单元内存', source: '`systemctl show -p MemoryCurrent`', reason: '主机侧指标' },
  { code: 'cost', name: '实际费用', source: '云账单（周期/币种/服务）', reason: '服务器上没有账单，API 调用次数不能换算成钱' },
  { code: 'fillable_gap', name: '可补缺口与有效补齐率', source: '按业务对象/字段/业务日建立确认可补集合后统计', reason: '需要先有分母定义，当前未建立，报率会失真' },
  { code: 'duplicate_crawl', name: '重复外采与恢复耗时', source: '同接口/对象/窗口的事件链', reason: '缺少把「缺口确认→有效可用」串起来的关联字段' },
  { code: 'delivery_cycle', name: '交付耗时与返工', source: '任务卡阶段起止 + Git 提交', reason: '不在数据库内，需人工按任务卡整理' },
];

function normalizeMonth(month) {
  const text = String(month || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) {
    throw new Error('--month 必须是 YYYY-MM（例如 2026-11）');
  }
  return text;
}

// 上海自然月 → 左闭右开的绝对时间区间。用显式 +08:00 偏移，禁止依赖服务器本地时区。
function monthRange(month) {
  const text = normalizeMonth(month);
  const [year, mon] = text.split('-').map(Number);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const pad = n => String(n).padStart(2, '0');
  return {
    month: text,
    timezone: 'Asia/Shanghai',
    fromDate: `${text}-01`,
    toDateExclusive: `${nextYear}-${pad(nextMon)}-01`,
    fromTs: `${text}-01T00:00:00+08:00`,
    toTsExclusive: `${nextYear}-${pad(nextMon)}-01T00:00:00+08:00`,
  };
}

// 只读护栏：任何非 SELECT 语句一律拒绝，避免被误改成写入口。
function assertReadOnly(sql) {
  const text = String(sql).trim();
  if (!/^SELECT\b/i.test(text) && !/^WITH\b/i.test(text)) {
    throw new Error('维护指标只允许只读查询，拒绝执行：' + text.slice(0, 60));
  }
  return text;
}

function groupOf(groups, rawStatus) {
  const text = String(rawStatus || '').toLowerCase();
  for (const [group, values] of Object.entries(groups)) {
    if (values.includes(text)) return group;
  }
  return 'other';
}

const QUERIES = {
  jobRuns: `SELECT status, trigger_type, slot_id, attempt_no, started_at
              FROM public.job_runs
             WHERE started_at >= $1 AND started_at < $2`,
  partitions: `SELECT dataset_code, status, partition_key::text AS partition_key, data_as_of::text AS data_as_of, is_stale
                 FROM ops.dataset_partitions
                WHERE partition_key >= $1::date AND partition_key < $2::date`,
  ingestion: `SELECT source_id, dataset_code, status, row_count
                FROM ops.ingestion_runs
               WHERE started_at >= $1 AND started_at < $2`,
  circuits: `SELECT source, api_name, state, recover_at, last_success_at, consecutive_rate_limit_count
               FROM ops.external_circuits
              WHERE state <> 'closed'`,
};

function buildPlan(month) {
  const range = monthRange(month);
  const plan = {
    range,
    queries: [
      { code: 'jobRuns', params: [range.fromTs, range.toTsExclusive], sql: QUERIES.jobRuns },
      { code: 'partitions', params: [range.fromDate, range.toDateExclusive], sql: QUERIES.partitions },
      { code: 'ingestion', params: [range.fromTs, range.toTsExclusive], sql: QUERIES.ingestion },
      { code: 'circuits', params: [], sql: QUERIES.circuits },
    ],
  };
  plan.queries.forEach(q => assertReadOnly(q.sql));
  return plan;
}

// 纯计算：把原始行变成同口径指标。抽成纯函数便于固定样本对账，不依赖数据库。
function summarize({ jobRows = [], partitionRows = [], ingestionRows = [], circuitRows = [], range }) {
  const jobByStatus = {};
  const jobByTrigger = {};
  const jobByGroup = { success: 0, failed: 0, running: 0, paused: 0, other: 0 };
  const slots = new Set();
  let retries = 0;
  for (const row of jobRows) {
    const status = String(row.status || '');
    jobByStatus[status] = (jobByStatus[status] || 0) + 1;
    jobByGroup[groupOf(JOB_STATUS_GROUPS, status)] += 1;
    const trigger = String(row.trigger_type || 'unknown');
    jobByTrigger[trigger] = (jobByTrigger[trigger] || 0) + 1;
    if (row.slot_id != null) slots.add(String(row.slot_id));
    if (Number(row.attempt_no) > 1) retries += 1;
  }

  const partitionByStatus = {};
  const partitionByGroup = { published: 0, rejected: 0, stale: 0, pending: 0, other: 0 };
  const datasets = new Set();
  let staleFlagged = 0;
  for (const row of partitionRows) {
    const status = String(row.status || '');
    partitionByStatus[status] = (partitionByStatus[status] || 0) + 1;
    partitionByGroup[groupOf(PARTITION_STATUS_GROUPS, status)] += 1;
    if (row.dataset_code) datasets.add(String(row.dataset_code));
    if (row.is_stale === true) staleFlagged += 1;
  }

  const ingestionByStatus = {};
  const ingestionByGroup = { success: 0, failed: 0, running: 0, other: 0 };
  let ingestionRowsTotal = 0;
  for (const row of ingestionRows) {
    const status = String(row.status || '');
    ingestionByStatus[status] = (ingestionByStatus[status] || 0) + 1;
    ingestionByGroup[groupOf(INGESTION_STATUS_GROUPS, status)] += 1;
    ingestionRowsTotal += Number(row.row_count) || 0;
  }

  const openCircuits = (circuitRows || []).map(row => ({
    source: row.source || '',
    api: row.api_name || '',
    state: row.state || '',
    // 无恢复时间的 open 熔断属于「无法自动恢复」，必须显性标出而不是当普通开断。
    recoverAt: row.recover_at ? new Date(row.recover_at).toISOString() : null,
    needsManualRecovery: !row.recover_at,
    consecutiveRateLimit: Number(row.consecutive_rate_limit_count) || 0,
  }));

  return {
    month: range.month,
    range: {
      from: range.fromDate,
      toExclusive: range.toDateExclusive,
      timezone: range.timezone,
    },
    jobRuns: {
      total: jobRows.length,
      byStatus: jobByStatus,
      byGroup: jobByGroup,
      byTrigger: jobByTrigger,
      uniqueSlots: slots.size,
      retries,
      // 同槽重试说明：执行次数（total）与真实工作量（uniqueSlots）必须分开看，
      // 直接把执行次数当月度工作量会把重试算成新任务。
      note: '执行次数 total 含重试；工作量看 uniqueSlots',
    },
    partitions: {
      total: partitionRows.length,
      byStatus: partitionByStatus,
      byGroup: partitionByGroup,
      datasets: datasets.size,
      staleFlagged,
    },
    ingestion: {
      total: ingestionRows.length,
      byStatus: ingestionByStatus,
      byGroup: ingestionByGroup,
      rows: ingestionRowsTotal,
    },
    circuits: {
      openCount: openCircuits.length,
      needsManualRecovery: openCircuits.filter(c => c.needsManualRecovery).length,
      items: openCircuits,
    },
    unknown: EXTERNAL_METRICS,
  };
}

async function collect(month, options = {}) {
  const plan = buildPlan(month);
  if (!options.run) return { preview: true, plan };

  const { pool } = options.pool ? { pool: options.pool } : require('../db/connection');
  const jobRes = await pool.query(assertReadOnly(QUERIES.jobRuns), plan.queries[0].params);
  const partRes = await pool.query(assertReadOnly(QUERIES.partitions), plan.queries[1].params);
  const ingestRes = await pool.query(assertReadOnly(QUERIES.ingestion), plan.queries[2].params);
  const circuitRes = await pool.query(assertReadOnly(QUERIES.circuits), plan.queries[3].params);

  return Object.assign(
    { preview: false, generatedAt: new Date().toISOString(), source: 'local-database' },
    summarize({
      jobRows: jobRes.rows,
      partitionRows: partRes.rows,
      ingestionRows: ingestRes.rows,
      circuitRows: circuitRes.rows,
      range: plan.range,
    })
  );
}

async function main() {
  const args = process.argv.slice(2);
  const monthArg = args.find(a => a.startsWith('--month='));
  const month = monthArg ? monthArg.split('=')[1] : null;
  const run = args.includes('--run');
  if (!month) {
    console.error('用法：node server/scripts/maintenanceMetrics.js --month=YYYY-MM [--run]');
    process.exit(2);
  }

  const result = await collect(month, { run });
  if (result.preview) {
    console.log('【预演】不连接数据库。口径与将执行的只读 SQL 如下：');
    console.log(JSON.stringify(result.plan, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
  if (run) {
    const { pool } = require('../db/connection');
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('维护指标统计失败：' + ((error && error.message) || error));
    process.exitCode = 1;
  });
}

module.exports = {
  monthRange,
  buildPlan,
  summarize,
  collect,
  assertReadOnly,
  INGESTION_STATUS_GROUPS,
  JOB_STATUS_GROUPS,
  PARTITION_STATUS_GROUPS,
  EXTERNAL_METRICS,
};

// path 仅用于未来扩展到报告落盘时解析相对路径，保持引号不产生未使用告警。
void path;
