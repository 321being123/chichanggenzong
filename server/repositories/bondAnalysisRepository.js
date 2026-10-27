// 可转债分析数据仓储（批次3，从 routes/bondAnalysis 迁入的 SQL）。
// 合同：method(params, tx)；只做候选证券检索，不判断可转债业务语义（type 归类由服务层决定）。
const { pool } = require('../db/connection');

// 本人持仓 + 自选 的证券集合（六位代码维度去重，标记持有/自选来源）
async function listOwnedSecurities(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT code,MAX(name) AS name,BOOL_OR(held) AS held,BOOL_OR(watchlisted) AS watchlisted FROM (
       SELECT p.code,MAX(p.name) AS name,true AS held,false AS watchlisted FROM positions p
        WHERE p.username=$1 AND p.code ~ '^[0-9]{6}$' GROUP BY p.code
       UNION ALL
       SELECT substring(w.ts_code,1,6),MAX(w.name),false,true FROM stock_watchlist w
        WHERE w.username=$1 GROUP BY substring(w.ts_code,1,6)
     ) s GROUP BY code ORDER BY held DESC,name,code`,
    [params.username],
  );
  return rows;
}

// 证券搜索：在售可转债排除定向/私募/临近摘牌与停止转股，股票限 A 股主板/创业板/科创板/北交所。
async function searchSecurities(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `WITH candidates AS (
       SELECT substring(m.ts_code,1,6) AS code,m.ts_code,m.name,'stock'::text AS type,''::text AS stock_name
         FROM market_instruments m
        WHERE m.source='tushare'
          AND m.ts_code ~ '^(60|68|00|30|43|83|87|92)[0-9]{4}\\.(SH|SZ|BJ)$'
          AND (m.name ILIKE $1 OR m.ts_code ILIKE $1 OR substring(m.ts_code,1,6) ILIKE $1)
       UNION ALL
       SELECT substring(b.canonical_code,1,6),b.canonical_code,p.bond_short_name,'bond',COALESCE(s.name,'')
         FROM fundamental.convertible_bond_profiles p
         JOIN core.instruments b ON b.instrument_id=p.instrument_id
         JOIN public.bond_unified bu ON bu.instrument_id=b.instrument_id
         LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
        WHERE bu.status='listed'
          AND (bu.issue_type IS NULL OR bu.issue_type NOT IN ('定向','私募'))
          AND (b.delist_date IS NULL OR b.delist_date > CURRENT_DATE)
          AND (p.maturity_date IS NULL OR p.maturity_date >= CURRENT_DATE)
          AND (p.conv_end_date IS NULL OR p.conv_end_date >= CURRENT_DATE)
          AND (p.conv_stop_date IS NULL OR p.conv_stop_date > CURRENT_DATE)
          AND (p.bond_short_name ILIKE $1 OR b.canonical_code ILIKE $1
               OR substring(b.canonical_code,1,6) ILIKE $1 OR COALESCE(s.name,'') ILIKE $1)
     )
     SELECT code,ts_code,name,type,stock_name
       FROM candidates
      ORDER BY CASE WHEN name ILIKE $2 THEN 0 WHEN code ILIKE $2 THEN 1 ELSE 2 END,
               CASE type WHEN 'stock' THEN 0 ELSE 1 END,name,code
      LIMIT 12`,
    [params.like, params.prefix],
  );
  return rows;
}

module.exports = { listOwnedSecurities, searchSecurities };
