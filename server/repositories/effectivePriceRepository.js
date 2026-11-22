const { pool } = require('../db/connection');

// 统一估值价格的批量只读仓储。
// 只做 SQL，不做业务判断：来源白名单、质量分级、市场时段与缺失原因都在 services/effectivePrice 内决定。
// 所有查询都接受外层事务连接，避免在一次账户读取里另开连接池连接造成口径分裂。

// 按证券取最近若干交易日的日价候选，跨用户读取普通市场事实：
// 同一证券同一交易日的收盘价是公开市场事实，不属于某个账户，因此不能按用户各选一份，
// 否则两位用户持有同一证券会各自得到“完整”但不同的价格。
// 账户私有的派生价（导入锚点等，见 $4 排除名单）只回给其所属账户，保持人工/派生估值隔离。
async function listRecentDailyPriceCandidates(params, client = pool) {
  const [username, codes, upperDate, privateSources, dateWindow] = params;
  return client.query(
    `SELECT code, market, date::text AS date, price::float8 AS price, username, account_name,
            quality, is_final, source, quote_at, revision, evidence
       FROM (
         SELECT code, market, date, price, username, account_name, quality, is_final, source, quote_at, revision, evidence,
                DENSE_RANK() OVER (PARTITION BY market, code ORDER BY date DESC) AS date_rank
           FROM daily_prices
          WHERE code = ANY($2::text[])
            AND date::date <= $3::date
            AND (COALESCE(source, '') <> ALL($4::text[]) OR username = $1)
       ) ranked
      WHERE date_rank <= $5
      ORDER BY market, code, date DESC, revision DESC`,
    [username, codes, upperDate, privateSources, dateWindow]
  );
}

// 共享行情缓存只含公开市场事实，不按账户隔离，也不写入账户专属人工估值。
async function listQuoteCacheCandidates(params, client = pool) {
  const [codes, sources] = params;
  return client.query(
    `SELECT code, symbol, source, market, name, price::float8 AS price, quote_time, fetched_at
       FROM market_quote_cache
      WHERE code = ANY($1::text[])
        AND ($2::text[] IS NULL OR source = ANY($2::text[]))
      ORDER BY code, fetched_at DESC`,
    [codes, sources]
  );
}

// 兼容持仓价：仅作为无任何行情证据时的“未核实参考价”，不构成正常证券估值权威。
async function listPositionPriceCache(params, client = pool) {
  const [username, accountName, codes] = params;
  return client.query(
    `SELECT code, name, price::float8 AS price, quantity::float8 AS quantity, subtype
       FROM positions
      WHERE username = $1 AND account_name = $2 AND code = ANY($3::text[])`,
    [username, accountName, codes]
  );
}

async function selectAccountId(params, client = pool) {
  const [username, accountName] = params;
  return client.query('SELECT id FROM accounts WHERE username=$1 AND account_name=$2', params);
}

