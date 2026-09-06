// 网站数据看板前端：只负责展示后台接口返回的数据，指标口径由服务端统一计算。
var analyticsState = { tab: 'overview', range: '30d', internal: false, ready: false };
var analyticsRequest = 0;
var analyticsPollTimer = 0;
var ANALYTICS_EVENT_LABELS = {
  page_view: '页面浏览', engagement: '活跃停留', detail_open: '详情打开', filter_apply: '筛选使用',
  register_view: '注册页面浏览', register_submit: '注册提交', register_success: '注册成功',
  watchlist_add_success: '自选股添加成功', import_result: '净值导入结果', telemetry_init: '统计初始化'
};
var ANALYTICS_PAGE_LABELS = {
  home: '首页', login: '登录页', register: '注册页', profile: '个人资料', changelog: '版本记录',
  'holdings.dashboard': '持仓总览', 'holdings.positions': '持仓明细', 'holdings.trades': '交易记录', 'holdings.nav': '净值管理',
  'ipo.calendar': '打新日历', 'ipo.report': '打新报告', 'bond.safety': '可转债安全性', 'bond.cycle': '可转债周期',
  'bond.valuation': '可转债估值', 'bond.list': '可转债列表', 'bond.redemption': '强赎管理', 'bond.revision': '下修管理',
  'bond.analysis': '可转债分析', 'stock.analysis': '股票分析', 'market.volatility': '股市周期',
  'knowledge.list': '投资笔记', 'knowledge.detail': '笔记详情', 'knowledge.share': '公开分享',
  'arbitrage.list': '套利列表', 'arbitrage.detail': '套利详情'
};
var ANALYTICS_MODULE_LABELS = {
  telemetry: '统计系统', auth: '账号', holdings: '持仓', ipo: '打新', bond: '可转债', stock: '股票',
  knowledge: '投资笔记', arbitrage: '套利', market: '市场', profile: '个人资料'
};
var ANALYTICS_ENTRY_LABELS = {
  direct: '直接访问', boot: '启动', active: '持续使用', switch: '切换', submit: '提交', list: '列表',
  analysis: '分析', report: '报告', share: '分享', history: '历史筛选', article: '文章', 'motive-detail': '动机详情'
};
var ANALYTICS_DEVICE_LABELS = { desktop: '电脑端', mobile: '手机端', unknown: '未知设备' };
var ANALYTICS_LAYER_LABELS = { app: '应用层', nginx: '边缘层' };
var ANALYTICS_COVERAGE_LABELS = {
  complete: '数据完整', partial: '数据不完整', no_sample: '暂无采样', no_data: '暂无数据',
  query_failed: '查询失败', sampled: '抽样数据', unknown: '未知'
};
var ANALYTICS_STATUS_LABELS = {
  ok: '正常', success: '成功', completed: '已完成', running: '运行中', pending: '等待中',
  waiting_quota: '等待额度', waiting_external: '等待外部服务', failed: '失败', error: '异常',
  warning: '警告', succeeded: '成功', degraded: '部分成功', blocked: '已阻断', skipped: '已跳过',
  sending: '发送中', sent: '已发送', send_failed: '发送失败', loading: '加载中', published: '已发布',
  rejected: '已拒绝', open: '已熔断', half_open: '恢复探测中', closed: '正常', stale: '已过期',
  not_seen: '未发现', not_configured: '未配置', disabled: '未启用', resolved: '已解决', acknowledged: '已确认', suppressed: '已抑制'
};
var ANALYTICS_QUALITY_STATUS_LABELS = { open: '待处理', resolved: '已解决', acknowledged: '已确认', suppressed: '已抑制' };
var ANALYTICS_SEVERITY_LABELS = { critical: '严重', high: '高', medium: '中', low: '低', info: '提示', warning: '警告' };
var ANALYTICS_ERROR_LABELS = {
  QUOTA_EXHAUSTED: '额度已用尽', RATE_LIMIT: '访问频率过高', CIRCUIT_OPEN: '熔断拦截',
  AUTH_ERROR: '认证失败', PERMISSION_DENIED: '权限不足', NETWORK_ERROR: '网络错误',
  TIMEOUT: '请求超时', BUDGET_WAIT: '预算等待'
};
var ANALYTICS_DATASET_LABELS = {
  bond_daily: '可转债日行情', bond_safety_snapshot: '可转债安全性快照', bond_valuation: '可转债估值',
  stock_adj_factor: '股票复权因子', stock_daily: '股票日行情', stock_valuation: '股票估值', daily_basic: '股票每日指标',
  financial: '财务数据', financial_statements: '财务报表', company_events: '公司事件', cb_basic: '可转债基础资料',
  cb_daily: '可转债日行情', conversion_price_announcements: '转股价公告', arbitrage: '套利数据', positions: '持仓数据'
};
var ANALYTICS_SCOPE_LABELS = {
  global: '全局', site_analytics: '网站统计', convertible_bond_valuation: '可转债估值', stock_analysis: '股票分析',
  bond_daily: '可转债行情', stock_daily: '股票行情'
};
var ANALYTICS_SOURCE_LABELS = {
  tushare: 'Tushare 数据源', tushare_backup: 'Tushare 备用数据源', tencent: '腾讯行情', cninfo: '巨潮资讯',
  szse: '深交所', sse: '上交所', 'exchange-rate': '汇率接口', 'stock-analysis': '股票分析数据'
};
var ANALYTICS_API_LABELS = {
  '*': '全部接口', daily_basic: '股票每日指标接口', pro_bar: '历史行情接口', rt_min: '实时行情接口',
  trade_cal: '交易日历接口', hk_basic: '港股基础资料接口', cb_daily: '可转债行情接口', exchange_announcements: '交易所公告接口'
};
var ANALYTICS_CREDENTIAL_LABELS = { primary: '主凭据', backup: '备用凭据', anonymous: '匿名访问', legacy: '旧配置' };
var ANALYTICS_WINDOW_LABELS = { minute: '分钟', day: '日' };
var ANALYTICS_ROUTE_LABELS = { '__event_loop__': '事件循环监控', '__static__': '静态资源' };

