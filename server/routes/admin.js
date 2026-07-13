// ========== 管理后台路由（统一前缀 /api/admin，全部接口需管理员权限）==========
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireAdmin } = require('../middleware/auth');
const { REGISTER_CODE } = require('../config');
const {
  adminOverview, countUsers, listUsers, setUserRole, setUserStatus, adminSetPassword,
  deleteUser, getUserDetail, hashPwd, adminListBrokers, createBroker, updateBroker, deleteBroker,
  isValidBroker, adminJobRuns, startJobRun, finishJobRun,
  getConfig, setConfig,
  listAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
  getChangelog, addChangelogItem, auditLog, listAudit, pool
} = require('../db');
const { backfillMissingCloses } = require('../jobs/marketClose');
const { ensureHolidaysCurrent } = require('../jobs/holidaySync');
const { loadHolidays, saveHolidays } = require('../config/holidays');

// 该路由下其余接口均需管理员鉴权（数据库 role=admin 或 ADMIN_USERS 白名单）
router.use(requireAdmin);

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
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: '角色非法' });
  if (role !== 'admin' && req.params.username === req.session.user) return res.status(400).json({ error: '不能取消自己的管理员权限' });
  await setUserRole(req.params.username, role);
  await auditLog(req.session.user, 'user_role', req.params.username, '设为' + (role === 'admin' ? '管理员' : '普通用户')).catch(() => {});
  res.json({ ok: true });
}));
router.post('/users/:username/status', asyncHandler(async (req, res) => {
  const status = req.body && req.body.status;
  if (status !== 'active' && status !== 'disabled') return res.status(400).json({ error: '状态非法' });
  if (status !== 'active' && req.params.username === req.session.user) return res.status(400).json({ error: '不能禁用自己的账号' });
  await setUserStatus(req.params.username, status);
  await auditLog(req.session.user, 'user_status', req.params.username, status === 'active' ? '启用' : '禁用').catch(() => {});
  res.json({ ok: true });
}));
router.post('/users/:username/password', asyncHandler(async (req, res) => {
  const pwd = req.body && req.body.password;
  if (!pwd || typeof pwd !== 'string' || pwd.length < 6) return res.status(400).json({ error: '密码至少6位' });
  await adminSetPassword(req.params.username, hashPwd(pwd));
  await auditLog(req.session.user, 'user_password', req.params.username, '管理员重置密码').catch(() => {});
  res.json({ ok: true });
}));
router.delete('/users/:username', asyncHandler(async (req, res) => {
  if (req.params.username === req.session.user) return res.status(400).json({ error: '不能删除当前登录账号' });
  await deleteUser(req.params.username);
  await auditLog(req.session.user, 'user_delete', req.params.username, '删除用户及全部数据').catch(() => {});
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
  await auditLog(req.session.user, 'broker_create', code, '新增券商 ' + name).catch(() => {});
  res.json({ ok: true });
}));
router.put('/brokers/:code', asyncHandler(async (req, res) => {
  const { name, market, sort_order, import_unit } = req.body || {};
  if (!name || !market) return res.status(400).json({ error: '名称、市场均必填' });
  if (!['A', 'H', 'U'].includes(market)) return res.status(400).json({ error: '市场非法' });
  if (import_unit && !['sheet', 'lot'].includes(import_unit)) return res.status(400).json({ error: '导入单位非法' });
  await updateBroker(req.params.code, { name, market, sort_order: sort_order ? parseInt(sort_order, 10) || 0 : 0, import_unit: import_unit || 'sheet' });
  await auditLog(req.session.user, 'broker_update', req.params.code, '编辑券商').catch(() => {});
  res.json({ ok: true });
}));
router.delete('/brokers/:code', asyncHandler(async (req, res) => {
  await deleteBroker(req.params.code);
  await auditLog(req.session.user, 'broker_delete', req.params.code, '删除券商').catch(() => {});
  res.json({ ok: true });
}));

// ====== 定时任务监控 ======
router.get('/jobs', asyncHandler(async (req, res) => {
  res.json(await adminJobRuns(req.query.limit));
}));
router.post('/jobs/backfill', asyncHandler(async (req, res) => {
  const id = await startJobRun('manual_backfill');
  try {
    await backfillMissingCloses();
    await finishJobRun(id, true, '手动触发收盘数据补漏');
    await auditLog(req.session.user, 'job_backfill', 'manual_backfill', '手动补漏收盘数据').catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    await finishJobRun(id, false, e.message || String(e));
    res.status(500).json({ error: '补漏失败：' + (e.message || '未知错误') });
  }
}));
router.post('/jobs/holiday-sync', asyncHandler(async (req, res) => {
  const id = await startJobRun('manual_holiday_sync');
  try {
    await ensureHolidaysCurrent();
    await finishJobRun(id, true, '手动触发休市日历核对');
    await auditLog(req.session.user, 'job_holiday_sync', 'manual_holiday_sync', '手动核对休市日历').catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    await finishJobRun(id, false, e.message || String(e));
    res.status(500).json({ error: '休市核对失败：' + (e.message || '未知错误') });
  }
}));

// ====== 平台公告 ======
router.get('/announcements', asyncHandler(async (req, res) => {
  res.json({ list: await listAnnouncements() });
}));
router.post('/announcements', asyncHandler(async (req, res) => {
  const { title, content, pinned, published_at } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: '标题必填' });
  const id = await createAnnouncement({ title: title.trim(), content: content || '', pinned: !!pinned, published_at: published_at || '' });
  await auditLog(req.session.user, 'announce_create', id, '发布公告：' + title).catch(() => {});
  res.json({ ok: true, id });
}));
router.put('/announcements/:id', asyncHandler(async (req, res) => {
  const { title, content, pinned, published_at } = req.body || {};
  await updateAnnouncement(req.params.id, { title: (title || '').trim(), content: content || '', pinned: !!pinned, published_at: published_at || '' });
  await auditLog(req.session.user, 'announce_update', req.params.id, '编辑公告').catch(() => {});
  res.json({ ok: true });
}));
router.delete('/announcements/:id', asyncHandler(async (req, res) => {
  await deleteAnnouncement(req.params.id);
  await auditLog(req.session.user, 'announce_delete', req.params.id, '删除公告').catch(() => {});
  res.json({ ok: true });
}));

// ====== 版本记录（changelog.json 可视化编辑）======
router.get('/changelog', asyncHandler(async (req, res) => {
  res.json({ list: getChangelog() });
}));
router.post('/changelog', asyncHandler(async (req, res) => {
  const { date, item } = req.body || {};
  if (!date || !item || !item.trim()) return res.status(400).json({ error: '日期与更新内容均必填' });
  const list = addChangelogItem(date, item.trim());
  await auditLog(req.session.user, 'changelog_add', date, '新增更新记录：' + item).catch(() => {});
  res.json({ ok: true, list });
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
  await auditLog(req.session.user, 'holiday_edit', y, '维护' + y + '年休市日，共' + obj.years[y].length + '天').catch(() => {});
  res.json({ ok: true });
}));

// ====== 操作审计 ======
router.get('/audit', asyncHandler(async (req, res) => {
  res.json({ list: await listAudit(req.query.limit) });
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
  await auditLog(req.session.user, 'settings_update', 'global', '更新全局参数').catch(() => {});
  res.json({ ok: true });
}));

module.exports = router;
