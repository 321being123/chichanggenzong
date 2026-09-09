const { runHkexIpoProbe, persistHkexProbe, upsertHkIpoFacts, syncHkexHistoricalReports, syncHkexNonPublicListings, syncHkexProspectusFacts, syncHkexAllotmentFacts } = require('../services/hkexIpo');
const { syncHkDailyCoverage } = require('../services/hkDailyCoverage');
const { syncHkIpoMarketSignals } = require('../services/hkIpoMarketSignals');

function rowsFromProbe(probe) {
  const rows = [];
  for (const target of (probe && probe.targets) || []) {
    if (!target.ok || !Array.isArray(target.items)) continue;
    for (const item of target.items) {
      if (!item.securityCode) continue;
      const row = {
        securityCode: item.securityCode,
      };
      for (const [key, value] of Object.entries({
        securityName: item.securityName,
        board: item.board || target.board,
        listingDate: item.listingDate,
        offerOpenDate: item.offerOpenDate,
        offerCloseDate: item.offerCloseDate,
        pricingDate: item.pricingDate,
        allotmentDate: item.allotmentDate,
        issuePriceLow: item.issuePriceLow,
        issuePriceHigh: item.issuePriceHigh,
        issuePriceFinal: item.issuePriceFinal,
        lotSizeShares: item.lotSizeShares,
        sourceUrl: item.sourceUrl || target.url,
      })) {
        if (value !== undefined && value !== null && value !== '') row[key] = value;
      }
      const documentUrl = item.documentUrl || item.url;
      if (documentUrl) row.sourceDocuments = [{ type: item.documentType || 'new_listing', url: documentUrl, title: item.title || item.securityName || '' }];
      rows.push(row);
    }
  }
  const seen = new Map();
  for (const row of rows) {
    const current = seen.get(row.securityCode) || {};
    const merged = { ...current };
    for (const [key, value] of Object.entries(row)) {
      if (key === 'sourceDocuments') continue;
      if (value !== undefined && value !== null && value !== '') merged[key] = value;
    }
    const documents = [...(current.sourceDocuments || []), ...(row.sourceDocuments || [])];
    if (documents.length) {
      const unique = new Map(documents.map(document => [`${document.type || ''}|${document.url || ''}`, document]));
      merged.sourceDocuments = [...unique.values()];
    }
    seen.set(row.securityCode, merged);
  }
  return [...seen.values()];
}

async function runHkIpoSync(mode = 'preopen', reason = 'scheduled', context = {}) {
  const probe = context.probe || await runHkexIpoProbe({
    targets: context.targets,
    fetchImpl: context.fetchImpl,
  });
  let probePersistence = null;
  if (context.persistProbe !== false) {
    try {
      probePersistence = await persistHkexProbe(probe, {
        environment: context.probeEnvironment || process.env.HKEX_PROBE_ENVIRONMENT || (process.env.NODE_ENV === 'production' ? 'server' : 'local'),
      });
    } catch (error) {
      probePersistence = { ok: false, error: error.message || String(error) };
    }
  }
  const rows = rowsFromProbe(probe);
  let historicalReports = null;
  if (context.syncHistoricalReports === true) {
    try {
      historicalReports = await syncHkexHistoricalReports(context.historicalOptions || {});
    } catch (error) {
      historicalReports = { ok: false, status: 'failed', error: error.message || String(error) };
    }
  }
  let dailyCoverage = null;
  let nonPublicListings = null;
  let prospectusFacts = null;
  let allotmentFacts = null;
  let marketSignals = null;
  if (mode === 'preopen' || mode === 'enrichment') {
    try {
      marketSignals = await syncHkIpoMarketSignals({
        mode,
        ...(context.marketSignalOptions || {}),
      });
    } catch (error) {
      marketSignals = { ok: false, status: 'failed', error: error.message || String(error) };
    }
  }
  if (mode === 'enrichment') {
    if (context.syncNonPublic !== false) {
      try {
        nonPublicListings = await syncHkexNonPublicListings(context.nonPublicOptions || {});
      } catch (error) {
        nonPublicListings = { ok: false, status: 'failed', error: error.message || String(error) };
      }
    }
    if (context.syncProspectus !== false) {
      try {
        prospectusFacts = await syncHkexProspectusFacts({
          ...(context.prospectusOptions || {}),
          refreshSponsor: context.refreshSponsor === true || context.prospectusOptions?.refreshSponsor === true
            || String(process.env.HK_IPO_REFRESH_SPONSOR || '').toLowerCase() === 'true',
          limit: context.prospectusOptions?.limit || Number(process.env.HK_IPO_PROSPECTUS_LIMIT || 18),
        });
      } catch (error) {
        prospectusFacts = { ok: false, status: 'failed', error: error.message || String(error) };
      }
    }
    if (context.syncAllotment !== false) {
      try {
        allotmentFacts = await syncHkexAllotmentFacts({
          ...(context.allotmentOptions || {}),
          limit: context.allotmentOptions?.limit || Number(process.env.HK_IPO_ALLOTMENT_LIMIT || 20),
        });
      } catch (error) {
        allotmentFacts = { ok: false, status: 'failed', error: error.message || String(error) };
      }
    }
    if (context.syncDaily !== false) {
      try {
        dailyCoverage = await syncHkDailyCoverage({
          ...(context.dailyOptions || {}),
          limit: context.dailyOptions?.limit || Number(process.env.HK_DAILY_SYNC_LIMIT || 20),
        });
      } catch (error) {
        dailyCoverage = { ok: false, status: 'failed', error: error.message || String(error) };
      }
    }
  }
  if (!rows.length) {
    // 空结果不能被解释为“没有新股”：保留探针证据，并让调度器按失败/降级处理。
    return { ok: false, mode, reason: 'no_verified_rows', probe, probePersistence, historicalReports, nonPublicListings, prospectusFacts, allotmentFacts, dailyCoverage, marketSignals, rows: 0, publishDatasets: false, degraded: true };
  }
  const result = await upsertHkIpoFacts(rows);
  return { ...result, mode, probePersistence, historicalReports, nonPublicListings, prospectusFacts, allotmentFacts, dailyCoverage, marketSignals, probeTargets: (probe.targets || []).length, dataAsOf: new Date().toISOString().slice(0, 10) };
}

module.exports = { runHkIpoSync, rowsFromProbe };
