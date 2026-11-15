// 日线口径与终盘证据回归（2026-11-15 第六轮验收）
// 覆盖：历史收盘备源只接受不复权口径、收盘任务必须有不复权日线作终盘证据、
// 补录把实际来源与口径写进证据（并拒绝用复权价冒充收盘价）。
const assert = require('assert');

// 只替换腾讯日 K 请求，保留该模块其余导出（其他服务依赖它的代码判定工具）。
let hkPayload = null;
const tencentQuote = require('../services/tencentQuote');
tencentQuote.requestTencentHkKline = async () => hkPayload;

// 官方（理杏仁）在本机没有 token：测试里显式返回空，验证的是“官方无数据时备源不能退回前复权”。
const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
adapter.resolveStockDaily = async () => [];

const datasets = require('../dataAccess/marketDatasets');
const { verifyTerminalClose } = require('../jobs/marketClose');
const { historyBackfillRow } = require('../jobs/replayNav');

function hkNode({ qfqday, day }) {
  return { data: { hk00001: { qfqday, day } } };
}

async function main() {
  // 1. 腾讯只给前复权（qfqday）时：没有可用收盘价，必须保持缺口。
  hkPayload = hkNode({
    qfqday: [['2026-11-13', '9.00', '8.00', '9.10', '7.90', '1000']],
    day: undefined,
  });
  const adjustOnly = await datasets.readStockDailySeries({
    tsCode: '00001.HK', market: 'hk', startDate: '2026-11-13', endDate: '2026-11-13',
  });
  assert.deepStrictEqual(adjustOnly, [], '只有前复权日线时不得返回价格（复权价不能当收盘价）');

  // 2. 同时存在 day 与 qfqday：取不复权的 day（10），并标明来源与口径。
  hkPayload = hkNode({
    qfqday: [['2026-11-13', '9.00', '8.00', '9.10', '7.90', '1000']],
    day: [['2026-11-13', '10.00', '10.00', '10.20', '9.80', '1200']],
  });
  const both = await datasets.readStockDailySeries({
    tsCode: '00001.HK', market: 'hk', startDate: '2026-11-13', endDate: '2026-11-13',
  });
  assert.strictEqual(both.length, 1);
  assert.strictEqual(Number(both[0].close), 10, '必须取不复权日线收盘价，不能取前复权价');
  assert.strictEqual(both[0].source_code, 'tencent_day', '来源必须标明是腾讯不复权日 K');
  assert.strictEqual(both[0].price_adjust, 'none', '必须标注不复权口径');

  // 3. 历史收盘序列把来源与口径透传给落库证据。
  const series = await datasets.readHistoricalCloseSeries({
    tsCode: '00001.HK', kind: 'stock', startDate: '2026-11-13', endDate: '2026-11-13',
  });
  assert.strictEqual(series.length, 1);
  assert.strictEqual(series[0].price_adjust, 'none');
  assert.strictEqual(series[0].source_code, 'tencent_day');

  // 4. 收盘任务的终盘证据：必须是不复权日线且价格一致。
  const date = '2026-11-13';
  const okSeries = async () => ([{ trade_date: date.replace(/-/g, ''), close: 10, source_code: 'lixinger', price_adjust: 'none' }]);
  const ok = await verifyTerminalClose({ code: '600000', subtype: '沪市', market: 'CN', date, price: 10, fetchSeries: okSeries });
  assert.strictEqual(ok.ok, true, '不复权日线与报价一致时应确认终盘：' + JSON.stringify(ok));
  assert.strictEqual(ok.provider, 'lixinger');

  const adjusted = await verifyTerminalClose({
    code: '600000', subtype: '沪市', market: 'CN', date, price: 10,
    fetchSeries: async () => ([{ trade_date: date.replace(/-/g, ''), close: 10, source_code: 'tencent_qfq', price_adjust: 'qfq' }]),
  });
  assert.strictEqual(adjusted.ok, false, '复权口径的日线不得作为终盘证据');
  assert.strictEqual(adjusted.reason, 'terminal_bar_adjusted');

  const missing = await verifyTerminalClose({
    code: '600000', subtype: '沪市', market: 'CN', date, price: 10,
    fetchSeries: async () => ([]),
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, 'terminal_bar_missing', '没有日线时只能保持候选');

  const mismatch = await verifyTerminalClose({
    code: '600000', subtype: '沪市', market: 'CN', date, price: 10.5,
    fetchSeries: okSeries,
  });
  assert.strictEqual(mismatch.ok, false, '报价与终盘日线不一致时不得确认');
  assert.strictEqual(mismatch.reason, 'terminal_bar_mismatch');

  const notStock = await verifyTerminalClose({ code: '110038', subtype: '可转债', market: 'CN', date, price: 100 });
  assert.strictEqual(notStock.reason, 'terminal_evidence_not_applicable', '非股票不套用股票日线证据');

  // 5. 补录行：只有不复权才写 confirmed，且来源/口径逐行保留。
  const confirmedRow = historyBackfillRow({
    code: '000858', price: 100, market: 'CN', provider: 'lixinger', adjust: 'none',
  });
  assert.strictEqual(confirmedRow.quality, 'confirmed');
  assert.strictEqual(confirmedRow.source, 'history_backfill:lixinger', '来源必须保留实际供应商');
  assert.strictEqual(confirmedRow.evidence.provider, 'lixinger');
  assert.strictEqual(confirmedRow.evidence.price_adjust, 'none');
  assert.ok(confirmedRow.evidence.market_basis, '补录写入必须带市场依据，否则同形代码会被判身份不明');

  const adjustedRow = historyBackfillRow({
    code: '000858', price: 100, market: 'CN', provider: 'tencent_qfq', adjust: 'qfq',
  });
  assert.strictEqual(adjustedRow.quality, 'candidate', '复权价不得写成已确认收盘价');
  assert.strictEqual(adjustedRow.is_final, null);
  assert.strictEqual(adjustedRow.evidence.qualification, 'adjustment_unverified');

  console.log('日线口径与终盘证据回归通过');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
