// 网站匿名统计：只发送页面、模块和有限事件属性，不发送完整 URL、输入内容或业务数据。
(function () {
  'use strict';
  var ENDPOINT = '/api/telemetry/events';
  var OPT_OUT_KEY = 'site_analytics_opt_out';
  var SESSION_KEY = 'site_analytics_session';
  var SESSION_MAX_IDLE = 30 * 60 * 1000;
  var MAX_QUEUE = 100;
  var MAX_RETRIES = 2;
  var queue = [];
  var currentPage = '';
  var currentPageView = '';
  var sessionId = '';
  var lastActivity = Date.now();
  var lastEngagementAt = 0;
  var flushing = false;
  var retryTimer = 0;
  var identityResetPending = false;
  var detailMarkers = {};
  var pageMap = {
    '/': 'home', '/index.html': 'home', '/login.html': 'login', '/ipo-report.html': 'ipo.report',
    '/share-knowledge.html': 'knowledge.share', '/bond-revision-motive.html': 'bond.revision'
  };
  var pageKeys = {
    home: true, login: true, register: true, profile: true, changelog: true,
    'holdings.dashboard': true, 'holdings.positions': true, 'holdings.trades': true, 'holdings.nav': true,
    'ipo.calendar': true, 'ipo.report': true, 'bond.safety': true, 'bond.cycle': true, 'bond.valuation': true,
    'bond.list': true, 'bond.redemption': true, 'bond.revision': true, 'bond.analysis': true,
    'stock.analysis': true, 'market.volatility': true, 'knowledge.list': true, 'knowledge.detail': true,
    'knowledge.share': true, 'arbitrage.list': true, 'arbitrage.detail': true
  };
  var allowed = {
    page_view: true, engagement: true, detail_open: true, filter_apply: true,
    register_view: true, register_submit: true, telemetry_init: true
  };
  var initialSourceDomain = '';
  var retryDelayMs = 10000;

  function disabled() {
    try { return window.localStorage.getItem(OPT_OUT_KEY) === '1'; } catch (_) { return false; }
  }
  function id() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return String(Date.now()) + Math.random().toString(16).slice(2);
  }
  function getSessionId() {
    try {
      var storage = window.localStorage;
      var value = storage.getItem(SESSION_KEY);
      var parts = value ? value.split('|') : [];
      var now = Date.now();
      if (!parts[0] || !Number(parts[1]) || now - Number(parts[1]) >= SESSION_MAX_IDLE) parts = [id()];
      storage.setItem(SESSION_KEY, parts[0] + '|' + now);
      return parts[0];
    } catch (_) {
      try {
        var fallback = window.sessionStorage.getItem(SESSION_KEY);
        if (fallback) return fallback;
        fallback = id(); window.sessionStorage.setItem(SESSION_KEY, fallback); return fallback;
      } catch (__) { return id(); }
    }
  }
  function pageForLocation() {
    var path = window.location.pathname || '/';
    var direct = pageMap[path];
    if (path !== '/' && path !== '/index.html') return direct || '';
    var params = new URLSearchParams(window.location.search || '');
    var main = params.get('main') || 'home';
    if (main === 'holdings') {
      var holdingSub = params.get('sub');
      return holdingSub === 'positions' ? 'holdings.positions' : holdingSub === 'trades' ? 'holdings.trades' : holdingSub === 'earnings' ? 'holdings.nav' : 'holdings.dashboard';
    }
    if (main === 'ipo') return 'ipo.calendar';
    if (main === 'stock-analysis') return 'stock.analysis';
    if (main === 'market-volatility') return 'market.volatility';
    if (main === 'arbitrage') return params.get('case') ? 'arbitrage.detail' : 'arbitrage.list';
    if (main === 'knowledge') return 'knowledge.list';
    if (main === 'bond-safety') {
      var bondSub = params.get('sub');
      return pageKeys['bond.' + bondSub] ? 'bond.' + bondSub : 'bond.safety';
    }
    return pageKeys[main] ? main : 'home';
  }
  function referrerDomain() {
    try {
      var referrer = document.referrer;
      if (!referrer) return '';
      var hostname = new URL(referrer, window.location.href).hostname.toLowerCase();
      if (!hostname || hostname === String(window.location.hostname || '').toLowerCase()) return '';
      return hostname.slice(0, 120);
    } catch (_) { return ''; }
  }
  function deviceType() {
    var width = window.innerWidth || 0;
    return width && width <= 760 ? 'mobile' : 'desktop';
  }
  function endpoint() { return typeof window.api === 'function' ? window.api(ENDPOINT) : ENDPOINT; }
  function cleanProperties(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function track(eventName, pageKey, module, entry, properties) {
    if (!allowed[eventName] || !pageKeys[pageKey] || disabled()) return;
    sessionId = getSessionId();
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ event_id: id(), occurred_at: new Date().toISOString(), event_name: eventName,
      page_key: pageKey, module: module || '', entry: entry || '', device_type: deviceType(),
      session_id: sessionId, page_view_id: currentPageView || '', source_domain: initialSourceDomain,
      properties: cleanProperties(properties) });
    if (queue.length >= 10) flush();
  }
  function trackPage(pageKey, module, entry) {
    if (!pageKey || pageKey === 'admin' || pageKey === currentPage) return;
    currentPage = pageKey; currentPageView = id(); detailMarkers = {};
    track('page_view', pageKey, module, entry, {});
  }
  function trackDetail(data) {
    data = data || {};
    var pageKey = data.page_key || currentPage || 'home';
    var marker = currentPageView + ':' + pageKey + ':' + String(data.detail_key || 'default');
    if (detailMarkers[marker]) return;
    detailMarkers[marker] = true;
    track('detail_open', pageKey, data.module, data.entry, data.properties || {});
  }
  function flush() {
    if (flushing || !queue.length || disabled()) return;
    flushing = true;
    var batch = queue.splice(0, 20);
    var body;
    try { body = JSON.stringify({ events: batch }); } catch (_) { flushing = false; return; }
    var headers = { 'Content-Type': 'application/json' };
    if (identityResetPending) headers['X-Site-Analytics-Reset'] = '1';
    fetch(endpoint(), { method: 'POST', credentials: 'same-origin', headers: headers,
      body: body, keepalive: true }).then(function (response) {
      if (response.ok || response.status === 403) { retryDelayMs = 10000; if (response.ok) identityResetPending = false; return; }
      if (response.status === 429 || response.status >= 500) {
        var retryAfter = Number(response.headers && response.headers.get && response.headers.get('Retry-After'));
        retryDelayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60000) : 10000;
        var retryBatch = batch.filter(function (item) {
          item.__retry = (item.__retry || 0) + 1;
          return item.__retry <= MAX_RETRIES;
        });
        queue = retryBatch.concat(queue).slice(0, MAX_QUEUE);
      }
    }).catch(function () {
      var retryBatch = batch.filter(function (item) {
        item.__retry = (item.__retry || 0) + 1;
        return item.__retry <= MAX_RETRIES;
      });
      queue = retryBatch.concat(queue).slice(0, MAX_QUEUE);
    })
      .finally(function () {
        flushing = false;
        if (queue.length && !retryTimer) retryTimer = setTimeout(function () { retryTimer = 0; flush(); }, retryDelayMs);
      });
  }
  function setupOptOutControl() {
    if (!document.body || document.getElementById('site-analytics-control')) return;
    var control = document.createElement('div');
    control.id = 'site-analytics-control'; control.className = 'site-analytics-control';
    control.innerHTML = '<span>仅收集匿名页面使用统计</span><button type="button"></button>';
    var button = control.querySelector('button');
    function update() { button.textContent = disabled() ? '开启统计' : '关闭统计'; }
    button.onclick = function () {
      if (disabled()) { window.SiteTelemetry.enable(); update(); return; }
      window.SiteTelemetry.disable(); update();
    };
    update(); document.body.appendChild(control);
  }
  function init() {
    var page = pageForLocation();
    if (!page) return;
    setupOptOutControl();
    if (disabled()) return;
    initialSourceDomain = referrerDomain();
    sessionId = getSessionId();
    trackPage(page, page.split('.')[0], 'direct');
    track('telemetry_init', page, 'telemetry', 'boot', { script_version: '1', init_status: 'ready' });
    ['click', 'keydown', 'scroll', 'touchstart'].forEach(function (eventName) {
      window.addEventListener(eventName, function () { lastActivity = Date.now(); }, { passive: true });
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(); else lastActivity = Date.now();
    });
    setInterval(function () {
      if (currentPage && document.visibilityState !== 'hidden' && Date.now() - lastActivity < 60000 && Date.now() - lastEngagementAt >= 60000) {
        lastEngagementAt = Date.now(); track('engagement', currentPage, currentPage.split('.')[0], 'active', { duration_sec: 60 });
      }
      flush();
    }, 60000);
  }
  window.SiteTelemetry = {
    trackPage: trackPage,
    trackEvent: function (eventName, data) {
      data = data || {}; track(eventName, data.page_key || currentPage || 'home', data.module, data.entry, data.properties || data);
    },
    trackDetail: trackDetail,
    flush: flush,
    getSessionId: getSessionId,
    isOptedOut: disabled,
    getHeaders: function (base) {
      var headers = Object.assign({}, base || {});
      if (disabled()) { headers['X-Site-Analytics-Opt-Out'] = '1'; return headers; }
      headers['X-Site-Session'] = getSessionId();
      return headers;
    },
    disable: function () {
      try { window.localStorage.setItem(OPT_OUT_KEY, '1'); window.localStorage.removeItem(SESSION_KEY); } catch (_) {}
      queue = []; sessionId = ''; identityResetPending = true; document.cookie = 'site_visitor=; Max-Age=0; Path=/';
      fetch((typeof window.api === 'function' ? window.api('/api/telemetry/opt-out') : '/api/telemetry/opt-out'), { method: 'POST', credentials: 'same-origin', headers: { 'X-Site-Analytics-Opt-Out': '1' }, keepalive: true }).catch(function () {});
    },
    enable: function () { try { window.localStorage.removeItem(OPT_OUT_KEY); } catch (_) {} identityResetPending = true; sessionId = getSessionId(); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
