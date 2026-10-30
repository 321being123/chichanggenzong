// 股票标准投影仓储（批次1，从 financialDataArchitecture 迁入的 SQL 写入）。
// 合同：method(params..., client) 的第一个参数始终是调用方事务 client；
// 本文件只做 SQL 与标准事实写入，不判断业务规则、不触发外采、不自行 BEGIN/COMMIT。
const { ensureInstrumentIdentity } = require('../services/securityIdentity');
const {
  FACT_MAP, METRICS, analysisMetricValues, asDate, finite, hash, periodType, rowVersion, stablePayload,
} = require('../domain/stockFacts');

async function sourceIds(client) {
  const { rows } = await client.query('SELECT source_code,source_id FROM ops.data_sources');
  return Object.fromEntries(rows.map(row => [row.source_code, row.source_id]));
}

async function ensureMaster(client, tsCode, sources, metadata) {
  let legacy = metadata ? { ...metadata, data: metadata } : null;
  if (!legacy) {
    const current = (await client.query(`SELECT canonical_code ts_code,name,market,to_char(list_date,'YYYYMMDD') list_date,raw_data data FROM core.instruments WHERE canonical_code=$1`, [tsCode])).rows[0];
    legacy = current ? { ...current, industry: current.data?.industry || '' } : null;
  }
  if (!legacy) throw new Error(`缺少证券基础资料：${tsCode}`);
  const raw = legacy.data || {}, exchange = tsCode.endsWith('.SH') ? 'SSE' : tsCode.endsWith('.BJ') ? 'BSE' : 'SZSE';
  const currency = tsCode.endsWith('.HK') ? 'HKD' : 'CNY', assetClass='stock';
  const master = await ensureInstrumentIdentity({ canonicalCode: tsCode, name: legacy.name || '', assetClass, market: legacy.market || (tsCode.endsWith('.HK') ? 'HK' : 'CN'), exchangeCode: exchange, currencyCode: currency, listDate: asDate(legacy.list_date), status: 'listed', rawData: raw, companyName: legacy.name || tsCode }, client.query.bind(client));
  const company = { company_id: master.companyId };
  const instrument = { instrument_id: master.instrumentId };
  const industryName = raw.industry || legacy.industry || '', system = raw.industry_system || 'Tushare基础行业', levelText = raw.industry_level || '';
  if (industryName) {
    const taxonomyCode = /申万/.test(system) ? 'SW2021' : 'TUSHARE_BASIC';
    const taxonomy = (await client.query('SELECT taxonomy_id FROM core.industry_taxonomies WHERE taxonomy_code=$1', [taxonomyCode])).rows[0];
    const industryCode = String(raw.industry_code || hash(`${taxonomyCode}|${industryName}`).slice(0, 16));
    const level = Number((String(levelText).match(/\d+/) || [])[0]) || null;
    const node = (await client.query(`INSERT INTO core.industry_nodes(taxonomy_id,industry_code,industry_name,level) VALUES($1,$2,$3,$4)
      ON CONFLICT(taxonomy_id,industry_code) DO UPDATE SET industry_name=EXCLUDED.industry_name,level=COALESCE(EXCLUDED.level,core.industry_nodes.level) RETURNING industry_node_id`, [taxonomy.taxonomy_id, industryCode, industryName, level])).rows[0];
    await client.query(`UPDATE core.company_industry_memberships SET is_current=false,valid_to=CURRENT_DATE WHERE company_id=$1 AND is_current=true AND industry_node_id<>$2`, [company.company_id, node.industry_node_id]);
    await client.query(`INSERT INTO core.company_industry_memberships(company_id,industry_node_id,source_id,valid_from,is_current)
      VALUES($1,$2,$3,$4,true) ON CONFLICT(company_id,industry_node_id,valid_from) DO UPDATE SET is_current=true,valid_to=NULL,source_id=EXCLUDED.source_id`, [company.company_id, node.industry_node_id, sources[raw.industry_source || 'tushare'], asDate(legacy.list_date)]);
  }
  const controller = raw.actual_controller;
  if (controller && controller.name) {
    await client.query(`UPDATE core.company_controllers SET is_current=false,valid_to=CURRENT_DATE WHERE company_id=$1 AND is_current=true AND controller_name<>$2`, [company.company_id, controller.name]);
    await client.query(`INSERT INTO core.company_controllers(company_id,controller_name,controller_type,control_ratio,source_id,valid_from,is_current,confidence,raw_data)
      VALUES($1,$2,$3,$4,$5,$6,true,$7,$8::jsonb) ON CONFLICT(company_id,controller_name,valid_from) DO UPDATE SET controller_type=EXCLUDED.controller_type,control_ratio=EXCLUDED.control_ratio,is_current=true,raw_data=EXCLUDED.raw_data`,
      [company.company_id, controller.name, controller.type || 'other', finite(controller.hold_ratio), sources.eastmoney, asDate(legacy.list_date), controller.name ? 0.8 : null, JSON.stringify(controller)]);
  }
  return { companyId: company.company_id, instrumentId: instrument.instrument_id, legacy, currency };
}

