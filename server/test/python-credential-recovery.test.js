// CREDENTIAL-AUTH-RECOVERY-001：Python 使用相同数据库作用域与竞态门禁。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { pool } = require('../db/connection');
const root = path.resolve(__dirname, '..', '..');
const candidates = [process.env.PYTHON, path.join(root, 'venv', 'Scripts', 'python.exe'),
  path.join(root, 'venv', 'bin', 'python'), path.join(root, 'ipo-report', 'venv', 'bin', 'python')].filter(Boolean);
const python = candidates.find(p => fs.existsSync(p)) || 'python3';
const py = `import sys\nsys.path.insert(0, sys.argv[1])\nimport external_call_guard as g\ng._budget_source=lambda _s: sys.argv[2]\ng._credential_profile=lambda _s: 'primary'\nprint('YES' if g.recover_credential_authentication('tushare',sys.argv[3],sys.argv[4]) else 'NO')`;

(async () => {
  const source = `python_auth_recovery_${process.pid}`;
  const fp = 'python-test-fingerprint';
  const c = await pool.connect();
  const run = (fingerprint, started) => {
    const result = spawnSync(python, ['-c', py, path.join(root, 'ipo-report'), source, fingerprint, started],
      { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 30000 });
    assert.strictEqual(result.status, 0, result.stderr || 'Python failed');
    return result.stdout.trim();
  };
  try {
    const id = (await c.query(`INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
      VALUES($1,$1,'test',999) RETURNING source_id`, [source])).rows[0].source_id;
    await c.query(`INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,credential_fingerprint,enabled,permission_status,last_verified_at,updated_at,verification_message)
      VALUES ($1,'*','primary',$2,false,'permission_denied',now()-interval '2 hours',now()-interval '2 hours','AUTH_ERROR: bad token'),
             ($1,'restricted','primary',$2,false,'permission_denied',now()-interval '2 hours',now()-interval '2 hours','interface denied')`, [id, fp]);
    const start = (await c.query('SELECT clock_timestamp()::text t')).rows[0].t;
    assert.strictEqual(run('other-fingerprint', start), 'NO');
    assert.strictEqual(run(fp, start), 'YES');
    let rows = (await c.query('SELECT api_name,enabled FROM ops.source_endpoint_policies WHERE source_id=$1', [id])).rows;
    assert.strictEqual(rows.find(r => r.api_name === 'restricted').enabled, false);
    await c.query(`UPDATE ops.source_endpoint_policies SET enabled=false,permission_status='permission_denied',
      last_verified_at=now()+interval '1 second',updated_at=now()+interval '1 second',verification_message='AUTH_ERROR: bad token'
      WHERE source_id=$1 AND api_name='*'`, [id]);
    assert.strictEqual(run(fp, start), 'NO', 'Python 迟到响应不得恢复新拒绝');
    console.log('python credential recovery PG parity passed');
  } finally {
    await c.query('DELETE FROM ops.data_sources WHERE source_code=$1', [source]).catch(() => {});
    c.release(); await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
