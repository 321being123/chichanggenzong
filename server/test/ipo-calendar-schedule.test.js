const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { SCRIPT, nextIpoRefreshDelay, pythonCandidates } = require('../jobs/ipoCalendarRefresh');

function shanghaiDate(iso) { return new Date(iso); }

// 2026-07-17 17:30 上海时间 -> 当日 18:00
assert.strictEqual(nextIpoRefreshDelay(shanghaiDate('2026-07-17T09:30:00Z')), 30 * 60 * 1000);
// 2026-07-17 周五 18:30 -> 下周一 18:00
assert.strictEqual(nextIpoRefreshDelay(shanghaiDate('2026-07-17T10:30:00Z')), 71.5 * 60 * 60 * 1000);
assert(pythonCandidates().length > 0);
assert.strictEqual(path.basename(SCRIPT), 'ipo_daily_report.py');
const valuationSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_valuation.py'), 'utf8');
assert.ok(valuationSource.includes('estimated = board_base'), '新股线性回退模型未使用板块稳健基准');
console.log('PASS=5 FAIL=0');
