const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { pool, runMigrations } = require('../db');
const { persistSnapshot, syncHkIpoMarketSignals } = require('../services/hkIpoMarketSignals');

const syncCode = '09995.HK';
const syncDate = '2099-12-30';

(async () => {
  await runMigrations();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const base = {
      code: '09996.HK', sourceCode: 'test-p0', signalType: 'subscription', signalKind: 'margin_estimate',
      dataDate: '2026-09-20', subscriptionMultiple: 12.50004, marginAmountHkd: 100000000,
      sourceObservedAt: '2026-09-20T10:00:00+08:00', rawPayload: { signal_kind: 'margin_estimate' },
    };
    await persistSnapshot(base, client);
    await persistSnapshot({ ...base, subscriptionMultiple: 13.5, sourceObservedAt: '2026-09-20T12:00:00+08:00' }, client);
    await persistSnapshot({
      ...base, code: '09997.HK', subscriptionMultiple: null, marginAmountHkd: 200000000,
      marginMultiple: 3.2, sourceObservedAt: '2026-09-20T13:00:00+08:00',
    }, client);
    await persistSnapshot(base, client);
    const result = await client.query(`
      SELECT COUNT(*)::int AS row_count,
             COUNT(DISTINCT source_record_hash)::int AS hash_count,
             COUNT(*) FILTER (WHERE margin_multiple=12.50004)::int AS first_value_count,
             COUNT(*) FILTER (WHERE margin_multiple=3.2)::int AS margin_only_count,
             COUNT(*) FILTER (WHERE quality_status='valid')::int AS valid_count
        FROM analytics.hk_ipo_market_snapshots
       WHERE source_code='test-p0'
    `);
    const row = result.rows[0];
    assert.strictEqual(row.row_count, 3, '同日不同信号及新孖展字段必须保存');
    assert.strictEqual(row.hash_count, 3, '不同规范化内容必须生成不同哈希');
    assert.strictEqual(row.first_value_count, 1, '同内容重复采集不得重复插入');
    assert.strictEqual(row.margin_only_count, 1, '仅有孖展金额/倍数也不得被静默丢弃');
    assert.strictEqual(row.valid_count, 3, '新快照质量状态必须为 valid');
    await client.query('ROLLBACK');
    console.log('hk-ipo-snapshot-persistence.test.js direct persistence passed');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  try {
    await pool.query(`
      INSERT INTO public.ipo_history(security_code,market_code,ipo_status,offer_open_at,offer_close_at)
      VALUES($1,'HK','active','2026-09-19T00:00:00+08:00','2099-12-31T23:59:59+08:00')
      ON CONFLICT (security_code) DO UPDATE SET market_code='HK',ipo_status='active',
        offer_open_at=EXCLUDED.offer_open_at,offer_close_at=EXCLUDED.offer_close_at
    `, [syncCode]);

    let multiple = 12.5;
    const fetchImpl = async url => {
      if (url.includes('get-h5-ipo-setting')) {
        return {
          data: {
            fields: ['stock_code', 'stock_name', 'over_subscribed_multiple', 'expiration_date', 'update_at'],
            list: [[syncCode.slice(0, 5), '测试信号', multiple, '2099-12-31', '2026-09-20 10:00:00']],
          },
        };
      }
      return { data: { fields: [], list: [] } };
    };
    const guardImpl = async (_source, _dataset, _businessDate, request) => request();

    const first = await syncHkIpoMarketSignals({ mode: 'preopen', businessDate: syncDate, fetchImpl, guardImpl, sourcesAdmitted: true });
    assert.strictEqual(first.subscription.saved, 1, '真实同步路径首次应写入一条申购快照');
    multiple = 13.5;
    const second = await syncHkIpoMarketSignals({ mode: 'preopen', businessDate: syncDate, fetchImpl, guardImpl, sourcesAdmitted: true });
    assert.strictEqual(second.subscription.saved, 1, '真实同步路径第二次应写入变化后的快照');
    const before = await pool.query(`
      SELECT last_seen_at FROM analytics.hk_ipo_market_snapshots
       WHERE security_code=$1 AND source_code='livermore' AND data_date=$2::date
         AND margin_multiple=13.5
    `, [syncCode, syncDate]);
    assert.strictEqual(before.rowCount, 1, '第二个时点快照应存在');
    await pool.query('SELECT pg_sleep(0.01)');
    const third = await syncHkIpoMarketSignals({ mode: 'preopen', businessDate: syncDate, fetchImpl, guardImpl, sourcesAdmitted: true });
    assert.strictEqual(third.subscription.saved, 1, '相同内容重采集应命中幂等更新');
    const after = await pool.query(`
      SELECT COUNT(*)::int AS row_count,
             MAX(last_seen_at) FILTER (WHERE margin_multiple=13.5) AS last_seen_at
        FROM analytics.hk_ipo_market_snapshots
       WHERE security_code=$1 AND source_code='livermore' AND data_date=$2::date
    `, [syncCode, syncDate]);
    assert.strictEqual(after.rows[0].row_count, 2, '同日两个不同值必须保留两条');
    assert.ok(new Date(after.rows[0].last_seen_at) > new Date(before.rows[0].last_seen_at), '相同内容必须更新 last_seen_at');
    console.log('hk-ipo-snapshot-persistence.test.js sync path passed');
  } finally {
    await pool.query('DELETE FROM analytics.hk_ipo_market_snapshots WHERE security_code=$1', [syncCode]);
    await pool.query('DELETE FROM public.ipo_history WHERE security_code=$1', [syncCode]);
    await pool.query(`
      DELETE FROM ops.raw_records r USING ops.data_sources ds
       WHERE r.source_id=ds.source_id AND ds.source_code='livermore'
         AND r.source_key IN ($1,$2)
    `, [syncDate, syncDate.slice(0, 4)]);
  }
  await pool.end();
  console.log('hk-ipo-snapshot-persistence.test.js passed');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
