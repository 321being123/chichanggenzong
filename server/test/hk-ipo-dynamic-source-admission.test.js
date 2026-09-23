const assert = require('assert');
const { syncHkIpoMarketSignals } = require('../services/hkIpoMarketSignals');
const { marketSignalDiagnostics } = require('../jobs/hkIpoSync');

(async () => {
  let networkCalls = 0;
  const signals = await syncHkIpoMarketSignals({
    mode: 'preopen',
    fetchImpl: async () => { networkCalls += 1; throw new Error('不应请求未准入来源'); },
    guardImpl: async (_source, _dataset, _date, fn) => fn(),
  });
  assert.strictEqual(signals.status, 'not_admitted');
  assert.strictEqual(signals.ok, true);
  assert.strictEqual(networkCalls, 0, '默认未准入状态必须在联网和读取动态信号数据库前安全返回');
  assert.deepStrictEqual(marketSignalDiagnostics(signals), {
    query_status: 'not_run', coverage_status: 'unknown', source_status: 'not_admitted',
    valid_signal_rows: 0, degraded_reason: [],
  });
  console.log('OK hk-ipo-dynamic-source-admission: 未授权来源安全跳过且不发起请求');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
