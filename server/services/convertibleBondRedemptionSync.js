const crypto = require('crypto');
const { pool } = require('../db/connection');
const { searchAnnouncements } = require('./cninfoAnnouncement');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { childProcessEnv, mergeExternalCallStatsFromStderr } = require('./externalCallGuard');

const SOURCE_CODE = 'convertible_bond_redemption_announcements';
const DATASET_CODE = 'convertible_bond_redemption_announcements';

function isoDate(value) {
  if (!value) return null;
  const text = String(value).replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-').replace(/\./g, '-');
  const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : null;
}

function dateFromTitle(title, patterns) {
  for (const pattern of patterns) {
    const match = String(title || '').match(pattern);
    const date = match && isoDate(match[1]);
    if (date) return date;
  }
  return null;
}

function classifyCallEvent(title) {
  const text = String(title || '');
  // 仅接受明确涉及可转债/赎回/转股的公告，避免把“股份回购实施结果”等普通股票公告误判为强赎完成。
  if (!/(赎回|转债|强赎|转股)/.test(text)) return null;
  if (/不提前赎回|不行使.*赎回|不实施.*赎回|暂不赎回/.test(text)) return 'waive';
  if (/实施结果|赎回结果|完成赎回|赎回完成/.test(text)) return 'completion';
  if (/赎回实施|实施.*赎回|停止交易|最后交易日|最后转股日|赎回公告/.test(text)) return 'implementation';
  if (/可能触发|触发条件|强赎提示/.test(text)) return 'warning';
  if (/强赎|提前赎回|触发.*赎回|可能触发/.test(text)) return 'exercise';
  return null;
}

