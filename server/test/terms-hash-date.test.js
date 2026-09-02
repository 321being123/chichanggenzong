// 真实读库测试：buildStandardTermsHash 必须按有效期选择「截至 asOf 当日生效」的条款，
// 而不是取最后写入的一行。可转债条款可能在存续期内修订，历史快照应锁定当时生效的条款。
// 本测试自建一个临时债券主档 + 两条不同 effective_from 的 reset 条款，验证按日期选择，
// 结束清理，不污染真实数据。
const assert = require('assert');
const { pool } = require('../db');
const { buildStandardTermsHash } = require('../services/convertibleBondAnalysis');

const TEST_CODE = '119999.SH'; // 不会与真实债券冲突

(async () => {
  // 1) 建临时债券主档
  const ins = await pool.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,status)
     VALUES($1,'条款有效期测试','convertible_bond','CN','SSE','listed') RETURNING instrument_id`,
    [TEST_CODE]
  );
  const instId = ins.rows[0].instrument_id;
  assert.ok(instId, '应成功创建临时债券主档');

  let threw = false;
  try {
    // 2) 同一 term_type 写入两条不同有效期的条款：早期条款(A) 与 2025 年起生效的修订条款(B)
    await pool.query(
      `INSERT INTO fundamental.convertible_bond_terms
       (instrument_id,term_type,effective_from,clause_text,source_id,source_key,raw_payload)
       VALUES($1,'reset','2020-01-01','早期修正条款A',1,$2,'{}'::jsonb),
             ($1,'reset','2025-01-01','修订后修正条款B',1,$3,'{}'::jsonb)`,
      [instId, `${TEST_CODE}:reset:2020`, `${TEST_CODE}:reset:2025`]
    );

    // 3) 在 2020 条款生效期内（2021）应取到 A；在 2025 修订生效后（2026）应取到 B
    const hEarly = await buildStandardTermsHash(pool, instId, '2021-06-01');
    const hLate = await buildStandardTermsHash(pool, instId, '2026-06-01');
    assert.ok(typeof hEarly === 'string' && hEarly.length > 0, '早期日期应算出非空指纹');
    assert.ok(typeof hLate === 'string' && hLate.length > 0, '晚期日期应算出非空指纹');
    assert.notStrictEqual(hEarly, hLate, '不同生效期内取到不同条款，指纹应不同（确认按有效期选择）');

    // 4) 早于任何条款生效期（2019）应取不到 reset 条款，指纹与 2021 不同（确认 effective_from 过滤生效）
    const hBefore = await buildStandardTermsHash(pool, instId, '2019-06-01');
    assert.notStrictEqual(hBefore, hEarly, '早于全部条款生效期时不应命中任何 reset 条款，指纹应不同于 2021');

    // 5) 不传 asOf 时取今天，应命中 2025 修订条款（与 2026 一致）
    const hToday = await buildStandardTermsHash(pool, instId);
    assert.strictEqual(hToday, hLate, '不传 asOf 默认今天，应命中 2025 修订条款（与 2026 一致）');

    console.log('terms-hash-date.test.js 通过：buildStandardTermsHash 已按有效期选择生效条款');
  } catch (e) {
    threw = true;
    throw e;
  } finally {
    // 6) 清理：删条款与主档，恢复真实数据状态
    await pool.query('DELETE FROM fundamental.convertible_bond_terms WHERE instrument_id=$1', [instId]);
    await pool.query('DELETE FROM core.instruments WHERE instrument_id=$1', [instId]);
    await pool.end();
    if (threw) process.exit(1);
  }
})().catch((err) => {
  console.error('terms-hash-date.test.js 失败：', err && err.message);
  process.exit(1);
});
