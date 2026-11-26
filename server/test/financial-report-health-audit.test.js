'use strict';

// INC-0054 第一阶段「自动检查与告警」回归：健康审计的到期口径必须与保留任务一致。
// 原实现按 --days（默认 1 天）统计 expired_rows，把 2-7 天正常保留和白名单外永久留证
// 都误报成超期；也缺少「单日新写入有效载荷 > 1 GiB」告警与「最老积压时间」。
// 这里用查询替身验证口径与阈值，不连库、不联网、不改任何数据。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const audit = require('../scripts/auditFinancialReportHealth');
const { DEFAULT_PRUNE_DATASETS } = require('../services/storageRetention');

// 查询替身：按 SQL 特征返回固定行，同时记录收到的参数供口径断言。
function fakeClient({ identity, backlog, daily } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/PARTITION BY company_id, report_kind, period_end/.test(sql)) {
        return { rows: [identity || { window_rows: 0, redundant_rows: 0, groups: 0 }] };
      }
      if (/GROUP BY r.dataset_code/.test(sql)) return { rows: backlog || [] };
      if (/make_interval\(hours => 24\)/.test(sql)) return { rows: [daily || { payload_bytes: 0, rows: 0 }] };
      if (/SET statement_timeout/.test(sql)) return { rows: [] };
      throw new Error(`未预期的查询：${sql.slice(0, 80)}`);
    },
  };
}

