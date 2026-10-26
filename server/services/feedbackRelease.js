// ========== 反馈发布闭环（2026-10-23） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第七、八节。
// 职责：把“发布核对 → 准备清单 → 专项验收 → 应用回写”落成可重复执行的受控服务。
// 命令入口（server/scripts/reconcileFeedbackRelease.js）与后台接口共用本文件，不各自实现状态规则。
const crypto = require('crypto');
const fs = require('fs');
const { pool } = require('../db');
const store = require('../db/feedback');
const feedbackService = require('./feedbackService');
const notificationService = require('./notificationService');
const { hasCapability, isAdminIdentity } = require('../middleware/auth');

const REVIEW_POLICY_VERSION = '2026-10-23';
const OPEN_STATUSES = ['new', 'needs_info', 'accepted', 'in_progress'];
// A-04：目标级发布锁，覆盖准备/冻结/验收/应用/回滚整段版本核验
const RELEASE_LOCK_ID = 904100;
const ROLLBACK_STATUSES = ['applied'];

function createError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function assertUuid(value) {
  const v = String(value || '').trim();
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) {
    throw createError(400, 'deploymentId 必须是 UUID');
  }
  return v;
}

// 清单哈希：编号 + 核对时修订 + 结论 + 实现提交 + 证据摘要，任一被改动都会导致哈希不匹配（A-02）
function computeManifestHash(items) {
  const lines = items
    .map(function (it) {
      return [
        String(it.feedbackId), String(it.expectedRevision), String(it.conclusion || 'pending'),
        String(it.implementationCommit || ''), String(it.evidenceSummary || ''),
      ].join(':');
    })
    .sort();
  return sha256(lines.join('\n'));
}

// 只有真实的内容管理员（或管理员）可以准备/验收/回写；运行身份伪造不可绕过
async function assertContentManager(username, action) {
  const who = String(username || '').trim();
  if (!who) throw createError(400, '必须提供有效的运行身份');
  const { rows } = await pool.query(
    'SELECT username, role, status, permissions FROM public.users WHERE username=$1', [who]
  );
  const user = rows[0];
  if (!user) throw createError(403, '运行身份不存在或已注销：' + who);
  if (user.status && user.status !== 'active') throw createError(403, '运行身份已被禁用：' + who);
  if (!(isAdminIdentity(user.username, user.role) || hasCapability(user, 'content_manage'))) {
    throw createError(403, '运行身份缺少 content_manage 能力，不能执行' + (action || '发布闭环'));
  }
  return user;
}

// B-01（2026-10-23 二次复验）：可信运行版本只由本进程在锁内读取，
// 调用方传入的 currentSha/currentVersion 只能用于交叉核对，永远不能覆盖实际值。
function readTrustedRuntime() {
  let sha = '';
  const repoRoot = require('path').join(__dirname, '..', '..');
  try {
    // 2026-10-23 端到端实录：/opt/portfolio 属主是 root，应用账号跑 git 会触发
    // dubious ownership 保护导致读不到 HEAD、回写被 fail-closed 拒绝。
    // 显式声明本仓库目录可信（随代码生效，不依赖服务器 git 全局配置）。
    sha = String(require('child_process').execFileSync('git', ['-c', 'safe.directory=' + repoRoot, 'rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8',
    })).trim();
  } catch (e) {
    sha = '';
  }
  let version = '';
  try {
    version = String(require('../../package.json').appVersion || require('../../package.json').version || '');
  } catch (e) {
    version = '';
  }
  return { sha: sha, version: version };
}

