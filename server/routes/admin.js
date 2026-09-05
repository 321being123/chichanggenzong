// ========== 管理后台路由（统一前缀 /api/admin，需管理员或对应后台能力）==========
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireStaff, requireCapability } = require('../middleware/auth');
const { REGISTER_CODE } = require('../config');
const {
  adminOverview,   countUsers, listUsers, setUserRole, setUserStatus, adminSetPassword, setKnowledgeEnabled,
  deleteUser, getUserDetail, hashPwd, adminListBrokers, createBroker, updateBroker, deleteBroker,
  isValidBroker, adminJobRuns, startJobRun, finishJobRun,
  getConfig, setConfig,
  auditEvent, listAudit, AUDIT_MODULES, pool
} = require('../db');
const { backfillMissingCloses } = require('../jobs/marketClose');
const { ensureHolidaysCurrent } = require('../jobs/holidaySync');
const { loadHolidays, saveHolidays } = require('../config/holidays');
const { getModels, saveModels, maskKey, recordStatus, getStatus } = require('../services/aiModels');
const arbitrageSvc = require('../services/arbitrageService');
const { getJobOverview, listJobSlots, getJobSlot, retryJobSlot, acknowledgeSlot, validateJobSlot } = require('../services/jobScheduleSlots');
const { listAlerts, resendAlert, acknowledgeAlert, sendTestEmail } = require('../services/jobAlertMailer');
const { sanitizeJobError } = require('../services/jobErrorSanitizer');
const {
  PROVIDERS: EXTERNAL_API_PROVIDERS,
  getExternalApiSettings,
  getProviderRuntime,
  testProviderAvailability,
  saveProviderSettings,
  switchProvider,
} = require('../services/externalApiConfig');
const { upsertSourceEndpointPolicy } = require('../services/sourceEndpointPolicy');
const { tokenFingerprint } = require('../services/externalCallGuard');
const { assertSafeUrl } = require('../services/ai');

// PERM-02：后台入口仅要求员工身份（管理员或任一后台能力），具体接口按路径前缀再校验对应能力。
// 后端独立校验——前端菜单可隐藏，但不能作为安全边界。
router.use(requireStaff);

// 后台接口 → 所需能力 映射（按路径前缀派发，避免逐个 handler 脆弱改动）
function adminCapabilityForPath(p) {
  const normalized = String(p || '').toLowerCase();
  if (normalized.indexOf('/users') === 0) return 'user_manage';
  if (normalized.indexOf('/knowledge') === 0) return 'content_manage';
  if (normalized.indexOf('/brokers') === 0 || normalized.indexOf('/jobs') === 0 || normalized.indexOf('/holidays') === 0 ||
      normalized.indexOf('/models') === 0 || normalized.indexOf('/settings') === 0 || normalized.indexOf('/arbitrage') === 0) return 'ops_manage';
  return null; // /overview、/audit 等仅要求员工身份
}
router.use(function (req, res, next) {
  const cap = adminCapabilityForPath(req.path);
  if (!cap) return next();
  requireCapability(cap)(req, res, next);
});

// AUDIT-01 审计助手：统一带上操作者与请求 ID，成功与失败都留痕（metadata 只放必要摘要）
function audit(req, action, target, opt) {
  const o = opt || {};
  return auditEvent({
    actor: req.session.user, action: action, target: target,
    result: o.result || 'success', requestId: req.id,
    detail: o.detail, metadata: o.metadata,
  }).catch(function () {});
}

// 平台概览：总用户/管理员/禁用/账户数/今日新增/全平台总资产
router.get('/overview', asyncHandler(async (req, res) => {
  res.json(await adminOverview());
}));

