// 首页仪表盘 Presenter（批次4：View／Presenter 分离）。
// 职责：持有首页卡片加载状态、经 siteApi 取数（fetchHomeJson 包装）、决定何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口（window.home*）；View 不取数，只渲染。
//       渲染段（原 loadHomeDashboard / loadHomeMarketCycles / renderHomeArticles 内的 DOM 行）
//       下沉到 home-dashboard.js 的 window.home* 新入口，由本文件经 window 调用。
// 全局保留：loadHomeDashboard / loadHomeMarketCycles / renderHomeArticles / fetchHomeJson
//       （navigation.js、内联脚本与卡片重试按钮按名调用，函数名不变）。
var homeDashboardLoading = false;
var homeMarketCyclesLoading = false;
var homeMarketCyclesLoaded = false;
// 账户切换守卫（2026-10-29 验收反例修复）：身份（登录名＋账户实体）变化即作废在途请求、
// 清 loading/loaded 保证切换后能发起新请求，旧响应不得写入新身份页面。
var homeDash = { epoch: 0 };
function homeBegin() {
  var user = typeof username === 'string' ? username : '';
  var identity = typeof accountIdentity === 'string' ? accountIdentity : '';
  if (homeDash.ownerUser !== user || homeDash.ownerIdentity !== identity) {
    homeDash.ownerUser = user; homeDash.ownerIdentity = identity;
    homeDash.epoch = (homeDash.epoch || 0) + 1;
    homeDashboardLoading = false; homeMarketCyclesLoading = false; homeMarketCyclesLoaded = false;
  }
  var epoch = homeDash.epoch;
  return function current() {
    return homeDash.epoch === epoch
      && user === (typeof username === 'string' ? username : '')
      && identity === (typeof accountIdentity === 'string' ? accountIdentity : '');
  };
}

async function fetchHomeJson(path) {
  // 传入站内路径（不含 API 前缀），拼接与发送统一由入口负责。
  var res = await window.siteApi.get(path);
  if (!res.ok) return { ok: false, error: new Error(res.error || ('接口返回 ' + res.status)) };
  return { ok: true, data: res.payload };
}

async function loadHomeMarketCycles() {
  var current = homeBegin();
  if (homeMarketCyclesLoading || homeMarketCyclesLoaded) return;
  homeMarketCyclesLoading = true;
  try {
    // 两张周期卡各自成败，互不拖累（2026-10-21 审查 U-19）
    var responses = await Promise.all([
      fetchHomeJson('/api/bond-cycle?range=all&view=home&maxPoints=800'),
      fetchHomeJson('/api/market-volatility/home-cycle?range=20y')
    ]);
    if (!current()) return;
    window.homePaintMarketCycles(responses);
    homeMarketCyclesLoaded = responses[0].ok && responses[1].ok;
  } catch (error) {
    if (!current()) return;
    console.error('首页市场周期加载失败', error);
    window.homePaintMarketCyclesError(error);
  } finally {
    if (current()) homeMarketCyclesLoading = false;
  }
}

async function loadHomeDashboard() {
  var current = homeBegin();
  renderHomeHoldings();
  window.homeApplyDashboardOrder();
  // 最新文章独立加载，不等待 IPO/债券接口，避免被大数据接口阻塞
  renderHomeArticles();
  loadHomeMarketCycles();
  if (homeDashboardLoading) return;
  homeDashboardLoading = true;
  try {
    var results = await Promise.all([fetchHomeJson('/api/ipo/calendar?days=90'), fetchHomeJson('/api/bond-safety/bonds?view=summary')]);
    if (!current()) return;
    window.homePaintDashboardResults(results);
  } catch (error) {
    if (!current()) return;
    console.error('首页数据加载失败', error);
  } finally { if (current()) homeDashboardLoading = false; }
}

async function renderHomeArticles() {
  var current = homeBegin();
  if (!window.homeArticlesReady()) return;
  try {
    var res = await window.siteApi.get('/api/knowledge/latest?limit=5');
    if (!current()) return;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var list = res.payload;
    if (!Array.isArray(list)) throw new Error('返回格式错误');
    window.homePaintArticles(list);
  } catch (e) {
    if (!current()) return;
    window.homePaintArticlesError(e);
  }
}
