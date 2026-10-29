// admin-presenter.js（批次4 P/V 拆分）：管理后台请求构造与发送、列表加载编排与搜索/分页状态。
// 职责：URL/方法/请求体构造 + siteApi 调用 + 列表状态（搜索/分页/序号）与加载编排；零 DOM。
// 渲染、表单读写与提示留在 admin.js（View，经 window.adminPaint* 入口回调）。
// 2026-10-29 验收 P2：状态与请求编排迁入本文件（View 只做表单读取和展示）；
// 同时按 P1 加身份＋序号守卫：请求绑定登录名/账户实体，旧响应不得写入新身份页面。

// 后台登录身份与权限判断由 Presenter 持有；跳转和用户文字由 View 执行。
var adminProfile = typeof adminProfile === 'object' ? adminProfile : null;
var adminAuthEpoch = 0;
async function checkAuth() {
  var authEpoch = ++adminAuthEpoch;
  try {
    var response = await adminFetchMe(), profile = response.payload;
    if (authEpoch !== adminAuthEpoch) return false;
    if (!profile.username) { window.adminNavigateLogin(); return false; }
    var caps = profile.capabilities || {};
    var hasAny = profile.role === 'admin' || Object.keys(caps).some(function (key) { return caps[key]; });
    if (!hasAny) { adminProfile = null; window.adminNavigateHome(); return false; }
    adminProfile = profile; window.adminShowIdentity(profile); return true;
  } catch (error) { if (authEpoch === adminAuthEpoch) { adminProfile = null; window.adminNavigateLogin(); } return false; }
}
async function adminLogout() {
  adminAuthEpoch += 1;
  adminProfile = null;
  await adminPostLogout();
  window.adminNavigateLoggedOut();
}

// ====== 身份＋序号守卫（通用） ======
function adminBegin(state) {
  var authEpoch = adminAuthEpoch;
  var user = typeof adminProfile !== 'undefined' && adminProfile ? String(adminProfile.username || '') : '';
  var identity = typeof adminProfile !== 'undefined' && adminProfile ? String(adminProfile.accountIdentity || '') : '';
  if (state.ownerUser !== user || state.ownerIdentity !== identity) {
    state.ownerUser = user; state.ownerIdentity = identity;
    state.seq = (state.seq || 0) + 1;
    if (state.resetOnSwitch) state.resetOnSwitch();
  }
  var seq = (state.seq = (state.seq || 0) + 1);
  return function current() {
    return state.seq === seq
      && authEpoch === adminAuthEpoch
      && user === (typeof adminProfile !== 'undefined' && adminProfile ? String(adminProfile.username || '') : '')
      && identity === (typeof adminProfile !== 'undefined' && adminProfile ? String(adminProfile.accountIdentity || '') : '');
  };
}

// ====== 用户列表：状态＋加载编排（搜索/分页状态归 Presenter） ======
var adminUsersState = {
  search: '', limit: 50, offset: 0, seq: 0,
  resetOnSwitch: function () { adminUsersState.search = ''; adminUsersState.offset = 0; }
};
async function loadUsersData() {
  var current = adminBegin(adminUsersState);
  try {
    const r = await adminFetchUsers(adminUsersState.search, adminUsersState.limit, adminUsersState.offset);
    if (!current()) return;
    if (!r.ok) { window.adminPaintUsersError(false); return; }
    window.adminPaintUsers(r.payload, adminUsersState.offset);
  } catch (e) { if (current()) window.adminPaintUsersError(true); }
}
function adminUsersSearchApply(value) {
  adminUsersState.search = value == null ? '' : String(value);
  adminUsersState.offset = 0;
  return loadUsersData();
}
function adminUsersReset() {
  adminUsersState.search = ''; adminUsersState.offset = 0;
  window.adminSetUsersSearch('');
  return loadUsersData();
}
function adminUsersPrev() {
  adminUsersState.offset = Math.max(0, adminUsersState.offset - adminUsersState.limit);
  return loadUsersData();
}
function adminUsersNext() {
  adminUsersState.offset += adminUsersState.limit;
  return loadUsersData();
}