// 目标级发布锁：同一时间只允许一个发布批次做版本核验与回写
// C-03（2026-10-23 三次复验）：部署流程的 hold-lock 进程已持有发布锁，
// 第二段反馈回写不得再 pg_advisory_lock 同一把锁（会自我死锁到超时）。
// 命令层传入 held-lock-token / held-lock-ready-file 凭证：校验 ready 文件、令牌、持锁进程存活与未过期后，
// 在“部署已持锁”的前提下跳过重复获取；凭证缺失或不合法则回退正常抢锁（或拒绝，见 verifyHeldLock）。
function verifyHeldLock(heldLockToken, heldLockReadyFile) {
  const token = String(heldLockToken || '').trim();
  const readyFile = String(heldLockReadyFile || '').trim();
  if (!token && !readyFile) return null;
  if (!token || !readyFile) {
    throw createError(400, 'held-lock-token 与 held-lock-ready-file 必须同时提供');
  }
  if (!fs.existsSync(readyFile)) {
    throw createError(409, '部署发布锁已丢失（ready 文件不存在），拒绝在锁外执行');
  }
  let info = null;
  try { info = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch (e) { info = null; }
  if (!info || String(info.token) !== token) {
    throw createError(409, '部署发布锁令牌不匹配，拒绝执行');
  }
  if (info.expiresAt && Date.now() > Number(info.expiresAt)) {
    throw createError(409, '部署发布锁已过期，拒绝执行');
  }
  try {
    process.kill(info.pid, 0);
  } catch (e) {
    // EPERM = 进程存在但无权限探测（如 root 持锁、应用账号校验），视为存活
    if (e && e.code === 'EPERM') { /* 存活 */ }
    else throw createError(409, '持锁进程已不存在，发布锁失效，拒绝执行');
  }
  return { token: info.token, pid: info.pid };
}

async function acquireReleaseLock(client, opts) {
  const options = opts || {};
  const held = verifyHeldLock(options.heldLockToken, options.heldLockReadyFile);
  if (held) {
    // 部署已持锁：本会话不再抢同一把 advisory lock，交由持锁进程统一解锁
    return { external: true, held: held };
  }
  await client.query('SELECT pg_advisory_lock($1)', [RELEASE_LOCK_ID]);
  return { external: false };
}

async function releaseLock(client, handle) {
  if (handle && handle.external) return; // 外部持锁进程负责解锁，本会话不得替它解锁
  await client.query('SELECT pg_advisory_unlock($1)', [RELEASE_LOCK_ID]).catch(function () {});
}

// ---------- 核对读取（read 模式） ----------
// 只输出编号、revision、状态与必要的公开字段；私密正文不随日志或 Git 传播，由调用方按需再取详情。
async function readCandidates(options) {
  const opts = options || {};
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 500);
  const afterId = opts.afterId ? String(opts.afterId) : null;
  const params = [];
  let where = `f.withdrawn_at IS NULL AND f.status = ANY($1::text[])`;
  params.push(OPEN_STATUSES);
  if (afterId) { params.push(afterId); where += ` AND f.id > $${params.length}`; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT f.id::text AS "feedbackId", f.revision::text AS revision, f.status, f.type,
            f.visibility, f.moderation, f.title, f.updated_at AS "updatedAt"
       FROM public.feedbacks f
      WHERE ${where}
      ORDER BY f.id ASC
      LIMIT $${params.length}`,
    params
  );
  const next = rows.length === limit ? rows[rows.length - 1].feedbackId : null;
  return { items: rows, nextCursor: next, complete: next === null };
}

async function readDetail(feedbackId, options) {
  const opts = options || {};
  const actor = { username: opts.operator || 'release-agent', canModerate: true };
  const data = await feedbackService.detail(feedbackId, actor);
  return data;
}

// ---------- 准备核对清单 ----------
async function prepareRun(input) {
  const owner = String(input.owner || '').trim();
  if (!owner) throw createError(400, '必须指定发布负责人');
  await assertContentManager(owner, '准备发布核对清单');
  const releaseSha = String(input.releaseSha || '').trim();
  const appVersion = String(input.appVersion || '').trim();
  if (!/^[0-9a-f]{7,40}$/.test(releaseSha)) throw createError(400, 'releaseSha 不合法');
  if (!appVersion) throw createError(400, '必须提供 appVersion');
  const deploymentId = assertUuid(input.deploymentId);
  const environment = 'production';

  const client = await pool.connect();
  let lockHandle = null;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    lockHandle = await acquireReleaseLock(client);
    const existing = await client.query(
      'SELECT id::text AS id, manifest_hash AS "manifestHash", prepare_status AS "prepareStatus" FROM ops.feedback_release_runs WHERE environment=$1 AND deployment_id=$2',
      [environment, deploymentId]
    );
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return {
        runId: existing.rows[0].id, deploymentId: deploymentId,
        manifestHash: existing.rows[0].manifestHash, reused: true,
      };
    }
    const snapshotAt = new Date();
    const run = await client.query(
      `INSERT INTO ops.feedback_release_runs
         (deployment_id, environment, release_sha, app_version, base_deployed_sha,
          review_policy_version, snapshot_at, owner, prepare_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING id::text AS id`,
      [deploymentId, environment, releaseSha, appVersion, String(input.baseDeployedSha || ''),
        REVIEW_POLICY_VERSION, snapshotAt, owner]
    );
    const runId = run.rows[0].id;
    const candidates = await client.query(
      `SELECT f.id::text AS id, f.revision::text AS revision, f.status
         FROM public.feedbacks f
        WHERE f.withdrawn_at IS NULL AND f.status = ANY($1::text[])
        ORDER BY f.id ASC`,
      [OPEN_STATUSES]
    );
    let inserted = 0;
    for (let i = 0; i < candidates.rows.length; i++) {
      const row = candidates.rows[i];
      await client.query(
        `INSERT INTO ops.feedback_release_items
           (run_id, feedback_id, expected_revision, expected_status, input_hash)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (run_id, feedback_id) DO NOTHING`,
        [runId, row.id, row.revision, row.status, sha256(row.id + ':' + row.revision)]
      );
      inserted++;
    }
    const items = await client.query(
      'SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision", conclusion, implementation_commit AS "implementationCommit", evidence_summary AS "evidenceSummary" FROM ops.feedback_release_items WHERE run_id=$1',
      [runId]
    );
    const manifestHash = computeManifestHash(items.rows);
    await client.query(
      `UPDATE ops.feedback_release_runs
          SET manifest_hash=$1, snapshot_count=$2, snapshot_complete=true, prepare_status='prepared', updated_at=now()
        WHERE id=$3`,
      [manifestHash, inserted, runId]
    );
    await client.query('COMMIT');
    return {
      runId: runId, deploymentId: deploymentId, manifestHash: manifestHash,
      snapshotCount: inserted, reused: false,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    await releaseLock(client, lockHandle);
    client.release();
  }
}

// 写入/更新单项核对结论（开发 Agent 的核对结果先落库，再由 apply 使用）
// 明细变化后自动作废已冻结清单与已通过的验收（A-02：修订后必须重新验收）
async function setItemConclusion(runId, feedbackId, patch) {
  const conclusions = ['pending', 'solved', 'partial', 'unrelated', 'needs_review'];
  if (conclusions.indexOf(patch.conclusion) < 0) throw createError(400, '核对结论不合法');
  const client = await pool.connect();
  let lockHandle = null;
  try {
    await client.query('BEGIN');
    lockHandle = await acquireReleaseLock(client);
    const run = await client.query(
      'SELECT id::text AS id, prepare_status AS "prepareStatus", verify_status AS "verifyStatus" FROM ops.feedback_release_runs WHERE id=$1 FOR UPDATE',
      [runId]
    );
    if (!run.rows[0]) throw createError(404, '发布批次不存在');
    const { rows } = await client.query(
      `UPDATE ops.feedback_release_items
          SET conclusion=$1, implementation_commit=$2, evidence_summary=$3, updated_at=now()
        WHERE run_id=$4 AND feedback_id=$5
          AND apply_status='pending'
        RETURNING id::text AS id, feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision",
                  conclusion, implementation_commit AS "implementationCommit", evidence_summary AS "evidenceSummary"`,
      [patch.conclusion, String(patch.implementationCommit || '').slice(0, 64),
        String(patch.evidenceSummary || '').slice(0, 1000), runId, feedbackId]
    );
    if (!rows[0]) throw createError(404, '找不到该发布批次中的这条反馈，或该项已应用');
    // 明细变化：冻结的清单要重新冻结，已通过的验收作废
    const all = await client.query(
      'SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision", conclusion, implementation_commit AS "implementationCommit", evidence_summary AS "evidenceSummary" FROM ops.feedback_release_items WHERE run_id=$1',
      [runId]
    );
    const manifestHash = computeManifestHash(all.rows);
    const invalidated = run.rows[0].verifyStatus === 'passed';
    await client.query(
      `UPDATE ops.feedback_release_runs
          SET manifest_hash=$1,
              prepare_status = CASE WHEN prepare_status='frozen' THEN 'prepared' ELSE prepare_status END,
              verify_status = CASE WHEN verify_status='passed' THEN 'pending' ELSE verify_status END,
              updated_at=now()
        WHERE id=$2`,
      [manifestHash, runId]
    );
    await client.query('COMMIT');
    return {
      runId: String(runId), feedbackId: String(feedbackId), conclusion: patch.conclusion,
      manifestHash: manifestHash, verificationInvalidated: invalidated,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    await releaseLock(client, lockHandle);
    client.release();
  }
}

async function freezeRun(runId) {
  const client = await pool.connect();
  let lockHandle = null;
  try {
    await client.query('BEGIN');
    lockHandle = await acquireReleaseLock(client);
    const items = await client.query(
      'SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision", conclusion, implementation_commit AS "implementationCommit", evidence_summary AS "evidenceSummary" FROM ops.feedback_release_items WHERE run_id=$1',
      [runId]
    );
    if (!items.rowCount) throw createError(400, '该发布批次没有核对明细');
    const manifestHash = computeManifestHash(items.rows);
    const { rows } = await client.query(
      `UPDATE ops.feedback_release_runs
          SET manifest_hash=$1, prepare_status='frozen',
              verify_status = CASE WHEN verify_status='passed' THEN 'pending' ELSE verify_status END,
              updated_at=now()
        WHERE id=$2 RETURNING id::text AS id`,
      [manifestHash, runId]
    );
    if (!rows[0]) throw createError(404, '发布批次不存在');
    await client.query('COMMIT');
    return { runId: String(runId), manifestHash: manifestHash };
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    await releaseLock(client, lockHandle);
    client.release();
  }
}

// 专项验收记录：只有验收通过的批次才允许把反馈写成已实施
async function verifyRun(runId, input) {
  const evidence = input && input.evidence ? input.evidence : {};
  const passed = input && input.passed === true;
  const sha = String((input && input.verifiedSha) || '').trim();
  const client = await pool.connect();
  let lockHandle = null;
  try {
    await client.query('BEGIN');
    lockHandle = await acquireReleaseLock(client);
    const { rows } = await client.query(
      'SELECT id::text AS id, release_sha AS "releaseSha", app_version AS "appVersion", owner, manifest_hash AS "manifestHash", prepare_status AS "prepareStatus" FROM ops.feedback_release_runs WHERE id=$1 FOR UPDATE',
      [runId]
    );
    if (!rows[0]) throw createError(404, '发布批次不存在');
    const run = rows[0];
    // 验收人与发布负责人必须是真实有权账号，不能用任意名字
    await assertContentManager(String(input && input.operator) || run.owner, '执行专项验收');
    if (passed && sha !== run.releaseSha) {
      throw createError(409, '验收提交与发布批次绑定的 SHA 不一致');
    }
    if (run.prepareStatus === 'draft') throw createError(409, '该发布批次清单尚未准备完成');
    const items = await client.query(
      'SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision", conclusion, implementation_commit AS "implementationCommit", evidence_summary AS "evidenceSummary" FROM ops.feedback_release_items WHERE run_id=$1',
      [runId]
    );
    const manifestHash = computeManifestHash(items.rows);
    if (run.manifestHash && manifestHash !== run.manifestHash) {
      throw createError(409, '核对清单已被修改，请重新冻结后再次验收');
    }
    if (passed) {
      // A-02：验收通过必须留下具体证据，空对象不算验收
      const keys = Object.keys(evidence).filter(function (k) {
        return evidence[k] !== null && evidence[k] !== undefined && String(evidence[k]).trim() !== '';
      });
      if (!keys.length) throw createError(400, '验收通过必须提交验收证据（不能为空）');
    }
    await client.query(
      `UPDATE ops.feedback_release_runs
          SET verify_status=$1, verify_evidence=$2, manifest_hash=$3, updated_at=now()
        WHERE id=$4`,
      [passed ? 'passed' : 'failed', JSON.stringify(evidence), manifestHash, runId]
    );
    await client.query('COMMIT');
    return { runId: String(runId), verifyStatus: passed ? 'passed' : 'failed' };
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    await releaseLock(client, lockHandle);
    client.release();
  }
}

// ---------- 应用回写 ----------
// 每项独立事务：锁明细 → 锁反馈 → 校验 revision/状态 → 更新 → 同事务写事件 → 明细标已应用。
// 幂等锚点是 (run_id, feedback_id) 唯一键 + apply_status，不依赖“先查事件不存在再插入”。
// 整段受目标级发布锁保护（A-04）：同一时间只有一个发布批次做版本核验与回写。
async function applyRun(runId, options) {
  const opts = options || {};
  await assertContentManager(opts.operator, '执行反馈回写');
  if (!opts.deploymentId) {
    throw createError(400, '必须提供 deployment_id（发布批次要与本次部署一一对应）');
  }
  const lockClient = await pool.connect();
  let lockHandle = null;
  try {
    // B-03：从读取验收/哈希/明细到写入，全部在发布锁内完成。
    // 排队期间清单被改、验收失效，拿到锁后会看到最新状态并拒绝，不再按旧结论更新。
    await lockClient.query('BEGIN');
    // C-03：部署第二段回写携带持锁凭证时跳过重复抢锁，否则正常获取
    lockHandle = await acquireReleaseLock(lockClient, {
      heldLockToken: opts.heldLockToken, heldLockReadyFile: opts.heldLockReadyFile,
    });
    const runQuery = await lockClient.query(
      `SELECT id::text AS id, deployment_id::text AS "deploymentId", release_sha AS "releaseSha", app_version AS "appVersion",
              verify_status AS "verifyStatus", apply_status AS "applyStatus",
              manifest_hash AS "manifestHash", prepare_status AS "prepareStatus", owner
         FROM ops.feedback_release_runs WHERE id=$1 FOR UPDATE`,
      [runId]
    );
    const run = runQuery.rows[0];
    if (!run) throw createError(404, '发布批次不存在');
    if (run.verifyStatus !== 'passed') throw createError(409, '该发布批次未通过专项验收，不能回写已实施');
    if (run.prepareStatus === 'draft') throw createError(409, '该发布批次清单尚未准备完成');

    // B-01：实际运行提交与版本只由锁内可信读取决定
    const runtime = readTrustedRuntime();
    if (!runtime.sha || !runtime.version) {
      throw createError(500, '无法确认当前运行版本，拒绝回写');
    }
    if (String(opts.deploymentId) !== String(run.deploymentId)) {
      throw createError(409, '发布批次不属于本次部署（deployment_id 不一致）');
    }
    // 调用方传值只用于交叉核对，不能替代实际值
    if (opts.expectedSha && String(opts.expectedSha).toLowerCase() !== runtime.sha.toLowerCase()) {
      throw createError(409, '调用方声明的提交与实际运行提交不一致');
    }
    if (opts.expectedVersion && String(opts.expectedVersion) !== runtime.version) {
      throw createError(409, '调用方声明的版本与实际运行版本不一致');
    }
    if (runtime.sha.toLowerCase() !== String(run.releaseSha).toLowerCase()) {
      throw createError(409, '当前运行提交与发布批次不一致，拒绝回写');
    }
    if (runtime.version !== String(run.appVersion)) {
      throw createError(409, '当前运行版本与发布批次不一致，拒绝回写');
    }

    const checked = await lockClient.query(
      'SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision", conclusion, implementation_commit AS "implementationCommit", evidence_summary AS "evidenceSummary" FROM ops.feedback_release_items WHERE run_id=$1',
      [runId]
    );
    const manifestHash = computeManifestHash(checked.rows);
    if (run.manifestHash && manifestHash !== run.manifestHash) {
      throw createError(409, '核对清单已被修改，请重新冻结后再次验收');
    }

    const targets = await lockClient.query(
      `SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision",
              expected_status AS "expectedStatus", conclusion, implementation_commit AS "implementationCommit",
              evidence_summary AS "evidenceSummary", apply_status AS "applyStatus"
         FROM ops.feedback_release_items
        WHERE run_id=$1 AND conclusion IN ('solved','partial')
        ORDER BY feedback_id ASC`,
      [runId]
    );

    const results = [];
    for (let i = 0; i < targets.rows.length; i++) {
      results.push(await applyOne(runId, run, targets.rows[i], opts));
    }
    const applied = results.filter(function (r) { return r.applyStatus === 'applied'; }).length;
    const failed = results.filter(function (r) { return r.applyStatus !== 'applied' && r.applyStatus !== 'skipped'; }).length;
    const overall = failed === 0 ? 'applied' : (applied > 0 ? 'partial' : 'failed');
    await lockClient.query('UPDATE ops.feedback_release_runs SET apply_status=$1, updated_at=now() WHERE id=$2', [overall, runId]);
    await lockClient.query('COMMIT');
    return { runId: String(runId), applyStatus: overall, applied: applied, failed: failed, items: results };
  } catch (e) {
    await lockClient.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    await releaseLock(lockClient, lockHandle);
    lockClient.release();
  }
}

async function applyOne(runId, run, item, opts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT id, apply_status AS "applyStatus", revision_after::text AS "revisionAfter"
         FROM ops.feedback_release_items
        WHERE run_id=$1 AND feedback_id=$2 FOR UPDATE`,
      [runId, item.feedbackId]
    );
    const row = locked.rows[0];
    if (!row) { await client.query('ROLLBACK'); return { feedbackId: item.feedbackId, applyStatus: 'failed', error: '明细不存在' }; }
    if (row.applyStatus === 'applied') {
      await client.query('ROLLBACK');
      return { feedbackId: item.feedbackId, applyStatus: 'applied', revisionAfter: row.revisionAfter, reused: true };
    }
    if (row.applyStatus === 'skipped') {
      await client.query('ROLLBACK');
      return { feedbackId: item.feedbackId, applyStatus: 'skipped' };
    }
    const fb = await store.lockFeedback(client, item.feedbackId);
    if (!fb) {
      await client.query('ROLLBACK');
      await markItem(item.feedbackId, runId, 'failed', '反馈不存在');
      return { feedbackId: item.feedbackId, applyStatus: 'failed', error: '反馈不存在' };
    }
    if (fb.withdrawnAt) {
      await client.query('ROLLBACK');
      await markItem(item.feedbackId, runId, 'skipped', '反馈已撤回');
      return { feedbackId: item.feedbackId, applyStatus: 'skipped', error: '反馈已撤回' };
    }
    if (String(fb.revision) !== String(item.expectedRevision) || fb.status !== item.expectedStatus) {
      await client.query('ROLLBACK');
      await markItem(item.feedbackId, runId, 'conflict', '核对后反馈已被修改');
      return { feedbackId: item.feedbackId, applyStatus: 'conflict', error: '核对后反馈已被修改' };
    }
    let fields;
    let summary;
    if (item.conclusion === 'solved') {
      // 版本与发布提交取自本批次（A-02），不接受外部填写
      const validated = await feedbackService.validateStatusChange(client, fb, { status: 'implemented' }, {
        reason: '随版本 ' + run.appVersion + ' 发布并验收',
        releaseRunId: runId,
        internalRelease: true,
      });
      fields = validated.fields;
      summary = '随版本 ' + run.appVersion + ' 发布，专项验收通过';
    } else {
      fields = { status: 'in_progress' };
      summary = '随版本 ' + run.appVersion + ' 部分解决，仍需后续处理';
    }
    const revision = await store.updateFeedbackFields(client, item.feedbackId, fields);
    await store.insertEvent(client, {
      feedbackId: item.feedbackId, actorUsername: opts.operator || null, actorSource: 'release',
      eventType: item.conclusion === 'solved' ? 'release_implemented' : 'release_partial',
      statusFrom: fb.status, statusTo: fields.status, summary: summary,
      note: String(item.evidenceSummary || '').slice(0, 500), revision: revision, releaseRunId: runId,
    });
    // 唯一完成来源是已验收批次的应用：通知必须与反馈、事件、明细同事务提交。
    // 这里只能用本项业务 client；禁止 pool / 外层 lockClient / 另开连接（否则会出现
    // 「反馈已实施但通知丢失」或「通知已写但反馈回滚」）。写失败由下方 catch 整体回滚并按 failed 留因。
    if (item.conclusion === 'solved') {
      await notificationService.createFeedbackImplementedNotice(client, {
        feedbackId: item.feedbackId,
        releaseRunId: runId,
        appVersion: run.appVersion,
        authorUsername: fb.authorUsername,
      });
    }
    await client.query(
      `UPDATE ops.feedback_release_items
          SET apply_status='applied', apply_error='', revision_before=$1, revision_after=$2,
              applied_at=now(), updated_at=now()
        WHERE run_id=$3 AND feedback_id=$4`,
      [fb.revision, revision, runId, item.feedbackId]
    );
    await client.query('COMMIT');
    return { feedbackId: item.feedbackId, applyStatus: 'applied', revisionBefore: fb.revision, revisionAfter: revision };
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    await markItem(item.feedbackId, runId, 'failed', String(e.message || e).slice(0, 300)).catch(function () {});
    return { feedbackId: item.feedbackId, applyStatus: 'failed', error: e.message };
  } finally {
    client.release();
  }
}

