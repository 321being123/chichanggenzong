// 可转债下修博弈详情 Presenter（批次4：View／Presenter 分离）。
// 职责：校验可转债代码、读取评分快照并决定何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 window.BondRevisionMotiveView 暴露的入口；View 不取数，只渲染并上报用户操作。
function loadMotiveDetail(code) {
  if (!/^(110|111|113|118|123|127|128)\d{3}\.(SH|SZ)$/i.test(code)) {
    window.BondRevisionMotiveView.showError('缺少有效的可转债代码');
    return;
  }
  window.siteApi.requestRaw('/api/bond-revision/' + encodeURIComponent(code) + '/motive-detail', { cache: 'no-store', timeoutMs: 0, headers: {} })
    .then(function (result) { var response = result.response; if (!response) throw new Error(result.error || '读取失败'); if (!response.ok) throw new Error(response.status === 404 ? '尚无评分数据' : '读取失败'); return response.json(); })
    .then(function (data) {
      window.BondRevisionMotiveView.render(data);
      if (window.SiteTelemetry && window.SiteTelemetry.trackDetail) window.SiteTelemetry.trackDetail({ page_key: 'bond.revision', module: 'bond', entry: 'motive-detail', detail_key: 'motive', properties: { detail_type: 'motive' } });
    })
    .catch(function (error) { window.BondRevisionMotiveView.showError(error.message || '读取失败'); });
}
window.bondRevisionMotiveLoad = loadMotiveDetail;
