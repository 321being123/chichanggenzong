// 市场周期指标 Presenter（批次4：View／Presenter 分离）。
// 职责：持有指标/市场/区间与加载状态、首页配置读写、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var mvcState = { metric: 'pe', market: 'CN', benchmark: 'CSI300', range: '20y', overview: null, history: [], loading: false, ready: false };
var marketCycleHomeConfig = null;
async function loadMarketCycleHomeConfig() {
  try{
    var res=await window.siteApi.get('/api/market-volatility/home-cycle/config');
    if(res.ok)marketCycleHomeConfig=res.payload;
  }catch(error){}
  updateMarketCycleHomeButtons();
}
async function setMarketCycleHome(metric,market,benchmark) {
  if(!marketCycleIsAdmin())return;
  var account=mvcAccount();
  if(!account){showToast('请先选择账户');return;}
  try{
    var response=await window.siteApi.put('/api/market-volatility/home-cycle/config',{
      metric:metric,market:market,benchmark:benchmark,accountName:account
    },{credentials:'same-origin'});
    var json=response.payload||{};if(!response.ok)throw new Error(json.error||response.status);
    marketCycleHomeConfig=json;updateMarketCycleHomeButtons();showToast('已设为首页');
  }catch(error){showToast('设置失败：'+(error.message||error));}
}
async function mvcLoad() {
  if(mvcState.loading)return; mvcState.loading=true; mvcSetStatus('正在读取数据...');
  try{
    // 同 loadMarketVolatility：等账户列表就绪后再取 mvcAccount()，避免占位账户「默认账户」触发 403
    if(window.accountDataReady){try{await window.accountDataReady;}catch(err){}}
    var qs='metric='+encodeURIComponent(mvcState.metric)+'&market='+encodeURIComponent(mvcState.market)+'&benchmark='+encodeURIComponent(mvcState.benchmark);
    var responses=await Promise.all([
      window.siteApi.get('/api/market-volatility/overview?'+qs+'&account='+encodeURIComponent(mvcAccount())),
      window.siteApi.get('/api/market-volatility/history?'+qs+'&range='+encodeURIComponent(mvcState.range))
    ]);
    if(!responses[0].ok||!responses[1].ok)throw new Error('接口返回 '+(!responses[0].ok?responses[0].status:responses[1].status));
    mvcState.overview=responses[0].payload;mvcState.history=(responses[1].payload||{}).history||[];mvcRender();
  }catch(error){mvcSetLoadError(error);}
  finally{mvcState.loading=false;}
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
  try{
    var response=await window.siteApi.put('/api/market-volatility/settings',{
      metric:mvcState.metric,market:mvcState.market,benchmark:mvcState.benchmark,accountName:account,lowerBoundaryPct:lower,upperBoundaryPct:upper,version:setting?setting.version:0
    },{credentials:'same-origin'});
    var json=response.payload||{};if(!response.ok)throw new Error(json.error||response.status);
    await mvcLoad();mvcSetSaveBusy(true);showToast('边界保存成功');
  }catch(error){
    mvcSetSaveBusy(false);showToast('保存失败：'+(error.message||error));
  }finally{
    mvcSetSaveText('保存边界');
  }
}
