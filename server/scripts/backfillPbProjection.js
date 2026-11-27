#!/usr/bin/env node
// PB 投影历史回填 CLI（2026-11-27）。
//
// 用途：首次上线按 (market, cal_year, cal_month) 逐月小事务回填 analytics PB 投影；
// 历史估值补录/修订/删除、交易日历/停牌/主档变更也可用它做定点整月重算。
//
// 安全边界：
// - 本脚本只连当前进程配置的数据库（PORTFOLIO .env）；生产回填必须由用户单独书面授权后执行。
// - 默认拒绝 NODE_ENV=production，除非显式 --allow-production；--dry-run 只打印计划，不写库。
// - 按月提交、逐月写 ops.sync_cursors，断开可从 --resume 续跑；批次间 sleep 让出 I/O。
//
// 示例：
//   node server/scripts/backfillPbProjection.js --market=CN --from=2015-01-01 --to=2026-11-30 --resume
//   node server/scripts/backfillPbProjection.js --market=HK --month=2026-10
//   node server/scripts/backfillPbProjection.js --instrument-change --market=CN --codes=600519.SH,000001.SZ
//   node server/scripts/backfillPbProjection.js --pending-full-rebuild
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool } = require('../db/connection');
const repository = require('../repositories/pbProjectionRepository');
const sync = require('../services/pbProjectionSync');

function parseArgs(argv) {
  const options = {
    market: 'ALL', from: null, to: null, month: null, resume: false,
    sleepMs: 120, dryRun: false, allowProduction: false, instrumentChange: false,
    codes: [], pendingFullRebuild: false, fullRebuild: false,
  };
  for (const arg of argv) {
    if (arg === '--resume') options.resume = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-production') options.allowProduction = true;
    else if (arg === '--instrument-change') options.instrumentChange = true;
    else if (arg === '--pending-full-rebuild') options.pendingFullRebuild = true;
    else if (arg === '--full-rebuild') options.fullRebuild = true;
    else if (arg.startsWith('--market=')) options.market = arg.split('=')[1].toUpperCase();
    else if (arg.startsWith('--from=')) options.from = arg.split('=')[1];
    else if (arg.startsWith('--to=')) options.to = arg.split('=')[1];
    else if (arg.startsWith('--month=')) options.month = arg.split('=')[1];
    else if (arg.startsWith('--sleep-ms=')) options.sleepMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--codes=')) {
      options.codes = arg.split('=')[1].split(',').map(code => code.trim()).filter(Boolean);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function resolveMarkets(value) {
  const text = String(value || 'ALL').toUpperCase();
  if (text === 'ALL') return ['CN', 'HK'];
  if (!['CN', 'HK'].includes(text)) throw new Error('--market 只能是 CN、HK 或 ALL');
  return [text];
}

function normalizeMonthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('--month 必须是 YYYY-MM');
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const start = `${month}-01`;
  const end = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
  return { start, end, year, month: mon };
}

async function resolveRange(options) {
  if (options.month) return normalizeMonthRange(options.month);
  let from = options.from;
  let to = options.to;
  if (!from || !to) {
    const bounds = await repository.getMarketValuationBounds({ market: resolveMarkets(options.market)[0] });
    from = from || bounds.min_date;
    to = to || bounds.max_date;
  }
  if (!from || !to) throw new Error('无法确定回填范围：请显式传 --from/--to 或 --month');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error('回填范围无效');
  }
  return { start: from, end: to };
}

async function resolveInstrumentIds(codes) {
  if (!codes.length) return [];
  const { rows } = await pool.query(
    'SELECT instrument_id, canonical_code FROM core.instruments WHERE canonical_code = ANY($1)',
    [codes],
  );
  const found = new Map(rows.map(row => [row.canonical_code, Number(row.instrument_id)]));
  const missing = codes.filter(code => !found.has(code));
  if (missing.length) throw new Error(`证券不存在：${missing.join(', ')}`);
  return [...found.values()];
}

async function resumeStart(market, start) {
  const cursor = await repository.readSyncCursor({ scopeKey: `pb_projection:${market}`, datasetCode: 'pb_projection' });
  if (!cursor || !cursor.last_success_date) return start;
  const last = String(cursor.last_success_date).slice(0, 10);
  if (last < start) return start;
  const date = new Date(`${last}T00:00:00Z`);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targetDatabase = process.env.PGDATABASE || '(from DATABASE_URL)';
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production' && !options.allowProduction) {
    throw new Error('拒绝在 production 环境直接回填；如已获用户书面授权，请显式加 --allow-production');
  }
  const markets = resolveMarkets(options.market);
  console.log(`[pb-projection] 目标库=${targetDatabase} 市场=${markets.join(',')} dryRun=${options.dryRun}`);

  if (options.instrumentChange) {
    const ids = await resolveInstrumentIds(options.codes);
    if (!ids.length) throw new Error('--instrument-change 需要 --codes');
    for (const market of markets) {
      if (options.dryRun) {
        console.log(`[dry-run] ${market} 证券主档变更重算 instrumentIds=${ids.join(',')}`);
        continue;
      }
      const result = await sync.syncInstrumentChange({ market, instrumentIds: ids });
      console.log(`[pb-projection] ${market} 主档变更重算完成`, result);
    }
    return;
  }

  if (options.pendingFullRebuild) {
    if (options.dryRun) {
      console.log('[dry-run] 将消费 6 类触发面留下的待全量重建标记');
      return;
    }
    const results = await sync.runPendingFullRebuilds({ markets, sleepMs: options.sleepMs });
    console.log('[pb-projection] 待全量重建处理完成', results);
    return;
  }

  for (const market of markets) {
    let range;
    try {
      range = await resolveRange({ ...options, market });
    } catch (error) {
      if (options.market === 'ALL') {
        console.warn(`[pb-projection] ${market} 跳过：${error.message}`);
        continue;
      }
      throw error;
    }
    const from = options.resume ? await resumeStart(market, range.start) : range.start;
    if (from > range.end) {
      console.log(`[pb-projection] ${market} 已到水位末端，无需回填`);
      continue;
    }
    if (options.dryRun) {
      console.log(`[dry-run] ${market} ${from} → ${range.end}`);
      continue;
    }
    console.log(`[pb-projection] ${market} 开始回填 ${from} → ${range.end}`);
    const result = await sync.fullRebuild({
      market, fromDate: from, toDate: range.end, sleepMs: options.sleepMs,
      onProgress: progress => {
        console.log(`[pb-projection] ${market} ${progress.month.year}-${String(progress.month.month).padStart(2, '0')}`
          + ` (${progress.rebuilt}/${progress.total}) picked=${progress.result.picked} summaries=${progress.result.summaries}`);
      },
    });
    console.log(`[pb-projection] ${market} 回填完成`, result);
  }
}

main()
  .catch(error => {
    console.error('[pb-projection] 失败：', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
