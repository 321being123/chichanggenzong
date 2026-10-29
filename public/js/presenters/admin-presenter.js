// admin-presenter.js（批次4 P/V 拆分）：管理后台全部站内请求的构造与发送。
// 职责：URL/方法/请求体构造 + siteApi 调用；零 DOM。渲染、表单读写与提示留在 admin.js（View）。
// 本文件由 2026-10-29 分层整改从 admin.js 抽出，函数体与原请求语句逐字一致。

async function adminFetchMe() { return window.siteApi.get('/api/me'); }
async function adminPostLogout() { return window.siteApi.post('/api/logout', {}); }
async function adminFetchOverview() { return window.siteApi.get('/api/admin/overview'); }
async function adminFetchUsers(search, limit, offset) {
  return window.siteApi.get('/api/admin/users?search=' + encodeURIComponent(search) + '&limit=' + limit + '&offset=' + offset);
}
async function adminPostUserStatus(username, status) {
  return window.siteApi.request('/api/admin/users/' + encodeURIComponent(username) + '/status', {
    method: 'POST', headers: window.siteApi.jsonHeaders(),
    body: JSON.stringify({ status: status })
  });
}
async function adminPostUserRole(username, role) {
  return window.siteApi.request('/api/admin/users/' + encodeURIComponent(username) + '/role', {
    method: 'POST', headers: window.siteApi.jsonHeaders(),
    body: JSON.stringify({ role: role })
  });
}
async function adminPostUserPassword(username, password) {
  return window.siteApi.request('/api/admin/users/' + encodeURIComponent(username) + '/password', {
    method: 'POST', headers: window.siteApi.jsonHeaders(),
    body: JSON.stringify({ password: password })
  });
}
async function adminDelUser(username) { return window.siteApi.del('/api/admin/users/' + encodeURIComponent(username)); }
async function adminFetchUserDetail(username) { return window.siteApi.get('/api/admin/users/' + encodeURIComponent(username)); }
async function adminFetchBrokers(qs) { return window.siteApi.get('/api/admin/brokers?' + qs); }
function adminFetchBrokerDetail(code) { return window.siteApi.get('/api/admin/brokers/' + encodeURIComponent(code)); }
async function adminSaveBrokerReq(url, method, body) {
  return window.siteApi.request(url, { method: method, headers: window.siteApi.jsonHeaders(), body: JSON.stringify(body) });
}
async function adminDeleteBrokerReq(code) { return window.siteApi.del('/api/admin/brokers/' + encodeURIComponent(code)); }
async function adminImportFed(form) { return window.siteApi.request('/api/market-volatility/federal-funds/import', { method: 'POST', body: form }); }
async function adminFetchJobs(limit) { return window.siteApi.get('/api/admin/jobs?limit=' + limit); }
function adminFetchJobSlot(slotId) { return window.siteApi.get('/api/admin/jobs/slots/' + encodeURIComponent(slotId)); }
async function adminRetryJobSlot(slotId) { return window.siteApi.post('/api/admin/jobs/slots/' + encodeURIComponent(slotId) + '/retry', {}); }
async function adminValidateJobSlot(slotId) { return window.siteApi.post('/api/admin/jobs/slots/' + encodeURIComponent(slotId) + '/validate', {}); }
async function adminAckJobSlot(slotId) { return window.siteApi.post('/api/admin/jobs/slots/' + encodeURIComponent(slotId) + '/acknowledge', {}); }
async function adminTestAlertEmail() { return window.siteApi.post('/api/admin/jobs/alert-email/test', {}); }
function adminFetchJobsOverview() { return window.siteApi.get('/api/admin/jobs/overview'); }
function adminFetchJobSlots(query) { return window.siteApi.get('/api/admin/jobs/slots?limit=100' + query); }
function adminFetchJobNotices(limit) { return window.siteApi.get('/api/admin/jobs/notifications?limit=' + limit); }
function adminFetchJobNoticeHistory(limit) { return window.siteApi.get('/api/admin/jobs/notifications?status=history&limit=' + limit); }
async function adminResendJobAlert(alertId) { return window.siteApi.post('/api/admin/jobs/notifications/' + encodeURIComponent(alertId) + '/resend', {}); }
async function adminAckJobAlert(alertId) { return window.siteApi.post('/api/admin/jobs/alerts/' + encodeURIComponent(alertId) + '/acknowledge', {}); }
async function adminPostBackfill() { return window.siteApi.post('/api/admin/jobs/backfill', {}); }
async function adminPostHolidaySync() { return window.siteApi.post('/api/admin/jobs/holiday-sync', {}); }
function adminFetchSettings() { return window.siteApi.get('/api/admin/settings'); }
async function adminPutPolicies(policies) {
  return window.siteApi.request('/api/admin/settings/external-api/tushare/policies', { method: 'PUT', headers: window.siteApi.jsonHeaders(), body: JSON.stringify({ policies: policies }) });
}
async function adminPutSettings(body) {
  return window.siteApi.request('/api/admin/settings', { method: 'PUT', headers: window.siteApi.jsonHeaders(), body: JSON.stringify(body) });
}
async function adminSwitchExternal(provider, mode) {
  return window.siteApi.request('/api/admin/settings/external-api/' + encodeURIComponent(provider) + '/switch', { method: 'POST', headers: window.siteApi.jsonHeaders(), body: JSON.stringify({ mode: mode }) });
}
async function adminTestExternal(provider, role, apiName) {
  return window.siteApi.request('/api/admin/settings/external-api/' + encodeURIComponent(provider) + '/test', { method: 'POST', headers: window.siteApi.jsonHeaders(), body: JSON.stringify({ role: role, api_name: apiName }) });
}
function adminFetchHolidays() { return window.siteApi.get('/api/admin/holidays'); }
async function adminPutHolidays(year, dates) {
  return window.siteApi.request('/api/admin/holidays', { method: 'PUT', headers: window.siteApi.jsonHeaders(), body: JSON.stringify({ year: year, dates: dates }) });
}
async function adminFetchAudit(qs) { return window.siteApi.get('/api/admin/audit?' + qs); }
async function adminPostBondSafetyRefresh() { return window.siteApi.post('/api/bond-safety/refresh', {}); }
async function adminPostBondValuationRefresh() { return window.siteApi.post('/api/bond-valuation/refresh', {}); }
function adminFetchModels() { return window.siteApi.get('/api/admin/models'); }
async function adminSaveModelReq(url, method, body) {
  return window.siteApi.request(url, { method: method, headers: window.siteApi.jsonHeaders(), body: JSON.stringify(body) });
}
async function adminDelModel(id) { return window.siteApi.del('/api/admin/models/' + encodeURIComponent(id)); }
async function adminTestModel(id) { return window.siteApi.post('/api/admin/models/' + encodeURIComponent(id) + '/test', {}); }
async function adminSetDefaultModelReq(id) { return window.siteApi.post('/api/admin/models/' + encodeURIComponent(id) + '/default', {}); }
async function adminMoveModelReq(id, dir) {
  return window.siteApi.request('/api/admin/models/' + encodeURIComponent(id) + '/move', { method: 'POST', headers: window.siteApi.jsonHeaders(), body: JSON.stringify({ dir: dir }) });
}
function adminFetchKsArticles(status) { return window.siteApi.get('/api/admin/knowledge/articles?limit=50' + (status ? '&status=' + status : '')); }
async function adminDelKsArticle(id) { return window.siteApi.del('/api/admin/knowledge/articles/' + id); }
async function adminSetKsArticleStatus(id, status) {
  return window.siteApi.request('/api/admin/knowledge/articles/' + id + '/status', { method: 'PUT', headers: window.siteApi.jsonHeaders(), body: JSON.stringify({ status: status }) });
}
function adminFetchKsComments(articleId) { return window.siteApi.get('/api/admin/knowledge/comments?limit=50' + (articleId ? '&article_id=' + articleId : '')); }
async function adminDelKsComment(id) { return window.siteApi.del('/api/admin/knowledge/comments/' + id); }
function adminFetchKsUsers(search) { return window.siteApi.get('/api/admin/knowledge/users' + (search ? '?search=' + encodeURIComponent(search) : '')); }
async function adminSetKsUserPerm(username, enabled) {
  return window.siteApi.request('/api/admin/knowledge/users/' + encodeURIComponent(username) + '/permission', {
    method: 'POST', headers: window.siteApi.jsonHeaders(), body: JSON.stringify({ enabled: enabled })
  });
}
function adminFetchArbCandidates() { return window.siteApi.get('/api/admin/arbitrage/candidates?status=approved&page_size=100'); }
async function adminPatchArbCase(caseId, reviewStatus) {
  return window.siteApi.request('/api/admin/arbitrage/' + caseId, {
    method: 'PATCH',
    headers: window.siteApi.jsonHeaders(),
    body: JSON.stringify({ review_status: reviewStatus })
  });
}
function adminFetchArbCase(caseId) { return window.siteApi.get('/api/admin/arbitrage/' + caseId); }
async function adminPostArbSync() { return window.siteApi.post('/api/admin/arbitrage/sync', {}); }
async function adminPatchArbEdit(caseId, body) {
  return window.siteApi.request('/api/admin/arbitrage/' + caseId, {
    method: 'PATCH', headers: window.siteApi.jsonHeaders(), body: JSON.stringify(body)
  });
}
