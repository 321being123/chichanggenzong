# T13 决策：US/10 手工导入的日期上限

日期：2026-09-28
基线：B00 `a767d091ae19be80e1af30f8f2f1fbdf7235374e`

## 已确认输入

- 用户确认手工 US/10 文件中的时间按北京时间处理。
- CSV/XLSX 中的观察日期仍作为纯日期原值保存到 `source_date`；不把日期当作时刻转换，也不改写历史观察日期。
- 仓库未记录文件发布者，也未收到真实脱敏文件样本，因此只确定“当前日期”的时区，不推断或修改原有最多 6 个日历日向前补齐规则。

## 实施与回归

- `server/routes/marketVolatility.js` 上传入口和 `server/scripts/importFederalFundsCsv.js` 离线导入入口统一以 `CoreDate.todayInZone('Asia/Shanghai')` 作为补齐截止日。
- `server/test/date-time-r4.test.js` 固定 `2026-09-27T16:30:00Z`，在 `UTC`、`Asia/Shanghai`、`America/New_York` 三种进程时区均得北京时间 `2026-09-28`；同时检查两个导入调用点使用上海日期。
- 定向回归：`node server/test/date-time-r4.test.js`，通过。批次全量验证以 R4 `verification.json` 为准。

## 边界

此修复只统一“今天”的北京时间上限；保持观察日、来源记录和最多 6 日填充不变。没有验证真实券商/供应商历史文件格式，也没有查询或写入生产数据。
