const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'js', 'bond-revision.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'bond-revision.css'), 'utf8');
const sharedCss = fs.readFileSync(path.join(root, 'public', 'shared', 'style.css'), 'utf8');
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
const stockAnalysisService = fs.readFileSync(path.join(root, 'server', 'services', 'stockAnalysis.js'), 'utf8');

assert.ok(html.includes('data-sub="revision"') && html.includes('id="sub-bond-revision"'), '缺少下修二级页');
assert.ok(html.includes('css/bond-revision.css?v=3') && html.includes('js/bond-revision.js?v=46'), '下修资源未接入首页');
assert.ok(fs.existsSync(path.join(root, 'public', 'bond-revision-motive.html')) && fs.existsSync(path.join(root, 'public', 'js', 'bond-revision-motive.js')), '缺少下修动机详情页');
assert.ok(page.includes('/api/bond-revision?limit=2000') && page.includes('biz-table'), '下修页必须只读统一接口并使用统一表格');
assert.ok(page.includes('target="_blank"') && page.includes('noopener noreferrer'), '下修动机列表应在新页面打开');
assert.ok(page.includes('bond-revision-near') && page.includes('business_status'), '下修页缺少临近触发筛选和状态展示');
assert.ok(page.includes('BOND_REVISION_OBSERVED') && page.includes('已提议下修（事实）') && page.includes('BOND_REVISION_RESEARCH_LEVEL'), '已确定下修必须展示公告事实，其他对象只展示非预测性的研究等级');
assert.ok(!page.includes("'reset_clause','下修条款'"), '下修页不应展示原始下修条款列');
assert.ok(cycle.includes("sub === 'revision'") && cycle.includes('loadBondRevision'), '二级导航未接入下修页');
assert.ok(route.includes("router.get('/')") || route.includes("router.get('/',"), '下修接口缺少只读路由');
assert.ok(route.includes('getBondRevisionOverview'), '下修接口未读取统一服务');
assert.ok(route.includes('motive-detail') && route.includes('尚无评分数据'), '下修动机详情接口未接入');
assert.ok(service.includes('analytics.convertible_bond_revision_latest') && service.includes("FORMULA_VERSION = 'reset-v2'") && service.includes('CALCULATION_LOGIC_VERSION'), '下修服务未使用统一视图和版本公式');
assert.ok(service.includes("NOT IN ('定向','私募')"), '下修服务必须排除定向私募债券');
assert.ok(service.includes('ORDER BY CASE r.business_status') && service.includes('COALESCE(r.remaining_days,9999)'), '下修接口必须使用数据库状态排序');
assert.ok(!service.includes('sortedRows'), '下修接口不应再以内存排序替代数据库排序');
assert.ok(!service.includes("'reset_clause'"), '下修接口不应返回原始下修条款字段');
assert.ok(analysis.includes('convertible_bond_announcement_history') && analysis.includes('last_success_date') && analysis.includes('scanStart'), '公告同步未按游标增量');
assert.ok(analysis.includes('OVERLAP_DAYS') || analysis.includes('minusCalendarDays'), '公告同步缺少重叠窗口');
assert.ok(migration.includes('090_convertible_bond_revision_monitor') && migration.includes('091_convertible_bond_revision_listed_only')
  && migration.includes('092_convertible_bond_revision_view_lean')
  && migration.includes('093_convertible_bond_revision_term_parser')
  && migration.includes('094_convertible_bond_revision_proposal_expiry')
  && migration.includes('095_convertible_bond_revision_symbolic_lock')
  && migration.includes('101_convertible_bond_revision_status_parity')
  && migration.includes('102_convertible_bond_revision_quality_gate_fix')
  && migration.includes('103_convertible_bond_revision_no_revision_evidence')
  && migration.includes('104_convertible_bond_revision_implemented_lock_evidence')
  && migration.includes('105_convertible_bond_revision_net_asset_floor')
  && migration.includes('106_convertible_bond_revision_net_asset_floor_view_fix')
  && migration.includes('107_convertible_bond_revision_net_asset_floor_same_day')
  && migration.includes('109_convertible_bond_revision_net_asset_floor_phrase')
  && migration.includes('111_convertible_bond_revision_motive')
  && migration.includes('event.convertible_bond_revision_events') && migration.includes('analytics.convertible_bond_revision_latest')
  && migration.includes('FROM latest_market md') && migration.includes('LEFT JOIN LATERAL'), '下修迁移缺少事件表、统一视图或轻量取数路径');
