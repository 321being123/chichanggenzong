// 股票数据架构写入编排（批次1：SQL 已迁 server/repositories/stockProjectionRepository.js）。
// 本文件只负责事务边界、步骤顺序与兼容出口；不再直接持有 SQL。
// 导出签名与批次0 前保持一致，调用方（stockAnalysis、公司财报同步、脚本）无需改动。
const { withTransaction } = require('../db/transaction');
const { STOCK_FORMULA_VERSION } = require('./analysisFreshness');
const projection = require('../repositories/stockProjectionRepository');
const {
  analysisMetricValues, asDate, finite, hash, marketMultiple, rowVersion, stablePayload,
} = require('../domain/stockFacts');

async function persistCollectedData(metadata, bundle) {
  const tsCode = metadata.ts_code;
  return withTransaction(async client => {
    const sources = await projection.sourceIds(client);
    const master = await projection.ensureMaster(client, tsCode, sources, metadata);
    const runId = await projection.createIngestionRun({
      sourceId: sources.tushare, datasetCode: 'stock_analysis_direct', requestRange: { ts_code: tsCode },
    }, client);
    let count = 0;
    for (const [dataset, rows] of Object.entries(bundle)) {
      if (dataset === 'valuationIssues' || !Array.isArray(rows)) continue;
      for (const row of rows) {
        await projection.insertRawRecord({
          runId, sourceId: sources.tushare, datasetCode: dataset,
          sourceKey: `${tsCode}:${rowVersion(row)}`, payload: row, payloadHash: hash(JSON.stringify(row)),
        }, client);
        count += 1;
      }
    }
    await projection.syncReportRows(client, bundle.income || [], 'income', master.companyId, sources.tushare);
    await projection.syncReportRows(client, bundle.balance || [], 'balance', master.companyId, sources.tushare);
    await projection.syncReportRows(client, bundle.cashflow || [], 'cashflow', master.companyId, sources.tushare);
    await projection.syncReportRows(client, bundle.indicators || [], 'indicator', master.companyId, sources.tushare);
    const daily = new Map((bundle.daily || []).map(x => [x.trade_date, x]));
    const basic = new Map((bundle.basics || []).map(x => [x.trade_date, x]));
    const factors = new Map((bundle.factors || []).map(x => [x.trade_date, x]));
    for (const date of new Set([...daily.keys(), ...basic.keys(), ...factors.keys()])) {
      const d = daily.get(date) || {}, b = basic.get(date) || {}, a = factors.get(date) || {}, day = asDate(date);
      if (!day) continue;
      if (finite(d.close) !== null) {
        await projection.upsertDailyBar({ instrumentId: master.instrumentId, tradeDate: day, sourceId: sources.tushare, close: finite(d.close) }, client);
      }
      if (finite(a.adj_factor) !== null) {
        await projection.upsertAdjustmentFactor({ instrumentId: master.instrumentId, tradeDate: day, sourceId: sources.tushare, adjFactor: finite(a.adj_factor) }, client);
      }
      if (basic.has(date)) {
        await projection.upsertDailyValuation({
          instrumentId: master.instrumentId, tradeDate: day, sourceId: sources.tushare,
          peStatic: marketMultiple(b.pe), peTtm: marketMultiple(b.pe_ttm), pb: marketMultiple(b.pb),
          dividendYield: finite(b.dv_ttm) == null ? null : finite(b.dv_ttm) / 100,
          totalMarketCap: finite(b.total_mv) == null ? null : finite(b.total_mv) * 10000,
          circulatingMarketCap: finite(b.circ_mv) == null ? null : finite(b.circ_mv) * 10000,
          freeFloatMarketCap: finite(d.close) == null || finite(b.free_share) == null ? null : finite(d.close) * finite(b.free_share) * 10000,
          currencyCode: master.currency,
        }, client);
      }
      if ([b.total_share, b.float_share, b.free_share].some(x => finite(x) !== null)) {
        await projection.upsertShareCapital({
          instrumentId: master.instrumentId, effectiveDate: day, sourceId: sources.tushare,
          totalShares: finite(b.total_share) == null ? null : finite(b.total_share) * 10000,
          circulatingShares: finite(b.float_share) == null ? null : finite(b.float_share) * 10000,
          freeFloatShares: finite(b.free_share) == null ? null : finite(b.free_share) * 10000,
        }, client);
      }
    }
    for (const r of bundle.dividends || []) {
      const cash = finite(r.cash_div_tax), base = finite(r.base_share);
      await projection.upsertCorporateAction({
        instrumentId: master.instrumentId, fiscalPeriodEnd: asDate(r.end_date), announcedAt: asDate(r.ann_date || r.imp_ann_date),
        recordDate: asDate(r.record_date), exDate: asDate(r.ex_date), payDate: asDate(r.pay_date), status: r.div_proc || '',
        cashPerSharePreTax: cash, cashPerShareAfterTax: finite(r.cash_div), stockDividendRatio: finite(r.stk_bo_rate), capitalizationRatio: finite(r.stk_co_rate),
        baseShares: base == null ? null : base * 10000, totalCashAmount: cash == null || base == null ? null : cash * base * 10000,
        sourceId: sources.tushare, sourceKey: `${tsCode}:${rowVersion(r)}`, rawPayload: r,
      }, client);
    }
    for (const r of bundle.forecasts || []) {
      if (!asDate(r.end_date)) continue;
      await projection.upsertEarningsGuidance({
        companyId: master.companyId, periodEnd: asDate(r.end_date), guidanceType: r.type || 'forecast', announcedAt: asDate(r.ann_date),
        profitMin: finite(r.net_profit_min) == null ? null : finite(r.net_profit_min) * 10000,
        profitMax: finite(r.net_profit_max) == null ? null : finite(r.net_profit_max) * 10000,
        changeMin: finite(r.p_change_min), changeMax: finite(r.p_change_max), summary: r.summary || '', changeReason: r.change_reason || '',
        sourceId: sources.tushare, sourceKey: `${tsCode}:${rowVersion(r)}`, rawPayload: r,
      }, client);
    }
    if (['income', 'balance', 'cashflow', 'indicators'].some(kind => (bundle[kind] || []).length)) {
      await projection.upsertFinancialCursor({ instrumentId: master.instrumentId, companyId: master.companyId }, client);
    }
    for (const issue of bundle.valuationIssues || []) {
      await projection.insertQualityIssue({
        instrumentId: master.instrumentId, companyId: master.companyId, datasetCode: 'daily_basic',
        fieldCode: issue.field, issueType: 'zero_after_retry', details: issue,
      }, client);
    }
    await projection.finishIngestionRun({ runId, rowCount: count }, client);
    return master;
  });
}

