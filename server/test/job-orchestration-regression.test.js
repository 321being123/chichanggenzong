const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const adminRoute = read('server/routes/admin.js');
const slots = read('server/services/jobScheduleSlots.js');
const orchestrator = read('server/services/jobOrchestrator.js');
const jobRunners = read('server/services/jobRunners.js');
const scheduler = read('server/scheduler.js');
const alertMailer = read('server/services/jobAlertMailer.js');
const testRunner = read('server/test/run-all.js');
const health = read('server/scripts/checkWorkerHealth.js');
const adminUi = read('public/js/admin.js');
const ipoJob = read('server/jobs/ipoCalendarRefresh.js');
const definitions = read('server/services/jobDefinitions.js');
const deployScript = read('deploy/deploy_password.py');
const config = read('server/config.js');
const jobsDb = read('server/db/jobs.js');
const migrations = read('server/db/migrations.js');
const marketClose = read('server/jobs/marketClose.js');
const arbitrageJob = read('server/jobs/arbitrageSync.js');
const arbitrageSync = read('server/services/arbitrageAnnouncementSync.js');
const arbitrageParser = read('server/services/arbitrageParser.js');
const arbitrageService = read('server/services/arbitrageService.js');

assert(!/runSlot\(slot,\s*'manual-retry'\)/.test(adminRoute), 'Web 路由不应直接执行人工补跑');
assert(/retryJobSlot\(slotId\)/.test(adminRoute), '人工补跑必须进入计划队列');
assert(/reasonForSlot\(slot\)/.test(orchestrator) && /slot\.trigger_type === 'manual_retry'/.test(orchestrator), '执行器必须保留人工补跑触发类型');
assert(/slot\.status === 'pending' && slot\.trigger_type === 'manual_retry'/.test(slots), '人工补跑不得被旧的失败运行记录立即回滚');
assert(/trigger_type='auto_retry'/.test(slots), '失败退避后必须标记为自动重试');
assert(/dependencyCodes/.test(slots) && /claimSlot/.test(slots), '领取任务前必须检查依赖');
assert(/benchmark_code='CSI300'/.test(slots) && /benchmark_code='CSIALL'/.test(slots) && /source_code='chinabond'/.test(slots) && /source_code='tushare_us_tycr'/.test(slots), '市场波动水位必须逐项检查必要来源');
assert(/重新校验发现业务数据水位落后/.test(slots), '重新校验发现水位落后时必须落库为降级');
assert(/slot\.status === 'degraded'/.test(slots) && /resolveJobSlotAlerts/.test(slots), '数据恢复后重新校验必须恢复状态和告警');
assert(/fork\(/.test(orchestrator) && /taskkill/.test(orchestrator) && /SIGKILL/.test(orchestrator), '任务必须在可强制终止的独立进程执行');
assert(!/claimSlot|completeSlot/.test(ipoJob), '打新业务任务不得自行领取或结束统一计划实例');
assert(/sendDueAlerts/.test(health), 'Worker 离线时健康检查仍必须负责邮件重试');
assert(/job-date-filter/.test(adminUi) && /job-category-filter/.test(adminUi) && /job-trigger-filter/.test(adminUi) && /job-keyword-filter/.test(adminUi), '后台必须提供四类筛选');
assert(/d\.dependencies/.test(adminUi) && /d\.alerts/.test(adminUi) && /d\.audits/.test(adminUi), '任务详情必须展示依赖、邮件和审计');
assert(/validateJobSlotFromUi/.test(adminUi) && /重新校验/.test(adminUi), '后台必须提供重新校验操作');
assert(/window\.confirm/.test(adminUi) && /访问数据源/.test(adminUi) && /成本提示/.test(adminUi) && /sourceDescription/.test(definitions), '人工补跑前必须确认外部源、目标日期和接口成本');
assert(/item\.label\.includes\(keyword\)/.test(slots), '关键词必须支持中文任务名称');
assert(!/渚濊禆|鍚庡彴|璁″垝/.test(slots), '任务告警内容不得包含乱码');

assert(/MAX_DELIVERY_ATTEMPTS = DELIVERY_RETRY_MINUTES\.length \+ 1/.test(alertMailer), '邮件发送失败后必须完整执行 1、5、15 分钟三次重试');
const nonProductionAlertGuards = alertMailer.match(/if \(!productionAlertsEnabled\(\)\)/g) || [];
assert(/function productionAlertsEnabled\(\)/.test(alertMailer) && /process\.env\.NODE_ENV === 'production'/.test(alertMailer)
  && nonProductionAlertGuards.length >= 6 && /status='suppressed'/.test(alertMailer), '所有非生产任务告警入口和最终邮件出口都必须强制抑制');
assert(/NODE_ENV: 'test'/.test(testRunner) && /ALERT_EMAIL_TO: ''/.test(testRunner), '完整测试入口必须清空真实告警收件人');
assert(!/\['worker_offline', 'late', 'dependency_blocked'\]\.includes\(input\.alertType\)/.test(alertMailer), '持续异常不得绕过去重周期重复发信');
assert(!/force:\s*true/.test(health), '健康检查不得强制重复发送逾期告警');
assert(/attempt_count \|\| 0\) === 2/.test(orchestrator) && /retry-warning/.test(orchestrator), '任务连续第二次失败必须发送预警');
assert(/r\.trigger_type='scheduled'/.test(orchestrator) && /SELECT trigger_type FROM job_runs WHERE id=\$1/.test(orchestrator), '重复成功告警不得把人工补跑或自动重试误判为重复定时任务');
assert(/systemctl enable portfolio-server\.service portfolio-worker\.service/.test(deployScript), 'Web 与 Worker 服务必须配置开机自启');
assert(/maxAttempts: 4/.test(definitions), '任务最大尝试次数必须包含首次执行和三次自动重试');
assert(/jobCode: 'bond_safety_refresh'[^\n]*retryDelaysMinutes: \[15, 60, 240\][^\n]*maxAttempts: 4/.test(definitions), '可转债安全评分必须覆盖上游数小时短时故障');
assert(/jobCode: 'convertible_bond_universe_refresh'[^\n]*retryDelaysMinutes: \[15, 60, 240\][^\n]*maxAttempts: 4/.test(definitions), '可转债行情同步必须覆盖上游数小时短时故障');
assert(/expectedDataDate\('bond_safety_refresh', businessDate\)/.test(jobRunners)
  && /runBondSafetyRefresh\(reason, \{ targetTradeDate \}\)/.test(jobRunners), '可转债安全评分必须按计划业务日期传入目标交易日');
