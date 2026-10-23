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
//   node server/scripts/reconcileFeedbackRelease.js --mode apply --run-id 3 --operator <内容管理员账号> \
//        --deployment-id <uuid> [--current-sha <sha>] [--current-version <版本>]
//     说明：--current-sha/--current-version 只做交叉核对；实际运行提交/版本由服务端锁内读取。
//   node server/scripts/reconcileFeedbackRelease.js --mode rollback --run-id 3 --operator <内容管理员账号>
//   node server/scripts/reconcileFeedbackRelease.js --mode status --run-id 3
//   node server/scripts/reconcileFeedbackRelease.js --mode hold-lock --hold-seconds 5400 \
//        --ready-file /tmp/portfolio-release-lock.ready --token <随机令牌>
//   node server/scripts/reconcileFeedbackRelease.js --mode release-lock \
//        --ready-file /tmp/portfolio-release-lock.ready --token <同一令牌>
//     说明：hold-seconds 单位是【秒】（不是毫秒），默认 3600、上限 21600（6 小时）；
//     ready 文件内容是 JSON {token, pid, acquiredAt, expiresAt}；release-lock 幂等。
//
// 连接规则：先固定加载 .env（优先 /opt/portfolio/.env），沿用应用角色连接；
// 不使用 MIGRATION_DATABASE_URL，也不设置 MIGRATION_ROLE。日志不输出连接串与私密正文。
//
// 运行身份（A-02/A-04）：prepare/verify/apply/rollback 都要求 --operator 指向真实的内容管理员账号；
// apply/rollback 默认按当前代码版本自校验（git HEAD 与 package.json.appVersion 必须与批次一致）。
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

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
// C-01（2026-10-23 三次复验）：pool 必须在模块作用域可读。
// 此前只在末尾 then/catch 里局部解构，hold-lock 分支引用 pool 时是未定义，实际执行即崩。
const { pool } = require('../db');

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

