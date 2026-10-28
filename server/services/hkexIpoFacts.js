// 港股 IPO 事实入库与完整度核算
// R-10 拆分自 ./hkexIpo.js（2026-10-21）：本文件只放港股 IPO 事实入库与完整度核算；对外入口仍是 ./hkexIpo.js。
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { ensureInstrumentIdentity } = require('./securityIdentity');
const { httpRequest, ALLOWED_DOMAINS, searchAnnouncements } = require('./hkexAnnouncement');
const { HKEX_ALLOTMENT_FACTS_PARSER_VERSION, HKEX_NEW_LISTING_TARGETS, HKEX_PREDEFINED_DOCUMENT_TARGETS, assertOfficialUrl, canonicalHkCode, parseNewListingsHtml, parsePredefinedDocumentHtml } = require('./hkexIpoCore.js');
const txControl = require('../repositories/transactionControl');
const repository = require('../repositories/hkexIpoFactsRepository.js');

async function persistHkexProbe(result, { environment = 'local', executor = pool.query.bind(pool) } = {}) {
  if (!['local', 'server'].includes(environment)) throw new Error(`未知探针环境：${environment}`);
  const source = await executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1");
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const targets = Array.isArray(result?.targets) ? result.targets : [];
  const invalidEvidence = targets.filter(target => target.ok && (!/^2\d\d$/.test(String(target.httpStatus || ''))
    || !/^[0-9a-f]{64}$/i.test(String(target.responseSha256 || ''))
    || !target.parserStatus || target.parserStatus === 'not_run' || target.parserStatus === 'http_ok_remote_parser_not_run'));
  const status = targets.length && !invalidEvidence.length && targets.every(target => target.ok)
    ? 'succeeded' : targets.some(target => target.ok) ? 'degraded' : 'failed';
  if (invalidEvidence.length) throw new Error(`探针证据不完整：${invalidEvidence.map(target => target.key).join('、')}`);
  const run = await executor(
    `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status,row_count,error_message,finished_at)
     VALUES($1,'hkex_ipo_probe',$2::jsonb,$3,$4,$5,now()) RETURNING run_id`,
    [source.rows[0].source_id, JSON.stringify({ environment, generatedAt: result?.generatedAt || null, targetCount: targets.length }), status,
      targets.reduce((sum, target) => sum + Number(target.rowCount || 0), 0), targets.filter(target => !target.ok).map(target => `${target.key}:${target.error || 'failed'}`).join('; ').slice(0, 2000)]
  );
  if (targets.length) {
    await executor(
      `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
       SELECT $1,$2,'hkex_ipo_probe',x.source_key,now(),x.payload,md5(x.payload::text)
         FROM jsonb_to_recordset($3::jsonb) AS x(source_key text,payload jsonb)
       ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,
      [run.rows[0].run_id, source.rows[0].source_id, JSON.stringify(targets.map(target => ({
        source_key: `${environment}|${target.key}|${target.responseSha256 || target.requestedAt || ''}`,
        payload: { environment, key: target.key, url: target.url, ok: target.ok, httpStatus: target.httpStatus || null,
          parserStatus: target.parserStatus, rowCount: target.rowCount || 0, responseBytes: target.responseBytes || 0,
          responseSha256: target.responseSha256 || null, dns: target.dns || null, cookieRequired: target.cookieRequired || null,
          wafSignals: target.wafSignals || [], error: target.error || null },
      })))]
    );
  }
  return { runId: run.rows[0].run_id, environment, status, targets: targets.length };
}

function buildProbePlan({ includeLocalizedNames = false } = {}) {
  return [
    ...HKEX_NEW_LISTING_TARGETS
      .filter(item => includeLocalizedNames || item.nameLanguage !== 'zh')
      .map(item => ({ ...item, source: 'www2.hkexnews.hk', probeType: 'new_listing_table' })),
    ...HKEX_PREDEFINED_DOCUMENT_TARGETS.map(item => ({ ...item, source: 'www1.hkexnews.hk', probeType: 'predefined_document' })),
    { key: 'title_search', source: 'www1.hkexnews.hk', probeType: 'title_search', url: 'https://www1.hkexnews.hk/search/titleSearchServlet.do' },
  ].map(item => ({ ...item, url: assertOfficialUrl(item.url) }));
}

async function runHkexIpoProbe({ fetchImpl = httpRequest, targets = buildProbePlan() } = {}) {
  const results = [];
  for (const target of targets) {
    const requestedAt = new Date().toISOString();
    try {
      const body = await fetchImpl(target.url);
      const text = String(body || '');
      const items = target.probeType === 'new_listing_table'
        ? parseNewListingsHtml(text, { board: target.board, sourceUrl: target.url, nameLanguage: target.nameLanguage })
        : target.probeType === 'predefined_document'
          ? parsePredefinedDocumentHtml(text, { documentType: target.documentType, sourceUrl: target.url })
          : [];
      results.push({
        ...target,
        ok: true,
        requestedAt,
        httpStatus: 200,
        dns: 'node:https（解析结果由运行环境提供）',
        cookieRequired: 'unknown',
        wafSignals: [],
        guardPolicy: 'hkex/anonymous（由 withExternalCallGuard 执行）',
        parserStatus: items.length ? 'parsed' : 'empty_unconfirmed',
        fallback: '保留旧分区；不得将空响应解释为无新股',
        responseBytes: Buffer.byteLength(text),
        responseSha256: crypto.createHash('sha256').update(text).digest('hex'),
        rowCount: items.length,
        items,
      });
    } catch (error) {
      const message = error.message || String(error);
      results.push({ ...target, ok: false, requestedAt, httpStatus: error.code && /^\d+$/.test(String(error.code)) ? Number(error.code) : null,
        dns: 'unknown', cookieRequired: 'unknown', wafSignals: /waf|captcha|forbidden|403|429/i.test(message) ? [message] : [],
        guardPolicy: 'hkex/anonymous（由 withExternalCallGuard 执行）', parserStatus: 'not_run', fallback: '保留旧分区；等待下一次探针', error: message, rowCount: 0, items: [] });
    }
  }
  return { generatedAt: new Date().toISOString(), targets: results };
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function dateIsOnOrBefore(value, asOfDate) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && String(value) <= asOfDate;
}

function stageForRow(row, asOfDate = todayShanghai()) {
  if (dateIsOnOrBefore(row.listingDate, asOfDate)) return 'listed';
  if (dateIsOnOrBefore(row.allotmentDate, asOfDate)) return 'allotted';
  if (dateIsOnOrBefore(row.pricingDate, asOfDate)) return 'priced';
  if (dateIsOnOrBefore(row.offerOpenDate, asOfDate)) return 'active';
  return 'active';
}

function completenessForRow(row) {
  const fields = ['offerOpenDate', 'offerCloseDate', 'pricingDate', 'allotmentDate', 'listingDate', 'issuePriceFinal', 'lotSizeShares'];
  const result = {};
  for (const field of fields) result[field] = row[field] == null || row[field] === '' ? 'missing' : 'value';
  const today = todayShanghai();
  const offerClose = String(row.offerCloseDate || '').slice(0, 10);
  const pendingNotDue = /^\d{4}-\d{2}-\d{2}$/.test(offerClose) && offerClose > today;
  const hasMissing = fields.some(field => result[field] === 'missing');
  result.status = pendingNotDue ? 'pending_not_due' : hasMissing ? 'retryable' : 'complete';
  result.checked_at = new Date().toISOString();
  result.next_retry_at = pendingNotDue ? `${offerClose}T00:00:00+08:00` : null;
  result.reason = pendingNotDue ? '认购截止日前，配发/上市事实尚未到期' : '字段缺失，等待官方事实补全';
  result.evidence_urls = (Array.isArray(row.sourceDocuments) ? row.sourceDocuments : [])
    .map(item => item && item.url).filter(Boolean).slice(0, 10);
  return result;
}

function recomputeCompletenessForStoredRow(row, asOfDate = todayShanghai(), { mode = 'enrichment' } = {}) {
  const current = row && row.data_completeness && typeof row.data_completeness === 'object'
    ? row.data_completeness : {};
  const prospectus = current.prospectus && typeof current.prospectus === 'object' ? current.prospectus : {};
  const expectedEvents = prospectus.expectedEvents && typeof prospectus.expectedEvents === 'object'
    ? prospectus.expectedEvents : {};
  const dateInShanghai = value => {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isFinite(parsed.getTime())
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(parsed) : null;
  };
  const storedDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').slice(0, 10))
    ? String(value).slice(0, 10) : null;
  const expectedDate = key => storedDate(expectedEvents[key] && expectedEvents[key].date);
  const closeDate = dateInShanghai(row.offer_close_at);
  const offerClosed = Boolean(closeDate && closeDate < asOfDate);
  // 盘前发布的是本阶段事实：预计今日上市并非实际上市已发生。
  // 盘后/补全及过去上市日仍要求真实上市证据，不以预计日期填造事实。
  const listingPendingPreopen = mode === 'preopen' && expectedDate('listingDate') === asOfDate;
  const due = key => {
    const expected = expectedDate(key);
    return offerClosed && (!expected || expected <= asOfDate)
      && !(key === 'listingDate' && listingPendingPreopen);
  };
  const hasActualListing = Boolean(row.listing_at || storedDate(row.listing_date));
  const maximumOnly = prospectus.fields && prospectus.fields.issuePriceLow === 'maximum_only';
  const fields = {
    offerOpenAt: row.offer_open_at,
    offerCloseAt: row.offer_close_at,
    pricingAt: row.pricing_at,
    allotmentAt: row.allotment_at,
    issuePriceFinal: row.issue_price_final,
    issuePriceLow: row.issue_price_low,
    issuePriceHigh: row.issue_price_high,
    lotSizeShares: row.lot_size_shares,
  };
  const result = { ...current };
  for (const field of ['offerOpenDate', 'offerCloseDate', 'pricingDate', 'allotmentDate', 'listingDate']) delete result[field];
  for (const [field, value] of Object.entries(fields)) {
    result[field] = value == null || value === '' ? 'missing' : 'value';
  }
  if (maximumOnly && row.issue_price_low == null) result.issuePriceLow = 'maximum_only';
  result.listingAt = hasActualListing ? 'value' : 'missing';
  result.expectedPricingDate = expectedDate('pricingDate') || 'missing';
  result.expectedAllotmentDate = expectedDate('allotmentDate') || 'missing';
  result.expectedListingDate = expectedDate('listingDate') || 'missing';
  if (!due('pricingDate')) {
    if (!row.pricing_at) result.pricingAt = 'pending';
    if (row.issue_price_final == null) result.issuePriceFinal = 'pending';
  }
  if (!due('allotmentDate') && !row.allotment_at) result.allotmentAt = 'pending';
  if (!due('listingDate') && !hasActualListing) result.listingAt = 'pending';
  // 旧配发检索曾把上市公司供股结果写入 IPO：只认官方供股结果，且不能覆盖真实招股窗口。
  const allotmentDocuments = (Array.isArray(row.source_documents) ? row.source_documents : [])
    .filter(document => document.type === 'allotment_result');
  const rightsIssueOnly = !row.offer_open_at && !row.offer_close_at && allotmentDocuments.length > 0
    && allotmentDocuments.every(document => {
      try { assertOfficialUrl(document.url); } catch (_) { return false; }
      return /\bright[s]?\s+issue\b|供股.*(?:結果|结果)/i.test(document.title || '');
    });
  if (rightsIssueOnly) {
    result.publicOfferEligibility = 'excluded';
    result.exclusionReason = 'rights_issue';
  }
  if (result.exclusionReason === 'postponed' && String(row.ipo_status || '').toLowerCase() !== 'postponed') {
    delete result.exclusionReason;
    delete result.publicOfferEligibility;
  }
  if (String(row.ipo_status || '').toLowerCase() === 'postponed') {
    result.publicOfferEligibility = 'excluded';
    result.exclusionReason = 'postponed';
  }
  if (!row.pricing_at && row.issue_price_final > 0 && (Array.isArray(row.source_documents) ? row.source_documents : []).some(document => {
    try { assertOfficialUrl(document.url); } catch (_) { return false; }
    return document.contentSha256 && (document.type === 'allotment_result'
      && document.parserEvidence?.factsParserVersion === HKEX_ALLOTMENT_FACTS_PARSER_VERSION
      || document.type==='pricing_result'&&document.parserEvidence?.parserVersion==='hk-ipo-pricing-v1'
        && document.parserEvidence.securityCode===row.security_code&&Number(document.parserEvidence.finalOfferPrice)===Number(row.issue_price_final))
      && document.parserEvidence?.actualPricingDateStatus === 'not_disclosed';
  })) {
    result.pricingAt = 'not_disclosed';
    result.pricingDateReason = '已核验官方配发公告未披露实际定价日期';
  }
  const terminalStatus = rightsIssueOnly || ['introduction', 'gem_transfer', 'de_spac', 'cancelled', 'canceled', 'postponed'].includes(String(row.ipo_status || '').toLowerCase());
  const requiredFields = ['offerOpenAt', 'offerCloseAt', 'issuePriceHigh', 'lotSizeShares'];
  if (!maximumOnly) requiredFields.push('issuePriceLow');
  if (due('pricingDate')) requiredFields.push('pricingAt', 'issuePriceFinal');
  if (due('allotmentDate')) requiredFields.push('allotmentAt');
  if (due('listingDate')) requiredFields.push('listingAt');
  const missingFields = requiredFields.filter(field => result[field] === 'missing');
  const futureDates = [closeDate, ...Object.values(expectedEvents).map(event => expectedDateByValue(event))]
    .filter(date => date && date > asOfDate).sort();
  const pendingNotDue = missingFields.length === 0
    && (futureDates.length > 0 || (listingPendingPreopen && !hasActualListing));
  result.target_date = asOfDate;
  result.evaluation_mode = mode;
  result.required_fields = requiredFields;
  result.missing_fields = terminalStatus ? [] : missingFields;
  result.status = terminalStatus ? 'complete'
    : missingFields.length ? 'retryable'
      : pendingNotDue ? 'pending_not_due' : 'complete';
  result.checked_at = new Date().toISOString();
  result.next_retry_at = terminalStatus || (!missingFields.length && !pendingNotDue) ? null
    : listingPendingPreopen && !hasActualListing && !missingFields.length ? `${asOfDate}T18:10:00+08:00`
      : futureDates.length && !missingFields.length ? `${futureDates[0]}T00:00:00+08:00`
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  result.reason = terminalStatus ? '终态项目不适用普通公众招股字段'
    : result.status === 'pending_not_due' ? (listingPendingPreopen ? '盘前阶段不要求当日实际上市，盘后核验实际证据' : '下一阶段官方时间尚未到期')
      : missingFields.length ? `官方事实待补：${missingFields.join(', ')}` : '关键官方事实已按最终事实行复核';
  result.evidence_urls = (Array.isArray(row.source_documents) ? row.source_documents : [])
    .map(item => item && item.url).filter(Boolean).slice(0, 10);
  return result;
}

function expectedDateByValue(event) {
  const value = event && event.date;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
}

async function readHkIpoCompleteness(executor = pool.query.bind(pool), asOfDate = todayShanghai(), options = {}) {
  const { rows } = await executor(`SELECT security_code,ipo_status,offer_open_at,offer_close_at,pricing_at,allotment_at,
    listing_at,listing_date,issue_price_low,issue_price_high,issue_price_final,lot_size_shares,source_documents,data_completeness
    FROM public.ipo_history WHERE market_code='HK'`);
  let complete = 0, pending = 0, missing = 0;
  for (const row of rows) {
    const status = recomputeCompletenessForStoredRow(row, asOfDate, options).status;
    if (status === 'complete') complete += 1;
    else if (status === 'pending_not_due') pending += 1;
    else missing += 1;
  }
  return { ok: true, rows: rows.length, complete, pending, missing, targetDate: asOfDate,
    evaluationMode: options.mode || 'enrichment', qualityStatus: missing || !rows.length ? 'stale' : 'passed' };
}

async function recomputeHkIpoCompleteness(executor = pool.query.bind(pool), targetCodes = [], asOfDate = todayShanghai(), options = {}) {
  const scopedCodes = [...new Set((Array.isArray(targetCodes) ? targetCodes : []).map(canonicalHkCode).filter(Boolean))];
  const targetFilter = scopedCodes.length ? ' AND security_code=ANY($1::text[])' : '';
  const { rows } = await executor(`
    SELECT security_code,ipo_status,offer_open_at,offer_close_at,pricing_at,allotment_at,listing_at,listing_date,
           issue_price_low,issue_price_high,issue_price_final,lot_size_shares,source_documents,data_completeness
      FROM public.ipo_history
     WHERE market_code='HK'
       ${targetFilter}
  `, scopedCodes.length ? [scopedCodes] : []);
  let updated = 0;
  let complete = 0;
  let pending = 0;
  let missing = 0;
  for (const row of rows) {
    const completeness = recomputeCompletenessForStoredRow(row, asOfDate, options);
    await executor(`
      UPDATE public.ipo_history
         SET data_completeness=$2::jsonb,
             updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
       WHERE market_code='HK' AND security_code=$1
    `, [row.security_code, JSON.stringify(completeness)]);
    updated += 1;
    if (completeness.status === 'complete') complete += 1;
    else if (completeness.status === 'pending_not_due') pending += 1;
    else missing += 1;
  }
  return { ok: true, status: missing ? 'degraded' : 'succeeded', rows: updated, complete, pending, missing,
    targetDate: asOfDate, evaluationMode: options.mode || 'enrichment', qualityStatus: missing || !updated ? 'stale' : 'passed' };
}

// 复用已成功入库的在市主档事实；预计上市安排不能进入本分支。
async function syncStoredHkListings({asOfDate=todayShanghai(),targetCodes=[],executor=pool.query.bind(pool),persist=upsertHkIpoFacts}={}) {
  const CoreDate=require('../../public/shared/core-date');
  if(CoreDate.normalizeBusinessDate(asOfDate)!==asOfDate) throw new Error('实际上市事实目标日无效');
  if(!Array.isArray(targetCodes)||targetCodes.some(code=>!canonicalHkCode(code))) throw new Error('实际上市事实目标代码无效');
  const codes=[...new Set(targetCodes.map(canonicalHkCode).filter(Boolean))];
  const {rows}=await executor(`SELECT h.security_code,h.security_name,h.security_name_cn,h.market_type,i.list_date::text,
      i.status,r.raw_record_id,r.payload,r.payload_hash,r.source_updated_at,r.request_range,r.ingestion_status
    FROM public.ipo_history h JOIN core.instruments i ON i.instrument_id=h.instrument_id
    JOIN LATERAL (SELECT rr.raw_record_id,rr.payload,rr.payload_hash,rr.source_updated_at,ir.request_range,ir.status AS ingestion_status
      FROM ops.raw_records rr JOIN ops.data_sources ds USING(source_id) JOIN ops.ingestion_runs ir ON ir.run_id=rr.run_id AND ir.source_id=rr.source_id
      WHERE ds.source_code='tushare' AND rr.dataset_code='hk_basic' AND rr.source_key=h.security_code
        AND rr.payload->>'ts_code'=h.security_code AND ir.dataset_code='hk_basic'
        AND ir.request_range->>'list_status'='L' AND ir.status='success'
      ORDER BY rr.ingested_at DESC,rr.raw_record_id DESC LIMIT 1) r ON true
    WHERE h.market_code='HK' AND h.listing_at IS NULL AND COALESCE(h.listing_date,'')=''
      AND i.market='HK' AND i.status='listed' AND i.list_date<=$1::date
      AND h.ipo_status NOT IN ('cancelled','canceled','postponed','introduction','gem_transfer','de_spac')
      AND (cardinality($2::text[])=0 OR h.security_code=ANY($2::text[]))`,[asOfDate,codes]);
  const verified=[],failures=[];
  for(const row of rows) {
    const raw=row.payload||{}, compact=String(raw.list_date||'');
    const date=/^\d{8}$/.test(compact)?CoreDate.normalizeBusinessDate(`${compact.slice(0,4)}-${compact.slice(4,6)}-${compact.slice(6,8)}`):null;
    const observed=CoreDate.dateInZone(row.source_updated_at,'Asia/Shanghai');
    if(!date||date>asOfDate||date!==row.list_date||raw.ts_code!==row.security_code||raw.curr_type!=='HKD'||codes.length&&!codes.includes(row.security_code)
      ||row.status!=='listed'||row.ingestion_status!=='success'||row.request_range?.list_status!=='L'||!observed||observed<date) {
      failures.push({code:row.security_code,reason:'listed_master_evidence_mismatch'});continue;
    }
    const evidence={source:'tushare',dataset:'hk_basic',rawRecordId:row.raw_record_id,payloadHash:row.payload_hash,
      observedAt:row.source_updated_at,listStatus:'L',listingDate:date};
    verified.push({securityCode:row.security_code,securityName:row.security_name,securityNameCn:row.security_name_cn,
      board:row.market_type,listingDate:date,listingEvidence:evidence,dataCompleteness:{},
      sourceDocuments:[{type:'listed_security_master',...evidence}]});
  }
  if(verified.length) await persist(verified,{sourceCode:'tushare'});
  return {ok:!failures.length,rows:verified.length,failures,source:'stored_hk_basic',externalCalls:0};
}

async function upsertHkIpoFacts(rows, { sourceCode = 'hkex_announcements', dbPool = pool } = {}) {
  const input = Array.isArray(rows) ? rows.filter(row => canonicalHkCode(row.securityCode)) : [];
  if (!input.length) return { ok: true, rows: 0, events: 0 };
  const client = await dbPool.connect();
  let events = 0;
  try {
    await txControl.begin(client);
    const sourceResult = await repository.select_ops_data_sources([sourceCode], client);
    if (!sourceResult.rows[0]) throw new Error(`未登记数据源：${sourceCode}`);
    const sourceId = sourceResult.rows[0].source_id;
    for (const row of input) {
      const canonicalCode = canonicalHkCode(row.securityCode);
      const status = stageForRow(row);
      const identity = await ensureInstrumentIdentity({
        canonicalCode,
        name: row.securityName || canonicalCode,
        assetClass: 'stock',
        market: 'HK',
        exchangeCode: 'HKEX',
        currencyCode: 'HKD',
        listDate: row.listingDate || null,
        status: stageForRow(row) === 'listed' ? 'listed' : 'pre_listing',
        rawData: { source: sourceCode, board: row.board || null },
        identifiers: [[sourceCode, 'security_code', canonicalCode]],
      }, client.query.bind(client));
      const sourceDocuments = Array.isArray(row.sourceDocuments) ? row.sourceDocuments : [];
      await repository.insert_public_ipo_history([canonicalCode, row.securityName || '', row.board || null, row.listingDate || null, row.offerOpenDate || null,
          identity.instrumentId, status, row.offerOpenDate || null, row.offerCloseDate || null, row.pricingDate || null,
          row.allotmentDate || null, row.listingDate || null, row.issuePriceLow || null, row.issuePriceHigh || null,
          row.issuePriceFinal || null, row.lotSizeShares || null, row.lotAmountHkd || null, row.applicationFeeHkd || null,
          row.brokerageFeeHkd || null, row.publicOfferRatio || null, row.internationalOfferRatio || null,
          JSON.stringify(row.cornerstoneDetails || {}), JSON.stringify(row.greenshoeDetails || {}), JSON.stringify(sourceDocuments),
          JSON.stringify(row.dataCompleteness || completenessForRow(row)),
          /[\u3400-\u9fff]/.test(String(row.securityNameCn || '')) ? String(row.securityNameCn).trim() : null], client);
      const eventRows = [
        ['offer_open', row.offerOpenDate], ['offer_close', row.offerCloseDate], ['pricing', row.pricingDate],
        ['allotment_result', row.allotmentDate], ['hk_listing', row.listingDate],
      ];
      for (const [eventType, eventDate] of eventRows) {
        if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate).slice(0, 10))) continue;
        await repository.insert_event_instrument_events([identity.instrumentId, eventType, String(eventDate).slice(0, 10), sourceId, `${canonicalCode}|${eventType}|${String(eventDate).slice(0, 10)}`,
            JSON.stringify({ market: 'HK', board: row.board || null, sourceUrl: row.sourceUrl || null,
              ...(eventType==='hk_listing'&&row.listingEvidence?{listingEvidence:row.listingEvidence}:{}) })], client);
        events += 1;
      }
    }
    await txControl.commit(client);
    return { ok: true, rows: input.length, events };
  } catch (error) {
    await txControl.rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  persistHkexProbe,
  buildProbePlan,
  runHkexIpoProbe,
  todayShanghai,
  dateIsOnOrBefore,
  stageForRow,
  completenessForRow,
  recomputeCompletenessForStoredRow,
  expectedDateByValue,
  readHkIpoCompleteness,
  recomputeHkIpoCompleteness,
  syncStoredHkListings,
  upsertHkIpoFacts,
};
