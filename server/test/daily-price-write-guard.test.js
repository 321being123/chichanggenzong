// 日价条件写入保护回归（2026-11-15 第二轮验收：已确认收盘价不得被较旧同级报价覆盖）
// 直接对隔离库验证仓储层的条件写入与幂等语义，不经过任务与页面。
const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../db/connection');
const priceRepository = require('../repositories/effectivePriceRepository');

const USER = 'daily_price_guard';
const ACCOUNT = '日价写保护账户';
const DATE = '2026-11-13';

function row({ price, quality, quoteAt, isFinal }) {
  return [{
    username: USER,
    accountName: ACCOUNT,
    accountId: ACCOUNT_ID,
    date: DATE,
    code: '600000',
    name: '测试证券',
    price,
    source: 'test_close_task',
    quoteAt,
    isFinal,
    quality,
    evidence: {},
  }];
}

let ACCOUNT_ID = null;

async function cleanup() {
  await pool.query('DELETE FROM daily_prices WHERE username=$1', [USER]);
  await pool.query('DELETE FROM account_data WHERE username=$1', [USER]);
  await pool.query('DELETE FROM accounts WHERE username=$1', [USER]);
  await pool.query('DELETE FROM users WHERE username=$1', [USER]);
}

async function main() {
  await cleanup();
  ACCOUNT_ID = crypto.createHash('sha256').update(USER + '\n' + ACCOUNT).digest('hex');
  await pool.query(
    `INSERT INTO users (username,password,accounts,role,status) VALUES ($1,'x',$2,'user','active')`,
    [USER, JSON.stringify([ACCOUNT])]
  );
  await pool.query(
    `INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at)
     VALUES ($1,$2,$3,0,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,
    [ACCOUNT_ID, USER, ACCOUNT]
  );

  // 1. 首次写入已确认终盘价。
  const first = await priceRepository.upsertDailyPrice(row({
    price: 10, quality: 'confirmed', quoteAt: `${DATE}T15:00:00+08:00`, isFinal: true,
  }));
  assert.strictEqual(first.rowCount, 1, '首次写入应成功');
  assert.strictEqual(first.rows[0].revision, 1);

  // 2. 较低资格（候选）不得覆盖已确认终盘价。
  const candidate = await priceRepository.upsertDailyPrice(row({
    price: 11, quality: 'candidate', quoteAt: `${DATE}T15:00:00+08:00`, isFinal: null,
  }));
  assert.strictEqual(candidate.rowCount, 0, '候选价不得覆盖已确认收盘价');

  // 3. 完全相同（同价同源时刻）视为幂等重复，不更新也不递增 revision。
  const identical = await priceRepository.upsertDailyPrice(row({
    price: 10, quality: 'confirmed', quoteAt: `${DATE}T15:00:00+08:00`, isFinal: true,
  }));
  assert.strictEqual(identical.rowCount, 0, '同价同源时刻的重复写入必须幂等跳过');

  // 4. 来源时刻更新的同级更正允许写入，并保留原值、递增修订号。
  const newer = await priceRepository.upsertDailyPrice(row({
    price: 10.5, quality: 'confirmed', quoteAt: `${DATE}T15:10:00+08:00`, isFinal: true,
  }));
  assert.strictEqual(newer.rowCount, 1, '更晚的已确认报价应允许更正');
  assert.strictEqual(newer.rows[0].revision, 2);
  const stored = (await pool.query(
    'SELECT price::float8 AS price, previous_price::float8 AS previous_price, quote_at FROM daily_prices WHERE username=$1 AND code=$2 AND date=$3',
    [USER, '600000', DATE]
  )).rows[0];
  assert.strictEqual(Number(stored.price), 10.5);
  assert.strictEqual(Number(stored.previous_price), 10, '被更正的旧价必须保留为 previous_price');

  // 5. 迟到的旧终盘（来源时刻更早、价格不同）不得覆盖更新修订。
  const late = await priceRepository.upsertDailyPrice(row({
    price: 9.9, quality: 'confirmed', quoteAt: `${DATE}T15:05:00+08:00`, isFinal: true,
  }));
  assert.strictEqual(late.rowCount, 0, '迟到的旧终盘不得覆盖更新的已确认价');
  const afterLate = (await pool.query(
    'SELECT price::float8 AS price FROM daily_prices WHERE username=$1 AND code=$2 AND date=$3',
    [USER, '600000', DATE]
  )).rows[0];
  assert.strictEqual(Number(afterLate.price), 10.5, '价格必须保持在更新的修订上');

  console.log('日价条件写入保护回归通过');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原结论 */ }
    await pool.end().catch(() => {});
  });