// 券商筛选和请求状态由 Presenter 管理；View 只读取输入与渲染结果。
var brokersSearch = '';
var brokersMarket = '';
var adminBrokersState = { seq: 0 };
async function loadBrokersData() {
  var current = adminBegin(adminBrokersState);
  var qs = 'search=' + encodeURIComponent(brokersSearch) + '&market=' + encodeURIComponent(brokersMarket);
  try {
    var response = await adminFetchBrokers(qs);
    if (!current()) return;
    if (!response.ok) { window.adminPaintBrokersError(false); return; }
    window.adminPaintBrokers(response.payload);
  } catch (error) { if (current()) window.adminPaintBrokersError(true); }
}
function adminBrokersMarketChange(value) { brokersMarket = value; window.renderBrokers(); }
function adminBrokersSearchApply(value) { brokersSearch = value == null ? '' : String(value); window.renderBrokers(); }
function adminBrokersReset() { brokersSearch = ''; brokersMarket = ''; window.renderBrokers(); }

// 任务监控并发加载和过期响应处理归 Presenter，界面只提供筛选值与绘制结果。
var adminJobsState = { seq: 0 };
async function adminLoadJobsData(query) {
  var current = adminBegin(adminJobsState);
  try {
    var responses = await Promise.all([
      adminFetchJobsOverview(), adminFetchJobSlots(query), adminFetchJobs(50),
      adminFetchJobNotices(30), adminFetchJobNoticeHistory(30),
    ]);
    if (!current()) return;
    if (responses.some(function (response) { return !response.ok; })) throw new Error('load failed');
    window.adminPaintJobs(responses.map(function (response) { return response.payload; }));
  } catch (error) { if (current()) window.adminPaintJobsError(); }
}

// 概览与模型列表只将当前身份的响应交给 View。
var adminOverviewState = { seq: 0 };
async function adminLoadOverview() {
  var current = adminBegin(adminOverviewState);
  try {
    var response = await adminFetchOverview();
    if (!current()) return;
    if (!response.ok) { window.adminPaintOverviewError(false); return; }
    window.adminPaintOverview(response.payload);
  } catch (error) { if (current()) window.adminPaintOverviewError(true); }
}
var adminModelsState = { seq: 0 };
async function loadAimodelsData() {
  var current = adminBegin(adminModelsState);
  try {
    var response = await adminFetchModels();
    if (!current()) return;
    if (!response.ok) { window.adminPaintAimodelsError(false); return; }
    window.adminPaintAimodels(response.payload);
  } catch (error) { if (current()) window.adminPaintAimodelsError(true); }
}

var adminAuditState = { seq: 0 };
async function adminLoadAuditData(filters) {
  var current = adminBegin(adminAuditState);
  var qs = 'limit=100' + (filters.module ? '&module=' + encodeURIComponent(filters.module) : '')
    + (filters.actor ? '&actor=' + encodeURIComponent(filters.actor) : '')
    + (filters.result ? '&result=' + encodeURIComponent(filters.result) : '');
  try {
    var response = await adminFetchAudit(qs);
    if (!current()) return;
    if (!response.ok) { window.adminPaintAuditError(false); return; }
    window.adminPaintAudit(response.payload);
  } catch (error) { if (current()) window.adminPaintAuditError(true); }
}

