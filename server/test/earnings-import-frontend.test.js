const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/shared/core-earnings.js'), 'utf8');

assert.ok(source.includes("'持仓现金'"), '应识别“持仓现金”表头');
assert.ok(source.includes("label: '持仓现金列（可选）'"), '现金列应为可选');
assert.ok(source.includes('const cash = cashBlank ? null : parseNumericCellF(cashRaw);'), '空现金应作为缺省值交给服务端处理');
assert.ok(source.includes('auto.date >= 0 && auto.nav >= 0 && auto.total >= 0 && auto.invested >= 0'), '自动匹配不应强制现金列');
assert.ok(source.includes("showToast('请先选择日期、净值、总市值和累计投入资金列')"), '手动匹配不应强制选择现金列');
assert.ok(source.includes('uniqueByDate.set(record.date, record);') && source.includes('records: importedRecords'), 'Excel 重复日期应保留最后一行后再提交');
assert.ok(source.includes('i > lastValidInvestedRow') && source.includes('invested = trailingInvested;'), '表尾累计投入公式错误时应沿用最后一个有效累计值');
assert.ok(source.includes('行累计投入资金异常，已沿用前一有效值'), '累计投入沿用必须向用户明确提示');

(async () => {
  let importBody = null;
  let toast = '';
  const context = {
    console,
    currentAccount: '招商证券账户',
    dataVersion: 1,
    api: (url) => url,
    refreshDataFromServer: () => {},
    renderEarnings: () => {},
    showToast: (message) => { toast = message; },
    fetch: async (url, options) => {
      if (String(url).includes('backup-nav-history')) return { ok: true };
      importBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: true }) };
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.finishImport([
    ['2026-07-05', 2.99, 2063297.01, 1664240.92, ''],
    ['2026-07-19', 3.04, 2095733, '#REF!', ''],
    ['2026-08-16', 3.06, 2110646, '#REF!', 926233]
  ], { date: 0, nav: 1, total: 2, invested: 3, cash: 4 });
  assert.strictEqual(importBody.records.length, 3, '表尾公式错误不应导致最新历史行被丢弃');
  assert.strictEqual(importBody.records[1].invested, 1664240.92, '表尾累计投入应沿用上一有效值');
  assert.strictEqual(importBody.records[2].invested, 1664240.92, '最新日期也应保留并沿用累计投入');
  assert.strictEqual(importBody.records[1].cash, null, '空现金应保留为缺省值，不能覆盖同日已有券商现金');
  assert.strictEqual(importBody.records[2].cash, 926233, '唯一一条现金值必须随最新日期导入');
  assert.ok(toast.includes('2 行累计投入资金异常，已沿用前一有效值'), '导入结果应提示沿用数量');
  console.log('收益导入空现金/表尾累计投入兼容回归测试通过 ✅');
})().catch((error) => { console.error(error); process.exitCode = 1; });
