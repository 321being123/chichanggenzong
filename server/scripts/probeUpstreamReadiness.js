#!/usr/bin/env node
// 上游数据就绪只读探针（阶段 0，2026-11-27）。
//
// 目的：在连续 3～5 个交易日的 00:30 / 01:00 / 02:00 / 03:00，抽样探测理杏仁、Tushare、
// 交易所对目标日 T 的数据是否已经可用，为凌晨波次排程提供实测证据。
//
// 边界（强制）：
// - 只读：所有外呼经现有 externalCallGuard；理杏仁 persist:false 不写 ops.raw_records，
//   Tushare/交易所适配器只返回结果；本脚本不写任何业务表。
// - 不猜额度、不扩大来源范围；单个来源失败只记录该来源，不熔断其他来源。
// - --dry-run 完全不连库、不联网，供本地单测与人工核对参数。
//
// 用法：
//   node server/scripts/probeUpstreamReadiness.js --target-date=2026-11-26 --market=CN --dry-run
//   node server/scripts/probeUpstreamReadiness.js --target-date=2026-11-26 --market=ALL --sample=3
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool } = require('../db/connection');
const lixingerOfficial = require('../services/lixingerOfficial');
const { tushareQuery } = require('../services/tushare');
const announcementAdapter = require('../dataAccess/adapters/announcementSourceAdapter');
const { stockCodeOf } = require('../dataAccess/adapters/lixingerDatasetAdapter');

function parseArgs(argv) {
  const options = {
    targetDate: null, market: 'ALL', sample: 5, dryRun: false,
    sources: ['lixinger', 'tushare', 'exchange'],
  };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--target-date=')) options.targetDate = arg.split('=')[1];
    else if (arg.startsWith('--market=')) options.market = arg.split('=')[1].toUpperCase();
    else if (arg.startsWith('--sample=')) options.sample = Math.max(Number(arg.split('=')[1]) || 5, 1);
    else if (arg.startsWith('--sources=')) {
      options.sources = arg.split('=')[1].split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (options.targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(options.targetDate)) {
    throw new Error('--target-date 必须是 YYYY-MM-DD');
  }
  if (options.dryRun && !options.targetDate) {
    options.targetDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  }
  if (!options.targetDate) throw new Error('必须提供 --target-date=YYYY-MM-DD');
  if (!['CN', 'HK', 'ALL'].includes(options.market)) throw new Error('--market 只能是 CN、HK 或 ALL');
  for (const source of options.sources) {
    if (!['lixinger', 'tushare', 'exchange'].includes(source)) throw new Error(`未知来源：${source}`);
  }
  return options;
}

function marketsOf(value) {
  return value === 'ALL' ? ['CN', 'HK'] : [value];
}

function compactDate(date) {
  return String(date).replace(/-/g, '');
}

async function sampleCodes(market, targetDate, limit) {
  const { rows } = await pool.query(`
    SELECT canonical_code FROM core.instruments
     WHERE market = $1 AND asset_class = 'stock'
       AND (list_date IS NULL OR list_date <= $2::date)
     ORDER BY instrument_id
     LIMIT $3`, [market, targetDate, limit]);
  return rows.map(row => row.canonical_code);
}

function timed() {
  const started = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - started) / 1e6;
}

async function probeLixinger({ market, targetDate, codes }) {
  const elapsed = timed();
  const endpoint = market === 'HK' ? 'hk/company/fundamental/non_financial' : 'cn/company/fundamental/non_financial';
  // 理杏仁官方接口只接受纯数字代码：A 股 6 位（600519）、港股 5 位补零（00700）。
  // 直接发 core.instruments.canonical_code（600519.SH / 00700.HK）会被上游判为 400。
  const stockCodes = (codes || []).map(stockCodeOf).filter(Boolean);
  if (!stockCodes.length) {
    return {
      source: 'lixinger', market, ok: false, ready: false, rowCount: 0, withPb: 0,
      error: { code: 'NO_VALID_STOCK_CODE', message: '样本中没有可转换为理杏仁纯数字代码的证券' },
      latencyMs: Math.round(elapsed()),
    };
  }
  try {
    const result = await lixingerOfficial.callEndpoint(endpoint, {
      stockCodes,
      date: targetDate,
      metricsList: ['pe_ttm', 'pb'],
    }, { targetDate, persist: false, maxAgeMs: 0 });
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const withPb = rows.filter(row => row && row.pb !== null && row.pb !== undefined).length;
    return {
      source: 'lixinger', market, ok: true, ready: rows.length > 0,
      rowCount: rows.length, withPb, total: result.total == null ? null : Number(result.total),
      stockCodes,
      sample: rows.slice(0, 2), latencyMs: Math.round(elapsed()),
      note: result.empty ? '接口成功但目标日暂无数据' : '目标日已有数据',
    };
  } catch (error) {
    return {
      source: 'lixinger', market, ok: false, ready: false, rowCount: 0, withPb: 0,
      stockCodes,
      error: { code: error.code || 'PROBE_FAILED', message: error.message },
      latencyMs: Math.round(elapsed()),
    };
  }
}

