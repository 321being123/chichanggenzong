// 站内 HTTP 客户端（批次4，方案 5.3：View 不直接取数）。
// 职责：唯一负责站内请求的发送、JSON 解析与错误归一；不做 DOM、不做业务计算。
// 约定：所有页面脚本经此入口取数，便于统一加遥测头、超时与重试口径。
// 说明：本文件是渐进收口的公共底座，页面脚本按批次逐个迁移，未迁移者登记在
// governance/architecture-boundaries.json 的 frontendApiClients.pending 中。
(function (global) {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 30000;

  function endpoint(path) {
    return typeof api === 'function' ? api(path) : path;
  }

  function withTelemetry(headers) {
    var merged = Object.assign({}, headers || {});
    if (global.SiteTelemetry && typeof global.SiteTelemetry.getHeaders === 'function') {
      return global.SiteTelemetry.getHeaders(merged);
    }
    return merged;
  }

  function jsonHeaders(extra) {
    return withTelemetry(Object.assign({ 'Content-Type': 'application/json' }, extra || {}));
  }

  /**
   * 统一请求：返回 { ok, status, payload }，永不因 JSON 解析失败抛出。
   * options.timeoutMs 为 0 时禁用超时（长任务可用）。
   */
  async function request(path, options) {
    var opts = Object.assign({}, options || {});
    var timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
    delete opts.timeoutMs;
    if (!opts.headers) opts.headers = withTelemetry();
    var controller = null;
    var timer = null;
    if (timeoutMs > 0 && typeof AbortController === 'function') {
      controller = new AbortController();
      opts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    }
    try {
      var response = await fetch(endpoint(path), opts);
      var payload = {};
      try { payload = await response.json(); } catch (_) { payload = {}; }
      return { ok: response.ok, status: response.status, payload: payload };
    } catch (error) {
      var aborted = error && (error.name === 'AbortError' || String(error.message || '').indexOf('abort') >= 0);
      return {
        ok: false,
        status: 0,
        payload: {},
        error: aborted ? '请求超时，请稍后重试' : (error && error.message) || '网络异常',
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 原始响应：用于下载 Excel/PDF 等二进制，不解析 body。
   * 返回 { ok, status, response }；超时与网络异常同样归一到 ok:false，由调用方决定提示文案。
   */
  async function requestRaw(path, options) {
    var opts = Object.assign({}, options || {});
    var timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
    delete opts.timeoutMs;
    if (!opts.headers) opts.headers = withTelemetry();
    var controller = null;
    var timer = null;
    if (timeoutMs > 0 && typeof AbortController === 'function') {
      controller = new AbortController();
      opts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    }
    try {
      var response = await fetch(endpoint(path), opts);
      return { ok: response.ok, status: response.status, response: response };
    } catch (error) {
      var aborted = error && (error.name === 'AbortError' || String(error.message || '').indexOf('abort') >= 0);
      return {
        ok: false,
        status: 0,
        response: null,
        error: aborted ? '请求超时，请稍后重试' : (error && error.message) || '网络异常',
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 取 JSON 或把失败归一成 Error（供需要 try/catch 的调用方使用） */
  async function requestOrThrow(path, options) {
    var result = await request(path, options);
    if (!result.ok) {
      var message = (result.payload && result.payload.error) || result.error || ('请求失败（' + result.status + '）');
      var error = new Error(message);
      error.status = result.status;
      error.payload = result.payload;
      throw error;
    }
    return result.payload;
  }

  global.siteApi = {
    request: request,
    requestRaw: requestRaw,
    requestOrThrow: requestOrThrow,
    jsonHeaders: jsonHeaders,
    get: function (path, options) { return request(path, Object.assign({ method: 'GET' }, options || {})); },
    getRaw: function (path, options) { return requestRaw(path, Object.assign({ method: 'GET' }, options || {})); },
    post: function (path, body, options) {
      return request(path, Object.assign({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body === undefined ? {} : body) }, options || {}));
    },
    put: function (path, body, options) {
      return request(path, Object.assign({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(body === undefined ? {} : body) }, options || {}));
    },
    del: function (path, options) { return request(path, Object.assign({ method: 'DELETE' }, options || {})); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
