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

// PERM-02：后台入口仅要求员工身份（管理员或任一后台能力），具体接口按路径前缀再校验对应能力。
// 后端独立校验——前端菜单可隐藏，但不能作为安全边界。
router.use(requireStaff);

// 后台接口 → 所需能力 映射（按路径前缀派发，避免逐个 handler 脆弱改动）
function adminCapabilityForPath(p) {
  if (p.indexOf('/users') === 0) return 'user_manage';
  if (p.indexOf('/knowledge') === 0) return 'content_manage';
  if (p.indexOf('/brokers') === 0 || p.indexOf('/jobs') === 0 || p.indexOf('/holidays') === 0 ||
      p.indexOf('/models') === 0 || p.indexOf('/settings') === 0) return 'ops_manage';
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
  m.name = String(name).trim();
  m.model = String(model).trim();
  m.apiUrl = String(apiUrl).trim();
  m.enabled = enabled !== false;
  // 前端回传的打码 Key（含 ***）表示未改动，保留库中原值；否则更新
  if (apiKey && String(apiKey).indexOf('***') < 0) m.apiKey = String(apiKey).trim();
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
  const [regOpen, regCode, email] = await Promise.all([
    getConfig('register_open', '1'),
    getConfig('register_code', REGISTER_CODE || ''),
    getConfig('require_email', '0')
  ]);
  res.json({ register_open: regOpen, register_code: regCode, require_email: email });
}));
router.put('/settings', asyncHandler(async (req, res) => {
  const b = req.body || {};
  await Promise.all([
    setConfig('register_open', (b.register_open === false || b.register_open === '0') ? '0' : '1'),
    setConfig('register_code', b.register_code || ''),
    setConfig('require_email', (b.require_email === true || b.require_email === '1') ? '1' : '0')
  ]);
  await audit(req, 'settings_update', 'global', { detail: '更新全局参数' });
  res.json({ ok: true });
}));

module.exports = router;