// 只读核对最后成交日至目标日之间每个自然日的交易日历，以及每个开市日的停牌事实和分区质量。
// 不把停牌参考价写入 daily_prices；退市日及之后的换股过渡期不适用。
const suspensionIntervalSql = `SELECT i.instrument_id, i.exchange_code,
            ($3::date - $2::date)::int AS calendar_days,
            COUNT(DISTINCT c.trade_date)::int AS known_days,
            COUNT(DISTINCT c.trade_date) FILTER (WHERE c.is_open)::int AS open_days,
            COUNT(DISTINCT c.trade_date) FILTER (WHERE c.is_open AND EXISTS (
              SELECT 1 FROM market.stock_suspend_calendar s
              JOIN ops.dataset_partitions p ON p.dataset_code='stock_suspend_calendar'
                AND p.scope_key='CN' AND p.partition_key=s.trade_date
              WHERE s.instrument_id=i.instrument_id AND s.trade_date=c.trade_date AND s.suspend_type='S'
                AND p.status='published' AND NOT COALESCE(p.is_stale,false)
                AND p.diagnostics->>'query_status'='success'
                AND COALESCE(p.diagnostics->>'quality_status','passed')='passed'
            ) AND NOT EXISTS (
              SELECT 1 FROM market.stock_suspend_calendar resumed
              WHERE resumed.instrument_id=i.instrument_id AND resumed.trade_date=c.trade_date
                AND resumed.suspend_type='R'
            ))::int AS verified_days,
            NOT EXISTS (
              SELECT 1 FROM daily_prices d
              WHERE d.code=$5 AND d.market='CN' AND d.date::text=$2::text
                AND d.quality='confirmed' AND d.is_final=true AND d.price>0
                AND COALESCE(d.source,'') <> ALL($6::text[])
                AND d.price IS DISTINCT FROM $4::numeric
            ) AS no_price_conflict
       FROM core.instruments i
       LEFT JOIN market.trade_calendar c ON c.exchange=i.exchange_code
         AND c.trade_date>$2::date AND c.trade_date<=$3::date
      WHERE upper(i.canonical_code)=upper($1) AND i.asset_class='stock' AND i.market='CN'
        AND i.exchange_code IN ('SSE','SZSE')
        AND EXISTS (SELECT 1 FROM market.trade_calendar first_day
          WHERE first_day.exchange=i.exchange_code AND first_day.trade_date=$2::date AND first_day.is_open)
        AND NOT EXISTS (SELECT 1 FROM fundamental.corporate_actions action
          WHERE action.instrument_id=i.instrument_id AND action.ex_date>$2::date AND action.ex_date<=$3::date)
        AND (i.list_date IS NULL OR i.list_date<=$2::date)
        AND (i.delist_date IS NULL OR i.delist_date>$3::date)
        AND (i.status<>'delisted' OR i.delist_date IS NOT NULL)
      GROUP BY i.instrument_id,i.exchange_code`;
async function inspectSuspensionInterval(params, client = pool) {
  return client.query(suspensionIntervalSql, params);
}

// 历史投影一次传入全部实际缺价区间，不按证券和日期逐次往返数据库。
async function inspectSuspensionIntervals(requests, privateSources, client = pool) {
  const sql = suspensionIntervalSql
    .replaceAll('$1', 'req.canonical').replaceAll('$2', 'req.actual_date')
    .replaceAll('$3', 'req.target_date').replaceAll('$4', 'req.price')
    .replaceAll('$5', 'req.code').replaceAll('$6', '$2');
  return client.query(`WITH requests AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id int, canonical text, actual_date text, target_date text, price numeric, code text)
  ) SELECT req.id, proof.* FROM requests req CROSS JOIN LATERAL (${sql}) proof`,
  [JSON.stringify(requests), privateSources]);
}

