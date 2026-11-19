// GC001 市场日加权利率唯一采集入口；计算和页面只读标准事实。
const {pool}=require('../db/connection');
const CoreDate=require('../../public/shared/core-date');
const {resolveInstrument}=require('./securityIdentity');
const {loadHolidays}=require('../config/holidays');
const crypto=require('crypto');
const repository = require('../repositories/repoDailyRatesRepository.js');
const txControl = require('../repositories/transactionControl');
const CODE='204001.SH', DOC='https://tushare.pro/document/2?doc_id=256';
function day(value) {const s=String(value||'').replace(/-/g,'');return /^\d{8}$/.test(s)?CoreDate.normalizeBusinessDate(s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6)):null;}
// 「上游返回了目标日记录但数据无效」与「未返回目标日记录」是两件事：
// 前者必须按真实失败计数与退避，只有后者才是"尚未发布"。
function invalidDataError(message){const error=new Error(message);error.code='INVALID_DATA';error.errorType='data_quality';return error;}
function normalize(row) {
  const date=day(row.trade_date);
  if(row.ts_code!==CODE || !date || !/^(GC001|1|1天|1D)$/i.test(String(row.repo_maturity))) throw invalidDataError('回购证券、期限或日期不匹配');
  for(const k of ['weight','close']) if(row[k]==null || row[k]==='' || !Number.isFinite(Number(row[k]))) throw invalidDataError('缺少有效回购利率：'+k);
  return {date,weighted:Number(row.weight)/100,close:Number(row.close)/100,unit:'annual_decimal',tenor:1};
}
function tradingDates(start,end) {
  const {calendarFor,shiftDay}=require('./cashIncome');
  const trading=calendarFor(loadHolidays().years),dates=[];
  for(let d=start;d<=end;d=shiftDay(d)) if(trading(d)) dates.push(d);
  return dates;
}
function completedRepoTarget(targetDate,{allowCompletedToday=false,now=new Date()}={}) {
  const today=CoreDate.dateInZone(now,'Asia/Shanghai');
  const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  return Boolean(CoreDate.normalizeBusinessDate(targetDate)&&targetDate<=today&&(targetDate<today||allowCompletedToday&&clock>='15:30'&&tradingDates(today,today).length));
}
async function syncRepoDailyRates({targetDate,startDate,probe=false,allowCompletedToday=false}={}) {
  if(!startDate) {
    const anchors=(await repository.select_nav_history([targetDate])).rows[0];
    startDate=anchors?.start_date||targetDate;
  }
  if(!completedRepoTarget(targetDate,{allowCompletedToday})||!CoreDate.normalizeBusinessDate(startDate)||startDate>targetDate) throw new Error('回购采集仅接受已完成交易日区间');
  let identity=await resolveInstrument({canonicalCode:CODE});
  if(!identity) {
    const master=await require('./securityIdentity').ensureInstrumentIdentity({canonicalCode:CODE,name:'GC001',assetClass:'repo',market:'CN',exchangeCode:'SSE',currencyCode:'CNY',status:'listed'});
    identity={instrument_id:master.instrumentId};
  }
  const source=(await repository.select_ops_data_sources()).rows[0].source_id;
  const expected=tradingDates(startDate,targetDate);
  const saved=(await repository.select_market_repo_daily_rates([identity.instrument_id,startDate,targetDate])).rows.map(r=>r.trade_date);
  const missing=expected.filter(d=>!saved.includes(d));
  const requested=probe?expected:missing;
  const failures=[],samples=[];
  // 单品种按完整自然年分批，每批最多366天，不会触碰官方2000行截断；业务范围不截断。
  for(const year of [...new Set(requested.map(d=>d.slice(0,4)))]) {
    const dates=requested.filter(d=>d.startsWith(year));
    try {
      // 回购利率属于「资金数据集」：只向数据层要，来源与请求形状由数据层负责。
      const rows=await require('../dataAccess/referenceDatasets')
        .readRepoRates({ tsCode: CODE, startDate: dates[0], endDate: dates.at(-1) });
      if(rows.length>=2000) throw new Error('回购响应可能截断');
      const seen=new Set();
      for(const row of rows) {
        const value=normalize(row);
        if(!expected.includes(value.date)) continue;
        if(seen.has(value.date)) throw new Error('回购重复交易日');
        seen.add(value.date);
        const payloadHash=crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
        const client=await pool.connect();
        try {
          await txControl.begin(client);
          const raw=(await repository.insert_ops_raw_records([source,CODE+':'+value.date,row,payloadHash], client)).rows[0];
          await repository.insert_market_repo_daily_rates([identity.instrument_id,value.date,source,value.weighted,value.close,raw.raw_record_id,payloadHash], client);
          await txControl.commit(client);samples.push({...row,weighted_annual_rate:value.weighted});
        } catch(e) {await txControl.rollback(client);throw e;} finally {client.release();}
      }
    } catch(e) {
      // 只有明确的数据源未发布类错误才沿用其 code；其余（含字段无效、响应截断、
      // 落库异常）一律按真实失败登记，避免被当成"上游还没发布"而进入等待队列。
      failures.push({year,message:e.message,code:e.code||'REPO_RATE_SYNC_FAILED'});
    }
  }
  const current=(await repository.select_market_repo_daily_rates([identity.instrument_id,startDate,targetDate])).rows.map(r=>r.trade_date);
  const remaining=expected.filter(d=>!current.includes(d));
  const ok=!remaining.length&&!failures.length;
  // 分区只覆盖 targetDate 一天：状态必须按目标日自身是否齐全判定。
  // 补采区间里更早的缺口（例如 10-12 缺数、10-13 已齐）只留在 report.remaining 里续跑，
  // 不能把合格的目标日分区降级成 rejected。
  const report=buildRepoReport({targetDate,startDate,expected,remaining,failures,samples,ok});
  // 事实已齐且同日分区已合格时零写入：共享采集每次都要同步上一交易日利率，
  // 无条件重发会刷新 published_at、把既有 source_id 覆盖成 NULL。
  const partitionState=await readRepoPartitionState(targetDate).catch(()=>null);
  const republish=shouldRepublishRepoReport(report,partitionState);
  if(republish) await publishRepoReport(report,source);
  report.partitionPublication=report.targetDateIsTradingDay===false
    ? 'skipped_non_trading_day'
    : (republish?'published':'already_published');
  return report;
}
// 分区发布状态只看目标日：区间内其他日期的缺口仍由 report.remaining 留痕与续跑。
// 目标日不是交易日时必须整体跳过：那天本来就没有（也不该有）利率事实，
// 不能因为"区间缺口为空"就写成 published/passed 并记 row_count=1。
function repoReportPublication(report) {
  const tradingDay = report && report.targetDateIsTradingDay !== undefined
    ? report.targetDateIsTradingDay === true
    : true;
  if (!tradingDay) {
    return { skip: true, complete: false, status: null, qualityStatus: null, queryStatus: null, rowCount: 0 };
  }
  const complete = report && report.targetDateComplete !== undefined
    ? report.targetDateComplete === true
    : Boolean(report && report.ok === true);
  return {
    skip: false,
    complete,
    status: complete ? 'published' : 'rejected',
    qualityStatus: complete ? 'passed' : 'failed',
    queryStatus: complete ? 'success' : 'incomplete',
    // 注册表按 trade_date 数行，GC001 一天只有一行。
    rowCount: complete ? 1 : 0,
  };
}

