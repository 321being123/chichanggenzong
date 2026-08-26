const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const guard = fs.readFileSync(path.join(root, 'public', 'shared', 'autofill-guard.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const login = fs.readFileSync(path.join(root, 'public', 'login.html'), 'utf8');
const dialog = fs.readFileSync(path.join(root, 'public', 'shared', 'dialog.js'), 'utf8');
const pageFiles = ['index.html', 'login.html', 'admin.html', 'share-knowledge.html', 'ipo-report.html'];

assert.ok(guard.includes('MutationObserver'), '自动填充守门器必须覆盖动态创建的输入框');
assert.ok(guard.includes("isPasswordField(el) ? 'new-password' : 'off'"), '只有密码输入框可以使用 new-password，普通输入框必须使用 off');
assert.ok(guard.includes('data-lpignore'), '普通输入框必须标记 LastPass 忽略');
assert.ok(guard.includes('data-1p-ignore'), '普通输入框必须标记 1Password 忽略');
assert.ok(guard.includes("data-autofill-ignore"), '浏览器兼容防护必须支持显式忽略标记');
assert.ok(index.includes('src="shared/autofill-guard.js?v=5"'), '主页面必须加载最新自动填充守门器');
assert.ok(guard.includes("data-autofill-ignore') && !isPasswordField(el)) autocompleteValue = 'off"), '显式忽略标记不得把搜索框改成密码字段');
assert.ok(index.includes('id="stock-analysis-code" name="security-analysis-query" rows="1" autocomplete="off"') && index.includes('aria-multiline="false"'), '证券搜索框必须使用非账号密码文本控件');
assert.ok(login.includes('id="username"') && login.includes('autocomplete="username"'), '登录账号字段必须保留账号自动填充');
assert.ok(login.includes('id="password"') && login.includes('autocomplete="current-password"'), '登录密码字段必须保留密码自动填充');
assert.ok(login.includes('id="email-code"') && login.includes('autocomplete="one-time-code"'), '验证码字段不得被识别为账号密码');
assert.ok(dialog.includes('id="project-dialog-input" autocomplete="off"'), '动态提示输入框必须禁止密码管理器接管');
pageFiles.forEach((file) => {
  const html = fs.readFileSync(path.join(root, 'public', file), 'utf8');
  assert.ok(html.includes('shared/autofill-guard.js?v=5'), `${file} 必须加载最新自动填充守门器`);
});
const nonCredentialPasswordIds = ['admin-pwd-input', 'model-key'];
nonCredentialPasswordIds.forEach((id) => {
  assert.ok(guard.includes(`'${id}'`) === false, `${id} 不得进入账号密码自动填充白名单`);
});

console.log('autofill-guard: 普通输入框与认证字段标记检查通过');
