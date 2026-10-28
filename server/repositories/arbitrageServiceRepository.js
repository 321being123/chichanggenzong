const { pool } = require('../db/connection');

// 自 server/services/arbitrageService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function getCandidates(page = 1, pageSize = 50, status = 'pending') {
  const offset = (page - 1) * pageSize;
  const { rows } = await pool.query(`
    SELECT c.*, i.canonical_code, i.name
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    WHERE c.review_status = $1
    ORDER BY c.created_at DESC
    LIMIT $2 OFFSET $3
  `, [status, pageSize, offset]);

  const { rows: countRows } = await pool.query(
    'SELECT count(*) as total FROM event.arbitrage_cases WHERE review_status=$1', [status]
  );

  return { rows, total: parseInt(countRows[0].total), page, pageSize };
}

async function getCaseDetail(caseId) {
  const { rows } = await pool.query(`
    SELECT c.*, i.canonical_code, i.name,
           ri.canonical_code as ref_code, ri.name as ref_name,
           rwi.canonical_code as rights_code, rwi.name as rights_name
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    LEFT JOIN core.instruments ri ON c.reference_instrument_id = ri.instrument_id
    LEFT JOIN core.instruments rwi ON c.rights_instrument_id = rwi.instrument_id
    WHERE c.case_id = $1
  `, [caseId]);

  if (!rows.length) return null;

  const { rows: docs } = await pool.query(`
    SELECT d.document_id, d.title, d.announced_at, d.url, acd.relation_type
    FROM event.arbitrage_case_documents acd
    JOIN event.documents d ON acd.document_id = d.document_id
    WHERE acd.case_id = $1
    ORDER BY d.announced_at DESC NULLS LAST
  `, [caseId]);

  return { ...rows[0], documents: docs };
}

async function with_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`
    WITH linked AS (
      SELECT d.document_id, d.title, d.announced_at, d.url, acd.relation_type, acd.document_role
      FROM event.arbitrage_case_documents acd
      JOIN event.documents d ON acd.document_id = d.document_id
      WHERE acd.case_id = $1
    ), inferred_risk AS (
      SELECT d.document_id, d.title, d.announced_at, d.url,
             'risk_event'::text AS relation_type, 'risk'::text AS document_role
      FROM event.documents d
      WHERE d.document_type = 'arbitrage_announcement'
        AND d.title ~* '(立案告知书|立案调查|调查通知书|调查告知书|行政处罚决定书|处罚决定|行政监管措施|监管警示|监管措施|问询函|监管工作函|监管函)'
        AND d.title !~* '((问询函|监管工作函|监管函).{0,16}(回复|答复)|((回复|答复).{0,16}(问询函|监管工作函|监管函)))'
        AND COALESCE(d.raw_payload->>'secCode', d.raw_payload->>'stockCode', d.raw_payload->>'code') = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM linked l WHERE l.document_id = d.document_id)
    ), inferred_progress AS (
      SELECT d.document_id, d.title, d.announced_at, d.url,
             'progress_event'::text AS relation_type, 'progress'::text AS document_role
      FROM event.documents d
      WHERE d.document_type = 'arbitrage_announcement'
        AND d.title ~* '((问询函|监管工作函|监管函).{0,16}(回复|答复)|((回复|答复).{0,16}(问询函|监管工作函|监管函))|(报告书|报告|申请).{0,12}(注册稿|申报稿)|(注册稿|申报稿).{0,12}(报告书|报告|申请))'
        AND COALESCE(d.raw_payload->>'secCode', d.raw_payload->>'stockCode', d.raw_payload->>'code') = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM linked l WHERE l.document_id = d.document_id)
    )
    SELECT * FROM linked
    UNION ALL
    SELECT * FROM inferred_risk
    UNION ALL
    SELECT * FROM inferred_progress
    ORDER BY announced_at DESC NULLS LAST
  `, params);
}

async function select_event_arbitrage_cases(params, client = pool) {
  return client.query(`
    SELECT c.*,i.canonical_code
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON i.instrument_id=c.target_instrument_id
    WHERE c.case_id = $1
  `, params);
}

async function select_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`
    SELECT d.document_id,d.url,d.title,acd.document_role,acd.parser_version,acd.parse_status
    FROM event.arbitrage_case_documents acd
    JOIN event.documents d ON acd.document_id=d.document_id
    WHERE acd.case_id=$1 AND d.url ~* '\\.pdf$'
    ORDER BY d.announced_at ASC NULLS LAST
  `, params);
}

async function select_event_arbitrage_cases_1(params, client = pool) {
  return client.query(`SELECT case_id FROM event.arbitrage_cases WHERE case_id=$1`, params);
}