// 已实施换股的历史参考：结算单、官方实施公告、同账户两条账本和合并方确认终盘必须一致。
// 该查询只读取既有事实；估值期间不回写交易、持仓或旧证券日价。
async function listSwapReferenceCandidates(username, accountName, client = pool) {
  return client.query(`SELECT s.settlement_id,s.case_id,split_part(old.canonical_code,'.',1) AS source_code,
      split_part(new.canonical_code,'.',1) AS target_code,old.delist_date::text AS delist_date,
      s.settlement_date::text AS settlement_date,src.trade_date::text AS execution_date,
      s.source_quantity::float8 AS source_quantity,s.target_quantity::float8 AS target_quantity,
      s.ratio_applied::float8 AS ratio,s.evidence_document_id,doc.announced_at::text AS evidence_date,
      p.date::text AS price_date,p.price::float8 AS target_price,p.source AS price_source
    FROM event.stock_swap_settlements s
    JOIN event.arbitrage_cases c ON c.case_id=s.case_id AND c.target_instrument_id=s.source_instrument_id
      AND c.reference_instrument_id=s.target_instrument_id AND c.strategy_type='a_share_swap' AND c.swap_ratio=s.ratio_applied
    JOIN core.instruments old ON old.instrument_id=s.source_instrument_id AND old.market='CN' AND old.asset_class='stock'
    JOIN core.instruments new ON new.instrument_id=s.target_instrument_id AND new.market='CN' AND new.asset_class='stock'
    JOIN event.documents doc ON doc.document_id=s.evidence_document_id AND doc.announced_at=s.settlement_date
    JOIN ops.data_sources ds ON ds.source_id=doc.source_id AND ds.source_code IN ('sse','szse')
    JOIN trades src ON src.username=s.username AND src.account_name=s.account_name
      AND src.id=s.applied_trade_ids->>0 AND src.code=split_part(old.canonical_code,'.',1)
      AND src.direction='adjust' AND src.quantity=0
    JOIN trades dst ON dst.username=s.username AND dst.account_name=s.account_name
      AND dst.id=s.applied_trade_ids->>1 AND dst.code=split_part(new.canonical_code,'.',1)
      AND dst.direction='adjust' AND dst.trade_date=src.trade_date
      AND dst.quantity=s.target_quantity+COALESCE(s.existing_target_quantity,0)
    JOIN daily_prices p ON p.username=s.username AND p.account_name=s.account_name AND p.market='CN'
      AND p.code=split_part(new.canonical_code,'.',1) AND p.date::date>=old.delist_date
      AND p.date::date<src.trade_date::date AND p.quality='confirmed' AND p.is_final=true AND p.price>0
      AND p.source IS NOT NULL AND p.source<>'nav_import_anchor'
      AND (p.evidence->>'price_adjust'='none' OR p.evidence->>'terminalEvidence'='unadjusted_bar_match')
    WHERE s.username=$1 AND s.account_name=$2 AND s.status='applied'
      AND jsonb_typeof(s.applied_trade_ids)='array' AND jsonb_array_length(s.applied_trade_ids)=2
      AND old.delist_date IS NOT NULL AND s.source_quantity>0 AND s.target_quantity>0 AND s.ratio_applied>0
      AND s.settlement_date<=src.trade_date::date
      AND (doc.title LIKE '%换股实施结果%' OR doc.title LIKE '%实施情况暨新增股份上市%' OR doc.title LIKE '%证券变更登记完成%')
      AND EXISTS (SELECT 1 FROM event.arbitrage_case_documents cd WHERE cd.case_id=s.case_id AND cd.document_id=doc.document_id)
      AND floor(s.source_quantity*s.ratio_applied+0.00000001)=s.target_quantity
      AND NOT EXISTS (SELECT 1 FROM daily_prices other WHERE other.market='CN' AND other.code=p.code
        AND other.date=p.date AND other.quality='confirmed' AND other.is_final=true AND other.price>0
        AND COALESCE(other.source,'')<>'nav_import_anchor' AND other.price IS DISTINCT FROM p.price)
    ORDER BY s.settlement_id,p.date`, [username,accountName]);
}

// 写入时必须带市场：港股 00001 与 A 股 000001 是两只不同证券，缺了市场就无法区分。
// 判定顺序：调用方显式给出（收盘任务按市场规则、补录按品种）→ 代码形状（5 位只在港股、
// 6 位不以 00 开头只在 A 股）→ 其余无法判定，写 'UNKNOWN'（身份不明，取价层按缺口处理）。
function dailyPriceMarket(market, code) {
  const text = String(market || '').toUpperCase();
  if (text === 'HK' || text === 'CN') return text;
  const codeText = String(code || '');
  if (codeText.length === 5) return 'HK';
  if (codeText.length === 6 && !codeText.startsWith('00')) return 'CN';
  return 'UNKNOWN';
}

