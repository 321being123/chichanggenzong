const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert(html.indexOf('js/api/client.js') < html.indexOf('js/api/earnings-history-api.js') &&
  html.indexOf('js/api/earnings-history-api.js') < html.indexOf('shared/core-earnings.js'));
const calls = [];
let badJson = false, status = 200;
const ctx = {
  api: value => '/sub' + value,
  fetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, json: async () => {
      if (badJson) throw new Error('JSON 无效');
      return { rows: 3 };
    } };
  },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'public/js/api/client.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'public/js/api/earnings-history-api.js'), 'utf8'), ctx);

(async () => {
  const api = ctx.earningsHistoryApi;
  await api.changelog();
  await api.parseExcel('sample');
  await api.importNav(3, { account: '账户%', records: [], mode: 'merge' });
  await api.backup('账户%');
  await api.backupInfo('账户%');
  await api.restore('账户%');
  await api.clear('账户%');
  assert.deepStrictEqual(calls.map(x => x.url), [
    'changelog.json', '/sub/api/excel-history-parse', '/sub/api/nav/import?version=3',
    '/sub/api/accounts/%E8%B4%A6%E6%88%B7%25/backup-nav-history',
    '/sub/api/accounts/%E8%B4%A6%E6%88%B7%25/nav-history-backup-info',
    '/sub/api/accounts/%E8%B4%A6%E6%88%B7%25/restore-nav-history',
    '/sub/api/accounts/%E8%B4%A6%E6%88%B7%25/clear-nav-history',
  ]);
  assert(calls.every(x => !('timeoutMs' in x.options) && !('relativePath' in x.options)));
  assert.strictEqual(JSON.parse(calls[2].options.body).mode, 'merge');
  assert.strictEqual(JSON.parse(calls[6].options.body).mode, 'keep-latest');
  badJson = true;
  assert.deepStrictEqual(Object.keys((await api.importNav(3, {})).payload), [], '导入接口沿用可选 JSON');
  await assert.rejects(api.restore('账户%'), /JSON 无效/, '还原接口的 JSON 异常不得报成功');
  await assert.rejects(api.clear('账户%'), /JSON 无效/, '清空接口的 JSON 异常不得报成功');
  await api.backup('账户%');
  status = 500;
  assert.strictEqual((await api.changelog()).status, 500, '版本记录失败应保留 HTTP 状态');
  console.log('净值历史客户端：七类请求、相对路径和 JSON 失败处理通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
