const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { nextIpoHistorySyncDelay, nextIpoHistorySchedule, pythonCandidates, SCRIPT } = require('../jobs/ipoHistorySync');

function instant(text) { return new Date(text); }

// 2026-08-11 19:00 上海时间 -> 当日 19:30 补全，30 分钟后。
assert.strictEqual(nextIpoHistorySyncDelay(instant('2026-08-11T11:00:00Z')), 30 * 60 * 1000);
assert.strictEqual(nextIpoHistorySchedule(instant('2026-08-11T11:00:00Z')).mode, 'enrichment');
// 周五 20:00 上海时间 -> 下周一 18:00 核心事实同步。
assert.strictEqual(nextIpoHistorySyncDelay(instant('2026-08-14T12:00:00Z')), 70 * 60 * 60 * 1000);
assert.strictEqual(nextIpoHistorySchedule(instant('2026-08-14T12:00:00Z')).mode, 'core');
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
assert.match(source, /"quality_status": "passed"/, 'IPO事实分区缺少质量通过状态');
assert.match(source, /"target_date": target_date/, 'IPO事实分区缺少目标日期');
assert.match(source, /"security_set_hash": security_set_hash/, 'IPO事实分区缺少证券集合哈希');
assert.match(source, /"ingestion_run_id": run_id/, 'IPO事实分区缺少采集批次');
assert.match(source, /"missing_listing_date_count": missing_listing_date_count/, 'IPO事实分区缺少上市日缺失诊断');

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ipo.js'), 'utf8');
const hkexSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'hkexIpo.js'), 'utf8');
assert.match(routeSource, /history_stage/, '新股历史没有阶段字段');
assert.match(routeSource, /field_status/, '新股历史没有字段质量状态');
assert.match(routeSource, /loadStockCalendar\(days\)/, '打新日历没有读取历史事实表');
assert.match(routeSource, /h\.ipo_date <= to_char\(\(timezone\('Asia\/Shanghai', now\(\)\)\)::date/, '新股历史仍只按上市日过滤');
assert.match(routeSource, /'industry'.*pending/s, '未上市新股行业字段未标记待补全');
assert.match(routeSource, /security_name_cn/, '港股历史没有中文名称字段');
assert.match(routeSource, /actual_return/, '港股历史没有实际涨幅字段');
assert.match(routeSource, /lot_profit/, '港股历史没有单签收益字段');
assert.match(routeSource, /online_lottery_rate/, '港股历史没有一手中签率字段');
assert.match(routeSource, /allotment_at/, '港股历史没有配售结果日期字段');
assert.match(routeSource, /application_fee_hkd/, '港股历史没有申请费用字段');
assert.match(routeSource, /brokerage_fee_hkd/, '港股历史没有佣金字段');
assert.match(routeSource, /public_oversubscription/, '港股历史没有超额认购倍数字段');
assert.match(routeSource, /greenshoe_details/, '港股历史没有绿鞋保护字段');
assert.match(routeSource, /greenshoe_protection_ratio/, '港股历史没有绿鞋保护比例字段');
assert.match(routeSource, /greenshoe_final_public_offer_shares/, '港股历史没有最终公开发售股数字段');
assert.match(hkexSource, /overAllocatedShares[\s\S]*publicOfferShares/, '绿鞋比例缺少历史缺口补全条件');
assert.match(hkexSource, /finalPublicOfferShares/, '港股配发没有保存回拨后最终公开发售股数');
assert.match(hkexSource, /final_public_offer_after_reallocation/, '绿鞋比例没有锁定回拨后最终公开发售口径');
const ipoPageSource = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ipo.js'), 'utf8');
assert.match(ipoPageSource, /发行价（港元）/, '港股发行价标题没有标注港元');
assert.match(ipoPageSource, /ipoHkStageLabel/, '港股阶段没有中文映射');
assert.match(ipoPageSource, /ipoIntegerCell/, '港股每手股数没有整数格式化');
assert.match(ipoPageSource, /ipoHkAllotmentCell/, '港股配售结果没有展示日期和一手中签率');
assert.match(ipoPageSource, /申请费用（含佣金及征费，港元）/, '港股申请费用标题没有说明口径');
assert.match(ipoPageSource, /预测涨幅.*实际涨幅.*单签收益（港元）/, '港股历史缺少三项表现列');
assert.match(ipoPageSource, /超额认购倍数/, '港股历史缺少超额认购倍数列');
assert.match(ipoPageSource, /ipoHkGreenshoeCell/, '港股历史缺少绿鞋保护展示');
assert.match(ipoPageSource, /绿鞋\/公开发售/, '港股历史没有展示绿鞋保护比例');
assert.match(ipoPageSource, /ratioRaw === null/, '绿鞋比例空值不能误显示为 0%');

const bondSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'bondDataService.js'), 'utf8');
assert.match(bondSource, /first_day_return/, '新债历史没有首日表现质量状态');
assert.match(bondSource, /history_stage/, '新债历史没有阶段字段');
assert.match(bondSource, /data_as_of/, '新债历史没有数据日期');
const fetchSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_fetch.py'), 'utf8');
assert.match(fetchSource, /existing_industry=None/, '详情补全没有复用已有行业值');
assert.match(fetchSource, /_split_embedded_industry/, '旧主营文本未拆分行业字段');
assert.match(fetchSource, /仪器仪表/, '行业PE缺少仪器仪表行业别名');
const sectorSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_sector.py'), 'utf8');
assert.match(sectorSource, /电子测量仪器/, '电子测量仪器未纳入赛道识别');
assert.match(sectorSource, /classification_status/, '赛道分类未区分行业兜底与资料缺失');

