#!/usr/bin/env node
// ========== 反馈发布闭环受控命令（2026-10-23） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第七、八节。
// 只做反馈服务的命令适配器：状态规则、权限、事件留痕全部走 server/services/feedbackRelease.js，
// 本文件不实现第二套状态判断，也不接受用户提供的 SQL。
//
// 用法（在服务器以应用账号运行，生产读走只读事务）：
//   node server/scripts/reconcileFeedbackRelease.js --mode read [--limit 100] [--after-id 123]
//   node server/scripts/reconcileFeedbackRelease.js --mode detail --feedback-id 12
//   node server/scripts/reconcileFeedbackRelease.js --mode prepare \
//        --deployment-id <uuid> --release-sha <sha> --app-version 0.8.4.12 [--base-sha <sha>] [--owner <名>]
//   node server/scripts/reconcileFeedbackRelease.js --mode conclusions --run-id 3 < conclusions.json
//   node server/scripts/reconcileFeedbackRelease.js --mode freeze --run-id 3
//   node server/scripts/reconcileFeedbackRelease.js --mode verify --run-id 3 --pass < evidence.json
//   node server/scripts/reconcileFeedbackRelease.js --mode apply --run-id 3 --operator <名>
//   node server/scripts/reconcileFeedbackRelease.js --mode status --run-id 3
//
// 连接规则：先固定加载 .env（优先 /opt/portfolio/.env），沿用应用角色连接；
// 不使用 MIGRATION_DATABASE_URL，也不设置 MIGRATION_ROLE。日志不输出连接串与私密正文。
const path = require('path');
const fs = require('fs');

function loadEnvFile() {
  const candidates = [
    process.env.FEEDBACK_ENV_FILE,
    '/opt/portfolio/.env',
    path.join(__dirname, '..', '..', '.env'),
  ].filter(Boolean);
  const found = candidates.find(function (p) { return fs.existsSync(p); });
  if (!found) return null;
  require('dotenv').config({ path: found, override: false });
  return found;
}
const envFile = loadEnvFile();

const release = require('../services/feedbackRelease');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function readStdin() {
  return new Promise(function (resolve) {
    if (process.stdin.isTTY) { resolve(''); return; }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (chunk) { buf += chunk; });
    process.stdin.on('end', function () { resolve(buf); });
    process.stdin.on('error', function () { resolve(''); });
  });
}

function output(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = String(args.mode || '').toLowerCase();
  const operator = String(args.operator || process.env.SUDO_USER || process.env.USER || '').slice(0, 64);

  if (mode === 'read') {
    const data = await release.readCandidates({ limit: args.limit, afterId: args['after-id'] });
    output({ mode: 'read', environment: 'production', complete: data.complete, nextCursor: data.nextCursor, items: data.items });
    return;
  }
  if (mode === 'detail') {
    if (!args['feedback-id']) throw new Error('缺少 --feedback-id');
    output({ mode: 'detail', data: await release.readDetail(args['feedback-id'], { operator: operator }) });
    return;
  }
  if (mode === 'prepare') {
    const result = await release.prepareRun({
      deploymentId: args['deployment-id'],
      releaseSha: args['release-sha'],
      appVersion: args['app-version'],
      baseDeployedSha: args['base-sha'],
      owner: args.owner || operator,
    });
    output({ mode: 'prepare', ...result });
    return;
  }
  if (mode === 'conclusions') {
    if (!args['run-id']) throw new Error('缺少 --run-id');
    const raw = await readStdin();
    let list;
    try { list = JSON.parse(raw); } catch (e) { throw new Error('清单 JSON 无法解析（应从标准输入传入）'); }
    if (!Array.isArray(list)) throw new Error('清单必须是数组');
    const done = [];
    for (const item of list) {
      if (!item || !item.feedbackId) continue;
      done.push(await release.setItemConclusion(args['run-id'], item.feedbackId, {
        conclusion: item.conclusion,
        implementationCommit: item.implementationCommit,
        evidenceSummary: item.evidenceSummary,
      }));
    }
    output({ mode: 'conclusions', runId: String(args['run-id']), updated: done.length, items: done });
    return;
  }
  if (mode === 'freeze') {
    if (!args['run-id']) throw new Error('缺少 --run-id');
    output({ mode: 'freeze', ...(await release.freezeRun(args['run-id'])) });
    return;
  }
  if (mode === 'verify') {
    if (!args['run-id']) throw new Error('缺少 --run-id');
    const raw = await readStdin();
    let evidence = {};
    if (raw.trim()) {
      try { evidence = JSON.parse(raw); } catch (e) { throw new Error('验收证据 JSON 无法解析'); }
    }
    output({
      mode: 'verify',
      ...(await release.verifyRun(args['run-id'], {
        passed: args.pass === true || args.pass === 'true',
        verifiedSha: args.sha || args['release-sha'],
        evidence: evidence,
      })),
    });
    return;
  }
  if (mode === 'apply') {
    if (!args['run-id']) throw new Error('缺少 --run-id');
    if (!operator) throw new Error('缺少运行身份（--operator 或系统账号）');
    const result = await release.applyRun(args['run-id'], { operator: operator });
    output({ mode: 'apply', ...result, readBack: await release.readBack(args['run-id']) });
    return;
  }
  if (mode === 'status') {
    if (!args['run-id']) throw new Error('缺少 --run-id');
    output({ mode: 'status', envFile: envFile ? '已加载' : '未找到', ...(await release.status(args['run-id'])) });
    return;
  }
  throw new Error('未知模式：' + (mode || '(空)') + '，支持 read/detail/prepare/conclusions/freeze/verify/apply/status');
}

main()
  .then(function () {
    const { pool } = require('../db');
    return pool.end().catch(function () {}).then(function () { process.exit(0); });
  })
  .catch(function (err) {
    const message = String((err && err.message) || err).slice(0, 500);
    process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n');
    const { pool } = require('../db');
    Promise.resolve(pool.end()).catch(function () {}).then(function () { process.exit(1); });
  });