// 分区发布与事实采集分开：事实已落库时只需要按同日事实补发分区，不必再请求上游。
// 目标日事实已齐且同日分区已合格时不得重复发布：共享采集任务每次运行都会同步上一交易日利率，
// 无条件重发会刷新 published_at、让"分区被更新"被误读成新数据到达。
// 目标日本身缺数时仍要发布 rejected/缺口证据，不能被这里跳过。
function shouldRepublishRepoReport(report, partitionState) {
  if (!report) return true;
  // 非交易日没有可发布的事实，也不该留下任何分区记录。
  if (report.targetDateIsTradingDay === false) return false;
  const targetComplete = report.targetDateComplete !== undefined
    ? report.targetDateComplete === true
    : report.ok === true;
  if (!targetComplete) return true;
  return !(partitionState && partitionState.published === true);
}

async function publishRepoReport(report,source) {
  const publication=repoReportPublication(report);
  if(publication.skip) return report;
  await require('./datasetPartitions').publishDatasetPartition('repo_daily_rates','CN',{
    partitionKey:report.targetDate,dataAsOf:report.targetDate,
    status:publication.status,
    rowCount:publication.rowCount,
    sourceId:source,
    diagnostics:{...report,quality_status:publication.qualityStatus,query_status:publication.queryStatus},
  });
  return report;
}
async function loadRepoRates(executor=pool.query.bind(pool)) {
  const rows=(await repository.loadRepoRates(executor,CODE)).rows;
  return Object.fromEntries(rows.map(r=>[r.trade_date,{annualRate:Number(r.weighted_annual_rate),sourceId:r.source_id,rawRecordId:r.raw_record_id,sourceRevision:r.source_revision}]));
}
// 用已落库的同日事实补发分区：不调用 Tushare，也不写新事实。
// 「事实成功、分区发布失败」是上一次运行留下的半成品，重试必须能把它补齐，
// 否则调度重验永远看不到同日分区，只能等到硬截止。
async function republishRepoDailyPartition(targetDate) {
  const identity=await resolveInstrument({canonicalCode:CODE});
  if(!identity) throw invalidDataError('缺少回购证券主档，无法补发同日分区');
  const source=(await repository.select_ops_data_sources()).rows[0]?.source_id||null;
  const expected=tradingDates(targetDate,targetDate);
  const saved=(await repository.select_market_repo_daily_rates([identity.instrument_id,targetDate,targetDate])).rows.map(r=>r.trade_date);
  const remaining=expected.filter(d=>!saved.includes(d));
  const ok=!remaining.length;
  const report={...buildRepoReport({targetDate,startDate:targetDate,expected,remaining,failures:[],samples:[],ok}),republished:true};
  return publishRepoReport(report,source);
}