// ====== 用户管理 ======
router.get('/users', asyncHandler(async (req, res) => {
  const search = (req.query.search || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const [total, list] = await Promise.all([countUsers(search), listUsers({ search, limit, offset })]);
  res.json({ total, list, limit, offset });
}));
router.get('/users/:username', asyncHandler(async (req, res) => {
  const d = await getUserDetail(req.params.username);
  if (!d) return res.status(404).json({ error: '用户不存在' });
  res.json(d);
}));
router.post('/users/:username/role', asyncHandler(async (req, res) => {
  const role = req.body && req.body.role;
  if (role !== 'admin' && role !== 'user') {
    await audit(req, 'user_role', req.params.username, { result: 'failure', detail: '角色非法' });
    return res.status(400).json({ error: '角色非法' });
  }
  if (role !== 'admin' && req.params.username === req.session.user) {
    await audit(req, 'user_role', req.params.username, { result: 'failure', detail: '不能取消自己的管理员权限' });
    return res.status(400).json({ error: '不能取消自己的管理员权限' });
  }
  await setUserRole(req.params.username, role);
  await audit(req, 'user_role', req.params.username, { detail: '设为' + (role === 'admin' ? '管理员' : '普通用户'), metadata: { role: role } });
  res.json({ ok: true });
}));
router.post('/users/:username/status', asyncHandler(async (req, res) => {
  const status = req.body && req.body.status;
  if (status !== 'active' && status !== 'disabled') {
    await audit(req, 'user_status', req.params.username, { result: 'failure', detail: '状态非法' });
    return res.status(400).json({ error: '状态非法' });
  }
  if (status !== 'active' && req.params.username === req.session.user) {
    await audit(req, 'user_status', req.params.username, { result: 'failure', detail: '不能禁用自己的账号' });
    return res.status(400).json({ error: '不能禁用自己的账号' });
  }
  await setUserStatus(req.params.username, status);
  await audit(req, 'user_status', req.params.username, { detail: status === 'active' ? '启用' : '禁用', metadata: { status: status } });
  res.json({ ok: true });
}));
router.post('/users/:username/password', asyncHandler(async (req, res) => {
  const pwd = req.body && req.body.password;
  if (!pwd || typeof pwd !== 'string' || pwd.length < 6) {
    await audit(req, 'user_password', req.params.username, { result: 'failure', detail: '密码长度不符合要求' });
    return res.status(400).json({ error: '密码至少6位' });
  }
  await adminSetPassword(req.params.username, hashPwd(pwd));
  await audit(req, 'user_password', req.params.username, { detail: '管理员重置密码' });
  res.json({ ok: true });
}));
router.delete('/users/:username', asyncHandler(async (req, res) => {
  if (req.params.username === req.session.user) {
    await audit(req, 'user_delete', req.params.username, { result: 'failure', detail: '不能删除当前登录账号' });
    return res.status(400).json({ error: '不能删除当前登录账号' });
  }
  await deleteUser(req.params.username);
  await audit(req, 'user_delete', req.params.username, { detail: '删除用户及全部数据' });
  res.json({ ok: true });
}));

// ====== 券商管理 ======
router.get('/brokers', asyncHandler(async (req, res) => {
  const list = await adminListBrokers({ search: (req.query.search || '').trim(), market: (req.query.market || '').trim() });
  res.json({ list });
}));
router.get('/brokers/:code', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT code, name, market, sort_order, import_unit FROM brokers WHERE code=$1', [req.params.code]);
  if (!rows.length) return res.status(404).json({ error: '券商不存在' });
  res.json(rows[0]);
}));
router.post('/brokers', asyncHandler(async (req, res) => {
  const { code, name, market, sort_order, import_unit } = req.body || {};
  if (!code || !name || !market) return res.status(400).json({ error: '券商代码、名称、市场均必填' });
  if (!['A', 'H', 'U'].includes(market)) return res.status(400).json({ error: '市场非法' });
  if (import_unit && !['sheet', 'lot'].includes(import_unit)) return res.status(400).json({ error: '导入单位非法' });
  if (await isValidBroker(code)) return res.status(409).json({ error: '券商代码已存在' });
  await createBroker({ code, name, market, sort_order: sort_order ? parseInt(sort_order, 10) || 0 : 0, import_unit: import_unit || 'sheet' });
  await audit(req, 'broker_create', code, { detail: '新增券商 ' + name });
  res.json({ ok: true });
}));
router.put('/brokers/:code', asyncHandler(async (req, res) => {
  const { name, market, sort_order, import_unit } = req.body || {};
  if (!name || !market) return res.status(400).json({ error: '名称、市场均必填' });
  if (!['A', 'H', 'U'].includes(market)) return res.status(400).json({ error: '市场非法' });
  if (import_unit && !['sheet', 'lot'].includes(import_unit)) return res.status(400).json({ error: '导入单位非法' });
  await updateBroker(req.params.code, { name, market, sort_order: sort_order ? parseInt(sort_order, 10) || 0 : 0, import_unit: import_unit || 'sheet' });
  await audit(req, 'broker_update', req.params.code, { detail: '编辑券商' });
  res.json({ ok: true });
}));
router.delete('/brokers/:code', asyncHandler(async (req, res) => {
  await deleteBroker(req.params.code);
  await audit(req, 'broker_delete', req.params.code, { detail: '删除券商' });
  res.json({ ok: true });
}));

