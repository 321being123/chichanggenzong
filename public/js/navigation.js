// ============== 一级页面切换与导航状态（FRONT-01 拆分，第一期） ==============
// 从 index.html 内联脚本抽取：switchMain / 主导航绑定 / 下拉 / URL 同步(pushState + popstate)。
// 依赖全局：username（session.js）、ACCESS_POLICY（access-policy.js）、各页面 load* 入口。
// 加载入口（loadHomeDashboard / loadProfile / loadIpo ...）仍由各页面/内联脚本定义，
// 此处只做分发，保持 DOM ID / API / 业务结果兼容。

// 一级页面切换（首页 / 持仓管理 / 个人中心 / 版本记录）
function switchMain(main, noPushState) {
  if (!username && ACCESS_POLICY.requiresLogin(main)) {
    window.location.href = api('/login.html?redirect=' + encodeURIComponent('/?main=' + main));
    return;
  }
  // 同步地址栏：首页清掉参数，其他页面带上 ?main=，可转债保留 sub
  if (!noPushState) {
    var params = new URLSearchParams(window.location.search);
    if (main === 'home') { while (params.toString()) { params.delete(params.keys().next().value); } }
    else { params.set('main', main); if (main !== 'bond-safety') params.delete('sub'); }
    if (main !== 'arbitrage') { params.delete('case'); params.delete('arb_type'); }
    var newUrl = params.toString() ? '/?' + params.toString() : '/';
    if (window.location.pathname + window.location.search !== newUrl) {
      history.pushState(null, '', newUrl);
    }
  }
  document.querySelectorAll('.main-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.main === main); });
  document.querySelectorAll('.main-page').forEach(function (p) { p.classList.remove('active'); });
  const mp = document.getElementById('main-' + main);
  if (mp) mp.classList.add('active');
  if (main === 'profile') loadProfile();
  if (main === 'changelog') loadChangelogPage();
  if (main === 'ipo') loadIpo();
  if (main === 'bond-safety') { loadBondSafety(); if (typeof initBondCycleSub === 'function') initBondCycleSub(); }
  if (main === 'stock-analysis') loadStockAnalysis();
  if (main === 'market-volatility') loadMarketVolatility();
  if (main === 'arbitrage') loadArbitrage();
  if (main === 'knowledge') loadKnowledge();
  if (main === 'home') loadHomeDashboard();
  if (main === 'holdings' && username && typeof doAutoRefresh === 'function') {
    doAutoRefresh().catch(function (e) { showToast('行情刷新失败: ' + (e.message || e)); });
  }
  // 仓位对比页：进入时若已有对比数据则重渲染，否则停留在空态（由标杆选择进入）
  if (main === 'position-compare' && window.PositionComparison && typeof window.PositionComparison.onPageEnter === 'function') {
    window.PositionComparison.onPageEnter();
  }
}

function setupMainNav() {
  document.querySelectorAll('.main-tab').forEach(function (tab) {
    tab.addEventListener('click', function () { switchMain(tab.dataset.main); });
  });
  window.addEventListener('popstate', function () {
    var params = new URLSearchParams(window.location.search);
    switchMain(params.get('main') || 'home', true);
  });
}

// 从首页功能卡跳转到持仓管理指定二级页
function goHoldings(page) {
  switchMain('holdings');
  const tab = document.querySelector('.sub-nav .nav-tab[data-page="' + page + '"]');
  if (tab) tab.click();
}

window.AppNav = { switchMain: switchMain, goHoldings: goHoldings };
