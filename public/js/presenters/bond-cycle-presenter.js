// 可转债周期 Presenter（批次4：View／Presenter 分离）。
// 职责：持有周期数据与加载状态（bondCycleState）、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。

var bondCycleState = { range: 'all', metric: 'percentile', data: null, loading: false, seq: 0, visible: { percentile: true, composite: true, median_price: false, median_conversion_premium_pct: false } };

async function loadBondCycle() {
  if (!bondCycleState.data) {
    // 请求序号守卫（防旧响应覆盖新状态）：真正发请求才领序号，旧响应直接丢弃（不渲染、不写状态、不提示）。
    // loading 仅作 UI 提示，不再拦截新调用，每次取数都领新序号作废旧请求。
    var seq = (bondCycleState.seq = (bondCycleState.seq || 0) + 1);
    bondCycleState.loading = true;
    bondCycleSetStatus('正在读取周期数据...');
    try {
      // 批次4：取数统一走 siteApi（View 不直接 fetch）
      var r = await window.siteApi.get('/api/bond-cycle?range=' + encodeURIComponent(bondCycleState.range));
      if (bondCycleState.seq !== seq) return;
      if (!r.ok) throw new Error('接口返回 ' + r.status);
      bondCycleState.data = r.payload;
    } catch (e) {
      if (bondCycleState.seq !== seq) return;
      bondCycleState.loading = false;
      bondCycleSetStatus('数据加载失败：' + (e.message || e));
      return;
    }
    if (bondCycleState.seq === seq) bondCycleState.loading = false;
  }
  renderBondCycle(bondCycleState.data);
}
