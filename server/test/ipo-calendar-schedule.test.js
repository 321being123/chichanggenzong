const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { SCRIPT, nextIpoRefreshDelay, pythonCandidates, summarizeIpoPythonError } = require('../jobs/ipoCalendarRefresh');
const { expectedDataDate } = require('../services/jobScheduleSlots');

function shanghaiDate(iso) { return new Date(iso); }

// 2026-07-17 17:30 上海时间 -> 当日 18:00
assert.strictEqual(nextIpoRefreshDelay(shanghaiDate('2026-07-17T09:30:00Z')), 30 * 60 * 1000);
// 2026-07-17 周五 18:30 -> 下周一 18:00
assert.strictEqual(nextIpoRefreshDelay(shanghaiDate('2026-07-17T10:30:00Z')), 71.5 * 60 * 60 * 1000);
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
console.log('PASS=9 FAIL=0');
