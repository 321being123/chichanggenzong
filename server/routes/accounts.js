// ========== 账户与数据 API 路由 ==========
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const asyncHandler = require('../middleware/async');
const { requireLogin, assertOwnership } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { validateAccountData, isValidAccountName } = require('../middleware/validate');
const { loadUser, updateUserAccounts, loadAccountData, saveAccountData, migrateToStructured, saveDailyPrices, syncUserAccounts, loadBrokers, isValidBroker, getAccountBrokers, updateAccountBroker, pool, backupNavHistory, restoreNavHistory, clearNavHistory, deleteAccountData, renameAccountData } = require('../db');
const { fetchQuoteByCode, todayCN, toTsCode } = require('../services/market');
const { recomputeNav } = require('../jobs/replayNav');
const { getValuationByCodes } = require('../services/convertibleBondValuationService');
const tradeLedger = require('../services/tradeLedger');

// ========== 账户账本局部接口（方案阶段三：交易增删改走服务端统一事务） ==========
// 前端交易录入不再自行计算持仓/现金，服务端事务完成后返回最新账户结果供刷新。
// 路由统一前缀 /api/accounts/:name/ledger/*（:name=账户名，保持与既有 /data/:name 一致的编码方式）

// 新增/修改交易：POST body={ trade: {...}, fromDate? }
router.post('/accounts/:name/ledger/trades', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const trade = req.body && req.body.trade;
  if (!trade) return res.status(400).json({ error: '缺少 trade' });
  try {
    const r = await tradeLedger.applyTrade(req.session.user, name, trade);
    if (r.skipped === 'duplicate') {
      // P1-4 服务端幂等：重复导入直接返回已存在，不重复写入
      return res.json({ ok: true, skipped: 'duplicate', id: r.id });
    }
    // 返回服务端最新账户结果（前端直接刷新内存，方案阶段二第 8 条）
    const fresh = await tradeLedger.loadLedgerResult(req.session.user, name);
    res.json({ ok: true, id: r.id, cash: r.cash, tradeDate: r.tradeDate, data: fresh });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 删除交易：DELETE body={ tradeId, fromDate? }
router.delete('/accounts/:name/ledger/trades/:tradeId', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const tradeId = req.params.tradeId;
  if (!tradeId) return res.status(400).json({ error: '缺少 tradeId' });
  try {
    const r = await tradeLedger.deleteTrade(req.session.user, name, tradeId);
    // P1-3：服务端自动触发历史净值重算闭环（删除交易影响该日之后净值，不依赖前端）
    try { await recomputeNav(req.session.user, name, r.fromDate || todayCN()); } catch (e) { console.warn('[ledger] 净值重算跳过:', e.message); }
    const fresh = await tradeLedger.loadLedgerResult(req.session.user, name);
    res.json({ ok: true, cash: r.cash, data: fresh });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 清空交易：DELETE /ledger/trades
router.delete('/accounts/:name/ledger/trades', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  try {
    const r = await tradeLedger.clearTrades(req.session.user, name);
    const fresh = await tradeLedger.loadLedgerResult(req.session.user, name);
    res.json({ ok: true, cash: r.cash, data: fresh });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 删除现金流：DELETE /ledger/cash-flows/:flowId（删除后服务端重算现金并返回最新结果）
router.delete('/accounts/:name/ledger/cash-flows/:flowId', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const flowId = req.params.flowId;
  if (!flowId) return res.status(400).json({ error: '缺少 flowId' });
  try {
    const r = await tradeLedger.deleteCashFlow(req.session.user, name, flowId);
    // P1-3：现金流变动影响全部历史净值，触发重算闭环
    try { await recomputeNav(req.session.user, name, r.fromDate || todayCN()); } catch (e) { console.warn('[ledger] 净值重算跳过:', e.message); }
    const fresh = await tradeLedger.loadLedgerResult(req.session.user, name);
    res.json({ ok: true, cash: r.cash, data: fresh });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 期初持仓/持仓调整事件（P0-2 验收修复）：POST /ledger/position-events
// body={ event: { code, name, direction: 'open'|'adjust', price?, quantity(+/-), date } }
// open=期初建仓（等效买入，记成本，不计现金）；adjust=持仓调整（数量可正可负，仅校正数量/成本）
router.post('/accounts/:name/ledger/position-events', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const event = req.body && req.body.event;
  if (!event) return res.status(400).json({ error: '缺少 event' });
  if (event.direction !== 'open' && event.direction !== 'adjust') {
    return res.status(400).json({ error: '方向必须为 open（期初建仓）或 adjust（持仓调整）' });
  }
  try {
    const r = await tradeLedger.applyTrade(req.session.user, name, event);
    const fresh = await tradeLedger.loadLedgerResult(req.session.user, name);
    res.json({ ok: true, id: r.id, data: fresh });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

router.get('/accounts', requireLogin, asyncHandler(async (req, res) => {
  // 2026-08-03 整改（报告 8.3）：账户列表唯一权威来源 = accounts 表。
  // users.accounts JSON 仅作"从未同步过的新用户"首登兜底（syncUserAccounts 后自动转为表来源）。
  const { rows } = await pool.query('SELECT account_name FROM accounts WHERE username=$1 ORDER BY created_at', [req.session.user]);
  if (rows.length > 0) return res.json(rows.map(r => r.account_name));
  const u = await loadUser(req.session.user);
  const legacy = (u && u.accounts) || ['默认账户'];
  // 同步进 accounts 表，此后列表只读表
  try { await syncUserAccounts(req.session.user, legacy); } catch (e) { console.warn('[accounts] 首登同步失败:', e.message); }
  res.json(legacy);
}));

router.put('/accounts', requireLogin, asyncHandler(async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: '账户列表格式错误' });
  if (req.body.length > 50) return res.status(400).json({ error: '账户数量超限' });
  for (const name of req.body) {
    if (!isValidAccountName(name)) return res.status(400).json({ error: '账户名含非法字符或长度不合法' });
  }
  // 单用户原子更新账户列表，杜绝全表快照并发覆盖
  await updateUserAccounts(req.session.user, req.body);
  // P2-3：同步结构化 accounts 表（新增补行、移除删除行），作为列表权威来源
  await syncUserAccounts(req.session.user, req.body);
  res.json({ ok: true });
}));

// 券商字典：返回券商清单供前端下拉（?market=A/HK/US 可选，默认全部）
router.get('/brokers', requireLogin, asyncHandler(async (req, res) => {
  const market = req.query.market || null;
  res.json(await loadBrokers(market));
}));

// 当前用户各账户的券商映射 { 账户名: broker code }（供账户管理弹窗回填下拉）
router.get('/accounts/broker', requireLogin, asyncHandler(async (req, res) => {
  res.json(await getAccountBrokers(req.session.user));
}));

// 更新单个账户的券商（用户在账户管理里显式选择）。UPDATE 限定本人 username，天然隔离越权。
router.put('/accounts/broker', requireLogin, asyncHandler(async (req, res) => {
  const { account_name, broker } = req.body || {};
  if (!account_name || !broker) return res.status(400).json({ error: '缺少 account_name 或 broker' });
  if (!(await isValidBroker(broker))) return res.status(400).json({ error: '券商代码不合法' });
  const n = await updateAccountBroker(req.session.user, account_name, broker);
  if (n === 0) return res.status(404).json({ error: '账户不存在' });
  res.json({ ok: true });
}));

router.get('/data/:name', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const result = await loadAccountData(req.session.user, name);
  // 附加券商信息（供前端判断交易数量单位转换：华泰等券商上交所债券以「手」录入需×10）
  const { rows: acctRows } = await pool.query(
    "SELECT a.broker, b.import_unit FROM accounts a LEFT JOIN brokers b ON a.broker=b.code WHERE a.username=$1 AND a.account_name=$2",
    [req.session.user, name]
  );
  if (acctRows.length > 0) {
    result._broker = acctRows[0].broker || 'other';
    result._brokerImportUnit = acctRows[0].import_unit || 'sheet';
  }
  // 附加当前行情涨跌幅（异步，不阻塞返回）
  if (result.positions && result.positions.length > 0) {
    result.changes = {};
    const codes = result.positions.map(p => p.code).filter(Boolean);
    // 并发拉取行情，超时3秒
    await Promise.all(codes.map(async (code) => {
      try {
        const q = await fetchQuoteByCode(code);
        if (q && q.change != null) result.changes[code] = q.change;
        // 搜特退债已退市，涨跌幅默认0
        if (!q && code === '404002') result.changes['404002'] = 0;
      } catch (e) {}
    }));
    // 附加可转债估值对照表（仅取可转债 6 位代码，一次批量查询；失败不影响持仓加载）
    try {
      const bondCodes = codes
        .map(c => String(c || '').trim().replace(/\.(SH|SZ|BJ|HK|US)$/i, ''))
        .filter(c => /^\d{6}$/.test(c));
      result.valuation_map = bondCodes.length ? await getValuationByCodes(bondCodes) : {};
    } catch (e) {
      result.valuation_map = {};
    }
  }
  res.json(result);
}));

router.put('/data/:name', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const v = validateAccountData(req.body);
  if (!v.ok) return res.status(400).json({ error: '数据校验失败：' + v.msg });
  // 乐观锁（P1-3）：version 必填且必须为整数；缺失/非整数/越界直接拒绝，不再保留绕过路径
  if (req.query.version == null || req.query.version === '') {
    return res.status(400).json({ error: '缺少版本号（version），请刷新页面后重试' });
  }
  const expectedVersion = parseInt(req.query.version, 10);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 1e9) {
    return res.status(400).json({ error: '版本号（version）非法' });
  }
  // 数据集级版本（2026-08-03 整改）：前端带回加载时的各数据集版本，服务端只写入版本一致的数据集，
  // 版本落后（被后台任务/其他浏览器改过）的数据集跳过写入并提示，防止旧快照覆盖新数据（报告 8.2）。
  const dv = {
    positions: req.query.posV === undefined ? undefined : parseInt(req.query.posV, 10),
    trades: req.query.tradeV === undefined ? undefined : parseInt(req.query.tradeV, 10),
    navHistory: req.query.navV === undefined ? undefined : parseInt(req.query.navV, 10),
    cashFlows: req.query.cashV === undefined ? undefined : parseInt(req.query.cashV, 10),
  };
  for (const k of Object.keys(dv)) {
    if (dv[k] !== undefined && (!Number.isInteger(dv[k]) || dv[k] < 0 || dv[k] > 1e9)) {
      return res.status(400).json({ error: '数据集版本号非法' });
    }
  }
  // P0-2 阻断修复（2026-08-03）：四个数据集版本必须**全部**提供且合法。
  // 只要求"至少一个版本"会导致只传 posV 即放行，其余数据集（尤其 navHistory）走 db 层
  // match(undefined)=允许写入 → 后台新增净值仍可被旧客户端覆盖。全带=新客户端；缺任一=409 提示刷新。
  const hasAllDatasetVersions = dv.positions !== undefined && dv.trades !== undefined &&
    dv.navHistory !== undefined && dv.cashFlows !== undefined;
  if (!hasAllDatasetVersions) {
    return res.status(409).json({ error: '页面版本过旧，无法安全保存，请刷新页面后重试' });
  }
  try {
    const r = await saveAccountData(req.session.user, decodeURIComponent(req.params.name), req.body, expectedVersion, dv);
    res.json({
      ok: true,
      version: r.version,
      posVersion: r.posVersion,
      tradeVersion: r.tradeVersion,
      navVersion: r.navVersion,
      cashflowVersion: r.cashflowVersion,
      skipped: r.skipped || []
    });
  } catch (e) {
    if (e && e.conflict) return res.status(409).json({ error: e.message });
    throw e;
  }
}));

// 晚录入交易 → 历史净值精确回填：从 fromDate 起重算该账户 nav_history（幂等 upsert）。
// 鉴权：本人账户归属校验；限频：每分钟最多 10 次，防误刷。
router.post('/data/:name/recompute-nav', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'recompute', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '回填过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const fromDate = req.body && req.body.fromDate;
  if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return res.status(400).json({ error: 'fromDate 格式应为 YYYY-MM-DD' });
  }
  const r = await recomputeNav(req.session.user, name, fromDate);
  if (!r.ok) return res.status(400).json({ error: r.error || '回填失败' });
  res.json({ ok: true, days: r.days || 0 });
}));

