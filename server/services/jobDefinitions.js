// 后台任务的统一定义：调度时间用于观察、补偿和告警，不替换现有业务实现。
// job_code 必须与 job_runs.job 保持一致，便于把旧任务运行记录纳入统一面板。
const DEFAULT_JOB_OPTIONS = {
  catchupWindowMinutes: 360,
  // 首次执行 + 3 次自动重试；retryDelaysMinutes 对应第 1、2、3 次重试。
  maxAttempts: 4,
  retryDelaysMinutes: [5, 15, 45],
  timeoutMinutes: 30,
  category: 'data_sync',
  importance: 'normal',
  sourceDescription: '本地数据库与该任务已配置的数据源',
  mayConsumeQuota: false,
  externalSources: [],
  externalApis: [],
  producesDatasets: [],
  consumesDatasets: [],
  datasetDependencies: [],
  readinessDatasetDependencies: [],
  maxExternalCallsPerRun: 0,
  // 槽位调用量只做审计；未知的累计调用上限保持 0，续批由任务超时、最长续跑时间和无进展保护停止。
  slotExternalCallsLimit: 0,
  continuationNoProgressLimit: 2,
  continuationMaxAgeHours: 24,
  modeExternalCallLimits: {},
  retryPolicy: 'local',
  catchupMode: 'per_business_date',
  dataDatePolicy: 'none',
  freshnessGate: false,
  // false = 交易日当天执行；true = 收盘日的次日执行。
  // 依赖收盘后才产生的数据（盘后公告、当日完整行情）的任务应设为 true，否则周末与
  // 节假日前一天收盘后的数据要等到下一个交易日才同步。
  afterTradingDay: false,
  // 就绪等待（方案 2026-11-18 P0）：本业务日的复查时刻、静默等待升级为告警的时刻、
  // 以及自动续跑硬截止。三者都按北京时间的 'HH:MM' 声明，由调度按业务日换算成绝对时刻，
  // 页面与 Runner 不得另写常量。未声明即沿用既有 blocked/失败合同，不切换到
  // waiting_readiness；这三个值是试行安排，不是供应商承诺的发布时间。
  readinessCheckpoints: null,
  readinessEscalateAt: null,
  readinessStopAt: null,
};

/**
 * 阶段 1B 调度开关（方案 4.5 / 8）：
 * - STOCK_SELECTION_LEGACY_SLOTS=0（默认）：18:40 只跑单一 selection_archive_light 槽，
 *   串行归档双市场×双策略，不再由 core 任务裂变日/周/季槽；
 * - =1：一键恢复原 18:40 selection_periodic 与旧入队链路，便于读路径/调度同步回滚。
 */
function selectionLegacySlotsEnabled() {
  return String(process.env.STOCK_SELECTION_LEGACY_SLOTS || '0').trim() === '1';
}

function selectionAdditionalSchedules() {
  return [
    selectionLegacySlotsEnabled()
      ? { hour: 18, minute: 40, mode: 'selection_periodic', afterTradingDay: false, freshnessGate: false }
      : { hour: 18, minute: 40, mode: 'selection_archive_light', afterTradingDay: false, freshnessGate: false },
    { hour: 18, minute: 55, mode: 'stock_analysis_hk', afterTradingDay: false, weekdays: false, calendarWeekdays: true, marketCalendarPolicy: 'hk-open', dataDatePolicy: 'latest_available', freshnessGate: false },
  ];
}

/**
 * 阶段 2/3 波次二收敛开关（方案 5.2 / 5.3 / 8）：
 * - 默认 '1'：只自动排波次一（market_close:* / hk_rate / nav_snapshot / ipo_calendar_refresh / holiday_sync）
 *   与 7 个凌晨收敛任务；带 supersededBy 的旧任务保留定义与手工补跑入口，但不再自动生成计划槽。
 * - '0'：跳过 7 个新收敛任务，恢复旧排程，用于一键回退。
 * 开关只影响“自动生成计划槽”，不修改任何 job_code、业务实现、数据集契约或历史告警作用域。
 */
const CONVERGED_JOB_CODES = Object.freeze([
  'cn_stock_eod_sync', 'hk_stock_eod_sync', 'convertible_bond_eod_sync', 'exchange_announcements_sync',
  'bond_analytics_refresh', 'stock_analytics_refresh', 'system_retention',
]);

function jobConvergenceEnabled() {
  const raw = process.env.JOB_CONVERGENCE_ENABLED;
  if (raw == null || String(raw).trim() === '') return true;
  return String(raw).trim() !== '0';
}

// 凌晨任务的目标业务日固定为“已收盘的上一交易日”，与 afterTradingDay 的“收盘日次日执行”配对：
// 周六 01:00 的槽位 business_date=周六，expectedDataDate=周五。周日/周一因前一天不是收盘日不生成槽位。
const CONVERGED_NIGHTLY = {
  afterTradingDay: true, weekdays: true, catchupMode: 'latest_only', dataDatePolicy: 'previous_trading_day',
  freshnessGate: false, requiresDataWatermark: false, strictDatasetPublication: false,
  category: 'data_sync', importance: 'high', retryPolicy: 'external', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4,
};

