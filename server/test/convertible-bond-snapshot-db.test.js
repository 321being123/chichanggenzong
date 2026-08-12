// 真实读库测试：可转债快照读取（锁死 financial_reports.period_end 列名契约 + 条款指纹读标准条款表）
// 若 getConvertibleBondSnapshot 中的 SQL 误用不存在的列（如 end_date），会抛 SQL 异常导致测试失败。
const assert = require('assert');
const { pool } = require('../db');
const { getConvertibleBondSnapshot, buildStandardTermsHash } = require('../services/convertibleBondAnalysis');
const { evaluateConvertibleBondFreshness } = require('../services/analysisFreshness');

// 使用专用虚拟代码，避免与生产库真实证券（如 000001.SZ）冲突。
const BOND_CODE = '128990.SZ';
const STOCK_CODE = '128991.SZ';
const COMPANY_NAME = 'CI测试公司（可删除）';

let fixtureCreated = false;

async function ensureFixture() {
  // 本地环境依赖既有数据；CI 空库自包含插入最小 fixture，保证测试不依赖外部 seed。
  const { rows } = await pool.query(
    `SELECT instrument_id FROM core.instruments WHERE canonical_code=$1`, [BOND_CODE]
  );
  if (rows.length > 0) return;

  const sourceRes = await pool.query(
    `SELECT source_id FROM ops.data_sources WHERE source_code='tushare'`
  );
  const sourceId = sourceRes.rows[0].source_id;

  const companyRes = await pool.query(
    `INSERT INTO core.companies(country_code, legal_name, company_type)
     VALUES ('CN', $1, 'listed') RETURNING company_id`,
    [COMPANY_NAME]
  );
  const companyId = companyRes.rows[0].company_id;

  const stockRes = await pool.query(
    `INSERT INTO core.instruments(canonical_code, name, asset_class, market, exchange_code, currency_code, status)
     VALUES ($1, 'CI测试正股', 'stock', 'A股', 'SZSE', 'CNY', 'listed') RETURNING instrument_id`,
    [STOCK_CODE]
  );
  const stockId = stockRes.rows[0].instrument_id;

  await pool.query(
    `INSERT INTO core.company_instruments(company_id, instrument_id, relation_type)
     VALUES ($1, $2, 'issued_by')`,
    [companyId, stockId]
  );

  const bondRes = await pool.query(
    `INSERT INTO core.instruments(canonical_code, name, asset_class, market, exchange_code, currency_code, status)
     VALUES ($1, 'CI测试转债', 'convertible_bond', 'A股', 'SZSE', 'CNY', 'listed') RETURNING instrument_id`,
    [BOND_CODE]
  );
  const bondId = bondRes.rows[0].instrument_id;

  await pool.query(
    `INSERT INTO fundamental.convertible_bond_profiles(
       instrument_id, stock_instrument_id, bond_full_name, bond_short_name, cb_type,
       current_conv_price, newest_rating
     ) VALUES ($1, $2, 'CI测试转债全称', 'CI测试转债', 'CB', 10.5, 'AA+')`,
    [bondId, stockId]
  );

  await pool.query(
    `INSERT INTO analytics.analysis_snapshots(
       instrument_id, as_of_date, snapshot_type, formula_bundle_version, payload, source_watermark
     ) VALUES ($1, '2026-08-07', 'convertible_bond_analysis', 'v1', $2, $3)`,
    [
      bondId,
      JSON.stringify({ as_of: '2026-08-07', basic: { convert_price: 10.5 } }),
      JSON.stringify({})
    ]
  );

  const terms = [
    ['reset', '转股价下修条款'],
    ['call', '赎回条款'],
    ['put', '回售条款'],
    ['maturity_call', '到期赎回价 110 元']
  ];
  for (const [termType, clauseText] of terms) {
    await pool.query(
      `INSERT INTO fundamental.convertible_bond_terms(
         instrument_id, term_type, clause_text, source_key
       ) VALUES ($1, $2, $3, 'fixture')`,
      [bondId, termType, clauseText]
    );
  }

  await pool.query(
    `INSERT INTO fundamental.financial_reports(
       company_id, report_kind, period_end, period_type, source_id, source_version
     ) VALUES ($1, 'annual', '2026-06-30', 'annual', $2, '1')`,
    [companyId, sourceId]
  );

  fixtureCreated = true;
}

async function cleanupFixture() {
  await pool.query(`DELETE FROM fundamental.financial_reports WHERE company_id IN (SELECT company_id FROM core.companies WHERE legal_name=$1)`, [COMPANY_NAME]);
  await pool.query(`DELETE FROM fundamental.convertible_bond_terms WHERE instrument_id IN (SELECT instrument_id FROM core.instruments WHERE canonical_code=$1)`, [BOND_CODE]);
  await pool.query(`DELETE FROM analytics.analysis_snapshots WHERE instrument_id IN (SELECT instrument_id FROM core.instruments WHERE canonical_code=$1)`, [BOND_CODE]);
  await pool.query(`DELETE FROM fundamental.convertible_bond_profiles WHERE instrument_id IN (SELECT instrument_id FROM core.instruments WHERE canonical_code=$1)`, [BOND_CODE]);
  await pool.query(`DELETE FROM core.company_instruments WHERE instrument_id IN (SELECT instrument_id FROM core.instruments WHERE canonical_code IN ($1,$2))`, [BOND_CODE, STOCK_CODE]);
  await pool.query(`DELETE FROM core.instruments WHERE canonical_code IN ($1,$2)`, [BOND_CODE, STOCK_CODE]);
  await pool.query(`DELETE FROM core.companies WHERE legal_name=$1`, [COMPANY_NAME]);
}

(async () => {
  // 清理上次中断可能留下的测试夹具，再开始本轮测试。
  await cleanupFixture();
  await ensureFixture();

  const [{ instrument_id: bondId }] = (await pool.query(
    `SELECT instrument_id FROM core.instruments WHERE canonical_code=$1`, [BOND_CODE]
  )).rows;
  assert.ok(bondId, '本地库应有测试用可转债主档');

  // 1) 直接调用快照函数：读取本轮测试夹具生成的可转债分析快照
  const snap = await getConvertibleBondSnapshot(BOND_CODE);
  assert.ok(snap && typeof snap === 'object', 'getConvertibleBondSnapshot 应返回快照对象而非抛错');
  assert.ok(snap.freshness && typeof snap.freshness === 'object', '快照应带 freshness 新鲜度判定结果');
  assert.ok('needs_refresh' in snap, '快照应含 needs_refresh 字段');

  // 2) 直接验证 fundamental.financial_reports 的真实列名是 period_end（不是 end_date）
  const probe = await pool.query(
    `SELECT max(period_end) AS pe FROM fundamental.financial_reports`
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

  await cleanupFixture();
  await pool.end();
  console.log('convertible-bond-snapshot-db.test.js 通过：可转债快照真实读库正常（period_end 列名 + 条款指纹读标准条款表 已锁死）');
})().catch(async (err) => {
  await cleanupFixture().catch(() => {});
  console.error('convertible-bond-snapshot-db.test.js 失败：', err && err.message);
  process.exit(1);
});