// 管理员判定：仅 ADMIN_USERS 环境变量中的用户名可触发运维类操作；未配置则一律拒绝
function isAdmin(username) {
  const admins = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
  return admins.includes(username);
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req.session.user)) return res.status(403).json({ error: '无权限：该操作仅限管理员执行' });
  next();
}

// 一次性手动触发：把 account_data JSON 里残留的净值/持仓/交易/现金流合并进结构化表（幂等，不覆盖已有）。
// 2026-08-03 架构整改（报告 3.4）：迁移只能执行一次——已归档账户（data_source_version=2）不再回灌，
// 防止"用户删除的数据被 /migrate-json 再次导入"。全局数据运维任务，仅管理员可调，记录操作人。
router.post('/migrate-json', requireLogin, requireAdmin, asyncHandler(async (req, res) => {
  console.log('[migrate-json] 操作人:', req.session.user, '时间:', new Date().toISOString());
  const r = await migrateToStructured();
  res.json({ ok: true, ...r });
}));

// ========== 账户生命周期（2026-08-03 架构整改，报告 3.6/3.7/阶段四） ==========
// 删除/重命名均走 db 层 deleteAccountData / renameAccountData（单事务覆盖业务表 + 兼容 JSON +
// users.accounts 列表同步），路由仅做参数校验与鉴权，事务逻辑与测试共用同一真实实现。

