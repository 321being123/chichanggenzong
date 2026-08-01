// 一次性回填：bond_history → core.instruments + convertible_bond_profiles 正股关联补齐（幂等）
// 用法：node server/scripts/backfillBondUnifiedLinks.js
// 说明：只处理「债券主档不存在」或「缺正股关联（bond_history 有 stk_code 但 profile 未关联）」的债券，
//       upsertBondBaseInfo 内部 ON CONFLICT + COALESCE，重复执行不新增重复证券、不覆盖更完整数据。
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { pool } = require('../db');
const { bootstrapBondsFromHistory } = require('../services/convertibleBondAnalysis');

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT source_code, source_id FROM ops.data_sources');
    const sources = Object.fromEntries(rows.map(r => [r.source_code, r.source_id]));
    const n = await bootstrapBondsFromHistory(client, sources);
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
