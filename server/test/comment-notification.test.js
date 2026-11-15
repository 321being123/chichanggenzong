// ========== 文章评论通知与提醒设置专项测试（2026-11-15） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.13 节。
// 覆盖：迁移（通知类型/目标类型/主体快照/请求幂等/偏好表）、一级评论/回复/@ 生成通知、
//       同人重叠原因合并与展示优先级、逐原因按设置过滤、三关全不生成、
//       反馈完成通知被设置关闭时仍应用成功但收件 skipped/preference_disabled、重开不补发、
//       父评论严格 409、@ 区间与身份校验、请求幂等（同标识同内容复用、不同内容 409）、
//       评论删除与文章撤回失效、收件箱按主体隔离、偏好读取默认与版本冲突、@ 候选转义、前端静态契约。
// 在临时数据库中执行（单文件运行从空库迁移）；连不上本地 PostgreSQL 时明确标记跳过。
const assert = require('assert');
const fs = require('fs');
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
  const tmpDb = 'portfolio_test_cmt_' + Date.now();
  const admin = new Client(Object.assign(baseConfig(), { database: process.env.PGDATABASE || 'portfolio' }));
  try {
    await admin.connect();
  } catch (e) {
    console.log('--- 文章评论通知与提醒设置专项测试 ---');
    console.log('SKIP：本地 PostgreSQL 不可用（' + e.message + '），本文件未验证。');
    process.exit(0);
  }

  try {
    // 库名必须匹配 server/db/connection.js 的测试隔离规则 (^|_)(test|migtest)(_|$)
    await require('./helpers/migrated-database').createMigratedDatabase(admin, tmpDb);
    process.env.PGDATABASE = tmpDb;
    delete process.env.DATABASE_URL;

    const pool = require('../db').pool;
    const store = require('../db/notifications');
    const ns = require('../services/notificationService');
    const prefs = require('../services/notificationPreferenceService');
    const comments = require('../services/commentService');
    const release = require('../services/feedbackRelease');

    console.log('--- 文章评论通知与提醒设置专项测试（临时库 ' + tmpDb + '）---');

    const suffix = String(Date.now()).slice(-6);
    const uAuthor = 'cmt_author_' + suffix;
    const uReader = 'cmt_reader_' + suffix;
    const uOther = 'cmt_other_' + suffix;
    const uOff = 'cmt_off_' + suffix;
    const uAdmin = 'cmt_admin_' + suffix;
    await pool.query(
      `INSERT INTO public.users (username, password, role, status, nickname)
       VALUES ($1,'x','user','active','文章作者'), ($2,'x','user','active','读者'),
              ($3,'x','user','active','另一位'), ($4,'x','user','disabled','停用号'),
              ($5,'x','admin','active','管理员')`,
      [uAuthor, uReader, uOther, uOff, uAdmin]
    );

    async function subjectOf(username) {
      const { rows } = await pool.query('SELECT subject_id::text AS s FROM public.users WHERE username=$1', [username]);
      return rows[0].s;
    }

    const subjAuthor = await subjectOf(uAuthor);
    const subjReader = await subjectOf(uReader);
    const subjOther = await subjectOf(uOther);
    const subjOff = await subjectOf(uOff);

    async function seedArticle(author) {
      const { rows } = await pool.query(
        `INSERT INTO public.articles (title, content, status, author_username, published_at)
         VALUES ('评论通知测试文章','正文','published',$1, now()) RETURNING id`,
        [author]
      );
      return rows[0].id;
    }

    async function comment(articleId, author, content, extra) {
      const opts = extra || {};
      return comments.createComment({
        articleId: articleId,
        authorUsername: author,
        authorSubjectId: await subjectOf(author),
        content: content,
        parentId: opts.parentId || null,
        mentions: opts.mentions || null,
        clientRequestId: opts.clientRequestId || '',
        ipHash: 'test',
        nickname: author,
      });
    }

    async function noticesOf(commentId) {
      const { rows } = await pool.query(
        `SELECT n.id::text AS id, n.title, n.body, n.invalidated_at AS "invalidatedAt",
                n.payload, r.status, r.skip_reason AS "skipReason",
                r.recipient_username AS "recipientUsername",
                r.recipient_subject_id::text AS "recipientSubjectId"
           FROM public.notifications n
           JOIN public.notification_recipients r ON r.notification_id = n.id
          WHERE n.target_kind = 'article_comment' AND n.target_id = $1
          ORDER BY n.id`,
        [String(commentId)]
      );
      return rows;
    }

    const articleId = await seedArticle(uAuthor);

    // ===== 迁移 =====
    await test('迁移扩展通知类型为 comment 并拒绝未知类型', async function () {
      const ok = await pool.query(
        `INSERT INTO public.notifications (type,title,body,target_kind,target_id,dedupe_key)
         VALUES ('comment','t','b','article_comment','1',$1) RETURNING id`, ['mig:ok:' + suffix]
      );
      assert.ok(ok.rows[0].id);
      await assert.rejects(
        pool.query(`INSERT INTO public.notifications (type,title,body,dedupe_key)
                    VALUES ('bogus','t','b',$1)`, ['mig:bad:' + suffix]),
        /type_check/
      );
      await assert.rejects(
        pool.query(`INSERT INTO public.notifications (type,title,body,target_kind,dedupe_key)
                    VALUES ('comment','t','b','bogus_kind',$1)`, ['mig:bad2:' + suffix]),
        /target_kind_check/
      );
    });

    await test('迁移建立偏好表、主体快照列与评论请求幂等表', async function () {
      const prefTable = await pool.query(
        `SELECT count(*)::int AS c FROM information_schema.tables
          WHERE table_schema='public' AND table_name='notification_preferences'`
      );
      assert.strictEqual(prefTable.rows[0].c, 1);
      const subjectCol = await pool.query(
        `SELECT count(*)::int AS c FROM information_schema.columns
          WHERE table_schema='public' AND table_name='notification_recipients'
            AND column_name='recipient_subject_id'`
      );
      assert.strictEqual(subjectCol.rows[0].c, 1);
      const reqTable = await pool.query(
        `SELECT count(*)::int AS c FROM information_schema.tables
          WHERE table_schema='public' AND table_name='article_comment_requests'`
      );
      assert.strictEqual(reqTable.rows[0].c, 1);
    });

    // ===== 生成规则 =====
    await test('一级评论只通知文章作者，且同事务记为已投递', async function () {
      const created = await comment(articleId, uReader, '这是一条普通评论');
      const rows = await noticesOf(created.comment.id);
      assert.strictEqual(rows.length, 1, '应只生成一条通知');
      assert.strictEqual(rows[0].recipientUsername, uAuthor);
      assert.strictEqual(rows[0].recipientSubjectId, subjAuthor);
      assert.strictEqual(rows[0].status, 'delivered');
      assert.ok(rows[0].title.indexOf('文章') >= 0, '文章评论通知标题应为文章维度');
      const payload = rows[0].payload || {};
      assert.strictEqual(String(payload.articleId), String(articleId));
      assert.deepStrictEqual(payload.reasons, ['article_comment']);
      const unread = await ns.unreadCountSummary(uAuthor, subjAuthor);
      assert.strictEqual(unread.comment, 1, '评论未读应计入 comment 分类');
      assert.strictEqual(unread.total, 1);
    });

    await test('评论自己发布的文章不通知自己', async function () {
      const created = await comment(articleId, uAuthor, '作者自己补充一句');
      const rows = await noticesOf(created.comment.id);
      assert.strictEqual(rows.length, 0);
    });

    await test('回复评论：父评论作者收到回复通知，文章作者收到文章评论通知', async function () {
      const first = await comment(articleId, uReader, '第一层评论');
      const reply = await comment(articleId, uOther, '回复读者', { parentId: first.comment.id });
      const rows = await noticesOf(reply.comment.id);
      const byUser = new Map(rows.map(function (r) { return [r.recipientUsername, r]; }));
      assert.ok(byUser.has(uReader), '父评论作者应收到回复通知');
      assert.ok(byUser.has(uAuthor), '文章作者应收到文章评论通知');
      assert.strictEqual(rows.length, 2, '两位收件人各一条');
      assert.deepStrictEqual(byUser.get(uReader).payload.reasons, ['comment_reply']);
      assert.deepStrictEqual(byUser.get(uAuthor).payload.reasons, ['article_comment']);
      assert.ok(byUser.get(uReader).title.indexOf('回复') >= 0);
    });

    await test('@ 提到：被提者收到通知，重复 @ 同一主体只算一次', async function () {
      const content = '请 @读者 看一下';
      const created = await comment(articleId, uOther, content, {
        mentions: [{ subjectId: subjReader, text: '@读者', start: 2, end: 5 }],
      });
      const rows = await noticesOf(created.comment.id);
      const mentioned = rows.filter(function (r) { return r.recipientUsername === uReader; });
      assert.strictEqual(mentioned.length, 1);
      assert.deepStrictEqual(mentioned[0].payload.reasons, ['comment_mention']);
    });

    await test('同一人既被回复又被 @：只一条通知，原因合并且 @ 优先展示', async function () {
      const parent = await comment(articleId, uReader, '等我回复');
      const content = '@读者 你再看一下';
      const reply = await comment(articleId, uOther, content, {
        parentId: parent.comment.id,
        mentions: [{ subjectId: subjReader, text: '@读者', start: 0, end: 3 }],
      });
      const rows = await noticesOf(reply.comment.id);
      const mine = rows.filter(function (r) { return r.recipientUsername === uReader; });
      assert.strictEqual(mine.length, 1, '每个收件人最多一条通知');
      assert.deepStrictEqual(mine[0].payload.reasons, ['comment_mention', 'comment_reply']);
      assert.ok(mine[0].title.indexOf('提到') >= 0, '展示优先级应为 @ ＞ 回复');
    });

    // ===== 设置过滤 =====
    await test('关闭「文章收到评论」只影响文章维度，回复通知照常', async function () {
      // 评论通知生成时已按主体建立默认设置行，版本从当前值起算（不是 0）
      const current = await prefs.read(subjAuthor);
      const saved = await prefs.save(subjAuthor, {
        version: current.version, articleComment: false, commentReply: true,
        commentMention: true, feedbackImplemented: true,
      });
      assert.strictEqual(saved.version, current.version + 1);
      const parent = await comment(articleId, uOther, '被回复的评论');
      const reply = await comment(articleId, uReader, '回复别人的评论', { parentId: parent.comment.id });
      const rows = await noticesOf(reply.comment.id);
      assert.ok(!rows.some(function (r) { return r.recipientUsername === uAuthor; }), '关闭后文章作者不应收到');
      assert.ok(rows.some(function (r) { return r.recipientUsername === uOther; }), '父评论作者的回复通知不受影响');
      const now = await prefs.read(subjAuthor);
      await prefs.save(subjAuthor, {
        version: now.version, articleComment: true, commentReply: true,
        commentMention: true, feedbackImplemented: true,
      });
    });

    await test('三个原因全关时评论仍成功但不生成任何通知', async function () {
      const current = await prefs.read(subjAuthor);
      const closed = await prefs.save(subjAuthor, {
        version: current.version, articleComment: false, commentReply: false,
        commentMention: false, feedbackImplemented: true,
      });
      assert.strictEqual(closed.version, current.version + 1);
      const created = await comment(articleId, uReader, '全关之后的评论');
      const rows = await noticesOf(created.comment.id);
      assert.strictEqual(rows.length, 0);
      const stillThere = await pool.query('SELECT id FROM public.article_comments WHERE id=$1', [created.comment.id]);
      assert.strictEqual(stillThere.rowCount, 1, '评论本身必须写入成功');
      const now = await prefs.read(subjAuthor);
      await prefs.save(subjAuthor, {
        version: now.version, articleComment: true, commentReply: true,
        commentMention: true, feedbackImplemented: true,
      });
    });

    // ===== 反馈完成通知的设置 =====
    const runtime = release.readTrustedRuntime();
    const uFbAuthor = uOther;

    async function seedFeedbackAndRun(subjectId, prefValues) {
      if (prefValues) await prefs.save(subjectId, prefValues);
      // 每个批次必须有独立部署标识（同环境同 deployment_id 有唯一约束）
      const runDeploymentId = crypto.randomUUID();
      const fb = await pool.query(
        `INSERT INTO public.feedbacks (author_username, author_nickname_snapshot, type, title, description, status)
         VALUES ($1,'提交人','bug','设置开关测试','描述','new') RETURNING id::text AS id, revision::text AS revision`,
        [uFbAuthor]
      );
      const run = await pool.query(
        `INSERT INTO ops.feedback_release_runs
           (deployment_id, environment, release_sha, app_version, base_deployed_sha,
            review_policy_version, snapshot_at, owner, prepare_status, verify_status, verify_evidence,
            manifest_hash, snapshot_count, snapshot_complete)
         VALUES ($1,'production',$2,$3,'','2026-10-23',now(),$4,'frozen','passed','{"k":"v"}'::jsonb,'',1,true)
         RETURNING id::text AS id`,
        [runDeploymentId, runtime.sha, runtime.version, uAdmin]
      );
      await pool.query(
        `INSERT INTO ops.feedback_release_items
           (run_id, feedback_id, expected_revision, expected_status, conclusion, implementation_commit, evidence_summary)
         VALUES ($1,$2,$3,'new','solved','abc1234','测试证据')`,
        [run.rows[0].id, fb.rows[0].id, fb.rows[0].revision]
      );
      return { feedbackId: fb.rows[0].id, runId: run.rows[0].id, deploymentId: runDeploymentId };
    }

    await test('关闭反馈处理结果通知：反馈仍应用成功，收件记 skipped/preference_disabled', async function () {
      const subjFb = await subjectOf(uFbAuthor);
      const current = await prefs.read(subjFb);
      const seed = await seedFeedbackAndRun(subjFb, {
        version: current.version, articleComment: current.articleComment,
        commentReply: current.commentReply, commentMention: current.commentMention,
        feedbackImplemented: false,
      });
      const result = await release.applyRun(seed.runId, {
        operator: uAdmin, deploymentId: seed.deploymentId,
        expectedSha: runtime.sha, expectedVersion: runtime.version,
      });
      assert.strictEqual(result.applied, 1, '反馈应照常应用成功：' + JSON.stringify(result));
      const fbAfter = await pool.query('SELECT status FROM public.feedbacks WHERE id=$1', [seed.feedbackId]);
      assert.strictEqual(fbAfter.rows[0].status, 'implemented', '反馈状态必须照常置为已实施');
      const notice = await pool.query(
        `SELECT r.status, r.skip_reason AS "skipReason"
           FROM public.notifications n JOIN public.notification_recipients r ON r.notification_id = n.id
          WHERE n.feedback_id=$1`, [seed.feedbackId]
      );
      assert.strictEqual(notice.rows[0].status, 'skipped');
      assert.strictEqual(notice.rows[0].skipReason, 'preference_disabled');
      const inbox = await ns.listInbox(uFbAuthor, { category: 'feedback' }, subjFb);
      assert.ok(!inbox.items.some(function (it) { return String(it.feedback && it.feedback.id) === String(seed.feedbackId); }),
        '被设置拦下的通知不能进入收件箱');
      // 重开设置后同一批次重试不补发
      const now = await prefs.read(subjFb);
      await prefs.save(subjFb, {
        version: now.version, articleComment: now.articleComment, commentReply: now.commentReply,
        commentMention: now.commentMention, feedbackImplemented: true,
      });
      const again = await release.applyRun(seed.runId, {
        operator: uAdmin, deploymentId: seed.deploymentId,
        expectedSha: runtime.sha, expectedVersion: runtime.version,
      });
      assert.strictEqual(again.applied, 1);
      const after = await pool.query(
        `SELECT r.status FROM public.notifications n JOIN public.notification_recipients r ON r.notification_id = n.id
          WHERE n.feedback_id=$1`, [seed.feedbackId]
      );
      assert.strictEqual(after.rows[0].status, 'skipped', '重开设置不得补发已跳过的事件');
    });

    await test('默认开启时反馈完成通知仍按原行为投递', async function () {
      const subjFb = await subjectOf(uFbAuthor);
      const current = await prefs.read(subjFb);
      assert.strictEqual(current.feedbackImplemented, true);
      const seed = await seedFeedbackAndRun(subjFb, null);
      const result = await release.applyRun(seed.runId, {
        operator: uAdmin, deploymentId: seed.deploymentId,
        expectedSha: runtime.sha, expectedVersion: runtime.version,
      });
      assert.strictEqual(result.applied, 1);
      const notice = await pool.query(
        `SELECT r.status FROM public.notifications n JOIN public.notification_recipients r ON r.notification_id = n.id
          WHERE n.feedback_id=$1`, [seed.feedbackId]
      );
      assert.strictEqual(notice.rows[0].status, 'delivered');
    });

    // ===== 校验与幂等 =====
    await test('显式父评论不存在或跨文章时返回 409，不再降为一级评论', async function () {
      await assert.rejects(
        comment(articleId, uReader, '回复不存在的评论', { parentId: 99999999 }),
        function (e) { return e.status === 409; }
      );
      const otherArticle = await seedArticle(uAuthor);
      const otherComment = await comment(otherArticle, uReader, '另一篇文章的评论');
      await assert.rejects(
        comment(articleId, uReader, '跨文章回复', { parentId: otherComment.comment.id }),
        function (e) { return e.status === 409; }
      );
    });

    await test('@ 区间、文本与身份校验失败返回 400', async function () {
      const content = '@读者 你好';
      await assert.rejects(
        comment(articleId, uOther, content, { mentions: [{ subjectId: subjReader, text: '@其他', start: 0, end: 3 }] }),
        function (e) { return e.status === 400; }
      );
      await assert.rejects(
        comment(articleId, uOther, content, { mentions: [{ subjectId: subjReader, text: '@读者', start: 0, end: 99 }] }),
        function (e) { return e.status === 400; }
      );
      await assert.rejects(
        comment(articleId, uOther, content, { mentions: [{ subjectId: subjOff, text: '@读者', start: 0, end: 3 }] }),
        function (e) { return e.status === 400; }
      );
      await assert.rejects(
        comment(articleId, uOther, content, { mentions: [{ subjectId: await subjectOf(uOther), text: '@读者', start: 0, end: 3 }] }),
        function (e) { return e.status === 400; }
      );
      await assert.rejects(
        comment(articleId, uReader, '@读者 @读者', {
          mentions: [
            { subjectId: subjReader, text: '@读者', start: 0, end: 3 },
            { subjectId: subjOther, text: '@读者', start: 4, end: 7 },
          ],
        }),
        function (e) { return e.status === 400; }
      );
    });

    await test('@ 文字必须是所选账号的当前昵称（伪造主体配别人昵称被拒）', async function () {
      // 正文写的是「另一位」，却把主体指成读者（昵称「读者」）：只校验区间一致会漏掉这种情况
      await assert.rejects(
        comment(articleId, uAdmin, '@另一位 你好', {
          mentions: [{ subjectId: subjReader, text: '@另一位', start: 0, end: 4 }],
        }),
        function (e) { return e.status === 400 && /昵称/.test(e.message); }
      );
    });

    await test('同昵称两个账号：同一段文字按区间绑定各自主体，不靠文字搜索', async function () {
      const dupName = 'cmt_dup_' + suffix;
      await pool.query(
        `INSERT INTO public.users (username, password, role, status, nickname)
         VALUES ($1,'x','user','active','读者')`, [dupName]
      );
      const subjDup = await subjectOf(dupName);
      const content = '@读者 和 @读者 都看一下';
      const created = await comment(articleId, uOther, content, {
        mentions: [
          { subjectId: subjReader, text: '@读者', start: 0, end: 3 },
          { subjectId: subjDup, text: '@读者', start: 6, end: 9 },
        ],
      });
      const rows = await noticesOf(created.comment.id);
      const mentionedUsers = rows
        .filter(function (r) { return (r.payload.reasons || []).indexOf('comment_mention') >= 0; })
        .map(function (r) { return r.recipientUsername; })
        .sort();
      assert.deepStrictEqual(mentionedUsers, [uReader, dupName].sort(),
        '两个同昵称账号必须各自收到通知，不能只按文字匹配到一个人');
    });

    await test('对方改昵称后，旧文字的 @ 必须重新选择（返回 400）', async function () {
      await pool.query("UPDATE public.users SET nickname='读者甲' WHERE username=$1", [uReader]);
      try {
        await assert.rejects(
          comment(articleId, uOther, '@读者 你好', {
            mentions: [{ subjectId: subjReader, text: '@读者', start: 0, end: 3 }],
          }),
          function (e) { return e.status === 400; }
        );
      } finally {
        await pool.query("UPDATE public.users SET nickname='读者' WHERE username=$1", [uReader]);
      }
    });

    await test('删除评论会等文章行写锁：并发回复不会被漏失效', async function () {
      const art = await seedArticle(uAuthor);
      const target = await comment(art, uReader, '要被删除的评论');
      const holder = await pool.connect();
      let finished = false;
      let pending = null;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM articles WHERE id=$1 FOR UPDATE', [art]);
        pending = comments.deleteComment(target.comment.id).then(function () { finished = true; });
        await new Promise(function (r) { setTimeout(r, 300); });
        assert.strictEqual(finished, false, '持文章写锁期间删除必须排队，不能先查子树再删');
        await holder.query('ROLLBACK');
        await pending;
      } finally {
        // 断言失败时也要把持锁事务结束，否则污染连接池后续用例
        await holder.query('ROLLBACK').catch(function () {});
        holder.release();
      }
      const rows = await noticesOf(target.comment.id);
      assert.ok(rows.length === 1 && rows[0].invalidatedAt, '删除完成后通知必须失效');
    });

    await test('撤回持锁期间的新评论必须排队，撤回提交后按未发布拒绝', async function () {
      const art = await seedArticle(uAuthor);
      const holder = await pool.connect();
      let finished = false;
      let error = null;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM articles WHERE id=$1 FOR UPDATE', [art]);
        // 同一事务内把文章改草稿（模拟撤回），提交前新的评论请求必须等待
        await holder.query("UPDATE articles SET status='draft', published_at=NULL WHERE id=$1", [art]);
        comment(art, uReader, '撤回期间提交的评论')
          .then(function () { finished = true; })
          .catch(function (e) { finished = true; error = e; });
        await new Promise(function (r) { setTimeout(r, 300); });
        assert.strictEqual(finished, false, '撤回未提交时新评论不得落库');
        await holder.query('COMMIT');
        await new Promise(function (r) { setTimeout(r, 200); });
      } finally {
        // 断言失败时也要结束事务，避免持锁连接被后续用例复用
        await holder.query('ROLLBACK').catch(function () {});
        holder.release();
      }
      assert.ok(error && error.status === 404, '撤回提交后评论必须被拒（而不是留下没有失效的通知）');
      const left = await pool.query('SELECT count(*)::int AS c FROM public.article_comments WHERE article_id=$1', [art]);
      assert.strictEqual(left.rows[0].c, 0);
    });

    await test('失效后的评论通知不再回传正文与跳转目标', async function () {
      const art = await seedArticle(uAuthor);
      const created = await comment(art, uReader, '失效前的评论');
      const before = await ns.listInbox(uAuthor, { category: 'comment' }, subjAuthor);
      const hit = before.items.find(function (it) {
        return it.target && String(it.target.commentId) === String(created.comment.id);
      });
      assert.ok(hit && hit.body, '失效前应有正文');
      await comments.unpublishArticle(art);
      const after = await ns.listInbox(uAuthor, { category: 'comment' }, subjAuthor);
      const gone = after.items.find(function (it) { return String(it.id) === String(hit.id); });
      assert.ok(gone, '历史通知仍保留在列表');
      assert.strictEqual(gone.invalidated, true);
      assert.strictEqual(gone.unavailable, true);
      assert.strictEqual(gone.body, '', '失效后不得继续回传原正文（含文章标题）');
      assert.strictEqual(gone.target.kind, 'none', '失效后不提供跳转目标');
      const detail = await ns.detail(uAuthor, gone.id, subjAuthor);
      assert.strictEqual(detail.body, '');
      assert.strictEqual(detail.unavailable, true);
    });

    await test('@ 候选只返回 active 账号必要字段，并转义 LIKE 通配符', async function () {
      const list = await comments.listMentionCandidates('读者');
      assert.ok(list.length >= 1);
      assert.ok(list.every(function (u) { return u.username && u.subjectId; }));
      assert.ok(!('email' in list[0]) && !('permissions' in list[0]), '不得返回邮箱或权限字段');
      assert.ok(!list.some(function (u) { return u.username === uOff; }), '停用账号不得出现');
      const wildcard = await comments.listMentionCandidates('%');
      assert.ok(!wildcard.some(function (u) { return u.username === uReader; }), '通配符必须按字面匹配');
      await assert.rejects(comments.listMentionCandidates(''), function (e) { return e.status === 400; });
    });

    await test('同一请求标识同内容返回原评论，不同内容 409', async function () {
      const requestId = 'req-' + suffix;
      const first = await comment(articleId, uReader, '幂等测试评论', { clientRequestId: requestId });
      assert.strictEqual(first.reused, false);
      const replay = await comment(articleId, uReader, '幂等测试评论', { clientRequestId: requestId });
      assert.strictEqual(replay.reused, true);
      assert.strictEqual(replay.comment.id, first.comment.id);
      const count = await pool.query(
        'SELECT count(*)::int AS c FROM public.article_comments WHERE content=$1', ['幂等测试评论']
      );
      assert.strictEqual(count.rows[0].c, 1, '同标识重放不能产生第二条评论');
      const notices = await noticesOf(first.comment.id);
      assert.strictEqual(notices.length, 1, '重放不能再产生通知');
      await assert.rejects(
        comment(articleId, uReader, '幂等测试评论（改了内容）', { clientRequestId: requestId }),
        function (e) { return e.status === 409 && e.code === 'request_conflict'; }
      );
    });

    // 并发同编号：两个事务同时插入评论，靠唯一索引让其中一个回滚。
    // 这一条 409 的含义是「请求已被处理过」（评论已存在），前端必须靠 code 区分，
    // 不能当成「明确没提交」而丢掉编号，否则第三次提交换新编号就会再发一条。
    await test('并发同编号竞争：被挤掉的一方返回 409 且带 request_already_processed', async function () {
      const requestId = 'req-race-' + suffix;
      const attempts = await Promise.allSettled([
        comment(articleId, uReader, '并发同编号评论', { clientRequestId: requestId }),
        comment(articleId, uReader, '并发同编号评论', { clientRequestId: requestId }),
        comment(articleId, uReader, '并发同编号评论', { clientRequestId: requestId }),
      ]);
      const ok = attempts.filter(function (a) { return a.status === 'fulfilled'; });
      const failed = attempts.filter(function (a) { return a.status === 'rejected'; });
      assert.ok(ok.length >= 1, '至少要有一次成功');
      failed.forEach(function (a) {
        assert.strictEqual(a.reason.status, 409);
        assert.strictEqual(a.reason.code, 'request_already_processed',
          '「已处理」的 409 必须带 request_already_processed，前端据此保留原编号');
      });
      // 无论竞争结果如何，同标识都不能产生第二条评论
      const count = await pool.query(
        'SELECT count(*)::int AS c FROM public.article_comments WHERE content=$1', ['并发同编号评论']
      );
      assert.strictEqual(count.rows[0].c, 1, '并发同标识只能落一条评论');
    });

    // 结果不明后文章被撤回：重试必须先按编号认出「上次已提交」，不能因为文章不是 published 就 404。
    // 否则前端会把 404 当成没提交、丢掉编号，文章重新发布后再提交就多发一条。
    await test('文章撤回后同编号重放仍返回原评论，不受文章状态拦截', async function () {
      const article4 = await seedArticle(uAuthor);
      const requestId = 'req-draft-' + suffix;
      const first = await comment(article4, uReader, '撤回前的评论', { clientRequestId: requestId });
      assert.strictEqual(first.reused, false);

      await comments.unpublishArticle(article4);
      const stillDraft = await pool.query('SELECT status FROM public.articles WHERE id=$1', [article4]);
      assert.strictEqual(stillDraft.rows[0].status, 'draft', '前置条件：文章已撤回为草稿');

      const replay = await comment(article4, uReader, '撤回前的评论', { clientRequestId: requestId });
      assert.strictEqual(replay.reused, true, '同编号必须回放原评论，而不是报文章未发布');
      assert.strictEqual(replay.comment.id, first.comment.id);
      const count = await pool.query(
        'SELECT count(*)::int AS c FROM public.article_comments WHERE content=$1', ['撤回前的评论']
      );
      assert.strictEqual(count.rows[0].c, 1, '重放不能产生第二条评论');

      // 撤回后换新编号提交仍然被文章状态拦住（回放只认原编号，不放开新评论）
      await assert.rejects(
        comment(article4, uReader, '撤回后的新评论', { clientRequestId: 'req-new-' + suffix }),
        function (e) { return e.status === 404; }
      );
    });

    // 评论被删（含文章删除级联）后同编号不再卡死：清掉陈旧请求记录，按正常流程新建
    await test('评论被删除后同编号重放不再卡冲突，按新评论创建', async function () {
      const article5 = await seedArticle(uAuthor);
      const requestId = 'req-stale-' + suffix;
      const first = await comment(article5, uReader, '会被删除的评论', { clientRequestId: requestId });
      await comments.deleteComment(first.comment.id);
      const gone = await pool.query(
        'SELECT comment_id FROM public.article_comment_requests WHERE client_request_id=$1', [requestId]
      );
      assert.strictEqual(gone.rows.length, 1, '前置条件：请求记录还在');
      assert.strictEqual(gone.rows[0].comment_id, null, '前置条件：评论号已置空');

      const again = await comment(article5, uReader, '会被删除的评论', { clientRequestId: requestId });
      assert.strictEqual(again.reused, false, '原评论已不存在，应按新评论创建而不是回放空结果');
      assert.ok(again.comment && again.comment.id, '必须返回真实评论，不能是空对象');
      const count = await pool.query(
        'SELECT count(*)::int AS c FROM public.article_comments WHERE content=$1', ['会被删除的评论']
      );
      assert.strictEqual(count.rows[0].c, 1);
    });

    // ===== 失效与可见性 =====
    await test('删除评论后其通知失效，且不再计入未读', async function () {
      const created = await comment(articleId, uReader, '待删除的评论');
      const before = await ns.unreadCountSummary(uAuthor, subjAuthor);
      assert.ok(before.comment >= 1);
      await comments.deleteComment(created.comment.id);
      const rows = await noticesOf(created.comment.id);
      assert.ok(rows.length === 1 && rows[0].invalidatedAt, '通知应被标记失效');
      const after = await ns.unreadCountSummary(uAuthor, subjAuthor);
      assert.strictEqual(after.comment, before.comment - 1, '失效通知不再计入未读');
    });

    await test('文章撤回为草稿后其评论通知失效', async function () {
      const article2 = await seedArticle(uAuthor);
      const created = await comment(article2, uReader, '撤回前的评论');
      const rows = await noticesOf(created.comment.id);
      assert.ok(rows.length === 1 && !rows[0].invalidatedAt);
      await comments.unpublishArticle(article2);
      const after = await noticesOf(created.comment.id);
      assert.ok(after[0].invalidatedAt, '撤回后通知必须失效');
    });

    await test('收件箱按账号主体隔离：主体不符看不到别人的评论通知', async function () {
      const created = await comment(articleId, uReader, '主体隔离测试');
      assert.ok((await noticesOf(created.comment.id)).length >= 1);
      const wrong = await ns.listInbox(uAuthor, { category: 'comment' }, subjReader);
      assert.strictEqual(wrong.items.length, 0, '主体不符时不得看到该通知');
      const right = await ns.listInbox(uAuthor, { category: 'comment' }, subjAuthor);
      assert.ok(right.items.length >= 1, '主体一致时必须能看到');
      const noSubject = await ns.listInbox(uAuthor, { category: 'comment' }, null);
      assert.strictEqual(noSubject.items.length, 0, '拿不到主体时必须 fail-closed');
    });

    await test('评论通知的站内目标由服务端生成，正文不含评论内容', async function () {
      const created = await comment(articleId, uReader, '含隐私的评论正文内容');
      const inbox = await ns.listInbox(uAuthor, { category: 'comment' }, subjAuthor);
      const item = inbox.items.find(function (it) {
        return it.target && String(it.target.commentId) === String(created.comment.id);
      });
      assert.ok(item, '应能找到该通知');
      assert.strictEqual(item.target.kind, 'article_comment');
      assert.ok(item.target.path.indexOf('main=knowledge') >= 0);
      assert.ok(item.target.path.indexOf('article=' + articleId) >= 0);
      assert.ok(item.target.path.indexOf('comment=' + created.comment.id) >= 0);
      assert.ok(item.target.path.indexOf('notification=' + item.id) >= 0, '目标地址应带通知编号，供加载成功后回标已读');
      assert.ok(item.body.indexOf('含隐私的评论正文内容') < 0, '通知正文不得复制评论正文');
    });

    // ===== 偏好接口 =====
    await test('偏好读取默认全开且版本为 0，保存后版本递增', async function () {
      const subj = await subjectOf(uAdmin);
      const initial = await prefs.read(subj);
      assert.strictEqual(initial.version, 0);
      assert.strictEqual(initial.articleComment, true);
      assert.strictEqual(initial.feedbackImplemented, true);
      const saved = await prefs.save(subj, {
        version: 0, articleComment: true, commentReply: false, commentMention: true, feedbackImplemented: true,
      });
      assert.strictEqual(saved.version, 1);
      assert.strictEqual(saved.commentReply, false);
      const reread = await prefs.read(subj);
      assert.strictEqual(reread.commentReply, false);
    });

    await test('旧版本保存被拒（409），非法布尔值被拒（400）', async function () {
      const subj = await subjectOf(uAdmin);
      await assert.rejects(
        prefs.save(subj, { version: 0, articleComment: true, commentReply: true, commentMention: true, feedbackImplemented: true }),
        function (e) { return e.status === 409; }
      );
      await assert.rejects(
        prefs.save(subj, { version: 1, articleComment: 'yes', commentReply: true, commentMention: true, feedbackImplemented: true }),
        function (e) { return e.status === 400; }
      );
      await assert.rejects(
        prefs.save(subj, { articleComment: true, commentReply: true, commentMention: true, feedbackImplemented: true }),
        function (e) { return e.status === 400; }
      );
    });

    await test('偏好按主体存储：删除账号后同名重建不继承旧设置', async function () {
      const tempName = 'cmt_temp_' + suffix;
      await pool.query(
        `INSERT INTO public.users (username, password, role, status, nickname)
         VALUES ($1,'x','user','active','临时')`, [tempName]
      );
      const oldSubject = await subjectOf(tempName);
      await prefs.save(oldSubject, {
        version: 0, articleComment: false, commentReply: false, commentMention: false, feedbackImplemented: false,
      });
      await pool.query('DELETE FROM public.users WHERE username=$1', [tempName]);
      const left = await pool.query('SELECT count(*)::int AS c FROM public.notification_preferences WHERE subject_id=$1', [oldSubject]);
      assert.strictEqual(left.rows[0].c, 0, '删号必须清理该主体的偏好行');
      await pool.query(
        `INSERT INTO public.users (username, password, role, status, nickname)
         VALUES ($1,'x','user','active','临时')`, [tempName]
      );
      const newSubject = await subjectOf(tempName);
      assert.notStrictEqual(newSubject, oldSubject);
      const fresh = await prefs.read(newSubject);
      assert.strictEqual(fresh.version, 0);
      assert.strictEqual(fresh.articleComment, true, '同名新账号必须回到默认全开');
    });

    // ===== 前端静态契约（未做浏览器/真机验证，只锁接线） =====
    await test('前端接线：评论子栏目、提醒设置、@ 候选与深链参数', async function () {
      const root = path.join(__dirname, '..', '..');
      const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
      assert.ok(/data-nt-sub="comment"/.test(html), '通知页应有评论子栏目');
      assert.ok(/startParams\.get\('article'\)/.test(html) && /startParams\.get\('comment'\)/.test(html),
        '首页应解析评论通知深链参数');
      assert.ok(/startParams\.get\('notification'\)/.test(html)
        && /\/api\/notifications\/' \+ encodeURIComponent\(deepNotice\) \+ '\/read'/.test(html),
        '评论通知应在目标定位成功后才回标已读');
      const ntView = fs.readFileSync(path.join(root, 'public/js/notifications.js'), 'utf8');
      assert.ok(/data-nt-act="settings"/.test(ntView), '通知页应提供提醒设置入口');
      assert.ok(/data-nt-pref="/.test(ntView), '设置面板应渲染四项开关');
      assert.ok(/'comment'/.test(ntView), '通知页应支持评论分类');
      const ntPresenter = fs.readFileSync(path.join(root, 'public/js/presenters/notifications-presenter.js'), 'utf8');
      assert.ok(/\/api\/notifications\/preferences/.test(ntPresenter), '取数应走提醒设置接口');
      assert.ok(/e\.status === 409/.test(ntPresenter), '版本冲突必须重新获取而不是覆盖');
      const ksView = fs.readFileSync(path.join(root, 'public/js/knowledge.js'), 'utf8');
      assert.ok(/mention-candidates/.test(ksView), '@ 候选应走受登录接口');
      assert.ok(/data-cid="/.test(ksView), '评论节点应带可定位编号');
      assert.ok(/ksFocusComment/.test(ksView), '深链定位入口缺失');
      const ksPresenter = fs.readFileSync(path.join(root, 'public/js/presenters/knowledge-presenter.js'), 'utf8');
      assert.ok(/client_request_id/.test(ksPresenter), '评论提交必须带请求标识');
      assert.ok(/mentions/.test(ksPresenter), '评论提交必须带 @ 选择');
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
