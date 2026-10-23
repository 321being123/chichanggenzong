// ========== 反馈模块验收缺口反例（2026-10-23，A-01～A-07） ==========
// 目的：把独立验收发现的 7 项缺口固化为反例，修复后必须真红再真绿。
// 与 feedback-module.test.js 一样在临时隔离库中执行（满足 connection.js 的测试库命名守卫）。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
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
  const tmpDb = 'portfolio_test_gap_' + Date.now();
  const admin = new Client(Object.assign(baseConfig(), { database: process.env.PGDATABASE || 'portfolio' }));
  try {
    await admin.connect();
  } catch (e) {
    console.log('--- 反馈缺口反例测试 ---');
    console.log('SKIP：本地 PostgreSQL 不可用（' + e.message + '），本文件未验证。');
    process.exit(0);
  }

  let pool = null;
  try {
    await admin.query('CREATE DATABASE "' + tmpDb + '"');
    process.env.PGDATABASE = tmpDb;
    delete process.env.DATABASE_URL;

    await require('../db/migrations').runMigrations();
    pool = require('../db').pool;
    const store = require('../db/feedback');
    const service = require('../services/feedbackService');
    const release = require('../services/feedbackRelease');

    console.log('--- 反馈缺口反例测试（临时库 ' + tmpDb + '）---');

    await pool.query(
      "INSERT INTO public.users (username, password, nickname, role, permissions) VALUES " +
      "('admin1','x','管理员','admin','{}')," +
      "('alice','x','Alice','user','{}')," +
      "('bob','x','Bob','user','{}')," +
      "('carol','x','Carol','user','{}')"
    );
    const adminActor = service.loadActor('admin1', 'admin', {});
    const aliceActor = service.loadActor('alice', 'user', {});

    async function createFeedback(author, title, extra) {
      const created = await service.createFeedback(service.loadActor(author, 'user', {}), Object.assign({
        type: 'bug', title: title, description: '描述内容用于测试', pagePath: '/?main=home', visibility: 'public',
      }, extra || {}), []);
      return created.id;
    }

    // ---------- A-01：带筛选的列表必须能查 ----------
    await test('A-01 公开列表按类型筛选可查', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      await createFeedback('alice', '类型筛选一', { type: 'bug' });
      await createFeedback('bob', '类型筛选二', { type: 'feature' });
      const data = await service.listPublic({ type: 'bug', pageSize: 50 });
      assert.strictEqual(data.total, 1, '类型筛选后应只剩 1 条');
      assert.strictEqual(data.items[0].title, '类型筛选一');
    });

    await test('A-01 我的反馈（mine 范围）可查', async function () {
      await createFeedback('alice', '我的反馈一');
      const data = await service.listMine(aliceActor, { pageSize: 50 });
      assert.ok(data.total >= 1, '本人列表应能查出记录');
    });

    await test('A-01 后台按状态与关键词组合筛选可查', async function () {
      const data = await service.adminList(adminActor, { status: 'new', q: '筛选', pageSize: 50 });
      assert.ok(data.total >= 1, '后台组合筛选应能查出记录');
    });

    // ---------- A-07：提交版本由服务端写入 ----------
    await test('A-07 客户端传的版本被忽略，使用运行版本', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      const id = await createFeedback('alice', '版本来源', { submittedVersion: '9.9.9-伪造' });
      const { rows } = await pool.query('SELECT submitted_version FROM public.feedbacks WHERE id=$1', [id]);
      assert.strictEqual(rows[0].submitted_version, require('../../package.json').appVersion,
        '应写入运行版本而非客户端传值');
    });

    // ---------- A-03：响应字段白名单 ----------
    await test('A-03 公开列表不输出登录名、内部证据与私密关联编号', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      await pool.query('DELETE FROM ops.feedback_release_items');
      await pool.query('DELETE FROM ops.feedback_release_runs');
      // 造一条已实施且有内部证据的反馈
      const createdId = await createFeedback('alice', '内部证据条目');
      await pool.query(
        "UPDATE public.feedbacks SET status='implemented', implemented_version='0.0.1', implemented_release_sha='deadbeef' WHERE id=$1",
        [createdId]
      );
      await pool.query(
        `INSERT INTO public.feedback_events (feedback_id, actor_username, actor_source, event_type, summary, note)
         VALUES ($1,'admin1','release','release_implemented','随版本发布','内部验收备注-不得外泄')`,
        [createdId]
      );
      const data = await service.listPublic({ pageSize: 50 });
      const raw = JSON.stringify(data);
      assert.ok(raw.indexOf('alice') < 0, '公开列表不得出现登录名');
      assert.ok(raw.indexOf('deadbeef') < 0, '公开列表不得出现发布提交 SHA');
      assert.ok(raw.indexOf('内部验收备注') < 0, '公开列表不得出现内部验收备注');
      assert.ok(raw.indexOf('authorUsername') < 0, '公开列表不得出现 authorUsername 字段');
    });

    await test('A-03 游客详情不泄露私密关联目标编号', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      const targetId = await createFeedback('alice', '私密主反馈', { visibility: 'private' });
      const dupId = await createFeedback('bob', '重复副反馈');
      await pool.query("UPDATE public.feedbacks SET status='duplicate', duplicate_of=$1 WHERE id=$2", [targetId, dupId]);
      const guest = await service.detail(dupId, { username: null, canModerate: false });
      const raw = JSON.stringify(guest);
      assert.strictEqual(guest.duplicateOf.id, null, '私密目标编号应被隐藏');
      assert.ok(raw.indexOf(String(targetId)) < 0 || guest.feedback.duplicateOf === undefined,
        '公开详情不得出现私密目标编号');
      assert.ok(!('duplicateOf' in guest.feedback), '公开详情的主记录不应再带 duplicateOf 原始字段');
      assert.ok(raw.indexOf('authorUsername') < 0, '公开详情不得出现登录名');
    });

    await test('A-03 回复响应不输出登录名，删除权限由服务端给出', async function () {
      const id = await createFeedback('alice', '回复投影');
      await service.addComment(id, aliceActor, '这是本人回复', 'c-1');
      const guest = await service.detail(id, { username: null, canModerate: false });
      const raw = JSON.stringify(guest.comments);
      assert.ok(raw.indexOf('authorUsername') < 0, '回复不得带 authorUsername');
      assert.strictEqual(guest.comments[0].canDelete, false, '游客不能删他人回复');
      const mine = await service.detail(id, aliceActor);
      assert.strictEqual(mine.comments[0].canDelete, true, '本人可删自己的回复');
    });

    // ---------- A-02：真实发布/专项验收门禁 ----------
    await test('A-02 未指定发布批次不能标记已实施', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      const id = await createFeedback('alice', '无批次关闭');
      const fb = await store.getFeedback(pool, id);
      await assert.rejects(function () {
        return service.validateStatusChange(pool, fb, { status: 'implemented' }, { reason: 'x' });
      }, /必须指定已通过专项验收的发布批次/);
    });

    await test('A-02 空验收证据不允许通过', async function () {
      await pool.query('DELETE FROM ops.feedback_release_items');
      await pool.query('DELETE FROM ops.feedback_release_runs');
      const run = await release.prepareRun({
        deploymentId: '11111111-2222-3333-4444-555555555555',
        releaseSha: 'abcdef1234567', appVersion: '0.8.4.13', owner: 'admin1',
      });
      await assert.rejects(function () {
        return release.verifyRun(run.runId, { passed: true, verifiedSha: 'abcdef1234567', operator: 'admin1', evidence: {} });
      }, /验收证据/);
    });

    await test('A-02 伪造运行身份不能准备/验收/回写', async function () {
      await assert.rejects(function () {
        return release.prepareRun({
          deploymentId: '22222222-3333-4444-5555-666666666666',
          releaseSha: 'abcdef1234567', appVersion: '0.8.4.13', owner: '不存在的人',
        });
      }, /运行身份不存在/);
      await assert.rejects(function () {
        return release.verifyRun('1', { passed: true, verifiedSha: 'x', operator: 'bob', evidence: { a: '1' } });
      }, /缺少 content_manage 能力/);
      await assert.rejects(function () {
        return release.applyRun('1', { operator: 'bob' });
      }, /缺少 content_manage 能力/);
    });

    await test('A-02 未通过验收、清单不含该反馈时不能关闭', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      const id = await createFeedback('alice', '批次外反馈');
      const fb = await store.getFeedback(pool, id);
      await assert.rejects(function () {
        return service.validateStatusChange(pool, fb, { status: 'implemented' }, {
          reason: 'x', releaseRunId: '1',
        });
      }, /未通过专项验收|清单不包含|未把这条反馈核对为完整解决/);
    });

    await test('A-02 明细改动后已通过的验收自动作废', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      await pool.query('DELETE FROM ops.feedback_release_items');
      await pool.query('DELETE FROM ops.feedback_release_runs');
      const id = await createFeedback('alice', '验收作废');
      const run = await release.prepareRun({
        deploymentId: '33333333-4444-5555-6666-777777777777',
        releaseSha: 'fedcba9876543', appVersion: '0.8.4.14', owner: 'admin1',
      });
      await release.setItemConclusion(run.runId, id, {
        conclusion: 'solved', implementationCommit: 'fedcba9', evidenceSummary: '实测通过',
      });
      await release.freezeRun(run.runId);
      await release.verifyRun(run.runId, {
        passed: true, verifiedSha: 'fedcba9876543', operator: 'admin1', evidence: { manual: 'checked' },
      });
      const after = await release.setItemConclusion(run.runId, id, {
        conclusion: 'partial', implementationCommit: 'fedcba9', evidenceSummary: '只修一半',
      });
      assert.strictEqual(after.verificationInvalidated, true, '改动明细应使验收失效');
      const runRow = await pool.query('SELECT verify_status FROM ops.feedback_release_runs WHERE id=$1', [run.runId]);
      assert.strictEqual(runRow.rows[0].verify_status, 'pending', '验收状态应回到 pending');
      await assert.rejects(function () {
        return release.applyRun(run.runId, { operator: 'admin1' });
      }, /未通过专项验收/);
    });

    // ---------- A-04：批次与运行版本绑定、回滚恢复 ----------
    await test('A-04 部署批次/当前版本不一致拒绝回写', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      await pool.query('DELETE FROM ops.feedback_release_items');
      await pool.query('DELETE FROM ops.feedback_release_runs');
      const id = await createFeedback('alice', '批次绑定');
      const run = await release.prepareRun({
        deploymentId: '44444444-5555-6666-7777-888888888888',
        releaseSha: 'aaaabbbbcccc1', appVersion: '0.8.4.15', owner: 'admin1',
      });
      await release.setItemConclusion(run.runId, id, {
        conclusion: 'solved', implementationCommit: 'aaaabbb', evidenceSummary: 'ok',
      });
      await release.freezeRun(run.runId);
      await release.verifyRun(run.runId, {
        passed: true, verifiedSha: 'aaaabbbbcccc1', operator: 'admin1', evidence: { manual: 'checked' },
      });
      await assert.rejects(function () {
        return release.applyRun(run.runId, {
          operator: 'admin1', deploymentId: '99999999-9999-9999-9999-999999999999',
        });
      }, /deployment_id 不一致/);
      await assert.rejects(function () {
        return release.applyRun(run.runId, { operator: 'admin1', currentSha: '0000000000000' });
      }, /当前运行提交与发布批次不一致/);
      const applied = await release.applyRun(run.runId, {
        operator: 'admin1', deploymentId: '44444444-5555-6666-7777-888888888888',
        currentSha: 'aaaabbbbcccc1', currentVersion: '0.8.4.15',
      });
      assert.strictEqual(applied.applyStatus, 'applied', '参数一致时应正常回写');
    });

    await test('A-04 回滚只恢复本批次关闭且未被后续修改的记录', async function () {
      const runId = (await pool.query("SELECT id::text AS id FROM ops.feedback_release_runs WHERE app_version='0.8.4.15'")).rows[0].id;
      const { rows } = await pool.query(
        "SELECT feedback_id::text AS id FROM ops.feedback_release_items WHERE run_id=$1 AND conclusion='solved'", [runId]
      );
      const closedId = rows[0].id;
      // 造一条“被后续修改”的：revision 与回写后不一致
      await pool.query('UPDATE public.feedbacks SET revision = revision + 5 WHERE id=$1', [closedId]);
      const result = await release.rollbackRun(runId, { operator: 'admin1', currentSha: 'aaaabbbbcccc1' });
      assert.strictEqual(result.kept, 1, '被后续修改的记录不应被回滚');
      assert.strictEqual(result.restored, 0);
      const fb = await store.getFeedback(pool, closedId);
      assert.strictEqual(fb.status, 'implemented', '被修改过的记录状态保持不变');
    });

    // ---------- A-05：备份/恢复脚本的缺图反例逻辑 ----------
    await test('A-05 恢复脚本在引用非零且无归档时必须失败', async function () {
      const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'restore_backup_drill.sh'), 'utf8');
      assert.ok(sh.indexOf('$att_rows" -gt 0') >= 0 && sh.indexOf('[ -z "$attachments" ]') >= 0,
        '恢复脚本必须显式拒绝“有引用却无归档”');
      assert.ok(/备份不完整/.test(sh), '必须报错而不是跳过检查');
    });

    await test('A-05 备份脚本缺图目录时不伪造“已备份附件”', async function () {
      const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'backup_db.sh'), 'utf8');
      assert.ok(/attachments=none/.test(sh), '无附件时清单必须写 none');
      assert.ok(/manifest\.sha256/.test(sh), '整组必须生成清单');
    });

    // ---------- A-06：截图增删服务端能力 ----------
    await test('A-06 作者在可编辑阶段可追加与移除截图', async function () {
      await pool.query('DELETE FROM public.feedbacks');
      const sharp = require('sharp');
      const png = await sharp({ create: { width: 200, height: 120, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
      const createdId = await createFeedback('alice', '截图增删');
      const fb0 = await store.getFeedback(pool, createdId);
      const added = await service.addAttachments(createdId, aliceActor, [{ buffer: png }], fb0.revision, 'att-1');
      assert.strictEqual(added.attachmentIds.length, 1, '应追加 1 张');
      const fb1 = await store.getFeedback(pool, createdId);
      const list1 = await store.listAttachments(pool, createdId, false);
      assert.strictEqual(list1.length, 1);
      await service.deleteAttachment(createdId, list1[0].id, aliceActor, fb1.revision);
      const list2 = await store.listAttachments(pool, createdId, false);
      assert.strictEqual(list2.length, 0, '移除后活动截图应为 0');
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
