// 交易账本与历史净值重算的站内接口。
(function (global) {
  'use strict';
  function request(path, options) {
    return global.siteApi.request(path, Object.assign({ timeoutMs: 0 }, options || {})).then(function (result) {
      if (result.status === 0 && result.error) throw new Error(result.error);
      return result;
    });
  }
  function jsonWrite(body) {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  function accountPath(account) { return '/api/accounts/' + encodeURIComponent(account); }
  function versionQuery(version) { return '?version=' + (version != null ? version : ''); }
  global.tradeLedgerApi = {
    addTrade: function (account, version, trade) {
      return request(accountPath(account) + '/ledger/trades' + versionQuery(version), jsonWrite({ trade: trade }));
    },
    deleteTrade: function (account, version, id) {
      return request(accountPath(account) + '/ledger/trades/' + encodeURIComponent(id) + versionQuery(version), { method: 'DELETE' });
    },
    recomputeNav: function (account, fromDate) {
      return request('/api/data/' + encodeURIComponent(account) + '/recompute-nav', jsonWrite({ fromDate: fromDate }));
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
