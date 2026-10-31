// 数据层：参考类与资金类数据集的中立需求入口。
//
// 覆盖：交易日历（trade_cal）、停牌（suspend_d）、港股主档（hk_basic）、港股日线（hk_daily）、
// 质押式回购利率（repo_daily）、股权质押统计（pledge_stat）、美债收益率（us_tycr）。
// 这些数据集官方目录都没有等价接口，来源固定为 Tushare；本层负责"用哪个接口、怎么分批、字段怎么给"，
// 上层只表达需求，不再自己拼 tushareQuery。
const { tushareQuery, tsRows } = require('../services/market');

// 交易日历：openOnly=true 只取开市日（is_open=1）。
async function readTradingCalendar({ exchange = 'SSE', startDate, endDate, openOnly = false, fields = 'cal_date,is_open' } = {}) {
  const params = {
    exchange,
    start_date: String(startDate).replace(/-/g, ''),
    end_date: String(endDate).replace(/-/g, ''),
  };
  if (openOnly) params.is_open = '1';
  const data = await tushareQuery('trade_cal', params, fields, { allowEmpty: true });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 停牌：区间内的停牌事实（停牌日是强赎/下修计算的共同输入）。
async function readSuspensions({ startDate, endDate, fields = 'ts_code,trade_date,suspend_type,suspend_reason' } = {}) {
  const data = await tushareQuery('suspend_d', {
    start_date: String(startDate).replace(/-/g, ''),
    end_date: String(endDate).replace(/-/g, ''),
  }, fields, { allowEmpty: true });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 港股主档（在交易清单 + 每手股数）。
async function readHkSecurityMaster({ listStatuses = ['L'], fields = 'ts_code,name,market,list_date,trade_unit,curr_type' } = {}) {
  const statuses = Array.isArray(listStatuses) ? listStatuses : [listStatuses];
  const rows = [];
  for (const status of statuses) {
    const data = await tushareQuery('hk_basic', { list_status: status }, fields, { allowEmpty: true });
    rows.push(...tsRows(data).map(row => ({ ...row, source_code: 'tushare' })));
  }
  return rows;
}

// 港股日线：单只区间（Tushare hk_daily 一次只接受一个 ts_code）。
async function readHkDailyQuotes({ tsCode, startDate, endDate, fields, allowEmpty = true } = {}) {
  const data = await tushareQuery('hk_daily', {
    ts_code: tsCode,
    start_date: String(startDate).replace(/-/g, ''),
    end_date: String(endDate).replace(/-/g, ''),
  }, fields, { allowEmpty });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 质押式回购利率：单品种按自然年分批（避免官方 2000 行截断），返回行数组。
async function readRepoRates({ tsCode, startDate, endDate, fields = 'ts_code,trade_date,repo_maturity,weight,close' } = {}) {
  const data = await tushareQuery('repo_daily', {
    ts_code: tsCode,
    start_date: String(startDate).replace(/-/g, ''),
    end_date: String(endDate).replace(/-/g, ''),
  }, fields);
  const payload = data && data.data ? data.data : data;
  const rows = payload && Array.isArray(payload.items)
    ? payload.items.map(item => Object.fromEntries((payload.fields || []).map((field, index) => [field, item[index]])))
    : tsRows(data);
  return rows.map(row => ({ ...row, source_code: 'tushare' }));
}

// 股权质押统计（单只证券某报告期）。
async function readPledgeStats({ tsCode, endDate = null, fields = 'ts_code,end_date,pledge_count,unrest_pledge,rest_pledge,total_share,pledge_ratio' } = {}) {
  const params = { ts_code: tsCode };
  if (endDate) params.end_date = String(endDate).replace(/-/g, '');
  const data = await tushareQuery('pledge_stat', params, fields, { allowEmpty: true });
  return tsRows(data);
}

// 美债收益率（us_tycr）：按时间窗口取，返回 Tushare 原始行。
async function readUsTreasuryYield({ startDate, endDate, fields = 'date,y10' } = {}) {
  const data = await tushareQuery('us_tycr', {
    start_date: String(startDate).replace(/-/g, ''),
    end_date: String(endDate).replace(/-/g, ''),
  }, fields);
  if (!data) throw new Error(`美债收益率查询失败（${startDate}-${endDate}）`);
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 港股交易日历：接口名与交易所由配置决定（默认 hk_tradecal），
// 调用方只说"要港股日历的哪段"，不关心具体接口名与字段差异。
async function readHkTradingCalendar({ startDate, endDate, apiName = null, exchange = null, fields = null } = {}) {
  const name = String(apiName || process.env.TUSHARE_HK_TRADE_CAL_API || 'hk_tradecal').trim();
  const params = {
    start_date: String(startDate).replace(/-/g, ''),
    end_date: String(endDate).replace(/-/g, ''),
  };
  if (name !== 'hk_tradecal') params.exchange = exchange || process.env.TUSHARE_HK_TRADE_CAL_EXCHANGE || 'HKEX';
  const columns = fields || (name === 'hk_tradecal' ? 'cal_date,is_open,pretrade_date' : 'cal_date,trade_date,is_open,pretrade_date');
  const data = await tushareQuery(name, params, columns, { allowEmpty: true });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

module.exports = {
  readHkTradingCalendar,
  readHkDailyQuotes,
  readHkSecurityMaster,
  readPledgeStats,
  readRepoRates,
  readSuspensions,
  readTradingCalendar,
  readUsTreasuryYield,
};
