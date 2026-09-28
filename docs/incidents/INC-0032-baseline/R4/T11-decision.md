# T11 决策：Excel 日期单元格

日期：2026-09-28
基线：B00 `a767d091ae19be80e1af30f8f2f1fbdf7235374e`

## 来源合同

- `server/services/excelParser.worker.js` 使用 ExcelJS 读取 XLSX；ExcelJS 的日期单元格返回 `Date`，隔离 Worker 用 `String(Date)` 序列化时保留偏移信息。
- `server/routes/import.js` 收到 Worker 文本后按日期文本解析；若直接收到有效 `Date`，按该 Excel 日期值的 UTC 日期归一化。
- `public/shared/core-earnings.js` 的 Excel 日期序列转换采用 UTC 零点换算；浏览器 `Date` 分支也保留该日期。
- CSV 日期是原文文本，按文件中的显式日期解析。此批没有改 CSV/XLSX 格式或列合同。

## 复核与决定

- 新增的 `server/test/date-time-r4.test.js` 构造真实 ExcelJS XLSX 日期单元格，经隔离解析 Worker、服务端导入归一化及浏览器收益导入逻辑，在 `UTC`、`Asia/Shanghai`、`America/New_York` 三种进程时区都得到 `2026-09-25`。
- 现有 `server/test/upload.test.js` 继续覆盖 CSV BOM、日期文本、Date 输入及旧格式兼容。自动测试未使用私人账本或券商文件。
- Excel 序列号转 UTC 日期是 ExcelJS 的日期值合同，不是服务器业务日转换；不能因 JavaScript 类型为 `Date` 就统一加 8 小时。未发现需要改生产代码的偏移。

## 未覆盖范围

本次没有收到真实脱敏券商旧文件，不能代表所有第三方文件格式均已兼容；本决策只覆盖当前 ExcelJS/CSV 实现及合成日期夹具。未来新增来源格式时须先核实单元格和工作簿日期系统。
