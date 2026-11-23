// 外币→人民币汇率（港股里用外币记账的公司做净流动资产折算用）。
//
// 背景：港股有一批公司用美元/澳元/新加坡元记账（财报是外币），但股票在港交所按港币交易，
// 市值也是港币。股票筛选的「格雷厄姆低估」规则要把「流动资产 − 流动负债 − 总市值」相减，
// 两边币种不同必须折算；而 market.fx_rates 过去只有 HKD→CNY 一对，这批公司只能判「缺汇率」跳过
// （含汇丰、友邦、渣打、中芯国际等）。本模块补齐其余币种对。
//
// 边界：
//   - 只写 base_currency=外币、quote_currency='CNY' 的行，不动 HKD→CNY 的任何现有数据；
//   - 不参与账户估值、不改 accounts.hk_rate 兼容字段，港币链路（jobs/hkRate、services/fxRate）不受影响；
//   - 数据源只用已准入的理杏仁官方 macro/currency-exchange-rate，不新增数据源。
//
// 币种对支持情况（2026-11-22 实测）：USD→CNY 可用（2019-01-02 起 2126 条）；
// AUD→CNY、SGD→CNY 返回 HTTP 400 ValidationError，即该接口不开放这两对，按「不支持」记录而非故障。
'use strict';
const official = require('./lixingerOfficial');
const fxRateRepository = require('../repositories/fxRateRepository');
const CoreDate = require('../../public/shared/core-date.js');

// 港股财报实际出现的非人民币/非港币币种（2026-11-22 生产核对：USD 58、AUD 1、SGD 1）。
const DEFAULT_CURRENCIES = ['USD', 'AUD', 'SGD'];
const DEFAULT_SINCE = '2019-01-01';
const CHUNK_DAYS = 366;
const QUOTE_CURRENCY = 'CNY';
// 各币种兑人民币的合理区间，用于拒绝明显脏数据；超出即丢弃并计入拒绝数。
const SANITY_RANGE = {
  USD: [5, 9],
  AUD: [3, 6.5],
  SGD: [3.5, 6.5],
  HKD: [0.5, 1.5],
  CNY: [0.5, 1.5],
};