// 公开页口径：只展示具备核心计算条款的案件，并兜底排除被误建为「进行中」的终态公告。
// 买方要约标题正则由调用方传入（与 arbitrageRules 同一份常量）。
function buildCaseFilter(buyerOfferPattern) {
  const targetRoleFilter = `NOT (c.strategy_type = 'a_cash_offer' AND EXISTS (
    SELECT 1 FROM event.documents buyer_doc
    WHERE buyer_doc.document_id=c.primary_document_id
      AND COALESCE(buyer_doc.title, '') ~ '${buyerOfferPattern}'
  ))`;
  return `
  c.review_status = 'approved'
  AND (c.parser_version IS NULL OR c.parse_status = 'validated')
  AND c.event_status NOT IN ('completed','terminated','expired')
  AND ${targetRoleFilter}
  AND (c.expected_completion_date IS NULL OR c.expected_completion_date >= CURRENT_DATE)
  AND (
    (c.strategy_type IN ('a_cash_offer','hk_privatisation') AND COALESCE(c.offer_price,c.cash_choice_price) > 0)
    OR (c.strategy_type = 'a_share_swap' AND (
        COALESCE(c.cash_choice_price,c.offer_price) > 0
        OR (c.swap_ratio > 0
          AND c.reference_instrument_id IS NOT NULL
          AND c.reference_instrument_id <> c.target_instrument_id
          AND EXISTS (
            SELECT 1 FROM core.instruments ref_valid
            WHERE ref_valid.instrument_id = c.reference_instrument_id
              AND COALESCE(ref_valid.name, '') <> ''
          ))))
    OR (c.strategy_type = 'hk_rights' AND c.subscription_price > 0
        AND c.rights_units_per_new_share > 0 AND c.rights_instrument_id IS NOT NULL)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM event.arbitrage_case_documents acd_terminal
    JOIN event.documents d_terminal ON d_terminal.document_id = acd_terminal.document_id
    WHERE acd_terminal.case_id = c.case_id
      AND COALESCE(d_terminal.title, '') ~* '(终止([^上]|$)|終止([^上]|$)|完成过户|完成過戶|过户完成|過戶完成|交割完成|交割完毕|交割完畢|实施结果|實施結果|申报结果|申報結果|供股.{0,12}结果|供股.{0,12}結果|私有化.{0,12}完成|privati[sz]ation.{0,20}completed|lapsed|terminated|withdrawn)'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM event.arbitrage_cases terminal_case
    JOIN event.arbitrage_case_documents terminal_link ON terminal_link.case_id=terminal_case.case_id
    JOIN event.documents terminal_doc ON terminal_doc.document_id=terminal_link.document_id
    WHERE terminal_case.target_instrument_id=c.target_instrument_id
      AND terminal_case.strategy_type=c.strategy_type
      AND terminal_case.case_id<>c.case_id
      AND terminal_case.event_status IN ('completed','terminated','expired')
      AND terminal_doc.announced_at>=c.announced_at
  )`;
}
const CASE_SELECT = `
    SELECT c.*, i.canonical_code, regexp_replace(i.name,'<[^>]+>','','g') AS name, i.currency_code as inst_currency,
           ri.canonical_code as ref_code, regexp_replace(ri.name,'<[^>]+>','','g') AS ref_name,
           rwi.canonical_code as rights_code, rwi.name as rights_name,
           pd.url AS announcement_url,
           CASE WHEN $4::text IS NULL THEN NULL ELSE NOT (
             (SELECT arbitrage_seen_cases FROM users WHERE username=$4) ? c.case_id::text
           ) END AS is_new
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    LEFT JOIN core.instruments ri ON c.reference_instrument_id = ri.instrument_id
    LEFT JOIN core.instruments rwi ON c.rights_instrument_id = rwi.instrument_id
    LEFT JOIN event.documents pd ON c.primary_document_id = pd.document_id`;

// 公开列表分页：未读优先，其次按条款更新时间
async function listArbitrageCases(params, client = pool) {
  const filter = buildCaseFilter(params.buyerOfferPattern);
  return client.query(
    `${CASE_SELECT}
    WHERE c.strategy_type = ANY($1)
      AND ${filter}
    ORDER BY is_new DESC NULLS LAST, c.terms_updated_at DESC NULLS LAST
    LIMIT $2 OFFSET $3
  `,
    [params.types, params.pageSize, params.offset, params.username],
  );
}

async function countArbitrageCases(params, client = pool) {
  const filter = buildCaseFilter(params.buyerOfferPattern);
  return client.query(
    `SELECT count(*) as total FROM event.arbitrage_cases c
    WHERE c.strategy_type = ANY($1)
      AND ${filter}
  `,
    [params.types],
  );
}

