const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'js', 'bond-analysis.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondAnalysis.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'stock-analysis.css'), 'utf8');

assert.ok(html.includes('data-main="stock-analysis">股债分析'), '一级导航未改为股债分析');
assert.ok(html.includes('id="bond-analysis-content"'), '缺少可转债分析结果区');
assert.ok(html.includes('id="security-analysis-select"'), '缺少持仓和自选入口');
assert.ok(html.includes('js/bond-analysis.js'), '缺少可转债前端脚本');
assert.ok(script.includes('/api/bond-analysis/'), '前端未接入可转债分析接口');
for (const field of ['强赎触发价','基金持仓','最快回售触发日','下修天计数','募资用途','转股价调整历史','转股价不下修历史','利息保障倍数','纯债价值','理论偏离度','正股年化波动率','资产负债率']) {
  assert.ok((html+script).includes(field), '可转债页面缺少字段：'+field);
}
assert.ok(script.includes('bondAnalysisTable') && script.includes('bondAnalysisListTable'), '可转债结果必须使用表格展示');
assert.ok(!script.includes("['转股条款'"), '可转债页面不应继续展示转股条款');
for (const text of ['利息保障倍数（符合：≥7）','到期税前收益率（YTM）','尚未进入回售期']) assert.ok(script.includes(text), '缺少计算说明：'+text);
for (const text of ['原转股价','下修到底','下修不到底','占剩余规模：']) assert.ok(script.includes(text), '缺少转债新增展示：'+text);
assert.ok(script.includes("if(/回购注销/.test(reason)) return '回购注销';"), '回购注销导致转股价上调未单独分类');
assert.ok(service.includes("model: 'Black-Scholes'") && script.includes('option.model'), '缺少Black-Scholes模型或前端展示');
assert.ok(css.includes('.bond-analysis-table tr:last-child th,.bond-analysis-table tr:last-child td{border-bottom:'), '可转债表格末行边框缺失');
assert.ok(script.includes('put_opportunity_used'), '回售展示未处理本计息年度机会已使用状态');
assert.ok(css.includes('#bond-analysis-price-history .bond-analysis-table th:nth-child(7){width:36%}'), '转股价历史说明列宽度不足');
assert.ok(script.includes('查看募集说明书') && script.includes('coupon_source_url'), '募集说明书或利息明细入口缺失');

console.log('convertible bond frontend tests passed');
