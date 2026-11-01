#!/usr/bin/env node
// 发布身份探针（验收 S-001）：部署脚本在健康检查通过后调用，核对"同一次发布"的四件事。
//
//   1) 目标提交：调用方传入的 head（部署脚本的 git rev-parse HEAD）；
//   2) Web 实际加载：本机 /health 自述的 commit / version / pid；
//   3) Worker 实际加载：ops.worker_heartbeats 最新 running 心跳的 commit_sha / app_version / pid；
//   4) 迁移就绪：schema_migrations 是否已包含当前代码里的全部迁移版本（不是"目录里字母序最后一个文件"）。
//
// 输出一行：IDENTITY_OK ... / IDENTITY_MISMATCH reasons=... / IDENTITY_UNKNOWN ...；
// 退出码：0 通过 / 3 身份不一致 / 2 无法检查。密钥与连接串不打印。
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
 * 纯判定：给定四类事实得出是否同一次发布。可离线回归，不连网络/数据库。
 * @param {object} p expectHead 目标提交；expectVersion 目标版本；
 *   health /health 自述（可为 null）；worker 最新心跳行（可为 null）；
 *   appliedVersions 已应用迁移；requiredVersions 代码要求迁移；now 时钟（测试可注入）
 */
function evaluateIdentity({ expectHead, expectVersion, health, worker, appliedVersions, requiredVersions, now = Date.now() }) {
  const reasons = [];
  const facts = [];

  if (!health) {
    reasons.push('health_unreachable');
  } else {
    facts.push(`web_version=${health.version || 'none'}`, `web_commit=${short(health.commit)}`, `web_pid=${health.pid || 'none'}`);
    if (expectVersion && String(health.version || '') !== expectVersion) reasons.push('web_version_mismatch');
    if (!health.commit) reasons.push('web_commit_unknown');
    else if (expectHead && String(health.commit) !== expectHead) reasons.push('web_commit_mismatch');
  }

  const applied = new Set((appliedVersions || []).map(item => String(item)));
  const required = (requiredVersions || []).map(item => String(item));
  const missing = required.filter(version => !applied.has(version));
  const latest = required[required.length - 1];
  facts.push(`migrations_applied=${applied.size}`, `migrations_latest=${latest || 'none'}`);
  if (missing.length) reasons.push(`migrations_missing=${missing.slice(0, 5).join('|')}`);

  if (!worker) {
    reasons.push('worker_heartbeat_missing');
  } else {
    const lastSeen = new Date(worker.last_seen_at).getTime();
    const ageMs = now - lastSeen;
    facts.push(
      `worker_id=${worker.worker_id}`, `worker_status=${worker.status}`, `worker_pid=${worker.pid}`,
      `worker_version=${worker.app_version || 'none'}`, `worker_commit=${short(worker.commit_sha)}`,
      `worker_heartbeat_age_s=${Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : 'unknown'}`,
    );
    if (worker.status !== 'running') reasons.push('worker_not_running');
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 120000) reasons.push('worker_heartbeat_stale');
    if (expectVersion && String(worker.app_version || '') !== expectVersion) reasons.push('worker_version_mismatch');
    // 心跳提交号为空只说明这一版还没承载（旧进程/迁移未跑），记未知；有值就必须与目标一致。
    if (worker.commit_sha) {
      if (expectHead && String(worker.commit_sha) !== expectHead) reasons.push('worker_commit_mismatch');
    } else {
      facts.push('worker_commit=unknown');
    }
  }

  const line = `${reasons.length ? 'IDENTITY_MISMATCH' : 'IDENTITY_OK'} expect_head=${short(expectHead)} ${facts.join(' ')}${reasons.length ? ` reasons=${reasons.join(',')}` : ''}`;
  return { ok: reasons.length === 0, reasons, facts, line: line.replace(/\s+/g, ' ').trim() };
}

async function main() {
  const envFile = process.env.MIGRATION_ENV_FILE;
  if (envFile) {
    try { require('dotenv').config({ path: envFile }); } catch (_) { /* 由下面的连接错误兜底 */ }
  }
  if (process.env.MIGRATION_DATABASE_URL) process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;

  const expectHead = arg('expect-head').trim();
  const expectVersion = arg('expect-version').trim();
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

  const verdict = evaluateIdentity({ expectHead, expectVersion, health, worker, appliedVersions, requiredVersions });
  if (pool) await pool.end().catch(() => {});
  console.log(verdict.line);
  process.exit(verdict.ok ? 0 : 3);
}

if (require.main === module) {
  main().catch(error => {
    console.error('IDENTITY_UNAVAILABLE', String((error && error.message) || error).slice(0, 120));
    process.exit(2);
  });
}

module.exports = { evaluateIdentity, fetchHealth, short, main };
