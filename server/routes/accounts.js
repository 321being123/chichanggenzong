// ========== 账户与数据 API 路由 ==========
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const asyncHandler = require('../middleware/async');
const { requireLogin, assertOwnership, requireAdmin } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { validateAccountData, isValidAccountName } = require('../middleware/validate');
const { loadUser, updateUserAccounts, loadAccountData, loadAccountSummary, saveAccountData, migrateToStructured, saveDailyPrices, syncUserAccounts, loadBrokers, isValidBroker, getAccountBrokers, updateAccountBroker, pool, backupNavHistory, restoreNavHistory, clearNavHistory, deleteAccountData, renameAccountData, upsertNav } = require('../db');
const { round } = require('../db/util');
const { fetchQuotesByCodes, todayCN, toTsCode, validateDailyPriceBatch } = require('../services/market');
const { recomputeNav } = require('../jobs/replayNav');
const { getValuationByCodes } = require('../services/convertibleBondValuationService');
const { applyPrivateCache } = require('../middleware/publicCache');
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

// 根据当前持仓反向回放导入日之后的交易，得到导入日的系统持仓数量。
// 导入历史收益时不能直接拿当前数量估值，否则导入日之后的买卖会被重复计入。
function buildAnchorPositions(positionRows, tradeRows, anchorDate) {
  const rowsByCode = new Map((positionRows || []).map((p) => [String(p.code), { ...p, quantity: Number(p.quantity) || 0 }]));
  for (const t of (tradeRows || [])) {
    const code = String(t.code || '');
    if (code && !rowsByCode.has(code)) {
      rowsByCode.set(code, { code, name: t.name || '', price: 0, quantity: 0, subtype: t.subtype || '', type: t.type || '' });
    }
  }
  const eventsByCode = new Map();
  for (const t of (tradeRows || [])) {
    const code = String(t.code || '');
    const d = String(t.trade_date || t.date || '').slice(0, 10);
    if (!code || d <= anchorDate) continue;
    if (!eventsByCode.has(code)) eventsByCode.set(code, []);
    eventsByCode.get(code).push(t);
  }
  const unsupported = [];
  for (const [code, events] of eventsByCode) {
    const row = rowsByCode.get(code);
    let quantity = Number(row.quantity) || 0;
    events.sort((a, b) => String(b.executed_at || b.created_at || b.date || '').localeCompare(String(a.executed_at || a.created_at || a.date || '')));
    for (const t of events) {
      const q = Number(t.quantity) || 0;
      if (t.direction === 'adjust') {
        unsupported.push(code);
        break;
      }
      // 反向撤销导入日之后的数量变化；open 与 buy 都是增加持仓。
      quantity += t.direction === 'sell' ? q : -q;
    }
    row.quantity = quantity;
  }
  if (unsupported.length) {
    const e = new Error('历史导入日期之后存在无法反向重建的持仓调整：' + [...new Set(unsupported)].join(', '));
    e.status = 422;
    throw e;
  }
  return [...rowsByCode.values()];
}

