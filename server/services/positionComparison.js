// ===================== 仓位对比服务（统一估值 + 字段脱敏 + 分组差异） =====================
// 对应 docs/仓位对比功能_开发文档.md 6 节：
//   - 6.1 双方使用同一批最新有效行情估值（复用腾讯批量行情）
//   - 6.2 证券合并（instrument_id 优先，回退 市场+标准化代码）
//   - 6.3 对比概览（相似度）
//   - 6.4/6.5/6.6 证券 / 资产类型(type) / 持仓细类(subtype) 对比
//   - 4.2 半公开服务端脱敏（数量/市值/盈亏/总资产删除）
const { pool } = require('../db/connection');
const { fetchTencentQuotes } = require('./tencentQuote');
const { todayCN } = require('./market');

// ========== 工具 ==========

// 标准化证券代码：A股 6 位加后缀（0/3→.SZ，6/9→.SH，4/8→.BJ），港股 1-5 位→补 5 位加 .HK
function normalizeSecCode(rawCode) {
  const c = String(rawCode || '').trim().toUpperCase();
  if (!c) return '';
  if (c.includes('.')) return c;
  const plain = c.replace(/\D/g, '');
  if (/^\d{1,5}$/.test(plain)) return plain.padStart(5, '0') + '.HK';
  if (/^\d{6}$/.test(plain)) {
    if (plain.startsWith('4') || plain.startsWith('8') || plain.startsWith('92')) return plain + '.BJ';
    if (plain.startsWith('6') || plain.startsWith('9') || plain.startsWith('11') || plain.startsWith('5')) return plain + '.SH';
    return plain + '.SZ';
  }
  return c;
}

// 同一证券身份键：优先 instrument_id，回退 市场+标准化代码
function secKey(pos) {
  if (pos.instrument_id) return 'I' + pos.instrument_id;
  return normalizeSecCode(pos.code);
}

// ========== 标杆列表（4.1 / 5.2） ==========

