#!/usr/bin/env node
// 选股分段 SQL 基准（阶段 0，2026-11-27）。
//
// 直接调用现行 stockSelectionRepository 的分段查询，避免另写一套“基准 SQL”与生产漂移。
// 只读：所有查询均为 SELECT；不写业务表、不改任务、不触发外采。
//
// 用法：
//   node server/scripts/benchmarkSelectionQueries.js --market=CN --iterations=3
//   node server/scripts/benchmarkSelectionQueries.js --market=CN --as-of=2026-09-30 --json
//
// 输出：每段 P50/P95/最小/最大毫秒 + 本机库规模。生产 1,285 万行必须在同规模隔离库复测，
// 本机结果只能作为相对基线，不能冒充生产阈值。
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool } = require('../db/connection');
const repo = require('../repositories/stockSelectionRepository');

function parseArgs(argv) {
  const options = { market: 'CN', asOf: null, iterations: 3, json: false, readMode: 'legacy' };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg.startsWith('--market=')) options.market = arg.split('=')[1].toUpperCase();
    else if (arg.startsWith('--as-of=')) options.asOf = arg.split('=')[1];
    else if (arg.startsWith('--iterations=')) options.iterations = Math.max(Number(arg.split('=')[1]) || 1, 1);
    else if (arg.startsWith('--read-mode=')) options.readMode = arg.split('=')[1].toLowerCase();
    else throw new Error(`未知参数：${arg}`);
  }
  if (!['CN', 'HK'].includes(options.market)) throw new Error('--market 只能是 CN 或 HK');
  if (options.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(options.asOf)) throw new Error('--as-of 必须是 YYYY-MM-DD');
  if (!['legacy', 'projected', 'both'].includes(options.readMode)) {
    throw new Error('--read-mode 只能是 legacy、projected 或 both');
  }
  return options;
}

function minusYears(dateText, years) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(Math.max(Math.ceil((pct / 100) * sorted.length) - 1, 0), sorted.length - 1);
  return sorted[index];
}

function summarize(samples) {
  const values = samples.filter(value => Number.isFinite(value));
  return {
    count: values.length,
    min: values.length ? Math.round(Math.min(...values)) : null,
    p50: values.length ? Math.round(percentile(values, 50)) : null,
    p95: values.length ? Math.round(percentile(values, 95)) : null,
    max: values.length ? Math.round(Math.max(...values)) : null,
    samples: values.map(value => Math.round(value)),
  };
}

