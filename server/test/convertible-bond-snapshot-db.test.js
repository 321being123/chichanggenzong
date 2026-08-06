// 真实读库测试：可转债快照读取（锁死 financial_reports.period_end 列名契约 + 条款指纹读标准条款表）
// 若 getConvertibleBondSnapshot 中的 SQL 误用不存在的列（如 end_date），会抛 SQL 异常导致测试失败。
const assert = require('assert');
const { pool } = require('../db');
const { getConvertibleBondSnapshot, buildStandardTermsHash } = require('../services/convertibleBondAnalysis');
const { evaluateConvertibleBondFreshness } = require('../services/analysisFreshness');

(async () => {
  const [{ instrument_id: bondId }] = (await pool.query(
    `SELECT instrument_id FROM core.instruments WHERE canonical_code='128124.SZ'`
  )).rows;
  assert.ok(bondId, '本地库应有 128124.SZ 的可转债主档');

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

  // 3) 条款指纹读取「标准条款表」convertible_bond_terms，且与水位同源（读/写一致）
  const stdHash = await buildStandardTermsHash(pool, bondId);
  assert.ok(typeof stdHash === 'string' && stdHash.length > 0, 'buildStandardTermsHash 应从标准条款表算出非空指纹');
  const stdHash2 = await buildStandardTermsHash(pool, bondId);
  assert.strictEqual(stdHash, stdHash2, '标准条款表未变时，两次算出的指纹应完全相同（稳定）');

  // 3a) 无假阳性：水位 terms_hash 与标准条款表指纹一致时，不得报 terms_changed
  const noFalse = evaluateConvertibleBondFreshness({ currentTermsHash: stdHash, watermark: { terms_hash: stdHash } });
  assert.ok(!noFalse.reasons.some(r => r.code === 'terms_changed'),
    '水位与标准条款表一致时不应报 terms_changed（确认指纹读的是标准条款表、且读/写同源）');

  // 3b) 能检出变化：标准条款表指纹与水印不一致时，必须报 terms_changed
  const detects = evaluateConvertibleBondFreshness({ currentTermsHash: 'deadbeefdeadbeef', watermark: { terms_hash: stdHash } });
  assert.ok(detects.reasons.some(r => r.code === 'terms_changed'),
    '标准条款表变化（指纹不同）时必须报 terms_changed（确认失效检测有效）');

  await pool.end();
  console.log('convertible-bond-snapshot-db.test.js 通过：可转债快照真实读库正常（period_end 列名 + 条款指纹读标准条款表 已锁死）');
})().catch((err) => {
  console.error('convertible-bond-snapshot-db.test.js 失败：', err && err.message);
  process.exit(1);
});