// ---------- 回滚恢复（A-04） ----------
// 只恢复「由本批次关闭、且之后没有被任何人再修改」的反馈；已被后续修改的一律保留现状。
async function rollbackRun(runId, options) {
  const opts = options || {};
  await assertContentManager(opts.operator, '执行回滚恢复');
  const lockClient = await pool.connect();
  let lockHandle = null;
  try {
    await lockClient.query('BEGIN');
    // C-03：同 applyRun，部署回滚接续可携带持锁凭证跳过重复抢锁
    lockHandle = await acquireReleaseLock(lockClient, {
      heldLockToken: opts.heldLockToken, heldLockReadyFile: opts.heldLockReadyFile,
    });
    const runQuery = await lockClient.query(
      `SELECT id::text AS id, deployment_id::text AS "deploymentId", release_sha AS "releaseSha",
              app_version AS "appVersion", verify_status AS "verifyStatus", apply_status AS "applyStatus"
         FROM ops.feedback_release_runs WHERE id=$1 FOR UPDATE`,
      [runId]
    );
    const run = runQuery.rows[0];
    if (!run) throw createError(404, '发布批次不存在');
    if (run.applyStatus === 'pending' || run.applyStatus === 'rolled_back') {
      throw createError(409, '该发布批次没有可回滚的已应用项');
    }
    const runtime = readTrustedRuntime();
    if (!runtime.sha) throw createError(500, '无法确认当前运行提交，拒绝回滚');
    if (opts.expectedSha && String(opts.expectedSha).toLowerCase() !== runtime.sha.toLowerCase()) {
      throw createError(409, '调用方声明的提交与实际运行提交不一致');
    }
    if (runtime.sha.toLowerCase() !== String(run.releaseSha).toLowerCase()) {
      throw createError(409, '当前运行提交与发布批次不一致，拒绝回滚');
    }
    const items = await lockClient.query(
      `SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision",
              expected_status AS "expectedStatus", revision_after::text AS "revisionAfter", apply_status AS "applyStatus"
         FROM ops.feedback_release_items
        WHERE run_id=$1 AND conclusion='solved' AND apply_status='applied'
        ORDER BY feedback_id ASC`,
      [runId]
    );
    const results = [];
    for (let i = 0; i < items.rows.length; i++) {
      results.push(await rollbackOne(runId, run, items.rows[i], opts));
    }
    const restored = results.filter(function (r) { return r.result === 'restored'; }).length;
    const kept = results.filter(function (r) { return r.result === 'kept_after_modification'; }).length;
    // 失效通知写入失败 = 本项整体未回滚（反馈/事件/明细/通知都保持事务前状态），必须报告失败而不是记为保留
    const failed = results.filter(function (r) { return r.result === 'failed'; }).length;
    const overall = failed > 0 ? 'partial'
      : (restored === 0 ? 'applied' : (kept > 0 ? 'partial' : 'rolled_back'));
    await lockClient.query('UPDATE ops.feedback_release_runs SET apply_status=$1, updated_at=now() WHERE id=$2', [overall, runId]);
    await lockClient.query('COMMIT');
    return { runId: String(runId), applyStatus: overall, restored: restored, kept: kept, failed: failed, items: results };
  } catch (e) {
    await lockClient.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    await releaseLock(lockClient, lockHandle);
    lockClient.release();
  }
}

