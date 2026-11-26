#!/usr/bin/env node
// 财报与原始报文健康审计（INC-0054 第一阶段「自动检查与告警」的落地入口）。
//
// 事故当时的缺口是：没有一处能回答「今天的写入有没有出现业务层面的重复」「原始报文积压
// 到什么程度」「根盘还能撑几批」——只能等到任务整 1800 秒超时才发现。
// 本脚本只读，按四个口径出结论，发现异常用非零退出码交给外层告警：
//   1) 完整身份重复：与写入口径一致（含证券代码与币种），同身份两行即为异常；
//      正常的幂等冲重更新和真实更正（不同公告日）不算重复。
//   2) 原始报文积压：到期可清条数必须与保留任务同一口径——只算 storage_retention 白名单
//      数据集、超过保留天数（默认 7 天）、且没有被业务外键引用的记录，并给出最老积压时间。
//      原来按 --days（默认 1 天）统计，把 2-7 天正常保留和白名单外永久留证都算成超期。
//   3) 每日有效载荷：最近 24 小时新写入的字段字节超过阈值（默认 1 GiB）即告警。
//   4) 根盘余量：低于统一停止线就报出来（与历史补采的止损同一套阈值，见 services/diskGuard）。
//
// 用法：
//   node server/scripts/auditFinancialReportHealth.js                 # 审计最近 1 天的重复写入
//   node server/scripts/auditFinancialReportHealth.js --days=7 --json   # 机器可读
// 退出码：0 = 正常；1 = 命中任一告警条件。
//
// 阈值（都可配）：
//   RAW_RECORDS_RETENTION_DAYS        到期口径的保留天数，与 storageRetention 同一变量（默认 7）
//   RAW_RECORD_EXPIRED_ALERT_ROWS     到期可清条数上限（默认 200000）
//   RAW_PAYLOAD_DAILY_ALERT_BYTES     最近 24 小时有效载荷字节上限（默认 1 GiB）

const { pool } = require('../db');
const { checkHistoryCollectionSpace } = require('../services/diskGuard');
const { DEFAULT_PRUNE_DATASETS } = require('../services/storageRetention');

const DEFAULT_EXPIRED_ROWS = 200000;
const DEFAULT_PAYLOAD_DAILY_BYTES = 1024 ** 3;

function argOf(name, fallback) {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
}

// 保留口径与 storageRetention 一致：同一个环境变量、同一个默认值与取值范围。
function retentionDaysOf(env = process.env) {
  return clampInt(env.RAW_RECORDS_RETENTION_DAYS, 7, 1, 365);
}

function expiredRowLimitOf(env = process.env) {
  return Math.max(1, Number(env.RAW_RECORD_EXPIRED_ALERT_ROWS || DEFAULT_EXPIRED_ROWS));
}

