// ========== 套利公告正文解析桥接 ==========
// 调用 Python 解析器（PyMuPDF）提取 PDF 公告中的条款，并回写到 arbitrage_cases。
// 与 arbitrageService / arbitrageAnnouncementSync 无循环依赖（仅依赖 db + child_process）。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const {
  PARSER_VERSION,
  classifyDocumentRole,
  documentRolePriority,
  sanitizeOfferor,
  validateParsedTerms,
} = require('./arbitrageRules');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'extractArbitrageDocument.py');

// 复用项目已有的 Python 定位逻辑（与 marketVolatilitySync / convertibleBondAnalysis 一致）：
// 优先 PYTHON 环境变量，其次项目 venv/Scripts/python.exe（Windows）/venv/bin/python（类 Unix），最后退回 PATH。
function resolvePython() {
  const root = path.resolve(__dirname, '..', '..');
  const localPython = path.join(root, 'venv', 'Scripts', 'python.exe');
  if (process.env.PYTHON) return process.env.PYTHON;
  if (process.platform === 'win32') {
    if (fs.existsSync(localPython)) return localPython;
    return 'python.exe'; // 退回 PATH 上的 python.exe
  }
  const venvUnix = path.join(root, 'venv', 'bin', 'python');
  if (fs.existsSync(venvUnix)) return venvUnix;
  return 'python3';
}

// 调用 Python 解析器提取单条公告 URL 的条款
// targetCode: 目标证券代码（如 A 股换股吸收合并中的被吸收合并方），帮助解析器选择正确的换股价格
function runPythonExtraction(url, targetCode) {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//i.test(url)) return reject(new Error('only http(s) urls are supported'));
    const py = resolvePython();
    const args = [SCRIPT, url];
    if (targetCode) args.push('--target-code', String(targetCode));
    const child = spawn(py, args, {
      cwd: path.resolve(__dirname, '..', '..'),
      env: Object.assign({}, process.env, { PYTHONUTF8: '1' }),
      windowsHide: true,
      timeout: 120000,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!out.trim()) return reject(new Error('parser empty output (code ' + code + '): ' + err.slice(0, 300)));
      try {
        const json = JSON.parse(out);
        if (json.error) return reject(new Error(json.error));
        resolve(json);
      } catch (e) {
        reject(new Error('parser output not JSON: ' + out.slice(0, 300)));
      }
    });
  });
}

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

const TERMS_COLUMNS = [
  'offer_price', 'cash_choice_price', 'subscription_price', 'swap_ratio', 'target_swap_price', 'reference_swap_price', 'cash_component',
  'rights_ratio_numerator', 'rights_ratio_denominator', 'rights_units_per_new_share', 'offeror', 'offeror_holding_pct',
  'rights_trade_start', 'rights_trade_end', 'payment_deadline',
  'description',
];

// 按代码解析/创建证券（5 位→港股，6 位→A股）
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
  const { rows } = await pool.query('SELECT instrument_id FROM core.instruments WHERE canonical_code=$1 AND coalesce(name,\'\') <> \'\'', [canonical]);
  if (rows.length) return rows[0].instrument_id;
  // 不再自动建空名证券：公告里抓到的代码可能是噪声（如文档编号），未知代码返回 null，由调用方走名称回查
  return null;
}

// 按公司简称解析证券（公告里收购方仅以名称出现、代码不在正文时回查；名称可能带 <em> 标签，先做清洗）
async function resolveInstrumentByName(raw) {
  const clean = String(raw || '').replace(/<[^>]+>/g, '').trim();
  if (!clean) return null;
  const { rows } = await pool.query(
    `SELECT instrument_id, canonical_code, regexp_replace(name,'<[^>]+>','','g') AS nm
     FROM core.instruments
     WHERE length(regexp_replace(name,'<[^>]+>','','g')) >= 2
       AND (regexp_replace(name,'<[^>]+>','','g') ILIKE '%'||$1||'%'
            OR $1 ILIKE '%'||regexp_replace(name,'<[^>]+>','','g')||'%')
     ORDER BY (CASE WHEN regexp_replace(name,'<[^>]+>','','g') = $1 THEN 0 ELSE 1 END), length(regexp_replace(name,'<[^>]+>','','g')) DESC`,
    [clean]
  );
  if (!rows.length) return null;
  // 多家命中时优先 A 股 6 位代码
  const a = rows.find((r) => /^\d{6}$/.test(r.canonical_code));
  return (a || rows[0]).instrument_id;
}

