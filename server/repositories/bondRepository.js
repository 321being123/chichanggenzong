// 可转债标准读取仓储（批次1，从 bondDataService 迁入的 SQL）。
// 合同：方法签名 method(params, tx)；tx 缺省时使用连接池（单语句只读）。
// 只读标准视图 public.bond_unified 与标准层，不触发外采、不写任何表。
const { pool } = require('../db');

// 全量可转债列表（基础信息）
async function listBonds(params = {}, tx) {
  const runner = tx || pool;
  const filters = params.filters || {};
  const where = [];
  const binds = [];
  let pi = 1;
  if (filters.status) {
    where.push(`status = $${pi}`); binds.push(filters.status); pi++;
  } else {
    where.push("status = 'listed'");
  }
  if (filters.search) {
    where.push(`(bond_code ILIKE $${pi} OR bond_name ILIKE $${pi} OR stock_name ILIKE $${pi})`);
    binds.push('%' + filters.search + '%'); pi++;
  }
  if (filters.excludeIssueType) {
    where.push(`(issue_type IS NULL OR issue_type NOT IN ($${pi}))`);
    binds.push(filters.excludeIssueType); pi++;
  }
  const sql = `SELECT * FROM public.bond_unified WHERE ${where.join(' AND ')}
    ORDER BY display_rating NULLS LAST, listing_date DESC NULLS LAST`;
  const { rows } = await runner.query(sql, binds);
  return rows;
}

// 单债详情（按纯数字代码匹配任一市场）
async function findDetail(params = {}, tx) {
  const runner = tx || pool;
  const cleanCode = String(params.code || '').trim().toUpperCase().split('.')[0];
  const { rows } = await runner.query(
    "SELECT * FROM public.bond_unified WHERE split_part(bond_code, '.', 1) = $1 AND (issue_type IS NULL OR issue_type NOT IN ('定向','私募'))",
    [cleanCode],
  );
  return rows[0] || null;
}

// 按六位纯数字代码查（兼容 IPO 模块调用方式）
async function findBySecurityCode(params = {}, tx) {
  const runner = tx || pool;
  const clean = String(params.securityCode || '').includes('.') ? String(params.securityCode).split('.')[0] : params.securityCode;
  const { rows } = await runner.query(
    "SELECT * FROM public.bond_unified WHERE bond_code LIKE $1 AND (issue_type IS NULL OR issue_type NOT IN ('定向','私募'))",
    [clean + '.%'],
  );
  return rows[0] || null;
}

// 打新历史列表：security_code 保持六位纯数字，标准代码走 canonical_code
async function listHistory(params = {}, tx) {
  const runner = tx || pool;
  const limit = params.limit === undefined ? 50 : params.limit;
  const { rows } = await runner.query(
    `SELECT split_part(b.bond_code, '.', 1) AS security_code,
       b.bond_code AS canonical_code, b.bond_name AS security_name,
       b.ann_date, b.res_ann_date, b.display_issue_size AS issue_size, b.issue_type,
       b.display_rating AS rating, b.shd_ration_ratio, b.bh_issue_price AS issue_price,
       b.shd_ration_record_date, b.onl_date, b.onl_size, b.onl_pch_num, b.offl_size,
       b.shd_ration_size, b.display_conv_price AS conv_price,
       b.stock_code AS stk_code, b.stock_name AS stk_name,
       b.listing_date, b.first_day_return,
       CASE
         WHEN b.listing_date = (timezone('Asia/Shanghai', now()))::date THEN 'listing_today'
         WHEN b.listing_date < (timezone('Asia/Shanghai', now()))::date THEN 'listed'
         WHEN b.onl_date IS NOT NULL THEN 'subscribed'
         ELSE 'announced'
       END AS history_stage,
       jsonb_build_object(
         'ann_date', CASE WHEN b.ann_date IS NOT NULL THEN 'value' ELSE 'missing' END,
         'onl_date', CASE WHEN b.onl_date IS NOT NULL THEN 'value' ELSE 'pending' END,
         'listing_date', CASE WHEN b.listing_date IS NOT NULL THEN 'value' ELSE 'pending' END,
         'issue_size', CASE WHEN b.display_issue_size IS NOT NULL THEN 'value' ELSE 'missing' END,
         'rating', CASE WHEN NULLIF(b.display_rating, '') IS NOT NULL THEN 'value' ELSE 'missing' END,
         'onl_size', CASE
           WHEN b.res_ann_date IS NULL OR b.res_ann_date::date > (timezone('Asia/Shanghai', now()))::date THEN 'pending'
           WHEN b.onl_size IS NOT NULL THEN 'value'
           ELSE 'missing'
         END,
         'onl_pch_num', CASE
           WHEN b.res_ann_date IS NULL OR b.res_ann_date::date > (timezone('Asia/Shanghai', now()))::date THEN 'pending'
           WHEN b.onl_pch_num IS NOT NULL THEN 'value'
           ELSE 'missing'
         END,
         'first_day_return', CASE
           WHEN b.listing_date IS NULL OR b.listing_date > (timezone('Asia/Shanghai', now()))::date THEN 'pending'
           WHEN b.first_day_return IS NOT NULL THEN 'value'
           ELSE 'missing'
         END
       ) AS field_status,
       to_char((timezone('Asia/Shanghai', now()))::date, 'YYYY-MM-DD') AS data_as_of,
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
    [limit],
  );
  return rows;
}

// 活跃可转债 codes 列表（过滤已退市/到期/停止转股）
async function listActiveCodes(params = {}, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT bond_code FROM public.bond_unified
      WHERE status = 'listed' AND (issue_type IS NULL OR issue_type NOT IN ('定向', '私募'))`,
  );
  return rows.map(row => row.bond_code);
}

// 评级分布
async function ratingDistribution(params = {}, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT display_rating AS rating, COUNT(*) AS cnt
     FROM public.bond_unified
     WHERE status = 'listed' AND (issue_type IS NULL OR issue_type NOT IN ('定向', '私募'))
     GROUP BY display_rating ORDER BY cnt DESC`,
  );
  return rows;
}

module.exports = {
  findBySecurityCode,
  findDetail,
  listActiveCodes,
  listBonds,
  listHistory,
  ratingDistribution,
};
