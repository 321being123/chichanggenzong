// 日价条件写入保护回归（2026-11-15 第二轮验收：已确认收盘价不得被较旧同级报价覆盖）
// 直接对隔离库验证仓储层的条件写入与幂等语义，不经过任务与页面。
const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../db/connection');
const priceRepository = require('../repositories/effectivePriceRepository');

const USER = 'daily_price_guard';
const ACCOUNT = '日价写保护账户';
const DATE = '2026-11-13';

function row({ price, quality, quoteAt, isFinal, source = 'test_close_task' }) {
  return [{
    username: USER,
    accountName: ACCOUNT,
    accountId: ACCOUNT_ID,
    date: DATE,
    code: '600000',
    name: '测试证券',
    price,
    source,
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

  // 6. 不同来源但同一报价时刻：无法核验谁更新，不得互相覆盖（冲突留待人工核验）。
  const otherSource = await priceRepository.upsertDailyPrice(row({
    price: 12, quality: 'confirmed', quoteAt: `${DATE}T15:10:00+08:00`, isFinal: true, source: 'test_other_source',
  }));
  assert.strictEqual(otherSource.rowCount, 0, '不同来源在同一报价时刻不得覆盖已确认价');
  const keptSource = (await pool.query(
    'SELECT price::float8 AS price, source FROM daily_prices WHERE username=$1 AND code=$2 AND date=$3',
    [USER, '600000', DATE]
  )).rows[0];
  assert.strictEqual(Number(keptSource.price), 10.5, '价格必须保持原来源的修订值');
  assert.strictEqual(keptSource.source, 'test_close_task', '来源不得被无证据的写入替换');

  // 7. 缺失报价时刻的两条日线（例如旧日线接口）一律不得互相覆盖。
  const nullQuoteA = await priceRepository.upsertDailyPrice([{
    ...row({ price: 13, quality: 'confirmed', quoteAt: null, isFinal: true })[0],
    code: '600519',
  }]);
  assert.strictEqual(nullQuoteA.rowCount, 1, '首次无时刻写入可以落库');
  const nullQuoteB = await priceRepository.upsertDailyPrice([{
    ...row({ price: 14, quality: 'confirmed', quoteAt: null, isFinal: true })[0],
    code: '600519',
  }]);
  assert.strictEqual(nullQuoteB.rowCount, 0, '缺失报价时刻时不得反复改写正式收盘价');

  // 8. 共享日线（market.daily_bars）的价格一旦被改写，旧终盘证据必须同时失效：
  //    把"已核验的终盘价"留给后来那条没人核验过的价格，等于凭空造出一个假收盘价。
  const barCode = '689999.SH';
  const barDay = '2026-11-13';
  const barSource = 'tencent';
  await pool.query('DELETE FROM market.daily_bars WHERE instrument_id IN (SELECT instrument_id FROM core.instruments WHERE canonical_code=$1)', [barCode]);
  await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [barCode]);
  const barInstrument = (await pool.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market) VALUES($1,'日线证据测试股','stock','CN') RETURNING instrument_id`,
    [barCode],
  )).rows[0].instrument_id;
  const sourceId = (await pool.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1', [barSource])).rows[0].source_id;
  const readBar = async () => (await pool.query(
    'SELECT close::float8 AS close,bar_status,quality_status,price_adjust,bar_evidence FROM market.daily_bars WHERE instrument_id=$1 AND trade_date=$2::date AND source_id=$3',
    [barInstrument, barDay, sourceId],
  )).rows[0];

  // 收盘任务回写：价格与证据一起写，证据必须保留。
  await require('../repositories/marketCloseRepository').upsert_daily_bar_evidence(
    [barCode, barDay, 10, barSource, JSON.stringify({ verified_via: 'daily-price-write-guard' })],
  );
  const verified = await readBar();
  assert.strictEqual(verified.bar_status, 'terminal', '核验过的日线必须标为终盘');
  assert.strictEqual(verified.quality_status, 'passed');

  // 其它写入方（可转债/选股/港股覆盖等只更新 close 的路径）改价后必须降级证据。
  await pool.query(
    'UPDATE market.daily_bars SET close=$4, ingested_at=now() WHERE instrument_id=$1 AND trade_date=$2::date AND source_id=$3',
    [barInstrument, barDay, sourceId, 10.5],
  );
  const overwritten = await readBar();
  assert.strictEqual(overwritten.close, 10.5);
  assert.strictEqual(overwritten.bar_status, 'unknown', '价格被改写后旧终盘证据必须失效');
  assert.strictEqual(overwritten.quality_status, 'unknown', '价格被改写后旧质量结论必须失效');
  assert.strictEqual(overwritten.price_adjust, 'unknown', '价格被改写后旧口径必须失效');
  assert.strictEqual((overwritten.bar_evidence || {}).evidence_invalidated_by, 'price_changed',
    '失效必须留痕，便于事后判断这条价格有没有被核验过');

  // 价格没变时不动证据：同一数值重复落库不该把核验结论清零。
  await pool.query(
    'UPDATE market.daily_bars SET close=close, ingested_at=now() WHERE instrument_id=$1 AND trade_date=$2::date AND source_id=$3',
    [barInstrument, barDay, sourceId],
  );
  const unchanged = await readBar();
  assert.strictEqual(unchanged.bar_status, 'unknown', '已失效的证据不会因为"价格没变"而自行恢复');

  await pool.query('DELETE FROM market.daily_bars WHERE instrument_id=$1', [barInstrument]);
  await pool.query('DELETE FROM core.instruments WHERE instrument_id=$1', [barInstrument]);

  console.log('日价条件写入保护回归通过');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原结论 */ }
    await pool.end().catch(() => {});
  });
