// 股票数据架构写入编排（批次1：SQL 已迁 server/repositories/stockProjectionRepository.js）。
// 本文件只负责事务边界、步骤顺序与兼容出口；不再直接持有 SQL。
// 导出签名与批次0 前保持一致，调用方（stockAnalysis、公司财报同步、脚本）无需改动。
const { withTransaction } = require('../db/transaction');
const { STOCK_FORMULA_VERSION } = require('./analysisFreshness');
const projection = require('../repositories/stockProjectionRepository');
const { hasUpstreamStatementEvidence } = require('../domain/financialReportEvidence');
const {
  analysisMetricValues, asDate, finite, hash, marketMultiple, rowVersion, stablePayload,
} = require('../domain/stockFacts');

// INC-0054 第一阶段：适配后的三表与指标不再逐条落原始报文。
// 同一份报告原先在 income/balance/cashflow/indicators 四个数据集各存一份近 10 KiB 的完整
// 副本（科目 + 比较值 + 覆盖清单），一天近 9.5 GiB。这些副本没有任何读端消费：
// 真实上游应答由 lixingerOfficial 按「来源＋请求键＋内容哈希」留在 ops.raw_records 并复用，
// 行内 __statement_coverage.audit 记录了这次采集的请求摘要、内容摘要与原始记录 ID，
// 科目值本身完整写入三张宽表，标准事实仍在 financial_reports / financial_facts。
const STATEMENT_DATASETS = new Set(['income', 'balance', 'cashflow', 'indicators']);

// 只有「已经有上游真实应答留证」的财报行才跳过逐条转换报文；备源（Tushare 等）不写
// lixinger_response，也没有 audit 指纹，停写就等于丢掉备源原始证据（第一阶段第 4 条）。
function shouldPersistRawDataset(dataset, row) {
  if (!STATEMENT_DATASETS.has(dataset)) return true;
  return !hasUpstreamStatementEvidence(row);
}

// 一次采集里各数据集的实际来源行数。缺 source_code 的行按 tushare 记账（数据层默认来源）。
function summarizeCollectionSources(bundle) {
  const counts = {};
  for (const [dataset, rows] of Object.entries(bundle || {})) {
    if (dataset === 'valuationIssues' || !Array.isArray(rows)) continue;
    for (const row of rows) {
      const code = String((row && row.source_code) || 'tushare');
      counts[code] = (counts[code] || 0) + 1;
    }
  }
  return counts;
}

