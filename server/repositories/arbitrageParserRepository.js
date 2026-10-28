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

module.exports = {
  acquireDocumentParseLock,
  resolveInstrumentByCode,
  resolveParseFailure,
};
