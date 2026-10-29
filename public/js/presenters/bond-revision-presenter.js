// 可转债下修监控 Presenter（批次4：View／Presenter 分离）。
// 职责：持有下修列表与加载状态、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var bondRevisionState = { rows: [], filtered: [], loaded: false, loading: false };

async function loadBondRevision(force) {
  if (bondRevisionState.loading) return;
  if (!force && bondRevisionState.loaded) { bondRevisionApplyFilters(); return; }
  bondRevisionState.loading = true;
  try {
    // 批次4：取数统一走 siteApi（View 不直接 fetch）
    var response = await window.siteApi.get('/api/bond-revision?limit=2000', { cache: 'no-store' });
    if (!response.ok) throw new Error('接口返回 ' + response.status);
    var data = response.payload;
    bondRevisionState.rows = Array.isArray(data.data) ? data.data : [];
    bondRevisionState.loaded = true;
    bondRevisionRenderSummary(data.summary);
    bondRevisionShowUpdated(data);
    bondRevisionApplyFilters();
  } catch (error) {
    bondRevisionShowError(error);
  } finally { bondRevisionState.loading = false; }
}
