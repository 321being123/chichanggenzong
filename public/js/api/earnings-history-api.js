// 版本记录和净值历史的站内接口。
(function (global) {
  'use strict';
  async function request(path, options, parseMode) {
    var result = await global.siteApi.requestRaw(path, Object.assign({ timeoutMs: 0 }, options || {}));
    if (!result.response) throw new Error(result.error || '网络异常');
    var payload = {};
    if (parseMode === 'required' || (parseMode === 'success' && result.ok)) {
      payload = await result.response.json();
    } else if (parseMode === 'optional') {
      try { payload = await result.response.json(); } catch (_) { payload = {}; }
    }
    return { ok: result.ok, status: result.status, payload: payload };
  }
  function jsonWrite(body, telemetry) {
    return { method: 'POST', headers: telemetry ? global.siteApi.jsonHeaders() : { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  function accountPath(account, operation) {
    return '/api/accounts/' + encodeURIComponent(account) + '/' + operation;
  }
  global.earningsHistoryApi = {
    changelog: function () { return request('changelog.json', { relativePath: true, headers: {} }, 'success'); },
    parseExcel: function (file) { return request('/api/excel-history-parse', jsonWrite({ file: file }, true), 'optional'); },
    importNav: function (version, body) { return request('/api/nav/import?version=' + (version != null ? version : ''), jsonWrite(body, true), 'optional'); },
    backup: function (account) { return request(accountPath(account, 'backup-nav-history'), { method: 'POST', headers: {} }, 'none'); },
    backupInfo: function (account) { return request(accountPath(account, 'nav-history-backup-info'), { headers: {} }, 'required'); },
    restore: function (account) { return request(accountPath(account, 'restore-nav-history'), { method: 'POST', headers: {} }, 'required'); },
    clear: function (account) { return request(accountPath(account, 'clear-nav-history'), jsonWrite({ mode: 'keep-latest' }), 'required'); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
