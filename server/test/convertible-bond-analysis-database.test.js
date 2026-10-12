const assert=require('assert');
require('dotenv').config();
if(process.env.NODE_ENV!=='test')throw new Error('本回归只允许使用隔离测试库');
const {pool}=require('../db/connection');
const {buildConvertibleBondAnalysisFromDatabase}=require('../services/convertibleBondAnalysis');
const express=require('express');
const bondRouter=require('../routes/bondAnalysis');
let ids=[],server;
(async()=>{
  const source=(await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare'")).rows[0].source_id;
  const stock=(await pool.query("INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code) VALUES('009991.SZ','测试正股','stock','CN','SZSE') RETURNING instrument_id")).rows[0].instrument_id;
  ids.push(stock);
  const bond=(await pool.query("INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code) VALUES('127991.SZ','测试转债','convertible_bond','CN','SZSE') RETURNING instrument_id")).rows[0].instrument_id;
  ids.push(bond);
  const profile={ts_code:'127991.SZ',stk_code:'009991.SZ',bond_short_name:'测试转债',value_date:'2024-01-01',maturity_date:'2030-01-01',
    call_clause:'连续30个交易日中至少15个交易日收盘价不低于转股价格的130%',reset_clause:'连续30个交易日中至少15个交易日收盘价低于转股价格的85%',
    put_clause:'最后两个计息年度连续30个交易日收盘价低于转股价格的70%',rate_clause:'第一年0.3%、第二年0.5%、第三年1%、第四年1.5%、第五年1.8%、第六年2%',maturity_call_price:'110',issue_rating:'AA+'};
  await pool.query(`INSERT INTO fundamental.convertible_bond_profiles(instrument_id,stock_instrument_id,bond_short_name,current_conv_price,
    value_date,maturity_date,rate_clause,maturity_call_price,issue_rating,raw_payload) VALUES($1,$2,'测试转债',10,'2024-01-01','2030-01-01',$3,'110','AA+',$4::jsonb)`,[bond,stock,profile.rate_clause,JSON.stringify(profile)]);
  await pool.query("INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close) VALUES($1,'2026-09-30',$2,12)",[stock,source]);
  await pool.query("INSERT INTO market.convertible_bond_daily_metrics(instrument_id,trade_date,source_id,close,bond_value) VALUES($1,'2026-09-30',$2,115,105)",[bond,source]);
  await pool.query("INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pb,dividend_yield_ttm) VALUES($1,'2026-09-30',$2,1.2,0.025)",[stock,source]);
  await pool.query(`INSERT INTO fundamental.convertible_bond_ratings(instrument_id,rating_date,announced_at,rating_company,rating,rating_outlook,raw_payload)
    VALUES($1,'2026-06-23','2026-06-25','测试机构','AA+','稳定','{"outlook_inferred_from_date":"2025-06-23"}')`,[bond]);
  // BOND-ANALYSIS-003: 真实PG无快照公开读取完整本地分析、股息单位与目标日期正确且不写库。
  let writes=0;
  const originalQuery=pool.query.bind(pool);
  pool.query=(sql,...args)=>{if(/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))writes++;return originalQuery(sql,...args);};
  const analysis=await buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-09-30',{persist:false});
  assert.equal(analysis.basic.convert_value,120);assert.equal(analysis.stock.dividend_yield,0.025);
  assert.equal(analysis.terms.call.ratio,1.3);assert.equal(analysis.bond.coupons.length,6);
  assert.equal(analysis.as_of,'2026-09-30');assert.equal(writes,0);
  assert.equal(analysis.rating_history[0].outlook_estimated,true,'沿用展望必须标记待核验，不能冒充原文采集值');
  await assert.rejects(buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-10-09',{persist:false}),/目标交易日/);
  const app=express();app.use('/api/bond-analysis',bondRouter);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/bond-analysis/127991`);
  assert.equal(response.status,200);const payload=await response.json();assert.equal(payload.terms.call.ratio,1.3);assert.equal(writes,0);
  pool.query=originalQuery;
  const {readSnapshot}=require('../services/datasetPartitionRegistry');
  const baseline=await readSnapshot('bond_analysis_snapshot',{partitionKey:'2026-09-30'});
  await pool.query(`INSERT INTO analytics.analysis_snapshots(instrument_id,as_of_date,snapshot_type,formula_bundle_version,payload)
    VALUES($1,'2026-09-29','convertible_bond_analysis','4','{}'),($1,'2026-09-30','convertible_bond_analysis','4','{}')`,[bond]);
  const partition=await readSnapshot('bond_analysis_snapshot',{partitionKey:'2026-09-30'});
  assert.equal(partition.rowCount,baseline.rowCount+1,'历史快照不能充当当前分区覆盖行数');
  assert.equal(partition.dataAsOf,'2026-09-30');
  console.log('BOND-ANALYSIS-003 passed: 真实PG、公开API、零写入、日期及金融单位');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(ids.length){await pool.query('DELETE FROM market.daily_valuations WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM analytics.analysis_snapshots WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM fundamental.convertible_bond_ratings WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM market.daily_bars WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM market.convertible_bond_daily_metrics WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM fundamental.convertible_bond_profiles WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM core.instruments WHERE instrument_id=ANY($1::bigint[])',[ids]);}
  await pool.end();
});
