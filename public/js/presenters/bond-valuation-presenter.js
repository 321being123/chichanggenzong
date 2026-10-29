// 可转债估值 Presenter（批次4：View／Presenter 分离）。
// 职责：持有估值数据与加载/详情状态（bondValState）、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。

var bondValState = { data: null, loading: false, sortKey: '__default__', sortDir: 'asc', detailCode: null, seq: 0 };

// ---------- 加载列表 ----------
async function loadBondValuation() {
  // 请求序号守卫（防旧响应覆盖新状态）：列表/详情/区间历史共用 bondValState.seq，
  // 每次取数领新序号作废旧请求，旧响应直接丢弃（不渲染、不写状态、不提示）；loading 仅作 UI 提示，不再拦截新调用。
  var seq = (bondValState.seq = (bondValState.seq || 0) + 1);
  bondValState.loading = true;
  window.bondValSetStatus('正在读取估值数据...');
  try {
    var res = await window.siteApi.get('/api/bond-valuation/bonds');
    if (bondValState.seq !== seq) return;
    if (!res.ok) throw new Error('接口返回 ' + res.status);
    var json = res.payload;
    bondValState.data = json;
    window.renderBondValOverview(json);
    bondValState.loading = false;
    window.bondValSetStatus('');
    if (json.detailCode) bondValState.detailCode = json.detailCode;
    // 直接带 bond 参数进入详情
    var params = new URLSearchParams(window.location.search);
    var bond = params.get('bond');
    if (bond) { openBondValDetail(bond); }
    else { window.renderBondValTable(); }
  } catch (e) {
    if (bondValState.seq !== seq) return;
    bondValState.loading = false;
    window.bondValSetStatus('数据加载失败：' + (e.message || e));
  }
}

// ---------- 详情（取数三并发；pushState 与列表/详情切换在 View） ----------
function openBondValDetail(code, skipPush) {
  bondValState.detailCode = code;
  window.bondValEnterDetail(code, skipPush);

  // 取数段开头领序号：旧详情响应不得覆盖新详情/新区间选择。
  var seq = (bondValState.seq = (bondValState.seq || 0) + 1);
  Promise.all([
    window.siteApi.get('/api/bond-valuation/bonds/' + encodeURIComponent(code)),
    window.siteApi.get('/api/bond-valuation/bonds/' + encodeURIComponent(code) + '/history?range=all'),
    window.siteApi.get('/api/bond-valuation/bonds/' + encodeURIComponent(code) + '/alerts')
  ]).then(function (results) {
    if (bondValState.seq !== seq) return;
    // 统一检查 HTTP 状态（404 的详情/历史允许继续渲染错误提示）
    return results.map(function (r) {
      if (!r.ok && r.status !== 404) throw new Error('接口返回 ' + r.status);
      return r.payload;
    });
  })
    .then(function (out) {
      if (bondValState.seq !== seq) return;
      window.renderBondValDetail(out[0], out[1], out[2]);
    })
    .catch(function (e) {
      if (bondValState.seq !== seq) return;
      window.bondValShowDetailError(e);
    });
}

// ---------- 区间历史 ----------
function bondValReloadHistory(code, range, btn) {
  // 请求序号守卫：区间切换领新序号，旧区间响应不得覆盖新选择。
  var seq = (bondValState.seq = (bondValState.seq || 0) + 1);
  window.bondValShowHistoryLoading(btn);
  window.siteApi.get('/api/bond-valuation/bonds/' + encodeURIComponent(code) + '/history?range=' + range)
    .then(function (r) {
      if (bondValState.seq !== seq) return;
      return r.payload;
    }).then(function (h) {
      if (bondValState.seq !== seq) return;
      window.drawBondValCharts((h && h.data) || [], h && h.boundaries);
    })
    .catch(function (e) {
      if (bondValState.seq !== seq) return;
      window.bondValShowHistoryError(e);
    });
}
