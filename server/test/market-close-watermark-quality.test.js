// HOLDINGS-CLOSE-WATERMARK-012：收盘水位只接受同账户、同市场、同证券的已确认终盘价。
// 临时表限定查询范围，测试真实 PostgreSQL，事务回滚且不碰现有业务行。
const assert = require('assert');
const { pool } = require('../db/connection');
const repo = require('../repositories/jobScheduleSlotsRepository');
const { queryDataAsOf } = require('../services/jobScheduleSlots');

(async () => {
  const client = await pool.connect();
  const original = repo.selectDataAsOfDate;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE positions (id text, username text, account_name text, code text, name text, subtype text) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE daily_prices (username text, account_name text, date date, code text, market text, quality text, is_final boolean) ON COMMIT DROP`);
    repo.selectDataAsOfDate = async (sql, params) => (await client.query(sql, params)).rows;
    const date = '2026-11-16';
    const fresh = `${date}T00:00:00.000Z`;
    const jobs = [
      ['market_close:A股', '600001', '', 'CN'],
      ['market_close:可转债', '113627', '', 'CN'],
      ['market_close:LOF/ETF', '510310', '', 'CN'],
      ['market_close:港股', '000001', '港股', 'HK'],
    ];
    for (const [job, code, subtype, market] of jobs) {
      await client.query('TRUNCATE positions, daily_prices');
      await client.query('INSERT INTO positions VALUES ($1,$2,$3,$4,$5,$6)', ['p', 'u', 'a', code, 'test', subtype]);
      const priceCode = market === 'HK' ? '00001' : code;
      const insert = async (user, acct, mkt, quality, final) => client.query(
        'INSERT INTO daily_prices VALUES ($1,$2,$3,$4,$5,$6,$7)', [user, acct, date, priceCode, mkt, quality, final]);
      assert.strictEqual(await queryDataAsOf(job, date), null, `${job}: 缺价不能算新鲜`);
      await insert('u', 'a', market, 'candidate', null);
      assert.strictEqual(await queryDataAsOf(job, date), null, `${job}: 候选价不能算终盘`);
      await insert('u', 'a', market, 'confirmed', false);
      await insert('u', 'a', 'UNKNOWN', 'confirmed', true);
      await insert('other', 'a', market, 'confirmed', true);
      await insert('u', 'other', market, 'confirmed', true);
      assert.strictEqual(await queryDataAsOf(job, date), null, `${job}: 未终盘、未知市场及其他账户不能代替`);
      await insert('u', 'a', market, 'confirmed', true);
      assert.strictEqual(await queryDataAsOf(job, date), fresh, `${job}: 同身份确认价应可判新鲜`);
      await client.query('INSERT INTO positions VALUES ($1,$2,$3,$4,$5,$6)', ['p2', 'u', 'b', code, 'test', subtype]);
      assert.strictEqual(await queryDataAsOf(job, date), null, `${job}: 另一个账户缺价不能被掩盖`);
    }
    console.log('market close watermark quality: 4 markets passed');
  } finally {
    repo.selectDataAsOfDate = original;
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
