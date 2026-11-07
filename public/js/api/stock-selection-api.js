// 股票筛选（投资策略选股中心）API 客户端（批次4 角色：api_client）。
// 职责：只负责站内请求与错误归一，不做 DOM、不做业务计算；页面脚本经此入口取数。
(function (global) {
  'use strict';

  function base(path) { return '/api/stock-selection' + path; }

  async function jsonOf(result) {
    if (!result.ok) {
      var message = (result.payload && result.payload.error) || result.error || ('请求失败（' + result.status + '）');
      var error = new Error(message);
      error.status = result.status;
      throw error;
    }
    return result.payload || {};
  }

  global.StockSelectionApi = {
    getMarkets: function () { return global.siteApi.get(base('/markets')).then(jsonOf); },
    listRuns: function (query) {
      var qs = new URLSearchParams();
      Object.keys(query || {}).forEach(function (key) {
        if (query[key] !== undefined && query[key] !== null && query[key] !== '') qs.set(key, query[key]);
      });
      return global.siteApi.get(base('/runs') + (qs.toString() ? '?' + qs.toString() : '')).then(jsonOf);
    },
    getRun: function (runId) { return global.siteApi.get(base('/runs/' + runId)).then(jsonOf); },
    getCandidates: function (runId, query) {
      var qs = new URLSearchParams();
      Object.keys(query || {}).forEach(function (key) {
        if (query[key] !== undefined && query[key] !== null && query[key] !== '') qs.set(key, query[key]);
      });
      return global.siteApi.get(base('/runs/' + runId + '/candidates') + (qs.toString() ? '?' + qs.toString() : '')).then(jsonOf);
    },
    getPortfolio: function (runId) { return global.siteApi.get(base('/runs/' + runId + '/portfolio')).then(jsonOf); },
    getStock: function (runId, code) {
      return global.siteApi.get(base('/runs/' + runId + '/stocks/' + encodeURIComponent(code))).then(jsonOf);
    },
    getSettings: function () { return global.siteApi.get(base('/settings')).then(jsonOf); },
    // 行业下拉只读库内已落库分类，不现场调用行业源（方案 27.10）。
    listIndustries: function (market) {
      return global.siteApi.get(base('/industries') + '?market=' + encodeURIComponent(market || 'CN')).then(jsonOf);
    },
    saveSettings: function (body) { return global.siteApi.put(base('/settings'), body).then(jsonOf); },
    simulate: function (body) { return global.siteApi.post(base('/simulations'), body).then(jsonOf); },
    getBacktest: function (backtestId) { return global.siteApi.get(base('/backtests/' + backtestId)).then(jsonOf); },
    listBacktests: function (query) {
      var qs = new URLSearchParams();
      Object.keys(query || {}).forEach(function (key) {
        if (query[key] !== undefined && query[key] !== null && query[key] !== '') qs.set(key, query[key]);
      });
      return global.siteApi.get(base('/backtests') + (qs.toString() ? '?' + qs.toString() : '')).then(jsonOf);
    },
    getBacktestPeriods: function (backtestId, query) {
      var qs = new URLSearchParams();
      Object.keys(query || {}).forEach(function (key) {
        if (query[key] !== undefined && query[key] !== null && query[key] !== '') qs.set(key, query[key]);
      });
      return global.siteApi.get(base('/backtests/' + backtestId + '/periods') + (qs.toString() ? '?' + qs.toString() : '')).then(jsonOf);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
