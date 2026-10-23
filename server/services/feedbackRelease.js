// ========== 反馈发布闭环（2026-10-23） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第七、八节。
// 职责：把“发布核对 → 准备清单 → 专项验收 → 应用回写”落成可重复执行的受控服务。
// 命令入口（server/scripts/reconcileFeedbackRelease.js）与后台接口共用本文件，不各自实现状态规则。
const crypto = require('crypto');
const { pool } = require('../db');
const store = require('../db/feedback');
const feedbackService = require('./feedbackService');

const REVIEW_POLICY_VERSION = '2026-10-23';
const OPEN_STATUSES = ['new', 'needs_info', 'accepted', 'in_progress'];

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

// 清单哈希：编号:修订 升序拼接，冻结后任何明细变化都会导致哈希不匹配
function computeManifestHash(items) {
  const lines = items
    .map(function (it) { return String(it.feedbackId) + ':' + String(it.expectedRevision) + ':' + String(it.conclusion || 'pending'); })
    .sort();
  return sha256(lines.join('\n'));
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
  const releaseSha = String(input.releaseSha || '').trim();
  const appVersion = String(input.appVersion || '').trim();
  if (!/^[0-9a-f]{7,40}$/.test(releaseSha)) throw createError(400, 'releaseSha 不合法');
  if (!appVersion) throw createError(400, '必须提供 appVersion');
  const deploymentId = assertUuid(input.deploymentId);
  const environment = 'production';

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
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
      'SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision", conclusion FROM ops.feedback_release_items WHERE run_id=$1',
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
    client.release();
  }
}

// 写入/更新单项核对结论（开发 Agent 的核对结果先落库，再由 apply 使用）
async function setItemConclusion(runId, feedbackId, patch) {
  const conclusions = ['pending', 'solved', 'partial', 'unrelated', 'needs_review'];
  if (conclusions.indexOf(patch.conclusion) < 0) throw createError(400, '核对结论不合法');
  const { rows } = await pool.query(
    `UPDATE ops.feedback_release_items
        SET conclusion=$1, implementation_commit=$2, evidence_summary=$3, updated_at=now()
      WHERE run_id=$4 AND feedback_id=$5
        AND apply_status='pending'
      RETURNING id::text AS id`,
    [patch.conclusion, String(patch.implementationCommit || '').slice(0, 64),
      String(patch.evidenceSummary || '').slice(0, 1000), runId, feedbackId]
  );
  if (!rows[0]) throw createError(404, '找不到该发布批次中的这条反馈，或该项已应用');
  return { runId: String(runId), feedbackId: String(feedbackId), conclusion: patch.conclusion };
}

async function freezeRun(runId) {
  const items = await pool.query(
    'SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision", conclusion FROM ops.feedback_release_items WHERE run_id=$1',
    [runId]
  );
  if (!items.rowCount) throw createError(400, '该发布批次没有核对明细');
  const manifestHash = computeManifestHash(items.rows);
  const { rows } = await pool.query(
    `UPDATE ops.feedback_release_runs
        SET manifest_hash=$1, prepare_status='frozen', updated_at=now()
      WHERE id=$2 RETURNING id::text AS id`,
    [manifestHash, runId]
  );
  if (!rows[0]) throw createError(404, '发布批次不存在');
  return { runId: String(runId), manifestHash: manifestHash };
}

// 专项验收记录：只有验收通过的批次才允许把反馈写成已实施
async function verifyRun(runId, input) {
  const evidence = input && input.evidence ? input.evidence : {};
  const passed = input && input.passed === true;
  const sha = String((input && input.verifiedSha) || '').trim();
  const { rows } = await pool.query(
    'SELECT id::text AS id, release_sha AS "releaseSha", app_version AS "appVersion" FROM ops.feedback_release_runs WHERE id=$1',
    [runId]
  );
  if (!rows[0]) throw createError(404, '发布批次不存在');
  if (passed && sha !== rows[0].releaseSha) {
    throw createError(409, '验收提交与发布批次绑定的 SHA 不一致');
  }
  await pool.query(
    `UPDATE ops.feedback_release_runs
        SET verify_status=$1, verify_evidence=$2, updated_at=now()
      WHERE id=$3`,
    [passed ? 'passed' : 'failed', JSON.stringify(evidence), runId]
  );
  return { runId: String(runId), verifyStatus: passed ? 'passed' : 'failed' };
}

// ---------- 应用回写 ----------
// 每项独立事务：锁明细 → 锁反馈 → 校验 revision/状态 → 更新 → 同事务写事件 → 明细标已应用。
// 幂等锚点是 (run_id, feedback_id) 唯一键 + apply_status，不依赖“先查事件不存在再插入”。
async function applyRun(runId, options) {
  const opts = options || {};
  const runQuery = await pool.query(
    `SELECT id::text AS id, release_sha AS "releaseSha", app_version AS "appVersion",
            verify_status AS "verifyStatus", apply_status AS "applyStatus",
            manifest_hash AS "manifestHash", prepare_status AS "prepareStatus"
       FROM ops.feedback_release_runs WHERE id=$1`,
    [runId]
  );
  const run = runQuery.rows[0];
  if (!run) throw createError(404, '发布批次不存在');
  if (run.verifyStatus !== 'passed') throw createError(409, '该发布批次未通过专项验收，不能回写已实施');
  if (run.prepareStatus === 'draft') throw createError(409, '该发布批次清单尚未准备完成');

  const checked = await pool.query(
    'SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision", conclusion FROM ops.feedback_release_items WHERE run_id=$1',
    [runId]
  );
  const manifestHash = computeManifestHash(checked.rows);
  if (run.manifestHash && manifestHash !== run.manifestHash) {
    throw createError(409, '核对清单已被修改，请重新冻结后再次验收');
  }

  const targets = await pool.query(
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
    const item = targets.rows[i];
    results.push(await applyOne(runId, run, item, opts));
  }

  const applied = results.filter(function (r) { return r.applyStatus === 'applied'; }).length;
  const failed = results.filter(function (r) { return r.applyStatus !== 'applied' && r.applyStatus !== 'skipped'; }).length;
  const overall = failed === 0 ? 'applied' : (applied > 0 ? 'partial' : 'failed');
  await pool.query('UPDATE ops.feedback_release_runs SET apply_status=$1, updated_at=now() WHERE id=$2', [overall, runId]);
  return { runId: String(runId), applyStatus: overall, applied: applied, failed: failed, items: results };
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
      const validated = await feedbackService.validateStatusChange(client, fb, { status: 'implemented' }, {
        reason: '随版本 ' + run.appVersion + ' 发布并验收',
        implementedVersion: run.appVersion,
        implementedReleaseSha: run.releaseSha,
      });
      fields = validated.fields;
      summary = '随版本 ' + run.appVersion + ' 发布，专项验收通过';
    } else {
      // 部分解决：只记录进度并转为进行中，不自动关闭、也不改成重复或不采纳
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
  applyRun, readBack, listRuns, getRun, listItems, status, computeManifestHash,
};