async function probeTushare({ market, targetDate }) {
  const elapsed = timed();
  const apiName = market === 'HK' ? 'hk_daily' : 'daily_basic';
  try {
    const data = await tushareQuery(apiName, { trade_date: compactDate(targetDate) }, '', { allowEmpty: true });
    const items = Array.isArray(data.items) ? data.items : [];
    return {
      source: 'tushare', market, ok: true, ready: items.length > 0,
      rowCount: items.length, apiName, latencyMs: Math.round(elapsed()),
      note: items.length ? '目标日已有数据' : '接口成功但目标日暂无数据',
    };
  } catch (error) {
    return {
      source: 'tushare', market, ok: false, ready: false, rowCount: 0, apiName,
      error: { code: error.code || 'PROBE_FAILED', message: error.message },
      latencyMs: Math.round(elapsed()),
    };
  }
}

async function probeExchange({ market, targetDate, codes }) {
  const elapsed = timed();
  try {
    if (market === 'HK') {
      const { searchAnnouncements } = require('../services/hkexAnnouncement');
      const result = await searchAnnouncements({ fromDate: targetDate, toDate: targetDate });
      const rows = Array.isArray(result) ? result : [];
      return {
        source: 'exchange', market, ok: true, ready: rows.length > 0,
        rowCount: rows.length, exchange: 'HKEX', latencyMs: Math.round(elapsed()),
        note: rows.length ? '目标日已有公告' : '接口成功但目标日暂无公告',
      };
    }
    const [sse, szse] = await Promise.all([
      announcementAdapter.fetchSseEventsBatch(targetDate, targetDate),
      announcementAdapter.fetchSzseEventsBatch(targetDate, targetDate),
    ]);
    const sseCount = Array.isArray(sse.events) ? sse.events.length : 0;
    const szseCount = Array.isArray(szse.events) ? szse.events.length : 0;
    return {
      source: 'exchange', market, ok: true, ready: sse.complete !== false && szse.complete !== false,
      rowCount: sseCount + szseCount,
      exchanges: {
        SSE: { rowCount: sseCount, complete: sse.complete !== false },
        SZSE: { rowCount: szseCount, complete: szse.complete !== false },
      },
      latencyMs: Math.round(elapsed()),
      note: (sseCount + szseCount) ? '目标日已有公告' : '交易所成功但目标日暂无公告',
    };
  } catch (error) {
    return {
      source: 'exchange', market, ok: false, ready: false, rowCount: 0,
      error: { code: error.code || 'PROBE_FAILED', message: error.message },
      latencyMs: Math.round(elapsed()),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const markets = marketsOf(options.market);
  const report = {
    mode: options.dryRun ? 'dry-run' : 'read-only',
    targetDate: options.targetDate,
    requestedAt: new Date().toISOString(),
    markets,
    sources: options.sources,
    results: [],
    ready: null,
  };
  if (options.dryRun) {
    for (const market of markets) {
      for (const source of options.sources) {
        report.results.push({
          source, market, dryRun: true, ok: true, ready: null,
          planned: source === 'lixinger' ? 'callEndpoint(persist:false; stockCodes=纯数字代码)'
            : source === 'tushare' ? 'tushareQuery(allowEmpty:true)'
              : '交易所公告批量只读',
        });
      }
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  for (const market of markets) {
    const codes = options.sources.includes('lixinger') || options.sources.includes('exchange')
      ? await sampleCodes(market, options.targetDate, options.sample)
      : [];
    for (const source of options.sources) {
      if (source === 'lixinger') report.results.push(await probeLixinger({ market, targetDate: options.targetDate, codes }));
      else if (source === 'tushare') report.results.push(await probeTushare({ market, targetDate: options.targetDate }));
      else report.results.push(await probeExchange({ market, targetDate: options.targetDate, codes }));
    }
  }
  report.ready = report.results.length > 0 && report.results.every(item => item.ready === true);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error('[probe] 失败：', error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end().catch(() => {});
    });
}

module.exports = { parseArgs, probeLixinger, marketsOf, compactDate };