// 公开详情：仅已审核通过且符合公开口径
async function selectArbitrageDetail(params, client = pool) {
  const targetRoleFilter = `NOT (c.strategy_type = 'a_cash_offer' AND EXISTS (
    SELECT 1 FROM event.documents buyer_doc
    WHERE buyer_doc.document_id=c.primary_document_id
      AND COALESCE(buyer_doc.title, '') ~ '${params.buyerOfferPattern}'
  ))`;
  return client.query(
    `SELECT c.*, i.canonical_code, regexp_replace(i.name,'<[^>]+>','','g') AS name, i.currency_code as inst_currency,
           ri.canonical_code as ref_code, regexp_replace(ri.name,'<[^>]+>','','g') AS ref_name,
           rwi.canonical_code as rights_code, rwi.name as rights_name,
           pd.url AS announcement_url,
           CASE WHEN $2::text IS NULL THEN NULL ELSE NOT (
             (SELECT arbitrage_seen_cases FROM users WHERE username=$2) ? c.case_id::text
           ) END AS is_new
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    LEFT JOIN core.instruments ri ON c.reference_instrument_id = ri.instrument_id
    LEFT JOIN core.instruments rwi ON c.rights_instrument_id = rwi.instrument_id
    LEFT JOIN event.documents pd ON c.primary_document_id = pd.document_id
    WHERE c.case_id = $1 AND c.review_status = 'approved' AND ${targetRoleFilter}
  `,
    [params.caseId, params.username],
  );
}

async function countUnreadArbitrages(params, client = pool) {
  const filter = buildCaseFilter(params.buyerOfferPattern);
  return client.query(
    `SELECT count(*)::int AS count FROM event.arbitrage_cases c
    WHERE ${filter} AND NOT (
      (SELECT arbitrage_seen_cases FROM users WHERE username=$1) ? c.case_id::text
    )`,
    [params.username],
  );
}

async function markArbitrageSeenCase(params, client = pool) {
  const filter = buildCaseFilter(params.buyerOfferPattern);
  return client.query(
    `UPDATE users SET arbitrage_seen_cases = arbitrage_seen_cases || jsonb_build_object($2::text, true)
    WHERE username=$1 AND EXISTS (
      SELECT 1 FROM event.arbitrage_cases c WHERE c.case_id=$2::bigint AND ${filter}
    )`,
    [params.username, String(params.caseId)],
  );
}

// 案件可编辑字段白名单：只有列在这里的字段才允许写库
const CASE_EDITABLE_COLUMNS = [
  'strategy_type', 'event_status', 'review_status',
  'currency_code', 'offer_price', 'cash_choice_price', 'cash_component', 'swap_ratio',
  'subscription_price', 'rights_units_per_new_share', 'rights_ratio_numerator', 'rights_ratio_denominator',
  'announced_at', 'expected_completion_date',
  'rights_trade_start', 'rights_trade_end', 'payment_deadline', 'listing_date',
  'offeror', 'offeror_holding_pct', 'registrar', 'transaction_method',
  'headcount_required', 'shortable', 'description',
  'target_instrument_id', 'reference_instrument_id', 'rights_instrument_id',
];

// 更新案件条款：字段白名单与 SET 拼装在本层，证券解析结果由调用方传入
async function updateArbitrageCase(params, client = pool) {
  const updates = params.updates || {};
  const sets = [];
  const args = [];
  let pi = 1;
  for (const [key, val] of Object.entries(updates)) {
    if (!CASE_EDITABLE_COLUMNS.includes(key)) continue;
    sets.push(`${key} = $${pi}`);
    args.push(val);
    pi += 1;
  }
  if (params.referenceInstrumentId !== undefined) { sets.push(`reference_instrument_id = $${pi}`); args.push(params.referenceInstrumentId); pi += 1; }
  if (params.rightsInstrumentId !== undefined) { sets.push(`rights_instrument_id = $${pi}`); args.push(params.rightsInstrumentId); pi += 1; }
  if (updates.review_status === 'approved' || updates.review_status === 'rejected') {
    sets.push(`reviewed_by = $${pi}`);
    args.push(params.reviewer);
    pi += 1;
    sets.push('reviewed_at = now()');
  }
  sets.push('updated_at = now()');
  return client.query(
    `UPDATE event.arbitrage_cases SET ${sets.join(', ')} WHERE case_id = $${pi} RETURNING *`,
    [...args, params.caseId],
  );
}

module.exports = {
  updateArbitrageCase,
  buildCaseFilter,
  countArbitrageCases,
  countUnreadArbitrages,
  listArbitrageCases,
  markArbitrageSeenCase,
  selectArbitrageDetail,
  getCandidates,
  getCaseDetail,
  with_event_arbitrage_case_documents,
  select_event_arbitrage_cases,
  select_event_arbitrage_case_documents,
  select_event_arbitrage_cases_1,
};