// 回写提取到的条款 + 参考/供股证券关系（仅更新非空字段）
async function applyExtractedTerms(caseId, parsed) {
  const fields = mapParserFields(parsed);
  const sets = [];
  const params = [];
  let pi = 1;
  for (const col of TERMS_COLUMNS) {
    if (fields[col] !== undefined && (fields[col] !== null || (col === 'offeror_holding_pct' && parsed.clear_offeror_holding_pct))) {
      sets.push(`${col} = $${pi}`);
      params.push(fields[col]);
      pi++;
    }
  }

  // 参考证券（换股吸收合并的收购方）：优先用公告中出现的代码，代码缺失时按公司简称回查
  const refName = (parsed && parsed.reference_names && parsed.reference_names[0]) || null;
  const refCode = (parsed && parsed.reference_codes && parsed.reference_codes[0]) || null;
  let refId = null;
  // 换股公告的代码上下文在多标的合并中容易指向另一家被合并方；结构识别出的合并方名称优先级更高。
  if (refName) refId = await resolveInstrumentByName(String(refName));
  if (!refId && refCode) refId = await resolveInstrumentByCode(String(refCode));
  if (refId) { sets.push(`reference_instrument_id = $${pi}`); params.push(refId); pi++; }
  // 供股权证券（供股的临时交易代码）
  const rightsCode = (parsed && parsed.rights_codes && parsed.rights_codes[0]) || null;
  if (rightsCode) {
    const id = await resolveInstrumentByCode(String(rightsCode));
    if (id) { sets.push(`rights_instrument_id = $${pi}`); params.push(id); pi++; }
  }

  if (!sets.length) return false;
  sets.push('terms_updated_at = now()');
  sets.push('updated_at = now()');
  await pool.query(
    `UPDATE event.arbitrage_cases SET ${sets.join(', ')} WHERE case_id = $${pi}`,
    [...params, caseId]
  );
  return true;
}

const MERGE_FIELDS = [
  'cash_offer_price', 'cash_choice_price', 'target_swap_price', 'reference_swap_price',
  'subscription_price', 'swap_ratio', 'cash_component', 'consideration_note',
  'rights_ratio_numerator', 'rights_ratio_denominator', 'rights_units_per_new_share',
  'offeror', 'offeror_holding_pct', 'rights_trade_start', 'rights_trade_end', 'payment_deadline',
  'clear_offeror',
];

async function parseAndStoreDocument(caseId, documentId, url, targetCode, role, force = false) {
  const { rows: caseRows } = await pool.query('SELECT strategy_type FROM event.arbitrage_cases WHERE case_id=$1', [caseId]);
  if (!caseRows.length) throw new Error('arbitrage case not found: ' + caseId);
  const strategyType = caseRows[0].strategy_type;
  const documentRole = role || classifyDocumentRole('');
  const { rows: existing } = await pool.query(
    'SELECT parsed_payload,parser_version,parse_status FROM event.arbitrage_case_documents WHERE case_id=$1 AND document_id=$2',
    [caseId, documentId]
  );
  if (!force && existing.length && existing[0].parser_version === PARSER_VERSION && existing[0].parsed_payload) {
    return existing[0].parsed_payload;
  }
  try {
    const raw = await runPythonExtraction(url, targetCode);
    const checked = validateParsedTerms(strategyType, raw);
    const payload = {
      raw,
      validated: checked.parsed,
      errors: checked.errors,
      coreComplete: checked.coreComplete,
      confidence: checked.confidence,
    };
    await pool.query(`
      UPDATE event.arbitrage_case_documents
      SET document_role=$1,parsed_payload=$2,parser_version=$3,parse_status=$4,parsed_at=now()
      WHERE case_id=$5 AND document_id=$6
    `, [documentRole, JSON.stringify(payload), PARSER_VERSION, checked.parseStatus, caseId, documentId]);
    return payload;
  } catch (err) {
    await pool.query(`
      UPDATE event.arbitrage_case_documents
      SET document_role=$1,parser_version=$2,parse_status='failed',parsed_at=now()
      WHERE case_id=$3 AND document_id=$4
    `, [documentRole, PARSER_VERSION, caseId, documentId]);
    await recordParseFailure(caseId, err.message);
    throw err;
  }
}

