// 一次性回填：标准主档缺失的正股关联补齐（幂等）。
// 迁移 058 后只基于标准主档和标准原始留痕补正股关联。
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { pool } = require('../db');

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      UPDATE fundamental.convertible_bond_profiles p
         SET stock_instrument_id=s.instrument_id,updated_at=now()
        FROM core.instruments b
        JOIN core.instruments s ON s.canonical_code = CASE
          WHEN COALESCE(NULLIF(p.raw_payload->>'stk_code',''), NULLIF(p.raw_payload->'cb_basic'->>'stk_code','')) LIKE '%.%'
            THEN COALESCE(NULLIF(p.raw_payload->>'stk_code',''), NULLIF(p.raw_payload->'cb_basic'->>'stk_code',''))
          WHEN COALESCE(NULLIF(p.raw_payload->>'stk_code',''), NULLIF(p.raw_payload->'cb_basic'->>'stk_code','')) ~ '^(0|3)'
            THEN COALESCE(NULLIF(p.raw_payload->>'stk_code',''), NULLIF(p.raw_payload->'cb_basic'->>'stk_code','')) || '.SZ'
          ELSE COALESCE(NULLIF(p.raw_payload->>'stk_code',''), NULLIF(p.raw_payload->'cb_basic'->>'stk_code','')) || '.SH'
        END
       WHERE p.instrument_id=b.instrument_id AND b.asset_class='convertible_bond'
         AND p.stock_instrument_id IS NULL
      RETURNING p.instrument_id
    `);
    const n = result.rowCount;
    await client.query('COMMIT');
    console.log(`回填完成：补齐 ${n} 只可转债的主档/正股关联（幂等，可重复执行）`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('回填失败:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