async function persistCollectedData(metadata, bundle) {
  const tsCode = metadata.ts_code;
  return withTransaction(async client => {
    const sources = await projection.sourceIds(client);
    const master = await projection.ensureMaster(client, tsCode, sources, metadata);
    // 行里自带 source_code：写标准事实时按行取来源，不再一律记在 tushare 名下
    // （否则官方数值会以 tushare 名义落库，来源记录失真）。缺登记直接报错，不静默改来源。
    const sourceIdOf = row => {
      const code = (row && row.source_code) || 'tushare';
      const sourceId = sources[code];
      if (!sourceId) throw new Error(`未找到数据源登记：${code}`);
      return sourceId;
    };
    const groupBySource = rows => {
      const groups = new Map();
      for (const row of rows || []) {
        const code = (row && row.source_code) || 'tushare';
        if (!groups.has(code)) groups.set(code, []);
        groups.get(code).push(row);
      }
      return groups;
    };
    // 采集批次按真实来源登记（INC-0054 第一阶段第 3 条）：原先一律记在 tushare 名下，
    // 而四类财报报文实际来自理杏仁官方，事故回溯时无法从批次记录判断是谁写的。
    // 单来源批次直接记该来源；混合来源批次保留来源集合与逐来源行数，便于按来源核算字节与缺口。
    const sourceRowCounts = summarizeCollectionSources(bundle);
    const sourceCodes = Object.keys(sourceRowCounts).sort();
    const runSourceId = sourceCodes.length === 1 && sources[sourceCodes[0]] ? sources[sourceCodes[0]] : sources.tushare;
    const context = metadata.collection_context && typeof metadata.collection_context === 'object'
      ? metadata.collection_context : {};
    const runId = await projection.createIngestionRun({
      sourceId: runSourceId,
      datasetCode: 'stock_analysis_direct',
      requestRange: {
        ts_code: tsCode,
        source_codes: sourceCodes,
        source_row_counts: sourceRowCounts,
        // 调用标识：谁发起的采集（任务/脚本/人工），目标范围由上游透传，不在这里猜。
        caller: context.caller || null,
        caller_mode: context.callerMode || null,
        job_run_id: context.jobRunId || null,
        slot_id: context.slotId || null,
        target_range: context.targetRange || null,
      },
    }, client);
    let count = 0;
    for (const [dataset, rows] of Object.entries(bundle)) {
      if (dataset === 'valuationIssues' || !Array.isArray(rows)) continue;
      // 四类财报转换报文：只有已具备上游真实应答留证的行才停写（见文件顶部注释）。
      // 批次 row_count 仍按「实际落进 ops.raw_records 的行」计：已由理杏仁原文与审计指纹替代的行
      // 不计入，避免用转换副本的行数继续掩盖真实留证量。判断必须逐行进行（混合来源同一数据集）。
      for (const row of rows) {
        if (!shouldPersistRawDataset(dataset, row)) continue;
        await projection.insertRawRecord({
          runId, sourceId: sourceIdOf(row), datasetCode: dataset,
          sourceKey: `${tsCode}:${rowVersion(row)}`, payload: row, payloadHash: hash(JSON.stringify(row)),
        }, client);
        count += 1;
      }
    }
    for (const [kind, rows] of [['income', bundle.income], ['balance', bundle.balance], ['cashflow', bundle.cashflow], ['indicator', bundle.indicators]]) {
      for (const [code, group] of groupBySource(rows)) {
        const sourceId = sources[code];
        if (!sourceId) throw new Error(`未找到数据源登记：${code}`);
        // 金额币种按证券主档兜底（港股 HKD），行内自带币种时以行为准（R2-03）。
        await projection.syncReportRows(client, group, kind, master.companyId, sourceId, { currency: master.currency, tsCode });
      }
    }
    const daily = new Map((bundle.daily || []).map(x => [x.trade_date, x]));
    const basic = new Map((bundle.basics || []).map(x => [x.trade_date, x]));
    const factors = new Map((bundle.factors || []).map(x => [x.trade_date, x]));
    for (const date of new Set([...daily.keys(), ...basic.keys(), ...factors.keys()])) {
      const d = daily.get(date) || {}, b = basic.get(date) || {}, a = factors.get(date) || {}, day = asDate(date);
      if (!day) continue;
      if (finite(d.close) !== null) {
        await projection.upsertDailyBar({ instrumentId: master.instrumentId, tradeDate: day, sourceId: sourceIdOf(d), close: finite(d.close) }, client);
      }
      if (finite(a.adj_factor) !== null) {
        await projection.upsertAdjustmentFactor({ instrumentId: master.instrumentId, tradeDate: day, sourceId: sourceIdOf(a), adjFactor: finite(a.adj_factor) }, client);
      }
      if (basic.has(date)) {
        await projection.upsertDailyValuation({
          instrumentId: master.instrumentId, tradeDate: day, sourceId: sourceIdOf(b),
          peStatic: marketMultiple(b.pe), peTtm: marketMultiple(b.pe_ttm), pb: marketMultiple(b.pb),
          dividendYield: finite(b.dv_ttm) == null ? null : finite(b.dv_ttm) / 100,
          totalMarketCap: finite(b.total_mv) == null ? null : finite(b.total_mv) * 10000,
          circulatingMarketCap: finite(b.circ_mv) == null ? null : finite(b.circ_mv) * 10000,
          freeFloatMarketCap: finite(d.close) == null || finite(b.free_share) == null ? null : finite(d.close) * finite(b.free_share) * 10000,
          currencyCode: master.currency,
        }, client);
      }
      if ([b.total_share, b.float_share, b.free_share].some(x => finite(x) !== null)) {
        // 股本字段来自备源（官方估值接口不提供股本），来源按 share_source_code 单独取。
        const shareCode = b.share_source_code || b.source_code || 'tushare';
        const shareSourceId = sources[shareCode];
        if (!shareSourceId) throw new Error(`未找到数据源登记：${shareCode}`);
        await projection.upsertShareCapital({
          instrumentId: master.instrumentId, effectiveDate: day, sourceId: shareSourceId,
          totalShares: finite(b.total_share) == null ? null : finite(b.total_share) * 10000,
          circulatingShares: finite(b.float_share) == null ? null : finite(b.float_share) * 10000,
          freeFloatShares: finite(b.free_share) == null ? null : finite(b.free_share) * 10000,
        }, client);
      }
    }
    const orderedDividends = projection.orderDividendBatchForUpsert(bundle.dividends || []);
    const officialBatchPeers = projection.dividendBatchPeersOf(
      orderedDividends.filter(row => row && row.is_default_source === false && row.end_date),
      tsCode,
    );
    const officialBatchDividendKeys = [...new Set(officialBatchPeers.map(p => p.key))];
    for (const r of orderedDividends) {
      const cash = finite(r.cash_div_tax), base = finite(r.base_share);
      // 来源直接给出分红总额时以它为准（港股常无 base_share），币种也按行落库，不硬编码 CNY（R2-03）。
      const declaredTotal = finite(r.total_cash_amount);
      const totalCash = declaredTotal != null
        ? declaredTotal
        : (cash == null || base == null ? null : cash * base * 10000);
      // 官方（非默认来源）行改按自己的来源落库，不再记在备源名下。键必须与
      // stockProjectionRepository.syncOfficialDividends 用的一致（同一来源、同一事件、同一行），
      // 否则 refreshDividends 里那条「另写标准分红事实」会再插一条同源副本，现金收益择一时出现并列。
      // 备源行同样按事件身份建键（INC-0054）：整条报文哈希会让补录或文字微调各生成一条新记录。
      const rowSourceId = sourceIdOf(r);
      const sourceKey = r.is_default_source === false
        ? projection.officialDividendSourceKey(r, tsCode)
        : await projection.resolveDefaultDividendSourceKey(client, {
          instrumentId: master.instrumentId, sourceId: rowSourceId, row: r, fallbackCode: tsCode,
        });
      const writtenKey = await projection.upsertCorporateAction({
        instrumentId: master.instrumentId, fiscalPeriodEnd: asDate(r.end_date), announcedAt: asDate(r.ann_date || r.imp_ann_date),
        recordDate: asDate(r.record_date), exDate: asDate(r.ex_date), payDate: asDate(r.pay_date), status: r.div_proc || '',
        cashPerSharePreTax: cash, cashPerShareAfterTax: finite(r.cash_div), stockDividendRatio: finite(r.stk_bo_rate), capitalizationRatio: finite(r.stk_co_rate),
        baseShares: base == null ? null : base * 10000, totalCashAmount: totalCash,
        currencyCode: String(r.currency || master.currency || 'CNY').toUpperCase(),
        sourceId: rowSourceId, sourceKey,
        legacySourceKeys: r.is_default_source === false ? projection.legacyOfficialDividendSourceKeys(r, master.instrumentId, tsCode) : [],
        protectedSourceKeys: r.is_default_source === false ? officialBatchDividendKeys : [],
        batchPeers: r.is_default_source === false ? officialBatchPeers : [],
        rawPayload: r,
      }, client);
      if (r.is_default_source === false && writtenKey && !officialBatchDividendKeys.includes(writtenKey)) {
        officialBatchDividendKeys.push(writtenKey);
      }
    }
    for (const r of bundle.forecasts || []) {
      if (!asDate(r.end_date)) continue;
      // 来源按行取（原先固定记 tushare，备源/官方混用时来源失真），
      // 键改为「同一期、同一类型、同一公告日」的事件身份，摘要文字微调不再新增一条预告。
      const forecastSourceId = sourceIdOf(r);
      const sourceKey = await projection.resolveEarningsGuidanceSourceKey(client, {
        companyId: master.companyId, sourceId: forecastSourceId, row: r, fallbackCode: tsCode,
      });
      await projection.upsertEarningsGuidance({
        companyId: master.companyId, periodEnd: asDate(r.end_date), guidanceType: r.type || 'forecast', announcedAt: asDate(r.ann_date),
        profitMin: finite(r.net_profit_min) == null ? null : finite(r.net_profit_min) * 10000,
        profitMax: finite(r.net_profit_max) == null ? null : finite(r.net_profit_max) * 10000,
        changeMin: finite(r.p_change_min), changeMax: finite(r.p_change_max), summary: r.summary || '', changeReason: r.change_reason || '',
        sourceId: forecastSourceId, sourceKey, rawPayload: r,
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
  summarizeCollectionSources,
  shouldPersistRawDataset,
  saveCollectedEvents,
  saveAnalysisResults,
};
