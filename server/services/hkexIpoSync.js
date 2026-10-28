const hkexSyncSql = require('../repositories/hkexIpoSyncRepository');
// 官方数据源同步入口
// R-10 拆分自 ./hkexIpo.js（2026-10-21）：本文件只放官方数据源同步入口；对外入口仍是 ./hkexIpo.js。
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { httpRequest, ALLOWED_DOMAINS, searchAnnouncements } = require('./hkexAnnouncement');
const { readCachedPdf, writeCachedPdf } = require('./documentPdfCache');
const { HKEX_ALLOTMENT_DATASET, HKEX_ALLOTMENT_FACTS_PARSER_VERSION, HKEX_ALLOTMENT_PARSER_VERSION, HKEX_LISTING_STATUS_DATASET, HKEX_NON_PUBLIC_DATASET, HKEX_NON_PUBLIC_LISTINGS, HKEX_PROSPECTUS_DATASET, HKEX_PROSPECTUS_NOT_APPLICABLE, allotmentTitleLooksLikeIpo, assertOfficialUrl, canonicalHkCode, fetchHkexNewListingReports, fetchOfficialPdfWithCache, isReparsableAllotmentDocument, isUsableProspectusDocument, mergeSourceDocuments, monthWindows, parseHkexAllotmentPdf, parseHkexProspectusPdf, prospectusSearchWindows, resolveHkexEnglishPdfUrl, shiftIsoDate, shouldPersistAllotmentFacts } = require('./hkexIpoCore.js');
const { todayShanghai, upsertHkIpoFacts } = require('./hkexIpoFacts.js');
const repository = require('../repositories/hkexIpoSyncRepository.js');

async function syncHkexPricingFacts({asOfDate,targetCodes=[],executor=pool.query.bind(pool),fetchImpl=httpRequest,searchImpl=searchAnnouncements}={}) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate||''))throw new Error('定价补全必须传入目标日');
  const codes=targetCodes.map(canonicalHkCode);
  if(codes.some(code=>!code))throw new Error('定价目标代码无效');
  const {rows}=await hkexSyncSql.syncHkexPricingFactsLayerQuery1(executor, [], [asOfDate,codes]);
  const failures=[];let enriched=0;
  for(const row of rows) {
    try {
      const known=(row.source_documents||[]).find(document=>document.type==='pricing_result'&&document.url);
      const announcements=known?[{title:known.title,fileLink:known.url,announcedAt:known.announcedAt}]:await searchImpl({fromDate:row.expected_pricing,toDate:asOfDate,stockCode:row.security_code.split('.')[0],categories:['-2'],_httpRequest:fetchImpl});
      const announcement=announcements.filter(item=>/發售價公告|发售价公告|發售價的釐定|offer price announcement/i.test(item.title||''))
        .sort((a,b)=>String(b.announcedAt).localeCompare(String(a.announcedAt)))[0];
      if(!announcement)throw new Error('到期定价候选未取得官方发售价公告');
      const {buffer,url}=await fetchOfficialPdfWithCache(announcement.fileLink,fetchImpl,{responseType:'buffer'});
      const parsed=await parseHkexAllotmentPdf(buffer,{pricingOnly:true,stockCode:row.security_code.split('.')[0]});
      if(parsed.securityCode!==row.security_code||parsed.currency!=='HKD'||!(parsed.finalOfferPrice>0))throw new Error('定价证券/币种/价格证据不匹配');
      if(parsed.actualPricingDate&&(parsed.actualPricingDate>asOfDate||parsed.actualPricingDate>String(announcement.announcedAt).slice(0,10)))throw new Error('实际定价日超出已发布目标窗口');
      const source=(await hkexSyncSql.syncHkexPricingFactsLayerQuery2(executor, [])).rows[0];
      if(!source)throw new Error('官方定价来源未登记');
      const hash=crypto.createHash('sha256').update(buffer).digest('hex');
      const document={type:'pricing_result',url,title:announcement.title,announcedAt:announcement.announcedAt,contentSha256:hash,parserEvidence:parsed};
      // 单条SQL将来源审计与目标事实同时写入，失败不会留下半条定价事实。
      await hkexSyncSql.syncHkexPricingFactsLayerQuery3(executor, [], [source.source_id,HKEX_ALLOTMENT_DATASET,`${row.security_code}|pricing|${url}`,JSON.stringify(document),hash,row.security_code,parsed.finalOfferPrice,parsed.actualPricingDate?`${parsed.actualPricingDate}T00:00:00+08:00`:null,JSON.stringify(mergeSourceDocuments(row.source_documents,document))]);
      enriched++;
    } catch(error){failures.push({code:row.security_code,error:error.message});}
  }
  return {ok:!failures.length,status:failures.length?'degraded':'succeeded',candidates:rows.length,enriched,failures,targetDate:asOfDate};
}

