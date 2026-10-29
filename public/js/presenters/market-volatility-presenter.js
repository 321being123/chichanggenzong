// 市场波动 Presenter（批次4：View／Presenter 分离）。
// 职责：持有市场/基准/区间与加载状态、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var mvState = { market: 'CN', benchmark: 'CSI300', range: '20y', overview: null, history: [], draft: null, loading: false, seq: 0 };
// 账户切换守卫：请求绑定登录名＋账户实体＋账户名与请求序号；身份变化即作废在途请求、清 loading 与旧结果，
// 保证切换后能发起新请求，旧响应不得写入新身份页面（2026-10-29 验收反例修复）。
function mvBeginLoad() {
  var user = typeof username === 'string' ? username : '';
  var identity = typeof accountIdentity === 'string' ? accountIdentity : '';
  var account = mvAccount();
  if (mvState.ownerUser !== user || mvState.ownerIdentity !== identity || mvState.ownerAccount !== account) {
    mvState.ownerUser = user; mvState.ownerIdentity = identity; mvState.ownerAccount = account;
    if (typeof mvSetSaveText === 'function') mvSetSaveText('保存边界');
    mvState.loading = false; mvState.overview = null; mvState.history = []; mvState.draft = null;
    mvState.seq = (mvState.seq || 0) + 1;
  }
  var requestKey = JSON.stringify([mvState.market, mvState.benchmark, mvState.range]);
  if (mvState.loading && mvState.loadingKey === requestKey) return null;
  mvState.loadingKey = requestKey;
  var seq = (mvState.seq || 0) + 1;
  mvState.seq = seq;
  return {
    user: user, identity: identity, account: account, seq: seq,
    current: function () {
      return mvState.seq === seq
        && user === (typeof username === 'string' ? username : '')
        && identity === (typeof accountIdentity === 'string' ? accountIdentity : '')
        && account === mvAccount();
    }
  };
}
async function loadMarketVolatility() {
  initMarketVolatility();
  // 初始化期间账户名可能从占位值变成真实账户；等待完成后再绑定守卫。
  var initialUser = typeof username === 'string' ? username : '';
  var initialIdentity = typeof accountIdentity === 'string' ? accountIdentity : '';
  if (window.accountDataReady) {
    mvSetStatus('正在读取数据...');
    try { await window.accountDataReady; } catch (err) {}
    if (initialUser !== (typeof username === 'string' ? username : '')
      || initialIdentity !== (typeof accountIdentity === 'string' ? accountIdentity : '')) return;
  }
  var guard = mvBeginLoad();
  if (!guard) return;
  var account = guard.account;
  mvState.loading = true; mvSetStatus('正在读取数据...');
  try {
    var qs = 'market=' + encodeURIComponent(mvState.market) + '&benchmark=' + encodeURIComponent(mvState.benchmark);
    // 仍并发两个请求（互相不依赖，串行会白白多等一个往返），只是发送统一走入口。
    var both = await Promise.all([
      window.siteApi.get('/api/market-volatility/overview?' + qs + '&account=' + encodeURIComponent(account)),
      window.siteApi.get('/api/market-volatility/history?' + qs + '&range=' + encodeURIComponent(mvState.range)),
    ]);
    if (!guard.current()) return;
    if (!both[0].ok || !both[1].ok) throw new Error('接口返回 ' + (!both[0].ok ? both[0].status : both[1].status));
    mvState.overview = both[0].payload; mvState.history = (both[1].payload || {}).history || [];
    mvState.draft = null; mvRender();
  } catch (e) { if (guard.current()) mvSetLoadError(e); }
  finally { if (guard.current()) mvState.loading = false; }
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
  var saveUser = typeof username === 'string' ? username : '';
  var saveIdentity = typeof accountIdentity === 'string' ? accountIdentity : '';
  function saveCurrent() {
    return saveUser === (typeof username === 'string' ? username : '')
      && saveIdentity === (typeof accountIdentity === 'string' ? accountIdentity : '')
      && account === mvAccount();
  }
  try {
    var r=await window.siteApi.put('/api/market-volatility/settings',{
      market:mvState.market,benchmark:mvState.benchmark,lowerBoundaryPct:d.lower,upperBoundaryPct:d.upper,accountName:account,version:d.version
    },{credentials:'same-origin'});
    if(!saveCurrent())return;
    var json=r.payload||{};if(!r.ok)throw new Error(json.error||r.status);
    mvState.draft=null;mvHideDraftControls();
    await loadMarketVolatility();if(!saveCurrent())return;showToast('边界保存成功');
  } catch(e) {
    if(saveCurrent()){mvSetSaveBusy(false);showToast('保存失败：'+(e.message||e));}
  } finally {
    if(saveCurrent())mvSetSaveText('保存边界');
  }
}
