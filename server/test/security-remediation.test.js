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

check('知识权限开关同步唯一能力字段并撤销旧会话', () => {
  const body = users.slice(users.indexOf('async function setKnowledgeEnabled'), users.indexOf('async function adminSetPassword'));
  assert.ok(/knowledge_write/.test(body));
  assert.ok(/auth_version\s*=\s*auth_version\s*\+\s*1/.test(body));
});

check('AI 地址换源时必须同时提交新密钥', () => {
  assert.ok(/new URL\([^\n]+\)\.origin/.test(admin));
  assert.ok(/API Key/.test(admin.slice(admin.indexOf("router.put('/models/:id'"), admin.indexOf("router.delete('/models/:id'"))));
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
  assert.ok(!/TUSHARE_REPLAY|X-API-Key/.test(ipoCommon));
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