// 历史导入日可能是周末，或当日收盘任务尚未补齐。
// 取导入日前最近一个“所有锚点持仓都有有效收盘价”的日期，避免把整批数据误判为缺价。
async function loadAnchorPrices(username, accountName, anchorDate, anchorPositions) {
  const codes = [...new Set((anchorPositions || [])
    .filter((p) => Number(p.quantity) !== 0)
    .map((p) => String(p.code || ''))
    .filter(Boolean))];
  if (!codes.length) return { prices: new Map(), priceDate: null };
  const { rows: exactRows } = await pool.query(
    `SELECT code, price::float8 AS price
       FROM daily_prices
      WHERE username=$1 AND account_name=$2 AND date=$3
        AND code=ANY($4::text[]) AND price > 0`,
    [username, accountName, anchorDate, codes]
  );
  const exactPrices = new Map(exactRows.map((p) => [String(p.code), Number(p.price)]));
  if (exactRows.length === codes.length) {
    return { prices: exactPrices, priceDate: anchorDate };
  }
  // 当天已有部分行情但并不完整时，也必须整批回退到前一个完整收盘日，
  // 不能把当天部分价格和前一完整日价格混用成一个锚点。
  const { rows } = await pool.query(
    `WITH candidate AS (
       SELECT date::text AS price_date
         FROM daily_prices
        WHERE username=$1 AND account_name=$2 AND date < $3
          AND code = ANY($4::text[]) AND price > 0
        GROUP BY date
       HAVING COUNT(DISTINCT code) = $5
        ORDER BY date DESC
        LIMIT 1
     )
     SELECT dp.code, dp.price::float8 AS price, c.price_date AS "priceDate"
       FROM candidate c
       JOIN daily_prices dp
         ON dp.username=$1 AND dp.account_name=$2
        AND dp.date=c.price_date AND dp.code=ANY($4::text[])
        AND dp.price > 0`,
    [username, accountName, anchorDate, codes, codes.length]
  );
  const priceDate = rows[0] ? String(rows[0].priceDate).slice(0, 10) : null;
  return {
    prices: rows.length ? new Map(rows.map((p) => [String(p.code), Number(p.price)])) : exactPrices,
    priceDate
  };
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
  if (String(req.query.scope || '').toLowerCase() === 'summary') {
    const summary = await loadAccountSummary(req.session.user, name);
    if (applyPrivateCache(req, res, [req.session.user, name, summary.version, summary.posVersion,
      summary.tradeVersion, summary.navVersion, summary.cashflowVersion].join('|'))) return;
    return res.json(summary);
  }
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
    // 所有持仓一次批量取行情，避免按证券逐只访问上游。
    try {
      const quotes = await fetchQuotesByCodes(codes);
      codes.forEach(code => {
        const q = quotes[code];
        if (q && q.change != null) result.changes[code] = q.change;
      });
    } catch (e) {}
    // 附加可转债估值对照表（仅取可转债 6 位代码，一次批量查询；失败不影响持仓加载）
    try {
      const bondCodes = codes
        .map(c => String(c || '').trim().replace(/\.(SH|SZ|BJ|HK|US)$/i, ''))
        .filter(c => /^\d{6}$/.test(c));
      result.valuation_map = bondCodes.length ? await getValuationByCodes(bondCodes) : {};
    } catch (e) {
      result.valuation_map = {};
    }
    // 附加真实昨收价（取自 daily_prices 上一交易日），供前端拆分「股价影响」时消除行情涨跌幅精度误差
    try {
      const today = todayCN();
      const navs = result.navHistory || [];
      const previousDate = navs.length >= 2 ? String(navs[navs.length - 2].date).slice(0, 10) : null;
      const { rows: prevRows } = await pool.query(
        `SELECT code, price::text AS price
           FROM daily_prices
          WHERE username = $1 AND account_name = $2 AND date = $3 AND code = ANY($4::text[])`,
        [req.session.user, name, previousDate || today, codes]
      );
      const previousPrices = {};
      prevRows.forEach(r => { previousPrices[r.code] = Number(r.price); });
      result.previousPrices = previousPrices;
      result.previousPricesDate = previousDate || today;
      result.previousPricesComplete = codes.every(code => Number.isFinite(previousPrices[code]));
    } catch (e) {
      result.previousPrices = {};
    }
  }
  res.json(result);
}));

// 只读归因接口：页面或审计工具可单独读取后端统一归因结果。
router.get('/nav/attribution/:name', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const result = await loadAccountData(req.session.user, name);
  res.json({ ok: true, attribution: result.navAttribution || { complete: false, reason: 'not_available' } });
}));

// ========== DATA-01 阶段二：快照导入专用接口（替代 PUT /api/data/:name?restore=true 整包写） ==========
// 逻辑集中在此 helper，前端导入与历史兼容调用统一走这里：强制全量覆盖全部数据集、跳过版本校验。
async function doImportSnapshot(username, accountName, body) {
  const v = validateAccountData(body);
  if (!v.ok) return { status: 400, error: '数据校验失败：' + v.msg };
  const { rows: verRows } = await pool.query(
    'SELECT COALESCE(version,0) as v FROM account_data WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const currentVersion = verRows[0] ? verRows[0].v : 0;
  try {
    const r = await saveAccountData(username, accountName, body, currentVersion, null, null);
    return {
      status: 200,
      body: {
        ok: true,
        version: r.version,
        posVersion: r.posVersion,
        tradeVersion: r.tradeVersion,
        navVersion: r.navVersion,
        cashflowVersion: r.cashflowVersion,
        skipped: r.skipped || []
      }
    };
  } catch (e) {
    if (e && e.conflict) return { status: 409, error: e.message };
    throw e;
  }
}

router.put('/data/:name', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  // 阶段三下线 saveData：日常与恢复整包写入统一走 POST /api/accounts/:name/import-snapshot
  return res.status(410).json({ error: '全量保存已下线，请刷新页面使用新版局部接口或快照导入功能' });
}));

