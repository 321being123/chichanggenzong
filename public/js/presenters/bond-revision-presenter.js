// 可转债下修监控 Presenter（批次4：View／Presenter 分离）。
// 职责：持有下修列表与加载状态、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var bondRevisionState = { rows: [], filtered: [], loaded: false, loading: false, seq: 0 };

async function loadBondRevision(force) {
  if (!force && bondRevisionState.loaded) { bondRevisionApplyFilters(); return; }
  // 请求序号守卫（防旧响应覆盖新状态）：真正发请求才领序号，旧响应直接丢弃（不渲染、不写状态、不提示）。
  // loading 仅作 UI 提示，不再拦截新调用，每次取数都领新序号作废旧请求。
  var seq = (bondRevisionState.seq = (bondRevisionState.seq || 0) + 1);
  bondRevisionState.loading = true;
  try {
    // 批次4：取数统一走 siteApi（View 不直接 fetch）
    var response = await window.siteApi.get('/api/bond-revision?limit=2000', { cache: 'no-store' });
    if (bondRevisionState.seq !== seq) return;
    if (!response.ok) throw new Error('接口返回 ' + response.status);
    var data = response.payload;
    bondRevisionState.rows = Array.isArray(data.data) ? data.data : [];
    bondRevisionState.loaded = true;
    bondRevisionRenderSummary(data.summary);
    bondRevisionShowUpdated(data);
    bondRevisionApplyFilters();
  } catch (error) {
    if (bondRevisionState.seq !== seq) return;
    bondRevisionShowError(error);
  } finally {
    if (bondRevisionState.seq === seq) bondRevisionState.loading = false;
  }
}
