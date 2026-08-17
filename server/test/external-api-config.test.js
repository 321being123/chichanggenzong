// 外部 API 主备配置：加密、掩码与通用配置结构回归测试。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../services/externalApiConfig');

const token = 'test-token-never-returned';
const encrypted = svc.encryptSecret(token);
assert.ok(encrypted.startsWith('enc:v1:'), '凭据应使用 AES-GCM 加密格式');
assert.notStrictEqual(encrypted, token, '数据库值不能保存明文');
assert.strictEqual(svc.decryptSecret(encrypted), token, '加密值应可解密');
assert.strictEqual(svc.maskSecret(token), 'test***rned', '接口展示应只返回掩码');
assert.strictEqual(svc.decryptSecret(''), '');

const adminRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const adminUi = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'admin.js'), 'utf8');
assert.ok(adminRoute.includes("/settings/external-api/:provider/switch"), '后台应提供手动切换接口');
assert.ok(adminRoute.includes("/settings/external-api/:provider/test"), '后台应提供外部 API 可用性测试接口');
assert.ok(adminRoute.includes('external_apis: externalApis'), '后台设置应返回外部 API 状态');
assert.ok(adminUi.includes('saveExternalApiSettings'), '后台应提供外部 API 参数保存入口');
assert.ok(adminUi.includes('switchExternalApiMode'), '后台应提供外部 API 手动切换入口');
assert.ok(adminUi.includes('testExternalApiAvailability'), '后台应提供外部 API 可用性测试入口');
assert.ok(adminUi.includes('renderExternalApiReturnedData'), '后台应展示外部 API 返回数据');
assert.strictEqual(typeof svc.testProviderAvailability, 'function', '服务层应提供外部 API 可用性测试');
console.log('external api config tests passed');
