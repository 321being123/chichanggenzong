// 套利案件「已终态后的进程公告」续接回归
// 覆盖：换股实施/退市等后续公告必须挂在原案件，不得新建平行案件；
// 历史补录（公告早于终态）、超窗口、异策略、异标的、非终态案件均不续接。
// 造数全部为自建测试对象，测试结束删除。
const assert = require('assert');
const { pool } = require('../db/connection');
const sync = require('../services/arbitrageAnnouncementSync');

const TAG = 'followup_case_test';
let instrumentId = null;
let otherInstrumentId = null;
let caseId = null;
let otherCaseId = null;
let docId = null;
let sourceId = null;

async function cleanup() {
  const caseIds = [caseId, otherCaseId].filter(Boolean);
  if (caseIds.length) {
    await pool.query('DELETE FROM event.arbitrage_case_documents WHERE case_id = ANY($1::int[])', [caseIds]);
    await pool.query('DELETE FROM event.arbitrage_cases WHERE case_id = ANY($1::int[])', [caseIds]);
  }
  if (docId) await pool.query('DELETE FROM event.arbitrage_case_documents WHERE document_id=$1', [docId]);
  if (docId) await pool.query('DELETE FROM event.documents WHERE document_id=$1', [docId]);
  const instIds = [instrumentId, otherInstrumentId].filter(Boolean);
  if (instIds.length) await pool.query('DELETE FROM core.instruments WHERE instrument_id = ANY($1::bigint[])', [instIds]);
}

(async () => {
  try {
    await cleanup();
    const src = await pool.query('SELECT MIN(source_id) AS id FROM ops.data_sources');
    sourceId = src.rows[0] && src.rows[0].id;
    if (!sourceId) throw new Error('测试环境缺少 ops.data_sources，无法构造案件');

    // 测试证券：一个终态案件的标的，另一个用于对照
    await pool.query("DELETE FROM core.instruments WHERE canonical_code IN ('990001.SH','990002.SH')");
    instrumentId = (await pool.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status,delist_date)
       VALUES('990001.SH','测试换股标的','stock','CN','SSE','CNY','delisted','2026-10-19') RETURNING instrument_id`
    )).rows[0].instrument_id;
    otherInstrumentId = (await pool.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status)
       VALUES('990002.SH','测试对照标的','stock','CN','SSE','CNY','listed') RETURNING instrument_id`
    )).rows[0].instrument_id;

    // 终态案件 + 最后一份公告 2026-09-22
    caseId = (await pool.query(
      `INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key,target_instrument_id,event_status,review_status,announced_at)
       VALUES('CN','a_share_swap',$1,$2,$3,'completed','approved','2026-07-01') RETURNING case_id`,
      [sourceId, TAG + '_main', instrumentId]
    )).rows[0].case_id;
    docId = (await pool.query(
      `INSERT INTO event.documents(document_type,title,url,source_id,content_hash,announced_at,raw_payload)
       VALUES('arbitrage_announcement','测试换股吸收合并完成公告',$1,$2,$3,'2026-09-22','{}') RETURNING document_id`,
      [TAG + '/main.pdf', sourceId, TAG + '_h1']
    )).rows[0].document_id;
    await pool.query(
      `INSERT INTO event.arbitrage_case_documents(case_id,document_id,relation_type,announced_at,document_role)
       VALUES($1,$2,'announcement','2026-09-22','terminal')`,
      [caseId, docId]
    );

    // 对照：未终态案件
    otherCaseId = (await pool.query(
      `INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key,target_instrument_id,event_status,review_status,announced_at)
       VALUES('CN','a_share_swap',$1,$2,$3,'proposed','approved','2026-09-01') RETURNING case_id`,
      [sourceId, TAG + '_open', otherInstrumentId]
    )).rows[0].case_id;

    // 1. 终态之后的实施公告（2026-10-16）→ 续接原案件
    const followUp = await sync.findFollowUpCaseId(pool, instrumentId, 'a_share_swap', '2026-10-16');
    assert.ok(followUp, '终态后的换股实施公告应续接原案件，不得新建');
    assert.strictEqual(Number(followUp.case_id), Number(caseId));

    // 2. 与最后公告同一天 → 交给既有「终态归档」分支处理，不在这里续接
    assert.strictEqual(await sync.findFollowUpCaseId(pool, instrumentId, 'a_share_swap', '2026-09-22'), null);

    // 3. 早于最后公告的历史补录 → 不续接
    assert.strictEqual(await sync.findFollowUpCaseId(pool, instrumentId, 'a_share_swap', '2026-09-20'), null);

    // 4. 超出 365 天窗口 → 视为新事件，不续接
    const beyond = '2027-10-01';
    assert.strictEqual(await sync.findFollowUpCaseId(pool, instrumentId, 'a_share_swap', beyond), null);

    // 5. 不同策略 / 不同标的 / 未终态案件 → 都不续接
    assert.strictEqual(await sync.findFollowUpCaseId(pool, instrumentId, 'a_cash_offer', '2026-10-16'), null);
    assert.strictEqual(await sync.findFollowUpCaseId(pool, otherInstrumentId, 'a_share_swap', '2026-10-16'), null);

    // 6. 窗口内边界：刚好 365 天前应命中
    const edge = await sync.findFollowUpCaseId(pool, instrumentId, 'a_share_swap', '2027-09-22');
    assert.ok(edge, '365 天窗口边界应包含在续接范围内');

    await cleanup();
    console.log('arbitrage-followup-case: 全部通过');
  } catch (e) {
    console.error('arbitrage-followup-case 失败:', e.message);
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原始错误 */ }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
