const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { nextIpoHistorySyncDelay, pythonCandidates, SCRIPT } = require('../jobs/ipoHistorySync');

function instant(text) { return new Date(text); }

// 2026-08-11 19:00 上海时间 -> 当日 19:30，30 分钟后。
assert.strictEqual(nextIpoHistorySyncDelay(instant('2026-08-11T11:00:00Z')), 30 * 60 * 1000);
// 周五 20:00 上海时间 -> 下周一 19:30。
assert.strictEqual(nextIpoHistorySyncDelay(instant('2026-08-14T12:00:00Z')), 71.5 * 60 * 60 * 1000);
assert.ok(fs.existsSync(SCRIPT), '独立新股历史同步脚本不存在');
assert.ok(pythonCandidates().length > 0, '没有 Python 候选解释器');

const source = fs.readFileSync(SCRIPT, 'utf8');
assert.match(source, /timedelta\(days=60\)/, '缺少 60 天重叠窗口');
assert.match(source, /返回空结果，已拒绝推进水位/, '空接口未阻止同步成功');
assert.match(source, /COALESCE\(EXCLUDED\.issue_price,old\.issue_price\)/, '空发行价可能覆盖旧值');
assert.match(source, /first_day_retry_count,0\) < 3/, '首日涨幅补偿未限制为 3 次');

const reportSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_report.py'), 'utf8');
assert.match(reportSource, /ipo_date=COALESCE\(\?, ipo_date\)/, '日报详情保存仍遗漏 ipo_date');

console.log('OK ipo-history-sync: 增量窗口、失败保留、补偿次数、申购日保存和 19:30 调度均已覆盖');
