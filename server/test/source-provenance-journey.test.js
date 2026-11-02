// N3：来源真实性三层贯通（采集 → 存储 → 业务），2026-11-02 补缺口
//
// 缺口：此前只有分段（lixinger-range-chunking）、优先级方向（lixinger-source-priority）、
// 读取去重（stock-valuation-dedupe）三块**分开**的证据，没有一条路径把
// 「官方原始响应 → 标准行（含单位换算/来源标签）→ 落库 → 业务汇总择一」串起来。
// 而单位链正是最容易错的地方：
//   官方 `mc` 是**元** → 标准行 `total_mv` 是**万元**（÷10000）→ 落库 `total_market_cap` 又回到**元**（×10000）。
// 任何一环漏乘漏除，业务侧市值会差 1 万倍且看不出来（这就是本文件的核心断言）。
//
// 边界：
//   - 采集层用离线夹具（options.fetch 注入），不发真实网络请求；
//   - 落库只写本文件自建的 instrument（699901 段），业务汇总用**增量**断言，
//     不假设测试库里有多少真实证券，也不全表比较；
//   - 不修改任何生产结构，结束后按自建 instrument 清理。
'use strict';

// 本文件全程用 options.fetch 注入夹具，不会发出真实请求；但适配层在拼请求头时会检查
// 凭据是否已配置。这里只给一个**离线占位值**，不读也不写真实 token。
process.env.LIXINGER_TOKEN = process.env.LIXINGER_TOKEN || 'offline-test-token';

const assert = require('assert');
const { pool } = require('../db/connection');
const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
const stockRepository = require('../repositories/stockRepository');

const CODE = '699901.SH';
const BARE = '699901';
const DAY = '2026-10-30';
let sourceIds = {};
let instrumentId = null;

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

// 官方原始行（cn/company/fundamental/non_financial 的返回形状）
const OFFICIAL_RAW = {
  date: DAY + 'T00:00:00+08:00',
  stockCode: BARE,
  pe_ttm: 12.3456,
  pb: 1.2345,
  dyr: 0.0234,              // 官方是小数比例
  mc: 123450000000,         // 官方总市值：元
  cmc: 100000000000,        // 官方流通市值：元
};

async function cleanup() {
  if (instrumentId) {
    await pool.query('DELETE FROM market.daily_valuations WHERE instrument_id=$1', [instrumentId]).catch(() => {});
    await pool.query('DELETE FROM core.instruments WHERE instrument_id=$1', [instrumentId]).catch(() => {});
  }
  await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [CODE]).catch(() => {});
}