const firstDaySource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'backfill_bond_firstday.py'), 'utf8');
assert.match(firstDaySource, /NOT EXISTS/, '新债上市表现补偿未按事实表缺口筛选');
assert.match(firstDaySource, /"remaining"/, '新债上市表现补偿没有输出剩余缺口');
const issueResultSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'backfill_bond_shd.py'), 'utf8');
assert.match(issueResultSource, /online_purchase_accounts_10k=COALESCE\(%s,/, '发行结果户数回填单位被重复缩放');
assert.match(issueResultSource, /res_ann_date::date <= CURRENT_DATE/, '发行结果补全没有按结果公告到期时间筛选');
assert.match(issueResultSource, /re\.sub\(r'\\s\+'/, '发行结果 PDF 拆行会导致申请户数漏解析');
assert.match(issueResultSource, /source_field_unavailable/, '发行结果缺口没有质量分类');
assert.match(firstDaySource, /listing_date < CURRENT_DATE/, '首日表现补全会误处理尚未形成首日行情的债券');
assert.match(firstDaySource, /source_unavailable/, '首日表现缺口没有质量分类');

const slotSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobScheduleSlots.js'), 'utf8');
assert.match(slotSource, /resultSummary\?\.window_end/, '任务成功判定未使用同步结果日期兜底');
const orchestratorSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobOrchestrator.js'), 'utf8');
assert.match(orchestratorSource, /\['fresh', 'already-ran-today'\]/, '已完成任务仍会被当作跳过反复补偿');
const historyJobSource = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'ipoHistorySync.js'), 'utf8');
assert.match(historyJobSource, /parseTushareFailovers/, 'Python 成功切备用后的接口标记未进入 Node 解析链');
assert.match(historyJobSource, /notifyTushareFailovers/, 'Python 成功切备用后的接口告警未接入');
const bondJobSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'convertibleBondAnalysis.js'), 'utf8');
assert.match(bondJobSource, /const result = await syncConvertibleBondUniverse\(reason, \{ targetTradeDate \}\)/, '可转债任务没有向调度器返回结果水位');
assert.match(bondJobSource, /backfillBondIssueResults/, '新债发行结果没有进入自动补全链路');
assert.match(bondJobSource, /BOND_ISSUE_RESULT_SCRIPT/, '新债发行结果补全脚本未接入');
assert.match(bondJobSource, /backfillBondListingLiquidity/, '新债流通规模没有进入现有生命周期同步链路');
assert.match(bondJobSource, /BOND_LIQUIDITY_SCRIPT/, '新债流通规模补全脚本未接入');
const liquiditySource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'sync_bond_listing_liquidity.py'), 'utf8');
assert.match(liquiditySource, /event_type='listing'/, '流通规模补全没有按上市事件增量筛选');
assert.match(liquiditySource, /l\.instrument_id IS NULL/, '流通规模补全没有跳过已入库事实');
assert.match(liquiditySource, /if code not in forced_codes and get_listing_liquidity\(code\)/, '指定代码定向重算没有覆盖旧流通规模事实');
assert.match(liquiditySource, /else:\s*\n\s*clauses\.append\("l\.instrument_id IS NULL"\)/, '指定代码定向重算不应改变普通增量跳过规则');
assert.match(fetchSource, /_parse_listed_bond_quantity/, '上市公告书明确上市数量没有解析兜底');
assert.match(fetchSource, /listed_quantity_fallback/, '上市数量兜底没有保留质量标记');

const migrationSource = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations.js'), 'utf8');
assert.match(migrationSource, /071_deduplicate_instrument_events/, '重复发行事件没有独立迁移');
assert.match(migrationSource, /uq_instrument_events_business/, '发行事件缺少业务唯一约束');
const bondRefreshSource = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'convertibleBondRefresh.js'), 'utf8');
assert.match(bondRefreshSource, /ipo-report.*venv.*bin.*python/, '估值任务没有 Linux Python 解释器兜底');

const reportSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_report.py'), 'utf8');
assert.match(reportSource, /所属行业/, '新股日报详情未展示所属行业');
assert.match(reportSource, /ipo_date=COALESCE\(\?, ipo_date\)/, '日报详情保存仍遗漏 ipo_date');
assert.match(reportSource, /def reconcile_report_calendar_sets\(/, '日报发布前缺少日历证券集合对账');
assert.match(reportSource, /拒绝发布并保留上一份有效结果/, '集合不一致时没有拒绝覆盖旧日报');

console.log('OK ipo-history-sync: 增量窗口、失败保留、18:00核心事实和19:30补全调度均已覆盖');
