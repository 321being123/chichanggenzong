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
INSERT INTO ipo_reports (report_date, html, md, summary_json, created_at) VALUES ('20260717', '<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>打新日报 — 2026年07月17日 周五</title>
<style>
    body { font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', ''PingFang SC'', ''Microsoft YaHei'', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #333; line-height: 1.6; }
    .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { color: #1a1a1a; font-size: 24px; margin: 0 0 8px 0; }
    h2 { color: #e74c3c; font-size: 20px; border-bottom: 2px solid #e74c3c; padding-bottom: 8px; }
    h3 { color: #2c3e50; font-size: 17px; margin-top: 20px; }
    h4 { color: #34495e; font-size: 15px; margin: 16px 0 8px 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
    th { background: #2c3e50; color: white; padding: 10px 12px; text-align: center; white-space: nowrap; }
    td { padding: 10px 12px; border-bottom: 1px solid #eee; text-align: center; }
    tr:hover { background: #f8f9fa; }
    .subtitle { color: #888; font-size: 13px; }
    .disclaimer { color: #999; font-size: 12px; }
    .section-empty { color: #999; font-style: italic; }
    .stock-item { background: #fafafa; border-radius: 8px; padding: 16px; margin: 12px 0; border-left: 3px solid #e74c3c; }
    .bond-item { background: #fafafa; border-radius: 8px; padding: 16px; margin: 12px 0; border-left: 3px solid #3498db; }
    .advice { font-weight: bold; }
    hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
</style>
</head>
<body>
<div class="card">
    <h1>🏦 打新日报 — 2026年07月17日 周五</h1>
    <p class="subtitle">📅 报告生成时间：2026-07-16 17:39</p>
    <p class="subtitle">🌡️ 新股温度：<strong>🔥 热市</strong>（破发率0.0%，近6月均涨幅352.2%）</p>
    <p class="subtitle">🏷️ 新债温度：<strong>🔥 热市</strong>（破发率0.0%，近6月均涨幅72.9%）</p>
    <p class="disclaimer">⚠️ 声明：以下内容仅供参考，不构成投资建议。打新有风险，投资需谨慎。</p>
</div>
<div class="card">
<h2>一、明日可申购</h2>
<h3>💰 新债申购</h3>
<table>
<tr><th>代码</th><th>简称</th><th>评级</th><th>规模(亿)</th><th>转股价</th><th>转股价值</th><th>溢价率</th><th>建议</th></tr>
<tr><td>118073</td><td>赛斯发债</td><td>AA</td><td>5.519</td><td>88.16</td><td>87.35</td><td>14.48%</td><td class="advice">顶格申购</td></tr>
</table>
<div class="bond-item"><h4>赛斯发债（118073）</h4><p><strong>建议：</strong>顶格申购 — 当前可转债零破发，中签即赚</p><p><strong>评级：</strong>AA | <strong>规模：</strong>5.519亿 | <strong>流通：</strong>❌ 未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围</p><p><strong>正股：</strong>赛恩斯（688480） | 股价：77.01元 | PE：60.8988 | PB：6.085 | ROE：9.5599%</p><p><strong>转股价：</strong>88.16元 | 转股价值：87.35元 | 溢价率：14.48%</p><p><strong>转债总市值占比：</strong>7.52%</p></div>
</div>
<div class="card">
<h2>二、明日上市</h2>
<h3>💰 新债上市</h3>
<table>
<tr><th>代码</th><th>简称</th><th>评级</th><th>规模(亿)</th><th>转股价值</th><th>溢价率</th><th>预估上市价</th></tr>
<tr><td>118071</td><td>华峰转债</td><td>AA</td><td>7.4947</td><td>125.55</td><td>-20.35%</td><td>157.3元</td></tr>
<tr><td>118072</td><td>鼎通转债</td><td>A+</td><td>9.3</td><td>71.85</td><td>39.18%</td><td>127.45元</td></tr>
</table>
<div class="bond-item"><h4>华峰转债（118071）</h4><p><strong>首日预估：</strong>预估157.3元（预计次日继续涨停）</p><p style="color:#666;font-size:13px">📊 预估上市价: 157.3元（溢价率 92.3%）<br>🔥 市场热度: 高估（全市场平均溢价率 149.2%，近1月指数 -0.3%）<br>📈 转股价值 125.55元 → 转股价值分档中位数得基础溢价 62.3%<br>   （方法：在全市场304只转债中，取同转股价值区间的溢价率中位数）<br>💰 流通规模 5.5114亿 → 大盘(5-10亿)，调整 5.0%<br>⭐ 评级 AA → 调整 0%<br>🚀 行业加成: 半导体热门赛道 → +25.0%<br>⚠️ 受上市首日157.3元上限限制（实际市场可能通过次日连板继续上涨）</p><p><strong>正股：</strong>华峰测控（688200） | 股价：422.0元</p><p><strong>转股价：</strong>336.12元 | 转股价值：125.55元 | 溢价率：-20.35%</p><p><strong>流通规模：</strong>约5.5114亿元</p></div>
<div class="bond-item"><h4>鼎通转债（118072）</h4><p><strong>首日预估：</strong>预估125元左右</p><p style="color:#666;font-size:13px">📊 预估上市价: 127.45元（溢价率 77.4%）<br>🔥 市场热度: 高估（全市场平均溢价率 149.2%，近1月指数 -0.3%）<br>📈 转股价值 71.85元 → 转股价值分档中位数得基础溢价 77.4%<br>   （方法：在全市场304只转债中，取同转股价值区间的溢价率中位数）<br>💰 流通规模 5.527亿 → 大盘(5-10亿)，调整 5.0%<br>⭐ 评级 A+ → 调整 -5.0%</p><p><strong>正股：</strong>鼎通科技（688668） | 股价：304.32元</p><p><strong>转股价：</strong>423.54元 | 转股价值：71.85元 | 溢价率：39.18%</p><p><strong>流通规模：</strong>约5.527亿元</p></div>
</div>
<div class="card">
<h2>📊 当前赛道热度系数（每日动态校准）</h2>
<p class="subtitle">系数 = 该赛道成分股近60日平均涨幅 / 最热赛道 × 3.0，由系统每日自动计算，非人工固定值。</p>
<table>
<tr><th>赛道</th><th>热度系数</th><th>成分股60日均值</th><th>样本数</th></tr>
<tr><td>半导体</td><td>3.0</td><td>25.93%</td><td>14</td></tr>
<tr><td>集成电路</td><td>3.0</td><td>50.17%</td><td>7</td></tr>
<tr><td>光子</td><td>1.93</td><td>32.25%</td><td>1</td></tr>
<tr><td>汽车电子</td><td>1.31</td><td>11.29%</td><td>3</td></tr>
<tr><td>光纤</td><td>0.55</td><td>9.15%</td><td>1</td></tr>
<tr><td>芯片</td><td>0.48</td><td>4.19%</td><td>8</td></tr>
<tr><td>新能源</td><td>0.13</td><td>1.09%</td><td>1</td></tr>
<tr><td>消费电子</td><td>-0.1</td><td>-0.82%</td><td>10</td></tr>
<tr><td>储能</td><td>-0.43</td><td>-9.01%</td><td>1</td></tr>
<tr><td>机器人</td><td>-0.56</td><td>-4.83%</td><td>2</td></tr>
<tr><td>核电</td><td>-1.11</td><td>-22.99%</td><td>1</td></tr>
<tr><td>医疗器械</td><td>-1.7</td><td>-14.66%</td><td>9</td></tr>
<tr><td>航空</td><td>-2.25</td><td>-19.43%</td><td>4</td></tr>
<tr><td>军工</td><td>-2.5</td><td>-21.57%</td><td>9</td></tr>
<tr><td>新材料</td><td>-2.81</td><td>-24.29%</td><td>4</td></tr>
<tr><td>光伏</td><td>-2.87</td><td>-24.79%</td><td>6</td></tr>
<tr><td>锂电池</td><td>-3.08</td><td>-26.62%</td><td>1</td></tr>
<tr><td>电力设备</td><td>-3.17</td><td>-27.36%</td><td>23</td></tr>
<tr><td>航天</td><td>-4.09</td><td>-35.36%</td><td>2</td></tr>
</table>
</div>
<div class="card">
<p class="disclaimer">本报告由打新日报系统自动生成，数据来源：东方财富网、巨潮资讯网。<br>⚠️ 流通规模说明：取自上市公司公告书「前十名可转换公司债券持有人」表格，以控股股东+实际控制人+一致行动人的配售量为限售依据，精确计算流通规模。若公告书未发布或解析失败，则不展示估算值，并注明失败原因。<br>报告日期：2026年07月17日 周五</p>
</div>
</body>
</html>', '# 🏦 打新日报 — 2026年07月17日 周五

> 📅 报告生成时间：2026-07-16 17:39
> 🌡️ 新股温度：**🔥 热市**（破发率0.0%，近6月均涨幅352.2%）
> 🏷️ 新债温度：**🔥 热市**（破发率0.0%，近6月均涨幅72.9%）
> ⚠️ 声明：以下内容仅供参考，不构成投资建议。打新有风险，投资需谨慎。

## 📋 结论

**上市**
- 华峰转债-沪市（预估157.3元（预计次日继续涨停））
- 鼎通转债-沪市（预估125元左右）

**打新**
- 赛斯发债（顶格申购）

---
## 一、明日可申购

### 💰 新债申购

| 债券代码 | 债券简称 | 评级 | 发行规模(亿) | 转股价 | 转股价值 | 溢价率 | 申购建议 |
|----------|----------|------|-------------|--------|----------|--------|----------|
| 118073 | 赛斯发债 | AA | 5.519 | 88.16 | 87.35 | 14.48% | 顶格申购 |

#### 赛斯发债（118073）
- **申购建议**：顶格申购
- **分析理由**：当前可转债零破发，中签即赚
- **债券评级**：AA
- **正股**：赛恩斯（688480）
- **正股价**：77.01元
- **正股PE**：60.8988
- **正股PB**：6.085
- **正股ROE**：9.5599%
- **转股价**：88.16元
- **转股价值**：87.35元
- **转股溢价率**：14.48%
- **发行规模**：5.519亿元
- **流通规模**：❌ 获取失败 — 未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围
- **转债总市值占比**：7.52%

---
## 二、明日上市

### 💰 新债上市

| 债券代码 | 债券简称 | 评级 | 发行规模(亿) | 转股价值 | 溢价率 | 首日预估 |
|----------|----------|------|-------------|----------|--------|----------|
| 118071 | 华峰转债 | AA | 7.4947 | 125.55 | -20.35% | 预估157.3元（预计次日继续涨停） |
| 118072 | 鼎通转债 | A+ | 9.3 | 71.85 | 39.18% | 预估125元左右 |

#### 华峰转债（118071）
- **首日预估**：预估157.3元（预计次日继续涨停）
  - 📊 预估上市价: 157.3元（溢价率 92.3%）
  - 🔥 市场热度: 高估（全市场平均溢价率 149.2%，近1月指数 -0.3%）
  - 📈 转股价值 125.55元 → 转股价值分档中位数得基础溢价 62.3%
  -    （方法：在全市场304只转债中，取同转股价值区间的溢价率中位数）
  - 💰 流通规模 5.5114亿 → 大盘(5-10亿)，调整 5.0%
  - ⭐ 评级 AA → 调整 0%
  - 🚀 行业加成: 半导体热门赛道 → +25.0%
  - ⚠️ 受上市首日157.3元上限限制（实际市场可能通过次日连板继续上涨）
- **债券评级**：AA
- **正股**：华峰测控（688200）
- **转股价**：336.12元
- **转股价值**：125.55元
- **转股溢价率**：-20.35%
- **正股价**：422.0元
- **流通规模**：约5.5114亿元

#### 鼎通转债（118072）
- **首日预估**：预估125元左右
  - 📊 预估上市价: 127.45元（溢价率 77.4%）
  - 🔥 市场热度: 高估（全市场平均溢价率 149.2%，近1月指数 -0.3%）
  - 📈 转股价值 71.85元 → 转股价值分档中位数得基础溢价 77.4%
  -    （方法：在全市场304只转债中，取同转股价值区间的溢价率中位数）
  - 💰 流通规模 5.527亿 → 大盘(5-10亿)，调整 5.0%
  - ⭐ 评级 A+ → 调整 -5.0%
- **债券评级**：A+
- **正股**：鼎通科技（688668）
- **转股价**：423.54元
- **转股价值**：71.85元
- **转股溢价率**：39.18%
- **正股价**：304.32元
- **流通规模**：约5.527亿元


---

## 📊 预测跟踪统计

> 统计近 90 天预测 vs 实际上市结果

**新股**：已上市 38 只，平均偏差 414.9pp
**新债**：已上市 17 只，平均偏差 19.1pp

> ⚡ 系统会根据实际结果持续校准预测模型，提升准确率
---
## 📊 当前赛道热度系数（每日动态校准）

> 系数 = 该赛道成分股近60日平均涨幅 / 最热赛道 × 3.0，由系统每日自动计算，非人工固定值。

| 赛道 | 热度系数 | 成分股60日均值 | 样本数 |
|------|----------|----------------|--------|
| 半导体 | 3.0 | 25.93% | 14 |
| 集成电路 | 3.0 | 50.17% | 7 |
| 光子 | 1.93 | 32.25% | 1 |
| 汽车电子 | 1.31 | 11.29% | 3 |
| 光纤 | 0.55 | 9.15% | 1 |
| 芯片 | 0.48 | 4.19% | 8 |
| 新能源 | 0.13 | 1.09% | 1 |
| 消费电子 | -0.1 | -0.82% | 10 |
| 储能 | -0.43 | -9.01% | 1 |
| 机器人 | -0.56 | -4.83% | 2 |
| 核电 | -1.11 | -22.99% | 1 |
| 医疗器械 | -1.7 | -14.66% | 9 |
| 航空 | -2.25 | -19.43% | 4 |
| 军工 | -2.5 | -21.57% | 9 |
| 新材料 | -2.81 | -24.29% | 4 |
| 光伏 | -2.87 | -24.79% | 6 |
| 锂电池 | -3.08 | -26.62% | 1 |
| 电力设备 | -3.17 | -27.36% | 23 |
| 航天 | -4.09 | -35.36% | 2 |

---

*本报告由打新日报系统自动生成，数据来源：东方财富网、巨潮资讯网。*

*⚠️ 流通规模说明：取自上市公司公告书「前十名可转换公司债券持有人」表格，以控股股东+实际控制人+一致行动人的配售量为限售依据，精确计算流通规模。若公告书未发布或解析失败，则不展示估算值，并注明失败原因。*
*报告日期：2026年07月17日 周五*', '{"weekday": "周五", "calendar": [{"date": "2026-07-20", "weekday": "周一", "list_bonds": [], "apply_bonds": [{"code": "123276", "name": "久吾发债"}], "list_stocks": [], "apply_stocks": [{"code": "301677", "name": "欣兴工具"}]}, {"date": "2026-07-21", "weekday": "周二", "list_bonds": [{"code": "111025", "name": "圣泉转债"}], "apply_bonds": [], "list_stocks": [{"code": "688806", "name": "泰诺麦博"}], "apply_stocks": []}, {"date": "2026-07-24", "weekday": "周五", "list_bonds": [], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "001232", "name": "嘉立创"}, {"code": "603468", "name": "津富士达"}]}, {"date": "2026-07-27", "weekday": "周一", "list_bonds": [], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "301707", "name": "展芯股份"}]}], "list_bonds": [{"code": "118071", "name": "华峰转债", "detail": {"_note": "上市公告书（天津芯华投资控股有限公司(1,909,570张)、交通银行股份有限公司－工银瑞信新(74,490张)）（金额列已按100元面值折算修正）", "rating": "AA", "stock_pb": 20.206, "stock_pe": 148.9212, "bond_name": "华峰转债", "list_date": "2026-07-17", "stock_roe": 14.0176, "bond_price": 100, "lock_scale": 1.9841, "stock_code": "688200", "stock_name": "华峰测控", "issue_scale": 7.4947, "stock_price": 422.0, "convert_price": 336.12, "premium_ratio": -20.35, "stock_industry": "半导体", "transfer_value": 125.55, "market_cap_ratio": 0.89, "stock_market_cap": 846.43, "circulation_scale": 5.5114, "_circulation_source": "上市公告书"}, "secu_code": "118071.SH", "has_detail": true, "listing_analysis": {"low": 152.3, "high": 157.3, "price": 157.3, "capped": true, "detail": "📊 预估上市价: 157.3元（溢价率 92.3%）\n🔥 市场热度: 高估（全市场平均溢价率 149.2%，近1月指数 -0.3%）\n📈 转股价值 125.55元 → 转股价值分档中位数得基础溢价 62.3%\n   （方法：在全市场304只转债中，取同转股价值区间的溢价率中位数）\n💰 流通规模 5.5114亿 → 大盘(5-10亿)，调整 5.0%\n⭐ 评级 AA → 调整 0%\n🚀 行业加成: 半导体热门赛道 → +25.0%\n⚠️ 受上市首日157.3元上限限制（实际市场可能通过次日连板继续上涨）", "premium": 92.3, "summary": "预估157.3元（预计次日继续涨停）", "is_yaozhai": false, "market_level": "高估"}}, {"code": "118072", "name": "鼎通转债", "detail": {"_note": "上市公告书（东莞市鼎宏骏盛投资有限公司(3,378,270张)、王成海(345,550张)、国泰多策略绝对收益股票型养老金产品－招商银行股份有限公司(47,620张)）", "rating": "A+", "stock_pb": 20.6016, "stock_pe": 158.1708, "bond_name": "鼎通转债", "list_date": "2026-07-17", "stock_roe": 12.7157, "bond_price": 100, "lock_scale": 3.7714, "stock_code": "688668", "stock_name": "鼎通科技", "issue_scale": 9.3, "stock_price": 304.32, "convert_price": 423.54, "premium_ratio": 39.18, "stock_industry": "通信设备", "transfer_value": 71.85, "market_cap_ratio": 2.19, "stock_market_cap": 423.83, "circulation_scale": 5.527, "_circulation_source": "上市公告书"}, "secu_code": "118072.SH", "has_detail": true, "listing_analysis": {"low": 122.45, "high": 132.45, "price": 127.45, "capped": false, "detail": "📊 预估上市价: 127.45元（溢价率 77.4%）\n🔥 市场热度: 高估（全市场平均溢价率 149.2%，近1月指数 -0.3%）\n📈 转股价值 71.85元 → 转股价值分档中位数得基础溢价 77.4%\n   （方法：在全市场304只转债中，取同转股价值区间的溢价率中位数）\n💰 流通规模 5.527亿 → 大盘(5-10亿)，调整 5.0%\n⭐ 评级 A+ → 调整 -5.0%", "premium": 77.4, "summary": "预估125元左右", "is_yaozhai": false, "market_level": "高估"}}], "apply_bonds": [{"code": "118073", "name": "赛斯发债", "advice": "顶格申购", "detail": {"_note": "⚠️ 上市公告书查询失败：未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围", "rating": "AA", "stock_pb": 6.085, "stock_pe": 60.8988, "bond_name": "赛斯转债", "list_date": "", "stock_roe": 9.5599, "bond_price": 100, "stock_code": "688480", "stock_name": "赛恩斯", "issue_scale": 5.519, "stock_price": 77.01, "convert_price": 88.16, "premium_ratio": 14.48, "stock_industry": "环境保护", "transfer_value": 87.35, "market_cap_ratio": 7.52, "stock_market_cap": 73.41, "_circulation_error": "未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围"}, "reason": "当前可转债零破发，中签即赚", "secu_code": "118073.SH", "has_detail": true}], "list_stocks": [], "apply_stocks": [], "date_display": "2026年07月17日", "sector_boost_info": [{"boost": 3.0, "count": 14, "sector": "半导体", "avg_gain": 25.93}, {"boost": 3.0, "count": 7, "sector": "集成电路", "avg_gain": 50.17}, {"boost": 1.93, "count": 1, "sector": "光子", "avg_gain": 32.25}, {"boost": 1.31, "count": 3, "sector": "汽车电子", "avg_gain": 11.29}, {"boost": 0.55, "count": 1, "sector": "光纤", "avg_gain": 9.15}, {"boost": 0.48, "count": 8, "sector": "芯片", "avg_gain": 4.19}, {"boost": 0.13, "count": 1, "sector": "新能源", "avg_gain": 1.09}, {"boost": -0.1, "count": 10, "sector": "消费电子", "avg_gain": -0.82}, {"boost": -0.43, "count": 1, "sector": "储能", "avg_gain": -9.01}, {"boost": -0.56, "count": 2, "sector": "机器人", "avg_gain": -4.83}, {"boost": -1.11, "count": 1, "sector": "核电", "avg_gain": -22.99}, {"boost": -1.7, "count": 9, "sector": "医疗器械", "avg_gain": -14.66}, {"boost": -2.25, "count": 4, "sector": "航空", "avg_gain": -19.43}, {"boost": -2.5, "count": 9, "sector": "军工", "avg_gain": -21.57}, {"boost": -2.81, "count": 4, "sector": "新材料", "avg_gain": -24.29}, {"boost": -2.87, "count": 6, "sector": "光伏", "avg_gain": -24.79}, {"boost": -3.08, "count": 1, "sector": "锂电池", "avg_gain": -26.62}, {"boost": -3.17, "count": 23, "sector": "电力设备", "avg_gain": -27.36}, {"boost": -4.09, "count": 2, "sector": "航天", "avg_gain": -35.36}]}', '2026-07-16T17:39:19.511496+08:00'::timestamptz) ON CONFLICT (report_date) DO UPDATE SET html=EXCLUDED.html, md=EXCLUDED.md, summary_json=EXCLUDED.summary_json, created_at=EXCLUDED.created_at;
INSERT INTO ipo_reports (report_date, html, md, summary_json, created_at) VALUES ('20260728', '<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>打新日报 — 2026年07月28日 周二</title>
<style>
    body { font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', ''PingFang SC'', ''Microsoft YaHei'', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #333; line-height: 1.6; }
    .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { color: #1a1a1a; font-size: 24px; margin: 0 0 8px 0; }
    h2 { color: #e74c3c; font-size: 20px; border-bottom: 2px solid #e74c3c; padding-bottom: 8px; }
    h3 { color: #2c3e50; font-size: 17px; margin-top: 20px; }
    h4 { color: #34495e; font-size: 15px; margin: 16px 0 8px 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
    th { background: #2c3e50; color: white; padding: 10px 12px; text-align: center; white-space: nowrap; }
    td { padding: 10px 12px; border-bottom: 1px solid #eee; text-align: center; }
    tr:hover { background: #f8f9fa; }
    .subtitle { color: #888; font-size: 13px; }
    .disclaimer { color: #999; font-size: 12px; }
    .section-empty { color: #999; font-style: italic; }
    .stock-item { background: #fafafa; border-radius: 8px; padding: 16px; margin: 12px 0; border-left: 3px solid #e74c3c; }
    .bond-item { background: #fafafa; border-radius: 8px; padding: 16px; margin: 12px 0; border-left: 3px solid #3498db; }
    .advice { font-weight: bold; }
    hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
</style>
</head>
<body>
<div class="card">
    <h1>🏦 打新日报 — 2026年07月28日 周二</h1>
    <p class="subtitle">📅 报告生成时间：2026-07-27 18:00</p>
    <p class="subtitle">🌡️ 新股温度：<strong>🔥 热市</strong>（破发率0.0%，近6月均涨幅351.5%）</p>
    <p class="subtitle">🏷️ 新债温度：<strong>🔥 热市</strong>（破发率0.0%，近6月均涨幅69.8%）</p>
    <p class="disclaimer">⚠️ 声明：以下内容仅供参考，不构成投资建议。打新有风险，投资需谨慎。</p>
</div>
<div class="card">
<h2>一、明日可申购</h2>
<h3>💰 新债申购</h3>
<table>
<tr><th>代码</th><th>简称</th><th>评级</th><th>规模(亿)</th><th>转股价</th><th>转股价值</th><th>溢价率</th><th>建议</th></tr>
<tr><td>118074</td><td>特宝发债</td><td>AA+</td><td>15.3327</td><td>58.56</td><td>103.53</td><td>-3.41%</td><td class="advice">顶格申购</td></tr>
</table>
<div class="bond-item"><h4>特宝发债（118074）</h4><p><strong>建议：</strong>顶格申购 — 当前可转债零破发，中签即赚</p><p><strong>评级：</strong>AA+ | <strong>规模：</strong>15.3327亿 | <strong>流通：</strong>❌ 未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围</p><p><strong>正股：</strong>特宝生物（688278） | 股价：60.63元 | PE：24.4164 | PB：6.8171 | ROE：34.358%</p><p><strong>转股价：</strong>58.56元 | 转股价值：103.53元 | 溢价率：-3.41%</p><p><strong>转债总市值占比：</strong>6.2%</p></div>
</div>
<div class="card">
<h2>二、明日上市</h2>
<p class="section-empty">明日无新股或新债上市。</p>
</div>
<div class="card">
<h2>📊 当前赛道热度系数（每日动态校准）</h2>
<p class="subtitle">系数 = 该赛道新股上市首日平均涨幅 / 150，封顶 3.0，由系统每日自动计算，非人工固定值。</p>
<table>
<tr><th>赛道</th><th>热度系数</th><th>新股首日均值</th><th>样本数</th></tr>
<tr><td>光通信</td><td>3.0</td><td>612.37%</td><td>2</td></tr>
<tr><td>机器人</td><td>3.0</td><td>536.72%</td><td>2</td></tr>
<tr><td>光纤</td><td>3.0</td><td>1510.52%</td><td>1</td></tr>
<tr><td>GPU</td><td>3.0</td><td>559.21%</td><td>2</td></tr>
<tr><td>储能</td><td>2.8</td><td>420.65%</td><td>3</td></tr>
<tr><td>航天</td><td>2.71</td><td>407.23%</td><td>1</td></tr>
<tr><td>新材料</td><td>2.68</td><td>401.5%</td><td>3</td></tr>
<tr><td>航空</td><td>2.54</td><td>381.66%</td><td>3</td></tr>
<tr><td>半导体</td><td>2.37</td><td>356.0%</td><td>19</td></tr>
<tr><td>轨道交通</td><td>1.75</td><td>262.09%</td><td>1</td></tr>
<tr><td>消费电子</td><td>1.7</td><td>254.95%</td><td>3</td></tr>
<tr><td>医疗器械</td><td>1.63</td><td>244.42%</td><td>6</td></tr>
<tr><td>AI</td><td>1.48</td><td>222.54%</td><td>2</td></tr>
<tr><td>光伏</td><td>1.47</td><td>220.05%</td><td>3</td></tr>
<tr><td>新能源</td><td>1.37</td><td>205.33%</td><td>12</td></tr>
<tr><td>智能驾驶</td><td>0.75</td><td>112.06%</td><td>1</td></tr>
<tr><td>汽车电子</td><td>0.72</td><td>108.43%</td><td>2</td></tr>
<tr><td>创新药</td><td>0.5</td><td>74.41%</td><td>1</td></tr>
<tr><td>生物医药</td><td>0.28</td><td>41.61%</td><td>1</td></tr>
</table>
</div>
<div class="card">
<p class="disclaimer">本报告由打新日报系统自动生成，数据来源：东方财富网、巨潮资讯网。<br>⚠️ 流通规模说明：取自上市公司公告书「前十名可转换公司债券持有人」表格，以控股股东+实际控制人+一致行动人的配售量为限售依据，精确计算流通规模。若公告书未发布或解析失败，则不展示估算值，并注明失败原因。<br>报告日期：2026年07月28日 周二</p>
</div>
</body>
</html>', '# 🏦 打新日报 — 2026年07月28日 周二

> 📅 报告生成时间：2026-07-27 18:00
> 🌡️ 新股温度：**🔥 热市**（破发率0.0%，近6月均涨幅351.5%）
> 🏷️ 新债温度：**🔥 热市**（破发率0.0%，近6月均涨幅69.8%）
> ⚠️ 声明：以下内容仅供参考，不构成投资建议。打新有风险，投资需谨慎。

## 📋 结论

**打新**
- 特宝发债（顶格申购）

---
## 一、明日可申购

### 💰 新债申购

| 债券代码 | 债券简称 | 评级 | 发行规模(亿) | 转股价 | 转股价值 | 溢价率 | 申购建议 |
|----------|----------|------|-------------|--------|----------|--------|----------|
| 118074 | 特宝发债 | AA+ | 15.3327 | 58.56 | 103.53 | -3.41% | 顶格申购 |

#### 特宝发债（118074）
- **申购建议**：顶格申购
- **分析理由**：当前可转债零破发，中签即赚
- **债券评级**：AA+
- **正股**：特宝生物（688278）
- **正股价**：60.63元
- **正股PE**：24.4164
- **正股PB**：6.8171
- **正股ROE**：34.358%
- **转股价**：58.56元
- **转股价值**：103.53元
- **转股溢价率**：-3.41%
- **发行规模**：15.3327亿元
- **流通规模**：❌ 获取失败 — 未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围
- **转债总市值占比**：6.2%

---
## 二、明日上市

> 明日无新股或新债上市。


---

## 📊 预测跟踪统计

> 统计近 90 天预测 vs 实际上市结果

**新股**：有效预测样本 3 只，平均绝对偏差 414.9pp
**新债**：有效预测样本 12 只，平均绝对偏差 23.6pp

> ⚡ 系统会根据实际结果持续校准预测模型，提升准确率
---
## 📊 当前赛道热度系数（每日动态校准）

> 系数 = 该赛道新股上市首日平均涨幅 / 150，封顶 3.0，由系统每日自动计算，非人工固定值。

| 赛道 | 热度系数 | 新股首日均值 | 样本数 |
|------|----------|----------------|--------|
| 光通信 | 3.0 | 612.37% | 2 |
| 机器人 | 3.0 | 536.72% | 2 |
| 光纤 | 3.0 | 1510.52% | 1 |
| GPU | 3.0 | 559.21% | 2 |
| 储能 | 2.8 | 420.65% | 3 |
| 航天 | 2.71 | 407.23% | 1 |
| 新材料 | 2.68 | 401.5% | 3 |
| 航空 | 2.54 | 381.66% | 3 |
| 半导体 | 2.37 | 356.0% | 19 |
| 轨道交通 | 1.75 | 262.09% | 1 |
| 消费电子 | 1.7 | 254.95% | 3 |
| 医疗器械 | 1.63 | 244.42% | 6 |
| AI | 1.48 | 222.54% | 2 |
| 光伏 | 1.47 | 220.05% | 3 |
| 新能源 | 1.37 | 205.33% | 12 |
| 智能驾驶 | 0.75 | 112.06% | 1 |
| 汽车电子 | 0.72 | 108.43% | 2 |
| 创新药 | 0.5 | 74.41% | 1 |
| 生物医药 | 0.28 | 41.61% | 1 |

---

*本报告由打新日报系统自动生成，数据来源：东方财富网、巨潮资讯网。*

*⚠️ 流通规模说明：取自上市公司公告书「前十名可转换公司债券持有人」表格，以控股股东+实际控制人+一致行动人的配售量为限售依据，精确计算流通规模。若公告书未发布或解析失败，则不展示估算值，并注明失败原因。*
*报告日期：2026年07月28日 周二*', '{"weekday": "周二", "calendar": [{"date": "2026-08-11", "weekday": "周二", "list_bonds": [], "apply_bonds": [], "list_stocks": [{"code": "301717", "name": "超纯应材"}, {"code": "688828", "name": "国仪公司"}], "apply_stocks": []}, {"date": "2026-08-12", "weekday": "周三", "list_bonds": [{"code": "118073", "name": "赛斯转债"}], "apply_bonds": [], "list_stocks": [], "apply_stocks": []}, {"date": "2026-08-13", "weekday": "周四", "list_bonds": [{"code": "110103", "name": "申能转债"}, {"code": "127115", "name": "炬申转债"}, {"code": "118074", "name": "特宝转债"}], "apply_bonds": [], "list_stocks": [], "apply_stocks": []}, {"date": "2026-08-14", "weekday": "周五", "list_bonds": [], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "688835", "name": "高凯技术"}]}, {"date": "2026-08-19", "weekday": "周三", "list_bonds": [], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "301697", "name": "贝特利"}]}, {"date": "2026-08-20", "weekday": "周四", "list_bonds": [], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "301688", "name": "格林生物"}]}], "list_bonds": [], "apply_bonds": [{"code": "118074", "name": "特宝发债", "advice": "顶格申购", "detail": {"_note": "⚠️ 上市公告书查询失败：未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围", "rating": "AA+", "stock_pb": 6.8171, "stock_pe": 24.4164, "bond_name": "特宝转债", "list_date": "", "stock_roe": 34.358, "bond_price": 100, "stock_code": "688278", "stock_name": "特宝生物", "issue_scale": 15.3327, "stock_price": 60.63, "convert_price": 58.56, "premium_ratio": -3.41, "stock_industry": "生物制药", "transfer_value": 103.53, "market_cap_ratio": 6.2, "stock_market_cap": 247.49, "_circulation_error": "未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围"}, "reason": "当前可转债零破发，中签即赚", "secu_code": "118074.SH", "has_detail": true}], "list_stocks": [], "apply_stocks": [], "date_display": "2026年07月28日", "sector_boost_info": [{"boost": 3.0, "count": 2, "sector": "光通信", "avg_gain": 612.37}, {"boost": 3.0, "count": 2, "sector": "机器人", "avg_gain": 536.72}, {"boost": 3.0, "count": 1, "sector": "光纤", "avg_gain": 1510.52}, {"boost": 3.0, "count": 2, "sector": "GPU", "avg_gain": 559.21}, {"boost": 2.8, "count": 3, "sector": "储能", "avg_gain": 420.65}, {"boost": 2.71, "count": 1, "sector": "航天", "avg_gain": 407.23}, {"boost": 2.68, "count": 3, "sector": "新材料", "avg_gain": 401.5}, {"boost": 2.54, "count": 3, "sector": "航空", "avg_gain": 381.66}, {"boost": 2.37, "count": 19, "sector": "半导体", "avg_gain": 356.0}, {"boost": 1.75, "count": 1, "sector": "轨道交通", "avg_gain": 262.09}, {"boost": 1.7, "count": 3, "sector": "消费电子", "avg_gain": 254.95}, {"boost": 1.63, "count": 6, "sector": "医疗器械", "avg_gain": 244.42}, {"boost": 1.48, "count": 2, "sector": "AI", "avg_gain": 222.54}, {"boost": 1.47, "count": 3, "sector": "光伏", "avg_gain": 220.05}, {"boost": 1.37, "count": 12, "sector": "新能源", "avg_gain": 205.33}, {"boost": 0.75, "count": 1, "sector": "智能驾驶", "avg_gain": 112.06}, {"boost": 0.72, "count": 2, "sector": "汽车电子", "avg_gain": 108.43}, {"boost": 0.5, "count": 1, "sector": "创新药", "avg_gain": 74.41}, {"boost": 0.28, "count": 1, "sector": "生物医药", "avg_gain": 41.61}]}', '2026-07-27T18:00:19.481681+08:00'::timestamptz) ON CONFLICT (report_date) DO UPDATE SET html=EXCLUDED.html, md=EXCLUDED.md, summary_json=EXCLUDED.summary_json, created_at=EXCLUDED.created_at;
INSERT INTO ipo_reports (report_date, html, md, summary_json, created_at) VALUES ('20260812', '<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>打新日报 — 2026年08月12日 周三</title>
<style>
    body { font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', ''PingFang SC'', ''Microsoft YaHei'', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #333; line-height: 1.6; }
    .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { color: #1a1a1a; font-size: 24px; margin: 0 0 8px 0; }
    h2 { color: #e74c3c; font-size: 20px; border-bottom: 2px solid #e74c3c; padding-bottom: 8px; }
    h3 { color: #2c3e50; font-size: 17px; margin-top: 20px; }
    h4 { color: #34495e; font-size: 15px; margin: 16px 0 8px 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
    th { background: #2c3e50; color: white; padding: 10px 12px; text-align: center; white-space: nowrap; }
    td { padding: 10px 12px; border-bottom: 1px solid #eee; text-align: center; }
    tr:hover { background: #f8f9fa; }
    .subtitle { color: #888; font-size: 13px; }
    .disclaimer { color: #999; font-size: 12px; }
    .section-empty { color: #999; font-style: italic; }
    .stock-item { background: #fafafa; border-radius: 8px; padding: 16px; margin: 12px 0; border-left: 3px solid #e74c3c; }
    .bond-item { background: #fafafa; border-radius: 8px; padding: 16px; margin: 12px 0; border-left: 3px solid #3498db; }
    .advice { font-weight: bold; }
    hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
</style>
</head>
<body>
<div class="card">
    <h1>🏦 打新日报 — 2026年08月12日 周三</h1>
    <p class="subtitle">📅 报告生成时间：2026-08-11 23:04</p>
    <p class="subtitle">🌡️ 新股温度：<strong>🔥 热市</strong>（破发率0.0%，近6月均涨幅374.1%）</p>
    <p class="subtitle">🏷️ 新债温度：<strong>🔥 热市</strong>（破发率0.0%，近6月均涨幅69.5%）</p>
    <p class="disclaimer">⚠️ 声明：以下内容仅供参考，不构成投资建议。打新有风险，投资需谨慎。</p>
</div>
<div class="card">
<h2>一、明日可申购</h2>
<p class="section-empty">明日无可申购的新股或新债。</p>
</div>
<div class="card">
<h2>二、明日上市</h2>
<h3>💰 新债上市</h3>
<table>
<tr><th>代码</th><th>简称</th><th>评级</th><th>规模(亿)</th><th>转股价值</th><th>溢价率</th><th>预估上市价</th></tr>
<tr><td>118073</td><td>赛斯转债</td><td>AA</td><td>5.519</td><td>90.18</td><td>10.89%</td><td>151.64元</td></tr>
</table>
<div class="bond-item"><h4>赛斯转债（118073）</h4><p><strong>首日预估：</strong>预估150元左右</p><p style="color:#666;font-size:13px">📊 预估上市价: 151.64元（溢价率 68.2%）<br>🔥 市场热度: 高估（全市场平均溢价率 146.9%，近1月指数 -0.3%）<br>📈 转股价值 90.18元 → 转股价值分档中位数得基础溢价 48.1%<br>   （方法：在全市场304只转债中，取同转股价值区间的溢价率中位数）<br>💰 流通规模 2.5341亿 → 小盘(2-3亿)，调整 20.0%<br>⭐ 评级 AA → 调整 0%</p><p><strong>正股：</strong>赛恩斯（688480） | 股价：79.5元</p><p><strong>转股价：</strong>88.16元 | 转股价值：90.18元 | 溢价率：10.89%</p><p><strong>流通规模：</strong>约2.5341亿元</p></div>
</div>
<div class="card">
<h2>📊 当前赛道热度系数（每日动态校准）</h2>
<p class="subtitle">系数 = 该赛道或行业新股上市首日平均涨幅 / 150，封顶 3.0；未命中热门赛道时按所属行业兜底，无行业历史时使用中性系数 1.0。</p>
<table>
<tr><th>赛道</th><th>热度系数</th><th>新股首日均值</th><th>样本数</th></tr>
<tr><td>行业:广告包装</td><td>3.0</td><td>959.76%</td><td>2</td></tr>
<tr><td>光纤</td><td>3.0</td><td>1510.52%</td><td>1</td></tr>
<tr><td>行业:铜</td><td>3.0</td><td>606.83%</td><td>1</td></tr>
<tr><td>行业:染料涂料</td><td>3.0</td><td>535.2%</td><td>4</td></tr>
<tr><td>机器人</td><td>3.0</td><td>536.72%</td><td>2</td></tr>
<tr><td>光通信</td><td>3.0</td><td>612.37%</td><td>2</td></tr>
<tr><td>行业:农药化肥</td><td>3.0</td><td>772.98%</td><td>3</td></tr>
<tr><td>行业:通信设备</td><td>3.0</td><td>530.92%</td><td>5</td></tr>
<tr><td>GPU</td><td>3.0</td><td>559.21%</td><td>2</td></tr>
<tr><td>行业:矿物制品</td><td>2.84</td><td>426.08%</td><td>4</td></tr>
<tr><td>储能</td><td>2.8</td><td>420.65%</td><td>3</td></tr>
<tr><td>行业:航空</td><td>2.8</td><td>420.32%</td><td>2</td></tr>
<tr><td>行业:医药商业</td><td>2.79</td><td>418.58%</td><td>1</td></tr>
<tr><td>行业:小金属</td><td>2.76</td><td>414.25%</td><td>7</td></tr>
<tr><td>航天</td><td>2.71</td><td>407.23%</td><td>1</td></tr>
<tr><td>行业:软件服务</td><td>2.69</td><td>402.89%</td><td>5</td></tr>
<tr><td>新材料</td><td>2.68</td><td>401.5%</td><td>3</td></tr>
<tr><td>芯片</td><td>2.65</td><td>396.89%</td><td>1</td></tr>
<tr><td>行业:石油开采</td><td>2.65</td><td>397.27%</td><td>1</td></tr>
<tr><td>航空</td><td>2.54</td><td>381.66%</td><td>3</td></tr>
<tr><td>半导体</td><td>2.51</td><td>375.81%</td><td>21</td></tr>
<tr><td>行业:电器仪表</td><td>2.45</td><td>367.67%</td><td>7</td></tr>
<tr><td>行业:建筑工程</td><td>2.44</td><td>366.23%</td><td>5</td></tr>
<tr><td>行业:半导体</td><td>2.34</td><td>351.32%</td><td>19</td></tr>
<tr><td>印制电路板</td><td>2.22</td><td>332.47%</td><td>3</td></tr>
<tr><td>行业:影视音像</td><td>2.13</td><td>318.83%</td><td>1</td></tr>
<tr><td>行业:机械基件</td><td>1.99</td><td>298.35%</td><td>9</td></tr>
<tr><td>行业:元器件</td><td>1.88</td><td>282.05%</td><td>24</td></tr>
<tr><td>行业:电气设备</td><td>1.86</td><td>279.42%</td><td>25</td></tr>
<tr><td>行业:食品</td><td>1.83</td><td>274.54%</td><td>1</td></tr>
<tr><td>PCB</td><td>1.78</td><td>267.11%</td><td>2</td></tr>
<tr><td>轨道交通</td><td>1.75</td><td>262.09%</td><td>1</td></tr>
<tr><td>行业:化工原料</td><td>1.75</td><td>261.78%</td><td>14</td></tr>
<tr><td>行业:运输设备</td><td>1.75</td><td>262.09%</td><td>1</td></tr>
<tr><td>消费电子</td><td>1.7</td><td>254.95%</td><td>3</td></tr>
<tr><td>行业:专用机械</td><td>1.7</td><td>254.34%</td><td>27</td></tr>
<tr><td>医疗器械</td><td>1.63</td><td>244.42%</td><td>6</td></tr>
<tr><td>行业:日用化工</td><td>1.61</td><td>241.33%</td><td>1</td></tr>
<tr><td>行业:化纤</td><td>1.59</td><td>238.22%</td><td>3</td></tr>
<tr><td>行业:塑料</td><td>1.58</td><td>236.38%</td><td>7</td></tr>
<tr><td>行业:IT设备</td><td>1.54</td><td>230.84%</td><td>5</td></tr>
<tr><td>AI</td><td>1.48</td><td>222.54%</td><td>2</td></tr>
<tr><td>行业:医疗保健</td><td>1.48</td><td>222.28%</td><td>12</td></tr>
<tr><td>光伏</td><td>1.47</td><td>220.05%</td><td>3</td></tr>
<tr><td>行业:仓储物流</td><td>1.37</td><td>205.26%</td><td>2</td></tr>
<tr><td>新能源</td><td>1.37</td><td>205.33%</td><td>12</td></tr>
<tr><td>行业:家居用品</td><td>1.29</td><td>193.82%</td><td>4</td></tr>
<tr><td>行业:汽车配件</td><td>1.22</td><td>183.52%</td><td>29</td></tr>
<tr><td>行业:橡胶</td><td>1.18</td><td>176.64%</td><td>4</td></tr>
<tr><td>行业:工程机械</td><td>1.11</td><td>166.14%</td><td>1</td></tr>
<tr><td>行业:化学制药</td><td>1.11</td><td>167.04%</td><td>1</td></tr>
<tr><td>行业:生物制药</td><td>0.92</td><td>137.6%</td><td>5</td></tr>
<tr><td>行业:家用电器</td><td>0.89</td><td>133.84%</td><td>2</td></tr>
<tr><td>行业:新型电力</td><td>0.88</td><td>131.34%</td><td>2</td></tr>
<tr><td>行业:其他建材</td><td>0.85</td><td>126.89%</td><td>2</td></tr>
<tr><td>行业:铝</td><td>0.83</td><td>124.42%</td><td>1</td></tr>
<tr><td>行业:玻璃</td><td>0.81</td><td>121.65%</td><td>1</td></tr>
<tr><td>行业:纺织</td><td>0.77</td><td>115.61%</td><td>2</td></tr>
<tr><td>行业:摩托车</td><td>0.76</td><td>114.72%</td><td>1</td></tr>
<tr><td>智能驾驶</td><td>0.75</td><td>112.06%</td><td>1</td></tr>
<tr><td>汽车电子</td><td>0.72</td><td>108.43%</td><td>2</td></tr>
<tr><td>行业:机床制造</td><td>0.69</td><td>103.77%</td><td>1</td></tr>
<tr><td>创新药</td><td>0.5</td><td>74.41%</td><td>1</td></tr>
<tr><td>行业:造纸</td><td>0.45</td><td>67.31%</td><td>2</td></tr>
<tr><td>行业:旅游景点</td><td>0.43</td><td>64.1%</td><td>1</td></tr>
<tr><td>生物医药</td><td>0.28</td><td>41.61%</td><td>1</td></tr>
<tr><td>行业:石油加工</td><td>0.18</td><td>27.32%</td><td>1</td></tr>
</table>
</div>
<div class="card">
<p class="disclaimer">本报告由打新日报系统自动生成，数据来源：东方财富网、巨潮资讯网。<br>⚠️ 流通规模说明：取自上市公司公告书「前十名可转换公司债券持有人」表格，以控股股东+实际控制人+一致行动人的配售量为限售依据，精确计算流通规模。若公告书未发布或解析失败，则不展示估算值，并注明失败原因。<br>报告日期：2026年08月12日 周三</p>
</div>
</body>
</html>', '# 🏦 打新日报 — 2026年08月12日 周三

> 📅 报告生成时间：2026-08-11 23:04
> 🌡️ 新股温度：**🔥 热市**（破发率0.0%，近6月均涨幅374.1%）
> 🏷️ 新债温度：**🔥 热市**（破发率0.0%，近6月均涨幅69.5%）
> ⚠️ 声明：以下内容仅供参考，不构成投资建议。打新有风险，投资需谨慎。

## 📋 结论

**上市**
- 赛斯转债-沪市（预估150元左右）

---
## 一、明日可申购

> 明日无可申购的新股或新债。

---
## 二、明日上市

### 💰 新债上市

| 债券代码 | 债券简称 | 评级 | 发行规模(亿) | 转股价值 | 溢价率 | 首日预估 |
|----------|----------|------|-------------|----------|--------|----------|
| 118073 | 赛斯转债 | AA | 5.519 | 90.18 | 10.89% | 预估150元左右 |

#### 赛斯转债（118073）
- **首日预估**：预估150元左右
  - 📊 预估上市价: 151.64元（溢价率 68.2%）
  - 🔥 市场热度: 高估（全市场平均溢价率 146.9%，近1月指数 -0.3%）
  - 📈 转股价值 90.18元 → 转股价值分档中位数得基础溢价 48.1%
  -    （方法：在全市场304只转债中，取同转股价值区间的溢价率中位数）
  - 💰 流通规模 2.5341亿 → 小盘(2-3亿)，调整 20.0%
  - ⭐ 评级 AA → 调整 0%
- **债券评级**：AA
- **正股**：赛恩斯（688480）
- **转股价**：88.16元
- **转股价值**：90.18元
- **转股溢价率**：10.89%
- **正股价**：79.5元
- **流通规模**：约2.5341亿元


---

## 📊 预测跟踪统计

> 统计近 90 天预测 vs 实际上市结果

**新股**：有效预测样本 3 只，平均绝对偏差 414.9pp
**新债**：有效预测样本 12 只，平均绝对偏差 23.6pp

> ⚡ 系统会根据实际结果持续校准预测模型，提升准确率
---
## 📊 当前赛道热度系数（每日动态校准）

> 系数 = 该赛道或行业新股上市首日平均涨幅 / 150，封顶 3.0；未命中热门赛道时按所属行业兜底，无行业历史时使用中性系数 1.0。

| 赛道 | 热度系数 | 新股首日均值 | 样本数 |
|------|----------|----------------|--------|
| 行业:广告包装 | 3.0 | 959.76% | 2 |
| 光纤 | 3.0 | 1510.52% | 1 |
| 行业:铜 | 3.0 | 606.83% | 1 |
| 行业:染料涂料 | 3.0 | 535.2% | 4 |
| 机器人 | 3.0 | 536.72% | 2 |
| 光通信 | 3.0 | 612.37% | 2 |
| 行业:农药化肥 | 3.0 | 772.98% | 3 |
| 行业:通信设备 | 3.0 | 530.92% | 5 |
| GPU | 3.0 | 559.21% | 2 |
| 行业:矿物制品 | 2.84 | 426.08% | 4 |
| 储能 | 2.8 | 420.65% | 3 |
| 行业:航空 | 2.8 | 420.32% | 2 |
| 行业:医药商业 | 2.79 | 418.58% | 1 |
| 行业:小金属 | 2.76 | 414.25% | 7 |
| 航天 | 2.71 | 407.23% | 1 |
| 行业:软件服务 | 2.69 | 402.89% | 5 |
| 新材料 | 2.68 | 401.5% | 3 |
| 芯片 | 2.65 | 396.89% | 1 |
| 行业:石油开采 | 2.65 | 397.27% | 1 |
| 航空 | 2.54 | 381.66% | 3 |
| 半导体 | 2.51 | 375.81% | 21 |
| 行业:电器仪表 | 2.45 | 367.67% | 7 |
| 行业:建筑工程 | 2.44 | 366.23% | 5 |
| 行业:半导体 | 2.34 | 351.32% | 19 |
| 印制电路板 | 2.22 | 332.47% | 3 |
| 行业:影视音像 | 2.13 | 318.83% | 1 |
| 行业:机械基件 | 1.99 | 298.35% | 9 |
| 行业:元器件 | 1.88 | 282.05% | 24 |
| 行业:电气设备 | 1.86 | 279.42% | 25 |
| 行业:食品 | 1.83 | 274.54% | 1 |
| PCB | 1.78 | 267.11% | 2 |
| 轨道交通 | 1.75 | 262.09% | 1 |
| 行业:化工原料 | 1.75 | 261.78% | 14 |
| 行业:运输设备 | 1.75 | 262.09% | 1 |
| 消费电子 | 1.7 | 254.95% | 3 |
| 行业:专用机械 | 1.7 | 254.34% | 27 |
| 医疗器械 | 1.63 | 244.42% | 6 |
| 行业:日用化工 | 1.61 | 241.33% | 1 |
| 行业:化纤 | 1.59 | 238.22% | 3 |
| 行业:塑料 | 1.58 | 236.38% | 7 |
| 行业:IT设备 | 1.54 | 230.84% | 5 |
| AI | 1.48 | 222.54% | 2 |
| 行业:医疗保健 | 1.48 | 222.28% | 12 |
| 光伏 | 1.47 | 220.05% | 3 |
| 行业:仓储物流 | 1.37 | 205.26% | 2 |
| 新能源 | 1.37 | 205.33% | 12 |
| 行业:家居用品 | 1.29 | 193.82% | 4 |
| 行业:汽车配件 | 1.22 | 183.52% | 29 |
| 行业:橡胶 | 1.18 | 176.64% | 4 |
| 行业:工程机械 | 1.11 | 166.14% | 1 |
| 行业:化学制药 | 1.11 | 167.04% | 1 |
| 行业:生物制药 | 0.92 | 137.6% | 5 |
| 行业:家用电器 | 0.89 | 133.84% | 2 |
| 行业:新型电力 | 0.88 | 131.34% | 2 |
| 行业:其他建材 | 0.85 | 126.89% | 2 |
| 行业:铝 | 0.83 | 124.42% | 1 |
| 行业:玻璃 | 0.81 | 121.65% | 1 |
| 行业:纺织 | 0.77 | 115.61% | 2 |
| 行业:摩托车 | 0.76 | 114.72% | 1 |
| 智能驾驶 | 0.75 | 112.06% | 1 |
| 汽车电子 | 0.72 | 108.43% | 2 |
| 行业:机床制造 | 0.69 | 103.77% | 1 |
| 创新药 | 0.5 | 74.41% | 1 |
| 行业:造纸 | 0.45 | 67.31% | 2 |
| 行业:旅游景点 | 0.43 | 64.1% | 1 |
| 生物医药 | 0.28 | 41.61% | 1 |
| 行业:石油加工 | 0.18 | 27.32% | 1 |

---

*本报告由打新日报系统自动生成，数据来源：东方财富网、巨潮资讯网。*

*⚠️ 流通规模说明：取自上市公司公告书「前十名可转换公司债券持有人」表格，以控股股东+实际控制人+一致行动人的配售量为限售依据，精确计算流通规模。若公告书未发布或解析失败，则不展示估算值，并注明失败原因。*
*报告日期：2026年08月12日 周三*', '{"weekday": "周三", "calendar": [{"date": "2026-08-11", "weekday": "周二", "list_bonds": [], "apply_bonds": [], "list_stocks": [{"code": "301717", "name": "超纯应材"}, {"code": "688828", "name": "国仪公司"}], "apply_stocks": []}, {"date": "2026-08-12", "weekday": "周三", "list_bonds": [{"code": "118073", "name": "赛斯转债"}], "apply_bonds": [], "list_stocks": [], "apply_stocks": []}, {"date": "2026-08-13", "weekday": "周四", "list_bonds": [{"code": "110103", "name": "申能转债"}, {"code": "127115", "name": "炬申转债"}, {"code": "118074", "name": "特宝转债"}], "apply_bonds": [], "list_stocks": [], "apply_stocks": []}, {"date": "2026-08-14", "weekday": "周五", "list_bonds": [], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "688835", "name": "高凯技术"}]}, {"date": "2026-08-19", "weekday": "周三", "list_bonds": [], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "301697", "name": "贝特利"}]}, {"date": "2026-08-20", "weekday": "周四", "list_bonds": [], "apply_bonds": [], "list_stocks": [], "apply_stocks": [{"code": "301688", "name": "格林生物"}]}], "list_bonds": [{"code": "118073", "name": "赛斯转债", "detail": {"_note": "上市公告书（高伟荣(1,433,560张)、紫金矿业紫峰（厦门）投资合伙企业（有限合伙）(1,164,750张)、高亮云(361,470张)、宁波梅山保税港区融远股权投资中心（有限合伙）(25,800张)）", "rating": "AA", "stock_pb": 6.2817, "stock_pe": 62.8678, "bond_name": "赛斯转债", "list_date": "2026-08-12", "stock_roe": 9.5599, "bond_price": 100, "lock_scale": 2.9856, "stock_code": "688480", "stock_name": "赛恩斯", "issue_scale": 5.519, "stock_price": 79.5, "convert_price": 88.16, "premium_ratio": 10.89, "stock_industry": "环境保护", "transfer_value": 90.18, "market_cap_ratio": 7.28, "stock_market_cap": 75.78, "circulation_scale": 2.5341, "_circulation_source": "上市公告书"}, "secu_code": "118073.SH", "has_detail": true, "listing_analysis": {"low": 146.64, "high": 156.64, "price": 151.64, "capped": false, "detail": "📊 预估上市价: 151.64元（溢价率 68.2%）\n🔥 市场热度: 高估（全市场平均溢价率 146.9%，近1月指数 -0.3%）\n📈 转股价值 90.18元 → 转股价值分档中位数得基础溢价 48.1%\n   （方法：在全市场304只转债中，取同转股价值区间的溢价率中位数）\n💰 流通规模 2.5341亿 → 小盘(2-3亿)，调整 20.0%\n⭐ 评级 AA → 调整 0%", "premium": 68.2, "summary": "预估150元左右", "is_yaozhai": false, "market_level": "高估", "tracking_price": 151.64, "second_day_limit": false}}], "apply_bonds": [], "list_stocks": [], "apply_stocks": [], "date_display": "2026年08月12日", "sector_boost_info": [{"boost": 3.0, "count": 2, "sector": "行业:广告包装", "avg_gain": 959.76}, {"boost": 3.0, "count": 1, "sector": "光纤", "avg_gain": 1510.52}, {"boost": 3.0, "count": 1, "sector": "行业:铜", "avg_gain": 606.83}, {"boost": 3.0, "count": 4, "sector": "行业:染料涂料", "avg_gain": 535.2}, {"boost": 3.0, "count": 2, "sector": "机器人", "avg_gain": 536.72}, {"boost": 3.0, "count": 2, "sector": "光通信", "avg_gain": 612.37}, {"boost": 3.0, "count": 3, "sector": "行业:农药化肥", "avg_gain": 772.98}, {"boost": 3.0, "count": 5, "sector": "行业:通信设备", "avg_gain": 530.92}, {"boost": 3.0, "count": 2, "sector": "GPU", "avg_gain": 559.21}, {"boost": 2.84, "count": 4, "sector": "行业:矿物制品", "avg_gain": 426.08}, {"boost": 2.8, "count": 3, "sector": "储能", "avg_gain": 420.65}, {"boost": 2.8, "count": 2, "sector": "行业:航空", "avg_gain": 420.32}, {"boost": 2.79, "count": 1, "sector": "行业:医药商业", "avg_gain": 418.58}, {"boost": 2.76, "count": 7, "sector": "行业:小金属", "avg_gain": 414.25}, {"boost": 2.71, "count": 1, "sector": "航天", "avg_gain": 407.23}, {"boost": 2.69, "count": 5, "sector": "行业:软件服务", "avg_gain": 402.89}, {"boost": 2.68, "count": 3, "sector": "新材料", "avg_gain": 401.5}, {"boost": 2.65, "count": 1, "sector": "芯片", "avg_gain": 396.89}, {"boost": 2.65, "count": 1, "sector": "行业:石油开采", "avg_gain": 397.27}, {"boost": 2.54, "count": 3, "sector": "航空", "avg_gain": 381.66}, {"boost": 2.51, "count": 21, "sector": "半导体", "avg_gain": 375.81}, {"boost": 2.45, "count": 7, "sector": "行业:电器仪表", "avg_gain": 367.67}, {"boost": 2.44, "count": 5, "sector": "行业:建筑工程", "avg_gain": 366.23}, {"boost": 2.34, "count": 19, "sector": "行业:半导体", "avg_gain": 351.32}, {"boost": 2.22, "count": 3, "sector": "印制电路板", "avg_gain": 332.47}, {"boost": 2.13, "count": 1, "sector": "行业:影视音像", "avg_gain": 318.83}, {"boost": 1.99, "count": 9, "sector": "行业:机械基件", "avg_gain": 298.35}, {"boost": 1.88, "count": 24, "sector": "行业:元器件", "avg_gain": 282.05}, {"boost": 1.86, "count": 25, "sector": "行业:电气设备", "avg_gain": 279.42}, {"boost": 1.83, "count": 1, "sector": "行业:食品", "avg_gain": 274.54}, {"boost": 1.78, "count": 2, "sector": "PCB", "avg_gain": 267.11}, {"boost": 1.75, "count": 1, "sector": "轨道交通", "avg_gain": 262.09}, {"boost": 1.75, "count": 14, "sector": "行业:化工原料", "avg_gain": 261.78}, {"boost": 1.75, "count": 1, "sector": "行业:运输设备", "avg_gain": 262.09}, {"boost": 1.7, "count": 3, "sector": "消费电子", "avg_gain": 254.95}, {"boost": 1.7, "count": 27, "sector": "行业:专用机械", "avg_gain": 254.34}, {"boost": 1.63, "count": 6, "sector": "医疗器械", "avg_gain": 244.42}, {"boost": 1.61, "count": 1, "sector": "行业:日用化工", "avg_gain": 241.33}, {"boost": 1.59, "count": 3, "sector": "行业:化纤", "avg_gain": 238.22}, {"boost": 1.58, "count": 7, "sector": "行业:塑料", "avg_gain": 236.38}, {"boost": 1.54, "count": 5, "sector": "行业:IT设备", "avg_gain": 230.84}, {"boost": 1.48, "count": 2, "sector": "AI", "avg_gain": 222.54}, {"boost": 1.48, "count": 12, "sector": "行业:医疗保健", "avg_gain": 222.28}, {"boost": 1.47, "count": 3, "sector": "光伏", "avg_gain": 220.05}, {"boost": 1.37, "count": 2, "sector": "行业:仓储物流", "avg_gain": 205.26}, {"boost": 1.37, "count": 12, "sector": "新能源", "avg_gain": 205.33}, {"boost": 1.29, "count": 4, "sector": "行业:家居用品", "avg_gain": 193.82}, {"boost": 1.22, "count": 29, "sector": "行业:汽车配件", "avg_gain": 183.52}, {"boost": 1.18, "count": 4, "sector": "行业:橡胶", "avg_gain": 176.64}, {"boost": 1.11, "count": 1, "sector": "行业:工程机械", "avg_gain": 166.14}, {"boost": 1.11, "count": 1, "sector": "行业:化学制药", "avg_gain": 167.04}, {"boost": 0.92, "count": 5, "sector": "行业:生物制药", "avg_gain": 137.6}, {"boost": 0.89, "count": 2, "sector": "行业:家用电器", "avg_gain": 133.84}, {"boost": 0.88, "count": 2, "sector": "行业:新型电力", "avg_gain": 131.34}, {"boost": 0.85, "count": 2, "sector": "行业:其他建材", "avg_gain": 126.89}, {"boost": 0.83, "count": 1, "sector": "行业:铝", "avg_gain": 124.42}, {"boost": 0.81, "count": 1, "sector": "行业:玻璃", "avg_gain": 121.65}, {"boost": 0.77, "count": 2, "sector": "行业:纺织", "avg_gain": 115.61}, {"boost": 0.76, "count": 1, "sector": "行业:摩托车", "avg_gain": 114.72}, {"boost": 0.75, "count": 1, "sector": "智能驾驶", "avg_gain": 112.06}, {"boost": 0.72, "count": 2, "sector": "汽车电子", "avg_gain": 108.43}, {"boost": 0.69, "count": 1, "sector": "行业:机床制造", "avg_gain": 103.77}, {"boost": 0.5, "count": 1, "sector": "创新药", "avg_gain": 74.41}, {"boost": 0.45, "count": 2, "sector": "行业:造纸", "avg_gain": 67.31}, {"boost": 0.43, "count": 1, "sector": "行业:旅游景点", "avg_gain": 64.1}, {"boost": 0.28, "count": 1, "sector": "生物医药", "avg_gain": 41.61}, {"boost": 0.18, "count": 1, "sector": "行业:石油加工", "avg_gain": 27.32}]}', '2026-08-11T23:04:21.117539+08:00'::timestamptz) ON CONFLICT (report_date) DO UPDATE SET html=EXCLUDED.html, md=EXCLUDED.md, summary_json=EXCLUDED.summary_json, created_at=EXCLUDED.created_at;