async function syncReportRows(client, rows, kind, companyId, sourceId, options = {}) {
  for (const data of rows) {
    if (!asDate(data.end_date)) continue;
    if (options.reportTypeOnly && String(data.report_type || '') !== String(options.reportTypeOnly)) continue;
    const sourceVersion = rowVersion(data), announced = asDate(data.ann_date), fAnnDate = asDate(data.f_ann_date || data.ann_date);
    let rawRecordId = null;
    if (options.runId && sourceId) {
      const rawKey = `${companyId}:${kind}:${asDate(data.end_date)}:${announced || ''}:${fAnnDate || ''}:${data.report_type || ''}:${data.update_flag || ''}`;
      const raw = (await client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
        ON CONFLICT(source_id,dataset_code,source_key,payload_hash)
        DO UPDATE SET run_id=EXCLUDED.run_id
        RETURNING raw_record_id`,
      [options.runId, sourceId, `stock_financial_${kind}`, rawKey, fAnnDate || announced, JSON.stringify(data), hash(JSON.stringify(stablePayload(data)))]
      )).rows[0];
      rawRecordId = raw && raw.raw_record_id;
    }
    const report = (await client.query(`INSERT INTO fundamental.financial_reports(company_id,report_kind,period_end,period_type,announced_at,f_ann_date,report_type,comp_type,source_id,source_version,update_flag,raw_record_id,raw_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT(company_id,report_kind,period_end,source_id,source_version)
      DO UPDATE SET announced_at=COALESCE(EXCLUDED.announced_at,fundamental.financial_reports.announced_at),
        f_ann_date=COALESCE(EXCLUDED.f_ann_date,fundamental.financial_reports.f_ann_date),
        report_type=COALESCE(NULLIF(EXCLUDED.report_type,''),fundamental.financial_reports.report_type),
        comp_type=COALESCE(NULLIF(EXCLUDED.comp_type,''),fundamental.financial_reports.comp_type),
        update_flag=COALESCE(NULLIF(EXCLUDED.update_flag,''),fundamental.financial_reports.update_flag),
        raw_record_id=COALESCE(EXCLUDED.raw_record_id,fundamental.financial_reports.raw_record_id),
        raw_payload=EXCLUDED.raw_payload,ingested_at=now() RETURNING report_id`,
    [companyId, kind, asDate(data.end_date), periodType(data.end_date), announced, fAnnDate, String(data.report_type || ''), String(data.comp_type || ''), sourceId, sourceVersion, data.update_flag || '', rawRecordId, JSON.stringify(data)])).rows[0];
    await client.query(`UPDATE fundamental.financial_reports
      SET f_ann_date=COALESCE($2,f_ann_date),report_type=COALESCE(NULLIF($3,''),report_type),comp_type=COALESCE(NULLIF($4,''),comp_type),statement_scope=CASE WHEN $3='1' THEN 'consolidated' ELSE statement_scope END,
      raw_record_id=COALESCE($5,raw_record_id)
      WHERE report_id=$1`, [report.report_id, fAnnDate, String(data.report_type || ''), String(data.comp_type || ''), rawRecordId]);
    for (const [sourceField, metricCode] of Object.entries(FACT_MAP[kind] || {})) {
      const value = finite(data[sourceField]);
      if (value === null) continue;
      const unit = metricCode === 'interest_coverage' ? 'multiple' : /roe|roa/.test(metricCode) ? 'percent' : 'currency';
      await client.query(`INSERT INTO fundamental.financial_facts(report_id,statement_type,metric_code,numeric_value,unit_code,currency_code,source_field)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(report_id,metric_code) DO UPDATE SET numeric_value=EXCLUDED.numeric_value,unit_code=EXCLUDED.unit_code,source_field=EXCLUDED.source_field`, [report.report_id, kind, metricCode, value, unit, unit === 'currency' ? 'CNY' : null, sourceField]);
    }
  }
  await client.query(`WITH ranked AS (SELECT report_id,row_number() OVER(PARTITION BY company_id,report_kind,period_end ORDER BY CASE WHEN report_type='1' THEN 0 ELSE 1 END,announced_at DESC NULLS LAST,ingested_at DESC,report_id DESC) rn FROM fundamental.financial_reports WHERE company_id=$1 AND report_kind=$2) UPDATE fundamental.financial_reports r SET is_current_version=(ranked.rn=1) FROM ranked WHERE r.report_id=ranked.report_id`, [companyId, kind]);
}

// formulaVersion 由编排层传入，仓储不依赖 services 常量模块。
async function syncAnalytics(client, instrumentId, analysis, sources, formulaVersion) {
  if (!analysis) return;
  for (const [code, [name, category, unit]] of Object.entries(METRICS)) {
    await client.query(`INSERT INTO analytics.metric_definitions(metric_code,metric_name,category,unit_code,formula_version) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(metric_code) DO UPDATE SET metric_name=EXCLUDED.metric_name,category=EXCLUDED.category,unit_code=EXCLUDED.unit_code,formula_version=EXCLUDED.formula_version,updated_at=now()`, [code, name, category, unit, '1']);
  }
  const asOf = asDate(analysis.as_of) || new Date().toISOString().slice(0, 10), valuation = analysis.valuation || {}, metricValues = analysisMetricValues(analysis);
  for (const code of Object.keys(METRICS)) {
    const value = finite(metricValues[code]), calculated = code === 'roa' && String(valuation.roa_source || '').includes('补算');
    await client.query(`INSERT INTO analytics.metric_values(instrument_id,metric_code,as_of_date,numeric_value,status,formula_version,input_hash,diagnostics)
      VALUES($1,$2,$3,$4,$5,'1',$6,$7::jsonb) ON CONFLICT(instrument_id,metric_code,as_of_date,period_start,period_end,formula_version)
      DO UPDATE SET numeric_value=EXCLUDED.numeric_value,status=EXCLUDED.status,input_hash=EXCLUDED.input_hash,diagnostics=EXCLUDED.diagnostics,calculated_at=now()`, [instrumentId, code, asOf, value, value == null ? 'missing' : calculated ? 'calculated' : 'valid', hash(JSON.stringify(metricValues)), JSON.stringify(code === 'roa' ? { source: valuation.roa_source || '' } : {})]);
  }
  for (const code of ['price', 'pe', 'pb']) {
    const stat = analysis.percentiles && analysis.percentiles[code];
    if (!stat) continue;
    await client.query(`INSERT INTO analytics.metric_statistics(instrument_id,metric_code,as_of_date,window_start,window_end,percentile_value,valid_samples,excluded_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(instrument_id,metric_code,as_of_date,window_start,window_end) DO UPDATE SET percentile_value=EXCLUDED.percentile_value,valid_samples=EXCLUDED.valid_samples,excluded_reason=EXCLUDED.excluded_reason,calculated_at=now()`, [instrumentId, code, asOf, analysis.percentiles.window_start ? asDate(analysis.percentiles.window_start) : null, asOf, finite(stat.value), Number(stat.samples || 0), stat.reason || '']);
  }
  const controller = analysis.actual_controller || {}, report = analysis.latest_report || {}, guidance = analysis.performance_forecast || {}, quote = analysis.quote || {};
  const dividendHistory = (analysis.stability && analysis.stability.dividend_history) || [];
  const latestDividend = dividendHistory[0] || {};
  const latestEventDate = (analysis.events || []).reduce((max, e) => String(e.event_date || '') > max ? String(e.event_date) : max, '');
  const stockWatermark = {
    analysis_type: 'stock',
    as_of: asDate(analysis.as_of),
    latest_report_end: report.end_date || null,
    instrument: { name: analysis.name || '', list_date: asDate(analysis.list_date) },
    market: { trade_date: asDate(analysis.latest_market_trade_date), quote_time: quote.quote_time || null, quote_source: quote.source || null },
    financial: { report_end_date: report.end_date || null, report_ann_date: report.ann_date || null },
    dividend: { latest_ann_date: latestDividend.ann_date || null, latest_ex_date: latestDividend.ex_date || null },
    guidance: { ann_date: guidance.ann_date || null, end_date: guidance.end_date || null },
    industry: {
      name: (analysis.industry_info && analysis.industry_info.name) || analysis.industry || '',
      system: (analysis.industry_info && analysis.industry_info.system) || '',
    },
    controller: { name: controller.name || '', source: controller.source || '' },
    event: { latest_event_date: latestEventDate || null },
    formula_bundle_version: formulaVersion,
  };
  await client.query(`INSERT INTO analytics.analysis_snapshots(instrument_id,as_of_date,snapshot_type,formula_bundle_version,payload,source_watermark)
    VALUES($1,$2,'stock_analysis',$3,$4::jsonb,$5::jsonb) ON CONFLICT(instrument_id,as_of_date,snapshot_type,formula_bundle_version) DO UPDATE SET payload=EXCLUDED.payload,source_watermark=EXCLUDED.source_watermark,created_at=now()`, [instrumentId, asOf, formulaVersion, JSON.stringify(analysis), JSON.stringify(stockWatermark)]);
  if (finite(quote.price) !== null) {
    await client.query(`INSERT INTO market.latest_quotes(instrument_id,source_id,price,currency_code,quote_time,is_stale)
      VALUES($1,$2,$3,$4,$5,false) ON CONFLICT(instrument_id,source_id) DO UPDATE SET price=EXCLUDED.price,currency_code=EXCLUDED.currency_code,quote_time=EXCLUDED.quote_time,is_stale=false,fetched_at=now()`, [instrumentId, sources[quote.source] || sources.calculated, finite(quote.price), quote.currency || 'CNY', quote.quote_time || null]);
  }
  await client.query(`INSERT INTO analytics.stock_overview_latest(instrument_id,as_of_date,name,canonical_code,industry_label,currency_code,price,total_market_cap,a_share_market_cap,circulating_market_cap,free_float_market_cap,controller_name,controller_type,latest_report_date,latest_report_announced_at,guidance_summary,metrics)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb) ON CONFLICT(instrument_id) DO UPDATE SET as_of_date=EXCLUDED.as_of_date,name=EXCLUDED.name,industry_label=EXCLUDED.industry_label,currency_code=EXCLUDED.currency_code,price=EXCLUDED.price,total_market_cap=EXCLUDED.total_market_cap,a_share_market_cap=EXCLUDED.a_share_market_cap,circulating_market_cap=EXCLUDED.circulating_market_cap,free_float_market_cap=EXCLUDED.free_float_market_cap,controller_name=EXCLUDED.controller_name,controller_type=EXCLUDED.controller_type,latest_report_date=EXCLUDED.latest_report_date,latest_report_announced_at=EXCLUDED.latest_report_announced_at,guidance_summary=EXCLUDED.guidance_summary,metrics=EXCLUDED.metrics,updated_at=now()`,
  [instrumentId, asOf, analysis.name || analysis.ts_code, analysis.ts_code, (analysis.industry_info && analysis.industry_info.name) || analysis.industry || '', quote.currency || 'CNY', finite(quote.price), finite(valuation.market_cap), finite(valuation.a_share_market_cap), finite(valuation.circulating_market_cap), finite(valuation.free_float_market_cap), controller.name || '', controller.type || '', asDate(report.end_date), asDate(report.ann_date), guidance.summary || guidance.type || '', JSON.stringify(valuation)]);
}

async function syncQualityIssues(client, instrumentId, companyId, analysis) {
  if (!analysis) return;
  const valuation = analysis.valuation || {};
  const issues = [];
  if (finite(valuation.circulating_market_cap) === null) issues.push(['daily_basic', 'circulating_market_cap', 'missing_value']);
  if (finite(valuation.free_float_market_cap) === null) issues.push(['daily_basic', 'free_float_market_cap', 'missing_value']);
  if (String(valuation.roa_source || '').includes('补算')) issues.push(['fina_indicator', 'roa', 'calculated_fallback']);
  for (const [dataset, field, type] of issues) {
    await client.query(`INSERT INTO ops.data_quality_issues(instrument_id,company_id,dataset_code,field_code,issue_type,details)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
      DO UPDATE SET details=EXCLUDED.details,detected_at=now(),resolved_at=NULL`, [instrumentId, companyId, dataset, field, type, JSON.stringify({ ts_code: analysis.ts_code || '' })]);
  }
}

// ---- 以下为批次1按 method(params, tx) 登记的新仓储方法 ----

async function createIngestionRun(params, tx) {
  const { rows } = await tx.query(
    `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status) VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`,
    [params.sourceId, params.datasetCode, JSON.stringify(params.requestRange || {})],
  );
  return rows[0].run_id;
}

async function finishIngestionRun(params, tx) {
  await tx.query(
    `UPDATE ops.ingestion_runs SET status='success',row_count=$2,finished_at=now() WHERE run_id=$1`,
    [params.runId, params.rowCount || 0],
  );
}

async function insertRawRecord(params, tx) {
  await tx.query(
    `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
     VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,
    [params.runId, params.sourceId, params.datasetCode, params.sourceKey, JSON.stringify(params.payload), params.payloadHash],
  );
}

async function upsertDailyBar(params, tx) {
  await tx.query(
    `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close) VALUES($1,$2,$3,$4)
     ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET close=EXCLUDED.close,ingested_at=now()`,
    [params.instrumentId, params.tradeDate, params.sourceId, params.close],
  );
}

async function upsertAdjustmentFactor(params, tx) {
  await tx.query(
    `INSERT INTO market.adjustment_factors(instrument_id,trade_date,source_id,adj_factor) VALUES($1,$2,$3,$4)
     ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET adj_factor=EXCLUDED.adj_factor,ingested_at=now()`,
    [params.instrumentId, params.tradeDate, params.sourceId, params.adjFactor],
  );
}

async function upsertDailyValuation(params, tx) {
  await tx.query(
    `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap,free_float_market_cap,currency_code)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(instrument_id,trade_date,source_id)
     DO UPDATE SET pe_static=EXCLUDED.pe_static,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,
       total_market_cap=EXCLUDED.total_market_cap,circulating_market_cap=EXCLUDED.circulating_market_cap,free_float_market_cap=EXCLUDED.free_float_market_cap,ingested_at=now()`,
    [params.instrumentId, params.tradeDate, params.sourceId, params.peStatic, params.peTtm, params.pb, params.dividendYield,
      params.totalMarketCap, params.circulatingMarketCap, params.freeFloatMarketCap, params.currencyCode],
  );
}

async function upsertShareCapital(params, tx) {
  await tx.query(
    `INSERT INTO market.share_capital_history(instrument_id,effective_date,source_id,total_shares,a_shares,circulating_shares,free_float_shares)
     VALUES($1,$2,$3,$4,$4,$5,$6) ON CONFLICT(instrument_id,effective_date,source_id)
     DO UPDATE SET total_shares=EXCLUDED.total_shares,a_shares=EXCLUDED.a_shares,circulating_shares=EXCLUDED.circulating_shares,free_float_shares=EXCLUDED.free_float_shares,ingested_at=now()`,
    [params.instrumentId, params.effectiveDate, params.sourceId, params.totalShares, params.circulatingShares, params.freeFloatShares],
  );
}

async function upsertCorporateAction(params, tx) {
  await tx.query(
    `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,record_date,ex_date,pay_date,status,cash_per_share_pre_tax,cash_per_share_after_tax,stock_dividend_ratio,capitalization_ratio,base_shares,total_cash_amount,currency_code,source_id,source_key,raw_payload)
     VALUES($1,'dividend',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CNY',$14,$15,$16::jsonb) ON CONFLICT(source_id,source_key)
     DO UPDATE SET status=EXCLUDED.status,record_date=EXCLUDED.record_date,ex_date=EXCLUDED.ex_date,pay_date=EXCLUDED.pay_date,total_cash_amount=EXCLUDED.total_cash_amount,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
    [params.instrumentId, params.fiscalPeriodEnd, params.announcedAt, params.recordDate, params.exDate, params.payDate, params.status,
      params.cashPerSharePreTax, params.cashPerShareAfterTax, params.stockDividendRatio, params.capitalizationRatio,
      params.baseShares, params.totalCashAmount, params.sourceId, params.sourceKey, JSON.stringify(params.rawPayload || {})],
  );
}

async function upsertEarningsGuidance(params, tx) {
  await tx.query(
    `INSERT INTO fundamental.earnings_guidance(company_id,period_end,guidance_type,announced_at,profit_min,profit_max,change_min,change_max,summary,change_reason,currency_code,source_id,source_key,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CNY',$11,$12,$13::jsonb) ON CONFLICT(source_id,source_key)
     DO UPDATE SET raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
    [params.companyId, params.periodEnd, params.guidanceType, params.announcedAt, params.profitMin, params.profitMax,
      params.changeMin, params.changeMax, params.summary, params.changeReason, params.sourceId, params.sourceKey, JSON.stringify(params.rawPayload || {})],
  );
}

async function upsertFinancialCursor(params, tx) {
  await tx.query(
    `INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_attempt_at,last_error)
     VALUES($1,$2,$3,'financial',CURRENT_DATE,now(),'') ON CONFLICT(scope_key,dataset_code)
     DO UPDATE SET last_success_date=CURRENT_DATE,last_attempt_at=now(),last_error='',updated_at=now()`,
    [params.instrumentId, params.companyId, `${params.instrumentId}:${params.companyId}`],
  );
}

async function insertQualityIssue(params, tx) {
  await tx.query(
    `INSERT INTO ops.data_quality_issues(instrument_id,company_id,dataset_code,field_code,issue_type,details)
     VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
     DO UPDATE SET details=EXCLUDED.details,detected_at=now(),resolved_at=NULL`,
    [params.instrumentId, params.companyId, params.datasetCode, params.fieldCode, params.issueType, JSON.stringify(params.details || {})],
  );
}

async function upsertDocument(params, tx) {
  const { rows } = await tx.query(
    `INSERT INTO event.documents(company_id,document_type,title,announced_at,url,source_id,content_hash,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(source_id,url,content_hash)
     DO UPDATE SET title=EXCLUDED.title,announced_at=EXCLUDED.announced_at,raw_payload=event.documents.raw_payload || EXCLUDED.raw_payload RETURNING document_id`,
    [params.companyId, params.documentType, params.title, params.announcedAt, params.url, params.sourceId, params.contentHash, JSON.stringify(params.rawPayload || {})],
  );
  return rows[0] ? rows[0].document_id : null;
}

async function upsertCompanyEvent(params, tx) {
  await tx.query(
    `INSERT INTO event.company_events(company_id,event_type,event_date,title,importance,is_official,source_id,document_id,source_key,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(source_id,source_key)
     DO UPDATE SET event_date=EXCLUDED.event_date,title=EXCLUDED.title,event_type=EXCLUDED.event_type,importance=EXCLUDED.importance,is_official=EXCLUDED.is_official,document_id=EXCLUDED.document_id,details=EXCLUDED.details`,
    [params.companyId, params.eventType, params.eventDate, params.title, params.importance, params.isOfficial,
      params.sourceId, params.documentId, params.sourceKey, JSON.stringify(params.details || {})],
  );
}

module.exports = {
  createIngestionRun,
  ensureMaster,
  finishIngestionRun,
  insertQualityIssue,
  insertRawRecord,
  sourceIds,
  syncAnalytics,
  syncQualityIssues,
  syncReportRows,
  upsertAdjustmentFactor,
  upsertCompanyEvent,
  upsertCorporateAction,
  upsertDailyBar,
  upsertDailyValuation,
  upsertDocument,
  upsertEarningsGuidance,
  upsertFinancialCursor,
  upsertShareCapital,
};
