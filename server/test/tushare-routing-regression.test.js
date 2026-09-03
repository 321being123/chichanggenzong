const assert = require('assert');
const { EventEmitter } = require('events');
const https = require('https');
const { getConfig, setConfig } = require('../db/config');
const { pool } = require('../db/connection');
const guard = require('../services/externalCallGuard');
const externalApiConfig = require('../services/externalApiConfig');
const { saveProviderSettings, getExternalApiSettings } = externalApiConfig;

process.env.NODE_ENV = 'test';
process.env.ALERT_EMAIL_TO = '';
process.env.ALERT_EMAIL_FROM = '';

const originalRequest = https.request;
const originalPrimary = process.env.TUSHARE_TOKEN;
const originalBackup = process.env.TUSHARE_BACKUP_TOKEN;

function mockResponses(items, delays = []) {
  const queue = items.slice();
  let requestIndex = 0;
  https.request = (url, options, callback) => {
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {
      const item = queue.shift();
      if (!item) throw new Error('测试响应队列已耗尽');
      const emit = () => {
        const response = new EventEmitter();
        response.statusCode = item.statusCode || 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit('data', JSON.stringify(item.payload));
        response.emit('end');
      };
      const delay = Number(delays[requestIndex++] || 0);
      if (delay) setTimeout(emit, delay);
      else emit();
    };
    request.destroy = () => {};
    return request;
  };
}

function mockNetworkError(message = '测试网络错误') {
  https.request = () => {
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => process.nextTick(() => request.emit('error', new Error(message)));
    request.destroy = () => {};
    return request;
  };
}

function ok(fields = ['value'], items = [['ok']]) {
  return { code: 0, data: { fields, items } };
}

