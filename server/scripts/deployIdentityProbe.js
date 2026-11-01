#!/usr/bin/env node
// 发布身份探针（验收 S-001）：部署脚本在健康检查通过后调用，核对"同一次发布"的四件事。
//
//   1) 目标提交：调用方传入的 head（部署脚本的 git rev-parse HEAD）；
//   2) Web 实际加载：本机 /health 自述的 commit / version / pid；
//   3) Worker 实际加载：ops.worker_heartbeats 最新 running 心跳的 commit_sha / app_version / pid；
//   4) 迁移就绪：schema_migrations 是否已包含当前代码里的全部迁移版本（不是"目录里字母序最后一个文件"）。
//
// 输出一行：IDENTITY_OK ... / IDENTITY_MISMATCH reasons=... / IDENTITY_UNKNOWN unverified=...；
// 退出码：0 同一次发布 / 3 明确不一致 / 2 无法核实（缺证据，不是通过）。密钥与连接串不打印。
// 复验 RV-03：缺 Worker 提交号、缺心跳、/health 不可达一律走「无法核实」，不再输出 OK。
//
// 用法（服务器上）：
//   MIGRATION_ENV_FILE=/etc/portfolio/migration.env \
//     /usr/bin/node server/scripts/deployIdentityProbe.js --expect-head=<sha> --expect-version=<0.9.x.y>
'use strict';

const http = require('http');

function arg(name) {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

function short(sha) {
  return sha ? String(sha).slice(0, 12) : 'none';
}

function fetchHealth(port = Number(process.env.PORT) || 3000, timeoutMs = 5000) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * 纯判定：把四类事实归到「同一次发布 / 明确不一致 / 无法核实」三态。可离线回归，不连网络/数据库。
 *
 * 复验 RV-03 修正：Worker 提交号为空以前只记一条 fact 就照常输出 IDENTITY_OK —— 那是假通过。
 * 现在「无法核实」必须是独立结论（IDENTITY_UNKNOWN），不能被读成同提交通过；
 * 同时把心跳与当前 unit 的 PID / 启动时刻绑定，避免拿上一条旧进程的心跳顶替本次发布。
 *
 * @param {object} p
 *   expectHead 目标提交；expectVersion 目标版本；
 *   health /health 自述（可为 null）；worker 最新心跳行（可为 null）；
 *   appliedVersions 已应用迁移；requiredVersions 代码要求迁移；
 *   expectWebPid/expectWorkerPid 当前 unit 的 MainPID（来自 systemctl）；
 *   expectWebStarted/expectWorkerStarted 当前 unit 的 ActiveEnterTimestamp；
 *   now 时钟（测试可注入）
 */
const PROCESS_START_TOLERANCE_MS = 60 * 1000;

function toTime(value) {
  if (!value) return NaN;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
}

function evaluateIdentity({
  expectHead, expectVersion, health, worker, appliedVersions, requiredVersions,
  expectWebPid, expectWorkerPid, expectWebStarted, expectWorkerStarted, now = Date.now(),
}) {
  // 明确矛盾（能证明"不是这次发布"）与无法核实（缺证据）必须分开：混在一起会把缺证据当通过，
  // 也会把环境限制当代码回滚理由。
  const mismatch = [];
  const unknown = [];
  const facts = [];

  if (!health) {
    unknown.push('health_unreachable');
  } else {
    facts.push(`web_version=${health.version || 'none'}`, `web_commit=${short(health.commit)}`, `web_pid=${health.pid || 'none'}`);
    if (expectVersion && String(health.version || '') !== expectVersion) mismatch.push('web_version_mismatch');
    if (!health.commit) unknown.push('web_commit_unknown');
    else if (expectHead && String(health.commit) !== expectHead) mismatch.push('web_commit_mismatch');
    // 进程绑定：health 自述的 PID 必须就是当前 unit 的 MainPID，否则说明响应来自旧进程/别的实例。
    if (expectWebPid && String(health.pid || '') !== String(expectWebPid)) mismatch.push('web_pid_mismatch');
    const webStarted = toTime(health.startedAt);
    const unitWebStarted = toTime(expectWebStarted);
    if (Number.isFinite(webStarted) && Number.isFinite(unitWebStarted) && webStarted < unitWebStarted - PROCESS_START_TOLERANCE_MS) {
      mismatch.push('web_process_older_than_unit');
    }
  }

  const applied = new Set((appliedVersions || []).map(item => String(item)));
  const required = (requiredVersions || []).map(item => String(item));
  const missing = required.filter(version => !applied.has(version));
  const latest = required[required.length - 1];
  facts.push(`migrations_applied=${applied.size}`, `migrations_latest=${latest || 'none'}`);
  if (missing.length) mismatch.push(`migrations_missing=${missing.slice(0, 5).join('|')}`);

  if (!worker) {
    // 没有心跳就证明不了 Worker 是本次提交：只能算未核实。
    unknown.push('worker_heartbeat_missing');
  } else {
    const lastSeen = toTime(worker.last_seen_at);
    const ageMs = now - lastSeen;
    facts.push(
      `worker_id=${worker.worker_id}`, `worker_status=${worker.status}`, `worker_pid=${worker.pid}`,
      `worker_version=${worker.app_version || 'none'}`, `worker_commit=${short(worker.commit_sha)}`,
      `worker_heartbeat_age_s=${Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : 'unknown'}`,
    );
    if (worker.status !== 'running') mismatch.push('worker_not_running');
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 120000) mismatch.push('worker_heartbeat_stale');
    if (expectVersion && String(worker.app_version || '') !== expectVersion) mismatch.push('worker_version_mismatch');
    // 心跳必须属于当前 unit 的进程：PID 不符或启动时刻早于 unit 启动，都是旧进程留下的心跳。
    if (expectWorkerPid && String(worker.pid || '') !== String(expectWorkerPid)) mismatch.push('worker_pid_mismatch');
    const workerStarted = toTime(worker.started_at);
    const unitWorkerStarted = toTime(expectWorkerStarted);
    if (Number.isFinite(workerStarted) && Number.isFinite(unitWorkerStarted) && workerStarted < unitWorkerStarted - PROCESS_START_TOLERANCE_MS) {
      mismatch.push('worker_process_older_than_unit');
    }
    // 缺提交号 = 未核实（不是一致）；有值就必须与目标提交相同。
    if (!worker.commit_sha) unknown.push('worker_commit_unknown');
    else if (expectHead && String(worker.commit_sha) !== expectHead) mismatch.push('worker_commit_mismatch');
  }

  const status = mismatch.length ? 'mismatch' : (unknown.length ? 'unknown' : 'ok');
  const label = status === 'ok' ? 'IDENTITY_OK' : status === 'mismatch' ? 'IDENTITY_MISMATCH' : 'IDENTITY_UNKNOWN';
  const tail = [
    mismatch.length ? `reasons=${mismatch.join(',')}` : '',
    unknown.length ? `unverified=${unknown.join(',')}` : '',
  ].filter(Boolean).join(' ');
  const line = `${label} expect_head=${short(expectHead)} ${facts.join(' ')}${tail ? ` ${tail}` : ''}`;
  return { status, ok: status === 'ok', mismatch, unknown, reasons: [...mismatch, ...unknown], facts, line: line.replace(/\s+/g, ' ').trim() };
}

