'use strict';
// 外币→人民币汇率（港股外币记账公司折算用）：时区归日与落库隔离专项测试。
//
// 为什么要有这个文件：
//   1) 官方接口返回的 `date` 是 UTC 时刻（实测 2026-11-18T16:00Z 实际是北京 11-19），
//      按 UTC 直接取日期会把整批汇率错一天，进而让「目标日汇率」取到错误的前一天值；
//   2) market.fx_rates 上同时躺著 HKD→CNY（账户估值在用）和新增的外币对，
//      upsert 一旦写错币种键，会污染账户估值口径，必须用真实 PG 验证只动目标币种对。
// 纯函数部分不连库；落库部分全部在同一事务内 ROLLBACK，不写业务数据。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { pool } = require('../db/connection');
const fxRateRepository = require('../repositories/fxRateRepository');
const { normalizeFxRow, rateInRange } = require('../services/fxForeignRate');

const SOURCE_CODE = 'lixinger_official';

async function sourceIdOf(client) {
  const { rows } = await client.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1', [SOURCE_CODE]);
  if (!rows.length) throw new Error(`数据源 ${SOURCE_CODE} 未登记，测试无法进行`);
  return rows[0].source_id;
}

(async () => {
  // ---- 1. 时区归日 ----
  // 官方返回 UTC 16:00Z，即北京时间次日 00:00，业务日期必须归到北京时间的次日。
  const normalized = normalizeFxRow({ date: '2026-11-18T16:00:00.000Z', close: 6.666666666666667 }, 'USD');
  assert.ok(normalized, '合法汇率行必须被采纳');
  assert.strictEqual(normalized.rateDate, '2026-11-19', 'UTC 16:00Z 必须归到北京时间次日');
  assert.strictEqual(normalized.rate, 6.666666666666667, '汇率值必须原样保留');

  // 北京时间白天时刻仍归当日，跨日边界不能误推一天。
  const sameDay = normalizeFxRow({ date: '2026-11-19T02:00:00.000Z', close: 6.66 }, 'USD');
  assert.strictEqual(sameDay.rateDate, '2026-11-19', '北京 10:00 必须仍是当日');

  // ---- 2. 区间校验（拒绝脏数据） ----
  assert.strictEqual(normalizeFxRow({ date: '2026-11-18T16:00:00.000Z', close: 0.001 }, 'USD'), null,
    '美元兑人民币 0.001 属脏数据必须拒绝');
  assert.strictEqual(normalizeFxRow({ date: '2026-11-18T16:00:00.000Z', close: 700 }, 'USD'), null,
    '美元兑人民币 700 属脏数据必须拒绝');
  assert.strictEqual(normalizeFxRow({ date: '2026-11-18T16:00:00.000Z', close: 'abc' }, 'USD'), null,
    '非数字汇率必须拒绝');
  assert.strictEqual(normalizeFxRow(null, 'USD'), null, '空行必须拒绝');
  assert.strictEqual(normalizeFxRow({ date: 'not-a-date', close: 6.6 }, 'USD'), null, '非法日期必须拒绝');
  assert.ok(rateInRange('USD', 6.67) && !rateInRange('USD', 0.86), '美元区间不能与港币区间混用');
  assert.ok(rateInRange('HKD', 0.86) && !rateInRange('HKD', 6.67), '港币区间不能与美元区间混用');

  // ---- 3. 真实 PG：写入与读取只作用于目标币种对 ----
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sourceId = await sourceIdOf(client);
    const HK_DATE = '2099-01-05';
    const USD_DATE = '2099-01-02';

    // 造一条港币行当「对照组」，确认后续美元写入不会碰它。
    await fxRateRepository.upsertRatePair(
      { baseCurrency: 'HKD', quoteCurrency: 'CNY', rateDate: HK_DATE, sourceId, rate: 0.8675 }, client);
    const hkBefore = await client.query(
      `SELECT rate::float8 AS rate FROM market.fx_rates
        WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date=$1`, [HK_DATE]);
    assert.strictEqual(hkBefore.rows.length, 1, '对照组港币行必须写入成功');

    // 美元行写入
    await fxRateRepository.upsertRatePair(
      { baseCurrency: 'USD', quoteCurrency: 'CNY', rateDate: USD_DATE, sourceId, rate: 6.66 }, client);

    // 「不晚于目标日取最近一条」：目标日 2099-01-05 应取 2099-01-02 那条
    const picked = await fxRateRepository.readLatestRatePairUpTo(
      { baseCurrency: 'USD', quoteCurrency: 'CNY', date: '2099-01-05' }, client);
    assert.ok(picked, '必须能取到美元汇率');
    assert.strictEqual(picked.rate_date, USD_DATE, '必须取不晚于目标日的最近一条');
    assert.ok(Math.abs(picked.rate - 6.66) < 1e-9, '取回的汇率值必须一致');

    // 早于全部数据的目标日取不到（不能拿未来数据回填历史）
    const tooEarly = await fxRateRepository.readLatestRatePairUpTo(
      { baseCurrency: 'USD', quoteCurrency: 'CNY', date: '2098-12-31' }, client);
    assert.strictEqual(tooEarly, null, '目标日早于全部汇率时必须取不到，不得使用未来值');

    // 幂等：同一 (币种对, 日期) 重复写入只更新，不新增行
    await fxRateRepository.upsertRatePair(
      { baseCurrency: 'USD', quoteCurrency: 'CNY', rateDate: USD_DATE, sourceId, rate: 6.71 }, client);
    const countRows = await client.query(
      `SELECT count(*)::int AS c FROM market.fx_rates
        WHERE base_currency='USD' AND quote_currency='CNY' AND rate_date=$1`, [USD_DATE]);
    assert.strictEqual(countRows.rows[0].c, 1, '同一币种对同一天只能一行（幂等 upsert）');
    const updated = await fxRateRepository.readLatestRatePairUpTo(
      { baseCurrency: 'USD', quoteCurrency: 'CNY', date: '2099-01-05' }, client);
    assert.ok(Math.abs(updated.rate - 6.71) < 1e-9, '重复写入必须更新为最新值');

    // 对照组未被牵连：港币行数量与取值都没变
    const hkAfter = await client.query(
      `SELECT rate::float8 AS rate FROM market.fx_rates
        WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date=$1`, [HK_DATE]);
    assert.strictEqual(hkAfter.rows.length, 1, '美元写入不能影响港币行');
    assert.ok(Math.abs(hkAfter.rows[0].rate - 0.8675) < 1e-9, '港币行取值不能被美元写入改动');

    console.log('外币汇率：UTC→北京归日、脏数据拒绝、最近可用取值、幂等写入、港币行隔离 全部通过');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
})().catch(async error => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
