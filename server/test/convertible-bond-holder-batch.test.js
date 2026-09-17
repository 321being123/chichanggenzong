// top10_cb_holders 批量读取回归：验证多代码合并、3000 行边界拆分和增量日期窗口。
const assert = require('assert');
const {
  TOP10_CB_HOLDERS_ROW_LIMIT,
  fetchTop10CbHolderRowsBatched,
} = require('../services/convertibleBondRevisionMotiveService');

function code(index) {
  return `${String(110000 + index).padStart(6, '0')}.SH`;
}

function rowsFor(params) {
  const codes = String(params.ts_code).split(',').filter(Boolean);
  const rows = [];
  // 模拟接口在超过 3000 行时只返回上限，验证调用方会主动拆分而不接受截断。
  for (const tsCode of codes) {
    for (let rank = 1; rank <= 10 && rows.length < TOP10_CB_HOLDERS_ROW_LIMIT; rank += 1) {
      rows.push({ ts_code: tsCode, end_date: '20260630', holder_rank: rank, holder_name: `持有人${rank}`, hold_amount: 1, hold_ratio: 1 });
    }
  }
  return rows;
}

(async () => {
  const calls = [];
  const bonds = Array.from({ length: 254 }, (_, index) => ({ ts_code: code(index), list_date: '20200101' }));
  const result = await fetchTop10CbHolderRowsBatched({
    bonds,
    businessDate: '2026-09-17',
    query: async params => { calls.push(params); return rowsFor(params); },
  });
  assert.strictEqual(calls.length, 1, '254 只债券单报告期最多2540行，应合并为一次请求');
  assert.strictEqual(result.calls, 1);
  assert.strictEqual(result.attemptedCodes.size, 254);
  assert.strictEqual(result.errorsByCode.size, 0);

  const splitCalls = [];
  const splitBonds = Array.from({ length: 301 }, (_, index) => ({ ts_code: code(index), list_date: '20200101' }));
  const splitResult = await fetchTop10CbHolderRowsBatched({
    bonds: splitBonds,
    businessDate: '2026-09-17',
    query: async params => { splitCalls.push(params); return rowsFor(params); },
  });
  assert.strictEqual(splitCalls.length, 3, '超过3000行时应先探测，再按代码拆成两批');
  assert.strictEqual(splitResult.attemptedCodes.size, 301);
  assert.strictEqual(splitResult.errorsByCode.size, 0);

  const dateSplitCalls = [];
  const dateSplitResult = await fetchTop10CbHolderRowsBatched({
    bonds: [{ ts_code: '110999.SH', list_date: '2020-01-01' }],
    businessDate: '2026-09-17',
    rowLimit: 3,
    query: async params => {
      dateSplitCalls.push(params);
      return params.start_date ? [{ ts_code: '110999.SH', end_date: params.end_date, holder_rank: 1 }] : [
        { ts_code: '110999.SH', end_date: '20260630', holder_rank: 1 },
        { ts_code: '110999.SH', end_date: '20260331', holder_rank: 2 },
        { ts_code: '110999.SH', end_date: '20251231', holder_rank: 3 },
      ];
    },
  });
  assert.strictEqual(dateSplitCalls.length, 3, '单只债券达到行数上限时应按日期拆分');
  assert.strictEqual(dateSplitResult.rowsByCode.get('110999.SH').length, 2, '日期拆分结果必须合并，不能被后一段覆盖');

  const incrementalCalls = [];
  await fetchTop10CbHolderRowsBatched({
    bonds: [
      { ts_code: '110001.SH', holder_report_date: '2026-06-30', list_date: '2020-01-01' },
      { ts_code: '110002.SH', holder_report_date: '2026-03-31', list_date: '2020-01-01' },
    ],
    businessDate: '2026-09-17',
    query: async params => { incrementalCalls.push(params); return []; },
  });
  assert.strictEqual(incrementalCalls.length, 1);
  assert.strictEqual(incrementalCalls[0].ts_code, '110001.SH,110002.SH');
  assert.strictEqual(incrementalCalls[0].start_date, '20260301', '批量增量窗口应取各对象水位向前30天的最早日期');
  assert.strictEqual(incrementalCalls[0].end_date, '20260917');

  console.log('convertible-bond-holder-batch.test.js 通过：批量请求、3000行拆分、增量窗口均符合预期');
})().catch(error => {
  console.error('convertible-bond-holder-batch.test.js 失败：', error && error.stack || error);
  process.exit(1);
});
