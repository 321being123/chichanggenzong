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
  retryPolicy: 'local',
  catchupMode: 'per_business_date',
  dataDatePolicy: 'none',
  freshnessGate: false,
};

const JOB_DEFINITIONS = [
  { jobCode: 'bond_safety_refresh', label: '可转债安全评分', hour: 6, minute: 30, weekdays: true, deadlineMinutes: 120, dataDatePolicy: 'previous_trading_day', freshnessGate: true, sourceDescription: '已配置的公司与可转债资料接口', mayConsumeQuota: true, externalSources: ['tushare', '公告'], retryPolicy: 'external', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4 },
  { jobCode: 'market_close:A股', label: 'A股收盘数据', hour: 15, minute: 10, weekdays: true, deadlineMinutes: 90, dataDatePolicy: 'same_day', freshnessGate: true, sourceDescription: '腾讯行情接口', mayConsumeQuota: true, externalSources: ['tencent'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'market_close:可转债', label: '可转债收盘数据', hour: 15, minute: 10, weekdays: true, deadlineMinutes: 90, dataDatePolicy: 'same_day', freshnessGate: true, sourceDescription: '腾讯行情接口', mayConsumeQuota: true, externalSources: ['tencent'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'market_close:LOF/ETF', label: 'LOF/ETF收盘数据', hour: 15, minute: 10, weekdays: true, deadlineMinutes: 90, dataDatePolicy: 'same_day', freshnessGate: true, sourceDescription: '腾讯行情接口', mayConsumeQuota: true, externalSources: ['tencent'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'hk_rate', label: '港币汇率更新', hour: 16, minute: 15, weekdays: true, deadlineMinutes: 90, dataDatePolicy: 'latest_available', freshnessGate: true, sourceDescription: '港币汇率接口', mayConsumeQuota: true, externalSources: ['exchange-rate'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'market_close:港股', label: '港股收盘数据', hour: 16, minute: 10, weekdays: true, deadlineMinutes: 120, dataDatePolicy: 'same_day', freshnessGate: true, sourceDescription: '腾讯行情接口', mayConsumeQuota: true, externalSources: ['tencent'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'nav_snapshot', label: '净值快照', hour: 16, minute: 20, weekdays: true, deadlineMinutes: 120, dataDatePolicy: 'same_day', freshnessGate: true, retryPolicy: 'local' },
  { jobCode: 'index_recent', label: '指数每日补齐', hour: 16, minute: 20, weekdays: true, deadlineMinutes: 120, dataDatePolicy: 'same_day', freshnessGate: true, sourceDescription: 'Tushare 指数接口', mayConsumeQuota: true, externalSources: ['tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'ipo_calendar_refresh', label: '打新日历与日报', hour: 18, minute: 0, weekdays: true, deadlineMinutes: 240, catchupWindowMinutes: 4200, catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: true, importance: 'high', sourceDescription: '打新数据接口与公告源', mayConsumeQuota: true, externalSources: ['tushare', '公告'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'convertible_bond_universe_refresh', label: '可转债行情同步', hour: 8, minute: 0, weekdays: true, catchupMode: 'latest_only', dataDatePolicy: 'previous_trading_day', freshnessGate: true, sourceDescription: '腾讯行情与 Tushare 接口', mayConsumeQuota: true, externalSources: ['tencent', 'tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4 },
  { jobCode: 'convertible_bond_redemption_announcement_sync', label: '可转债强赎公告同步', hour: 7, minute: 45, weekdays: true, catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: false, requiresDataWatermark: false, sourceDescription: '巨潮资讯官方公告', mayConsumeQuota: true, externalSources: ['巨潮资讯'], retryPolicy: 'external', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4 },
  { jobCode: 'convertible_bond_announcement_history_sync', label: '可转债下修与转股价公告事实同步', manualOnly: true, requiresDataWatermark: false, deadlineMinutes: 240, timeoutMinutes: 120, importance: 'high', sourceDescription: '巨潮资讯与交易所官方公告，结果写入公告事实库', mayConsumeQuota: true, externalSources: ['巨潮资讯', '上交所', '深交所'], retryPolicy: 'external', retryDelaysMinutes: [15, 60, 240], maxAttempts: 4 },
  { jobCode: 'market_volatility_sync', label: '股市波动指标', hour: 18, minute: 45, weekdays: true, catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: true, freshnessMaxLagDays: 45, sourceDescription: '中债、中证指数、恒生指数及美国十年期国债收益率替代基准', mayConsumeQuota: true, externalSources: ['tushare', '中债', '中证指数', '恒生指数'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'convertible_bond_valuation_refresh', label: '可转债估值预警', hour: 8, minute: 15, weekdays: true, deadlineMinutes: 360, dataDatePolicy: 'previous_trading_day',
    dependencyCodes: ['convertible_bond_universe_refresh'], freshnessGate: true, retryPolicy: 'local' },
  { jobCode: 'ipo_history_sync', label: '新股历史同步', hour: 19, minute: 30, weekdays: true, catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: true, deadlineMinutes: 240, sourceDescription: '新股历史数据接口', mayConsumeQuota: true, externalSources: ['tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'stock_analysis_refresh', label: '个股分析刷新', hour: 20, minute: 30, weekdays: true, catchupMode: 'latest_only', dataDatePolicy: 'latest_available', freshnessGate: true, deadlineMinutes: 360, sourceDescription: 'Tushare 与已入库标准行情', mayConsumeQuota: true, externalSources: ['tushare', 'tencent', '公告'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'hk_trade_rules_sync', label: '港股每手股数同步', hour: 20, minute: 30, weekdays: true, catchupMode: 'latest_only', requiresDataWatermark: false, sourceDescription: '港交所证券资料接口', mayConsumeQuota: true, externalSources: ['tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'arbitrage_sync', label: '套利公告同步', hour: 21, minute: 30, weekdays: true, catchupMode: 'latest_only', requiresDataWatermark: false, sourceDescription: '港交所与巨潮资讯公告接口', mayConsumeQuota: true, externalSources: ['港交所', '巨潮资讯'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
  { jobCode: 'arbitrage_reparse', label: '套利公告重新解析', manualOnly: true, requiresDataWatermark: false, deadlineMinutes: 240, timeoutMinutes: 120, importance: 'high', sourceDescription: '已入库公告 PDF 与本地解析器' },
  { jobCode: 'holiday_sync', label: '休市日历月度同步', hour: 7, minute: 0, weekdays: false, monthly: true, deadlineMinutes: 1440, catchupWindowMinutes: 43200, catchupMode: 'latest_only', requiresDataWatermark: false, category: 'system', importance: 'high', sourceDescription: 'Tushare 交易日历接口', mayConsumeQuota: true, externalSources: ['tushare'], retryPolicy: 'external', retryDelaysMinutes: [15, 60], maxAttempts: 3 },
].map(item => ({ ...DEFAULT_JOB_OPTIONS, ...item }));

const JOB_DEFINITION_MAP = new Map(JOB_DEFINITIONS.map(item => [item.jobCode, item]));

function getJobDefinition(jobCode) {
  return JOB_DEFINITION_MAP.get(jobCode) || { ...DEFAULT_JOB_OPTIONS, jobCode, label: jobCode, deadlineMinutes: 180 };
}

module.exports = { JOB_DEFINITIONS, getJobDefinition };
