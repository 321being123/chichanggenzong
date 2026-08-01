// ====== 可转债统一数据服务 ======
// 所有模块（打新日历、股债分析、估值、安全性、周期）通过本服务读写可转债基础信息。
//
// 标准模式（所有模块都遵循，不假设谁先谁后）：
//   1. checkBondCompleteness(code) → 查 bond_unified，判断数据是否完整
//   2. 如果完整 → 直接用，不再拉外部 API
//   3. 如果缺字段 → pull 缺失的字段（不是全量拉），upsert 补充
//   4. 如果不存在 → pull 全部，upsert 新建
//
// 关键：所有写入走 upsertBondBaseInfo()，内部用 INSERT ON CONFLICT，
// 已有数据保留（COALESCE 优先旧值），只补空字段。任何模块都可以是"第一个"。
const { pool } = require('../db');

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
  const cleanCode = code.includes('.') ? code.split('.')[0] : code;
  const { rows } = await pool.query(
    'SELECT * FROM public.bond_unified WHERE bond_code = $1',
    [code.includes('.') ? code : null]
  );
  if (rows.length) return rows[0];
  // 兜底：只用代码前缀匹配
  const { rows: r2 } = await pool.query(
    "SELECT * FROM public.bond_unified WHERE bond_code LIKE $1",
    [cleanCode + '.%']
  );
  return r2[0] || null;
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

// 打新历史列表（替代原 bond_history 直查）
async function getBondHistoryList(limit = 50) {
  const { rows } = await pool.query(
    `SELECT bond_code AS security_code, bond_name AS security_name,
       ann_date, res_ann_date, display_issue_size AS issue_size, issue_type,
       display_rating AS rating, shd_ration_ratio, bh_issue_price AS issue_price,
       shd_ration_record_date, onl_date, onl_size, onl_pch_num, offl_size,
       shd_ration_size, display_conv_price AS conv_price,
       stock_code AS stk_code, stock_name AS stk_name,
       listing_date, first_day_return
     FROM public.bond_unified
     WHERE issue_type IS NULL OR issue_type NOT IN ('定向', '私募')
     ORDER BY COALESCE(res_ann_date, ann_date, listing_date::text) DESC NULLS LAST
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
// 原则：先查 bond_unified 有没有 → 缺什么补什么 → 够了直接用。
// 不假设谁先写谁后写，任何模块都可以是"第一个"。
//
// 字段完整性判断：有 bond_code + bond_name + conv_price + stock_code 就算基础完整。
// 如果 ipo 特有字段（onl_date/ann_date 等）缺失，说明只有打新日历模块能补。
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

// 从 bond_history 增量补充数据到 instruments + profiles
// 调用方可以传入已有的 client（事务内），也可以不传（独立事务）
async function upsertBondBaseInfo(client, bhRow, sourceId) {
  const db = client || pool;
  const suffix = /^12/.test(bhRow.security_code) ? '.SZ' : '.SH';
  const tsCode = bhRow.security_code + suffix;

  // 确保 instrument 存在
  await db.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,list_date)
     VALUES($1,$2,'convertible_bond','CN',$3::date)
     ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name,list_date=COALESCE(core.instruments.list_date,EXCLUDED.list_date),
       updated_at=now()`,
    [tsCode, bhRow.security_name || bhRow.security_code, bhRow.listing_date || null]
  );

  // 查 instrument_id（新建或已存在都取到）
  const { rows: [inst] } = await db.query(
    'SELECT instrument_id FROM core.instruments WHERE canonical_code=$1', [tsCode]
  );
  if (!inst) return null;
  const bondId = inst.instrument_id;

  // 确保或补充 profile（ON CONFLICT：已有数据保留，只补空字段）
  await db.query(
    `INSERT INTO fundamental.convertible_bond_profiles
     (instrument_id,bond_short_name,cb_type,current_conv_price,issue_size,newest_rating,list_date,source_id,raw_payload)
     VALUES($1,$2,'CB',$3,$4,$5,$6::date,$7,$8::jsonb)
     ON CONFLICT(instrument_id) DO UPDATE SET
      bond_short_name=COALESCE(NULLIF(fundamental.convertible_bond_profiles.bond_short_name,''),EXCLUDED.bond_short_name),
      current_conv_price=COALESCE(fundamental.convertible_bond_profiles.current_conv_price,EXCLUDED.current_conv_price),
      issue_size=COALESCE(fundamental.convertible_bond_profiles.issue_size,EXCLUDED.issue_size),
      newest_rating=COALESCE(fundamental.convertible_bond_profiles.newest_rating,EXCLUDED.newest_rating),
      list_date=COALESCE(fundamental.convertible_bond_profiles.list_date,EXCLUDED.list_date),
      raw_payload=fundamental.convertible_bond_profiles.raw_payload || EXCLUDED.raw_payload,
      updated_at=now()`,
    [bondId, bhRow.security_name || bhRow.security_code,
      finiteVal(bhRow.conv_price), finiteVal(bhRow.issue_size),
      bhRow.rating || '', bhRow.listing_date || null,
      sourceId, JSON.stringify({ source: 'bond_history_upsert', security_code: bhRow.security_code })]
  );

  // 正股：有 stk_code 就确保 instrument
  if (bhRow.stk_code) {
    const stkSuffix = /^(0|3)/.test(bhRow.stk_code) ? '.SZ' : '.SH';
    const stkCode = bhRow.stk_code + stkSuffix;
    await db.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market)
       VALUES($1,$2,'stock','CN')
       ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name,updated_at=now()`,
      [stkCode, bhRow.stk_name || bhRow.stk_code]
    );
    // 关联正股
    const { rows: [stk] } = await db.query(
      'SELECT instrument_id FROM core.instruments WHERE canonical_code=$1', [stkCode]
    );
    if (stk) {
      await db.query(
        `UPDATE fundamental.convertible_bond_profiles SET stock_instrument_id=$1,updated_at=now()
         WHERE instrument_id=$2 AND (stock_instrument_id IS NULL OR stock_instrument_id<>$1)`,
        [stk.instrument_id, bondId]
      );
    }
  }

  return bondId;
}

function finiteVal(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  getBondList,
  getBondDetail,
  getBondBySecurityCode,
  getBondHistoryList,
  getActiveBondCodes,
  getRatingDistribution,
  checkBondCompleteness,
  upsertBondBaseInfo,
};
