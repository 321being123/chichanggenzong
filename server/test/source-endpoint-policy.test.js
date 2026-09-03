// 来源＋接口＋凭据三维策略与计数验收。
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { pool } = require('../db/connection');

(async () => {
  const source = `test_policy_${process.pid}_${Date.now()}`;
  const fingerprint = 'policy-fp-a';
  const otherFingerprint = 'policy-fp-b';
  const client = await pool.connect();
  const unlockSlot = async (apiName, fp, slot) => {
    if (slot == null) return;
    const key = `external_slot:${source}:${apiName}:${fp}:${slot}`;
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
  };
  const reserve = async (apiName, fp) => {
    const result = await client.query(
      'SELECT * FROM ops.reserve_external_call($1,$2,$3,$4)',
      [source, apiName, 'primary', fp]
    );
    const row = result.rows[0];
    await unlockSlot(apiName, fp, row && row.concurrency_slot);
    return row;
  };

  try {
    await client.query(
      `INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
       VALUES($1,$1,'test',999)`, [source]
    );
    const sourceRow = await client.query(
      'SELECT source_id FROM ops.data_sources WHERE source_code=$1', [source]
    );
    const sourceId = sourceRow.rows[0].source_id;
    await client.query(
      `INSERT INTO ops.source_endpoint_policies
         (source_id,api_name,credential_profile,internal_per_minute_limit,internal_daily_limit,
          max_concurrency,min_interval_ms)
       VALUES
         ($1,'*','primary',3,3,1,0),
         ($1,'api_a','primary',2,10,1,0),
         ($1,'api_b','primary',10,10,1,0)`, [sourceId]
    );

    assert.strictEqual((await reserve('api_a', fingerprint)).allowed, true);
    assert.strictEqual((await reserve('api_a', fingerprint)).allowed, true);
    assert.strictEqual((await reserve('api_a', fingerprint)).reason, 'minute',
      '同一接口必须按接口级分钟额度拦截');
    assert.strictEqual((await reserve('api_b', fingerprint)).allowed, true);
    assert.strictEqual((await reserve('api_b', fingerprint)).reason, 'credential_minute',
      '同一凭据跨接口累计后必须按凭据级分钟额度拦截');
    assert.strictEqual((await reserve('api_a', otherFingerprint)).allowed, true,
      '更换凭据后应使用独立的三维计数');

    const rows = await client.query(
      `SELECT api_name,credential_profile,credential_fingerprint,window_type,call_count
         FROM ops.external_call_budgets WHERE source=$1
        ORDER BY credential_fingerprint,api_name,window_type`, [source]
    );
    assert.ok(rows.rows.some(row => row.api_name === 'api_a' && row.credential_fingerprint === fingerprint));
    assert.ok(rows.rows.some(row => row.api_name === 'api_b' && row.credential_fingerprint === fingerprint));
    assert.ok(rows.rows.some(row => row.api_name === 'api_a' && row.credential_fingerprint === otherFingerprint));
    assert.ok(rows.rows.every(row => row.credential_profile === 'primary'));

    console.log('source-endpoint-policy: 来源＋接口＋凭据精确计数与跨接口凭据额度通过');
  } finally {
    await client.query('DELETE FROM ops.data_sources WHERE source_code=$1', [source]).catch(() => {});
    client.release();
    await pool.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
