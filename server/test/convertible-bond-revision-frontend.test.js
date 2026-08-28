const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'js', 'bond-revision.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'bond-revision.css'), 'utf8');
const cycle = fs.readFileSync(path.join(root, 'public', 'js', 'bond-cycle.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'server', 'routes', 'bondRevision.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondRevisionService.js'), 'utf8');
const analysis = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondAnalysis.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'server', 'db', 'migrations.js'), 'utf8');
const refresh = fs.readFileSync(path.join(root, 'server', 'jobs', 'convertibleBondRefresh.js'), 'utf8');
const jobs = fs.readFileSync(path.join(root, 'server', 'services', 'jobDefinitions.js'), 'utf8');
const redemptionSync = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondRedemptionSync.js'), 'utf8');
const suspensionSync = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondSuspensionSync.js'), 'utf8');
const ipo = fs.readFileSync(path.join(root, 'server', 'routes', 'ipo.js'), 'utf8');
const bondAnalysis = fs.readFileSync(path.join(root, 'server', 'routes', 'bondAnalysis.js'), 'utf8');

assert.ok(html.includes('data-sub="revision"') && html.includes('id="sub-bond-revision"'), '缺少下修二级页');
assert.ok(html.includes('css/bond-revision.css') && html.includes('js/bond-revision.js'), '下修资源未接入首页');
assert.ok(page.includes('/api/bond-revision?limit=2000') && page.includes('biz-table'), '下修页必须只读统一接口并使用统一表格');
assert.ok(page.includes('bond-revision-near') && page.includes('business_status'), '下修页缺少临近触发筛选和状态展示');
assert.ok(cycle.includes("sub === 'revision'") && cycle.includes('loadBondRevision'), '二级导航未接入下修页');
assert.ok(route.includes("router.get('/')") || route.includes("router.get('/',"), '下修接口缺少只读路由');
assert.ok(route.includes('getBondRevisionOverview'), '下修接口未读取统一服务');
assert.ok(service.includes('analytics.convertible_bond_revision_latest') && service.includes("FORMULA_VERSION = 'reset-v2'"), '下修服务未使用统一视图和版本公式');
assert.ok(service.includes("NOT IN ('定向','私募')"), '下修服务必须排除定向私募债券');
assert.ok(analysis.includes('convertible_bond_announcement_history') && analysis.includes('last_success_date') && analysis.includes('scanStart'), '公告同步未按游标增量');
assert.ok(analysis.includes('OVERLAP_DAYS') || analysis.includes('minusCalendarDays'), '公告同步缺少重叠窗口');
assert.ok(migration.includes('090_convertible_bond_revision_monitor') && migration.includes('091_convertible_bond_revision_listed_only')
  && migration.includes('event.convertible_bond_revision_events') && migration.includes('analytics.convertible_bond_revision_latest')
  && migration.includes('JOIN latest_market md'), '下修迁移缺少事件表、统一视图或上市范围约束');
assert.ok(service.includes('active_dm') && service.includes('remaining_days'), '下修计算未限定当前行情日或缺少剩余天数');
assert.ok(analysis.includes('sourceFailures') && analysis.includes('defaultLimit'), '公告同步未保护来源失败或首次全量数量');
assert.ok(refresh.includes('calculateConvertibleBondRevisionStatus') && refresh.includes("convertible_bond_revision"), '每日链路未计算下修进度');
assert.ok(refresh.includes('scheduleDaily(7, 40') && refresh.includes('syncConvertibleBondAnnouncementHistories'), '兼容调度未执行下修公告增量');
assert.ok(jobs.includes("convertible_bond_announcement_history_sync") && jobs.includes('hour: 7, minute: 40'), '下修公告任务未纳入日常调度');
for (const [name, source] of Object.entries({ redemptionSync, suspensionSync, ipo, bondAnalysis })) {
  assert.ok(source.includes("NOT IN ('定向','私募')"), `${name} 未排除定向私募债券`);
}
assert.ok(css.includes('.bond-revision-stats') && css.includes('.bond-revision-status'), '下修样式缺少概览和状态类');

console.log('convertible bond revision frontend tests passed');