// 投资笔记管理的列表请求与身份/序号保护。
var adminKsArticlesState = { seq: 0 }, adminKsCommentsState = { seq: 0 }, adminKsPermissionsState = { seq: 0 };
async function ksLoadKsArticles(status) {
  adminKsArticlesState.status = status;
  var current = adminBegin(adminKsArticlesState);
  try { var response = await adminFetchKsArticles(status); if (!current()) return;
    if (!response.ok) throw new Error('load failed'); window.adminPaintKsArticles(response.payload);
  } catch (error) { if (current()) window.adminPaintKsArticlesError(); }
}
async function ksLoadKsComments(articleId) {
  adminKsCommentsState.articleId = articleId;
  var current = adminBegin(adminKsCommentsState);
  try { var response = await adminFetchKsComments(articleId); if (!current()) return;
    if (!response.ok) throw new Error('load failed'); window.adminPaintKsComments(response.payload);
  } catch (error) { if (current()) window.adminPaintKsCommentsError(); }
}
async function ksLoadKsPermissions(search) {
  adminKsPermissionsState.search = search;
  var current = adminBegin(adminKsPermissionsState);
  try { var response = await adminFetchKsUsers(search); if (!current()) return;
    if (!response.ok) throw new Error('load failed'); window.adminPaintKsPermissions(response.payload);
  } catch (error) { if (current()) window.adminPaintKsPermissionsError(); }
}

// 投资笔记管理的写操作只在接口成功后提示并刷新。
async function adminDeleteKsArticle(id) {
  var current = adminIdentityCurrent();
  try { var response = await adminDelKsArticle(id); if (!current()) return;
    if (!response.ok) throw new Error('删除失败'); window.showToast('已删除'); return ksLoadKsArticles(adminKsArticlesState.status || '');
  } catch (error) { if (current()) window.showToast(error.message || '删除失败'); }
}
async function adminToggleKsArticleStatus(id, status) {
  var current = adminIdentityCurrent(), next = status === 'draft' ? 'published' : 'draft';
  try { var response = await adminSetKsArticleStatus(id, next); if (!current()) return;
    if (!response.ok) throw new Error('操作失败'); window.showToast(next === 'published' ? '已发布' : '已撤回'); return ksLoadKsArticles(adminKsArticlesState.status || '');
  } catch (error) { if (current()) window.showToast(error.message || '操作失败'); }
}
async function adminDeleteKsComment(id) {
  var current = adminIdentityCurrent();
  try { var response = await adminDelKsComment(id); if (!current()) return;
    if (!response.ok) throw new Error('删除失败'); window.showToast('已删除'); return ksLoadKsComments(adminKsCommentsState.articleId || '');
  } catch (error) { if (current()) window.showToast(error.message || '删除失败'); }
}
async function adminToggleKsUserPermission(username, value) {
  var current = adminIdentityCurrent(), next = value !== '1';
  try { var response = await adminSetKsUserPerm(username, next); if (!current()) return;
    if (!response.ok) throw new Error('设置失败'); window.showToast(next ? '已开启写权限' : '已关闭写权限'); return ksLoadKsPermissions(adminKsPermissionsState.search || '');
  } catch (error) { if (current()) window.showToast(error.message || '设置失败'); }
}

var adminArbCandidatesState = { seq: 0 };
async function loadArbCandidates() {
  var current = adminBegin(adminArbCandidatesState);
  try {
    var response = await adminFetchArbCandidates();
    if (!current()) return;
    if (!response.ok) throw new Error('HTTP ' + response.status);
    window.adminPaintArbCandidates(response.payload);
  } catch (error) { if (current()) window.adminPaintArbCandidatesError(error); }
}

