const assert = require('assert');
const { latestMarketPartition, normalizeTradeDate } = require('../services/bondSafetyTushare');

function response(rows) {
  const fields = ['ts_code', 'trade_date', 'close'];
  return { fields, items: rows.map(row => fields.map(field => row[field])) };
}

const complete = response([{ ts_code: '000001.SZ', trade_date: '20260824', close: 10 }]);

(async () => {
  assert.strictEqual(normalizeTradeDate('20260825'), '2026-08-25');
  assert.strictEqual(normalizeTradeDate('2026-08-25'), '2026-08-25');
  assert.strictEqual(normalizeTradeDate('not-a-date'), null);

  const queried = [];
  const selected = await latestMarketPartition(['20260825', '20260824'], {
    query: async (apiName, params, fields, options) => {
      assert.strictEqual(options.allowEmpty, true, `${apiName} 必须允许空分区继续回查`);
      queried.push(`${apiName}:${params.trade_date}`);
      if (params.trade_date === '20260825' && apiName === 'daily') return response([]);
      return params.trade_date === '20260824' ? complete : response([{ ts_code: '000001.SZ', trade_date: params.trade_date, close: 10 }]);
    },
  });
  assert.strictEqual(selected.tradeDate, '20260824', '任一行情分区为空时必须回查上一共同交易日');
  assert.deepStrictEqual(queried, [
    'cb_daily:20260825', 'daily_basic:20260825', 'daily:20260825',
    'cb_daily:20260824', 'daily_basic:20260824', 'daily:20260824',
  ]);

  await assert.rejects(
    () => latestMarketPartition(['20260825'], {
      query: async () => { const error = new Error('权限不足'); error.code = 'PERMISSION_DENIED'; throw error; },
    }),
    error => error.code === 'PERMISSION_DENIED',
    '权限错误不能被当作空数据吞掉',
  );
  console.log('bond safety date fallback tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
