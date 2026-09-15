const assert = require('assert');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const database = String(process.env.PGDATABASE || 'portfolio');
if (process.env.NODE_ENV !== 'test' || !/_test$/i.test(database)) {
  console.log('[SKIP] ops-alert-remediation-db 仅允许在独立测试库运行');
  process.exit(0);
}

const { pool } = require('../db/connection');
const { migration151AlertScopeAndCninfoBackoff } = require('../db/migrations');
const { closeExternalCircuit } = require('../services/externalCallGuard');

(async () => {
  const source = `cninfo-test-close-${process.pid}-${Date.now()}`;
  const alertKey = `${source}:wildcard-alert`;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    // 重复执行验证迁移幂等；所有写入只发生在 portfolio_test。
    await migration151AlertScopeAndCninfoBackoff();
    await migration151AlertScopeAndCninfoBackoff();
    await pool.query(
      `INSERT INTO ops.external_circuits
         (source,api_name,token_fingerprint,state,recover_at,error_code,error_type,detail)
       VALUES($1,'*','none','open',now()-interval '1 minute','RATE_LIMIT','rate_limit','test')`,
      [source]
    );
    await pool.query(
      `INSERT INTO ops.alert_notifications
         (alert_key,alert_type,severity,status,scope_type,scope_key,subject,summary)
       VALUES($1,'failure','critical','pending','source_endpoint',$2,'test','test')`,
      [alertKey, `${source}:*`]
    );

    process.env.NODE_ENV = 'production';
    const closed = await closeExternalCircuit(source, 'topSearch', 'none');
    assert.deepStrictEqual(closed.map(row => row.api_name), ['*'], '必须返回实际关闭的通配熔断');

    const circuit = await pool.query(
      `SELECT state,consecutive_forbidden_count FROM ops.external_circuits
        WHERE source=$1 AND api_name='*' AND token_fingerprint='none'`, [source]
    );
    assert.strictEqual(circuit.rows[0].state, 'closed');
    assert.strictEqual(Number(circuit.rows[0].consecutive_forbidden_count), 0);
    const alert = await pool.query(
      'SELECT status,resolved_at FROM ops.alert_notifications WHERE alert_key=$1', [alertKey]
    );
    assert.strictEqual(alert.rows[0].status, 'resolved', '通配熔断成功探测后必须关闭 source:* 告警');
    assert(alert.rows[0].resolved_at);

    console.log('OK ops-alert-remediation-db: 迁移151幂等、通配熔断与告警按实际作用域同步关闭');
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    await pool.query('DELETE FROM ops.alert_notifications WHERE alert_key=$1', [alertKey]).catch(() => {});
    await pool.query('DELETE FROM ops.external_circuits WHERE source=$1', [source]).catch(() => {});
    await pool.end();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
