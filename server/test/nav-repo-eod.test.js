const assert=require('assert');
const {completedRepoTarget,ensureNavRepoRate,normalize,shouldRepublishRepoReport,repoReportPublication,buildRepoReport}=require('../services/repoDailyRates');
const {publishJobDatasets}=require('../services/datasetPartitionRegistry');
const {loadCandidates}=require('../services/hkDailyCoverage');
(async()=>{
  const {isCashIncomeDependencyWait}=require('../jobs/navSnapshot');
  const wait=[{diagnostics:[{reason:'cash_income_recalculation_incomplete',pending:[{reason:'missing_repo_daily_rate'}]}]}];
  assert.strictEqual(isCashIncomeDependencyWait(wait,{ok:false,failures:[{code:'EMPTY_DATA'}]}),true);
  assert.strictEqual(isCashIncomeDependencyWait(wait,{ok:false,failures:[{code:'PERMISSION_DENIED'}]}),false);
  assert.strictEqual(isCashIncomeDependencyWait([{error:'坏数据'}],null),false);
  assert.strictEqual(isCashIncomeDependencyWait([{diagnostics:[{reason:'missing_prices',pending:[{reason:'missing_repo_daily_rate'}]}]}],null),false);
  assert.strictEqual(isCashIncomeDependencyWait([{diagnostics:[{reason:'cash_income_recalculation_incomplete',pending:[{reason:'missing_acquisition_date'}]}]}],null),false);
  assert.strictEqual(isCashIncomeDependencyWait([],null),false);
  // NAV-REPO-EOD-001: 上海收盘边界与缺口定点补采。
  const options={allowCompletedToday:true,now:new Date('2026-10-13T07:29:59Z')};
  assert.strictEqual(completedRepoTarget('2026-10-13',options),false);
  options.now=new Date('2026-10-13T07:30:00Z');
  assert.strictEqual(completedRepoTarget('2026-10-13',options),true);
  assert.strictEqual(completedRepoTarget('2026-10-13',{now:options.now}),false);
  assert.strictEqual(completedRepoTarget('2026-10-14',options),false);
  assert.strictEqual(completedRepoTarget('2026-10-12',options),true);
  assert.strictEqual(completedRepoTarget('2026-10-11',{allowCompletedToday:true,now:new Date('2026-10-11T08:00:00Z')}),false);
  let enabled=2,saved=true,calls=0,republications=0;
  const query=async(sql,params)=>{
    if(sql.includes('COUNT(*)')) return {rows:[{enabled_count:enabled}]};
    assert.match(sql,/quality_status='passed'/);
    assert.deepStrictEqual(params,['2026-10-13']);
    return {rows:saved?[{exists:1}]:[]};
  };
  const sync=async args=>{calls++;assert.deepStrictEqual(args,{targetDate:'2026-10-13',startDate:'2026-10-13',allowCompletedToday:true});return {ok:true};};
  const republish=async date=>{republications++;return {ok:true,republished:true,targetDate:date};};
  // 事实已落库 + 同日分区已发布：不重采、不补发。
  const published=await ensureNavRepoRate('2026-10-13',{query,sync,partitionState:async()=>({published:true}),republish});
  assert.ok(published, '事实在库且分区已发布时必须返回完成结果，不能返回 null');
  assert.strictEqual(published.ok,true);
  assert.strictEqual(published.republished,false);
  assert.strictEqual(calls,0);
  assert.strictEqual(republications,0);
  // 事实已落库但分区发布失败（上一次半成品）：只补发同日分区，不再请求上游。
  const missing=await ensureNavRepoRate('2026-10-13',{query,sync,partitionState:async()=>({published:false}),republish});
  assert.ok(missing, '事实在库但分区缺失时必须返回补发结果，不能返回 null');
  assert.strictEqual(missing.ok,true);
  assert.strictEqual(missing.republished,true);
  assert.strictEqual(republications,1);
  assert.strictEqual(calls,0,'事实已落库时不得再请求上游');
  // 补发失败必须保留失败分类，不能被当成"上游未发布"。
  const republishFailed=await ensureNavRepoRate('2026-10-13',{query,sync,partitionState:async()=>({published:false}),
    republish:async()=>{const error=new Error('分区写入失败');error.code='42P01';throw error;}});
  assert.strictEqual(republishFailed.ok,false);
  assert.strictEqual(republishFailed.errorCode,'42P01');
  assert.ok(republishFailed.failures.length, '补发异常必须带回失败证据');
  saved=false;
  assert.strictEqual((await ensureNavRepoRate('2026-10-13',{query,sync,partitionState:async()=>({published:false}),republish})).ok,true);
  assert.strictEqual(calls,1);
  const failed=await ensureNavRepoRate('2026-10-13',{query,sync:async()=>{throw new Error('上游空响应');}});
  assert.strictEqual(failed.ok,false);
  // 事实齐且同日分区已合格时必须零写入（共享采集每次都要同步上一交易日利率）。
  assert.strictEqual(shouldRepublishRepoReport({ok:true},{published:true}),false,
    '事实齐且分区已合格时不得重复发布，否则会刷新 published_at、覆盖 source_id');
  assert.strictEqual(shouldRepublishRepoReport({ok:true},{published:false}),true,'分区缺失时必须发布');
  assert.strictEqual(shouldRepublishRepoReport({ok:true},null),true,'拿不到分区状态时保守发布');
  assert.strictEqual(shouldRepublishRepoReport({ok:false},{published:true}),true,
    '事实未齐时仍要发布缺口/拒绝证据，不能被跳过');
  // 区间有缺口、但目标日本身齐全：分区必须保持 published/passed，
  // 缺口留在 report.remaining 里继续续跑（复验：10-12 缺数、10-13 已齐）。
  const targetOnly=repoReportPublication({targetDate:'2026-10-13',ok:false,targetDateComplete:true,remaining:['2026-10-12'],remainingCount:1});
  assert.strictEqual(targetOnly.status,'published','更早日期的缺口不得把目标日分区降为 rejected');
  assert.strictEqual(targetOnly.qualityStatus,'passed');
  assert.strictEqual(targetOnly.rowCount,1,'目标日只有一行，rowCount 不得用区间条数');
  assert.strictEqual(shouldRepublishRepoReport({ok:false,targetDateComplete:true},{published:true}),false,
    '目标日已齐且分区已合格时，历史缺口不得触发重写');
  // 目标日本身缺数：才写 rejected 留痕。
  const targetMissing=repoReportPublication({targetDate:'2026-10-13',ok:false,targetDateComplete:false,remaining:['2026-10-13'],remainingCount:1});
  assert.strictEqual(targetMissing.status,'rejected');
  assert.strictEqual(targetMissing.qualityStatus,'failed');
  assert.strictEqual(targetMissing.rowCount,0);
  assert.strictEqual(shouldRepublishRepoReport({ok:false,targetDateComplete:false},{published:true}),true,
    '目标日本身缺数时仍要发布 rejected 留痕');
  // 旧形态（没有 targetDateComplete）回退到 ok，保持兼容。
  assert.strictEqual(repoReportPublication({ok:true}).status,'published');
  assert.strictEqual(repoReportPublication({ok:false}).status,'rejected');
  // 历史休市日：区间交易日为 0 时不得被当成"已齐全"而发布分区。
  const holiday=repoReportPublication({targetDate:'2026-10-11',targetDateIsTradingDay:false,targetDateComplete:false,ok:true,remaining:[],remainingCount:0});
  assert.strictEqual(holiday.skip,true,'休市日必须跳过发布，不能写出 published/passed');
  assert.strictEqual(holiday.status,null);
  assert.strictEqual(holiday.rowCount,0,'休市日不得记 row_count=1');
  assert.strictEqual(shouldRepublishRepoReport({targetDateIsTradingDay:false,ok:true},null),false,
    '休市日不外采、不发布分区');
  // 交易日不受这条跳过影响。
  assert.strictEqual(repoReportPublication({targetDate:'2026-10-13',targetDateIsTradingDay:true,targetDateComplete:true,ok:true}).status,'published');
  // 休市日报告必须自带"跳过发布"：门禁按 repo_daily 阶段契约要求分区已存在，
  // 不声明跳过就会把正常休市报成"数据集分区未全部发布"。
  const holidayReport=buildRepoReport({targetDate:'2026-10-11',startDate:'2026-10-11',expected:[],remaining:[],failures:[],samples:[],ok:true});
  assert.strictEqual(holidayReport.targetDateIsTradingDay,false);
  assert.strictEqual(holidayReport.skipDatasetPublication,true,'休市日必须声明跳过发布');
  assert.deepStrictEqual(holidayReport.publishDatasetCodes,[],'休市日不得提交发布清单');
  const tradingReport=buildRepoReport({targetDate:'2026-10-13',startDate:'2026-10-13',expected:['2026-10-13'],remaining:[],failures:[],samples:[],ok:true});
  assert.strictEqual(tradingReport.skipDatasetPublication,false);
  assert.deepStrictEqual(tradingReport.publishDatasetCodes,['repo_daily_rates']);
  // 正式发布门禁复验：休市日 repo_daily 阶段必须正常跳过，不得抛"分区未全部发布"。
  const skipped=await publishJobDatasets('convertible_bond_universe_refresh','2026-10-11',
    {mode:'repo_daily',ok:true,skipDatasetPublication:true,publishDatasetCodes:[]});
  assert.deepStrictEqual(skipped,[],'休市日不得被发布门禁判成未发布');
  // 防误用：声明跳过却仍提交发布清单必须报错，不能拿它绕过发布。
  await assert.rejects(
    ()=>publishJobDatasets('convertible_bond_universe_refresh','2026-10-11',
      {mode:'repo_daily',ok:true,skipDatasetPublication:true,publishDatasetCodes:['repo_daily_rates']}),
    /声明跳过发布却仍提交了发布清单/,
  );
  // 非法输入一律拒绝：省略清单、非数组清单、非法日期都不能借"休市"通过门禁。
  await assert.rejects(
    ()=>publishJobDatasets('convertible_bond_universe_refresh','2026-10-11',
      {mode:'repo_daily',skipDatasetPublication:true,ok:true}),
    /跳过发布必须显式提交空发布清单/,
    '省略发布清单不得通过门禁',
  );
  await assert.rejects(
    ()=>publishJobDatasets('convertible_bond_universe_refresh','2026-10-11',
      {mode:'repo_daily',skipDatasetPublication:true,publishDatasetCodes:'repo_daily_rates',ok:true}),
    /跳过发布必须显式提交空发布清单/,
    '非数组发布清单不得通过门禁',
  );
  await assert.rejects(
    ()=>publishJobDatasets('convertible_bond_universe_refresh','2026-10-11',
      {mode:'repo_daily',skipDatasetPublication:true,publishDatasetCodes:{},ok:true}),
    /跳过发布必须显式提交空发布清单/,
    '对象形式的发布清单不得通过门禁',
  );
  for (const invalidDate of ['2026-13-01','2026-02-30','2026-02-29','2026-00-10','2026-1-1','']) {
    await assert.rejects(
      ()=>publishJobDatasets('convertible_bond_universe_refresh',invalidDate,
        {mode:'repo_daily',skipDatasetPublication:true,publishDatasetCodes:[],ok:true}),
      /业务日无效/,
      `非法日期 ${invalidDate} 不得跳过发布`,
    );
  }
  // 例外必须收窄：未登记的任务/阶段不得跳过发布门禁。
  await assert.rejects(
    ()=>publishJobDatasets('nav_snapshot','2026-10-11',
      {skipDatasetPublication:true,publishDatasetCodes:[],ok:true}),
    /未登记可跳过发布/,
  );
  await assert.rejects(
    ()=>publishJobDatasets('convertible_bond_universe_refresh','2026-10-11',
      {mode:'core',skipDatasetPublication:true,publishDatasetCodes:[],ok:true}),
    /未登记可跳过发布/,
  );
  // 独立核验：交易日不得以"跳过"名义越过发布门禁（2026-11-19 周四）。
  await assert.rejects(
    ()=>publishJobDatasets('convertible_bond_universe_refresh','2026-11-19',
      {mode:'repo_daily',skipDatasetPublication:true,publishDatasetCodes:[],ok:true}),
    /是交易日，不得跳过发布/,
  );

  // 历史缺口必须继续留痕并可续跑：remaining 不能按目标日裁剪，重试间隔仍为 15 分钟。
  const repoDailyRatesSource=require('fs').readFileSync(require('path').join(__dirname,'../services/repoDailyRates.js'),'utf8');
  assert(/targetDateComplete:targetDateIsTradingDay&&!remaining\.includes\(targetDate\)/.test(repoDailyRatesSource),
    '目标日齐全标记必须同时看开市与缺口，不能只看区间 ok');
  assert(/nextAttemptInMinutes:remaining.length\?15:null/.test(repoDailyRatesSource),
    '历史缺口必须保留续跑节奏，不能被目标日口径抹掉');
  assert(/if\(publication\.skip\) return report;/.test(repoDailyRatesSource),
    '休市日必须在真正写分区之前直接返回，不能靠状态取值绕过');
  // 上游无效利率（返回了目标日记录但字段无效）必须区别于"尚未发布"。
  assert.throws(()=>normalize({ts_code:'204001.SH',repo_maturity:'1',trade_date:'20261013',weight:null,close:null}),
    error=>error.code==='INVALID_DATA','缺利率字段必须按无效数据分类');
  assert.throws(()=>normalize({ts_code:'131810.SZ',repo_maturity:'1',trade_date:'20261013',weight:1.5,close:1.5}),
    error=>error.code==='INVALID_DATA','非目标回购证券必须按无效数据分类');
  enabled=0;
  assert.strictEqual(await ensureNavRepoRate('2026-10-13',{query,sync,partitionState:async()=>({published:false}),republish}),null);
  assert.strictEqual(calls,1);
  // HK-DAILY-LIFECYCLE-001: 定向代码也不能跳过目标日上市生命周期。
  await loadCandidates({query:async(sql,params)=>{
    assert.match(sql,/i.list_date IS NOT NULL AND i.list_date::date <= \$1::date/);
    assert.deepStrictEqual(params,['2026-10-13',['02636.HK']]);
    return {rows:[]};
  }},'2025-08-04','2026-10-13',null,['02636.HK']);
  console.log('NAV-REPO-EOD-001 / HK-DAILY-LIFECYCLE-001 passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
