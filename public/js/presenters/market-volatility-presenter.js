// 市场波动 Presenter（批次4：View／Presenter 分离）。
// 职责：持有市场/基准/区间与加载状态、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var mvState = { market: 'CN', benchmark: 'CSI300', range: '20y', overview: null, history: [], draft: null, loading: false };
async function loadMarketVolatility() {
  initMarketVolatility(); if (mvState.loading) return;
  var account = mvAccount();
  mvState.loading = true; mvSetStatus('正在读取数据...');
  try {
    // 账户列表后台异步加载；未就绪时 currentAccount 仍是占位值「默认账户」，
    // 直接发请求会被账户归属校验拒为 403（深链/登录回跳进入本页时必现），须等就绪后重取。
    if (window.accountDataReady) { try { await window.accountDataReady; } catch (err) {} }
    account = mvAccount();
    var qs = 'market=' + encodeURIComponent(mvState.market) + '&benchmark=' + encodeURIComponent(mvState.benchmark);
    // 仍并发两个请求（互相不依赖，串行会白白多等一个往返），只是发送统一走入口。
    var both = await Promise.all([
      window.siteApi.get('/api/market-volatility/overview?' + qs + '&account=' + encodeURIComponent(account)),
      window.siteApi.get('/api/market-volatility/history?' + qs + '&range=' + encodeURIComponent(mvState.range)),
    ]);
    if (!both[0].ok || !both[1].ok) throw new Error('接口返回 ' + (!both[0].ok ? both[0].status : both[1].status));
    mvState.overview = both[0].payload; mvState.history = (both[1].payload || {}).history || [];
    mvState.draft = null; mvRender();
  } catch (e) { mvSetLoadError(e); }
  finally { mvState.loading = false; }
}
async function mvSaveDraft() {
  var d=mvState.draft,account=mvAccount();
  if(!d){showToast('请先拖动边界后再保存');return;}
  if(!username){
    window.location.href=api('/login.html?redirect='+encodeURIComponent('/?main=market-volatility&metric=graham'));
    return;
  }
  if(!account){showToast('请先选择账户后再保存');return;}
  mvSetSaveBusy(true);mvSetSaveText('保存中...');
  try {
    var r=await window.siteApi.put('/api/market-volatility/settings',{
      market:mvState.market,benchmark:mvState.benchmark,lowerBoundaryPct:d.lower,upperBoundaryPct:d.upper,accountName:account,version:d.version
    },{credentials:'same-origin'});
    var json=r.payload||{};if(!r.ok)throw new Error(json.error||r.status);
    mvState.draft=null;mvHideDraftControls();
    await loadMarketVolatility();showToast('边界保存成功');
  } catch(e) {
    mvSetSaveBusy(false);showToast('保存失败：'+(e.message||e));
  } finally {
    mvSetSaveText('保存边界');
  }
}