async function rebuildCaseTerms(caseId) {
  const { rows: caseRows } = await pool.query('SELECT strategy_type,review_status FROM event.arbitrage_cases WHERE case_id=$1', [caseId]);
  if (!caseRows.length) return { status: 'missing' };
  const strategyType = caseRows[0].strategy_type;
  const { rows: docs } = await pool.query(`
    SELECT acd.document_role,acd.parsed_payload,d.announced_at
    FROM event.arbitrage_case_documents acd
    JOIN event.documents d ON d.document_id=acd.document_id
    WHERE acd.case_id=$1 AND acd.parsed_payload IS NOT NULL AND acd.parse_status IN ('validated','incomplete')
  `, [caseId]);
  // 后续正式文件天然覆盖早期版本；同日多附件再按“修订 > 正式条款 > 摘要”取证。
  docs.sort((a, b) => (new Date(b.announced_at || 0).getTime() - new Date(a.announced_at || 0).getTime())
    || documentRolePriority(b.document_role) - documentRolePriority(a.document_role));

  const merged = { evidence: [], reference_codes: [], reference_names: [], rights_codes: [] };
  const swapFields = ['target_swap_price', 'reference_swap_price', 'swap_ratio'];
  let swapBundleChosen = false;
  for (const doc of docs) {
    const payload = doc.parsed_payload || {};
    const candidate = payload.validated || payload.raw || payload;
    if (!swapBundleChosen && swapFields.some((field) => candidate[field] != null)) {
      for (const field of swapFields) {
        if (candidate[field] != null) merged[field] = candidate[field];
      }
      merged.reference_codes = Array.isArray(candidate.reference_codes) ? candidate.reference_codes : [];
      merged.reference_names = Array.isArray(candidate.reference_names) ? candidate.reference_names : [];
      swapBundleChosen = true;
    }
    for (const field of MERGE_FIELDS) {
      if (swapFields.includes(field)) continue;
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
  if (!checked.coreComplete || checked.errors.length) {
    await pool.query(`UPDATE event.arbitrage_cases SET parse_status=$1,parser_version=$2,terms_confidence=$3,updated_at=now() WHERE case_id=$4`,
      [checked.parseStatus, PARSER_VERSION, checked.confidence, caseId]);
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

  const sets = [];
  const params = [];
  for (const column of TERMS_COLUMNS) {
    params.push(values[column]);
    sets.push(`${column}=$${params.length}`);
  }
  params.push(refId, rightsId, checked.parseStatus, PARSER_VERSION, checked.confidence, caseId);
  await pool.query(`
    UPDATE event.arbitrage_cases SET ${sets.join(',')},
      reference_instrument_id=$${params.length - 5},rights_instrument_id=$${params.length - 4},
      parse_status=$${params.length - 3},parser_version=$${params.length - 2},terms_confidence=$${params.length - 1},
      review_status='approved',terms_updated_at=now(),updated_at=now()
    WHERE case_id=$${params.length}
  `, params);
  return { status: 'validated', confidence: checked.confidence, extracted: values };
}

// 解析失败写入数据质量表（不再静默吞掉），便于后续排查
async function recordParseFailure(caseId, message) {
  try {
    const { rows } = await pool.query('SELECT target_instrument_id FROM event.arbitrage_cases WHERE case_id=$1', [caseId]);
    const instrumentId = rows.length ? rows[0].target_instrument_id : null;
    await pool.query(`
      INSERT INTO ops.data_quality_issues(instrument_id, dataset_code, field_code, issue_type, severity, details)
      VALUES($1, 'arbitrage', 'pdf_parse', 'parse_failed', 'warning', $2)
      ON CONFLICT(instrument_id, dataset_code, field_code, issue_type, status)
      DO UPDATE SET details=EXCLUDED.details, detected_at=now()
    `, [instrumentId, JSON.stringify({ case_id: caseId, error: String(message || '').slice(0, 500) })]);
  } catch (e) {
    console.error('[arbitrage] recordParseFailure error:', e.message);
  }
}

module.exports = {
  runPythonExtraction,
  mapParserFields,
  applyExtractedTerms,
  parseAndStoreDocument,
  rebuildCaseTerms,
  recordParseFailure,
  resolvePython,
  resolveInstrumentByCode,
  resolveInstrumentByName,
  SCRIPT,
};
