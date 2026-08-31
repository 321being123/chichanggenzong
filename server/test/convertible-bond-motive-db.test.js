// 可转债下修动机评分真实数据库回归：验证迁移、候选范围、评分主链和结果落库。
const assert = require('assert');
const { pool } = require('../db');
const { calculateConvertibleBondRevisionMotiveScores, getBondRevisionMotiveDetail, loadMotiveInput, MOTIVE_MODEL_VERSION } = require('../services/convertibleBondRevisionMotiveService');
const { getBondRevisionOverview } = require('../services/convertibleBondRevisionService');

const FIXTURE_BOND_CODE = '128992.SZ';
let fixtureCreated = false;

async function ensureEmptyDatabaseFixture(date) {
  const { rows } = await pool.query(`
    SELECT 1
      FROM market.convertible_bond_daily_metrics md
      JOIN core.instruments i ON i.instrument_id=md.instrument_id
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
     WHERE md.trade_date=$1::date AND i.asset_class='convertible_bond' AND i.status='listed'
     LIMIT 1`, [date]);
  if (rows.length) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bondResult = await client.query(`
      INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status,list_date)
      VALUES ($1,'CI动机评分测试转债','convertible_bond','A股','SZSE','CNY','listed',$2::date)
      ON CONFLICT (canonical_code) DO NOTHING
      RETURNING instrument_id`, [FIXTURE_BOND_CODE, date]);
    if (!bondResult.rows.length) {
      await client.query('ROLLBACK');
      return;
    }
    const instrumentId = bondResult.rows[0].instrument_id;
    await client.query(`
      INSERT INTO fundamental.convertible_bond_profiles(
        instrument_id,bond_full_name,bond_short_name,cb_type,par_value,issue_size,remain_size,
        maturity_date,conv_end_date,current_conv_price
      ) VALUES ($1,'CI动机评分测试转债','CI动机评分测试转债','CB',100,100000000,50000000,$2::date,$2::date,10)`, [instrumentId, '2028-08-28']);
    await client.query(`
      INSERT INTO market.convertible_bond_daily_metrics(
        instrument_id,trade_date,source_id,close,conversion_value,conversion_premium_pct
      ) VALUES ($1,$2::date,(SELECT source_id FROM ops.data_sources WHERE source_code='calculated' LIMIT 1),100,85,17)`, [instrumentId, date]);
    await client.query('COMMIT');
    fixtureCreated = true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixture() {
  if (!fixtureCreated) return;
  await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [FIXTURE_BOND_CODE]);
}

