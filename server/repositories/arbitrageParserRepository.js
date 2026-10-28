const { pool } = require('../db/connection');

const txControl = require('./transactionControl');
const { hashString } = require('../db/util');

// 自 server/services/arbitrageParser.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function acquireDocumentParseLock(caseId, documentId) {
  const client = await pool.connect();
  const namespace = hashString('arbitrage_pdf_parse');
  const documentKey = hashString(`${caseId}:${documentId}`);
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1,$2) AS ok', [namespace, documentKey]);
    if (!rows[0] || !rows[0].ok) {
      client.release();
      return null;
    }
    return async () => {
      await client.query('SELECT pg_advisory_unlock($1,$2)', [namespace, documentKey]).catch(() => {});
      client.release();
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

async function resolveInstrumentByCode(raw) {
  const code = String(raw || '').replace(/\D/g, '');
  if (!code) return null;
  let canonical, market, exchange, currency;
  if (code.length === 5) {
    canonical = code.padStart(5, '0') + '.HK';
    market = 'HK'; exchange = 'SEHK'; currency = 'HKD';
  } else if (code.length === 6) {
    canonical = code;
    market = 'CN';
    exchange = (code.startsWith('6') || code.startsWith('9')) ? 'SSE' : 'SZSE';
    currency = 'CNY';
  } else {
    return null;
  }
  // 仅返回有名称的有效证券；空名记录（早期错误链接产生的垃圾）一律排除，避免链到脏数据
  const marketSuffix = exchange === 'SSE' ? 'SH' : (exchange === 'SZSE' ? 'SZ' : null);
  const canonicalCandidates = canonical === code
    ? [canonical, marketSuffix ? `${code}.${marketSuffix}` : canonical]
    : [canonical];
  const { rows } = await pool.query(`
    SELECT instrument_id
      FROM core.instruments
     WHERE canonical_code=ANY($1::text[]) AND coalesce(name,'') <> ''
     ORDER BY CASE WHEN canonical_code=$2 THEN 0 ELSE 1 END
     LIMIT 1
  `, [canonicalCandidates, canonical]);
  if (rows.length) return rows[0].instrument_id;
  // 不再自动建空名证券：公告里抓到的代码可能是噪声（如文档编号），未知代码返回 null，由调用方走名称回查
  return null;
}

async function resolveParseFailure(caseId) {
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const { rows } = await client.query('SELECT target_instrument_id FROM event.arbitrage_cases WHERE case_id=$1', [caseId]);
    if (!rows.length) {
      await txControl.rollback(client);
      return;
    }
    const instrumentId = rows[0].target_instrument_id;
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [
      hashString('arbitrage_parse_quality'),
      instrumentId == null ? hashString(`case:${caseId}`) : Number(instrumentId) | 0,
    ]);
    const { rows: failedRows } = await client.query(`
      SELECT 1
        FROM event.arbitrage_case_documents acd
        JOIN event.arbitrage_cases c ON c.case_id=acd.case_id
       WHERE acd.parse_status='failed'
         AND acd.document_role <> 'superseded'
         AND (($2::bigint IS NOT NULL AND c.target_instrument_id=$2) OR ($2::bigint IS NULL AND c.case_id=$1))
       LIMIT 1
    `, [caseId, instrumentId]);
    if (!failedRows.length) {
      await client.query(`
        DELETE FROM ops.data_quality_issues q
         WHERE q.dataset_code='arbitrage' AND q.field_code='pdf_parse'
           AND q.issue_type='parse_failed' AND q.status='resolved'
           AND (($2::bigint IS NOT NULL AND q.instrument_id=$2)
             OR ($2::bigint IS NULL AND q.instrument_id IS NULL AND q.details->>'case_id'=$1::text))
      `, [caseId, instrumentId]);
      await client.query(`
        UPDATE ops.data_quality_issues q
           SET status='resolved',resolved_at=now()
         WHERE q.dataset_code='arbitrage' AND q.field_code='pdf_parse'
           AND q.issue_type='parse_failed' AND q.status='open'
           AND (($2::bigint IS NOT NULL AND q.instrument_id=$2)
             OR ($2::bigint IS NULL AND q.instrument_id IS NULL AND q.details->>'case_id'=$1::text))
      `, [caseId, instrumentId]);
    }
    await txControl.commit(client);
  } catch (error) {
    await txControl.rollback(client).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function select_core_instruments(params, client = pool) {
  return client.query(`SELECT instrument_id, canonical_code, regexp_replace(name,'<[^>]+>','','g') AS nm
     FROM core.instruments
     WHERE length(regexp_replace(name,'<[^>]+>','','g')) >= 2
       AND (regexp_replace(name,'<[^>]+>','','g') ILIKE '%'||$1||'%'
            OR $1 ILIKE '%'||regexp_replace(name,'<[^>]+>','','g')||'%')
     ORDER BY (CASE WHEN regexp_replace(name,'<[^>]+>','','g') = $1 THEN 0 ELSE 1 END), length(regexp_replace(name,'<[^>]+>','','g')) DESC`, params);
}

async function select_core_instruments_1(params, client = pool) {
  return client.query(`
      SELECT instrument_id, canonical_code, regexp_replace(name,'<[^>]+>','','g') AS nm
      FROM core.instruments
      WHERE length(regexp_replace(name,'<[^>]+>','','g')) >= 2
    `);
}

async function select_event_arbitrage_cases(params, client = pool) {
  return client.query(`SELECT strategy_type FROM event.arbitrage_cases WHERE case_id=$1`, params);
}

async function update_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`
        UPDATE event.arbitrage_case_documents
           SET parse_attempts=0,next_parse_attempt_at=NULL,last_parse_error=NULL
         WHERE case_id=$1 AND document_id=$2
      `, params);
}