// 设置和休市日历状态、加载与身份守卫。
var settingsTab = 'site';
var holidayYear = String(new Date().getFullYear()), holidayEditSet = null;
var adminSettingsState = { seq: 0 }, adminHolidaysState = { seq: 0 };
async function adminLoadSettings() {
  var current = adminBegin(adminSettingsState);
  try { var response = await adminFetchSettings(); if (!current()) return;
    if (!response.ok || !response.payload) throw new Error('load failed'); window.adminPaintSettings(response.payload);
  } catch (error) { if (current()) window.adminPaintSettingsError(); }
}
async function adminLoadHolidays() {
  var current = adminBegin(adminHolidaysState);
  try {
    var response = await adminFetchHolidays(); if (!current()) return;
    if (!response.ok || !response.payload) throw new Error('load failed');
    var years = Object.keys(response.payload.years || {}).sort();
    if (years.length) {
      if (years.indexOf(holidayYear) < 0) holidayYear = years[years.length - 1];
      holidayEditSet = new Set((response.payload.years[holidayYear] || []).slice().sort());
    }
    window.adminPaintHolidays(years);
  } catch (error) { if (current()) window.adminPaintHolidaysError(); }
}
function adminHolidayYearChange(value) { holidayYear = value; window.renderHolidays(); }

// 用户管理操作与结果处理；View 负责收集输入、弹窗和消息。
function adminIdentityCurrent() {
  var authEpoch = adminAuthEpoch, profile = adminProfile, user = profile && profile.username, identity = profile && profile.accountIdentity;
  return function () { return authEpoch === adminAuthEpoch && adminProfile && adminProfile.username === user && adminProfile.accountIdentity === identity; };
}
async function adminToggleStatus(username, currentStatus) {
  var current = adminIdentityCurrent(), next = currentStatus === 'active' ? 'disabled' : 'active';
  try { var r = await adminPostUserStatus(username, next); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '操作失败'); return; }
    window.showToast(next === 'active' ? '已启用' : '已禁用'); return loadUsersData();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function adminToggleRole(username, currentRole) {
  var current = adminIdentityCurrent(), next = currentRole === 'admin' ? 'user' : 'admin';
  try { var r = await adminPostUserRole(username, next); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '操作失败'); return; }
    window.showToast(next === 'admin' ? '已设为管理员' : '已取消管理员'); return loadUsersData();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function adminResetUserPassword(username, password) {
  if (!password || password.length < 6) { window.showToast('密码至少6位'); return; }
  var current = adminIdentityCurrent();
  try { var r = await adminPostUserPassword(username, password); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '重置失败'); return; }
    window.showToast('密码已重置'); window.closeAdminModal();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function doAdminDeleteUser(username) {
  var current = adminIdentityCurrent();
  try { var r = await adminDelUser(username); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '删除失败'); return; }
    window.showToast('已删除'); window.closeAdminModal(); return loadUsersData();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
var adminUserDetailState = { seq: 0 };
async function adminShowDetail(username) {
  var current = adminBegin(adminUserDetailState);
  try { var response = await adminFetchUserDetail(username); if (!current()) return;
    if (!response.ok) { window.showToast('加载失败'); return; }
    window.adminPaintUserDetail(username, response.payload);
  } catch (error) { if (current()) window.showToast('网络错误'); }
}