// ====== 定时任务监控 ======
router.get('/jobs', asyncHandler(async (req, res) => {
  res.json(await adminJobRuns(req.query.limit));
}));
router.get('/jobs/overview', asyncHandler(async (req, res) => {
  res.json(await getJobOverview());
}));
router.get('/jobs/health', asyncHandler(async (req, res) => {
  const overview = await getJobOverview();
  res.json({ ok: Boolean(overview.health && overview.health.schedulerOnline), ...overview.health, today: overview.today });
}));
router.get('/jobs/slots', asyncHandler(async (req, res) => {
  res.json({ list: await listJobSlots({
    date: req.query.date,
    status: req.query.status,
    category: req.query.category,
    trigger: req.query.trigger,
    keyword: req.query.keyword,
    limit: req.query.limit,
  }) });
}));
router.get('/jobs/slots/:slotId', asyncHandler(async (req, res) => {
  const slot = await getJobSlot(parseInt(req.params.slotId, 10));
  if (!slot) return res.status(404).json({ error: '任务计划不存在' });
  res.json(slot);
}));
router.post('/jobs/slots/:slotId/retry', asyncHandler(async (req, res) => {
  const slotId = parseInt(req.params.slotId, 10);
  const slot = await retryJobSlot(slotId);
  if (!slot) {
    await audit(req, 'job_retry', String(slotId), { result: 'failure', detail: '当前任务状态不允许补跑', metadata: { slotId, queued: false } });
    return res.status(409).json({ error: '当前任务状态不允许补跑' });
  }
  // 普通补跑仍遵守新鲜度门禁；只有管理员明确传 force=true 才允许强制重拉。
  if (req.body && req.body.force === true) {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '只有管理员可以强制重拉外部数据' });
    await pool.query(
      `UPDATE ops.job_schedule_slots SET request_payload=request_payload || '{"force":true}'::jsonb, updated_at=now() WHERE slot_id=$1`,
      [slotId]
    );
    slot.request_payload = { ...(slot.request_payload || {}), force: true };
  }
  await audit(req, 'job_retry', slot.job_code, { detail: '后台手动补跑已入队', metadata: { slotId, queued: true } });
  res.status(202).json({ ok: true, queued: true, slotId, slot });
}));
router.post('/jobs/slots/:slotId/validate', asyncHandler(async (req, res) => {
  const slotId = parseInt(req.params.slotId, 10);
  const result = await validateJobSlot(slotId);
  if (!result) {
    await audit(req, 'job_validate', String(slotId), { result: 'failure', detail: '任务计划不存在', metadata: { slotId } });
    return res.status(404).json({ error: '任务计划不存在' });
  }
  await audit(req, 'job_validate', String(result.slotId), { result: result.valid ? 'success' : 'failure', detail: result.message, metadata: { slotId: result.slotId, dataAsOf: result.dataAsOf } });
  res.status(result.valid ? 200 : 409).json(result);
}));
router.post('/jobs/slots/:slotId/acknowledge', asyncHandler(async (req, res) => {
  const slotId = parseInt(req.params.slotId, 10);
  const slot = await acknowledgeSlot(slotId);
  if (!slot) {
    await audit(req, 'job_acknowledge', String(slotId), { result: 'failure', detail: '任务计划不存在', metadata: { slotId } });
    return res.status(404).json({ error: '任务计划不存在' });
  }
  await audit(req, 'job_acknowledge', slot.job_code, { detail: '确认任务异常已接管', metadata: { slotId: slot.slot_id } });
  res.json({ ok: true, slot });
}));
router.get('/jobs/alerts', asyncHandler(async (req, res) => {
  res.json({ list: await listAlerts({ status: req.query.status || 'open', limit: req.query.limit }) });
}));
router.get('/jobs/notifications', asyncHandler(async (req, res) => {
  res.json({ list: await listAlerts({ status: req.query.status || 'open', limit: req.query.limit }) });
}));
router.post('/jobs/notifications/:alertId/resend', asyncHandler(async (req, res) => {
  const alertId = parseInt(req.params.alertId, 10);
  const result = await resendAlert(alertId);
  if (!result) {
    await audit(req, 'job_alert_resend', String(alertId), { result: 'failure', detail: '告警不存在' });
    return res.status(404).json({ error: '告警不存在' });
  }
  await audit(req, 'job_alert_resend', String(alertId), { result: result.ok ? 'success' : 'failure', detail: result.ok ? '告警邮件已重新投递' : (result.error || '告警邮件投递失败') });
  res.status(result.ok ? 200 : 503).json(result);
}));
router.post('/jobs/alerts/:alertId/acknowledge', asyncHandler(async (req, res) => {
  const alertId = parseInt(req.params.alertId, 10);
  const alert = await acknowledgeAlert(alertId);
  if (!alert) {
    await audit(req, 'job_alert_acknowledge', String(alertId), { result: 'failure', detail: '告警不存在' });
    return res.status(404).json({ error: '告警不存在' });
  }
  await audit(req, 'job_alert_acknowledge', String(alert.alert_id), { detail: '确认邮件告警' });
  res.json({ ok: true, alert });
}));
router.post('/jobs/alert-email/test', asyncHandler(async (req, res) => {
  try {
    const result = await sendTestEmail();
    await audit(req, 'job_alert_email_test', 'smtp', { result: result.ok ? 'success' : 'failure', detail: result.ok ? '邮件测试成功' : result.error });
    res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    await audit(req, 'job_alert_email_test', 'smtp', { result: 'failure', detail: String(error.message || error) });
    res.status(503).json({ ok: false, error: String(error.message || error) });
  }
}));
router.post('/jobs/backfill', asyncHandler(async (req, res) => {
  const id = await startJobRun('manual_backfill');
  try {
    const result = await backfillMissingCloses({ scanAllMissingDates: true });
    await finishJobRun(id, true, '检查 ' + result.accounts + ' 个账户，发现 ' + result.missingDates + ' 个缺失交易日，补写 ' + result.recorded + ' 条价格');
    await audit(req, 'job_backfill', 'manual_backfill', {
      detail: '手动补漏收盘数据',
      metadata: { accounts: result.accounts, missingDates: result.missingDates, recorded: result.recorded },
    });
    res.json({ ok: true });
  } catch (e) {
    await finishJobRun(id, false, e.message || String(e));
    await audit(req, 'job_backfill', 'manual_backfill', { result: 'failure', detail: e.message || String(e) });
    res.status(500).json({ error: '补漏失败：' + (e.message || '未知错误') });
  }
}));
router.post('/jobs/holiday-sync', asyncHandler(async (req, res) => {
  const id = await startJobRun('manual_holiday_sync');
  try {
    await ensureHolidaysCurrent();
    await finishJobRun(id, true, '手动触发休市日历核对');
    await audit(req, 'job_holiday_sync', 'manual_holiday_sync', { detail: '手动核对休市日历' });
    res.json({ ok: true });
  } catch (e) {
    await finishJobRun(id, false, e.message || String(e));
    await audit(req, 'job_holiday_sync', 'manual_holiday_sync', { result: 'failure', detail: e.message || String(e) });
    res.status(500).json({ error: '休市核对失败：' + (e.message || '未知错误') });
  }
}));

