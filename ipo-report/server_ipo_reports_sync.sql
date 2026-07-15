SET standard_conforming_strings = on;
CREATE TABLE IF NOT EXISTS ipo_reports (  report_date  TEXT                     NOT NULL,  html         TEXT,  md           TEXT,  summary_json JSONB,  created_at   TIMESTAMPTZ DEFAULT now(),  PRIMARY KEY (report_date));
INSERT INTO ipo_reports (report_date, html, md, summary_json, created_at) VALUES ('2026-07-15', NULL, '# 🏦 打新日报 — 2026年07月15日 周三

> 📅 报告生成时间：2026-07-14 14:12
> 🌡️ 新股温度：**🔥 热市**（破发率0%，近6月均涨幅0%）
> 🏷️ 新债温度：**🔥 热市**（破发率0%，近6月均涨幅0%）
> ⚠️ 声明：以下内容仅供参考，不构成投资建议。打新有风险，投资需谨慎。

## 📋 结论

**打新**
- 曙26发债（顶格申购）

---
## 一、明日可申购

### 💰 新债申购

| 债券代码 | 债券简称 | 评级 | 发行规模(亿) | 转股价 | 转股价值 | 溢价率 | 申购建议 |
|----------|----------|------|-------------|--------|----------|--------|----------|
| 113708 | 曙26发债 | AAA | 80.0 | 108.89 | 97.47 | 2.6% | 顶格申购 |

#### 曙26发债（113708）
- **申购建议**：顶格申购
- **分析理由**：当前可转债零破发，中签即赚
- **债券评级**：AAA
- **正股**：中科曙光（603019）
- **正股价**：106.13元
- **正股PE**：70.0198
- **正股PB**：6.8843
- **正股ROE**：10.2089%
- **转股价**：108.89元
- **转股价值**：97.47元
- **转股溢价率**：2.6%
- **发行规模**：80.0亿元
- **流通规模**：❌ 获取失败 — 未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围
- **转债总市值占比**：5.15%

---
## 二、明日上市

> 明日无新股或新债上市。


---

## 📊 预测跟踪统计

> 统计近 90 天预测 vs 实际上市结果

**新股**：已上市 1 只，平均偏差 871.8pp
**新债**：已上市 9 只，平均偏差 19.1pp

> ⚡ 系统会根据实际结果持续校准预测模型，提升准确率
---
## 📊 当前赛道热度系数（每日动态校准）

> 系数 = 该赛道成分股近60日平均涨幅 / 最热赛道 × 3.0，由系统每日自动计算，非人工固定值。

| 赛道 | 热度系数 | 成分股60日均值 | 样本数 |
|------|----------|----------------|--------|
| 汽车电子 | 3.0 | 35.67% | 1 |
| 集成电路 | 3.0 | 101.87% | 3 |
| 光纤 | 2.54 | 70.31% | 1 |
| 半导体 | 2.15 | 73.14% | 20 |
| 芯片 | 1.15 | 39.11% | 7 |
| 锂电池 | 1.12 | 37.95% | 5 |
| 消费电子 | 0.42 | 5.05% | 1 |
| 机器人 | 0.08 | 2.61% | 4 |
| 军工 | -0.23 | -2.73% | 2 |
| 新能源 | -0.36 | -7.49% | 2 |
| 储能 | -0.43 | -9.01% | 1 |
| 新材料 | -0.46 | -15.6% | 1 |
| 光伏 | -0.47 | -15.93% | 11 |
| 电力设备 | -0.62 | -7.34% | 1 |
| 光子 | -1.04 | -35.17% | 1 |
| 航天 | -1.06 | -35.87% | 1 |
| 核电 | -1.11 | -22.99% | 1 |
| 航空 | -1.71 | -20.37% | 1 |
| 医疗器械 | -3.23 | -38.39% | 1 |

---

*本报告由打新日报系统自动生成，数据来源：东方财富网、巨潮资讯网。*

*⚠️ 流通规模说明：取自上市公司公告书「前十名可转换公司债券持有人」表格，以控股股东+实际控制人+一致行动人的配售量为限售依据，精确计算流通规模。若公告书未发布或解析失败，则不展示估算值，并注明失败原因。*
*报告日期：2026年07月15日 周三*', '{"weekday": "周三", "calendar": [{"date": "2026-07-14", "weekday": "周二", "list_bonds": [{"code": "127114", "name": "宜化转债"}], "apply_bonds": [{"code": "110102", "name": "江农发债"}], "list_stocks": [], "apply_stocks": []}, {"date": "2026-07-15", "weekday": "周三", "list_bonds": [], "apply_bonds": [{"code": "113708", "name": "曙26发债"}], "list_stocks": [], "apply_stocks": [{"code": "920238", "name": "长鹰硬科"}]}, {"date": "2026-07-16", "weekday": "周四", "list_bonds": [{"code": "110101", "name": "宝钛转债"}], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "688825", "name": "长鑫科技"}]}, {"date": "2026-07-20", "weekday": "周一", "list_bonds": [], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "301677", "name": "欣兴工具"}]}], "list_bonds": [], "apply_bonds": [{"code": "113708", "name": "曙26发债", "advice": "顶格申购", "detail": {"_note": "⚠️ 上市公告书查询失败：未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围", "rating": "AAA", "stock_pb": 6.8843, "stock_pe": 70.0198, "bond_name": "曙26转债", "list_date": "", "stock_roe": 10.2089, "bond_price": 100, "stock_code": "603019", "stock_name": "中科曙光", "issue_scale": 80.0, "stock_price": 106.13, "convert_price": 108.89, "premium_ratio": 2.6, "stock_industry": "IT设备", "transfer_value": 97.47, "market_cap_ratio": 5.15, "stock_market_cap": 1552.8, "_circulation_error": "未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围"}, "reason": "当前可转债零破发，中签即赚", "secu_code": "113708.SH", "has_detail": true}], "list_stocks": [], "apply_stocks": [], "date_display": "2026年07月15日", "sector_boost_info": [{"boost": 3.0, "count": 1, "sector": "汽车电子", "avg_gain": 35.67}, {"boost": 3.0, "count": 3, "sector": "集成电路", "avg_gain": 101.87}, {"boost": 2.54, "count": 1, "sector": "光纤", "avg_gain": 70.31}, {"boost": 2.15, "count": 20, "sector": "半导体", "avg_gain": 73.14}, {"boost": 1.15, "count": 7, "sector": "芯片", "avg_gain": 39.11}, {"boost": 1.12, "count": 5, "sector": "锂电池", "avg_gain": 37.95}, {"boost": 0.42, "count": 1, "sector": "消费电子", "avg_gain": 5.05}, {"boost": 0.08, "count": 4, "sector": "机器人", "avg_gain": 2.61}, {"boost": -0.23, "count": 2, "sector": "军工", "avg_gain": -2.73}, {"boost": -0.36, "count": 2, "sector": "新能源", "avg_gain": -7.49}, {"boost": -0.43, "count": 1, "sector": "储能", "avg_gain": -9.01}, {"boost": -0.46, "count": 1, "sector": "新材料", "avg_gain": -15.6}, {"boost": -0.47, "count": 11, "sector": "光伏", "avg_gain": -15.93}, {"boost": -0.62, "count": 1, "sector": "电力设备", "avg_gain": -7.34}, {"boost": -1.04, "count": 1, "sector": "光子", "avg_gain": -35.17}, {"boost": -1.06, "count": 1, "sector": "航天", "avg_gain": -35.87}, {"boost": -1.11, "count": 1, "sector": "核电", "avg_gain": -22.99}, {"boost": -1.71, "count": 1, "sector": "航空", "avg_gain": -20.37}, {"boost": -3.23, "count": 1, "sector": "医疗器械", "avg_gain": -38.39}]}', '2026-07-14T14:12:38.259617+08:00'::timestamptz) ON CONFLICT (report_date) DO UPDATE SET html=EXCLUDED.html, md=EXCLUDED.md, summary_json=EXCLUDED.summary_json, created_at=EXCLUDED.created_at;
