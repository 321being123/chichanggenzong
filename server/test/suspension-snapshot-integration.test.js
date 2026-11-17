// 通过真实账户、原后台 Runner 和 PG 验证停牌期间快照；测试库专用夹具。
const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { recordNavSnapshots } = require('../jobs/navSnapshot');
const { loadAccountData } = require('../db');
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-09-24T16:30:00+08:00'])); }
  static now() { return RealDate.parse('2026-09-24T16:30:00+08:00'); }
};
const username = 'suspension_snapshot_integration_test', account = '停牌快照测试', code = '699997';
const tables = ['positions','trades','nav_history','cash_flows','daily_prices','nav_position_snapshots','nav_import_batches','account_data','accounts'];
(async () => {
  const savedPartitions = [];
  const addedCalendarDays = [];
  let instrumentId;
  try {
    assert(/test/.test((await pool.query('SELECT current_database() AS name')).rows[0].name));
    for (const table of tables) await pool.query(`DELETE FROM ${table} WHERE username=$1`, [username]);
    await pool.query('DELETE FROM users WHERE username=$1', [username]);
    const source = (await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare'" )).rows[0];
    instrumentId = (await pool.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,list_date,status)
      VALUES ('699997.SH','停牌回归','stock','CN','SSE','2020-01-01','listed') RETURNING instrument_id`)).rows[0].instrument_id;
    for (const day of ['2026-09-21','2026-09-22']) {
      const previous = (await pool.query(`SELECT status,is_stale,diagnostics FROM ops.dataset_partitions
        WHERE dataset_code='stock_suspend_calendar' AND scope_key='CN' AND partition_key=$1::date`,[day])).rows[0];
      savedPartitions.push({day,previous});
      await pool.query(`INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,is_stale,diagnostics)
        VALUES ('stock_suspend_calendar','CN',$1::date,'published',false,'{"query_status":"success"}')
        ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE SET status='published',is_stale=false,diagnostics=EXCLUDED.diagnostics`,[day]);
      await pool.query(`INSERT INTO market.stock_suspend_calendar(instrument_id,trade_date,suspend_type,source_id)
        VALUES ($1,$2::date,'S',$3)`,[instrumentId,day,source.source_id]);
    }
    const insertedCalendar = await pool.query(`INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code)
      SELECT 'SSE',day::date,EXTRACT(ISODOW FROM day)<6,'test'
      FROM generate_series('2026-09-18'::date,'2026-09-22'::date,interval '1 day') day
      ON CONFLICT(exchange,trade_date) DO NOTHING RETURNING trade_date::text`);
    addedCalendarDays.push(...insertedCalendar.rows.map(row=>row.trade_date));
    const calendar = (await pool.query(`SELECT trade_date::text,is_open FROM market.trade_calendar
      WHERE exchange='SSE' AND trade_date BETWEEN '2026-09-18' AND '2026-09-22' ORDER BY trade_date`)).rows;
    assert.strictEqual(calendar.length,5,'测试库须有连续自然日历');
    assert.deepStrictEqual(calendar.map(r=>r.is_open),[true,false,false,true,true]);
    await pool.query(`INSERT INTO users(username,password,accounts,role,status) VALUES($1,'x',$2,'user','active')`,[username,JSON.stringify([account])]);
    const id = crypto.createHash('sha256').update(username+'\n'+account).digest('hex');
    await pool.query(`INSERT INTO accounts(id,username,account_name,cash_base,hk_rate,version,updated_at)
      VALUES($1,$2,$3,100,1,0,'2026-09-18 15:30:00')`,[id,username,account]);
    await pool.query(`INSERT INTO account_data(username,account_name,data,version) VALUES($1,$2,'{}',0)`,[username,account]);
    await pool.query(`INSERT INTO positions(id,username,account_name,code,name,quantity,price,cost,type,subtype)
      VALUES('suspension-fixture-p',$1,$2,$3,'停牌回归',10,10,10,'股权','沪市')`,[username,account,code]);
    await pool.query(`INSERT INTO nav_history(username,account_name,date,nav,total_asset,invested,hk_rate,snapshot_at,snapshot_source,source_priority,is_locked,cash_cny,market_value_cny,system_market_value_at_snapshot)
      VALUES($1,$2,'2026-09-18',2,200,100,1,'2026-09-18T07:00:00Z','imported',100,true,100,100,100)`,[username,account]);
    await pool.query(`INSERT INTO nav_position_snapshots(snapshot_id,username,account_name,snapshot_date,instrument_code,quantity,price,quote_currency,fx_rate_to_cny,market_value_cny,source)
      VALUES('suspension-fixture-anchor',$1,$2,'2026-09-18',$3,10,10,'CNY',1,100,'manual_reconciliation')`,[username,account,code]);
    await pool.query(`INSERT INTO daily_prices(username,account_name,date,code,name,price,quality,is_final,source,market,evidence)
      VALUES($1,$2,'2026-09-18',$3,'停牌回归',10,'confirmed',true,'history_backfill:test','CN','{"price_adjust":"none"}')`,[username,account,code]);
    for (const day of ['2026-09-21','2026-09-22']) {
      const result = await recordNavSnapshots(username,account,null,day);
      assert.strictEqual(result.ok,true,JSON.stringify(result));
      assert.strictEqual(result.usedPriceDates[day][code],'2026-09-18');
      assert.strictEqual(result.usedSuspensionReferences[day][code].tradeDate,'2026-09-18');
    }
    const saved=(await pool.query(`SELECT date::text,nav::float8,diagnostics FROM nav_history WHERE username=$1 AND date='2026-09-22'`,[username])).rows[0];
    assert.strictEqual(saved.nav,2);
    assert.strictEqual(saved.diagnostics.homepageBasis.suspensionReferencePrices.current[0].tradeDate,'2026-09-18');
    const data=await loadAccountData(username,account);
    assert.strictEqual(data.performanceHistory.find(row=>row.date==='2026-09-22').basis.suspensionReferencePrices.current[0].tradeDate,'2026-09-18');
    console.log('HOLDINGS-NAV-SUSPENSION-001: real Runner, persisted NAV and API projection passed');
  } finally {
    for (const table of tables) await pool.query(`DELETE FROM ${table} WHERE username=$1`,[username]).catch(()=>{});
    await pool.query('DELETE FROM users WHERE username=$1',[username]).catch(()=>{});
    if (instrumentId) {
      await pool.query('DELETE FROM market.stock_suspend_calendar WHERE instrument_id=$1',[instrumentId]).catch(()=>{});
      await pool.query('DELETE FROM core.instruments WHERE instrument_id=$1',[instrumentId]).catch(()=>{});
    }
    if (addedCalendarDays.length) await pool.query(`DELETE FROM market.trade_calendar WHERE exchange='SSE' AND trade_date=ANY($1::date[]) AND source_code='test'`,[addedCalendarDays]).catch(()=>{});
    for (const {day,previous} of savedPartitions) {
      if (previous) await pool.query(`UPDATE ops.dataset_partitions SET status=$2,is_stale=$3,diagnostics=$4::jsonb WHERE dataset_code='stock_suspend_calendar' AND scope_key='CN' AND partition_key=$1::date`,[day,previous.status,previous.is_stale,JSON.stringify(previous.diagnostics)]).catch(()=>{});
      else await pool.query(`DELETE FROM ops.dataset_partitions WHERE dataset_code='stock_suspend_calendar' AND scope_key='CN' AND partition_key=$1::date`,[day]).catch(()=>{});
    }
    await pool.end(); global.Date=RealDate;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
