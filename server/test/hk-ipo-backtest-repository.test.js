const assert = require('assert');
const repo = require('../repositories/hkIpoBacktestRepository');

(async () => {
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
})().catch(error => { console.error(error); process.exitCode = 1; });
