// 端到端测试（真实读库）：快照生成后新增有效条款 -> 旧快照必须被判失效(terms_changed)
// 这是「以后条款更新后旧分析自动失效」的核心场景。
// 复现步骤：①建临时债券 + 早期条款；②写入一张「快照日期当时生效」的旧快照(水位=当时条款指纹)；
// ③在快照生成后新增一条更晚生效的修订条款；④读取快照，失效检查按今天重算指纹，应与水位不一致。
// 结束清理，不污染真实数据。
const assert = require('assert');
const { pool } = require('../db');
const { getConvertibleBondSnapshot, buildStandardTermsHash } = require('../services/convertibleBondAnalysis');

const TEST_CODE = '113998.SH'; // 有效格式且不与真实债券冲突（getConvertibleBondSnapshot 会经 normalizeBondCode 归一化）

(async () => {
  // 1) 建临时债券主档
  const ins = await pool.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,status)
     VALUES($1,'条款变更失效测试','convertible_bond','CN','SSE','listed') RETURNING instrument_id`,
    [TEST_CODE]
  );
  const instId = ins.rows[0].instrument_id;
  assert.ok(instId, '应成功创建临时债券主档');

  let threw = false;
  try {
    // 2) 早期条款（上市日生效）：call / put / reset 三类，均早于快照日期
    await pool.query(
      `INSERT INTO fundamental.convertible_bond_terms
       (instrument_id,term_type,effective_from,clause_text,source_id,source_key,raw_payload)
       VALUES($1,'call','2024-01-01','赎回条款V1',1,$2,'{}'::jsonb),
             ($1,'put','2024-01-01','回售条款V1',1,$3,'{}'::jsonb),
             ($1,'reset','2024-01-01','下修条款V1',1,$4,'{}'::jsonb)`,
      [instId, `${TEST_CODE}:call:2024`, `${TEST_CODE}:put:2024`, `${TEST_CODE}:reset:2024`]
    );

    // 3) 计算「快照日期(2026-01-01)当时生效」的条款哈希，作为旧快照水位
    const oldHash = await buildStandardTermsHash(pool, instId, '2026-01-01');
    assert.ok(typeof oldHash === 'string' && oldHash.length > 0, '应能算出快照日期当时生效的条款哈希');

    // 4) 写入一张 2026-01-01 的旧快照，水位 terms_hash 锁定为当时生效条款
    await pool.query(
      `INSERT INTO analytics.analysis_snapshots
       (instrument_id,as_of_date,snapshot_type,formula_bundle_version,payload,source_watermark)
       VALUES($1,'2026-01-01','convertible_bond_analysis','2026-01-01',$2::jsonb,$3::jsonb)`,
      [instId, JSON.stringify({ as_of: '2026-01-01' }), JSON.stringify({ terms_hash: oldHash })]
    );

    // 5) 关键：快照生成后，新增一条 2026-02-01 生效的修订 call 条款
    await pool.query(
      `INSERT INTO fundamental.convertible_bond_terms
       (instrument_id,term_type,effective_from,clause_text,source_id,source_key,raw_payload)
       VALUES($1,'call','2026-02-01','赎回条款V2(修订)',1,$2,'{}'::jsonb)`,
      [instId, `${TEST_CODE}:call:2026`]
    );

    // 6) 读取快照：失效检查按今天(晚于 2026-02-01)重算指纹，应命中 V2，
    //    与水位(2026-01-01 当时生效的 V1)不一致 -> 必须报 terms_changed
    const snap = await getConvertibleBondSnapshot(TEST_CODE);
    assert.ok(snap && snap.freshness, '应能读取到快照并带 freshness 判定');
    assert.ok(
      snap.freshness.reasons.some(r => r.code === 'terms_changed'),
      '快照生成后新增有效条款，旧快照必须被判 terms_changed 失效（核心场景）'
    );
    console.log('terms-changed-e2e.test.js 通过：快照生成后新增条款 -> 旧快照判失效');
  } catch (e) {
    threw = true;
    console.error('terms-changed-e2e.test.js 断言/执行失败：', e && e.message, '\n', e && e.stack);
    // 不在 finally 内 process.exit，避免吞掉上面的报错；交由外層 catch 退出
  } finally {
    // 7) 清理：删快照、条款、主档
    await pool.query('DELETE FROM analytics.analysis_snapshots WHERE instrument_id=$1', [instId]);
    await pool.query('DELETE FROM fundamental.convertible_bond_terms WHERE instrument_id=$1', [instId]);
    await pool.query('DELETE FROM core.instruments WHERE instrument_id=$1', [instId]);
    await pool.end();
  }
})().catch((err) => {
  console.error('terms-changed-e2e.test.js 失败：', err && err.message);
  process.exit(1);
});