(async () => {
  const originalConfig = await getConfig('external_api_configs', '');
  const originalNotify = externalApiConfig.notifyTushareFailover;
  const failoverNotices = [];
  const genericSource = 'cninfo-test';
  try {
    process.env.TUSHARE_TOKEN = 'primary-test-token';
    process.env.TUSHARE_BACKUP_TOKEN = 'backup-test-token';
    await setConfig('external_api_configs', '');
    externalApiConfig.notifyTushareFailover = async (...args) => { failoverNotices.push(args); };
    guard.resetExternalCallGuard();
    await guard.resetExternalCallGuardPersistence('tushare');
    await guard.resetExternalCallGuardPersistence('tushare_backup');
    await pool.query(
      `INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
       VALUES($1,$1,'test',999) ON CONFLICT(source_code) DO NOTHING`, [genericSource]
    );
    const genericSourceRow = await pool.query(
      `SELECT source_id FROM ops.data_sources WHERE source_code=$1`, [genericSource]
    );
    await pool.query(
      `INSERT INTO ops.source_endpoint_policies
         (source_id,api_name,credential_profile,internal_per_minute_limit,internal_daily_limit)
       VALUES($1,'*','anonymous',20,20)
       ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE SET
         internal_per_minute_limit=EXCLUDED.internal_per_minute_limit,
         internal_daily_limit=EXCLUDED.internal_daily_limit,
         enabled=true,permission_status='unknown'`, [genericSourceRow.rows[0].source_id]
    );

    // HTTP 200 + 业务频率错误必须识别，且只熔断主 Token 的 rt_min。
    mockResponses([
      { payload: { code: 40203, msg: 'rt_min 频率超限' } },
      { payload: ok(['ts_code', 'close'], [['000001.SZ', 10]]) },
    ]);
    const { tushareQuery } = require('../services/tushare');
    const realtime = await tushareQuery('rt_min', { ts_code: '000001.SZ', freq: '1MIN' }, 'ts_code,close');
    assert.deepStrictEqual(realtime, { fields: ['ts_code', 'close'], items: [['000001.SZ', 10]] });
    assert.strictEqual(failoverNotices.length, 1, '备用成功后才发送一次接口切换告警');
    assert.deepStrictEqual(failoverNotices[0].slice(0, 3), ['rt_min', 'primary', 'backup']);
    const primaryFp = guard.tokenFingerprint('primary-test-token');
    const circuits = await pool.query(
      "SELECT source,api_name,state FROM ops.external_circuits WHERE source='tushare' AND token_fingerprint=$1", [primaryFp]
    );
    assert.strictEqual(circuits.rows.find(row => row.api_name === 'rt_min')?.state, 'open');
    assert.strictEqual(circuits.rows.find(row => row.api_name === '*'), undefined);

    // HTTP 200 + 单接口当日额度耗尽仍只熔断当前 Token 的 rt_min，不得升级为 Token 级 '*'.
    failoverNotices.length = 0;
    await guard.resetExternalCallGuardPersistence('tushare');
    await guard.resetExternalCallGuardPersistence('tushare_backup');
    mockResponses([
      { payload: { code: 40203, msg: 'rt_min 当日调用次数已耗尽' } },
      { payload: ok(['ts_code', 'close'], [['000001.SZ', 11]]) },
    ]);
    const quotaRealtime = await tushareQuery('rt_min', { ts_code: '000001.SZ', freq: '1MIN' }, 'ts_code,close');
    assert.deepStrictEqual(quotaRealtime.items, [['000001.SZ', 11]]);
    assert.strictEqual(failoverNotices.length, 1, '单接口日额度耗尽切备用后应告警');
    const quotaCircuits = await pool.query(
      "SELECT api_name FROM ops.external_circuits WHERE source='tushare' AND token_fingerprint=$1", [primaryFp]
    );
    assert.ok(quotaCircuits.rows.some(row => row.api_name === 'rt_min'));
    assert.strictEqual(quotaCircuits.rows.some(row => row.api_name === '*'), false);

    // rt_min 切备用后，new_share 仍应先走主 Token。
    mockResponses([{ payload: ok(['ts_code'], [['301000.SZ']]) }]);
    const next = await tushareQuery('new_share', {}, 'ts_code');
    assert.deepStrictEqual(next, { fields: ['ts_code'], items: [['301000.SZ']] });

    // 备用 Token 没有 rt_min 权限时，只记录两个 Token 的 rt_min，不写全局熔断。
    guard.resetExternalCallGuard();
    await guard.resetExternalCallGuardPersistence('tushare');
    await guard.resetExternalCallGuardPersistence('tushare_backup');
    mockResponses([
      { payload: { code: 2002, msg: '没有 rt_min 接口访问权限' } },
      { payload: { code: 2002, msg: '没有 rt_min 接口访问权限' } },
    ]);
    await assert.rejects(
      () => tushareQuery('rt_min', { ts_code: '000001.SZ', freq: '1MIN' }, 'ts_code,close'),
      error => error.code === 'PERMISSION_DENIED' && error.apiName === 'rt_min'
    );
    const permissionCircuits = await pool.query(
      "SELECT api_name,token_fingerprint FROM ops.external_circuits WHERE source IN ('tushare','tushare_backup')"
    );
    assert.strictEqual(permissionCircuits.rows.length, 2);
    assert.ok(permissionCircuits.rows.every(row => row.api_name === 'rt_min'));
    mockResponses([{ payload: ok(['ts_code'], [['301000.SZ']]) }]);
    const unaffected = await tushareQuery('new_share', {}, 'ts_code');
    assert.deepStrictEqual(unaffected.items, [['301000.SZ']], 'rt_min 权限失败不得阻断 new_share');
    const displayedSettings = await getExternalApiSettings();
    assert.ok(displayedSettings.tushare.circuits.some(item => item.source_role === 'backup' && item.api_name === 'rt_min'),
      '后台必须显示备用 Token 的接口熔断');

    // 备用 Token 也失败时不能误报“已切换成功”。
    failoverNotices.length = 0;
    await guard.resetExternalCallGuardPersistence('tushare');
    await guard.resetExternalCallGuardPersistence('tushare_backup');
    mockResponses([
      { payload: { code: 40203, msg: 'rt_min 频率超限' } },
      { payload: { code: 40203, msg: 'rt_min 频率超限' } },
    ]);
    await assert.rejects(() => tushareQuery('rt_min', { ts_code: '000001.SZ', freq: '1MIN' }, 'ts_code,close'));
    assert.strictEqual(failoverNotices.length, 0, '备用失败时不得发送已切换成功告警');

    // 更换主 Token 后，旧 Token 指纹对应的熔断必须失效。
    await guard.openExternalCircuit('tushare', 'old rt_min circuit', {
      apiName: 'rt_min', tokenFingerprint: primaryFp, errorCode: 'RATE_LIMIT',
    });
    await saveProviderSettings('tushare', { primary_token: 'new-primary-test-token' });
    const oldRows = await pool.query(
      "SELECT 1 FROM ops.external_circuits WHERE source='tushare' AND token_fingerprint=$1", [primaryFp]
    );
    assert.strictEqual(oldRows.rowCount, 0);

    // 恢复探测并发时，只允许一个 Worker 进入真实请求。
    const newFp = guard.tokenFingerprint('new-primary-test-token');
    await guard.openExternalCircuit('tushare', 'probe', {
      apiName: 'rt_min', tokenFingerprint: newFp, errorCode: 'RATE_LIMIT',
      recoverAt: new Date(Date.now() - 1000),
    });
    let probeCalls = 0;
    const probeResults = await Promise.allSettled([
      guard.withExternalCallGuard('tushare', 'probe-a', '2026-08-18', async () => {
        probeCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 250));
        return 'ok';
      }, { apiName: 'rt_min', tokenFingerprint: newFp }),
      guard.withExternalCallGuard('tushare', 'probe-b', '2026-08-18', async () => {
        probeCalls += 1;
        return 'duplicate';
      }, { apiName: 'rt_min', tokenFingerprint: newFp }),
    ]);
    assert.strictEqual(probeCalls, 1);
    assert.strictEqual(probeResults.filter(item => item.status === 'fulfilled').length, 1);
    assert.strictEqual(probeResults.filter(item => item.status === 'rejected')[0].reason.code, 'CIRCUIT_OPEN');
    await guard.closeExternalCircuit('tushare', 'rt_min', newFp);

    // Token 级 '*' 熔断恢复探测成功时，必须关闭实际命中的通配熔断，并放行后续接口。
    await guard.openExternalCircuit('tushare', 'global-probe-success', {
      apiName: '*', tokenFingerprint: newFp, errorCode: 'QUOTA_EXHAUSTED',
      recoverAt: new Date(Date.now() - 1000),
    });
    await guard.withExternalCallGuard('tushare', 'global-probe-success', '2026-08-18', async () => 'global-ok', {
      apiName: 'rt_min', tokenFingerprint: newFp,
    });
    await guard.closeExternalCircuit('tushare', 'rt_min', newFp);
    const closedGlobal = await pool.query(
      "SELECT state,probe_in_flight FROM ops.external_circuits WHERE source='tushare' AND api_name='*' AND token_fingerprint=$1",
      [newFp]
    );
    assert.strictEqual(closedGlobal.rows[0].state, 'closed');
    assert.strictEqual(closedGlobal.rows[0].probe_in_flight, false);
    mockResponses([{ payload: ok(['ts_code'], [['301001.SZ']]) }]);
    const afterGlobalProbe = await tushareQuery('new_share', {}, 'ts_code');
    assert.deepStrictEqual(afterGlobalProbe.items, [['301001.SZ']], 'Token 级熔断探测成功后其他接口必须恢复');

    // Token 级 '*' 熔断恢复探测失败时，也必须释放通配探测占用并留下退避时间。
    await guard.openExternalCircuit('tushare', 'global-probe-failure', {
      apiName: '*', tokenFingerprint: newFp, errorCode: 'QUOTA_EXHAUSTED',
      recoverAt: new Date(Date.now() - 1000),
    });
    await guard.resetExternalCallGuardPersistence('tushare_backup');
    mockNetworkError('Token 级探测网络失败');
    await assert.rejects(
      () => tushareQuery('rt_min', { ts_code: '000001.SZ', freq: '1MIN' }, 'ts_code,close'),
      error => error.code === 'NETWORK_ERROR'
    );
    const releasedGlobal = await pool.query(
      "SELECT probe_in_flight,recover_at FROM ops.external_circuits WHERE source='tushare' AND api_name='*' AND token_fingerprint=$1",
      [newFp]
    );
    assert.strictEqual(releasedGlobal.rows[0].probe_in_flight, false);
    assert.ok(new Date(releasedGlobal.rows[0].recover_at).getTime() > Date.now());
    await guard.closeExternalCircuit('tushare', 'rt_min', newFp);

    // 通用 Guard 的探测成功必须自动关闭来源熔断，不能依赖某个适配器自行补写。
    const genericFingerprint = 'generic-probe-test';
    await guard.openExternalCircuit('cninfo-test', 'generic-success', {
      apiName: '*', tokenFingerprint: genericFingerprint, errorCode: 'RATE_LIMIT',
      recoverAt: new Date(Date.now() - 1000),
    });
    const genericSuccess = await guard.withExternalCallGuard(
      'cninfo-test', 'generic-success', '2026-08-18', async () => 'generic-ok',
      { apiName: '*', tokenFingerprint: genericFingerprint }
    );
    assert.strictEqual(genericSuccess, 'generic-ok');
    const genericClosed = await pool.query(
      "SELECT state,probe_in_flight FROM ops.external_circuits WHERE source='cninfo-test' AND api_name='*' AND token_fingerprint=$1",
      [genericFingerprint]
    );
    assert.strictEqual(genericClosed.rows[0].state, 'closed');
    assert.strictEqual(genericClosed.rows[0].probe_in_flight, false);

    // 通用 Guard 的探测失败必须释放租约并留下短暂退避。
    await guard.openExternalCircuit('cninfo-test', 'generic-failure', {
      apiName: '*', tokenFingerprint: genericFingerprint, errorCode: 'RATE_LIMIT',
      recoverAt: new Date(Date.now() - 1000),
    });
    await assert.rejects(
      () => guard.withExternalCallGuard(
        'cninfo-test', 'generic-failure', '2026-08-18', async () => { throw new Error('generic probe failed'); },
        { apiName: '*', tokenFingerprint: genericFingerprint }
      ),
      /generic probe failed/
    );
    const genericReleased = await pool.query(
      "SELECT probe_in_flight,recover_at FROM ops.external_circuits WHERE source='cninfo-test' AND api_name='*' AND token_fingerprint=$1",
      [genericFingerprint]
    );
    assert.strictEqual(genericReleased.rows[0].probe_in_flight, false);
    assert.ok(new Date(genericReleased.rows[0].recover_at).getTime() > Date.now());
    await guard.resetExternalCallGuardPersistence('cninfo-test');

    // 恢复探测遇到网络错误时必须释放占用，并留下短暂退避，不能永久卡住。
    await guard.openExternalCircuit('tushare', 'probe-failure', {
      apiName: 'rt_min', tokenFingerprint: newFp, errorCode: 'RATE_LIMIT',
      recoverAt: new Date(Date.now() - 1000),
    });
    mockNetworkError();
    await assert.rejects(
      () => tushareQuery('rt_min', { ts_code: '000001.SZ', freq: '1MIN' }, 'ts_code,close'),
      error => error.code === 'NETWORK_ERROR' && error.apiName === 'rt_min'
    );
    const releasedProbe = await pool.query(
      "SELECT probe_in_flight,recover_at FROM ops.external_circuits WHERE source='tushare' AND api_name='rt_min' AND token_fingerprint=$1",
      [newFp]
    );
    assert.strictEqual(releasedProbe.rows[0].probe_in_flight, false);
    assert.ok(new Date(releasedProbe.rows[0].recover_at).getTime() > Date.now());

    // Worker 在恢复探测请求期间异常退出后，过期的探测占用必须自动回收。
    await guard.resetExternalCallGuardPersistence('tushare');
    await guard.openExternalCircuit('tushare', 'stale-probe', {
      apiName: 'rt_min', tokenFingerprint: newFp, errorCode: 'RATE_LIMIT',
      recoverAt: new Date(Date.now() - 1000),
    });
    await pool.query(
      `UPDATE ops.external_circuits
          SET probe_in_flight=true,updated_at=now() - interval '10 minutes'
        WHERE source='tushare' AND api_name='rt_min' AND token_fingerprint=$1`, [newFp]
    );
    const staleProbeResult = await guard.withExternalCallGuard(
      'tushare', 'stale-probe', '2026-08-18', async () => 'stale-recovered',
      { apiName: 'rt_min', tokenFingerprint: newFp }
    );
    assert.strictEqual(staleProbeResult, 'stale-recovered');
    await guard.closeExternalCircuit('tushare', 'rt_min', newFp);
    await guard.resetExternalCallGuardPersistence('tushare');
    await guard.resetExternalCallGuardPersistence('tushare_backup');

    // 真实 fork 子进程错误对象必须保留 apiName，防止调度器退回全局 source 熔断。
    const { runJobInIsolatedProcess } = require('../services/jobOrchestrator');
    await assert.rejects(
      () => runJobInIsolatedProcess('__test_tushare_api_propagation', 'ipc-test', '2026-08-18', {}, null),
      error => error.code === 'RATE_LIMIT' && error.source === 'tushare' && error.apiName === 'rt_min'
    );

    console.log('tushare-routing-regression: 业务限流、接口隔离、主备路由、Token 版本和单探测通过');
  } finally {
    https.request = originalRequest;
    externalApiConfig.notifyTushareFailover = originalNotify;
    await setConfig('external_api_configs', originalConfig);
    guard.resetExternalCallGuard();
    await guard.resetExternalCallGuardPersistence('tushare');
    await guard.resetExternalCallGuardPersistence('tushare_backup');
    await pool.query('DELETE FROM ops.data_sources WHERE source_code=$1', [genericSource]).catch(() => {});
    if (originalPrimary === undefined) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = originalPrimary;
    if (originalBackup === undefined) delete process.env.TUSHARE_BACKUP_TOKEN;
    else process.env.TUSHARE_BACKUP_TOKEN = originalBackup;
    await pool.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
