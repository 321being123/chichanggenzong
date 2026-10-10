// 真实 PG 隔离 schema：异常日期不能被迁移静默修正，失败必须整体回滚。
const assert = require('assert');
const { pool } = require('../db/connection');
const { migrateCashFlowDatePrecision } = require('../db/cashIncomeMigration');
(async()=>{
  const client=await pool.connect();
  const schema='cash_income_migration_test';
  const adapter={connect:async()=>({query:client.query.bind(client),release(){}})};
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query("CREATE TABLE cash_flows(id text,username text,account_name text,date text DEFAULT '',amount numeric(20,2))");
    await client.query("INSERT INTO cash_flows VALUES('bad','u','a','2026-02-30',12.34)");
    await assert.rejects(()=>migrateCashFlowDatePrecision(adapter),/无效日期/);
    assert.strictEqual((await client.query('SELECT date FROM cash_flows')).rows[0].date,'2026-02-30');
    assert.strictEqual((await client.query('SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3',[schema,'cash_flows','date'])).rows[0].data_type,'text');
    await client.query("UPDATE cash_flows SET date='2026-02-28'");
    await migrateCashFlowDatePrecision(adapter);
    assert.deepStrictEqual((await client.query('SELECT date::text,amount::text FROM cash_flows')).rows[0],{date:'2026-02-28',amount:'12.340000'});
    await migrateCashFlowDatePrecision(adapter);
    assert.strictEqual((await client.query('SELECT count(*)::int AS n FROM cash_flows')).rows[0].n,1);
    console.log('cash income migration: invalid dates rollback, precision and idempotence passed');
  } finally { await client.query('SET search_path TO public'); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); client.release(); await pool.end(); }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
