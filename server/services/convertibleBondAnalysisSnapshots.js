const { pool } = require('../db/connection');
const CoreDate = require('../../public/shared/core-date');
const crypto=require('crypto');
const { refreshConvertibleBondAnalysis, isoDate } = require('./convertibleBondAnalysis');
const { latestAnalysisDate, loadAnalysisUniverse, persistAnalysisProgress } = require('../repositories/convertibleBondAnalysisSnapshotsRepository.js');
const repository = require('../repositories/convertibleBondAnalysisSnapshotsRepository.js');

/* loadAnalysisUniverse 已迁入 server/repositories/convertibleBondAnalysisSnapshotsRepository.js */

/* persistAnalysisProgress 已迁入 server/repositories/convertibleBondAnalysisSnapshotsRepository.js */

async function refreshAllConvertibleBondAnalysis(targetDate, deps = {}) {
  const load = deps.loadUniverse || loadAnalysisUniverse;
  const build = deps.build || ((code,date)=>refreshConvertibleBondAnalysis(code,'daily',{readOnly:true,targetDate:date}));
  const persist = deps.persist || persistAnalysisProgress;
  const rows = await load(targetDate);
  const prior=deps.loadUniverse ? null : (await repository.select_ops_sync_cursors()).rows[0]?.cursor_payload;
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

/* latestAnalysisDate 已迁入 server/repositories/convertibleBondAnalysisSnapshotsRepository.js */

module.exports={loadAnalysisUniverse,persistAnalysisProgress,refreshAllConvertibleBondAnalysis,latestAnalysisDate};
