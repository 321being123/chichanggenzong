// Codex Security 2026-08-09 修复回归测试（不依赖数据库或外网）
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(['PASS', name]);
    console.log('  [PASS] ' + name);
  } catch (e) {
    results.push(['FAIL', name]);
    console.log('  [FAIL] ' + name + ' :: ' + e.message);
  }
}

const admin = read('server/routes/admin.js');
const app = read('server/app.js');
const auth = read('server/routes/auth.js');
const users = read('server/db/users.js');
const knowledge = read('server/routes/knowledge.js');
const excelSafe = read('server/services/excelSafe.js');
const excelWorker = read('server/services/excelParser.worker.js');
const login = read('public/login.html');
const ipoCommon = read('ipo-report/_common.py');
const ipoRoute = read('server/routes/ipo.js');
const envExample = read('deploy/.env.example');
const initScript = read('deploy/server-init.sh');
const securityMiddleware = read('server/middleware/security.js');
const aiModels = read('server/services/aiModels.js');
const aiService = read('server/services/ai.js');
const profile = read('server/routes/profile.js');
const indexHtml = read('public/index.html');
const nginxHttps = read('deploy/nginx-portfolio.conf');
const nginxHttp = read('deploy/nginx-portfolio-http.conf');
const backupUnit = read('deploy/portfolio-db-backup.service');
const backupTimer = read('deploy/portfolio-db-backup.timer');
const sshScripts = [
  'ipo-report/_common.py',
  'deploy/deploy_password.py',
  'outputs/deploy_bond_cycle.py',
  'outputs/_check_api.py',
  'outputs/_check_snap.py',
].map(read).join('\n');

check('后台能力映射先统一路径大小写', () => {
  assert.ok(/adminCapabilityForPath[\s\S]{0,250}toLowerCase\(\)/.test(admin));
});

