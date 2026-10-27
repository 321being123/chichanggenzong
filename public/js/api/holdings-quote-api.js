// 持仓行情与持仓录入的站内接口，复用统一响应和错误处理。
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
  global.holdingsQuoteApi = {
    quote: function (code) { return request('/api/quote/' + encodeURIComponent(code)); },
    hkRate: function (realtime) { return request('/api/hkrate' + (realtime ? '?realtime=1' : '')); },
    quotes: function (codes) { return request('/api/quotes?codes=' + encodeURIComponent(codes.join(','))); },
    savePrices: function (account, version, prices) {
      return request('/api/positions/prices?version=' + (version != null ? version : ''), jsonWrite('PATCH', { account: account, prices: prices }));
    },
    saveDailyPrices: function (account, date, prices) {
      return request('/api/daily-prices/' + encodeURIComponent(account), jsonWrite('POST', { prices: prices, date: date }));
    },
    addPosition: function (account, version, event) {
      return request('/api/accounts/' + encodeURIComponent(account) + '/ledger/position-events?version=' + (version != null ? version : ''), jsonWrite('POST', { event: event }));
    },
    addPositions: function (account, version, events) {
      return request('/api/accounts/' + encodeURIComponent(account) + '/ledger/position-events/batch?version=' + (version != null ? version : ''), jsonWrite('POST', { events: events }));
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
