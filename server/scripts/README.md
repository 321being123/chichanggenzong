# server/scripts 脚本归属清单

> 生成于 2026-10-21（审查 R-10：一次性脚本此前无归属文档，持续累积）。
> 新增脚本必须在本文件登记用途与状态；一次性脚本执行完成后标注「已完成/已废弃」，不再默默堆积。

## 分类约定

| 类别 | 说明 |
|---|---|
| 发布/常驻入口 | `runMigrations.js`（发布时执行迁移）、`sendBackupFailureAlert.js`（systemd OnFailure 告警），部署流程引用，不得随手改名 |
| npm 脚本入口 | `package.json` 的 audit:bonds / backfill:terms-hash / backtest:motive / audit:instrument-merges / probe:tushare-permissions / check:data-architecture 指向的工具 |
| Python 解析器 | 由后台任务/Runner 以子进程调用（extract*.py、convertibleBond*.py 等），随任务契约演进 |
| 审计/回补/修复/探针 | 运维与数据治理一次性工具；默认只读预览，写入需显式 `--apply`；执行完在下表标注状态 |
| 手工归档 | 根目录 `scripts_manual/`（带日期后缀的补跑脚本），只增不改历史脚本 |

## 根目录历史入口说明

仓库根的 `test.js` / `test-integration.js` / `test-security.js` 等为历史入口（`npm test`、`npm run test:unit`、`npm run test:integration` 仍指向它们）；**正式回归以 `npm.cmd run test:all`（`server/test/run-all.js`）为准**，新测试一律放 `server/test/*.test.js`。

## JavaScript 工具（server/scripts/）

