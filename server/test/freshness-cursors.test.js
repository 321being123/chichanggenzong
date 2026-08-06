// 新鲜度判定与数据组 TTL 门控的纯逻辑单元测试（方案 P1/P2）。
// 只覆盖不访问数据库的判断规则；DB 读写由集成测试覆盖。
const assert = require('assert');
const { evaluateConvertibleBondFreshness, evaluateStockFreshness } = require('../services/analysisFreshness');
const { isDatasetFresh } = require('../services/datasetCursors');

// ===== 可转债新鲜度 =====
// 1) 快照转股价与主档不一致 -> needs_refresh
{
  const r = evaluateConvertibleBondFreshness({ snapshotConvPrice: 21.03, profileConvPrice: 13.8 });
  assert.ok(r.needs_refresh, '转股价不一致应标记 needs_refresh');
  assert.ok(r.reasons.some(x => x.code === 'conv_price_mismatch'), '应给出 conv_price_mismatch 原因');
}

// 2) 转股价一致、水位齐全、行情未落后 -> fresh
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-08-05', latestBondTradeDate: '2026-08-05',
    watermark: { conversion_price_event: { change_date: '2026-08-01' } },
    latestConvPriceChangeDate: '2026-07-30',
  });
  assert.ok(!r.needs_refresh, '输入一致时应为 fresh');
}

// 3) 已入库的转股价公告晚于快照水位 -> conv_price_event_newer
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-08-05', latestBondTradeDate: '2026-08-05',
    watermark: { conversion_price_event: { change_date: '2026-08-01' } },
    latestConvPriceChangeDate: '2026-08-05',
  });
  assert.ok(r.needs_refresh, '新转股价公告应标记 needs_refresh');
  assert.ok(r.reasons.some(x => x.code === 'conv_price_event_newer'), '应给出 conv_price_event_newer 原因');
}

// 4) 新行情交易日晚于快照 as_of -> market_data_newer
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-08-01', latestBondTradeDate: '2026-08-05',
    watermark: { conversion_price_event: { change_date: '2026-08-01' } },
    latestConvPriceChangeDate: '2026-07-30',
  });
  assert.ok(r.reasons.some(x => x.code === 'market_data_newer'), '应给出 market_data_newer 原因');
}

// ===== 股票新鲜度 =====
// 5) 旧版占位水位 -> watermark_legacy
{
  const r = evaluateStockFreshness({ watermark: { source: 'legacy_projection' } });
  assert.ok(r.needs_refresh, 'legend_projection 占位水位应标记 needs_refresh');
  assert.ok(r.reasons.some(x => x.code === 'watermark_legacy'), '应给出 watermark_legacy 原因');
}

// 6) 水位缺行情/财报依赖 -> watermark_incomplete
{
  const r = evaluateStockFreshness({ watermark: { analysis_type: 'stock', instrument: {} } });
  assert.ok(r.reasons.some(x => x.code === 'watermark_incomplete'), '应给出 watermark_incomplete 原因');
}

// 7) 新行情晚于快照行情水位 -> market_data_newer
{
  const r = evaluateStockFreshness({
    watermark: { market: { trade_date: '2026-08-01' }, financial: { period_end: '2026-06-30' } },
    latestTradeDate: '2026-08-05',
  });
  assert.ok(r.reasons.some(x => x.code === 'market_data_newer'), '应给出 market_data_newer 原因');
}

// 8) 行情一致且依赖齐全 -> fresh
{
  const r = evaluateStockFreshness({
    watermark: { market: { trade_date: '2026-08-05' }, financial: { period_end: '2026-06-30' } },
    latestTradeDate: '2026-08-05',
  });
  assert.ok(!r.needs_refresh, '输入一致时应为 fresh');
}

