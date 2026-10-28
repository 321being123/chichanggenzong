// ========== 套利公告正文解析桥接 ==========
// 调用 Python 解析器（PyMuPDF）提取 PDF 公告中的条款，并回写到 arbitrage_cases。
// 与 arbitrageService / arbitrageAnnouncementSync 无循环依赖（仅依赖 db + child_process）。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const { hashString } = require('../db/util');
const { sanitizeJobError } = require('./jobErrorSanitizer');
const { resolvePython, runPythonExtraction } = require('./arbitrageDocumentSource');
const txControl = require('../repositories/transactionControl');
const { acquireDocumentParseLock, resolveInstrumentByCode, resolveParseFailure } = require('../repositories/arbitrageParserRepository.js');
const repository = require('../repositories/arbitrageParserRepository.js');
const {
  PARSER_VERSION,
  classifyDocumentRole,
  documentRolePriority,
  sanitizeOfferor,
  validateParsedTerms,
} = require('./arbitrageRules');

// 公告正文通常是简体中文，港股证券基础资料可能保留繁体中文。名称回查时先做
// 常见证券名称字形归一，避免同一只参考证券在两套数据源中被识别成不同名称。
const SECURITY_NAME_CHAR_MAP = {
  '滬': '沪', '證': '证', '銀': '银', '國': '国', '際': '际', '華': '华',
  '東': '东', '興': '兴', '達': '达', '發': '发', '財': '财', '業': '业',
  '經': '经', '濟': '济', '與': '与', '廣': '广', '萬': '万', '會': '会',
  '龍': '龙', '賣': '卖', '買': '买', '聯': '联', '絡': '络', '號': '号',
  '開': '开', '關': '关', '點': '点', '場': '场', '現': '现', '價': '价',
  '實': '实', '訊': '讯', '網': '网', '臺': '台', '灣': '湾',
};

function normalizeSecurityName(value) {
  return [...String(value || '').replace(/<[^>]+>/g, '')]
    .map((char) => SECURITY_NAME_CHAR_MAP[char] || char)
    .join('')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'extractArbitrageDocument.py');
const MAX_PARSE_ATTEMPTS = 3;
const PARSE_RETRY_MINUTES = [5, 15];
const EXTERNAL_PARSE_CODES = new Set([
  'BUDGET_WAIT', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN',
  'POLICY_NOT_CONFIGURED', 'POLICY_DISABLED', 'PERMISSION_DENIED',
]);

function isPermanentParseError(message) {
  return /PDF exceeds size limit/i.test(String(message || ''));
}

function externalParseRetryAt(error) {
  const code = String(error && error.code || '').toUpperCase();
  if (!EXTERNAL_PARSE_CODES.has(code)) return null;
  const recoverAt = error && error.recoverAt && new Date(error.recoverAt);
  if (recoverAt && !Number.isNaN(recoverAt.getTime())) return recoverAt;
  const waitMinutes = ['POLICY_NOT_CONFIGURED', 'POLICY_DISABLED', 'PERMISSION_DENIED'].includes(code) ? 24 * 60 : 30;
  return new Date(Date.now() + waitMinutes * 60 * 1000);
}

function getParseRetryDecision(existing, force = false, now = new Date()) {
  if (!existing || existing.parser_version !== PARSER_VERSION) return { shouldParse: true };
  if (!force && existing.parsed_payload) return { shouldParse: false, payload: existing.parsed_payload, reason: 'cached' };
  if (existing.parse_status !== 'failed') return { shouldParse: true };
  const attempts = Number(existing.parse_attempts || 0);
  if (attempts >= MAX_PARSE_ATTEMPTS) return { shouldParse: false, reason: 'exhausted' };
  const nextAttemptAt = existing.next_parse_attempt_at && new Date(existing.next_parse_attempt_at);
  if (nextAttemptAt && !Number.isNaN(nextAttemptAt.getTime()) && nextAttemptAt.getTime() > new Date(now).getTime()) {
    return { shouldParse: false, reason: 'not_due' };
  }
  return { shouldParse: true };
}

