// ========== 套利公告正文解析桥接 ==========
// 调用 Python 解析器（PyMuPDF）提取 PDF 公告中的条款，并回写到 arbitrage_cases。
// 与 arbitrageService / arbitrageAnnouncementSync 无循环依赖（仅依赖 db + child_process）。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');

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
function runPythonExtraction(url) {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//i.test(url)) return reject(new Error('only http(s) urls are supported'));
    const py = resolvePython();
    const child = spawn(py, [SCRIPT, url], {
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
  if (parsed.cash_component != null) f.cash_component = parsed.cash_component;
  // 供股比例（旧股:新股），如实写入；不等于「每新股所需供股权份数」
  if (parsed.rights_ratio_numerator != null) f.rights_ratio_numerator = parsed.rights_ratio_numerator;
  if (parsed.rights_ratio_denominator != null) f.rights_ratio_denominator = parsed.rights_ratio_denominator;
  // 每新股所需供股权份数：只能从供股权交易条款单独确认，无法确认时保持为空（不得用比例分子代替，否则公式错误）
  if (parsed.rights_units_per_new_share != null) f.rights_units_per_new_share = parsed.rights_units_per_new_share;
  if (parsed.offeror) f.offeror = String(parsed.offeror).slice(0, 200);
  if (parsed.offeror_holding_pct != null) f.offeror_holding_pct = parsed.offeror_holding_pct;
  return f;
}

const TERMS_COLUMNS = [
  'offer_price', 'cash_choice_price', 'subscription_price', 'swap_ratio', 'cash_component',
  'rights_ratio_numerator', 'rights_ratio_denominator', 'rights_units_per_new_share', 'offeror', 'offeror_holding_pct',
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
  const { rows } = await pool.query('SELECT instrument_id FROM core.instruments WHERE canonical_code=$1', [canonical]);
  if (rows.length) return rows[0].instrument_id;
  const { rows: ins } = await pool.query(
    `INSERT INTO core.instruments(canonical_code, name, asset_class, market, exchange_code, currency_code, status)
     VALUES($1,'','stock',$2,$3,$4,'listed') ON CONFLICT(canonical_code) DO UPDATE SET status=EXCLUDED.status RETURNING instrument_id`,
    [canonical, market, exchange, currency]
  );
  return ins[0].instrument_id;
}

// 回写提取到的条款 + 参考/供股证券关系（仅更新非空字段）
async function applyExtractedTerms(caseId, parsed) {
  const fields = mapParserFields(parsed);
  const sets = [];
  const params = [];
  let pi = 1;
  for (const col of TERMS_COLUMNS) {
    if (fields[col] !== undefined && fields[col] !== null) {
      sets.push(`${col} = $${pi}`);
      params.push(fields[col]);
      pi++;
    }
  }

  // 参考证券（换股吸收合并的被吸并方/换股标的）
  const refCode = (parsed && parsed.reference_codes && parsed.reference_codes[0]) || null;
  if (refCode) {
    const id = await resolveInstrumentByCode(String(refCode));
    if (id) { sets.push(`reference_instrument_id = $${pi}`); params.push(id); pi++; }
  }
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

module.exports = { runPythonExtraction, mapParserFields, applyExtractedTerms, recordParseFailure, resolvePython, resolveInstrumentByCode, SCRIPT };