// 套利审核与详情编排由 Presenter 处理，View 只收集表单及绘制弹窗。
async function adminArbReview(caseId, status) {
  var current = adminIdentityCurrent();
  try { var response = await adminPatchArbCase(caseId, status); if (!current()) return;
    if (!response.ok) throw new Error('HTTP ' + response.status);
    window.showToast(status === 'approved' ? '已通过审核' : '已驳回'); return loadArbCandidates();
  } catch (error) { if (current()) window.showToast('操作失败: ' + error.message); }
}
var adminArbDetailState = { seq: 0 };
async function adminArbDetail(caseId) {
  var current = adminBegin(adminArbDetailState);
  try { var response = await adminFetchArbCase(caseId); if (!current()) return;
    if (!response.ok) throw new Error('HTTP ' + response.status); window.adminPaintArbDetail(caseId, response.payload);
  } catch (error) { if (current()) window.showToast('加载失败: ' + error.message); }
}
async function openArbEditForm(caseId) {
  var current = adminBegin(adminArbDetailState);
  try { var response = await adminFetchArbCase(caseId); if (!current()) return;
    if (!response.ok) throw new Error('HTTP ' + response.status); window.adminPaintArbEditForm(caseId, response.payload);
  } catch (error) { if (current()) window.showToast('加载失败: ' + error.message); }
}
async function adminArbSync() {
  var current = adminIdentityCurrent();
  try { var response = await adminPostArbSync(); if (!current()) return;
    if (!response.ok) throw new Error('HTTP ' + response.status); window.showToast((response.payload || {}).message || '同步已启动');
  } catch (error) { if (current()) window.showToast('同步失败: ' + error.message); }
}
async function adminSubmitArbEdit(caseId, body) {
  var current = adminIdentityCurrent();
  try { var response = await adminPatchArbEdit(caseId, body); if (!current()) return;
    if (!response.ok) { window.showToast((response.payload || {}).error || '保存失败'); return; }
    window.showToast('条款已保存'); window.closeAdminModal(); return loadArbCandidates();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}

// 券商编辑、保存与删除：输入来自 View，业务校验和请求由 Presenter 负责。
var adminBrokerDetailState = { seq: 0 };
function adminInvalidateBrokerDetail() { adminBrokerDetailState.seq += 1; }
async function adminLoadBrokerDetail(code) {
  var current = adminBegin(adminBrokerDetailState);
  try { var response = await adminFetchBrokerDetail(code); if (!current()) return;
    if (!response.ok) throw new Error('加载失败'); window.adminPaintBrokerDetail(response.payload);
  } catch (error) { if (current()) window.showToast(error.message || '加载失败'); }
}
async function adminSubmitBroker(input) {
  if (!input.code || !input.name) { window.showToast('代码和名称均必填'); return; }
  var current = adminIdentityCurrent(), url = input.isEdit ? '/api/admin/brokers/' + encodeURIComponent(input.code) : '/api/admin/brokers';
  var body = { name: input.name, market: input.market, import_unit: input.import_unit, sort_order: input.sort_order };
  if (!input.isEdit) body.code = input.code;
  try { var response = await adminSaveBrokerReq(url, input.isEdit ? 'PUT' : 'POST', body); if (!current()) return;
    if (!response.ok) { window.showToast((response.payload || {}).error || '保存失败'); return; }
    window.showToast('已保存'); window.closeAdminModal(); return loadBrokersData();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function doDeleteBroker(code) {
  var current = adminIdentityCurrent();
  try { var response = await adminDeleteBrokerReq(code); if (!current()) return;
    if (!response.ok) { window.showToast((response.payload || {}).error || '删除失败'); return; }
    window.showToast('已删除'); window.closeAdminModal(); return loadBrokersData();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}

// 任务管理：确认交给 View，任务请求与结果归 Presenter。
async function retryJobSlotFromUi(slotId) {
  var current = adminIdentityCurrent();
  try {
    var detailResponse = await adminFetchJobSlot(slotId); if (!current()) return;
    var detail = detailResponse.payload || {};
    if (!detailResponse.ok) { window.showToast(detail.error || '读取任务信息失败'); return; }
    var label = detail.definition && detail.definition.label || detail.job_code || '该任务';
    var targetDate = detail.business_date ? String(detail.business_date).slice(0, 10) : '-';
    var source = detail.definition && detail.definition.sourceDescription || '本地数据库与该任务已配置的数据源';
    var cost = detail.definition && detail.definition.mayConsumeQuota ? '可能消耗接口额度' : '通常不产生额外接口费用';
    if (!(await window.adminConfirmJobRetry(label, targetDate, source, cost)) || !current()) return;
    var response = await adminRetryJobSlot(slotId); if (!current()) return;
    var data = response.payload || {};
    window.showToast(response.ok ? (data.queued ? '已加入补跑队列' : '补跑完成') : (data.error || '补跑失败'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  if (current()) window.loadJobsData();
}
async function validateJobSlotFromUi(slotId) {
  var current = adminIdentityCurrent();
  try { var r = await adminValidateJobSlot(slotId); if (!current()) return; var d = r.payload || {};
    window.showToast(d.message || (r.ok ? '重新校验通过' : '重新校验未通过'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  if (current()) window.loadJobsData();
}
async function acknowledgeJobSlot(slotId) {
  var current = adminIdentityCurrent();
  try { var r = await adminAckJobSlot(slotId); if (!current()) return;
    window.showToast(r.ok ? '已确认并接管' : ((r.payload || {}).error || '操作失败'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  if (current()) window.loadJobsData();
}
async function testJobAlertEmail() {
  var current = adminIdentityCurrent();
  try { var r = await adminTestAlertEmail(); if (!current()) return;
    window.showToast(r.ok ? '测试邮件已发送' : ((r.payload || {}).error || '邮件测试失败'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function resendJobAlert(alertId) {
  var current = adminIdentityCurrent();
  try { var r = await adminResendJobAlert(alertId); if (!current()) return;
    window.showToast(r.ok ? '告警邮件已重新投递' : ((r.payload || {}).error || '邮件投递失败'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  if (current()) window.loadJobsData();
}
async function acknowledgeJobAlert(alertId) {
  var current = adminIdentityCurrent();
  try { var r = await adminAckJobAlert(alertId); if (!current()) return;
    window.showToast(r.ok ? '告警已确认' : ((r.payload || {}).error || '确认失败'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  if (current()) window.loadJobsData();
}

var adminJobDetailState = { seq: 0 };
async function adminLoadJobDetail(slotId, legacy) {
  var current = adminBegin(adminJobDetailState);
  try { var response = await adminFetchJobSlot(slotId); if (!current()) return;
    if (!response.ok) { window.showToast((response.payload || {}).error || '读取详情失败'); return; }
    if (legacy) window.adminPaintJobSlotDetailLegacy(response.payload);
    else window.adminPaintJobSlotDetail(response.payload);
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
function openJobSlotDetail(slotId) { return adminLoadJobDetail(slotId, false); }
function openJobSlotDetailLegacy(slotId) { return adminLoadJobDetail(slotId, true); }

// 运维操作与结果处理。
var adminOpsJobsState = { seq: 0 };
async function opsLoadJobs() {
  var current = adminBegin(adminOpsJobsState);
  try { var response = await adminFetchJobs(20); if (!current()) return;
    if (!response.ok) { window.adminPaintOpsJobsError(false); return; } window.adminPaintOpsJobs(response.payload);
  } catch (error) { if (current()) window.adminPaintOpsJobsError(true); }
}
async function adminOpsRefresh(kind) {
  var current = adminIdentityCurrent(), id = kind === 'safety' ? 'ops-bond-safety-refresh' : 'ops-bond-valuation-refresh';
  window.adminSetOpsBusy(id, true);
  try { var response = await (kind === 'safety' ? adminPostBondSafetyRefresh() : adminPostBondValuationRefresh()); if (!current()) return;
    window.showToast(response.ok ? (kind === 'safety' ? '可转债安全性数据已刷新' : '可转债估值已刷新') : ((response.payload || {}).error || '刷新失败'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  finally { if (current()) { window.adminSetOpsBusy(id, false); opsLoadJobs(); } }
}
function opsRefreshBondSafety() { return adminOpsRefresh('safety'); }
function opsRefreshBondValuation() { return adminOpsRefresh('valuation'); }
async function adminOpsImportFederalFunds(form) {
  if (!form) { window.showToast('请先选择利率文件'); return; }
  var current = adminIdentityCurrent(); window.adminSetOpsBusy('ops-fed-import', true);
  try { var response = await adminImportFed(form); if (!current()) return;
    window.showToast(response.ok ? '已导入 ' + ((response.payload || {}).imported || 0) + ' 条利率数据' : ((response.payload || {}).error || '导入失败'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  finally { if (current()) { window.adminSetOpsBusy('ops-fed-import', false); opsLoadJobs(); } }
}

// 全局参数、来源策略与测试的提交编排。
async function adminSaveEndpointPolicies(policies) {
  var current = adminIdentityCurrent();
  try { var r = await adminPutPolicies(policies); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '保存接口策略失败'); return; }
    window.showToast('接口策略已保存'); window.renderSettings();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function adminSaveExternalApiSettings(body) {
  var current = adminIdentityCurrent();
  try { var r = await adminPutSettings(body); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '保存失败'); return; }
    window.showToast('外部 API 参数已保存'); window.renderSettings();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function adminApplyExternalApiMode(provider, mode) {
  var current = adminIdentityCurrent();
  try { var r = await adminSwitchExternal(provider, mode); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '切换失败'); return; }
    window.showToast('已手动应用' + (mode === 'auto' ? '自动故障转移' : mode === 'primary' ? '主 Token' : '备用 Token')); window.renderSettings();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function adminTestExternalAvailability(provider, role, apiName, originalText) {
  var current = adminIdentityCurrent(), label = role === 'primary' ? '主' : role === 'backup' ? '备用' : '当前';
  try { var r = await adminTestExternal(provider, role, apiName); if (!current()) return;
    var d = r.payload || {};
    if (!r.ok) { window.showToast(d.error || '测试失败'); return; }
    window.showToast(d.result && d.result.ok ? label + ' API 可用' : label + ' API 不可用：' + ((d.result && d.result.message) || '请检查配置'));
    window.renderSettings();
  } catch (error) { if (current()) window.showToast('网络错误'); }
  finally { if (current()) window.adminRestoreExternalTestButton(provider, role, originalText); }
}
async function adminSubmitSettings(body) {
  var current = adminIdentityCurrent();
  try { var r = await adminPutSettings(body); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '保存失败'); return; }
    window.showToast('设置已保存（即时生效）');
  } catch (error) { if (current()) window.showToast('网络错误'); }
}

function addHoliday(date) {
  if (!holidayEditSet) return;
  if (holidayEditSet.has(date)) { window.showToast('该日期已是休市日'); return; }
  holidayEditSet.add(date); window.renderHolidayCalendar(); window.showToast('已标记 ' + date + '（点「保存」后生效）');
}
function removeHoliday(date) {
  if (!holidayEditSet) return;
  holidayEditSet.delete(date); window.renderHolidayCalendar(); window.showToast('已移除 ' + date + '（点「保存」后生效）');
}
async function saveHolidays() {
  if (!holidayEditSet) return;
  var current = adminIdentityCurrent(), year = holidayYear, dates = Array.from(holidayEditSet).sort();
  try { var response = await adminPutHolidays(year, dates); if (!current()) return;
    if (!response.ok) { window.showToast((response.payload || {}).error || '保存失败'); return; }
    window.showToast('已保存 ' + year + ' 年休市日（' + dates.length + '天）'); window.renderHolidays();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function runJobBackfill() {
  var current = adminIdentityCurrent(); window.adminSetManualJobBusy('job-btn-backfill', true);
  try { var r = await adminPostBackfill(); if (!current()) return;
    window.showToast(r.ok ? '补漏完成' : ((r.payload || {}).error || '补漏失败'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  finally { if (current()) { window.adminSetManualJobBusy('job-btn-backfill', false); window.loadJobsData(); } }
}
async function runJobHolidaySync() {
  var current = adminIdentityCurrent(); window.adminSetManualJobBusy('holiday-btn-sync', true);
  try { var r = await adminPostHolidaySync(); if (!current()) return;
    window.showToast(r.ok ? '休市日历已核对' : ((r.payload || {}).error || '核对失败'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  finally { if (current()) { window.adminSetManualJobBusy('holiday-btn-sync', false); window.renderHolidays(); } }
}

// 模型编辑与操作：只把已选择模型的数据交给 View。
var adminModelDetailState = { seq: 0 };
function adminInvalidateModelDetail() { adminModelDetailState.seq += 1; }
async function adminLoadModelDetail(id) {
  var current = adminBegin(adminModelDetailState);
  try { var response = await adminFetchModels(); if (!current()) return;
    if (!response.ok) throw new Error('加载失败');
    var model = ((response.payload || {}).list || []).find(function (item) { return item.id === id; });
    if (model) window.adminPaintModelDetail(model);
  } catch (error) { if (current()) window.showToast('加载失败'); }
}
async function adminSubmitModel(input) {
  if (!input.name || !input.model || !input.apiUrl) { window.showToast('名称、模型名、API 地址均必填'); return; }
  if (!input.isEdit && !input.apiKey) { window.showToast('新增时 API Key 必填'); return; }
  var current = adminIdentityCurrent(), url = input.isEdit ? '/api/admin/models/' + encodeURIComponent(input.id) : '/api/admin/models';
  var body = { name: input.name, model: input.model, apiUrl: input.apiUrl, apiKey: input.apiKey, enabled: input.enabled };
  try { var response = await adminSaveModelReq(url, input.isEdit ? 'PUT' : 'POST', body); if (!current()) return;
    if (!response.ok) { window.showToast((response.payload || {}).error || '保存失败'); return; }
    window.showToast('已保存'); window.closeAdminModal(); return loadAimodelsData();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function doDeleteModel(id) {
  var current = adminIdentityCurrent();
  try { var r = await adminDelModel(id); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '删除失败'); return; }
    window.showToast('已删除'); window.closeAdminModal(); return loadAimodelsData();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function testModel(id) {
  var current = adminIdentityCurrent(); window.adminSetModelTestBusy(id, true);
  try { var r = await adminTestModel(id); if (!current()) return; var d = r.payload || {};
    if (!r.ok) window.showToast(d.error || '测试失败');
    else if (d.ok) window.showToast('测试成功（耗时 ' + (d.ms || 0) + 'ms）');
    else window.showToast('测试失败：' + (d.error || '未知错误'));
  } catch (error) { if (current()) window.showToast('网络错误'); }
  finally { if (current()) { window.adminSetModelTestBusy(id, false); loadAimodelsData(); } }
}
async function setDefaultModel(id) {
  var current = adminIdentityCurrent();
  try { var r = await adminSetDefaultModelReq(id); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '操作失败'); return; }
    window.showToast('已设为默认模型'); return loadAimodelsData();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}
async function moveModel(id, dir) {
  var current = adminIdentityCurrent();
  try { var r = await adminMoveModelReq(id, dir); if (!current()) return;
    if (!r.ok) { window.showToast((r.payload || {}).error || '操作失败'); return; }
    return loadAimodelsData();
  } catch (error) { if (current()) window.showToast('网络错误'); }
}

async function adminImportFederalFunds(form) {
  if (!form) { window.showToast('请选择 CSV 或 XLSX 文件'); return; }
  var current = adminIdentityCurrent(), success = false;
  try { var response = await adminImportFed(form); if (!current()) return;
    var data = response.payload || {};
    if (!response.ok) throw new Error(data.error || response.status);
    success = true; window.showToast('已导入 ' + data.imported + ' 条日频利率数据');
  } catch (error) { if (current()) window.showToast('导入失败：' + (error.message || error)); }
  finally { if (current()) window.adminFinishFederalFunds(success); }
}
var adminLegacyJobsState = { seq: 0 };
async function loadJobsDataLegacy() {
  var current = adminBegin(adminLegacyJobsState);
  try { var response = await adminFetchJobs(50); if (!current()) return;
    if (!response.ok) { window.adminPaintJobsLegacyError(false); return; }
    window.adminPaintJobsLegacy(response.payload);
  } catch (error) { if (current()) window.adminPaintJobsLegacyError(true); }
}

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