check('仓库 SSH 脚本不含密码登录且严格校验主机密钥', () => {
  assert.ok(!/connect\([^\n]*password\s*=/.test(sshScripts));
  assert.ok(!/AutoAddPolicy/.test(sshScripts));
  assert.ok(/RejectPolicy/.test(sshScripts));
});

check('官方反向代理部署显式启用仅本机可信代理', () => {
  assert.ok(/TRUST_PROXY=loopback/.test(envExample));
  assert.ok(/TRUST_PROXY=loopback/.test(initScript));
  assert.ok(/loopback/.test(app));
});

check('知识写入和所有权守卫前统一校验登录态', () => {
  const protectedLines = knowledge.split(/\r?\n/).filter(line =>
    /router\.(post|put|delete)\(/.test(line) &&
    /(requireKsWrite|requireArticleOwner|requireCategoryOwner)/.test(line));
  assert.ok(protectedLines.length >= 12);
  protectedLines.forEach(line => assert.ok(/requireLogin,\s*(requireKsWrite|requireArticleOwner|requireCategoryOwner)/.test(line), line));
  assert.ok(/router\.get\('\/articles\/:id',\s*optionalLogin/.test(knowledge), '文章详情未校验已有会话是否仍有效');
  const detailRoute = knowledge.slice(knowledge.indexOf("router.get('/articles/:id'"), knowledge.indexOf("router.get('/share/:token'"));
  assert.ok(/req\.authUser/.test(detailRoute), '文章详情仍信任未经验证的 session.user');
});

check('知识公开入口校验已吊销会话', () => {
  assert.ok(/router\.get\('\/categories',\s*optionalLogin/.test(knowledge));
  assert.ok(/router\.get\('\/articles',\s*optionalLogin/.test(knowledge));
  assert.ok(/router\.get\('\/articles\/:id\/comments',\s*optionalLogin/.test(knowledge));
  const list = knowledge.slice(knowledge.indexOf("router.get('/articles',"), knowledge.indexOf("router.get('/articles/:id',"));
  assert.ok(/req\.authUser/.test(list));
  assert.ok(!/req\.session\.user/.test(list));
});

check('CSRF 覆盖 PATCH 等所有非安全方法', () => {
  assert.ok(/!\['GET',\s*'HEAD',\s*'OPTIONS'\]\.includes\(req\.method\)/.test(securityMiddleware));
});

check('API 路径优先于静态后缀缓存规则', () => {
  [nginxHttps, nginxHttp].forEach(function (cfg) {
    const api = cfg.indexOf('location ^~ /api/');
    const staticJs = cfg.indexOf('location ~* [.](js|css)$');
    assert.ok(api >= 0 && staticJs > api, '缺少 /api/ 优先 location');
  });
});

check('AI 模型密钥入库前加密、读取时解密', () => {
  assert.ok(/encryptSecret\(copy\.apiKey\)/.test(aiModels));
  assert.ok(/decryptSecret\(m\.apiKey\)/.test(aiModels));
});

check('知识权限开关同步唯一能力字段并撤销旧会话', () => {
  const body = users.slice(users.indexOf('async function setKnowledgeEnabled'), users.indexOf('async function adminSetPassword'));
  assert.ok(/knowledge_write/.test(body));
  assert.ok(/auth_version\s*=\s*auth_version\s*\+\s*1/.test(body));
});

check('AI 地址换源时必须同时提交新密钥', () => {
  assert.ok(/new URL\([^\n]+\)\.origin/.test(admin));
  assert.ok(/API Key/.test(admin.slice(admin.indexOf("router.put('/models/:id'"), admin.indexOf("router.delete('/models/:id'"))));
});

check('后台 AI 连通性测试复用 SSRF 地址校验', () => {
  const testRoute = admin.slice(admin.indexOf("router.post('/models/:id/test'"), admin.indexOf("// ====== 操作审计 ======"));
  assert.ok(/assertSafeUrl\(m\.apiUrl,\s*\[modelHost\]\)/.test(testRoute));
});

check('AI 跳转逐跳解析并固定公网目标', () => {
  assert.ok(/fetchSafeAi/.test(aiService));
  assert.ok(/dns\.lookup/.test(aiService));
  assert.ok(/禁止跨域跳转/.test(aiService));
  assert.ok(/redirect: 'manual'/.test(aiService));
});

check('模型产物与发布代码支持分离目录', () => {
  const runtime = read('ipo-report/model_runtime.py');
  const train = read('ipo-report/train_xgb_model.py');
  assert.ok(/IPO_MODEL_DIR/.test(runtime));
  assert.ok(/get_model_dir/.test(train));
  assert.ok(/runtime\/models\/ipo/.test(read('deploy/portfolio-server.service')));
  assert.ok(/migrate_ipo_model_artifacts/.test(read('deploy/migrate_ipo_model_artifacts.py')) || fs.existsSync(path.join(ROOT, 'deploy', 'migrate_ipo_model_artifacts.py')));
});

check('数据库备份模板强制加密并使用受保护目录', () => {
  assert.ok(/REQUIRE_ENCRYPTION=1/.test(backupUnit));
  assert.ok(/EnvironmentFile=\/etc\/portfolio\/backup\.env/.test(backupUnit));
  assert.ok(/ReadWritePaths=\/var\/backups\/portfolio/.test(backupUnit));
  assert.ok(/OnCalendar=\*-\*-\* 03:30:00/.test(backupTimer));
});

check('个人敏感资料变更要求复核并限流', () => {
  assert.ok(/currentPassword/.test(profile));
  assert.ok(/修改邮箱需要验证当前密码/.test(profile));
  assert.ok(/profile-password/.test(profile) && /max:\s*5/.test(profile));
  assert.ok(/修改邮箱需要输入当前密码/.test(indexHtml));
});

check('链接抓取使用固定到已验证公网 IP 的连接', () => {
  assert.ok(/createPinnedDispatcher|pinnedDispatcher/.test(knowledge));
  assert.ok(/enforcePublicTarget/.test(knowledge));
});

check('DOCX 使用 ZIP 预检和受限子进程解析', () => {
  assert.ok(/safeParseDocx/.test(knowledge));
  assert.ok(fs.existsSync(path.join(ROOT, 'server/services/docxSafe.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'server/services/docxParser.worker.js')));
});

check('Excel 使用中央目录预检并限制全局并发', () => {
  assert.ok(/assertSafeZip/.test(excelWorker));
  assert.ok(/MAX_ACTIVE/.test(excelSafe));
  assert.ok(!/GPBF_DATA_DESCRIPTOR[\s\S]{0,500}break/.test(excelWorker));
});

check('Tushare 统一直连官方 HTTPS POST API', () => {
  assert.ok(/https:\/\/api\.tushare\.pro/.test(ipoCommon));
  assert.ok(/method="POST"/.test(ipoCommon));
  assert.ok(/TUSHARE_TOKEN/.test(ipoCommon), 'Tushare 请求应使用主 Token 配置');
  assert.ok(/"token": token/.test(ipoCommon), 'Tushare 请求体应使用当前候选 Token');
});

check('登录回跳按 URL 语义限制为同源', () => {
  assert.ok(/new URL\([^\n]+window\.location\.origin/.test(login));
  assert.ok(/\.origin\s*!==\s*window\.location\.origin/.test(login));
});

check('分类移动只读取并重排当前用户拥有的分类', () => {
  const move = knowledge.slice(knowledge.indexOf("router.post('/categories/:id/move'"), knowledge.indexOf("router.delete('/categories/:id'"));
  assert.ok(/owner_username/.test(move));
  assert.ok(/req\.session\.user/.test(move));
});

check('登录失败不区分禁用账号', () => {
  const block = auth.slice(auth.indexOf("router.post('/login'"), auth.indexOf("router.post('/logout'"));
  assert.ok(block.indexOf('verifyPwd') < block.indexOf("user.status"));
  assert.ok(!/status\(403\)/.test(block));
});

check('公开知识和 IPO 路由不返回内部异常详情', () => {
  assert.ok(!/detail:\s*e\.message/.test(knowledge));
  assert.ok(!/detail:\s*e\.message/.test(ipoRoute));
});

const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n安全修复回归：' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) process.exit(1);