async function syncHkexAllotmentFacts({
  fromDate = '2025-08-04',
  toDate = todayShanghai(),
  asOfDate = toDate,
  limit = null,
  refreshLottery = false,
  targetCodes = [],
  executor = pool.query.bind(pool),
  fetchImpl = httpRequest,
  searchImpl = searchAnnouncements,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) || fromDate > toDate) {
    throw new Error('港股配发结果补全日期范围无效');
  }
  const source = await hkexSyncSql.syncHkexAllotmentFactsLayerQuery1(executor, []);
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const scopedCodes = [...new Set((Array.isArray(targetCodes) ? targetCodes : []).map(canonicalHkCode).filter(Boolean))];
  const targeted = scopedCodes.length > 0;
  const candidateLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const refreshLotteryParam = targeted ? 1 : 3;
  const feeParserParam = targeted ? 2 : 4;
  const factsParserParam = targeted ? 3 : 5;
  const targetCodesParam = targeted ? 4 : 6;
  const targetFilter = targeted ? ` AND security_code=ANY($${targetCodesParam}::text[])` : '';
  const candidateDateFilter = targeted ? '' : `AND (
         (ipo_status='listed' AND listing_at::date BETWEEN $1::date AND $2::date)
         OR (ipo_status IN ('active','priced','allotted') AND allotment_at IS NULL)
       )`;
  const candidateLimitClause = candidateLimit ? ` LIMIT $${targeted ? 5 : 6}` : '';
  const candidateParams = targeted
    ? [Boolean(refreshLottery), HKEX_ALLOTMENT_PARSER_VERSION, HKEX_ALLOTMENT_FACTS_PARSER_VERSION, scopedCodes]
    : [fromDate, toDate, Boolean(refreshLottery), HKEX_ALLOTMENT_PARSER_VERSION, HKEX_ALLOTMENT_FACTS_PARSER_VERSION];
  if (candidateLimit) candidateParams.push(candidateLimit);
  const candidatesResult = await hkexSyncSql.syncHkexAllotmentFactsLayerQuery2(executor, [candidateDateFilter, refreshLotteryParam, feeParserParam, factsParserParam, factsParserParam, factsParserParam, targetFilter, candidateLimitClause], candidateParams);
  const candidates = candidatesResult.rows;
  const run = await hkexSyncSql.syncHkexAllotmentFactsLayerQuery3(executor, [], [source.rows[0].source_id, HKEX_ALLOTMENT_DATASET, JSON.stringify({ fromDate, toDate, limit: candidateLimit, targetCodes: scopedCodes, refreshLottery: Boolean(refreshLottery), candidateCount: candidates.length })]);
  const runId = run.rows[0].run_id;
  const byCode = new Map(candidates.map(row => [String(row.security_code).split('.')[0].padStart(5, '0'), row]));
  // 配发结果通常在上市日前 1—3 个工作日公告，首个候选可能跨月，
  // 因此检索窗口至少向前覆盖一个月，避免漏掉月初上市的公告。
  const candidateDates = candidates.map(row => row.listing_date || row.allotment_date)
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))).sort();
  const firstCandidateDate = candidateDates[0] || fromDate;
  const lastCandidateDate = candidateDates[candidateDates.length - 1] || toDate;
  const allotmentSearchStart = shiftIsoDate(firstCandidateDate, -31);
  const searchStart = scopedCodes.length ? allotmentSearchStart
    : allotmentSearchStart < fromDate ? fromDate : allotmentSearchStart;
  const searchEnd = shiftIsoDate(lastCandidateDate, 5) > toDate ? toDate : shiftIsoDate(lastCandidateDate, 5);
  const announcements = [];
  const failures = [];
  let matched = 0;
  const pendingNotDue = [];
  let enriched = 0;
  try {
    const candidatesNeedingSearch = candidates.filter(row => {
      const document = (Array.isArray(row.source_documents) ? row.source_documents : [])
        .find(isReparsableAllotmentDocument);
      return !document;
    });
    if (candidatesNeedingSearch.length) {
      for (const [windowStart, windowEnd] of monthWindows(searchStart, searchEnd)) {
        try {
          const rows = await searchImpl({
            fromDate: windowStart,
            toDate: windowEnd,
            categories: ['15100'],
            _httpRequest: fetchImpl,
          });
          announcements.push(...rows.filter(row => allotmentTitleLooksLikeIpo(row.title, row.rawPayload)));
        } catch (error) {
          failures.push({ stage: 'search', fromDate: windowStart, toDate: windowEnd, error: error.message || String(error) });
        }
      }
    }
    const selected = new Map();
    // 已经由当前解析器验证过的官方配发 PDF 才直接复用；历史上误分类或
    // 只有“待解析”标记的文件必须重新走 15100 标题检索。
    for (const row of candidates) {
      const document = (Array.isArray(row.source_documents) ? row.source_documents : [])
        .filter(isReparsableAllotmentDocument)
        .sort((a, b) => String(b.announcedAt || '').localeCompare(String(a.announcedAt || '')))[0];
      if (!document) continue;
      const code = String(row.security_code || '').split('.')[0].padStart(5, '0');
      selected.set(code, {
        fileLink: document.sourceUrl || null,
        englishUrl: document.url,
        announcedAt: document.announcedAt || row.allotment_date || null,
        title: document.title || 'HKEX allotment result',
      });
    }
    for (const item of announcements.sort((a, b) => String(b.announcedAt || '').localeCompare(String(a.announcedAt || '')))) {
      const code = String(item.stockCode || '').padStart(5, '0');
      if (!byCode.has(code) || selected.has(code)) continue;
      selected.set(code, item);
    }
    matched = selected.size;
    for (const code of byCode.keys()) {
      if (selected.has(code)) continue;
      const expected = byCode.get(code).data_completeness?.prospectus?.expectedEvents?.allotmentDate?.date;
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(expected || '')) && expected > asOfDate) {
        pendingNotDue.push({ code, expectedDate: expected });
      } else failures.push({ code, stage: 'discovery', error: '候选配发资料未找到可核验的官方公告，不能视为零行成功' });
    }
    for (const [code, item] of selected) {
      const sourceUrl = item.fileLink || item.sourceUrl || null;
      const englishUrl = item.englishUrl || resolveHkexEnglishPdfUrl(sourceUrl);
      if (!englishUrl) {
        failures.push({ code, stage: 'resolve_document', error: '无法解析英文配发结果 URL' });
        continue;
      }
      try {
        const { buffer, url: cachedUrl } = await fetchOfficialPdfWithCache(
          englishUrl, fetchImpl, { responseType: 'buffer' }
        );
        const responseSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const current = byCode.get(code);
        const parsed = await parseHkexAllotmentPdf(buffer, { lotSizeShares: current && current.lot_size_shares });
        await hkexSyncSql.syncHkexAllotmentFactsLayerQuery4(executor, [], [runId, source.rows[0].source_id, HKEX_ALLOTMENT_DATASET, `${code}|${cachedUrl}`, JSON.stringify({
            securityCode: `${code}.HK`, sourceUrl, englishUrl: cachedUrl,
            announcedAt: item.announcedAt || (current && current.allotment_date) || null,
            responseBytes: buffer.length, responseSha256, parser: parsed,
          }), responseSha256]);
        const lotteryRate = Number.isFinite(Number(parsed.oneLotSuccessRate))
          && Number(parsed.oneLotSuccessRate) > 0 && Number(parsed.oneLotSuccessRate) <= 100
          ? Number(parsed.oneLotSuccessRate) : null;
        const lotteryParserStatus = parsed.lotteryParserStatus || (lotteryRate !== null ? 'parsed' : 'missing');
        const feeParserStatus = parsed.feeParserStatus || 'missing';
        const oversubscriptionParserStatus = parsed.oversubscriptionParserStatus || (parsed.publicOversubscription != null ? 'parsed' : 'missing');
        const greenshoeParserStatus = parsed.greenshoeParserStatus || (parsed.greenshoeDetails && parsed.greenshoeDetails.parserStatus) || (parsed.greenshoeDetails && Object.keys(parsed.greenshoeDetails).length ? 'parsed' : 'missing');
        const factsParserStatus = oversubscriptionParserStatus === 'parsed' || greenshoeParserStatus === 'parsed' ? 'parsed' : 'missing';
        const parsedGreenshoeDetails = parsed.greenshoeDetails && typeof parsed.greenshoeDetails === 'object'
          ? parsed.greenshoeDetails : {};
        const greenshoeDetailsForPersist = {
          ...(current.greenshoe_details && typeof current.greenshoe_details === 'object' ? current.greenshoe_details : {}),
          ...parsedGreenshoeDetails,
        };
        // 旧版本曾用初始公开发售股数计算比例。若本次公告没有解析到最终回拨股数，
        // 清除旧口径的分母和比例，避免继续展示不符合当前口径的结果。
        if (parsedGreenshoeDetails.publicOfferSharesBasis === 'final_public_offer_missing'
          && greenshoeDetailsForPersist.publicOfferSharesBasis !== 'final_public_offer_after_reallocation') {
          if (greenshoeDetailsForPersist.initialPublicOfferShares == null
            && greenshoeDetailsForPersist.publicOfferShares != null
            && greenshoeDetailsForPersist.publicOfferSharesBasis === 'initial_public_offer') {
            greenshoeDetailsForPersist.initialPublicOfferShares = greenshoeDetailsForPersist.publicOfferShares;
          }
          delete greenshoeDetailsForPersist.publicOfferShares;
          delete greenshoeDetailsForPersist.finalPublicOfferShares;
          delete greenshoeDetailsForPersist.protectionRatioPct;
          greenshoeDetailsForPersist.publicOfferSharesBasis = 'final_public_offer_missing';
        }
        // 公开发售比例和一手中签率是两组独立事实。部分官方配发 PDF
        // 缺少完整的初始发售股数，但仍有可审计的一手配发表；不能因为
        // 比例结构不完整而丢弃已经解析成功的一手中签率。
        if (!shouldPersistAllotmentFacts(parsed, lotteryParserStatus, feeParserStatus, factsParserStatus)) {
          failures.push({ code, stage: 'parse', error: '配发结果未得到完整初始发售结构或一手中签率', parser: parsed });
          continue;
        }
        const sourceDocuments = mergeSourceDocuments(current.source_documents, {
          type: 'allotment_result',
          url: cachedUrl,
          sourceUrl,
          title: item.title || 'HKEX allotment result',
          announcedAt: item.announcedAt || current.allotment_date || null,
          language: 'en',
          ratioBasis: 'final_public_offer_after_reallocation',
          contentSha256: responseSha256,
          parserEvidence: {
            ...parsed.evidence,
            parserStatus: parsed.parserStatus || null,
            oneLotAppliedShares: parsed.oneLotAppliedShares || null,
            oneLotValidApplications: parsed.oneLotValidApplications || null,
            oneLotSuccessfulApplications: parsed.oneLotSuccessfulApplications || null,
            oneLotSuccessRate: parsed.oneLotSuccessRate || null,
            lotteryParserStatus,
            finalOfferPrice: parsed.finalOfferPrice || null,
            brokerageRatePct: parsed.brokerageRatePct || null,
            sfcTransactionLevyRatePct: parsed.sfcTransactionLevyRatePct || null,
            afrcTransactionLevyRatePct: parsed.afrcTransactionLevyRatePct || null,
            stockExchangeTradingFeeRatePct: parsed.stockExchangeTradingFeeRatePct || null,
            lotAmountHkd: parsed.lotAmountHkd || null,
            applicationFeeHkd: parsed.applicationFeeHkd || null,
            brokerageFeeHkd: parsed.brokerageFeeHkd || null,
            feeParserStatus,
            feeParserVersion: parsed.parserVersion || HKEX_ALLOTMENT_PARSER_VERSION,
            publicOversubscription: parsed.publicOversubscription ?? null,
            publicOversubscriptionQualifier: parsed.publicOversubscriptionQualifier || null,
            oversubscriptionParserStatus,
            initialPublicOfferShares: parsed.initialPublicOfferShares ?? null,
            finalPublicOfferShares: parsed.finalPublicOfferShares ?? null,
            finalPublicOfferSharesParserStatus: parsed.finalPublicOfferSharesParserStatus || 'missing',
            initialInternationalOfferShares: parsed.initialInternationalOfferShares ?? null,
            initialOfferSharesTotal: parsed.initialOfferSharesTotal ?? null,
            greenshoeDetails: greenshoeDetailsForPersist,
            greenshoeParserStatus,
            factsParserVersion: HKEX_ALLOTMENT_FACTS_PARSER_VERSION,
            actualPricingDateStatus: parsed.actualPricingDateStatus,
          },
        });
        const completeness = {
          ...(current.data_completeness && typeof current.data_completeness === 'object' ? current.data_completeness : {}),
        };
        if (parsed.initialPublicOfferRatio != null) completeness.public_offer_ratio = 'value';
        if (parsed.initialInternationalOfferRatio != null) completeness.international_offer_ratio = 'value';
        if (lotteryRate !== null) completeness.onlineLotteryRate = 'value';
        if (item.announcedAt || current.allotment_date) completeness.allotmentDate = 'value';
        if (parsed.lotAmountHkd != null) completeness.lotAmountHkd = 'value';
        if (parsed.applicationFeeHkd != null) completeness.applicationFeeHkd = 'value';
        if (parsed.brokerageFeeHkd != null) completeness.brokerageFeeHkd = 'value';
        if (parsed.publicOversubscription != null) completeness.publicOversubscription = 'value';
        if (parsed.finalPublicOfferShares != null) completeness.finalPublicOfferShares = 'value';
        if (parsed.greenshoeDetails && parsed.greenshoeDetails.protectionRatioPct != null) completeness.greenshoeProtectionRatio = 'value';
        completeness.greenshoe = greenshoeParserStatus === 'parsed' ? 'value' : 'missing';
        await executor(`
          UPDATE public.ipo_history
             SET public_offer_ratio=COALESCE(public_offer_ratio,$2),
                 international_offer_ratio=COALESCE(international_offer_ratio,$3),
                 online_lottery_rate=COALESCE(online_lottery_rate,$4),
                 allotment_at=COALESCE(allotment_at,$5::timestamptz),
                 lot_amount_hkd=COALESCE(lot_amount_hkd,$6),
                 application_fee_hkd=COALESCE(application_fee_hkd,$7),
                 brokerage_fee_hkd=COALESCE(brokerage_fee_hkd,$8),
                 oversubscribe_multiple=COALESCE(oversubscribe_multiple,$9),
                 greenshoe_details=CASE WHEN $10::jsonb <> '{}'::jsonb THEN COALESCE(greenshoe_details,'{}'::jsonb) || $10::jsonb ELSE greenshoe_details END,
                 source_documents=$11::jsonb,
                 data_completeness=$12::jsonb,
                 pricing_at=COALESCE(pricing_at,$13::timestamptz),
                 issue_price_final=COALESCE(issue_price_final,$14),
                 facts_published_at=now(),
                 updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
           WHERE market_code='HK' AND security_code=$1`, [
          `${code}.HK`, parsed.initialPublicOfferRatio, parsed.initialInternationalOfferRatio, lotteryRate,
          item.announcedAt || current.allotment_date || null,
          parsed.lotAmountHkd, parsed.applicationFeeHkd, parsed.brokerageFeeHkd,
          parsed.publicOversubscription, JSON.stringify(greenshoeDetailsForPersist),
          JSON.stringify(sourceDocuments), JSON.stringify(completeness),
          parsed.actualPricingDate && parsed.evidence?.actualPricingDate ? `${parsed.actualPricingDate}T00:00:00+08:00` : null,
          parsed.finalOfferPrice > 0 ? parsed.finalOfferPrice : null,
        ]);
        enriched += 1;
      } catch (error) {
        failures.push({ code, stage: 'fetch_or_persist', error: error.message || String(error) });
      }
    }
    const limited = candidateLimit !== null;
    const status = failures.length ? (enriched ? 'degraded' : 'failed') : (limited ? 'degraded' : 'succeeded');
    const statusMessage = failures.map(item => `${item.code || item.stage}:${item.error}`).join('; ')
      || (limited ? '显式批次上限已启用，需后续复核剩余候选' : null);
    await executor(
      `UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
      [runId, status, enriched, statusMessage ? statusMessage.slice(0, 2000) : '']
    );
    return { ok: status !== 'failed', status, runId, candidates: candidates.length, matched, enriched, failures, pendingNotDue, limited, fromDate, toDate };
  } catch (error) {
    await executor(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

// 港交所新上市报表会把介绍上市、GEM 转主板和 De-SPAC 也列入“新上市”。
// 这些项目没有普通公众发售，不得因缺少招股价/每手股数被误判为公众招股数据缺失。
// 分类证据只接受港交所官方文件，并将响应哈希和原文摘要写入审计层。
async function syncHkexNonPublicListings({
  fromDate = '2025-08-04',
  toDate = todayShanghai(),
  limit = null,
  executor = pool.query.bind(pool),
  fetchImpl = httpRequest,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) || fromDate > toDate) {
    throw new Error('港股非公众上市分类日期范围无效');
  }
  const source = await hkexSyncSql.syncHkexNonPublicListingsLayerQuery1(executor, []);
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const candidateLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const known = candidateLimit ? HKEX_NON_PUBLIC_LISTINGS.slice(0, candidateLimit) : [...HKEX_NON_PUBLIC_LISTINGS];
  const candidateResult = await hkexSyncSql.syncHkexNonPublicListingsLayerQuery2(executor, [], [fromDate, toDate, known.map(item => item.securityCode)]);
  const candidates = new Map(candidateResult.rows.map(row => [String(row.security_code), row]));
  const selected = known.filter(item => candidates.has(item.securityCode));
  const run = await hkexSyncSql.syncHkexNonPublicListingsLayerQuery3(executor, [], [source.rows[0].source_id, HKEX_NON_PUBLIC_DATASET, JSON.stringify({ fromDate, toDate, limit: candidateLimit, candidateCount: selected.length })]);
  const runId = run.rows[0].run_id;
  let enriched = 0;
  const failures = [];
  try {
    for (const item of selected) {
      const current = candidates.get(item.securityCode);
      try {
        const { buffer, url } = await fetchOfficialPdfWithCache(
          item.sourceUrl, fetchImpl, { responseType: 'buffer', maxResponseBytes: 40 * 1024 * 1024 }
        );
        const responseSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const payload = {
          securityCode: item.securityCode,
          sourceUrl: url,
          title: item.title,
          classification: item.ipoStatus,
          listingMethod: item.listingMethod,
          evidence: item.evidence,
          responseBytes: buffer.length,
          responseSha256,
          parserStatus: 'official_evidence_pinned_v1',
        };
        await hkexSyncSql.syncHkexNonPublicListingsLayerQuery4(executor, [], [runId, source.rows[0].source_id, HKEX_NON_PUBLIC_DATASET, `${item.securityCode}|${url}`, JSON.stringify(payload), responseSha256]);
        const sourceDocuments = mergeSourceDocuments(current.source_documents, {
          type: 'listing_classification', url, title: item.title, language: 'en',
          classification: item.ipoStatus, listingMethod: item.listingMethod,
          contentSha256: responseSha256, parserStatus: 'official_evidence_pinned_v1', evidence: item.evidence,
        });
        const completeness = {
          ...(current.data_completeness && typeof current.data_completeness === 'object' ? current.data_completeness : {}),
          publicOfferEligibility: 'excluded',
          exclusionReason: item.ipoStatus,
        };
        await executor(`
          UPDATE public.ipo_history
             SET ipo_status=$2,ipo_status_at=now(),source_documents=$3::jsonb,
                 data_completeness=$4::jsonb,facts_published_at=now(),updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
           WHERE market_code='HK' AND security_code=$1`,
          [item.securityCode, item.ipoStatus, JSON.stringify(sourceDocuments), JSON.stringify(completeness)]
        );
        if (current.instrument_id) {
          await executor(`
            UPDATE core.instruments
               SET status=$2,raw_data=raw_data || $3::jsonb,updated_at=now()
             WHERE instrument_id=$1`,
            [current.instrument_id, item.ipoStatus, JSON.stringify({ source: 'hkex_announcements', listingMethod: item.listingMethod, evidenceUrl: url })]
          );
        }
        enriched += 1;
      } catch (error) {
        failures.push({ code: item.securityCode, stage: 'fetch_or_persist', error: error.message || String(error) });
      }
    }
    const limited = candidateLimit !== null;
    const status = failures.length ? (enriched ? 'degraded' : 'failed') : (limited ? 'degraded' : 'succeeded');
    const statusMessage = failures.map(item => `${item.code}:${item.error}`).join('; ')
      || (limited ? '显式批次上限已启用，需后续复核剩余候选' : null);
    await executor(`UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
      [runId, status, enriched, statusMessage ? statusMessage.slice(0, 2000) : '']);
    return { ok: status !== 'failed', status, runId, candidates: selected.length, enriched, failures, limited, fromDate, toDate };
  } catch (error) {
    await executor(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

function classifyHkexIpoStatusNotice(title, rawPayload) {
  const text = `${title || ''} ${JSON.stringify(rawPayload || {})}`;
  const ipoContext = /(global\s+offering|public\s+offer|share\s+offer|\bipo\b|listing|上市|全球发售|全球發售|新股|招股)/i.test(text);
  if (ipoContext && /(cancel|withdraw|not\s+(?:to\s+)?proceed|terminate|撤回|取消|終止|终止|不再进行|不再進行|撤銷|撤销)/i.test(text)) {
    return 'cancelled';
  }
  const postponement = /(postpon|delay|延期|推迟|推遲|延迟|延遲|延后|延後|押后|押後)/i.test(text)
    && /(global offering|listing|上市|发售|發售|招股)/i.test(text);
  if (postponement) return 'postponed';
  return null;
}

function cancellationTitleLooksLikeIpo(title, rawPayload) {
  return classifyHkexIpoStatusNotice(title, rawPayload) === 'cancelled';
}

async function syncHkexListingStatusNotices({
  fromDate = shiftIsoDate(todayShanghai(), -180),
  toDate = todayShanghai(),
  limit = null,
  targetCodes = [],
  executor = pool.query.bind(pool),
  fetchImpl = httpRequest,
  searchImpl = searchAnnouncements,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) || fromDate > toDate) {
    throw new Error('港股发行状态公告日期范围无效');
  }
  const source = await hkexSyncSql.syncHkexListingStatusNoticesLayerQuery1(executor, []);
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const scopedCodes = [...new Set((Array.isArray(targetCodes) ? targetCodes : []).map(canonicalHkCode).filter(Boolean))];
  const targetFilter = scopedCodes.length ? ' AND security_code=ANY($3::text[])' : '';
  const candidateLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const candidateLimitClause = candidateLimit ? ` LIMIT $${scopedCodes.length ? 4 : 3}` : '';
  const candidateParams = [fromDate, toDate];
  if (scopedCodes.length) candidateParams.push(scopedCodes);
  if (candidateLimit) candidateParams.push(candidateLimit);
  const candidateResult = await hkexSyncSql.syncHkexListingStatusNoticesLayerQuery2(executor, [targetFilter, candidateLimitClause], candidateParams);
  const candidates = new Map(candidateResult.rows.map(row => [String(row.security_code), row]));
  if (!candidates.size) return { ok: true, status: 'succeeded', candidates: 0, searched: 0, matched: 0, cancelled: 0, postponed: 0, enriched: 0, failures: [], fromDate, toDate };
  const run = await hkexSyncSql.syncHkexListingStatusNoticesLayerQuery3(executor, [], [source.rows[0].source_id, HKEX_LISTING_STATUS_DATASET, JSON.stringify({ fromDate, toDate, limit: candidateLimit, targetCodes: scopedCodes, candidateCount: candidates.size })]);
  const runId = run.rows[0].run_id;
  const failures = [];
  let cancelled = 0;
  let postponed = 0;
  let enriched = 0;
  let searched = 0;
  try {
    const selected = new Map();
    for (const code of candidates.keys()) {
      const candidate = candidates.get(code);
      // 已取消的新申请人可能不再出现在股票代码检索中；优先核验已保存的官方公告。
      const cachedNotices = (Array.isArray(candidate.source_documents) ? candidate.source_documents : [])
        .filter(document => document.type === 'new_listing' && document.url && !/_c\.pdf$/i.test(document.url));
      for (const document of cachedNotices) {
        try {
          const cached = await readCachedPdf(document.url);
          if (!cached) continue;
          const parsed = await parseHkexAllotmentPdf(cached);
          const notice = parsed.listingStatusNotice;
          if (!notice || canonicalHkCode(notice.stockCode) !== code
            || notice.announcedAt < candidate.offer_open_date || notice.announcedAt > toDate) continue;
          selected.set(code, { fileLink: document.url, title: notice.evidence,
            announcedAt: notice.announcedAt, rawPayload: { listingStatusNotice: notice } });
          break;
        } catch (error) {
          failures.push({ code, stage: 'cached_notice', error: error.message || String(error) });
        }
      }
      if (selected.has(code)) continue;
      searched += 1;
      try {
        const announcements = await searchImpl({ fromDate, toDate, categories: ['-2'], stockCode: code, _httpRequest: fetchImpl });
        for (const item of announcements.filter(row => row && row.fileLink && classifyHkexIpoStatusNotice(row.title, row.rawPayload))) {
          if (canonicalHkCode(item.stockCode) !== code) continue;
          const current = selected.get(code);
          const announcedAt = String(item.announcedAt || '').slice(0, 10);
          const currentAnnouncedAt = String(current?.announcedAt || '').slice(0, 10);
          if (!current || announcedAt > currentAnnouncedAt) selected.set(code, item);
        }
      } catch (error) {
        failures.push({ code, stage: 'search', error: error.message || String(error) });
      }
    }
    for (const [code, item] of selected) {
      const current = candidates.get(code);
      const ipoStatus = classifyHkexIpoStatusNotice(item.title, item.rawPayload);
      const announcedAt = String(item.announcedAt || '').slice(0, 10);
      // PostgreSQL timestamptz is parsed as a JavaScript Date by node-postgres;
      // compare the SQL-normalized business date, not Date.toString().
      const currentOfferOpenDate = String(current.offer_open_date || '').slice(0, 10);
      // 新招股窗口晚于旧延期公告时，不能用历史延期记录覆盖重新启动的项目。
      if (ipoStatus === 'postponed' && announcedAt && currentOfferOpenDate > announcedAt) continue;
      try {
        const { buffer, url } = await fetchOfficialPdfWithCache(
          item.fileLink, fetchImpl, { responseType: 'buffer', maxResponseBytes: 20 * 1024 * 1024 }
        );
        const responseSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const sourceDocuments = mergeSourceDocuments(current.source_documents, {
          type: ipoStatus === 'postponed' ? 'listing_postponement' : 'listing_cancellation',
          url, title: item.title || `HKEX ${ipoStatus} notice`,
          announcedAt: item.announcedAt || null, language: 'en', contentSha256: responseSha256,
          parserStatus: item.rawPayload?.listingStatusNotice ? 'official_body_match_v1' : 'official_title_match_v1',
          parserEvidence: item.rawPayload?.listingStatusNotice || null,
        });
        const completeness = {
          ...(current.data_completeness && typeof current.data_completeness === 'object' ? current.data_completeness : {}),
          ...(ipoStatus === 'cancelled' ? { publicOfferEligibility: 'excluded', exclusionReason: 'cancelled' } : {}),
        };
        await hkexSyncSql.syncHkexListingStatusNoticesLayerQuery4(executor, [], [runId, source.rows[0].source_id, HKEX_LISTING_STATUS_DATASET, `${code}|${url}`, JSON.stringify({
            securityCode: code, ipoStatus, sourceUrl: url, title: item.title || null, announcedAt: item.announcedAt || null,
            responseBytes: buffer.length, responseSha256,
            parserStatus: item.rawPayload?.listingStatusNotice ? 'official_body_match_v1' : 'official_title_match_v1',
            parserEvidence: item.rawPayload?.listingStatusNotice || null,
          }), responseSha256]);
        await executor(`
          UPDATE public.ipo_history
             SET ipo_status=$2,ipo_status_at=COALESCE($3::date::timestamptz,now()),source_documents=$4::jsonb,
                 data_completeness=$5::jsonb,facts_published_at=now(),updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
           WHERE market_code='HK' AND security_code=$1`, [code, ipoStatus, announcedAt || null, JSON.stringify(sourceDocuments), JSON.stringify(completeness)]);
        if (ipoStatus === 'cancelled' && current.instrument_id) {
          await executor(`UPDATE core.instruments SET status='cancelled',raw_data=raw_data || $2::jsonb,updated_at=now() WHERE instrument_id=$1`,
            [current.instrument_id, JSON.stringify({ source: 'hkex_announcements', evidenceUrl: url })]);
        }
        if (ipoStatus === 'cancelled') cancelled += 1;
        if (ipoStatus === 'postponed') postponed += 1;
        enriched += 1;
      } catch (error) {
        failures.push({ code, stage: 'fetch_or_persist', error: error.message || String(error) });
      }
    }
    const limited = candidateLimit !== null;
    const status = failures.length ? (enriched ? 'degraded' : 'failed') : (limited ? 'degraded' : 'succeeded');
    const statusMessage = failures.map(item => `${item.code}:${item.error}`).join('; ')
      || (limited ? '显式批次上限已启用，需后续复核剩余候选' : null);
    await executor(`UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
      [runId, status, enriched, statusMessage ? statusMessage.slice(0, 2000) : '']);
    return { ok: status !== 'failed', status, runId, candidates: candidates.size, searched, matched: selected.size, cancelled, postponed, enriched, failures, limited, fromDate, toDate };
  } catch (error) {
    await executor(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

async function syncHkexProspectusFacts({
  fromDate = '2025-08-04',
  toDate = todayShanghai(),
  limit = null,
  refreshSponsor = false,
  targetCodes = [],
  executor = pool.query.bind(pool),
  fetchImpl = httpRequest,
  searchImpl = searchAnnouncements,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) || fromDate > toDate) {
    throw new Error('港股招股书补全日期范围无效');
  }
  const source = await hkexSyncSql.syncHkexProspectusFactsLayerQuery1(executor, []);
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const scopedCodes = [...new Set((Array.isArray(targetCodes) ? targetCodes : []).map(canonicalHkCode).filter(Boolean))];
  const targeted = scopedCodes.length > 0;
  const candidateLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const refreshSponsorParam = targeted ? 1 : 3;
  const targetCodesParam = targeted ? 2 : 4;
  const targetFilter = targeted ? ` AND security_code=ANY($${targetCodesParam}::text[])` : '';
  const candidateDateFilter = targeted ? '' : `AND (
         timezone('Asia/Shanghai',listing_at)::date BETWEEN $1::date AND $2::date
       OR (listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND listing_date::date BETWEEN $1::date AND $2::date)
       OR (listing_at IS NULL AND ipo_status IN ('active','priced','allotted'))
       OR (listing_at IS NULL AND ipo_status='listed'
           AND (listing_date IS NULL OR listing_date !~ '^\\d{4}-\\d{2}-\\d{2}$')
           AND COALESCE(offer_close_at::date,offer_open_at::date,
             CASE WHEN ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN ipo_date::date END) BETWEEN $1::date AND $2::date)
       )`;
  const retryFilter = targeted ? '' : `AND (data_completeness#>>'{prospectus,next_retry_at}' IS NULL
         OR (data_completeness#>>'{prospectus,next_retry_at}')::timestamptz <= now())`;
  const candidateLimitClause = candidateLimit ? ` LIMIT $${targeted ? 3 : 4}` : '';
  const candidateParams = targeted
    ? [Boolean(refreshSponsor), scopedCodes]
    : [fromDate, toDate, Boolean(refreshSponsor)];
  if (candidateLimit) candidateParams.push(candidateLimit);
  const candidatesResult = await hkexSyncSql.syncHkexProspectusFactsLayerQuery2(executor, [candidateDateFilter, retryFilter, targeted ? 'true' : 'false', refreshSponsorParam, targetFilter, candidateLimitClause], candidateParams);
  const candidates = candidatesResult.rows;
  const run = await hkexSyncSql.syncHkexProspectusFactsLayerQuery3(executor, [], [source.rows[0].source_id, HKEX_PROSPECTUS_DATASET, JSON.stringify({ fromDate, toDate, limit: candidateLimit, targetCodes: scopedCodes, refreshSponsor: Boolean(refreshSponsor), candidateCount: candidates.length })]);
  const runId = run.rows[0].run_id;
  if (!candidates.length) {
    await executor(`UPDATE ops.ingestion_runs SET status='succeeded',row_count=0,finished_at=now() WHERE run_id=$1`, [runId]);
    return { ok: true, status: 'succeeded', runId, candidates: 0, searched: 0, attempted: 0, enriched: 0, failures: [], fromDate, toDate };
  }

  // 候选查询会优先重试已有招股书证据，顺序不再保证按上市日排列；
  // 检索窗口必须使用全部候选的日期边界，不能取数组首尾。
  const listingDates = candidates.map(candidate => candidate.actual_listing_date || candidate.listing_date
    || candidate.offer_close_at || candidate.offer_open_at || candidate.ipo_date)
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))).sort();
  const firstListing = listingDates[0] || fromDate;
  const lastListing = listingDates[listingDates.length - 1] || toDate;
  const prospectusSearchStart = shiftIsoDate(firstListing, -45);
  const searchStart = scopedCodes.length ? prospectusSearchStart
    : prospectusSearchStart < fromDate ? fromDate : prospectusSearchStart;
  const searchEnd = lastListing > toDate ? toDate : lastListing;
  const byCode = new Map(candidates.map(row => [String(row.security_code), row]));
  const announcements = [];
  const failures = [];
  let searched = 0;
  let attempted = 0;
  let enriched = 0;
  let missingEvidence = 0;
  try {
    const documentsByCode = new Map();
    const candidatesNeedingSearch = candidates.filter(candidate => {
      const existing = (Array.isArray(candidate.source_documents) ? candidate.source_documents : [])
        .filter(isUsableProspectusDocument);
      if (existing.length) {
        documentsByCode.set(String(candidate.security_code), existing.map(document => ({
          fileLink: document.url,
          announcedAt: document.announcedAt || null,
          title: document.title || 'HKEX prospectus',
        })));
        return false;
      }
      return true;
    });
    if (candidatesNeedingSearch.length) {
      for (const [windowStart, windowEnd] of prospectusSearchWindows(searchStart, searchEnd)) {
        try {
          const rows = await searchImpl({
            fromDate: windowStart,
            toDate: windowEnd,
            categories: ['30700'],
            t1code: '30000',
            t2Gcode: '-1',
            _httpRequest: fetchImpl,
          });
          searched += 1;
          announcements.push(...rows.filter(row => row.fileLink && /\.pdf(?:[?#].*)?$/i.test(row.fileLink)));
        } catch (error) {
          failures.push({ stage: 'search', fromDate: windowStart, toDate: windowEnd, error: error.message || String(error) });
        }
      }
    }
    for (const item of announcements) {
      const code = canonicalHkCode(item.stockCode);
      if (!code || !byCode.has(code)) continue;
      const list = documentsByCode.get(code) || [];
      if (!list.some(doc => doc.fileLink === item.fileLink)) list.push(item);
      documentsByCode.set(code, list);
    }
    for (const candidate of candidates) {
      const code = String(candidate.security_code);
      if (HKEX_PROSPECTUS_NOT_APPLICABLE.has(code)) {
        const evidenceUrl = (Array.isArray(candidate.source_documents) ? candidate.source_documents : [])
          .map(item => item && item.url).find(Boolean) || null;
        await executor(
          `UPDATE public.ipo_history
              SET data_completeness=jsonb_set(COALESCE(data_completeness,'{}'::jsonb),'{prospectus}',$2::jsonb,true),
                  updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            WHERE market_code='HK' AND security_code=$1`,
          [code, JSON.stringify({ status: 'not_applicable', checked_at: new Date().toISOString(), next_retry_at: null,
            reason: '供股/配售对象，不适用普通 IPO 招股书', evidence_url: evidenceUrl })]
        );
        continue;
      }
      const documents = (documentsByCode.get(code) || []).sort((a, b) => String(a.announcedAt || '').localeCompare(String(b.announcedAt || '')));
      if (!documents.length) {
        missingEvidence += 1;
        await executor(
          `UPDATE public.ipo_history
              SET data_completeness=jsonb_set(COALESCE(data_completeness,'{}'::jsonb),'{prospectus}',$2::jsonb,true),
                  updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
            WHERE market_code='HK' AND security_code=$1`,
          [code, JSON.stringify({ status: 'retryable', checked_at: new Date().toISOString(),
            next_retry_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), reason: '官方招股书窗口内暂未发现可核验文件', evidence_url: null,
            expectedEvents: {
              pricingDate: { date: null, status: 'not_located' },
              allotmentDate: { date: null, status: 'not_located' },
              listingDate: { date: null, status: 'not_located' },
            } })]
        );
        continue;
      }
      const aggregate = {};
      const existingProspectus = candidate.data_completeness?.prospectus || {};
      for (const [key, value] of Object.entries({
        issuePriceLow: candidate.issue_price_low,
        issuePriceHigh: candidate.issue_price_high,
        issuePriceFinal: candidate.issue_price_final,
        issuePriceType: existingProspectus.fields?.issuePriceLow === 'maximum_only' ? 'maximum_only' : null,
        lotSizeShares: candidate.lot_size_shares,
        offerOpenAt: candidate.offer_open_at,
        offerCloseAt: candidate.offer_close_at,
        expectedPricingDate: existingProspectus.expectedEvents?.pricingDate?.date,
        expectedAllotmentDate: existingProspectus.expectedEvents?.allotmentDate?.date,
        expectedListingDate: existingProspectus.expectedEvents?.listingDate?.date,
      })) if (value != null) aggregate[key] = value;
      const evidenceDocuments = [];
      const parseDocuments = [];
      for (const document of documents) {
        // 保荐人字段优先复用同一份官方招股书的英文版；英文版附录通常有
        // “3. Joint Sponsors”结构化名单，中文 PDF 的多栏抽取容易丢失公司名。
        if (refreshSponsor) {
          const englishUrl = resolveHkexEnglishPdfUrl(document.fileLink);
          if (englishUrl && englishUrl !== document.fileLink) {
            parseDocuments.push({ ...document, fileLink: englishUrl, originalFileLink: document.fileLink, language: 'en' });
          }
        }
        parseDocuments.push(document);
      }
      const uniqueParseDocuments = parseDocuments.filter((document, index, list) => (
        list.findIndex(item => item.fileLink === document.fileLink) === index
      ));
      // 候选对象上限与证据文档数是两个不同维度；不得用固定文档数截断业务事实。
      for (const document of uniqueParseDocuments) {
        attempted += 1;
        try {
          const cachedUrl = assertOfficialUrl(document.fileLink);
          const persisted = await hkexSyncSql.syncHkexProspectusFactsLayerQuery4(executor, [], [source.rows[0].source_id, HKEX_PROSPECTUS_DATASET, `${code}|${cachedUrl}`]);
          let payload = persisted.rows[0]?.payload;
          const needsTimetableReparse=payload?.parser?.expectedTimetableVersion!=='hk-ipo-timetable-v2'&&
            ((!candidate.allotment_at&&!payload?.parser?.expectedAllotmentDate)||
              (!candidate.listing_at&&!payload?.parser?.expectedListingDate));
          if (!payload || payload.sourceUrl !== cachedUrl || !/^[a-f0-9]{64}$/.test(payload.responseSha256 || '')
            || needsTimetableReparse || (payload.parser.securityCode && canonicalHkCode(payload.parser.securityCode) !== code)) {
            const { buffer } = await fetchOfficialPdfWithCache(
              cachedUrl, fetchImpl, { responseType: 'buffer', maxResponseBytes: 40 * 1024 * 1024 }
            );
            payload = { responseSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
              responseBytes: buffer.length, parser: await parseHkexProspectusPdf(buffer) };
          }
          const responseSha256 = payload.responseSha256;
          const parsed = payload.parser;
          if (parsed.securityCode && canonicalHkCode(parsed.securityCode) !== code) {
            throw new Error('官方招股书证券身份与目标不一致');
          }
          await hkexSyncSql.syncHkexProspectusFactsLayerQuery5(executor, [], [runId, source.rows[0].source_id, HKEX_PROSPECTUS_DATASET, `${code}|${cachedUrl}`, JSON.stringify({
              securityCode: code, sourceUrl: cachedUrl, originalSourceUrl: document.originalFileLink || cachedUrl,
              language: document.language || null, announcedAt: document.announcedAt || null,
              responseBytes: payload.responseBytes, responseSha256, parser: parsed,
            }), responseSha256]);
          evidenceDocuments.push({
            type: 'prospectus', url: cachedUrl, sourceUrl: document.originalFileLink || null,
            language: document.language || null, title: document.title || 'HKEX prospectus',
            announcedAt: document.announcedAt || null, contentSha256: responseSha256,
            parserStatus: parsed.parserStatus, parserVersion: parsed.parserVersion || null,
            parserEvidence: {
              ...(parsed.evidence || {}),
              ...(parsed.sponsorGroup ? { sponsorGroup: parsed.sponsorGroup, sponsorGroupEvidence: parsed.evidence?.sponsorGroup || null } : {}),
            },
          });
          for (const [key, value] of Object.entries({
            issuePriceLow: parsed.issuePriceLow,
            issuePriceHigh: parsed.issuePriceHigh,
            issuePriceType: parsed.issuePriceType,
            lotSizeShares: parsed.lotSizeShares,
            offerOpenAt: parsed.offerOpenAt,
            offerCloseAt: parsed.offerCloseAt,
            expectedPricingDate: parsed.expectedPricingDate,
            expectedAllotmentDate: parsed.expectedAllotmentDate,
            expectedListingDate: parsed.expectedListingDate,
            sponsorGroup: parsed.sponsorGroup,
          })) {
            if (aggregate[key] == null && value != null) aggregate[key] = value;
          }
          if (parsed.issuePriceType === 'range' && parsed.issuePriceLow != null && parsed.issuePriceHigh != null) {
            aggregate.issuePriceLow = parsed.issuePriceLow;
            aggregate.issuePriceHigh = parsed.issuePriceHigh;
            aggregate.issuePriceType = 'range';
          }
          const coreComplete = (aggregate.issuePriceLow != null || aggregate.issuePriceType === 'maximum_only')
            && aggregate.issuePriceHigh != null
            && aggregate.lotSizeShares != null && aggregate.offerOpenAt != null && aggregate.offerCloseAt != null;
          const timetableComplete = aggregate.expectedPricingDate && aggregate.expectedAllotmentDate && aggregate.expectedListingDate;
          if (coreComplete && timetableComplete && (!refreshSponsor || aggregate.sponsorGroup != null)) break;
        } catch (error) {
          failures.push({ code, stage: 'fetch_or_parse', url: document.fileLink, error: error.message || String(error) });
        }
      }
      if (!Object.keys(aggregate).length) continue;
      const currentDocuments = Array.isArray(candidate.source_documents) ? candidate.source_documents : [];
      const sourceDocuments = currentDocuments.slice();
      for (const document of evidenceDocuments) {
        const key = `${document.type}|${document.url}`;
        const index = sourceDocuments.findIndex(item => `${item.type || ''}|${item.url || ''}` === key);
        if (index >= 0) sourceDocuments[index] = { ...sourceDocuments[index], ...document };
        else sourceDocuments.push(document);
      }
      const prospectusComplete = (aggregate.issuePriceLow != null || aggregate.issuePriceType === 'maximum_only')
        && aggregate.issuePriceHigh != null
        && aggregate.lotSizeShares != null && aggregate.offerOpenAt != null && aggregate.offerCloseAt != null;
      const today = todayShanghai();
      const expectedEvents = {
        pricingDate: aggregate.expectedPricingDate
          ? { date: aggregate.expectedPricingDate, status: 'parsed' }
          : { date: null, status: 'not_located' },
        allotmentDate: aggregate.expectedAllotmentDate
          ? { date: aggregate.expectedAllotmentDate, status: 'parsed' }
          : { date: null, status: 'not_located' },
        listingDate: aggregate.expectedListingDate
          ? { date: aggregate.expectedListingDate, status: 'parsed' }
          : { date: null, status: 'not_located' },
      };
      const futureExpectedDates = Object.values(expectedEvents).map(item => item.date)
        .filter(value => /^\\d{4}-\\d{2}-\\d{2}$/.test(String(value || '')) && value > today).sort();
      const closeDate = String(aggregate.offerCloseAt || '').slice(0, 10);
      const hasMissingExpectedOutcome = closeDate && closeDate < today && (
        !candidate.actual_listing_date && !candidate.listing_date
        || !candidate.pricing_at && (!expectedEvents.pricingDate.date || expectedEvents.pricingDate.date <= today)
        || !candidate.issue_price_final && (!expectedEvents.pricingDate.date || expectedEvents.pricingDate.date <= today)
        || !candidate.allotment_at && (!expectedEvents.allotmentDate.date || expectedEvents.allotmentDate.date <= today)
        || expectedEvents.pricingDate.date && expectedEvents.pricingDate.date <= today
        || expectedEvents.allotmentDate.date && expectedEvents.allotmentDate.date <= today
        || expectedEvents.listingDate.date && expectedEvents.listingDate.date <= today
      );
      const nextRetryAt = !prospectusComplete
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : hasMissingExpectedOutcome
          ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          : futureExpectedDates.length
          ? `${futureExpectedDates[0]}T00:00:00+08:00`
          : null;
      const prospectusCompleteness = {
        status: prospectusComplete ? (hasMissingExpectedOutcome ? 'retryable' : nextRetryAt ? 'pending_not_due' : 'complete') : 'retryable', checked_at: new Date().toISOString(),
        next_retry_at: nextRetryAt,
        reason: prospectusComplete ? '官方招股书已解析并保存证据' : '官方招股书已发现但核心字段仍缺失',
        evidence_url: evidenceDocuments[0]?.url || documents[0]?.fileLink || null,
        fields: {}, expectedEvents,
      };
      for (const [key, value] of Object.entries({
        issuePriceLow: aggregate.issuePriceLow, issuePriceHigh: aggregate.issuePriceHigh,
        issuePriceType: aggregate.issuePriceType, lotSizeShares: aggregate.lotSizeShares,
        offerOpenAt: aggregate.offerOpenAt, offerCloseAt: aggregate.offerCloseAt,
        sponsorGroup: aggregate.sponsorGroup,
      })) if (value != null) prospectusCompleteness.fields[key] = key === 'issuePriceType' ? value : 'value';
      if (aggregate.issuePriceType === 'maximum_only') prospectusCompleteness.fields.issuePriceLow = 'maximum_only';
      await executor(`
        UPDATE public.ipo_history
           SET issue_price_low=COALESCE($2,issue_price_low),
               issue_price_high=COALESCE($3,issue_price_high),
               lot_size_shares=COALESCE(lot_size_shares,$4),
               offer_open_at=COALESCE(offer_open_at,$5::timestamptz),
               offer_close_at=COALESCE(offer_close_at,$6::timestamptz),
               source_documents=$7::jsonb,
               data_completeness=jsonb_set(COALESCE(data_completeness,'{}'::jsonb),'{prospectus}',$8::jsonb,true),
               facts_published_at=now(),updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
         WHERE market_code='HK' AND security_code=$1`, [
        code, aggregate.issuePriceLow ?? null, aggregate.issuePriceHigh ?? null, aggregate.lotSizeShares ?? null,
        aggregate.offerOpenAt || null, aggregate.offerCloseAt || null, JSON.stringify(sourceDocuments), JSON.stringify(prospectusCompleteness),
      ]);
      enriched += 1;
    }
    const limited = candidateLimit !== null;
    const status = failures.length ? (enriched || missingEvidence ? 'degraded' : 'failed')
      : (limited || missingEvidence ? 'degraded' : 'succeeded');
    const statusMessage = failures.map(item => `${item.code || item.stage}:${item.error}`).join('; ')
      || (limited ? '显式批次上限已启用，需后续复核剩余候选' : null);
    await executor(`UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
      [runId, status, enriched, statusMessage ? statusMessage.slice(0, 2000) : '']);
    return { ok: status !== 'failed', status, runId, candidates: candidates.length, searched, attempted, enriched, missingEvidence, failures, limited, fromDate, toDate };
  } catch (error) {
    await executor(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

async function syncHkexHistoricalReports({
  fromDate = '2025-08-04',
  toDate = todayShanghai(),
  years = [2025, 2026],
  fetchImpl = httpRequest,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) || fromDate > toDate) {
    throw new Error('港股 IPO 历史报表日期范围无效');
  }
  const reports = await fetchHkexNewListingReports({ years, fetchImpl });
  const rows = reports.flatMap(report => (report.items || [])
    .filter(item => item.listingDate && item.listingDate >= fromDate && item.listingDate <= toDate)
    .map(item => ({
      ...item,
      sourceDocuments: [{ type: 'new_listing_report', url: report.url, title: `${report.board} ${report.year} 官方新上市报表` }],
    })));
  const source = await repository.select_ops_data_sources();
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const range = { fromDate, toDate, years, targetCount: reports.length, reportKeys: reports.map(report => report.key) };
  const run = await repository.insert_ops_ingestion_runs([source.rows[0].source_id, JSON.stringify(range)]);
  const runId = run.rows[0].run_id;
  try {
    for (const report of reports) {
      const payload = {
        key: report.key,
        board: report.board,
        year: report.year,
        url: report.url,
        ok: report.ok,
        responseBytes: report.responseBytes || 0,
        responseSha256: report.responseSha256 || null,
        parserStatus: report.parserStatus || 'not_run',
        rowCount: report.rowCount || 0,
        error: report.error || null,
        items: report.items || [],
      };
      const payloadText = JSON.stringify(payload);
      await repository.insert_ops_raw_records([runId, source.rows[0].source_id, report.key, payloadText, report.responseSha256 || crypto.createHash('sha256').update(payloadText).digest('hex')]);
    }
    const upserted = await upsertHkIpoFacts(rows, { sourceCode: 'hkex_announcements' });
    const failures = reports.filter(report => !report.ok);
    const status = reports.length && !failures.length ? 'succeeded' : rows.length ? 'degraded' : 'failed';
    const errorMessage = failures.map(report => `${report.key}:${report.error || 'failed'}`).join('; ').slice(0, 2000);
    await repository.update_ops_ingestion_runs([runId, status, rows.length, errorMessage]);
    return { ok: status !== 'failed', status, runId, reports: reports.length, rows: rows.length, upserted, failures: failures.length, fromDate, toDate };
  } catch (error) {
    await repository.update_ops_ingestion_runs_1([runId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

module.exports = {
  syncHkexPricingFacts,
  syncHkexAllotmentFacts,
  syncHkexNonPublicListings,
  classifyHkexIpoStatusNotice,
  cancellationTitleLooksLikeIpo,
  syncHkexListingStatusNotices,
  syncHkexProspectusFacts,
  syncHkexHistoricalReports,
};