(async () => {
  try {
    await cleanup();

    const src = await pool.query(
      "SELECT source_code, source_id, priority FROM ops.data_sources WHERE source_code = ANY($1::text[])",
      [['lixinger_official', 'tushare']]
    );
    for (const row of src.rows) sourceIds[row.source_code] = { id: row.source_id, priority: Number(row.priority) };
    assert.ok(sourceIds.lixinger_official, '缺少 lixinger_official 来源登记（属环境缺失，不是通过）');
    assert.ok(sourceIds.tushare, '缺少 tushare 来源登记');

    const ins = await pool.query(
      `INSERT INTO core.instruments(canonical_code, name, asset_class, market, exchange_code, status)
       VALUES($1,'三层贯通测试股','stock','CN','SSE','listed') RETURNING instrument_id`,
      [CODE]
    );
    instrumentId = ins.rows[0].instrument_id;

    // ==================== 第一层：采集（离线夹具 → 标准行） ====================
    const seen = [];
    const fakeFetch = async (url, options) => {
      const body = JSON.parse(options.body);
      seen.push({ url, stockCodes: body.stockCodes, startDate: body.startDate, endDate: body.endDate, metricsList: body.metricsList });
      return jsonResponse({ code: 1, message: 'success', total: 1, data: [OFFICIAL_RAW] });
    };
    const detail = await adapter.resolveValuationSeriesDetailed({
      codes: [CODE], startDate: DAY, endDate: DAY,
      options: { fetch: fakeFetch, sleep: async () => {} },
    });
    assert.ok(detail && Array.isArray(detail.rows), '采集入口必须返回带 rows 的详细结果');
    assert.strictEqual(detail.complete, true, '单段单只必须判定为完整，不能报部分失败：' + JSON.stringify(detail));
    assert.strictEqual(detail.rows.length, 1);
    assert.strictEqual(seen.length, 1, '同日单只只能发一次请求');
    assert.deepStrictEqual(seen[0].stockCodes, [BARE], '官方区间接口只接受单个证券代码');

    const row = detail.rows[0];
    assert.strictEqual(row.ts_code, CODE);
    // 标准行沿用 Tushare 形状：trade_date 是 8 位 YYYYMMDD（无横线），落库时才转成 DATE。
    // 这条口径不写清，后续「补数脚本按 2026-10-30 过滤标准行」会一条都匹配不上。
    assert.strictEqual(row.trade_date, '20261030', '标准行日期必须是 Tushare 口径 YYYYMMDD');
    assert.strictEqual(row.source_code, 'lixinger_official', '标准行必须自带来源标签，不能等落库再猜');
    // 单位链第一段：官方元 → 标准行万元
    assert.strictEqual(row.total_mv, OFFICIAL_RAW.mc / 10000, '总市值必须由元换算成万元');
    assert.strictEqual(row.circ_mv, OFFICIAL_RAW.cmc / 10000);
    // 单位链第二段：官方小数比例 → 标准行百分数点
    assert.strictEqual(row.dv_ttm, OFFICIAL_RAW.dyr * 100, '股息率必须换算成百分数点');
    assert.strictEqual(row.pe_ttm, OFFICIAL_RAW.pe_ttm);
    assert.strictEqual(row.pb, OFFICIAL_RAW.pb);
    assert.strictEqual(row.pe, null, '官方没有静态市盈率指标，必须留 null 而不是编一个值');
    console.log('  ✓ 采集层：官方原始行 → 标准行（来源标签 + 元→万元 + 小数→百分数点，静态PE 留 null）');

    // 反例：官方该日无数据时必须如实返回空，不得伪造一行
    const emptyFetch = async () => jsonResponse({ code: 1, message: 'success', total: 0, data: [] });
    const emptyDetail = await adapter.resolveValuationSeriesDetailed({
      codes: [CODE], startDate: DAY, endDate: DAY,
      options: { fetch: emptyFetch, sleep: async () => {} },
    });
    assert.strictEqual(emptyDetail.rows.length, 0, '官方返空不能造数据');
    assert.strictEqual(emptyDetail.emptyBatches, 1, '空结果要留空批次计数，供任务区分「无数据」与「失败」');
    console.log('  ✓ 采集层反例：官方返空如实记空批次，不伪造数据');

    // ==================== 第二层：存储（按行来源落库，多来源共存） ====================
    // 落库单位回到「元」：total_mv(万元) × 10000。
    async function insertValuation(sourceCode, { peTtm, pb, dividendYield, totalMvWan }) {
      await pool.query(
        `INSERT INTO market.daily_valuations
           (instrument_id, trade_date, source_id, pe_static, pe_ttm, pb, dividend_yield_ttm,
            total_market_cap, circulating_market_cap, currency_code)
         VALUES($1,$2,$3,NULL,$4,$5,$6,$7,NULL,'CNY')
         ON CONFLICT (instrument_id, trade_date, source_id) DO UPDATE SET
           pe_ttm=EXCLUDED.pe_ttm, pb=EXCLUDED.pb, dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,
           total_market_cap=EXCLUDED.total_market_cap`,
        [instrumentId, DAY, sourceIds[sourceCode].id, peTtm, pb, dividendYield, totalMvWan * 10000]
      );
    }

    // 业务基线必须在写入之前取，否则增量恒为 0（等于自己和自己比）。
    const before = await stockRepository.totalMarketCap({ tradeDate: DAY });

    await insertValuation('lixinger_official', {
      peTtm: row.pe_ttm, pb: row.pb, dividendYield: row.dv_ttm, totalMvWan: row.total_mv,
    });
    // 备源同日写入一个明显不同的值：如果择一取错，业务汇总会立刻对不上。
    await insertValuation('tushare', { peTtm: 99.9, pb: 9.9, dividendYield: 9.9, totalMvWan: 1 });

    const stored = await pool.query(
      `SELECT d.source_id, s.source_code, d.total_market_cap::double precision AS cap,
              d.dividend_yield_ttm::double precision AS dyr
         FROM market.daily_valuations d JOIN ops.data_sources s ON s.source_id = d.source_id
        WHERE d.instrument_id=$1 AND d.trade_date=$2 ORDER BY s.source_code`,
      [instrumentId, DAY]
    );
    assert.strictEqual(stored.rows.length, 2, '同一天两个来源必须能共存（主键含 source_id）');
    const officialStored = stored.rows.find(r => r.source_code === 'lixinger_official');
    assert.strictEqual(officialStored.cap, OFFICIAL_RAW.mc, '落库总市值必须回到「元」，与官方原始值一致');
    assert.strictEqual(officialStored.dyr, OFFICIAL_RAW.dyr * 100, '落库股息率是百分数点');
    console.log('  ✓ 存储层：万元×10000 回元，双来源同日共存且各带自己的 source_id');

    // ==================== 第三层：业务（汇总按来源优先级择一） ====================
    // 业务汇总口径：同证券同日只取一行、按 ops.data_sources.priority ASC（官方 5 < tushare 10）。
    const after = await stockRepository.totalMarketCap({ tradeDate: DAY });
    const deltaCap = after.total_cap - before.total_cap;
    assert.strictEqual(deltaCap, OFFICIAL_RAW.mc,
      '业务汇总必须取官方值（' + OFFICIAL_RAW.mc + '），实际增量 ' + deltaCap
      + '；若等于 10000 说明取到了备源的 1 万元');
    assert.strictEqual(after.stock_count - before.stock_count, 1,
      '同证券同日双来源只能计一次，否则市值会被重复计算');
    assert.ok(sourceIds.lixinger_official.priority < sourceIds.tushare.priority,
      '官方优先级必须小于备源（数值小者优先），否则上面的断言只是碰巧通过');
    console.log('  ✓ 业务层：同证券同日双来源按优先级择一，取官方值且不重复计数');

    // 反例一：只有备源时，业务侧应取到备源值——这是合法的降级，不是伪造官方
    await pool.query('DELETE FROM market.daily_valuations WHERE instrument_id=$1 AND trade_date=$2 AND source_id=$3',
      [instrumentId, DAY, sourceIds.lixinger_official.id]);
    const fallbackOnly = await stockRepository.totalMarketCap({ tradeDate: DAY });
    assert.strictEqual(fallbackOnly.total_cap - before.total_cap, 1 * 10000,
      '只剩备源时必须取备源的 1 万元，不能凭空变回官方值');
    console.log('  ✓ 业务层反例：官方缺失时降级取备源，数值随实际来源变化（不保留旧官方值）');

    // 反例二：市值为 0 的行不参与汇总（>0 过滤），但行本身要留着
    await pool.query('DELETE FROM market.daily_valuations WHERE instrument_id=$1 AND trade_date=$2', [instrumentId, DAY]);
    await insertValuation('lixinger_official', { peTtm: 12.3, pb: 1.2, dividendYield: 2.3, totalMvWan: 0 });
    const zeroRow = await stockRepository.totalMarketCap({ tradeDate: DAY });
    assert.strictEqual(zeroRow.total_cap - before.total_cap, 0, '总市值为 0 的行不得进入汇总');
    const keptZero = await pool.query(
      'SELECT count(*)::int AS n FROM market.daily_valuations WHERE instrument_id=$1 AND trade_date=$2',
      [instrumentId, DAY]
    );
    assert.strictEqual(keptZero.rows[0].n, 1, '0 值行本身必须保留，不能当脏数据删掉');
    console.log('  ✓ 业务层反例：总市值 0 的行保留但不计入汇总（0 与 NULL 都不是「无数据」）');

    await cleanup();
    console.log('source-provenance-journey: 全部通过');
  } catch (error) {
    console.error('source-provenance-journey 失败:', error && error.stack ? error.stack : error);
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原始错误 */ }
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
