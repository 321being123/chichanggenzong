// ========== 反馈模块集成测试（2026-10-23） ==========
// 覆盖：迁移建表与约束、可见范围与排名口径、提交幂等、状态规则、图片压缩、发布回写幂等。
// 在临时数据库中执行（与业务库隔离）：先建库 → 跑全量迁移 → 断言 → 删库。
// 连不上本地 PostgreSQL 时明确标记跳过（不视为通过）。
const assert = require('assert');
const path = require('path');
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
  const tmpDb = 'portfolio_test_fb_' + Date.now();
  const admin = new Client(Object.assign(baseConfig(), { database: process.env.PGDATABASE || 'portfolio' }));
  try {
    await admin.connect();
  } catch (e) {
    console.log('--- 反馈模块集成测试 ---');
    console.log('SKIP：本地 PostgreSQL 不可用（' + e.message + '），本文件未验证。');
    process.exit(0);
  }

  let pool = null;
  try {
    await admin.query('CREATE DATABASE "' + tmpDb + '"');
    // 关键顺序：先切换库名，再 require 连接模块，确保连接池落在临时库
    process.env.PGDATABASE = tmpDb;
    delete process.env.DATABASE_URL;

    const migrations = require('../db/migrations');
    await migrations.runMigrations();
    pool = require('../db').pool;
    const store = require('../db/feedback');
    const service = require('../services/feedbackService');
    const release = require('../services/feedbackRelease');

    console.log('--- 反馈模块集成测试（临时库 ' + tmpDb + '）---');

    await test('迁移建立 6 张反馈表', async function () {
      const { rows } = await pool.query(
        "SELECT table_schema||'.'||table_name AS t FROM information_schema.tables WHERE table_name LIKE 'feedback%' ORDER BY 1"
      );
      const names = rows.map(function (r) { return r.t; });
      ['public.feedback_attachments', 'public.feedback_comments', 'public.feedback_events', 'public.feedbacks',
        'ops.feedback_release_items', 'ops.feedback_release_runs'].forEach(function (t) {
        assert.ok(names.indexOf(t) >= 0, '缺少表 ' + t);
      });
    });

    await pool.query("INSERT INTO public.users (username, password, nickname, role, permissions) VALUES ('admin1','x','管理员','admin','{}'),('alice','x','Alice','user','{}'),('bob','x','Bob','user','{}'),('carol','x','Carol','user','{}') ON CONFLICT (username) DO NOTHING");

    // 真实运行版本：回写门禁要求批次与当前运行一致（B-01）
    const RT = {
      sha: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: require('path').join(__dirname, '..', '..'), encoding: 'utf8',
      }).trim(),
      version: String(require('../../package.json').appVersion),
    };

    async function createFor(author, title, opts) {
      const o = opts || {};
      const row = await store.insertFeedback(pool, {
        authorUsername: author, authorNicknameSnapshot: author,
        type: o.type || 'bug', title: title, description: o.description || '测试描述内容',
        pagePath: '', submittedVersion: '0.8.4.11',
        visibility: o.visibility || 'public', clientRequestId: o.requestId || null,
        requestHash: o.requestHash || null,
      });
      return row.id;
    }

    await test('正文长度与类型受数据库约束', async function () {
      await assert.rejects(function () {
        return createFor('alice', 'x'.repeat(101));
      }, /title_len|check/i);
      await assert.rejects(function () {
        return store.insertFeedback(pool, {
          authorUsername: 'alice', authorNicknameSnapshot: 'alice', type: 'unknown',
          title: 't', description: 'd', pagePath: '', submittedVersion: '', visibility: 'public',
        });
      }, /type|check/i);
    });

    await test('已实施必须有版本与发布提交（否则约束拒绝）', async function () {
      const id = await createFor('alice', '实施约束');
      await assert.rejects(function () {
        return pool.query("UPDATE public.feedbacks SET status='implemented' WHERE id=$1", [id]);
      }, /implemented_pairing|check/i);
      await pool.query(
        "UPDATE public.feedbacks SET status='implemented', implemented_version='0.8.4.12', implemented_release_sha='abc1234' WHERE id=$1",
        [id]
      );
      const { rows } = await pool.query('SELECT status, implemented_version FROM public.feedbacks WHERE id=$1', [id]);
      assert.strictEqual(rows[0].status, 'implemented');
    });

    await test('重复标记必须关联存在且非自身的主反馈', async function () {
      const id = await createFor('alice', '重复约束');
      await assert.rejects(function () {
        return pool.query("UPDATE public.feedbacks SET status='duplicate' WHERE id=$1", [id]);
      }, /duplicate_pairing|check/i);
      await assert.rejects(function () {
        return pool.query("UPDATE public.feedbacks SET status='duplicate', duplicate_of=$1 WHERE id=$1", [id]);
      }, /self_duplicate|check/i);
    });

    await test('同一作者的提交标识唯一（服务端去重锚点）', async function () {
      const id1 = await createFor('bob', '幂等一', { requestId: 'req-1', requestHash: 'h1' });
      assert.ok(id1);
      await assert.rejects(function () {
        return createFor('bob', '幂等二', { requestId: 'req-1', requestHash: 'h1' });
      }, /uq_feedbacks_author_request|duplicate key/i);
      const found = await store.findByIdempotencyKey(pool, 'bob', 'req-1');
      assert.strictEqual(String(found.id), String(id1));
    });

    await test('公开列表排除私密、隐藏与已撤回记录', async function () {
      const openId = await createFor('carol', '公开可见');
      const privateId = await createFor('carol', '私密记录', { visibility: 'private' });
      const hiddenId = await createFor('carol', '隐藏记录');
      const withdrawnId = await createFor('carol', '撤回记录');
      await pool.query("UPDATE public.feedbacks SET moderation='hidden', moderation_reason='测试' WHERE id=$1", [hiddenId]);
      await pool.query('UPDATE public.feedbacks SET withdrawn_at=now() WHERE id=$1', [withdrawnId]);

      const data = await service.listPublic({ pageSize: 100 });
      const ids = data.items.map(function (r) { return String(r.id); });
      assert.ok(ids.indexOf(String(openId)) >= 0, '公开记录应出现');
      assert.ok(ids.indexOf(String(privateId)) < 0, '私密记录不应出现在公开列表');
      assert.ok(ids.indexOf(String(hiddenId)) < 0, '隐藏记录不应出现在公开列表');
      assert.ok(ids.indexOf(String(withdrawnId)) < 0, '撤回记录不应出现在公开列表');
    });

    await test('排名只统计公开有效反馈，同数并列且排除私密/隐藏/撤回', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      await createFor('alice', 'a1');
      await createFor('alice', 'a2');
      await createFor('bob', 'b1');
      await createFor('bob', 'b2');
      const privateOne = await createFor('carol', 'c-private', { visibility: 'private' });
      const hiddenOne = await createFor('carol', 'c-hidden');
      const withdrawnOne = await createFor('carol', 'c-withdrawn');
      await pool.query("UPDATE public.feedbacks SET moderation='hidden', moderation_reason='t' WHERE id=$1", [hiddenOne]);
      await pool.query('UPDATE public.feedbacks SET withdrawn_at=now() WHERE id=$1', [withdrawnOne]);
      assert.ok(privateOne && hiddenOne && withdrawnOne);

      const rank = await service.ranking({ username: 'alice' }, { pageSize: 10 });
      assert.strictEqual(rank.total, 2, '只有 alice / bob 有公开记录');
      assert.deepStrictEqual(rank.items.map(function (r) { return r.rank; }), [1, 1], '同数应并列 1,1');
      assert.deepStrictEqual(rank.items.map(function (r) { return r.count; }), [2, 2]);
      assert.strictEqual(rank.mine.rank, 1);
      assert.strictEqual(rank.mine.count, 2);
    });

    await test('状态规则：待补充/重复/不采纳必须填写原因', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      const id = await createFor('alice', '状态原因');
      const fb = await store.getFeedback(pool, id);
      await assert.rejects(function () {
        return service.validateStatusChange(pool, fb, { status: 'needs_info' }, {});
      }, /必须填写处理原因/);
      await assert.rejects(function () {
        return service.validateStatusChange(pool, fb, { status: 'declined' }, {});
      }, /必须填写处理原因/);
      const ok = await service.validateStatusChange(pool, fb, { status: 'needs_info' }, { reason: '缺截图' });
      assert.strictEqual(ok.fields.status, 'needs_info');
    });

    await test('状态规则：标记已实施必须绑定已验收的发布批次（不再接受自由填写）', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      const id = await createFor('alice', '实施校验');
      const fb = await store.getFeedback(pool, id);
      await assert.rejects(function () {
        return service.validateStatusChange(pool, fb, { status: 'implemented' }, { reason: 'x' });
      }, /必须指定已通过专项验收的发布批次/);
      await assert.rejects(function () {
        return service.validateStatusChange(pool, fb, { status: 'implemented' }, {
          reason: 'x', releaseRunId: '999999', implementedVersion: '0.8.4.12', implementedReleaseSha: 'abcdef1',
        });
      }, /发布批次不存在|未通过专项验收/);
    });

    await test('状态规则：重复关联拒绝自身与循环', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      const a = await createFor('alice', 'A');
      const b = await createFor('bob', 'B');
      await pool.query("UPDATE public.feedbacks SET status='duplicate', duplicate_of=$1 WHERE id=$2", [a, b]);
      const fbA = await store.getFeedback(pool, a);
      await assert.rejects(function () {
        return service.validateStatusChange(pool, fbA, { status: 'duplicate' }, { reason: 'x', duplicateOf: a });
      }, /重复自身/);
      const fbB = await store.getFeedback(pool, b);
      // A 已指向 B，B 若再指向 A 会形成循环
      await pool.query('UPDATE public.feedbacks SET status=\'new\', duplicate_of=NULL WHERE id=$1', [b]);
      const fbB2 = await store.getFeedback(pool, b);
      await assert.rejects(function () {
        return service.validateStatusChange(pool, fbB2, { status: 'duplicate' }, { reason: 'x', duplicateOf: b });
      }, /重复自身/);
      assert.ok(fbB);
    });

    await test('状态数量应用除状态外的筛选条件', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      await createFor('alice', 'bug-one', { type: 'bug' });
      await createFor('alice', 'bug-two', { type: 'bug' });
      await createFor('alice', 'feature-one', { type: 'feature' });
      const counts = await service.counts({ username: null }, { type: 'bug' }, 'public');
      assert.strictEqual(counts.byStatus.new, 2, '类型筛选后未处理应为 2');
      assert.strictEqual(counts.total, 2);
      const all = await service.counts({ username: null }, {}, 'public');
      assert.strictEqual(all.total, 3);
    });

    await test('图片压缩：统一 WebP、长边≤2048、单张≤1MiB，拒绝非位图', async function () {
      const sharp = require('sharp');
      const png = await sharp({
        create: { width: 3000, height: 1200, channels: 3, background: { r: 20, g: 40, b: 80 } },
      }).png().toBuffer();
      const out = await service.encodeImage(png);
      assert.strictEqual(out.sizeBytes <= 1024 * 1024, true, '压缩后必须 ≤1MiB');
      assert.ok(Math.max(out.width, out.height) <= 2048, '长边必须 ≤2048');
      assert.strictEqual(out.sha256.length, 64);
      const small = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
      const smallOut = await service.encodeImage(small);
      assert.strictEqual(smallOut.width, 40, '小图不放大');
      await assert.rejects(function () {
        return service.encodeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'));
      });
    });

    await test('发布回写：准备快照、验收门槛与重复应用幂等', async function () {
      await pool.query('DELETE FROM ops.feedback_release_items');
      await pool.query('DELETE FROM ops.feedback_release_runs');
      await pool.query('DELETE FROM public.feedbacks');
      const id1 = await createFor('alice', '本次已解决');
      const id2 = await createFor('bob', '本次部分解决');

      const run = await release.prepareRun({
        deploymentId: '11111111-2222-3333-4444-555555555555',
        releaseSha: RT.sha, appVersion: RT.version,
        baseDeployedSha: '0000000', owner: 'admin1',
      });
      assert.ok(run.runId);
      assert.strictEqual(run.snapshotCount, 2, '两条待处理项应进入快照');

      // 未验收前不允许回写
      await assert.rejects(function () { return release.applyRun(run.runId, { operator: 'admin1', deploymentId: '11111111-2222-3333-4444-555555555555' }); }, /未通过专项验收/);

      await release.setItemConclusion(run.runId, id1, {
        conclusion: 'solved', implementationCommit: 'abcdef1', evidenceSummary: '页面实测通过',
      });
      await release.setItemConclusion(run.runId, id2, {
        conclusion: 'partial', implementationCommit: 'abcdef1', evidenceSummary: '只修了一半',
      });
      await release.freezeRun(run.runId);
      await release.verifyRun(run.runId, { passed: true, verifiedSha: RT.sha, operator: 'admin1', evidence: { manual: 'checked' } });

      const applied = await release.applyRun(run.runId, { operator: 'admin1', deploymentId: '11111111-2222-3333-4444-555555555555' });
      assert.strictEqual(applied.applyStatus, 'applied');
      const solved = await store.getFeedback(pool, id1);
      assert.strictEqual(solved.status, 'implemented');
      assert.strictEqual(solved.implementedVersion, RT.version);
      const partial = await store.getFeedback(pool, id2);
      assert.strictEqual(partial.status, 'in_progress', '部分解决只记录进度');

      const eventsBefore = await pool.query('SELECT count(*)::int AS c FROM public.feedback_events WHERE release_run_id=$1', [run.runId]);
      const again = await release.applyRun(run.runId, { operator: 'admin1', deploymentId: '11111111-2222-3333-4444-555555555555' });
      assert.strictEqual(again.applied, 2, '重复应用应复用原结果');
      const eventsAfter = await pool.query('SELECT count(*)::int AS c FROM public.feedback_events WHERE release_run_id=$1', [run.runId]);
      assert.strictEqual(eventsAfter.rows[0].c, eventsBefore.rows[0].c, '重复应用不得新增处理事件');

      const readBack = await release.readBack(run.runId);
      assert.strictEqual(readBack.length, 2);
      assert.ok(readBack.every(function (r) { return r.eventCount === 1; }), '每项只保留一条发布事件');
    });

    await test('发布回写：核对后反馈被修改则冲突，不覆盖', async function () {
      await pool.query('DELETE FROM ops.feedback_release_items');
      await pool.query('DELETE FROM ops.feedback_release_runs');
      await pool.query('DELETE FROM public.feedbacks');
      const id = await createFor('alice', '并发冲突');
      const run = await release.prepareRun({
        deploymentId: '99999999-8888-7777-6666-555555555555',
        releaseSha: RT.sha, appVersion: RT.version, owner: 'admin1',
      });
      await release.setItemConclusion(run.runId, id, { conclusion: 'solved', evidenceSummary: 'ok' });
      await release.freezeRun(run.runId);
      await release.verifyRun(run.runId, { passed: true, verifiedSha: RT.sha, operator: 'admin1', evidence: { manual: 'checked' } });
      // 核对之后作者又改了内容
      await pool.query('UPDATE public.feedbacks SET revision = revision + 1, title = $2 WHERE id=$1', [id, '核对后改名']);
      const result = await release.applyRun(run.runId, { operator: 'admin1', deploymentId: '99999999-8888-7777-6666-555555555555' });
      assert.strictEqual(result.applyStatus, 'failed');
      assert.strictEqual(result.items[0].applyStatus, 'conflict');
      const fb = await store.getFeedback(pool, id);
      assert.notStrictEqual(fb.status, 'implemented', '冲突时不得写成已实施');
    });

    await test('发布清单被篡改后拒绝应用', async function () {
      await pool.query('DELETE FROM ops.feedback_release_items');
      await pool.query('DELETE FROM ops.feedback_release_runs');
      await pool.query('DELETE FROM public.feedbacks');
      const id = await createFor('alice', '清单冻结');
      const run = await release.prepareRun({
        deploymentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        releaseSha: RT.sha, appVersion: RT.version, owner: 'admin1',
      });
      await release.setItemConclusion(run.runId, id, { conclusion: 'solved', evidenceSummary: 'ok' });
      await release.freezeRun(run.runId);
      await release.verifyRun(run.runId, { passed: true, verifiedSha: RT.sha, operator: 'admin1', evidence: { manual: 'checked' } });
      await pool.query("UPDATE ops.feedback_release_items SET conclusion='partial' WHERE run_id=$1", [run.runId]);
      await assert.rejects(function () { return release.applyRun(run.runId, { operator: 'admin1', deploymentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }); }, /核对清单已被修改/);
    });
  } catch (e) {
    fail++;
    failures.push('执行异常：' + (e && e.message));
    console.log('  ✗ 执行异常 —— ' + (e && e.message));
  } finally {
    try { if (pool) await pool.end(); } catch (e) { /* 忽略关闭异常 */ }
    try {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [tmpDb]);
      await admin.query('DROP DATABASE IF EXISTS "' + tmpDb + '"');
    } catch (e) { console.log('清理临时库失败（需人工确认）：' + e.message); }
    await admin.end().catch(function () {});
  }

  console.log('\n--- 汇总 ---');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) failures.forEach(function (f) { console.log(' - ' + f); });
  process.exit(fail ? 1 : 0);
})();
