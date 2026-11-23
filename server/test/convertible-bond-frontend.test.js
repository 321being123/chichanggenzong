// 可转债前端合并测试（合并原 convertible-bond-frontend / motive-frontend / revision-frontend）。
'use strict';
(async () => {

  // --- convertible-bond-frontend.test.js ---
  await (async () => {
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'js', 'bond-analysis.js'), 'utf8');
// 批次4：可转债侧取数已拆入 Presenter，接口接入断言跟随代码指向 Presenter，其余渲染断言仍查 View。
const bondPresenter = fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'bond-analysis-presenter.js'), 'utf8');
const { readServiceSource } = require('./helpers/service-source');
const service = readServiceSource('convertibleBondAnalysis');
const priceChangeAudit = fs.readFileSync(path.join(root, 'server', 'scripts', 'auditConvertibleBondPriceChanges.js'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'server', 'services', 'jobRunners.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'stock-analysis.css'), 'utf8');

assert.ok(html.includes('data-main="stock-analysis"'), '缺少个券分析导航入口（研究工具下拉子项）');
assert.ok(html.includes('id="bond-analysis-content"'), '缺少可转债分析结果区');
assert.ok(html.includes('id="security-analysis-select"'), '缺少持仓和自选入口');
assert.ok(script.includes("'security-analysis-select'"), '持仓和自选下拉填充引用的 id 必须与 index.html 一致，否则选项为空');
{
  // 批次4：股票分析的加载编排已迁入 Presenter，等待列表填充的断言需覆盖 View＋Presenter。
  const stockScript = fs.readFileSync(path.join(root, 'public', 'js', 'stock-analysis.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'stock-analysis-presenter.js'), 'utf8');
  assert.ok(!stockScript.includes('stock-analysis-select'), 'stock-analysis.js 不得再引用已废弃的下拉 id stock-analysis-select（现为 security-analysis-select）');
  assert.ok(/await\s+window\.securityAnalysisLoadList\(/.test(stockScript), '加载分析页时必须等待持仓和自选列表填充完成，否则加自选后无法自动回选');
}
assert.ok(html.includes('js/bond-analysis.js'), '缺少可转债前端脚本');
assert.ok(bondPresenter.includes('/api/bond-analysis/'), '前端未接入可转债分析接口');
for (const field of ['强赎触发价','基金持仓','预估回售触发日','下修天计数','募资用途','转股价调整历史','转股价不下修历史','利息保障倍数','纯债价值','理论偏离度','正股年化波动率','资产负债率']) {
  assert.ok((html+script).includes(field), '可转债页面缺少字段：'+field);
}
assert.ok(script.includes("['到期赎回价'") && script.includes("['回售价'"), '募集用途与条款缺少到期赎回价后的回售价');
assert.ok(script.includes('bondAnalysisTable') && script.includes('bondAnalysisListTable'), '可转债结果必须使用表格展示');
assert.ok(!script.includes("['转股条款'"), '可转债页面不应继续展示转股条款');
for (const text of ['利息保障倍数（符合：≥7）','到期税前收益率（YTM）','尚未进入回售期']) assert.ok(script.includes(text), '缺少计算说明：'+text);
for (const text of ['原转股价','下修到底','下修不到底','占剩余规模：']) assert.ok(script.includes(text), '缺少转债新增展示：'+text);
assert.ok(script.includes("if(/回购注销/.test(reason)) return '回购注销';"), '回购注销导致转股价上调未单独分类');
assert.ok(service.includes("model: 'Black-Scholes'") && script.includes('option.model'), '缺少Black-Scholes模型或前端展示');
assert.ok(css.includes('.bond-analysis-table tr:last-child th,.bond-analysis-table tr:last-child td{border-bottom:'), '可转债表格末行边框缺失');
assert.ok(script.includes('put_opportunity_used'), '回售展示未处理本计息年度机会已使用状态');
assert.ok(css.includes('#bond-analysis-price-history .bond-analysis-table th:nth-child(7){width:36%}'), '转股价历史说明列宽度不足');
assert.ok(script.includes('查看募集说明书') && script.includes('coupon_source_url'), '募集说明书或利息明细入口缺失');
assert.ok(script.includes('bond-analysis-delisted') && script.includes('已退市'), '退市转债缺少醒目标识');
assert.ok(css.includes('.bond-analysis-summary .bond-analysis-delisted'), '退市标识缺少样式');
assert.ok(!/tushareQuery\(['"]cb_price_chg/.test(service + priceChangeAudit),
  '转股价历史只能走公告解析链路，不得重新调用无权限的 cb_price_chg');
assert.ok(service.includes('analytics.convertible_bond_announcement_history'), '股债分析历史必须读取统一公告事实视图');
assert.ok(!service.includes("fetchCninfoEvents(stockCode, announcementWindowStart, end, '转股价格')")
  && !service.includes("fetchSseEvents(stockCode, announcementWindowStart, end, '转股价格')")
  && !service.includes("fetchSzseEvents(stockCode, announcementWindowStart, end, '转股价格')"),
  '股债分析请求不得再次直接抓取转股价公告');
assert.ok(service.includes('syncConvertibleBondAnnouncementHistories') && runner.includes('convertible_bond_announcement_history_sync'),
  '下修和转股价公告必须由独立同步任务入库');

console.log('convertible bond frontend tests passed');

  })();

  // --- convertible-bond-motive-frontend.test.js ---
  await (async () => {
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const service = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondRevisionMotiveService.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'repositories', 'convertibleBondRevisionMotiveServiceRepository.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'repositories', 'convertibleBondRevisionMotiveServiceRepository.js'), 'utf8');
// 2026-10-31 数据层收口：持有人与质押的取数（含字段契约与 allowEmpty）收到 dataAccess，
// 断言同时覆盖服务与数据层，检查意义不变。
const datasetsSource = fs.readFileSync(path.join(root, 'server', 'dataAccess', 'bondDatasets.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'dataAccess', 'referenceDatasets.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'bond-revision-motive.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'js', 'bond-revision-motive.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'bond-revision-motive.css'), 'utf8');

// 2026-10-31 数据层收口：持有人与质押的取数收到 dataAccess，服务只调中立需求接口。
assert.ok(service.includes('readBondTopHolders') && service.includes('readPledgeStats'), '持有人和质押同步接口缺失');
assert.ok(!/tushareQuery\('(top10_cb_holders|pledge_stat)'/.test(service), '服务层不得直接调用持有人/质押供应商接口');
assert.ok(!service.includes('TUSHARE_ENABLE_5000_ENDPOINTS') && service.includes("dataset: 'top10_cb_holders'") && service.includes("dataset: 'pledge_stat'"), '持有人和质押同步不应被同一个权限开关整体拦截');
assert.ok(service.includes('holderStopError') && service.includes('pledgeStopError') && service.includes('RATE_LIMIT') && service.includes('CIRCUIT_OPEN') && service.includes('md.trade_date'), '同步任务应区分单对象空结果与接口限速并只处理当前行情候选');
assert.ok(service.includes('hcur.last_attempt_at') && service.includes('pcur.last_attempt_at'), '单对象空结果应按最近尝试时间后置，避免补数批次反复卡在同一批');
assert.ok(service.includes('holderAttempted && !holderError') && service.includes('pledgeAttempted && !pledgeError'), '正常空结果必须推进游标并保留后续复查机会');
assert.ok(!service.includes('MAX_HOLDER_CALLS_PER_RUN') && !service.includes('holderCallsThisRun'), '不得用业务代码自设持有人接口批次数量上限');
assert.ok(service.includes('const configuredLimit') && service.includes('limitClause') && service.includes('continuationRequired'), '显式调试批次必须走统一限流并保留续跑语义');
assert.ok(service.includes('holderAttempted && !holderError') && service.includes('pledgeAttempted && !pledgeError'), '未实际请求的对象不得被误记为空结果成功');
assert.ok((datasetsSource.match(/allowEmpty/g) || []).length >= 2, '持有人和质押接口的正常空结果不得被误记为失败（口径落在数据层）');
assert.ok(service.includes('raw_records') && service.includes('sync_cursors'), '同步任务缺少原始响应或游标留痕');
assert.ok((service + datasetsSource).includes('hold_amount,hold_ratio')
  && (service + datasetsSource).includes('pledge_count,unrest_pledge,rest_pledge,total_share,pledge_ratio'), 'Tushare字段契约未锁定');
assert.ok(!service.includes("top10_cb_holders', holderParams, 'ts_code,end_date,ann_date") && !service.includes("pledge_stat', pledgeParams, 'ts_code,end_date,pledge_amount"), '不得请求接口不支持的字段');
assert.ok(service.includes('announced_at IS NOT NULL AND announced_at <= $2'), '历史评分必须按公告可见日隔离');
assert.ok(service.includes('same report period') || service.includes('同一报告期'), '财务指标应锁定同一报告期');
assert.ok(service.includes("upper(COALESCE(r.raw_payload->>'ts_code',''))=upper($3)"), '可转债动机财报必须锁定正股报告代码');
assert.ok(html.includes('motive-inputs') && !html.includes('motive-sources') && html.includes('返回可转债监控'), '详情页结构不完整');
assert.ok(html.includes('href="/?main=bond-safety&sub=revision"') && html.indexOf('bond-motive-back') < html.indexOf('bond-feature-hero'), '返回链接应位于蓝色标题外');
assert.ok(script.includes('raw_value') && script.includes('input_snapshot') && script.includes('financialText') && script.includes('cycleText') && script.includes('holderText') && script.includes('controllerText') && !script.includes('proposalHistoryText') && !script.includes('motive-json'), '详情页原始输入展示不符合要求');
assert.ok(script.includes('<details class="motive-calculations" open>') && script.includes('motive-cycle-line'), '计算项应默认展开且历史下修应逐轮换行');
assert.ok(!service.includes("proposal_monthly_count") && !service.includes("市场每月提议下修次数"), '无意义的市场每月提议次数不应再进入详情输入或计算项');
assert.ok(script.includes('motive-core') && script.includes('dimensionNames') && script.includes('calculations'), '详情页缺少核心动机或五维计算项');
assert.ok(script.includes('dimensionScoreTotal') && script.includes('motive-dimension-total') && script.includes('五项合计'), '详情页缺少五项评分合计');
assert.ok(script.includes('研究等级') && script.includes('relative_high') && script.includes('observed_empty'), '详情页缺少相对研究等级或空质押核验状态');
assert.ok(script.includes('bond_price_percentile') && script.includes('remain_issue_ratio') && script.includes('market_cap') && script.includes('亿元') && script.includes("toFixed(2)"), '详情页未格式化百分位、比例、金额或年数');
assert.ok(script.includes("'false': '否'") && script.includes('displayText'), '详情页仍可能展示英文状态值');
assert.ok(!script.includes('sourceCell') && !script.includes('source_references'), '详情页不应展示来源引用');
assert.ok(css.includes('.motive-calculations') && !css.includes('.motive-json'), '详情页计算项或JSON样式不符合要求');
assert.ok(css.includes('.motive-input-table') && css.includes('table-layout:fixed') && css.includes('overflow-wrap:anywhere') && css.includes('.motive-hero h1') && css.includes('align-items:center'), '详情页长文本换行或标题垂直居中样式缺失');
assert.ok(!script.includes('Tushare') && !script.includes('tushareQuery'), '详情页不得调用外部数据接口');

console.log('convertible-bond-motive-frontend.test.js 通过');

  })();

  // --- convertible-bond-revision-frontend.test.js ---
  await (async () => {
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'js', 'bond-revision.js'), 'utf8');
// 批次4：下修页已拆为 View（渲染）与 Presenter（状态/取数），取数断言指向 presenter。
const presenter = fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'bond-revision-presenter.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'bond-revision.css'), 'utf8');
const sharedCss = fs.readFileSync(path.join(root, 'public', 'shared', 'style.css'), 'utf8');
const cycle = fs.readFileSync(path.join(root, 'public', 'js', 'bond-cycle.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'server', 'routes', 'bondRevision.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondRevisionService.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'repositories', 'convertibleBondRevisionServiceRepository.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'repositories', 'convertibleBondRevisionServiceRepository.js'), 'utf8');
const { readServiceSource } = require('./helpers/service-source');
const analysis = readServiceSource('convertibleBondAnalysis');
const { readMigrationSource } = require('./helpers/migration-source');
const migration = readMigrationSource();
const refresh = fs.readFileSync(path.join(root, 'server', 'jobs', 'convertibleBondRefresh.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'repositories', 'convertibleBondRefreshRepository.js'), 'utf8');
const jobs = fs.readFileSync(path.join(root, 'server', 'services', 'jobDefinitions.js'), 'utf8');
const redemptionSync = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondRedemptionSync.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'repositories', 'convertibleBondRedemptionSyncRepository.js'), 'utf8');
const suspensionSync = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondSuspensionSync.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'repositories', 'convertibleBondSuspensionSyncRepository.js'), 'utf8');
const ipo = fs.readFileSync(path.join(root, 'server', 'routes', 'ipo.js'), 'utf8');
// 批次3：IPO 的 SQL 已迁入仓储，定向/私募排除规则随之落位，证券检索断言指向真实实现。
const ipoRepositorySource = fs.readFileSync(path.join(root, 'server', 'repositories', 'ipoRepository.js'), 'utf8');
const bondAnalysis = fs.readFileSync(path.join(root, 'server', 'routes', 'bondAnalysis.js'), 'utf8');
// 可转债证券检索 SQL 已按批次3 迁入仓储，定向/私募排除规则随之落在仓储内，断言须指向真实实现位置。
const bondAnalysisRepository = fs.readFileSync(path.join(root, 'server', 'repositories', 'bondAnalysisRepository.js'), 'utf8');
const stockAnalysisService = fs.readFileSync(path.join(root, 'server', 'services', 'stockAnalysis.js'), 'utf8')
  + fs.readFileSync(path.join(root, 'server', 'repositories', 'stockAnalysisRepository.js'), 'utf8')
  // 批次4：公告采集与来源映射已迁入数据接入层，断言同时覆盖适配器，避免搬移让检查静默失效。
  + '\n' + fs.readFileSync(path.join(root, 'server', 'dataAccess', 'adapters', 'announcementSourceAdapter.js'), 'utf8');

assert.ok(html.includes('data-sub="revision"') && html.includes('id="sub-bond-revision"'), '缺少下修二级页');
assert.ok(html.includes('css/bond-revision.css?v=__APP_VERSION__') && html.includes('js/bond-revision.js?v=__APP_VERSION__'), '下修资源未接入首页');
assert.ok(fs.existsSync(path.join(root, 'public', 'bond-revision-motive.html')) && fs.existsSync(path.join(root, 'public', 'js', 'bond-revision-motive.js')), '缺少下修动机详情页');
assert.ok(presenter.includes('/api/bond-revision?limit=2000') && page.includes('biz-table'), '下修页必须只读统一接口并使用统一表格');
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
assert.ok(/WHEN 'implemented' THEN 1[\s\S]*WHEN 'proposed' THEN 2/.test(service), '已实施下修必须排在列表前列');
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
  && migration.includes('132_convertible_bond_revision_decision_timeline')
  && migration.includes('133_convertible_bond_revision_legacy_false_facts')
  && migration.includes('event.convertible_bond_revision_events') && migration.includes('analytics.convertible_bond_revision_latest')
  && migration.includes('FROM latest_market md') && migration.includes('LEFT JOIN LATERAL'), '下修迁移缺少事件表、统一视图或轻量取数路径');
assert.ok(migration.includes('ev.announced_at >= nr.announced_at') && migration.includes('ev.announced_at > nr.announced_at')
  && migration.includes("nr.announced_at >= COALESCE(ev.announced_at"), '下修视图未按事实公告时间线决定状态优先级');
const revisionView = migration.slice(migration.indexOf('async function rebuildConvertibleBondRevisionLatestView'), migration.indexOf('// ========== 091：'));
assert.ok(!revisionView.includes('public.bond_unified'), '下修视图不应展开强赎/上市表现统一视图');
assert.ok(service.includes('active_dm') && service.includes('remaining_days'), '下修计算未限定当前行情日或缺少剩余天数');
assert.ok(service.includes('quality') && service.includes('pending_no_revision_parse') && service.includes('terminal_no_revision_parse') && service.includes('announcement_errors'), '下修接口缺少公告质量门禁');
assert.ok(service.includes('decision_status_conflicts') && service.includes('latest_revision_event'), '下修接口缺少事实时间线冲突审计');
assert.ok(service.includes('firstOpenDateAfter') && service.includes('legacyMalformedNoRevision'), '下修计算缺少不下修公告后的重新起算和旧解析结果保护');
assert.ok(service.includes('rolling_remaining_days'), '下修接口缺少滚动剩余天数字段');
assert.ok(service.includes('net_asset_floor_value') && service.includes('floor_blocked'), '下修接口未按净资产底线排除不可执行下修');
assert.ok(service.includes('convertible_bond_revision_motive_daily') && service.includes('MOTIVE_SELECT_FIELDS') && service.includes('MOTIVE_MODEL_VERSION'), '下修列表未接入当前版本动机等级快照');
assert.ok(page.includes('BOND_REVISION_RESEARCH_LEVEL') && page.includes('research_level') && !page.includes("row.motive_quality_status !== 'complete'"), '动机等级必须按研究分位展示，且所有行都能进入详情页');
assert.ok(service.includes('implicitSseNoRevisionRestartDate') && service.includes('loadRevisionResponseHistory'), '下修计算缺少上交所次日未公告的隐含重新起算');
assert.ok(analysis.includes('sourceFailures') && analysis.includes('configuredLimit') && analysis.includes('continuationRequired'), '公告同步未保护来源失败或显式批次续跑语义');
assert.ok(analysis.includes("decision === 'no_revision' || period.lock_declared"), '转股价调整公告正文中的不下修决定必须入库');
assert.ok(analysis.includes("['no_revision', 'revised', 'adjusted']") && analysis.includes('cacheComplete'), '实施公告正文锁定期必须进入不下修解析链');
assert.ok(analysis.includes('cachedAnnouncements') && analysis.includes('cached_reparse'), '公告源失败时必须支持从库内官方 PDF 重新解析');
assert.ok(analysis.includes('parserNeedsReparse') && analysis.includes('latestNoRevision.next_eligible_date == null || !latestNoRevision.lock_declared'), '旧解析器产生的未来日期未进入定点重解析候选');
assert.ok(analysis.includes('loadRevisionEventCache') && analysis.includes('revision_event_cache'), '历史实施公告必须支持定点重解析正文锁定期');
assert.ok(analysis.includes('retryFailed') && analysis.includes('changed_count') && analysis.includes('no_revision_evidence'), '公告解析重试和增量计数缺少闭环');
assert.ok(analysis.includes('resolveConvertibleBondSymbolicLocks') && analysis.includes('symbolic_reference_type') && analysis.includes('symbolic_check_from'), '季度报告董事会无固定日期锁定缺少每日定点解析');
assert.ok(analysis.includes('fetchSseEventsBatch') && analysis.includes('fetchSzseEventsBatch') && analysis.includes('fetchCninfoEventsBatch'), '公告同步必须使用交易所主链并具备CNINFO分页备援');
assert.ok(analysis.includes('{ maxAttempts = 2 }') && analysis.includes('attempt <= attempts')
  && analysis.includes('分页未完整') && analysis.includes('已重试${attempts - 1}次'), '公告批量源默认必须执行一次有界重试，并允许受控修复显式扩大并发退避次数');
assert.strictEqual(require('../services/jobDefinitions').getJobDefinition('convertible_bond_announcement_history_sync').maxExternalCallsPerRun, null, '公告事实同步不得设置臆造的内部单批上限');
assert.ok(migration.includes('137_convertible_bond_exchange_announcement_unlimited') && migration.includes('internal_per_minute_limit=NULL') && migration.includes('internal_daily_limit=NULL') && migration.includes('min_interval_ms=0'), '交易所公告迁移必须取消分钟/日和间隔内部预算');
assert.ok(analysis.includes('const rejected = settled.filter(item => item.status === \'rejected\')')
  && !analysis.includes('fetchCninfoEventsByYear(stockCode, start, end, \'转股价格\'')
  && !redemptionSync.includes("require('./cninfoAnnouncement')"), '个股公告失败不得走旧版巨潮单证券备取');
assert.ok(refresh.includes('calculateConvertibleBondRevisionStatus') && refresh.includes("convertible_bond_revision"), '每日链路未计算下修进度');
assert.ok(refresh.includes('scheduleDaily(7, 40') && refresh.includes('syncConvertibleBondAnnouncementHistories') && refresh.includes('resolveConvertibleBondSymbolicLocks'), '兼容调度未执行下修公告增量和董事会锁定核查');
assert.ok(refresh.includes('pending_parse') && refresh.includes('cachedOnly: true') && refresh.includes('parser_version IS DISTINCT FROM'), '启动补漏未处理旧解析器积压');
assert.ok(jobs.includes("convertible_bond_announcement_history_sync") && jobs.includes('hour: 7, minute: 40'), '下修公告任务未纳入日常调度');
assert.ok(jobs.includes('convertible_bond_revision_motive_inputs_sync') && jobs.includes('hour: 7, minute: 20') && jobs.includes('catchupWindowMinutes: 4320'), '动机输入同步任务未纳入日常调度或周末补偿');
for (const [name, source] of Object.entries({ redemptionSync, suspensionSync })) {
  assert.ok(source.includes("NOT IN ('定向','私募')"), `${name} 未排除定向私募债券`);
}
assert.ok(bondAnalysisRepository.includes("NOT IN ('定向','私募')"), 'bondAnalysis 未排除定向私募债券');
assert.ok(ipoRepositorySource.includes("NOT IN ('定向','私募')"), 'ipo 未排除定向私募债券');
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

  })();
})().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