async function run() {
  // --- 1) 到期口径只算白名单数据集 ---
  const whitelisted = backlogRow({ dataset: 'lixinger_response', rows: 100, expired: 10, oldest: '2026-11-01T00:00:00Z' });
  const outOfWhitelist = backlogRow({ dataset: 'dividends', rows: 500, expired: 499, oldest: '2026-10-01T00:00:00Z' });
  const client = fakeClient({ backlog: [whitelisted, outOfWhitelist] });
  const backlog = await audit.auditRawBacklog(client, { retentionDays: 7 });
  assert.strictEqual(backlog.retentionDays, 7);
  assert.strictEqual(backlog.expiredRows, 10, '只有保留白名单数据集的到期记录计入超期');
  assert.strictEqual(backlog.oldestExpiredAt, '2026-11-01T00:00:00Z', '最老积压只取白名单内的到期记录');
  const whitelistEntry = backlog.datasets.find(item => item.dataset === 'lixinger_response');
  assert.strictEqual(whitelistEntry.inRetentionWhitelist, true);
  assert.strictEqual(whitelistEntry.expiredRows, 10);
  const excludedEntry = backlog.datasets.find(item => item.dataset === 'dividends');
  assert.strictEqual(excludedEntry.inRetentionWhitelist, false, '白名单外数据集要标注出来，便于判断是否纳入保留任务');
  assert.strictEqual(excludedEntry.expiredRows, 0, '白名单外不参与到期告警');
  assert.deepStrictEqual(backlog.outOfWhitelist, { rows: 500, payloadBytes: 1024 }, '白名单外仍如实统计存量');
  assert.deepStrictEqual([...DEFAULT_PRUNE_DATASETS].sort(),
    ['balance', 'cashflow', 'income', 'indicators', 'lixinger_response'],
    '到期口径直接复用保留任务的白名单，不得另写一份');

  // 到期 SQL 的保留窗口与反查引用必须与 storageRetentionRepository 完全一致
  const backlogSql = client.calls.find(call => /GROUP BY r.dataset_code/.test(call.sql)).sql;
  assert.deepStrictEqual(client.calls.find(call => /GROUP BY r.dataset_code/.test(call.sql)).params, [7],
    '保留天数必须作为参数进入到期条件（默认 7 天，可配）');
  assert.ok(/make_interval\(days => \$1\)/.test(backlogSql), '到期窗口必须按天计算，不能按 1 天窗口');
  const retentionSrc = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'storageRetentionRepository.js'), 'utf8');
  for (const table of ['fundamental.financial_reports', 'event.documents', 'market.repo_daily_rates', 'market.instrument_trade_rules']) {
    assert.ok(retentionSrc.includes(table), `保留仓储应引用 ${table}`);
    assert.ok(backlogSql.includes(table), `到期口径必须与保留任务同一引用清单：缺 ${table}`);
  }
  assert.ok(!/r\.ingested_at < now\(\) - \(\$1::int \* interval '1 day'\)/.test(backlogSql),
    '不得沿用原来按 --days 计算的口径');

  // --- 2) 单日有效载荷阈值（默认 1 GiB，可配）---
  assert.strictEqual(audit.payloadDailyLimitOf({}), 1024 ** 3, '默认阈值 1 GiB');
  assert.strictEqual(audit.payloadDailyLimitOf({ RAW_PAYLOAD_DAILY_ALERT_BYTES: String(2 * 1024 ** 3) }), 2 * 1024 ** 3);
  assert.strictEqual(audit.retentionDaysOf({}), 7, '默认保留 7 天，与 storageRetention 一致');
  assert.strictEqual(audit.retentionDaysOf({ RAW_RECORDS_RETENTION_DAYS: '30' }), 30);
  assert.strictEqual(audit.retentionDaysOf({ RAW_RECORDS_RETENTION_DAYS: '0' }), 1, '保留天数下限 1 天');
  assert.strictEqual(audit.retentionDaysOf({ RAW_RECORDS_RETENTION_DAYS: 'abc' }), 7, '非法值回落默认值');

  const under = await audit.auditDailyWrites(fakeClient({ daily: { payload_bytes: 1024 ** 3, rows: 10 } }), { limitBytes: 1024 ** 3 });
  assert.strictEqual(under.verdict, 'within_limit', '等于阈值不算超限');
  const over = await audit.auditDailyWrites(fakeClient({ daily: { payload_bytes: 1024 ** 3 + 1, rows: 10 } }), { limitBytes: 1024 ** 3 });
  assert.strictEqual(over.verdict, 'daily_payload_over_limit');

  // --- 3) 告警项与退出码语义 ---
  const diskOk = { readable: true, suspended: false, freeBytes: 50 * 1024 ** 3, minFreeBytes: 8 * 1024 ** 3 };
  const clean = audit.buildAlerts({
    duplicates: { redundantRows: 0 },
    backlog: { expiredRows: 0, retentionDays: 7, oldestExpiredAt: null },
    daily: { payloadBytes: 10 * 1024 ** 2 },
    disk: diskOk,
    limits: { expiredRows: 200000, dailyPayloadBytes: 1024 ** 3 },
  });
  assert.deepStrictEqual(clean, [], '正常重放与低写入量不得误报');

  const alerts = audit.buildAlerts({
    duplicates: { redundantRows: 3 },
    backlog: { expiredRows: 200001, retentionDays: 7, oldestExpiredAt: '2026-11-01T00:00:00Z' },
    daily: { payloadBytes: 15 * 1024 ** 3 },
    disk: diskOk,
    limits: { expiredRows: 200000, dailyPayloadBytes: 1024 ** 3 },
  });
  assert.strictEqual(alerts.length, 3, '重复、到期积压、单日载荷三个条件都要各自告警');
  assert.ok(alerts.some(item => item.includes('最近 24 小时新写入有效载荷')), '缺「单日有效载荷 > 1 GiB」告警项');
  assert.ok(alerts.some(item => item.includes('最老 2026-11-01T00:00:00Z')), '到期告警必须带最老积压时间');

  const diskAlerts = audit.buildAlerts({
    duplicates: { redundantRows: 0 },
    backlog: { expiredRows: 0, retentionDays: 7, oldestExpiredAt: null },
    daily: { payloadBytes: 0 },
    disk: { readable: true, suspended: true, freeBytes: 1, minFreeBytes: 2 },
    limits: { expiredRows: 200000, dailyPayloadBytes: 1024 ** 3 },
  });
  assert.strictEqual(diskAlerts.length, 1, '根盘低于停止线仍单独告警');

  // --- 4) 纯只读：脚本不得包含写操作 ---
  const scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'auditFinancialReportHealth.js'), 'utf8');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/.test(scriptSrc.replace(/^\s*\/\/.*$/gm, '')),
    '健康审计必须是纯只读脚本');

  // --- 5) F-10：健康审计必须和其余运维审计一样登记统一 npm 入口 ---
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['audit:financial-health'], 'node server/scripts/auditFinancialReportHealth.js',
    'F-10: 财报健康审计脚本必须在 package.json scripts 中登记统一入口');

  console.log('财报健康审计口径（白名单到期/最老积压/单日载荷）验证通过');
}

function backlogRow({ dataset, rows, expired, oldest }) {
  return {
    dataset_code: dataset,
    rows,
    distinct_payloads: rows,
    payload_bytes: 1024,
    expired_rows: expired,
    oldest_expired_at: oldest,
    latest: '2026-11-26T00:00:00Z',
  };
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