async function timeIt(fn) {
  const started = process.hrtime.bigint();
  const result = await fn();
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, result };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const market = options.market;
  const row = (await pool.query(`
    SELECT MAX(v.trade_date)::text AS max_date,
           COUNT(*)::bigint AS valuation_rows
      FROM market.daily_valuations v
      JOIN core.instruments i ON i.instrument_id = v.instrument_id
     WHERE i.market = $1`, [market])).rows[0] || {};
  const asOf = options.asOf || row.max_date;
  if (!asOf) throw new Error('没有可用估值日期，请显式传 --as-of');
  const windowStart = minusYears(asOf, 10);

  const universe = await repo.loadUniverse({ market, asOfDate: asOf });
  const instrumentIds = universe.map(item => Number(item.instrument_id));
  const companyIds = Array.from(new Set(universe.map(item => Number(item.company_id)).filter(Number.isFinite)));
  const samples = new Map();
  const record = (name, ms) => {
    if (!samples.has(name)) samples.set(name, []);
    samples.get(name).push(ms);
  };

  // 先跑一次预热，避免连接池新建与 PG 计划缓存把首轮算进 P95。
  const requestedModes = options.readMode === 'both' ? ['legacy', 'projected'] : [options.readMode];
  const withMode = async (mode, fn) => {
    const previous = process.env.PB_PROJECTION_READ_ENABLED;
    process.env.PB_PROJECTION_READ_ENABLED = mode === 'projected' ? '1' : '0';
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.PB_PROJECTION_READ_ENABLED;
      else process.env.PB_PROJECTION_READ_ENABLED = previous;
    }
  };
  const preheatErrors = {};
  const readModes = [];
  for (const mode of requestedModes) {
    try {
      await withMode(mode, () => repo.loadPbWindow({ market, windowStart, asOfDate: asOf }));
      readModes.push(mode);
    } catch (error) {
      // 投影尚未回填时 projected 预热会抛 PB_PROJECTION_NOT_READY；记录后继续测 legacy，
      // 不让一次基准脚本把“还没回填”误报成脚本故障。
      preheatErrors[mode] = error.message;
    }
  }
  if (!readModes.length) throw new Error(`所有读路径预热失败：${JSON.stringify(preheatErrors)}`);
  for (let index = 0; index < options.iterations; index += 1) {
    record('loadUniverse', (await timeIt(() => repo.loadUniverse({ market, asOfDate: asOf }))).ms);
    for (const mode of readModes) {
      record(`loadPbWindow(${mode})`, await withMode(mode, async () => {
        const measured = await timeIt(() => repo.loadPbWindow({ market, windowStart, asOfDate: asOf }));
        return measured.ms;
      }));
    }
    record('marketDaysOnly', (await timeIt(() => pool.query(`
      SELECT COUNT(DISTINCT v.trade_date)::int AS market_days
        FROM market.daily_valuations v
        JOIN core.instruments i ON i.instrument_id = v.instrument_id
       WHERE i.market = $1 AND v.trade_date > $2::date AND v.trade_date <= $3::date`,
    [market, windowStart, asOf]))).ms);
    record('loadAnnualDividends', (await timeIt(() => repo.loadAnnualDividends({
      companyIds, asOfDate: asOf, availableBefore: `${asOf}T23:59:59Z`, market,
    }))).ms);
    record('loadEquityFacts', (await timeIt(() => repo.loadEquityFacts({
      companyIds, asOfDate: asOf, availableBefore: `${asOf}T23:59:59Z`, market,
    }))).ms);
    record('loadAnnualProfits', (await timeIt(() => repo.loadAnnualProfits({
      companyIds, asOfDate: asOf, availableBefore: `${asOf}T23:59:59Z`, market,
    }))).ms);
    record('loadTtmInputs', (await timeIt(() => repo.loadTtmInputs({
      companyIds, asOfDate: asOf, availableBefore: `${asOf}T23:59:59Z`, market,
    }))).ms);
    record('loadIndustries', (await timeIt(() => repo.loadIndustries({ companyIds, market, asOfDate: asOf }))).ms);
  }

  const sizes = (await pool.query(`
    SELECT 'daily_valuations' AS table_name, COUNT(*)::bigint AS row_count,
           pg_total_relation_size('market.daily_valuations')::bigint AS bytes
      FROM market.daily_valuations
    UNION ALL
    SELECT 'financial_reports', COUNT(*)::bigint,
           pg_total_relation_size('fundamental.financial_reports')::bigint
      FROM fundamental.financial_reports`)).rows;

  const report = {
    mode: 'local-baseline',
    market,
    asOfDate: asOf,
    windowStart,
    iterations: options.iterations,
    readModes,
    preheatErrors,
    universe: instrumentIds.length,
    companies: companyIds.length,
    database: process.env.PGDATABASE || '(from DATABASE_URL)',
    tables: sizes.map(item => ({
      table: item.table_name, rows: Number(item.row_count), bytes: Number(item.bytes),
      sizeMb: Math.round(Number(item.bytes) / 1024 / 1024),
    })),
    segments: Object.fromEntries([...samples.entries()].map(([name, values]) => [name, summarize(values)])),
    note: '本机 dev 库体量；生产 1,285 万行 daily_valuations 必须在同规模隔离库复测后才能锁定阶段 1 绝对阈值。',
    measuredAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(error => {
    console.error('[benchmark] 失败：', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
