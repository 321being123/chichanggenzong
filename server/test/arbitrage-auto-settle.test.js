// 套利案例自动收口：标的已退市的进行中案例必须判 completed（真库）。
// 背景（2026-11-04）：中金换股吸收合并东兴证券(601198)、信达证券(601059) 于 2026-10-19 完成退市，
// 但案例状态停在 proposed——因为同步只靠公告标题词表判断"完成"，而「A股换股实施公告」并不命中。
// 退市是硬证据：被吸并方退市 = 合并已完成。这里验证该规则只收口该收口的，且留审计痕迹。
'use strict';
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const DELISTED = '609777.SH';
const LISTED = '609778.SH';

async function cleanup(pool) {
  const codes = [DELISTED, LISTED];
  await pool.query(`DELETE FROM event.arbitrage_cases WHERE event_key LIKE 'TEST-AUTOSETTLE%'`);
  await pool.query(`DELETE FROM core.instruments WHERE canonical_code = ANY($1)`, [codes]);
}

async function main() {
  const { pool } = require('../db/connection');
  const migrations = require('../db/migrations');
  await migrations.runMigrations();
  const sync = require('../services/arbitrageAnnouncementSync');

  await cleanup(pool);

  const sourceRow = await pool.query(`SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1`);
  assert.ok(sourceRow.rows[0], '测试环境缺少 ops.data_sources');
  const sourceId = sourceRow.rows[0].source_id;

  let pass = 0, fail = 0;
  try {
    const mkInstrument = async (code, delistDate) => {
      const { rows } = await pool.query(
        `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, delist_date, status)
         VALUES ($1,$2,'stock','CN','SSE','CNY','2015-01-01',$3::date,$4) RETURNING instrument_id`,
        [code, code + '测试', delistDate, delistDate ? 'delisted' : 'listed']);
      return rows[0].instrument_id;
    };
    const delistedId = await mkInstrument(DELISTED, '2026-10-19');
    const listedId = await mkInstrument(LISTED, null);

    const mkCase = async (instrumentId, key) => {
      const { rows } = await pool.query(
        `INSERT INTO event.arbitrage_cases
           (market, strategy_type, source_id, source_key, event_key, target_instrument_id,
            event_status, review_status, announced_at, raw_payload)
         VALUES ('CN','a_share_swap',$1,$2,$3,$4,'proposed','approved','2026-09-24'::date,'{}'::jsonb)
         RETURNING case_id`,
        [sourceId, key, key, instrumentId]);
      return rows[0].case_id;
    };
    const delistedCase = await mkCase(delistedId, 'TEST-AUTOSETTLE-DELISTED');
    const listedCase = await mkCase(listedId, 'TEST-AUTOSETTLE-LISTED');

    const result = await sync.settleDelistedCases({ asOfDate: '2026-11-04' });
    const { rows } = await pool.query(
      `SELECT case_id, event_status, review_status, raw_payload FROM event.arbitrage_cases WHERE case_id = ANY($1::int[])`,
      [[delistedCase, listedCase]]);
    const byId = new Map(rows.map(row => [Number(row.case_id), row]));

    try {
      assert.ok(result.settled >= 1, '应至少收口 1 条已退市案例');
      assert.ok(result.cases.some(item => Number(item.caseId) === Number(delistedCase)), '返回值必须列出被收口的案例');
      const settled = byId.get(Number(delistedCase));
      assert.strictEqual(settled.event_status, 'completed', '标的已退市的进行中案例必须判完成');
      assert.strictEqual(settled.raw_payload.autoSettled.reason, 'target_delisted', '必须留审计原因');
      assert.strictEqual(settled.raw_payload.autoSettled.delistDate, '2026-10-19', '审计痕迹里要写退市日');
      assert.strictEqual(settled.review_status, 'approved', '不得伪造或改动人工审核状态');
      const untouched = byId.get(Number(listedCase));
      assert.strictEqual(untouched.event_status, 'proposed', '未退市标的的进行中案例不能被改动');
      pass += 1;
      console.log('  [PASS] 标的已退市 → 案例自动判 completed 且留审计痕迹，未退市的不受影响');
    } catch (error) {
      fail += 1;
      console.log('  [FAIL] 标的已退市 → 案例自动判 completed 且留审计痕迹 :: ' + error.message);
    }
  } finally {
    try { await cleanup(pool); } catch (error) { console.error('清理夹具失败：', error.message); }
    await pool.end().catch(() => {});
  }

  console.log(`PASS=${pass} FAIL=${fail} ERROR=0`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
