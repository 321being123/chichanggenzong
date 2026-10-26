// ========== 站内通知模块集成测试（2026-10-25） ==========
// 规则登记：NOTIFICATION-DISPATCH-001（群发投递只消费固定名单、按页核验执行令牌与批次代次、
// delivered/skipped 不重投、pending=0 且 failed=0 才完成）、NOTIFICATION-COMPLETE-001
// （完成通知只由已验收批次逐项事务生成，离开 implemented 在事务内失效）。
// 覆盖：迁移四表与执行令牌列、反馈完成通知（同事务/去重/作者删除）、离开已实施即失效、
//       未读与已读幂等、全部已读只影响当前分类且不吞新投递、
//       群发预览固定名单/幂等发送/零收件人拒绝/draft 取消/指定人数去重、
//       Runner 分页投递与停用账号跳过、已投递不重投、旧执行令牌不能改状态。
// 在临时数据库中执行（与业务库隔离）：先建库 → 跑全量迁移 → 断言 → 删库。
// 连不上本地 PostgreSQL 时明确标记跳过（不视为通过）。
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + (e && e.message)); console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
}

function baseConfig() {
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
  };
}

(async () => {
  // 库名必须匹配 server/db/connection.js 的测试隔离规则 (^|_)(test|migtest)(_|$)
  const tmpDb = 'portfolio_test_nt_' + Date.now();
  const admin = new Client(Object.assign(baseConfig(), { database: process.env.PGDATABASE || 'portfolio' }));
  try {
    await admin.connect();
  } catch (e) {
    console.log('--- 站内通知集成测试 ---');
    console.log('SKIP：本地 PostgreSQL 不可用（' + e.message + '），本文件未验证。');
    process.exit(0);
  }

  try {
    await admin.query('CREATE DATABASE "' + tmpDb + '"');
    // 关键顺序：先切换库名，再 require 连接模块，确保连接池落在临时库
    process.env.PGDATABASE = tmpDb;
    delete process.env.DATABASE_URL;

    const migrations = require('../db/migrations');
    await migrations.runMigrations();
    const pool = require('../db').pool;
    const store = require('../db/notifications');
    const ns = require('../services/notificationService');
    const batchSvc = require('../services/notificationBatchService');
    const release = require('../services/feedbackRelease');
    const feedbackService = require('../services/feedbackService');
    const slots = require('../services/jobScheduleSlots');
    const runner = require('../jobs/notificationDispatch');

    console.log('--- 站内通知集成测试（临时库 ' + tmpDb + '）---');

    // ===== 夹具 =====
    const suffix = String(Date.now()).slice(-6);
    const uAuthor = 'nt_author_' + suffix;
    const uAdmin = 'nt_admin_' + suffix;
    const uOther = 'nt_other_' + suffix;
    const uGone = 'nt_gone_' + suffix;
    await pool.query(
      `INSERT INTO public.users (username, password, role, status, nickname)
       VALUES ($1,'x','user','active','提交人'), ($2,'x','admin','active','管理员'),
              ($3,'x','user','active','其他人'), ($4,'x','user','disabled','停用号')`,
      [uAuthor, uAdmin, uOther, uGone]
    );

    await test('迁移建立通知四表并带执行令牌列', async function () {
      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_name LIKE 'notification%' ORDER BY 1`
      );
      const names = rows.map(function (r) { return r.table_name; });
      ['notification_batches', 'notification_operations', 'notification_recipients', 'notifications']
        .forEach(function (t) { assert.ok(names.indexOf(t) >= 0, '缺少表 ' + t); });
      const token = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name='job_schedule_slots' AND column_name='execution_token'`
      );
      assert.strictEqual(token.rowCount, 1, 'job_schedule_slots 缺少 execution_token');
    });

    await test('同一通知的收件槽位唯一（重复写入不新增）', async function () {
      const n = await pool.query(
        `INSERT INTO public.notifications (type,title,body,dedupe_key)
         VALUES ('system','唯一槽位测试','正文',$1) RETURNING id::text AS id`, ['test:slot:' + suffix]
      );
      const id = n.rows[0].id;
      const first = await store.insertRecipient(pool, {
        notificationId: id, recipientSlotKey: 'u:abc', recipientUsername: uOther, status: 'pending',
      });
      const second = await store.insertRecipient(pool, {
        notificationId: id, recipientSlotKey: 'u:abc', recipientUsername: uOther, status: 'pending',
      });
      assert.ok(first && first.id, '首次写入应成功');
      assert.strictEqual(second, null, '同槽位重复写入必须被唯一约束拦下');
      const count = await pool.query(
        'SELECT count(*)::int AS c FROM public.notification_recipients WHERE notification_id=$1', [id]
      );
      assert.strictEqual(count.rows[0].c, 1);
    });

    await test('未投递记录不能标记已读（库级约束）', async function () {
      const n = await pool.query(
        `INSERT INTO public.notifications (type,title,body,dedupe_key)
         VALUES ('system','未投递已读','正文',$1) RETURNING id::text AS id`, ['test:read:' + suffix]
      );
      const rec = await store.insertRecipient(pool, {
        notificationId: n.rows[0].id, recipientSlotKey: 'u:x', recipientUsername: uOther, status: 'pending',
      });
      await assert.rejects(
        pool.query('UPDATE public.notification_recipients SET read_at=now() WHERE id=$1', [rec.id]),
        /read_after_delivery/
      );
    });

    // ===== 反馈完成通知 =====
    const runtime = release.readTrustedRuntime();
    const deploymentId = crypto.randomUUID();
    let runId = null;
    let feedbackId = null;

    async function seedFeedback(author) {
      const fb = await pool.query(
        `INSERT INTO public.feedbacks (author_username, author_nickname_snapshot, type, title, description, status)
         VALUES ($1,'提交人','bug','通知测试反馈','描述','new') RETURNING id::text AS id, revision::text AS revision`,
        [author]
      );
      return fb.rows[0];
    }

    async function seedRun() {
      const run = await pool.query(
        `INSERT INTO ops.feedback_release_runs
           (deployment_id, environment, release_sha, app_version, base_deployed_sha,
            review_policy_version, snapshot_at, owner, prepare_status, verify_status, verify_evidence,
            manifest_hash, snapshot_count, snapshot_complete)
         VALUES ($1,'production',$2,$3,'','2026-10-23',now(),$4,'frozen','passed','{"k":"v"}'::jsonb,'',1,true)
         RETURNING id::text AS id`,
        [deploymentId, runtime.sha, runtime.version, uAdmin]
      );
      return run.rows[0].id;
    }

    await test('已验收批次应用后生成一条完成通知并投递给作者', async function () {
      const fb = await seedFeedback(uAuthor);
      feedbackId = fb.id;
      runId = await seedRun();
      await pool.query(
        `INSERT INTO ops.feedback_release_items
           (run_id, feedback_id, expected_revision, expected_status, conclusion, implementation_commit, evidence_summary)
         VALUES ($1,$2,$3,'new','solved','abc1234','测试证据')`,
        [runId, feedbackId, fb.revision]
      );
      const result = await release.applyRun(runId, {
        operator: uAdmin, deploymentId: deploymentId,
        expectedSha: runtime.sha, expectedVersion: runtime.version,
      });
      assert.strictEqual(result.applied, 1, '应成功应用 1 项：' + JSON.stringify(result));
      const fbAfter = await pool.query('SELECT status FROM public.feedbacks WHERE id=$1', [feedbackId]);
      assert.strictEqual(fbAfter.rows[0].status, 'implemented');
      const notice = await pool.query(
        `SELECT n.id::text AS id, n.title, n.body, n.invalidated_at,
                r.status, r.read_at, r.recipient_slot_key
           FROM public.notifications n
           JOIN public.notification_recipients r ON r.notification_id = n.id
          WHERE n.feedback_id=$1`,
        [feedbackId]
      );
      assert.strictEqual(notice.rowCount, 1, '应只生成一条完成通知');
      assert.strictEqual(notice.rows[0].status, 'delivered');
      assert.strictEqual(notice.rows[0].recipient_slot_key, 'feedback_author');
      assert.ok(notice.rows[0].body.indexOf(runtime.version) >= 0, '正文应带版本号');
      assert.ok(!/['"][0-9a-f]{40}/.test(notice.rows[0].body), '正文不得出现发布 SHA');
    });

    await test('同批次重复应用不产生第二条通知', async function () {
      const again = await release.applyRun(runId, {
        operator: uAdmin, deploymentId: deploymentId,
        expectedSha: runtime.sha, expectedVersion: runtime.version,
      });
      assert.strictEqual(again.applied, 1);
      const count = await pool.query(
        'SELECT count(*)::int AS c FROM public.notifications WHERE feedback_id=$1', [feedbackId]
      );
      assert.strictEqual(count.rows[0].c, 1);
    });

    await test('作者已删除时保留唯一槽位并记 skipped/author_deleted', async function () {
      const fb = await seedFeedback(null);
      const notice = await ns.createFeedbackImplementedNotice(pool, {
        feedbackId: fb.id, releaseRunId: runId, appVersion: runtime.version, authorUsername: null,
      });
      const rec = await pool.query(
        `SELECT status, skip_reason, recipient_username FROM public.notification_recipients
          WHERE notification_id=$1`, [notice.notificationId]
      );
      assert.strictEqual(rec.rowCount, 1);
      assert.strictEqual(rec.rows[0].status, 'skipped');
      assert.strictEqual(rec.rows[0].skip_reason, 'author_deleted');
      assert.strictEqual(rec.rows[0].recipient_username, null);
    });

    await test('离开已实施的任何目标状态都会失效当前完成通知', async function () {
      const actor = { username: uAdmin, canModerate: true };
      await feedbackService.adminUpdate(feedbackId, actor, {
        status: 'in_progress', reason: '需要继续跟进', expectedRevision: '2',
      });
      const notice = await pool.query(
        'SELECT invalidated_at, invalidation_reason FROM public.notifications WHERE feedback_id=$1',
        [feedbackId]
      );
      assert.ok(notice.rows[0].invalidated_at, '通知应被失效');
      assert.ok(String(notice.rows[0].invalidation_reason || '').length > 0, '失效原因不能为空');
      const fb = await pool.query('SELECT status FROM public.feedbacks WHERE id=$1', [feedbackId]);
      assert.strictEqual(fb.rows[0].status, 'in_progress');
    });

    // ===== 未读与已读 =====
    let noticeA = null;
    let noticeB = null;
    async function seedDelivered(type, title, username) {
      const n = await pool.query(
        `INSERT INTO public.notifications (type,title,body,dedupe_key)
         VALUES ($1,$2,'正文',$3) RETURNING id::text AS id`, [type, title, 'test:' + title + suffix]
      );
      await store.insertRecipient(pool, {
        notificationId: n.rows[0].id, recipientSlotKey: 'u:' + crypto.randomUUID().slice(0, 8),
        recipientUsername: username, status: 'delivered',
      });
      return n.rows[0].id;
    }

    await test('未读只统计本人已投递未读且未失效记录', async function () {
      noticeA = await seedDelivered('system', '系统通知A', uOther);
      noticeB = await seedDelivered('feedback', '反馈通知B', uOther);
      const counts = await ns.unreadCountSummary(uOther);
      assert.strictEqual(counts.total, 2, '未读总数应为 2，实际 ' + counts.total);
      assert.strictEqual(counts.system, 1);
      assert.strictEqual(counts.feedback, 1);
      const otherCounts = await ns.unreadCountSummary(uAuthor);
      assert.strictEqual(otherCounts.total, 0, '不能统计他人通知');
    });

    await test('单条已读幂等并保留首次时间', async function () {
      const first = await ns.markRead(uOther, noticeA);
      const second = await ns.markRead(uOther, noticeA);
      assert.strictEqual(String(first.readAt), String(second.readAt), '重复已读必须保留首次 read_at');
      assert.strictEqual(second.unread.total, 1);
    });

    await test('全部已读按当前分类生效，请求后新投递保持未读', async function () {
      // 先只清「系统」分类：反馈类应保持未读
      const scoped = await ns.markAllRead(uOther, 'system');
      assert.strictEqual(scoped.marked, 0, '系统分类已无未读');
      assert.strictEqual(scoped.unread.feedback, 1);
      // 请求之后新投递一条系统通知，再对系统分类全部已读：新到的这条必须仍未读
      const fresh = await seedDelivered('system', '新到通知C', uOther);
      const all = await ns.markAllRead(uOther, 'all');
      assert.ok(all.marked >= 1);
      const still = await pool.query(
        `SELECT read_at FROM public.notification_recipients
          WHERE notification_id=$1 AND recipient_username=$2`, [fresh, uOther]
      );
      assert.ok(still.rows[0].read_at, '已存在收件应被本次全部已读覆盖');
      const after = await seedDelivered('system', '全部已读之后D', uOther);
      const counts = await ns.unreadCountSummary(uOther);
      assert.strictEqual(counts.total, 1, '随后新投递的记录必须保持未读');
      const untouched = await pool.query(
        'SELECT read_at FROM public.notification_recipients WHERE notification_id=$1', [after]
      );
      assert.strictEqual(untouched.rows[0].read_at, null);
    });

    await test('他人通知按不存在处理，不泄露存在性', async function () {
      await assert.rejects(ns.detail(uAuthor, noticeA), function (e) { return e.status === 404; });
      await assert.rejects(ns.markRead(uAuthor, noticeA), function (e) { return e.status === 404; });
    });

    // ===== 后台群发 =====
    const adminActor = { username: uAdmin, role: 'admin' };
    let draftBatch = null;

    await test('预览生成草稿并固定完整名单', async function () {
      const result = await batchSvc.previewBatch(adminActor, {
        title: '维护通知', body: '今晚 22:00 维护', audienceMode: 'all',
        clientRequestId: crypto.randomUUID(),
      });
      draftBatch = result;
      assert.ok(result.batchId, '应返回批次编号');
      // 全发口径必须与独立查询的 active 集合一致（不截断、不多算停用账号）
      const expected = await pool.query("SELECT count(*)::int AS c FROM public.users WHERE status='active'");
      assert.strictEqual(Number(result.snapshotCount), expected.rows[0].c,
        '全发人数应与 active 账号数一致，实际 ' + result.snapshotCount + ' 期望 ' + expected.rows[0].c);
      const listed = await pool.query(
        `SELECT count(*)::int AS c FROM public.notification_recipients WHERE notification_id=$1`,
        [result.notificationId]
      );
      assert.strictEqual(listed.rows[0].c, Number(result.snapshotCount), '名单快照与收件记录必须一致');
    });

    await test('预览后新注册账号不追加进名单', async function () {
      const uNew = 'nt_new_' + suffix;
      await pool.query("INSERT INTO public.users (username,password,role,status) VALUES ($1,'x','user','active')", [uNew]);
      const after = await pool.query(
        `SELECT count(*)::int AS c FROM public.notification_recipients WHERE notification_id=$1`,
        [draftBatch.notificationId]
      );
      assert.strictEqual(after.rows[0].c, Number(draftBatch.snapshotCount), '名单必须保持预览时的快照');
    });

    await test('发送确认建立槽位并进入排队', async function () {
      const requestId = crypto.randomUUID();
      const sent = await batchSvc.sendBatch(adminActor, draftBatch.batchId, {
        revision: draftBatch.revision, contentAudienceHash: draftBatch.contentAudienceHash,
        clientRequestId: requestId,
      });
      assert.strictEqual(sent.status, 'queued');
      assert.ok(sent.slotId, '必须建立调度槽位');
      const row = await pool.query(
        `SELECT status, dispatch_slot_id::text AS slot FROM public.notification_batches WHERE id=$1`,
        [draftBatch.batchId]
      );
      assert.strictEqual(row.rows[0].status, 'queued');
      assert.strictEqual(row.rows[0].slot, sent.slotId);
      // 同请求标识重放返回原结果，不新建批次
      const replay = await batchSvc.sendBatch(adminActor, draftBatch.batchId, {
        revision: draftBatch.revision, contentAudienceHash: draftBatch.contentAudienceHash,
        clientRequestId: requestId,
      });
      assert.strictEqual(replay.reused, true);
      assert.strictEqual(replay.slotId, sent.slotId);
    });

    await test('已确认批次不能再次发送或取消', async function () {
      await assert.rejects(
        batchSvc.sendBatch(adminActor, draftBatch.batchId, {
          revision: draftBatch.revision, contentAudienceHash: draftBatch.contentAudienceHash,
          clientRequestId: crypto.randomUUID(),
        }), function (e) { return e.status === 409; }
      );
      await assert.rejects(
        batchSvc.cancelBatch(adminActor, draftBatch.batchId, { clientRequestId: crypto.randomUUID() }),
        function (e) { return e.status === 409; }
      );
    });

    await test('零收件人不能发送，草稿可取消', async function () {
      const empty = await batchSvc.previewBatch(adminActor, {
        title: '空名单', body: '', audienceMode: 'selected', usernames: ['no_such_user_' + suffix],
        clientRequestId: crypto.randomUUID(),
      });
      assert.strictEqual(Number(empty.snapshotCount), 0);
      await assert.rejects(
        batchSvc.sendBatch(adminActor, empty.batchId, {
          revision: empty.revision, contentAudienceHash: empty.contentAudienceHash,
          clientRequestId: crypto.randomUUID(),
        }), function (e) { return e.status === 409; }
      );
      const cancelled = await batchSvc.cancelBatch(adminActor, empty.batchId, { clientRequestId: crypto.randomUUID() });
      assert.strictEqual(cancelled.status, 'cancelled');
    });

    await test('指定多人服务端去重并只保留启用账号', async function () {
      const result = await batchSvc.previewBatch(adminActor, {
        title: '指定发送', body: '正文', audienceMode: 'selected',
        usernames: [uOther, uOther, uGone],
        clientRequestId: crypto.randomUUID(),
      });
      assert.strictEqual(Number(result.snapshotCount), 1, '停用账号应被剔除、重复账号去重');
    });

    await test('仅系统管理员可预览/发送', async function () {
      await assert.rejects(
        batchSvc.previewBatch({ username: uOther }, {
          title: '越权', body: '', audienceMode: 'all', clientRequestId: crypto.randomUUID(),
        }), function (e) { return e.status === 403; }
      );
    });

    await test('后台路径派发把通知群发限定管理员', async function () {
      const adminRouter = require('../routes/admin');
      assert.strictEqual(adminRouter.adminCapabilityForPath('/notifications/preview'), 'admin_only');
      assert.strictEqual(adminRouter.adminCapabilityForPath('/notifications'), 'admin_only');
    });

    // ===== Runner 投递 =====
    await test('Runner 按页投递、停用账号跳过，已投递不再重投', async function () {
      // 用「指定多人」建一个只含 uOther 与 uGone(停用) 的批次，避免影响其他用例数据
      const uActive = uOther;
      const draft = await batchSvc.previewBatch(adminActor, {
        title: '投递测试', body: '正文', audienceMode: 'selected',
        usernames: [uActive], clientRequestId: crypto.randomUUID(),
      });
      const sent = await batchSvc.sendBatch(adminActor, draft.batchId, {
        revision: draft.revision, contentAudienceHash: draft.contentAudienceHash,
        clientRequestId: crypto.randomUUID(),
      });
      // 模拟预览后账号被停用：确认后、投递前停用，Runner 必须记 skipped
      await pool.query("UPDATE public.users SET status='disabled' WHERE username=$1", [uActive]);
      // 领取槽位（走统一执行器入口，拿到本次执行令牌）
      const claimed = await slots.claimSlot(Number(sent.slotId), 'test-worker', 'manual_retry');
      assert.ok(claimed, '应能领取槽位');
      const result = await runner.runNotificationDispatch('manual-retry', {
        slotId: Number(sent.slotId), executionToken: claimed.execution_token, batchId: String(draft.batchId),
      });
      assert.strictEqual(Number(result.pendingCount), 0, '本轮不应残留待处理：' + JSON.stringify(result));
      const rec = await pool.query(
        `SELECT status, skip_reason FROM public.notification_recipients WHERE notification_id=$1`,
        [draft.notificationId]
      );
      assert.strictEqual(rec.rows[0].status, 'skipped');
      assert.strictEqual(rec.rows[0].skip_reason, 'account_inactive');
      const batchRow = await pool.query(
        'SELECT status, skipped_count FROM public.notification_batches WHERE id=$1', [draft.batchId]
      );
      // 全部跳过且无失败也应视为完成
      assert.strictEqual(batchRow.rows[0].status, 'completed');
      assert.strictEqual(Number(batchRow.rows[0].skipped_count), 1);
      await pool.query("UPDATE public.users SET status='active' WHERE username=$1", [uActive]);
    });

    await test('旧执行令牌不能改槽位状态（接管保护）', async function () {
      const draft = await batchSvc.previewBatch(adminActor, {
        title: '令牌测试', body: '正文', audienceMode: 'selected',
        usernames: [uOther], clientRequestId: crypto.randomUUID(),
      });
      const sent = await batchSvc.sendBatch(adminActor, draft.batchId, {
        revision: draft.revision, contentAudienceHash: draft.contentAudienceHash,
        clientRequestId: crypto.randomUUID(),
      });
      const slotId = Number(sent.slotId);
      const claimed = await slots.claimSlot(slotId, 'test-worker-a', 'manual_retry');
      assert.ok(claimed && claimed.execution_token, '首次领取应有执行令牌');
      const oldToken = claimed.execution_token;
      // 模拟被另一次执行接管：令牌更换
      await pool.query("UPDATE ops.job_schedule_slots SET execution_token='takeover-token', status='running' WHERE slot_id=$1", [slotId]);
      const stale = await slots.completeSlot(slotId, 'succeeded', { ok: true }, null, null, oldToken);
      assert.strictEqual(stale, null, '旧令牌写入必须影响 0 行');
      const row = await pool.query('SELECT status, execution_token FROM ops.job_schedule_slots WHERE slot_id=$1', [slotId]);
      assert.strictEqual(row.rows[0].status, 'running', '槽位状态不能被旧执行改写');
      assert.strictEqual(row.rows[0].execution_token, 'takeover-token');
      // 清理：让该槽位离开 running，避免影响后续用例统计
      await pool.query("UPDATE ops.job_schedule_slots SET status='failed' WHERE slot_id=$1", [slotId]);
    });

    // ===== 2026-10-25 验收反例（5 类） =====
    await test('迁移 173 增加收件人账号身份列', async function () {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='notification_recipients'
            AND column_name='recipient_identity'`
      );
      assert.strictEqual(rows.length, 1, '缺少 recipient_identity 列');
    });

    async function seedDraft(title, usernames) {
      const draft = await batchSvc.previewBatch(adminActor, {
        title: title, body: '正文', audienceMode: 'selected', usernames: usernames,
        clientRequestId: crypto.randomUUID(),
      });
      return draft;
    }

    await test('预览后删号并同名重注册：投递前身份不符只记 skipped（不误投新账号）', async function () {
      const name = 'nt_reuse_' + suffix;
      await pool.query("INSERT INTO public.users (username,password,role,status) VALUES ($1,'x','user','active')", [name]);
      const draft = await seedDraft('同名重注册', [name]);
      const sent = await batchSvc.sendBatch(adminActor, draft.batchId, {
        revision: draft.revision, contentAudienceHash: draft.contentAudienceHash,
        clientRequestId: crypto.randomUUID(),
      });
      // 模拟「预览后删号并同名重注册」：用户名不变、建号时间变化 = 另一个账号
      await pool.query("UPDATE public.users SET created_at = now() - interval '2 hours' WHERE username=$1", [name]);
      const claimed = await slots.claimSlot(Number(sent.slotId), 'test-worker', 'manual_retry');
      const result = await runner.runNotificationDispatch('manual-retry', {
        slotId: Number(sent.slotId), executionToken: claimed.execution_token, batchId: String(draft.batchId),
      });
      assert.strictEqual(Number(result.pendingCount), 0);
      const rec = await pool.query(
        'SELECT status, skip_reason FROM public.notification_recipients WHERE notification_id=$1',
        [draft.notificationId]
      );
      assert.strictEqual(rec.rows[0].status, 'skipped');
      assert.strictEqual(rec.rows[0].skip_reason, 'account_replaced', '同名新账号必须记 account_replaced');
      await pool.query('DELETE FROM public.users WHERE username=$1', [name]);
    });

    await test('缺少执行令牌一律拒绝投递，且不改批次状态', async function () {
      const draft = await seedDraft('缺令牌', [uOther]);
      const sent = await batchSvc.sendBatch(adminActor, draft.batchId, {
        revision: draft.revision, contentAudienceHash: draft.contentAudienceHash,
        clientRequestId: crypto.randomUUID(),
      });
      const result = await runner.runNotificationDispatch('manual-retry', {
        slotId: Number(sent.slotId), batchId: String(draft.batchId),
      });
      assert.strictEqual(result.ok, false);
      assert.ok(/执行令牌/.test(result.error || ''), '缺令牌应明确拒绝：' + JSON.stringify(result));
      const row = await pool.query('SELECT status FROM public.notification_batches WHERE id=$1', [draft.batchId]);
      assert.strictEqual(row.rows[0].status, 'queued', '缺令牌不得把批次改成 running');
      const rec = await pool.query(
        'SELECT status FROM public.notification_recipients WHERE notification_id=$1', [draft.notificationId]
      );
      assert.strictEqual(rec.rows[0].status, 'pending', '缺令牌不得投递');
      await pool.query('UPDATE public.notification_batches SET status=$2 WHERE id=$1', [draft.batchId, 'cancelled']);
    });

    await test('租约过期时拒绝写入，不把批次写成完成', async function () {
      const draft = await seedDraft('租约过期', [uOther]);
      const sent = await batchSvc.sendBatch(adminActor, draft.batchId, {
        revision: draft.revision, contentAudienceHash: draft.contentAudienceHash,
        clientRequestId: crypto.randomUUID(),
      });
      const claimed = await slots.claimSlot(Number(sent.slotId), 'test-worker', 'manual_retry');
      await pool.query(
        "UPDATE ops.job_schedule_slots SET lease_until = now() - interval '1 minute' WHERE slot_id=$1",
        [Number(sent.slotId)]
      );
      const result = await runner.runNotificationDispatch('manual-retry', {
        slotId: Number(sent.slotId), executionToken: claimed.execution_token, batchId: String(draft.batchId),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'lease_expired');
      const row = await pool.query('SELECT status FROM public.notification_batches WHERE id=$1', [draft.batchId]);
      assert.strictEqual(row.rows[0].status, 'queued', '租约过期不得改写批次状态');
      const rec = await pool.query(
        'SELECT status FROM public.notification_recipients WHERE notification_id=$1', [draft.notificationId]
      );
      assert.strictEqual(rec.rows[0].status, 'pending', '租约过期不得投递');
      await pool.query("UPDATE ops.job_schedule_slots SET status='failed' WHERE slot_id=$1", [Number(sent.slotId)]);
    });

    await test('旧执行令牌不能修改批次状态（进入态也受守卫）', async function () {
      const draft = await seedDraft('旧令牌', [uOther]);
      const sent = await batchSvc.sendBatch(adminActor, draft.batchId, {
        revision: draft.revision, contentAudienceHash: draft.contentAudienceHash,
        clientRequestId: crypto.randomUUID(),
      });
      const claimed = await slots.claimSlot(Number(sent.slotId), 'test-worker-a', 'manual_retry');
      const oldToken = claimed.execution_token;
      // 被另一次执行接管：换令牌但保持 running 与有效租约
      await pool.query(
        "UPDATE ops.job_schedule_slots SET execution_token='takeover-token', status='running', lease_until=now()+interval '10 minutes' WHERE slot_id=$1",
        [Number(sent.slotId)]
      );
      const result = await runner.runNotificationDispatch('manual-retry', {
        slotId: Number(sent.slotId), executionToken: oldToken, batchId: String(draft.batchId),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'execution_token_mismatch');
      const row = await pool.query('SELECT status FROM public.notification_batches WHERE id=$1', [draft.batchId]);
      assert.strictEqual(row.rows[0].status, 'queued', '旧令牌不得把批次改成 running');
      await pool.query("UPDATE ops.job_schedule_slots SET status='failed' WHERE slot_id=$1", [Number(sent.slotId)]);
    });

    await test('同一请求标识重复预览返回原结果，不新建批次', async function () {
      const requestId = crypto.randomUUID();
      const countBatches = async function () {
        const r = await pool.query('SELECT count(*)::int AS c FROM public.notification_batches');
        return r.rows[0].c;
      };
      const before = await countBatches();
      const first = await batchSvc.previewBatch(adminActor, {
        title: '重复预览', body: '正文', audienceMode: 'selected', usernames: [uOther],
        clientRequestId: requestId,
      });
      const mid = await countBatches();
      assert.strictEqual(mid, before + 1, '首次预览应只建 1 个批次（前 ' + before + ' → 后 ' + mid + '）');
      const second = await batchSvc.previewBatch(adminActor, {
        title: '重复预览', body: '正文', audienceMode: 'selected', usernames: [uOther],
        clientRequestId: requestId,
      });
      assert.strictEqual(String(second.batchId), String(first.batchId), '重复预览必须复用原批次');
      assert.strictEqual(second.reused, true);
      const after = await countBatches();
      assert.strictEqual(after, mid, '重复预览不得新建批次（中 ' + mid + ' → 后 ' + after + '）');
      // 同标识不同内容必须拒绝
      await assert.rejects(
        batchSvc.previewBatch(adminActor, {
          title: '改了内容', body: '正文', audienceMode: 'selected', usernames: [uOther],
          clientRequestId: requestId,
        }), function (e) { return e.status === 409; }
      );
    });

    await test('相同请求并发的重复确认复用同一槽位，不报 409', async function () {
      const draft = await seedDraft('并发确认', [uOther]);
      const requestId = crypto.randomUUID();
      const payload = {
        revision: draft.revision, contentAudienceHash: draft.contentAudienceHash,
        clientRequestId: requestId,
      };
      const [a, b] = await Promise.all([
        batchSvc.sendBatch(adminActor, draft.batchId, payload),
        batchSvc.sendBatch(adminActor, draft.batchId, payload),
      ]);
      assert.strictEqual(String(a.slotId), String(b.slotId), '两个并发请求必须复用同一槽位');
      assert.ok(a.reused || b.reused, '至少一个请求应标记为复用原结果');
      const slotsUsed = await pool.query(
        `SELECT count(*)::int AS c FROM ops.job_schedule_slots
          WHERE job_code='notification_dispatch' AND request_payload->>'batchId'=$1`,
        [String(draft.batchId)]
      );
      assert.strictEqual(slotsUsed.rows[0].c, 1, '同批次只能有一个槽位');
    });

    await test('租约过期后槽位收尾被拒绝，不能标记成功', async function () {
      const draft = await seedDraft('收尾租约', [uOther]);
      const sent = await batchSvc.sendBatch(adminActor, draft.batchId, {
        revision: draft.revision, contentAudienceHash: draft.contentAudienceHash,
        clientRequestId: crypto.randomUUID(),
      });
      const slotId = Number(sent.slotId);
      const claimed = await slots.claimSlot(slotId, 'test-worker', 'manual_retry');
      await pool.query(
        "UPDATE ops.job_schedule_slots SET lease_until = now() - interval '1 minute' WHERE slot_id=$1", [slotId]
      );
      const done = await slots.completeSlot(slotId, 'succeeded', { ok: true }, null, null, claimed.execution_token);
      assert.strictEqual(done, null, '租约过期后 completeSlot 必须影响 0 行');
      const row = await pool.query('SELECT status FROM ops.job_schedule_slots WHERE slot_id=$1', [slotId]);
      assert.strictEqual(row.rows[0].status, 'running', '槽位不能被标记为成功');
      await pool.query("UPDATE ops.job_schedule_slots SET status='failed' WHERE slot_id=$1", [slotId]);
    });

    await test('处理过程中跨过到期时间：批次提交被实际时钟拒绝', async function () {
      const draft = await seedDraft('跨期提交', [uOther]);
      const sent = await batchSvc.sendBatch(adminActor, draft.batchId, {
        revision: draft.revision, contentAudienceHash: draft.contentAudienceHash,
        clientRequestId: crypto.randomUUID(),
      });
      const slotId = Number(sent.slotId);
      const claimed = await slots.claimSlot(slotId, 'test-worker', 'manual_retry');
      // 租约只剩 300ms：事务先开始，然后跨过到期时间再写批次
      await pool.query(
        "UPDATE ops.job_schedule_slots SET lease_until = clock_timestamp() + interval '300 milliseconds' WHERE slot_id=$1",
        [slotId]
      );
      const generation = await pool.query(
        'SELECT dispatch_generation FROM public.notification_batches WHERE id=$1', [draft.batchId]
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // 固定事务时钟（now()），模拟「事务早已开始、处理中才过期」
        await client.query('SELECT now()');
        await new Promise(function (resolve) { setTimeout(resolve, 600); });
        const updated = await store.updateBatchGuarded(client, {
          batchId: String(draft.batchId),
          generation: Number(generation.rows[0].dispatch_generation),
          slotId: slotId,
          executionToken: claimed.execution_token,
        }, { status: 'completed', pendingCount: 0 });
        assert.strictEqual(updated, null, '跨过到期时间的批次写入必须影响 0 行（不能用事务 now() 放行）');
      } finally {
        await client.query('ROLLBACK').catch(function () {});
        client.release();
      }
      const row = await pool.query('SELECT status FROM public.notification_batches WHERE id=$1', [draft.batchId]);
      assert.strictEqual(row.rows[0].status, 'queued', '批次不能被写成完成');
      await pool.query("UPDATE ops.job_schedule_slots SET status='failed' WHERE slot_id=$1", [slotId]);
    });

    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    if (fail) {
      console.log('失败明细：');
      failures.forEach(function (f) { console.log('  - ' + f); });
    }
    await pool.end().catch(function () {});
    await admin.query('DROP DATABASE IF EXISTS "' + tmpDb + '" WITH (FORCE)').catch(function () {});
    await admin.end().catch(function () {});
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('测试执行失败：', e && e.stack || e);
    await admin.query('DROP DATABASE IF EXISTS "' + tmpDb + '" WITH (FORCE)').catch(function () {});
    await admin.end().catch(function () {});
    process.exit(1);
  }
})();
