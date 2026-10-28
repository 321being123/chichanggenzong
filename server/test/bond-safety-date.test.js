const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { filterPublicBonds, latestMarketPartition, normalizeTradeDate, isPendingListingBond } = require('../services/bondSafetyTushare');

function response(rows) {
  const fields = ['ts_code', 'trade_date', 'close'];
  return { fields, items: rows.map(row => fields.map(field => row[field])) };
}

const complete = response([{ ts_code: '000001.SZ', trade_date: '20260824', close: 10 }]);

(async () => {
  assert.strictEqual(normalizeTradeDate('20260825'), '2026-08-25');
  assert.strictEqual(normalizeTradeDate('2026-08-25'), '2026-08-25');
  assert.strictEqual(normalizeTradeDate('not-a-date'), null);

  const publicBonds = await filterPublicBonds([
    { ts_code: '110815.SH' },
    { ts_code: '110817.SH' },
    { ts_code: '127033.SZ' },
  ], {
    query: async (sql, params) => {
      assert.deepStrictEqual(params, [['110815.SH', '110817.SH', '127033.SZ']]);
      return { rows: [
        { canonical_code: '110815.SH', issue_type: '定向' },
        { canonical_code: '110817.SH', issue_type: '定向' },
      ] };
    },
  });
  assert.deepStrictEqual(publicBonds.map(row => row.ts_code), ['127033.SZ'], '定向债券不得进入安全评分预期集合');

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

  const lowCoverage = await latestMarketPartition(['20260825'], {
    expectedBondCount: 100,
    query: async (apiName, params, fields, options) => response([{ ts_code: '000001.SZ', trade_date: params.trade_date, close: 10 }]),
  });
  assert.strictEqual(lowCoverage.tradeDate, null, '行情覆盖率不足时不得形成安全评分快照');
  assert.strictEqual(lowCoverage.diagnostics[0].coverage, 0.01);

  await assert.rejects(
    () => latestMarketPartition(['20260825'], {
      query: async () => { const error = new Error('权限不足'); error.code = 'PERMISSION_DENIED'; throw error; },
    }),
    error => error.code === 'PERMISSION_DENIED',
    '权限错误不能被当作空数据吞掉',
  );
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'services', 'bondSafetyTushare.js'), 'utf8');
  const repo = fs.readFileSync(path.resolve(__dirname, '..', 'repositories', 'bondSafetyTushareRepository.js'), 'utf8');
  assert.ok(source.includes('bondSafetyTushareRepository.loadBondSafetyFacts'), '安全评分必须调用标准事实仓储');
  assert.ok(repo.includes('dm.trade_date::text AS trade_date'), '安全评分读取 PostgreSQL DATE 必须先转为日历日期文本');
  assert.ok(source.includes('const tradeDate = date || normalizeTradeDate(rows.find(row=>row.trade_date)?.trade_date)'), '安全评分须优先原目标日，再读取非空日历日期文本');

  // 待上市新债：日报在上市前一交易日就要用转股价生成首日建议，判定必须覆盖到。
  assert.strictEqual(isPendingListingBond({ ts_code: '123286.SZ', list_date: '20261019' }, '2026-10-18'), true, '下一交易日上市的新债必须进入主档补全');
  assert.strictEqual(isPendingListingBond({ ts_code: '123286.SZ', list_date: '20261018' }, '2026-10-18'), false, '当日上市已由 isActiveBond 覆盖');
  assert.strictEqual(isPendingListingBond({ ts_code: '123286.SZ', list_date: '20261019', delist_date: '20261020' }, '2026-10-18'), true, '仅有退市日不影响待上市判定');
  assert.strictEqual(isPendingListingBond({ ts_code: '123286.SZ', list_date: '20261019', maturity_date: '20261001' }, '2026-10-18'), false, '已到期债券不得进入主档补全');
  assert.strictEqual(isPendingListingBond({ ts_code: '600000.SH', list_date: '20261019' }, '2026-10-18'), false, '非可转债代码不得进入主档补全');
  assert.strictEqual(isPendingListingBond({ ts_code: '123286.SZ', list_date: null }, '2026-10-18'), false, '缺少上市日不得猜测');
  console.log('bond safety date fallback tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
