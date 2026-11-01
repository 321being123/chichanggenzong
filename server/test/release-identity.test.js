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

  console.log('B. 部署脚本留证（静态）');

  const deploy = fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'deploy_password.py'), 'utf8');
  await check('部署后打印同一提交的交叉证据', async () => {
    assert.match(deploy, /release_identity head=%s/, '必须打印一行发布身份证据');
    assert.match(deploy, /web_pid=\$\(systemctl show -p MainPID --value portfolio-server\.service\)/, 'Web 必须取当前 MainPID');
    assert.match(deploy, /worker_pid=\$\(systemctl show -p MainPID --value portfolio-worker\.service\)/, 'Worker 必须取当前 MainPID');
    assert.match(deploy, /ActiveEnterTimestamp/, '要记录进程启动时刻，才能证明加载的是本次代码');
    assert.match(deploy, /health_commit=/, '要采集 /health 自述的提交');
    assert.match(deploy, /migrations_head=/, '要记录本次提交携带的迁移尾部');
  });

  await check('发布身份采集不得让部署失败或被当成验收通过', async () => {
    // 采集本身不进入 && 失败链（缺项不该回滚代码），但也不得替代版本校验。
    assert.match(deploy, /printf '%s' \\"\$health_json\\" \| grep -Fq '\\"version\\":\\"" \+ local_version/,
      '版本一致校验仍是硬门禁');
    assert.ok(!/test -n \\"\$health_commit\\"/.test(deploy), '不得把缺提交号变成部署失败（.git 不可读不能当回滚理由）');
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
