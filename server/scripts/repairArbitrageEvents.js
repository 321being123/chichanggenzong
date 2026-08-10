const { pool } = require('../db/connection');
const {
  cleanSecurityText,
  firstSecurityCode,
  firstSecurityName,
  classifyDocumentRole,
  buildEventKey,
  sanitizeOfferor,
  validateParsedTerms,
  PARSER_VERSION,
} = require('../services/arbitrageRules');
const parser = require('../services/arbitrageParser');

async function main() {
  const client = await pool.connect();
  const stats = { roles: 0, names: 0, reassigned: 0, closed: 0, eventKeys: 0, offerorsCleared: 0, revalidated: 0, parsed: 0, parseFailed: 0, rebuilt: 0 };
  let openCaseIds = [];
  try {
    await client.query('BEGIN');

    const { rows: docs } = await client.query(`
      SELECT acd.case_id,acd.document_id,d.title
      FROM event.arbitrage_case_documents acd
      JOIN event.documents d ON d.document_id=acd.document_id
    `);
    for (const doc of docs) {
      const role = classifyDocumentRole(doc.title);
      const result = await client.query(
        'UPDATE event.arbitrage_case_documents SET document_role=$1 WHERE case_id=$2 AND document_id=$3 AND document_role IS DISTINCT FROM $1',
        [role, doc.case_id, doc.document_id]
      );
      stats.roles += result.rowCount;
    }

    const { rows: parsedDocs } = await client.query(`
      SELECT acd.case_id,acd.document_id,acd.parsed_payload,acd.parser_version,c.strategy_type
      FROM event.arbitrage_case_documents acd
      JOIN event.arbitrage_cases c ON c.case_id=acd.case_id
      WHERE acd.parsed_payload IS NOT NULL
    `);
    for (const doc of parsedDocs) {
      // 旧版本原始结果必须重新跑提取器，不能只换版本号后冒充新版结果。
      if (doc.parser_version !== PARSER_VERSION) continue;
      const payload = doc.parsed_payload || {};
      const checked = validateParsedTerms(doc.strategy_type, payload.raw || payload);
      const nextPayload = {
        raw: payload.raw || payload,
        validated: checked.parsed,
        errors: checked.errors,
        coreComplete: checked.coreComplete,
        confidence: checked.confidence,
      };
      await client.query(`
        UPDATE event.arbitrage_case_documents
        SET parsed_payload=$1,parser_version=$2,parse_status=$3
        WHERE case_id=$4 AND document_id=$5
      `, [JSON.stringify(nextPayload), PARSER_VERSION, checked.parseStatus, doc.case_id, doc.document_id]);
      stats.revalidated++;
    }

    const { rows: dirtyNames } = await client.query("SELECT instrument_id,canonical_code,name FROM core.instruments WHERE name LIKE '%<%' OR canonical_code LIKE '%<%'");
    for (const instrument of dirtyNames) {
      if (instrument.canonical_code.includes('<')) {
        const code = firstSecurityCode(instrument.canonical_code, 'HK');
        const { rows: target } = await client.query('SELECT instrument_id FROM core.instruments WHERE canonical_code=$1', [`${code}.HK`]);
        if (target.length && String(target[0].instrument_id) !== String(instrument.instrument_id)) {
          for (const column of ['target_instrument_id', 'reference_instrument_id', 'rights_instrument_id']) {
            const moved = await client.query(`UPDATE event.arbitrage_cases SET ${column}=$1 WHERE ${column}=$2`, [target[0].instrument_id, instrument.instrument_id]);
            stats.reassigned += moved.rowCount;
          }
        }
      } else {
        const name = firstSecurityName(instrument.name);
        const changed = await client.query('UPDATE core.instruments SET name=$1 WHERE instrument_id=$2 AND name IS DISTINCT FROM $1', [name, instrument.instrument_id]);
        stats.names += changed.rowCount;
      }
    }

    const { rows: active } = await client.query(`
      SELECT a.case_id,
        (array_agg(old.event_status ORDER BY d.announced_at DESC,old.updated_at DESC))[1] AS terminal_status
      FROM event.arbitrage_cases a
      JOIN event.arbitrage_cases old ON old.target_instrument_id=a.target_instrument_id
        AND old.strategy_type=a.strategy_type AND old.event_status IN ('completed','terminated','expired')
      JOIN event.arbitrage_case_documents acd ON acd.case_id=old.case_id
      JOIN event.documents d ON d.document_id=acd.document_id AND d.announced_at>=a.announced_at
      WHERE a.event_status NOT IN ('completed','terminated','expired')
      GROUP BY a.case_id
    `);
    for (const row of active) {
      const changed = await client.query('UPDATE event.arbitrage_cases SET event_status=$1,updated_at=now() WHERE case_id=$2', [row.terminal_status, row.case_id]);
      stats.closed += changed.rowCount;
    }

    const { rows: cases } = await client.query(`
      SELECT c.case_id,c.market,c.strategy_type,c.announced_at,c.source_key,i.canonical_code,c.offeror
      FROM event.arbitrage_cases c
      LEFT JOIN core.instruments i ON i.instrument_id=c.target_instrument_id
      WHERE c.event_status NOT IN ('completed','terminated','expired')
    `);
    openCaseIds = cases.map((row) => row.case_id);
    for (const row of cases) {
      const key = buildEventKey({
        market: row.market,
        strategyType: row.strategy_type,
        canonicalCode: row.canonical_code,
        announcedAt: row.announced_at,
        sourceKey: row.source_key,
      });
      if (key) {
        const duplicate = await client.query('SELECT 1 FROM event.arbitrage_cases WHERE event_key=$1 AND case_id<>$2', [key, row.case_id]);
        if (!duplicate.rowCount) {
          const changed = await client.query('UPDATE event.arbitrage_cases SET event_key=$1 WHERE case_id=$2 AND event_key IS DISTINCT FROM $1', [key, row.case_id]);
          stats.eventKeys += changed.rowCount;
        }
      }
      if (row.offeror && !sanitizeOfferor(row.offeror)) {
        const changed = await client.query('UPDATE event.arbitrage_cases SET offeror=NULL WHERE case_id=$1', [row.case_id]);
        stats.offerorsCleared += changed.rowCount;
      }
    }

    await client.query('COMMIT');

    // 新版解析器自动补跑进行中事件的未解析/旧版本核心公告；失败会标记 failed，避免每天无限重试。
    const { rows: pendingDocs } = await pool.query(`
      SELECT acd.case_id,acd.document_id,acd.document_role,d.url,i.canonical_code
      FROM event.arbitrage_case_documents acd
      JOIN event.arbitrage_cases c ON c.case_id=acd.case_id
      JOIN event.documents d ON d.document_id=acd.document_id
      JOIN core.instruments i ON i.instrument_id=c.target_instrument_id
      WHERE c.event_status NOT IN ('completed','terminated','expired')
        AND acd.document_role IN ('amendment','terms','summary','proposal')
        AND (acd.parsed_payload IS NULL OR acd.parser_version IS DISTINCT FROM $1)
        AND d.url ~* '\\.pdf$'
      ORDER BY d.announced_at DESC,acd.document_id DESC
    `, [PARSER_VERSION]);
    for (const doc of pendingDocs) {
      try {
        await parser.parseAndStoreDocument(doc.case_id, doc.document_id, doc.url, doc.canonical_code, doc.document_role, true);
        stats.parsed++;
      } catch (_) {
        stats.parseFailed++;
      }
    }
    for (const caseId of openCaseIds) {
      await parser.rebuildCaseTerms(caseId);
      stats.rebuilt++;
    }
    console.log(JSON.stringify(stats, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
