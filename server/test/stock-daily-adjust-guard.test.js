// 日线口径与终盘证据回归（2026-11-15 第六轮验收 + 第七轮返工）
// 覆盖：历史收盘备源只接受不复权口径、收盘任务必须有不复权日线作终盘证据（按品种取各自日线）、
// 确认后落库核验过的日线收盘价、终盘核验先读已发布共享日线不重复外采、
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
const { verifyTerminalClose, loadTerminalBar } = require('../jobs/marketClose');
// 第七轮验收新增：共享日线证据裁决与港股代码规范化（纯函数，离线可回归）。
const mcTerminal = require('../jobs/marketClose');
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

  const independentBar = await verifyTerminalClose({
    code: '600000', subtype: '沪市', market: 'CN', date, price: 10.5,
    fetchSeries: okSeries,
  });
  assert.strictEqual(independentBar.ok, true, '独立不复权日线是终盘价格依据，不应被旧报价价格拦截');

  // 4a. 可转债与基金/ETF 必须各自有终盘确认路径，不能一律“不适用”把收盘任务降为候选。
  const askedKinds = [];
  const bondSeries = async ({ kind }) => {
    askedKinds.push(kind);
    return [{ trade_date: date.replace(/-/g, ''), close: 100, source_code: 'tushare', price_adjust: 'none' }];
  };
  const bond = await verifyTerminalClose({ code: '110038', subtype: '可转债', market: 'CN', date, price: 100, fetchSeries: bondSeries });
  assert.strictEqual(bond.ok, true, '可转债应能用不复权可转债日线确认终盘：' + JSON.stringify(bond));
  assert.strictEqual(askedKinds.at(-1), 'bond', '可转债必须走可转债日线（cb_daily）证据');

  const fund = await verifyTerminalClose({ code: '510300', subtype: '基金/ETF', market: 'CN', date, price: 100, fetchSeries: bondSeries });
  assert.strictEqual(fund.ok, true, 'ETF 应能用不复权基金日线确认终盘：' + JSON.stringify(fund));
  assert.strictEqual(askedKinds.at(-1), 'fund', 'ETF 必须走基金日线（fund_daily）证据');

  const hk = await verifyTerminalClose({ code: '00001', subtype: '港股', market: 'HK', date, price: 100, fetchSeries: bondSeries });
  assert.strictEqual(hk.ok, true, '港股应能用不复权港股日线确认终盘');
  assert.strictEqual(askedKinds.at(-1), 'stock', '港股走正股日线入口（数据层内部按 .HK 选腾讯 day 日 K）');

  // 4c. 终盘核验先读已发布的共享日线：命中就不再外采。
  let fetched = 0;
  const published = await loadTerminalBar({
    code: '600000', kind: 'stock', date,
    readPublishedBar: async () => ({ close: 10, source_code: 'lixinger_official' }),
    fetchSeries: async () => { fetched += 1; return []; },
  });
  assert.strictEqual(published.ok, true);
  assert.strictEqual(published.via, 'published_bar', '命中共享日线时必须以共享日线作证据');
  assert.strictEqual(fetched, 0, '命中共享日线后不得再外采（多账户持仓同一证券会重复请求）');

  const fetchedMiss = await loadTerminalBar({
    code: '600000', kind: 'stock', date,
    readPublishedBar: async () => null,
    fetchSeries: async () => { fetched += 1; return [{ trade_date: date.replace(/-/g, ''), close: 10, source_code: 'tushare', price_adjust: 'none' }]; },
  });
  assert.strictEqual(fetchedMiss.via, 'series', '共享日线缺失时才外采');
  assert.strictEqual(fetched, 1, '外采只发生一次');

  // 4d. 共享日线必须带终盘证据：只有来源名相同、价格也相同，但没有终盘/口径/分区质量证据的行不得采信。
  const publishedPartition = { partition_status: 'published', partition_is_stale: false, partition_diagnostics: { quality_status: 'passed', query_status: 'success' } };
  const realtimeBar = {
    close: 10, source_code: 'tencent', price_adjust: 'none', bar_status: 'unknown', quality_status: 'unknown',
    ...publishedPartition,
  };
  const { isTerminalBarEvidence, pickTerminalBarRow } = mcTerminal;
  assert.strictEqual(isTerminalBarEvidence(realtimeBar, 'position_close_bars_cn'), false,
    '同表里可转债同步写入的腾讯实时报价没有终盘证据，不得当成已确认收盘价');
  assert.strictEqual(pickTerminalBarRow([realtimeBar], 'position_close_bars_cn'), null, '没有终盘证据时宁可外采，也不能采信');
  const terminalBar = { ...realtimeBar, bar_status: 'terminal', quality_status: 'passed' };
  assert.strictEqual(isTerminalBarEvidence(terminalBar, 'position_close_bars_cn'), true);
  const picked = pickTerminalBarRow([realtimeBar, terminalBar], 'position_close_bars_cn');
  assert.strictEqual(picked.close, 10, '排在前面但无证据的行必须被跳过，取后面有证据的行');
  assert.strictEqual(isTerminalBarEvidence({ ...terminalBar, price_adjust: 'qfq' }, 'position_close_bars_cn'), false, '复权口径的行不得采信');
  assert.strictEqual(isTerminalBarEvidence({ ...terminalBar, partition_status: 'stale' }, 'position_close_bars_cn'), false, '分区未发布（stale）不得采信');
  assert.strictEqual(isTerminalBarEvidence({ ...terminalBar, partition_is_stale: true }, 'position_close_bars_cn'), false, '分区已失真不得采信');
  assert.strictEqual(isTerminalBarEvidence({ ...terminalBar, partition_status: null }, 'position_close_bars_cn'), false, '没有分区记录不得采信');
  assert.strictEqual(isTerminalBarEvidence({ ...terminalBar, partition_diagnostics: { quality_status: 'failed' } }, 'position_close_bars_cn'), false,
    '分区质量未通过不得采信');

  // 4e. 外采到的终盘日线必须落库复用：只放内存缓存的话，下次任务/重试会重复采同一证券同一天。
  const savedBars = [];
  const reused = await loadTerminalBar({
    code: '600000', kind: 'stock', date,
    readPublishedBar: async () => null,
    fetchSeries: async () => ([{ trade_date: date.replace(/-/g, ''), close: 10, source_code: 'tencent_day', price_adjust: 'none' }]),
    persistBar: async args => { savedBars.push(args); return { persisted: true }; },
  });
  assert.strictEqual(reused.ok, true);
  assert.strictEqual(savedBars.length, 1, '外采成功后必须写回共享日线（否则后续任务重复外采）');
  assert.strictEqual(savedBars[0].provider, 'tencent_day', '落库必须保留真实供应商，不能只写一个笼统来源');
  assert.strictEqual(reused.persisted, true);

  // 4f. 港股六位补零代码必须规范为五位：000001 是 A 股代码，港股规范代码是 00001。
  const { terminalSeriesCode, normalizeHkCode } = mcTerminal;
  assert.strictEqual(normalizeHkCode('000001'), '00001', '六位补零港股必须缩短为五位');
  assert.strictEqual(normalizeHkCode('00001'), '00001');
  assert.strictEqual(normalizeHkCode('00700'), '00700');
  assert.strictEqual(terminalSeriesCode('000001', 'hk_stock'), '00001.HK', '港股 000001 的日线代码必须是 00001.HK');
  assert.strictEqual(terminalSeriesCode('00001', 'hk_stock'), '00001.HK');
  assert.strictEqual(terminalSeriesCode('000001', 'stock'), '000001.SZ', 'A 股代码不受港股规范化影响');
  // 走完整链路验证：持仓 000001（港股）在共享日线与外采两条路径上都必须用 00001.HK。
  const askedPublished = [];
  await loadTerminalBar({
    code: '000001', kind: 'hk_stock', date,
    readPublishedBar: async ({ tsCode }) => { askedPublished.push(tsCode); return null; },
    fetchSeries: async ({ tsCode }) => { askedPublished.push(tsCode); return [{ trade_date: date.replace(/-/g, ''), close: 10, source_code: 'tencent_day', price_adjust: 'none' }]; },
    persistBar: async () => ({ persisted: true }),
  });
  assert.deepStrictEqual(askedPublished, ['00001.HK', '00001.HK'],
    '六位补零港股的共享日线与外采请求都必须用规范代码 00001.HK');
  // 规范化只能有一份实现：收盘核验、数据层与历史补录必须共用，否则会各写一套而漂移。
  assert.strictEqual(datasets.normalizeHkSecurityCode('000001'), '00001');
  assert.strictEqual(mcTerminal.normalizeHkCode, datasets.normalizeHkSecurityCode,
    '收盘核验的港股代码规范化必须来自数据访问层唯一实现');
  const replaySource = require('fs').readFileSync(require('path').join(__dirname, '..', 'jobs', 'replayNav.js'), 'utf8');
  assert.ok(!/replace\(\/\\\.HK\$\/i, ''\)\.padStart\(5/.test(replaySource),
    '历史补录不得再自己 padStart(5)：六位补零港股会被当成另一只证券');
  assert.ok(replaySource.includes('normalizeHkSecurityCode(code)'), '历史补录必须用同一规范化入口');

  // 4g. 外采日线没写回共享日线时，失败原因必须一路传到任务结果（不能只统计成功条数）：
  //     否则全部保存失败时任务会显示"无需发布"，下一次又重复外采，缺口原因也查不到。
  const persistFailedBar = await loadTerminalBar({
    code: '600000', kind: 'stock', date,
    readPublishedBar: async () => null,
    fetchSeries: async () => ([{ trade_date: date.replace(/-/g, ''), close: 10, source_code: 'tushare', price_adjust: 'none' }]),
    persistBar: async () => ({ persisted: false, reason: 'instrument_or_source_not_found' }),
  });
  assert.strictEqual(persistFailedBar.ok, true, '写库失败不改变本次核验结论');
  assert.strictEqual(persistFailedBar.persisted, false);
  assert.strictEqual(persistFailedBar.persistReason, 'instrument_or_source_not_found', '失败原因必须带回来');
  const carried = await verifyTerminalClose({
    code: '600000', subtype: '沪市', market: 'CN', date, price: 10,
    readBar: async () => persistFailedBar,
  });
  assert.strictEqual(carried.ok, true);
  assert.strictEqual(carried.persisted, false, 'verifyTerminalClose 不得把持久化结果吞掉');
  assert.strictEqual(carried.persistReason, 'instrument_or_source_not_found');
  // 4h. 同一港股的五位/六位代码必须落到同一个身份：否则缺口判定、幂等跳过和历史修订门禁各自为政。
  assert.strictEqual(mcTerminal.identityOf('HK', '000001'), 'HK|00001', '身份里的港股代码必须先规范化');
  assert.strictEqual(mcTerminal.identityOf('HK', '00001'), 'HK|00001');
  assert.strictEqual(mcTerminal.identityOf('UNKNOWN', '000001'), 'UNKNOWN|000001', '身份不明的行不做规范化');
  assert.strictEqual(mcTerminal.positionIdentityKey({ code: '000001', subtype: '港股' }),
    mcTerminal.positionIdentityKey({ code: '00001', subtype: '港股' }),
    '六位补零与五位写法必须视为同一只港股');
  // 已有五位代码的确认日价时，六位代码不得再被当成缺行去补写。
  const hkPositions = [{ code: '000001', subtype: '港股', quantity: 100 }];
  assert.deepStrictEqual(
    mcTerminal.pickMissingCodes(hkPositions, new Set(['HK|00001']), () => true), [],
    '已有五位代码的日价时，六位补零持仓不得重复补写',
  );
  // 身份集合由 confirmedExistingCodes / existingAnyIdentities 统一规范化后再判断，
  // 所以六位代码的已确认日价也能命中五位的持仓（见下面的 confirmedExistingCodes 断言）。
  const confirmedFromSixDigitRow = mcTerminal.confirmedExistingCodes([
    { code: '000001', market: 'HK', quality: 'confirmed', is_final: true },
  ]);
  assert.ok(confirmedFromSixDigitRow.has('HK|00001'), '六位代码的已确认日价必须命中五位代码的持仓');
  // 历史修订门禁同样按规范化身份判断：六位补零持仓遇上五位代码的存量日价，
  // 必须被认成"同一只证券已有历史"，而不是"缺行可以随便补"。
  const crossPaddingPlan = mcTerminal.splitHistoricalBackfill(
    [mcTerminal.positionIdentityKey({ code: '000001', subtype: '港股' })],
    new Set([mcTerminal.positionIdentityKey({ code: '00001', subtype: '港股' })]),
    false,
  );
  assert.deepStrictEqual(crossPaddingPlan.blocked, ['HK|00001'],
    '六位补零持仓遇上五位代码的存量日价时，必须按同一只证券处理（需授权修订，不能当缺行补写）');
  assert.deepStrictEqual(crossPaddingPlan.writable, []);

  // 4i. 源码守卫：价格改写必须让旧证据失效（数据库触发器），证据列不能只写不失效。
  const fsSource = require('fs');
  const pathSource = require('path');
  const guardMigration = fsSource.readFileSync(pathSource.join(__dirname, '..', 'db', 'migrations', 'era15DailyBarEvidenceGuard.js'), 'utf8');
  assert.ok(guardMigration.includes('trg_daily_bars_evidence_invalidation'), '必须有触发器保证价格变更与证据失效原子完成');
  assert.ok(guardMigration.includes("NEW.bar_status := 'unknown'"), '价格变化后旧终盘状态必须降级');
  assert.ok(guardMigration.includes('evidence_invalidated_by'), '证据失效必须留痕');
  const migrationsSource = fsSource.readFileSync(pathSource.join(__dirname, '..', 'db', 'migrations.js'), 'utf8');
  assert.ok(migrationsSource.includes('202_daily_bar_evidence_guard'), '迁移 202 必须注册到执行顺序');

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
