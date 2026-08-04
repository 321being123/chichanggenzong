// ========== 账户与数据 API 路由 ==========
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const asyncHandler = require('../middleware/async');
const { requireLogin, assertOwnership } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { validateAccountData, isValidAccountName } = require('../middleware/validate');
const { loadUser, updateUserAccounts, loadAccountData, saveAccountData, migrateToStructured, saveDailyPrices, syncUserAccounts, loadBrokers, isValidBroker, getAccountBrokers, updateAccountBroker, pool, backupNavHistory, restoreNavHistory, clearNavHistory, deleteAccountData, renameAccountData, upsertNav } = require('../db');
const { round } = require('../db/util');
const { fetchQuoteByCode, todayCN, toTsCode } = require('../services/market');
const { recomputeNav } = require('../jobs/replayNav');
const { getValuationByCodes } = require('../services/convertibleBondValuationService');
const tradeLedger = require('../services/tradeLedger');

// 乐观锁版本必填中间件（2026-08-04 第二轮修复）：核心业务写接口必须携带 ?version=，
// 缺失/非法 → 400，防止并发保护被"不带版本号"绕过。一致性校验在事务内 checkVersionInTxn 完成。
function requireVersion(req, res, next) {
  const v = req.query.version;
  if (v === undefined || v === null || v === '') {
    return res.status(400).json({ error: '缺少版本号（version），请刷新页面后重试' });
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1e9) {
    return res.status(400).json({ error: '版本号非法，请刷新页面后重试' });
  }
  next();
}

// ========== 账户账本局部接口（方案阶段三：交易增删改走服务端统一事务） ==========
// 前端交易录入不再自行计算持仓/现金，服务端事务完成后返回最新账户结果供刷新。
// 路由统一前缀 /api/accounts/:name/ledger/*（:name=账户名，保持与既有 /data/:name 一致的编码方式）

