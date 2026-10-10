const assert=require('assert'),{assess}=require('../services/repoSourceAdmission');
const dates=require('../services/repoDailyRates').tradingDates('2026-07-20','2026-08-31');
const rows=dates.map(d=>({ts_code:'204001.SH',trade_date:d.replace(/-/g,''),repo_maturity:'GC001',weight:1.283,close:1.295}));
const sample={date:dates[0],code:'204001.SH',metric:'daily_volume_weighted',unit:'percent',value:'1.283',label:'加权平均利率(%)',sourceUrl:'https://bond.sse.com.cn/data/statistics/overview/Pledgerepo/',contentHash:'a'.repeat(64)};
const base={rows,expectedDates:dates,targetDate:dates.at(-1),officialSamples:[sample],fetchedAt:'2026-09-01T10:00:00+08:00',permissionVerified:true};
assert.strictEqual(assess(base).status,'admitted');
assert.strictEqual(assess({...base,officialSamples:[]}).status,'pending_evidence');
assert.strictEqual(assess({...base,officialSamples:[{...sample,metric:'five_day_mean'}]}).status,'pending_evidence','跨统计指标不能冒充匹配');
assert.strictEqual(assess({...base,officialSamples:[{...sample,value:'1.391'}]}).status,'rejected');
assert.strictEqual(assess({...base,rows:rows.concat(rows[0])}).status,'rejected');
assert.strictEqual(assess({...base,rows:rows.slice(1)}).status,'pending_evidence');
assert.strictEqual(assess({...base,permissionVerified:false}).status,'pending_evidence');
assert.throws(()=>assess({...base,officialSamples:[{...sample,sourceUrl:'https://example.com/'}]}),/上交所/);
assert.strictEqual(assess({...base,fetchedAt:'2026-08-30T10:00:00+08:00'}).status,'pending_evidence');
console.log('cash income source admission: sample coverage, same metric, official provenance, mismatch rejection and publication observation passed');
async function cacheRegression(){
  const calls=[];
  const result=await require('../services/repoSourceAdmission').probeOfficial(sample.date,async(sql,args)=>{calls.push({sql,args});return {rows:sql.includes('ops.data_sources')?[{source_id:1}]:[{payload:{...sample,sqlId:'COMMON_SSEBOND_SCSJ_SCTJ_SCGL_ZQZYSHGSCGL_CX_L'}}]};});
  assert.strictEqual(result.value,'1.283');assert.strictEqual(calls.length,2,'已有官方原文证据命中不联网、不重写策略');
  await assert.rejects(()=>require('../services/repoSourceAdmission').probeOfficial(require('../../public/shared/core-date').todayInZone('Asia/Shanghai'),async()=>{throw new Error('不得访问');}),/已完成/);
  const python=process.env.IPO_PYTHON_PATH||require('path').resolve('venv/Scripts/python.exe');
  const script=`import importlib.util, json, io
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('probe','server/scripts/probeRepoOfficial.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
payload={'pageHelp':{'total':1},'result':[{'BOND_CODE':'204001','BOND_NAME':'GC001','TRADE_DATE':'2026-08-31','WEIGHT_RATE':'1.283'}]}
def fake(request,**kw):
 assert kw['source']=='sse' and kw['api_name']=='repo_overview' and kw['dataset']=='repo-official-admission:2026-08-31'
 assert 'TRADE_DATE=2026-08-31' in request.full_url
 return io.BytesIO(json.dumps(payload).encode('utf-8'))
with patch.object(m,'guarded_urlopen',fake):
 assert m.probe('2026-08-31')['value']=='1.283'
 payload['pageHelp']['total']=2
 try:m.probe('2026-08-31');raise AssertionError('incomplete accepted')
 except ValueError as e:assert 'pagination incomplete' in str(e)
 payload['pageHelp']['total']=1;payload['result'][0]['TRADE_DATE']='2026-08-30'
 try:m.probe('2026-08-31');raise AssertionError('wrong date accepted')
 except ValueError as e:assert 'unique same-date' in str(e)
print('official probe Guard scope, incomplete pagination and identity/date validation passed')`;
  const output=await require('util').promisify(require('child_process').execFile)(python,['-c',script],{windowsHide:true,timeout:10000});console.log(output.stdout.trim());
  console.log('official admission cache reuse and completed-day boundary passed');
}
cacheRegression().catch(e=>{console.error(e);process.exitCode=1;});
