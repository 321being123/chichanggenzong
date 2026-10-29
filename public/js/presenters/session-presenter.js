// 登录态与通知轮询 Presenter（批次4：View／Presenter 分离）。
// 职责：登录态请求（/api/me、/api/logout）与未读数轮询取数，持有响应序号防旧响应覆盖。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       铃铛/头像渲染与退出跳转在 session.js（View），需要改界面时经 window 全局回调 View；
//       View 不取数，只渲染。登录态变量（username / myProfile / accountIdentity）与轮询句柄
//       （notifPoll）仍在 session.js 声明，供其他脚本按名读取，本文件按名读写。
// 未读数：旧响应不能覆盖新结果（seq 递增作废），换账号后旧响应直接丢弃
async function refreshUnreadCount() {
  if (!username) { window.resetBell(); return null; }
  var seq = ++notifPoll.seq;
  var who = username;
  try {
    var result = await window.siteApi.requestRaw('/api/notifications/unread-count', { timeoutMs: 0, headers: {} });
    if (!result.response) throw new Error(result.error || '网络异常');
    var r = result.response;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var d = await r.json();
    if (seq !== notifPoll.seq || who !== username) return null;
    var total = Number(d && d.total);
    notifPoll.total = Number.isFinite(total) && total > 0 ? total : 0;
    window.paintBell(notifPoll.total);
    return d;
  } catch (e) {
    if (seq !== notifPoll.seq || who !== username) return null;
    // 失败保留旧数并提示重试，绝不伪装成 0
    window.paintBell(notifPoll.total);
    return null;
  }
}

async function checkAuth() {
  const previousUser = username, previousIdentity = accountIdentity;
  function invalidateIfChanged() {
    if ((previousUser !== username || previousIdentity !== accountIdentity) && typeof window.invalidateSmartImportScope === 'function') window.invalidateSmartImportScope();
    if ((previousUser !== username || previousIdentity !== accountIdentity) && typeof window.securityAnalysisResetAccount === 'function') window.securityAnalysisResetAccount();
  }
  try {
    const result = await window.siteApi.requestRaw('/api/me', { timeoutMs: 0, headers: {} });
    if (!result.response) throw new Error(result.error || '网络异常');
    const r = result.response;
    const d = await r.json();
    if (!d.username) {
      username = null; myProfile = null; accountIdentity = ''; invalidateIfChanged(); window.stopNotificationPolling(); window.clearNotificationCache(); window.renderTopUser(null); return false;
    }
    username = d.username;
    myProfile = d;
    accountIdentity = String(d.accountIdentity || '');
    invalidateIfChanged();
    window.renderAuthUser(d);
    window.startNotificationPolling();
    return true;
  } catch (e) {
    username = null; myProfile = null; accountIdentity = ''; invalidateIfChanged(); window.stopNotificationPolling(); window.clearNotificationCache(); window.renderTopUser(null); return false;
  }
}

async function logout() {
  window.stopNotificationPolling();
  window.clearNotificationCache();
  if (typeof window.invalidateSmartImportScope === 'function') window.invalidateSmartImportScope();
  if (typeof window.securityAnalysisResetAccount === 'function') window.securityAnalysisResetAccount();
  accountIdentity = '';
  const result = await window.siteApi.requestRaw('/api/logout', { method: 'POST', timeoutMs: 0, headers: {} });
  if (!result.response) throw new Error(result.error || '网络异常');
  window.redirectAfterLogout();
}