// 市场依据：写入时同时留下“凭什么这么判”，取价层对同形代码要求有依据才接受。
function dailyPriceMarketBasis(market, code, evidence) {
  const declared = evidence && evidence.market_basis;
  if (declared) return String(declared);
  const text = String(market || '').toUpperCase();
  if (text === 'HK' || text === 'CN') return 'writer_declared';
  const codeText = String(code || '');
  if (codeText.length === 5) return 'code_length_5';
  if (codeText.length === 6 && !codeText.startsWith('00')) return 'code_shape';
  return 'unverified';
}

// 条件写入：
// ①已确认收盘价不允许被较低资格（候选/遗留/派生）覆盖；
// ②同级 confirmed 更正必须能核验修订关系，只认两种情形：
//   a) 同一已准入来源、报价时刻严格更新（正常修订/重取）；
//   b) 同一已准入来源、同一报价时刻但价格确实不同（来源侧更正）。
//   报价时刻缺失，或来源不同且时刻相同（迟到响应/来源打架）一律不写，冲突留待人工核验；
// ③完全相同（同质量、同价、同来源时刻）视为幂等重复，不更新也不递增 revision。
// previous_price / revision 保留可追溯性与“合法更正使版本变化”的语义。
async function upsertDailyPrice(params, client = pool) {
  const [row] = params;
  return client.query(
    `INSERT INTO daily_prices
       (username, account_name, account_id, date, code, name, price, source, quote_at, is_final, quality, revision, evidence, market)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12::jsonb,$13)
     ON CONFLICT (username, account_name, date, market, code) DO UPDATE SET
       name = EXCLUDED.name,
       previous_price = CASE
         WHEN daily_prices.price IS DISTINCT FROM EXCLUDED.price THEN daily_prices.price
         ELSE daily_prices.previous_price END,
       revision = daily_prices.revision + 1,
       price = EXCLUDED.price,
       source = EXCLUDED.source,
       quote_at = EXCLUDED.quote_at,
       is_final = EXCLUDED.is_final,
       quality = EXCLUDED.quality,
       evidence = EXCLUDED.evidence,
       -- 市场必须与价格/质量在同一条语句里一起更新：否则一次过期写入就能把
       -- “已被错标成 A 股的港股行”继续保留错误市场，随后被 A 股持仓选中。
       market = EXCLUDED.market
     WHERE daily_prices.quality <> 'confirmed'
        OR (EXCLUDED.quality = 'confirmed'
            AND EXCLUDED.source IS NOT DISTINCT FROM daily_prices.source
            AND (
              -- a) 同来源、报价时刻严格更新
              (EXCLUDED.quote_at IS NOT NULL
                AND (daily_prices.quote_at IS NULL OR EXCLUDED.quote_at > daily_prices.quote_at))
              -- b) 同来源、同一报价时刻但价格不同：来源侧更正
              OR (daily_prices.quote_at IS NOT NULL
                  AND EXCLUDED.quote_at IS NOT DISTINCT FROM daily_prices.quote_at
                  AND EXCLUDED.price IS DISTINCT FROM daily_prices.price)
            ))
     RETURNING date::text AS date, code, revision, quality, is_final`,
    [row.username, row.accountName, row.accountId, row.date, row.code, row.name || '',
      row.price, row.source || null, row.quoteAt || null, row.isFinal == null ? null : !!row.isFinal,
      row.quality || 'candidate',
      JSON.stringify({
        ...(row.evidence || {}),
        market_basis: dailyPriceMarketBasis(row.market, row.code, row.evidence),
      }),
      dailyPriceMarket(row.market, row.code)]
  );
}

module.exports = {
  dailyPriceMarket,
  dailyPriceMarketBasis,
  listRecentDailyPriceCandidates,
  listQuoteCacheCandidates,
  listPositionPriceCache,
  selectAccountId,
  inspectSuspensionInterval,
  inspectSuspensionIntervals,
  listSwapReferenceCandidates,
  upsertDailyPrice,
};
