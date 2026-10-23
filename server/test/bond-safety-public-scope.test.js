const assert=require('assert');
const {pool}=require('../db/connection');
const {fetchBondSafetySourceFromDatabase,filterPublicBonds}=require('../services/bondSafetyTushare');
(async()=>{
  const client=await pool.connect(),original=pool.query;
  try{
    await client.query('BEGIN');
    const source=(await client.query("SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1")).rows[0].source_id;
    const stock=(await client.query("INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code) VALUES('600999.SH','范围测试','stock','CN','SSE','CNY') ON CONFLICT(canonical_code) DO UPDATE SET canonical_code=EXCLUDED.canonical_code RETURNING instrument_id")).rows[0].instrument_id;
    const codes=(await client.query("SELECT n::text||'.SH' AS code FROM generate_series(113000,113999) n WHERE NOT EXISTS(SELECT 1 FROM core.instruments WHERE canonical_code=n::text||'.SH') ORDER BY n LIMIT 3")).rows.map(r=>r.code);
    assert.strictEqual(codes.length,3);
    let index=0;
    for(const [type,listed,quote] of [['公开','2026-10-20',true],['公开','2026-10-21',false],['定向',null,false]]){
      const code=codes[index++];
      const id=(await client.query("INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status,list_date) VALUES($1,$1,'convertible_bond','CN','SSE','CNY','listed',$2) RETURNING instrument_id",[code,listed])).rows[0].instrument_id;
      await client.query('INSERT INTO fundamental.convertible_bond_profiles(instrument_id,stock_instrument_id) VALUES($1,$2)',[id,stock]);
      await client.query('INSERT INTO fundamental.convertible_bond_issuance(instrument_id,issue_type,source_id) VALUES($1,$2,$3)',[id,type,source]);
      if(quote)await client.query("INSERT INTO market.convertible_bond_daily_metrics(instrument_id,trade_date,source_id,close) VALUES($1,'2026-10-20',$2,100)",[id,source]);
    }
    pool.query=client.query.bind(client);
    const result=await fetchBondSafetySourceFromDatabase('2026-10-20');
    const own=result.bondRows.filter(r=>codes.includes(r.bond_code));
    assert.deepStrictEqual(own.map(r=>r.bond_code).sort(),codes.slice(0,2).sort());
    const previous=await filterPublicBonds(codes.map(ts_code=>({ts_code})));
    assert.strictEqual(previous.length,2,'上期也排除定向债');
    assert.strictEqual(result.dataAsOf,'2026-10-20');
    console.log('安全性真实PG范围：公开待上市保留、上市当日去重、定向债及上期污染排除通过');
  }finally{pool.query=original;await client.query('ROLLBACK');client.release();await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