// ====== 休市日历（读写 holidays.json，即时生效，无需部署）======
router.get('/holidays', asyncHandler(async (req, res) => {
  const obj = loadHolidays();
  res.json({ updatedAt: obj.updatedAt || '', years: obj.years || {} });
}));
router.put('/holidays', asyncHandler(async (req, res) => {
  const { year, dates } = req.body || {};
  const y = String(year || '').trim();
  if (!/^\d{4}$/.test(y)) return res.status(400).json({ error: '年份格式错误' });
  if (!Array.isArray(dates)) return res.status(400).json({ error: '日期列表非法' });
  const obj = loadHolidays();
  if (!obj.years) obj.years = {};
  obj.years[y] = dates.filter(function (d) { return typeof d === 'string'; });
  obj.updatedAt = new Date().toISOString().slice(0, 10);
  saveHolidays(obj);
  await audit(req, 'holiday_edit', y, { detail: '维护' + y + '年休市日，共' + obj.years[y].length + '天' });
  res.json({ ok: true });
}));

// ====== 大模型配置（图片/Excel识别所用模型，支持多模型兜底）======
// 地址仅要求 HTTPS 合法 URL（管理员录入受信任，识别调用时仍走 SSRF 校验并放行已配置域名）
function isValidModelUrl(u) {
  try { return new URL(u).protocol === 'https:'; } catch (e) { return false; }
}

router.get('/models', asyncHandler(async (req, res) => {
  const list = await getModels();
  list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  res.json({
    list: list.map(function (m) {
      return {
        id: m.id, name: m.name, model: m.model, apiUrl: m.apiUrl,
        apiKey: maskKey(m.apiKey), enabled: m.enabled !== false,
        order: m.order || 0, status: getStatus(m.id)
      };
    })
  });
}));

router.post('/models', asyncHandler(async (req, res) => {
  const { name, model, apiUrl, apiKey, enabled } = req.body || {};
  if (!name || !model || !apiUrl || !apiKey) return res.status(400).json({ error: '名称、模型名、API地址、API Key 均必填' });
  if (!isValidModelUrl(apiUrl)) return res.status(400).json({ error: 'API 地址必须是合法的 HTTPS 网址' });
  const list = await getModels();
  const id = 'm_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const maxOrder = list.reduce(function (mx, m) { return Math.max(mx, m.order || 0); }, -1);
  list.push({
    id: id, name: String(name).trim(), model: String(model).trim(),
    apiUrl: String(apiUrl).trim(), apiKey: String(apiKey).trim(),
    enabled: enabled !== false, order: maxOrder + 1
  });
  await saveModels(list);
  await audit(req, 'model_create', id, { detail: '新增大模型 ' + name });
  res.json({ ok: true, id });
}));

