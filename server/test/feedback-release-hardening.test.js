// ========== 反馈发布闭环加固反例（2026-10-23 二次复验 B-01～B-03） ==========
// B-01 版本验证可绕过：CLI 传假版本/提交号或省略部署批次号必须失败
// B-02 正常回滚无效：未修改项必须恢复；已修改项必须保留
// B-03 并发更新使用旧清单：排队期间验收失效后，拿到锁必须拒绝而不是按旧结论更新
// 全部在临时隔离库执行；CLI 反例走真实子进程。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ROOT = path.join(__dirname, '..', '..');

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

function realRuntime() {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const version = String(require(path.join(ROOT, 'package.json')).appVersion);
  return { sha: sha, version: version };
}

(async () => {
  const tmpDb = 'portfolio_test_relh_' + Date.now();
  const admin = new Client(Object.assign(baseConfig(), { database: process.env.PGDATABASE || 'portfolio' }));
  try {
    await admin.connect();
  } catch (e) {
    console.log('--- 反馈发布加固反例 ---');
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

    console.log('--- 反馈发布加固反例（临时库 ' + tmpDb + '）---');

    await pool.query(
      "INSERT INTO public.users (username, password, nickname, role, permissions) VALUES " +
      "('admin1','x','管理员','admin','{}'),('alice','x','Alice','user','{}')"
    );
    const adminActor = service.loadActor('admin1', 'admin', {});
    const aliceActor = service.loadActor('alice', 'user', {});
    const runtime = realRuntime();

    async function createFeedback(author, title) {
      const created = await service.createFeedback(service.loadActor(author, 'user', {}), {
        type: 'bug', title: title, description: '描述内容用于测试', pagePath: '/?main=home', visibility: 'public',
      }, []);
      return created.id;
    }

    async function prepareVerifiedRun(deploymentId, conclusion) {
      await pool.query('DELETE FROM public.feedbacks');
      await pool.query('DELETE FROM ops.feedback_release_items');
      await pool.query('DELETE FROM ops.feedback_release_runs');
      const id = await createFeedback('alice', '发布加固用例');
      const run = await release.prepareRun({
        deploymentId: deploymentId,
        releaseSha: runtime.sha,
        appVersion: runtime.version,
        owner: 'admin1',
      });
      await release.setItemConclusion(run.runId, id, {
        conclusion: conclusion, implementationCommit: 'abcdef1', evidenceSummary: '实测通过',
      });
      await release.freezeRun(run.runId);
      await release.verifyRun(run.runId, {
        passed: true, verifiedSha: runtime.sha, operator: 'admin1', evidence: { manual: 'checked' },
      });
      return { id: id, runId: run.runId };
    }

    // ---------- B-01：真实 CLI 传假版本必须失败 ----------
    await test('B-01 CLI 传假提交号不能把反馈标为已实施', async function () {
      const depId = '11111111-2222-3333-4444-555555555555';
      const ctx = await prepareVerifiedRun(depId, 'solved');
      const r = spawnSync(process.execPath, [
        'server/scripts/reconcileFeedbackRelease.js', '--mode', 'apply',
        '--run-id', String(ctx.runId), '--operator', 'admin1',
        '--deployment-id', depId,
        '--current-sha', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        '--current-version', '99.99.99.99',
      ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8' });
      assert.strictEqual(r.status, 1, '传假版本应退出非 0，实际输出：' + (r.stderr || r.stdout || '').slice(0, 200));
      const fb = await store.getFeedback(pool, ctx.id);
      assert.notStrictEqual(fb.status, 'implemented', '反馈不应被标为已实施');
    });

    await test('B-01 CLI 省略部署批次号必须失败', async function () {
      const depId = '22222222-3333-4444-5555-666666666666';
      const ctx = await prepareVerifiedRun(depId, 'solved');
      const r = spawnSync(process.execPath, [
        'server/scripts/reconcileFeedbackRelease.js', '--mode', 'apply',
        '--run-id', String(ctx.runId), '--operator', 'admin1',
      ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8' });
      assert.strictEqual(r.status, 1, '省略 deployment-id 应退出非 0');
      const fb = await store.getFeedback(pool, ctx.id);
      assert.notStrictEqual(fb.status, 'implemented', '反馈不应被标为已实施');
    });

    await test('B-01 CLI 参数正确时才允许回写，版本取自真实运行', async function () {
      const depId = '33333333-4444-5555-6666-777777777777';
      const ctx = await prepareVerifiedRun(depId, 'solved');
      const r = spawnSync(process.execPath, [
        'server/scripts/reconcileFeedbackRelease.js', '--mode', 'apply',
        '--run-id', String(ctx.runId), '--operator', 'admin1',
        '--deployment-id', depId,
        '--current-sha', runtime.sha,
        '--current-version', runtime.version,
      ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8' });
      assert.strictEqual(r.status, 0, '参数一致应成功，输出：' + (r.stderr || r.stdout || '').slice(0, 300));
      const fb = await store.getFeedback(pool, ctx.id);
      assert.strictEqual(fb.status, 'implemented');
      assert.strictEqual(fb.implementedVersion, runtime.version, '版本必须是真实运行版本');
    });

    // ---------- B-02：正常回滚必须生效 ----------
    await test('B-02 未被后续修改的反馈回滚后应恢复原状态', async function () {
      const depId = '44444444-5555-6666-7777-888888888888';
      const ctx = await prepareVerifiedRun(depId, 'solved');
      await release.applyRun(ctx.runId, { operator: 'admin1', deploymentId: depId });
      const before = await store.getFeedback(pool, ctx.id);
      assert.strictEqual(before.status, 'implemented');
      const result = await release.rollbackRun(ctx.runId, { operator: 'admin1' });
      assert.strictEqual(result.restored, 1, '未修改项应恢复 1 条');
      assert.strictEqual(result.kept, 0);
      const after = await store.getFeedback(pool, ctx.id);
      assert.strictEqual(after.status, 'new', '应恢复到核对前状态');
      assert.strictEqual(after.implementedVersion, null, '实施版本应清空');
      assert.strictEqual(after.implementedReleaseSha, null, '发布提交应清空');
    });

    await test('B-02 被后续修改的反馈回滚时保留现状', async function () {
      const depId = '55555555-6666-7777-8888-999999999999';
      const ctx = await prepareVerifiedRun(depId, 'solved');
      await release.applyRun(ctx.runId, { operator: 'admin1', deploymentId: depId });
      await pool.query('UPDATE public.feedbacks SET revision = revision + 3, title = $2 WHERE id=$1', [ctx.id, '核对后改名']);
      const result = await release.rollbackRun(ctx.runId, { operator: 'admin1' });
      assert.strictEqual(result.restored, 0);
      assert.strictEqual(result.kept, 1, '被修改项应保留');
      const after = await store.getFeedback(pool, ctx.id);
      assert.strictEqual(after.status, 'implemented', '被修改项状态不变');
    });

    // ---------- B-03：排队期间验收失效必须拒绝 ----------
    await test('B-03 占锁期间验收失效后，拿到锁的回写必须拒绝', async function () {
      const depId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
      const ctx = await prepareVerifiedRun(depId, 'partial');
      const lockClient = await pool.connect();
      await release.acquireReleaseLock(lockClient);
      let applyPromise = release.applyRun(ctx.runId, { operator: 'admin1', deploymentId: depId })
        .then(function () { return 'resolved'; }, function (e) { return e; });
      // 等待 applyRun 阻塞在发布锁上
      await new Promise(function (r) { setTimeout(r, 400); });
      // 排队期间：验收被作废（清单哈希不变，只让 verify 回到 pending）
      await pool.query("UPDATE ops.feedback_release_runs SET verify_status='pending' WHERE id=$1", [ctx.runId]);
      await release.releaseLock(lockClient);
      lockClient.release();
      const result = await applyPromise;
      assert.ok(result instanceof Error, '应拒绝而不是按旧结论更新');
      const fb = await store.getFeedback(pool, ctx.id);
      assert.strictEqual(fb.status, 'new', 'partial 分支不得在验收失效后把反馈改为进行中');
    });

    await test('B-03 占锁期间清单被改后，拿到锁的回写必须拒绝', async function () {
      const depId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
      const ctx = await prepareVerifiedRun(depId, 'solved');
      const lockClient = await pool.connect();
      await release.acquireReleaseLock(lockClient);
      let applyPromise = release.applyRun(ctx.runId, { operator: 'admin1', deploymentId: depId })
        .then(function () { return 'resolved'; }, function (e) { return e; });
      await new Promise(function (r) { setTimeout(r, 400); });
      await pool.query("UPDATE ops.feedback_release_items SET conclusion='unrelated' WHERE run_id=$1", [ctx.runId]);
      await release.releaseLock(lockClient);
      lockClient.release();
      const result = await applyPromise;
      assert.ok(result instanceof Error, '清单被改后应拒绝');
      const fb = await store.getFeedback(pool, ctx.id);
      assert.strictEqual(fb.status, 'new');
    });

    // ---------- B-01 补充：运行版本读取必须自带仓库目录信任（2026-10-23 端到端实录） ----------
    await test('B-01 读取运行版本的 git 调用必须显式声明 safe.directory（防 dubious ownership）', async function () {
      const svc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'feedbackRelease.js'), 'utf8');
      const cli = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'reconcileFeedbackRelease.js'), 'utf8');
      assert.ok(svc.indexOf("'safe.directory='") >= 0, 'feedbackRelease 读取 HEAD 必须声明 safe.directory');
      assert.ok(cli.indexOf("'safe.directory='") >= 0, '受控命令读取 HEAD 必须声明 safe.directory');
    });

    // ---------- 部署脚本参与同一串行边界 ----------
    await test('A-04 部署脚本在代码部署前获取同一发布锁', async function () {
      const py = fs.readFileSync(path.join(ROOT, 'deploy', 'deploy_password.py'), 'utf8');
      assert.ok(py.indexOf('--mode hold-lock') >= 0, '部署脚本必须持有发布锁');
      assert.ok(py.indexOf('无法获取发布锁，中止部署') >= 0, '拿不到锁必须中止部署');
      assert.ok(py.indexOf('release_lock_pid') >= 0, 'trap 里必须释放锁');
      const cli = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'reconcileFeedbackRelease.js'), 'utf8');
      assert.ok(cli.indexOf("mode === 'hold-lock'") >= 0, '受控命令必须提供 hold-lock');
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
