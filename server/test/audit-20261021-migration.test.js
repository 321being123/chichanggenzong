// ========== 2026-10-21 三视角审查回归（真实数据库 + 真实迁移执行） ==========
// 运行：node server/test/audit-20261021-migration.test.js（在 portfolio_test 上执行）
// 覆盖：R-14 两种日期格式水位、P-6 迁移后视图状态、P-7 脏名清理迁移（168/169 真实执行）。
const assert = require('assert');
const { pool } = require('../db');
const { migration168CallEventKindSemantics, migration169InstrumentNameCleanup } = require('../db/migrations');
const { readSnapshot } = require('../services/datasetPartitionRegistry');

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push(['PASS', name]); console.log('  [PASS] ' + name); })
    .catch(e => { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); });
}

// 审计专用夹具代码段，断言只限定在自建数据内（测试库可能是旧快照）
const FIXTURES = [
  { code: '119991.SH', title: '关于示例转债一即将到期及停止交易的提示性公告', name: '示例转债一' },
  { code: '119992.SH', title: '关于提前赎回“示例转债二”的提示性公告', name: '示例转债二' },
  { code: '119993.SH', title: '关于“示例转债三”停止交易的公告', name: '示例转债三' },
];
const DIRTY_NAME_CODE = '119994.SH';
const IPO_DATE_8 = '20991231';
const IPO_DATE_DASH = '2098-01-05';

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const src = await client.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1");
    const sourceId = src.rows[0] ? src.rows[0].source_id : (await client.query('SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1')).rows[0].source_id;
    for (const f of FIXTURES) {
      const inst = await client.query(
        `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status,list_date)
         VALUES ($1,$2,'convertible_bond','A股','SSE','CNY','listed','2026-01-05')
         ON CONFLICT (canonical_code) DO UPDATE SET name=EXCLUDED.name
         RETURNING instrument_id`, [f.code, f.name]);
      const id = inst.rows[0].instrument_id;
      await client.query(
        `INSERT INTO fundamental.convertible_bond_profiles(instrument_id,bond_full_name,bond_short_name,cb_type,par_value,issue_size,remain_size,maturity_date,conv_end_date,current_conv_price)
         VALUES ($1,$2,$2,'CB',100,100000000,50000000,'2029-01-05','2029-01-05',10)
         ON CONFLICT (instrument_id) DO NOTHING`, [id, f.name]);
      await client.query('DELETE FROM event.convertible_bond_call_events WHERE instrument_id=$1 AND source_key LIKE $2', [id, 'audit-20261021%']);
      await client.query(
        `INSERT INTO event.convertible_bond_call_events(instrument_id,event_type,announced_at,source_id,source_key,source_url,title,parse_status,parser_version,details,raw_payload)
         VALUES ($1,'implementation','2026-10-20',$2,$3,'','' || $4,'complete','audit-test','{}'::jsonb,'{}'::jsonb)`,
        [id, sourceId, 'audit-20261021-' + f.code, f.title]);
    }
    // P-7：脏名 + 干净官方简称
    const dirty = await client.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status,list_date)
       VALUES ($1,'为“示例脏名转债','convertible_bond','A股','SSE','CNY','pending_listing','2026-11-01')
       ON CONFLICT (canonical_code) DO UPDATE SET name=EXCLUDED.name
       RETURNING instrument_id`, [DIRTY_NAME_CODE]);
    const dirtyId = dirty.rows[0].instrument_id;
    await client.query(
      `INSERT INTO fundamental.convertible_bond_profiles(instrument_id,bond_full_name,bond_short_name,cb_type,par_value,issue_size,remain_size)
       VALUES ($1,'示例脏名转债','示例发债','CB',100,100000000,100000000)
       ON CONFLICT (instrument_id) DO UPDATE SET bond_short_name=EXCLUDED.bond_short_name`, [dirtyId]);
    // R-14：八位与横线两种历史格式并存
    await client.query('DELETE FROM public.ipo_reports WHERE report_date IN ($1,$2)', [IPO_DATE_8, IPO_DATE_DASH]);
    await client.query('INSERT INTO public.ipo_reports(report_date,md) VALUES ($1,$2),($3,$4)',
      [IPO_DATE_8, 'audit-8digit', IPO_DATE_DASH, 'audit-dashed']);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function cleanupFixtures() {
  for (const f of FIXTURES) {
    await pool.query('DELETE FROM event.convertible_bond_call_events WHERE source_key=$1', ['audit-20261021-' + f.code]).catch(() => {});
    await pool.query('DELETE FROM fundamental.convertible_bond_profiles WHERE instrument_id=(SELECT instrument_id FROM core.instruments WHERE canonical_code=$1)', [f.code]).catch(() => {});
    await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [f.code]).catch(() => {});
  }
  await pool.query('DELETE FROM fundamental.convertible_bond_profiles WHERE instrument_id=(SELECT instrument_id FROM core.instruments WHERE canonical_code=$1)', [DIRTY_NAME_CODE]).catch(() => {});
  await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [DIRTY_NAME_CODE]).catch(() => {});
  await pool.query('DELETE FROM public.ipo_reports WHERE report_date IN ($1,$2)', [IPO_DATE_8, IPO_DATE_DASH]).catch(() => {});
}

(async () => {
  await setupFixtures();

  console.log('A. 迁移168真实执行：call_kind 回填 + 视图三类语义');
  await check('迁移168可重复执行且不报错', async () => {
    await migration168CallEventKindSemantics();
    await migration168CallEventKindSemantics();
  });
  await check('details.call_kind 按标题回填（maturity/early/unconfirmed）', async () => {
    const { rows } = await pool.query(
      `SELECT source_key,details->>'call_kind' AS kind FROM event.convertible_bond_call_events WHERE source_key LIKE 'audit-20261021%'`);
    const map = Object.fromEntries(rows.map(r => [r.source_key, r.kind]));
    assert.strictEqual(map['audit-20261021-119991.SH'], 'maturity');
    assert.strictEqual(map['audit-20261021-119992.SH'], 'early');
    assert.strictEqual(map['audit-20261021-119993.SH'], 'unconfirmed');
  });
  await check('状态视图区分到期兑付/已公告强赎/待确认', async () => {
    const { rows } = await pool.query(
      `SELECT security_code,business_status FROM analytics.convertible_bond_call_latest WHERE security_code IN ('119991','119992','119993')`);
    const map = Object.fromEntries(rows.map(r => [r.security_code, r.business_status]));
    assert.strictEqual(map['119991'], 'maturity_redeem', '到期公告不得再显示为已公告强赎');
    assert.strictEqual(map['119992'], 'announced', '真实提前强赎必须保留');
    assert.strictEqual(map['119993'], 'redemption_unconfirmed', '无法区分的必须是待确认');
  });

  console.log('B. 迁移169真实执行：脏名沿官方简称纠正');
  await check('正文残留脏名被替换为官方简称', async () => {
    await migration169InstrumentNameCleanup();
    const { rows } = await pool.query('SELECT name FROM core.instruments WHERE canonical_code=$1', [DIRTY_NAME_CODE]);
    assert.strictEqual(rows[0].name, '示例发债');
  });
  await check('干净名称不被改动', async () => {
    const { rows } = await pool.query('SELECT name FROM core.instruments WHERE canonical_code=$1', ['119991.SH']);
    assert.strictEqual(rows[0].name, '示例转债一');
  });

  console.log('C. R-14 分区水位覆盖两种日期格式');
  await check('八位日期参与水位，取两种格式的真实最大值', async () => {
    const snap = await readSnapshot('ipo_calendar');
    assert.strictEqual(snap.dataAsOf, '2099-12-31', '水位应取八位格式的最大日期，实际: ' + snap.dataAsOf);
  });
  await check('仅横线格式时也能正确取值', async () => {
    await pool.query('DELETE FROM public.ipo_reports WHERE report_date=$1', [IPO_DATE_8]);
    const snap = await readSnapshot('ipo_calendar');
    assert.strictEqual(snap.dataAsOf, '2098-01-05', '横线格式应参与水位，实际: ' + snap.dataAsOf);
  });

  await cleanupFixtures();
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('PASS=' + results.filter(r => r[0] === 'PASS').length + ' FAIL=' + failed.length);
  if (failed.length) process.exit(1);
  console.log('audit-20261021-migration 全部通过');
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  await cleanupFixtures().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
