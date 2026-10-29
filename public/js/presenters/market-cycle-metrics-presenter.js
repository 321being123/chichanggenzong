// 市场周期指标 Presenter（批次4：View／Presenter 分离）。
// 职责：持有指标/市场/区间与加载状态、首页配置读写、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var mvcState = { metric: 'pe', market: 'CN', benchmark: 'CSI300', range: '20y', overview: null, history: [], loading: false, ready: false, seq: 0 };
var marketCycleHomeConfig = null;
// 账户切换守卫：请求绑定登录名＋账户实体＋账户名与请求序号；身份变化即作废在途请求、清 loading 与旧结果，
// 保证切换后能发起新请求，旧响应不得写入新身份页面（2026-10-29 验收反例修复，同 market-volatility）。
function mvcBeginLoad() {
  var user = typeof username === 'string' ? username : '';
  var identity = typeof accountIdentity === 'string' ? accountIdentity : '';
  var account = mvcAccount();
  if (mvcState.ownerUser !== user || mvcState.ownerIdentity !== identity || mvcState.ownerAccount !== account) {
    mvcState.ownerUser = user; mvcState.ownerIdentity = identity; mvcState.ownerAccount = account;
    if (typeof mvcSetSaveText === 'function') mvcSetSaveText('保存边界');
    mvcState.loading = false; mvcState.overview = null; mvcState.history = [];
    mvcState.seq = (mvcState.seq || 0) + 1;
  }
  var requestKey = JSON.stringify([mvcState.metric, mvcState.market, mvcState.benchmark, mvcState.range]);
  if (mvcState.loading && mvcState.loadingKey === requestKey) return null;
  mvcState.loadingKey = requestKey;
  var seq = (mvcState.seq || 0) + 1;
  mvcState.seq = seq;
  return {
    user: user, identity: identity, account: account, seq: seq,
    current: function () {
      return mvcState.seq === seq
        && user === (typeof username === 'string' ? username : '')
        && identity === (typeof accountIdentity === 'string' ? accountIdentity : '')
        && account === mvcAccount();
    }
  };
}
async function loadMarketCycleHomeConfig() {
  var user = typeof username === 'string' ? username : '';
  var identity = typeof accountIdentity === 'string' ? accountIdentity : '';
  try{
    var res=await window.siteApi.get('/api/market-volatility/home-cycle/config');
    if (user !== (typeof username === 'string' ? username : '') || identity !== (typeof accountIdentity === 'string' ? accountIdentity : '')) return;
    if(res.ok)marketCycleHomeConfig=res.payload;
  }catch(error){}
  updateMarketCycleHomeButtons();
}
async function setMarketCycleHome(metric,market,benchmark) {
  if(!marketCycleIsAdmin())return;
  var account=mvcAccount();
  if(!account){showToast('请先选择账户');return;}
  var saveUser = typeof username === 'string' ? username : '';
  var saveIdentity = typeof accountIdentity === 'string' ? accountIdentity : '';
  function saveCurrent() {
    return saveUser === (typeof username === 'string' ? username : '')
      && saveIdentity === (typeof accountIdentity === 'string' ? accountIdentity : '')
      && account === mvcAccount();
  }
  try{
    var response=await window.siteApi.put('/api/market-volatility/home-cycle/config',{
      metric:metric,market:market,benchmark:benchmark,accountName:account
    },{credentials:'same-origin'});
    if(!saveCurrent())return;
    var json=response.payload||{};if(!response.ok)throw new Error(json.error||response.status);
    marketCycleHomeConfig=json;updateMarketCycleHomeButtons();showToast('已设为首页');
  }catch(error){if(saveCurrent())showToast('设置失败：'+(error.message||error));}
}
async function mvcLoad() {
  // 先等账户初始化，避免将占位账户绑定为请求身份。
  var initialUser = typeof username === 'string' ? username : '';
  var initialIdentity = typeof accountIdentity === 'string' ? accountIdentity : '';
  if (window.accountDataReady) {
    mvcSetStatus('正在读取数据...');
    try { await window.accountDataReady; } catch (err) {}
    if (initialUser !== (typeof username === 'string' ? username : '')
      || initialIdentity !== (typeof accountIdentity === 'string' ? accountIdentity : '')) return;
  }
  var guard = mvcBeginLoad();
  if (!guard) return;
  mvcState.loading=true; mvcSetStatus('正在读取数据...');
  try{
    var qs='metric='+encodeURIComponent(mvcState.metric)+'&market='+encodeURIComponent(mvcState.market)+'&benchmark='+encodeURIComponent(mvcState.benchmark);
    var responses=await Promise.all([
      window.siteApi.get('/api/market-volatility/overview?'+qs+'&account='+encodeURIComponent(mvcAccount())),
      window.siteApi.get('/api/market-volatility/history?'+qs+'&range='+encodeURIComponent(mvcState.range))
    ]);
    if(!guard.current())return;
    if(!responses[0].ok||!responses[1].ok)throw new Error('接口返回 '+(!responses[0].ok?responses[0].status:responses[1].status));
    mvcState.overview=responses[0].payload;mvcState.history=(responses[1].payload||{}).history||[];mvcRender();
  }catch(error){if(guard.current())mvcSetLoadError(error);}
  finally{if(guard.current())mvcState.loading=false;}
}
async function mvcSave(){
  var setting=mvcState.overview&&mvcState.overview.setting,bounds=mvcReadBoundaries(),lower=bounds.lower,upper=bounds.upper,account=mvcAccount();
  if(typeof username!=='string'||!username){
    window.location.href=api('/login.html?redirect='+encodeURIComponent('/?main=market-volatility&metric='+mvcState.metric));
    return;
  }
  if(!account){showToast('请先选择账户后再保存');return;}
  if(!(lower>0&&upper>lower)){showToast('边界值无效，请重新拖动');return;}
  mvcSetSaveBusy(true);mvcSetSaveText('保存中...');
  var saveUser = typeof username === 'string' ? username : '';
  var saveIdentity = typeof accountIdentity === 'string' ? accountIdentity : '';
  function saveCurrent() {
    return saveUser === (typeof username === 'string' ? username : '')
      && saveIdentity === (typeof accountIdentity === 'string' ? accountIdentity : '')
      && account === mvcAccount();
  }
  try{
    var response=await window.siteApi.put('/api/market-volatility/settings',{
      metric:mvcState.metric,market:mvcState.market,benchmark:mvcState.benchmark,accountName:account,lowerBoundaryPct:lower,upperBoundaryPct:upper,version:setting?setting.version:0
    },{credentials:'same-origin'});
    if(!saveCurrent())return;
    var json=response.payload||{};if(!response.ok)throw new Error(json.error||response.status);
    await mvcLoad();if(!saveCurrent())return;mvcSetSaveBusy(true);showToast('边界保存成功');
  }catch(error){
    if(saveCurrent()){mvcSetSaveBusy(false);showToast('保存失败：'+(error.message||error));}
  }finally{
    if(saveCurrent())mvcSetSaveText('保存边界');
  }
}