/* acquireDocumentParseLock 已迁入 server/repositories/arbitrageParserRepository.js */

// Python 定位与解析桥接已迁入 server/services/arbitrageDocumentSource.js（外部取数适配）。

// 将解析器输出映射为 arbitrage_cases 的标量列
function mapParserFields(parsed) {
  if (!parsed || typeof parsed !== 'object') return {};
  const f = {};
  if (parsed.cash_offer_price != null) {
    f.offer_price = parsed.cash_offer_price;
    f.cash_choice_price = parsed.cash_choice_price != null ? parsed.cash_choice_price : parsed.cash_offer_price;
  }
  if (parsed.subscription_price != null) f.subscription_price = parsed.subscription_price;
  if (parsed.swap_ratio != null) f.swap_ratio = parsed.swap_ratio;
  if (parsed.target_swap_price != null) f.target_swap_price = parsed.target_swap_price;
  if (parsed.reference_swap_price != null) f.reference_swap_price = parsed.reference_swap_price;
  if (parsed.cash_component != null) f.cash_component = parsed.cash_component;
  if (parsed.consideration_note) f.description = String(parsed.consideration_note).slice(0, 1000);
  // 供股比例（旧股:新股），如实写入；不等于「每新股所需供股权份数」
  if (parsed.rights_ratio_numerator != null) f.rights_ratio_numerator = parsed.rights_ratio_numerator;
  if (parsed.rights_ratio_denominator != null) f.rights_ratio_denominator = parsed.rights_ratio_denominator;
  // 每新股所需供股权份数：只能从供股权交易条款单独确认，无法确认时保持为空（不得用比例分子代替，否则公式错误）
  if (parsed.rights_units_per_new_share != null) f.rights_units_per_new_share = parsed.rights_units_per_new_share;
  if (parsed.offeror) f.offeror = sanitizeOfferor(parsed.offeror);
  if (parsed.clear_offeror) f.offeror = null;
  if (parsed.offeror_holding_pct != null) f.offeror_holding_pct = parsed.offeror_holding_pct;
  if (parsed.clear_offeror_holding_pct) f.offeror_holding_pct = null;
  // 供股权交易期与付款截止（仅当解析器提取到时写入）
  if (parsed.rights_trade_start) f.rights_trade_start = parsed.rights_trade_start;
  if (parsed.rights_trade_end) f.rights_trade_end = parsed.rights_trade_end;
  if (parsed.payment_deadline) f.payment_deadline = parsed.payment_deadline;
  return f;
}

// 条款列白名单由数据层持有（与动态 SET 拼装同源），服务层只做取值映射
const { TERMS_COLUMNS } = repository;

const SWAP_BUNDLE_FIELDS = ['target_swap_price', 'reference_swap_price', 'swap_ratio'];

function parserCandidate(doc) {
  const payload = doc?.parsed_payload || {};
  return payload.validated || payload.raw || payload;
}

// 最新修订公告有时只补充换股比例，不重复完整换股价；重建时应优先使用
// 最近一份包含完整换股条款的公告，避免把已有换股价覆盖为空。
function selectSwapBundle(docs) {
  const candidates = docs.map((doc) => parserCandidate(doc));
  return candidates.find((candidate) => SWAP_BUNDLE_FIELDS.every((field) => candidate[field] != null))
    || candidates.find((candidate) => SWAP_BUNDLE_FIELDS.some((field) => candidate[field] != null))
    || null;
}

// 按代码解析/创建证券（5 位→港股，6 位→A股）
/* resolveInstrumentByCode 已迁入 server/repositories/arbitrageParserRepository.js */