// ===== 数据组 TTL 门控 =====
const TTL = 60; // 分钟
const NOW = new Date('2026-08-05T12:00:00Z');
// 9) TTL 内且本地有值 -> fresh
{
  const cursor = { last_source_update: new Date('2026-08-05T11:30:00Z'), last_attempt_at: new Date('2026-08-05T11:30:00Z') };
  assert.ok(isDatasetFresh(cursor, 'stock_dividend', { ttlMinutes: TTL, now: NOW }), 'TTL 内应视为新鲜');
}
// 10) TTL 外 -> 不新鲜
{
  const cursor = { last_source_update: new Date('2026-08-05T10:00:00Z'), last_attempt_at: new Date('2026-08-05T10:00:00Z') };
  assert.ok(!isDatasetFresh(cursor, 'stock_dividend', { ttlMinutes: TTL, now: NOW }), 'TTL 外应视为过期');
}
// 11) 强制刷新 -> 不新鲜
{
  const cursor = { last_source_update: new Date('2026-08-05T11:59:00Z'), last_attempt_at: new Date('2026-08-05T11:59:00Z') };
  assert.ok(!isDatasetFresh(cursor, 'stock_dividend', { ttlMinutes: TTL, now: NOW, force: true }), 'force 应跳过 TTL 直接过期');
}
// 12) 有上次错误 -> 不新鲜
{
  const cursor = { last_source_update: new Date('2026-08-05T11:59:00Z'), last_attempt_at: new Date('2026-08-05T11:59:00Z'), last_error: 'boom' };
  assert.ok(!isDatasetFresh(cursor, 'stock_dividend', { ttlMinutes: TTL, now: NOW }), '有错误记录应视为过期以便重试');
}

// ===== 扩展：M5/M6 修复验证 =====
// 13) 同天主档更新时间（含时分秒）晚于快照创建时间 -> profile_updated（修复"同日检测不到"）
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-08-05', latestBondTradeDate: '2026-08-05',
    snapshotCreatedAt: '2026-08-05T09:00:00+08:00',
    profileUpdatedAt: '2026-08-05T15:30:00+08:00',
    watermark: { conversion_price_event: { change_date: '2026-08-01' } },
    latestConvPriceChangeDate: '2026-07-30',
  });
  assert.ok(r.needs_refresh, '同天主档晚于快照创建应标记 needs_refresh');
  assert.ok(r.reasons.some(x => x.code === 'profile_updated'), '应给出 profile_updated 原因');
}

// 14) 行业变更 -> industry_changed（补全股票失效规则）
{
  const r = evaluateStockFreshness({
    watermark: { market: { trade_date: '2026-08-05' }, financial: { report_end_date: '2026-06-30', report_ann_date: '2026-08-01' },
      dividend: { latest_ann_date: '2026-06-01', latest_ex_date: '2026-06-10' },
      guidance: { ann_date: '2026-07-01', end_date: '2026-06-30' },
      industry: { name: '软件开发' }, controller: { name: '张三' }, event: { latest_event_date: '2026-07-20' } },
    latestTradeDate: '2026-08-05',
    current: { industryName: '半导体', controllerName: '张三' },
  });
  assert.ok(r.needs_refresh, '行业变更应标记 needs_refresh');
  assert.ok(r.reasons.some(x => x.code === 'industry_changed'), '应给出 industry_changed 原因');
}

// 15) 财报更新 -> financial_newer
{
  const r = evaluateStockFreshness({
    watermark: { market: { trade_date: '2026-08-05' }, financial: { report_end_date: '2026-06-30', report_ann_date: '2026-08-01' } },
    latestTradeDate: '2026-08-05',
    current: { financialEnd: '2026-09-30', financialAnn: '2026-10-20' },
  });
  assert.ok(r.reasons.some(x => x.code === 'financial_newer'), '财报更新应给出 financial_newer 原因');
}

// 16) 分红更新 -> dividend_newer
{
  const r = evaluateStockFreshness({
    watermark: { market: { trade_date: '2026-08-05' }, financial: { report_end_date: '2026-06-30', report_ann_date: '2026-08-01' },
      dividend: { latest_ann_date: '2026-06-01', latest_ex_date: '2026-06-10' } },
    latestTradeDate: '2026-08-05',
    current: { dividendAnn: '2026-08-15', dividendEx: '2026-08-20' },
  });
  assert.ok(r.reasons.some(x => x.code === 'dividend_newer'), '分红更新应给出 dividend_newer 原因');
}

// 17) 全部水位与当前实际值一致 -> fresh（新规则不误判）
{
  const r = evaluateStockFreshness({
    watermark: { market: { trade_date: '2026-08-05' }, financial: { report_end_date: '2026-06-30', report_ann_date: '2026-08-01' },
      dividend: { latest_ann_date: '2026-06-01', latest_ex_date: '2026-06-10' },
      guidance: { ann_date: '2026-07-01', end_date: '2026-06-30' },
      industry: { name: '软件开发' }, controller: { name: '张三' }, event: { latest_event_date: '2026-07-20' } },
    latestTradeDate: '2026-08-05',
    current: { financialEnd: '2026-06-30', financialAnn: '2026-08-01', dividendAnn: '2026-06-01', dividendEx: '2026-06-10',
      guidanceAnn: '2026-07-01', guidanceEnd: '2026-06-30', industryName: '软件开发', controllerName: '张三', eventDate: '2026-07-20' },
  });
  assert.ok(!r.needs_refresh, '全部水位与当前一致应为 fresh');
}

