// 港股打新契约单测（合并原 hk-ipo-backtest-repository / dynamic-source-admission / dataset-publication / frontend-contract）。
(async () => {

  // --- hk-ipo-backtest-repository.test.js ---
  await (async () => {
const assert = require('assert');
const repo = require('../repositories/hkIpoBacktestRepository');

return (async () => {
  const calls = [];
  const result = { rows: [{ instrument_id: 1 }] };
  const executor = async (sql, params) => { calls.push({ sql, params }); return result; };
  assert.strictEqual(await repo.listCandidates(executor, '2025-08-04', '2026-10-28'), result);
  assert.deepStrictEqual(calls[0].params, ['2025-08-04', '2026-10-28']);
  assert.match(calls[0].sql, /market_code='HK'/);
  assert.match(calls[0].sql, /listing_at::date BETWEEN \$1::date AND \$2::date/);
  assert.strictEqual(await repo.listBars(executor, [1, 2], '2026-10-28'), result);
  assert.deepStrictEqual(calls[1].params, [[1, 2], '2026-10-28']);
  assert.match(calls[1].sql, /DISTINCT ON \(instrument_id,trade_date\)/);
  assert.strictEqual(await repo.listOpenDates(executor, '2026-10-01', '2026-10-28'), result);
  assert.deepStrictEqual(calls[2].params, ['2026-10-01', '2026-10-28']);
  assert.match(calls[2].sql, /exchange='HKEX' AND is_open/);
  console.log('港股回测仓储：查询参数、市场范围及执行器透传通过');
})();
  })();

  // --- hk-ipo-dynamic-source-admission.test.js ---
  await (async () => {
const assert = require('assert');
const { syncHkIpoMarketSignals } = require('../services/hkIpoMarketSignals');
const { marketSignalDiagnostics } = require('../jobs/hkIpoSync');

return (async () => {
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
})();
  })();

  // --- hk-ipo-dataset-publication.test.js ---
  await (async () => {
// 动态信号发布门禁：失败或未知不能把旧快照重新发布成“本次成功”。
const assert = require('assert');
const { publishDatasetSnapshot } = require('../services/datasetPartitionRegistry');

let insertCalls = 0;
async function executor(sql) {
  const text = String(sql);
  if (text.includes('COUNT(*)::int AS row_count')) return { rows: [{ row_count: 2 }] };
  if (text.includes('MAX(data_date)::text AS data_as_of')) return { rows: [{ data_as_of: '2026-09-20' }] };
  if (text.includes('INSERT INTO ops.dataset_partitions')) {
    insertCalls += 1;
    return { rows: [{ dataset_code: 'hk_ipo_subscription_signals', status: 'published' }] };
  }
  throw new Error('未预期的 SQL：' + text.slice(0, 100));
}

return (async () => {
  const rejected = await publishDatasetSnapshot('hk_ipo_subscription_signals', {
    partitionKey: '2026-09-20',
    diagnostics: { query_status: 'failed', coverage_status: 'unknown' },
  }, executor);
  assert.strictEqual(rejected.published, false);
  assert.strictEqual(rejected.reason, 'dynamic_signal_degraded');
  assert.strictEqual(insertCalls, 0, '动态来源失败时不得写入已发布分区');

  const published = await publishDatasetSnapshot('hk_ipo_subscription_signals', {
    partitionKey: '2026-09-20',
    diagnostics: { query_status: 'success', coverage_status: 'verified_no_change' },
  }, executor);
  assert.strictEqual(published.published, true);
  assert.strictEqual(insertCalls, 1);
  console.log('OK hk-ipo-dataset-publication: 动态信号失败保留旧事实、成功空结果可带证据发布');
})();
  })();

  // --- hk-ipo-frontend-contract.test.js ---
  await (async () => {
// 港股 IPO 页面字段契约：验证申购倍数、预计孖展和盘中快照不会再次混成一列。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/ipo.js'), 'utf8');

assert.match(source, /申购期认购倍数（参考）/);
assert.match(source, /申购期预计孖展倍数（每日）/);
assert.ok(!source.includes('采集记录'), '采集快照应保留在后台记录中，不在历史表格逐条展示');
assert.match(source, /ipoHkSubscriptionCell\(it\)/);
assert.match(source, /ipoHkLiveOversubscriptionCell\(it\)/);
assert.match(source, /current_subscription_signal/);
assert.match(source, /current_margin_signal/);
assert.ok(!source.includes('intraday_signal_history'), '历史快照数组不应渲染到打新历史表格');
assert.ok(!source.includes('可能过期'), '申购倍数显示中不应出现可能过期提示');
assert.match(source, /暂无可验证数据/);
assert.match(source, /offerPhase/);
assert.match(source, /ipoHkOfferWindowCell/);
assert.match(source, /待官方配发公告/);
assert.match(source, /phase === 'postponed'.*全球发售及上市已延期/);
assert.match(source, /发售延期，无官方最终倍数/);
assert.match(source, /发售已延期，等待新安排/);
assert.match(source, /公布配发结果/);
assert.match(source, /预计 /);
assert.match(source, /function ipoHkListingCell/);
assert.match(source, /listing_date_is_estimated/);
assert.match(source, /关键事实已核实/);
assert.match(source, /官方资料待补/);
assert.match(source, /中文名待补/);
assert.match(source, /来源时间/);
assert.match(source, /本地采集/);
assert.ok(source.includes("'申购期认购倍数（参考）', '申购期预计孖展倍数（每日）', '最终超额认购倍数'"),
  '历史页应分别展示申购期认购参考、预计孖展和官方最终超购');

console.log('OK hk-ipo-frontend-contract: 港股动态信号显示和隐藏采集历史契约通过');

  })();
})().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
