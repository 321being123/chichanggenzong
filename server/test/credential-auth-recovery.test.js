// CREDENTIAL-AUTH-RECOVERY-001：真实 PG 验证只恢复有后续认证成功证据的同一凭据通配策略。
const assert = require('assert');
const { pool } = require('../db/connection');
const { recoverCredentialAuthentication } = require('../services/sourceEndpointPolicy');

(async () => {
  const c = await pool.connect();
  const source = `auth_recovery_${process.pid}`;
  const fingerprint = 'test-fingerprint-primary';
  try {
    await c.query('BEGIN');
    const id = (await c.query(`INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
      VALUES($1,$1,'test',999) RETURNING source_id`, [source])).rows[0].source_id;
    await c.query(`INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,credential_fingerprint,enabled,permission_status,last_verified_at,updated_at,verification_message)
      VALUES ($1,'*','primary',$2,false,'permission_denied',now()-interval '2 hours',now()-interval '2 hours','AUTH_ERROR: bad token'),
             ($1,'*','backup','backup-fingerprint',false,'permission_denied',now()-interval '2 hours',now()-interval '2 hours','AUTH_ERROR: bad token'),
             ($1,'restricted','primary',$2,false,'permission_denied',now()-interval '2 hours',now()-interval '2 hours','interface denied')`, [id, fingerprint]);
    const started = (await c.query('SELECT clock_timestamp()::text AS t')).rows[0].t;
    assert.strictEqual(await recoverCredentialAuthentication(source, 'primary', 'different-token', started, c), false, '其他凭据不得恢复');
    assert.strictEqual(await recoverCredentialAuthentication(source, 'backup', fingerprint, started, c), false, '主备不得串用');
    assert.strictEqual(await recoverCredentialAuthentication(source, 'primary', fingerprint, null, c), false, '缺发送时刻不得恢复');
    assert.strictEqual(await recoverCredentialAuthentication(source, 'primary', fingerprint, started, c), true, '同凭据后续认证成功应恢复');
    let rows = (await c.query('SELECT api_name,credential_profile,enabled FROM ops.source_endpoint_policies WHERE source_id=$1', [id])).rows;
    assert.strictEqual(rows.find(r => r.api_name === '*' && r.credential_profile === 'backup').enabled, false, '备用状态不得被主账号恢复');
    assert.strictEqual(rows.find(r => r.api_name === 'restricted').enabled, false, '单接口权限拒绝不得被其他接口成功恢复');
    await c.query(`UPDATE ops.source_endpoint_policies SET enabled=false, permission_status='permission_denied',
      last_verified_at=now()+interval '1 second',updated_at=now()+interval '1 second',verification_message='AUTH_ERROR: bad token'
      WHERE source_id=$1 AND api_name='*' AND credential_profile='primary'`, [id]);
    assert.strictEqual(await recoverCredentialAuthentication(source, 'primary', fingerprint, started, c), false, '迟到的旧响应不得覆盖新拒绝');
    await c.query(`UPDATE ops.source_endpoint_policies SET last_verified_at=now()-interval '2 hours',
      updated_at=now()-interval '1 hour' WHERE source_id=$1 AND api_name='*' AND credential_profile='primary'`, [id]);
    assert.strictEqual(await recoverCredentialAuthentication(source, 'primary', fingerprint, started, c), false, '管理员后续修改不得自动覆盖');
    await c.query(`UPDATE ops.source_endpoint_policies SET updated_at=last_verified_at,verification_message='接口权限不足'
      WHERE source_id=$1 AND api_name='*' AND credential_profile='primary'`, [id]);
    assert.strictEqual(await recoverCredentialAuthentication(source, 'primary', fingerprint, started, c), false, '没有认证失败证据时不得恢复');
    console.log('credential auth recovery: scope and concurrency passed');
  } finally {
    await c.query('ROLLBACK'); c.release(); await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
