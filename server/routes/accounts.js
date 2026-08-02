// ========== 账户与数据 API 路由 ==========
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const asyncHandler = require('../middleware/async');
const { requireLogin, assertOwnership } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { validateAccountData, isValidAccountName } = require('../middleware/validate');
const { loadUser, updateUserAccounts, loadAccountData, saveAccountData, migrateToStructured, saveDailyPrices, syncUserAccounts, loadBrokers, isValidBroker, getAccountBrokers, updateAccountBroker, pool } = require('../db');
const { fetchQuoteByCode, todayCN, toTsCode } = require('../services/market');
const { recomputeNav } = require('../jobs/replayNav');
const { getValuationByCodes } = require('../services/convertibleBondValuationService');

router.get('/accounts', requireLogin, asyncHandler(async (req, res) => {
  // P2-3：账户列表优先读结构化 accounts 表；该用户尚无结构化记录时回退 users.accounts（单用户读取，不暴露全量密码哈希）
  const { rows } = await pool.query('SELECT account_name FROM accounts WHERE username=$1 ORDER BY created_at', [req.session.user]);
  if (rows.length > 0) return res.json(rows.map(r => r.account_name));
  const u = await loadUser(req.session.user);
  res.json((u && u.accounts) || ['默认账户']);
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
  try {
    const newVersion = await saveAccountData(req.session.user, decodeURIComponent(req.params.name), req.body, expectedVersion);
    res.json({ ok: true, version: newVersion });
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
// 属全局数据运维任务，收敛为仅管理员可调，并记录操作人。
router.post('/migrate-json', requireLogin, requireAdmin, asyncHandler(async (req, res) => {
  console.log('[migrate-json] 操作人:', req.session.user, '时间:', new Date().toISOString());
  await migrateToStructured();
  res.json({ ok: true });
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

// ========== 历史净值备份（导入前自动拍快照，误导入可一键还原） ==========

// 备份当前 navHistory 到 nav_history_backup（导入前调用）
router.post('/accounts/:name/backup-nav-history', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '备份过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const result = await pool.query(
      `UPDATE account_data
         SET nav_history_backup = (data::jsonb->'navHistory')::jsonb,
             nav_history_backup_at = now()
       WHERE username=$1 AND account_name=$2
       RETURNING jsonb_array_length(COALESCE(nav_history_backup, '[]'::jsonb)) AS rows`,
      [req.session.user, name]
    );
    if (!result.rowCount) return res.status(404).json({ error: '账户数据不存在' });
    res.json({ ok: true, rows: result.rows[0].rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// 清理历史数据（按模式）：invested-only 清空投入本金字段让公式回算；before-date 删除某日期前
router.post('/accounts/:name/clear-nav-history', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '清理过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { mode, beforeDate } = req.body || {};
    if (mode === 'invested-only') {
      // 清空 navHistory 中每条记录的 invested 字段（置 null，前端 investedAt 用 cashFlows 回算）
      const r = await pool.query(
        `UPDATE account_data
            SET data = jsonb_set(
              data::jsonb,
              '{navHistory}',
              COALESCE(
                (SELECT jsonb_agg(jsonb_set(elem, '{invested}', 'null'::jsonb))
                   FROM jsonb_array_elements(data::jsonb->'navHistory') elem),
                '[]'::jsonb
              ),
              false
            )::text
          WHERE username=$1 AND account_name=$2
          RETURNING jsonb_array_length(data::jsonb->'navHistory') AS rows`,
        [req.session.user, name]
      );
      if (!r.rowCount) return res.status(404).json({ error: '账户数据不存在' });
      res.json({ ok: true, rows: r.rows[0].rows });
    } else if (mode === 'before-date' && beforeDate) {
      // 删除该日期之前（含）的所有 navHistory 记录
      const r = await pool.query(
        `UPDATE account_data
            SET data = jsonb_set(
              data::jsonb,
              '{navHistory}',
              COALESCE(
                (SELECT jsonb_agg(elem)
                   FROM jsonb_array_elements(data::jsonb->'navHistory') elem
                  WHERE elem->>'date' > $1),
                '[]'::jsonb
              ),
              false
            )::text
          WHERE username=$1 AND account_name=$2
          RETURNING jsonb_array_length(data::jsonb->'navHistory') AS rows`,
        [beforeDate, req.session.user, name]
      );
      if (!r.rowCount) return res.status(404).json({ error: '账户数据不存在' });
      res.json({ ok: true, rows: r.rows[0].rows });
    } else {
      res.status(400).json({ error: '不支持的模式（invested-only / before-date）' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// 一键还原：将 nav_history_backup 恢复到 navHistory（误导入/污染时使用）
router.post('/accounts/:name/restore-nav-history', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 10, getKey: (r) => r.session.user || r.ip, message: '还原请求过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const r = await pool.query(
      `UPDATE account_data
          SET data = jsonb_set(
            data::jsonb,
            '{navHistory}',
            COALESCE(nav_history_backup, '[]'::jsonb),
            false
          )::text
        WHERE username=$1 AND account_name=$2
        RETURNING nav_history_backup_at AS backup_at,
                  jsonb_array_length(COALESCE(nav_history_backup, '[]'::jsonb)) AS rows`,
      [req.session.user, name]
    );
    if (!r.rowCount) return res.status(404).json({ error: '账户数据不存在' });
    res.json({ ok: true, rows: r.rows[0].rows, backupAt: r.rows[0].backup_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// 查看备份信息（前端按钮显示"备份时间"）
router.get('/accounts/:name/nav-history-backup-info', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const r = await pool.query(
      `SELECT nav_history_backup_at AS at,
              jsonb_array_length(COALESCE(nav_history_backup, '[]'::jsonb)) AS rows
         FROM account_data WHERE username=$1 AND account_name=$2`,
      [req.session.user, name]
    );
    if (!r.rowCount) return res.json({ hasBackup: false });
    res.json({ hasBackup: !!r.rows[0].at, at: r.rows[0].at, rows: r.rows[0].rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// 暴露 isAdmin 供测试与安全审计使用（不改变 router 导出，app.js 仍以 router 挂载）
router.isAdmin = isAdmin;

module.exports = router;