async function rollbackOne(runId, run, item, opts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT id, apply_status AS "applyStatus" FROM ops.feedback_release_items WHERE run_id=$1 AND feedback_id=$2 FOR UPDATE',
      [runId, item.feedbackId]
    );
    if (!locked.rows[0] || locked.rows[0].applyStatus !== 'applied') {
      await client.query('ROLLBACK');
      return { feedbackId: item.feedbackId, result: 'kept_after_modification' };
    }
    const fb = await store.lockFeedback(client, item.feedbackId);
    if (!fb) {
      await client.query('ROLLBACK');
      return { feedbackId: item.feedbackId, result: 'kept_after_modification', error: '反馈不存在' };
    }
    const unchanged = fb.status === 'implemented'
      && String(fb.implementedReleaseSha || '') === String(run.releaseSha)
      && String(fb.revision) === String(item.revisionAfter);
    if (!unchanged) {
      await client.query('ROLLBACK');
      return { feedbackId: item.feedbackId, result: 'kept_after_modification' };
    }
    const revision = await store.updateFeedbackFields(client, item.feedbackId, {
      status: item.expectedStatus,
      implementedVersion: null,
      implementedReleaseSha: null,
    });
    await store.insertEvent(client, {
      feedbackId: item.feedbackId, actorUsername: opts.operator || null, actorSource: 'release',
      eventType: 'release_rollback',
      statusFrom: 'implemented', statusTo: item.expectedStatus,
      summary: '版本 ' + run.appVersion + ' 回滚，恢复为核对前状态',
      note: '', revision: revision, releaseRunId: runId,
    });
    // 回滚只失效本批次确实恢复未完成的对应项；同一事务内失效，写失败则整项恢复到事务前状态并报告失败。
    await notificationService.invalidateFeedbackNotifications(client, {
      feedbackId: item.feedbackId,
      releaseRunId: runId,
      reason: '版本 ' + run.appVersion + ' 已回滚，处理状态已更新',
    });
    await client.query(
      `UPDATE ops.feedback_release_items SET apply_status='rolled_back', updated_at=now()
        WHERE run_id=$1 AND feedback_id=$2`,
      [runId, item.feedbackId]
    );
    await client.query('COMMIT');
    return { feedbackId: item.feedbackId, result: 'restored', revisionAfter: revision };
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    return { feedbackId: item.feedbackId, result: 'failed', error: e.message };
  } finally {
    client.release();
  }
}

