const assert = require('assert');
const { pool } = require('../db');
const repo = require('../repositories/marketStrategyRepository');
const originalConnect = pool.connect;
let calls = [], failInsert = false;
pool.connect = async () => ({
  query: async (sql, params) => {
    calls.push({ sql, params });
    if (failInsert && sql.includes('INSERT INTO analytics.market_cycle_strategy_settings')) throw new Error('insert failed');
    return { rows: [] };
  },
  release: () => calls.push({ sql: 'release' }),
});
(async () => {
  try {
    await repo.writeSetting('user', 'account', 'pe', 'CN', 'CSI300', 10, 20, 2);
    assert.deepStrictEqual(calls.map(item => item.sql.split(' ')[0]), ['BEGIN', 'UPDATE', 'INSERT', 'COMMIT', 'release']);
    assert.deepStrictEqual(calls[2].params, ['user', 'account', 'pe', 'CN', 'CSI300', 10, 20, 2]);
    calls = []; failInsert = true;
    await assert.rejects(repo.writeSetting('user', 'account', 'pe', 'CN', 'CSI300', 10, 20, 2), /insert failed/);
    assert.deepStrictEqual(calls.map(item => item.sql.split(' ')[0]), ['BEGIN', 'UPDATE', 'INSERT', 'ROLLBACK', 'release']);
    console.log('market strategy repository: transaction, rollback and parameters passed');
  } finally { pool.connect = originalConnect; await pool.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