router.put('/models/:id', asyncHandler(async (req, res) => {
  const { name, model, apiUrl, apiKey, enabled } = req.body || {};
  if (!name || !model || !apiUrl) return res.status(400).json({ error: '名称、模型名、API地址均必填' });
  if (!isValidModelUrl(apiUrl)) return res.status(400).json({ error: 'API 地址必须是合法的 HTTPS 网址' });
  const list = await getModels();
  const m = list.find(function (x) { return x.id === req.params.id; });
  if (!m) return res.status(404).json({ error: '模型不存在' });
  const nextApiUrl = String(apiUrl).trim();
  const targetChanged = new URL(nextApiUrl).origin !== new URL(m.apiUrl).origin;
  const hasNewKey = !!(apiKey && String(apiKey).indexOf('***') < 0 && String(apiKey).trim());
  if (targetChanged && !hasNewKey) {
    return res.status(400).json({ error: '更换 API 服务地址时必须同时填写新的 API Key' });
  }
  m.name = String(name).trim();
  m.model = String(model).trim();
  m.apiUrl = nextApiUrl;
  m.enabled = enabled !== false;
  // 前端回传的打码 Key（含 ***）表示未改动，保留库中原值；否则更新
  if (hasNewKey) m.apiKey = String(apiKey).trim();
  await saveModels(list);
  await audit(req, 'model_update', m.id, { detail: '编辑大模型 ' + m.name });
  res.json({ ok: true });
}));

router.delete('/models/:id', asyncHandler(async (req, res) => {
  const list = await getModels();
  const m = list.find(function (x) { return x.id === req.params.id; });
  if (!m) return res.status(404).json({ error: '模型不存在' });
  await saveModels(list.filter(function (x) { return x.id !== req.params.id; }));
  await audit(req, 'model_delete', m.id, { detail: '删除大模型 ' + m.name });
  res.json({ ok: true });
}));

// 设为默认：排到最前并整体重新编号
router.post('/models/:id/default', asyncHandler(async (req, res) => {
  const list = await getModels();
  const m = list.find(function (x) { return x.id === req.params.id; });
  if (!m) return res.status(404).json({ error: '模型不存在' });
  list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  const rest = list.filter(function (x) { return x.id !== m.id; });
  const ordered = [m].concat(rest);
  ordered.forEach(function (x, i) { x.order = i; });
  await saveModels(ordered);
  await audit(req, 'model_default', m.id, { detail: '设为默认大模型 ' + m.name });
  res.json({ ok: true });
}));

// 上移/下移：与相邻模型交换顺序
router.post('/models/:id/move', asyncHandler(async (req, res) => {
  const dir = req.body && req.body.dir;
  if (dir !== 'up' && dir !== 'down') return res.status(400).json({ error: '方向非法' });
  const list = await getModels();
  list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  const idx = list.findIndex(function (x) { return x.id === req.params.id; });
  if (idx < 0) return res.status(404).json({ error: '模型不存在' });
  const swap = dir === 'up' ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= list.length) return res.json({ ok: true });
  const tmp = list[idx]; list[idx] = list[swap]; list[swap] = tmp;
  list.forEach(function (x, i) { x.order = i; });
  await saveModels(list);
  await audit(req, 'model_move', req.params.id, { detail: '调整大模型顺序' });
  res.json({ ok: true });
}));

// 测试连通性：发一次真实小请求（纯文本、极小 token），返回耗时与结果
router.post('/models/:id/test', asyncHandler(async (req, res) => {
  const list = await getModels();
  const m = list.find(function (x) { return x.id === req.params.id; });
  if (!m) return res.status(404).json({ error: '模型不存在' });
  const t0 = Date.now();
  try {
    // 管理员可配置自定义 HTTPS 域名，但连通性测试仍必须拒绝私网、回环和非 HTTPS 地址。
    const modelHost = new URL(m.apiUrl).hostname.toLowerCase();
    assertSafeUrl(m.apiUrl, [modelHost]);
    const r = await fetch(m.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + m.apiKey },
      body: JSON.stringify({
        model: m.model,
        messages: [{ role: 'user', content: '只回复OK两个字母' }],
        max_tokens: 5,
        temperature: 0
      }),
      signal: AbortSignal.timeout(20000)
    });
    const ms = Date.now() - t0;
    if (!r.ok) {
      const t = await r.text();
      const err = 'HTTP ' + r.status + ' ' + String(t).slice(0, 150);
      recordStatus(m.id, false, err, ms);
      return res.json({ ok: false, ms: ms, error: err });
    }
    const d = await r.json();
    const reply = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    recordStatus(m.id, true, '', ms);
    res.json({ ok: true, ms: ms, reply: String(reply).slice(0, 50) });
  } catch (e) {
    const ms = Date.now() - t0;
    recordStatus(m.id, false, e.message, ms);
    res.json({ ok: false, ms: ms, error: e.message });
  }
}));

