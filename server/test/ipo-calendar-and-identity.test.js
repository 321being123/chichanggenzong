// IPO 日历合并、调度及证券身份单测（合并原 ipo-calendar-merge / calendar-schedule / instrument-identity）。
(async () => {

  // --- ipo-calendar-merge.test.js ---
  await (async () => {
const assert = require('assert');
const { mergeCalendarDays } = require('../routes/ipo');

const merged = mergeCalendarDays(
  [{ date: '2026-09-10', apply_stocks: [{ code: '600000', name: 'A股' }], list_stocks: [] }],
  [{ date: '2026-09-10', apply_stocks: [{ code: '00001.HK', name: '港股' }], list_stocks: [{ code: '00002.HK', name: '港股上市' }] }],
  [{ date: '2026-09-10', apply_bonds: [{ code: '123001', name: '转债' }], list_bonds: [] }],
);

assert.strictEqual(merged.length, 1);
assert.deepStrictEqual(merged[0].apply_stocks.map(item => item.code), ['600000', '00001.HK']);
assert.strictEqual(merged[0].list_stocks[0].code, '00002.HK');
assert.strictEqual(merged[0].apply_bonds[0].code, '123001');
console.log('ipo-calendar-merge.test.js passed');

  })();

  // --- ipo-calendar-schedule.test.js ---
  await (async () => {
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { SCRIPT, nextIpoRefreshDelay, pythonCandidates, summarizeIpoPythonError } = require('../jobs/ipoCalendarRefresh');
const { expectedDataDate } = require('../services/jobScheduleSlots');

function shanghaiDate(iso) { return new Date(iso); }

// 2026-07-17 17:30 上海时间 -> 当日 18:05
assert.strictEqual(nextIpoRefreshDelay(shanghaiDate('2026-07-17T09:30:00Z')), 35 * 60 * 1000);
// 2026-07-17 周五 18:30 -> 下周一 18:05
assert.strictEqual(nextIpoRefreshDelay(shanghaiDate('2026-07-17T10:30:00Z')), (71 * 60 + 35) * 60 * 1000);
assert.strictEqual(expectedDataDate('ipo_calendar_refresh', '2026-08-17'), '2026-08-18', '打新日报应校验下一个交易日数据');
assert.strictEqual(expectedDataDate('ipo_calendar_refresh', '2026-08-21'), '2026-08-24', '周五日报应校验下周一数据');
assert(pythonCandidates().length > 0);
assert.strictEqual(path.basename(SCRIPT), 'ipo_daily_report.py');
const valuationSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_valuation.py'), 'utf8');
assert.ok(valuationSource.includes('estimated = board_base'), '新股线性回退模型未使用板块稳健基准');
const permissionError = summarizeIpoPythonError('Traceback (most recent call last):\nXGBoostError: LocalFileSystem::Open "/opt/portfolio/ipo-report/data/ipo_xgb_model.json": Permission denied\n[bt] stack');
assert.ok(permissionError.includes('权限不足') && !permissionError.includes('Traceback') && permissionError.length < 150);
const jobSource = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'ipoCalendarRefresh.js'), 'utf8');
assert.ok(jobSource.includes("PYTHONUTF8: '1'") && jobSource.includes("PYTHONIOENCODING: 'utf-8'"));
assert.ok(jobSource.includes("IPO_REPORT_DATABASE_ONLY: '1'"));
const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobRunners.js'), 'utf8');
assert.match(runnerSource, /case 'ipo_calendar_refresh':[\s\S]*expectedDataDate\('ipo_calendar_refresh', businessDate\)[\s\S]*targetDate/);
const calendarSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'calendar_core.py'), 'utf8');
assert.doesNotMatch(calendarSource, /new_share/, '日报日历不得直接调用new_share');
assert.match(calendarSource, /FROM ipo_history/, '新股申购和上市事件必须读取ipo_history');
assert.match(calendarSource, /market\.trade_calendar/, '目标交易日必须读取已入库trade_calendar');
assert.match(jobSource, /parseTushareFailovers/, 'Python 成功切备用后的接口标记未进入日报解析链');
assert.match(jobSource, /notifyTushareFailovers/, 'Python 成功切备用后的接口告警未接入日报任务');
console.log('PASS=9 FAIL=0');

  })();

  // --- ipo-instrument-identity.test.js ---
  await (async () => {
// 运行：node server/test/ipo-instrument-identity.test.js
// 第 17 节首批身份链回归：迁移、A 股兼容读写和接口级限制口径。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const { readMigrationSource } = require('./helpers/migration-source');
const migration = readMigrationSource();
const sync = fs.readFileSync(path.join(root, 'ipo-report', 'ipo_history_sync.py'), 'utf8');
const identity = fs.readFileSync(path.join(root, 'server', 'services', 'securityIdentity.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'server', 'routes', 'ipo.js'), 'utf8');
// 批次3：IPO 的 SQL 已迁入仓储，字段级断言需同时覆盖两处。
const ipoRepositorySource = fs.readFileSync(path.join(root, 'server', 'repositories', 'ipoRepository.js'), 'utf8');
const hkex = require('../services/hkexAnnouncement');

assert.match(migration, /140_ipo_instrument_identity/);
assert.match(migration, /141_backfill_ipo_identity_gaps/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS instrument_id BIGINT/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS market_code TEXT NOT NULL DEFAULT 'CN'/);
assert.match(migration, /fk_ipo_history_instrument_id/);
assert.match(migration, /uq_ipo_history_market_instrument/);
assert.match(migration, /156_endpoint_only_internal_limits/);
assert.match(migration, /ck_source_endpoint_wildcard_no_internal_limits/);
assert.match(sync, /ensure_instrument\(/);
assert.match(sync, /"instrument_id"\] = master\["instrument_id"\]/);
assert.match(sync, /market_code='CN'/);
assert.match(identity, /core\.instruments\.status='listed'/);
assert.match(route + ipoRepositorySource, /h\.market_code='CN'/);
assert.ok(hkex.ALLOWED_DOMAINS.has('www1.hkexnews.hk'));
assert.ok(hkex.ALLOWED_DOMAINS.has('www2.hkexnews.hk'));
assert.ok(!hkex.ALLOWED_DOMAINS.has('example.com'));

console.log('OK ipo-instrument-identity: IPO 事实已具备统一 instrument_id、CN 隔离和 HKEX 内部保护口径');

  })();
})().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