async function markItem(feedbackId, runId, status, error) {
  await pool.query(
    `UPDATE ops.feedback_release_items SET apply_status=$1, apply_error=$2, updated_at=now()
      WHERE run_id=$3 AND feedback_id=$4 AND apply_status IN ('pending','conflict','failed')`,
    [status, String(error || '').slice(0, 300), runId, feedbackId]
  );
}

// 回读：确认主记录、版本关联与处理历史
async function readBack(runId) {
  const { rows } = await pool.query(
    `SELECT i.feedback_id::text AS "feedbackId", i.apply_status AS "applyStatus",
            f.status, f.implemented_version AS "implementedVersion",
            f.implemented_release_sha AS "implementedReleaseSha", f.revision::text AS revision,
            (SELECT count(*)::int FROM public.feedback_events e
              WHERE e.feedback_id = i.feedback_id AND e.release_run_id = i.run_id) AS "eventCount"
       FROM ops.feedback_release_items i
       JOIN public.feedbacks f ON f.id = i.feedback_id
      WHERE i.run_id=$1 AND i.apply_status IN ('applied','skipped','conflict','failed')
      ORDER BY i.feedback_id ASC`,
    [runId]
  );
  return rows;
}

async function listRuns(query) {
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const { rows } = await pool.query(
    `SELECT id::text AS id, deployment_id::text AS "deploymentId", environment,
            release_sha AS "releaseSha", app_version AS "appVersion", prepare_status AS "prepareStatus",
            verify_status AS "verifyStatus", apply_status AS "applyStatus", snapshot_count AS "snapshotCount",
            snapshot_at AS "snapshotAt", owner, created_at AS "createdAt"
       FROM ops.feedback_release_runs ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize]
  );
  const total = await pool.query('SELECT count(*)::int AS total FROM ops.feedback_release_runs');
  return { items: rows, total: total.rows[0].total, page: page, pageSize: pageSize };
}

async function getRun(runId) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, deployment_id::text AS "deploymentId", environment,
            release_sha AS "releaseSha", app_version AS "appVersion", base_deployed_sha AS "baseDeployedSha",
            manifest_hash AS "manifestHash", review_policy_version AS "reviewPolicyVersion",
            snapshot_at AS "snapshotAt", snapshot_count AS "snapshotCount", snapshot_complete AS "snapshotComplete",
            owner, prepare_status AS "prepareStatus", verify_status AS "verifyStatus", apply_status AS "applyStatus",
            verify_evidence AS "verifyEvidence", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM ops.feedback_release_runs WHERE id=$1`,
    [runId]
  );
  if (!rows[0]) throw createError(404, '发布批次不存在');
  return rows[0];
}

