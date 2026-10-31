// 数据层：可转债专属数据集的中立需求入口（主档、发行、评级、前十大持有人）。
//
// 官方目录没有可转债个券接口（261 条里与债券相关的只有两条宏观国债），所以这四个数据集
// 固定使用 Tushare 单一来源；但「用哪个接口、怎么分批、字段怎么给」由本层决定，
// 上层只表达"要哪只债、哪个窗口"，不再自己拼 tushareQuery。
const { tushareQuery, tsRows } = require('../services/market');

const BOND_MASTER_FIELDS = 'ts_code,bond_short_name,stk_code,stk_short_name,list_date,delist_date,maturity_date,conv_end_date,conv_stop_date,conv_price';
const BOND_RATING_FIELDS = 'ts_code,ann_date,rating_date,rating_com_name,rating_way,rating_type,rating,rating_outlook';

// 转债主档：按 ts_code 取单只、或一次取全市场（Tushare 该接口一次可回全量）。
// 返回 Tushare 形状的行，附 source_code 供落库分组。
async function readBondMaster({ tsCode = null, fields = BOND_MASTER_FIELDS, allowEmpty = false } = {}) {
  const params = tsCode ? { ts_code: tsCode } : {};
  const data = await tushareQuery('cb_basic', params, fields, { allowEmpty });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 转债发行条款：增量窗口传日期，全量窗口不传（与既有 lifecycleSyncWindow 的语义一致）。
async function readBondIssuance({ startDate = null, endDate = null, fields, allowEmpty = false } = {}) {
  const params = startDate && endDate
    ? { start_date: String(startDate).replace(/-/g, ''), end_date: String(endDate).replace(/-/g, '') }
    : {};
  const data = await tushareQuery('cb_issue', params, fields, { allowEmpty });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 转债评级历史（单只）。
async function readBondRatings({ tsCode, fields = BOND_RATING_FIELDS } = {}) {
  const data = await tushareQuery('cb_rating', { ts_code: tsCode }, fields);
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 转债前十大持有人：调用方按官方行数上限自行拆批，这里只负责"用哪个接口"。
async function readBondTopHolders({ params, fields, allowEmpty = true } = {}) {
  const data = await tushareQuery('top10_cb_holders', params || {}, fields, { allowEmpty });
  return Array.isArray(data) ? data : tsRows(data);
}

module.exports = {
  BOND_MASTER_FIELDS,
  BOND_RATING_FIELDS,
  readBondIssuance,
  readBondMaster,
  readBondRatings,
  readBondTopHolders,
};