// 按公司简称解析证券（公告里收购方仅以名称出现、代码不在正文时回查；名称可能带 <em> 标签，先做清洗）
async function resolveInstrumentByName(raw) {
  const clean = String(raw || '').replace(/<[^>]+>/g, '').trim();
  if (!clean) return null;
  const { rows } = await repository.select_core_instruments([clean]);
  if (!rows.length) {
    // 基础资料和公告可能分别使用繁体/简体名称；仅在普通模糊查询无结果时
    // 才做一次归一化兜底，避免给每次正常名称回查增加额外查询成本。
    const normalized = normalizeSecurityName(clean);
    if (!normalized) return null;
    const { rows: candidates } = await repository.select_core_instruments_1();
    const matched = candidates
      .filter((candidate) => {
        const candidateName = normalizeSecurityName(candidate.nm);
        return candidateName.includes(normalized) || normalized.includes(candidateName);
      })
      .sort((left, right) => {
        const leftExact = normalizeSecurityName(left.nm) === normalized ? 0 : 1;
        const rightExact = normalizeSecurityName(right.nm) === normalized ? 0 : 1;
        return leftExact - rightExact || right.nm.length - left.nm.length;
      });
    if (!matched.length) return null;
    const fallback = matched.find((r) => /^\d{6}$/.test(r.canonical_code));
    return (fallback || matched[0]).instrument_id;
  }
  // 多家命中时优先 A 股 6 位代码
  const a = rows.find((r) => /^\d{6}$/.test(r.canonical_code));
  return (a || rows[0]).instrument_id;
}

// 回写提取到的条款 + 参考/供股证券关系（仅更新非空字段）
async function applyExtractedTerms(caseId, parsed) {
  const fields = mapParserFields(parsed);
  // 只收集「本次确实提取到」的列，SET 拼装与列名白名单都在数据层完成
  const collected = {};
  for (const col of TERMS_COLUMNS) {
    if (fields[col] !== undefined && (fields[col] !== null || (col === 'offeror_holding_pct' && parsed.clear_offeror_holding_pct))) {
      collected[col] = fields[col];
    }
  }

  // 参考证券（换股吸收合并的收购方）：优先用公告中出现的代码，代码缺失时按公司简称回查
  const refName = (parsed && parsed.reference_names && parsed.reference_names[0]) || null;
  const refCode = (parsed && parsed.reference_codes && parsed.reference_codes[0]) || null;
  let refId = null;
  // 换股公告的代码上下文在多标的合并中容易指向另一家被合并方；结构识别出的合并方名称优先级更高。
  if (refName) refId = await resolveInstrumentByName(String(refName));
  if (!refId && refCode) refId = await resolveInstrumentByCode(String(refCode));
  // 供股权证券（供股的临时交易代码）
  const rightsCode = (parsed && parsed.rights_codes && parsed.rights_codes[0]) || null;
  let rightsId = null;
  if (rightsCode) rightsId = await resolveInstrumentByCode(String(rightsCode));

  if (!Object.keys(collected).length && !refId && !rightsId) return false;
  await repository.patchArbitrageCaseTerms(caseId, {
    terms: collected,
    referenceInstrumentId: refId || null,
    rightsInstrumentId: rightsId || null,
  });
  return true;
}

const MERGE_FIELDS = [
  'cash_offer_price', 'cash_choice_price', 'target_swap_price', 'reference_swap_price',
  'subscription_price', 'swap_ratio', 'cash_component', 'consideration_note',
  'rights_ratio_numerator', 'rights_ratio_denominator', 'rights_units_per_new_share',
  'offeror', 'offeror_holding_pct', 'rights_trade_start', 'rights_trade_end', 'payment_deadline',
  'clear_offeror',
];