function eventDates(title, eventType) {
  const lastConversionDate = dateFromTitle(title, [
    /最后转股日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
    /转股截止日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
  ]);
  const lastTradeDate = dateFromTitle(title, [
    /最后交易日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
  ]);
  const redemptionRecordDate = dateFromTitle(title, [
    /登记日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
    /赎回登记日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
  ]);
  const noCallUntil = dateFromTitle(title, [
    /不提前赎回[^0-9]{0,30}(?:至|到|截止|止)\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
    /不提前赎回[^0-9]{0,30}([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)[^0-9]{0,10}(?:起|止)/,
  ]);
  return { lastConversionDate, lastTradeDate, redemptionRecordDate, noCallUntil,
    parseStatus: eventType && (lastConversionDate || lastTradeDate || redemptionRecordDate || noCallUntil) ? 'complete' : 'partial' };
}

function pickInstrument(item, candidates) {
  if (!candidates.length) return null;
  const title = String(item.title || '').replace(/[“”‘’「」《》\s]/g, '');
  const nameMatches = candidates.filter(row => {
    const bondName = String(row.bond_name || '').replace(/[“”‘’「」《》\s]/g, '');
    const securityCode = String(row.security_code || '');
    return bondName && title.includes(bondName) || securityCode && title.includes(securityCode);
  });
  if (nameMatches.length === 1) return nameMatches[0].instrument_id;
  // 同一正股可能同时发行多只转债；无法从公告标题唯一匹配时必须进入待确认，
  // 不能默认取第一只，否则会把公告事实写到另一只转债上。
  if (candidates.length === 1) return candidates[0].instrument_id;
  return null;
}

async function parseOfficialDocuments(items, maxUrls = 50) {
  const uniqueUrls = [...new Set((items || []).map(item => item.fileLink).filter(Boolean))];
  const limit = Number.isFinite(Number(maxUrls)) && Number(maxUrls) > 0 ? Number(maxUrls) : uniqueUrls.length;
  const urls = uniqueUrls.slice(0, limit);
  if (!urls.length) return new Map();
  const root = path.join(__dirname, '..', '..');
  const script = path.join(root, 'server', 'scripts', 'extractConvertibleBondCallEvent.py');
  const candidates = [process.env.CALL_EVENT_PYTHON, path.join(root, 'venv', 'Scripts', 'python.exe'), 'python3'].filter(Boolean);
  const python = candidates.find(candidate => candidate === 'python3' || fs.existsSync(candidate)) || 'python3';
  const parsed = new Map();
  for (let index = 0; index < urls.length; index += 10) {
    const batch = urls.slice(index, index + 10);
    try {
      const output = await new Promise((resolve, reject) => {
        execFile(python, [script, ...batch], { cwd: root, env: childProcessEnv({ PYTHONUTF8: '1' }), timeout: 2 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
          mergeExternalCallStatsFromStderr(stderr);
          if (error) { error.detail = String(stderr || error.message); reject(error); return; }
          resolve(String(stdout || '[]'));
        });
      });
      for (const row of JSON.parse(output)) if (row && row.source_url) parsed.set(row.source_url, row);
    } catch (error) {
      console.warn(`[bond-redemption] 官方 PDF 解析失败，保留标题事件：${String(error.detail || error.message).slice(0, 200)}`);
    }
  }
  return parsed;
}

function eventParseComplete(eventType, dates) {
  const value = dates || {};
  if (eventType === 'exercise' || eventType === 'implementation') {
    return Boolean(value.lastTradeDate && value.lastConversionDate);
  }
  if (eventType === 'waive') return Boolean(value.noCallUntil);
  if (eventType === 'completion') return Boolean(value.redemptionRecordDate || value.redemptionPrice != null);
  return false;
}

async function syncConvertibleBondCallAnnouncements({ fromDate, toDate, exchanges = ['sse', 'szse'], stock = '', keywords = null } = {}) {
  const end = isoDate(toDate) || new Date().toISOString().slice(0, 10);
  const start = isoDate(fromDate) || new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  const sourceRows = await pool.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1', [SOURCE_CODE]);
  if (!sourceRows.rows[0]) throw new Error('强赎公告数据源尚未完成数据库迁移');
  const sourceId = sourceRows.rows[0].source_id;
  const { rows: instruments } = await pool.query(
    `SELECT p.instrument_id,split_part(s.canonical_code,'.',1) AS stock_code,
            split_part(i.canonical_code,'.',1) AS security_code,i.name AS bond_name
       FROM fundamental.convertible_bond_profiles p
       JOIN core.instruments i ON i.instrument_id=p.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
       JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      WHERE i.status='listed' AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))`
  );
  const byStockCode = new Map();
  for (const row of instruments) {
    const key = String(row.stock_code).slice(0, 6);
    if (!byStockCode.has(key)) byStockCode.set(key, []);
    byStockCode.get(key).push(row);
  }
  // 巨潮 stock 参数需要“证券代码,orgId”，只传 6 位代码会返回空结果；批量补历史时改为全局检索后按证券代码过滤。
  const stockCodes = String(stock || '').split(',').map(value => value.trim()).filter(value => /^\d{6}$/.test(value));
  const announcementsRaw = await searchAnnouncements({ fromDate: start, toDate: end,
    stock: stockCodes.length ? '' : stock,
    keywords: keywords && keywords.length ? keywords : [
      '强赎', '提前赎回', '不提前赎回', '暂不赎回', '不行使赎回', '不实施赎回',
      '赎回实施', '实施赎回', '赎回结果', '到期兑付', '即将到期', '停止交易', '最后交易日',
    ], exchanges });
  const announcements = stockCodes.length
    ? announcementsRaw.filter(item => stockCodes.includes(String(item.stockCode || '').slice(0, 6)))
    : announcementsRaw;
  const classified = announcements.filter(item => classifyCallEvent(item.title));
  // 正常同步也必须处理全部公告；分批由 parseOfficialDocuments 内部完成，不能以“前50份”
  // 作为成功条件，否则近期公告排序变化会让部分已公告转债永久缺日期。
  const parsedDocuments = await parseOfficialDocuments(classified, classified.length);
  const client = await pool.connect();
  let runId = null;
  let matched = 0;
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`,
      [sourceId, DATASET_CODE, JSON.stringify({ fromDate: start, toDate: end, exchanges })]
    );
    runId = run.rows[0].run_id;
    let matchedCount = 0;
    for (const item of classified) {
      const eventType = classifyCallEvent(item.title);
      const dates = eventDates(item.title, eventType);
      const documentDates = parsedDocuments.get(item.fileLink) || {};
      for (const field of ['no_call_until', 'last_trade_date', 'last_conversion_date', 'redemption_record_date']) {
        if (documentDates[field]) dates[field === 'no_call_until' ? 'noCallUntil' : field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = documentDates[field];
      }
      // “不提前赎回”公告通常没有明确截止日；解析器若返回公告日，不能把它当成已过期的截止日。
      const announcedDate = isoDate(item.announcedAt) || start;
      if (eventType === 'waive' && dates.noCallUntil && dates.noCallUntil <= announcedDate) dates.noCallUntil = null;
      if (documentDates.redemption_price != null) dates.redemptionPrice = documentDates.redemption_price;
      dates.parseStatus = eventParseComplete(eventType, dates) ? 'complete' : 'partial';
      const sourceKey = String(item.sourceKey || item.fileLink || `${item.announcedAt}:${item.stockCode}:${item.title}`);
      const raw = JSON.stringify(item.rawPayload || item);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      await client.query(
        `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
         VALUES($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,
        [runId, sourceId, DATASET_CODE, sourceKey, raw, hash]
      );
      const instrumentId = pickInstrument(item, byStockCode.get(String(item.stockCode || '').slice(0, 6)) || []);
      if (!instrumentId) continue;
      await client.query(
        `INSERT INTO event.convertible_bond_call_events
           (instrument_id,event_type,announced_at,no_call_until,last_trade_date,last_conversion_date,redemption_record_date,redemption_price,
            source_id,source_key,source_url,title,parse_status,parser_version,details,raw_payload)
         VALUES($1,$2,$3::date,$4::date,$5::date,$6::date,$7::date,$8,$9,$10,$11,$12,$13,'call-event-v2',$14::jsonb,$15::jsonb)
         ON CONFLICT(source_id,source_key) DO UPDATE SET
           event_type=EXCLUDED.event_type,announced_at=EXCLUDED.announced_at,
           no_call_until=EXCLUDED.no_call_until,
           last_trade_date=EXCLUDED.last_trade_date,last_conversion_date=EXCLUDED.last_conversion_date,
           redemption_record_date=EXCLUDED.redemption_record_date,redemption_price=EXCLUDED.redemption_price,source_url=EXCLUDED.source_url,
           title=EXCLUDED.title,parse_status=EXCLUDED.parse_status,details=EXCLUDED.details,
           raw_payload=EXCLUDED.raw_payload,updated_at=now()`,
        [instrumentId, eventType, isoDate(item.announcedAt) || start, dates.noCallUntil,
          dates.lastTradeDate, dates.lastConversionDate, dates.redemptionRecordDate, dates.redemptionPrice || null,
          sourceId, sourceKey, item.fileLink || '', item.title || '', dates.parseStatus,
          JSON.stringify({ exchange: item.exchange || null, parser: 'official-pdf' }), raw]
      );
      matchedCount++;
    }
    // 同一公告日通常同时有公司公告和券商核查意见；以同日公告中最长的“不提前赎回”期限为准，
    // 避免后写入的核查意见覆盖公司公告中的有效期（例如精测转2、金诚转债）。
    await client.query(`
      UPDATE event.convertible_bond_call_events e
         SET no_call_until=v.max_no_call_until,updated_at=now()
        FROM (
          SELECT instrument_id,announced_at,MAX(no_call_until) AS max_no_call_until
            FROM event.convertible_bond_call_events
           WHERE event_type='waive' AND no_call_until IS NOT NULL
           GROUP BY instrument_id,announced_at
        ) v
       WHERE e.instrument_id=v.instrument_id AND e.announced_at=v.announced_at
         AND e.event_type='waive' AND e.no_call_until IS DISTINCT FROM v.max_no_call_until;
    `);
    await client.query(`UPDATE ops.ingestion_runs SET status='succeeded',row_count=$2,finished_at=now() WHERE run_id=$1`, [runId, matchedCount]);
    await client.query('COMMIT');
    matched = matchedCount;
  } catch (error) {
    await client.query('ROLLBACK');
    if (runId) await pool.query(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 1000)]).catch(() => {});
    throw error;
  } finally { client.release(); }
  return { ok: true, fromDate: start, toDate: end, discovered: announcements.length, classified: classified.length, matched, runId };
}

module.exports = { classifyCallEvent, eventDates, eventParseComplete, pickInstrument, syncConvertibleBondCallAnnouncements };