assert(/bond_safety_refresh: `SELECT MAX\(COALESCE\(source_updated_at, refreshed_at\)\)/.test(slots), '可转债安全评分水位必须取所有快照中的最新数据日期');
assert(!/type: 'empty_data'[^\n]*maxAttempts: 2/.test(orchestrator), '空数据不得越过任务定义提前终止重试');
assert(/jobCode: 'convertible_bond_universe_refresh'[^\n]*hour: 8, minute: 0/.test(definitions), '可转债行情同步必须改为次日 08:00 执行');
assert(/jobCode: 'convertible_bond_valuation_refresh'[^\n]*hour: 8, minute: 15/.test(definitions), '可转债估值必须改为 08:15 执行');
assert(/jobCode: 'convertible_bond_valuation_refresh'[\s\S]*dataDatePolicy: 'previous_trading_day'/.test(definitions), '可转债估值任务必须按上一个交易日校验数据水位');
assert(/expectedDataDate\('convertible_bond_universe_refresh', businessDate\)/.test(jobRunners)
  && /targetTradeDate/.test(jobRunners), '可转债行情 Runner 必须把计划业务日期转换为目标交易日并传入主同步');
assert(!/notifyJobFailure/.test(jobsDb), '底层 job_runs 完成记录不得绕过统一执行器直接发送首次失败告警');
assert(/claimAlertDelivery/.test(alertMailer) && /status='sending'/.test(alertMailer), '邮件投递必须先原子领取，避免重复发送');
assert(/connectionTimeout: 10 \* 1000/.test(config) && /greetingTimeout: 10 \* 1000/.test(config) && /socketTimeout: 10 \* 1000/.test(config), 'SMTP 必须配置 10 秒超时');
assert(/activeControllers\.forEach\(controller => controller\.abort\(\)/.test(orchestrator) && /stopWaiters/.test(orchestrator), 'Worker 停机必须先等待再中止超时任务');
assert(/WORKER_DRAIN_TIMEOUT_MS/.test(read('server/worker.js')) && /TimeoutStopSec=50min/.test(read('deploy/portfolio-worker.service')), 'Worker 停机必须使用可配置排空窗口并由服务保留足够退出时间');
assert(/WORKER_DRAIN_TIMEOUT_MS: '60000'/.test(read('deploy/ecosystem.config.js')) && /kill_timeout: 3000000/.test(read('deploy/ecosystem.config.js')), 'PM2 Worker 也必须使用同样的排空窗口');
assert(/kill_timeout: 3000000/.test(read('deploy/ecosystem.config.js')) && /TimeoutStopSec=50min/.test(read('deploy/portfolio-worker.service')), '部署管理器必须覆盖最长任务的排空时间');
assert(/systemctl stop portfolio-worker\.service/.test(deployScript) && /systemctl stop portfolio-server\.service/.test(deployScript) && /systemctl start portfolio-server\.service portfolio-worker\.service/.test(deployScript), '部署必须先停止服务再更新代码，完成后再启动');
assert(/stop_unit_if_present portfolio-worker-health\.timer/.test(deployScript) && /stop_unit_if_present portfolio-worker-health\.service/.test(deployScript), '部署期间必须暂停已安装的独立 Worker 健康检查，避免停机误报');
assert(!/worker:overdue-slots/.test(health) && /DELETE FROM ops\.worker_heartbeats/.test(health), '健康检查不得重复制造全局逾期告警，且必须定期清理旧心跳');
assert(/waiting_external/.test(slots) && /waitForExternalSlot/.test(slots) && /attempt_count=GREATEST\(attempt_count-1,0\)/.test(slots), '外部限流或额度耗尽必须进入等待恢复状态且不消耗业务重试次数');
assert(/workerIdForRole/.test(slots) && /IS DISTINCT FROM/.test(slots) && /heartbeat\('worker', 'stopped'\)/.test(read('server/worker.js')), 'Worker 心跳必须固定为主机加角色，重启更新原记录并在退出时标记停止');
assert(/probe_owner/.test(migrations) && /probe_token/.test(read('server/services/externalCallGuard.js')) && /probe_lease_until/.test(read('server/services/externalCallGuard.js')), '外部熔断探测必须使用租约和令牌隔离不同进程');
assert(/arbitrage_sync: `SELECT LEAST/.test(slots) && /convertible_bond_announcement_history_sync:/.test(slots), '多来源任务的数据水位必须按最慢来源核验');
assert(/migration063AlertSendingStatus/.test(migrations), '数据库必须支持告警投递中状态');
assert(/migration070RemoveDuplicateLegacyPriceDates/.test(migrations) && /DELETE FROM daily_prices/.test(migrations), '收盘价日期归一后必须清理已存在标准日期对应的旧格式重复行');
assert(/job_alert_resend/.test(adminRoute) && /result: 'failure'/.test(adminRoute), '邮件重发失败必须写入管理员审计');
assert(/sendRecoverySummary/.test(alertMailer) && /status='sending'/.test(alertMailer), 'SMTP 恢复后必须合并补发历史告警且不能覆盖人工状态');
assert(/emailConfigured/.test(read('public/js/admin.js')) && /投递失败/.test(read('public/js/admin.js')), '后台必须显示邮件告警配置与投递状态');
assert(/jobDisplayText\(alert\.summary/.test(adminUi) && /text\.match\(\/\\uFFFD\/g\)/.test(adminUi), '后台必须压缩超长告警并隐藏无法还原的历史乱码');
assert(/const JOB_LABELS/.test(adminUi) && /ipo_history_sync: '新股历史同步'/.test(adminUi) && /arbitrage_reparse: '套利公告重新解析'/.test(adminUi), '所有后台任务必须使用中文名称');
const scheduledJobCodes = [...definitions.matchAll(/jobCode: '([^']+)'/g)].map(match => match[1]);
assert(scheduledJobCodes.filter(code => !code.startsWith('market_close:')).every(code => new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':').test(adminUi)), '任务定义中的每个任务都必须有中文名称映射');
assert(/function formatJobDetail/.test(adminUi) && /jobDisplayText\(j\.detail/.test(adminUi) && /jobTriggerLabel/.test(adminUi), '任务运行详情和触发方式必须转换为中文说明');
assert(/jobStatusLabel\(alert\.status\)/.test(adminUi) && /jobLabel\(dep\.job_code\)/.test(adminUi), '告警状态和任务依赖名称必须转换为中文');
assert(/market_close:\(\[\^#/.test(adminUi) && /Object\.keys\(JOB_LABELS\)/.test(adminUi), '逾期汇总告警中的任务代码必须转换为中文名称');
assert(/FOR UPDATE SKIP LOCKED/.test(alertMailer) && /status <> 'sending'/.test(alertMailer), '历史告警合并补发与人工重发不得抢占正在发送的告警');
assert(/sending_started_at/.test(alertMailer) && /COALESCE\(sending_started_at, updated_at\)/.test(alertMailer), '告警僵尸回收必须使用独立发送开始时间');
assert(/status='send_failed'/.test(alertMailer) && /status IN \('pending','send_failed'\)/.test(alertMailer) && /next_send_at IS NULL OR next_send_at <= now\(\)/.test(alertMailer), 'SMTP 恢复后必须合并全部到期待发送告警');
assert(/maxTaskTimeoutMs/.test(read('server/worker.js')) && /maxTaskTimeoutMs\) \+ 15/.test(read('server/worker.js')), 'Worker 硬退出时间必须覆盖最长任务超时');
assert(/if \(stopping\)/.test(orchestrator) && /workerStopping/.test(orchestrator), '领取任务后如果进入停机状态必须立即回到补偿队列');
assert(/trap rollback_deploy EXIT/.test(deployScript) && /previous_commit/.test(deployScript) && /deploy_complete/.test(deployScript), '部署失败必须恢复部署前版本并重新启动服务');
assert(/send_attempts > 0/.test(alertMailer) && !/claimRecoverySummaryAlerts\(limit/.test(alertMailer), 'SMTP 任意重试阶段恢复都必须合并全部到期历史告警');
assert(/sanitizeJobError/.test(alertMailer) && /sanitizeJobError/.test(orchestrator) && /sanitizeJobError/.test(read('server/services/jobRunnerProcess.js')), '任务错误进入数据库和邮件前必须统一脱敏');
assert(/activeRuns === 0 && !executing/.test(orchestrator) && /notifyStopWaiters/.test(orchestrator) && /waitForStartupTasks/.test(read('server/worker.js')), 'Worker 停机必须等待完整执行器轮次和启动任务');
assert(/executorTimer = setInterval\(tick, 60 \* 1000\)/.test(orchestrator) && !/executorTimer\.unref/.test(orchestrator), '持久化执行器必须作为独立 Worker 保活句柄，不能在启动任务结束后自动退出');
assert(/sleep 10/.test(deployScript) && /health_json=/.test(deployScript) && !/time\.sleep\(5\)/.test(deployScript), '最终健康与版本检查必须在可回滚部署事务内完成');
assert(/pg_try_advisory_lock\(hashtext\('ops\.alert_notifications\.recovery_summary'\)\)/.test(alertMailer) && /pg_advisory_unlock/.test(alertMailer), 'SMTP 恢复摘要必须使用跨进程全局锁');
assert(/MAX_RECOVERY_SUMMARY_ATTEMPTS = 3/.test(alertMailer) && /recovery_attempts < \$3/.test(alertMailer) && /065_alert_recovery_attempts/.test(migrations), 'SMTP 恢复摘要最多尝试3次并持久化计数');
assert(/sanitizeJobResult/.test(orchestrator) && /sanitizeJobResult/.test(slots) && /sanitizeJobError/.test(jobsDb), '任务错误和结果写入数据库前必须递归脱敏');
assert(/setTimeout\(resolve, 5000\)/.test(orchestrator) && /stopJobOrchestrationObserver/.test(read('server/worker.js')), 'Worker 强制中止后必须留足落库时间并停止观察器');
assert(/recovery_attempts > 0 OR send_attempts >= \$1/.test(alertMailer), '恢复摘要中断后的僵尸记录必须继续走合并摘要');
assert(/send_attempts > 0 OR recovery_attempts > 0/.test(alertMailer) && /AND recovery_attempts=0/.test(alertMailer), '恢复摘要队列不得退回普通逐条投递');
assert(/send_attempts=CASE WHEN ops\.alert_notifications\.status IN \('acknowledged','resolved'\) THEN 0/.test(alertMailer)
  && /recovery_attempts=CASE WHEN ops\.alert_notifications\.status IN \('acknowledged','resolved'\) THEN 0/.test(alertMailer), '已解决或已确认告警复发时必须重置投递次数');
assert(/rollback_failed=1/.test(deployScript) && /systemctl is-active --quiet portfolio-server\.service portfolio-worker\.service/.test(deployScript)
  && /systemctl is-active --quiet portfolio-worker-health\.timer/.test(deployScript)
  && /部署回滚未能恢复服务/.test(deployScript), '部署回滚必须检查依赖、服务和健康状态并明确报告恢复失败');
assert(/last_sent_at=CASE WHEN ops\.alert_notifications\.status IN \('acknowledged','resolved'\) THEN NULL/.test(alertMailer), '已恢复告警复发时必须清除旧发送时间，避免再次故障被抑制');
assert(/sanitizeJobError\(alert\.summary \|\| '', 4000\)/.test(alertMailer) && /sanitizeAlertRecord\(rows\[0\]\)/.test(alertMailer), '历史告警在邮件发送和确认接口返回前必须再次脱敏');
assert(/stop_unit_if_present portfolio-worker-health\.timer/.test(deployScript) && /health_timer_preexisting/.test(deployScript), '首次部署时不存在的健康检查单元不得导致部署或回滚失败');
assert(/WHERE slot_id=\$1 AND status <> 'resolved' AND alert_type <> 'recovery'/.test(alertMailer) && /worker:offline[\s\S]*status <> 'resolved'/.test(health), '人工确认后的故障恢复仍必须关闭故障告警且不得重复处理恢复邮件');
assert(/ACTIVE_ALERT_WHERE/.test(alertMailer)
  && /external_api_switch','external_api_interface_failover/.test(alertMailer)
  && /status IN \('sent','suppressed'\)/.test(alertMailer)
  && /WHERE \$\{ACTIVE_ALERT_WHERE\} GROUP BY status/.test(slots), '已发送的恢复和主备切换通知不得继续计入待处理告警');
assert(/holidaySyncMonthly/.test(scheduler) && /24 \* 60 \* 60 \* 1000/.test(scheduler)
  && !/30 \* 24 \* 3600 \* 1000/.test(scheduler), '月度休市检查不得使用超过 Node 上限的 30 天定时器');
assert(/subject: sanitizeJobError\(alert\.subject/.test(slots) && /audits: audits\.rows\.map/.test(slots), '任务详情中的历史告警标题和审计记录必须脱敏');
assert(/health_timer_enabled=0/.test(deployScript) && /health_timer_active=0/.test(deployScript)
  && /systemctl disable portfolio-worker-health\.timer/.test(deployScript), '部署回滚必须恢复健康定时器原有启用和运行状态');
assert(/health_timer_masked=0/.test(deployScript) && /systemctl mask portfolio-worker-health\.timer/.test(deployScript), '部署回滚必须恢复健康定时器原有 masked 状态');
assert(/test -L \/etc\/systemd\/system\/\$unit/.test(deployScript) && /cp -a \/etc\/systemd\/system\/\$unit/.test(deployScript)
  && /test -L \$backup_dir\/\$unit/.test(deployScript), 'systemd masked 符号链接必须被原样备份和恢复');
assert(/if \(failed > 0\) throw new Error/.test(marketClose) && /失败 \$\{failed\}/.test(marketClose), '收盘任务任一证券失败都必须进入统一重试，不能以部分成功掩盖缺数');
assert(/market_close:A股/.test(slots) && /market_close:港股/.test(slots) && /market_close:可转债/.test(slots)
  && /market_close:LOF\/ETF/.test(slots) && /COUNT\(dp\.code\)=COUNT\(\*\)/.test(slots), '收盘任务数据水位必须按对应市场逐项核对持仓价格');
assert(/const errors = \[\.\.\.\(result\.hkex\.errors/.test(arbitrageJob) && /if \(errors\.length \|\| parsePending \|\| parseExhausted\)/.test(arbitrageJob)
  && /finishJobRun\(runId, false, error\)/.test(arbitrageJob), '套利任一公告源局部失败必须记失败并进入统一重试');
assert(/066_arbitrage_parse_retry/.test(migrations) && /parse_attempts INTEGER NOT NULL DEFAULT 0/.test(migrations)
  && /next_parse_attempt_at TIMESTAMPTZ/.test(migrations), '套利 PDF 解析重试次数和下次时间必须持久化');
assert(/acd\.parse_status='failed' AND acd\.parse_attempts < \$2/.test(arbitrageSync)
  && /COALESCE\(acd\.next_parse_attempt_at, now\(\)\) <= now\(\)/.test(arbitrageSync), '解析失败 PDF 必须在到期后有限重试，不能永久排除');
assert(/MAX_PARSE_ATTEMPTS = 3/.test(arbitrageParser) && /parse_attempts=\$3/.test(arbitrageParser)
  && /parseExhausted/.test(arbitrageJob), 'PDF 解析达到上限后必须停止外部调用并进入统一任务告警');
assert(/getParseRetryDecision/.test(arbitrageParser) && /reason: 'exhausted'/.test(arbitrageParser)
  && /reason: 'not_due'/.test(arbitrageParser), 'PDF 解析入口本身必须阻止未到期和超过上限的外部调用');
assert(/resolveParseFailure\(caseId\)/.test(arbitrageParser) && /SET status='resolved',resolved_at=now\(\)/.test(arbitrageParser), 'PDF 解析恢复后必须关闭对应数据质量异常');
assert(/error: sanitizeJobError\(message, 500\)/.test(arbitrageParser), 'PDF 解析错误写入数据质量表前必须脱敏');
assert(/WITH failed_document AS[\s\S]*UPDATE event\.arbitrage_case_documents[\s\S]*UPDATE event\.arbitrage_cases[\s\S]*SET parse_status='incomplete'/.test(arbitrageParser), '文档失败状态和案件降级必须在同一数据库语句内原子落库');
assert(/const hasFailedDocument = docs\.some[\s\S]*if \(hasFailedDocument\)[\s\S]*status: 'incomplete'/.test(arbitrageParser), '重建条款时只要仍有失败公告，案件就不能恢复为已验证');
assert(/acd\.parse_status='failed' AND acd\.document_role IN \('amendment','terms','summary','proposal'\)/.test(arbitrageParser), '只有条款类公告解析失败才可阻止案件验证，历史风险或终态文档不得污染条款状态');
assert(/const payload = await parser\.parseAndStoreDocument/.test(arbitrageSync) && /if \(!payload\) continue/.test(arbitrageSync), 'PDF 解析被重试规则拦截时不得误计为解析成功');
assert(/pg_try_advisory_lock\(\$1,\$2\)/.test(arbitrageParser) && /pg_advisory_unlock\(\$1,\$2\)/.test(arbitrageParser), 'PDF 解析资格判断和外部调用必须受文档级跨进程锁保护');
assert(/parseAndStoreDocument\(caseId,[\s\S]*true, true\)/.test(arbitrageService), '人工重新解析必须在同一文档锁内重置解析次数');
assert(/if \(failedCount\)[\s\S]*status: 'failed'[\s\S]*任务将进入统一重试/.test(arbitrageService), '人工重新解析只要仍有公告失败就必须进入统一重试和告警，不能以部分成功掩盖缺数');
assert(/if \(!eligibleCount\) return \{ caseId, status: 'skipped'/.test(arbitrageService), '只有风险或终态公告时应明确跳过，不能误报解析失败并反复重试');
assert(/enqueueManualJob\('arbitrage_sync'\)/.test(arbitrageService) && !/setImmediate\(async \(\) =>[\s\S]*runIncrementalSync/.test(arbitrageService), '后台手动套利同步必须进入持久化任务队列');
assert(/queueReparseCase\(caseId\)/.test(adminRoute) && /enqueueManualJob\('arbitrage_reparse', \{ caseId \}\)/.test(arbitrageService)
  && /request_payload/.test(slots) && /manualOnly/.test(definitions), '人工重新解析必须携带事件编号进入持久化队列，且不能自动生成每日计划');
assert(/requiresDataWatermark: false/.test(definitions) && /getJobDefinition\(slot\.job_code\)\.requiresDataWatermark === false/.test(slots), '解析类任务必须按执行结果验收，不能因没有业务日期水位误判为降级');
assert(/const lockKey = JOB_CODE/.test(read('server/jobs/arbitrageReparse.js')), '参数化重新解析任务必须按任务代码全局串行，避免多 Worker 将运行记录关联到错误计划实例');
assert(/migration067JobRequestPayload/.test(migrations) && /request_payload JSONB NOT NULL DEFAULT '\{\}'::jsonb/.test(migrations), '人工参数化任务必须使用数据库字段持久化请求参数');
assert(/pg_advisory_xact_lock\(hashtext\('manual_job:' \|\| \$1 \|\| ':' \|\| \$2\)\)/.test(slots)
  && /COALESCE\(next_attempt_at,scheduled_for\) <= now\(\) AND attempt_count < \$2/.test(slots), '重复点击手动同步只能复用正在运行或当前可领取的实例，不能误复用未来计划或耗尽实例');
assert(/DELETE FROM ops\.data_quality_issues q[\s\S]*q\.status='resolved'/.test(arbitrageParser)
  && /UPDATE ops\.data_quality_issues q[\s\S]*q\.status='open'/.test(arbitrageParser), '质量异常二次恢复必须先清理旧resolved再关闭当前open');
assert(/sanitizeJobError\(err\.message \|\| err, 500\)/.test(arbitrageService)
  && /sanitizeJobError\(error\.message \|\| error, 1000\)/.test(arbitrageJob), '套利解析和同步错误写入日志前必须脱敏');

console.log('OK job-orchestration-regression: 95 项关键验收约束通过');
