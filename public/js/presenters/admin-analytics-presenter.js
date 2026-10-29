// 网站数据看板 Presenter（批次4：View／Presenter 分离）。
// 职责：持有看板 tab/range 等状态与请求序号、经 siteApi 取数、把结果交给 View 渲染。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       指标口径由服务端统一计算，看板 HTML 与工具栏在 admin-analytics.js（View），经 window 全局回调 View。
var analyticsState = { tab: 'overview', range: '30d', internal: false, ready: false };
var analyticsRequest = 0;

function analyticsLoad() {
  if (!window.analyticsPaintLoading()) return;
  var requestId = ++analyticsRequest;
  var query = '?range=' + encodeURIComponent(analyticsState.range) + (analyticsState.internal ? '&include_internal=1' : '');
  window.siteApi.requestRaw('/api/admin/analytics/' + analyticsState.tab + query, { timeoutMs: 0, headers: {} }).then(function (result) {
    if (!result.response) throw new Error(result.error || '网络异常');
    var response = result.response;
    return response.json().then(function (data) { return { ok: response.ok, data: data }; });
  }).then(function (result) {
    if (requestId !== analyticsRequest) return;
    window.analyticsPaintResult(result);
  }).catch(function () { if (requestId === analyticsRequest) window.analyticsPaintError(); });
}
