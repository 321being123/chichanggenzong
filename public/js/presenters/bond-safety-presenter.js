// 可转债安全性 Presenter（批次4：View／Presenter 分离）。
// 职责：持有列表与筛选排序状态、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var bondSafetyState = { rows: [], filtered: [], sortKey: 'bond_price', sortDir: 1, loaded: false };

async function exportBondSafety() {
  var filters = bondSafetyExportFilters();
  var params = new URLSearchParams({
    search: filters.search,
    rating: filters.rating,
    sort: bondSafetyState.sortKey,
    dir: bondSafetyState.sortDir > 0 ? 'asc' : 'desc'
  });
  bondSafetySetExportButton(true, '导出中...');
  try {
    // 导出是二进制下载，走统一入口的"原始响应"分支，超时与网络异常同样归一。
    var exported = await window.siteApi.getRaw('/api/bond-safety/export?' + params.toString());
    if (!exported.ok) {
      var error = exported.response ? await exported.response.json().catch(function() { return {}; }) : {};
      throw new Error(error.error || exported.error || '导出失败');
    }
    var blob = await exported.response.blob();
    bondSafetyDownload(blob);
  } catch (error) {
    if (typeof showToast === 'function') showToast(error.message || String(error));
  } finally {
    bondSafetySetExportButton(false, '导出Excel');
  }
}

async function loadBondSafety(force) {
  if (bondSafetyState.loaded && !force) return;
  bondSafetyShowLoading();
  try {
    var res = await window.siteApi.get('/api/bond-safety/bonds');
    var d = res.payload || {};
    if (!res.ok) throw new Error(d.error || '加载失败');
    bondSafetyState.rows = Array.isArray(d.data) ? d.data : [];
    bondSafetyState.loaded = true;
    bondSafetyShowUpdated(d);
    bondSafetyRenderStats(d);
    if (!d.data.length && !d.configured) {
      bondSafetyShowEmptySource();
      return;
    }
    bondSafetyApplyFilters();
  } catch(error) {
    bondSafetyShowError(error);
  }
}
