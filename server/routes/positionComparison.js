// ========== 仓位对比路由（公开设置 / 标杆列表 / 对比 / 复制测算） ==========
// 对应 docs/仓位对比功能_开发文档.md 8.4 接口设计：
//   PUT   /api/accounts/:name/position-visibility   更新当前账户公开状态
//   GET   /api/position-comparisons/benchmarks      标杆账户列表
//   POST  /api/position-comparisons/compare         获取对比结果
//   POST  /api/position-comparisons/replicate       复制测算
// 2026-08-01 验收修复：
//   - 统一估值：双方代码合并一次批量拉行情 + 统一汇率（文档 6.1），不再各自请求/各自汇率
//   - 隐私竞态：返回前按 finalCheck 最新 visibility 脱敏（计算期间 public→semi_public 也要按新状态脱敏）
//   - 汇率传递：实际汇率传入复制算法，前端用响应汇率反算港币金额
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin, assertOwnership, requireCapability } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { pool, auditEvent } = require('../db');
const { isValidAccountName } = require('../middleware/validate');
const { fetchTencentQuotes } = require('../services/tencentQuote');
const { ensureHkRate, getCurrentFxRate } = require('../jobs/hkRate');
const {
  listBenchmarks, loadEffectivePositions, loadAccountCash, estimatePositions,
  missingQuotePositions, groupByField, similarity, compareSecurities, sanitizeSemiPublic,
} = require('../services/positionComparison');
const { getHkLotRulesByInstrumentIds, getATradeRule } = require('../services/tradeLot');
const { replicatePositions } = require('../services/positionReplication');

const VALID_VISIBILITY = ['public', 'semi_public', 'private'];

// ========== 更新当前账户公开状态（8.4 / 4.3；需 benchmark_publish 能力，且只能改自己的账户） ==========
router.put('/accounts/:name/position-visibility', requireLogin, requireCapability('benchmark_publish'), assertOwnership, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { visibility } = req.body || {};
  if (!VALID_VISIBILITY.includes(visibility)) {
    await auditEvent({ actor: req.session.user, action: 'benchmark_publish', target: name, result: 'failure', requestId: req.id, detail: '公开状态不合法' });
    return res.status(400).json({ error: '公开状态不合法' });
  }
  const { rows } = await pool.query(
    `UPDATE accounts SET position_visibility=$1, position_visibility_updated_at=now(), updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE username=$2 AND account_name=$3 RETURNING id`,
    [visibility, req.session.user, name]
  );
  if (rows.length === 0) {
    await auditEvent({ actor: req.session.user, action: 'benchmark_publish', target: name, result: 'failure', requestId: req.id, detail: '账户不存在' });
    return res.status(404).json({ error: '账户不存在' });
  }
  await auditEvent({ actor: req.session.user, action: 'benchmark_publish', target: name, result: 'success', requestId: req.id, detail: '设为' + visibility, metadata: { visibility: visibility } });
  res.json({ ok: true, visibility });
}));

// ========== 读取当前账户公开状态（前端控件回显） ==========
router.get('/position-comparisons/visibility', requireLogin, asyncHandler(async (req, res) => {
  const accountName = req.query.account || '';
  if (!accountName) return res.json({ visibility: 'private' });
  const { rows } = await pool.query(
    `SELECT position_visibility FROM accounts WHERE username=$1 AND account_name=$2`,
    [req.session.user, accountName]
  );
  res.json({ visibility: rows[0] ? rows[0].position_visibility : 'private' });
}));

// ========== 标杆账户列表（5.2 / 8.4） ==========
router.get('/position-comparisons/benchmarks', requireLogin, asyncHandler(async (req, res) => {
  const benchmarks = await listBenchmarks(req.session.user);
  res.json(benchmarks);
}));

// ========== 对比（6 节） ==========
const compareLimiter = rateLimit({ prefix: 'poscmp', windowMs: 10 * 1000, max: 10, message: '请求过于频繁，请稍后再试' });

