// 可转债周期 Presenter（批次4：View／Presenter 分离）。
// 职责：持有周期数据与加载状态（bondCycleState）、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。

var bondCycleState = { range: 'all', metric: 'percentile', data: null, loading: false, visible: { percentile: true, composite: true, median_price: false, median_conversion_premium_pct: false } };

async function loadBondCycle() {
  if (bondCycleState.loading) return;
  if (!bondCycleState.data) {
    bondCycleState.loading = true;
    bondCycleSetStatus('正在读取周期数据...');
    try {
      // 批次4：取数统一走 siteApi（View 不直接 fetch）
      var r = await window.siteApi.get('/api/bond-cycle?range=' + encodeURIComponent(bondCycleState.range));
      if (!r.ok) throw new Error('接口返回 ' + r.status);
      bondCycleState.data = r.payload;
    } catch (e) {
      bondCycleState.loading = false;
      bondCycleSetStatus('数据加载失败：' + (e.message || e));
      return;
    }
    bondCycleState.loading = false;
  }
  renderBondCycle(bondCycleState.data);
}