async function parseAndStoreDocument(caseId, documentId, url, targetCode, role, force = false, resetRetries = false) {
  const releaseLock = await acquireDocumentParseLock(caseId, documentId);
  if (!releaseLock) return null;
  try {
    const { rows: caseRows } = await repository.select_event_arbitrage_cases([caseId]);
    if (!caseRows.length) throw new Error('arbitrage case not found: ' + caseId);
    const strategyType = caseRows[0].strategy_type;
    const documentRole = role || classifyDocumentRole('');
    if (resetRetries) {
      await repository.update_event_arbitrage_case_documents([caseId, documentId]);
    }
    const { rows: existing } = await repository.select_event_arbitrage_case_documents([caseId, documentId]);
    const retryDecision = getParseRetryDecision(existing[0], force);
    if (!retryDecision.shouldParse) return retryDecision.payload || null;
    let payload;
    try {
      const raw = await runPythonExtraction(url, targetCode);
      const checked = validateParsedTerms(strategyType, raw);
      payload = {
        raw,
        validated: checked.parsed,
        errors: checked.errors,
        coreComplete: checked.coreComplete,
        confidence: checked.confidence,
      };
      await repository.update_event_arbitrage_case_documents_1([documentRole, JSON.stringify(payload), PARSER_VERSION, checked.parseStatus, caseId, documentId]);
    } catch (err) {
      const previous = existing[0];
      const previousAttempts = previous && previous.parser_version === PARSER_VERSION
        ? Number(previous.parse_attempts || 0) : 0;
      const externalRetryAt = externalParseRetryAt(err);
      const attempt = externalRetryAt ? previousAttempts : isPermanentParseError(err.message)
        ? MAX_PARSE_ATTEMPTS
        : previousAttempts + 1;
      const retryMinutes = externalRetryAt
        ? 30
        : PARSE_RETRY_MINUTES[Math.min(attempt - 1, PARSE_RETRY_MINUTES.length - 1)];
      await repository.with_event_arbitrage_case_documents([documentRole, PARSER_VERSION, attempt, MAX_PARSE_ATTEMPTS, externalRetryAt,
        String(retryMinutes), sanitizeJobError(err.message || err, 1000), caseId, documentId]);
      await recordParseFailure(caseId, err.message);
      throw err;
    }
    try {
      await resolveParseFailure(caseId);
    } catch (err) {
      console.error('[arbitrage] resolveParseFailure error:', sanitizeJobError(err.message || err, 500));
    }
    return payload;
  } finally {
    await releaseLock();
  }
}