// 返回其他用户的 public / semi_public 账户，不含 username 与绝对金额
async function listBenchmarks(currentUsername) {
  const { rows } = await pool.query(
    `SELECT a.id AS account_id, a.account_name, a.username, a.position_visibility,
            COALESCE(u.nickname, a.username) AS nickname,
            a.updated_at,
            ad.updated_at AS data_updated_at
       FROM accounts a
       LEFT JOIN users u ON u.username = a.username
       LEFT JOIN account_data ad ON ad.username=a.username AND ad.account_name=a.account_name
      WHERE a.position_visibility <> 'private'
        AND a.username <> $1
      ORDER BY a.updated_at DESC NULLS LAST`,
    [currentUsername]
  );
  const result = [];
  for (const row of rows) {
    // 证券只数（半公开也可展示只数，但不能展示持仓数量）
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(DISTINCT COALESCE(instrument_id::text, code))::int AS cnt
         FROM positions WHERE username=$1 AND account_name=$2 AND quantity > 0`,
      [row.username, row.account_name]
    );
    result.push({
      accountId: row.account_id,
      displayName: `${row.nickname || row.username} · ${row.account_name}`,
      visibility: row.position_visibility,
      // 持仓更新时间：真实持仓保存时间优先（account_data.updated_at），不用公开状态修改时间
      positionUpdatedAt: row.data_updated_at || row.updated_at || null,
      securityCount: cnt[0] ? cnt[0].cnt : 0,
    });
  }
  return result;
}

// ========== 持仓读取与统一估值（6.1 / 6.2） ==========

// 读取账户全部有效持仓（数量>0），合并同一证券多条记录
async function loadEffectivePositions(username, accountName) {
  const { rows } = await pool.query(
    `SELECT id, code, name, price::float8 AS price, quantity::float8 AS quantity,
            cost::float8 AS cost, type, subtype, note, instrument_id
       FROM positions WHERE username=$1 AND account_name=$2 AND quantity > 0`,
    [username, accountName]
  );
  return rows;
}

// 读取账户现金（口径与持仓页一致：cash = cashBase + 现金流净额 + 交易净额）
// 简单复用 loadAccountData 太重（会拉全部 trades/nav），这里直接算现金
async function loadAccountCash(username, accountName) {
  const { rows: am } = await pool.query(
    `SELECT cash_base::float8 AS cash_base, hk_rate::float8 AS hk_rate, hk_rate_updated_at FROM accounts WHERE username=$1 AND account_name=$2`,
    [username, accountName]
  );
  const cashBase = am[0] ? am[0].cash_base : 0;
  const hkRate = (am[0] && am[0].hk_rate > 0) ? am[0].hk_rate : 0.868;
  // 真实汇率更新时间（迁移 039 专用列），不随持仓保存/公开状态修改而更新
  const hkRateUpdatedAt = am[0] && am[0].hk_rate_updated_at ? am[0].hk_rate_updated_at : null;
  const { rows: cf } = await pool.query(
    `SELECT COALESCE(SUM(amount::float8),0) AS net FROM cash_flows WHERE username=$1 AND account_name=$2`,
    [username, accountName]
  );
  const { rows: tr } = await pool.query(
    `SELECT COALESCE(SUM(
        CASE WHEN direction='buy' THEN -(amount::float8) - (COALESCE(commission::float8,0)+COALESCE(stamp_tax::float8,0)+COALESCE(transfer_fee::float8,0)+COALESCE(other_fee::float8,0))
             ELSE (amount::float8) - (COALESCE(commission::float8,0)+COALESCE(stamp_tax::float8,0)+COALESCE(transfer_fee::float8,0)+COALESCE(other_fee::float8,0))
        END),0) AS net FROM trades WHERE username=$1 AND account_name=$2`,
    [username, accountName]
  );
  return { cash: (cashBase || 0) + (cf[0] ? cf[0].net : 0) + (tr[0] ? tr[0].net : 0), hkRate, hkRateUpdatedAt };
}

// 统一估值：输出每证券 {code,name,type,subtype,quantity,price,change,quoteTime,marketValue,ratio,...}
// 支持外部传入统一行情与汇率（文档 6.1：双方必须使用同一批最新有效行情 + 同一汇率）：
//   - quotes: Map<code, quote>（由调用方一次批量拉取，双方共用）
//   - hkRate: number（统一汇率，双方共用）
// 未传时各自独立拉取/用账户汇率（兼容单边场景）。
async function estimatePositions(positions, cashInfo, quotes, hkRate) {
  const codes = [...new Set(positions.map(p => String(p.code || '').trim()).filter(Boolean))];
  const quoteMap = quotes || (codes.length ? await fetchTencentQuotes(codes) : new Map());
  const rate = (hkRate != null && hkRate > 0) ? hkRate : (cashInfo.hkRate || 0.868);
  const enriched = positions.map(p => {
    const c = String(p.code || '').trim();
    const q = quoteMap.get(c) || null;
    const price = q && q.price != null && q.price > 0 ? q.price : (p.price > 0 ? p.price : null);
    const isHk = normalizeSecCode(c).endsWith('.HK');
    const marketValue = (price != null && p.quantity > 0) ? price * p.quantity * (isHk ? rate : 1) : null;
    return {
      code: c,
      name: (q && q.name) || p.name || c,
      type: p.type || '',
      subtype: p.subtype || '',
      quantity: p.quantity,
      price,
      change: q && q.change != null ? q.change : null,
      quoteTime: q ? q.quote_time : null,
      quoteSource: q ? q.source : null,
      marketValue,
      instrument_id: p.instrument_id || null,
    };
  });
  // 合并同一证券（6.2：instrument_id 优先，回退 市场+代码）
  const merged = new Map();
  for (const pos of enriched) {
    if (pos.marketValue == null) continue; // 无有效行情不参与正式对比（异常提示另行处理）
    const key = secKey(pos);
    const prev = merged.get(key);
    if (!prev) { merged.set(key, { ...pos }); continue; }
    prev.quantity += pos.quantity;
    prev.marketValue += pos.marketValue;
    if (pos.price != null) prev.price = pos.price;
    if (pos.change != null) prev.change = pos.change;
    if (pos.quoteTime != null) prev.quoteTime = pos.quoteTime;
    if (pos.name && !prev.name.startsWith('未')) prev.name = pos.name;
  }
  const list = [...merged.values()];
  const totalAsset = list.reduce((s, p) => s + (p.marketValue || 0), 0) + (cashInfo.cash || 0);
  list.forEach(p => { p.ratio = totalAsset > 0 ? p.marketValue / totalAsset : 0; });
  const cashRatio = totalAsset > 0 ? (cashInfo.cash || 0) / totalAsset : (totalAsset === 0 && cashInfo.cash === 0 ? 1 : 0);
  return { positions: list, cash: cashInfo.cash || 0, cashRatio, totalAsset, hkRate: rate };
}

// 无有效行情、未参与正式对比的证券（异常提示）
function missingQuotePositions(positions, estimateResult) {
  const keys = new Set(estimateResult.positions.map(p => secKey(p)));
  return positions.filter(p => !keys.has(secKey(p))).map(p => ({
    code: p.code, name: p.name || p.code, type: p.type, subtype: p.subtype,
  }));
}

// ========== 分组聚合（6.5 资产类型 / 6.6 持仓细类） ==========

function groupByField(estimate, field, cashFieldLabel) {
  const map = new Map();
  for (const p of estimate.positions) {
    const key = (field === 'type' && !p.type) ? '未分类' : (p[field] || '未分类');
    map.set(key, (map.get(key) || 0) + p.marketValue);
  }
  const cash = estimate.cash || 0;
  if (cash > 0 || estimate.cashRatio > 0) {
    const cashKey = cashFieldLabel || '现金';
    map.set(cashKey, (map.get(cashKey) || 0) + cash);
  }
  const total = estimate.totalAsset || 1;
  return [...map.entries()].map(([name, value]) => ({
    name, value, ratio: total > 0 ? value / total : 0,
  })).sort((a, b) => b.ratio - a.ratio);
}

// ========== 相似度（6.3） ==========

// 仓位相似度 = max(0, 1 - 0.5 × Σ|我的占比 - 标杆占比|) × 100%，现金作为单独项目参与
function similarity(my, benchmark) {
  const keys = new Set([...my.positions.map(secKey), ...benchmark.positions.map(secKey)]);
  let diff = 0;
  for (const key of keys) {
    const a = my.positions.find(p => secKey(p) === key);
    const b = benchmark.positions.find(p => secKey(p) === key);
    diff += Math.abs((a ? a.ratio : 0) - (b ? b.ratio : 0));
  }
  diff += Math.abs(my.cashRatio - benchmark.cashRatio);
  return Math.max(0, 1 - 0.5 * diff) * 100;
}

// ========== 证券对比明细（6.4） ==========

function compareSecurities(my, benchmark) {
  const keys = new Set([...my.positions.map(secKey), ...benchmark.positions.map(secKey)]);
  const rows = [...keys].map(key => {
    const a = my.positions.find(p => secKey(p) === key);
    const b = benchmark.positions.find(p => secKey(p) === key);
    const myRatio = a ? a.ratio : 0;
    const benchmarkRatio = b ? b.ratio : 0;
    const status = a && b ? 'both' : (a ? 'mine_only' : 'benchmark_only');
    const src = a || b;
    return {
      code: src.code,
      name: src.name,
      type: src.type || '',
      subtype: src.subtype || '',
      status,
      price: src.price != null ? src.price : null,
      change: src.change != null ? src.change : null,
      quoteTime: src.quoteTime != null ? src.quoteTime : null,
      myRatio,
      benchmarkRatio,
      diff: myRatio - benchmarkRatio,
      myQuantity: a ? a.quantity : 0,
      myMarketValue: a ? a.marketValue : 0,
      benchmarkQuantity: b ? b.quantity : 0,
      benchmarkMarketValue: b ? b.marketValue : 0,
    };
  });
  // 默认按占比差异绝对值从大到小
  rows.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  return rows;
}

// ========== 半公开脱敏（4.2：服务端删除【标杆】的数量/市值/盈亏/总资产，我的账户信息保留） ==========
// 半公开只隐藏标杆账户的数量、市值和总资产；用户自己的数量、市值、总资产是本人数据，必须保留。

function sanitizeSemiPublic(comparison) {
  const result = JSON.parse(JSON.stringify(comparison));
  // 只删除标杆侧的绝对金额（含可用于反推规模的总资产/现金）
  delete result.benchmarkAccount.totalAsset;
  delete result.benchmarkAccount.cash;
  // 逐证券：只删标杆的数量/市值，我的保留
  for (const row of result.securities || []) {
    delete row.benchmarkQuantity;
    delete row.benchmarkMarketValue;
  }
  return result;
}

module.exports = {
  normalizeSecCode, secKey,
  listBenchmarks,
  loadEffectivePositions, loadAccountCash, estimatePositions, missingQuotePositions,
  groupByField, similarity, compareSecurities, sanitizeSemiPublic,
};
