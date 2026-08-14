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
assert.match(source, /def enrich_stock_missing_details\(/, '缺失详情没有定点补全函数');
assert.match(source, /historical_enrichment/, '详情补全未保留来源记录');
assert.match(source, /pending_not_due/, '数据质量未区分尚未到期字段');

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ipo.js'), 'utf8');
assert.match(routeSource, /history_stage/, '新股历史没有阶段字段');
assert.match(routeSource, /field_status/, '新股历史没有字段质量状态');
assert.match(routeSource, /loadStockCalendar\(days\)/, '打新日历没有读取历史事实表');
assert.match(routeSource, /h\.ipo_date <= to_char\(\(timezone\('Asia\/Shanghai', now\(\)\)\)::date/, '新股历史仍只按上市日过滤');
assert.match(routeSource, /'industry'.*pending/s, '未上市新股行业字段未标记待补全');

const bondSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'bondDataService.js'), 'utf8');
assert.match(bondSource, /first_day_return/, '新债历史没有首日表现质量状态');
assert.match(bondSource, /history_stage/, '新债历史没有阶段字段');
assert.match(bondSource, /data_as_of/, '新债历史没有数据日期');
const fetchSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_fetch.py'), 'utf8');
assert.match(fetchSource, /existing_industry=None/, '详情补全没有复用已有行业值');

const firstDaySource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'backfill_bond_firstday.py'), 'utf8');
assert.match(firstDaySource, /NOT EXISTS/, '新债上市表现补偿未按事实表缺口筛选');
assert.match(firstDaySource, /"remaining"/, '新债上市表现补偿没有输出剩余缺口');
const issueResultSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'backfill_bond_shd.py'), 'utf8');
assert.match(issueResultSource, /online_purchase_accounts_10k=COALESCE\(%s,/, '发行结果户数回填单位被重复缩放');
assert.match(issueResultSource, /listing_date <= CURRENT_DATE/, '发行结果补全会误处理未来上市债券');
assert.match(issueResultSource, /source_field_unavailable/, '发行结果缺口没有质量分类');
assert.match(firstDaySource, /listing_date < CURRENT_DATE/, '首日表现补全会误处理尚未形成首日行情的债券');
assert.match(firstDaySource, /source_unavailable/, '首日表现缺口没有质量分类');

const slotSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobScheduleSlots.js'), 'utf8');
assert.match(slotSource, /resultSummary\?\.window_end/, '任务成功判定未使用同步结果日期兜底');
const orchestratorSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobOrchestrator.js'), 'utf8');
assert.match(orchestratorSource, /\['fresh', 'already-ran-today'\]/, '已完成任务仍会被当作跳过反复补偿');
const bondJobSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'convertibleBondAnalysis.js'), 'utf8');
assert.match(bondJobSource, /const result = await syncConvertibleBondUniverse\(reason\)/, '可转债任务没有向调度器返回结果水位');
assert.match(bondJobSource, /backfillBondIssueResults/, '新债发行结果没有进入自动补全链路');
assert.match(bondJobSource, /BOND_ISSUE_RESULT_SCRIPT/, '新债发行结果补全脚本未接入');

const migrationSource = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations.js'), 'utf8');
assert.match(migrationSource, /071_deduplicate_instrument_events/, '重复发行事件没有独立迁移');
assert.match(migrationSource, /uq_instrument_events_business/, '发行事件缺少业务唯一约束');
const bondRefreshSource = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'convertibleBondRefresh.js'), 'utf8');
assert.match(bondRefreshSource, /ipo-report.*venv.*bin.*python/, '估值任务没有 Linux Python 解释器兜底');

const reportSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_report.py'), 'utf8');
assert.match(reportSource, /ipo_date=COALESCE\(\?, ipo_date\)/, '日报详情保存仍遗漏 ipo_date');

console.log('OK ipo-history-sync: 增量窗口、失败保留、补偿次数、申购日保存和 19:30 调度均已覆盖');
