const assert = require('assert');
const path = require('path');
const { SCRIPT, nextIpoRefreshDelay, pythonCandidates } = require('../jobs/ipoCalendarRefresh');

function shanghaiDate(iso) { return new Date(iso); }

// 2026-07-17 17:30 上海时间 -> 当日 18:00
assert.strictEqual(nextIpoRefreshDelay(shanghaiDate('2026-07-17T09:30:00Z')), 30 * 60 * 1000);
// 2026-07-17 周五 18:30 -> 下周一 18:00
assert.strictEqual(nextIpoRefreshDelay(shanghaiDate('2026-07-17T10:30:00Z')), 71.5 * 60 * 60 * 1000);
assert(pythonCandidates().length > 0);
assert.strictEqual(path.basename(SCRIPT), 'ipo_daily_report.py');
console.log('PASS=4 FAIL=0');