// 明细按编号游标分页，不以持续变化的列表 offset 作为完整性依据
async function listItems(runId, query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);
  const afterId = query.afterId ? String(query.afterId) : null;
  const params = [runId];
  let where = 'run_id = $1';
  if (afterId) { params.push(afterId); where += ' AND feedback_id > $' + params.length; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision",
            expected_status AS "expectedStatus", conclusion, implementation_commit AS "implementationCommit",
            evidence_summary AS "evidenceSummary", apply_status AS "applyStatus", apply_error AS "applyError",
            revision_before::text AS "revisionBefore", revision_after::text AS "revisionAfter"
       FROM ops.feedback_release_items
      WHERE ${where} ORDER BY feedback_id ASC LIMIT $${params.length}`,
    params
  );
  const next = rows.length === limit ? rows[rows.length - 1].feedbackId : null;
  return { items: rows, nextCursor: next, complete: next === null };
}

async function status(runId) {
  const run = await getRun(runId);
  const items = await listItems(runId, { limit: 500 });
  return { run: run, items: items.items, complete: items.complete };
}

module.exports = {
  REVIEW_POLICY_VERSION, OPEN_STATUSES,
  readCandidates, readDetail, prepareRun, setItemConclusion, freezeRun, verifyRun,
  applyRun, rollbackRun, readBack, listRuns, getRun, listItems, status, computeManifestHash,
  RELEASE_LOCK_ID, acquireReleaseLock, releaseLock, readTrustedRuntime,
};
