# T12 决策：分析新鲜度、套利公告与港股日线日期输入

日期：2026-09-28
基线：B00 `a767d091ae19be80e1af30f8f2f1fbdf7235374e`

| 入口 | 实际传入值 | 决定 |
|---|---|---|
| `analysisFreshness.isoDateSafe` | `stockAnalysis` 传入腾讯行情 `quote_time`；`tencentQuote.parseQuoteTime` 将源时刻规范为带 `+08:00` 的 ISO 时刻 | 保留显式时区时刻；不是 PostgreSQL DATE。目标日先由上海业务时钟转成日期文本。 |
| `arbitrageRules.buildEventKey` | 交易所公告映射先经 `normalizeAnnouncementDate` 产出 `YYYY-MM-DD` 文本；事件键以公告源日期为锚 | 纯日期保持原日。Date 支持仅为防御性输入和单元测试，不是标准采集调用链。 |
| `hkDailyCoverage.isoDate` | `loadCandidates` 的 `list_date::text`，Tushare `trade_date` 的 `YYYYMMDD` 或腾讯 `trade_date` 的 `YYYY-MM-DD` | 保留已存在的 `::text` 与源格式归一化；没有 PostgreSQL Date 进入标准路径。 |

## 验证与决定

- B00 的合成 PostgreSQL DATE 输入可以复现 UTC 截日偏移；这说明这些工具不能被任意改为接受 PostgreSQL Date 并截 ISO。
- 对照真实调用点和 SQL 后，三条生产路径分别传明确 `+08:00` 的真实时刻、公告日期文本和 `::text`/源格式日期文本；未发现实际 PostgreSQL DATE 输入。
- `server/test/date-time-r4.test.js` 复核腾讯 `+08:00` 报价日期、套利公告日期键以及港股日线两种源日期格式均保持 `2026-09-25`。完整测试还运行现有分析与公告回归。
- 因当前来源合同清楚且无错误输入路径，不改 helper 的防御性 Date 分支；继续禁止将 `::text` 保护改成裸 PG DATE 解码。
