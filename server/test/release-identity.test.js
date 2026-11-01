// 发布一致性证据（审查 S-001）：进程自述构建身份 + 部署脚本采集同一提交的交叉证据。
//
// 只验证"证据能被采集到"，不证明生产已经发布；真实发布仍按原入口执行并回执。
// 运行：node server/test/release-identity.test.js
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PGDATABASE = process.env.PGTESTDATABASE || 'portfolio_test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cases = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    cases.push(['PASS', name]);
    console.log('  [PASS] ' + name);
  }).catch(error => {
    cases.push(['FAIL', name + ' :: ' + (error && error.message)]);
    console.log('  [FAIL] ' + name + ' :: ' + (error && error.message));
  });
}

(async () => {
  console.log('A. 进程自述构建身份');

  await check('describe 只输出版本/提交/启动时刻/进程号', async () => {
    const identity = require('../services/buildIdentity');
    const described = identity.describe();
    assert.deepStrictEqual(Object.keys(described).sort(), ['commit', 'pid', 'startedAt', 'version']);
    assert.strictEqual(typeof described.version, 'string');
    assert.strictEqual(described.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(described.startedAt)), '启动时刻必须是可解析的时间');
    // 不泄露环境内容：输出里不含任何 token/密码字段名。
    assert.ok(!/token|password|secret/i.test(JSON.stringify(described)), '构建身份不得带出凭据字段');
  });

  await check('APP_COMMIT 环境变量优先于仓库 HEAD', async () => {
    const modulePath = require.resolve('../services/buildIdentity');
    const savedEnv = process.env.APP_COMMIT;
    process.env.APP_COMMIT = 'a'.repeat(40);
    delete require.cache[modulePath];
    const reloaded = require('../services/buildIdentity');
    assert.strictEqual(reloaded.commit, 'a'.repeat(40), '部署链路注入的提交号必须优先');
    delete require.cache[modulePath];
    if (savedEnv === undefined) delete process.env.APP_COMMIT; else process.env.APP_COMMIT = savedEnv;
    require('../services/buildIdentity');
  });

  await check('仓库里能读出真实提交（本机工作树）', async () => {
    const { execFileSync } = require('child_process');
    let head = '';
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }).trim();
    } catch (_) {
      head = '';
    }
    if (!head) return; // 无 git 的环境（发布包）跳过，不伪造结论
    const modulePath = require.resolve('../services/buildIdentity');
    delete require.cache[modulePath];
    const savedEnv = process.env.APP_COMMIT;
    delete process.env.APP_COMMIT;
    const reloaded = require('../services/buildIdentity');
    assert.strictEqual(reloaded.commit, head, '读到的提交必须与当前 HEAD 一致');
    if (savedEnv !== undefined) process.env.APP_COMMIT = savedEnv;
    delete require.cache[modulePath];
    require('../services/buildIdentity');
  });

  await check('/health 自述构建身份（不再只有版本号）', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(source, /buildIdentity\.describe\(\)/, '/health 必须带进程自述的构建身份');
    assert.match(source, /app\.get\('\/health'/, '健康检查入口保持原路径');
  });

  console.log('B. Worker 心跳与迁移状态（验收 S-001 补齐项）');

  await check('Worker 心跳承载完整提交号（迁移 182 + 写入链路）', async () => {
    const migrations = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations.js'), 'utf8');
    const migrationFile = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', 'releaseIdentity.js'), 'utf8');
    const repo = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'jobScheduleSlotsRepository.js'), 'utf8');
    const slots = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobScheduleSlots.js'), 'utf8');
    assert.match(migrations, /182_worker_heartbeat_commit/, '迁移必须注册进 runner');
    assert.match(migrationFile, /ADD COLUMN IF NOT EXISTS commit_sha TEXT/, '心跳表要新增 commit_sha 列');
    assert.match(repo, /INSERT INTO ops\.worker_heartbeats\([^)]*commit_sha/, '心跳写入要带 commit_sha');
    assert.match(slots, /require\('\.\/buildIdentity'\)\.commit/, '心跳内容取自启动时固定的构建身份');
  });

  await check('迁移集合按数据库实际已应用版本核对，而不是目录末文件', async () => {
    const probe = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deployIdentityProbe.js'), 'utf8');
    assert.match(probe, /SELECT version FROM schema_migrations/, '必须读 schema_migrations 实际集合');
    assert.match(probe, /MIGRATIONS\.map\(item => item\.version\)/, '必须与代码里要求的迁移列表逐项比对');
    assert.match(probe, /migrations_missing=/, '缺失迁移要作为身份不一致的原因之一');
  });

  console.log('C. 身份判定逻辑（纯函数）');

  const { evaluateIdentity } = require('../scripts/deployIdentityProbe');
  const head = 'a'.repeat(40);

  await check('四类事实一致时判 IDENTITY_OK；任一不一致必须指出原因', async () => {
    const ok = evaluateIdentity({
      expectHead: head, expectVersion: '0.9.1.21',
      health: { version: '0.9.1.21', commit: head, pid: 1 },
      worker: { worker_id: 'h:1', pid: '1', app_version: '0.9.1.21', status: 'running', commit_sha: head, last_seen_at: new Date().toISOString() },
      appliedVersions: ['001_init', '182_worker_heartbeat_commit'],
      requiredVersions: ['001_init', '182_worker_heartbeat_commit'],
    });
    assert.strictEqual(ok.ok, true, ok.line);
    assert.match(ok.line, /^IDENTITY_OK/);

    const bad = evaluateIdentity({
      expectHead: head, expectVersion: '0.9.1.21',
      health: { version: '0.9.1.20', commit: 'b'.repeat(40), pid: 1 },
      worker: { worker_id: 'h:1', pid: '1', app_version: '0.9.1.20', status: 'stopped', commit_sha: 'c'.repeat(40), last_seen_at: new Date(Date.now() - 600000).toISOString() },
      appliedVersions: ['001_init'],
      requiredVersions: ['001_init', '182_worker_heartbeat_commit'],
    });
    assert.strictEqual(bad.ok, false);
    for (const reason of ['web_version_mismatch', 'web_commit_mismatch', 'worker_commit_mismatch', 'worker_not_running', 'worker_heartbeat_stale']) {
      assert.ok(bad.reasons.includes(reason), `缺少原因 ${reason}：${bad.reasons.join(',')}`);
    }
    assert.ok(bad.reasons.some(item => item.startsWith('migrations_missing=')), '迁移缺失要单独指出');
  });

  await check('心跳还没承载提交号时记 unknown，而不是伪造一致', async () => {
    const verdict = evaluateIdentity({
      expectHead: head, expectVersion: '0.9.1.21',
      health: { version: '0.9.1.21', commit: head, pid: 1 },
      worker: { worker_id: 'h:1', pid: '1', app_version: '0.9.1.21', status: 'running', commit_sha: null, last_seen_at: new Date().toISOString() },
      appliedVersions: ['001_init', '182_worker_heartbeat_commit'],
      requiredVersions: ['001_init', '182_worker_heartbeat_commit'],
    });
    assert.strictEqual(verdict.ok, true, '空提交号只记未知，不阻断（旧进程/迁移未跑）');
    assert.ok(verdict.facts.includes('worker_commit=unknown'));
  });

  console.log('D. 部署脚本接线（静态）');

  const deploy = fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'deploy_password.py'), 'utf8');
  await check('部署脚本调用身份探针并对不一致判失败', async () => {
    assert.match(deploy, /deployIdentityProbe\.js --expect-head/, '必须在同一提交下调用探针');
    assert.match(deploy, /IDENTITY_MISMATCH/, '必须识别身份不一致');
    assert.match(deploy, /发布身份不一致，部署判为失败/, '不一致要明确失败并进入回滚');
    assert.ok(!/migrations_head=\$\(ls server\/db\/migrations/.test(deploy), '不得再用迁移目录字母序末文件冒充已应用迁移');
    assert.match(deploy, /release_identity head=%s/, '仍要打印一行发布身份证据');
    assert.match(deploy, /ActiveEnterTimestamp/, '要记录进程启动时刻');
  });

  await check('探针不可用只记录，不冒充一致也不阻断代码发布', async () => {
    assert.match(deploy, /2>&1 \|\| true/, '探针异常要留输出，不能因环境问题回滚代码');
    // 版本一致仍是硬门禁：部署脚本里保留针对 /health 的 version 精确校验。
    assert.match(deploy, /grep -Fq '\\"version\\":\\"/, '版本一致校验仍是硬门禁');
    assert.match(deploy, /health_json=/, '硬门禁读的是健康检查返回体');
  });

  const failed = cases.filter(item => item[0] === 'FAIL');
  console.log(`\n==== 发布身份结果: ${cases.length - failed.length}/${cases.length} 通过 ====`);
  if (failed.length) {
    failed.forEach(item => console.log('  - ' + item[1]));
    process.exit(1);
  }
  console.log('全部通过 ✅');
})().catch(error => {
  console.error('release-identity.test.js 失败:', (error && error.stack) || error);
  process.exit(1);
});
