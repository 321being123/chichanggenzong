// 上市可转债列表与导出的共享列/格式定义；浏览器 View 和 Node 工作簿服务只共用这一份。
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BondListContract = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLUMNS = [
    ['bond_code', '代码'], ['bond_name', '转债名称'], ['price', '现价'], ['change_pct', '涨跌幅'], ['stock_name', '正股名称'],
    ['stock_price', '正股价'], ['stock_change_pct', '正股涨跌'], ['stock_pb', '正股PB'], ['convert_price', '转股价'], ['conversion_value', '转股价值'],
    ['conversion_premium', '转股溢价率'], ['bond_value', '纯债价值'], ['bond_floor_premium', '债底溢价率'], ['rating', '债券评级'], ['safety', '安全性'],
    ['option_value', '期权价值'], ['theoretical_value', '理论价值'], ['theoretical_deviation', '理论偏离度'], ['stock_volatility', '正股波动率'],
    ['call_trigger_price', '强赎触发价'], ['bond_market_cap_ratio', '转债占比'], ['asset_liability_ratio', '资产负债率'], ['fund_holding_ratio', '基金持仓'],
    ['maturity_date', '到期时间'], ['remaining_years', '剩余年限'], ['remain_size', '剩余规模(亿元)'], ['amount', '成交额(万元)'], ['turnover_rate', '换手率'],
    ['maturity_yield_pre_tax', '到期税前收益'], ['double_low', '双低']
  ];
  var TEXT_COLUMNS = ['bond_code', 'bond_name', 'stock_name', 'rating', 'safety', 'maturity_date'];
  var PERCENT_COLUMNS = [
    'change_pct', 'stock_change_pct', 'conversion_premium', 'bond_floor_premium', 'theoretical_deviation',
    'stock_volatility', 'bond_market_cap_ratio', 'asset_liability_ratio', 'fund_holding_ratio', 'turnover_rate',
    'maturity_yield_pre_tax'
  ];

  return { COLUMNS: COLUMNS, TEXT_COLUMNS: TEXT_COLUMNS, PERCENT_COLUMNS: PERCENT_COLUMNS };
});
