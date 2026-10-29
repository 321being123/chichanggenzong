// 上市可转债列表 Presenter（批次4：View／Presenter 分离）。
// 职责：持有列表与加载状态、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var bondListState = { rows: [], filtered: [], sortKey: 'double_low', sortDir: 1, loaded: false, loading: false, lastRefreshAt: 0, refreshTimer: null };

async function loadBondList(forceRefresh) {
  forceRefresh = Boolean(forceRefresh);
  if (bondListState.loading) return;
  if (!forceRefresh && bondListState.loaded && Date.now() - bondListState.lastRefreshAt < BOND_LIST_REFRESH_MS) {
    bondListApplyFilters();
    return;
  }
  bondListState.loading = true;
  bondListSetRefreshButton(true);
  try {
    var url = '/api/bond-analysis/bonds?limit=1000' + (forceRefresh ? '&refresh=1' : '');
    // 批次4：取数统一走 siteApi（View 不直接 fetch），错误与 JSON 解析由客户端归一。
    var result = await window.siteApi.get(url, { cache: 'no-store' });
    if (!result.ok) throw new Error('接口返回 ' + result.status);
    var data = result.payload;
    bondListState.rows = Array.isArray(data.data) ? data.data : [];
    bondListState.loaded = true;
    bondListState.lastRefreshAt = Date.now();
    bondListShowUpdated(data, forceRefresh);
    bondListApplyFilters();
  } catch (error) {
    bondListShowError(error);
  } finally {
    bondListState.loading = false;
    bondListSetRefreshButton(false);
    bondListStartAutoRefresh();
  }
}