// ====== 操作审计 ======
router.get('/audit', asyncHandler(async (req, res) => {
  const filter = {
    module: (req.query.module || '').trim(),
    actor: (req.query.actor || '').trim(),
    result: (req.query.result || '').trim(),
  };
  res.json({ list: await listAudit(req.query.limit, filter), modules: Object.keys(AUDIT_MODULES) });
}));

// ====== 知识分享管理 ======
// 文章列表（支持分页、按状态筛选）
router.get('/knowledge/articles', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const status = (req.query.status || '').trim();
  const params = [];
  let where = '';
  if (status === 'draft' || status === 'published') { params.push(status); where = 'WHERE a.status=$1'; }
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.status, a.view_count, a.author_username, a.published_at, a.updated_at,
            c.name AS category_name
     FROM articles a
     LEFT JOIN article_categories c ON c.id = a.category_id
     ${where}
     ORDER BY COALESCE(a.published_at, a.updated_at) DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS c FROM articles' + where, params);
  res.json({ total: cnt[0].c, list: rows, limit, offset });
}));
// 删除文章
router.delete('/knowledge/articles/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await pool.query('DELETE FROM articles WHERE id=$1', [id]);
  await audit(req, 'ks_article_delete', id, { detail: '后台删除投资笔记文章' });
  res.json({ ok: true });
}));
// 修改文章状态（草稿/发布）
router.put('/knowledge/articles/:id/status', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = req.body && req.body.status;
  if (status !== 'draft' && status !== 'published') return res.status(400).json({ error: '状态非法' });
  if (status === 'published') {
    const cur = await pool.query('SELECT share_token FROM articles WHERE id=$1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: '文章不存在' });
    const token = cur.rows[0].share_token || crypto.randomBytes(24).toString('hex');
    await pool.query(
      "UPDATE articles SET status='published', published_at=now(), share_token=$1, updated_at=now() WHERE id=$2",
      [token, id]
    );
  } else {
    await pool.query("UPDATE articles SET status='draft', published_at=NULL, updated_at=now() WHERE id=$1", [id]);
  }
  await audit(req, 'ks_article_status', id, { detail: status === 'published' ? '发布' : '撤回' });
  res.json({ ok: true });
}));

