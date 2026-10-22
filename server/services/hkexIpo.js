// hkexIpo.js —— R-10 拆分后主入口（2026-10-21）：函数体按域放在 ./hkexIpo*.js，
// 本文件只做编排与再导出；module.exports 与拆分前完全一致，调用方零改动。
const { HKEX_NEW_LISTING_REPORT_TARGETS, HKEX_NEW_LISTING_TARGETS, HKEX_NON_PUBLIC_LISTINGS, HKEX_PREDEFINED_DOCUMENT_TARGETS, allotmentTitleLooksLikeIpo, canonicalHkCode, fetchHkexNewListingReports, fetchOfficialPdfWithCache, isReparsableAllotmentDocument, isUsableProspectusDocument, isVerifiedAllotmentDocument, normalizeDate, parseHkexAllotmentPdf, parseHkexProspectusPdf, parseNewListingReportWorkbook, parseNewListingsHtml, parsePredefinedDocumentHtml, resolveHkexEnglishPdfUrl, shouldPersistAllotmentFacts } = require('./hkexIpoCore.js');
const { cancellationTitleLooksLikeIpo, classifyHkexIpoStatusNotice, syncHkexAllotmentFacts, syncHkexHistoricalReports, syncHkexListingStatusNotices, syncHkexNonPublicListings, syncHkexPricingFacts, syncHkexProspectusFacts } = require('./hkexIpoSync.js');
const { buildProbePlan, persistHkexProbe, readHkIpoCompleteness, recomputeCompletenessForStoredRow, recomputeHkIpoCompleteness, runHkexIpoProbe, stageForRow, syncStoredHkListings, upsertHkIpoFacts } = require('./hkexIpoFacts.js');

module.exports = {
  syncStoredHkListings,
  HKEX_NEW_LISTING_TARGETS,
  HKEX_NEW_LISTING_REPORT_TARGETS,
  HKEX_PREDEFINED_DOCUMENT_TARGETS,
  buildProbePlan,
  runHkexIpoProbe,
  persistHkexProbe,
  parseNewListingsHtml,
  parseNewListingReportWorkbook,
  fetchHkexNewListingReports,
  HKEX_NON_PUBLIC_LISTINGS,
  syncHkexNonPublicListings,
  syncHkexListingStatusNotices,
  classifyHkexIpoStatusNotice,
  cancellationTitleLooksLikeIpo,
  resolveHkexEnglishPdfUrl,
  parseHkexAllotmentPdf,
  allotmentTitleLooksLikeIpo,
  shouldPersistAllotmentFacts,
  isVerifiedAllotmentDocument,
  isReparsableAllotmentDocument,
  isUsableProspectusDocument,
  parseHkexProspectusPdf,
  fetchOfficialPdfWithCache,
  syncHkexAllotmentFacts,
  syncHkexPricingFacts,
  syncHkexProspectusFacts,
  syncHkexHistoricalReports,
  parsePredefinedDocumentHtml,
  upsertHkIpoFacts,
  recomputeCompletenessForStoredRow,
  recomputeHkIpoCompleteness,
  readHkIpoCompleteness,
  canonicalHkCode,
  normalizeDate,
  stageForRow,
};
