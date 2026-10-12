const assert = require('assert');
const { pool } = require('../db/connection');
const { identityReference, attachCashFlowIdentity } = require('../services/cashFlowIdentity');

async function main() {
  assert.deepStrictEqual(identityReference({flow_type:'dividend',instrument_id:'1'}), {instrumentId:'1'});
  assert.deepStrictEqual(identityReference({flow_type:'dividend_tax',event_key:'dividend:1:2026-01-01:2026-01-02:tax:sale'}), {instrumentId:'1'});
  assert.strictEqual(identityReference({flow_type:'dividend',instrument_id:'2',event_key:'dividend:1:2026-01-01'}), null);
  assert.strictEqual(identityReference({flow_type:'external_transfer',instrument_id:'1'}), null);
  assert.strictEqual(identityReference({flow_type:'repo_fee',event_key:'repo:204001.SH:2026-01-01:unexpected'}), null);
  assert.deepStrictEqual(identityReference({flow_type:'repo_interest',event_key:'repo:131810.SZ:2026-01-01'}), {canonicalCode:'131810.SZ'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 测试库可能来自较早快照，所需三种身份在隔离事务内补齐，结束即回滚。
    await client.query(`INSERT INTO core.instruments(canonical_code,name,market,exchange_code,currency_code,asset_class)
      VALUES ('204001.SH','GC001','CN','SSE','CNY','repo'),
             ('000001.SZ','平安银行','CN','SZSE','CNY','stock'),
             ('00941.HK','中国移动','HK','HKEX','HKD','stock')
      ON CONFLICT(canonical_code) DO NOTHING`);
    const identities = (await client.query("SELECT instrument_id,canonical_code,name FROM core.instruments WHERE canonical_code IN ('204001.SH','000001.SZ','00941.HK')")).rows;
    assert.strictEqual(identities.length,3,'测试主档须覆盖回购、A股与港股');
    const order = ['204001.SH','000001.SZ','00941.HK'];
    identities.sort((a,b)=>order.indexOf(a.canonical_code)-order.indexOf(b.canonical_code));
    const flows = identities.flatMap(i => i.canonical_code==='204001.SH'
      ? ['repo_interest','repo_fee'].map(flow_type=>({flow_type,event_key:'repo:204001.SH:2026-01-01',amount:10}))
      : ['dividend','dividend_tax'].map(flow_type=>({flow_type,event_key:`dividend:${i.instrument_id}:2026-01-01:2026-01-02`,amount:10})));
    flows.push({flow_type:'dividend',instrument_id:'9007199254740991',amount:10});
    await attachCashFlowIdentity(flows,client.query.bind(client));
    assert.deepStrictEqual(flows.map(f=>f.code),['204001','204001','000001','000001','00941','00941',undefined]);
    for (const flow of flows.slice(0,-1)) assert.ok(identities.some(i=>i.name===flow.name));
    assert.ok(flows.every(f=>f.amount===10),'展示装载不得修改金额');
    await client.query('ROLLBACK');
  } finally { client.release(); }
  console.log('cash-income identity: reference guards and PostgreSQL master mapping passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());