function payloadDailyLimitOf(env = process.env) {
  const value = Number(env.RAW_PAYLOAD_DAILY_ALERT_BYTES || DEFAULT_PAYLOAD_DAILY_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PAYLOAD_DAILY_BYTES;
}

function log(text, asJson) {
  if (!asJson) console.log(text);
}

// 完整业务身份（与 stockProjectionRepository.reportIdentityVersion 同口径）：
// 缺了证券代码和币种就会把 A/H 或不同币种的报告误判成重复，这正是本次清理脚本的已知缺陷。
const IDENTITY_SQL = `
  WITH ident AS (
    SELECT report_id, company_id, report_kind, period_end, source_id,
           COALESCE(report_type,'') AS rt,
           COALESCE(comp_type,'') AS ct,
           COALESCE(NULLIF(update_flag,''),'0') AS uf,
           announced_at, f_ann_date,
           COALESCE(statement_scope,'consolidated') AS sc,
           upper(COALESCE(raw_payload->>'ts_code','')) AS code,
           upper(COALESCE(NULLIF(raw_payload->>'currency',''),
             CASE WHEN upper(COALESCE(raw_payload->>'ts_code','')) ~ '^[0-9]{6}[.](SH|SZ|BJ)$'
                  THEN 'CNY' ELSE '' END)) AS ccy
      FROM fundamental.financial_reports
     WHERE ingested_at >= now() - ($1::int * interval '1 day')
  ), ranked AS (
    SELECT report_id,
           row_number() OVER (
             PARTITION BY company_id, report_kind, period_end, source_id, rt, ct, uf, announced_at, f_ann_date, sc, code, ccy
             ORDER BY report_id
           ) AS rn
      FROM ident
  )
  SELECT count(*)::int AS window_rows,
         count(*) FILTER (WHERE rn > 1)::int AS redundant_rows,
         count(*) FILTER (WHERE rn = 1)::int AS groups
    FROM ranked`;

// 到期可清记录的反查清单必须与 storageRetentionRepository.deleteExpiredUnreferencedRawRecords
// 保持一致：多一处引用会把可清记录误报成超期，少一处会把仍有效的原文报成可清。
const UNREFERENCED_SQL = `
      NOT EXISTS (SELECT 1 FROM fundamental.financial_reports fr WHERE fr.raw_record_id = r.raw_record_id)
  AND NOT EXISTS (SELECT 1 FROM event.documents d WHERE d.raw_record_id = r.raw_record_id)
  AND NOT EXISTS (SELECT 1 FROM market.repo_daily_rates rr WHERE rr.raw_record_id = r.raw_record_id)
  AND NOT EXISTS (SELECT 1 FROM market.instrument_trade_rules tr WHERE tr.raw_record_id = r.raw_record_id)`;

async function auditDuplicates(client, days) {
  const { rows } = await client.query(IDENTITY_SQL, [days]);
  const row = rows[0] || {};
  const redundant = Number(row.redundant_rows || 0);
  return {
    windowDays: days,
    windowRows: Number(row.window_rows || 0),
    redundantRows: redundant,
    identityGroups: Number(row.groups || 0),
    verdict: redundant > 0 ? 'has_duplicates' : 'clean',
  };
}

async function auditRawBacklog(client, options = {}) {
  const retentionDays = options.retentionDays == null ? retentionDaysOf() : options.retentionDays;
  const whitelist = options.datasets || [...DEFAULT_PRUNE_DATASETS];
  const expiredCondition = `r.ingested_at < now() - make_interval(days => $1)
       AND ${UNREFERENCED_SQL}`;
  const { rows } = await client.query(
    `SELECT r.dataset_code,
            count(*)::int AS rows,
            count(DISTINCT r.payload_hash)::int AS distinct_payloads,
            COALESCE(sum(pg_column_size(r.payload)),0)::bigint AS payload_bytes,
            count(*) FILTER (WHERE ${expiredCondition})::int AS expired_rows,
            min(r.ingested_at) FILTER (WHERE ${expiredCondition}) AS oldest_expired_at,
            max(r.ingested_at) AS latest
       FROM ops.raw_records r
      GROUP BY r.dataset_code
      ORDER BY payload_bytes DESC
      LIMIT 30`, [retentionDays]);
  const whitelistSet = new Set(whitelist);
  const datasets = rows.map(item => ({
    dataset: item.dataset_code,
    rows: Number(item.rows || 0),
    distinctPayloads: Number(item.distinct_payloads || 0),
    payloadBytes: Number(item.payload_bytes || 0),
    // 只有白名单数据集才会被保留任务清理；白名单外的"超期"不是积压，是永久留证。
    inRetentionWhitelist: whitelistSet.has(item.dataset_code),
    expiredRows: whitelistSet.has(item.dataset_code) ? Number(item.expired_rows || 0) : 0,
    oldestExpiredAt: whitelistSet.has(item.dataset_code) ? (item.oldest_expired_at || null) : null,
    latest: item.latest || null,
  }));
  const expiredRows = datasets.reduce((sum, item) => sum + item.expiredRows, 0);
  const oldestExpiredAt = datasets
    .map(item => item.oldestExpiredAt)
    .filter(Boolean)
    .sort()[0] || null;
  // 白名单外仍如实统计，方便判断是否该纳入保留任务，但不计入到期告警。
  const outOfWhitelist = datasets
    .filter(item => !item.inRetentionWhitelist)
    .reduce((acc, item) => ({ rows: acc.rows + item.rows, payloadBytes: acc.payloadBytes + item.payloadBytes }), { rows: 0, payloadBytes: 0 });
  return {
    retentionDays,
    datasets,
    expiredRows,
    oldestExpiredAt,
    outOfWhitelist,
  };
}

// 最近 24 小时新写入的有效载荷：事故当天四类转换报文一天就近 9.5 GiB，单日阈值必须先于磁盘报警。
async function auditDailyWrites(client, options = {}) {
  const limitBytes = options.limitBytes == null ? payloadDailyLimitOf() : options.limitBytes;
  const { rows } = await client.query(
    `SELECT COALESCE(sum(pg_column_size(payload)),0)::bigint AS payload_bytes,
            count(*)::int AS rows,
            min(ingested_at) AS first_at,
            max(ingested_at) AS latest_at
       FROM ops.raw_records
      WHERE ingested_at >= now() - make_interval(hours => 24)`);
  const row = rows[0] || {};
  const payloadBytes = Number(row.payload_bytes || 0);
  return {
    windowHours: 24,
    rows: Number(row.rows || 0),
    payloadBytes,
    limitBytes,
    firstAt: row.first_at || null,
    latestAt: row.latest_at || null,
    verdict: payloadBytes > limitBytes ? 'daily_payload_over_limit' : 'within_limit',
  };
}

function buildAlerts({ duplicates, backlog, daily, disk, limits }) {
  const alerts = [];
  if (duplicates.redundantRows > 0) alerts.push(`同身份重复 ${duplicates.redundantRows} 行`);
  if (backlog.expiredRows > limits.expiredRows) {
    alerts.push(`到期可清原始报文 ${backlog.expiredRows} 条（上限 ${limits.expiredRows}，保留 ${backlog.retentionDays} 天，最老 ${backlog.oldestExpiredAt || '-'}）`);
  }
  if (daily.payloadBytes > limits.dailyPayloadBytes) {
    alerts.push(`最近 24 小时新写入有效载荷 ${(daily.payloadBytes / 1024 ** 3).toFixed(2)} GiB（上限 ${(limits.dailyPayloadBytes / 1024 ** 3).toFixed(2)} GiB）`);
  }
  if (disk.suspended) {
    alerts.push(`根盘可用低于停止线（可用 ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GiB，停止线 ${(disk.minFreeBytes / 1024 ** 3).toFixed(1)} GiB）`);
  }
  return alerts;
}

async function main() {
  const days = Math.max(1, Math.min(90, Number(argOf('days', 1)) || 1));
  const asJson = process.argv.includes('--json');
  const limits = { expiredRows: expiredRowLimitOf(), dailyPayloadBytes: payloadDailyLimitOf() };
  const client = await pool.connect();
  try {
    // 审计是只读统计，允许跑慢，不因单条语句超时把整个检查判成失败。
    await client.query("SET statement_timeout = '0'");
    const duplicates = await auditDuplicates(client, days);
    const backlog = await auditRawBacklog(client, { retentionDays: retentionDaysOf() });
    const daily = await auditDailyWrites(client, { limitBytes: limits.dailyPayloadBytes });
    const disk = await checkHistoryCollectionSpace();
    const alerts = buildAlerts({ duplicates, backlog, daily, disk, limits });
    const result = {
      ok: alerts.length === 0,
      alerts,
      duplicates,
      backlog,
      daily,
      disk,
      limits,
      generatedAt: new Date().toISOString(),
    };

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      log(`财报健康审计（重复窗口 ${days} 天，保留口径 ${backlog.retentionDays} 天）`, asJson);
      log(`- 报告写入 ${duplicates.windowRows} 行，完整身份重复 ${duplicates.redundantRows} 行 -> ${duplicates.verdict}`, asJson);
      log(`- 到期可清原始报文 ${backlog.expiredRows} 条（上限 ${limits.expiredRows}，最老 ${backlog.oldestExpiredAt || '-'}）`, asJson);
      backlog.datasets.slice(0, 8).forEach(item => {
        const mib = (item.payloadBytes / 1024 ** 2).toFixed(1);
        const expired = item.inRetentionWhitelist ? `到期可清 ${item.expiredRows}` : '白名单外（不计到期）';
        log(`    ${item.dataset}: ${item.rows} 行 / 去重 ${item.distinctPayloads} / ${mib} MiB / ${expired}`, asJson);
      });
      log(`- 最近 24 小时新写入 ${daily.rows} 条 / ${(daily.payloadBytes / 1024 ** 3).toFixed(2)} GiB（上限 ${(limits.dailyPayloadBytes / 1024 ** 3).toFixed(2)} GiB）-> ${daily.verdict}`, asJson);
      log(disk.readable
        ? `- 根盘可用 ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GiB，停止线 ${(disk.minFreeBytes / 1024 ** 3).toFixed(1)} GiB -> ${disk.suspended ? '低于停止线，历史补采应暂停' : '充足'}`
        : '- 根盘余量读取失败（不据此暂停补采，需人工核查）', asJson);
      log(alerts.length ? `告警：${alerts.join('；')}` : '结论：未命中告警条件', asJson);
    }
    if (!result.ok) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = {
  IDENTITY_SQL,
  retentionDaysOf,
  expiredRowLimitOf,
  payloadDailyLimitOf,
  auditDuplicates,
  auditRawBacklog,
  auditDailyWrites,
  buildAlerts,
  main,
};

if (require.main === module) {
  main().catch(error => {
    console.error('[audit-financial] 失败：', error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
