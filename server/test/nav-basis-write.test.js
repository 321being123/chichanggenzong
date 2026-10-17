const assert = require('assert');
const express = require('express');
const { pool, loadAccountData, upsertNav } = require('../db');
const router = require('../routes/accounts');
const RealDate = Date;
let fixedTime='2026-09-24T15:30:00+08:00';
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixedTime])); }
  static now() { return RealDate.parse(fixedTime); }
};
const U = 'canonical_nav_write_test', A = '统一净值基准回归';
const tables = ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'nav_position_snapshots', 'nav_import_batches', 'account_data', 'accounts'];
let server;
(async () => {
 try {
  const db = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert(/test/.test(db), '写入回归只能使用隔离测试库');
  for (const table of tables) await pool.query(`DELETE FROM ${table} WHERE username=$1`, [U]);
  await pool.query('DELETE FROM users WHERE username=$1', [U]);
  await pool.query(`INSERT INTO users(username,password,accounts,role,status) VALUES($1,'x',$2,'user','active')`, [U, JSON.stringify([A])]);
  const id = require('crypto').createHash('sha256').update(U + '\n' + A).digest('hex');
  await pool.query(`INSERT INTO accounts(id,username,account_name,cash_base,hk_rate,version,updated_at)
    VALUES($1,$2,$3,100,1,0,'2026-09-24 15:30:00')`, [id,U,A]);
  await pool.query(`INSERT INTO account_data(username,account_name,data,version) VALUES($1,$2,'{}',0)`,[U,A]);
  await pool.query(`INSERT INTO positions(id,username,account_name,code,name,quantity,price,cost,type,subtype)
    VALUES('canonical-p',$1,$2,'600000','测试证券',10,12,10,'股权','沪市')`,[U,A]);
  await pool.query(`INSERT INTO nav_history(username,account_name,date,nav,total_asset,invested,hk_rate,snapshot_at,snapshot_source,source_priority,is_locked,cash_cny,market_value_cny,system_market_value_at_snapshot)
    VALUES($1,$2,'2026-09-22',2,200,100,1,'2026-09-22T07:00:00Z','imported',100,true,100,100,100),
      ($1,$2,'2026-09-23',2.04,200,100,1,'2026-09-23T07:00:00Z','legacy',0,false,NULL,NULL,NULL)`,[U,A]);
  await pool.query(`INSERT INTO nav_position_snapshots(snapshot_id,username,account_name,snapshot_date,instrument_code,quantity,price,quote_currency,fx_rate_to_cny,market_value_cny,source)
    VALUES('canonical-anchor',$1,$2,'2026-09-22','600000',10,10,'CNY',1,100,'manual_reconciliation')`,[U,A]);
  await pool.query(`INSERT INTO daily_prices(username,account_name,date,code,name,price)
    VALUES($1,$2,'2026-09-22','600000','测试证券',10),($1,$2,'2026-09-23','600000','测试证券',11),($1,$2,'2026-09-24','600000','测试证券',12)`,[U,A]);
  const app = express();app.use(express.json());
  app.use((req,res,next)=>{req.session={user:U,authVersion:1};next();});app.use('/api',router);
  server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  let input=await loadAccountData(U,A);
  assert.strictEqual(input.performanceHistory.at(-1).date,'2026-09-24','当日实时投影不依赖先保存');
  const background = await require('../jobs/navSnapshot').recordNavSnapshots(U,A,null,'2026-09-24');
  assert.strictEqual(background.ok,true,JSON.stringify(background));
  assert.strictEqual((await pool.query(`SELECT nav::float8 AS nav FROM nav_history WHERE username=$1 AND account_name=$2 AND date='2026-09-24'`,[U,A])).rows[0].nav,2.2,'后台首次补快照也必须沿同一首页基准');
  input=await loadAccountData(U,A);
  const save = async version => {
    const response=await fetch(base+'/api/nav/2026-09-24?version='+version,{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({account:A,calculationMode:'system',nav:99,totalAsset:999999})});
    return {status:response.status,body:await response.json()};
  };
  let r=await save(input.version);assert.strictEqual(r.status,200,JSON.stringify(r.body));
  const stored=await pool.query(`SELECT nav::float8 AS nav,total_asset::float8 AS total,diagnostics FROM nav_history WHERE username=$1 AND account_name=$2 AND date='2026-09-24'`,[U,A]);
  assert.strictEqual(stored.rows[0].nav,2.2,'服务端须忽略客户端NAV及旧2.04基准，按首页资产重建净值链');
  assert.strictEqual(stored.rows[0].total,220);
  assert.strictEqual(stored.rows[0].diagnostics.homepageBasis.previousTotalAsset,210);
  assert.strictEqual(stored.rows[0].diagnostics.homepageBasis.positions[0].quantity,10);
  const attr=r.body.data.navAttribution,series=r.body.data.performanceHistory;
  assert(Math.abs(series.at(-1).nav/series.at(-2).nav-1-attr.totalChange/attr.previousTotalAsset)<1e-10);
  r=await save(r.body.data.version);assert.strictEqual(r.status,200);assert.strictEqual(r.body.data.navHistory.at(-1).nav,2.2,'同日重复保存不得复利重复计入');
  assert.strictEqual((await save(0)).status,409,'保留乐观锁');
  await upsertNav(U,A,{date:'2026-09-22',nav:99,totalAsset:99,calculationMode:'system'});
  assert.strictEqual((await pool.query(`SELECT nav::float8 AS nav FROM nav_history WHERE username=$1 AND account_name=$2 AND date='2026-09-22'`,[U,A])).rows[0].nav,2,'锁定导入不得改写');
  await pool.query(`DELETE FROM nav_history WHERE username=$1 AND account_name=$2 AND date='2026-09-23'`,[U,A]);
  const failed=await save(r.body.data.version);assert.strictEqual(failed.status,409,'缺中间交易日必须阻止自动保存');
  assert(failed.body.error.includes('基准不完整'));
  assert.strictEqual((await pool.query(`SELECT nav::float8 AS nav FROM nav_history WHERE username=$1 AND account_name=$2 AND date='2026-09-24'`,[U,A])).rows[0].nav,2.2,'失败保留已保存事实');
  const recovered = await require('../jobs/navSnapshot').recordNavSnapshots(U,A,null,'2026-09-24');
  assert.strictEqual(recovered.ok,true,'原Runner补齐缺日后必须使用新的同源投影，不可用旧内存继续报缺失：'+JSON.stringify(recovered));
  const manual = await fetch(base+'/api/nav/2026-09-23?version='+r.body.data.version,{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({account:A,nav:2.123,totalAsset:210,invested:100})});
  const manualBody=await manual.json();assert.strictEqual(manual.status,200,JSON.stringify(manualBody));
  assert.strictEqual(manualBody.data.performanceHistory.find(n=>n.date==='2026-09-23').nav,2.123,'保留用户明确的人工净值修订');
  assert.strictEqual(manualBody.data.navAttribution.previousTotalAsset,210,'人工明确资产与首页也使用同一基准');
  const concurrent = await Promise.all([save(manualBody.data.version),save(manualBody.data.version)]);
  assert.deepStrictEqual(concurrent.map(r=>r.status).sort(),[200,409],'并发自动记录只接受同一版本的一次写入');
  fixedTime='2026-09-24T16:00:00+08:00';
  await pool.query(`INSERT INTO cash_flows(id,username,account_name,account_id,date,amount,amount_cny,flow_type,origin,status,created_at)
    VALUES('canonical-income',$1,$2,$3,'2026-09-24',10,10,'repo_interest','manual','confirmed','2026-09-24 15:45:00')`,[U,A,id]);
  await require('../services/cashIncome').settleCashIncome(U,A,{targetDate:'2026-09-24',enable:true});
  const incomeRow=(await pool.query(`SELECT nav::float8 AS nav,total_asset::float8 AS total,diagnostics FROM nav_history
    WHERE username=$1 AND account_name=$2 AND date='2026-09-24'`,[U,A])).rows[0];
  assert.strictEqual(incomeRow.total,230,'现金收益后的资产使用统一现金账本');
  assert(Math.abs(incomeRow.nav-2.123*230/210)<0.000001,'现金收益结算也必须复用首页净值投影');
  assert.strictEqual(incomeRow.diagnostics.historicalValuation,'homepage_asset_basis');
  const settledData=await loadAccountData(U,A),settledNav=settledData.navHistory.at(-1);
  assert.strictEqual(require('../../public/shared/nav-math').cashAt(settledData,'2026-09-24',settledNav.snapshot_at).value,110,'同日收益到账后快照时间必须与新现金证据一致');
  fixedTime='2026-09-24T16:01:00+08:00';
  assert.strictEqual((await require('../services/cashIncome').settleCashIncome(U,A,{targetDate:'2026-09-24'})).navUpdated,0,'同源现金收益重复结算不得改写或叠加已入账NAV');
  await assert.rejects(()=>upsertNav(U,A,{date:'2026-09-25',calculationMode:'system'}),/不能晚于上海当日/);
  console.log('nav basis write: real API/PG canonical inputs, repeat, lock, imported protection and failure preservation passed');
 } finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  for(const table of tables)await pool.query(`DELETE FROM ${table} WHERE username=$1`,[U]).catch(()=>{});
  await pool.query('DELETE FROM users WHERE username=$1',[U]).catch(()=>{});
  await pool.end();global.Date=RealDate;
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
