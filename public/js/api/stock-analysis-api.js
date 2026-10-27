// 股票分析站内 API 客户端（批次2c，方案 5.3 第 1 条）。
// 职责：唯一负责股票分析相关站内 HTTP 与响应解析/错误归一；不做 DOM、不做金融计算、不持页面状态。
// 页面脚本（View/Presenter）不再直接 fetch。
// 批次4 起统一走 js/api/client.js 的 siteApi 底座，避免每个页面各写一套请求与错误处理。
(function (global) {
  'use strict';

  function request(path, options) {
    return global.siteApi.request(path, options);
  }

  var stockAnalysisApi = {
    listStocks: function () {
      return request('/api/stock-analysis/stocks');
    },
    getSnapshot: function (code) {
      return request('/api/stock-analysis/' + encodeURIComponent(code));
    },
    requestRefresh: function (code) {
      return request('/api/stock-analysis/' + encodeURIComponent(code) + '/refresh', { method: 'POST' });
    },
    addWatchlist: function (code) {
      return request('/api/stock-analysis/watchlist', {
        method: 'POST',
        headers: global.siteApi.jsonHeaders(),
        body: JSON.stringify({ ts_code: code }),
      });
    },
    removeWatchlist: function (code) {
      return request('/api/stock-analysis/watchlist/' + encodeURIComponent(code), { method: 'DELETE' });
    },
  };

  global.stockAnalysisApi = stockAnalysisApi;
})(typeof window !== 'undefined' ? window : globalThis);