async function rebuildCaseTerms(caseId) {
  const { rows: caseRows } = await repository.select_event_arbitrage_cases_1([caseId]);
  if (!caseRows.length) return { status: 'missing' };
  const strategyType = caseRows[0].strategy_type;
  const { rows: docs } = await repository.select_event_arbitrage_case_documents_1([caseId]);
  const hasFailedDocument = docs.some(doc => doc.parse_status === 'failed');
  const usableDocs = docs.filter(doc => doc.parsed_payload != null && doc.parse_status !== 'failed');
  // 后续正式文件天然覆盖早期版本；同日多附件再按“修订 > 正式条款 > 摘要”取证。
  usableDocs.sort((a, b) => (new Date(b.announced_at || 0).getTime() - new Date(a.announced_at || 0).getTime())
    || documentRolePriority(b.document_role) - documentRolePriority(a.document_role));

  const merged = { evidence: [], reference_codes: [], reference_names: [], rights_codes: [] };
  const swapCandidate = selectSwapBundle(usableDocs);
  const swapBundleChosen = Boolean(swapCandidate);
  if (swapCandidate) {
    for (const field of SWAP_BUNDLE_FIELDS) {
      if (swapCandidate[field] != null) merged[field] = swapCandidate[field];
    }
    merged.reference_codes = Array.isArray(swapCandidate.reference_codes) ? swapCandidate.reference_codes : [];
    merged.reference_names = Array.isArray(swapCandidate.reference_names) ? swapCandidate.reference_names : [];
  }
  for (const doc of usableDocs) {
    const candidate = parserCandidate(doc);
    for (const field of MERGE_FIELDS) {
      if (SWAP_BUNDLE_FIELDS.includes(field)) continue;
      if (merged[field] == null && candidate[field] != null) merged[field] = candidate[field];
    }
    for (const field of ['reference_codes', 'reference_names', 'rights_codes', 'target_codes']) {
      if (swapBundleChosen && (field === 'reference_codes' || field === 'reference_names')) continue;
      if ((!merged[field] || !merged[field].length) && Array.isArray(candidate[field]) && candidate[field].length) {
        merged[field] = candidate[field];
      }
    }
    if (Array.isArray(candidate.evidence)) merged.evidence.push(...candidate.evidence);
  }
  const checked = validateParsedTerms(strategyType, merged);
  if (merged.clear_offeror) checked.parsed.offeror = null;
  if (hasFailedDocument) {
    await repository.update_event_arbitrage_cases([PARSER_VERSION, checked.confidence, caseId]);
    return { status: 'incomplete', confidence: checked.confidence, errors: [...checked.errors, '仍有公告解析失败'] };
  }
  if (!checked.coreComplete || checked.errors.length) {
    await repository.update_event_arbitrage_cases_1([checked.parseStatus, PARSER_VERSION, checked.confidence, caseId]);
    return { status: checked.parseStatus, confidence: checked.confidence, errors: checked.errors };
  }

  const fields = mapParserFields(checked.parsed);
  const values = Object.fromEntries(TERMS_COLUMNS.map((column) => [column, fields[column] ?? null]));
  let refId = null;
  const refName = checked.parsed.reference_names?.[0];
  const refCode = checked.parsed.reference_codes?.[0];
  if (refName) refId = await resolveInstrumentByName(refName);
  if (!refId && refCode) refId = await resolveInstrumentByCode(refCode);
  let rightsId = null;
  if (checked.parsed.rights_codes?.[0]) rightsId = await resolveInstrumentByCode(checked.parsed.rights_codes[0]);

  // 整行重写：列名白名单与占位符拼装都在数据层完成
  await repository.rewriteArbitrageCaseTerms({
    values,
    referenceInstrumentId: refId,
    rightsInstrumentId: rightsId,
    parseStatus: checked.parseStatus,
    parserVersion: PARSER_VERSION,
    confidence: checked.confidence,
    caseId,
  });
  return { status: 'validated', confidence: checked.confidence, extracted: values };
}

// 解析失败写入数据质量表（不再静默吞掉），便于后续排查
async function recordParseFailure(caseId, message) {
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const { rows } = await repository.select_event_arbitrage_cases_2([caseId], client);
    const instrumentId = rows.length ? rows[0].target_instrument_id : null;
    const details = JSON.stringify({ case_id: caseId, error: sanitizeJobError(message, 500) });
    await repository.select_data([
      hashString('arbitrage_parse_quality'),
      instrumentId == null ? hashString(`case:${caseId}`) : Number(instrumentId) | 0,
    ], client);
    if (instrumentId == null) {
      const updated = await repository.update_ops_data_quality_issues([caseId, details], client);
      if (!updated.rowCount) {
        await repository.insert_ops_data_quality_issues([details], client);
      }
    } else {
      await repository.insert_ops_data_quality_issues_1([instrumentId, details], client);
    }
    await txControl.commit(client);
  } catch (e) {
    await txControl.rollback(client).catch(() => {});
    console.error('[arbitrage] recordParseFailure error:', sanitizeJobError(e.message, 500));
  } finally {
    client.release();
  }
}

/* resolveParseFailure 已迁入 server/repositories/arbitrageParserRepository.js */

module.exports = {
  runPythonExtraction,
  mapParserFields,
  selectSwapBundle,
  applyExtractedTerms,
  parseAndStoreDocument,
  rebuildCaseTerms,
  recordParseFailure,
  resolveParseFailure,
  getParseRetryDecision,
  acquireDocumentParseLock,
  PARSER_VERSION,
  resolvePython,
  resolveInstrumentByCode,
  resolveInstrumentByName,
  SCRIPT,
};
