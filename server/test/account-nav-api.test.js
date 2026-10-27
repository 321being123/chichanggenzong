const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert(html.indexOf('js/api/client.js') < html.indexOf('js/api/account-nav-api.js') &&
  html.indexOf('js/api/account-nav-api.js') < html.indexOf('shared/core-account.js'), '账户客户端必须在共享账户脚本之前加载');
const calls = [];
let error = false;
const result = { ok: true, status: 200, payload: {} };
const context = { window: { siteApi: { request: async (url, options) => {
  calls.push({ url, options });
  return error ? { ok: false, status: 0, payload: {}, error: '网络故障' } : result;
} } } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/api/account-nav-api.js'), 'utf8'), context);
const api = context.window.accountNavApi;

(async () => {
  await api.saveNav('2026-10-28', 3, { account: '账户%', nav: 1 });
  await api.deleteNav('2026-10-28', 3, '账户%');
  await api.brokers();
  await api.setBroker('账户%', 'test');
  await api.accountBrokers();
  await api.deleteAccount('账户%');
  await api.renameAccount('账户%', '新账户');
  await api.saveSettings('账户%', 3, { cashType: '现金' });
  assert.deepStrictEqual(calls.map(x => x.url), [
    '/api/nav/2026-10-28?version=3', '/api/nav/2026-10-28?version=3',
    '/api/brokers?market=A', '/api/accounts/broker', '/api/accounts/broker',
    '/api/accounts/%E8%B4%A6%E6%88%B7%25', '/api/accounts/%E8%B4%A6%E6%88%B7%25/rename',
    '/api/accounts/%E8%B4%A6%E6%88%B7%25/settings?version=3',
  ]);
  assert.deepStrictEqual(calls.map(x => x.options.method || 'GET'), ['PUT', 'DELETE', 'GET', 'PUT', 'GET', 'DELETE', 'POST', 'PATCH']);
  assert(calls.every(x => x.options.timeoutMs === 0));
  assert.strictEqual(JSON.parse(calls[0].options.body).account, '账户%');
  assert.strictEqual(JSON.parse(calls[6].options.body).newName, '新账户');
  assert.strictEqual(JSON.parse(calls[7].options.body).cashType, '现金');
  error = true;
  await assert.rejects(api.deleteAccount('账户%'), /网络故障/);

  const src = fs.readFileSync(path.join(root, 'public/shared/core-account.js'), 'utf8');
  const section = src.slice(src.indexOf('async function saveNavEdit()'), src.indexOf('async function deleteNav('));
  const fields = { 'nav-edit-date': '2026-10-28', 'nav-edit-nav': '1', 'nav-edit-total': '100', 'nav-edit-invested': '90' };
  const messages = [], refreshed = [];
  let conflict = true;
  const ui = { navEditIndex: -1, data: {}, dataVersion: 3, currentAccount: '账户%',
    normalizeDate: x => x, document: { getElementById: id => ({ value: fields[id] }) },
    showToast: text => messages.push(text), refreshDataFromServer: data => refreshed.push(data),
    renderEarnings() {}, closeModal() {}, window: { accountNavApi: { saveNav: async () =>
      conflict ? { ok: false, status: 409, payload: { error: '版本冲突' } } : { ok: true, status: 200, payload: { data: { version: 4 } } } } } };
  vm.runInNewContext(section, ui);
  await ui.saveNavEdit();
  assert.strictEqual(messages.at(-1), '版本冲突');
  assert.strictEqual(refreshed.length, 0, '冲突不得写入旧数据');
  conflict = false;
  await ui.saveNavEdit();
  assert.strictEqual(refreshed.length, 1, '成功时应使用服务器返回的数据');
  console.log('账户净值客户端：7 类请求、编码、版本冲突及失败通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
