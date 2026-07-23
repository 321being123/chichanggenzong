const crypto = require('crypto');
const { pool } = require('../db/connection');

function asDate(value) {
  const text=String(value||'').replace(/-/g,'').slice(0,8);
  return /^\d{8}$/.test(text)?`${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}`:null;
}

function finite(value) {
  if(value===null||value===undefined||value==='')return null;
  const number=Number(value);return Number.isFinite(number)?number:null;
}
function marketMultiple(value){const n=finite(value);return n===0?null:n;}

function hash(value) { return crypto.createHash('sha256').update(String(value||'')).digest('hex'); }

async function sourceIds(client) {
  const {rows}=await client.query('SELECT source_code,source_id FROM ops.data_sources');
  return Object.fromEntries(rows.map(row=>[row.source_code,row.source_id]));
}

async function syncRawRecords(client, tsCode, runId, sourceId) {
  const datasets = [
    ['stock_income_statements','income'], ['stock_balance_sheets','balancesheet'],
    ['stock_cashflow_statements','cashflow'], ['stock_financial_indicators','fina_indicator'],
    ['stock_dividends','dividend'], ['stock_forecasts','forecast']
  ];
  let rowCount = 0;
  for (const [table, dataset] of datasets) {
    const result = await client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
      SELECT $2,$3,$4,version_key,data,md5(data::text) FROM ${table} WHERE ts_code=$1
      ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`, [tsCode,runId,sourceId,dataset]);
    rowCount += result.rowCount;
  }
  const valuationResult = await client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
    SELECT $2,$3,'daily_basic',trade_date,to_jsonb(v),md5(to_jsonb(v)::text) FROM stock_daily_valuations v WHERE ts_code=$1
    ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`, [tsCode,runId,sourceId]);
  return rowCount + valuationResult.rowCount;
}