// 当前运行版本：以仓库 HEAD 与 package.json 为准，不接受外部传值伪造
function currentRuntime() {
  let sha = '';
  const repoRoot = path.join(__dirname, '..', '..');
  try {
    // 同 feedbackRelease.readTrustedRuntime：显式声明仓库目录可信，避开 dubious ownership
    sha = execFileSync('git', ['-c', 'safe.directory=' + repoRoot, 'rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim();
  } catch (e) {
    sha = '';
  }
  let version = '';
  try {
    version = String(require('../../package.json').appVersion || '');
  } catch (e) {
    version = '';
  }
  return { sha: sha, version: version };
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
        operator: operator,
        evidence: evidence,
      })),
    });
    return;
  }
  if (mode === 'apply') {
    if (!args['run-id']) throw new Error('缺少 --run-id');
    if (!args['deployment-id']) throw new Error('缺少 --deployment-id（必须与发布批次一一对应）');
    if (!operator) throw new Error('缺少 --operator（必须是真实的内容管理员账号）');
    // B-01：这里只把调用方声明值交给服务端做交叉核对，
    // 实际运行提交/版本由服务端在锁内自行读取，参数永远不能覆盖真实值。
    const result = await release.applyRun(args['run-id'], {
      operator: operator,
      deploymentId: args['deployment-id'],
      expectedSha: args['current-sha'] || null,
      expectedVersion: args['current-version'] || null,
      heldLockToken: args['held-lock-token'] || null,
      heldLockReadyFile: args['held-lock-ready-file'] || null,
    });
    output({ mode: 'apply', ...result, readBack: await release.readBack(args['run-id']) });
    return;
  }
  if (mode === 'rollback') {
    if (!args['run-id']) throw new Error('缺少 --run-id');
    if (!operator) throw new Error('缺少 --operator（必须是真实的内容管理员账号）');
    output({
      mode: 'rollback',
      ...(await release.rollbackRun(args['run-id'], {
        operator: operator,
        expectedSha: args['current-sha'] || null,
        heldLockToken: args['held-lock-token'] || null,
        heldLockReadyFile: args['held-lock-ready-file'] || null,
      })),
    });
    return;
  }
  if (mode === 'status') {
    if (!args['run-id']) throw new Error('缺少 --run-id');
    output({ mode: 'status', envFile: envFile ? '已加载' : '未找到', ...(await release.status(args['run-id'])) });
    return;
  }
  if (mode === 'hold-lock') {
    // A-04/B-03/C-01/C-02：给代码部署用的目标级发布锁，与回写共用同一把 advisory lock。
    // C-02：持有时间单位是【秒】（--hold-seconds），不再接受 --hold-ms，杜绝 5400 被当 5.4 毫秒级的单位事故。
    // 获取成功后写 ready 文件（JSON：token/pid/acquiredAt/expiresAt）并保持持有，直到超时、被终止或 release-lock 释放。
    if (args['hold-ms'] !== undefined) {
      throw new Error('不接受 --hold-ms（曾导致 5400 被当作毫秒只持有 5.4 秒）；请改用 --hold-seconds <秒>');
    }
    const holdSeconds = Math.min(Math.max(parseInt(args['hold-seconds'], 10) || 3600, 1), 21600);
    const readyFile = args['ready-file'] || null;
    const token = String(args.token || '').trim();
    if (!readyFile) throw new Error('hold-lock 必须提供 --ready-file（部署流程据此判断是否持锁中）');
    if (!token) throw new Error('hold-lock 必须提供 --token（release 与第二段回写据此证明同一次部署）');
    const client = await pool.connect();
    let released = false;
    // D-01：只删除自己创建且令牌仍属于自己的凭证文件；等待者/后来者绝不碰别人的文件
    const cleanupReadyFile = function () {
      if (!readyFile) return;
      try {
        const info = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
        if (!info || String(info.token) !== token) return; // 不是本批次的文件，不动
        fs.unlinkSync(readyFile);
      } catch (e) { /* 文件不存在或已不属于自己 */ }
    };
    const releaseAll = async function () {
      if (released) return;
      released = true;
      // 持锁进程自己持锁自己解锁（此时没有 external 凭证，走正常 unlock）
      await release.releaseLock(client).catch(function () {});
      client.release();
      cleanupReadyFile();
    };
    // 被部署流程 kill 时优雅收尾：解锁并清 ready 文件
    process.once('SIGTERM', function () { releaseAll().then(function () { process.exit(0); }); });
    process.once('SIGINT', function () { releaseAll().then(function () { process.exit(0); }); });
    // 同步兜底：任何退出路径都删【本批次】ready 文件（C-01），令牌不符不删（D-01）
    process.on('exit', cleanupReadyFile);
    try {
      await release.acquireReleaseLock(client);
      const acquiredAt = Date.now();
      const expiresAt = acquiredAt + holdSeconds * 1000;
      if (readyFile) {
        fs.writeFileSync(readyFile, JSON.stringify({
          token: token, pid: process.pid, acquiredAt: acquiredAt, expiresAt: expiresAt, holdSeconds: holdSeconds,
        }));
      }
      output({ mode: 'hold-lock', held: true, holdSeconds: holdSeconds, pid: process.pid });
      // 心跳等待：期间 ready 文件持续存在；到时自动释放（部署必须在此之前完成或自行中止）
      await new Promise(function (resolve) {
        const timer = setInterval(function () {
          if (Date.now() >= expiresAt) { clearInterval(timer); resolve(); }
        }, 1000);
      });
    } finally {
      await releaseAll();
    }
    return;
  }
  if (mode === 'release-lock') {
    // C-03：部署结束（含反馈第二段）后由编排方最后释放；幂等，可重复执行。
    const readyFile = args['ready-file'] || null;
    const token = String(args.token || '').trim();
    if (!readyFile) throw new Error('release-lock 必须提供 --ready-file');
    if (!token) throw new Error('release-lock 必须提供 --token');
    if (!fs.existsSync(readyFile)) {
      output({ mode: 'release-lock', released: true, already: true });
      return;
    }
    let info = null;
    try { info = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch (e) { info = null; }
    if (!info || String(info.token) !== token) {
      throw new Error('release-lock 令牌不匹配，拒绝释放他人持有的发布锁');
    }
    // 通知持锁进程优雅退出（其收尾负责解锁与删 ready 文件）；进程已不在则直接清理
    let holderAlive = true;
    try { process.kill(info.pid, 0); } catch (e) { holderAlive = false; }
    if (holderAlive && info.pid !== process.pid) {
      try { process.kill(info.pid, 'SIGTERM'); } catch (e) { /* 已退出 */ }
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && fs.existsSync(readyFile)) {
        await new Promise(function (r) { setTimeout(r, 200); });
      }
    }
    // D-01：只删自己批次的凭证；若文件已被换给别的批次则不碰
    if (fs.existsSync(readyFile)) {
      try {
        const now = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
        if (now && String(now.token) === token) fs.unlinkSync(readyFile);
      } catch (e) { /* 文件不存在或损坏，不动 */ }
    }
    output({ mode: 'release-lock', released: true, holderAlive: holderAlive });
    return;
  }
  throw new Error('未知模式：' + (mode || '(空)') + '，支持 read/detail/prepare/conclusions/freeze/verify/apply/rollback/hold-lock/release-lock/status');
}

main()
  .then(function () {
    return pool.end().catch(function () {}).then(function () { process.exit(0); });
  })
  .catch(function (err) {
    const message = String((err && err.message) || err).slice(0, 500);
    process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n');
    Promise.resolve(pool.end()).catch(function () {}).then(function () { process.exit(1); });
  });