// 新增/修改交易：POST body={ trade: {...}, fromDate? }
router.post('/accounts/:name/ledger/trades', requireLogin, asyncHandler(assertOwnership), requireVersion, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const trade = req.body && req.body.trade;
  if (!trade) return res.status(400).json({ error: '缺少 trade' });
  try {
    const r = await tradeLedger.applyTrade(req.session.user, name, trade, null, req.query.version);
    if (r.skipped === 'duplicate') {
      // P1-4 服务端幂等：重复导入直接返回已存在，不重复写入。
      // 2026-08-04 第三轮修复：必须返回最新数据+版本——若第一次保存成功但响应丢失，
      // 重试命中后前端需要靠这里的 data 恢复最新状态，否则页面停留在旧数据/旧版本。
      const fresh = await tradeLedger.loadLedgerResult(req.session.user, name);
      return res.json({ ok: true, skipped: 'duplicate', id: r.id, data: fresh });
    }
    // 返回服务端最新账户结果（前端直接刷新内存，方案阶段二第 8 条）
    const fresh = await tradeLedger.loadLedgerResult(req.session.user, name);
    res.json({ ok: true, id: r.id, cash: r.cash, tradeDate: r.tradeDate, data: fresh });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 删除交易：DELETE body={ tradeId, fromDate? }
router.delete('/accounts/:name/ledger/trades/:tradeId', requireLogin, asyncHandler(assertOwnership), requireVersion, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const tradeId = req.params.tradeId;
  if (!tradeId) return res.status(400).json({ error: '缺少 tradeId' });
  try {
    const r = await tradeLedger.deleteTrade(req.session.user, name, tradeId, req.query.version);
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
router.delete('/accounts/:name/ledger/cash-flows/:flowId', requireLogin, asyncHandler(assertOwnership), requireVersion, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const flowId = req.params.flowId;
  if (!flowId) return res.status(400).json({ error: '缺少 flowId' });
  try {
    const r = await tradeLedger.deleteCashFlow(req.session.user, name, flowId, req.query.version);
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
router.post('/accounts/:name/ledger/position-events', requireLogin, asyncHandler(assertOwnership), requireVersion, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const event = req.body && req.body.event;
  if (!event) return res.status(400).json({ error: '缺少 event' });
  if (event.direction !== 'open' && event.direction !== 'adjust') {
    return res.status(400).json({ error: '方向必须为 open（期初建仓）或 adjust（持仓调整）' });
  }
  try {
    const r = await tradeLedger.applyTrade(req.session.user, name, event, null, req.query.version);
    const fresh = await tradeLedger.loadLedgerResult(req.session.user, name);
    res.json({ ok: true, id: r.id, data: fresh });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 批量期初建仓（粘贴导入）：POST /ledger/position-events/batch
// body={ events: [{ code, name, direction:'open', price, quantity, type, subtype, date, note }, ...] }
// 2026-08-04 阻断修复：整体走单事务，任一条失败 → 全部回滚（不再出现"提示失败但导入了一部分"）
router.post('/accounts/:name/ledger/position-events/batch', requireLogin, asyncHandler(assertOwnership), requireVersion, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const events = req.body && req.body.events;
  if (!Array.isArray(events) || events.length === 0) return res.status(400).json({ error: '缺少 events 数组' });
  for (const event of events) {
    if (event.direction !== 'open' && event.direction !== 'adjust') {
      return res.status(400).json({ error: '方向必须为 open 或 adjust' });
    }
  }
  try {
    const r = await tradeLedger.applyTradesBatch(req.session.user, name, events, req.query.version);
    const fresh = await tradeLedger.loadLedgerResult(req.session.user, name);
    res.json({ ok: true, ids: r.ids, added: r.added, data: fresh });
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
  const isRestore = req.query.restore === 'true';
  // 阶段三下线 saveData：日常调用（无 ?restore=true）直接 410 拒绝
  if (!isRestore) {
    return res.status(410).json({ error: '全量保存已下线，请刷新页面使用新版局部接口' });
  }
  // 全量导入恢复：跳过 changedDatasets/版本验证，按当前库版本强制覆盖全部数据集
  const v = validateAccountData(req.body);
  if (!v.ok) return res.status(400).json({ error: '数据校验失败：' + v.msg });
  const username = req.session.user;
  const accountName = decodeURIComponent(req.params.name);
  // 读取当前版本号作为乐观锁基值
  const { rows: verRows } = await pool.query(
    'SELECT COALESCE(version,0) as v FROM account_data WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const currentVersion = verRows[0] ? verRows[0].v : 0;
  try {
    const r = await saveAccountData(username, accountName, req.body, currentVersion, null, null);
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

// ========== 阶段二局部接口：替换 saveData 全量保存 ==========

// 2-5 行情价格批量更新：PATCH /api/positions/prices
// body={ prices: [{ code, price }], account }
router.patch('/positions/prices', requireLogin, asyncHandler(assertOwnership), requireVersion, rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const prices = req.body && req.body.prices;
  if (!Array.isArray(prices) || prices.length === 0) return res.status(400).json({ error: '缺少 prices 数组' });
  // 取当前账户（前端通过 currentAccount 全局变量传入 account 字段）
  const accountName = req.body.account;
  if (!accountName) return res.status(400).json({ error: '缺少 account' });
  const username = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 乐观锁（2026-08-04）：版本不一致 → 409
    await tradeLedger.checkVersionInTxn(client, username, accountName, req.query.version);
    for (const p of prices) {
      if (!p.code || p.price == null) continue;
      await client.query(
        'UPDATE positions SET price=$1 WHERE username=$2 AND account_name=$3 AND code=$4',
        [round(p.price, 4), username, accountName, p.code]
      );
    }
    // 提升 pos_version + 总版本（RETURNING 返回新版本号供前端同步，2026-08-04 第二轮修复）
    const upV = await client.query(
      `INSERT INTO account_data (username, account_name, data, version, pos_version) VALUES ($1,$2,'{}',0,0) ON CONFLICT (username, account_name) DO UPDATE SET pos_version=account_data.pos_version+1, version=account_data.version+1 RETURNING version`,
      [username, accountName]
    );
    await client.query('COMMIT');
    res.json({ ok: true, version: upV.rows[0] ? Number(upV.rows[0].version) : null });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
}));

// 2-4 持仓资料修改：PATCH /api/positions/:id/meta
// body={ name?, type?, subtype?, note? }
router.patch('/positions/:id/meta', requireLogin, asyncHandler(assertOwnership), requireVersion, rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const posId = req.params.id;
  if (!posId) return res.status(400).json({ error: '缺少 position id' });
  const accountName = req.body.account;
  if (!accountName) return res.status(400).json({ error: '缺少 account' });
  const username = req.session.user;
  const fields = ['name', 'type', 'subtype', 'note'];
  const sets = [];
  const vals = [username, accountName, posId];
  let idx = 4;
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      sets.push(f + '=$' + idx);
      vals.push(req.body[f]);
      idx++;
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: '没有要修改的字段' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 乐观锁（2026-08-04）：版本不一致 → 409
    await tradeLedger.checkVersionInTxn(client, username, accountName, req.query.version);
    await client.query(
      'UPDATE positions SET ' + sets.join(', ') + ' WHERE username=$1 AND account_name=$2 AND id=$3',
      vals
    );
    const upV = await client.query(
      `INSERT INTO account_data (username, account_name, data, version, pos_version) VALUES ($1,$2,'{}',0,0) ON CONFLICT (username, account_name) DO UPDATE SET pos_version=account_data.pos_version+1, version=account_data.version+1 RETURNING version`,
      [username, accountName]
    );
    await client.query('COMMIT');
    res.json({ ok: true, version: upV.rows[0] ? Number(upV.rows[0].version) : null });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
}));

// 2-1 账户设置/税费/汇率：PATCH /api/accounts/:name/settings
// body={ cashBase?, hkRate?, feeSettings?, cashType?, cashSubtype? }
router.patch('/accounts/:name/settings', requireLogin, asyncHandler(assertOwnership), requireVersion, rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const username = req.session.user;
  const sets = [];
  const vals = [username, name];
  let idx = 3;
  if (req.body.cashBase !== undefined) {
    sets.push('cash_base=$' + idx);
    vals.push(round(req.body.cashBase, 2));
    idx++;
  }
  if (req.body.hkRate !== undefined) {
    sets.push('hk_rate=$' + idx);
    vals.push(round(req.body.hkRate, 6));
    idx++;
  }
  if (req.body.feeSettings !== undefined) {
    sets.push('fee_settings=$' + idx);
    vals.push(typeof req.body.feeSettings === 'object' ? JSON.stringify(req.body.feeSettings) : req.body.feeSettings);
    idx++;
  }
  if (req.body.cashType !== undefined) {
    sets.push('cash_type=$' + idx);
    vals.push(req.body.cashType);
    idx++;
  }
  if (req.body.cashSubtype !== undefined) {
    sets.push('cash_subtype=$' + idx);
    vals.push(req.body.cashSubtype);
    idx++;
  }
  if (sets.length === 0) return res.status(400).json({ error: '没有要修改的设置' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 乐观锁（2026-08-04）：版本不一致 → 409
    await tradeLedger.checkVersionInTxn(client, username, name, req.query.version);
    await client.query(
      'UPDATE accounts SET ' + sets.join(', ') + ', updated_at=to_char(now(),\'YYYY-MM-DD HH24:MI:SS\'), version=COALESCE(version,0)+1 WHERE username=$1 AND account_name=$2',
      vals
    );
    // 同步提升 account_data 总版本（并发乐观锁基准），RETURNING 返回新版本号供前端同步
    const upV = await client.query(
      `INSERT INTO account_data (username, account_name, data, version) VALUES ($1,$2,'{}',0)
       ON CONFLICT (username, account_name) DO UPDATE SET version=account_data.version+1 RETURNING version`,
      [username, name]
    );
    await client.query('COMMIT');
    res.json({ ok: true, version: upV.rows[0] ? Number(upV.rows[0].version) : null });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
}));

// 2-2 现金流新增：POST /api/accounts/:name/ledger/cash-flows
// cashFlow.id 由前端生成（幂等键）：重复提交同一 id 不新增第二条
router.post('/accounts/:name/ledger/cash-flows', requireLogin, asyncHandler(assertOwnership), requireVersion, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const cf = req.body && req.body.cashFlow;
  if (!cf) return res.status(400).json({ error: '缺少 cashFlow' });
  try {
    const r = await tradeLedger.addCashFlow(req.session.user, name, cf, req.query.version);
    res.json({ ok: true, id: r.id, cash: r.cash, data: r.data });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 2-3 单日净值 UPSERT：PUT /api/nav/:date
// body={ nav, totalAsset?, invested?, account, fromDate? }
router.put('/nav/:date', requireLogin, asyncHandler(assertOwnership), requireVersion, rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式错误' });
  const accountName = req.body.account;
  if (!accountName) return res.status(400).json({ error: '缺少 account' });
  const username = req.session.user;
  if (!req.body.nav || isNaN(parseFloat(req.body.nav))) return res.status(400).json({ error: '缺少有效净值' });
  const rec = {
    date: date,
    nav: parseFloat(req.body.nav),
    totalAsset: req.body.totalAsset != null ? parseFloat(req.body.totalAsset) : null,
    invested: req.body.invested != null ? parseFloat(req.body.invested) : null,
  };
  try {
    // fromDate：编辑改日期时传旧日期，服务端事务内先删旧再写新（2026-08-04 阻断修复）
    // bumpVersion=true：前端主动保存净值，提升总版本（后台任务的 upsertNav 不提升）
    await upsertNav(username, accountName, rec, req.body.fromDate || null, req.query.version, true);
    // 前端需要同步版本号 → 返回加载结果即可（含版本号）
    const result = await loadAccountData(username, accountName);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// 2-3 单日净值删除：DELETE /api/nav/:date
// body={ account }
router.delete('/nav/:date', requireLogin, asyncHandler(assertOwnership), requireVersion, rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式错误' });
  const accountName = req.body.account;
  if (!accountName) return res.status(400).json({ error: '缺少 account' });
  const username = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await tradeLedger.checkVersionInTxn(client, username, accountName, req.query.version);
    await client.query(
      'DELETE FROM nav_history WHERE username=$1 AND account_name=$2 AND date=$3',
      [username, accountName, date]
    );
    await client.query(
      `INSERT INTO account_data (username, account_name, data, version, nav_version) VALUES ($1,$2,'{}',0,0) ON CONFLICT (username, account_name) DO UPDATE SET nav_version=account_data.nav_version+1, version=account_data.version+1`,
      [username, accountName]
    );
    await client.query('COMMIT');
    const result = await loadAccountData(username, accountName);
    res.json({ ok: true, data: result });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
}));

// 2-7 历史净值批量导入：POST /api/nav/import
// body={ account, records: [{ date, nav, totalAsset?, invested? }], mode?: 'replace'|'merge' }
router.post('/nav/import', requireLogin, asyncHandler(assertOwnership), requireVersion, rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '导入过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const accountName = req.body.account;
  if (!accountName) return res.status(400).json({ error: '缺少 account' });
  const username = req.session.user;
  const records = req.body.records;
  if (!Array.isArray(records) || records.length === 0) return res.status(400).json({ error: '缺少有效净值记录' });
  const client = await pool.connect();
  const { rows: aRows } = await client.query(
    'SELECT id FROM accounts WHERE username=$1 AND account_name=$2', [username, accountName]
  );
  const accountId = aRows[0] ? aRows[0].id : null;
  try {
    await client.query('BEGIN');
    // 乐观锁（2026-08-04）：版本不一致 → 409
    await tradeLedger.checkVersionInTxn(client, username, accountName, req.query.version);
    // 全量替换模式：先清空再导入
    if (req.body.mode === 'replace') {
      await client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
    }
    for (const r of records) {
      if (!r.date || r.nav == null) continue;
      await client.query(
        'INSERT INTO nav_history (username, account_name, account_id, date, nav, total_asset, invested) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (username, account_name, date) DO UPDATE SET nav=EXCLUDED.nav, total_asset=EXCLUDED.total_asset, invested=EXCLUDED.invested',
        [username, accountName, accountId, r.date, round(r.nav, 6), r.totalAsset != null ? round(r.totalAsset, 2) : null, r.invested != null ? round(r.invested, 2) : null]
      );
    }
    await client.query(
      `INSERT INTO account_data (username, account_name, data, version, nav_version) VALUES ($1,$2,'{}',0,0) ON CONFLICT (username, account_name) DO UPDATE SET nav_version=account_data.nav_version+1, version=account_data.version+1`,
      [username, accountName]
    );
    await client.query('COMMIT');
    const result = await loadAccountData(username, accountName);
    res.json({ ok: true, count: records.length, data: result });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
}));

// 暴露 isAdmin 供测试与安全审计使用（不改变 router 导出，app.js 仍以 router 挂载）
router.isAdmin = isAdmin;

module.exports = router;