async function ensureMaster(client, tsCode, sources, metadata) {
  let legacy=metadata?{...metadata,data:metadata}:null;
  if(!legacy){const current=(await client.query(`SELECT canonical_code ts_code,name,market,to_char(list_date,'YYYYMMDD') list_date,raw_data data FROM core.instruments WHERE canonical_code=$1`,[tsCode])).rows[0];legacy=current?{...current,industry:current.data?.industry||''}:null;}
  if(!legacy)throw new Error(`缺少证券基础资料：${tsCode}`);
  const raw=legacy.data||{},exchange=tsCode.endsWith('.SH')?'SSE':tsCode.endsWith('.BJ')?'BSE':'SZSE';
  const currency=tsCode.endsWith('.HK')?'HKD':'CNY',assetClass='equity';
  const company=(await client.query(`INSERT INTO core.companies(legal_name,short_name,country_code,raw_data)
    VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(country_code,legal_name) DO UPDATE SET short_name=EXCLUDED.short_name,raw_data=EXCLUDED.raw_data,updated_at=now()
    RETURNING company_id`,[legacy.name||tsCode,legacy.name||'',tsCode.endsWith('.HK')?'HK':'CN',JSON.stringify(raw)])).rows[0];
  const instrument=(await client.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status,raw_data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name,market=EXCLUDED.market,exchange_code=EXCLUDED.exchange_code,currency_code=EXCLUDED.currency_code,list_date=EXCLUDED.list_date,raw_data=EXCLUDED.raw_data,updated_at=now()
    RETURNING instrument_id`,[tsCode,legacy.name||'',assetClass,legacy.market||'',exchange,currency,asDate(legacy.list_date),'listed',JSON.stringify(raw)])).rows[0];
  await client.query(`INSERT INTO core.company_instruments(company_id,instrument_id,valid_from) VALUES($1,$2,$3)
    ON CONFLICT(company_id,instrument_id,relation_type) DO UPDATE SET valid_from=COALESCE(core.company_instruments.valid_from,EXCLUDED.valid_from)`,[company.company_id,instrument.instrument_id,asDate(legacy.list_date)]);
  for(const [sourceCode,type,value] of [['tushare','ts_code',tsCode],['tencent','quote_symbol',tsCode.endsWith('.SH')?'sh'+tsCode.slice(0,6):'sz'+tsCode.slice(0,6)],['eastmoney','f10_code',tsCode]]){
    await client.query(`INSERT INTO core.instrument_identifiers(instrument_id,source_id,identifier_type,identifier_value,valid_from)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING`,[instrument.instrument_id,sources[sourceCode],type,value,asDate(legacy.list_date)]);
  }
  const industryName=raw.industry||legacy.industry||'',system=raw.industry_system||'Tushare基础行业',levelText=raw.industry_level||'';
  if(industryName){
    const taxonomyCode=/申万/.test(system)?'SW2021':'TUSHARE_BASIC';
    const taxonomy=(await client.query('SELECT taxonomy_id FROM core.industry_taxonomies WHERE taxonomy_code=$1',[taxonomyCode])).rows[0];
    const industryCode=String(raw.industry_code||hash(`${taxonomyCode}|${industryName}`).slice(0,16));
    const level=Number((String(levelText).match(/\d+/)||[])[0])||null;
    const node=(await client.query(`INSERT INTO core.industry_nodes(taxonomy_id,industry_code,industry_name,level) VALUES($1,$2,$3,$4)
      ON CONFLICT(taxonomy_id,industry_code) DO UPDATE SET industry_name=EXCLUDED.industry_name,level=COALESCE(EXCLUDED.level,core.industry_nodes.level) RETURNING industry_node_id`,[taxonomy.taxonomy_id,industryCode,industryName,level])).rows[0];
    await client.query(`UPDATE core.company_industry_memberships SET is_current=false,valid_to=CURRENT_DATE WHERE company_id=$1 AND is_current=true AND industry_node_id<>$2`,[company.company_id,node.industry_node_id]);
    await client.query(`INSERT INTO core.company_industry_memberships(company_id,industry_node_id,source_id,valid_from,is_current)
      VALUES($1,$2,$3,$4,true) ON CONFLICT(company_id,industry_node_id,valid_from) DO UPDATE SET is_current=true,valid_to=NULL`,[company.company_id,node.industry_node_id,sources.tushare,asDate(legacy.list_date)]);
  }
  const controller=raw.actual_controller;
  if(controller&&controller.name){
    await client.query(`UPDATE core.company_controllers SET is_current=false,valid_to=CURRENT_DATE WHERE company_id=$1 AND is_current=true AND controller_name<>$2`,[company.company_id,controller.name]);
    await client.query(`INSERT INTO core.company_controllers(company_id,controller_name,controller_type,control_ratio,source_id,valid_from,is_current,confidence,raw_data)
      VALUES($1,$2,$3,$4,$5,$6,true,$7,$8::jsonb) ON CONFLICT(company_id,controller_name,valid_from) DO UPDATE SET controller_type=EXCLUDED.controller_type,control_ratio=EXCLUDED.control_ratio,is_current=true,raw_data=EXCLUDED.raw_data`,
      [company.company_id,controller.name,controller.type||'other',finite(controller.hold_ratio),sources.eastmoney,asDate(legacy.list_date),controller.name?0.8:null,JSON.stringify(controller)]);
  }
  return {companyId:company.company_id,instrumentId:instrument.instrument_id,legacy,currency};
}

async function syncMarket(client, tsCode, instrumentId, sources, currency) {
  await client.query(`INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close)
    SELECT $2,to_date(trade_date,'YYYYMMDD'),$3,close FROM stock_daily_valuations WHERE ts_code=$1 AND close IS NOT NULL
    ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET close=EXCLUDED.close,ingested_at=now()`,[tsCode,instrumentId,sources.tushare]);
  await client.query(`INSERT INTO market.adjustment_factors(instrument_id,trade_date,source_id,adj_factor)
    SELECT $2,to_date(trade_date,'YYYYMMDD'),$3,adj_factor FROM stock_daily_valuations WHERE ts_code=$1 AND adj_factor IS NOT NULL
    ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET adj_factor=EXCLUDED.adj_factor,ingested_at=now()`,[tsCode,instrumentId,sources.tushare]);
  await client.query(`INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap,free_float_market_cap,currency_code)
    SELECT $2,to_date(trade_date,'YYYYMMDD'),$3,pe,pe_ttm,pb,CASE WHEN dv_ttm IS NULL THEN NULL ELSE dv_ttm/100 END,
      total_mv*10000,circ_mv*10000,CASE WHEN close IS NULL OR free_share IS NULL THEN NULL ELSE close*free_share*10000 END,$4
    FROM stock_daily_valuations WHERE ts_code=$1
    ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET pe_static=EXCLUDED.pe_static,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,
      dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,total_market_cap=EXCLUDED.total_market_cap,circulating_market_cap=EXCLUDED.circulating_market_cap,
      free_float_market_cap=EXCLUDED.free_float_market_cap,currency_code=EXCLUDED.currency_code,ingested_at=now()`,[tsCode,instrumentId,sources.tushare,currency]);
  await client.query(`WITH capital AS (
      SELECT to_date(trade_date,'YYYYMMDD') effective_date,total_share*10000 total_shares,float_share*10000 circulating_shares,free_share*10000 free_float_shares,
        lag(total_share) OVER(ORDER BY trade_date) previous_total,lag(float_share) OVER(ORDER BY trade_date) previous_float,
        lag(free_share) OVER(ORDER BY trade_date) previous_free
      FROM stock_daily_valuations WHERE ts_code=$1 AND (total_share IS NOT NULL OR float_share IS NOT NULL OR free_share IS NOT NULL)
    ) INSERT INTO market.share_capital_history(instrument_id,effective_date,source_id,total_shares,a_shares,circulating_shares,free_float_shares)
      SELECT $2,effective_date,$3,total_shares,total_shares,circulating_shares,free_float_shares FROM capital
      WHERE previous_total IS NULL OR total_shares/10000 IS DISTINCT FROM previous_total
        OR circulating_shares/10000 IS DISTINCT FROM previous_float OR free_float_shares/10000 IS DISTINCT FROM previous_free
      ON CONFLICT(instrument_id,effective_date,source_id) DO UPDATE SET total_shares=EXCLUDED.total_shares,a_shares=EXCLUDED.a_shares,circulating_shares=EXCLUDED.circulating_shares,free_float_shares=EXCLUDED.free_float_shares,ingested_at=now()`,[tsCode,instrumentId,sources.tushare]);
}

const FACT_MAP={
  income:{n_income_attr_p:'net_profit_parent',total_revenue:'total_revenue',revenue:'revenue',operate_profit:'operating_profit',total_profit:'total_profit',ebit:'ebit',fin_exp_int_exp:'interest_expense'},
  balance:{total_assets:'total_assets',total_liab:'total_liabilities',total_hldr_eqy_exc_min_int:'equity_parent',goodwill:'goodwill',money_cap:'cash_and_equivalents',trad_asset:'trading_financial_assets'},
  cashflow:{n_cashflow_act:'operating_cashflow',c_pay_acq_const_fiolta:'capital_expenditure'},
  indicator:{profit_dedt:'net_profit_deducted',roe:'roe',roa:'roa',interestdebt:'interest_bearing_debt',ebit_to_interest:'interest_coverage'}
};

function periodType(endDate){const suffix=String(endDate||'').slice(4);return suffix==='1231'?'annual':suffix==='0630'?'semiannual':suffix==='0331'?'q1':suffix==='0930'?'q3':'other';}

function rowVersion(row){return hash([row.end_date,row.ann_date,row.f_ann_date,row.report_type,row.comp_type,row.update_flag,row.div_proc,row.ex_date,row.pay_date,row.type].join('|'));}

async function syncReportRows(client, rows, kind, companyId, sourceId) {
  for(const data of rows){if(!asDate(data.end_date))continue;const sourceVersion=rowVersion(data),announced=asDate(data.f_ann_date||data.ann_date);
    const report=(await client.query(`INSERT INTO fundamental.financial_reports(company_id,report_kind,period_end,period_type,announced_at,source_id,source_version,update_flag,raw_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(company_id,report_kind,period_end,source_id,source_version)
      DO UPDATE SET announced_at=EXCLUDED.announced_at,update_flag=EXCLUDED.update_flag,raw_payload=EXCLUDED.raw_payload,ingested_at=now() RETURNING report_id`,
      [companyId,kind,asDate(data.end_date),periodType(data.end_date),announced,sourceId,sourceVersion,data.update_flag||'',JSON.stringify(data)])).rows[0];
    for(const [sourceField,metricCode] of Object.entries(FACT_MAP[kind]||{})){const value=finite(data[sourceField]);if(value===null)continue;const unit=/roe|roa|coverage/.test(metricCode)?'percent':'currency';
      await client.query(`INSERT INTO fundamental.financial_facts(report_id,statement_type,metric_code,numeric_value,unit_code,currency_code,source_field)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(report_id,metric_code) DO UPDATE SET numeric_value=EXCLUDED.numeric_value,unit_code=EXCLUDED.unit_code,source_field=EXCLUDED.source_field`,[report.report_id,kind,metricCode,value,unit,unit==='currency'?'CNY':null,sourceField]);}
  }
  await client.query(`WITH ranked AS (SELECT report_id,row_number() OVER(PARTITION BY company_id,report_kind,period_end ORDER BY announced_at DESC NULLS LAST,ingested_at DESC,report_id DESC) rn FROM fundamental.financial_reports WHERE company_id=$1 AND report_kind=$2) UPDATE fundamental.financial_reports r SET is_current_version=(ranked.rn=1) FROM ranked WHERE r.report_id=ranked.report_id`,[companyId,kind]);
}

async function syncReportTable(client, table, kind, tsCode, companyId, sourceId) {
  const {rows}=await client.query(`SELECT version_key,end_date,ann_date,data FROM ${table} WHERE ts_code=$1`,[tsCode]);
  await syncReportRows(client,rows.map(row=>row.data||{}),kind,companyId,sourceId);
}

async function syncFundamentals(client, tsCode, companyId, instrumentId, sources) {
  await syncReportTable(client,'stock_income_statements','income',tsCode,companyId,sources.tushare);
  await syncReportTable(client,'stock_balance_sheets','balance',tsCode,companyId,sources.tushare);
  await syncReportTable(client,'stock_cashflow_statements','cashflow',tsCode,companyId,sources.tushare);
  await syncReportTable(client,'stock_financial_indicators','indicator',tsCode,companyId,sources.tushare);
  await client.query(`INSERT INTO fundamental.financial_period_summary(company_id,period_end,announced_at,net_profit_parent,net_profit_deducted,total_assets,equity_parent,operating_cashflow,goodwill,interest_expense,roe,roa,source_report_ids)
    SELECT $1,r.period_end,max(r.announced_at),max(f.numeric_value) FILTER(WHERE f.metric_code='net_profit_parent'),max(f.numeric_value) FILTER(WHERE f.metric_code='net_profit_deducted'),
      max(f.numeric_value) FILTER(WHERE f.metric_code='total_assets'),max(f.numeric_value) FILTER(WHERE f.metric_code='equity_parent'),max(f.numeric_value) FILTER(WHERE f.metric_code='operating_cashflow'),
      max(f.numeric_value) FILTER(WHERE f.metric_code='goodwill'),max(f.numeric_value) FILTER(WHERE f.metric_code='interest_expense'),max(f.numeric_value) FILTER(WHERE f.metric_code='roe'),max(f.numeric_value) FILTER(WHERE f.metric_code='roa'),array_agg(DISTINCT r.report_id)
    FROM fundamental.financial_reports r JOIN fundamental.financial_facts f ON f.report_id=r.report_id WHERE r.company_id=$1 AND r.is_current_version GROUP BY r.period_end
    ON CONFLICT(company_id,period_end) DO UPDATE SET announced_at=EXCLUDED.announced_at,net_profit_parent=EXCLUDED.net_profit_parent,net_profit_deducted=EXCLUDED.net_profit_deducted,
      total_assets=EXCLUDED.total_assets,equity_parent=EXCLUDED.equity_parent,operating_cashflow=EXCLUDED.operating_cashflow,goodwill=EXCLUDED.goodwill,interest_expense=EXCLUDED.interest_expense,
      roe=EXCLUDED.roe,roa=EXCLUDED.roa,source_report_ids=EXCLUDED.source_report_ids,updated_at=now()`,[companyId]);
  await client.query(`UPDATE fundamental.corporate_actions SET source_key=$2||':'||source_key
    WHERE instrument_id=$1 AND source_id=$3 AND source_key NOT LIKE $2||':%'`,[instrumentId,tsCode,sources.tushare]);
  const dividends=(await client.query('SELECT version_key,data FROM stock_dividends WHERE ts_code=$1',[tsCode])).rows;
  for(const item of dividends){const r=item.data||{},cashPre=finite(r.cash_div_tax),base=finite(r.base_share),amount=cashPre!=null&&base!=null?cashPre*base*10000:null;
    await client.query(`INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,record_date,ex_date,pay_date,status,cash_per_share_pre_tax,cash_per_share_after_tax,stock_dividend_ratio,capitalization_ratio,base_shares,total_cash_amount,currency_code,source_id,source_key,raw_payload)
      VALUES($1,'dividend',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CNY',$14,$15,$16::jsonb) ON CONFLICT(source_id,source_key) DO UPDATE SET status=EXCLUDED.status,record_date=EXCLUDED.record_date,ex_date=EXCLUDED.ex_date,pay_date=EXCLUDED.pay_date,total_cash_amount=EXCLUDED.total_cash_amount,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
      [instrumentId,asDate(r.end_date),asDate(r.ann_date||r.imp_ann_date),asDate(r.record_date),asDate(r.ex_date),asDate(r.pay_date),r.div_proc||'',cashPre,finite(r.cash_div),finite(r.stk_bo_rate),finite(r.stk_co_rate),base==null?null:base*10000,amount,sources.tushare,`${tsCode}:${item.version_key}`,JSON.stringify(r)]);
  }
  await client.query(`UPDATE fundamental.earnings_guidance SET source_key=$2||':'||source_key
    WHERE company_id=$1 AND source_id=$3 AND source_key NOT LIKE $2||':%'`,[companyId,tsCode,sources.tushare]);
  const guidance=(await client.query('SELECT version_key,data FROM stock_forecasts WHERE ts_code=$1',[tsCode])).rows;
  for(const item of guidance){const r=item.data||{};if(!asDate(r.end_date))continue;await client.query(`INSERT INTO fundamental.earnings_guidance(company_id,period_end,guidance_type,announced_at,profit_min,profit_max,change_min,change_max,summary,change_reason,currency_code,source_id,source_key,raw_payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CNY',$11,$12,$13::jsonb) ON CONFLICT(source_id,source_key) DO UPDATE SET guidance_type=EXCLUDED.guidance_type,profit_min=EXCLUDED.profit_min,profit_max=EXCLUDED.profit_max,change_min=EXCLUDED.change_min,change_max=EXCLUDED.change_max,summary=EXCLUDED.summary,change_reason=EXCLUDED.change_reason,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
    [companyId,asDate(r.end_date),r.type||'forecast',asDate(r.ann_date),finite(r.net_profit_min)==null?null:finite(r.net_profit_min)*10000,finite(r.net_profit_max)==null?null:finite(r.net_profit_max)*10000,finite(r.p_change_min),finite(r.p_change_max),r.summary||'',r.change_reason||'',sources.tushare,`${tsCode}:${item.version_key}`,JSON.stringify(r)]);}
}

async function syncEvents(client, tsCode, companyId, sources) {
  const {rows}=await client.query('SELECT * FROM stock_events WHERE ts_code=$1',[tsCode]);
  for(const r of rows){const source=sources[r.source]||sources.calculated,key=r.event_key||hash(`${r.source}|${r.url}|${r.title}`),documentId=r.is_official?(await client.query(`INSERT INTO event.documents(company_id,document_type,title,announced_at,url,source_id,content_hash,raw_payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(source_id,url,content_hash) DO UPDATE SET title=EXCLUDED.title,raw_payload=EXCLUDED.raw_payload RETURNING document_id`,[companyId,r.category||'announcement',r.title,asDate(r.event_date),r.url||'',source,hash(r.title),JSON.stringify(r.data||{})])).rows[0]?.document_id:null;
    await client.query(`INSERT INTO event.company_events(company_id,event_type,event_date,title,importance,is_official,source_id,document_id,source_key,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(source_id,source_key) DO UPDATE SET title=EXCLUDED.title,event_type=EXCLUDED.event_type,details=EXCLUDED.details`,[companyId,r.category||'other',asDate(r.event_date),r.title,r.is_official?10:1,r.is_official,source,documentId,key,JSON.stringify(r.data||{})]);
  }
}

const METRICS={
  pe_ttm:['滚动市盈率','valuation','multiple'],pe_static:['静态市盈率','valuation','multiple'],pe_forecast:['动态市盈率','valuation','multiple'],pe_three_year_avg:['三年平均市盈率','valuation','multiple'],pb:['市净率','valuation','multiple'],pb_ex_goodwill:['扣除商誉市净率','valuation','multiple'],dividend_yield:['股息率','dividend','ratio'],payout_ratio:['分红率','dividend','ratio'],cumulative_payout_ratio:['累计分红率','dividend','ratio'],average_dividend_yield:['平均股息率','dividend','ratio'],roe:['净资产收益率','profitability','percent'],roa:['总资产收益率','profitability','percent'],annualized_return_since_listing:['上市至今年化收益率','return','ratio'],
  net_cash:['净现金安全额','safety','currency'],interest_coverage:['利息保障倍数','safety','multiple'],market_cap_to_liability:['市值负债比','safety','ratio'],operating_cashflow_latest:['最近一年经营现金流','cashflow','currency'],free_cashflow_latest:['最近一年自由现金流','cashflow','currency'],operating_cashflow_3y:['三年平均经营现金流','cashflow','currency'],free_cashflow_3y:['三年平均自由现金流','cashflow','currency'],operating_cashflow_5y:['五年平均经营现金流','cashflow','currency'],free_cashflow_5y:['五年平均自由现金流','cashflow','currency'],profit_growth_3y_parent:['归母净利润三年增长率','growth','ratio'],profit_growth_3y_deducted:['扣非净利润三年增长率','growth','ratio'],profit_growth_5y_parent:['归母净利润五年增长率','growth','ratio'],profit_growth_5y_deducted:['扣非净利润五年增长率','growth','ratio'],profit_growth_10y_parent:['归母净利润十年增长率','growth','ratio'],profit_growth_10y_deducted:['扣非净利润十年增长率','growth','ratio'],profit_growth_latest_parent:['最近报告期归母净利润同比','growth','ratio'],profit_growth_latest_deducted:['最近报告期扣非净利润同比','growth','ratio']
};

function analysisMetricValues(analysis) {
  const valuation=analysis.valuation||{},safety=analysis.safety||{},cashflow=analysis.cashflow||{},growth=analysis.growth||{},periods=growth.periods||{},latest=growth.latest_interim_yoy||{};
  return Object.assign({},valuation,{net_cash:safety.net_cash,interest_coverage:safety.interest_coverage,market_cap_to_liability:safety.market_cap_to_liability,operating_cashflow_latest:cashflow.latest_year?.operating,free_cashflow_latest:cashflow.latest_year?.free,operating_cashflow_3y:cashflow.average_3y?.operating,free_cashflow_3y:cashflow.average_3y?.free,operating_cashflow_5y:cashflow.average_5y?.operating,free_cashflow_5y:cashflow.average_5y?.free,profit_growth_3y_parent:periods[3]?.parent?.value,profit_growth_3y_deducted:periods[3]?.deducted?.value,profit_growth_5y_parent:periods[5]?.parent?.value,profit_growth_5y_deducted:periods[5]?.deducted?.value,profit_growth_10y_parent:periods[10]?.parent?.value,profit_growth_10y_deducted:periods[10]?.deducted?.value,profit_growth_latest_parent:latest.parent,profit_growth_latest_deducted:latest.deducted});
}

async function syncAnalytics(client, instrumentId, analysis, sources) {
  if(!analysis)return;
  for(const [code,[name,category,unit]] of Object.entries(METRICS))await client.query(`INSERT INTO analytics.metric_definitions(metric_code,metric_name,category,unit_code,formula_version) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(metric_code) DO UPDATE SET metric_name=EXCLUDED.metric_name,category=EXCLUDED.category,unit_code=EXCLUDED.unit_code,formula_version=EXCLUDED.formula_version,updated_at=now()`,[code,name,category,unit,'1']);
  const asOf=asDate(analysis.as_of)||new Date().toISOString().slice(0,10),valuation=analysis.valuation||{},metricValues=analysisMetricValues(analysis);
  for(const code of Object.keys(METRICS)){const value=finite(metricValues[code]),calculated=code==='roa'&&String(valuation.roa_source||'').includes('补算');await client.query(`INSERT INTO analytics.metric_values(instrument_id,metric_code,as_of_date,numeric_value,status,formula_version,input_hash,diagnostics)
    VALUES($1,$2,$3,$4,$5,'1',$6,$7::jsonb) ON CONFLICT(instrument_id,metric_code,as_of_date,period_start,period_end,formula_version)
    DO UPDATE SET numeric_value=EXCLUDED.numeric_value,status=EXCLUDED.status,input_hash=EXCLUDED.input_hash,diagnostics=EXCLUDED.diagnostics,calculated_at=now()`,[instrumentId,code,asOf,value,value==null?'missing':calculated?'calculated':'valid',hash(JSON.stringify(metricValues)),JSON.stringify(code==='roa'?{source:valuation.roa_source||''}:{})]);}
  for(const code of ['price','pe','pb']){const stat=analysis.percentiles&&analysis.percentiles[code];if(!stat)continue;await client.query(`INSERT INTO analytics.metric_statistics(instrument_id,metric_code,as_of_date,window_start,window_end,percentile_value,valid_samples,excluded_reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(instrument_id,metric_code,as_of_date,window_start,window_end) DO UPDATE SET percentile_value=EXCLUDED.percentile_value,valid_samples=EXCLUDED.valid_samples,excluded_reason=EXCLUDED.excluded_reason,calculated_at=now()`,[instrumentId,code,asOf,analysis.percentiles.window_start?asDate(analysis.percentiles.window_start):null,asOf,finite(stat.value),Number(stat.samples||0),stat.reason||'']);}
  await client.query(`INSERT INTO analytics.analysis_snapshots(instrument_id,as_of_date,snapshot_type,formula_bundle_version,payload,source_watermark)
    VALUES($1,$2,'stock_analysis','1',$3::jsonb,$4::jsonb) ON CONFLICT(instrument_id,as_of_date,snapshot_type,formula_bundle_version) DO UPDATE SET payload=EXCLUDED.payload,source_watermark=EXCLUDED.source_watermark,created_at=now()`,[instrumentId,asOf,JSON.stringify(analysis),JSON.stringify({source:'legacy_projection'})]);
  const controller=analysis.actual_controller||{},report=analysis.latest_report||{},guidance=analysis.performance_forecast||{},quote=analysis.quote||{};
  if(finite(quote.price)!==null)await client.query(`INSERT INTO market.latest_quotes(instrument_id,source_id,price,currency_code,quote_time,is_stale)
    VALUES($1,$2,$3,$4,$5,false) ON CONFLICT(instrument_id,source_id) DO UPDATE SET price=EXCLUDED.price,currency_code=EXCLUDED.currency_code,quote_time=EXCLUDED.quote_time,is_stale=false,fetched_at=now()`,[instrumentId,sources[quote.source]||sources.calculated,finite(quote.price),quote.currency||'CNY',quote.quote_time||null]);
  await client.query(`INSERT INTO analytics.stock_overview_latest(instrument_id,as_of_date,name,canonical_code,industry_label,currency_code,price,total_market_cap,a_share_market_cap,circulating_market_cap,free_float_market_cap,controller_name,controller_type,latest_report_date,latest_report_announced_at,guidance_summary,metrics)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb) ON CONFLICT(instrument_id) DO UPDATE SET as_of_date=EXCLUDED.as_of_date,name=EXCLUDED.name,industry_label=EXCLUDED.industry_label,currency_code=EXCLUDED.currency_code,price=EXCLUDED.price,total_market_cap=EXCLUDED.total_market_cap,a_share_market_cap=EXCLUDED.a_share_market_cap,circulating_market_cap=EXCLUDED.circulating_market_cap,free_float_market_cap=EXCLUDED.free_float_market_cap,controller_name=EXCLUDED.controller_name,controller_type=EXCLUDED.controller_type,latest_report_date=EXCLUDED.latest_report_date,latest_report_announced_at=EXCLUDED.latest_report_announced_at,guidance_summary=EXCLUDED.guidance_summary,metrics=EXCLUDED.metrics,updated_at=now()`,
    [instrumentId,asOf,analysis.name||analysis.ts_code,analysis.ts_code,(analysis.industry_info&&analysis.industry_info.name)||analysis.industry||'',quote.currency||'CNY',finite(quote.price),finite(valuation.market_cap),finite(valuation.a_share_market_cap),finite(valuation.circulating_market_cap),finite(valuation.free_float_market_cap),controller.name||'',controller.type||'',asDate(report.end_date),asDate(report.ann_date),guidance.summary||guidance.type||'',JSON.stringify(valuation)]);
}

async function syncCursors(client, tsCode, instrumentId, companyId) {
  const {rows}=await client.query('SELECT * FROM stock_data_sync_state WHERE ts_code=$1',[tsCode]);
  for(const row of rows)await client.query(`INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_attempt_at,last_error)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,last_attempt_at=EXCLUDED.last_attempt_at,last_error=EXCLUDED.last_error,updated_at=now()`,[instrumentId,companyId,`${instrumentId}:${companyId}`,row.dataset,asDate(row.last_success_date),row.last_attempt_at,row.last_error||'']);
}

async function syncQualityIssues(client, instrumentId, companyId, analysis) {
  if (!analysis) return;
  const valuation = analysis.valuation || {};
  const issues = [];
  if (finite(valuation.circulating_market_cap) === null) issues.push(['daily_basic','circulating_market_cap','missing_value']);
  if (finite(valuation.free_float_market_cap) === null) issues.push(['daily_basic','free_float_market_cap','missing_value']);
  if (String(valuation.roa_source || '').includes('补算')) issues.push(['fina_indicator','roa','calculated_fallback']);
  for (const [dataset,field,type] of issues) await client.query(`INSERT INTO ops.data_quality_issues(instrument_id,company_id,dataset_code,field_code,issue_type,details)
    VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
    DO UPDATE SET details=EXCLUDED.details,detected_at=now(),resolved_at=NULL`, [instrumentId,companyId,dataset,field,type,JSON.stringify({ts_code:analysis.ts_code||''})]);
}

async function persistCollectedData(metadata, bundle) {
  const tsCode=metadata.ts_code,client=await pool.connect();
  try{await client.query('BEGIN');const sources=await sourceIds(client),master=await ensureMaster(client,tsCode,sources,metadata);
    const run=(await client.query(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status) VALUES($1,'stock_analysis_direct',$2::jsonb,'running') RETURNING run_id`,[sources.tushare,JSON.stringify({ts_code:tsCode})])).rows[0];let count=0;
    for(const [dataset,rows] of Object.entries(bundle)){if(dataset==='valuationIssues'||!Array.isArray(rows))continue;for(const row of rows){const key=`${tsCode}:${rowVersion(row)}`;await client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,[run.run_id,sources.tushare,dataset,key,JSON.stringify(row),hash(JSON.stringify(row))]);count++;}}
    await syncReportRows(client,bundle.income||[],'income',master.companyId,sources.tushare);await syncReportRows(client,bundle.balance||[],'balance',master.companyId,sources.tushare);await syncReportRows(client,bundle.cashflow||[],'cashflow',master.companyId,sources.tushare);await syncReportRows(client,bundle.indicators||[],'indicator',master.companyId,sources.tushare);
    const daily=new Map((bundle.daily||[]).map(x=>[x.trade_date,x])),basic=new Map((bundle.basics||[]).map(x=>[x.trade_date,x])),factors=new Map((bundle.factors||[]).map(x=>[x.trade_date,x]));
    for(const date of new Set([...daily.keys(),...basic.keys(),...factors.keys()])){const d=daily.get(date)||{},b=basic.get(date)||{},a=factors.get(date)||{},day=asDate(date);if(!day)continue;
      if(finite(d.close)!==null)await client.query(`INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close) VALUES($1,$2,$3,$4) ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET close=EXCLUDED.close,ingested_at=now()`,[master.instrumentId,day,sources.tushare,finite(d.close)]);
      if(finite(a.adj_factor)!==null)await client.query(`INSERT INTO market.adjustment_factors(instrument_id,trade_date,source_id,adj_factor) VALUES($1,$2,$3,$4) ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET adj_factor=EXCLUDED.adj_factor,ingested_at=now()`,[master.instrumentId,day,sources.tushare,finite(a.adj_factor)]);
      if(basic.has(date))await client.query(`INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap,free_float_market_cap,currency_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET pe_static=EXCLUDED.pe_static,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,total_market_cap=EXCLUDED.total_market_cap,circulating_market_cap=EXCLUDED.circulating_market_cap,free_float_market_cap=EXCLUDED.free_float_market_cap,ingested_at=now()`,[master.instrumentId,day,sources.tushare,marketMultiple(b.pe),marketMultiple(b.pe_ttm),marketMultiple(b.pb),finite(b.dv_ttm)==null?null:finite(b.dv_ttm)/100,finite(b.total_mv)==null?null:finite(b.total_mv)*10000,finite(b.circ_mv)==null?null:finite(b.circ_mv)*10000,finite(d.close)==null||finite(b.free_share)==null?null:finite(d.close)*finite(b.free_share)*10000,master.currency]);
      if([b.total_share,b.float_share,b.free_share].some(x=>finite(x)!==null))await client.query(`INSERT INTO market.share_capital_history(instrument_id,effective_date,source_id,total_shares,a_shares,circulating_shares,free_float_shares) VALUES($1,$2,$3,$4,$4,$5,$6) ON CONFLICT(instrument_id,effective_date,source_id) DO UPDATE SET total_shares=EXCLUDED.total_shares,a_shares=EXCLUDED.a_shares,circulating_shares=EXCLUDED.circulating_shares,free_float_shares=EXCLUDED.free_float_shares,ingested_at=now()`,[master.instrumentId,day,sources.tushare,finite(b.total_share)==null?null:finite(b.total_share)*10000,finite(b.float_share)==null?null:finite(b.float_share)*10000,finite(b.free_share)==null?null:finite(b.free_share)*10000]);}
    for(const r of bundle.dividends||[]){const cash=finite(r.cash_div_tax),base=finite(r.base_share);await client.query(`INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,record_date,ex_date,pay_date,status,cash_per_share_pre_tax,cash_per_share_after_tax,stock_dividend_ratio,capitalization_ratio,base_shares,total_cash_amount,currency_code,source_id,source_key,raw_payload) VALUES($1,'dividend',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CNY',$14,$15,$16::jsonb) ON CONFLICT(source_id,source_key) DO UPDATE SET status=EXCLUDED.status,record_date=EXCLUDED.record_date,ex_date=EXCLUDED.ex_date,pay_date=EXCLUDED.pay_date,total_cash_amount=EXCLUDED.total_cash_amount,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,[master.instrumentId,asDate(r.end_date),asDate(r.ann_date||r.imp_ann_date),asDate(r.record_date),asDate(r.ex_date),asDate(r.pay_date),r.div_proc||'',cash,finite(r.cash_div),finite(r.stk_bo_rate),finite(r.stk_co_rate),base==null?null:base*10000,cash==null||base==null?null:cash*base*10000,sources.tushare,`${tsCode}:${rowVersion(r)}`,JSON.stringify(r)]);}
    for(const r of bundle.forecasts||[]){if(!asDate(r.end_date))continue;await client.query(`INSERT INTO fundamental.earnings_guidance(company_id,period_end,guidance_type,announced_at,profit_min,profit_max,change_min,change_max,summary,change_reason,currency_code,source_id,source_key,raw_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CNY',$11,$12,$13::jsonb) ON CONFLICT(source_id,source_key) DO UPDATE SET raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,[master.companyId,asDate(r.end_date),r.type||'forecast',asDate(r.ann_date),finite(r.net_profit_min)==null?null:finite(r.net_profit_min)*10000,finite(r.net_profit_max)==null?null:finite(r.net_profit_max)*10000,finite(r.p_change_min),finite(r.p_change_max),r.summary||'',r.change_reason||'',sources.tushare,`${tsCode}:${rowVersion(r)}`,JSON.stringify(r)]);}
    await client.query(`INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_attempt_at,last_error) VALUES($1,$2,$3,'financial',CURRENT_DATE,now(),'') ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=CURRENT_DATE,last_attempt_at=now(),last_error='',updated_at=now()`,[master.instrumentId,master.companyId,`${master.instrumentId}:${master.companyId}`]);
    for(const issue of bundle.valuationIssues||[])await client.query(`INSERT INTO ops.data_quality_issues(instrument_id,company_id,dataset_code,field_code,issue_type,details) VALUES($1,$2,'daily_basic',$3,'zero_after_retry',$4::jsonb) ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status) DO UPDATE SET details=EXCLUDED.details,detected_at=now(),resolved_at=NULL`,[master.instrumentId,master.companyId,issue.field,JSON.stringify(issue)]);
    await client.query(`UPDATE ops.ingestion_runs SET status='success',row_count=$2,finished_at=now() WHERE run_id=$1`,[run.run_id,count]);await client.query('COMMIT');return master;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function saveCollectedEvents(tsCode, events) {const client=await pool.connect();try{await client.query('BEGIN');const sources=await sourceIds(client),master=await ensureMaster(client,tsCode,sources);for(const r of events){const source=sources[r.source]||sources.calculated,key=hash(`${tsCode}|${r.source}|${r.url}|${r.title}`),documentId=r.is_official?(await client.query(`INSERT INTO event.documents(company_id,document_type,title,announced_at,url,source_id,content_hash,raw_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(source_id,url,content_hash) DO UPDATE SET title=EXCLUDED.title,announced_at=EXCLUDED.announced_at,raw_payload=EXCLUDED.raw_payload RETURNING document_id`,[master.companyId,r.category||'announcement',r.title,asDate(r.event_date),r.url||'',source,hash(r.title),JSON.stringify(r.raw||{})])).rows[0]?.document_id:null;await client.query(`INSERT INTO event.company_events(company_id,event_type,event_date,title,importance,is_official,source_id,document_id,source_key,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(source_id,source_key) DO UPDATE SET event_date=EXCLUDED.event_date,title=EXCLUDED.title,event_type=EXCLUDED.event_type,importance=EXCLUDED.importance,is_official=EXCLUDED.is_official,document_id=EXCLUDED.document_id,details=EXCLUDED.details`,[master.companyId,r.category||'other',asDate(r.event_date),r.title,r.is_official?10:1,Boolean(r.is_official),source,documentId,key,JSON.stringify(r.raw||{})]);}await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}

async function saveAnalysisResults(tsCode,analysis){const client=await pool.connect();try{await client.query('BEGIN');const sources=await sourceIds(client),master=await ensureMaster(client,tsCode,sources);await syncAnalytics(client,master.instrumentId,analysis,sources);await syncQualityIssues(client,master.instrumentId,master.companyId,analysis);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}

async function syncStockToArchitecture(tsCode, analysis, externalClient) {
  const client=externalClient||await pool.connect();
  const own=!externalClient;
  try{
    if(own)await client.query('BEGIN');
    const sources=await sourceIds(client),master=await ensureMaster(client,tsCode,sources);
    const run=(await client.query(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
      VALUES($1,'stock_analysis_architecture',$2::jsonb,'running') RETURNING run_id`,[sources.calculated,JSON.stringify({ts_code:tsCode})])).rows[0];
    const rawCount=await syncRawRecords(client,tsCode,run.run_id,sources.tushare);
    await syncMarket(client,tsCode,master.instrumentId,sources,master.currency);
    await syncFundamentals(client,tsCode,master.companyId,master.instrumentId,sources);
    await syncEvents(client,tsCode,master.companyId,sources);
    let currentAnalysis=analysis;
    if(!currentAnalysis){const snapshot=(await client.query('SELECT data FROM stock_analysis_snapshots WHERE ts_code=$1',[tsCode])).rows[0];currentAnalysis=snapshot&&snapshot.data;}
    await syncAnalytics(client,master.instrumentId,currentAnalysis,sources);
    await syncCursors(client,tsCode,master.instrumentId,master.companyId);
    await syncQualityIssues(client,master.instrumentId,master.companyId,currentAnalysis);
    await client.query(`UPDATE ops.ingestion_runs SET status='success',row_count=$2,finished_at=now() WHERE run_id=$1`,[run.run_id,rawCount]);
    if(own)await client.query('COMMIT');
    return {ts_code:tsCode,instrument_id:master.instrumentId,company_id:master.companyId};
  }catch(error){if(own)await client.query('ROLLBACK');throw error;}finally{if(own)client.release();}
}

async function backfillLegacyFinancialData() {
  const {rows}=await pool.query('SELECT ts_code FROM stock_analysis_stocks ORDER BY ts_code');
  const results=[];
  for(const row of rows)results.push(await syncStockToArchitecture(row.ts_code));
  return results;
}

module.exports={asDate,finite,analysisMetricValues,persistCollectedData,saveCollectedEvents,saveAnalysisResults,syncStockToArchitecture,backfillLegacyFinancialData};