| 文件 | 用途（首行注释） | 状态 |
|---|---|---|
| `acceptanceDataArchitecture.js` | 证券数据架构只读验收工具。 | |
| `auditAccountConsistency.js` | ========== 账户数据一致性只读审计（2026-08-03 整改报告 8.4 / 阶段一） ========== | |
| `auditCashIncomeCoverage.js` | （缺首行说明，补充后更新本表） | |
| `auditConvertibleBondPriceChanges.js` | （缺首行说明，补充后更新本表） | |
| `auditHeldConvertibleBondNoRevision.js` | （缺首行说明，补充后更新本表） | |
| `auditInstrumentMerges.js` | 证券历史 ID 合并审计工具。 | |
| `auditMarketCalendar.js` | 只读日历对账：不发外部请求、不写数据库。 | |
| `auditSnapshotFreshness.js` | 快照一致性审计：找出与当前标准事实不一致的股债分析快照（仅取每只证券最新一份快照）。 | |
| `backfillArbitrage.js` | ========== 套利公告首次 1 年同步入口 ========== | |
| `backfillBondUnifiedLinks.js` | 一次性回填：标准主档缺失的正股关联补齐（幂等）。 | |
| `backfillCompanyFinancials.js` | 公司财务历史回填：默认只预览；真正写入必须显式传入 --apply。 | |
| `backfillConvertibleBondCycle.js` | 可转债周期：手动补缺入口（应急用） | |
| `backfillConvertibleBondStockMarket.js` | （缺首行说明，补充后更新本表） | |
| `backfillDatasetPartitions.js` | 为已存在的非核心数据集补齐 ops.dataset_partitions 元数据，不调用外部接口。 | |
| `backfillMarketCycleMetrics.js` | （缺首行说明，补充后更新本表） | |
| `backfillTermsHash.js` | 回填存量可转债快照的水位 terms_hash 为标准条款表口径，且按「各快照自身 as_of_date 当时生效的条款 | |
| `backtestConvertibleBondMotive.js` | 可转债下修动机：公告前时间滚动回测与历史评分回填。 | |
| `captureCashIncomeBaseline.js` | P0a 只读基线：业务数据仅保存在本机 _probe，不进入 Git。 | |
| `checkWorkerHealth.js` | （缺首行说明，补充后更新本表） | |
| `exportVerifiedBondCallFacts.js` | （缺首行说明，补充后更新本表） | |
| `importCashIncomeEvidence.js` | 经明确授权的事实搬运：原文进入统一公告库，随后只调用原分红Runner和现金服务；不搬运余额或自动流水。 | |
| `importFederalFundsCsv.js` | （缺首行说明，补充后更新本表） | |
| `importHsiWeightedValuationCsv.js` | （缺首行说明，补充后更新本表） | |
| `importMarketVolatilityExport.js` | （缺首行说明，补充后更新本表） | |
| `migrateInstrumentMerges.js` | 历史证券 ID 分批迁移工具。 | |
| `probeHkexIpo.js` | 港交所 IPO 入口探针；默认只读，--persist 才把探针摘要写入 ops 审计表。 | |
| `probeTusharePermissions.js` | 6,000 积分 Tushare 权限探测：逐 Token、逐接口登记实测结果。 | |
| `rebuildBondCallProjection.js` | （缺首行说明，补充后更新本表） | |
| `recalculateCashIncome.js` | 明确指定用户；沿用本地服务，不采集、不部署、不触碰其他用户。 | |
| `reconcileAlertHistory.js` | 历史后台告警收敛核查：默认只读预览；--apply 仅关闭已验证恢复且显式列出的告警。 | |
| `repairArbitrageEvents.js` | （缺首行说明，补充后更新本表） | |
| `repairConvertibleBondCallEvents.js` | （缺首行说明，补充后更新本表） | |
| `repairFxRateHistory.js` | 统一历史港币汇率并修复冲突日期的净值快照。 | |
| `repairHkTradeCalendarPartitions.js` | 港股交易日历业务分区定向修复：默认只读预览；--apply 才写入且保留原记录。 | |
| `repairStockMarketDate.js` | （缺首行说明，补充后更新本表） | |
| `reparseArbitrageTerms.js` | ========== 套利条款一次性回补脚本 ========== | |
| `runMigrations.js` | 发布维护阶段使用迁移账号执行数据库升级；Web/Worker 只做版本检查。 | |
| `sendBackupFailureAlert.js` | systemd OnFailure 入口：复用统一的 ops.alert_notifications + SMTP 告警 | |
| `syncCashIncomeFacts.js` | （缺首行说明，补充后更新本表） | |
| `syncConvertibleBondSuspensions.js` | （缺首行说明，补充后更新本表） | |
| `syncHkexAllotmentFacts.js` | 从港交所披露易官方配发结果英文 PDF 增量补齐港股 IPO 初始发售结构。 | |
| `syncHkexHistoricalReports.js` | 从港交所官方新上市 Excel 报表增量回填港股 IPO 历史事实。 | |
| `syncHkexProspectusFacts.js` | 从港交所披露易官方招股书增量补齐申购事实和保荐人证据。 | |
| `syncTencentHkDailyCoverage.js` | 使用项目已有腾讯行情源补齐港股 IPO 上市首日及上市后五个交易日日线。 | |
| `verifyCashIncomeBaseline.js` | （缺首行说明，补充后更新本表） | |

## Python 解析器/工具（server/scripts/）

| 文件 | 用途（首行注释） | 状态 |
|---|---|---|
| `convertibleBondDocument.py` | （缺首行说明，补充后更新本表） | |
| `convertibleBondValuation.py` | （缺首行说明，补充后更新本表） | |
| `extractArbitrageDocument.py` | （缺首行说明，补充后更新本表） | |
| `extractConvertibleBondCallEvent.py` | （缺首行说明，补充后更新本表） | |
| `extractConvertibleBondFundHoldings.py` | （缺首行说明，补充后更新本表） | |
| `extractConvertibleBondLifecycle.py` | （缺首行说明，补充后更新本表） | |
| `extractConvertibleBondNoRevision.py` | （缺首行说明，补充后更新本表） | |
| `extractConvertibleBondPriceChange.py` | （缺首行说明，补充后更新本表） | |
| `extractConvertibleBondPriceHistory.py` | （缺首行说明，补充后更新本表） | |
| `extractConvertibleBondProspectus.py` | （缺首行说明，补充后更新本表） | |
| `extractConvertibleBondRating.py` | （缺首行说明，补充后更新本表） | |
| `extractHkIpoAllotment.py` | （缺首行说明，补充后更新本表） | |
| `extractHkIpoProspectus.py` | （缺首行说明，补充后更新本表） | |
| `probeRepoOfficial.py` | （缺首行说明，补充后更新本表） | |

## 手工归档（scripts_manual/）

- `backfill_cycle_0727.js`
