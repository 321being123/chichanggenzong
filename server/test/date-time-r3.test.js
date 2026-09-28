'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const CoreDate = require('../../public/shared/core-date.js');
const stockRefresh = require('../jobs/stockAnalysisRefresh');
const hkRate = require('../jobs/hkRate');
const hkIpo = require('../jobs/hkIpoSync');
const cycleMetrics = require('../services/marketCycleMetrics');
const marketVolatility = require('../services/marketVolatility');
const pool = require('../db/connection').pool;

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const fixedInstant = '2026-09-27T16:30:00.000Z';

assert.deepStrictEqual(stockRefresh.targetDateStatus('2026-09-28', fixedInstant), {
  ok: true, targetDate: '2026-09-28',
});
assert.deepStrictEqual(stockRefresh.targetDateStatus('2026-09-25', fixedInstant), {
  ok: false, reason: 'historical_target_unsupported',
});
assert.deepStrictEqual(stockRefresh.targetDateStatus('2026-09-29', fixedInstant), {
  ok: false, reason: 'future_target_unsupported',
});
assert.strictEqual(hkIpo.resolveTargetDate({ targetDate: '2026-09-25' }, fixedInstant), '2026-09-25');
assert.strictEqual(hkIpo.resolveTargetDate({ targetDate: '2026-02-30' }, fixedInstant), null);
assert.strictEqual(hkIpo.resolveTargetDate({}, fixedInstant), '2026-09-28');
assert.deepStrictEqual(hkIpo.liveSignalTargetDateStatus('subscription_midday', '2026-09-25', fixedInstant), {
  ok: false, reason: 'historical_target_unsupported',
});
assert.deepStrictEqual(hkIpo.liveSignalTargetDateStatus('preopen', '2026-09-28', fixedInstant), { ok: true });
assert.deepStrictEqual(hkIpo.liveSignalTargetDateStatus('subscription_close', '2026-09-29', fixedInstant), {
  ok: false, reason: 'future_target_unsupported',
});

const requestedDates = [];
(async () => {
  const actualToday = CoreDate.todayInZone('Asia/Shanghai');
  const historicalTarget = new Date(`${actualToday}T00:00:00.000Z`);
  historicalTarget.setUTCDate(historicalTarget.getUTCDate() - 1);
  const historicalDate = historicalTarget.toISOString().slice(0, 10);
  const originalQueryForHistorical = pool.query;
  let historicalQueryCount = 0;
  let historicalFetchCount = 0;
  try {
    pool.query = async () => { historicalQueryCount += 1; throw new Error('历史目标日不应读取当前快照'); };
    for (const mode of ['preopen', 'subscription_midday', 'subscription_close']) {
      const blocked = await hkIpo.runHkIpoSync(mode, 'acceptance', {
        targetDate: historicalDate,
        marketSignalOptions: { fetchImpl: async () => { historicalFetchCount += 1; return ''; } },
      });
      assert.strictEqual(blocked.status, 'blocked', `${mode} 历史实时信号必须阻断`);
      assert.strictEqual(blocked.reason, 'historical_target_unsupported');
      assert.strictEqual(blocked.dataAsOf, null, '阻断结果不得报告虚假的历史数据日');
      assert.deepStrictEqual(blocked.publishDatasetCodes, [], '阻断的历史槽位不得发布数据分区');
    }
    assert.strictEqual(historicalQueryCount, 0, '历史实时信号应在访问数据库前阻断');
    assert.strictEqual(historicalFetchCount, 0, '历史实时信号应在发出外部请求前阻断');
  } finally {
    pool.query = originalQueryForHistorical;
  }

  const historical = await hkRate.historicalRateResult('2026-09-25', async date => {
    requestedDates.push(date);
    return 0.91;
  });
  assert.deepStrictEqual(requestedDates, ['2026-09-25'], '历史汇率读取必须精确使用目标日');
  assert.deepStrictEqual(historical, {
    ok: true, status: 'historical', rate: 0.91, rateDate: '2026-09-25',
    dataAsOf: '2026-09-25', externalCalls: 0,
  });
  const missing = await hkRate.historicalRateResult('2026-09-24', async date => {
    requestedDates.push(date);
    return null;
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, 'historical_rate_missing');
  assert.strictEqual(missing.externalCalls, 0, '缺少历史汇率不得转成当前汇率外部抓取');

  for (const timeZone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    const child = spawnSync(process.execPath, ['-e', [
      "const c=require('./server/services/marketCycleMetrics');",
      `process.stdout.write(c.rangeCutoff('1y','${fixedInstant}'));`,
    ].join(' ')], { cwd: root, encoding: 'utf8', env: { ...process.env, TZ: timeZone } });
    assert.strictEqual(child.status, 0, `${timeZone} 日期范围子进程失败：${child.stderr}`);
    assert.strictEqual(child.stdout, '2025-09-28', `${timeZone} 的上海业务日图表起点错误`);
  }
  assert.strictEqual(CoreDate.todayInZone('Asia/Shanghai', fixedInstant), '2026-09-28');
  assert.strictEqual(cycleMetrics.rangeCutoff('1y', fixedInstant), '2025-09-28');
  assert.strictEqual(cycleMetrics.rangeCutoff('all', fixedInstant), null);

  const originalQuery = pool.query;
  let historyQuery;
  try {
    pool.query = async (sql, params) => {
      historyQuery = { sql, params };
      return { rows: [] };
    };
    await marketVolatility.getHistory('CN', 'CSI300', '1y');
  } finally {
    pool.query = originalQuery;
  }
  assert.match(historyQuery.sql, /trade_date >= \$3::date/);
  assert.ok(!/CURRENT_DATE\s*-/.test(historyQuery.sql), '格雷厄姆历史范围不得依赖数据库会话日期');
  assert.strictEqual(historyQuery.params[2], cycleMetrics.rangeCutoff('1y'));

  const stockJob = read('server/jobs/stockAnalysisRefresh.js');
  assert.match(stockJob, /lastSuccessDate: dataAsOf/);
  assert.match(stockJob, /historical_target_unsupported/);
  assert.match(stockJob, /latest_market_trade_date/);
  assert.match(read('server/services/jobRunners.js'), /targetDate: context\.targetDate \|\| businessDate/);
  const ipoJob = read('server/jobs/hkIpoSync.js');
  assert.match(ipoJob, /dataAsOf: targetDate/);
  assert.ok(!/dataAsOf:\s*new Date\(\)\.toISOString\(\)/.test(ipoJob));
  assert.match(read('server/services/jobScheduleSlots.js'), /hk_rate: `SELECT max\(rate_date\)::text AS data_as_of/);
  assert.match(read('server/services/financialDataArchitecture.js'), /market: \{ trade_date: asDate\(analysis\.latest_market_trade_date\),/);
  assert.match(read('server/jobs/hkRate.js'), /stateDate < today[\s\S]*historicalRateResult\(stateDate\)/);
  assert.match(read('server/services/jobRunners.js'), /runHkIpoSync\('postclose', reason, \{ \.\.\.context, targetDate: context\.targetDate \|\| businessDate \}\)/);
  assert.match(read('server/routes/marketVolatility.js'), /rangeCutoff\s*\|\|\s*'all'/,
    '首页周期缓存版本必须包含当前日期范围截止日');

  console.log('R3 日期边界测试通过：T07/T08/T09 目标日、T13 上海截点、跨时区及缓存/查询口径。');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
