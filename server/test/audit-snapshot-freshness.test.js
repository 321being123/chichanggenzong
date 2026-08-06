// 真实读库测试：审计脚本只扫描每只证券的最新快照（不再全历史口径）
const assert = require('assert');
const { runAudit } = require('../scripts/auditSnapshotFreshness');
const { pool } = require('../db/connection');

(async () => {
  const r = await runAudit();
  assert.ok(Array.isArray(r.cbConv), 'runAudit 应返回可转债转股价错配列表');
  assert.ok(Array.isArray(r.cbProf), 'runAudit 应返回可转债主档更新列表');
  assert.ok(Array.isArray(r.cbMkt), 'runAudit 应返回可转债行情更新列表');
  assert.ok(typeof r.stockLegacy === 'number', 'runAudit 应返回股票 legacy 水位数量');

  // 每只证券最多一条：证明已按最新快照去重，而非全历史扫描
  const dup = (rows, key) => {
    const seen = new Set();
    for (const x of rows) {
      if (seen.has(x[key])) return true;
      seen.add(x[key]);
    }
    return false;
  };
  assert.ok(!dup(r.cbConv, 'canonical_code'), '可转债转股价错配不应出现同一证券多行（已取最新快照）');
  assert.ok(!dup(r.cbProf, 'canonical_code'), '可转债主档更新不应出现同一证券多行（已取最新快照）');
  assert.ok(!dup(r.cbMkt, 'canonical_code'), '可转债行情更新不应出现同一证券多行（已取最新快照）');

  await pool.end();
  console.log('audit-snapshot-freshness.test.js 通过：审计脚本仅统计每只证券最新快照（无重复证券行）');
})().catch((err) => {
  console.error('audit-snapshot-freshness.test.js 失败：', err && err.message);
  process.exit(1);
});
