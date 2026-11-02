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

  const baseFacts = {
    expectHead: head, expectVersion: '0.9.1.21',
    appliedVersions: ['001_init', '183_source_contract_verifications'],
    requiredVersions: ['001_init', '183_source_contract_verifications'],
  };
  const goodHealth = { version: '0.9.1.21', commit: head, pid: 111, startedAt: new Date().toISOString() };
  const goodWorker = {
    worker_id: 'h:1', pid: '222', app_version: '0.9.1.21', status: 'running', commit_sha: head,
    started_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
  };

  await check('四类事实一致时判 IDENTITY_OK；任一不一致必须指出原因', async () => {
    const ok = evaluateIdentity({ ...baseFacts, health: goodHealth, worker: goodWorker, expectWebPid: '111', expectWorkerPid: '222' });
    assert.strictEqual(ok.status, 'ok', ok.line);
    assert.match(ok.line, /^IDENTITY_OK/);

    const bad = evaluateIdentity({
      ...baseFacts,
      health: { version: '0.9.1.20', commit: 'b'.repeat(40), pid: 111 },
      worker: { worker_id: 'h:1', pid: '222', app_version: '0.9.1.20', status: 'stopped', commit_sha: 'c'.repeat(40), last_seen_at: new Date(Date.now() - 600000).toISOString() },
      appliedVersions: ['001_init'],
    });
    assert.strictEqual(bad.status, 'mismatch', bad.line);
    for (const reason of ['web_version_mismatch', 'web_commit_mismatch', 'worker_commit_mismatch', 'worker_not_running', 'worker_heartbeat_stale']) {
      assert.ok(bad.mismatch.includes(reason), '缺少原因 ' + reason + '：' + bad.mismatch.join(','));
    }
    assert.ok(bad.mismatch.some(item => item.startsWith('migrations_missing=')), '迁移缺失要单独指出');
  });

  // 复验 RV-03：缺 Worker 提交号以前输出 IDENTITY_OK（假通过）。现在必须是"无法核实"。
  await check('Worker 提交号为空时是「无法核实」，不能称同提交通过', async () => {
    const verdict = evaluateIdentity({ ...baseFacts, health: goodHealth, worker: { ...goodWorker, commit_sha: null }, expectWebPid: '111', expectWorkerPid: '222' });
    assert.strictEqual(verdict.status, 'unknown', verdict.line);
    assert.strictEqual(verdict.ok, false, '未核实不能算通过');
    assert.match(verdict.line, /^IDENTITY_UNKNOWN/);
    assert.ok(verdict.unknown.includes('worker_commit_unknown'));
  });

  await check('心跳缺失、/health 不可达同样按「无法核实」处理', async () => {
    const noWorker = evaluateIdentity({ ...baseFacts, health: goodHealth, worker: null });
    assert.strictEqual(noWorker.status, 'unknown');
    assert.ok(noWorker.unknown.includes('worker_heartbeat_missing'));
    const noHealth = evaluateIdentity({ ...baseFacts, health: null, worker: goodWorker });
    assert.strictEqual(noHealth.status, 'unknown');
    assert.ok(noHealth.unknown.includes('health_unreachable'));
  });

  await check('心跳与 unit 的 PID/启动时刻必须绑定：错误 PID、旧进程心跳都要判不一致', async () => {
    const wrongPid = evaluateIdentity({ ...baseFacts, health: goodHealth, worker: { ...goodWorker, pid: '999' }, expectWebPid: '111', expectWorkerPid: '222' });
    assert.strictEqual(wrongPid.status, 'mismatch');
    assert.ok(wrongPid.mismatch.includes('worker_pid_mismatch'), wrongPid.line);

    const oldProcess = evaluateIdentity({
      ...baseFacts, health: goodHealth,
      worker: { ...goodWorker, started_at: new Date(Date.now() - 3600 * 1000).toISOString() },
      expectWebPid: '111', expectWorkerPid: '222', expectWorkerStarted: new Date().toISOString(),
    });
    assert.strictEqual(oldProcess.status, 'mismatch');
    assert.ok(oldProcess.mismatch.includes('worker_process_older_than_unit'), oldProcess.line);

    const wrongWebPid = evaluateIdentity({ ...baseFacts, health: { ...goodHealth, pid: 333 }, worker: goodWorker, expectWebPid: '111', expectWorkerPid: '222' });
    assert.ok(wrongWebPid.mismatch.includes('web_pid_mismatch'), wrongWebPid.line);
  });

  // 复验 RR-01：生产 systemctl 输出 `Sun ... CST`，JS 会按美国中部时间解析（差 14 小时），
  // 正常进程被判成旧进程 → 部署失败/回滚。这里把"真实时刻等价性"和"不猜时区"都钉住。
  const { parseUnitTimestamp } = require('../scripts/deployIdentityProbe');
  const instantIso = '2026-11-01T21:41:28+08:00';
  const instantMs = Date.parse(instantIso);

  await check('同一真实时刻的不同表示必须解析成同一时刻（CST 文本不得被当成美国中部时间）', async () => {
    assert.strictEqual(parseUnitTimestamp(instantIso), instantMs, '带 +08:00 偏移的 ISO');
    assert.strictEqual(parseUnitTimestamp('2026-11-01T13:41:28Z'), instantMs, 'UTC ISO');
    assert.strictEqual(parseUnitTimestamp('Sun 2026-11-01 13:41:28 UTC'), instantMs, 'TZ=UTC 的 systemctl 文本');
    assert.strictEqual(parseUnitTimestamp(`@${Math.floor(instantMs / 1000)}`), instantMs, 'epoch 秒');
    assert.strictEqual(parseUnitTimestamp(`@${instantMs * 1000}`), instantMs, 'epoch 微秒');
    assert.strictEqual(parseUnitTimestamp(String(instantMs)), instantMs, 'epoch 毫秒');
    // CST/CET 等英文缩写不可无歧义还原：拒绝猜测（返回 NaN），绝不机械减小时数。
    assert.ok(Number.isNaN(parseUnitTimestamp('Sun 2026-11-01 21:41:28 CST')), 'CST 文本不能猜');
    assert.ok(Number.isNaN(parseUnitTimestamp('2026-11-01 21:41:28')), '无时区文本不能猜');
  });

  await check('CST 文本只记"无法核实"，不得误判成旧进程（不触发假失败）', async () => {
    const verdict = evaluateIdentity({
      ...baseFacts, health: goodHealth, worker: goodWorker, expectWebPid: '111', expectWorkerPid: '222',
      // 同一个真实时刻：CST 文本 vs 实际 ISO（若按美国中部时间解析会差 14 小时）
      expectWebStarted: 'Sun 2026-11-01 21:41:28 CST',
      expectWorkerStarted: 'Sun 2026-11-01 21:41:28 CST',
    });
    assert.strictEqual(verdict.status, 'unknown', verdict.line);
    assert.ok(verdict.unknown.includes('web_start_unparsed'), verdict.line);
    assert.ok(verdict.unknown.includes('worker_start_unparsed'), verdict.line);
    assert.ok(!verdict.mismatch.includes('web_process_older_than_unit'), '不能因为时区表示差异报旧进程');
    assert.ok(!verdict.mismatch.includes('worker_process_older_than_unit'), '不能因为时区表示差异报旧进程');
  });

  await check('UTC 文本、等价偏移与 epoch：同进程判一致，旧进程才判不一致', async () => {
    // 进程真实启动时刻固定为 13:41:28Z（= 21:41:28+08:00）。
    const healthAt = { ...goodHealth, startedAt: '2026-11-01T13:41:28Z' };
    const workerAt = { ...goodWorker, started_at: '2026-11-01T13:41:28Z' };
    const base = { ...baseFacts, health: healthAt, worker: workerAt, expectWebPid: '111', expectWorkerPid: '222' };

    const okUtc = evaluateIdentity({ ...base, expectWebStarted: 'Sun 2026-11-01 13:41:28 UTC', expectWorkerStarted: 'Sun 2026-11-01 13:41:28 UTC' });
    assert.strictEqual(okUtc.status, 'ok', okUtc.line);

    const okEpoch = evaluateIdentity({ ...base, expectWebStarted: `@${Math.floor(instantMs / 1000)}`, expectWorkerStarted: `@${Math.floor(instantMs / 1000)}` });
    assert.strictEqual(okEpoch.status, 'ok', okEpoch.line);

    const okOffset = evaluateIdentity({ ...base, expectWebStarted: instantIso, expectWorkerStarted: instantIso });
    assert.strictEqual(okOffset.status, 'ok', okOffset.line);

    // 旧进程：unit 启动比进程真实启动晚一小时 → 必须判不一致（60 秒容差盖不住 1 小时）。
    const oldProcess = evaluateIdentity({ ...base, expectWebStarted: 'Sun 2026-11-01 14:41:28 UTC', expectWorkerStarted: 'Sun 2026-11-01 14:41:28 UTC' });
    assert.strictEqual(oldProcess.status, 'mismatch', oldProcess.line);
    assert.ok(oldProcess.mismatch.includes('web_process_older_than_unit'));
    assert.ok(oldProcess.mismatch.includes('worker_process_older_than_unit'));
  });

  await check('启动时刻缺失不比较、非法值记无法核实（都不制造假不一致）', async () => {
    const missing = evaluateIdentity({ ...baseFacts, health: goodHealth, worker: goodWorker, expectWebPid: '111', expectWorkerPid: '222' });
    assert.strictEqual(missing.status, 'ok', missing.line);
    assert.ok(!missing.mismatch.some(item => /older_than_unit/.test(item)));

    const invalid = evaluateIdentity({ ...baseFacts, health: goodHealth, worker: goodWorker, expectWebPid: '111', expectWorkerPid: '222', expectWebStarted: 'not-a-timestamp', expectWorkerStarted: '' });
    assert.strictEqual(invalid.status, 'unknown', invalid.line);
    assert.ok(invalid.unknown.includes('web_start_unparsed'), invalid.line);
    assert.ok(!invalid.mismatch.includes('web_process_older_than_unit'));
  });

  console.log('D. 部署脚本接线（静态）');

  const deploy = fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'deploy_password.py'), 'utf8');
  await check('部署脚本调用身份探针并对不一致判失败', async () => {
    assert.match(deploy, /deployIdentityProbe\.js --expect-head/, '必须在同一提交下调用探针');
    assert.match(deploy, /IDENTITY_MISMATCH/, '必须识别身份不一致');
    assert.match(deploy, /--expect-worker-pid=/, '必须把当前 unit 的 MainPID 交给探针');
    assert.match(deploy, /--expect-worker-started=/, '必须把 unit 启动时刻交给探针');
    // RR-01：时间取值必须无歧义（epoch 优先，退回 TZ=UTC），不能再直传 CST 文本。
    assert.match(deploy, /ActiveEnterTimestamp --value --timestamp=unix/, '启动时刻必须取 epoch');
    assert.match(deploy, /TZ=UTC systemctl show -p ActiveEnterTimestamp/, '不支持 epoch 时必须退回 UTC 文本');
    assert.match(deploy, /IDENTITY_UNKNOWN/, '无法核实要单独识别，不能当成通过');
    assert.match(deploy, /发布身份无法核实/, '无法核实要在输出里明说');
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