async function saveCollectedEvents(tsCode, events) {
  return withTransaction(async client => {
    const sources = await projection.sourceIds(client);
    const master = await projection.ensureMaster(client, tsCode, sources);
    for (const r of events) {
      const source = sources[r.source] || sources.calculated;
      const key = hash(`${tsCode}|${r.source}|${r.url}|${r.title}`);
      const documentId = r.is_official ? await projection.upsertDocument({
        companyId: master.companyId, documentType: r.category || 'announcement', title: r.title,
        announcedAt: asDate(r.event_date), url: r.url || '', sourceId: source, contentHash: hash(r.title), rawPayload: r.raw || {},
      }, client) : null;
      await projection.upsertCompanyEvent({
        companyId: master.companyId, eventType: r.category || 'other', eventDate: asDate(r.event_date), title: r.title,
        importance: r.is_official ? 10 : 1, isOfficial: Boolean(r.is_official), sourceId: source,
        documentId, sourceKey: key, details: r.raw || {},
      }, client);
    }
  });
}

async function saveAnalysisResults(tsCode, analysis) {
  return withTransaction(async client => {
    const sources = await projection.sourceIds(client);
    const master = await projection.ensureMaster(client, tsCode, sources);
    await projection.syncAnalytics(client, master.instrumentId, analysis, sources, STOCK_FORMULA_VERSION);
    await projection.syncQualityIssues(client, master.instrumentId, master.companyId, analysis);
  });
}

// 2026-10-30 删除：syncStockToArchitecture 与 backfillLegacyFinancialData。
// 这两条是「股票分析 → 标准化层」迁移的半成品：内部读写 stock_daily_valuations / stock_dividends /
// stock_forecasts / stock_events / stock_data_sync_state / stock_analysis_* 七张旧表，而它们在
// migration008 已删除，所以一旦调用必然整事务报错。核查确认无任何路由/任务/脚本调用（只有测试里
// 断言过导出名），且同类事实已由 persistCollectedData（原文/主档）、saveCollectedEvents（公告事件）、
// saveAnalysisResults（指标与质量）三条活路径承担。删除后不再保留这两条死入口，避免有人"复用"后
// 在生产事务里踩雷。

module.exports = {
  // 兼容出口：纯函数仍从本模块可导入，实现只有 domain/stockFacts 一份
  asDate,
  finite,
  analysisMetricValues,
  hash,
  rowVersion,
  stablePayload,
  // 兼容出口：报表事实写入仍在同一仓储实现
  syncReportRows: projection.syncReportRows,
  persistCollectedData,
  saveCollectedEvents,
  saveAnalysisResults,
};