(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.log('[SKIP] PostgreSQL 不可用：' + String(error.message || error));
    await pool.end().catch(() => {});
    return;
  }

  const date = '2026-08-28';
  await ensureEmptyDatabaseFixture(date);
  const { rows: candidates } = await pool.query(`
    SELECT DISTINCT i.canonical_code
      FROM market.convertible_bond_daily_metrics md
      JOIN core.instruments i ON i.instrument_id=md.instrument_id
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      JOIN public.bond_unified u ON u.instrument_id=i.instrument_id
      LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
      LEFT JOIN LATERAL (
        SELECT max(last_trade_date) AS last_trade_date,
               max(COALESCE(last_conversion_date,last_trade_date)) AS last_conversion_date
          FROM event.convertible_bond_call_events ce
         WHERE ce.instrument_id=i.instrument_id AND ce.event_type IN ('exercise','implementation','completion')
      ) call_stop ON true
     WHERE md.trade_date=$1::date AND i.asset_class='convertible_bond' AND i.status='listed' AND u.status='listed'
       AND (p.cb_type IS NULL OR p.cb_type IN ('CB',''))
       AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
       AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
       AND (i.list_date IS NULL OR i.list_date <= $1::date)
       AND (i.delist_date IS NULL OR i.delist_date > $1::date)
       AND (p.maturity_date IS NULL OR p.maturity_date >= $1::date)
       AND (p.conv_end_date IS NULL OR p.conv_end_date >= $1::date)
       AND (p.conv_stop_date IS NULL OR p.conv_stop_date > $1::date)
       AND (COALESCE(call_stop.last_trade_date,call_stop.last_conversion_date) IS NULL OR COALESCE(call_stop.last_trade_date,call_stop.last_conversion_date) > $1::date)`, [date]);
  assert.ok(candidates.length > 0, '验收日期应存在可转债候选范围');

  const result = await calculateConvertibleBondRevisionMotiveScores(date);
  assert.strictEqual(result.tradeDate, date);
  assert.strictEqual(result.count, candidates.length, '候选范围内每只债都应完成评分');
  assert.strictEqual(result.failures.length, 0, '评分主链不应出现 SQL 或数据契约错误：' + JSON.stringify(result.failures.slice(0, 3)));

  const historicalInput = await loadMotiveInput(candidates[0].canonical_code, date);
  assert.ok(historicalInput, '评分候选应能读取输入快照');
  assert.ok(historicalInput.holders.every(row => !row.announced_at || String(row.announced_at).slice(0, 10) <= date), '持有人数据不得使用评分日后公告');
  assert.ok(!historicalInput.financialDate || historicalInput.financialDate <= date, '财报不得使用评分日后报告期');
  assert.ok(!historicalInput.stockTradeDate || historicalInput.stockTradeDate <= date, '正股行情不得超过评分日');

  const { rows: persisted } = await pool.query(
    `SELECT COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE motive_score IS NULL OR motive_score NOT BETWEEN 0 AND 100)::int AS bad_score,
            COUNT(*) FILTER (WHERE completeness_rate NOT BETWEEN 0 AND 1)::int AS bad_quality
       FROM analytics.convertible_bond_revision_motive_daily m
       JOIN core.instruments i ON i.instrument_id=m.instrument_id
      WHERE m.trade_date=$1::date AND m.model_version=$2
        AND i.canonical_code=ANY($3::text[])`, [date, MOTIVE_MODEL_VERSION, candidates.map(row => row.canonical_code)]
  );
  assert.strictEqual(persisted[0].count, candidates.length, '评分结果应全部落库且可幂等覆盖');
  assert.strictEqual(persisted[0].bad_score, 0, '评分范围约束应生效');
  assert.strictEqual(persisted[0].bad_quality, 0, '完整度范围约束应生效');

  const overview = await getBondRevisionOverview({ limit: 2000 });
  assert.ok(overview.data.every(row => !row.motive_model_version || row.motive_model_version === MOTIVE_MODEL_VERSION), '下修列表不得混入旧模型版本快照');
  const observed = overview.data.find(row => ['proposed', 'meeting_pending', 'approved', 'implemented', 'terminated'].includes(row.business_status));
  if (observed) assert.notStrictEqual(observed.motive_level, 'weak', '已确定下修状态不得继续展示预测性的动机偏弱');

  const detail = await getBondRevisionMotiveDetail({ tsCode: candidates[0].canonical_code, tradeDate: date });
  assert.ok(detail && detail.score_summary.trade_date === date, '详情必须读取指定交易日快照');
  assert.ok(detail.input_snapshot.some(row => row.rule) && detail.source_references.some(row => row.api_name), '详情必须带规则和来源接口');
  const conversionItems = (detail.dimension_calculations.find(row => row.dimension === 'conversion') || {}).calculations || [];
  assert.strictEqual(conversionItems.find(row => row.metric === 'remain_issue_ratio').unit, '百分比', '剩余规模/发行规模应使用百分比单位');
  assert.strictEqual(conversionItems.find(row => row.metric === 'remain_market_cap_ratio').unit, '百分比', '剩余规模/正股市值应使用百分比单位');

  const { rows: requiredColumns } = await pool.query(`
    SELECT table_schema,table_name,column_name
      FROM information_schema.columns
     WHERE (table_schema,table_name,column_name) IN (
       ('event','convertible_bond_holder_change_events','before_amount'),
       ('event','convertible_bond_holder_change_events','after_amount'),
       ('event','convertible_bond_holder_change_events','is_cleared'),
       ('fundamental','company_pledge_snapshots','pledge_count'),
       ('fundamental','company_pledge_snapshots','total_shares')
     )`);
  assert.strictEqual(requiredColumns.length, 5, '112 迁移补齐的审计列应存在');
  await cleanupFixture();
  await pool.end();
  console.log(`convertible-bond-motive-db.test.js 通过：${result.count} 只候选、0 失败、评分结果全部落库`);
})().catch(async error => {
  console.error('convertible-bond-motive-db.test.js 失败：', error && error.stack || error);
  await cleanupFixture().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
