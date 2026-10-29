// 市场状态快照 Presenter（批次4：View／Presenter 分离）。
// 职责：经站内请求客户端刷新市场状态快照（唯一取数点），快照状态 marketStateSnapshot 仍由
//       utils.js 声明为全局 var（读方为 utils.js 与共享行情脚本，按名读取）。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验）；
//       纯格式化/工具函数在 utils.js（View）。取数经 window.siteApi（js/api/client.js 提供），
//       顶层只声明函数，调用发生在页面加载完成后，与 client.js 的先后不影响运行。

async function refreshMarketStateSnapshot() {
  try {
    var result = await window.siteApi.requestRaw('/api/market-state', { timeoutMs: 0, headers: {} });
    if (!result.response) return marketStateSnapshot;
    var response = result.response;
    if (!response.ok) return marketStateSnapshot;
    var snapshot = await response.json();
    if (snapshot && snapshot.businessDate && snapshot.markets) marketStateSnapshot = snapshot;
  } catch (e) {}
  return marketStateSnapshot;
}