function addDays(dateText, days) {
  const d = new Date(`${dateText}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return CoreDate.dateInZone(d, 'Asia/Shanghai');
}

function minDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function rateInRange(currency, rate) {
  const range = SANITY_RANGE[currency];
  if (!range) return Number.isFinite(rate) && rate > 0;
  return Number.isFinite(rate) && rate >= range[0] && rate <= range[1];
}

/**
 * 把官方返回的一行汇率归一成 { rateDate, rate }，无效返回 null。
 * 官方 `date` 是 UTC 时刻，业务日期按北京时间归日（实测 2026-11-18T16:00Z = 北京 11-19）。
 * @param {{date: string, close: number|string}} row
 * @param {string} currency
 * @returns {{rateDate: string, rate: number}|null}
 */
function normalizeFxRow(row, currency) {
  if (!row || !row.date) return null;
  const bizDate = CoreDate.dateInZone(new Date(row.date), 'Asia/Shanghai');
  const rate = Number(row.close);
  if (!bizDate || !CoreDate.normalizeBusinessDate(bizDate) || !rateInRange(currency, rate)) return null;
  return { rateDate: bizDate, rate };
}

async function fetchChunk(currency, startDate, endDate) {
  const res = await official.callEndpoint('macro/currency-exchange-rate', {
    startDate, endDate, fromCurrency: currency, toCurrency: QUOTE_CURRENCY,
  });
  const rows = Array.isArray(res) ? res : (res && (res.data || res.rows)) || [];
  const points = [];
  let rejected = 0;
  for (const row of rows) {
    const point = normalizeFxRow(row, currency);
    if (!point) {
      rejected += 1;
      continue;
    }
    points.push(point);
  }
  return { points, rejected, raw: rows.length };
}

/**
 * 同步外币→人民币汇率到 market.fx_rates。
 * @param {object} opts
 * @param {string[]} [opts.currencies] 币种列表
 * @param {string} [opts.since] 起始日（含），全量回填用
 * @param {number|null} [opts.days] 只拉最近 N 天（增量用），传了就忽略 since
 * @param {boolean} [opts.apply] 是否写库；false 为预演
 * @returns {Promise<{apply:boolean, quoteCurrency:string, today:string, sourceId:number, currencies:Array}>}
 */
async function syncForeignRates({ currencies = DEFAULT_CURRENCIES, since = DEFAULT_SINCE, days = null, apply = false } = {}) {
  const today = CoreDate.todayInZone('Asia/Shanghai', new Date());
  const sourceId = await fxRateRepository.readSourceIdByCode('lixinger_official');
  if (!sourceId) throw new Error('数据源 lixinger_official 未登记');

  const report = { apply, quoteCurrency: QUOTE_CURRENCY, today, sourceId, currencies: [] };
  for (const currency of currencies) {
    const upper = String(currency).toUpperCase();
    if (upper === QUOTE_CURRENCY) continue;
    const entry = { currency: upper, startDate: null, endDate: today, fetched: 0, rejected: 0,
      written: 0, firstDate: null, lastDate: null, latest: null, error: null };
    try {
      let start = days ? addDays(today, -Math.abs(days) + 1) : since;
      if (days === null) {
        // 全量回填：已有数据时只补缺口（回退 7 天重合，保证幂等覆盖），不把存量区间重复请求一遍。
        const existing = await fxRateRepository.readLatestRatePairUpTo(
          { baseCurrency: upper, quoteCurrency: QUOTE_CURRENCY, date: today });
        if (existing && existing.rate_date) {
          const resumeFrom = addDays(existing.rate_date, -7);
          if (resumeFrom && resumeFrom > start) start = resumeFrom;
        }
      }
      entry.startDate = start;
      let cursor = start;
      while (cursor && cursor <= today) {
        const chunkEnd = minDate(addDays(cursor, CHUNK_DAYS - 1), today);
        const { points, rejected, raw } = await fetchChunk(upper, cursor, chunkEnd);
        entry.fetched += raw;
        entry.rejected += rejected;
        for (const p of points) {
          // 接口按日期倒序返回，区间首末要自己比较大小，不能按顺序取。
          if (!entry.firstDate || p.rateDate < entry.firstDate) entry.firstDate = p.rateDate;
          if (!entry.lastDate || p.rateDate > entry.lastDate) entry.lastDate = p.rateDate;
          if (p.rateDate > ((entry.latest && entry.latest.rateDate) || '')) {
            entry.latest = { rateDate: p.rateDate, rate: p.rate };
          }
          if (apply) {
            await fxRateRepository.upsertRatePair({
              baseCurrency: upper, quoteCurrency: QUOTE_CURRENCY,
              rateDate: p.rateDate, sourceId, rate: p.rate,
            });
            entry.written += 1;
          }
        }
        cursor = chunkEnd < today ? addDays(chunkEnd, 1) : null;
      }
      if (!entry.fetched) entry.error = 'empty_result';
    } catch (e) {
      // 该接口只对部分币种对开放（AUD→CNY、SGD→CNY 实测 400），属「不支持」而不是故障。
      entry.error = (e.code === 'INVALID_REQUEST' && /HTTP 400/.test(String(e.message)))
        ? `unsupported_pair（接口不支持 ${upper}→${QUOTE_CURRENCY}）`
        : `${e.code || ''} ${e.message}`.trim();
    }
    report.currencies.push(entry);
  }
  return report;
}

/**
 * 定时任务用：增量同步最近 N 天，失败不影响调用方（只把结果回传）。
 * @param {object} [opts]
 * @param {number} [opts.days] 回溯天数
 */
async function syncRecentForeignRates({ days = 7 } = {}) {
  try {
    const report = await syncForeignRates({ days, apply: true });
    const applied = report.currencies.filter(c => c.written > 0);
    return {
      ok: true,
      days,
      written: applied.reduce((sum, c) => sum + c.written, 0),
      currencies: report.currencies.map(c => ({
        currency: c.currency, written: c.written, latest: c.latest, error: c.error,
      })),
    };
  } catch (e) {
    return { ok: false, days, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { syncForeignRates, syncRecentForeignRates, normalizeFxRow, rateInRange, DEFAULT_CURRENCIES };
