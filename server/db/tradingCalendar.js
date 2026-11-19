// 交易日历的运行时读取入口（infrastructure 层）。
//
// 为什么不在业务模块里直接读 config：`server/services` 里的数据集发布属于 data_access 角色，
// 该角色禁止直接依赖 config 层。这里把同一份运行时休市日历转交出去，
// 让调度与"休市跳过发布"用同一套判断，不产生第二套交易日口径。
'use strict';

function isTradingDate(date) {
  return require('../config/holidays').isTradingDate(date);
}

module.exports = { isTradingDate };
