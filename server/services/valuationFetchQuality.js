// 估值取数缺口的可查询质量证据（验收 V-01，复验 RV-01 修正）。
//
// 2026-11-02 分层整改：本模块原先在服务层直接写 SQL，同时被数据层
// `server/dataAccess/marketDatasets.js` 反向 require，触发门禁
// CROSS_LAYER_IMPORT 与 4 条 SQL_IN_NON_DATA_LAYER。现把实现整体迁到
// `server/dataAccess/valuationQualityIssues.js`（data_access 角色，允许 SQL），
// 本文件只保留转发，供既有调用方与测试按原路径 require，行为不变。
//
// 缺口身份与恢复判据（原始设计说明）：
//   缺口写进既有的 `ops.data_quality_issues`（不新建进度表），按「失败单元」逐条记录：
//   - 序列类单元：(证券, 段起, 段止)；只有同一证券、且该段被本次成功区间包含时才关闭；
//   - 快照类单元：(交易日, 证券集合)；只有同一交易日、且单元里每只证券这次都成功时才关闭。
//   任一维度不满足就保持 open，续跑范围可直接从 details.unit 查出来。
module.exports = require('../dataAccess/valuationQualityIssues');
