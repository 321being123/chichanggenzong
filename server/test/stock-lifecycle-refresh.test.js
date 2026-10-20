const assert = require('assert');
require('dotenv').config();
if (process.env.NODE_ENV !== 'test') throw new Error('本回归只允许隔离测试库');
const { pool } = require('../db/connection');
const { loadTrackedDelistedStocks, ensureStockUniverse } = require('../services/convertibleBondAnalysis');
const { getJobDefinition, stageCompletionEvidence } = require('../services/jobDefinitions');
const { activeStockScope } = require('../jobs/stockAnalysisRefresh');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const code = '699943.SH';
    await client.query("INSERT INTO users(username,password) VALUES('stock_lifecycle_fixture','test_fixture')");
    await client.query("INSERT INTO stock_watchlist(username,ts_code,name) VALUES('stock_lifecycle_fixture',$1,'退市核验夹具')", [code]);
    await ensureStockUniverse(client, [{ ts_code: code, name: '退市核验夹具', list_status: 'L', list_date: '20200101' }]);
    const listed = [{ ts_code: '600000.SH', list_status: 'L' }];
    let calls = 0;
    const deps = { query: client.query.bind(client), fetch: async (api, params, fields) => {
      calls++;
      assert.strictEqual(api, 'stock_basic');
      assert.deepStrictEqual(params, { ts_code: code, list_status: 'D' });
      assert(fields.includes('delist_date'));
      return { fields: ['ts_code', 'name', 'list_status', 'delist_date'], items: [[code, '退市核验夹具', 'D', '20261019']] };
    } };
    // STOCK-LIFECYCLE-044：缺席上市清单不等于退市，只有精确代码、D状态和实际日期可落库。
    for (const items of [[], [['699942.SH', 'D', '20261019']], [[code, 'L', '20261019']], [[code, 'D', null]]]) {
      assert.deepStrictEqual(await loadTrackedDelistedStocks(listed, [code], { ...deps,
        fetch: async () => ({ fields: ['ts_code', 'list_status', 'delist_date'], items }) }), []);
      assert.strictEqual((await client.query('SELECT status FROM core.instruments WHERE canonical_code=$1', [code])).rows[0].status, 'listed');
    }
    await assert.rejects(loadTrackedDelistedStocks(listed, [code], { ...deps, fetch: async () => { throw new Error('权限拒绝'); } }), /权限拒绝/);
    const rows = await loadTrackedDelistedStocks(listed, [code], deps);
    await ensureStockUniverse(client, rows);
    assert.strictEqual(calls, 1);
    const stored = (await client.query('SELECT status,delist_date::text,raw_data FROM core.instruments WHERE canonical_code=$1', [code])).rows[0];
    assert.strictEqual(stored.status, 'delisted');
    assert.strictEqual(stored.delist_date, '2026-10-19');
    assert.strictEqual(stored.raw_data.list_status, 'D');
    assert.deepStrictEqual(await loadTrackedDelistedStocks(listed, [code], deps), []);
    assert.strictEqual(calls, 1, '已确认退市事实落库后不重复外部查询');
    const stocks = [{ ts_code: code }, { ts_code: '699942.SH' }];
    const before = await activeStockScope(stocks, '2026-10-18', client.query.bind(client));
    const after = await activeStockScope(stocks, '2026-10-19', client.query.bind(client));
    assert.strictEqual(before.activeStocks.length, 2);
    assert.deepStrictEqual(after.activeStocks, [{ ts_code: '699942.SH' }], '未知状态仍需核验，不能当退市排除');
    assert.deepStrictEqual(after.excluded, [{ code, reason: 'confirmed_delisted', delistDate: '2026-10-19' }]);
    const definition = getJobDefinition('convertible_bond_universe_refresh');
    const result = { ok: true, mode: 'stock_lifecycle', stageComplete: true, codes: [code] };
    assert.strictEqual(stageCompletionEvidence(definition, result, { mode: 'stock_lifecycle', targetCodes: [code] }), true);
    assert.strictEqual(stageCompletionEvidence(definition, result, { mode: 'stock_lifecycle', targetCodes: ['699942.SH'] }), false);
    assert.deepStrictEqual(definition.datasetPublicationByMode.stock_lifecycle.publish, []);
    console.log('STOCK-LIFECYCLE-044: 精确退市证据、失败保留、真实PG、缓存复用、日期与阶段作用域通过');
  } finally { await client.query('ROLLBACK'); client.release(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