function analyticsLabel(map, value, fallback) {
  var text = String(value == null ? '' : value);
  return Object.prototype.hasOwnProperty.call(map, text) ? map[text] : (text || fallback || '--');
}
function analyticsRangeLabel(value) {
  return analyticsLabel({ today: '今天', '7d': '近7天', '30d': '近30天', '90d': '近90天' }, value, '当前范围');
}
function analyticsRouteLabel(value) {
  var route = String(value == null ? '' : value);
  if (!route) return '--';
  if (Object.prototype.hasOwnProperty.call(ANALYTICS_ROUTE_LABELS, route)) return ANALYTICS_ROUTE_LABELS[route];
  if (route === '/') return '首页';
  if (route.indexOf('/api/admin/') === 0) return '后台管理接口（' + route + '）';
  if (route.indexOf('/api/') === 0) return '业务接口（' + route + '）';
  return '页面路由（' + route + '）';
}
function analyticsBudgetRisk(value) {
  var percent = Number(value);
  if (!Number.isFinite(percent)) return '未知';
  if (percent >= 100) return '已用尽';
  if (percent >= 90) return '高风险';
  return '接近上限';
}
function analyticsCircuitStatus(row) {
  var recoverAt = row && row.recover_at ? new Date(row.recover_at).getTime() : NaN;
  return Number.isFinite(recoverAt) && recoverAt <= Date.now() ? '待恢复探测' : '已熔断（暂停请求）';
}
function analyticsCircuitRecovery(row) {
  var recoverAt = row && row.recover_at ? new Date(row.recover_at).getTime() : NaN;
  if (Number.isFinite(recoverAt) && recoverAt <= Date.now()) return '已到期，等待探测';
  return analyticsDate(row && row.recover_at);
}

