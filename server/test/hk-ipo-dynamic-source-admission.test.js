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
  const partial = marketSignalDiagnostics({ status: 'succeeded', subscription: {
    ok: true, fetched: true, saved: 1, activeCodes: ['00123.HK', '00456.HK'], coveredCodes: ['00123.HK'],
  } });
  assert.strictEqual(partial.query_status, 'success', '网页读取成功需保留为查询成功');
  assert.strictEqual(partial.coverage_status, 'incomplete', '少覆盖一只申购中的新股时不得按有数据判定完整');
  assert.strictEqual(partial.quality_status, 'stale', '覆盖不全的动态信号分区必须标为过期');
  assert.deepStrictEqual(partial.missing_active_codes, ['00456.HK']);
  console.log('OK hk-ipo-dynamic-source-admission: 未授权来源安全跳过且不发起请求');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
