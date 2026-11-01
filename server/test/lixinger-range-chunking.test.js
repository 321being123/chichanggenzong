// 官方区间接口的「时间跨度不能超过 10 年」限制：适配层必须自己分段，否则「上市以来」这类
// 二十多年的区间会整体 403 → 静默回退备源（生产实测就是财报/分红/宏观一直没走到官方）。
process.env.NODE_ENV = 'test';
process.env.LIXINGER_TOKEN = process.env.LIXINGER_TOKEN || 'test-token-never-stored';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
const { pool } = require('../db/connection');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

// ---------- 一、分段的边界 ----------
assert.strictEqual(adapter.MAX_RANGE_YEARS, 10, '官方上限是年份差 10 年，不能放宽');
const spanOf = ([start, end]) => Number(end.slice(0, 4)) - Number(start.slice(0, 4));

const single = adapter.rangeChunks('2016-01-01', '2026-11-01');
assert.strictEqual(single.length, 1, '10 年内不应拆段');
assert.deepStrictEqual(single[0], ['2016-01-01', '2026-11-01']);

// 实测边界：2001-01-01~2011-12-31 通过、2001-01-01~2012-01-01 被拒 → 年差 10 是上限。
assert.strictEqual(adapter.rangeChunks('2001-01-01', '2011-12-31').length, 1);
const two = adapter.rangeChunks('2001-01-01', '2012-01-01');
assert.strictEqual(two.length, 2, '年差 11 必须拆成两段');
assert.deepStrictEqual(two, [['2001-01-01', '2011-12-31'], ['2012-01-01', '2012-01-01']]);

// 上市以来（25 年）：段数正确、每段不超限、首尾连续无缺口、起点终点不被改写。
const long = adapter.rangeChunks('2001-08-27', '2026-11-01');
assert.strictEqual(long.length, 3);
assert.ok(long.every(chunk => spanOf(chunk) <= 10), '任何一段都不能超过 10 年');
assert.strictEqual(long[0][0], '2001-08-27', '起点必须原样保留');
assert.strictEqual(long[long.length - 1][1], '2026-11-01', '终点必须原样保留');
for (let i = 1; i < long.length; i += 1) {
  const prevEnd = new Date(`${long[i - 1][1]}T00:00:00Z`);
  const nextStart = new Date(`${long[i][0]}T00:00:00Z`);
  assert.strictEqual(nextStart.getTime() - prevEnd.getTime(), 86400000, `第 ${i} 段与上一段之间必须只差一天，不能漏日`);
}
assert.deepStrictEqual(adapter.rangeChunks('2026-11-01', '2026-01-01'), [], '反向区间返回空，不构造非法请求');

// ---------- 二、区间函数确实走分段入口（静态钉住，避免以后改回直连） ----------
const source = fs.readFileSync(path.join(__dirname, '../dataAccess/adapters/lixingerDatasetAdapter.js'), 'utf8');
// R2-001 后分段实现落在详细结果入口，数组入口委托给它；两条都要钉住。
const rangeFunctions = ['resolveValuationSeriesDetailed', 'resolveAnnualNetProfits', 'resolveFinancialReports',
  'resolveDividendRows', 'resolveIndexDaily', 'resolveIndexValuation', 'resolveStockDaily',
  'resolveMoneySupply', 'resolveSovereignYield10y'];
for (const name of rangeFunctions) {
  const bodyStart = source.indexOf(`async function ${name}(`);
  assert.ok(bodyStart > 0, `找不到 ${name}`);
  const bodyEnd = source.indexOf('\nasync function ', bodyStart + 10);
  const body = source.slice(bodyStart, bodyEnd > 0 ? bodyEnd : source.length);
  assert.ok(body.includes('callEndpointRange(') || body.includes('rangeChunks('),
    `${name} 是区间接口，必须经分段取数（否则超过 10 年直接 403）`);
}

{
  const bodyStart = source.indexOf('async function resolveValuationSeries(');
  const body = source.slice(bodyStart, source.indexOf('\nasync function ', bodyStart + 10));
  assert.ok(body.includes('resolveValuationSeriesDetailed('),
    '数组入口必须委托详细结果入口，不能在两处各写一套分段与失败处理（R2-001）');
}

(async () => {
  try {
    // ---------- 三、真实适配层：25 年区间要被拆成 3 次请求并合并 ----------
    const seen = [];
    const fakeFetch = async (url, options) => {
      const body = JSON.parse(options.body);
      seen.push({ url, startDate: body.startDate, endDate: body.endDate });
      // 每段返回一条该段结束年的年报，用来验证合并（不是每段各自返回、后面覆盖前面）。
      const year = body.endDate.slice(0, 4);
      return jsonResponse({
        code: 1, message: 'success', total: 1,
        data: [{
          standardDate: `${year}-12-31T00:00:00+08:00`, reportDate: `${Number(year) + 1}-03-31T00:00:00+08:00`,
          reportType: 'annual_report', currency: 'CNY', q: { ps: { toi: { t: 1000 } } },
        }],
      });
    };
    const reports = await adapter.resolveFinancialReports({
      tsCode: '600519.SH', kinds: ['income'], startDate: '2001-08-27', endDate: '2026-11-01',
      options: { fetch: fakeFetch, sleep: async () => {} },
    });
    assert.strictEqual(seen.length, 3, '25 年要拆成 3 次请求');
    for (const call of seen) {
      assert.ok(Number(call.endDate.slice(0, 4)) - Number(call.startDate.slice(0, 4)) <= 10,
        `单次请求跨年超限：${call.startDate}~${call.endDate}`);
    }
    assert.strictEqual(seen[0].startDate, '2001-08-27');
    assert.strictEqual(seen[2].endDate, '2026-11-01');
    assert.strictEqual(reports.income.length, 3, '三段结果必须合并，不能只留最后一段');
    assert.ok(reports.income.every(row => row.source_code === 'lixinger_official'));

    console.log('lixinger-range-chunking：官方区间上限 10 年，适配层已分段并合并，通过');
  } finally {
    await pool.end().catch(() => {});
    process.exit(0);
  }
})().catch(error => { console.error(error); process.exit(1); });