function analyticsEsc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function analyticsNum(value) {
  var n = Number(value); return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '--';
}
function analyticsDate(value) {
  if (!value) return '--';
  var text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  var date = new Date(value);
  if (!Number.isFinite(date.getTime())) return analyticsEsc(text);
  var parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  var map = {}; parts.forEach(function (part) { map[part.type] = part.value; });
  return map.year + '-' + map.month + '-' + map.day + ' ' + map.hour + ':' + map.minute;
}
function analyticsCoverage(data) {
  var status = data && data.coverage && data.coverage.status || 'unknown';
  return '<span class="analytics-coverage analytics-coverage-' + analyticsEsc(status) + '">' +
    analyticsEsc(analyticsLabel(ANALYTICS_COVERAGE_LABELS, status, '未知状态')) + '</span>';
}
function analyticsTable(headers, rows, empty) {
  if (!rows || !rows.length) return '<div class="analytics-empty">' + analyticsEsc(empty || '暂无数据') + '</div>';
  return '<div class="analytics-table-wrap"><table class="biz-table analytics-table"><thead><tr>' + headers.map(function (h) { return '<th>' + analyticsEsc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
    rows.map(function (row) { return '<tr>' + row.map(function (cell) { return '<td>' + (cell == null ? '--' : cell) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
}
function analyticsBars(rows, labelKey, valueKey) {
  if (!rows || !rows.length) return '<div class="analytics-empty">暂无数据</div>';
  var max = Math.max.apply(null, rows.map(function (r) { return Number(r[valueKey]) || 0; }).concat([1]));
  return '<div class="analytics-bars">' + rows.map(function (r) {
    var value = Number(r[valueKey]) || 0;
    return '<div class="analytics-bar-row"><span>' + analyticsEsc(r[labelKey]) + '</span><div class="analytics-bar-track"><i style="width:' + Math.max(2, value / max * 100) + '%"></i></div><b>' + analyticsNum(value) + '</b></div>';
  }).join('') + '</div>';
}
function analyticsSection(title, body) { return '<section class="analytics-card"><h3>' + title + '</h3>' + body + '</section>'; }

function analyticsSetTabActive() {
  document.querySelectorAll('[data-analytics-tab]').forEach(function (tab) {
    tab.classList.toggle('active', tab.dataset.analyticsTab === analyticsState.tab);
  });
}

function renderAnalytics() {
  var el = document.getElementById('view-analytics');
  if (!el) return;
  if (!analyticsState.ready) {
    el.innerHTML = '<div class="analytics-toolbar"><div class="analytics-tabs">' +
      [['overview', '总览'], ['traffic', '访问分析'], ['behavior', '行为分析'], ['runtime', '运行状态'], ['data-health', '数据健康']].map(function (item) {
        return '<button type="button" class="analytics-tab" data-analytics-tab="' + item[0] + '">' + item[1] + '</button>';
      }).join('') +
      '</div><div class="analytics-controls"><select id="analytics-range"><option value="today">今天</option><option value="7d">近7天</option><option value="30d" selected>近30天</option><option value="90d">近90天</option></select><label><input type="checkbox" id="analytics-internal">包含内部流量</label><button type="button" class="btn btn-outline btn-sm" id="analytics-refresh">刷新</button></div></div><div id="analytics-panel"></div>';
    el.querySelectorAll('[data-analytics-tab]').forEach(function (button) { button.onclick = function () { analyticsState.tab = button.dataset.analyticsTab; analyticsSetTabActive(); analyticsLoad(); }; });
    var range = document.getElementById('analytics-range');
    if (range) range.onchange = function () { analyticsState.range = range.value; analyticsLoad(); };
    var internal = document.getElementById('analytics-internal');
    if (internal) internal.onchange = function () { analyticsState.internal = internal.checked; analyticsLoad(); };
    var refresh = document.getElementById('analytics-refresh');
    if (refresh) refresh.onclick = function () { analyticsLoad(); };
    analyticsState.ready = true;
  }
  if (!analyticsPollTimer) analyticsPollTimer = setInterval(function () {
    if (!document.hidden && el.classList.contains('active')) analyticsLoad();
  }, 60000);
  analyticsSetTabActive();
  analyticsLoad();
}

function analyticsLoad() {
  var panel = document.getElementById('analytics-panel');
  if (!panel) return;
  var requestId = ++analyticsRequest;
  panel.innerHTML = '<div class="admin-placeholder"><div class="spinner" style="margin:0 auto 12px;"></div>加载中...</div>';
  var query = '?range=' + encodeURIComponent(analyticsState.range) + (analyticsState.internal ? '&include_internal=1' : '');
  fetch(api('/api/admin/analytics/' + analyticsState.tab + query)).then(function (response) {
    return response.json().then(function (data) { return { ok: response.ok, data: data }; });
  }).then(function (result) {
    if (requestId !== analyticsRequest) return;
    if (!result.ok || result.data.ok === false) { panel.innerHTML = '<div class="admin-placeholder"><div class="icon">⚠️</div>' + analyticsEsc(result.data.error || '看板暂不可用') + '</div>'; return; }
    if (analyticsState.tab === 'overview') panel.innerHTML = analyticsOverviewHtml(result.data);
    else if (analyticsState.tab === 'traffic') panel.innerHTML = analyticsTrafficHtml(result.data);
    else if (analyticsState.tab === 'behavior') panel.innerHTML = analyticsBehaviorHtml(result.data);
    else if (analyticsState.tab === 'runtime') panel.innerHTML = analyticsRuntimeHtml(result.data);
    else panel.innerHTML = analyticsHealthHtml(result.data);
  }).catch(function () { if (requestId === analyticsRequest) panel.innerHTML = '<div class="admin-placeholder"><div class="icon">⚠️</div>网络错误，请刷新重试</div>'; });
}

function analyticsOverviewHtml(data) {
  var s = data.summary || {};
  var cards = [['页面浏览量（PV）', s.pv], ['独立访客数（UV）', s.uv], ['近5分钟活跃访客（估计）', s.active_visitors], ['访问会话', s.sessions], ['活跃登录用户', s.logged_users], ['真实新增注册', s.new_registrations], ['待处理异常', s.pending_exceptions], ['自选股添加成功', s.watchlist_adds]];
  var trend = data.daily || [];
  return '<div class="analytics-meta">统计范围：' + analyticsEsc(analyticsRangeLabel(data.range)) + '　' + analyticsCoverage(data) + '</div><div class="stats analytics-stats">' + cards.map(function (c) { return '<div class="stat-card"><div class="label">' + c[0] + '</div><div class="value">' + analyticsNum(c[1]) + '</div></div>'; }).join('') + '</div>' +
    '<div class="analytics-grid-2">' + analyticsSection('页面浏览趋势（今天按小时）', analyticsBars(trend.map(function (r) { return { label: r.day, value: r.pv }; }), 'label', 'value')) +
    analyticsSection('独立访客趋势', analyticsBars(trend.map(function (r) { return { label: r.day, value: r.uv }; }), 'label', 'value')) + '</div>' +
    '<div class="analytics-grid-2">' + analyticsSection('热门页面', analyticsTable(['页面', '页面浏览量（PV）', '独立访客（UV）', '入口', '平均停留秒数'], (data.topPages || []).map(function (r) { return [analyticsEsc(analyticsLabel(ANALYTICS_PAGE_LABELS, r.page_key, '其他页面')), analyticsNum(r.pv), analyticsNum(r.uv), analyticsNum(r.entries), r.avg_duration_sec == null ? '--' : analyticsNum(r.avg_duration_sec)]; }))) +
    analyticsSection('设备分布', analyticsBars((data.devices || []).map(function (r) { return { label: analyticsLabel(ANALYTICS_DEVICE_LABELS, r.device_type, '其他设备'), value: r.pv }; }), 'label', 'value')) + '</div>';
}
function analyticsTrafficHtml(data) {
  return '<div class="analytics-meta">统计范围：' + analyticsEsc(analyticsRangeLabel(data.range)) + '　' + analyticsCoverage(data) + '</div><div class="analytics-grid-2">' +
    analyticsSection('来源域名', analyticsTable(['来源', '页面浏览量（PV）', '独立访客（UV）'], (data.sources || []).map(function (r) { return [analyticsEsc(r.source_domain), analyticsNum(r.pv), analyticsNum(r.uv)]; }))) +
    analyticsSection('入口标记', analyticsTable(['入口', '页面浏览量（PV）', '独立访客（UV）'], (data.entries || []).map(function (r) { return [analyticsEsc(analyticsLabel(ANALYTICS_ENTRY_LABELS, r.entry, '其他入口')), analyticsNum(r.pv), analyticsNum(r.uv)]; }))) + '</div>' +
    analyticsSection('会话趋势', analyticsTable(['日期', '会话', '登录用户'], (data.sessions || []).map(function (r) { return [analyticsEsc(r.day), analyticsNum(r.sessions), analyticsNum(r.logged_users)]; }))) +
    analyticsSection('页面访问质量', analyticsTable(['页面', '页面浏览量（PV）', '独立访客（UV）', '入口数', '平均停留秒数'], (data.pages || []).map(function (r) { return [analyticsEsc(analyticsLabel(ANALYTICS_PAGE_LABELS, r.page_key, '其他页面')), analyticsNum(r.pv), analyticsNum(r.uv), analyticsNum(r.entry_count), r.avg_duration_sec == null ? '--' : analyticsNum(r.avg_duration_sec)]; })));
}
function analyticsBehaviorHtml(data) {
  var f = data.funnel || {};
  var funnel = [['注册页面浏览', f.register_view], ['注册提交', f.register_submit], ['注册成功', f.register_success], ['自选股添加成功', f.watchlist_add_success], ['净值导入成功', f.import_success]];
  return '<div class="analytics-meta">统计范围：' + analyticsEsc(analyticsRangeLabel(data.range)) + '　' + analyticsCoverage(data) + '</div><div class="analytics-grid-2">' +
    analyticsSection('功能行为排行', analyticsTable(['事件', '用户数', '次数'], (data.events || []).map(function (r) { return [analyticsEsc(analyticsLabel(ANALYTICS_EVENT_LABELS, r.event_name, '其他事件')), analyticsNum(r.users), analyticsNum(r.count)]; }))) +
    analyticsSection('关键转化', analyticsBars(funnel.map(function (r) { return { label: r[0], value: Number(r[1]) || 0 }; }), 'label', 'value')) + '</div>' +
    analyticsSection('详情与停留', analyticsTable(['页面', '事件数', '平均停留秒数'], (data.details || []).map(function (r) { return [analyticsEsc(analyticsLabel(ANALYTICS_PAGE_LABELS, r.page_key, '其他页面')), analyticsNum(r.count), r.avg_duration_sec == null ? '--' : analyticsNum(r.avg_duration_sec)]; }))) +
    analyticsSection('最近30分钟行为（最多50条）', analyticsTable(['时间', '事件', '页面', '模块', '入口', '访客', '登录'], (data.recent || []).map(function (r) { return [analyticsDate(r.occurred_at), analyticsEsc(analyticsLabel(ANALYTICS_EVENT_LABELS, r.event_name, '其他事件')), analyticsEsc(analyticsLabel(ANALYTICS_PAGE_LABELS, r.page_key, '其他页面')), analyticsEsc(analyticsLabel(ANALYTICS_MODULE_LABELS, r.module, '其他模块')), analyticsEsc(analyticsLabel(ANALYTICS_ENTRY_LABELS, r.entry, '其他入口')), analyticsEsc(r.visitor_label), r.logged_in ? '是' : '否']; })));
}
function analyticsRuntimeHtml(data) {
  var dependency = data.dependency || {}, db = dependency.database || {}, dep = dependency.redis || {}, worker = dependency.worker || {};
  var depText = (db.status === 'ok' ? '数据库正常' : '数据库异常：' + (db.reason || '未知')) + '；' + (dep.status === 'ok' ? 'Redis 正常' : dep.status === 'not_configured' ? 'Redis 未配置（可选）' : 'Redis 异常：' + (dep.reason || '未知')) + '；Worker：' + (worker.reason || analyticsLabel(ANALYTICS_STATUS_LABELS, worker.status, '未知'));
  var rows = (data.rows || []).slice(0, 200).map(function (r) {
    return [analyticsDate(r.bucket_start), analyticsEsc(analyticsLabel(ANALYTICS_LAYER_LABELS, r.layer, '其他层')), analyticsEsc(analyticsRouteLabel(r.route_key)), analyticsNum(r.request_count), analyticsNum(r.status_429), analyticsNum(r.status_5xx), r.p50_ms == null ? '--' : analyticsNum(r.p50_ms), r.p95_ms == null ? '--' : analyticsNum(r.p95_ms), analyticsNum(r.slow_requests), analyticsEsc(analyticsLabel(ANALYTICS_COVERAGE_LABELS, r.coverage_status, '未知'))];
  });
  var summary = (data.summary || []).map(function (r) {
    return [analyticsEsc(analyticsLabel(ANALYTICS_LAYER_LABELS, r.layer, '其他层')), analyticsNum(r.request_count), analyticsNum(r.status_429), analyticsNum(r.status_5xx), r.p50_ms == null ? '--' : analyticsNum(r.p50_ms), r.p95_ms == null ? '--' : analyticsNum(r.p95_ms), analyticsNum(r.slow_requests)];
  });
  return '<div class="analytics-meta">统计范围：' + analyticsEsc(analyticsRangeLabel(data.range)) + '　' + analyticsCoverage(data) + '　<span class="analytics-dependency">' + analyticsEsc(depText) + '；进程内存：' + analyticsNum(data.process && data.process.rss_mb) + ' MB</span></div>' + analyticsSection('区间运行汇总', analyticsTable(['层', '请求数', '限流（429）', '服务器错误（5xx）', '耗时中位数（P50，毫秒）', '耗时95分位（P95，毫秒）', '慢请求'], summary, '暂无运行采样')) + analyticsSection('分钟运行采样', analyticsTable(['时间', '层', '路由描述', '请求数', '限流（429）', '服务器错误（5xx）', '耗时中位数（P50，毫秒）', '耗时95分位（P95，毫秒）', '慢请求', '覆盖状态'], rows, '暂无运行采样'));
}
function analyticsHealthHtml(data) {
  var e = data.events || {}, r = data.runtime || {}, c = data.config || {};
  var configRows = [['统计开关', c.enabled ? '开启' : '关闭'], ['匿名密钥', c.secretConfigured ? '已配置' : '未配置'], ['保留天数', c.retentionDays + ' 天'], ['Nginx采集', c.nginxConfigured ? '已配置' : '未配置'], ['启用时间', analyticsDate(c.enabledAt)]];
  var eventRows = [['事件数', analyticsNum(e.count)], ['最早接收', analyticsDate(e.first_received_at)], ['最近接收', analyticsDate(e.last_received_at)], ['无访客标识', analyticsNum(e.no_visitor_key)], ['游客事件', analyticsNum(e.guest_events)], ['内部事件', analyticsNum(e.internal_events)]];
  var dep = data.dependency || {};
  var dependencyRows = [['数据库', dep.database && analyticsLabel(ANALYTICS_STATUS_LABELS, dep.database.status, '未知'), dep.database && dep.database.reason], ['Redis', dep.redis && analyticsLabel(ANALYTICS_STATUS_LABELS, dep.redis.status, '未知'), dep.redis && dep.redis.reason], ['Worker', dep.worker && analyticsLabel(ANALYTICS_STATUS_LABELS, dep.worker.status, '未知'), dep.worker && dep.worker.reason]];
  var nginxCursor = data.nginxCursor;
  var nginxStatus = nginxCursor ? (nginxCursor.last_error ? '异常：' + nginxCursor.last_error : '已建立') : '未建立';
  var coverageRows = [['采样行数', analyticsNum(r.row_count)], ['最近分钟', analyticsDate(r.last_bucket)], ['Nginx游标', analyticsEsc(nginxStatus)]].concat(dependencyRows.map(function (x) { return [x[0], analyticsEsc(x[1] || '--') + '（' + analyticsEsc(x[2] || '') + '）']; }));
  var budgetRows = (data.budgets || []).map(function (x) {
    var percent = x.usage_percent == null ? Number(x.budget_limit) ? Number(x.call_count || 0) * 100 / Number(x.budget_limit) : NaN : Number(x.usage_percent);
    var remaining = x.remaining == null ? Math.max(Number(x.budget_limit || 0) - Number(x.call_count || 0), 0) : x.remaining;
    return [analyticsEsc(analyticsLabel(ANALYTICS_SOURCE_LABELS, x.source, x.source && /^(test|debug)_guard_/.test(x.source) ? '测试记录' : '其他来源')), analyticsEsc(analyticsLabel(ANALYTICS_API_LABELS, x.api_name, '其他接口')), analyticsEsc(analyticsLabel(ANALYTICS_CREDENTIAL_LABELS, x.credential_profile, '其他凭据')), analyticsEsc(analyticsLabel(ANALYTICS_WINDOW_LABELS, x.window_type, '其他周期') + '/' + x.window_key), analyticsNum(x.budget_limit), analyticsNum(x.call_count), analyticsNum(remaining), Number.isFinite(percent) ? percent.toFixed(1) + '%' : '--', analyticsBudgetRisk(percent)];
  });
  var circuitRows = (data.circuits || []).map(function (x) {
    return [analyticsEsc(analyticsLabel(ANALYTICS_SOURCE_LABELS, x.source, x.source && /^(test|debug)_guard_/.test(x.source) ? '测试记录' : '其他来源')), analyticsEsc(analyticsLabel(ANALYTICS_API_LABELS, x.api_name, '其他接口')), analyticsCircuitStatus(x), analyticsCircuitRecovery(x), analyticsEsc(analyticsLabel(ANALYTICS_ERROR_LABELS, x.error_code, x.error_code || '其他原因'))];
  });
  return '<div class="analytics-meta">统计范围：' + analyticsEsc(analyticsRangeLabel(data.range)) + '　' + analyticsCoverage(data) + '</div><div class="analytics-grid-2">' + analyticsSection('采集配置', analyticsTable(['项目', '状态'], configRows)) + analyticsSection('事件数据', analyticsTable(['项目', '数值'], eventRows)) + '</div>' +
    analyticsSection('运行采样覆盖与依赖', analyticsTable(['项目', '数值'], coverageRows)) +
    analyticsSection('金融数据分区', analyticsTable(['数据集', '范围', '最早日期', '最新日期', '状态', '最新分区行数'], (data.datasets || []).map(function (x) { return [analyticsEsc(analyticsLabel(ANALYTICS_DATASET_LABELS, x.dataset_code, '其他数据集')), analyticsEsc(analyticsLabel(ANALYTICS_SCOPE_LABELS, x.scope_key, '其他范围')), analyticsEsc(x.earliest_data_as_of || '--'), analyticsEsc(x.latest_data_as_of || x.data_as_of || x.partition_key || '--'), x.is_stale ? '陈旧：' + analyticsEsc(x.stale_reason) : '正常', analyticsNum(x.row_count)]; }))) +
    '<div class="analytics-grid-2">' + analyticsSection('质量问题', analyticsTable(['数据集', '状态', '级别', '数量'], (data.quality || []).map(function (x) { return [analyticsEsc(analyticsLabel(ANALYTICS_DATASET_LABELS, x.dataset_code, '其他数据集')), analyticsEsc(analyticsLabel(ANALYTICS_QUALITY_STATUS_LABELS, x.status, analyticsLabel(ANALYTICS_STATUS_LABELS, x.status, '其他状态'))), analyticsEsc(analyticsLabel(ANALYTICS_SEVERITY_LABELS, x.severity, '其他级别')), analyticsNum(x.count)]; }))) + analyticsSection('任务槽位', analyticsTable(['状态', '数量'], (data.jobs || []).map(function (x) { return [analyticsEsc(analyticsLabel(ANALYTICS_STATUS_LABELS, x.status, '其他状态')), analyticsNum(x.count)]; }))) + '</div>' +
    '<div class="analytics-grid-2">' + analyticsSection('待处理告警', analyticsTable(['状态', '级别', '数量'], (data.alerts || []).map(function (x) { return [analyticsEsc(analyticsLabel(ANALYTICS_STATUS_LABELS, x.status, '其他状态')), analyticsEsc(analyticsLabel(ANALYTICS_SEVERITY_LABELS, x.severity, '其他级别')), analyticsNum(x.count)]; }))) + analyticsSection('预算预警（当前窗口，使用率≥80%）', analyticsTable(['来源', '接口', '凭据', '窗口', '预算上限', '已消耗', '剩余', '使用率', '风险'], budgetRows, '当前没有达到预警阈值的预算')) + '</div>' +
    analyticsSection('当前已触发的熔断（暂停请求）', analyticsTable(['来源', '接口', '状态', '预计恢复', '触发原因'], circuitRows, '当前没有已触发的熔断')) +
    analyticsSection('预算与熔断指标说明', analyticsTable(['指标', '含义'], [
      ['预算上限', '当前来源、接口、凭据在该分钟或当天允许的最大外部调用次数。'],
      ['已消耗', '当前预算窗口已经使用的外部调用次数。'],
      ['剩余', '预算上限减去已消耗，最低显示为 0；为 0 表示当前窗口已用尽。'],
      ['使用率/风险', '达到 80% 列入预警，达到 90% 标记高风险，达到 100% 表示已用尽。'],
      ['预算预警范围', '只展示当前分钟或当天使用率达到 80% 的记录，历史窗口不会继续作为当前风险。'],
      ['熔断', '上游限流、额度用尽、认证失败等异常触发保护后，系统会暂时停止继续请求。'],
      ['熔断恢复', '预计恢复时间到了，不代表已经自动恢复；还要等待下一次恢复探测成功。']
    ])) +
    analyticsSection('数据健康指标说明', analyticsTable(['指标', '含义'], [
      ['事件数', '选定时间范围内收到的匿名统计事件总量，不等于访问人数。'],
      ['无访客标识', '没有有效匿名访客标识的事件数量，数值较高通常表示统计身份未成功建立。'],
      ['游客事件', '未登录用户产生的统计事件数量；登录用户另按登录身份统计。'],
      ['内部事件', '被系统识别为管理员、测试或内部访问的事件数量。'],
      ['采样行数', '选定时间范围内保存的应用层和边缘层分钟运行采样行数。'],
      ['最早日期/最新日期', '表示该数据集已发布数据分区覆盖的时间范围；最新日期不是今天日期。'],
      ['最新分区行数', '对应数据集最新发布分区中的记录数量，不代表全库总行数。'],
      ['质量问题/告警数量', '当前仍记录的异常或待处理事项数量，不是访问量。'],
      ['预算调用/上限', '当前周期已使用的外部接口调用次数与保护上限。'],
      ['P50/P95', 'P50 是一半请求不超过的耗时；P95 是 95% 请求不超过的耗时，单位为毫秒。'],
      ['限流（429）/服务器错误（5xx）', '分别表示被访问频率限制的请求数，以及服务器错误响应的请求数。']
    ]));
}