// 18) 空转股价（'' / null）不应被当成 0 元，产生错误错配（修复 finiteNum 空串转 0）
{
  const r1 = evaluateConvertibleBondFreshness({ snapshotConvPrice: '', profileConvPrice: 13.8 });
  assert.ok(!r1.reasons.some(x => x.code === 'conv_price_mismatch'), '空字符串快照转股价不应判为 0 元错配');
  const r2 = evaluateConvertibleBondFreshness({ snapshotConvPrice: null, profileConvPrice: 13.8 });
  assert.ok(!r2.reasons.some(x => x.code === 'conv_price_mismatch'), 'null 快照转股价不应判为 0 元错配');
}

// 19) 跨日期时间比较：7月30日更新必须判为晚于7月22日快照（修复 String() 字典序误判）
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-07-22', latestBondTradeDate: '2026-07-22',
    snapshotCreatedAt: '2026-07-22T11:00:00+08:00',
    profileUpdatedAt: '2026-07-30T10:00:00+08:00',
    watermark: { conversion_price_event: { change_date: '2026-07-20' } },
    latestConvPriceChangeDate: '2026-07-20',
  });
  assert.ok(r.needs_refresh && r.reasons.some(x => x.code === 'profile_updated'), '7月30日更新应判为晚于7月22日快照');
}

// 20) 已写入水位的正股行情日落后当前入库行情 -> stock_market_newer（补全失效检查）
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-08-05', latestBondTradeDate: '2026-08-05',
    watermark: { conversion_price_event: { change_date: '2026-08-01' }, stock_daily: { trade_date: '2026-08-01' } },
    latestConvPriceChangeDate: '2026-07-30',
    latestStockTradeDate: '2026-08-05',
  });
  assert.ok(r.reasons.some(x => x.code === 'stock_market_newer'), '正股新行情应给出 stock_market_newer 原因');
}

// 21) 已写入水位的财报报告期落后当前入库财报 -> financial_newer
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-08-05', latestBondTradeDate: '2026-08-05',
    watermark: { conversion_price_event: { change_date: '2026-08-01' }, financial: { report_end_date: '2026-06-30' } },
    latestConvPriceChangeDate: '2026-07-30',
    currentFinancialEnd: '2026-09-30',
  });
  assert.ok(r.reasons.some(x => x.code === 'financial_newer'), '更新财报应给出 financial_newer 原因');
}

// 22) 已写入水位的评级与当前主档评级不一致 -> rating_changed
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-08-05', latestBondTradeDate: '2026-08-05',
    watermark: { conversion_price_event: { change_date: '2026-08-01' }, rating: { newest_rating: 'AA' } },
    latestConvPriceChangeDate: '2026-07-30',
    currentRating: 'AA-',
  });
  assert.ok(r.reasons.some(x => x.code === 'rating_changed'), '评级变更应给出 rating_changed 原因');
}

// 23) 重算条款哈希与快照水位不一致 -> terms_changed
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-08-05', latestBondTradeDate: '2026-08-05',
    watermark: { conversion_price_event: { change_date: '2026-08-01' }, terms_hash: 'aaa' },
    latestConvPriceChangeDate: '2026-07-30',
    currentTermsHash: 'bbb',
  });
  assert.ok(r.reasons.some(x => x.code === 'terms_changed'), '条款变更应给出 terms_changed 原因');
}

// 24) 水位齐全且与当前实际值一致 -> fresh（新增检查不误判）
{
  const r = evaluateConvertibleBondFreshness({
    snapshotConvPrice: 13.8, profileConvPrice: 13.8,
    snapshotAsOf: '2026-08-05', latestBondTradeDate: '2026-08-05',
    watermark: { conversion_price_event: { change_date: '2026-08-01' },
      stock_daily: { trade_date: '2026-08-05' }, financial: { report_end_date: '2026-06-30' },
      rating: { newest_rating: 'AA' }, terms_hash: 'abc' },
    latestConvPriceChangeDate: '2026-07-30',
    latestStockTradeDate: '2026-08-05', currentFinancialEnd: '2026-06-30', currentRating: 'AA', currentTermsHash: 'abc',
  });
  assert.ok(!r.needs_refresh, '水位与当前实际值一致应为 fresh');
}

console.log('freshness-cursors.test.js 通过：可转债/股票新鲜度 + 数据组 TTL 门控 共 24 项');
