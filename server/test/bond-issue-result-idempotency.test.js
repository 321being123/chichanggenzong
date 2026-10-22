const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const {spawnSync}=require('child_process');
require('dotenv').config();
const root=path.join(__dirname,'..','..');
const {resolvePython}=require('../services/arbitrageParser');

(async()=>{
  // BOND-ISSUE-QUALITY-RETRY-041：恢复重复幂等保留open快照，业务错误不能换解释器重放外部采集。
  assert.equal(process.env.NODE_ENV,'test');
  assert(/_test$/.test(process.env.PGDATABASE||''),'只允许独立测试库');
  const code=String.raw`
import sys,json,psycopg2
sys.path.insert(0,'ipo-report')
from backfill_bond_shd import resolve_issuance_quality
conn=psycopg2.connect('');cur=conn.cursor()
try:
 cur.execute('SELECT instrument_id FROM core.instruments LIMIT 1');instrument=cur.fetchone()[0]
 field='test_issue_idempotency_041'
 cur.execute("DELETE FROM ops.data_quality_issues WHERE instrument_id=%s AND dataset_code='cb_issue' AND field_code=%s",(instrument,field))
 cur.execute("INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,status,details) VALUES(%s,'cb_issue',%s,'source_field_unavailable','warning','resolved','{\"old_evidence\":\"preserved\"}')",(instrument,field))
 cur.execute("INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,status,details) VALUES(%s,'cb_issue',%s,'source_field_unavailable','warning','open','{\"error\":\"original missing source\"}') RETURNING issue_id",(instrument,field));old_id=cur.fetchone()[0]
 assert resolve_issuance_quality(cur,instrument,field)==1
 assert resolve_issuance_quality(cur,instrument,field)==0
 cur.execute("SELECT status,details FROM ops.data_quality_issues WHERE instrument_id=%s AND dataset_code='cb_issue' AND field_code=%s",(instrument,field));rows=cur.fetchall()
 assert len(rows)==1 and rows[0][0]=='resolved'
 d=rows[0][1];assert d['old_evidence']=='preserved' and len(d['resolution_history'])==1
 assert d['resolution_history'][0]['issue_id']==old_id and d['resolution_history'][0]['details']['error']=='original missing source'
 cur.execute("INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,status,details) VALUES(%s,'cb_issue',%s,'pending_not_due','warning','open','{}')",(instrument,field+'new'))
 assert resolve_issuance_quality(cur,instrument,field+'new')==1
 assert resolve_issuance_quality(cur,instrument,field+'new')==0
finally:
 conn.rollback();conn.close()
print('quality closure atomicity and evidence preserved')
`;
  const py=spawnSync(resolvePython(),['-c',code],{cwd:root,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:30000});
  assert.equal(py.status,0,py.stderr||py.stdout);
  const file=require.resolve('../services/convertibleBondAnalysis');
  const context=vm.createContext({require:require('module').createRequire(file),module:{exports:{}},process,console,Buffer,setTimeout,clearTimeout,__dirname:path.dirname(file)});
  vm.runInContext(require('./helpers/service-source').readServiceFlatten('convertibleBondAnalysis'),context);
  vm.runInContext("pythonCandidates=()=>['first','second'];globalThis.attempts=0;runBondIssueResultBackfill=async()=>{globalThis.attempts++;throw Error('UniqueViolation business failure')}",context);
  await assert.rejects(vm.runInContext('backfillBondIssueResults',context)(),/UniqueViolation/);
  assert.equal(context.attempts,1);
  vm.runInContext("globalThis.attempts=0;runBondIssueResultBackfill=async()=>{globalThis.attempts++;if(globalThis.attempts===1){const e=Error('missing executable');e.code='ENOENT';throw e;}return {updated:1,failed:0}}",context);
  assert.equal((await vm.runInContext('backfillBondIssueResults',context)()).updated,1);
  assert.equal(context.attempts,2);
  // QUALITY-ISSUE-CLOSE-IDEMPOTENCY-042：公共Node关闭器同样保留原记录/快照，跨字段不受影响。
  const {pool}=require('../db/connection');
  const {resolveQualityIssue}=require('../services/datasetCursors');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const instrument=(await client.query('SELECT instrument_id FROM core.instruments LIMIT 1')).rows[0].instrument_id;
    const field='test_node_idempotency_042';
    await client.query("DELETE FROM ops.data_quality_issues WHERE instrument_id=$1 AND dataset_code='test_quality_042'",[instrument]);
    await client.query(`INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,status,details)
      VALUES($1,'test_quality_042',$2,'missing','warning','resolved','{"earlier":"preserved"}'),
      ($1,'test_quality_042',$2,'missing','warning','open','{"error":"new missing"}'),
      ($1,'test_quality_042','other-field','missing','warning','open','{}')`,[instrument,field]);
    const issue={instrumentId:instrument,datasetCode:'test_quality_042',fieldCode:field,issueType:'missing'};
    await resolveQualityIssue(issue,{client});await resolveQualityIssue(issue,{client});
    const rows=(await client.query("SELECT field_code,status,details FROM ops.data_quality_issues WHERE instrument_id=$1 AND dataset_code='test_quality_042'",[instrument])).rows;
    const closed=rows.filter(r=>r.field_code===field);assert.equal(closed.length,1);assert.equal(closed[0].status,'resolved');
    assert.equal(closed[0].details.earlier,'preserved');assert.equal(closed[0].details.resolution_history.length,1);
    assert.equal(closed[0].details.resolution_history[0].details.error,'new missing');
    assert.equal(rows.find(r=>r.field_code==='other-field').status,'open');
  }finally{await client.query('ROLLBACK');client.release();await pool.end();}
  console.log('BOND-ISSUE-QUALITY-RETRY-041 passed: 幂等恢复保留证据，业务错误不重放采集');
})().catch(e=>{console.error(e);process.exitCode=1});
