// 账户、券商和手工净值的站内接口。
(function (global) {
  'use strict';
  function request(path, options) {
    return global.siteApi.request(path, Object.assign({ timeoutMs: 0 }, options || {})).then(function (result) {
      if (result.status === 0 && result.error) throw new Error(result.error);
      return result;
    });
  }
  function jsonWrite(method, body) {
    return { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  function navPath(date, version) {
    return '/api/nav/' + date + '?version=' + (version != null ? version : '');
  }
  global.accountNavApi = {
    saveNav: function (date, version, body) { return request(navPath(date, version), jsonWrite('PUT', body)); },
    deleteNav: function (date, version, account) { return request(navPath(date, version), jsonWrite('DELETE', { account: account })); },
    brokers: function () { return request('/api/brokers?market=A'); },
    setBroker: function (name, broker) { return request('/api/accounts/broker', jsonWrite('PUT', { account_name: name, broker: broker })); },
    accountBrokers: function () { return request('/api/accounts/broker'); },
    saveSettings: function (account, version, body) {
      return request('/api/accounts/' + encodeURIComponent(account) + '/settings?version=' + (version != null ? version : ''), jsonWrite('PATCH', body));
    },
    deleteAccount: function (name) { return request('/api/accounts/' + encodeURIComponent(name), { method: 'DELETE' }); },
    renameAccount: function (name, newName) { return request('/api/accounts/' + encodeURIComponent(name) + '/rename', jsonWrite('POST', { newName: newName })); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