// 快照导入：全量覆盖账户全部数据集（持仓/交易/现金流/净值/设置），跳过版本校验，按当前库版本强制覆盖。
// 鉴权：本人账户归属校验 + 限频；数据校验失败 400；导入后返回最新版本号供前端同步。
router.post('/accounts/:name/import-snapshot', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '导入过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const accountName = decodeURIComponent(req.params.name);
  const r = await doImportSnapshot(req.session.user, accountName, req.body);
  if (r.status !== 200) return res.status(r.status).json({ error: r.error });
  res.json(r.body);
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

// 管理员判定统一走 server/middleware/auth.js 的 requireAdmin（数据库 role=admin 或 ADMIN_USERS 白名单，
// 并校验账号状态与会话版本），不再在此重复实现第二套逻辑（AUTH-03）。

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
    const targetDate = date || todayCN();
    const validation = validateDailyPriceBatch(targetDate, prices);
    if (!validation.ok) return res.status(400).json(validation);
    await saveDailyPrices(req.session.user, name, validation.date, prices);
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
    if (req.body.hkRate !== undefined) {
      const globalRate = round(req.body.hkRate, 6);
      await client.query(
        `INSERT INTO market.fx_rates(base_currency,quote_currency,rate_date,source_id,rate,fetched_at)
         VALUES ('HKD','CNY',(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,7,$1,now())
         ON CONFLICT (base_currency,quote_currency,rate_date)
         DO UPDATE SET source_id=7, rate=EXCLUDED.rate, fetched_at=EXCLUDED.fetched_at`,
        [globalRate]
      );
      await client.query(
        "UPDATE accounts SET hk_rate=$1, hk_rate_updated_at=now(), updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')",
        [globalRate]
      );
    }
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
    hkRate: req.body.hkRate != null ? parseFloat(req.body.hkRate) : null,
    snapshot_at: null,
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
    const { rows: locked } = await client.query(
      `SELECT is_locked AS "isLocked", source_priority AS "sourcePriority"
         FROM nav_history WHERE username=$1 AND account_name=$2 AND date=$3 FOR UPDATE`,
      [username, accountName, date]
    );
    if (locked[0] && locked[0].isLocked === true && Number(locked[0].sourcePriority || 0) >= 100) {
      const e = new Error('券商导入快照已锁定，不能删除');
      e.status = 409;
      throw e;
    }
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
// body={ account, records: [{ date, nav, totalAsset, invested, cash }], mode?: 'replace'|'merge' }
router.post('/nav/import', requireLogin, asyncHandler(assertOwnership), requireVersion, rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '导入过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const accountName = req.body.account;
  if (!accountName) return res.status(400).json({ error: '缺少 account' });
  const username = req.session.user;
  const records = req.body.records;
  if (!Array.isArray(records) || records.length === 0) return res.status(400).json({ error: '缺少有效净值记录' });
  const requiredNumber = (value) => value == null || value === '' ? NaN : Number(value);
  const normalized = records.map((r) => ({
    date: String(r.date || '').slice(0, 10),
    nav: requiredNumber(r.nav),
    totalAsset: requiredNumber(r.totalAsset),
    invested: requiredNumber(r.invested),
    cash: r.cash == null || r.cash === '' ? null : Number(r.cash),
    hkRate: r.hkRate == null || r.hkRate === '' ? null : Number(r.hkRate)
  }));
  const bad = normalized.find((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
    !Number.isFinite(r.nav) || r.nav < 0 || !Number.isFinite(r.totalAsset) || r.totalAsset < 0 ||
    !Number.isFinite(r.invested) || (r.cash != null && (!Number.isFinite(r.cash) || r.cash < 0 || r.cash > r.totalAsset)) ||
    (r.hkRate != null && (!Number.isFinite(r.hkRate) || r.hkRate <= 0)));
  if (bad) return res.status(400).json({ error: '权威导入必须包含合法的日期、净值、总资产和累计投入资金；现金可留空，但不能为负数或大于总资产' });
  // 券商导出可能同一天出现多条修订记录；按已有后写覆盖语义保留最后一行，避免整批导入失败。
  const byDate = new Map();
  normalized.forEach((r) => byDate.set(r.date, r));
  const normalizedRecords = [...byDate.values()];
  const duplicateCount = normalized.length - normalizedRecords.length;
  const minImportDate = normalizedRecords.reduce((m, r) => !m || r.date < m ? r.date : m, '');
  const maxImportDate = normalizedRecords.reduce((m, r) => r.date > m ? r.date : m, '');
  const importBatchId = String(req.body.importBatchId || crypto.randomUUID());
  const inputHash = crypto.createHash('sha256').update(JSON.stringify({ mode: req.body.mode || 'merge', records: normalizedRecords })).digest('hex');
  const client = await pool.connect();
  const { rows: aRows } = await client.query(
    'SELECT id FROM accounts WHERE username=$1 AND account_name=$2', [username, accountName]
  );
  const accountId = aRows[0] ? aRows[0].id : null;
  try {
    await client.query('BEGIN');
    const { rows: oldBatch } = await client.query(
      `SELECT id, input_hash AS "inputHash", row_count AS "rowCount"
         FROM nav_import_batches WHERE username=$1 AND account_name=$2
           AND (id=$3 OR input_hash=$4)
         ORDER BY CASE WHEN id=$3 THEN 0 ELSE 1 END, imported_at DESC
         LIMIT 1 FOR UPDATE`,
      [username, accountName, importBatchId, inputHash]
    );
    if (oldBatch[0]) {
      if (oldBatch[0].inputHash !== inputHash) {
        const e = new Error('importBatchId 已存在但内容不同，拒绝覆盖');
        e.status = 409;
        throw e;
      }
      await client.query('COMMIT');
      const result = await loadAccountData(username, accountName);
      return res.json({ ok: true, idempotent: true, batchId: oldBatch[0].id, count: Number(oldBatch[0].rowCount || records.length), data: result });
    }
    // 乐观锁（2026-08-04）：版本不一致 → 409；幂等重试已在上面无写入返回，不受旧版本影响。
    await tradeLedger.checkVersionInTxn(client, username, accountName, req.query.version);
    const { rows: currentNav } = await client.query(
      `SELECT date, nav, total_asset AS "totalAsset", invested, snapshot_at, hk_rate AS "hkRate",
              cash_cny AS "cashCny", market_value_cny AS "marketValueCny", system_market_value_at_snapshot AS "systemMarketValueAtSnapshot",
              snapshot_source AS "snapshotSource", source_priority AS "sourcePriority", import_batch_id AS "importBatchId",
              calc_status AS "calcStatus", diagnostics, is_locked AS "isLocked", input_hash AS "inputHash"
         FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date`, [username, accountName]
    );
    const hasStoredNumber = (value) => value != null && value !== '' && Number.isFinite(Number(value));
    const existingCashByDate = new Map(currentNav.filter((n) => hasStoredNumber(n.cashCny))
      .map((n) => [String(n.date || '').slice(0, 10), Number(n.cashCny)]));
    normalizedRecords.forEach((r) => {
      if (r.cash == null) r.cash = existingCashByDate.has(r.date) ? existingCashByDate.get(r.date) : 0;
    });
    // merge 仅补导更早历史时，保留库中较新的完整券商锚点。
    // 旧批次只补历史总资产/净值，不应为了一个不会生效的旧锚点强制要求整套历史持仓行情。
    const latestExistingAnchor = currentNav.filter((n) =>
      n.snapshotSource === 'imported' && n.isLocked !== false &&
      hasStoredNumber(n.cashCny) && hasStoredNumber(n.marketValueCny) &&
      hasStoredNumber(n.systemMarketValueAtSnapshot)
    ).reduce((latest, n) => {
      const date = String(n.date || '').slice(0, 10);
      return !latest || date > latest ? date : latest;
    }, '');
    const preserveExistingAnchor = req.body.mode !== 'replace' && latestExistingAnchor > maxImportDate;
    const { rows: posRows } = await client.query(
      `SELECT code, name, price::float8 AS price, quantity::float8 AS quantity, subtype, type
         FROM positions WHERE username=$1 AND account_name=$2`, [username, accountName]
    );
    const { rows: tradeRows } = await client.query(
      `SELECT code, name, direction, quantity::float8 AS quantity, trade_date, date, executed_at, created_at, subtype, type,
              quote_currency, amount_cny::float8 AS amount_cny
         FROM trades WHERE username=$1 AND account_name=$2`, [username, accountName]
    );
    const anchorPositions = preserveExistingAnchor ? [] : buildAnchorPositions(posRows, tradeRows, maxImportDate);
    const { rows: acctRows } = await client.query(
      `SELECT hk_rate::float8 AS hk_rate FROM accounts WHERE username=$1 AND account_name=$2`, [username, accountName]
    );
    const requestedAnchorDate = maxImportDate;
    const { rows: fxRows } = await client.query(
      `SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate FROM market.fx_rates
        WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
        ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`, [requestedAnchorDate]
    );
    const fxAtDate = (date) => {
      let rate = 0;
      for (const row of fxRows) {
        const rowDate = row.rate_date instanceof Date
          ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(row.rate_date)
          : String(row.rate_date).slice(0, 10);
        if (rowDate <= date && Number(row.rate) > 0) rate = Number(row.rate);
      }
      return rate;
    };
    const anchorRecord = normalizedRecords.find((r) => r.date === requestedAnchorDate);
    const systemRate = anchorRecord && anchorRecord.hkRate > 0 ? anchorRecord.hkRate :
      (fxAtDate(requestedAnchorDate) || (acctRows[0] && Number(acctRows[0].hk_rate) > 0 ? Number(acctRows[0].hk_rate) : 0));
    const anchorPriceData = preserveExistingAnchor
      ? { prices: new Map(), priceDate: null }
      : await loadAnchorPrices(username, accountName, requestedAnchorDate, anchorPositions);
    const dayPrices = anchorPriceData.prices;
    const anchorPriceDate = anchorPriceData.priceDate;
    const missingCodes = [];
    if (!preserveExistingAnchor && requestedAnchorDate !== todayCN() && (!anchorPriceDate || anchorPositions.some((p) => Number(p.quantity) !== 0 && !(dayPrices.get(String(p.code)) > 0)))) {
      anchorPositions.forEach((p) => { if (Number(p.quantity) !== 0 && !(dayPrices.get(String(p.code)) > 0)) missingCodes.push(String(p.code)); });
      const e = new Error('历史导入日期缺少持仓收盘价，无法建立精确锚点：' + [...new Set(missingCodes)].join(', '));
      e.status = 422;
      throw e;
    }
    if (!preserveExistingAnchor && anchorPositions.some((p) => Number(p.quantity) !== 0 && p.subtype === '港股') && !(systemRate > 0)) {
      const e = new Error('历史导入日期缺少港币兑人民币汇率，无法建立精确锚点');
      e.status = 422;
      throw e;
    }
    const systemMarketValue = preserveExistingAnchor ? null : anchorPositions.reduce((sum, p) => {
      const quantity = Number(p.quantity) || 0;
      if (quantity === 0) return sum;
      const price = requestedAnchorDate === todayCN() ? (Number(p.price) || 0) : dayPrices.get(String(p.code));
      const mv = price * quantity;
      return sum + (p.subtype === '港股' ? mv * systemRate : mv);
    }, 0);
    const priorLatestCash = currentNav.length && currentNav[currentNav.length - 1].cashCny != null
      ? Number(currentNav[currentNav.length - 1].cashCny) : null;
    await client.query(
      `INSERT INTO nav_import_batches (id, username, account_name, range_start, range_end, row_count, input_hash, status, backup_payload, diagnostics)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'committed',$8::jsonb,$9::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [importBatchId, username, accountName, minImportDate, maxImportDate, normalizedRecords.length, inputHash,
        JSON.stringify(currentNav), JSON.stringify({ systemRate, systemMarketValue, preservedAnchorDate: preserveExistingAnchor ? latestExistingAnchor : null })]
    );
    // 全量替换模式：先清空再导入
    if (req.body.mode === 'replace') {
      await client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
    }
    for (const r of normalizedRecords) {
      const brokerPositionValue = round(r.totalAsset - r.cash, 2);
      const isAnchor = !preserveExistingAnchor && r.date === maxImportDate;
      await client.query(
        `INSERT INTO nav_history
          (username, account_name, account_id, date, nav, total_asset, invested, snapshot_at, hk_rate,
           cash_cny, market_value_cny, system_market_value_at_snapshot, broker_fx_rate,
           snapshot_source, source_priority, import_batch_id, calc_status, diagnostics, is_locked, input_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'imported',100,$14,$15,$16,true,$17)
         ON CONFLICT (username, account_name, date) DO UPDATE SET
           nav=EXCLUDED.nav, total_asset=EXCLUDED.total_asset, invested=EXCLUDED.invested, snapshot_at=EXCLUDED.snapshot_at,
           hk_rate=EXCLUDED.hk_rate, cash_cny=EXCLUDED.cash_cny, market_value_cny=EXCLUDED.market_value_cny,
           system_market_value_at_snapshot=EXCLUDED.system_market_value_at_snapshot, broker_fx_rate=EXCLUDED.broker_fx_rate,
           snapshot_source='imported', source_priority=100, import_batch_id=EXCLUDED.import_batch_id,
           calc_status=EXCLUDED.calc_status, diagnostics=EXCLUDED.diagnostics, is_locked=true, input_hash=EXCLUDED.input_hash`,
        [username, accountName, accountId, r.date, round(r.nav, 6), round(r.totalAsset, 2), round(r.invested, 2),
           `${r.date} 23:59:59`, round(r.hkRate != null && r.hkRate > 0 ? r.hkRate : (fxAtDate(r.date) || systemRate), 6),
          round(r.cash, 2), brokerPositionValue, isAnchor ? round(systemMarketValue, 2) : null,
          r.hkRate != null && r.hkRate > 0 ? round(r.hkRate, 6) : null, importBatchId,
          isAnchor ? (anchorPriceDate && anchorPriceDate !== requestedAnchorDate ? 'broker_previous_close' : 'broker_exact') : 'total_authoritative',
          JSON.stringify({
            source: 'broker_import',
            position_source_gap_cny: isAnchor ? round(brokerPositionValue - systemMarketValue, 2) : null,
            cash_replacement_delta_cny: isAnchor && priorLatestCash != null ? round(r.cash - priorLatestCash, 2) : null,
            position_price_date: isAnchor ? anchorPriceDate : null,
            position_price_fallback: isAnchor && anchorPriceDate && anchorPriceDate !== requestedAnchorDate ? 'previous_complete_close' : null
          }), inputHash]
      );
      if (isAnchor) {
        // 前一完整收盘日用于周末/行情未落库日时，把同一组价格固化到导入日，
        // 让后续归因查询仍能按导入日读取，并可被之后的真实收盘价覆盖。
        if (anchorPriceDate && anchorPriceDate !== requestedAnchorDate) {
          for (const p of anchorPositions) {
            const price = dayPrices.get(String(p.code));
            if (!(price > 0)) continue;
            await client.query(
              `INSERT INTO daily_prices (username, account_name, account_id, date, code, name, price)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (username, account_name, date, code) DO UPDATE SET
                 name=EXCLUDED.name, price=EXCLUDED.price`,
              [username, accountName, accountId, requestedAnchorDate, p.code, p.name || '', price]
            );
          }
        }
        await client.query('DELETE FROM nav_position_snapshots WHERE snapshot_id=$1', [importBatchId]);
        for (const p of anchorPositions) {
          const price = maxImportDate === todayCN()
            ? (Number(p.price) || 0)
            : (dayPrices.get(String(p.code)) > 0 ? dayPrices.get(String(p.code)) : (Number(p.quantity) === 0 ? 0 : null));
          const fx = p.subtype === '港股' ? systemRate : 1;
          await client.query(
            `INSERT INTO nav_position_snapshots
               (snapshot_id, username, account_name, snapshot_date, instrument_code, quantity, price,
                quote_currency, fx_rate_to_cny, market_value_cny, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [importBatchId, username, accountName, maxImportDate, p.code, Number(p.quantity) || 0,
              price, p.subtype === '港股' ? 'HKD' : 'CNY', fx,
              round(price * (Number(p.quantity) || 0) * fx, 2),
              anchorPriceDate && anchorPriceDate !== requestedAnchorDate ? 'system_previous_close' : 'system_daily_price']
          );
        }
      }
    }
    // 导入成功后，导入批次的最新日期之前只保留导入数据；清理旧的系统/手工快照，
    // 避免它们继续混入历史曲线或在后续刷新时被误当成有效历史。
    const { rowCount: deletedLegacyRows } = await client.query(
      `DELETE FROM nav_history
         WHERE username=$1 AND account_name=$2
           AND COALESCE(snapshot_source, '') <> 'imported'
           AND date < (
             SELECT MAX(date) FROM nav_history
              WHERE username=$1 AND account_name=$2 AND snapshot_source='imported'
           )`,
      [username, accountName]
    );
    await client.query(
      `INSERT INTO account_data (username, account_name, data, version, nav_version) VALUES ($1,$2,'{}',0,0) ON CONFLICT (username, account_name) DO UPDATE SET nav_version=account_data.nav_version+1, version=account_data.version+1`,
      [username, accountName]
    );
    await client.query('COMMIT');
    const result = await loadAccountData(username, accountName);
    res.json({ ok: true, batchId: importBatchId, count: normalizedRecords.length, duplicates: duplicateCount, deletedLegacyRows, data: result });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
}));