async function select_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`SELECT parsed_payload,parser_version,parse_status,parse_attempts,next_parse_attempt_at FROM event.arbitrage_case_documents WHERE case_id=$1 AND document_id=$2`, params);
}

async function update_event_arbitrage_case_documents_1(params, client = pool) {
  return client.query(`
        UPDATE event.arbitrage_case_documents
        SET document_role=$1,parsed_payload=$2,parser_version=$3,parse_status=$4,parsed_at=now(),
            parse_attempts=0,next_parse_attempt_at=NULL,last_parse_error=NULL
        WHERE case_id=$5 AND document_id=$6
      `, params);
}

async function with_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`
        WITH failed_document AS (
          UPDATE event.arbitrage_case_documents
             SET document_role=$1,parser_version=$2,parse_status='failed',parsed_at=now(),
                 parse_attempts=$3::integer,
                 next_parse_attempt_at=CASE WHEN $3::integer < $4::integer
                    THEN COALESCE($5::timestamptz, now()+($6 || ' minutes')::interval) ELSE NULL END,
                 last_parse_error=$7
           WHERE case_id=$8 AND document_id=$9
           RETURNING case_id
        )
        UPDATE event.arbitrage_cases
           SET parse_status='incomplete',parser_version=$2,updated_at=now()
         WHERE case_id=$8 AND parse_status NOT IN ('conflict','incomplete')
           AND EXISTS (SELECT 1 FROM failed_document)
      `, params);
}

async function select_event_arbitrage_cases_1(params, client = pool) {
  return client.query(`SELECT strategy_type,review_status FROM event.arbitrage_cases WHERE case_id=$1`, params);
}

async function select_event_arbitrage_case_documents_1(params, client = pool) {
  return client.query(`
    SELECT acd.document_role,acd.parsed_payload,acd.parse_status,d.announced_at
    FROM event.arbitrage_case_documents acd
    JOIN event.documents d ON d.document_id=acd.document_id
    WHERE acd.case_id=$1 AND (
      (acd.parsed_payload IS NOT NULL AND acd.parse_status IN ('validated','incomplete'))
      OR (acd.parse_status='failed' AND acd.document_role IN ('amendment','terms','summary','proposal'))
    )
  `, params);
}

async function update_event_arbitrage_cases(params, client = pool) {
  return client.query(`UPDATE event.arbitrage_cases SET parse_status='incomplete',parser_version=$1,terms_confidence=$2,updated_at=now() WHERE case_id=$3`, params);
}

async function update_event_arbitrage_cases_1(params, client = pool) {
  return client.query(`UPDATE event.arbitrage_cases SET parse_status=$1,parser_version=$2,terms_confidence=$3,updated_at=now() WHERE case_id=$4`, params);
}

async function select_event_arbitrage_cases_2(params, client = pool) {
  return client.query(`SELECT target_instrument_id FROM event.arbitrage_cases WHERE case_id=$1`, params);
}

async function select_data(params, client = pool) {
  return client.query(`SELECT pg_advisory_xact_lock($1,$2)`, params);
}

async function update_ops_data_quality_issues(params, client = pool) {
  return client.query(`
        UPDATE ops.data_quality_issues SET details=$2::jsonb,detected_at=now()
         WHERE issue_id=(
           SELECT issue_id FROM ops.data_quality_issues
            WHERE instrument_id IS NULL AND dataset_code='arbitrage' AND field_code='pdf_parse'
              AND issue_type='parse_failed' AND status='open' AND details->>'case_id'=$1::text
            ORDER BY issue_id DESC LIMIT 1
         )
      `, params);
}

