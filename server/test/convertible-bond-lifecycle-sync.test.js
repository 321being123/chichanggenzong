const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  OVERLAP_DAYS,
  lifecycleSyncWindow,
  lifecycleCandidates,
  issueSize100m,
  normalizeBondMasterCode,
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
const { readServiceSource } = require('./helpers/service-source');
const analysis = readServiceSource('convertibleBondAnalysis');
const schedule = fs.readFileSync(path.join(root, 'server', 'jobs', 'convertibleBondRefresh.js'), 'utf8');
assert.ok(analysis.includes("includeTushare: mode === 'calendar'"), 'cb_issue 每天只能由晚间生命周期槽采集一次');
assert.ok(!schedule.includes('scheduleDaily(7, 45'), '旧07:45强赎公告任务必须移除');
assert.ok(schedule.includes('scheduleDaily(17, 30'), '兼容调度必须注册晚间生命周期槽');

// 2026-11-05：异常债券代码不得带着脏值写主档，否则单条上游脏数据会让整批事务回滚。
assert.strictEqual(normalizeBondMasterCode('123291.SZ'), '123291.SZ');
assert.strictEqual(normalizeBondMasterCode('118078.SH'), '118078.SH');
assert.strictEqual(normalizeBondMasterCode('123291'), '123291.SZ');
for (const bad of ['102583523', 'NAN', '', null, undefined, '2026-11-05', 'abcdef', '123291123292']) {
  assert.strictEqual(normalizeBondMasterCode(bad), null, `异常代码必须拦住：${String(bad)}`);
}
const lifecycleSource = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondLifecycleSync.js'), 'utf8');
assert.ok(lifecycleSource.includes('if (!canonicalCode) return null;'), '非法代码不得写主档');
assert.ok(lifecycleSource.includes('excludedInvalidCodes.push'), '被排除的脏代码必须留可查证据');
assert.ok(lifecycleSource.includes('excludedInvalidCodes }'), '排除清单必须回传供质量核对');
const analysisSource = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondAnalysisSync.js'), 'utf8');
assert.ok(analysisSource.includes('excluded_invalid_codes'), '排除清单必须进数据集诊断');

console.log('OK convertible-bond-lifecycle-sync: 三日增量、统一公告任务、单一cb_issue写入者和异常代码守门通过');