// 评论列表（支持分页、按文章筛选）
router.get('/knowledge/comments', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const articleId = req.query.article_id ? parseInt(req.query.article_id, 10) : null;
  const params = [];
  let where = '';
  if (articleId) { params.push(articleId); where = 'WHERE c.article_id=$1'; }
  const { rows } = await pool.query(
    `SELECT c.id, c.article_id,
            COALESCE(NULLIF(BTRIM(u.nickname), ''), c.author_username, c.nickname) AS nickname,
            c.content, c.parent_id, c.root_id, c.created_at,
            a.title AS article_title
     FROM article_comments c
     LEFT JOIN articles a ON a.id = c.article_id
     LEFT JOIN users u ON u.username = c.author_username
     ${where}
     ORDER BY c.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS c FROM article_comments' + where, params);
  res.json({ total: cnt[0].c, list: rows, limit, offset });
}));
// 删除评论
router.delete('/knowledge/comments/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await pool.query('DELETE FROM article_comments WHERE id=$1', [id]);
  await audit(req, 'ks_comment_delete', id, { detail: '后台删除评论' });
  res.json({ ok: true });
}));

// 写权限用户列表
router.get('/knowledge/users', asyncHandler(async (req, res) => {
  const search = (req.query.search || '').trim();
  const params = [];
  let where = '';
  if (search) { params.push('%' + search + '%'); where = 'WHERE username ILIKE $1'; }
  const { rows } = await pool.query(
    `SELECT username, role, status, knowledge_enabled
     FROM users ${where} ORDER BY created_at DESC, username`,
    params
  );
  res.json({ list: rows });
}));
// 开关用户写权限
router.post('/knowledge/users/:username/permission', asyncHandler(async (req, res) => {
  const username = req.params.username;
  if (username === req.session.user) {
    await audit(req, 'ks_permission', username, { result: 'failure', detail: '不能修改自己的权限' });
    return res.status(400).json({ error: '不能修改自己的权限' });
  }
  const enabled = !!(req.body && req.body.enabled);
  await setKnowledgeEnabled(username, enabled);
  await audit(req, 'ks_permission', username, { detail: enabled ? '开启写权限' : '关闭写权限', metadata: { enabled: enabled } });
  res.json({ ok: true, enabled });
}));

// ====== 全局参数（注册开关/邀请码/邮箱验证）======
router.get('/settings', asyncHandler(async (req, res) => {
  const [regOpen, regCode, email, externalApis] = await Promise.all([
    getConfig('register_open', '1'),
    getConfig('register_code', REGISTER_CODE || ''),
    getConfig('require_email', '0'),
    getExternalApiSettings()
  ]);
  res.json({ register_open: regOpen, register_code: regCode, require_email: email, external_apis: externalApis });
}));
router.put('/settings', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const externalInput = b.external_api && b.external_api.provider ? b.external_api : null;
  const externalProvider = externalInput ? String(externalInput.provider).trim() : '';
  if (externalInput && !EXTERNAL_API_PROVIDERS[externalProvider]) return res.status(400).json({ error: '不支持的外部 API' });
  const writes = [];
  if (Object.prototype.hasOwnProperty.call(b, 'register_open')) {
    writes.push(setConfig('register_open', (b.register_open === false || b.register_open === '0') ? '0' : '1'));
  }
  if (Object.prototype.hasOwnProperty.call(b, 'register_code')) writes.push(setConfig('register_code', b.register_code || ''));
  if (Object.prototype.hasOwnProperty.call(b, 'require_email')) {
    writes.push(setConfig('require_email', (b.require_email === true || b.require_email === '1') ? '1' : '0'));
  }
  if (writes.length) await Promise.all(writes);
  if (externalInput) {
    await saveProviderSettings(externalProvider, {
      primary_token: typeof externalInput.primary_token === 'string' ? externalInput.primary_token : undefined,
      backup_token: typeof externalInput.backup_token === 'string' ? externalInput.backup_token : undefined,
      clear_primary: externalInput.clear_primary === true,
      clear_backup: externalInput.clear_backup === true,
      mode: externalInput.mode,
      notify_on_switch: externalInput.notify_on_switch,
    });
    await audit(req, 'settings_external_api', externalProvider, {
      detail: '更新外部 API 主备参数',
      metadata: {
        provider: externalProvider,
        mode: externalInput.mode,
        notify_on_switch: externalInput.notify_on_switch,
        primary_changed: Boolean(externalInput.primary_token && String(externalInput.primary_token).trim()) || externalInput.clear_primary === true,
        backup_changed: Boolean(externalInput.backup_token && String(externalInput.backup_token).trim()) || externalInput.clear_backup === true,
      },
    });
  }
  await audit(req, 'settings_update', 'global', { detail: '更新全局参数' });
  res.json({ ok: true, external_apis: await getExternalApiSettings() });
}));

// 外部 API 主备手动切换：模式为 auto 时恢复自动故障转移。
router.post('/settings/external-api/:provider/switch', asyncHandler(async (req, res) => {
  const provider = String(req.params.provider || '').trim();
  const mode = String(req.body && req.body.mode || '').trim();
  if (!EXTERNAL_API_PROVIDERS[provider]) return res.status(400).json({ error: '不支持的外部 API' });
  if (!['auto', 'primary', 'backup'].includes(mode)) return res.status(400).json({ error: '切换模式非法' });
  const runtime = await switchProvider(provider, mode, { reason: '后台手动切换' });
  await audit(req, 'settings_external_api_switch', provider, {
    detail: `手动切换外部 API 到${mode === 'auto' ? '自动模式' : mode === 'primary' ? '主 Token' : '备用 Token'}`,
    metadata: { provider, mode },
  });
  const settings = await getExternalApiSettings();
  res.json({ ok: true, provider, mode: runtime.mode, settings: settings[provider] });
}));

// 外部 API 可用性测试：只测试指定主/备凭据，不触发自动故障转移。
router.post('/settings/external-api/:provider/test', asyncHandler(async (req, res) => {
  const provider = String(req.params.provider || '').trim();
  const role = String(req.body && req.body.role || 'current').trim();
  const apiName = String(req.body && req.body.api_name || 'trade_cal').trim();
  if (!EXTERNAL_API_PROVIDERS[provider]) return res.status(400).json({ error: '不支持的外部 API' });
  if (!['primary', 'backup', 'current'].includes(role)) return res.status(400).json({ error: '测试目标非法' });
  const result = await testProviderAvailability(provider, role, apiName);
  await audit(req, 'settings_external_api_test', provider, {
    result: result.ok ? 'success' : 'failure',
    detail: `${result.role === 'primary' ? '主' : '备用'} API 测试：${result.message}`,
    metadata: { provider, role: result.role, api_name: result.api_name, status: result.status, latency_ms: result.latency_ms },
  });
  const settings = await getExternalApiSettings();
  res.json({ ok: result.ok, result, settings: settings[provider] });
}));

// 外部 API 接口策略：只接受规则字段，凭据指纹由服务端当前主/备 Token 计算，客户端不能提交。
router.put('/settings/external-api/:provider/policies', asyncHandler(async (req, res) => {
  const provider = String(req.params.provider || '').trim();
  if (!EXTERNAL_API_PROVIDERS[provider]) return res.status(400).json({ error: '不支持的外部 API' });
  const input = req.body && Array.isArray(req.body.policies) ? req.body.policies : [req.body || {}];
  if (!input.length || input.length > 100) return res.status(400).json({ error: '策略数量非法' });
  if (input.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return res.status(400).json({ error: '策略格式非法' });
  const runtime = await getProviderRuntime(provider);
  for (const item of input) {
    const profile = String(item.credential_profile || item.credentialProfile || 'anonymous');
    if (!['primary', 'backup', 'anonymous'].includes(profile)) return res.status(400).json({ error: '凭据角色非法' });
    const token = profile === 'primary' ? runtime.primary : profile === 'backup' ? runtime.backup : '';
    await upsertSourceEndpointPolicy({
      ...item,
      source_code: provider,
      credential_profile: profile,
      credential_fingerprint: tokenFingerprint(token),
    });
  }
  await audit(req, 'settings_external_api_policies', provider, {
    detail: `更新${input.length}条接口策略`, metadata: {
      provider, count: input.length,
      api_names: input.map(item => String(item.api_name || item.apiName || '*').slice(0, 64)),
    },
  });
  const settings = await getExternalApiSettings();
  res.json({ ok: true, settings: settings[provider] });
}));

// ====== 套利机会审核 ======
router.get('/arbitrage/candidates', asyncHandler(async (req, res) => {
  const { page = 1, page_size = 50, status = 'pending' } = req.query;
  const result = await arbitrageSvc.getCandidates(parseInt(page), parseInt(page_size), status);
  res.json(result);
}));

router.get('/arbitrage/:caseId', asyncHandler(async (req, res) => {
  const detail = await arbitrageSvc.getCaseDetail(parseInt(req.params.caseId));
  if (!detail) return res.status(404).json({ error: '未找到该事件' });
  res.json(detail);
}));

router.patch('/arbitrage/:caseId', asyncHandler(async (req, res) => {
  const reviewer = req.session.user ? req.session.user.username : 'admin';
  const updated = await arbitrageSvc.updateCase(parseInt(req.params.caseId), req.body || {}, reviewer);
  if (!updated) return res.status(404).json({ error: '未找到该事件' });
  await audit(req, 'arbitrage_review', String(req.params.caseId), { detail: '审核/修改套利事件' });
  res.json({ ok: true, case: updated });
}));

router.post('/arbitrage/:caseId/reparse', asyncHandler(async (req, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  try {
    const result = await arbitrageSvc.queueReparseCase(caseId);
    if (!result) {
      await audit(req, 'arbitrage_reparse', String(caseId), { result: 'failure', detail: '未找到该事件', metadata: { caseId, resetRetries: true } });
      return res.status(404).json({ error: '未找到该事件' });
    }
    await audit(req, 'arbitrage_reparse', String(caseId), {
      result: result.ok ? 'success' : 'failure',
      detail: result.message || result.error || '人工重新解析已进入任务队列',
      metadata: { caseId, resetRetries: true, queued: Boolean(result.queued), slotId: result.slotId || null },
    });
    res.status(result.ok ? 202 : 503).json(result);
  } catch (error) {
    const safeError = sanitizeJobError(error.message || error, 500);
    await audit(req, 'arbitrage_reparse', String(caseId), { result: 'failure', detail: safeError, metadata: { caseId, resetRetries: true } });
    res.status(500).json({ error: safeError });
  }
}));

router.post('/arbitrage/sync', asyncHandler(async (req, res) => {
  try {
    const result = await arbitrageSvc.triggerSync();
    await audit(req, 'arbitrage_sync', 'manual', {
      result: result.ok ? 'success' : 'failure',
      detail: result.ok ? '手动套利公告同步已进入持久化任务队列' : result.error,
      metadata: { slotId: result.slotId || null, queued: Boolean(result.queued) },
    });
    res.status(result.ok ? 202 : 503).json(result);
  } catch (error) {
    const safeError = sanitizeJobError(error.message || error, 500);
    await audit(req, 'arbitrage_sync', 'manual', { result: 'failure', detail: safeError, metadata: { queued: false } });
    res.status(503).json({ ok: false, error: safeError });
  }
}));

module.exports = router;
