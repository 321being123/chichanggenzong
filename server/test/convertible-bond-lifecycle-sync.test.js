const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  OVERLAP_DAYS,
  lifecycleSyncWindow,
  lifecycleCandidates,
  issueSize100m,
} = require('../services/convertibleBondLifecycleSync');
const definitions = require('../services/jobDefinitions');

assert.strictEqual(OVERLAP_DAYS, 3);
assert.strictEqual(issueSize100m(607500000), 6.075);
assert.strictEqual(issueSize100m(6.075), 6.075);
assert.deepStrictEqual(lifecycleSyncWindow('2026-09-07', '2026-09-08'), {
  incremental: true,
  startDate: '2026-09-04',
  endDate: '2026-09-08',
});
assert.deepStrictEqual(lifecycleSyncWindow(null, '2026-09-08'), {
  incremental: false,
  startDate: null,
  endDate: '2026-09-08',
});

const candidates = lifecycleCandidates([
  { source: 'cninfo', source_number: '1', event_date: '2026-09-08', stock_code: '300727',
    title: '向不特定对象发行可转换公司债券发行公告', url: 'https://static.cninfo.com.cn/a.pdf' },
  { source: 'cninfo', source_number: '2', event_date: '2026-09-07', stock_code: '301459',
    title: '向不特定对象发行可转换公司债券上市公告书', url: 'https://static.cninfo.com.cn/b.pdf' },
  { source: 'cninfo', source_number: '3', event_date: '2026-09-08', stock_code: '300001',
    title: '半年度报告', url: 'https://static.cninfo.com.cn/c.pdf' },
]);
assert.deepStrictEqual(candidates.map(item => item.sourceKey), ['1', '2']);

const unified = definitions.getJobDefinition('convertible_bond_announcement_history_sync');
assert.ok(unified.externalApis.includes('cb_issue'));
assert.ok(unified.producesDatasets.includes('bond_issuance_events'));
assert.ok(unified.producesDatasets.includes('bond_redemption_events'));
assert.ok(!definitions.JOB_DEFINITIONS.some(item => item.jobCode === 'convertible_bond_redemption_announcement_sync'));
assert.ok(!definitions.getJobDefinition('convertible_bond_universe_refresh').externalApis.includes('cb_issue'));

const root = path.join(__dirname, '..', '..');
const analysis = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondAnalysis.js'), 'utf8');
const schedule = fs.readFileSync(path.join(root, 'server', 'jobs', 'convertibleBondRefresh.js'), 'utf8');
assert.ok(analysis.includes("includeTushare: mode === 'calendar'"), 'cb_issue 每天只能由晚间生命周期槽采集一次');
assert.ok(!schedule.includes('scheduleDaily(7, 45'), '旧07:45强赎公告任务必须移除');
assert.ok(schedule.includes('scheduleDaily(17, 30'), '兼容调度必须注册晚间生命周期槽');

console.log('OK convertible-bond-lifecycle-sync: 三日增量、统一公告任务和单一cb_issue写入者通过');
