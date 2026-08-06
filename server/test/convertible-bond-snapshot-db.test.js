// 真实读库测试：可转债快照读取（锁死 financial_reports.period_end 列名契约）
// 若 getConvertibleBondSnapshot 中的 SQL 误用不存在的列（如 end_date），会抛 SQL 异常导致测试失败。
const assert = require('assert');
const { pool } = require('../db');
const { getConvertibleBondSnapshot } = require('../services/convertibleBondAnalysis');

(async () => {
  // 1) 直接调用快照函数：本地库已有 128124.SZ / 113625.SH 的可转债分析快照
  const snap = await getConvertibleBondSnapshot('128124.SZ');
  assert.ok(snap && typeof snap === 'object', 'getConvertibleBondSnapshot 应返回快照对象而非抛错');
  assert.ok(snap.freshness && typeof snap.freshness === 'object', '快照应带 freshness 新鲜度判定结果');
  assert.ok('needs_refresh' in snap, '快照应含 needs_refresh 字段');

  // 2) 直接验证 fundamental.financial_reports 的真实列名是 period_end（不是 end_date）
  const probe = await pool.query(
    `SELECT max(period_end) AS pe FROM fundamental.financial_reports fr
       JOIN core.company_instruments ci ON ci.company_id=fr.company_id
       WHERE ci.instrument_id=$1`,
    [42]
  );
  assert.ok(probe.rows[0].pe, 'fundamental.financial_reports 应存在 period_end 列并可读到日期');

  // 反证：end_date 在该表不存在，子查询不得引用它（仅断言列存在性，避免误改后回退）
  let endColExists = true;
  try {
    await pool.query('SELECT end_date FROM fundamental.financial_reports LIMIT 0');
  } catch (_) {
    endColExists = false;
  }
  assert.ok(!endColExists, 'fundamental.financial_reports 不应存在 end_date 列（确认修复点正确）');

  // 3) 条款指纹必须基于「数据库当前条款」重算：本地快照的数据库条款与水位一致，不得误报 terms_changed
  assert.ok(Array.isArray(snap.freshness.reasons), '新鲜度应含 reasons 数组');
  const termsChanged = snap.freshness.reasons.filter(r => r.code === 'terms_changed');
  assert.ok(termsChanged.length === 0,
    '数据库当前条款与快照水位一致时不应报 terms_changed（确认条款指纹读取的是数据库条款而非快照自身 payload）');

  await pool.end();
  console.log('convertible-bond-snapshot-db.test.js 通过：可转债快照真实读库正常（period_end 列名契约 + 条款指纹读数据库条款 已锁死）');
})().catch((err) => {
  console.error('convertible-bond-snapshot-db.test.js 失败：', err && err.message);
  process.exit(1);
});