async function insert_ops_data_quality_issues(params, client = pool) {
  return client.query(`
          INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,details)
          VALUES(NULL,'arbitrage','pdf_parse','parse_failed','warning',$1::jsonb)
        `, params);
}

async function insert_ops_data_quality_issues_1(params, client = pool) {
  return client.query(`
        INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,details)
        VALUES($1,'arbitrage','pdf_parse','parse_failed','warning',$2::jsonb)
        ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
        DO UPDATE SET details=EXCLUDED.details,detected_at=now(),resolved_at=NULL
      `, params);
}

// 条款字段白名单：只有这些列允许出现在动态 SET 中（不接受外部输入的列名）。
const TERMS_COLUMNS = [
  'offer_price', 'cash_choice_price', 'subscription_price', 'swap_ratio', 'target_swap_price', 'reference_swap_price', 'cash_component',
  'rights_ratio_numerator', 'rights_ratio_denominator', 'rights_units_per_new_share', 'offeror', 'offeror_holding_pct',
  'rights_trade_start', 'rights_trade_end', 'payment_deadline',
  'description',
];

// 局部更新条款：只写 patch 里明确给出的列（列名按白名单校验），附参考/供股证券关系。
async function patchArbitrageCaseTerms(caseId, patch, client = pool) {
  const terms = patch.terms || {};
  const sets = [];
  const params = [];
  for (const column of TERMS_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(terms, column)) continue;
    params.push(terms[column]);
    sets.push(`${column} = $${params.length}`);
  }
  if (patch.referenceInstrumentId != null) {
    params.push(patch.referenceInstrumentId);
    sets.push(`reference_instrument_id = $${params.length}`);
  }
  if (patch.rightsInstrumentId != null) {
    params.push(patch.rightsInstrumentId);
    sets.push(`rights_instrument_id = $${params.length}`);
  }
  if (!sets.length) return 0;
  sets.push('terms_updated_at = now()', 'updated_at = now()');
  params.push(caseId);
  const result = await client.query(
    `UPDATE event.arbitrage_cases SET ${sets.join(', ')} WHERE case_id = $${params.length}`,
    params,
  );
  return result.rowCount || 0;
}

// 整行重写条款（人工重新解析后覆盖）：白名单内的列全部写一遍，再写解析状态与置信度。
async function rewriteArbitrageCaseTerms(patch, client = pool) {
  const values = patch.values || {};
  const sets = [];
  const params = [];
  for (const column of TERMS_COLUMNS) {
    params.push(values[column] ?? null);
    sets.push(`${column}=$${params.length}`);
  }
  params.push(patch.referenceInstrumentId ?? null);
  const refIdx = params.length;
  params.push(patch.rightsInstrumentId ?? null);
  const rightsIdx = params.length;
  params.push(patch.parseStatus);
  const statusIdx = params.length;
  params.push(patch.parserVersion);
  const versionIdx = params.length;
  params.push(patch.confidence ?? null);
  const confidenceIdx = params.length;
  params.push(patch.caseId);
  const caseIdx = params.length;
  return client.query(`
    UPDATE event.arbitrage_cases SET ${sets.join(',')},
      reference_instrument_id=$${refIdx},rights_instrument_id=$${rightsIdx},
      parse_status=$${statusIdx},parser_version=$${versionIdx},terms_confidence=$${confidenceIdx},
      review_status='approved',terms_updated_at=now(),updated_at=now()
    WHERE case_id=$${caseIdx}
  `, params);
}

module.exports = {
  TERMS_COLUMNS,
  patchArbitrageCaseTerms,
  rewriteArbitrageCaseTerms,
  acquireDocumentParseLock,
  resolveInstrumentByCode,
  resolveParseFailure,
  select_core_instruments,
  select_core_instruments_1,
  select_event_arbitrage_cases,
  update_event_arbitrage_case_documents,
  select_event_arbitrage_case_documents,
  update_event_arbitrage_case_documents_1,
  with_event_arbitrage_case_documents,
  select_event_arbitrage_cases_1,
  select_event_arbitrage_case_documents_1,
  update_event_arbitrage_cases,
  update_event_arbitrage_cases_1,
  select_event_arbitrage_cases_2,
  select_data,
  update_ops_data_quality_issues,
  insert_ops_data_quality_issues,
  insert_ops_data_quality_issues_1,
};