// 删除账户：单事务删除该账户全部业务数据 + 账户元数据 + 兼容 JSON + users.accounts 列表项
router.delete('/accounts/:name', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  try {
    await deleteAccountData(req.session.user, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// 重命名账户：单事务内把所有业务表 + 账户元数据 + 兼容 JSON + users.accounts 列表改为新名
router.post('/accounts/:name/rename', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const oldName = decodeURIComponent(req.params.name);
  const newName = (req.body && req.body.newName) || '';
  if (!isValidAccountName(newName)) return res.status(400).json({ error: '新账户名含非法字符或长度不合法' });
  if (newName === oldName) return res.json({ ok: true });
  try {
    const r = await renameAccountData(req.session.user, oldName, newName);
    if (r.conflict) return res.status(409).json({ error: r.conflict });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// 导出持仓为 Excel
router.get('/export/:name', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const result = await loadAccountData(req.session.user, name);
    const positions = result.positions || [];
    const hkRate = result.hkRate || 0.868;

    const rows = [['代码', '代码', '正股/转债名称', '现价', '持有数量', '人民币市值', '持仓比例', '类型', '细类']];
    var totalRmb = 0;

    positions.forEach(function (p) {
      var code = p.code || '';
      var canonicalCode = toTsCode(code);
      var suffix = canonicalCode.startsWith(code) ? canonicalCode.slice(code.length) : '';

      var price = Number(p.price) || 0;
      var qty = Number(p.quantity) || 0;
      var mv = price * qty;
      if (p.subtype === '港股') { mv = mv * hkRate; }

      var priceDisplay = p.subtype === '港股' ? 'HK$' + price.toFixed(2) : price.toFixed(2);
      totalRmb += mv;

      rows.push([code, code + suffix, p.name || '', priceDisplay, qty, Math.round(mv * 100) / 100, 0, p.type || '', p.subtype || '']);
    });

    // 计算比例
    var totalAsset = result.totalAsset > 0 ? result.totalAsset : totalRmb;
    for (var i = 1; i < rows.length; i++) {
      rows[i][6] = totalAsset > 0 ? Math.round(rows[i][5] / totalAsset * 10000) / 10000 : 0;
    }

    // 尾部加入现金行
    var cash = Number(result.cash) || 0;
    var totalWithCash = totalAsset;
    var cashPct = totalWithCash > 0 ? Math.round(cash / totalWithCash * 10000) / 10000 : 0;
    rows.push([null, null, null, null, null, Math.round(cash * 100) / 100, cashPct, '债权', '现金']);

    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('Sheet1');
    ws.columns = [{ width: 10 }, { width: 14 }, { width: 20 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 8 }, { width: 10 }];
    ws.addRows(rows);

    var buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="export.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// ========== 每日收盘价记录 ==========
router.post('/daily-prices/:name', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { prices, date } = req.body;
    if (!prices || !prices.length) return res.json({ ok: true });
    await saveDailyPrices(req.session.user, name, date || todayCN(), prices);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}));

// ========== 历史净值备份/还原/清理（导入前自动拍快照，误导入可一键还原） ==========
// ⚠️ 2026-08-03 修复：必须操作真实数据源 nav_history 表（页面读取来源），而非 account_data.data JSONB
//    （旧实现导致"接口成功但刷新无变化"）。逻辑集中在 db 层 backupNavHistory/restoreNavHistory/clearNavHistory。

// 备份当前 nav_history 到 nav_history_backup（导入前调用）
router.post('/accounts/:name/backup-nav-history', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '备份过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const r = await backupNavHistory(req.session.user, name);
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 清理历史数据（按模式）：invested-only 清空投入本金字段让公式回算；before-date 删除某日期前（含）
router.post('/accounts/:name/clear-nav-history', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '清理过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { mode, beforeDate } = req.body || {};
    const r = await clearNavHistory(req.session.user, name, mode, beforeDate);
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 一键还原：校验备份存在，将 nav_history_backup 写回 nav_history 表，并提升 version
router.post('/accounts/:name/restore-nav-history', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '还原请求过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const r = await restoreNavHistory(req.session.user, name);
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 查看备份信息（前端按钮显示"备份时间"；无备份时 hasBackup=false）
router.get('/accounts/:name/nav-history-backup-info', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { rows } = await pool.query(
      `SELECT nav_history_backup_at AS at,
              jsonb_array_length(COALESCE(nav_history_backup, '[]'::jsonb)) AS rows
         FROM account_data WHERE username=$1 AND account_name=$2`,
      [req.session.user, name]
    );
    if (!rows.length || !rows[0].at) return res.json({ hasBackup: false });
    res.json({ hasBackup: true, at: rows[0].at, rows: rows[0].rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// 暴露 isAdmin 供测试与安全审计使用（不改变 router 导出，app.js 仍以 router 挂载）
router.isAdmin = isAdmin;

module.exports = router;
