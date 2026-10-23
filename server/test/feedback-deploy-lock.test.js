// ========== 部署持锁生命周期反例（2026-10-23 三次复验 C-01～C-03） ==========
// C-01 hold-lock 实际执行报错（pool is not defined）：必须真实执行持锁入口并取得锁、写 ready、保持、释放
// C-02 持锁时间单位：--hold-ms 被拒（曾把 5400 当毫秒只持有 5.4 秒）；--hold-seconds 按秒保持，
//      须覆盖长于 5.4 秒的部署且第二发布者不能进入
// C-03 锁在回滚与反馈回写前释放：锁必须最后释放；真实进程级「发布→回滚→释放」接续；
//      持锁期间第二段携带凭证可执行（不重复抢锁），凭证不符必须拒绝
// 全部在临时隔离库执行；持锁/回写/回滚走真实 CLI 子进程。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'server', 'scripts', 'reconcileFeedbackRelease.js');

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

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 竞争探测：另一个连接此刻能否拿到同一把 advisory lock
async function lockBusy(db, lockId) {
  const c = await db.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [lockId]);
    if (rows[0].ok) { await c.query('SELECT pg_advisory_unlock($1)', [lockId]); return false; }
    return true;
  } finally { c.release(); }
}

function spawnHoldLock(dbName, readyFile, token, holdSeconds) {
  const args = [CLI, '--mode', 'hold-lock', '--ready-file', readyFile, '--token', token];
  if (holdSeconds !== undefined) args.push('--hold-seconds', String(holdSeconds));
  const child = spawn(process.execPath, args, {
    cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: dbName }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', function (d) { out += d; });
  child.stderr.on('data', function (d) { err += d; });
  const done = new Promise(function (resolve) {
    child.on('exit', function (code) { resolve({ code: code, out: out, err: err }); });
  });
  return { child: child, done: done, getOut: function () { return out; }, getErr: function () { return err; } };
}

(async () => {
  const tmpDb = 'portfolio_test_lock_' + Date.now();
  const admin = new Client(Object.assign(baseConfig(), { database: process.env.PGDATABASE || 'portfolio' }));
  try {
    await admin.connect();
  } catch (e) {
    console.log('--- 部署持锁生命周期反例 ---');
    console.log('SKIP：本地 PostgreSQL 不可用（' + e.message + '），本文件未验证。');
    process.exit(0);
  }

  let pool = null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-lock-'));
  try {
    await admin.query('CREATE DATABASE "' + tmpDb + '"');
    process.env.PGDATABASE = tmpDb;
    delete process.env.DATABASE_URL;

    await require('../db/migrations').runMigrations();
    pool = require('../db').pool;
    const store = require('../db/feedback');
    const service = require('../services/feedbackService');
    const release = require('../services/feedbackRelease');

    console.log('--- 部署持锁生命周期反例（临时库 ' + tmpDb + '）---');

    await pool.query(
      "INSERT INTO public.users (username, password, nickname, role, permissions) VALUES " +
      "('admin1','x','管理员','admin','{}'),('alice','x','Alice','user','{}')"
    );
    const runtime = realRuntime();
    const LOCK_ID = release.RELEASE_LOCK_ID;

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
      const id = await createFeedback('alice', '持锁接续用例');
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

    // ---------- C-01：hold-lock 必须能被真实执行并取得锁 ----------
    await test('C-01 hold-lock 真实执行：取得锁、写 ready、进程存活可被释放', async function () {
      const readyFile = path.join(tmpDir, 'c1.ready');
      const holder = spawnHoldLock(tmpDb, readyFile, 'token-c1', 60);
      try {
        // 等 ready 文件出现（真实执行不再报 pool is not defined）
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !fs.existsSync(readyFile)) await sleep(200);
        assert.ok(fs.existsSync(readyFile), 'ready 文件未生成：' + holder.getErr().slice(0, 300));
        const info = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
        assert.strictEqual(info.token, 'token-c1');
        assert.ok(info.pid > 0, 'ready 文件应记录持锁进程 pid');
        assert.ok(info.expiresAt > info.acquiredAt, 'ready 文件应记录到期时间');
        assert.ok(await lockBusy(pool, LOCK_ID), '持锁期间竞争者不应拿到锁');
      } finally {
        // 生产同款释放路径：release-lock（幂等）
        const rRel = spawnSync(process.execPath, [
          CLI, '--mode', 'release-lock', '--ready-file', readyFile, '--token', 'token-c1',
        ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8', timeout: 30000 });
        assert.strictEqual(rRel.status, 0, 'release-lock 应成功：' + (rRel.stderr || rRel.stdout || '').slice(0, 200));
        const r = await Promise.race([holder.done, sleep(8000).then(function () { return { code: 'timeout' }; })]);
        assert.notStrictEqual(r.code, 'timeout', '释放后持锁进程未退出');
      }
      assert.ok(!fs.existsSync(readyFile), '释放后 ready 文件应被清理');
      assert.ok(!(await lockBusy(pool, LOCK_ID)), '释放后锁应回到空闲');
    });

    await test('C-01 hold-lock 正常到期：自动解锁并清理 ready 后退出 0', async function () {
      const readyFile = path.join(tmpDir, 'c1b.ready');
      const holder = spawnHoldLock(tmpDb, readyFile, 'token-c1b', 2);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !fs.existsSync(readyFile)) await sleep(200);
      assert.ok(fs.existsSync(readyFile), 'ready 文件未生成：' + holder.getErr().slice(0, 300));
      const r = await Promise.race([holder.done, sleep(8000).then(function () { return { code: 'timeout' }; })]);
      assert.strictEqual(r.code, 0, '到期应退出 0：' + (r.err || r.out || '').slice(0, 200));
      assert.ok(!fs.existsSync(readyFile), '到期后 ready 文件应被清理');
      assert.ok(!(await lockBusy(pool, LOCK_ID)), '到期后锁应回到空闲');
    });

    // ---------- C-02：单位必须是秒，且保持期要覆盖长于 5.4 秒的流程 ----------
    await test('C-02 拒绝 --hold-ms（历史单位事故），必须用 --hold-seconds', async function () {
      const readyFile = path.join(tmpDir, 'c2a.ready');
      const r = spawnSync(process.execPath, [
        CLI, '--mode', 'hold-lock', '--hold-ms', '5400', '--ready-file', readyFile, '--token', 't-mis',
      ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8' });
      assert.strictEqual(r.status, 1, '应拒绝 --hold-ms，输出：' + (r.stderr || r.stdout || '').slice(0, 200));
      assert.ok(/hold-seconds/.test(r.stderr + r.stdout), '错误信息应指引用 --hold-seconds');
      assert.ok(!fs.existsSync(readyFile), '不应生成 ready 文件');
    });

    await test('C-02 --hold-seconds 按秒保持：6 秒后仍在持锁、第二发布者不能进入', async function () {
      const readyFile = path.join(tmpDir, 'c2b.ready');
      const holder = spawnHoldLock(tmpDb, readyFile, 'token-c2', 7);
      try {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !fs.existsSync(readyFile)) await sleep(200);
        assert.ok(fs.existsSync(readyFile), 'ready 文件未生成：' + holder.getErr().slice(0, 300));
        // 第 1 秒：持锁中
        await sleep(1000);
        assert.ok(await lockBusy(pool, LOCK_ID), '1 秒时应仍持锁');
        // 第 6 秒：已超过 5.4 秒（历史缺陷只持有 5.4 秒），必须仍在持锁
        await sleep(5000);
        assert.ok(fs.existsSync(readyFile), '6 秒后 ready 文件应仍在（旧缺陷 5.4 秒即失锁）');
        assert.ok(await lockBusy(pool, LOCK_ID), '6 秒后应仍持锁，第二发布者不能进入');
        // 到期后自动释放
        const r = await Promise.race([holder.done, sleep(8000).then(function () { return { code: 'timeout' }; })]);
        assert.notStrictEqual(r.code, 'timeout', '持有期满进程未退出');
        assert.strictEqual(r.code, 0, '正常到期应退出 0，输出：' + (r.err || r.out || '').slice(0, 200));
      } finally {
        if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill('SIGTERM');
      }
      assert.ok(!fs.existsSync(readyFile), '到期释放后 ready 文件应被清理');
      assert.ok(!(await lockBusy(pool, LOCK_ID)), '到期释放后锁应回到空闲');
    });

    await test('C-02 部署脚本持有时长按秒且覆盖部署上限，禁用 --hold-ms', async function () {
      const py = fs.readFileSync(path.join(ROOT, 'deploy', 'deploy_password.py'), 'utf8');
      assert.ok(py.indexOf('--hold-ms') < 0, '部署脚本不得再使用 --hold-ms');
      const m = py.match(/--hold-seconds (\d+)/);
      assert.ok(m, '部署脚本必须用 --hold-seconds 指定持有时长');
      const holdSeconds = Number(m[1]);
      const timeoutMatch = py.match(/timeout=(\d+)/);
      const deployTimeout = timeoutMatch ? Number(timeoutMatch[1]) : 0;
      assert.ok(holdSeconds >= deployTimeout, `持有时长 ${holdSeconds} 秒必须覆盖部署超时 ${deployTimeout} 秒`);
      assert.ok(holdSeconds > 5400 / 1000, '持有时长必须远大于 5.4 秒（历史缺陷值）');
    });

    // ---------- C-03：真实进程级「发布→回滚→释放」接续 ----------
    await test('C-03 持锁期间带凭证执行回写与回滚，最后才释放（无死锁、不重复抢锁）', async function () {
      const depId = '99999999-1111-2222-3333-444444444444';
      const ctx = await prepareVerifiedRun(depId, 'solved');
      const readyFile = path.join(tmpDir, 'c3.ready');
      const holder = spawnHoldLock(tmpDb, readyFile, 'token-c3', 120);
      try {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !fs.existsSync(readyFile)) await sleep(200);
        assert.ok(fs.existsSync(readyFile), 'ready 文件未生成：' + holder.getErr().slice(0, 300));

        // 1) 回写：携带持锁凭证，必须在限定时间内完成（否则就是重复抢锁自我死锁）
        const t0 = Date.now();
        const rApply = spawnSync(process.execPath, [
          CLI, '--mode', 'apply', '--run-id', String(ctx.runId), '--operator', 'admin1',
          '--deployment-id', depId,
          '--current-sha', runtime.sha, '--current-version', runtime.version,
          '--held-lock-token', 'token-c3', '--held-lock-ready-file', readyFile,
        ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8', timeout: 60000 });
        const applyMs = Date.now() - t0;
        assert.strictEqual(rApply.status, 0, '持锁回写应成功：' + (rApply.stderr || rApply.stdout || '').slice(0, 300));
        assert.ok(applyMs < 30000, '持锁回写不应卡死（用时 ' + applyMs + 'ms）');
        const fb1 = await store.getFeedback(pool, ctx.id);
        assert.strictEqual(fb1.status, 'implemented');

        // 2) 回滚：同一凭证接续执行
        const rBack = spawnSync(process.execPath, [
          CLI, '--mode', 'rollback', '--run-id', String(ctx.runId), '--operator', 'admin1',
          '--current-sha', runtime.sha,
          '--held-lock-token', 'token-c3', '--held-lock-ready-file', readyFile,
        ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8', timeout: 60000 });
        assert.strictEqual(rBack.status, 0, '持锁回滚应成功：' + (rBack.stderr || rBack.stdout || '').slice(0, 300));
        const fb2 = await store.getFeedback(pool, ctx.id);
        assert.strictEqual(fb2.status, 'new', '回滚后应恢复原状态');
        assert.strictEqual(fb2.implementedVersion, null);

        // 3) 全程锁未释放（第二发布者仍进不来）
        assert.ok(fs.existsSync(readyFile), '回写回滚完成后锁必须仍在（不得提前释放）');
        assert.ok(await lockBusy(pool, LOCK_ID), '回写回滚完成时第二发布者仍不能进入');

        // 4) 最后释放
        const rRel = spawnSync(process.execPath, [
          CLI, '--mode', 'release-lock', '--ready-file', readyFile, '--token', 'token-c3',
        ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8', timeout: 30000 });
        assert.strictEqual(rRel.status, 0, '释放应成功：' + (rRel.stderr || rRel.stdout || '').slice(0, 200));
      } finally {
        if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill('SIGTERM');
        await Promise.race([holder.done, sleep(8000)]);
      }
      assert.ok(!fs.existsSync(readyFile), '释放后 ready 文件应被清理');
      assert.ok(!(await lockBusy(pool, LOCK_ID)), '释放后锁应回到空闲');
    });

    await test('C-03 凭证不符必须拒绝执行（不能绕过发布锁）', async function () {
      const depId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const ctx = await prepareVerifiedRun(depId, 'solved');
      const readyFile = path.join(tmpDir, 'c3b.ready');
      const holder = spawnHoldLock(tmpDb, readyFile, 'token-good', 60);
      try {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !fs.existsSync(readyFile)) await sleep(200);
        assert.ok(fs.existsSync(readyFile), 'ready 文件未生成');

        const rBad = spawnSync(process.execPath, [
          CLI, '--mode', 'apply', '--run-id', String(ctx.runId), '--operator', 'admin1',
          '--deployment-id', depId,
          '--current-sha', runtime.sha, '--current-version', runtime.version,
          '--held-lock-token', 'token-evil', '--held-lock-ready-file', readyFile,
        ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8', timeout: 60000 });
        assert.strictEqual(rBad.status, 1, '假凭证应退出非 0');
        assert.ok(/令牌不匹配/.test(rBad.stderr + rBad.stdout), '应报令牌不匹配');
        const fb = await store.getFeedback(pool, ctx.id);
        assert.notStrictEqual(fb.status, 'implemented', '假凭证不得改状态');

        // ready 文件被删（失锁）也要拒绝
        fs.unlinkSync(readyFile);
        const rLost = spawnSync(process.execPath, [
          CLI, '--mode', 'apply', '--run-id', String(ctx.runId), '--operator', 'admin1',
          '--deployment-id', depId,
          '--current-sha', runtime.sha, '--current-version', runtime.version,
          '--held-lock-token', 'token-good', '--held-lock-ready-file', readyFile,
        ], { cwd: ROOT, env: Object.assign({}, process.env, { PGDATABASE: tmpDb }), encoding: 'utf8', timeout: 60000 });
        assert.strictEqual(rLost.status, 1, '失锁后应退出非 0');
        assert.ok(/发布锁已丢失/.test(rLost.stderr + rLost.stdout), '应报发布锁已丢失');
        const fb2 = await store.getFeedback(pool, ctx.id);
        assert.notStrictEqual(fb2.status, 'implemented', '失锁后不得改状态');
      } finally {
        if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill('SIGTERM');
        await Promise.race([holder.done, sleep(8000)]);
        if (fs.existsSync(readyFile)) { try { fs.unlinkSync(readyFile); } catch (e) { /* 忽略 */ } }
      }
    });

    await test('C-03 部署脚本：回滚期间不释放锁，反馈回写之后才统一释放', async function () {
      const py = fs.readFileSync(path.join(ROOT, 'deploy', 'deploy_password.py'), 'utf8');
      // rollback_deploy 里杀锁必须在恢复 git 之后（最后释放）
      const trapStart = py.indexOf('rollback_deploy() {');
      const trapEnd = py.indexOf('trap rollback_deploy EXIT;');
      assert.ok(trapStart >= 0 && trapEnd > trapStart, '找不到回滚 trap');
      const trap = py.slice(trapStart, trapEnd);
      const killIdx = trap.indexOf('kill $release_lock_pid');
      const resetIdx = trap.indexOf('git reset --hard');
      assert.ok(killIdx < 0 || (resetIdx >= 0 && killIdx > resetIdx), '锁必须在回滚恢复完成之后才释放');
      // 无条件提前杀锁必须不存在
      assert.ok(!/rollback_deploy\(\) \{ rc=\$\?; "\s*\n\s*"if \[ -n/.test(py), 'trap 开头不得提前杀锁');
      // Python 层：release_deploy_lock 在 finally 且位于 apply_feedback_release 之后（同函数体内语义）
      const fnStart = py.indexOf('def release_deploy_lock(');
      assert.ok(fnStart > 0, '必须有 release_deploy_lock 统一释放');
      const releaseCallIdx = py.indexOf('release_deploy_lock(client, lock_token)');
      assert.ok(releaseCallIdx > 0, '必须调用 release_deploy_lock(client, lock_token)');
      assert.ok(releaseCallIdx > py.indexOf('apply_feedback_release('), '释放必须在反馈回写之后');
      assert.ok(py.includes("finally:") && /finally:[\s\S]{0,200}release_deploy_lock\(client, lock_token\)/.test(py),
        '释放必须在 finally 兜底（允许多行注释）');
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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log('\n--- 汇总 ---');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) failures.forEach(function (f) { console.log(' - ' + f); });
  process.exit(fail ? 1 : 0);
})();
