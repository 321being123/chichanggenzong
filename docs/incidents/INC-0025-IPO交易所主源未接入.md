# INC-0025：A 股 IPO 资料补全未接入交易所主源

状态：跟踪中
日期：2026-09-15

## 现象与影响

CNINFO 接口限流/熔断时，301716（鸿富诚）和 920202（安达股份）的 IPO 主营业务补全进入等待，线上“交易所兜底”没有实际覆盖 A 股 IPO 链路。

## 根因链路

Tushare `new_share` → `ipo_history_sync` → `fetch_stock_historical_detail` → 原先直接调用 CNINFO 招股书 → CNINFO 熔断 → 增强字段未补齐、槽位等待。

现有交易所适配只服务可转债上市公告解析，未被 A 股 IPO 主营业务补全调用；深交所和北交所官方接口也分别要求简称检索、代码检索，不能用同一套旧参数代替。

## 直接原因、根本原因与保护机制失效原因

- 直接原因：IPO 主营业务函数没有交易所候选发现和官方 PDF 解析分支。
- 根本原因：数据源登记、任务契约和补全代码按“巨潮为主源”长期演进，未把交易所 IPO 披露纳入同一条 Guard 链路。
- 保护机制失效：CNINFO 熔断虽正确等待，但因没有主源可用，等待被误认为“没有其他来源可执行”。

## 同类范围与核查结果

已覆盖上交所、深交所、北交所三类 A 股代码路径；定向核查 301716、920202。可转债上市公告链路保持原有行为，不改其事实表和解析口径。

## 修复与回归证据

版本 `0.8.1.33` 接入：上交所 `queryCompanyBulletinNew.do`、深交所 `api/ras/infodisc/query`、北交所 `disclosureInfoController/zoneInfoResult.do`；官方 PDF 无效或正文解析失败才进入 CNINFO，最后才回退 Tushare `stock_company`。来源写入 `source_payload.historical_enrichment.main_business_source`，迁移 154 登记 `bse` 策略。

本地回归覆盖交易所优先、交易所失败才走巨潮和 `bse.cn` 来源分类；全量测试、知识门禁及生产定向运行结果在发布后补录。

## 防复发措施与遗留风险

任务契约明确声明 `sse/szse/bse/cninfo/stock_company`；架构文档固定主备顺序和官方域名。交易所反爬挑战页、接口改版或 PDF 版式变化仍会触发巨潮备源，不把 HTTP 200 的 HTML 挑战页当作成功；若交易所和巨潮同时不可用，继续保留等待状态和已有有效字段。
