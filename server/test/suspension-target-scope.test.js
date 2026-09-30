const assert = require('assert');
const { pool } = require('../db/connection');
const market = require('../services/market');
let calls = 0;
let saved;
market.tushareQuery = async () => {
  calls++;
  return { fields: ['ts_code', 'trade_date', 'suspend_type'], items: [
    ['601198.SH', '20260915', 'S'], ['601059.SH', '20260915', 'S'], ['600000.SH', '20260915', 'S'],
  ] };
};
pool.query = async sql => ({ rows: sql.includes('SELECT source_id') ? [{ source_id: 1 }] : [
  { canonical_code: '601198.SH', instrument_id: 1 }, { canonical_code: '601059.SH', instrument_id: 2 },
  { canonical_code: '600000.SH', instrument_id: 3 },
] });
pool.connect = async () => ({ query: async (sql, params) => {
  if (sql.includes('INSERT INTO market.stock_suspend_calendar')) { saved = JSON.parse(params[0]); return { rowCount: saved.length }; }
  return { rows: [] };
}, release() {} });
const { syncConvertibleBondSuspensions } = require('../services/convertibleBondSuspensionSync');
(async () => {
  const result = await syncConvertibleBondSuspensions({ startDate: '20260915', endDate: '20260930', targetCodes: ['601198.SH', '601059.SH'] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls, 1, '指定证券仍复用一次批量接口');
  assert.deepStrictEqual(saved.map(row => row.instrument_id), [1, 2], '不得写入范围外证券');
  const unknown = await syncConvertibleBondSuspensions({ startDate: '20260915', endDate: '20260930', targetCodes: ['999999.SH'] });
  assert.strictEqual(unknown.ok, false, '证券身份缺失不能冒充空结果成功');
  console.log('suspension target scope verified');
})().catch(error => { console.error(error); process.exitCode = 1; });
