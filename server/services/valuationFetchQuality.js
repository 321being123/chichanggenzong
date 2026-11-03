// 估值取数缺口质量证据：实现已下沉到 server/dataAccess/valuationGapQuality.js（R2-07）。
// 本文件只保留既有导出面，避免调用方改动；不要再把 SQL 写回这里——
// 服务层角色不允许持 SQL，静态分层门禁会以 SQL_IN_NON_DATA_LAYER 拦下。
module.exports = require('../dataAccess/valuationGapQuality');