const revisionView = migration.slice(migration.indexOf('async function rebuildConvertibleBondRevisionLatestView'), migration.indexOf('// ========== 091：'));
assert.ok(!revisionView.includes('public.bond_unified'), '下修视图不应展开强赎/上市表现统一视图');
assert.ok(service.includes('active_dm') && service.includes('remaining_days'), '下修计算未限定当前行情日或缺少剩余天数');
assert.ok(service.includes('quality') && service.includes('pending_no_revision_parse') && service.includes('terminal_no_revision_parse') && service.includes('announcement_errors'), '下修接口缺少公告质量门禁');
assert.ok(service.includes('rolling_remaining_days'), '下修接口缺少滚动剩余天数字段');
assert.ok(service.includes('net_asset_floor_value') && service.includes('floor_blocked'), '下修接口未按净资产底线排除不可执行下修');
assert.ok(service.includes('convertible_bond_revision_motive_daily') && service.includes('MOTIVE_SELECT_FIELDS') && service.includes('MOTIVE_MODEL_VERSION'), '下修列表未接入当前版本动机等级快照');
assert.ok(page.includes('BOND_REVISION_RESEARCH_LEVEL') && page.includes('research_level') && !page.includes("row.motive_quality_status !== 'complete'"), '动机等级必须按研究分位展示，且所有行都能进入详情页');
assert.ok(service.includes('implicitSseNoRevisionRestartDate') && service.includes('loadRevisionResponseHistory'), '下修计算缺少上交所次日未公告的隐含重新起算');
assert.ok(analysis.includes('sourceFailures') && analysis.includes('defaultLimit'), '公告同步未保护来源失败或首次全量数量');
assert.ok(analysis.includes("decision === 'no_revision' || period.lock_declared"), '转股价调整公告正文中的不下修决定必须入库');
assert.ok(analysis.includes("['no_revision', 'revised', 'adjusted']") && analysis.includes('cacheComplete'), '实施公告正文锁定期必须进入不下修解析链');
assert.ok(analysis.includes('cachedAnnouncements') && analysis.includes('cached_reparse'), '公告源失败时必须支持从库内官方 PDF 重新解析');
assert.ok(analysis.includes('loadRevisionEventCache') && analysis.includes('revision_event_cache'), '历史实施公告必须支持定点重解析正文锁定期');
assert.ok(analysis.includes('retryFailed') && analysis.includes('changed_count') && analysis.includes('no_revision_evidence'), '公告解析重试和增量计数缺少闭环');
assert.ok(analysis.includes('resolveConvertibleBondSymbolicLocks') && analysis.includes('symbolic_reference_type') && analysis.includes('symbolic_check_from'), '季度报告董事会无固定日期锁定缺少每日定点解析');
assert.ok(analysis.includes('fetchSseEventsBatch') && analysis.includes('fetchSzseEventsBatch') && analysis.includes('fetchCninfoEventsBatch'), '公告同步必须支持交易所批量主取和巨潮备取');
assert.ok(analysis.includes('settled[0].status === \'rejected\'') && !analysis.includes('!primaryEvents.length && (stockCode.endsWith(\'.SH\')'), '正常空公告不得触发巨潮备取');
assert.ok(refresh.includes('calculateConvertibleBondRevisionStatus') && refresh.includes("convertible_bond_revision"), '每日链路未计算下修进度');
assert.ok(refresh.includes('scheduleDaily(7, 40') && refresh.includes('syncConvertibleBondAnnouncementHistories') && refresh.includes('resolveConvertibleBondSymbolicLocks'), '兼容调度未执行下修公告增量和董事会锁定核查');
assert.ok(refresh.includes('pending_parse') && refresh.includes('cachedOnly: true'), '启动补漏未处理公告解析积压');
assert.ok(jobs.includes("convertible_bond_announcement_history_sync") && jobs.includes('hour: 7, minute: 40'), '下修公告任务未纳入日常调度');
assert.ok(jobs.includes('convertible_bond_revision_motive_inputs_sync') && jobs.includes('hour: 7, minute: 20') && jobs.includes('catchupWindowMinutes: 4320'), '动机输入同步任务未纳入日常调度或周末补偿');
for (const [name, source] of Object.entries({ redemptionSync, suspensionSync, ipo, bondAnalysis })) {
  assert.ok(source.includes("NOT IN ('定向','私募')"), `${name} 未排除定向私募债券`);
}
assert.ok(stockAnalysisService.includes("channelCode: ['listedNotice_disc']") && stockAnalysisService.includes('payload.announceCount'), '深交所公告必须使用上市公司公告频道并支持分页');
assert.ok(css.includes('.bond-revision-stats') && css.includes('.bond-revision-status'), '下修样式缺少概览和状态类');
assert.ok(sharedCss.includes('--bond-feature-gradient-start') && html.includes('bond-feature-hero'), '下修页未复用可转债功能页统一视觉');
assert.ok(sharedCss.includes('.bond-feature-toolbar input:not([type=checkbox])')
  && sharedCss.includes('.bond-feature-toolbar input[type=checkbox]')
  && sharedCss.includes('font-size:13px'), '可转债工具栏必须使用固定字号并排除复选框通用输入样式');
assert.ok(page.includes("['remaining_days','当前还差']") && page.includes("['rolling_remaining_days','滚动最快还需']")
  && page.includes("['net_asset_floor_value','每股净资产']") && page.includes('floor_blocked')
  && page.includes('公告数据待补齐'), '下修页未展示双口径剩余天数、净资产底线或质量状态');

console.log('convertible bond revision frontend tests passed');
