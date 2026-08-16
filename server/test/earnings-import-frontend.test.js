const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/shared/core-earnings.js'), 'utf8');

assert.ok(source.includes("'持仓现金'"), '应识别“持仓现金”表头');
assert.ok(source.includes("label: '持仓现金列（可选）'"), '现金列应为可选');
assert.ok(source.includes('const cash = cashBlank ? 0 : parseNumericCellF(cashRaw);'), '空现金应按 0 处理');
assert.ok(source.includes('auto.date >= 0 && auto.nav >= 0 && auto.total >= 0 && auto.invested >= 0'), '自动匹配不应强制现金列');
assert.ok(source.includes("showToast('请先选择日期、净值、总市值和累计投入资金列')"), '手动匹配不应强制选择现金列');

console.log('收益导入空现金列兼容回归测试通过 ✅');