async function main() {
  const envFile = process.env.MIGRATION_ENV_FILE;
  if (envFile) {
    try { require('dotenv').config({ path: envFile }); } catch (_) { /* 由下面的连接错误兜底 */ }
  }
  if (process.env.MIGRATION_DATABASE_URL) process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;

  const expectHead = arg('expect-head').trim();
  const expectVersion = arg('expect-version').trim();
  const expectWebPid = arg('expect-web-pid').trim();
  const expectWorkerPid = arg('expect-worker-pid').trim();
  const expectWebStarted = arg('expect-web-started').trim();
  const expectWorkerStarted = arg('expect-worker-started').trim();
  const health = await fetchHealth();

  let pool;
  let appliedVersions = [];
  let requiredVersions = [];
  let worker = null;
  try {
    ({ pool } = require('../db/connection'));
    const { MIGRATIONS } = require('../db/migrations');
    requiredVersions = MIGRATIONS.map(item => item.version);
    appliedVersions = (await pool.query('SELECT version FROM schema_migrations')).rows.map(row => String(row.version));
    const heartbeat = await pool.query(
      `SELECT worker_id, pid, app_version, status, commit_sha, started_at, last_seen_at
         FROM ops.worker_heartbeats
        WHERE role IN ('worker','worker-health')
        ORDER BY last_seen_at DESC LIMIT 1`,
    );
    worker = heartbeat.rows[0] || null;
  } catch (error) {
    // 无法检查数据库不能等同于"身份一致"：单独标记，由部署脚本按 UNKNOWN 记录。
    console.log(`IDENTITY_UNKNOWN probe_failed=${String((error && error.message) || '').slice(0, 80).replace(/\s+/g, '_')}`);
    if (pool) await pool.end().catch(() => {});
    process.exit(2);
  }

  const verdict = evaluateIdentity({
    expectHead, expectVersion, health, worker, appliedVersions, requiredVersions,
    expectWebPid, expectWorkerPid, expectWebStarted, expectWorkerStarted,
  });
  if (pool) await pool.end().catch(() => {});
  console.log(verdict.line);
  // 0 同一次发布 / 3 明确不一致 / 2 无法核实（不是通过，也不冒充不一致）。
  process.exit(verdict.status === 'ok' ? 0 : verdict.status === 'mismatch' ? 3 : 2);
}

if (require.main === module) {
  main().catch(error => {
    console.error('IDENTITY_UNAVAILABLE', String((error && error.message) || error).slice(0, 120));
    process.exit(2);
  });
}

module.exports = { evaluateIdentity, fetchHealth, short, main };