function buildRepoReport({targetDate,startDate,expected,remaining,failures,samples,ok}) {
  // 目标日是否开市：区间 tradingDates 只含交易日，所以"目标日在 expected 里"就是开市日。
  // 休市日既没有缺口也不该有分区，必须与"交易日已齐"区分开。
  const targetDateIsTradingDay=expected.includes(targetDate);
  return {ok,stageComplete:ok,mode:'repo_daily',
    // 休市日本阶段没有可发布对象：交给发布门禁按"跳过"处理，
    // 否则门禁会按 repo_daily 阶段契约要求 repo_daily_rates 分区已发布并报错。
    publishDatasetCodes:targetDateIsTradingDay?['repo_daily_rates']:[],
    skipDatasetPublication:!targetDateIsTradingDay,
    status:ok?'succeeded':'partial',dataAsOf:targetDate,code:CODE,startDate,targetDate,expectedDays:expected.length,remaining,remainingCount:remaining.length,
    // 分区只写 targetDate 一天：这个标记决定该分区是 published 还是 rejected，
    // 与整段补采区间的 ok 分开，避免更早日期的缺口把目标日分区降级。
    targetDateComplete:targetDateIsTradingDay&&!remaining.includes(targetDate),
    targetDateIsTradingDay,
    failures,samples,unit:'annual_decimal',conversion:'weight / 100',officialDocumentation:DOC,publishDatasets:false,failedDatasets:ok?[]:['repo_daily_rates'],pendingStages:ok?[]:['repoDailyRates'],nextAttemptInMinutes:remaining.length?15:null};
}

// 同日分区是否已发布且质量通过：事实在库但分区缺失时，只有这里能区分"已就绪"与"待补发"。
// 必须按目标日精确查询——补跑历史日时"最新分区"通常是更晚的日期，
// 用最新分区判断会把存在的历史分区判成缺失，触发多余补发并重写分区。
async function readRepoPartitionState(targetDate,{readPartition}={}) {
  const read=readPartition||((datasetCode,scopeKey,partitionKey)=>require('./datasetPartitions').getPartition(datasetCode,scopeKey,partitionKey));
  const partition=await read('repo_daily_rates','CN',targetDate);
  if(!partition) return {published:false,partitionKey:null,quality:null,status:null};
  const quality=partition.diagnostics&&partition.diagnostics.quality_status;
  return {
    published:partition.status==='published'&&partition.is_stale!==true&&quality==='passed',
    partitionKey:String(partition.partition_key||''),quality,status:partition.status||null,
  };
}

function syncFailure(error) {
  // 落库/发布异常（例如分区写入失败）不是"上游还没发布"：必须保留失败分类，
  // 否则净值任务会把缺失的 failures 当成空数组、当作数据未发布而进等待队列，
  // 真实故障因此绕过失败计数与退避。
  const code=String((error&&(error.code||error.errorCode))||'REPO_RATE_SYNC_FAILED').toUpperCase();
  return {ok:false,status:'failed',error:error&&error.message,errorCode:code,
    errorType:(error&&(error.errorType||error.type))||'internal',
    failures:[{code,message:error&&error.message}]};
}

async function ensureNavRepoRate(targetDate,{query=pool.query.bind(pool),sync=syncRepoDailyRates,partitionState=readRepoPartitionState,republish=republishRepoDailyPartition}={}) {
  const {rows:enabled}=await repository.countEnabledAccounts(query);
  if(!Number(enabled[0]?.enabled_count)||!tradingDates(targetDate,targetDate).length) return null;
  const {rows:rates}=await repository.findRateForDate(query,targetDate);
  if(rates.length) {
    // 事实已在库：只核对/补发同日分区，绝不重复请求上游。
    const state=await partitionState(targetDate);
    if(state&&state.published) return {ok:true,status:'succeeded',stageComplete:true,targetDate,code:CODE,republished:false,partition:'already_published',failures:[],remainingCount:0,unit:'annual_decimal',conversion:'weight / 100'};
    return republish(targetDate).catch(error=>syncFailure(error));
  }
  return sync({targetDate,startDate:targetDate,allowCompletedToday:true}).catch(error=>syncFailure(error));
}
module.exports={normalize,tradingDates,syncRepoDailyRates,loadRepoRates,completedRepoTarget,ensureNavRepoRate,
  republishRepoDailyPartition,readRepoPartitionState,shouldRepublishRepoReport,repoReportPublication,publishRepoReport,buildRepoReport,
  isInvalidRepoRateError:error=>Boolean(error&&error.code==='INVALID_DATA')};
