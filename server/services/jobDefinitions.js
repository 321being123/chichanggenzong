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
};

const JOB_DEFINITIONS = [
  { jobCode: 'bond_safety_refresh', label: '可转债安全评分', hour: 6, minute: 30, weekdays: true, deadlineMinutes: 120, dataDatePolicy: 'previous_trading_day', sourceDescription: '已配置的公司与可转债资料接口', mayConsumeQuota: true },
  { jobCode: 'market_close:A股', label: 'A股收盘数据', hour: 15, minute: 10, weekdays: true, deadlineMinutes: 90, sourceDescription: '腾讯行情接口' },
  { jobCode: 'market_close:可转债', label: '可转债收盘数据', hour: 15, minute: 10, weekdays: true, deadlineMinutes: 90, sourceDescription: '腾讯行情接口' },
  { jobCode: 'market_close:LOF/ETF', label: 'LOF/ETF收盘数据', hour: 15, minute: 10, weekdays: true, deadlineMinutes: 90, sourceDescription: '腾讯行情接口' },
  { jobCode: 'hk_rate', label: '港币汇率更新', hour: 16, minute: 15, weekdays: true, deadlineMinutes: 90, sourceDescription: '港币汇率接口' },
  { jobCode: 'market_close:港股', label: '港股收盘数据', hour: 16, minute: 10, weekdays: true, deadlineMinutes: 120, sourceDescription: '腾讯行情接口' },
  { jobCode: 'nav_snapshot', label: '净值快照', hour: 16, minute: 20, weekdays: true, deadlineMinutes: 120 },
  { jobCode: 'index_recent', label: '指数每日补齐', hour: 16, minute: 20, weekdays: true, deadlineMinutes: 120 },
  { jobCode: 'ipo_calendar_refresh', label: '打新日历与日报', hour: 18, minute: 0, weekdays: true, deadlineMinutes: 240, catchupWindowMinutes: 4200, importance: 'high', sourceDescription: '打新数据接口与公告源', mayConsumeQuota: true },
  { jobCode: 'convertible_bond_universe_refresh', label: '可转债行情同步', hour: 18, minute: 0, weekdays: true, deadlineMinutes: 240, sourceDescription: '腾讯行情与 Tushare 接口', mayConsumeQuota: true },
  { jobCode: 'market_volatility_sync', label: '股市波动指标', hour: 18, minute: 45, weekdays: true, deadlineMinutes: 240, freshnessMaxLagDays: 45, sourceDescription: '中债、中证指数、恒生指数及美国十年期国债收益率替代基准', mayConsumeQuota: true },
  { jobCode: 'convertible_bond_valuation_refresh', label: '可转债估值预警', hour: 18, minute: 15, weekdays: true, deadlineMinutes: 360, dataDatePolicy: 'previous_trading_day',
    dependencyCodes: ['convertible_bond_universe_refresh'] },
  { jobCode: 'ipo_history_sync', label: '新股历史同步', hour: 19, minute: 30, weekdays: true, deadlineMinutes: 240, sourceDescription: '新股历史数据接口', mayConsumeQuota: true },
  { jobCode: 'stock_analysis_refresh', label: '个股分析刷新', hour: 20, minute: 30, weekdays: true, deadlineMinutes: 360, sourceDescription: 'Tushare 与已入库标准行情', mayConsumeQuota: true },
  { jobCode: 'hk_trade_rules_sync', label: '港股每手股数同步', hour: 20, minute: 30, weekdays: true, deadlineMinutes: 360, requiresDataWatermark: false, sourceDescription: '港交所证券资料接口' },
  { jobCode: 'arbitrage_sync', label: '套利公告同步', hour: 21, minute: 30, weekdays: true, deadlineMinutes: 360, sourceDescription: '港交所与巨潮资讯公告接口' },
  { jobCode: 'arbitrage_reparse', label: '套利公告重新解析', manualOnly: true, requiresDataWatermark: false, deadlineMinutes: 240, timeoutMinutes: 120, importance: 'high', sourceDescription: '已入库公告 PDF 与本地解析器' },
  { jobCode: 'holiday_sync', label: '休市日历月度同步', hour: 7, minute: 0, weekdays: false, monthly: true, deadlineMinutes: 1440, catchupWindowMinutes: 43200, requiresDataWatermark: false, category: 'system', importance: 'high' },
].map(item => ({ ...DEFAULT_JOB_OPTIONS, ...item }));

const JOB_DEFINITION_MAP = new Map(JOB_DEFINITIONS.map(item => [item.jobCode, item]));

function getJobDefinition(jobCode) {
  return JOB_DEFINITION_MAP.get(jobCode) || { ...DEFAULT_JOB_OPTIONS, jobCode, label: jobCode, deadlineMinutes: 180 };
}

module.exports = { JOB_DEFINITIONS, getJobDefinition };
