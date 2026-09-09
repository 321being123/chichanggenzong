const { runHkexIpoProbe, persistHkexProbe, upsertHkIpoFacts, syncHkexHistoricalReports, syncHkexNonPublicListings, syncHkexProspectusFacts, syncHkexAllotmentFacts } = require('../services/hkexIpo');
const { syncHkDailyCoverage } = require('../services/hkDailyCoverage');
const { syncHkIpoMarketSignals } = require('../services/hkIpoMarketSignals');
const { pool } = require('../db/connection');
const { fetchTencentQuotes } = require('../services/tencentQuote');

const MAX_TENCENT_NAME_BATCH = 80;

function canonicalHkCode(rawCode) {
  const text = String(rawCode || '').trim().toUpperCase();
  const match = text.match(/^(?:HK)?(\d{1,5})(?:\.HK)?$/);
  return match ? `${match[1].padStart(5, '0')}.HK` : null;
}

function hasChineseName(value) {
  return /[\u3400-\u9fff]/.test(String(value || '').trim());
}

async function persistTencentNames(quoteMap, { executor = pool.query.bind(pool) } = {}) {
  const updates = new Map();
  for (const quote of (quoteMap instanceof Map ? quoteMap.values() : [])) {
    if (!quote || !hasChineseName(quote.name)) continue;
    const code = canonicalHkCode(quote.code || quote.symbol);
    if (code) updates.set(code, String(quote.name).trim());
  }
  let persisted = 0;
  for (const [code, name] of updates) {
    const result = await executor(`
      UPDATE public.ipo_history
         SET security_name_cn=$2,updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
       WHERE market_code='HK'
         AND security_code=$1
         AND COALESCE(NULLIF(security_name_cn,''),'')=''`, [code, name]);
    persisted += Number(result?.rowCount || 0);
  }
  return { requested: quoteMap instanceof Map ? quoteMap.size : 0, named: updates.size, persisted, source: 'tencent' };
}

async function syncHkIpoTencentNames(seedCodes = [], { batchSize = MAX_TENCENT_NAME_BATCH, businessDate, ttlMs, executor = pool.query.bind(pool) } = {}) {
  const limit = Math.min(MAX_TENCENT_NAME_BATCH, Math.max(1, Number(batchSize) || MAX_TENCENT_NAME_BATCH));
  const candidates = await executor(`
    SELECT security_code
      FROM public.ipo_history
     WHERE market_code='HK'
       AND COALESCE(NULLIF(security_name_cn,''),'')=''
     ORDER BY CASE WHEN listing_at IS NOT NULL OR ipo_status='listed' THEN 0 ELSE 1 END,
              COALESCE(listing_at,NULLIF(updated_at,'')::timestamptz) DESC NULLS LAST,security_code
     LIMIT $1`, [limit]);
  const codes = [];
  const seen = new Set();
  for (const raw of [...(Array.isArray(seedCodes) ? seedCodes : []), ...(candidates.rows || []).map(row => row.security_code)]) {
    const code = canonicalHkCode(raw);
    if (code && !seen.has(code)) { seen.add(code); codes.push(code); }
    if (codes.length >= limit) break;
  }
  if (!codes.length) return { requested: 0, quoted: 0, named: 0, persisted: 0, source: 'tencent' };
  const quotes = await fetchTencentQuotes(codes, { businessDate, ttlMs });
  const named = new Set();
  for (const quote of quotes.values()) if (quote && hasChineseName(quote.name)) named.add(canonicalHkCode(quote.code || quote.symbol));
  const persisted = await persistTencentNames(quotes, { executor });
  return { ...persisted, requested: codes.length, quoted: quotes.size, candidateCount: candidates.rowCount || 0 };
}

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
  if (!rows.length) {
    // 空结果不能被解释为“没有新股”：保留探针证据，并让调度器按失败/降级处理。
    return { ok: false, mode, reason: 'no_verified_rows', probe, probePersistence, rows: 0, publishDatasets: false, degraded: true };
  }

  // 先落主事实，再执行历史报表、官方 PDF 和市场信号补全，避免补全任务看不到本轮新发现的代码。
  const result = await upsertHkIpoFacts(rows);
  let historicalReports = null;
  const shouldSyncHistorical = context.syncHistoricalReports === true
    || ((mode === 'postclose' || mode === 'enrichment') && context.syncHistoricalReports !== false);
  if (shouldSyncHistorical) {
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
  let tencentNames = null;
  try {
    tencentNames = await syncHkIpoTencentNames(rows.map(row => row.securityCode), context.tencentNameOptions || {});
  } catch (error) {
    tencentNames = { ok: false, status: 'failed', error: error.message || String(error) };
  }
  const subtasks = [historicalReports, nonPublicListings, prospectusFacts, allotmentFacts, dailyCoverage, marketSignals, tencentNames].filter(Boolean);
  // 腾讯名称、暗盘和日线属于补充信号；这些可选来源失败时保留官方事实发布，
  // 只把历史报表/非公众分类/招股书/配发结果等核心事实失败标成不可发布。
  const coreSubtasks = [historicalReports, nonPublicListings, prospectusFacts, allotmentFacts].filter(Boolean);
  const failedSubtasks = coreSubtasks.filter(item => item.ok === false);
  const degraded = subtasks.some(item => item.ok === false || item.status === 'degraded');
  return {
    ...result, ok: failedSubtasks.length === 0, status: degraded ? 'degraded' : 'succeeded', degraded,
    failedDatasets: failedSubtasks.length ? ['hk_ipo_facts'] : [],
    mode, probePersistence, historicalReports, nonPublicListings, prospectusFacts, allotmentFacts,
    dailyCoverage, marketSignals, tencentNames, probeTargets: (probe.targets || []).length,
    dataAsOf: new Date().toISOString().slice(0, 10),
  };
}

module.exports = { runHkIpoSync, rowsFromProbe, persistTencentNames, syncHkIpoTencentNames };