// 校验标杆账户仍公开（返回 account 行或 null；含持仓/更新时间字段供页面展示）
async function requireBenchmarkOpen(accountId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.account_name, a.username, a.position_visibility,
            a.position_visibility_updated_at, a.updated_at,
            ad.updated_at AS data_updated_at
       FROM accounts a
       LEFT JOIN account_data ad ON ad.username=a.username AND ad.account_name=a.account_name
      WHERE a.id=$1`,
    [accountId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.position_visibility === 'private') return null;
  return row;
}

// 读取我的账户行（本人 + 存在；含持仓更新时间 account_data.updated_at 与账户更新时间）
async function requireMyAccount(username, accountName) {
  const { rows } = await pool.query(
    `SELECT a.account_name, a.updated_at,
            ad.updated_at AS data_updated_at
       FROM accounts a
       LEFT JOIN account_data ad ON ad.username=a.username AND ad.account_name=a.account_name
      WHERE a.username=$1 AND a.account_name=$2`,
    [username, accountName]
  );
  return rows[0] || null;
}

// 持仓更新时间：真实持仓保存时间优先（account_data.updated_at，随持仓保存更新），
// 其次账户更新时间；不用 position_visibility_updated_at（那是公开状态修改时间，会误导）
function holdingsUpdatedAt(row) {
  return row.data_updated_at || row.updated_at || null;
}

// 构造单边对比侧数据：持仓统一估值 + 现金
// 统一口径（文档 6.1）：quotes 与 hkRate 由调用方一次拉取/确定，双方共用同一批行情、同一汇率
async function buildSide(username, accountName, visibility, quotes, hkRate) {
  const [positions, cashInfo] = await Promise.all([
    loadEffectivePositions(username, accountName),
    loadAccountCash(username, accountName),
  ]);
  const estimate = await estimatePositions(positions, cashInfo, quotes, hkRate);
  return {
    accountName,
    visibility,
    positions: estimate.positions,
    cash: estimate.cash,
    cashRatio: estimate.cashRatio,
    totalAsset: estimate.totalAsset,
    hkRate: estimate.hkRate,
    missingQuotes: missingQuotePositions(positions, estimate),
  };
}

// 统一估值准备：合并双方全部代码一次批量拉行情 + 统一汇率（优先实时汇率，回退标杆/我的账户汇率）
// 返回 { quotes, hkRate, hkRateTime }：hkRateTime 为汇率来源时间（实时抓取时刻或账户更新时间）
async function prepareUnifiedEstimation(myUsername, myAccountName, benchRow) {
  const [myPositions, benchPositions, myCash, benchCash, liveRate] = await Promise.all([
    loadEffectivePositions(myUsername, myAccountName),
    loadEffectivePositions(benchRow.username, benchRow.account_name),
    loadAccountCash(myUsername, myAccountName),
    loadAccountCash(benchRow.username, benchRow.account_name),
    ensureHkRate()
      .then(r => r.ok ? r.rate : getCurrentFxRate())
      .catch(() => getCurrentFxRate()),
  ]);
  const codes = [...new Set([...myPositions, ...benchPositions].map(p => String(p.code || '').trim()).filter(Boolean))];
  const quotes = codes.length ? await fetchTencentQuotes(codes) : new Map();
  let hkRate, hkRateTime;
  if (liveRate != null && liveRate > 0) {
    hkRate = liveRate;
    hkRateTime = new Date().toISOString(); // 实时抓取成功：标记本次抓取时刻
  } else {
    hkRate = (benchCash.hkRate > 0 ? benchCash.hkRate : (myCash.hkRate > 0 ? myCash.hkRate : 0.868));
    hkRateTime = benchCash.hkRateUpdatedAt || myCash.hkRateUpdatedAt || null; // 回退账户汇率：用账户更新时间
  }
  return { quotes, hkRate, hkRateTime };
}

// 类型/细类差异合并展示
function mergeGroups(my, bench) {
  const keys = new Set([...my.map(g => g.name), ...bench.map(g => g.name)]);
  return [...keys].map(name => ({
    name,
    myRatio: (my.find(g => g.name === name) || {}).ratio || 0,
    benchmarkRatio: (bench.find(g => g.name === name) || {}).ratio || 0,
    diff: ((my.find(g => g.name === name) || {}).ratio || 0) - ((bench.find(g => g.name === name) || {}).ratio || 0),
  })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

router.post('/position-comparisons/compare', requireLogin, compareLimiter, asyncHandler(async (req, res) => {
  const { myAccountName, benchmarkAccountId } = req.body || {};
  if (!myAccountName || !benchmarkAccountId) return res.status(400).json({ error: '缺少参数' });
  if (!isValidAccountName(myAccountName)) return res.status(400).json({ error: '账户名不合法' });
  // 我的账户归属（本人 + 存在）
  const myRow = await requireMyAccount(req.session.user, myAccountName);
  if (!myRow) return res.status(404).json({ error: '我的账户不存在' });
  // 标杆账户必须仍为公开/半公开（每次实时校验，不依赖前端）
  const benchRow = await requireBenchmarkOpen(benchmarkAccountId);
  if (!benchRow) return res.status(404).json({ error: '该仓位已取消公开' });

  // 统一估值：同一批行情 + 同一汇率（文档 6.1）
  const uni = await prepareUnifiedEstimation(req.session.user, myAccountName, benchRow);
  const [mySide, benchSide] = await Promise.all([
    buildSide(req.session.user, myAccountName, 'private', uni.quotes, uni.hkRate),
    buildSide(benchRow.username, benchRow.account_name, benchRow.position_visibility, uni.quotes, uni.hkRate),
  ]);

  if (!mySide.positions.length && !mySide.cash && !benchSide.positions.length && !benchSide.cash) {
    return res.json({ empty: true, message: '双方都没有可对比的资产' });
  }

  const securities = compareSecurities(mySide, benchSide);
  const typeGroups = {
    my: groupByField(mySide, 'type', '现金'),
    benchmark: groupByField(benchSide, 'type', '现金'),
  };
  const subtypeGroups = {
    my: groupByField(mySide, 'subtype', '现金'),
    benchmark: groupByField(benchSide, 'subtype', '现金'),
  };
  const mergedType = mergeGroups(typeGroups.my, typeGroups.benchmark);
  const mergedSubtype = mergeGroups(subtypeGroups.my, subtypeGroups.benchmark);

  // 本次估值时间（同一批行情的最早/最新时间戳，取最新的一个）
  const quoteTimes = [...mySide.positions, ...benchSide.positions].map(p => p.quoteTime).filter(Boolean);
  const valuationTime = quoteTimes.length ? quoteTimes.sort().pop() : null;

  const overview = {
    similarity: similarity(mySide, benchSide),
    commonCount: securities.filter(s => s.status === 'both').length,
    mineMissingCount: securities.filter(s => s.status === 'benchmark_only').length,
    mineOnlyCount: securities.filter(s => s.status === 'mine_only').length,
    maxTypeDiff: Math.max(...mergedType.map(g => Math.abs(g.diff)), 0),
    maxSubtypeDiff: Math.max(...mergedSubtype.map(g => Math.abs(g.diff)), 0),
    myUpdatedAt: holdingsUpdatedAt(myRow),
    benchmarkUpdatedAt: holdingsUpdatedAt(benchRow),
    valuationTime,
    hkRate: uni.hkRate,
    hkRateTime: uni.hkRateTime || null,
  };

  const comparison = {
    myAccount: { accountName: mySide.accountName, visibility: 'private', totalAsset: mySide.totalAsset, cash: mySide.cash, missingQuotes: mySide.missingQuotes },
    benchmarkAccount: { accountId: benchRow.id, accountName: benchSide.accountName, visibility: benchSide.visibility, totalAsset: benchSide.totalAsset, cash: benchSide.cash, missingQuotes: benchSide.missingQuotes },
    overview,
    securities,
    typeGroups: mergedType,
    subtypeGroups: mergedSubtype,
  };

  // 返回前再次校验标杆公开状态（文档 11：计算中变更为不公开则丢弃结果）
  const finalCheck = await requireBenchmarkOpen(benchmarkAccountId);
  if (!finalCheck) return res.status(404).json({ error: '该仓位已取消公开' });
  // 隐私竞态修复：①按【最新】visibility 脱敏（public→semi_public 也按新状态隐藏标杆数量/市值）
  //              ②响应中的公开状态也必须同步为最新值（否则数据已脱敏但标签仍显示"公开仓位"）
  const effectiveVisibility = finalCheck.position_visibility;
  comparison.benchmarkAccount.visibility = effectiveVisibility;
  comparison.overview.benchmarkUpdatedAt = holdingsUpdatedAt(finalCheck);
  const result = effectiveVisibility === 'semi_public' ? sanitizeSemiPublic(comparison) : comparison;
  res.json(result);
}));

// ========== 复制测算（7 节） ==========
router.post('/position-comparisons/replicate', requireLogin, compareLimiter, asyncHandler(async (req, res) => {
  const { myAccountName, benchmarkAccountId, availableCash } = req.body || {};
  if (!myAccountName || !benchmarkAccountId) return res.status(400).json({ error: '缺少参数' });
  if (!isValidAccountName(myAccountName)) return res.status(400).json({ error: '账户名不合法' });
  const cash = Number(availableCash);
  if (!Number.isFinite(cash) || cash <= 0) return res.status(400).json({ error: '可用资金必须是大于 0 的数字' });
  if (cash > 1000000000) return res.status(400).json({ error: '可用资金超出合理上限' });

  const myRow = await requireMyAccount(req.session.user, myAccountName);
  if (!myRow) return res.status(404).json({ error: '我的账户不存在' });
  const benchRow = await requireBenchmarkOpen(benchmarkAccountId);
  if (!benchRow) return res.status(404).json({ error: '该仓位已取消公开' });

  // 统一估值（同一批行情 + 同一汇率）
  const uni = await prepareUnifiedEstimation(req.session.user, myAccountName, benchRow);
  const [mySide, benchSide] = await Promise.all([
    buildSide(req.session.user, myAccountName, 'private', uni.quotes, uni.hkRate),
    buildSide(benchRow.username, benchRow.account_name, benchRow.position_visibility, uni.quotes, uni.hkRate),
  ]);

  // 交易单位：A 股按市场规则，港股查 market.instrument_trade_rules
  const lotRules = new Map();
  const hkInstrumentIds = new Map();
  for (const p of benchSide.positions) {
    const plain = String(p.code).replace(/\D/g, '');
    if (plain.length === 6) lotRules.set(p.code, getATradeRule(p.code));
    else if (plain.length === 5) hkInstrumentIds.set(p.code, p.instrument_id);
  }
  const hkLots = await getHkLotRulesByInstrumentIds(hkInstrumentIds);
  for (const [code, rule] of hkLots) lotRules.set(code, { market: 'HK', buy_lot_size_shares: rule.buy_lot_size_shares });

  // 价格表（统一估值中的最新价：A 股人民币、港股港币原价）
  const prices = new Map();
  for (const p of benchSide.positions) prices.set(p.code, p.price);

  const result = replicatePositions(mySide, benchSide, cash, lotRules, prices, uni.hkRate);

  // 每手股数数据来源与缓存状态（9.2）
  const tradeRuleSources = [];
  for (const [code, rule] of lotRules) {
    if (rule.market === 'HK') {
      const hkRule = hkLots.get(code);
      tradeRuleSources.push({
        code,
        source: 'tushare:hk_basic',
        lotSize: rule.buy_lot_size_shares,
        sourceUpdatedAt: hkRule ? hkRule.source_updated_at : null,
        validFrom: hkRule ? hkRule.valid_from : null,
        cached: hkRule ? !!hkRule.cached : false,
      });
    } else {
      tradeRuleSources.push({ code, source: 'market_rule', lotSize: rule.minLot, cached: true });
    }
  }

  const response = {
    benchmarkVisibility: benchSide.visibility,
    availableCash: cash,
    hkRate: uni.hkRate,
    hkRateTime: uni.hkRateTime || null,
    valuationTime: [...mySide.positions, ...benchSide.positions].map(p => p.quoteTime).filter(Boolean).sort().pop() || null,
    tradeRuleSources,
    items: result.items,
    summary: result.summary,
  };
  // 返回前再次校验标杆公开状态（文档 11：计算中变更为不公开则丢弃结果）
  const finalCheck = await requireBenchmarkOpen(benchmarkAccountId);
  if (!finalCheck) return res.status(404).json({ error: '该仓位已取消公开' });
  // 隐私竞态：公开状态同步为最新值（计算期间 public→semi_public 时响应不显示"公开仓位"）
  response.benchmarkVisibility = finalCheck.position_visibility;
  res.json(response);
}));

module.exports = router;