const JOB_DEFINITION_SOURCE = [
  { jobCode: 'company_financial_incremental_sync', supersededBy: ['cn_stock_eod_sync', 'hk_stock_eod_sync'], label: '公司财务增量同步', hour: 6, minute: 30, weekdays: false, catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: false, requiresDataWatermark: false, strictDatasetPublication: true, deadlineMinutes: 120, timeoutMinutes: 30,
    // 方案 27.38 P0（2026-11-10）：选股输入必须每天有一次「按需补」——此前 `selection_inputs`
    // 只有人工/排队入口，港股股票估值自 11-07 起全市场断档，日选股每天等不到数据、重复计算
    // 466 次后撞 24 小时止损。这里复用同一 Runner、同一缺口队列，只增加两个日常触发：
    //   · CN 08:40：08:00 的共享收盘采集（convertible_bond_universe_refresh）写上一交易日后，
    //     只补它没覆盖的财报/行业/估值缺口；
    //   · HK 08:45：港股没有共享收盘采集，由本模式自己补成分/日线/估值。
    // 目标日一律取「本地交易日历的上一交易日」，不用当天（未收盘的一天会把全市场算成缺口）。
    // 缺口驱动 + 既有续批与无进展止损，不设业务上限、不新增数据源或第二调度器。
    additionalSchedules: [
      { hour: 8, minute: 40, mode: 'selection_inputs', market: 'CN', targetTradeDate: 'previous_trading_day', weekdays: true, freshnessGate: false },
      { hour: 8, minute: 45, mode: 'selection_inputs', market: 'HK', targetTradeDate: 'previous_trading_day', weekdays: true, marketCalendarPolicy: 'hk-open', freshnessGate: false },
    ],
    manualTargetScope: 'stock_analysis模式仅对request_payload.targetCodes指定的一只普通A股补齐完整历史财报、分红与公告并重算快照，不发布全市场分区；selection_inputs模式按market与targetTradeDate冻结选股输入缺口，复用既有财务/分红/行业采集入口与标准层写入，港股另补成分、日线和估值，剩余对象持久化续跑，不发布全市场财务分区', sourceDescription: '日常当前上市可转债正股；手动股票分析按明确指定单股采集财报入标准层；选股输入补齐以理杏仁官方为主源，分红与A股行业可回退Tushare、港股日线可回退腾讯，均经既有数据访问层入口', mayConsumeQuota: true, externalSources: ['lixinger_official', 'tushare', 'tencent', 'sse', 'szse', 'cninfo'], retryPolicy: 'external', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4 },
  { jobCode: 'bond_safety_refresh', supersededBy: ['bond_analytics_refresh'], label: '可转债安全评分', hour: 8, minute: 30, weekdays: true, afterTradingDay: true, deadlineMinutes: 120, dataDatePolicy: 'previous_trading_day', freshnessGate: true, strictDatasetPublication: true, dependencyCodes: ['convertible_bond_universe_refresh'], sourceDescription: '已发布的共享标准行情与财务标准层；本地计算', mayConsumeQuota: false, externalSources: [], retryPolicy: 'local', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4 },
  { jobCode: 'market_close:A股', label: 'A股收盘数据', hour: 15, minute: 30, previousScheduledMinute: 10, weekdays: true, deadlineMinutes: 90, dataDatePolicy: 'same_day', freshnessGate: true, readinessCheckpoints: ['15:31', '15:33', '15:36'], readinessEscalateAt: '16:00', readinessStopAt: '17:00', sourceDescription: '北京时间15:30采集同日腾讯报价，时间晚于收市即直接形成账户收盘估值；历史补价仍沿用日线', mayConsumeQuota: true, externalSources: ['tencent', 'lixinger_official', 'tushare'], retryPolicy: 'external', retryDelaysMinutes: [3, 10], maxAttempts: 3 },
  { jobCode: 'market_close:可转债', label: '可转债收盘数据', hour: 15, minute: 30, previousScheduledMinute: 10, weekdays: true, deadlineMinutes: 90, dataDatePolicy: 'same_day', freshnessGate: true, readinessCheckpoints: ['15:31', '15:33', '15:36'], readinessEscalateAt: '16:00', readinessStopAt: '17:00', sourceDescription: '北京时间15:30采集同日腾讯报价，时间晚于收市即直接形成账户收盘估值；历史补价仍沿用日线', mayConsumeQuota: true, externalSources: ['tencent', 'tushare'], retryPolicy: 'external', retryDelaysMinutes: [3, 10], maxAttempts: 3 },
  { jobCode: 'market_close:LOF/ETF', label: 'LOF/ETF收盘数据', hour: 15, minute: 30, previousScheduledMinute: 10, weekdays: true, deadlineMinutes: 90, dataDatePolicy: 'same_day', freshnessGate: true, readinessCheckpoints: ['15:31', '15:33', '15:36'], readinessEscalateAt: '16:00', readinessStopAt: '17:00', sourceDescription: '北京时间15:30采集同日腾讯报价，时间晚于收市即直接形成账户收盘估值；历史补价仍沿用日线', mayConsumeQuota: true, externalSources: ['tencent', 'tushare'], retryPolicy: 'external', retryDelaysMinutes: [3, 10], maxAttempts: 3 },
  { jobCode: 'hk_rate', label: '港币汇率更新', hour: 16, minute: 15, weekdays: false, marketCalendarPolicy: 'hk-rate', deadlineMinutes: 90, dataDatePolicy: 'latest_available', freshnessGate: false, freshnessMode: 'max_age', freshnessMaxAgeMinutes: 1440, sourceDescription: '港股收市报价到达后采集最终汇率；A股单开市日沿用16:15', mayConsumeQuota: true, externalSources: ['exchange-rate'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'market_close:港股', label: '港股收盘数据', hour: 16, minute: 30, weekdays: false, marketCalendarPolicy: 'hk-close', deadlineMinutes: 120, dataDatePolicy: 'same_day', freshnessGate: true, sourceDescription: '港股按交易日历于实际收市后采集同日腾讯报价，时间晚于收市即直接形成账户收盘估值；历史补价仍沿用日线', mayConsumeQuota: true, externalSources: ['tencent', 'lixinger_official'], retryPolicy: 'external', retryDelaysMinutes: [3, 10], maxAttempts: 3 },
  { jobCode: 'nav_snapshot', label: '净值快照', hour: 16, minute: 20, weekdays: false, marketCalendarPolicy: 'nav-snapshot', deadlineMinutes: 120, dataDatePolicy: 'same_day', freshnessGate: false, retryPolicy: 'local', readinessCheckpoints: ['18:30'], readinessEscalateAt: '19:00', readinessStopAt: '20:00', readinessDatasetDependencies: [{ datasetCode: 'repo_daily_rates', scopeKey: 'CN', partitionDatePolicy: 'business_date', requireQualityStatus: 'passed' }], sourceDescription: '收盘净值按目标日补缺口；逆回购利率未发布时只在 18:30 检查点后请求同日缺口，由统一就绪重验按 repo_daily_rates 分区唤醒' },
  { jobCode: 'index_recent', supersededBy: ['cn_stock_eod_sync'], label: '指数每日补齐', hour: 16, minute: 20, weekdays: true, deadlineMinutes: 120, dataDatePolicy: 'previous_trading_day', freshnessGate: true, sourceDescription: 'Tushare 指数接口', mayConsumeQuota: true, externalSources: ['tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'ipo_calendar_refresh', label: '打新日历与日报', hour: 18, minute: 5, additionalSchedules: [{ hour: 19, minute: 45, mode: 'enrichment', weekdays: true }], weekdays: true, deadlineMinutes: 240, catchupWindowMinutes: 4200, catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: true, readinessCheckpoints: ['18:30', '19:45'], readinessEscalateAt: '20:00', readinessStopAt: '22:00', requiresDataWatermark: false, importance: 'high', datasetDependencies: [{ datasetCode: 'ipo_history', scopeKey: 'GLOBAL', partitionDatePolicy: 'business_date', requireQualityStatus: 'passed' }, { datasetCode: 'bond_issuance_events', scopeKey: 'CN', partitionDatePolicy: 'business_date', requireQualityStatus: 'passed' }, { datasetCode: 'bond_listing_liquidity', scopeKey: 'CN', partitionDatePolicy: 'business_date', requireQualityStatus: 'passed' }], sourceDescription: '读取16:30上市前预测缺口检查后已发布的新股事实与17:30已核验的可转债流通规模事实生成日报；19:45再刷新同一基础分区对应的日报', retryPolicy: 'local' },
  { jobCode: 'convertible_bond_universe_refresh', supersededBy: ['cn_stock_eod_sync', 'convertible_bond_eod_sync'], label: '可转债行情同步（共享收盘采集）', hour: 8, minute: 0, weekdays: true, afterTradingDay: true, catchupMode: 'latest_only', dataDatePolicy: 'previous_trading_day', freshnessGate: true, strictDatasetPublication: true, datasetFailureThreshold: 3, sourceDescription: '腾讯行情与 Tushare 接口；同时发布股票日行情、估值、复权因子和停牌分区', mayConsumeQuota: true, externalSources: ['tencent', 'tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4, collectorRole: 'shared_cn_market_eod' },
  { jobCode: 'convertible_bond_revision_motive_inputs_sync', supersededBy: ['convertible_bond_eod_sync'], label: '下修动机输入增量同步', hour: 7, minute: 20, weekdays: true, afterTradingDay: true, catchupMode: 'latest_only', catchupWindowMinutes: 4320, dataDatePolicy: 'latest_available', freshnessGate: false, requiresDataWatermark: false, sourceDescription: 'Tushare 持有人与质押接口，结果写入事实库', mayConsumeQuota: true, externalSources: ['tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4 },
  { jobCode: 'convertible_bond_revision_motive_calculate', label: '下修动机评分计算', manualOnly: true, requiresDataWatermark: false, sourceDescription: '已入库下修、行情、财务、持有人和质押事实，数据库本地计算' },
  { jobCode: 'convertible_bond_announcement_history_sync', supersededBy: ['exchange_announcements_sync'], label: '可转债公告与生命周期同步', hour: 7, minute: 40, weekdays: true, afterTradingDay: true, additionalSchedules: [{ hour: 17, minute: 30, mode: 'calendar', afterTradingDay: false, weekdays: true }, {hour:18,minute:15,mode:'analysis_inputs',afterTradingDay:false,weekdays:true,freshnessGate:false}], catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: true, requiresDataWatermark: true, reconcileByWatermark: true, strictDatasetPublication: true, deadlineMinutes: 240, timeoutMinutes: 120, importance: 'high', sourceDescription: 'Tushare发行事实与上交所、深交所官方公告统一采集后按事件类型分发；17:30上市流通明细历史补全优先交易所官方资料，交易所不可用时以巨潮资讯兜底', mayConsumeQuota: true, externalSources: ['tushare', '上交所', '深交所', '巨潮资讯'], retryPolicy: 'external', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4 },
  { jobCode: 'convertible_bond_announcement_reparse', label: '可转债旧公告重新解析', manualOnly: true, requiresDataWatermark: false, deadlineMinutes: 240, timeoutMinutes: 120, importance: 'high', sourceDescription: '已入库官方公告 PDF 与本地解析器' },
  { jobCode: 'market_volatility_sync', supersededBy: ['cn_stock_eod_sync'], label: '股市波动指标', hour: 18, minute: 45, weekdays: true, catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: false, freshnessMaxLagDays: 45, sourceDescription: '中债、中证指数、恒生指数及美国十年期国债收益率替代基准；按子数据集分别校验新鲜度', mayConsumeQuota: true, externalSources: ['tushare', '中债', '中证指数', '恒生指数'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'convertible_bond_valuation_refresh', supersededBy: ['bond_analytics_refresh'], label: '可转债估值预警', hour: 8, minute: 15, weekdays: true, afterTradingDay: true, deadlineMinutes: 360, dataDatePolicy: 'previous_trading_day',
    datasetDependencies: ['bond_master','bond_daily','stock_daily','stock_suspend_calendar'].map(datasetCode=>({datasetCode,scopeKey:'CN',partitionDatePolicy:'previous_trading_day'})), freshnessGate: true, retryPolicy: 'local' },
  { jobCode: 'ipo_history_sync', supersededBy: ['exchange_announcements_sync'], label: 'IPO事实同步', hour: 18, minute: 0, weekdays: true, additionalSchedules: [{ hour: 16, minute: 30, mode: 'prediction_ready', freshnessGate: false }, { hour: 19, minute: 30, mode: 'core', freshnessGate: false }, { hour: 19, minute: 35, mode: 'enrichment' }], catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: true, strictDatasetPublication: true, deadlineMinutes: 240, manualTargetScope: 'request_payload.targetCodes：仅对指定 A 股 IPO 执行增强资料补全；可用 targetFields=[business_exposure] 定向重解析上下游关系；特殊原文表格可用 manualCorrection.type=ipo_chain_evidence 与 chainEvidenceRecords 绑定目标代码、原文URL/全文哈希及逐条引文，先人工核对发行人/产品关系，再由Python拒绝原文不匹配证据，或 targetFields=[industry] 定向重解析官方行业；targetFields=[industry_pe] 仅补官方行业PE或有原文与未来发行公告日的待披露证据，其他金融字段不变；targetFields=[ld_close_change] 独立补首日涨幅，优先读精确上市日标准行情，不运行资料/申万补全、不发布全局分区；行业、行业PE或产业链字段阶段不运行申万补全，只更新请求字段及其证据，不刷新全量主档或历史预测', sourceDescription: 'Tushare新股基础事实；16:30先复用本地标准层检查下一交易日申购/上市新股的预测缺口，仅对缺失字段定向补齐；19:35先独立提交首日表现再补历史资料，首日行情优先读数据库，沪深缺口按上市日查询腾讯未复权行情，北交所缺口复用Tushare daily；完整资料补全按上交所/深交所/北交所官方招股书优先、巨潮兜底、Tushare最后回退', mayConsumeQuota: true, externalSources: ['tushare', 'tencent', '上交所', '深交所', '北交所', '巨潮资讯'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'stock_analysis_refresh', supersededBy: ['stock_analytics_refresh'], label: '个股分析刷新', hour: 8, minute: 20, weekdays: true, afterTradingDay: true, catchupMode: 'latest_only', dataDatePolicy: 'previous_trading_day', dependencyCodes: ['convertible_bond_universe_refresh'], freshnessGate: true, deadlineMinutes: 360, additionalSchedules: selectionAdditionalSchedules(), sourceDescription: '已发布的共享标准行情与财务标准层；本地计算；stock_analysis_hk 按港交所日历触发，HK 开市而 A 股休市也须可运行，外采为 0', mayConsumeQuota: false, externalSources: [], retryPolicy: 'local', retryDelaysMinutes: [15, 60], maxAttempts: 3, manualTargetScope: 'request_payload.mode=selection_quarterly 按市场生成季度选股组合；selection_preview 按明确目标日试算并标记预览，不替换正式季度；selection_daily/selection_weekly 按市场周期键计算每日动态与每周正式组合（shadow=true 只写影子批次与影子分区，不移动正式指针）；selection_backtest 用已验证标准事实跑季度回测；selection_inputs 负责选股输入缺口审计并把缺口冻结进可续跑队列。选股模式只消费本市场已核验的标准事实：输入就绪与否由批次质量裁决记录（待补对象会阻断正式发布），不靠槽位依赖链，避免"数据待补"被误当成"任务永远不能跑"而让缺口无法被发现', modeExternalCallLimits: { selection_quarterly: 0, selection_preview: 0, selection_backtest: 0, selection_inputs: 0, selection_daily: 0, selection_weekly: 0, selection_periodic: 0, selection_archive_light: 0, stock_analysis_hk: 0 }, modeDependencyCodes: { selection_quarterly: [], selection_preview: [], selection_backtest: [], selection_inputs: [], selection_daily: [], selection_weekly: [], selection_periodic: [], selection_archive_light: [], stock_analysis_hk: [] }, modeDatasetDependencies: { selection_quarterly: [], selection_preview: [], selection_backtest: [], selection_inputs: [], selection_daily: [], selection_weekly: [], selection_periodic: [], selection_archive_light: [], stock_analysis_hk: [] } },
  { jobCode: 'hk_trade_rules_sync', supersededBy: ['hk_stock_eod_sync'], label: '港股每手股数同步', hour: 20, minute: 30, weekdays: true, catchupMode: 'latest_only', requiresDataWatermark: false, sourceDescription: '港交所证券资料接口', mayConsumeQuota: true, externalSources: ['tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'hk_trade_calendar_sync', supersededBy: ['hk_stock_eod_sync'], label: '港交所交易日历同步', hour: 7, minute: 50, weekdays: false, calendarWeekdays: true, catchupMode: 'latest_only', requiresDataWatermark: false, sourceDescription: '港交所年度官方安排与 Tushare 增量日历，均经同一同步入口落库', mayConsumeQuota: true, externalSources: ['hkex', 'tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'hk_ipo_preopen', label: '港股 IPO 盘前事实与认购倍数采集', hour: 8, minute: 30, additionalSchedules: [{ hour: 12, minute: 5, mode: 'subscription_midday' }, { hour: 16, minute: 10, mode: 'subscription_close' }], weekdays: false, calendarWeekdays: true, marketCalendarPolicy: 'hk-open', catchupMode: 'latest_only', requiresDataWatermark: false, datasetDependencies: [{ datasetCode: 'hk_trade_calendar', scopeKey: 'HK', partitionDatePolicy: 'business_date' }], sourceDescription: '港交所主板/GEM 新上市事实；HKIPOx 实时申购倍数仅允许上海当天目标日，历史/未来槽位阻断；盘前、午间和收盘后快照保留时点记录', mayConsumeQuota: true, externalSources: ['hkex', 'tencent', 'hkipox-public'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'hk_ipo_postclose', label: '港股 IPO 盘后事实同步', hour: 18, minute: 10, weekdays: false, calendarWeekdays: true, marketCalendarPolicy: 'hk-open', catchupMode: 'latest_only', requiresDataWatermark: false, datasetDependencies: [{ datasetCode: 'hk_trade_calendar', scopeKey: 'HK', partitionDatePolicy: 'business_date' }], sourceDescription: '港交所配售结果、标题检索、年度新上市报表、腾讯行情名称与事实层', mayConsumeQuota: true, externalSources: ['hkex', 'tencent'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'hk_ipo_enrichment', label: '港股 IPO 官方文件与日线补全', hour: 19, minute: 40, mode: 'enrichment', weekdays: false, calendarWeekdays: true, marketCalendarPolicy: 'hk-open', catchupMode: 'latest_only', requiresDataWatermark: false, datasetDependencies: [{ datasetCode: 'hk_trade_calendar', scopeKey: 'HK', partitionDatePolicy: 'business_date' }], manualTargetScope: 'request_payload.targetCodes：按代码定向补发行状态公告、招股书、配发、港股日线和完整度，不跑全局报表、探针或申购期信号', sourceDescription: '港交所年度新上市报表、官方延期/取消等发行状态公告、招股书/配售结果 PDF、腾讯港股 K 线首日/五日覆盖', mayConsumeQuota: true, externalSources: ['hkex', 'tencent'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'arbitrage_sync', supersededBy: ['exchange_announcements_sync'], label: '套利公告同步', hour: 8, minute: 30, additionalSchedules: [{ hour: 8, minute: 35, mode: 'cash_dividends', freshnessGate: false, requiresDataWatermark: false, reconcileByWatermark: false }, { hour: 8, minute: 40, mode: 'stock_swap_settle', freshnessGate: false, requiresDataWatermark: false, reconcileByWatermark: false }], weekdays: true, catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: true, requiresDataWatermark: true, reconcileByWatermark: true, sourceDescription: '港交所、上交所、深交所官方公告接口；08:35复用同一Runner补全启用账户分红事实；08:40按已实施换股案件结算持仓；每日附带一次巨潮资讯权限恢复探针，不参与公告采集', mayConsumeQuota: true, externalSources: ['港交所', '上交所', '深交所', '巨潮资讯权限探针'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'arbitrage_reparse', label: '套利公告重新解析', manualOnly: true, requiresDataWatermark: false, deadlineMinutes: 240, timeoutMinutes: 120, importance: 'high', sourceDescription: '已入库官方公告 PDF 链接与本地解析器', mayConsumeQuota: true, externalSources: ['巨潮资讯', '港交所'], externalApis: ['cninfo', 'hkex'], maxExternalCallsPerRun: null },
  { jobCode: 'holiday_sync', label: '休市日历月度同步', hour: 4, minute: 30, weekdays: false, monthly: true, deadlineMinutes: 1440, catchupWindowMinutes: 43200, catchupMode: 'latest_only', requiresDataWatermark: false, category: 'system', importance: 'high', sourceDescription: 'Tushare 交易日历接口；每月 1 日 04:30 执行，避开凌晨数据波次 I/O 高峰', mayConsumeQuota: true, externalSources: ['tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  // ===== 波次二：T+1 凌晨收敛任务（阶段 2/3，受 JOB_CONVERGENCE_ENABLED 控制）=====
  // 全部为既有业务 Runner 的串行编排，不新增数据源、不新增事实表、不新增第二调度器。
  { jobCode: 'cn_stock_eod_sync', label: 'A股日终与财报指数波动同步', hour: 1, minute: 0, ...CONVERGED_NIGHTLY, targetTradeDate: 'previous_trading_day', market: 'CN', deadlineMinutes: 120, timeoutMinutes: 120,
    sourceDescription: '复用共享 A 股日终采集（股票行情/估值/复权/停牌 + 可转债主档/日线/回购利率）、公司财务增量、指数补齐与股市波动指标；各子阶段独立失败隔离，成功后触发 PB 投影同步',
    mayConsumeQuota: true, externalSources: ['tencent', 'tushare', 'lixinger_official', 'sse', 'szse', 'cninfo', '中债', '中证指数', '恒生指数'],
    manualTargetScope: '手工补跑按上一交易日串行执行 A 股日终、财务、指数与波动子阶段；失败子阶段记录 failedDatasets，不阻断其余子阶段' },
  { jobCode: 'hk_stock_eod_sync', label: '港股日终与财报同步', hour: 1, minute: 15, ...CONVERGED_NIGHTLY, weekdays: false, calendarWeekdays: true, marketCalendarPolicy: 'hk-open', targetTradeDate: 'previous_trading_day', market: 'HK', deadlineMinutes: 120, timeoutMinutes: 120,
    sourceDescription: '复用港交所交易日历/证券资料同步与港股选股输入缺口补齐；按港交所日历触发，港股开市而 A 股休市仍需运行；成功后触发 HK PB 投影同步',
    mayConsumeQuota: true, externalSources: ['hkex', 'tushare', 'lixinger_official', 'tencent'],
    manualTargetScope: '手工补跑按上一港股交易日串行执行日历、每手股数与港股财务/日线/估值缺口；子阶段独立失败隔离' },
  { jobCode: 'convertible_bond_eod_sync', label: '可转债主档日线与持有人同步', hour: 1, minute: 30, ...CONVERGED_NIGHTLY, targetTradeDate: 'previous_trading_day', market: 'CN', deadlineMinutes: 90, timeoutMinutes: 90,
    sourceDescription: '复用共享可转债主档/日线与下修动机持有人/质押增量；目标日主档与日线分区已由共享采集发布时只补持有人与质押，不重复联网',
    mayConsumeQuota: true, externalSources: ['tencent', 'tushare'],
    manualTargetScope: '手工补跑按上一交易日检查可转债主档/日线分区，缺失时才调用共享采集，再补持有人与质押输入' },
  { jobCode: 'exchange_announcements_sync', label: '交易所公告统一采集与分发', hour: 1, minute: 45, ...CONVERGED_NIGHTLY, targetTradeDate: 'previous_trading_day', market: 'CN', deadlineMinutes: 120, timeoutMinutes: 120,
    sourceDescription: '复用可转债公告、IPO 历史与套利公告的既有采集入口，按显式顺序分发且逐子阶段失败隔离；套利换股结算只依赖套利案件成功，现金分红失败不得阻断换股结算',
    mayConsumeQuota: true, externalSources: ['上交所', '深交所', '北交所', '港交所', '巨潮资讯', 'tushare', 'tencent'],
    manualTargetScope: '手工补跑按上一交易日串行执行可转债公告、IPO 历史、套利公告/现金分红/换股结算；任一子阶段失败只记录 failedDatasets' },
  { jobCode: 'bond_analytics_refresh', label: '可转债估值与安全评分刷新', hour: 2, minute: 30, ...CONVERGED_NIGHTLY, market: 'CN', deadlineMinutes: 360, timeoutMinutes: 360,
    sourceDescription: '只读已发布的标准事实（转债主档/日线、股票日线/停牌/财报），先刷新估值快照再计算安全评分；安全评分失败不回滚已发布估值分区',
    mayConsumeQuota: false, externalSources: [],
    manualTargetScope: '手工补跑按上一交易日先刷新估值快照、再计算安全评分；安全评分失败只记录 failedDatasets，不撤销估值分区' },
  { jobCode: 'stock_analytics_refresh', label: '个股分析与选股轻量归档刷新', hour: 2, minute: 30, ...CONVERGED_NIGHTLY, deadlineMinutes: 60, timeoutMinutes: 60,
    sourceDescription: '数据库只读计算：CN 个股分析、按港交所日历的 HK 个股分析与选股 ≤30 席轻量归档；与 360 分钟可转债估值彻底拆槽，0 外采',
    mayConsumeQuota: false, externalSources: [],
    manualTargetScope: '手工补跑按上一交易日串行执行 CN 个股分析、HK 个股分析（按港交所日历）与选股轻量归档；CN/HK 与选股互不回滚' },
  { jobCode: 'system_retention', label: '系统数据保留与投影对账清理', hour: 4, minute: 0, weekdays: false, catchupMode: 'latest_only', dataDatePolicy: 'none', freshnessGate: false, requiresDataWatermark: false, strictDatasetPublication: false, category: 'system', importance: 'normal', deadlineMinutes: 120, timeoutMinutes: 120,
    sourceDescription: '本地网站统计与存储保留清理，含每周 PB 投影抽样对账；不访问任何外部接口',
    mayConsumeQuota: false, externalSources: [], retryPolicy: 'local', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'site_analytics_retention', supersededBy: ['system_retention'], label: '网站统计数据保留清理', hour: 2, minute: 0, weekdays: false, deadlineMinutes: 120, catchupWindowMinutes: 360, catchupMode: 'latest_only', requiresDataWatermark: false, category: 'system', importance: 'normal', sourceDescription: '本地网站统计事实表与运行采样表', mayConsumeQuota: false, externalSources: [], externalApis: [], retryPolicy: 'local', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'storage_retention', supersededBy: ['system_retention'], label: '数据库存储保留清理', hour: 2, minute: 15, weekdays: false, deadlineMinutes: 120, catchupWindowMinutes: 360, catchupMode: 'latest_only', dataDatePolicy: 'none', requiresDataWatermark: false, strictDatasetPublication: false, category: 'system', importance: 'normal', sourceDescription: '本地 ops.raw_records 超期未引用原始报文与未发布 partial 选股试算记录', mayConsumeQuota: false, externalSources: [], externalApis: [], retryPolicy: 'local', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  // 站内通知群发投递：只在后台确认后由任务框架执行，无外部数据源，不发布金融数据集
  { jobCode: 'notification_dispatch', label: '站内通知投递', manualOnly: true, dataDatePolicy: 'none', requiresDataWatermark: false, strictDatasetPublication: false, timeoutMinutes: 15, deadlineMinutes: 60, category: 'system', importance: 'normal', sourceDescription: '预览时已固定的本地收件名单；投递前重验账号，不调用任何外部接口', mayConsumeQuota: false, externalSources: [], externalApis: [], maxExternalCallsPerRun: 0, retryPolicy: 'local', retryDelaysMinutes: [1, 5, 15], maxAttempts: 3 },
  // 导入/建仓后补齐账户持仓基准与缺失行情。由导入路由入队，批次上限之外的剩余
  // 由槽位续批机制持久化（result_summary.remaining + next_attempt_at），
  // 缺口清空前不宣告完成；行情来源复用既有回放路径，不新增第二套采集。
  { jobCode: 'account_price_backfill', label: '账户持仓基准与缺失行情补齐', manualOnly: true, dataDatePolicy: 'none', requiresDataWatermark: false, strictDatasetPublication: false, timeoutMinutes: 60, deadlineMinutes: 120, category: 'data_sync', importance: 'normal', sourceDescription: '导入账户后按固定业务日补齐持仓基准快照与缺失收盘价，行情走既有 Tushare/腾讯回放路径', mayConsumeQuota: true, externalSources: ['tushare', 'tencent'], retryPolicy: 'external', retryDelaysMinutes: [5, 15, 45], maxAttempts: 4 },
];

// 任务→接口→数据集契约是生成矩阵和预算门禁的唯一输入；没有外部接口的计算任务必须显式保持空数组。
const JOB_CONTRACTS = {
  // selection_inputs 复用本任务入口补选股输入：官方接口按 lixingerEndpoints.json 已登记的 key 列名，
  // 备源按既有 Tushare/腾讯接口名登记；未知的单批调用额度保持 null，不编造上限。
  'company_financial_incremental_sync': { externalApis: [
    'disclosure_date', 'income', 'balancesheet', 'cashflow', 'fina_indicator', 'dividend', 'sse', 'szse', 'cninfo',
    'cn/company/fs/non_financial', 'hk/company/fs/non_financial',
    'cn/company/dividend', 'hk/company/dividend',
    'cn/company/industries', 'hk/company/industries',
    'hk/company/fundamental/non_financial', 'hk/company/candlestick', 'hk/index/constituents',
    'index_member_all', 'tencent_hk_daily',
  ], producesDatasets: ['stock_financial_reports'], consumesDatasets: ['stock_master', 'financial_disclosure_schedule'], maxExternalCallsPerRun: null,
    datasetPublicationByMode: {
      core: { publish: ['stock_financial_reports'] },
      stock_analysis: { publish: [], requirePublished: [], requireStageComplete: true, requiresDataWatermark: false,
        completionConditions: ['A 股：仅处理用户指定的一只普通 A 股；先核验四类财报覆盖，缺历史时从上市年分窗补齐；财报、分红及公告入库后本地重算分析快照；公告优先交易所、失败或分页不完整才用巨潮', '港股：请求带完整标准代码、目标日与 market=HK；逐域审计并复用已有采集补主档、日线/估值、财报/分红缺口，按域持久化水位只续失败域；报告期不按四个季末枚举，币种/范围/版本按实际元数据；只读重算并保存快照，失败保留上次完整快照', '两种市场都只返回本证券阶段结果、剩余进度、有效数据日与快照版本；不发布整个市场财务或行情分区，不靠 row_count>0 判成功'] },
      // 选股输入补齐：写的是同一张 financial_reports/facts（不新增数据集），按市场+目标日冻结缺口，
      // 未清空剩余对象前不宣告完成；因此这里不设 requireStageComplete（部分完成是正常中间态）。
      selection_inputs: { publish: [], requirePublished: [], requireStageComplete: true, requiresDataWatermark: false,
        completionConditions: ['按市场与目标日冻结选股输入缺口；逐公司复用既有财务采集入口与标准层写入；剩余对象持久化在可续跑队列并以 continuationRequired 续批，只有缺口清空才 allowed stageComplete'] },
    },
  },
  // 安全评分只读取共享收盘批次与财务标准层；外部同步由 universe/financial 任务负责。
  'bond_safety_refresh': { externalApis: [], producesDatasets: ['bond_safety_snapshot'], consumesDatasets: ['bond_master', 'stock_daily', 'stock_valuation', 'stock_financial_reports'], maxExternalCallsPerRun: 0 },
  'market_close:A股': { externalApis: ['tencent_quote', 'daily', 'cn/company/candlestick'], producesDatasets: ['account_daily_prices', 'position_close_bars_cn'], consumesDatasets: ['account_positions', 'stock_daily'], maxExternalCallsPerRun: null },
  'market_close:可转债': { externalApis: ['tencent_quote', 'cb_daily'], producesDatasets: ['account_daily_prices', 'position_close_bars_cn'], consumesDatasets: ['account_positions', 'stock_daily', 'position_close_bars_cn'], maxExternalCallsPerRun: null },
  'market_close:LOF/ETF': { externalApis: ['tencent_quote', 'fund_daily'], producesDatasets: ['account_daily_prices', 'position_close_bars_cn'], consumesDatasets: ['account_positions', 'stock_daily', 'position_close_bars_cn'], maxExternalCallsPerRun: null },
  'hk_rate': { externalApis: ['exchange_rate_realtime', 'exchange_rate'], producesDatasets: ['hk_fx_rate'], consumesDatasets: [], maxExternalCallsPerRun: null },
  'market_close:港股': { externalApis: ['tencent_quote', 'hk/company/candlestick'], producesDatasets: ['account_daily_prices', 'position_close_bars_hk'], consumesDatasets: ['account_positions', 'position_close_bars_hk'], maxExternalCallsPerRun: null },
  'nav_snapshot': { externalApis: ['repo_daily'], producesDatasets: ['nav_snapshot','account_cash_income','repo_daily_rates'], consumesDatasets: ['account_daily_prices','repo_daily_rates'], readinessDatasetDependencies: [{ datasetCode: 'repo_daily_rates', scopeKey: 'CN', partitionDatePolicy: 'business_date', requireQualityStatus: 'passed' }], maxExternalCallsPerRun: null,modeExternalCallLimits:{cash_income:0},
    datasetPublicationByMode:{core:{publish:['nav_snapshot'],optionalPublish:['repo_daily_rates'],completionConditions:['按fromDate至businessDate核验；日任务默认单日，历史补算保留原指定范围及区间内缺口']},cash_income:{publish:['account_cash_income'],requireStageComplete:true}} },
  'index_recent': { externalApis: ['index_daily'], producesDatasets: ['index_daily'], consumesDatasets: [], maxExternalCallsPerRun: null },
  'ipo_calendar_refresh': { externalApis: [], producesDatasets: ['ipo_calendar'], consumesDatasets: ['ipo_history', 'trade_calendar', 'bond_issuance_events', 'bond_listing_liquidity'], maxExternalCallsPerRun: 0 },
  'convertible_bond_universe_refresh': { externalApis: ['cb_basic', 'stock_basic', 'cb_daily', 'daily', 'daily_basic', 'adj_factor', 'suspend_d', 'tencent_quote','repo_daily'], producesDatasets: ['bond_master', 'bond_daily', 'stock_daily', 'stock_valuation', 'stock_adj_factor', 'stock_suspend_calendar','repo_daily_rates'], consumesDatasets: [], maxExternalCallsPerRun: null,
    datasetPublicationByMode:{core:{publish:['bond_master','bond_daily','stock_daily','stock_valuation','stock_adj_factor','stock_suspend_calendar'],optionalPublish:['repo_daily_rates'],requireStageComplete:true},repo_daily:{publish:['repo_daily_rates'],requirePublished:['repo_daily_rates'],requireStageComplete:true},
      shared_eod:{publish:['bond_master','bond_daily','stock_daily','stock_valuation','stock_adj_factor','stock_suspend_calendar'],optionalPublish:['repo_daily_rates'],requireStageComplete:true},
      market_repair:{publish:['bond_master','bond_daily','stock_daily','stock_valuation','stock_adj_factor','stock_suspend_calendar'],requireStageComplete:true},
      stock_lifecycle:{publish:[],requirePublished:[],requireStageComplete:true,requiresDataWatermark:false}} },
  // 候选规模随上市转债变化，不能编造固定调用数；完整遍历由接口官方频率、任务超时和失败分类保护。
  'convertible_bond_revision_motive_inputs_sync': { externalApis: ['top10_cb_holders', 'pledge_stat'], producesDatasets: ['bond_motive_inputs'], consumesDatasets: ['bond_master'], maxExternalCallsPerRun: null },
  'convertible_bond_revision_motive_calculate': { externalApis: [], producesDatasets: ['bond_motive_scores'], consumesDatasets: ['bond_motive_inputs', 'bond_daily'], maxExternalCallsPerRun: 0 },
  'convertible_bond_announcement_history_sync': { externalApis: ['cb_issue', 'sse', 'szse', 'cninfo', 'cb_rating', 'top10_cb_holders', 'cb_price_chg', 'cb_rate'], producesDatasets: ['bond_announcement_facts', 'bond_issuance_events', 'bond_redemption_events', 'bond_listing_liquidity','bond_analysis_inputs'], consumesDatasets: ['bond_master'], maxExternalCallsPerRun: null,
    datasetPublicationByMode:{core:{publish:['bond_announcement_facts','bond_issuance_events','bond_redemption_events'],requireStageComplete:true},calendar:{publish:['bond_announcement_facts','bond_issuance_events','bond_redemption_events','bond_listing_liquidity'],requireStageComplete:true},analysis_inputs:{publish:['bond_analysis_inputs'],requireStageComplete:true},analysis_inputs_targeted:{publish:[],requirePublished:[],requireStageComplete:true,requiresDataWatermark:false}} },
  'convertible_bond_announcement_reparse': { externalApis: [], producesDatasets: ['bond_announcement_facts', 'bond_redemption_events'], consumesDatasets: ['bond_announcement_documents'], maxExternalCallsPerRun: 0 },
  // 市场波动指标不设内部单批外部调用数上限；仍受来源级额度/熔断、并发和任务超时保护。
  'market_volatility_sync': { externalApis: ['index_dailybasic', 'cn_bond_yield', 'hsi_valuation'], producesDatasets: ['market_volatility'], consumesDatasets: [], maxExternalCallsPerRun: null },
  'convertible_bond_valuation_refresh': { externalApis: [], producesDatasets: ['bond_valuation','bond_analysis_snapshot'], consumesDatasets: ['bond_master', 'bond_daily', 'stock_daily', 'stock_suspend_calendar'], maxExternalCallsPerRun: 0 },
  'ipo_history_sync': {
    externalApis: ['new_share', 'daily', 'tencent_quote', 'stock_basic', 'index_member_all', 'sse', 'szse', 'bse', 'cninfo', 'stock_company'],
    producesDatasets: ['ipo_history'], consumesDatasets: [], maxExternalCallsPerRun: null,
    datasetPublicationByMode: {
      prediction_ready: { publish: [], requirePublished: [], requireStageComplete: true },
      core: { publish: ['ipo_history'], requirePublished: ['ipo_history'] },
      enrichment: { publish: [], requirePublished: ['ipo_history'], requireStageComplete: true },
      targeted: { publish: [], requirePublished: [], requireStageComplete: true, requiresDataWatermark: false },
    },
  },
  // 个股分析定时任务为数据库只读计算；财务/行情采集由共享批次和独立增量任务完成。
  // 选股模式的产物是两市场各自的选股快照与输入分区（见 datasetPartitionRegistry），
  // 每个市场独立发布：A 股失败不撤销港股已发布分区，也不让港股等 A 股转债权威链。
  'stock_analysis_refresh': { externalApis: [], producesDatasets: ['stock_analysis_snapshot', 'stock_selection_snapshot_cn', 'stock_selection_snapshot_hk', 'stock_selection_inputs_cn', 'stock_selection_inputs_hk', 'stock_selection_daily_cn', 'stock_selection_daily_hk', 'stock_selection_weekly_cn', 'stock_selection_weekly_hk', 'stock_selection_shadow_cn', 'stock_selection_shadow_hk'], consumesDatasets: ['stock_master', 'stock_daily', 'stock_valuation', 'stock_financial_reports'], maxExternalCallsPerRun: 0,
    datasetPublicationByMode: {
      // HK 定向纯计算：外采 0，复用原 Runner；只按 HK 交易日与目标集发布覆盖证据，单股不发布市场全集分区。
      stock_analysis_hk: { publish: [], requirePublished: [], requireStageComplete: true, requiresDataWatermark: false,
        completionConditions: ['目标集为持仓与显式自选的港股按证券去重；HK 日历缺失时阻塞并说明，不按周一至五猜开市', '按本批冻结目标集、目标 HK 交易日与各域覆盖发布范围证据；无跟踪对象可留证正常空跑', '只消费本地已发布标准事实，逐域 partial/blocked/等待与整体覆盖分别记录，不发布整个 HK 市场财务或行情分区'] },
      // 阶段 1B：单一槽位串行归档双市场×双策略（含影子），每项只落入选 ≤30 席；
      // 日/周/季分区由 Runner 在服务事务内分别发布，这里用 optionalPublish 允许按实际命中集合出现。
      selection_archive_light: {
        publish: [],
        optionalPublish: [
          'stock_selection_daily_cn', 'stock_selection_daily_hk',
          'stock_selection_weekly_cn', 'stock_selection_weekly_hk',
          'stock_selection_shadow_cn', 'stock_selection_shadow_hk',
          'stock_selection_snapshot_cn', 'stock_selection_snapshot_hk',
        ],
        requirePublished: [], requireStageComplete: true, requiresDataWatermark: false,
        completionConditions: [
          '串行完成双市场×双策略轻量归档（含 STOCK_SELECTION_SHADOW=1 的影子批次）；每项只写入选 ≤30 席候选与成员',
          '本周最后开市日顺带落周指针，本季度最后开市日顺带落季指针；未到最后开市日只记录日结果',
          '任一市场/策略未就绪或失败时保留 stageCompletedKind/continuationRequired 以便续跑，不用部分成功冒充整阶段完成',
        ],
      },
    } },
  'hk_trade_rules_sync': { externalApis: ['hk_basic'], producesDatasets: ['hk_trade_rules'], consumesDatasets: [], maxExternalCallsPerRun: null },
  'hk_trade_calendar_sync': { externalApis: ['hk_trade_calendar'], producesDatasets: ['hk_trade_calendar'], consumesDatasets: [], maxExternalCallsPerRun: null },
  'hk_ipo_preopen': {
    externalApis: ['hkex_new_listings', 'hkex_prospectus', 'tencent_quote', 'hk_ipo_public_page'],
    producesDatasets: ['hk_ipo_facts', 'hk_ipo_subscription_signals'], consumesDatasets: ['hk_trade_calendar'], maxExternalCallsPerRun: null,
    datasetPublicationByMode: {
      preopen: { publish: ['hk_ipo_facts', 'hk_ipo_subscription_signals'], completionConditions: ['官方事实按目标日核验；预计当日上市在盘前标记待阶段，过去上市日及已到期定价/配发不得豁免；盘后/补全必须核验实际上市证据'] },
      subscription_midday: { publish: ['hk_ipo_subscription_signals'] },
      subscription_close: { publish: ['hk_ipo_subscription_signals'] },
    },
  },
  'hk_ipo_postclose': { externalApis: ['hkex_allotment', 'hkex_title_search', 'hkex_history_report', 'hkex_market', 'tencent_quote'], producesDatasets: ['hk_ipo_facts'], consumesDatasets: ['hk_trade_calendar','hk_trade_rules'], maxExternalCallsPerRun: null },
  'hk_ipo_enrichment': { externalApis: ['hkex_official_documents', 'hkex_issuance_status_notices', 'hkex_history_report', 'tencent_hk_daily', 'tencent_quote'], producesDatasets: ['hk_ipo_facts', 'hk_ipo_listing_status_notice', 'hk_ipo_grey_market_signals'], consumesDatasets: ['hk_trade_calendar','hk_trade_rules'], maxExternalCallsPerRun: null },
  'arbitrage_sync': { externalApis: ['hkex', 'sse', 'szse', 'cninfo', 'cninfo_permission_probe'], producesDatasets: ['arbitrage_cases','stock_cash_dividend_facts','stock_swap_settlements'], consumesDatasets: [], maxExternalCallsPerRun: null,
    datasetPublicationByMode:{core:{publish:['arbitrage_cases']},cash_dividends:{publish:['stock_cash_dividend_facts'],requirePublished:['stock_cash_dividend_facts'],requireStageComplete:true},stock_swap_settle:{publish:['stock_swap_settlements']}} },
  'arbitrage_reparse': { externalApis: ['cninfo', 'hkex'], producesDatasets: ['arbitrage_cases'], consumesDatasets: ['arbitrage_documents'], maxExternalCallsPerRun: null },
  'holiday_sync': { externalApis: ['trade_cal'], producesDatasets: ['trade_calendar'], consumesDatasets: [], maxExternalCallsPerRun: null },
  'site_analytics_retention': { externalApis: [], producesDatasets: ['site_events', 'site_runtime_minute'], consumesDatasets: [], maxExternalCallsPerRun: 0 },
  'storage_retention': { externalApis: [], producesDatasets: [], consumesDatasets: [], maxExternalCallsPerRun: 0 },
  'notification_dispatch': { externalApis: [], producesDatasets: [], consumesDatasets: [], maxExternalCallsPerRun: 0 },
  // 补价写的是账户私有行情（account_daily_prices 由 market_close 任务发布分区），
  // 本任务不发布金融数据集，只读持仓、补缺失价格与基准快照。
  'account_price_backfill': { externalApis: ['tushare', 'tencent_quote'], producesDatasets: [], consumesDatasets: ['account_positions'], maxExternalCallsPerRun: null },
  // ===== 波次二收敛任务契约（阶段 3）=====
  // 发布口径：聚合 Runner 在每个子阶段成功后调用统一发布入口按目标日逐数据集发布；
  // 这里 publish=[] + requireStageComplete=true，通用发布器只做阶段完成校验、不重复发布，
  // 避免把子阶段写入的分区诊断、水位和 quality_status 洗成汇总快照值。
  // 失败隔离：子阶段失败只记 failedDatasets/pendingStages，已成功子阶段的分区保持已发布。
  'cn_stock_eod_sync': {
    externalApis: ['cb_basic', 'stock_basic', 'cb_daily', 'daily', 'daily_basic', 'adj_factor', 'suspend_d', 'tencent_quote', 'repo_daily',
      'disclosure_date', 'income', 'balancesheet', 'cashflow', 'fina_indicator', 'dividend', 'sse', 'szse', 'cninfo',
      'cn/company/fs/non_financial', 'cn/company/dividend', 'cn/company/industries',
      'index_daily', 'index_dailybasic', 'cn_bond_yield', 'hsi_valuation'],
    producesDatasets: ['bond_master', 'bond_daily', 'stock_daily', 'stock_valuation', 'stock_adj_factor', 'stock_suspend_calendar', 'repo_daily_rates',
      'stock_financial_reports', 'index_daily', 'market_volatility'],
    consumesDatasets: [], maxExternalCallsPerRun: null,
    datasetPublicationByMode: {
      core: { publish: [], optionalPublish: ['bond_master', 'bond_daily', 'stock_daily', 'stock_valuation', 'stock_adj_factor', 'stock_suspend_calendar', 'repo_daily_rates', 'stock_financial_reports', 'index_daily', 'market_volatility'], requireStageComplete: true },
    },
    modeDependencyCodes: { core: [] }, modeDatasetDependencies: { core: [] },
  },
  'hk_stock_eod_sync': {
    externalApis: ['hk_trade_calendar', 'hk_basic', 'hk/company/fs/non_financial', 'hk/company/dividend', 'hk/company/industries',
      'hk/company/fundamental/non_financial', 'hk/company/candlestick', 'hk/index/constituents', 'index_member_all', 'tencent_hk_daily', 'tencent_quote'],
    producesDatasets: ['hk_trade_calendar', 'hk_trade_rules', 'stock_financial_reports'], consumesDatasets: [], maxExternalCallsPerRun: null,
    datasetPublicationByMode: {
      core: { publish: [], optionalPublish: ['hk_trade_calendar', 'hk_trade_rules', 'stock_financial_reports'], requireStageComplete: true },
    },
    modeDependencyCodes: { core: [] }, modeDatasetDependencies: { core: [] },
  },
  'convertible_bond_eod_sync': {
    externalApis: ['cb_basic', 'stock_basic', 'cb_daily', 'daily', 'daily_basic', 'adj_factor', 'suspend_d', 'tencent_quote', 'repo_daily', 'top10_cb_holders', 'pledge_stat'],
    producesDatasets: ['bond_master', 'bond_daily', 'bond_motive_inputs'], consumesDatasets: [], maxExternalCallsPerRun: null,
    datasetPublicationByMode: {
      core: { publish: [], optionalPublish: ['bond_master', 'bond_daily', 'bond_motive_inputs'], requireStageComplete: true },
    },
    modeDependencyCodes: { core: [] }, modeDatasetDependencies: { core: [] },
  },
  'exchange_announcements_sync': {
    externalApis: ['cb_issue', 'sse', 'szse', 'bse', 'cninfo', 'cb_rating', 'top10_cb_holders', 'cb_price_chg', 'cb_rate',
      'new_share', 'daily', 'tencent_quote', 'stock_basic', 'index_member_all', 'stock_company', 'hkex', 'cninfo_permission_probe'],
    producesDatasets: ['bond_announcement_facts', 'bond_issuance_events', 'bond_redemption_events', 'bond_listing_liquidity', 'bond_analysis_inputs',
      'ipo_history', 'arbitrage_cases', 'stock_cash_dividend_facts', 'stock_swap_settlements'],
    consumesDatasets: ['bond_master'], maxExternalCallsPerRun: null,
    datasetDependencies: [{ datasetCode: 'bond_master', scopeKey: 'CN', partitionDatePolicy: 'previous_trading_day' }],
    datasetPublicationByMode: {
      core: { publish: [], optionalPublish: ['bond_announcement_facts', 'bond_issuance_events', 'bond_redemption_events', 'bond_listing_liquidity', 'bond_analysis_inputs', 'ipo_history', 'arbitrage_cases', 'stock_cash_dividend_facts', 'stock_swap_settlements'], requireStageComplete: true },
    },
    modeDependencyCodes: { core: [] },
    modeDatasetDependencies: { core: [{ datasetCode: 'bond_master', scopeKey: 'CN', partitionDatePolicy: 'previous_trading_day' }] },
  },
  'bond_analytics_refresh': {
    externalApis: [], producesDatasets: ['bond_valuation', 'bond_analysis_snapshot', 'bond_safety_snapshot'],
    consumesDatasets: ['bond_master', 'bond_daily', 'stock_daily', 'stock_suspend_calendar', 'stock_financial_reports'], maxExternalCallsPerRun: 0,
    datasetDependencies: ['bond_master', 'bond_daily', 'stock_daily', 'stock_suspend_calendar', 'stock_financial_reports']
      .map(datasetCode => ({ datasetCode, scopeKey: 'CN', partitionDatePolicy: 'previous_trading_day' })),
    datasetPublicationByMode: {
      core: { publish: [], optionalPublish: ['bond_valuation', 'bond_analysis_snapshot', 'bond_safety_snapshot'], requireStageComplete: true },
    },
    modeDependencyCodes: { core: [] },
    modeDatasetDependencies: {
      core: ['bond_master', 'bond_daily', 'stock_daily', 'stock_suspend_calendar', 'stock_financial_reports']
        .map(datasetCode => ({ datasetCode, scopeKey: 'CN', partitionDatePolicy: 'previous_trading_day' })),
    },
  },
  'stock_analytics_refresh': {
    externalApis: [],
    producesDatasets: ['stock_analysis_snapshot', 'stock_selection_daily_cn', 'stock_selection_daily_hk', 'stock_selection_weekly_cn', 'stock_selection_weekly_hk',
      'stock_selection_shadow_cn', 'stock_selection_shadow_hk', 'stock_selection_snapshot_cn', 'stock_selection_snapshot_hk'],
    consumesDatasets: ['stock_master', 'stock_daily', 'stock_valuation', 'stock_financial_reports'], maxExternalCallsPerRun: 0,
    datasetPublicationByMode: {
      core: { publish: [], optionalPublish: ['stock_analysis_snapshot', 'stock_selection_daily_cn', 'stock_selection_daily_hk', 'stock_selection_weekly_cn', 'stock_selection_weekly_hk', 'stock_selection_shadow_cn', 'stock_selection_shadow_hk', 'stock_selection_snapshot_cn', 'stock_selection_snapshot_hk'], requireStageComplete: true },
    },
    modeDependencyCodes: { core: [] }, modeDatasetDependencies: { core: [] },
  },
  'system_retention': {
    externalApis: [], producesDatasets: [], consumesDatasets: [], maxExternalCallsPerRun: 0,
    datasetPublicationByMode: { core: { publish: [], requireStageComplete: true } },
    modeDependencyCodes: { core: [] }, modeDatasetDependencies: { core: [] },
  },
};

const DATA_DATE_POLICIES = Object.freeze(['none', 'same_day', 'previous_trading_day', 'latest_available']);
const PARTITION_DATE_POLICIES = Object.freeze(['business_date', 'previous_trading_day', 'expected_data_date']);
const CONTRACT_FIELDS = Object.freeze([
  'externalApis', 'producesDatasets', 'consumesDatasets', 'datasetDependencies', 'readinessDatasetDependencies', 'maxExternalCallsPerRun',
  'datasetPublicationByMode', 'modeExternalCallLimits',
  // 阶段 3 收敛任务按模式声明依赖（任务码/数据集分区）也必须由契约统一承载与审计。
  'modeDependencyCodes', 'modeDatasetDependencies',
]);

const JOB_DEFINITIONS = JOB_DEFINITION_SOURCE.map(item => ({
  ...DEFAULT_JOB_OPTIONS,
  ...item,
  ...(JOB_CONTRACTS[item.jobCode] || {}),
  ...(['hk_ipo_preopen', 'hk_ipo_postclose', 'hk_ipo_enrichment'].includes(item.jobCode)
    ? { disabled: true, disabledReason: '港股 IPO 暂时下线，等待可用数据源后恢复' } : {}),
}));

const JOB_DEFINITION_MAP = new Map(JOB_DEFINITIONS.map(item => [item.jobCode, item]));

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// 在默认值合并前审计两层原始配置。默认模式只报告存量遗漏，严格模式供新增/修改任务门禁使用。
function validateJobDefinitionSources({
  source = JOB_DEFINITION_SOURCE,
  contracts = JOB_CONTRACTS,
  datasetRegistry = null,
  strict = false,
} = {}) {
  const errors = [];
  const warnings = [];
  const sourceRows = Array.isArray(source) ? source : [];
  const sourceCodes = sourceRows.map(item => item && item.jobCode).filter(Boolean);
  const seen = new Set();
  for (const code of sourceCodes) {
    if (seen.has(code)) errors.push(`JOB_DEFINITION_SOURCE 重复 jobCode：${code}`);
    seen.add(code);
  }
  for (const item of sourceRows) {
    if (!item || !item.jobCode) {
      errors.push('JOB_DEFINITION_SOURCE 存在缺少 jobCode 的任务');
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(item, 'dataDatePolicy')) {
      if (!DATA_DATE_POLICIES.includes(item.dataDatePolicy)) {
        errors.push(`${item.jobCode} 的 dataDatePolicy 非法：${item.dataDatePolicy}`);
      }
    } else if (strict) {
      errors.push(`${item.jobCode} 原始定义缺少 dataDatePolicy，不能依赖默认值`);
    } else {
      warnings.push(`${item.jobCode} 原始定义缺少 dataDatePolicy，当前由默认值补齐`);
    }
    const requirements = Array.isArray(item.datasetDependencies) ? item.datasetDependencies : [];
    const readinessRequirements = Array.isArray(item.readinessDatasetDependencies) ? item.readinessDatasetDependencies : [];
    for (const requirement of [...requirements, ...readinessRequirements]) {
      if (!requirement || !requirement.datasetCode) {
        errors.push(`${item.jobCode} 存在缺少 datasetCode 的数据集依赖`);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(requirement, 'partitionDatePolicy')) {
        if (strict) errors.push(`${item.jobCode}.${requirement.datasetCode} 缺少 partitionDatePolicy，不能依赖默认值`);
        else warnings.push(`${item.jobCode}.${requirement.datasetCode} 缺少 partitionDatePolicy，当前按 business_date 兼容`);
      }
      const policy = requirement.partitionDatePolicy || 'business_date';
      if (!PARTITION_DATE_POLICIES.includes(policy)) {
        errors.push(`${item.jobCode}.${requirement.datasetCode} 的 partitionDatePolicy 非法：${policy}`);
      }
      if (datasetRegistry && !datasetRegistry[requirement.datasetCode]) {
        errors.push(`${item.jobCode}.${requirement.datasetCode} 未登记 DATASET_PARTITION_REGISTRY`);
      }
    }
  }
  const contractCodes = Object.keys(contracts || {});
  for (const code of contractCodes) {
    if (!seen.has(code)) errors.push(`JOB_CONTRACTS 存在孤儿 jobCode：${code}`);
    const contract = contracts[code] || {};
    for (const field of Object.keys(contract)) {
      if (!CONTRACT_FIELDS.includes(field)) errors.push(`${code} 的契约字段不在允许范围：${field}`);
      const sourceItem = sourceRows.find(item => item && item.jobCode === code);
      if (sourceItem && Object.prototype.hasOwnProperty.call(sourceItem, field)
        && !sameJson(sourceItem[field], contract[field])) {
        errors.push(`${code}.${field} 在 JOB_DEFINITION_SOURCE 与 JOB_CONTRACTS 中冲突`);
      }
    }
  }
  for (const item of sourceRows) {
    if (!item || !item.jobCode) continue;
    const effective = { ...DEFAULT_JOB_OPTIONS, ...item, ...(contracts[item.jobCode] || {}) };
    const consumes = new Set(Array.isArray(effective.consumesDatasets) ? effective.consumesDatasets : []);
    for (const requirement of [
      ...(Array.isArray(effective.datasetDependencies) ? effective.datasetDependencies : []),
      ...(Array.isArray(effective.readinessDatasetDependencies) ? effective.readinessDatasetDependencies : []),
    ]) {
      if (requirement && requirement.datasetCode && !consumes.has(requirement.datasetCode)) {
        errors.push(`${item.jobCode} 的硬依赖 ${requirement.datasetCode} 不在 consumesDatasets 中`);
      }
      if (datasetRegistry && requirement && requirement.datasetCode && !datasetRegistry[requirement.datasetCode]) {
        errors.push(`${item.jobCode}.${requirement.datasetCode} 未登记 DATASET_PARTITION_REGISTRY`);
      }
    }
    const declaredDatasets = new Set(effective.producesDatasets || []);
    for (const [mode, phase] of Object.entries(effective.datasetPublicationByMode || {})) {
      if (!mode || !phase || typeof phase !== 'object') {
        errors.push(`${item.jobCode} 存在无效的 datasetPublicationByMode 契约`);
        continue;
      }
      for (const field of ['publish', 'optionalPublish', 'requirePublished']) {
        const codes = phase[field] || [];
        if (!Array.isArray(codes) || new Set(codes).size !== codes.length) {
          errors.push(`${item.jobCode}.${mode}.${field} 必须是无重复数据集代码的数组`);
          continue;
        }
        for (const code of codes) {
          if (!declaredDatasets.has(code)) errors.push(`${item.jobCode}.${mode}.${field} 的 ${code} 未在 producesDatasets 中声明`);
          if (datasetRegistry && !datasetRegistry[code]) errors.push(`${item.jobCode}.${mode}.${field} 的 ${code} 未登记数据集注册表`);
        }
      }
      if ((phase.publish || []).length === 0 && phase.requireStageComplete !== true) {
        errors.push(`${item.jobCode}.${mode} 无发布数据集时必须要求阶段结果完成`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, sourceCount: sourceRows.length, contractCount: contractCodes.length };
}

const JOB_DEFINITION_AUDIT = validateJobDefinitionSources({ datasetRegistry: null, strict: false });
if (!JOB_DEFINITION_AUDIT.ok) {
  throw new Error(`任务定义门禁失败：${JOB_DEFINITION_AUDIT.errors.join('；')}`);
}

function isKnownJobCode(jobCode) {
  return JOB_DEFINITION_MAP.has(jobCode);
}

function getRegisteredJobDefinition(jobCode) {
  return JOB_DEFINITION_MAP.get(jobCode) || null;
}

function getJobDefinition(jobCode) {
  return getRegisteredJobDefinition(jobCode) || { ...DEFAULT_JOB_OPTIONS, jobCode, label: jobCode, deadlineMinutes: 180 };
}

function externalCallLimitForMode(definition, mode = 'core') {
  const limits = definition && definition.modeExternalCallLimits || {};
  const value = Object.prototype.hasOwnProperty.call(limits, mode)
    ? limits[mode] : definition && definition.maxExternalCallsPerRun;
  // null 表示不设置本任务级单批上限；来源级额度、熔断、并发和任务超时仍然有效。
  if (value === null) return null;
  return Math.max(Number(value) || 0, 0);
}

// 选股各模式的合法完成终态（R2-05 / R3-04）：只认"正式发布 / 正常关闭 / 明确空仓 /
// 预览已记录 / 缺口已清空 / 回测可评估"，不允许用"分区行写成功"或 ok:true 冒充。
const SELECTION_STAGE_KINDS = Object.freeze({
  selection_quarterly: ['quarterly_published', 'market_closed', 'no_eligible_member'],
  selection_preview: ['preview_recorded'],
  selection_backtest: ['backtest_evaluated'],
  selection_inputs: ['inputs_cleared'],
  // V2 每日/每周（方案 27.8）：日结果记录成功、周度正式发布、影子评估完成是三种不同的终态；
  // 影子不得用「已发布」冒充，正式也不得拿影子终态结案。整周期休市记 no_session（运营证据）。
  selection_daily: ['daily_recorded', 'shadow_evaluated', 'no_session'],
  selection_weekly: ['weekly_published', 'shadow_evaluated', 'no_eligible_member', 'no_session'],
  // 阶段 1B 单槽归档：日/周/季串行完成后只认这两个终态；部分完成必须续跑。
  selection_archive_light: ['archive_light_completed', 'archive_light_no_session'],
});

function stageCompletionEvidence(definition, result = {}, request = {}) {
  const requestedMode = request.mode || (request.targetCodes?.length ? 'targeted' : definition.mode || 'core');
  if (result.mode !== requestedMode) return false;
  // 选股模式没有 targetCodes 合同：完成证据是"本市场目标日算到明确终态且分区/证据已落库"。
  if (String(requestedMode).startsWith('selection_')) {
    const market = String(request.market || result.market || '').toUpperCase();
    const allowedKinds = SELECTION_STAGE_KINDS[requestedMode] || [];
    return result.ok === true
      && result.stageComplete === true
      && allowedKinds.includes(result.stageCompletedKind)
      && !result.error
      && result.continuationRequired !== true
      && (result.failedDatasets || []).length === 0
      && (result.pendingStages || []).length === 0
      && (!market || String(result.market || '').toUpperCase() === market);
  }
  const phase = definition.datasetPublicationByMode?.[result.mode];
  if (!phase || phase.requiresDataWatermark !== false) return false;
  if (result.ok !== true || result.stageComplete !== true || result.error || result.continuationRequired
    || (result.failedDatasets || []).length || (result.pendingStages || []).length) return false;
  if (requestedMode === 'stock_analysis_hk') {
    const targetSet = Array.isArray(result.targetSet) ? result.targetSet : null;
    if (!targetSet || String(result.market || '').toUpperCase() !== 'HK') return false;
    if (!['open', 'closed'].includes(String(result.marketCalendarStatus || ''))) return false;
    if ((result.remaining || []).length > 0) return false;
    if (targetSet.length === 0) return Boolean(result.emptyReason);
    return Array.isArray(result.results)
      && result.results.length === targetSet.length
      && result.results.every(item => item && item.ok === true);
  }
  const requested = [...new Set((request.targetCodes || []).map(String))].sort();
  const completed = [...new Set((result.codes || []).map(String))].sort();
  const fields = [...new Set(request.targetFields || [])].sort();
  return requested.length > 0 && JSON.stringify(requested) === JSON.stringify(completed)
    && JSON.stringify(fields) === JSON.stringify([...new Set(result.targetFields || [])].sort());
}

function declaredDailyExternalCallBudget(definition) {
  if (!definition || definition.manualOnly) return externalCallLimitForMode(definition) || 0;
  if (Number.isFinite(Number(definition.dailyBudget)) && Number(definition.dailyBudget) >= 0) {
    return Number(definition.dailyBudget);
  }
  const schedules = [{ mode: 'core' }, ...(definition.additionalSchedules || [])];
  return schedules.reduce((sum, schedule) => sum + (externalCallLimitForMode(definition, schedule.mode || 'core') || 0), 0);
}

module.exports = {
  DEFAULT_JOB_OPTIONS, JOB_DEFINITION_SOURCE, JOB_CONTRACTS, JOB_DEFINITIONS, JOB_DEFINITION_AUDIT,
  DATA_DATE_POLICIES, PARTITION_DATE_POLICIES, validateJobDefinitionSources, SELECTION_STAGE_KINDS,
  isKnownJobCode, getRegisteredJobDefinition, getJobDefinition, externalCallLimitForMode, declaredDailyExternalCallBudget, stageCompletionEvidence,
  selectionLegacySlotsEnabled, CONVERGED_JOB_CODES, jobConvergenceEnabled,
};