// 导入批次回滚：只允许回滚本账户已提交批次，恢复导入前的 nav_history 备份。
router.post('/nav/import/:batchId/rollback', requireLogin, asyncHandler(assertOwnership), requireVersion, rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '回滚过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const accountName = req.body && req.body.account;
  const batchId = String(req.params.batchId || '');
  if (!accountName || !batchId) return res.status(400).json({ error: '缺少 account 或 batchId' });
  const username = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await tradeLedger.checkVersionInTxn(client, username, accountName, req.query.version);
    const { rows: batches } = await client.query(
      `SELECT id, status, backup_payload FROM nav_import_batches
        WHERE id=$1 AND username=$2 AND account_name=$3 FOR UPDATE`,
      [batchId, username, accountName]
    );
    if (!batches[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '导入批次不存在' });
    }
    if (batches[0].status === 'rolled_back') {
      await client.query('COMMIT');
      return res.json({ ok: true, idempotent: true, data: await loadAccountData(username, accountName) });
    }
    const backup = Array.isArray(batches[0].backup_payload) ? batches[0].backup_payload : [];
    const { rows: aRows } = await client.query('SELECT id FROM accounts WHERE username=$1 AND account_name=$2', [username, accountName]);
    const accountId = aRows[0] ? aRows[0].id : null;
    await client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
    await client.query('DELETE FROM nav_position_snapshots WHERE username=$1 AND account_name=$2 AND snapshot_id=$3', [username, accountName, batchId]);
    for (const n of backup) {
      await client.query(
        `INSERT INTO nav_history
          (username, account_name, account_id, date, nav, total_asset, invested, snapshot_at, hk_rate,
           cash_cny, market_value_cny, system_market_value_at_snapshot, broker_fx_rate,
           snapshot_source, source_priority, import_batch_id, calc_status, diagnostics, is_locked, input_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [username, accountName, accountId, n.date, round(n.nav, 6), round(n.totalAsset, 2), n.invested == null ? null : round(n.invested, 2),
          n.snapshot_at || null, n.hkRate || null, n.cashCny == null ? null : round(n.cashCny, 2),
          n.marketValueCny == null ? null : round(n.marketValueCny, 2), n.systemMarketValueAtSnapshot == null ? null : round(n.systemMarketValueAtSnapshot, 2),
          n.brokerFxRate || null, n.snapshotSource || 'legacy', Number(n.sourcePriority || 10), n.importBatchId || null,
          n.calcStatus || 'complete', JSON.stringify(n.diagnostics || {}), n.isLocked === true, n.inputHash || null]
      );
    }
    await client.query(`UPDATE nav_import_batches SET status='rolled_back' WHERE id=$1`, [batchId]);
    await client.query(
      `INSERT INTO account_data (username, account_name, data, version, nav_version)
       VALUES ($1,$2,'{}',0,1)
       ON CONFLICT (username, account_name) DO UPDATE SET version=account_data.version+1, nav_version=account_data.nav_version+1`,
      [username, accountName]
    );
    await client.query('COMMIT');
    res.json({ ok: true, batchId, rows: backup.length, data: await loadAccountData(username, accountName) });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
}));

// 导入预览：只校验字段和历史锚点输入，不写入任何业务表。
router.post('/nav/import/preview', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  const accountName = req.body && req.body.account;
  const records = req.body && req.body.records;
  if (!accountName || !Array.isArray(records) || records.length === 0) return res.status(400).json({ error: '缺少 account 或 records' });
  const toNum = v => v == null || v === '' ? NaN : Number(v);
  const normalized = records.map(r => ({ date: String(r.date || '').slice(0, 10), nav: toNum(r.nav), totalAsset: toNum(r.totalAsset), invested: toNum(r.invested), cash: toNum(r.cash) }));
  const bad = normalized.find(r => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(r.nav) || !Number.isFinite(r.totalAsset) || !Number.isFinite(r.invested) || !Number.isFinite(r.cash) || r.cash < 0 || r.cash > r.totalAsset);
  if (bad) return res.status(400).json({ error: '必须包含合法的日期、净值、总资产、累计投入资金和现金；现金不能大于总资产' });
  const maxDate = normalized.reduce((m, r) => !m || r.date > m ? r.date : m, '');
  const { rows: positions } = await pool.query('SELECT code, price::float8 AS price, quantity::float8 AS quantity, subtype FROM positions WHERE username=$1 AND account_name=$2', [req.session.user, accountName]);
  const { rows: previewTrades } = await pool.query(`SELECT code, name, direction, quantity::float8 AS quantity, trade_date, date, executed_at, created_at, subtype, type, quote_currency, amount_cny::float8 AS amount_cny FROM trades WHERE username=$1 AND account_name=$2`, [req.session.user, accountName]);
  const unresolvedTradeIds = previewTrades.filter((t) => String(t.quote_currency || '').toUpperCase() === 'HKD' && t.amount_cny == null).map((t) => t.code).slice(0, 20);
  const anchorPositions = buildAnchorPositions(positions, previewTrades, maxDate);
  const { rows: fx } = await pool.query(`SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate FROM market.fx_rates WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1 ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`, [maxDate]);
  const fxAtDate = (date) => {
    let rate = 0;
    for (const row of fx) {
      const rowDate = row.rate_date instanceof Date ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(row.rate_date) : String(row.rate_date).slice(0, 10);
      if (rowDate <= date && Number(row.rate) > 0) rate = Number(row.rate);
    }
    return rate;
  };
  const systemRate = fxAtDate(maxDate);
  const anchorPriceData = await loadAnchorPrices(req.session.user, accountName, maxDate, anchorPositions);
  const priceMap = anchorPriceData.prices;
  const anchorPriceDate = anchorPriceData.priceDate;
  const missingCodes = anchorPositions.filter(p => Number(p.quantity) !== 0 && maxDate !== todayCN() && (!anchorPriceDate || !(priceMap.get(String(p.code)) > 0))).map(p => String(p.code));
  const missingFx = anchorPositions.some(p => Number(p.quantity) !== 0 && p.subtype === '港股') && !(systemRate > 0);
  const systemMarketValue = missingCodes.length || missingFx ? null : anchorPositions.reduce((s, p) => {
    const quantity = Number(p.quantity) || 0;
    if (quantity === 0) return s;
    const price = maxDate === todayCN() ? Number(p.price) || 0 : priceMap.get(String(p.code));
    return s + price * quantity * (p.subtype === '港股' ? systemRate : 1);
  }, 0);
  const inputHash = crypto.createHash('sha256').update(JSON.stringify({ mode: req.body.mode || 'merge', records: normalized.map(r => ({ ...r, hkRate: null })) })).digest('hex');
  res.json({ ok: true, rowCount: normalized.length, rangeStart: normalized.reduce((m, r) => !m || r.date < m ? r.date : m, ''), rangeEnd: maxDate, inputHash, systemMarketValueAtSnapshot: systemMarketValue, calcStatus: systemMarketValue == null || unresolvedTradeIds.length ? 'data_incomplete' : 'ready', missingCodes: [...new Set(missingCodes)], missingFx, unresolvedTradeIds, positionPriceDate: anchorPriceDate, positionPriceFallback: anchorPriceDate && anchorPriceDate !== maxDate ? 'previous_complete_close' : null });
}));

// 管理员判定已统一收敛到 server/middleware/auth.js（AUTH-03），accounts 路由不再保留第二套逻辑。

module.exports = router;
