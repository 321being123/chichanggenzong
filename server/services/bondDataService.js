// ====== 可转债统一数据服务 ======
// 统一读取层：所有可转债展示与打新读取都经过 bond_unified 视图。
//
// 当前真实调用方：
//   - getBondBySecurityCode / getBondHistoryList：ipo.js 打新日历路由（读）。
//   - 可转债主同步：convertibleBondAnalysis.js 直接写入标准主档、发行事实和事件（写）。
// 主档、发行事实、生命周期事件和上市表现由迁移 058 的标准表分别写入；
// 本服务不再回读或写入历史兼容表。
const { pool } = require('../db');

// 六位正股代码 → 标准代码（补后缀）。规则必须与迁移 035 的 normalize_stock_code() SQL 函数保持一致：
// 0/3 开头 → 深市 .SZ，其余 → 沪市 .SH；已带后缀则原样返回。
function normalizeStockCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return null;
  if (raw.includes('.')) return raw;
  return /^(0|3)/.test(raw) ? raw + '.SZ' : raw + '.SH';
}

// 全量可转债列表（基础信息）
async function getBondList(filters = {}) {
  const where = [];
  const params = [];
  let pi = 1;

  if (filters.status) {
    where.push(`status = $${pi}`); params.push(filters.status); pi++;
  } else {
    where.push("status = 'listed'");
  }
  if (filters.search) {
    where.push(`(bond_code ILIKE $${pi} OR bond_name ILIKE $${pi} OR stock_name ILIKE $${pi})`);
    params.push('%' + filters.search + '%'); pi++;
  }
  if (filters.excludeIssueType) {
    where.push(`(issue_type IS NULL OR issue_type NOT IN ($${pi}))`);
    params.push(filters.excludeIssueType); pi++;
  }

  const sql = `SELECT * FROM public.bond_unified WHERE ${where.join(' AND ')}
    ORDER BY display_rating NULLS LAST, listing_date DESC NULLS LAST`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

// 单债详情
async function getBondDetail(code) {
  const cleanCode = String(code || '').trim().toUpperCase().split('.')[0];
  const { rows } = await pool.query(
    "SELECT * FROM public.bond_unified WHERE split_part(bond_code, '.', 1) = $1",
    [cleanCode]
  );
  return rows[0] || null;
}

// 根据纯数字代码查（兼容 IPO 模块调用方式）
async function getBondBySecurityCode(securityCode) {
  const clean = securityCode.includes('.') ? securityCode.split('.')[0] : securityCode;
  const { rows } = await pool.query(
    "SELECT * FROM public.bond_unified WHERE bond_code LIKE $1",
    [clean + '.%']
  );
  return rows[0] || null;
}

// 打新历史列表（读取统一视图）
// 对外契约：security_code 保持六位纯数字（兼容前端交易所判断/报告链接）；标准代码走 canonical_code。
async function getBondHistoryList(limit = 50) {
  const { rows } = await pool.query(
    `SELECT split_part(b.bond_code, '.', 1) AS security_code,
       b.bond_code AS canonical_code, b.bond_name AS security_name,
       b.ann_date, b.res_ann_date, b.display_issue_size AS issue_size, b.issue_type,
       b.display_rating AS rating, b.shd_ration_ratio, b.bh_issue_price AS issue_price,
       b.shd_ration_record_date, b.onl_date, b.onl_size, b.onl_pch_num, b.offl_size,
       b.shd_ration_size, b.display_conv_price AS conv_price,
       b.stock_code AS stk_code, b.stock_name AS stk_name,
       b.listing_date, b.first_day_return,
       p.pred_return AS pred_return
     FROM public.bond_unified b
     LEFT JOIN LATERAL (
       SELECT pred_return FROM predictions
       WHERE type = 'bond' AND instrument_id = b.instrument_id AND pred_return IS NOT NULL
       ORDER BY pred_date DESC LIMIT 1
     ) p ON true
     WHERE b.issue_type IS NULL OR b.issue_type NOT IN ('定向', '私募')
     ORDER BY COALESCE(b.res_ann_date, b.ann_date, b.listing_date::text) DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// 活跃可转债 codes 列表（过滤已退市/到期/停止转股）
async function getActiveBondCodes() {
  const { rows } = await pool.query(
    `SELECT bond_code FROM public.bond_unified WHERE status = 'listed'`
  );
  return rows.map(r => r.bond_code);
}

// 统计评级分布
async function getRatingDistribution() {
  const { rows } = await pool.query(
    `SELECT display_rating AS rating, COUNT(*) AS cnt
     FROM public.bond_unified WHERE status = 'listed'
     GROUP BY display_rating ORDER BY cnt DESC`
  );
  return rows;
}

// ====== 统一写入标准：所有模块都走这个入口写入可转债基础信息 ======
// 原则：只读 bond_unified；缺失数据由标准同步任务补齐。
// 不假设谁先写谁后写，任何模块都可以是"第一个"。
//
// 字段完整性判断：有 bond_code + bond_name + conv_price + stock_code 就算基础完整。
async function checkBondCompleteness(code) {
  const row = await getBondDetail(code);
  if (!row) return { exists: false, complete: false, missingFields: ['all'] };
  const missing = [];
  if (!row.bond_code) missing.push('bond_code');
  if (!row.bond_name) missing.push('bond_name');
  if (!row.conv_price && !row.display_conv_price) missing.push('conv_price');
  if (!row.stock_code) missing.push('stock_code');
  if (!row.listing_date) missing.push('listing_date');
  if (!row.display_rating && !row.rating) missing.push('rating');
  if (!row.issue_size && !row.display_issue_size) missing.push('issue_size');
  if (!row.onl_date) missing.push('onl_date');
  if (!row.ann_date) missing.push('ann_date');
  // maturity_date 如果为空说明 cb_basic 也没数据，不影响基础可用性
  return { exists: true, complete: missing.length === 0, missingFields: missing, data: row };
}

module.exports = {
  getBondList,
  getBondDetail,
  getBondBySecurityCode,
  getBondHistoryList,
  getActiveBondCodes,
  getRatingDistribution,
  checkBondCompleteness,
  normalizeStockCode,
};
