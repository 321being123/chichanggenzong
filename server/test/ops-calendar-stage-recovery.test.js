const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-calendar-test-'));
process.env.HOLIDAY_CONFIG_PATH = path.join(temporary, 'holidays.json');
const { pool } = require('../db/connection');
const market = require('../services/market');
const realQuery = market.tushareQuery;
let calls = [];
let responseKind = 'complete';
market.tushareQuery = async (api, params) => {
  calls.push({ api, params });
  const dates = calendar.datesForYear(Number(params.start_date.slice(0, 4))).filter(date => date.replace(/-/g, '') >= params.start_date && date.replace(/-/g, '') <= params.end_date);
  if (responseKind === 'empty') return { fields: ['cal_date', 'is_open'], items: [] };
  return { fields: ['cal_date', 'is_open'], items: dates.map(date => [date.replace(/-/g, ''),
    date === '2026-10-01' || [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? '0' : '1']) };
};
const calendar = require('../jobs/holidaySync');
const { loadHolidays, saveHolidays } = require('../config/holidays');
const { getJobDefinition, stageCompletionEvidence } = require('../services/jobDefinitions');
const { verifySlotRecoveryEvidence } = require('../services/jobRecoveryEvidence');
const { readSnapshot } = require('../services/datasetPartitionRegistry');
const { verifiedStockDataDate } = require('../jobs/stockAnalysisRefresh');

async function main() {
  const client = await pool.connect();
  const realConnect = pool.connect;
  pool.connect = async () => ({ query: client.query.bind(client), release() {} });
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM market.trade_calendar WHERE exchange='SSE' AND trade_date BETWEEN '2026-01-01' AND '2026-12-31'");
    saveHolidays({ updatedAt: '2026-09-15', years: { 2026: ['2026-10-01'] } });
    assert.strictEqual(calendar.datesForYear(2024).length, 366);
    const all = calendar.datesForYear(2026);
    const data = await market.tushareQuery('trade_cal', { start_date: '20260101', end_date: '20261231' });
    const rows = calendar.validateCalendarRows(data, all);
    await client.query(`INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code,raw_payload)
      SELECT 'SSE',x.trade_date,x.is_open,'tushare','{}'::jsonb FROM jsonb_to_recordset($1::jsonb) AS x(trade_date date,is_open boolean)`,
    [JSON.stringify(rows.filter(row => row.trade_date <= '2026-09-30'))]);
    calls = [];
    const result = await calendar.ensureHolidaysCurrent({ businessDate: '2026-09-30' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 1, '新鲜JSON不能短路共享SSE缺口');
    assert.strictEqual(calls[0].params.start_date, '20261001', '只补缺失日期范围');
    assert.strictEqual(result.datasetDiagnostics.trade_calendar.next_trade_date, '2026-10-02');
    calls = [];
    await calendar.ensureHolidaysCurrent({ businessDate: '2026-09-30' });
    assert.strictEqual(calls.length, 0, '完整日历命中数据库，不重复请求');
    await client.query("DELETE FROM market.trade_calendar WHERE exchange='SSE' AND trade_date='2026-06-02'");
    responseKind = 'empty';
    await assert.rejects(calendar.ensureHolidaysCurrent({ businessDate: '2026-09-30' }), /覆盖不完整/);
    assert.deepStrictEqual(loadHolidays().years[2026], ['2026-10-01'], '空结果不覆盖原配置');
    responseKind = 'complete';
    await calendar.ensureHolidaysCurrent({ businessDate: '2026-09-30' });
    assert.strictEqual(calls[calls.length - 1].params.start_date, '20260602', '最大日期完整也要发现中间缺日');
    await calendar.saveManualHolidays('2026', ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']);
    assert.strictEqual((await client.query("SELECT is_open FROM market.trade_calendar WHERE exchange='SSE' AND trade_date='2026-10-02'")).rows[0].is_open, false);
    const manual = loadHolidays();
    saveHolidays({ ...manual, updatedAt: '2026-01-01' });
    calls = [];
    assert.strictEqual((await calendar.ensureHolidaysCurrent({ businessDate: '2026-09-30' })).datasetDiagnostics.trade_calendar.next_trade_date, '2026-10-08');
    assert.strictEqual(calls.length, 0, '人工维护年度不得被月度自动覆盖');
    await assert.rejects(calendar.saveManualHolidays('2026', ['2025-10-01']), /维护年份/);
    await client.query("DELETE FROM market.trade_calendar WHERE exchange='SSE' AND trade_date BETWEEN '2027-01-01' AND '2027-12-31'");
    assert.strictEqual((await calendar.ensureHolidaysCurrent({ businessDate: '2026-12-31' })).datasetDiagnostics.trade_calendar.next_trade_date, '2027-01-01', '年末提前验证下一年度');
    assert.throws(() => calendar.validateCalendarRows({ fields: ['cal_date', 'is_open'], items: [['20261001', 0], ['20261001', 0]] }, ['2026-10-01']), /重复/);
    const definition = getJobDefinition('ipo_history_sync');
    const request = { mode: 'targeted', targetCodes: ['301716'], targetFields: ['business_exposure'] };
    const targeted = { ok: true, status: 'succeeded', mode: 'targeted', stageComplete: true,
      codes: ['301716'], targetFields: ['business_exposure'] };
    assert.strictEqual(stageCompletionEvidence(definition, targeted, request), true);
    assert.strictEqual(stageCompletionEvidence(definition, { ...targeted, codes: [] }, request), false);
    assert.strictEqual(stageCompletionEvidence(definition, { ...targeted, stageComplete: false }, request), false);
    assert.strictEqual(stageCompletionEvidence(definition, { ...targeted, mode: 'core' }, request), false);
    assert.strictEqual(stageCompletionEvidence(definition, { ...targeted, targetFields: [] }, request), false);
    const slot = { slot_id: 111, job_code: 'ipo_history_sync', business_date: '2026-09-30', status: 'succeeded', request_payload: request };
    const query = async sql => {
      assert(sql.includes('FROM job_runs'), '定向恢复不依赖无关的全局分区');
      return { rows: [{ id: 1, slot_id: 111, status: 'done', result_json: targeted }] };
    };
    assert.strictEqual((await verifySlotRecoveryEvidence(slot, query)).recovered, true);
    assert.strictEqual((await verifySlotRecoveryEvidence({ ...slot, request_payload: { ...request, targetCodes: ['001246'] } }, query)).recovered, false);
    assert.strictEqual((await verifySlotRecoveryEvidence(slot, query, { alertType: 'data_quality' })).recovered, false,
      '任务阶段完成不能代替数据质量告警证据');
    const suspensionQuery = async () => ({ rows: [{ expected_count: 2, suspended_count: 2, calendar_count: 4, calendar_days: 4 }] });
    const suspension = await verifiedStockDataDate('601198.SH', '2026-09-14', '2026-09-18', suspensionQuery);
    assert.strictEqual(suspension.dataAsOf, '2026-09-18');
    assert.strictEqual(suspension.lastTradeDate, '2026-09-14', '停牌核验不改最后成交日');
    for (const incomplete of [{ expected_count: 0 }, { expected_count: 2, suspended_count: 1, calendar_count: 4, calendar_days: 4 },
      { expected_count: 2, suspended_count: 2, calendar_count: 3, calendar_days: 4 }]) {
      assert.strictEqual((await verifiedStockDataDate('601198.SH', '2026-09-14', '2026-09-18', async () => ({ rows: [incomplete] }))).dataAsOf, '2026-09-14');
    }
    await readSnapshot('trade_calendar', {}, async sql => {
      assert(sql.includes("exchange='SSE'"), 'HKEX覆盖不得替代SSE');
      return { rows: [{ row_count: 365, data_as_of: '2026-12-31' }] };
    });
    const navPartition = await readSnapshot('nav_snapshot', { partitionKey: '1900-01-01' }, client.query.bind(client));
    assert.strictEqual(navPartition.rowCount, 0, '真实PG文本日期按精确分区查询，空日期不能借用全局净值');
    await client.query('SELECT date::text AS date FROM nav_history WHERE username=$1 AND account_name=$2 AND date=$3::text',
      ['test_nav_date_type', 'fixture', '1900-01-01']);
    console.log('calendar coverage, manual edits and targeted recovery tests passed');
  } finally {
    await client.query('ROLLBACK');
    pool.connect = realConnect;
    client.release();
    market.tushareQuery = realQuery;
    await pool.end();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
