// 可转债分析数据仓储（批次3，从 routes/bondAnalysis 迁入的 SQL）。
// 合同：method(params, tx)；只做候选证券检索，不判断可转债业务语义（type 归类由服务层决定）。
const { pool } = require('../db/connection');

// 本人持仓 + 自选 的证券集合（按完整标准身份去重，标记持有/自选来源）。
// 五位数字按港股补零为 NNNNN.HK，六位数字沿用内地 A 股后缀规则；自选保留完整标准代码，不截六位。
async function listOwnedSecurities(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT code,MAX(name) AS name,BOOL_OR(held) AS held,BOOL_OR(watchlisted) AS watchlisted FROM (
       SELECT CASE
                WHEN p.code ~ '^[0-9]{5}(\\.HK)?$' THEN lpad(replace(upper(p.code),'.HK',''),5,'0')||'.HK'
                WHEN p.code ~ '^[0-9]{6}$' THEN CASE WHEN p.code ~ '^6' THEN p.code||'.SH'
                     WHEN p.code ~ '^(4|8|92)' THEN p.code||'.BJ' ELSE p.code||'.SZ' END
              END AS code,
              MAX(p.name) AS name,true AS held,false AS watchlisted
         FROM positions p
        WHERE p.username=$1 AND p.code ~ '^[0-9]{5,6}(\\.(HK|SH|SZ|BJ))?$'
        GROUP BY 1
       UNION ALL
       SELECT w.ts_code,MAX(w.name),false,true FROM stock_watchlist w
        WHERE w.username=$1 GROUP BY w.ts_code
     ) s WHERE code IS NOT NULL GROUP BY code ORDER BY held DESC,name,code`,
    [params.username],
  );
  return rows;
}

// 证券搜索：在售可转债排除定向/私募/临近摘牌与停止转股；股票含内地 A 股与港股主档普通股票。
// 完整标准代码精确命中优先，LIMIT 不能截掉精确命中；港股类型闸门在应用层按主档核对。
async function searchSecurities(params, tx) {
  const runner = tx || pool;
  const exact = String(params.exact || params.prefix || '').replace(/%$/, '');
  const { rows } = await runner.query(
    `WITH candidates AS (
       SELECT substring(m.ts_code,1,6) AS code,m.ts_code,m.name,'stock'::text AS type,''::text AS stock_name
         FROM market_instruments m
        WHERE m.source='tushare'
          AND m.ts_code ~ '^(60|68|00|30|43|83|87|92)[0-9]{4}\\.(SH|SZ|BJ)$'
          AND (m.name ILIKE $1 OR m.ts_code ILIKE $1 OR substring(m.ts_code,1,6) ILIKE $1)
       UNION ALL
       SELECT i.canonical_code,i.canonical_code,i.name,'stock'::text,''::text
         FROM core.instruments i
        WHERE i.market='HK' AND i.asset_class='stock'
          AND i.canonical_code ~ '^[0-9]{5}\\.HK$'
          AND (i.name ILIKE $1 OR i.canonical_code ILIKE $1 OR substring(i.canonical_code,1,5) ILIKE $1)
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
      ORDER BY CASE WHEN lower(ts_code)=lower($3) THEN 0 WHEN lower(code)=lower($3) THEN 1
                    WHEN name ILIKE $2 THEN 2 WHEN code ILIKE $2 THEN 3 ELSE 4 END,
               CASE type WHEN 'stock' THEN 0 ELSE 1 END,name,code
      LIMIT 12`,
    [params.like, params.prefix, exact],
  );
  return rows;
}

module.exports = { listOwnedSecurities, searchSecurities };
