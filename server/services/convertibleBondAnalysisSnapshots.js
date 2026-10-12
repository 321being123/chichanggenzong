const { pool } = require('../db/connection');
const CoreDate = require('../../public/shared/core-date');
const crypto=require('crypto');
const { refreshConvertibleBondAnalysis, isoDate } = require('./convertibleBondAnalysis');

async function loadAnalysisUniverse(targetDate) {
  const { rows } = await pool.query(`SELECT i.instrument_id,i.canonical_code AS ts_code,p.bond_short_name,p.bond_full_name,
    s.canonical_code AS stock_code,p.value_date::text,p.maturity_date::text,p.raw_payload,
    p.fundraising_purpose,p.rate_clause,p.first_conv_price,p.updated_at::text AS profile_version
    FROM core.instruments i JOIN fundamental.convertible_bond_profiles p USING(instrument_id)
    JOIN public.bond_unified u USING(instrument_id)
    LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
    WHERE u.status='listed' AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
    AND (i.list_date IS NULL OR i.list_date<=$1::date) AND (i.delist_date IS NULL OR i.delist_date>$1::date)
    AND (p.maturity_date IS NULL OR p.maturity_date>=$1::date)
    AND (p.conv_end_date IS NULL OR p.conv_end_date>=$1::date)
    AND (p.conv_stop_date IS NULL OR p.conv_stop_date>$1::date)
    AND EXISTS(SELECT 1 FROM market.convertible_bond_daily_metrics m WHERE m.instrument_id=i.instrument_id AND m.trade_date=$1::date)
    ORDER BY i.canonical_code`,[targetDate]);
  return rows;
}

async function persistAnalysisProgress(datasetCode, targetDate, state) {
  await pool.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,cursor_payload,last_attempt_at,last_success_date,last_error)
    VALUES($5,$1,$2::jsonb,now(),$3,$4)
    ON CONFLICT(scope_key,dataset_code) DO UPDATE SET cursor_payload=EXCLUDED.cursor_payload,last_attempt_at=now(),
    last_success_date=COALESCE(GREATEST(ops.sync_cursors.last_success_date,EXCLUDED.last_success_date),ops.sync_cursors.last_success_date),
    last_error=EXCLUDED.last_error,updated_at=now()`,
  [datasetCode,JSON.stringify({targetDate,...state}),state.remaining.length || !state.expected ? null : targetDate,
    state.remaining.length || !state.expected?'资料或计算尚未完成':'',state.scopeKey||'convertible_bond_analysis']);
}

async function refreshAllConvertibleBondAnalysis(targetDate, deps = {}) {
  const load = deps.loadUniverse || loadAnalysisUniverse;
  const build = deps.build || ((code,date)=>refreshConvertibleBondAnalysis(code,'daily',{readOnly:true,targetDate:date}));
  const persist = deps.persist || persistAnalysisProgress;
  const rows = await load(targetDate);
  const prior=deps.loadUniverse ? null : (await pool.query(`SELECT cursor_payload FROM ops.sync_cursors
    WHERE scope_key='convertible_bond_analysis' AND dataset_code='snapshots'`)).rows[0]?.cursor_payload;
  const resume=prior?.targetDate===targetDate&&prior.pendingStages?.length ? prior.completed||{} : {};
  const completed={};
  const remaining = [], missingFields = {}, failures = [];
  let count = 0;
  for (const row of rows) {
    const inputHash=crypto.createHash('sha256').update(JSON.stringify({version:row.profile_version,raw:row.raw_payload})).digest('hex');
    try {
      if(resume[row.ts_code]===inputHash){count++;completed[row.ts_code]=inputHash;continue;}
      const analysis = await build(row.ts_code,targetDate);
      if (isoDate(analysis.as_of)!==targetDate) throw new Error('分析日期与任务目标日不一致');
      count++;
      completed[row.ts_code]=inputHash;
      if (analysis.completeness?.missing.length) missingFields[row.ts_code]=analysis.completeness.missing;
    } catch (error) { remaining.push(row.ts_code);failures.push({code:row.ts_code,error:error.message}); }
    await persist('snapshots',targetDate,{count,expected:rows.length,remaining:[...remaining,...rows.slice(count+failures.length).map(b=>b.ts_code)],completed,failures,missingFields,
      pendingStages:['analysis_snapshot'],nextRunAt:new Date(Date.now()+15*60000).toISOString()});
  }
  const empty = rows.length===0;
  const state = {count,expected:rows.length,remaining,completed,failures,missingFields,
    pendingStages:remaining.length||empty?['analysis_snapshot']:[],
    nextRunAt:remaining.length||empty?new Date(Date.now()+15*60000).toISOString():null};
  await persist('snapshots',targetDate,state);
  return {ok:!empty&&!remaining.length,status:!empty&&!remaining.length?'succeeded':'partial',
    dataAsOf:targetDate,externalCalls:0,...state,remainingCount:remaining.length,
    ...(empty||remaining.length?{failedDatasets:['bond_analysis_snapshot'],errorType:'data_quality',error:'详细分析快照覆盖未完成'}:{})};
}

async function latestAnalysisDate() {
  const {rows}=await pool.query('SELECT MAX(trade_date)::text AS date FROM market.convertible_bond_daily_metrics');
  return CoreDate.normalizeBusinessDate(rows[0]?.date);
}

module.exports={loadAnalysisUniverse,persistAnalysisProgress,refreshAllConvertibleBondAnalysis,latestAnalysisDate};
